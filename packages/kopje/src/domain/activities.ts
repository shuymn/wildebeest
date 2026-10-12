import {
	addressingOf,
	type Audience,
	audienceOf,
	isDistributable,
	PUBLIC_COLLECTION,
	type Recipient,
	type Visibility,
} from './audience'
import type { Db } from '../db/sql'

// Outbound intents. A local change that federates records the ActivityPub activity it means and the audience it is
// for in outbound_activities, in the transaction of the change. Nothing is delivered here: B2 expands the audience
// into inboxes and delivers (design §4 "outbound"). outbound_activities.body is the envelope
//
//   { "activity": <the activity JSON>, "audience": { "followers": boolean, "accounts": [<account id>, ...] } }
//
// where followers means the signer's followers and accounts are the addressed accounts (silent recipients included,
// local ones too; B2 skips HTTP for local recipients). Update and Delete are addressed and delivered to the audience
// the status already had and never wider: visibility cannot change, and a mention removed by an edit stays as a
// silent mention. Delete carries a Tombstone, not the content.

const CONTEXT = ['https://www.w3.org/ns/activitystreams', { sensitive: 'as:sensitive', Hashtag: 'as:Hashtag' }] as const

export type OutboundEnvelope = { activity: Record<string, unknown>; audience: Audience }

// Records the intent if anyone remote may need it: the signer has a remote follower and the audience includes
// followers, or the audience names a remote account.
export function recordOutbound(db: Db, signerId: string, envelope: OutboundEnvelope, now: number): void {
	const reaches = db.first(
		`SELECT 1 AS yes WHERE (?2 AND EXISTS (SELECT 1 FROM follows f JOIN accounts a ON a.id = f.account_id
				WHERE f.target_account_id = ?1 AND f.state = 'accepted' AND a.domain IS NOT NULL))
			OR EXISTS (SELECT 1 FROM accounts a WHERE a.id IN (SELECT value FROM json_each(?3)) AND a.domain IS NOT NULL)`,
		signerId,
		envelope.audience.followers ? 1 : 0,
		JSON.stringify(envelope.audience.accounts)
	)
	if (reaches === undefined) {
		return
	}
	db.run(
		'INSERT INTO outbound_activities (account_id, body, created_at) VALUES (?, ?, ?)',
		signerId,
		JSON.stringify(envelope),
		now
	)
}

export function followersUri(actorUri: string): string {
	return `${actorUri}/followers`
}

// What the activities about one local status need, read from the Store.
export type StatusFacts = {
	id: string
	uri: string
	url: string
	actorUri: string
	visibility: Visibility
	content: string
	spoilerText: string
	sensitive: boolean
	language: string | null
	publishedAt: string
	editedAt: string | null
	inReplyToUri: string | null
	recipients: Recipient[]
	// Remote accounts that interacted with a distributable status (reblogged it, or wrote the replied-to status).
	reached: string[]
	tags: { name: string; href: string }[]
	media: { url: string; type: string; description: string }[]
	mentionNames: Map<string, string>
}

export function statusFacts(db: Db, statusId: string): StatusFacts | null {
	const row = db.first<{
		id: string
		uri: string
		visibility: Visibility
		content: string
		spoiler_text: string
		sensitive: number
		language: string | null
		published_at: string
		edited_at: string | null
		in_reply_to_uri: string | null
		in_reply_to_id: string | null
		actor_uri: string
		username: string
	}>(
		`SELECT s.id, s.uri, s.visibility, s.content, s.spoiler_text, s.sensitive, s.language, s.published_at, s.edited_at,
			s.in_reply_to_uri, s.in_reply_to_id, a.uri AS actor_uri, a.username
		FROM statuses s JOIN accounts a ON a.id = s.account_id WHERE s.id = ?`,
		statusId
	)
	if (row === undefined) {
		return null
	}
	const mentioned = db.all<{
		account_id: string
		uri: string
		silent: number
		username: string
		domain: string | null
	}>(
		`SELECT m.account_id, a.uri, m.silent, a.username, a.domain FROM status_mentions m JOIN accounts a ON a.id = m.account_id
		WHERE m.status_id = ? ORDER BY a.id`,
		statusId
	)
	const reached = isDistributable(row.visibility)
		? db
				.all<{ id: string }>(
					`SELECT r.account_id AS id FROM statuses r JOIN accounts a ON a.id = r.account_id
					WHERE r.reblog_of_id = ?1 AND a.domain IS NOT NULL
					UNION
					SELECT p.account_id FROM statuses p JOIN accounts a ON a.id = p.account_id
					WHERE p.id = ?2 AND a.domain IS NOT NULL`,
					statusId,
					row.in_reply_to_id
				)
				.map((r) => r.id)
		: []
	const { host, origin } = new URL(row.actor_uri)
	return {
		id: row.id,
		uri: row.uri,
		url: `${origin}/@${row.username}/${row.id}`,
		actorUri: row.actor_uri,
		visibility: row.visibility,
		content: row.content,
		spoilerText: row.spoiler_text,
		sensitive: row.sensitive === 1,
		language: row.language,
		publishedAt: row.published_at,
		editedAt: row.edited_at,
		inReplyToUri: row.in_reply_to_uri,
		recipients: mentioned.map((m) => ({ accountId: m.account_id, uri: m.uri, silent: m.silent === 1 })),
		reached,
		tags: db
			.all<{ name: string }>('SELECT name FROM status_tags WHERE status_id = ? ORDER BY name', statusId)
			.map((t) => ({ name: t.name, href: `${origin}/tags/${encodeURIComponent(t.name)}` })),
		media: db.all<{ url: string; type: string; description: string }>(
			'SELECT url, type, description FROM media_attachments WHERE status_id = ? ORDER BY position, id',
			statusId
		),
		mentionNames: new Map(mentioned.map((m) => [m.uri, `@${m.username}@${m.domain ?? host}`])),
	}
}

function noteOf(facts: StatusFacts): Record<string, unknown> {
	const { to, cc } = addressingOf(facts.visibility, followersUri(facts.actorUri), facts.recipients)
	return {
		id: facts.uri,
		type: 'Note',
		summary: facts.spoilerText === '' ? null : facts.spoilerText,
		inReplyTo: facts.inReplyToUri,
		published: facts.publishedAt,
		...(facts.editedAt === null ? {} : { updated: facts.editedAt }),
		url: facts.url,
		attributedTo: facts.actorUri,
		to,
		cc,
		sensitive: facts.sensitive,
		content: facts.content,
		...(facts.language === null ? {} : { contentMap: { [facts.language]: facts.content } }),
		attachment: facts.media.map((m) => ({
			type: 'Document',
			mediaType: null,
			url: m.url,
			name: m.description === '' ? null : m.description,
		})),
		tag: [
			...facts.recipients
				.filter((r) => !r.silent)
				.map((r) => ({ type: 'Mention', href: r.uri, name: facts.mentionNames.get(r.uri) ?? r.uri })),
			...facts.tags.map((t) => ({ type: 'Hashtag', href: t.href, name: `#${t.name}` })),
		],
	}
}

function statusAudience(facts: StatusFacts): Audience {
	return audienceOf(facts.visibility, facts.recipients, facts.reached)
}

export function createActivity(facts: StatusFacts): OutboundEnvelope {
	const note = noteOf(facts)
	return {
		activity: {
			'@context': CONTEXT,
			id: `${facts.uri}/activity`,
			type: 'Create',
			actor: facts.actorUri,
			published: facts.publishedAt,
			to: note.to,
			cc: note.cc,
			object: note,
		},
		audience: statusAudience(facts),
	}
}

export function updateActivity(facts: StatusFacts): OutboundEnvelope {
	const note = noteOf(facts)
	const at = facts.editedAt ?? facts.publishedAt
	return {
		activity: {
			'@context': CONTEXT,
			id: `${facts.uri}#updates/${Date.parse(at)}`,
			type: 'Update',
			actor: facts.actorUri,
			published: at,
			to: note.to,
			cc: note.cc,
			object: note,
		},
		audience: statusAudience(facts),
	}
}

export function deleteActivity(facts: StatusFacts): OutboundEnvelope {
	const { to, cc } = addressingOf(facts.visibility, followersUri(facts.actorUri), facts.recipients)
	return {
		activity: {
			'@context': CONTEXT,
			id: `${facts.uri}#delete`,
			type: 'Delete',
			actor: facts.actorUri,
			to,
			cc,
			object: { id: facts.uri, type: 'Tombstone', atomUri: facts.uri },
		},
		audience: statusAudience(facts),
	}
}

// A favourite goes to the status's author only.
export function likeActivity(input: { likeUri: string; actorUri: string; objectUri: string; authorId: string }) {
	return {
		activity: { '@context': CONTEXT, id: input.likeUri, type: 'Like', actor: input.actorUri, object: input.objectUri },
		audience: { followers: false, accounts: [input.authorId] },
	} satisfies OutboundEnvelope
}

export function undoLikeActivity(input: { likeUri: string; actorUri: string; objectUri: string; authorId: string }) {
	const like = likeActivity(input)
	return {
		activity: {
			'@context': CONTEXT,
			id: `${input.likeUri}/undo`,
			type: 'Undo',
			actor: input.actorUri,
			object: { id: input.likeUri, type: 'Like', actor: input.actorUri, object: input.objectUri },
		},
		audience: like.audience,
	} satisfies OutboundEnvelope
}

export type AnnounceInput = {
	announceUri: string
	actorUri: string
	visibility: Visibility
	publishedAt: string
	objectUri: string
	authorUri: string
	authorId: string
}

// A boost goes to the booster's followers and the original's author (Mastodon's TagManager#to/#cc for a reblog).
function announceAddressing(input: AnnounceInput): { to: string[]; cc: string[] } {
	const followers = followersUri(input.actorUri)
	switch (input.visibility) {
		case 'public':
			return { to: [PUBLIC_COLLECTION], cc: [input.authorUri, followers] }
		case 'unlisted':
			return { to: [followers], cc: [PUBLIC_COLLECTION, input.authorUri] }
		default:
			return { to: [followers], cc: [input.authorUri] }
	}
}

export function announceActivity(input: AnnounceInput) {
	const { to, cc } = announceAddressing(input)
	return {
		activity: {
			'@context': CONTEXT,
			id: input.announceUri,
			type: 'Announce',
			actor: input.actorUri,
			published: input.publishedAt,
			to,
			cc,
			object: input.objectUri,
		},
		audience: { followers: true, accounts: [input.authorId] },
	} satisfies OutboundEnvelope
}

export function undoAnnounceActivity(input: AnnounceInput) {
	const announce = announceActivity(input)
	const { to, cc } = announceAddressing(input)
	const { '@context': _, ...inner } = announce.activity
	return {
		activity: {
			'@context': CONTEXT,
			id: `${input.announceUri}/undo`,
			type: 'Undo',
			actor: input.actorUri,
			to,
			cc,
			object: inner,
		},
		audience: announce.audience,
	} satisfies OutboundEnvelope
}
