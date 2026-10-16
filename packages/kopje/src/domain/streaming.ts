import { authorize, authorizeStream } from './auth'
import { type Notification, streamedNotification } from './notifications'
import { readOperation, sessionOperation } from './operation'
import { instanceOrigin } from './push'
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
//   and checks k's scope; the payload is that reference's presentation for V. For a `notification` on `user` (with a
//   notification scope) and `user:notification`, the reference is V's notification list positioned at x
//   (streamedNotification in notifications.ts: R15, unfiltered, kept).
//
// A unit is one subject for one viewer. Units go in a stable order (event id, then viewer account id ascending), and
// the position past a unit is persisted by compare-and-set before its messages are sent, so none is sent twice
// (streamAdvance). Delivery is at most once and live: REST is authoritative.

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

// The journal stops recording once it spans this many ids: the fan-out stalled, and REST is authoritative.
export const JOURNAL_SPAN = 4096

// Journal rows pruned per call, at or below the finished position.
export const PRUNE_BATCH = 500

// The fan-out's position: the last unit sent, as (event id, viewer account id), the account null once the event is
// done (the last unit of an event moves it there directly).
export type StreamPosition = { event: number; account: string | null }

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

export type StreamEvent = { id: number; kind: string; subject: string; viewers: string[] }

// The journal after `position`, oldest first, at most `limit` events, each with the accounts that may be sent it in
// unit order: for a notification, its recipient while it exists. Also the journal's span.
export const streamEvents = readOperation<
	{ limit: number },
	{ position: StreamPosition; events: StreamEvent[]; head: number; tail: number }
>((db, { limit }) => {
	const position = readPosition(db)
	const rows = db.all<{ id: number; kind: string; subject: string; recipient: string | null }>(
		`SELECT e.id, e.kind, e.subject, n.account_id AS recipient FROM stream_events e
			LEFT JOIN notifications n ON e.kind = 'notification' AND n.id = CAST(e.subject AS INTEGER)
		WHERE e.id >= ?1 ORDER BY e.id LIMIT ?2`,
		position.event,
		limit
	)
	const events = rows.flatMap((row): StreamEvent[] => {
		const viewers = row.recipient === null ? [] : [row.recipient]
		if (row.id < position.event || (row.id === position.event && position.account === null)) {
			return []
		}
		const after = row.id === position.event ? position.account : null
		return [
			{
				id: row.id,
				kind: row.kind,
				subject: row.subject,
				viewers: viewers.filter((viewer) => after === null || viewer > after).sort(),
			},
		]
	})
	// Each bound its own subquery: one seek each (min and max together would scan the journal).
	const span = db.first<{ head: number | null; tail: number | null }>(
		'SELECT (SELECT max(id) FROM stream_events) AS head, (SELECT min(id) FROM stream_events) AS tail'
	)
	return { position, events, head: span?.head ?? 0, tail: span?.tail ?? 0 }
})

// One unit of a notification event: the viewer's tokens checked (each one's grant, while valid), and the
// notification as the reference shows it now (R33), presented; null when no token is valid or the list would not show
// it. Each token is a check, and so is the reference read.
export const streamNotificationUnit = readOperation<
	{ accountId: string; tokenHashes: readonly string[]; notificationId: string; now: number },
	{ grants: Record<string, StreamGrant>; notification: Notification | null }
>((db, { accountId, tokenHashes, notificationId, now }) => {
	const { scopes, context } = authorizeStream(db, accountId, tokenHashes, now)
	const grants = Object.fromEntries([...scopes].map(([hash, granted]) => [hash, streamGrant(granted)]))
	const origin = instanceOrigin(db)
	const shown = Object.values(grants).some((grant) => grant.notifications)
	return {
		grants,
		notification:
			context === null || origin === null || !shown
				? null
				: streamedNotification(db, context, notificationId, { origin }),
	}
})

// Moves the position from `from` to `to` if it is still at `from`: false when another turn moved it first.
export const streamAdvance = sessionOperation<{ from: StreamPosition; to: StreamPosition }, boolean>(
	(db, { from, to }) =>
		db.run(
			'UPDATE stream_cursor SET event_id = ?3, account_id = ?4 WHERE id = 1 AND event_id = ?1 AND account_id IS ?2',
			from.event,
			from.account,
			to.event,
			to.account
		) === 1
)

// Deletes at most PRUNE_BATCH journal rows at or below `upTo`, a finished event, but the newest row: it keeps the next
// id above every id given (the journal has no AUTOINCREMENT counter). Returns how many.
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
	const row = db.first<{ event_id: number; account_id: string | null }>(
		'SELECT event_id, account_id FROM stream_cursor WHERE id = 1'
	)
	return { event: row?.event_id ?? 0, account: row?.account_id ?? null }
}

function journalHead(db: Db): number {
	return db.first<{ head: number | null }>('SELECT max(id) AS head FROM stream_events')?.head ?? 0
}
