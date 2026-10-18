import { ANSWER_BYTES } from './answer-budget'
import {
	addresses,
	addressingOf,
	type Audience,
	audienceOf,
	availableLocalSql,
	availableSql,
	DISTRIBUTABLE_SQL,
	isDistributable,
	PUBLIC_COLLECTION,
	quotePolicyFlags,
	reachQuoters,
	type Recipient,
	type Visibility,
} from './audience'
import { type DeliveryEnvelope, enqueueActivity, type ReachOf } from './deliveries'
import { readOperation } from './operation'
import { actorUriSql, usernameSql } from './profile-bounds'
import { type NoteQuote, noteQuote } from './quotes'
import {
	MAX_PRESENTED_TAGS,
	MAX_STATUS_MEDIA,
	MAX_STATUS_MENTION_ROWS,
	mediaDescriptionSql,
	mediaUrlSql,
	pollOptionsSql,
	tagNameSql,
} from './status-bounds'
import { readWindow, singleWindow, windowJson } from './windows'
import type { Db } from '../db/sql'
import { utf8Length } from '../platform/dump-format'
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

// The terms of a status's interaction policy (GoToSocial's namespace, as Mastodon's interaction_policies context) and
// of its quote (Mastodon's quotes context: FEP-044f's quote and quoteAuthorization, Fedibird's quoteUri, Misskey's
// _misskey_quote).
const INTERACTION_POLICY = {
	gts: 'https://gotosocial.org/ns#',
	interactionPolicy: { '@id': 'gts:interactionPolicy', '@type': '@id' },
	canQuote: { '@id': 'gts:canQuote', '@type': '@id' },
	automaticApproval: { '@id': 'gts:automaticApproval', '@type': '@id' },
	manualApproval: { '@id': 'gts:manualApproval', '@type': '@id' },
	quote: { '@id': 'https://w3id.org/fep/044f#quote', '@type': '@id' },
	quoteUri: 'http://fedibird.com/ns#quoteUri',
	_misskey_quote: 'https://misskey-hub.net/ns#_misskey_quote',
	quoteAuthorization: { '@id': 'https://w3id.org/fep/044f#quoteAuthorization', '@type': '@id' },
} as const

const NOTE_CONTEXT = [AS_CONTEXT, { sensitive: 'as:sensitive', Hashtag: 'as:Hashtag', ...INTERACTION_POLICY }] as const

// The context of a status carrying a poll: Mastodon's votersCount extension too.
const POLL_CONTEXT = [
	AS_CONTEXT,
	{
		sensitive: 'as:sensitive',
		Hashtag: 'as:Hashtag',
		toot: 'http://joinmastodon.org/ns#',
		votersCount: 'toot:votersCount',
		...INTERACTION_POLICY,
	},
] as const

function contextOf(facts: StatusFacts) {
	return facts.poll === null ? NOTE_CONTEXT : POLL_CONTEXT
}

// signedBy 'instance': signed by the instance actor rather than the lane's account (a report's Flag, deliveries.ts);
// immutable and reachOf: a stamp's signed Delete (deliveries.ts DeliveryEnvelope).
export type OutboundEnvelope = Omit<DeliveryEnvelope, 'audience'> & { audience: Audience }

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
	options: { withdraws?: boolean; audienceOnly?: boolean } = {}
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
	// Remote accounts a distributable status reaches beyond its addressing: those that reblogged it, the author of the
	// replied-to status, and the authors of its accepted quotes (audience.ts reachQuoters); may repeat an account, which
	// audienceOf deduplicates.
	reached: string[]
	// statuses.quote_policy, Mastodon's flags (audience.ts QUOTE_POLICY_FLAGS).
	quotePolicy: number
	quote: NoteQuote | null
	tags: { name: string; href: string }[]
	media: { url: string | null; content_type: string | null; description: string }[]
	// The Mention tags (href, name) the Note shows.
	mentions: { href: string; name: string }[]
	// The status's poll, which makes its object a Question.
	poll: PollFacts | null
}

// A poll as its Question shows it (ActivityPub::NoteSerializer): the choices with their counts (none while hide_totals
// hides them and the poll is open), its end, whether the cron has closed it, and its voters.
export type PollFacts = {
	options: string[]
	tallies: number[]
	multiple: boolean
	hideTotals: boolean
	expiresAt: string | null
	ended: boolean
	votersCount: number | null
}

function pollFacts(db: Db, statusId: string): PollFacts | null {
	const row = db.first<{
		options: string
		tallies: string
		multiple: number
		hide_totals: number
		expires_at: string | null
		ended: number
		voters_count: number | null
	}>(
		`SELECT ${pollOptionsSql('options')} AS options, tallies, multiple, hide_totals, expires_at, ended, voters_count
		FROM polls WHERE status_id = ? AND removed = 0 AND ${pollOptionsSql('options')} IS NOT NULL`,
		statusId
	)
	return row === undefined
		? null
		: {
				options: JSON.parse(row.options) as string[],
				tallies: JSON.parse(row.tallies) as number[],
				multiple: row.multiple === 1,
				hideTotals: row.hide_totals === 1,
				expiresAt: row.expires_at,
				ended: row.ended === 1,
				votersCount: row.voters_count,
			}
}

// options.reached false leaves the remote accounts the status reached out (reached: []): a read that only serves the
// Note or its Create (noteOf and createActivity's activity do not use them; only its audience does) need not read
// every remote boost of the status. The object endpoint, the outbox and the featured collection pass it.
export function statusFacts(db: Db, statusId: string, options: { reached?: boolean } = {}): StatusFacts | null {
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
		quote_policy: number
		actor_uri: string
		username: string
	}>(
		`SELECT s.id, s.uri, s.visibility, s.content, s.spoiler_text, s.sensitive, s.language, s.published_at, s.edited_at,
			s.in_reply_to_uri, s.in_reply_to_id, s.quote_policy, a.uri AS actor_uri, a.username
		FROM statuses s JOIN accounts a ON a.id = s.account_id WHERE s.id = ?`,
		statusId
	)
	if (row === undefined) {
		return null
	}
	const mentioned = db.all<{ account_id: string; uri: string; silent: number }>(
		`SELECT m.account_id, a.uri, m.silent FROM status_mentions m JOIN accounts a ON a.id = m.account_id
		WHERE m.status_id = ? ORDER BY a.id`,
		statusId
	)
	const reached =
		options.reached !== false && isDistributable(row.visibility)
			? [
					...db
						.all<{ id: string }>(
							`SELECT r.account_id AS id FROM statuses r JOIN accounts a ON a.id = r.account_id
							WHERE r.reblog_of_id = ?1 AND a.domain IS NOT NULL
							UNION
							SELECT p.account_id FROM statuses p JOIN accounts a ON a.id = p.account_id
							WHERE p.id = ?2 AND a.domain IS NOT NULL`,
							statusId,
							row.in_reply_to_id
						)
						.map((r) => r.id),
					...reachQuoters(db, statusId),
				]
			: []
	const { host, origin } = new URL(row.actor_uri)
	// The Mention tags, hashtags and attachments the Note shows, read through the projections the API presenter reads
	// them with (status-bounds.ts, profile-bounds.ts), so the Note shows what the Status entity shows (RES-3): at most
	// MAX_STATUS_MENTION_ROWS mentions that are not silent, by account id; MAX_PRESENTED_TAGS hashtags by name, one
	// whose name is past its bound left out; MAX_STATUS_MEDIA shown attachments, URLs past their bound as none and
	// descriptions cut. The addressing (to, cc) and the delivery keep every recipient.
	const mentionTags = db.all<{ uri: string; username: string; domain: string | null }>(
		`SELECT ${actorUriSql('a.uri')} AS uri, ${usernameSql('a.username')} AS username, a.domain FROM accounts a
		WHERE a.id IN (SELECT m.account_id FROM status_mentions m INDEXED BY status_mentions_shown
			WHERE m.status_id = ?1 AND m.silent = 0 ORDER BY m.account_id LIMIT ${MAX_STATUS_MENTION_ROWS})
		ORDER BY a.id`,
		statusId
	)
	const tags = db.all<{ name: string }>(
		`SELECT n.name FROM (SELECT ${tagNameSql('name')} AS name FROM status_tags WHERE status_id = ?1 ORDER BY name
			LIMIT ${MAX_PRESENTED_TAGS}) n WHERE n.name IS NOT NULL`,
		statusId
	)
	const media = db.all<{ url: string | null; content_type: string | null; description: string }>(
		`SELECT ${mediaUrlSql('url')} AS url, content_type, ${mediaDescriptionSql('description')} AS description
		FROM media_attachments INDEXED BY media_attachments_status WHERE status_id = ?1 AND shown = 1
		ORDER BY position, id LIMIT ${MAX_STATUS_MEDIA}`,
		statusId
	)
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
		tags: tags.map((t) => ({ name: t.name, href: `${origin}/tags/${encodeURIComponent(t.name)}` })),
		media,
		mentions: mentionTags.map((m) => ({ href: m.uri, name: `@${m.username}@${m.domain ?? host}` })),
		poll: pollFacts(db, statusId),
		quotePolicy: row.quote_policy,
		quote: noteQuote(db, statusId),
	}
}

// A poll's part of its Question: oneOf (anyOf when it is multiple) with each choice's votes as replies.totalItems,
// left out while hide_totals hides them and the poll is open; endTime, closed once the cron has ended it, and
// votersCount when known.
function questionOf(poll: PollFacts): Record<string, unknown> {
	const shown = !poll.hideTotals || poll.ended
	const choices = poll.options.map((name, i) => ({
		type: 'Note',
		name,
		replies: { type: 'Collection', ...(shown ? { totalItems: poll.tallies[i] ?? 0 } : {}) },
	}))
	return {
		[poll.multiple ? 'anyOf' : 'oneOf']: choices,
		...(poll.expiresAt === null ? {} : { endTime: poll.expiresAt }),
		...(poll.ended && poll.expiresAt !== null ? { closed: poll.expiresAt } : {}),
		...(poll.votersCount === null ? {} : { votersCount: poll.votersCount }),
	}
}

export function noteOf(facts: StatusFacts): Record<string, unknown> {
	const { to, cc } = addressingOf(facts.visibility, followersUri(facts.actorUri), facts.recipients)
	return {
		id: facts.uri,
		type: facts.poll === null ? 'Note' : 'Question',
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
			const url = m.url === null ? null : httpUrl(m.url)
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
			...facts.mentions.map((m) => ({ type: 'Mention', href: m.href, name: m.name })),
			...facts.tags.map((t) => ({ type: 'Hashtag', href: t.href, name: `#${t.name}` })),
		],
		...(facts.poll === null ? {} : questionOf(facts.poll)),
		...(facts.quote === null ? {} : quoteOf(facts.quote)),
		interactionPolicy: { canQuote: { automaticApproval: automaticApproval(facts) } },
	}
}

// ActivityPub::NoteSerializer's quote properties: quote (the quoted status, or a Tombstone once it is gone), and,
// while it is there, _misskey_quote and quoteUri whatever the quote's state (Misskey reads only those, and only from a
// Create: design §8); quoteAuthorization only while the quote is accepted with a stamp.
function quoteOf(quote: NoteQuote): Record<string, unknown> {
	return {
		quote: quote.quotedUri ?? { type: 'Tombstone' },
		...(quote.quotedUri === null ? {} : { _misskey_quote: quote.quotedUri, quoteUri: quote.quotedUri }),
		...(quote.stamp === null ? {} : { quoteAuthorization: quote.stamp }),
	}
}

// ActivityPub::NoteSerializer#interaction_policy: who may quote the status with automatic approval, from the automatic
// half of its policy: everyone, its author's followers or following collection, or its author alone for nobody
// (Kopje, as Mastodon, never publishes manual approval). Advisory to receivers (FEP-044f): Kopje's answer to a
// QuoteRequest (R36) is the approval.
function automaticApproval(facts: StatusFacts): string[] {
	const flags = quotePolicyFlags(facts.quotePolicy, 'automatic')
	const approved = [
		...(flags.includes('public') ? [PUBLIC_COLLECTION] : []),
		...(flags.includes('followers') ? [followersUri(facts.actorUri)] : []),
		...(flags.includes('following') ? [`${facts.actorUri}/following`] : []),
	]
	return approved.length === 0 ? [facts.actorUri] : approved
}

function statusAudience(facts: StatusFacts): Audience {
	return audienceOf(facts.visibility, facts.recipients, facts.reached)
}

// The reach of the local status `statusId` for another activity's reachOf (deliveries.ts): its owner, its uri and its
// current audience. Null when it is gone or not local.
export function statusReach(db: Db, statusId: string): ReachOf | null {
	const owner = db.first<{ account_id: string }>(
		'SELECT s.account_id FROM statuses s JOIN local_accounts l ON l.account_id = s.account_id WHERE s.id = ?',
		statusId
	)
	const facts = owner === undefined ? null : statusFacts(db, statusId)
	return owner === undefined || facts === null
		? null
		: { owner: owner.account_id, object: facts.uri, audience: statusAudience(facts) }
}

export function createActivity(facts: StatusFacts): OutboundEnvelope {
	const note = noteOf(facts)
	return {
		activity: {
			'@context': contextOf(facts),
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
			'@context': contextOf(facts),
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

// The Update of a local poll's counts or its end (ActivityPub::UpdatePollSerializer), named after the time it is
// recorded. It reaches the poll's remote voters too (DistributePollUpdateWorker), as recipientsFor decides (R23).
export function pollUpdateActivity(facts: StatusFacts, at: number): OutboundEnvelope {
	const update = updateActivity(facts, `poll-${at}`)
	return { activity: update.activity, audience: { ...update.audience, pollVoters: facts.id } }
}

// A local account's vote in a remote poll (ActivityPub::VoteSerializer): a Create of a Note naming the choice, in reply
// to the poll's status, to its author alone.
export function voteActivity(input: {
	voteUri: string
	actorUri: string
	name: string
	statusUri: string
	authorUri: string
	authorId: string
}) {
	return {
		activity: {
			'@context': AS_CONTEXT,
			id: `${input.voteUri}/activity`,
			type: 'Create',
			actor: input.actorUri,
			to: [input.authorUri],
			object: {
				id: input.voteUri,
				type: 'Note',
				name: input.name,
				attributedTo: input.actorUri,
				inReplyTo: input.statusUri,
				to: [input.authorUri],
			},
		},
		audience: { followers: false, accounts: [input.authorId] },
	} satisfies OutboundEnvelope
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
	// The original's author; null when the Announce leaves it out (boostAnnounce), so it is neither named nor sent.
	authorUri: string | null
	authorId: string | null
}

// The Announce input of a local boost by `boosterId` of a status by `author`, for the Announce (`content`: the one
// delivered and the outbox's) or for its Undo (`retraction`). Whether it names the author is the policy's (addresses
// in audience.ts, R22): as Mastodon allows boosting a status of an account on a domain the booster blocks, the
// Announce then leaves the author out of the addressing and the audience (VIS-15); the Undo names and reaches them
// whatever the booster blocks, as every retraction does (VIS-13).
export function boostAnnounce(
	db: Db,
	boosterId: string,
	boost: Omit<AnnounceInput, 'authorUri' | 'authorId'>,
	author: { id: string; uri: string },
	kind: 'content' | 'retraction'
): AnnounceInput {
	const named = addresses(db, kind, boosterId, author.id)
	return { ...boost, authorUri: named ? author.uri : null, authorId: named ? author.id : null }
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
// Quote requests and stamps (FEP-044f, Mastodon 4.5's AcceptQuoteRequestSerializer, RejectQuoteRequestSerializer and
// DeleteQuoteAuthorizationSerializer). An answer goes to the requester only, as a Follow's does, and names the request
// by its id (with its actor, object and instrument by id, never the inlined Note). An Accept's delivery subject is the
// stamp it grants (deliveries.ts subjectOf), so the stamp's Delete supersedes it while it waits.
// ---------------------------------------------------------------------------------------------------------------

const QUOTE_REQUEST_CONTEXT = [AS_CONTEXT, { QuoteRequest: 'https://w3id.org/fep/044f#QuoteRequest' }] as const

// The stamp of an accepted quote of a local status (QuoteAuthorization), under its quoted author.
export function stampUri(authorUri: string, authorizationId: string): string {
	return `${authorUri}/quote_authorizations/${authorizationId}`
}

export type QuoteRequestRef = {
	id: string
	actorUri: string
	actorId: string
	quotedUri: string
	instrumentUri: string
}

// Mastodon's QuoteRequestSerializer: only to the quoted author, with the quoting Note inlined. Its id
// (quoteRequestUri), which an Accept or Reject names, is also its delivery subject (deliveries.ts subjectOf), so an
// edit or the status's Delete cannot drop it while it waits (test/quote-authoring.test.ts concurrency table, row 5).
export function quoteRequestActivity(facts: StatusFacts, quoted: { uri: string; authorId: string }): OutboundEnvelope {
	const [as, terms] = contextOf(facts)
	return {
		activity: {
			'@context': [as, { ...terms, QuoteRequest: 'https://w3id.org/fep/044f#QuoteRequest' }],
			id: quoteRequestUri(facts.uri),
			type: 'QuoteRequest',
			actor: facts.actorUri,
			object: quoted.uri,
			instrument: noteOf(facts),
		},
		audience: { followers: false, accounts: [quoted.authorId] },
	}
}

export function quoteRequestUri(statusUri: string): string {
	return `${statusUri}#quote-request`
}

// result: the stamp an Accept grants.
export function quoteAnswerActivity(
	kind: 'Accept' | 'Reject',
	authorUri: string,
	request: QuoteRequestRef,
	result?: string
): OutboundEnvelope {
	return {
		activity: {
			'@context': QUOTE_REQUEST_CONTEXT,
			id: `${authorUri}#${kind === 'Accept' ? 'accepts' : 'rejects'}/quote_requests/${sha256Hex(request.id)}`,
			type: kind,
			actor: authorUri,
			object: {
				id: request.id,
				type: 'QuoteRequest',
				actor: request.actorUri,
				object: request.quotedUri,
				instrument: request.instrumentUri,
			},
			...(result === undefined ? {} : { result }),
		},
		audience: { followers: false, accounts: [request.actorId] },
	}
}

// A revoke's Reject of a request answered for the quote, naming the request by id alone. Mastodon 4.5.11 matches a
// Reject by its object's id against the quote's current request (Reject#quote_request_from_object); an embedded
// QuoteRequest that matches none falls into reject_embedded_quote_request, which calls an undefined quoting_status
// (app/lib/activitypub/activity/reject.rb:39, a NameError), so a revoke never inlines it. Recorded as a retraction
// (withdraws): it withdraws an approval already sent, so admission never refuses it and a suspension does not drop it,
// as the stamp's Delete it follows in the lane.
export function revocationRejectActivity(
	authorUri: string,
	request: Pick<QuoteRequestRef, 'id' | 'actorId'>
): OutboundEnvelope {
	return {
		activity: {
			'@context': QUOTE_REQUEST_CONTEXT,
			id: `${authorUri}#rejects/quote_requests/${sha256Hex(request.id)}/revoked`,
			type: 'Reject',
			actor: authorUri,
			object: request.id,
		},
		audience: { followers: false, accounts: [request.actorId] },
	}
}

// Mastodon's public, id-only stamp Delete. LD-signed before it is recorded and delivered unedited, so receivers can
// relay the author's proof (federation/ld-sign.ts, VIS-28).
export function stampDeleteActivity(authorUri: string, stamp: string): Record<string, unknown> {
	return {
		'@context': [AS_CONTEXT, 'https://w3id.org/security/v1'],
		id: `${stamp}#delete`,
		type: 'Delete',
		actor: authorUri,
		to: [PUBLIC_COLLECTION],
		object: stamp,
	}
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
// Reports (Mastodon's ReportService#forward_to_origin! and #forward_to_replied_to!, app/services/report_service.rb:53-67):
// a Flag of the reported account and statuses (ActivityPub::FlagSerializer, app/serializers/activitypub/
// flag_serializer.rb:3-26), from the instance actor (Account.representative, report_service.rb:98-100), so the
// reporter is not named. It has no to: it goes to each forwarded server's inbox as a Follow does (audienceTargets).
// ---------------------------------------------------------------------------------------------------------------

// The instance actor (federation.ts serves it at /actor).
export function instanceActorUri(domain: string): string {
	return `https://${domain}/actor`
}

export function flagActivity(input: {
	id: string
	actorUri: string
	targetUri: string
	statusUris: readonly string[]
	comment: string
	recipients: readonly string[]
}) {
	return {
		activity: {
			'@context': AS_CONTEXT,
			id: input.id,
			type: 'Flag',
			actor: input.actorUri,
			content: input.comment,
			object: [input.targetUri, ...input.statusUris],
		},
		audience: { followers: false, accounts: [...input.recipients] },
		signedBy: 'instance',
	} satisfies OutboundEnvelope
}

// ---------------------------------------------------------------------------------------------------------------
// Pins (Mastodon's Api::V1::Statuses::PinsController): pinning a status adds its uri to the actor's featured
// collection, unpinning removes it, each told to the actor's followers (ActivityPub::AddSerializer and
// RemoveSerializer, sent by ActivityPub::RawDistributionWorker to followers.inboxes). Neither is content (R23): it
// carries a uri only, and goes to every accepted remote follower, as Mastodon sends it. Mastodon's carries no id;
// Kopje names each `<actor>#featured/<local id>`.
// ---------------------------------------------------------------------------------------------------------------

// StatusPinValidator::PIN_LIMIT: a local account pins at most this many statuses (status-actions.ts), so its featured
// collection holds at most this many.
export const PIN_LIMIT = 5

// The featured collection of a local actor (ActivityPub::ActorSerializer#featured), served by federation.ts.
export function featuredUri(actorUri: string): string {
	return `${actorUri}/collections/featured`
}

export function featuredActivity(type: 'Add' | 'Remove', input: { id: string; actorUri: string; statusUri: string }) {
	return {
		activity: {
			'@context': AS_CONTEXT,
			id: input.id,
			type,
			actor: input.actorUri,
			object: input.statusUri,
			target: featuredUri(input.actorUri),
		},
		audience: { followers: true, accounts: [] },
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
	const facts = row === undefined ? null : statusFacts(db, row.id, { reached: false })
	return facts === null ? null : JSON.stringify({ '@context': contextOf(facts), ...noteOf(facts) })
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

// The bytes of an outbox page's serialized activities at most (RES-3): ANSWER_BYTES less a reserve for the
// collection page around them, which the Worker builds. Activities are admitted newest first while they fit, the first
// whatever its size (one Create of a local status, a unit); a page cut there continues from its last activity.
export const OUTBOX_BYTES = ANSWER_BYTES - 64 * 1024

// Items are serialized JSON: RPC types cannot carry `unknown`.
export type OutboxPage = { total: number | null; items: string[]; next: string | null }

// A local actor's outbox, newest first: Create for its statuses, Announce for its boosts (of public or unlisted
// originals only). before null asks for the count only; otherwise a page of statuses with ids below it. The count is
// the account's stored statuses_count, as Mastodon's OutboxesController gives totalItems (@account.statuses_count): one
// row, however long the history.
export const getOutbox = readOperation<{ username: string; before: string | null }, OutboxPage | null>(
	(db, { username, before }) => {
		const owner = db.first<{ id: string; uri: string; statuses_count: number }>(
			`SELECT a.id, a.uri, a.statuses_count FROM accounts a JOIN local_accounts l ON l.account_id = a.id
			WHERE a.domain IS NULL AND lower(a.username) = lower(?1) AND a.username = ?1 AND ${availableLocalSql('l')}`,
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
			return { total: owner.statuses_count, items: [], next: null }
		}
		// A statuses_account window (windows.ts) below `before`: public and unlisted statuses and boosts of such
		// originals, then the rule, so unavailable originals cost a window. Statuses an anonymous reader may not see
		// supply no cursor (docs/visibility.md "Read bounds"). One more than a page tells whether more follow.
		const size = readWindow(OUTBOX_PAGE_SIZE + 1)
		const window = singleWindow(
			db,
			`SELECT s.id FROM statuses s WHERE s.account_id = ?1 AND s.id < ?2 AND s.visibility IN ${DISTRIBUTABLE_SQL}
				AND (s.reblog_of_id IS NULL OR EXISTS (SELECT 1 FROM statuses wo
					WHERE wo.id = s.reblog_of_id AND wo.visibility IN ${DISTRIBUTABLE_SQL}))
			ORDER BY s.id DESC LIMIT ?3`,
			size,
			owner.id,
			before,
			size
		)
		const rows =
			window.candidates.length === 0
				? []
				: db.all<{
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
						${listed} AND s.id IN (SELECT json_extract(value, '$.id') FROM json_each(?2)) ORDER BY s.id DESC`,
						owner.id,
						windowJson(window)
					)
		const items: string[] = []
		let bytes = 0
		let consumed = 0
		const admitted = (item: string): boolean => {
			const size = utf8Length(item) + 1
			if (bytes + size > OUTBOX_BYTES && items.length > 0) {
				return false
			}
			bytes += size
			items.push(item)
			return true
		}
		for (const row of rows.slice(0, OUTBOX_PAGE_SIZE)) {
			if (row.original_uri !== null && row.original_author_uri !== null && row.original_author_id !== null) {
				const announce = admitted(
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
								{ id: row.original_author_id, uri: row.original_author_uri },
								'content'
							)
						).activity
					)
				)
				if (!announce) {
					break
				}
				consumed++
				continue
			}
			const facts = statusFacts(db, row.id, { reached: false })
			if (facts !== null && !admitted(JSON.stringify(createActivity(facts).activity))) {
				break
			}
			consumed++
		}
		const last = rows[OUTBOX_PAGE_SIZE - 1]
		// Cut by bytes, the page continues from its last activity, before the window's continuation.
		const next =
			consumed < Math.min(rows.length, OUTBOX_PAGE_SIZE)
				? (rows[consumed - 1]?.id ?? null)
				: rows.length > OUTBOX_PAGE_SIZE && last !== undefined
					? last.id
					: window.cut
						? (window.candidates.at(-1)?.id ?? null)
						: null
		return { total: null, items, next }
	}
)

// A pinned status in the featured collection: the Note (serialized JSON-LD) of a public or unlisted one, else its uri
// alone (ActivityPub::CollectionsController#set_items: `item.distributable? ? item : uri`).
export type FeaturedItem = { uri: string; note: string | null }

// A local actor's featured collection (ActivityPub::CollectionsController, `featured`): its pinned statuses, newest pin
// first (Account#pinned_statuses), all at once (an OrderedCollection without pages). Null for no such actor, or a
// suspended one, as the outbox answers. The actor is found through the index of local usernames, and its pins through
// their primary key: at most PIN_LIMIT.
export const getFeatured = readOperation<{ username: string }, FeaturedItem[] | null>((db, { username }) => {
	const owner = db.first<{ id: string }>(
		`SELECT a.id FROM accounts a JOIN local_accounts l ON l.account_id = a.id
		WHERE a.domain IS NULL AND lower(a.username) = lower(?1) AND a.username = ?1 AND ${availableLocalSql('l')}`,
		username
	)
	if (owner === undefined) {
		return null
	}
	const rows = db.all<{ id: string; uri: string; servable: number }>(
		`SELECT s.id, s.uri, s.visibility IN ${DISTRIBUTABLE_SQL} AS servable
		FROM status_pins p CROSS JOIN statuses s ON s.id = p.status_id
		WHERE p.account_id = ?1 AND s.account_id = ?1 AND s.reblog_of_id IS NULL
		ORDER BY p.created_at DESC, s.id DESC LIMIT ?2`,
		owner.id,
		PIN_LIMIT
	)
	// The Notes within OUTBOX_BYTES (RES-3), in pin order, the first whatever its size; from the first that does not
	// fit, each pin is shown by its uri alone, as a pin that is not distributable is, and a receiver fetches it.
	let bytes = 0
	let full = false
	return rows.map((row) => {
		const facts = row.servable === 1 && !full ? statusFacts(db, row.id, { reached: false }) : null
		const note = facts === null ? null : JSON.stringify({ '@context': contextOf(facts), ...noteOf(facts) })
		const size = note === null ? 0 : utf8Length(note) + 1
		if (note !== null && bytes > 0 && bytes + size > OUTBOX_BYTES) {
			full = true
		}
		if (note === null || full) {
			return { uri: row.uri, note: null }
		}
		bytes += size
		return { uri: row.uri, note }
	})
})
