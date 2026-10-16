import { deleteAudience } from './audience'
import { authorize, authorizeStream } from './auth'
import { mentionedStatus, streamedNotification } from './notifications'
import { readOperation, sessionOperation } from './operation'
import { instanceOrigin } from './push'
import { presentStatus } from './status-presenter'
import { homeStatus } from './timelines'
import type { Db } from '../db/sql'
import { storeMaintenanceError } from '../platform/store-errors'
import type { StoreOperation } from '../platform/store-kernel'
import { grantsAny } from '../security/scopes'

// The streaming API's operations on the Store's data (Mastodon 4.5's streaming server; the sockets themselves are
// src/stream-hub.ts's). A write records what a stream may carry in the journal (stream_events, by a trigger of
// migration 0026_streaming, ids only), and a turn of the hub makes each message later, one unit at a time:
//
//   R33 (stream membership): a message (event e, subject x) reaches a subscription (viewer V, stream k) only if the
//   reference for (e, k) returns x to V in the transaction that makes the message, which also authorizes V's tokens
//   and checks k's scope; the payload is that reference's presentation for V. The references:
//     - `notification` on `user` (with a notification scope) and `user:notification`: V's notification list
//       positioned at x (streamedNotification in notifications.ts: R15, unfiltered, kept);
//     - `update` on `user`: home positioned at x (homeStatus in timelines.ts), for a status published within 6 hours
//       of its arrival (Mastodon's real-time window);
//     - `status.update` on `user`: home positioned at x or, with a notification scope, the mention reference (V's
//       notification read restricted to V's mention of x: mentionedStatus in notifications.ts); on
//       `user:notification`, the mention reference alone.
//   Each status is presented as REST presents it to V (presentStatus).
//
//   R32 (stream delete): a `delete` of x (a status, or a boost of it) reaches (V, k) only if, in the transaction that
//   first changes the status's audience, V was listening on `user` and could view x (R3), and k is `user`. The
//   capture (streamDelete) is taken once, before that change, in bounded rows (stream_delete_viewers, migration
//   0028_streaming_home); the unit re-checks only V's tokens.
//
// A unit is one subject for one viewer. Units go in a stable order (event id, then the subject within the event: 0 for
// the status, then a delete's captured boosts by id, then viewer account id ascending), and the position past a unit is
// persisted by compare-and-set before its messages are sent, so none is sent twice (streamAdvance). Delivery is at most
// once and live: REST is authoritative.

// The stream names Mastodon's streaming server knows (streaming/index.js channelNameToIds).
export const STREAM_NAMES: readonly string[] = [
	'user',
	'user:notification',
	'public',
	'public:local',
	'public:remote',
	'public:media',
	'public:local:media',
	'public:remote:media',
	'hashtag',
	'hashtag:local',
	'list',
	'direct',
]

// The streams Kopje serves; the others answer Unknown stream type until they are.
export type ServedStream = 'user' | 'user:notification'
export const SERVED_STREAMS: readonly ServedStream[] = ['user', 'user:notification']

// What a token may stream (streaming/index.js checkScopes and channelsForUserStream): `user` and the other timelines
// need `read:statuses`, `user:notification` and the notifications on `user` need `read:notifications` (`read`
// covers both).
export type StreamGrant = { statuses: boolean; notifications: boolean }

export function streamGrant(scopes: readonly string[]): StreamGrant {
	return {
		statuses: grantsAny(scopes, 'read:statuses'),
		notifications: grantsAny(scopes, 'read:notifications'),
	}
}

// Whether a token with `grant` may subscribe to `stream`.
export function maySubscribe(grant: StreamGrant, stream: string): boolean {
	return stream === 'user:notification' ? grant.notifications : grant.statuses
}

// Whether a subscription to `stream` carries notifications for a token with `grant`.
export function carriesNotifications(grant: StreamGrant, stream: ServedStream): boolean {
	return stream === 'user:notification' ? grant.notifications : grant.statuses && grant.notifications
}

// Whether a subscription to `stream` may carry an event of `kind` (the journal's: a notification inserted, a status
// inserted, a status edited, a delete captured) for a token with `grant`, before any reference is
// read: the streams and scopes each event goes to.
export function mayCarry(kind: string, grant: StreamGrant, stream: ServedStream): boolean {
	switch (kind) {
		case 'notification':
			return carriesNotifications(grant, stream)
		case 'status':
		case 'delete':
			return stream === 'user' && grant.statuses
		case 'edit':
			return stream === 'user' ? grant.statuses : grant.notifications
		default:
			return false
	}
}

// The `update` event's real-time window (Mastodon's Status::REAL_TIME_WINDOW): a status published more than this long
// before it arrived (a remote post fetched late) is not streamed.
const REAL_TIME_WINDOW = '-6 hours'

// A delete's capture (R32): at most this many boosts per viewer, and a viewer row of at most this many bytes. A row
// over it (only a change of these caps could make one) drops boosts, newest first, then its list ids, and is logged; the
// capture never fails the delete. Tests lower viewerBytes.
export const CAPTURE_LIMITS = { boosts: 40, viewerBytes: 16 * 1024 }

// The journal stops recording once it spans this many ids: the fan-out stalled, and REST is authoritative.
export const JOURNAL_SPAN = 4096

// Journal rows pruned per call, at or below the finished position.
export const PRUNE_BATCH = 500

// The fan-out's position: the last unit sent, as (event id, subject index, viewer account id), the account null once
// the event is done (the last unit of an event moves it there directly).
export type StreamPosition = { event: number; subject: number; account: string | null }

// The upgrade: the token is valid and a user's (Mastodon's accountFromToken joins users, so an app token fails), and
// the instance is published. `since` is the journal head: a socket receives only later events.
export const streamAccept = readOperation<
	{ tokenHash: string; now: number },
	{ status: 'ok'; accountId: string; grant: StreamGrant; since: number } | { status: 'unauthenticated' }
>((db, { tokenHash, now }) => {
	if (db.first("SELECT 1 AS x FROM kopje_state WHERE name = 'unpublished'") !== undefined) {
		throw storeMaintenanceError('unpublished')
	}
	const auth = authorize(db, { tokenHash, scope: null, now })
	if (auth.status !== 'ok' || auth.viewer.accountId === null) {
		return { status: 'unauthenticated' }
	}
	return {
		status: 'ok',
		accountId: auth.viewer.accountId,
		grant: streamGrant(auth.viewer.scopes),
		since: journalHead(db),
	}
})

// The tokens of the open sockets that are still valid and still their account's (VIS-26: a revoked or expired token,
// or a suspended account's, is closed at the next turn).
export const streamTokens = readOperation<
	{ sockets: readonly { tokenHash: string; accountId: string }[]; now: number },
	string[]
>((db, { sockets, now }) => {
	const valid: string[] = []
	for (const { tokenHash, accountId } of sockets) {
		if (authorizeStream(db, accountId, [tokenHash], now).context !== null) {
			valid.push(tokenHash)
		}
	}
	return valid
})

// One subject of an event (its index in the event's order, and its id) with the viewers that may be sent it, in unit
// order.
export type StreamSubject = { index: number; id: string; viewers: string[] }

export type StreamEvent = { id: number; kind: string; subject: string; subjects: StreamSubject[] }

// The journal after `position`, oldest first, at most `limit` events, each with its subjects and the accounts that may
// be sent each, in unit order: for a notification, its recipient while it exists; for a status, every account listening
// on `user`, and for an edit on `user` or `user:notification`; for a delete, the captured viewers, and for each boost
// the viewers whose capture holds it. The event of a position within an event is read again (for its units after the
// position's), and a finished one is not, so a full window means more may follow. Also the journal's span. Each
// event's viewers are bounded by the registry's caps (256 accounts).
export const streamEvents = readOperation<
	{ limit: number },
	{ position: StreamPosition; events: StreamEvent[]; head: number; tail: number }
>((db, { limit }) => {
	const position = readPosition(db)
	const rows = db.all<{ id: number; kind: string; subject: string; recipient: string | null }>(
		`SELECT e.id, e.kind, e.subject, n.account_id AS recipient FROM stream_events e
			LEFT JOIN notifications n ON e.kind = 'notification' AND n.id = CAST(e.subject AS INTEGER)
		WHERE e.id > ?1 OR (e.id = ?1 AND ?3 IS NOT NULL) ORDER BY e.id LIMIT ?2`,
		position.event,
		limit,
		position.account
	)
	const listeners = new Map<string, string[]>()
	const listening = (keys: readonly string[]) => {
		const name = keys.join(',')
		let accounts = listeners.get(name)
		if (accounts === undefined) {
			accounts = db
				.all<{ account_id: string }>(
					`SELECT DISTINCT account_id FROM stream_subscriptions
					WHERE stream_key IN (SELECT value FROM json_each(?)) ORDER BY account_id`,
					JSON.stringify(keys)
				)
				.map((row) => row.account_id)
			listeners.set(name, accounts)
		}
		return accounts
	}
	const events = rows.map((row): StreamEvent => {
		let subjects: StreamSubject[]
		switch (row.kind) {
			case 'notification':
				subjects = [{ index: 0, id: row.subject, viewers: row.recipient === null ? [] : [row.recipient] }]
				break
			case 'status':
				subjects = [{ index: 0, id: row.subject, viewers: listening(['user']) }]
				break
			case 'edit':
				subjects = [{ index: 0, id: row.subject, viewers: listening(['user', 'user:notification']) }]
				break
			case 'delete':
				subjects = deleteSubjects(db, row.id, row.subject)
				break
			default:
				subjects = []
		}
		// Within the position's event, only the units after its own.
		if (row.id === position.event && position.account !== null) {
			const { subject, account } = position
			subjects = subjects.flatMap((s) =>
				s.index < subject
					? []
					: s.index > subject
						? [s]
						: [{ ...s, viewers: s.viewers.filter((viewer) => viewer > account) }]
			)
		}
		return { id: row.id, kind: row.kind, subject: row.subject, subjects }
	})
	// Each bound its own subquery: one seek each (min and max together would scan the journal).
	const span = db.first<{ head: number | null; tail: number | null }>(
		'SELECT (SELECT max(id) FROM stream_events) AS head, (SELECT min(id) FROM stream_events) AS tail'
	)
	return { position, events, head: span?.head ?? 0, tail: span?.tail ?? 0 }
})

// A delete event's subjects: the status (0) for every viewer captured, then each captured boost by id for the viewers
// whose capture holds it.
function deleteSubjects(db: Db, eventId: number, statusId: string): StreamSubject[] {
	const rows = db.all<{ account_id: string; boosts: string }>(
		'SELECT account_id, boosts FROM stream_delete_viewers WHERE event_id = ? ORDER BY account_id',
		eventId
	)
	const boosts = new Map<string, string[]>()
	for (const row of rows) {
		for (const [boost] of JSON.parse(row.boosts) as [string, string[]][]) {
			boosts.set(boost, [...(boosts.get(boost) ?? []), row.account_id])
		}
	}
	return [
		{ index: 0, id: statusId, viewers: rows.map((row) => row.account_id) },
		...[...boosts]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([id, viewers], i) => ({ index: i + 1, id, viewers })),
	]
}

// What a unit sends: one event, its payload (presented once), and the streams it goes on, each with the scopes a
// socket's token needs for it; and the reference reads it made.
export type StreamUnit = {
	grants: Record<string, StreamGrant>
	event: string
	payload: unknown
	streams: { stream: ServedStream; needs: StreamGrant }[]
	checks: number
}

const STATUSES: StreamGrant = { statuses: true, notifications: false }
const NOTIFICATIONS: StreamGrant = { statuses: false, notifications: true }
const BOTH: StreamGrant = { statuses: true, notifications: true }

// One unit: the viewer's tokens checked (each one's grant, while valid), then the reference reads of the event for the
// viewer's streams (R33), and the subject presented once if any reference returns it; for a delete, what its capture
// allowed (R32). Nothing is sent when no token is valid. Each token is a check, and so is each reference read.
export const streamUnit = readOperation<
	{ kind: string; subject: string; accountId: string; tokenHashes: readonly string[]; now: number },
	StreamUnit
>((db, { kind, subject, accountId, tokenHashes, now }) => {
	const { scopes, context } = authorizeStream(db, accountId, tokenHashes, now)
	const grants = Object.fromEntries([...scopes].map(([hash, granted]) => [hash, streamGrant(granted)]))
	const none = { grants, event: '', payload: null, streams: [], checks: 0 }
	const origin = instanceOrigin(db)
	if (context === null || origin === null) {
		return none
	}
	const notified = Object.values(grants).some((grant) => grant.notifications)
	switch (kind) {
		case 'notification': {
			const notification = notified ? streamedNotification(db, context, subject, { origin }) : null
			return notification === null
				? { ...none, checks: notified ? 1 : 0 }
				: {
						grants,
						event: 'notification',
						payload: notification,
						streams: [
							{ stream: 'user', needs: BOTH },
							{ stream: 'user:notification', needs: NOTIFICATIONS },
						],
						checks: 1,
					}
		}
		case 'status': {
			const fresh =
				db.first(
					`SELECT 1 AS x FROM statuses
					WHERE id = ? AND published_at >= strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '${REAL_TIME_WINDOW}')`,
					subject
				) !== undefined
			const shown = fresh ? homeStatus(db, context, subject) : null
			const status = shown === null ? null : presentStatus(db, shown, { origin, viewer: context })
			return status === null
				? { ...none, checks: fresh ? 1 : 0 }
				: { grants, event: 'update', payload: status, streams: [{ stream: 'user', needs: STATUSES }], checks: 1 }
		}
		case 'edit': {
			const home = homeStatus(db, context, subject)
			const mention = notified ? mentionedStatus(db, context, subject) : null
			const shown = home ?? mention
			const status = shown === null ? null : presentStatus(db, shown, { origin, viewer: context })
			const checks = notified ? 2 : 1
			if (status === null) {
				return { ...none, checks }
			}
			const streams: StreamUnit['streams'] = [{ stream: 'user', needs: home !== null ? STATUSES : BOTH }]
			if (mention !== null) {
				streams.push({ stream: 'user:notification', needs: NOTIFICATIONS })
			}
			return { grants, event: 'status.update', payload: status, streams, checks }
		}
		case 'delete':
			return { grants, event: 'delete', payload: subject, streams: [{ stream: 'user', needs: STATUSES }], checks: 0 }
		default:
			return none
	}
})

// R32's capture of the delete of the status (or boost) `statusId`, made once, before the first change to its audience
// (the four sites: deleteStatus and unreblog in statuses.ts, a remote Delete when its job is created and a remote
// Delete or Undo of a boost in inbox.ts): a 'delete' event in the journal, with one row per account listening on `user`
// that may view the status (R3), holding the boosts of it the account may view (deleteAudience in audience.ts, at most
// CAPTURE_LIMITS.boosts). Nothing is written when nobody listening may view it, or when the journal is full (the
// fan-out stalled; logged as the triggers' events are). The rows are at most 1 + 256 (the registry's accounts), each
// within CAPTURE_LIMITS.viewerBytes; a row over it is truncated and logged, never refused, so the capture never fails
// the delete.
export function streamDelete(db: Db, statusId: string, now: number): void {
	const listeners = db
		.all<{ account_id: string }>(
			"SELECT account_id FROM stream_subscriptions WHERE stream_key = 'user' ORDER BY account_id"
		)
		.map((row) => row.account_id)
	if (listeners.length === 0) {
		return
	}
	const span = db.first<{ span: number }>(
		'SELECT coalesce((SELECT max(id) FROM stream_events) - (SELECT min(id) FROM stream_events), 0) AS span'
	)
	if ((span?.span ?? 0) >= JOURNAL_SPAN) {
		console.warn({ event: 'kopje.stream.journal-full', kind: 'delete' })
		return
	}
	const audience = deleteAudience(db, statusId, listeners, CAPTURE_LIMITS.boosts)
	if (audience.length === 0) {
		return
	}
	const event = db.first<{ id: number }>(
		"INSERT INTO stream_events (kind, subject, created_at) VALUES ('delete', ?, ?) RETURNING id",
		statusId,
		new Date(now).toISOString()
	)!.id
	for (const viewer of audience) {
		const row = captureRow(
			viewer.boosts.map((boost) => [boost, []]),
			[]
		)
		db.run(
			'INSERT INTO stream_delete_viewers (event_id, account_id, lists, boosts) VALUES (?, ?, ?, ?)',
			event,
			viewer.accountId,
			row.lists,
			row.boosts
		)
	}
}

// A viewer's capture as its row's JSON, within CAPTURE_LIMITS.viewerBytes: boosts dropped from the newest, then the
// list ids, while it is over (logged once).
function captureRow(boosts: [string, string[]][], lists: string[]): { lists: string; boosts: string } {
	const kept = { boosts: [...boosts], lists: [...lists] }
	const size = () => JSON.stringify(kept.boosts).length + JSON.stringify(kept.lists).length
	let truncated = false
	while (size() > CAPTURE_LIMITS.viewerBytes && (kept.boosts.length > 0 || kept.lists.length > 0)) {
		truncated = true
		if (kept.boosts.length > 0) {
			kept.boosts.pop()
		} else {
			kept.lists.pop()
		}
	}
	if (truncated) {
		console.warn({ event: 'kopje.stream.capture-truncated', boosts: kept.boosts.length, lists: kept.lists.length })
	}
	return { lists: JSON.stringify(kept.lists), boosts: JSON.stringify(kept.boosts) }
}

// Moves the position from `from` to `to` if it is still at `from`: false when another turn moved it first.
export const streamAdvance = sessionOperation<{ from: StreamPosition; to: StreamPosition }, boolean>(
	(db, { from, to }) =>
		db.run(
			`UPDATE stream_cursor SET event_id = ?4, subject = ?5, account_id = ?6
			WHERE id = 1 AND event_id = ?1 AND subject = ?2 AND account_id IS ?3`,
			from.event,
			from.subject,
			from.account,
			to.event,
			to.subject,
			to.account
		) === 1
)

// Deletes at most PRUNE_BATCH journal rows at or below `upTo`, a finished event, but the newest row: it keeps the next
// id above every id given (the journal has no AUTOINCREMENT counter). A delete's capture rows go with its row (at most
// 256 each, the registry's accounts). Returns how many journal rows.
export const streamPrune = sessionOperation<{ upTo: number }, number>((db, { upTo }) =>
	db.run(
		`DELETE FROM stream_events WHERE id IN (SELECT id FROM stream_events
			WHERE id <= ?1 AND id < (SELECT max(id) FROM stream_events) ORDER BY id LIMIT ?2)`,
		upTo,
		PRUNE_BATCH
	)
)

export type StreamKeys = readonly { key: string; sockets: number }[]

// The stream keys an account's open sockets subscribe to, replacing what was recorded: written on subscribe,
// unsubscribe and close.
export const streamRegister = sessionOperation<{ accountId: string; keys: StreamKeys }, null>(
	(db, { accountId, keys }) => {
		db.run('DELETE FROM stream_subscriptions WHERE account_id = ?', accountId)
		insertKeys(db, accountId, keys)
		return null
	}
)

// The whole registry rebuilt from the open sockets, by the first turn after the Store starts (sockets closed while it
// was not running left their rows).
export const streamReconcile = sessionOperation<{ accounts: readonly { accountId: string; keys: StreamKeys }[] }, null>(
	(db, { accounts }) => {
		db.run('DELETE FROM stream_subscriptions')
		for (const { accountId, keys } of accounts) {
			insertKeys(db, accountId, keys)
		}
		return null
	}
)

// Whether the fan-out has reached the journal's head (the drain barrier of the streaming tests).
export const streamCaughtUp = readOperation<void, boolean>((db) => {
	const position = readPosition(db)
	const head = journalHead(db)
	return head === 0 || (position.event >= head && position.account === null)
})

// The operations the hub runs for itself: their commits start no turn.
export const STREAM_OPERATIONS: ReadonlySet<StoreOperation<never, unknown>> = new Set<StoreOperation<never, unknown>>([
	streamAdvance,
	streamPrune,
	streamRegister,
	streamReconcile,
])

function insertKeys(db: Db, accountId: string, keys: StreamKeys): void {
	for (const { key, sockets } of keys) {
		db.run(
			'INSERT INTO stream_subscriptions (account_id, stream_key, sockets) VALUES (?, ?, ?)',
			accountId,
			key,
			sockets
		)
	}
}

function readPosition(db: Db): StreamPosition {
	const row = db.first<{ event_id: number; subject: number; account_id: string | null }>(
		'SELECT event_id, subject, account_id FROM stream_cursor WHERE id = 1'
	)
	return { event: row?.event_id ?? 0, subject: row?.subject ?? 0, account: row?.account_id ?? null }
}

function journalHead(db: Db): number {
	return db.first<{ head: number | null }>('SELECT max(id) AS head FROM stream_events')?.head ?? 0
}
