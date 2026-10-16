import { deleteAudience } from './audience'
import { authorize, authorizeStream, listenerContext, type UserContext } from './auth'
import { streamedConversation } from './conversations'
import { ownList } from './lists'
import { mentionedStatus, streamedNotification } from './notifications'
import { readOperation, sessionOperation } from './operation'
import { instanceOrigin } from './push'
import { presentStatus } from './status-presenter'
import { homeStatus, listStatus } from './timelines'
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
//       `user:notification`, the mention reference alone;
//     - `update` and `status.update` on `list:<id>`: the list's read positioned at x, which includes that the list is
//       V's (listStatus in timelines.ts), with the same real-time window for `update`;
//     - `conversation` on `direct`: the conversation relation, V's row x, presented as the list presents it
//       (streamedConversation in conversations.ts, R25);
//     - `notifications_merged` on `user` (with a notification scope) and `user:notification`: V's transition to no
//       pending accept job (streamMerged, written by notification-requests.ts).
//   Each status is presented as REST presents it to V (presentStatus).
//
//   R32 (stream delete): a `delete` of x (a status, or a boost of it) reaches (V, k) only if, in the transaction that
//   first changes the status's audience, V was listening on `user` or a list and could view x (R3), and k is `user`,
//   or `list:<id>` when that list's read positioned at x returned x then and the list is still V's when it is sent.
//   The capture (streamDelete) is taken once, before that change, in bounded rows (stream_delete_viewers, migration
//   0028_streaming_home); the unit re-checks V's tokens and the lists' owner.
//
// A conversation's write takes its owner's next change sequence (conversations.ts nextStreamSeq, migration
// 0033_streaming_lists), and the mark's move journals a 'conversation' event for the owner unless one is still ahead of
// the position (one row per owner however many changes a burst makes). Its units are the owner's newest changes above
// what its sockets were sent (streamConversations), at the event's place in the journal.
//
// A unit is one subject for one viewer. Units go in a stable order (event id, then viewer account id ascending, then
// the subject within the viewer's units: 0 for the status, then a delete's captured boosts by id), and the position
// past a unit is persisted by compare-and-set before its messages are sent, so none is sent twice (streamAdvance).
// Delivery is at most once and live: REST is authoritative.

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
export type ServedStream = 'user' | 'user:notification' | 'list' | 'direct'
export const SERVED_STREAMS: readonly ServedStream[] = ['user', 'user:notification', 'list', 'direct']

// A subscription's key, as the registry (stream_subscriptions) and a socket's attachment hold it: the stream's name, or
// `list:<id>` for a list.
export function listKey(listId: string): string {
	return `list:${listId}`
}

// The list id of a key, or null for any other stream.
export function keyList(key: string): string | null {
	return key.startsWith('list:') ? key.slice('list:'.length) : null
}

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

// Whether a subscription with the key `key` carries notifications for a token with `grant`.
export function carriesNotifications(grant: StreamGrant, key: string): boolean {
	switch (key) {
		case 'user:notification':
			return grant.notifications
		case 'user':
			return grant.statuses && grant.notifications
		default:
			return false
	}
}

// Whether a subscription with the key `key` may carry an event of `kind` (the journal's: a notification inserted, a
// status inserted, a status edited, a delete captured, a merge done; or a conversation changed) for a token with
// `grant`, before any reference is read: the streams and scopes each event goes to.
export function mayCarry(kind: string, grant: StreamGrant, key: string): boolean {
	const timeline = key === 'user' || keyList(key) !== null
	switch (kind) {
		case 'notification':
		case 'merged':
			return carriesNotifications(grant, key)
		case 'status':
		case 'delete':
			return timeline && grant.statuses
		case 'edit':
			return timeline ? grant.statuses : key === 'user:notification' && grant.notifications
		case 'conversation':
			return key === 'direct' && grant.statuses
		default:
			return false
	}
}

// The `update` event's real-time window (Mastodon's Status::REAL_TIME_WINDOW): a status published more than this long
// before it arrived (a remote post fetched late) is not streamed.
const REAL_TIME_WINDOW = '-6 hours'

// A delete's capture (R32): at most this many boosts per viewer, and a viewer row of at most this many bytes. A row
// over it (only a change of these caps could make one) drops boosts, newest first, and is logged; the capture never
// fails the delete. Tests lower viewerBytes.
export const CAPTURE_LIMITS = { boosts: 40, viewerBytes: 16 * 1024 }

// The journal stops recording once it spans this many ids: the fan-out stalled, and REST is authoritative.
export const JOURNAL_SPAN = 4096

// The conversation changes of one owner a conversation event sends, the newest; older ones are skipped (REST is
// authoritative).
export const CONVERSATIONS_PER_TURN = 20

// Journal rows pruned per call, at or below the finished position.
export const PRUNE_BATCH = 500

// The fan-out's position: the last unit sent, as (event id, viewer account id, subject index within the viewer's
// units), the account null once the event is done.
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

// A subject of a unit: its index among the viewer's units of the event (0 for the status, then a delete's captured
// boosts by id), and its id.
export type StreamSubject = { index: number; id: string }

// A journal event and, but for a delete (read a page at a time: streamDeleteUnits), the accounts that may be sent it in
// unit order, after the position within it.
export type StreamEvent = { id: number; kind: string; subject: string; viewers: string[] }

// The journal after `position`, oldest first, at most `limit` events, each with the accounts that may be sent it in
// unit order: for a notification, its recipient while it exists; for a merge, its recipient; for a status, every
// account listening on `user` or a list, and for an edit on `user`, `user:notification` or a list (the registry's, at
// most 256, read once a scan). A delete's units are not read here. The event of a position within an event is read again (for its units after the position's), and a
// finished one is not, so a full window means more may follow. Also the journal's span.
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
					WHERE stream_key IN (SELECT value FROM json_each(?)) OR (stream_key > 'list:' AND stream_key < 'list;')
					ORDER BY account_id`,
					JSON.stringify(keys)
				)
				.map((row) => row.account_id)
			listeners.set(name, accounts)
		}
		return accounts
	}
	const events = rows.map((row): StreamEvent => {
		let viewers: string[]
		switch (row.kind) {
			case 'notification':
				viewers = row.recipient === null ? [] : [row.recipient]
				break
			case 'merged':
			case 'conversation':
				viewers = [row.subject]
				break
			case 'status':
				viewers = listening(['user'])
				break
			case 'edit':
				viewers = listening(['user', 'user:notification'])
				break
			default:
				viewers = []
		}
		// Within the position's event, only the viewers after its account (these events have one unit per viewer).
		const after = row.id === position.event ? position.account : null
		if (after !== null) {
			viewers = viewers.filter((viewer) => viewer > after)
		}
		return { id: row.id, kind: row.kind, subject: row.subject, viewers }
	})
	// Each bound its own subquery: one seek each (min and max together would scan the journal).
	const span = db.first<{ head: number | null; tail: number | null }>(
		'SELECT (SELECT max(id) FROM stream_events) AS head, (SELECT min(id) FROM stream_events) AS tail'
	)
	return { position, events, head: span?.head ?? 0, tail: span?.tail ?? 0 }
})

// Where a page of a delete's units starts: after the unit (account, subject), or at the start.
export type StreamUnitAfter = { account: string; subject: number } | null

// A page of a delete event's units after `after`: at most `rows` viewers' captures (stream_delete_viewers, by its key),
// each viewer's status (subject 0) then its captured boosts oldest first, each with the lists its capture allowed, so
// the units read at once never exceed `rows` × 41 however many viewers the capture holds; and where the next page
// starts, or null after the last.
export const streamDeleteUnits = readOperation<
	{ eventId: number; statusId: string; after: StreamUnitAfter; rows: number },
	{ units: { viewer: string; subject: StreamSubject; lists: string[] }[]; next: StreamUnitAfter }
>((db, { eventId, statusId, after, rows }) => {
	const captured = db.all<{ account_id: string; lists: string; boosts: string }>(
		`SELECT account_id, lists, boosts FROM stream_delete_viewers WHERE event_id = ?1 AND account_id >= ?2
		ORDER BY account_id LIMIT ?3`,
		eventId,
		after?.account ?? '',
		rows
	)
	const units = captured.flatMap((row) =>
		[[statusId, JSON.parse(row.lists) as string[]] as const, ...(JSON.parse(row.boosts) as [string, string[]][])]
			.map(([id, lists], index) => ({ viewer: row.account_id, subject: { index, id }, lists: [...lists] }))
			.filter((unit) => after === null || unit.viewer > after.account || unit.subject.index > after.subject)
	)
	const last = captured.at(-1)
	return {
		units,
		next:
			captured.length < rows || last === undefined
				? null
				: { account: last.account_id, subject: Number.MAX_SAFE_INTEGER },
	}
})

// What a unit sends: one event, its payload (presented once), and the streams it goes on (by key), each with the
// scopes a socket's token needs for it; and the reference reads it made.
export type StreamUnit = {
	grants: Record<string, StreamGrant>
	event: string
	payload: unknown
	streams: { stream: string; needs: StreamGrant }[]
	checks: number
}

const STATUSES: StreamGrant = { statuses: true, notifications: false }
const NOTIFICATIONS: StreamGrant = { statuses: false, notifications: true }
const BOTH: StreamGrant = { statuses: true, notifications: true }

// One unit: the viewer's tokens checked (each one's grant, while valid), then the reference reads of the event for the
// viewer's streams (R33), and the subject presented once if any reference returns it; for a delete, what its capture
// allowed (R32), with each captured list still the viewer's. `lists` are the list ids the unit may go on: those the
// viewer's sockets subscribe to (for a delete, of those its capture allowed). Nothing is sent when no token is valid.
// Each token is a check, and so is each reference read (at most 16 lists, home and the mention: UNIT_WORST in
// stream-hub.ts).
export const streamUnit = readOperation<
	{
		kind: string
		subject: string
		accountId: string
		tokenHashes: readonly string[]
		lists?: readonly string[]
		now: number
	},
	StreamUnit
>((db, { kind, subject, accountId, tokenHashes, lists = [], now }) => {
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
			const home = fresh ? homeStatus(db, context, subject) : null
			const listed = fresh ? listedIn(db, context, lists, subject) : []
			const shown = home ?? listed[0]?.status ?? null
			const status = shown === null ? null : presentStatus(db, shown, { origin, viewer: context })
			const checks = fresh ? 1 + lists.length : 0
			if (status === null) {
				return { ...none, checks }
			}
			const streams: StreamUnit['streams'] = home === null ? [] : [{ stream: 'user', needs: STATUSES }]
			return { grants, event: 'update', payload: status, streams: [...streams, ...listStreams(listed)], checks }
		}
		case 'edit': {
			const home = homeStatus(db, context, subject)
			const mention = notified ? mentionedStatus(db, context, subject) : null
			const listed = listedIn(db, context, lists, subject)
			const shown = home ?? mention ?? listed[0]?.status ?? null
			const status = shown === null ? null : presentStatus(db, shown, { origin, viewer: context })
			const checks = (notified ? 2 : 1) + lists.length
			if (status === null) {
				return { ...none, checks }
			}
			const streams: StreamUnit['streams'] = []
			if (home !== null || mention !== null) {
				streams.push({ stream: 'user', needs: home !== null ? STATUSES : BOTH })
			}
			if (mention !== null) {
				streams.push({ stream: 'user:notification', needs: NOTIFICATIONS })
			}
			return { grants, event: 'status.update', payload: status, streams: [...streams, ...listStreams(listed)], checks }
		}
		case 'delete': {
			// The captured lists still the viewer's (R32: a list deleted since receives nothing).
			const owned = lists.filter((id) => ownList(db, accountId, id) !== undefined)
			return {
				grants,
				event: 'delete',
				payload: subject,
				streams: [
					{ stream: 'user', needs: STATUSES },
					...owned.map((id) => ({ stream: listKey(id), needs: STATUSES })),
				],
				checks: lists.length,
			}
		}
		case 'merged':
			// No reference to read: the transition was judged when it was written (notification-requests.ts).
			return notified
				? {
						grants,
						event: 'notifications_merged',
						payload: '1',
						streams: [
							{ stream: 'user', needs: BOTH },
							{ stream: 'user:notification', needs: NOTIFICATIONS },
						],
						checks: 0,
					}
				: none
		case 'conversation': {
			const conversation = streamedConversation(db, context, subject, { origin })
			return conversation === null
				? { ...none, checks: 1 }
				: {
						grants,
						event: 'conversation',
						payload: conversation,
						streams: [{ stream: 'direct', needs: STATUSES }],
						checks: 1,
					}
		}
		default:
			return none
	}
})

// The lists among `lists` whose read positioned at the status returns it, each with the status.
function listedIn(db: Db, viewer: UserContext, lists: readonly string[], statusId: string) {
	return lists.flatMap((id) => {
		const status = listStatus(db, viewer, id, statusId)
		return status === null ? [] : [{ id, status }]
	})
}

function listStreams(listed: readonly { id: string }[]): StreamUnit['streams'] {
	return listed.map(({ id }) => ({ stream: listKey(id), needs: STATUSES }))
}

// R32's capture of the delete of the status (or boost) `statusId`, made once, before the first change to its audience
// (the four sites: deleteStatus and unreblog in statuses.ts, a remote Delete when its job is created and a remote
// Delete or Undo of a boost in inbox.ts): a 'delete' event in the journal, with one row per account listening on `user`
// or a list that may view the status (R3), holding the boosts of it the account may view (deleteAudience in
// audience.ts, at most CAPTURE_LIMITS.boosts), and for the status and each boost the account's subscribed lists whose
// read positioned at it returns it (listStatus: at most 16 lists, each a narrowed read). Nothing is written when nobody
// listening may view it, or when the journal is full (the fan-out stalled; logged as the triggers' events are). The rows
// are at most 1 + 256 (the registry's accounts), each within CAPTURE_LIMITS.viewerBytes; a row over it is truncated and
// logged, never refused, so the capture never fails the delete.
export function streamDelete(db: Db, statusId: string, now: number): void {
	const listening = new Map<string, string[]>()
	for (const row of db.all<{ account_id: string; stream_key: string }>(
		`SELECT account_id, stream_key FROM stream_subscriptions
		WHERE stream_key = 'user' OR (stream_key > 'list:' AND stream_key < 'list;') ORDER BY account_id`
	)) {
		const lists = listening.get(row.account_id) ?? []
		const list = keyList(row.stream_key)
		if (list !== null) {
			lists.push(list)
		}
		listening.set(row.account_id, lists)
	}
	if (listening.size === 0) {
		return
	}
	if (journalFull(db, 'delete')) {
		return
	}
	const audience = deleteAudience(db, statusId, [...listening.keys()], CAPTURE_LIMITS.boosts)
	if (audience.length === 0) {
		return
	}
	const event = db.first<{ id: number }>(
		"INSERT INTO stream_events (kind, subject, created_at) VALUES ('delete', ?, ?) RETURNING id",
		statusId,
		new Date(now).toISOString()
	)!.id
	for (const viewer of audience) {
		const subscribed = listening.get(viewer.accountId) ?? []
		const context = listenerContext(viewer.accountId, now)
		const lists = (id: string) => subscribed.filter((list) => listStatus(db, context, list, id) !== null)
		const row = captureRow(
			lists(statusId),
			viewer.boosts.map((boost) => [boost, lists(boost)])
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

// A viewer's capture as its row's JSON, within CAPTURE_LIMITS.viewerBytes: boosts dropped from the newest while it is
// over, then the status's list ids (logged once).
function captureRow(lists: string[], boosts: [string, string[]][]): { lists: string; boosts: string } {
	const kept = { lists: [...lists], boosts: [...boosts] }
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
		console.warn({
			event: 'kopje.stream.capture-truncated',
			boosts: kept.boosts.length,
			lists: kept.lists.length,
		})
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

// Deletes at most PRUNE_BATCH rows in all at or below `upTo`, a finished event, but the newest journal row: it keeps the
// next id above every id given (the journal has no AUTOINCREMENT counter). Journal rows go first, so the journal's span
// shrinks as soon as the fan-out passes them; then, with what is left of the batch, the capture rows of finished
// deletes, oldest first (they name their event by id only, so nothing cascades). Returns how many journal rows went,
// and whether prunable rows are left for another call.
export const streamPrune = sessionOperation<{ upTo: number }, { pruned: number; more: boolean }>((db, { upTo }) => {
	const changes = () => db.first<{ n: number }>('SELECT changes() AS n')?.n ?? 0
	db.run(
		`DELETE FROM stream_events WHERE id IN (SELECT id FROM stream_events
			WHERE id <= ?1 AND id < (SELECT max(id) FROM stream_events) ORDER BY id LIMIT ?2)`,
		upTo,
		PRUNE_BATCH
	)
	const pruned = changes()
	if (pruned < PRUNE_BATCH) {
		db.run(
			`DELETE FROM stream_delete_viewers WHERE (event_id, account_id) IN (SELECT event_id, account_id
				FROM stream_delete_viewers WHERE event_id <= ?1 AND event_id < (SELECT max(id) FROM stream_events)
				ORDER BY event_id, account_id LIMIT ?2)`,
			upTo,
			PRUNE_BATCH - pruned
		)
	}
	const more =
		db.first(
			`SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM stream_events
					WHERE id <= ?1 AND id < (SELECT max(id) FROM stream_events))
				OR EXISTS (SELECT 1 FROM stream_delete_viewers
					WHERE event_id <= ?1 AND event_id < (SELECT max(id) FROM stream_events))`,
			upTo
		) !== undefined
	return { pruned, more }
})

export type StreamKeys = readonly { key: string; sockets: number }[]

// The stream keys an account's open sockets subscribe to, replacing what was recorded: written on subscribe,
// unsubscribe and close. With `direct`, the account's conversation mark, made on its first subscription from the highest
// stream_seq of its conversations (one seek of conversations_stream), never lowered; returned as where a socket that
// subscribes now starts (its convSeq).
export const streamRegister = sessionOperation<{ accountId: string; keys: StreamKeys }, { convSeq: number | null }>(
	(db, { accountId, keys }) => {
		db.run('DELETE FROM stream_subscriptions WHERE account_id = ?', accountId)
		insertKeys(db, accountId, keys)
		if (!keys.some(({ key }) => key === 'direct')) {
			return { convSeq: null }
		}
		db.run(
			`INSERT INTO stream_conversation_marks (account_id, seq)
			SELECT ?1, coalesce((SELECT max(stream_seq) FROM conversations WHERE account_id = ?1), 0)
			ON CONFLICT (account_id) DO NOTHING`,
			accountId
		)
		return {
			convSeq: db.first<{ seq: number }>('SELECT seq FROM stream_conversation_marks WHERE account_id = ?', accountId)!
				.seq,
		}
	}
)

// Whether the list `listId` is the account's: a `list` subscription needs it (Mastodon's authorizeListAccess), and each
// message checks it again (listStatus, or a delete's ownList).
export const streamListOwned = readOperation<{ accountId: string; listId: string }, boolean>(
	(db, { accountId, listId }) => ownList(db, accountId, listId) !== undefined
)

// An owner's conversation changes above `after` (the lowest convSeq of its `direct` sockets, or the position within
// the event): the newest `limit`, by conversations_stream, oldest of them first, so they are sent in order and each
// socket's convSeq rises with each. Older changes are skipped.
export const streamConversations = readOperation<
	{ accountId: string; after: number; limit: number },
	{ id: string; seq: number }[]
>((db, { accountId, after, limit }) =>
	db
		.all<{ id: string; seq: number }>(
			`SELECT CAST(id AS TEXT) AS id, stream_seq AS seq FROM conversations WHERE account_id = ?1 AND stream_seq > ?2
			ORDER BY stream_seq DESC LIMIT ?3`,
			accountId,
			after,
			limit
		)
		.reverse()
)

// The streaming API's `notifications_merged` for the account (notification-requests.ts calls it on its transition to
// no pending accept job): a 'merged' event in the journal, while the account listens on `user` or `user:notification`
// (the scope is checked when it is sent) and the journal is not full.
export function streamMerged(db: Db, accountId: string, now: string): void {
	const listening = db.first(
		"SELECT 1 AS x FROM stream_subscriptions WHERE account_id = ? AND stream_key IN ('user', 'user:notification')",
		accountId
	)
	if (listening === undefined) {
		return
	}
	if (journalFull(db, 'merged')) {
		return
	}
	db.run("INSERT INTO stream_events (kind, subject, created_at) VALUES ('merged', ?, ?)", accountId, now)
}

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

// Whether the fan-out has reached the journal's head (the drain barrier of the streaming tests). Conversation changes
// are journaled too, so this covers them.
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

// Whether the journal spans JOURNAL_SPAN ids (the fan-out stalled), logged for an event of `kind` it then refuses.
function journalFull(db: Db, kind: string): boolean {
	const span = db.first<{ span: number }>(
		'SELECT coalesce((SELECT max(id) FROM stream_events) - (SELECT min(id) FROM stream_events), 0) AS span'
	)
	if ((span?.span ?? 0) < JOURNAL_SPAN) {
		return false
	}
	console.warn({ event: 'kopje.stream.journal-full', kind })
	return true
}

function journalHead(db: Db): number {
	return db.first<{ head: number | null }>('SELECT max(id) AS head FROM stream_events')?.head ?? 0
}
