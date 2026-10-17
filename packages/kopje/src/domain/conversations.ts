import { type Account, type Page, type PageQuery, type Present, presentAccountsById } from './accounts'
import { statusReads, type ViewerContext } from './audience'
import { userReadOperation, userWriteOperation } from './auth'
import { participantsSql } from './conversation-rows'
import { presentStatuses, type Status } from './status-presenter'
import { statusCursor } from './statuses'
import type { Db } from '../db/sql'

// Conversations, the direct-message list (Mastodon 4.5's AccountConversation and Api::V1::ConversationsController). A
// row belongs to a local account and is written when a direct status is stored, never worked out when read:
//   - a local author's direct status goes into the author's conversation (FanOutOnWriteService#deliver_to_conversation!),
//     read;
//   - a direct status a local account is notified of as a mention goes into that account's (notify() in
//     notifications.ts, NotifyService#push_to_conversation!), unread. The notification rule (R15) decides, so a status
//     from an account the owner blocks or mutes with notifications adds nothing, as Mastodon drops its notification.
// A row is keyed by its owner, its thread (statuses.thread, written once with the status) and its participants
// (conversation-rows.ts). A status leaves its
// conversations with its conversation_statuses rows, and the trigger of migration 0009_conversations moves each one's
// last status back, or deletes it when it has none left (AccountConversation.remove_status). A block ends the
// blocker's conversations with the blocked account (AfterBlockService#clear_conversations!).
//
// Each write of a row also takes its owner's next streaming change sequence while the owner has a mark (nextStreamSeq),
// so the `direct` stream sends the changed conversation.
// Reading shows the owner's rows only (anyone else's is not found), newest last status first. The last status is
// shown only if the owner may still see it (R2, through statusReads): one whose author is suspended or blocks the owner
// is shown as null, as Mastodon shows a last status it can no longer load. The accounts are the other participants
// (the owner when there are none).

// The participants one conversation presents: the first by account id, the order the row stores them in
// (conversation-rows.ts participantsSql). Mastodon presents every participant; this cap keeps one conversation within
// its share of an answer (docs/threat-model.md, "Maxima of presented units"). The stored participants, which key the
// row, are unchanged.
export const MAX_PRESENTED_PARTICIPANTS = 12

// REST::ConversationSerializer.
export type Conversation = { id: string; unread: boolean; accounts: Account[]; last_status: Status | null }

type ConversationRow = { id: string; participants: string; last_status_id: string; unread: number }

const COLUMNS = 'CAST(id AS TEXT) AS id, participants, last_status_id, unread'

// Mastodon's conversation ids are integers; anything else names none.
const CONVERSATION_ID = /^\d{1,19}$/

// AccountConversation.add_status: the direct status `statusId` (not a boost) joins the conversation of `ownerId` with
// its thread and participants, made if there is none. A status already in that conversation changes nothing;
// otherwise it becomes the last status if it is the newest, and the conversation is unread unless the status is the
// owner's own.
export function addToConversation(db: Db, ownerId: string, statusId: string): void {
	const status = db.first<{ account_id: string; thread: string; participants: string }>(
		`SELECT s.account_id, s.thread, ${participantsSql('s', '?2')} AS participants
		FROM statuses s WHERE s.id = ?1 AND s.visibility = 'direct' AND s.reblog_of_id IS NULL`,
		statusId,
		ownerId
	)
	if (status === undefined) {
		return
	}
	const key = [ownerId, status.thread, status.participants] as const
	const held = db.first(
		`SELECT 1 AS held FROM conversations c JOIN conversation_statuses cs ON cs.conversation_id = c.id AND cs.status_id = ?4
		WHERE c.account_id = ?1 AND c.thread = ?2 AND c.participants = ?3`,
		...key,
		statusId
	)
	if (held !== undefined) {
		return
	}
	const row = db.first<{ id: number }>(
		`INSERT INTO conversations (account_id, thread, participants, last_status_id, unread, stream_seq)
		VALUES (?1, ?2, ?3, ?4, ?5, coalesce(?6, 0))
		ON CONFLICT (account_id, thread, participants)
			DO UPDATE SET last_status_id = max(last_status_id, excluded.last_status_id), unread = excluded.unread,
				stream_seq = coalesce(?6, stream_seq)
		RETURNING id`,
		...key,
		statusId,
		status.account_id === ownerId ? 0 : 1,
		nextStreamSeq(db, ownerId)
	)
	if (row === undefined) {
		throw new Error('the conversation was not written')
	}
	db.run('INSERT INTO conversation_statuses (conversation_id, status_id) VALUES (?, ?)', row.id, statusId)
}

// The streaming API's change sequence (`direct`, migration 0032_streaming_lists): the owner's mark moved to its next
// value, which the conversation write stores in stream_seq, or null when the owner never subscribed to `direct` (then
// nothing more is written). The mark is never lowered, so a turn sends each change once (stream-hub.ts). Every writer
// of a conversation row takes it: addToConversation, markConversation, and the trigger conversation_statuses_removed.
function nextStreamSeq(db: Db, ownerId: string): number | null {
	return (
		db.first<{ seq: number }>(
			'UPDATE stream_conversation_marks SET seq = seq + 1 WHERE account_id = ? RETURNING seq',
			ownerId
		)?.seq ?? null
	)
}

// AfterBlockService#clear_conversations!: the owner's conversations with the account go. Reads the owner's
// conversations, as Mastodon's does.
export function leaveConversationsWith(db: Db, ownerId: string, accountId: string): void {
	db.run(
		`DELETE FROM conversations WHERE account_id = ?1
			AND EXISTS (SELECT 1 FROM json_each(conversations.participants) WHERE value = ?2)`,
		ownerId,
		accountId
	)
}

// The rows as the API shows them: each last status the owner may see (R2), and the participants.
function presentConversations(
	db: Db,
	rows: readonly ConversationRow[],
	viewer: ViewerContext & { readonly accountId: string },
	present: Present
): Conversation[] {
	const visible = statusReads(viewer, { viewer: '?1' }).select(
		db,
		'visible',
		{ from: 'json_each(?2) j JOIN', join: 'ON s.id = j.value' },
		viewer.accountId,
		JSON.stringify(rows.map((row) => row.last_status_id))
	)
	const statuses = new Map(
		presentStatuses(
			db,
			visible.map((row) => row.id),
			{ ...present, viewer }
		).map((status) => [status.id, status])
	)
	const participants = rows.map((row) =>
		(JSON.parse(row.participants) as string[]).slice(0, MAX_PRESENTED_PARTICIPANTS)
	)
	const accounts = presentAccountsById(db, [viewer.accountId, ...participants.flat()], present)
	const owner = accounts.get(viewer.accountId)
	return rows.map((row, i) => {
		const others = (participants[i] ?? []).flatMap((id) => {
			const account = accounts.get(id)
			return account === undefined ? [] : [account]
		})
		return {
			id: row.id,
			unread: row.unread === 1,
			accounts: others.length > 0 || owner === undefined ? others : [owner],
			last_status: statuses.get(row.last_status_id) ?? null,
		}
	})
}

// GET /api/v1/conversations: the viewer's conversations, newest last status first, paged by the last status's id
// (AccountConversation.to_a_paginated_by_id). The cursor is a plain range (no cursor is ':' or '', above and below every
// id), so the read starts in the (account, last status) index at the cursor.
export const listConversations = userReadOperation<{ page: PageQuery; present: Present }, Page<Conversation>>(
	(db, { page, present }, _viewer, viewer) => {
		const ascending = page.minId !== undefined
		const rows = db.all<ConversationRow>(
			`SELECT ${COLUMNS} FROM conversations
			WHERE account_id = ?1 AND last_status_id < ?2 AND last_status_id > ?3
			ORDER BY last_status_id ${ascending ? 'ASC' : 'DESC'} LIMIT ?4`,
			viewer.accountId,
			statusCursor(page.maxId) ?? ':',
			statusCursor(page.minId ?? page.sinceId) ?? '',
			page.limit
		)
		if (ascending) {
			rows.reverse()
		}
		return {
			items: presentConversations(db, rows, viewer, present),
			newest: rows[0]?.last_status_id ?? null,
			oldest: rows.at(-1)?.last_status_id ?? null,
		}
	}
)

// R33 for `conversation` on the `direct` stream (streaming.ts): the conversation relation, the row `id` of the viewer
// (the owner predicate of listConversations), read by its key, presented as the list presents it (its last status only
// if the viewer may see it, R25). Null when it is gone or not the viewer's.
export function streamedConversation(
	db: Db,
	viewer: ViewerContext & { readonly accountId: string },
	id: string,
	present: Present
): Conversation | null {
	if (!CONVERSATION_ID.test(id)) {
		return null
	}
	const row = db.first<ConversationRow>(
		`SELECT ${COLUMNS} FROM conversations WHERE id = CAST(?1 AS INTEGER) AND account_id = ?2`,
		id,
		viewer.accountId
	)
	return row === undefined ? null : (presentConversations(db, [row], viewer, present)[0] ?? null)
}

// POST /api/v1/conversations/:id/read and /unread: the viewer's conversation, marked; null when it is not theirs.
export const markConversation = userWriteOperation<
	{ id: string; unread: boolean; present: Present },
	Conversation | null
>((db, { id, unread, present }, _viewer, viewer) => {
	if (!CONVERSATION_ID.test(id)) {
		return null
	}
	if (
		db.first(
			'SELECT 1 AS x FROM conversations WHERE id = CAST(? AS INTEGER) AND account_id = ?',
			id,
			viewer.accountId
		) === undefined
	) {
		return null
	}
	const row = db.first<ConversationRow>(
		`UPDATE conversations SET unread = ?3, stream_seq = coalesce(?4, stream_seq)
		WHERE id = CAST(?1 AS INTEGER) AND account_id = ?2 RETURNING ${COLUMNS}`,
		id,
		viewer.accountId,
		unread ? 1 : 0,
		nextStreamSeq(db, viewer.accountId)
	)
	return row === undefined ? null : (presentConversations(db, [row], viewer, present)[0] ?? null)
})

// DELETE /api/v1/conversations/:id: the viewer's conversation goes (its statuses stay). Whether it was theirs.
export const deleteConversation = userWriteOperation<{ id: string }, boolean>(
	(db, { id }, { accountId }) =>
		CONVERSATION_ID.test(id) &&
		db.run('DELETE FROM conversations WHERE id = CAST(? AS INTEGER) AND account_id = ?', id, accountId) > 0
)
