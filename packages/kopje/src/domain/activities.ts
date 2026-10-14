import {
	addressingOf,
	type Audience,
	audienceOf,
	availableLocalSql,
	availableSql,
	blockedSql,
	DISTRIBUTABLE_SQL,
	isDistributable,
	PUBLIC_COLLECTION,
	type Recipient,
	type Visibility,
} from './audience'
import { enqueueActivity } from './deliveries'
import { readOperation } from './operation'
import type { Db } from '../db/sql'
import { httpUrl } from '../platform/http-url'
import { sha256Hex } from '../platform/sha256'

// Outbound intents. A local change that federates records the ActivityPub activity it means and the audience it is
// for in outbound_activities, in the transaction of the change. Nothing is delivered here: B2 expands the audience
// into inboxes and delivers (design §4 "outbound"). outbound_activities.body is the envelope
//
//   { "activity": <the activity JSON>, "audience": { "followers": boolean, "accounts": [<account id>, ...] } }
//
// where followers means the signer's followers and accounts are the addressed accounts (silent recipients included,
// local ones too; delivery skips local recipients). An addressed account named in to/cc is delivered to by its shared
// inbox, a silent recipient by its personal inbox, and the recipient of an activity without to (a Like, Follow,
// Accept, Reject, Block or their Undo) by its shared inbox when it has one (deliveries.ts). Update and Delete are addressed
// and delivered to the audience the status already had and never wider: visibility cannot change, and a mention
// removed by an edit stays as a silent mention. Delete carries a Tombstone, not the content.

const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams'

const CONTEXT = [AS_CONTEXT, { sensitive: 'as:sensitive', Hashtag: 'as:Hashtag' }] as const

export type OutboundEnvelope = { activity: Record<string, unknown>; audience: Audience }

// Records the intent and its target inboxes (domain/deliveries.ts), or nothing if no remote inbox needs it. As in
// Mastodon, the followers are the current ones; a Delete also reaches every inbox that received the status or may
// still receive it, so a follower who left since still gets the Tombstone. Record a retraction before deleting the
// row it retracts: the receipts go with the row.
// withdraws: a Reject that ends a follow already accepted (see subjectOf in deliveries.ts).
export function recordOutbound(
	db: Db,
	signerId: string,
	envelope: OutboundEnvelope,
	now: number,
	options: { withdraws?: boolean } = {}
): void {
	enqueueActivity(db, signerId, envelope, now, options)
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
	media: { url: string; content_type: string | null; description: string }[]
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
		media: db.all<{ url: string; content_type: string | null; description: string }>(
			'SELECT url, content_type, description FROM media_attachments WHERE status_id = ? ORDER BY position, id',
			statusId
		),
		mentionNames: new Map(mentioned.map((m) => [m.uri, `@${m.username}@${m.domain ?? host}`])),
	}
}

export function noteOf(facts: StatusFacts): Record<string, unknown> {
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
		// Only http(s) URLs are published (HTML-3).
		attachment: facts.media.flatMap((m) => {
			const url = httpUrl(m.url)
			return url === null
				? []
				: [
						{
							type: 'Document',
							mediaType: m.content_type,
							url: url.href,
							name: m.description === '' ? null : m.description,
						},
					]
		}),
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

// Named after the edit's history entry, so two edits in the same millisecond are distinct activities.
export function updateActivity(facts: StatusFacts, editId: string): OutboundEnvelope {
	const note = noteOf(facts)
	const at = facts.editedAt ?? facts.publishedAt
	return {
		activity: {
			'@context': CONTEXT,
			id: `${facts.uri}#updates/${editId}`,
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
	// The original's author; null when the booster blocks it or its domain (VIS-15), so it is neither named nor sent.
	authorUri: string | null
	authorId: string | null
}

// The Announce input of a local boost by `boosterId` of a status by `author`, for every copy of that Announce (the one
// delivered, its Undo, and the outbox's). As Mastodon allows boosting a status of an account on a domain the booster
// blocks, the author is then left out of the addressing and the audience (VIS-15).
export function boostAnnounce(
	db: Db,
	boosterId: string,
	boost: Omit<AnnounceInput, 'authorUri' | 'authorId'>,
	author: { id: string; uri: string }
): AnnounceInput {
	const blocked = db.first(`SELECT 1 AS x WHERE ${blockedSql('?1', '?2')}`, boosterId, author.id) !== undefined
	return { ...boost, authorUri: blocked ? null : author.uri, authorId: blocked ? null : author.id }
}

// A boost goes to the booster's followers and the original's author (Mastodon's TagManager#to/#cc for a reblog).
function announceAddressing(input: AnnounceInput): { to: string[]; cc: string[] } {
	const followers = followersUri(input.actorUri)
	const author = input.authorUri === null ? [] : [input.authorUri]
	switch (input.visibility) {
		case 'public':
			return { to: [PUBLIC_COLLECTION], cc: [...author, followers] }
		case 'unlisted':
			return { to: [followers], cc: [PUBLIC_COLLECTION, ...author] }
		default:
			return { to: [followers], cc: author }
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
		audience: { followers: true, accounts: input.authorId === null ? [] : [input.authorId] },
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

// ---------------------------------------------------------------------------------------------------------------
// Follows (Mastodon's FollowService, UnfollowService, AuthorizeFollowService and RejectFollowService). Each goes to
// the other side's shared inbox, or its personal inbox without one (audienceTargets). A follow's id is
// `<actor>#follows/<edge id>`. Accept and Reject are named after the Follow they answer:
// `<actor>#accepts/follows/<sha256 of the Follow's id>`, so two generations of one follow get two answers and a
// replayed Follow names the same one; a Follow without an id (migrated rows) falls back to the edge id, as Mastodon's
// `#accepts/follows/<id>`.
// ---------------------------------------------------------------------------------------------------------------

export type FollowActivityInput = { followUri: string; actorUri: string; targetUri: string; targetId: string }

export function followUri(actorUri: string, edgeId: string): string {
	return `${actorUri}#follows/${edgeId}`
}

export function followActivity(input: FollowActivityInput) {
	return {
		activity: {
			'@context': AS_CONTEXT,
			id: input.followUri,
			type: 'Follow',
			actor: input.actorUri,
			object: input.targetUri,
		},
		audience: { followers: false, accounts: [input.targetId] },
	} satisfies OutboundEnvelope
}

export function undoFollowActivity(input: FollowActivityInput) {
	const { '@context': _, ...follow } = followActivity(input).activity
	return {
		activity: {
			'@context': AS_CONTEXT,
			id: `${input.followUri}/undo`,
			type: 'Undo',
			actor: input.actorUri,
			object: follow,
		},
		audience: { followers: false, accounts: [input.targetId] },
	} satisfies OutboundEnvelope
}

// The answer of a local account to a remote follow: Accept when it is (or becomes) accepted, Reject when a request is
// refused or a follower is removed. followUri is the remote Follow's id as received; edgeId is follows.id.
export type FollowAnswerInput = {
	localActorUri: string
	followerUri: string
	followerId: string
	followUri: string | null
	edgeId: string
}

export function followAnswerActivity(kind: 'Accept' | 'Reject', input: FollowAnswerInput) {
	const path = kind === 'Accept' ? 'accepts' : 'rejects'
	const name = input.followUri === null ? input.edgeId : sha256Hex(input.followUri)
	return {
		activity: {
			'@context': AS_CONTEXT,
			id: `${input.localActorUri}#${path}/follows/${name}`,
			type: kind,
			actor: input.localActorUri,
			object: {
				...(input.followUri === null ? {} : { id: input.followUri }),
				type: 'Follow',
				actor: input.followerUri,
				object: input.localActorUri,
			},
		},
		audience: { followers: false, accounts: [input.followerId] },
	} satisfies OutboundEnvelope
}

// ---------------------------------------------------------------------------------------------------------------
// Blocks (Mastodon's BlockService and UnblockService): a Block of a remote account, and its Undo, go to the blocked
// account only, by its shared inbox or its personal inbox without one (audienceTargets), as a Follow does. A block's
// id is `<actor>#blocks/<blocks.id>`, as Mastodon names it; a block without a stored uri (migrated rows) gets the id
// this instance would have given it.
// ---------------------------------------------------------------------------------------------------------------

export type BlockActivityInput = { blockUri: string; actorUri: string; targetUri: string; targetId: string }

export function blockUri(actorUri: string, edgeId: string): string {
	return `${actorUri}#blocks/${edgeId}`
}

export function blockActivity(input: BlockActivityInput) {
	return {
		activity: {
			'@context': AS_CONTEXT,
			id: input.blockUri,
			type: 'Block',
			actor: input.actorUri,
			object: input.targetUri,
		},
		audience: { followers: false, accounts: [input.targetId] },
	} satisfies OutboundEnvelope
}

export function undoBlockActivity(input: BlockActivityInput) {
	const { '@context': _, ...block } = blockActivity(input).activity
	return {
		activity: {
			'@context': AS_CONTEXT,
			id: `${input.blockUri}/undo`,
			type: 'Undo',
			actor: input.actorUri,
			object: block,
		},
		audience: { followers: false, accounts: [input.targetId] },
	} satisfies OutboundEnvelope
}

// ---------------------------------------------------------------------------------------------------------------
// Local objects served over ActivityPub (VIS-4): the Note of a public or unlisted local status, and the outbox. Both
// come from statusFacts and noteOf, the data of the outbound Create, so the served object and the delivered one agree.
// ---------------------------------------------------------------------------------------------------------------

// Public, unlisted, local, and not by a suspended account. Anything else answers as missing.
const SERVABLE = `s.visibility IN ${DISTRIBUTABLE_SQL} AND ${availableLocalSql('l')}`

// The Note as serialized JSON-LD.
export const getLocalNote = readOperation<{ uri: string }, string | null>((db, { uri }) => {
	const row = db.first<{ id: string }>(
		`SELECT s.id FROM statuses s JOIN local_accounts l ON l.account_id = s.account_id
		WHERE s.uri = ? AND s.reblog_of_id IS NULL AND ${SERVABLE}`,
		uri
	)
	const facts = row === undefined ? null : statusFacts(db, row.id)
	return facts === null ? null : JSON.stringify({ '@context': CONTEXT, ...noteOf(facts) })
})

// A legacy /ap/o/<uuid> the cutover kept (docs/cutover.md): the proxy id a legacy instance gave a remote status
// (statuses.legacy_ap_o), or the id of a local image (media_attachments.legacy_ap_o). Federation URLs do not change, so
// they keep answering, without showing more than the status they belong to (VIS-4): a remote proxy moves to the
// original only when that status is public and the original is https; an image is shown only with a servable status.
// Anything else is not found.
// location: where a remote proxy moves; image: the Image document. Both null: not found. (One shape, so the RPC type
// stays simple.)
export type LegacyObject = { location: string | null; image: string | null }

export const getLegacyObject = readOperation<{ uuid: string; origin: string }, LegacyObject>((db, { uuid, origin }) => {
	const remote = db.first<{ uri: string }>(
		`SELECT s.uri FROM statuses s JOIN accounts a ON a.id = s.account_id
		WHERE s.legacy_ap_o = ? AND a.domain IS NOT NULL AND s.reblog_of_id IS NULL AND s.visibility = 'public'`,
		uuid
	)
	if (remote !== undefined) {
		const location = httpUrl(remote.uri)
		return { location: location?.protocol === 'https:' ? location.href : null, image: null }
	}
	const image = db.first<{ url: string; description: string; content_type: string | null; author: string }>(
		`SELECT m.url, m.description, m.content_type, a.uri AS author
		FROM media_attachments m JOIN statuses s ON s.id = m.status_id
		JOIN local_accounts l ON l.account_id = s.account_id JOIN accounts a ON a.id = s.account_id
		WHERE m.legacy_ap_o = ? AND s.reblog_of_id IS NULL AND ${SERVABLE}`,
		uuid
	)
	const url = image === undefined ? null : httpUrl(image.url)
	if (image === undefined || url === null) {
		return { location: null, image: null }
	}
	return {
		location: null,
		image: JSON.stringify({
			'@context': AS_CONTEXT,
			id: `${origin}/ap/o/${uuid}`,
			type: 'Image',
			attributedTo: image.author,
			url: url.href,
			...(image.content_type === null ? {} : { mediaType: image.content_type }),
			...(image.description === '' ? {} : { name: image.description }),
		}),
	}
})

export const OUTBOX_PAGE_SIZE = 20

// Items are serialized JSON: RPC types cannot carry `unknown`.
export type OutboxPage = { total: number | null; items: string[]; next: string | null }

// A local actor's outbox, newest first: Create for its statuses, Announce for its boosts (of public or unlisted
// originals only). before null asks for the count only; otherwise a page of statuses with ids below it.
export const getOutbox = readOperation<{ username: string; before: string | null }, OutboxPage | null>(
	(db, { username, before }) => {
		const owner = db.first<{ id: string; uri: string }>(
			`SELECT a.id, a.uri FROM accounts a JOIN local_accounts l ON l.account_id = a.id
			WHERE a.domain IS NULL AND a.username = ? AND ${availableLocalSql('l')}`,
			username
		)
		if (owner === undefined) {
			return null
		}
		const listed = `FROM statuses s JOIN local_accounts l ON l.account_id = s.account_id
			LEFT JOIN statuses o ON o.id = s.reblog_of_id
			WHERE s.account_id = ?1 AND ${SERVABLE}
				AND (s.reblog_of_id IS NULL OR (o.visibility IN ${DISTRIBUTABLE_SQL} AND ${availableSql('o.account_id')}))`
		// The count only for the collection itself; a page does not need it.
		if (before === null) {
			return {
				total: db.first<{ n: number }>(`SELECT count(*) AS n ${listed}`, owner.id)?.n ?? 0,
				items: [],
				next: null,
			}
		}
		const rows = db.all<{
			id: string
			uri: string
			visibility: Visibility
			published_at: string
			original_id: string | null
			original_uri: string | null
			original_author_id: string | null
			original_author_uri: string | null
		}>(
			`SELECT s.id, s.uri, s.visibility, s.published_at, o.id AS original_id, o.uri AS original_uri,
				o.account_id AS original_author_id, (SELECT uri FROM accounts WHERE id = o.account_id) AS original_author_uri
			${listed} AND s.id < ?2 ORDER BY s.id DESC LIMIT ?3`,
			owner.id,
			before,
			OUTBOX_PAGE_SIZE + 1
		)
		const items: string[] = []
		for (const row of rows.slice(0, OUTBOX_PAGE_SIZE)) {
			if (row.original_uri !== null && row.original_author_uri !== null && row.original_author_id !== null) {
				items.push(
					JSON.stringify(
						announceActivity(
							boostAnnounce(
								db,
								owner.id,
								{
									announceUri: row.uri,
									actorUri: owner.uri,
									visibility: row.visibility,
									publishedAt: row.published_at,
									objectUri: row.original_uri,
								},
								{ id: row.original_author_id, uri: row.original_author_uri }
							)
						).activity
					)
				)
				continue
			}
			const facts = statusFacts(db, row.id)
			if (facts !== null) {
				items.push(JSON.stringify(createActivity(facts).activity))
			}
		}
		const last = rows[OUTBOX_PAGE_SIZE - 1]
		return { total: null, items, next: rows.length > OUTBOX_PAGE_SIZE && last !== undefined ? last.id : null }
	}
)
