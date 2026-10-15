// How a conversation (Mastodon's AccountConversation, the direct-message list) is keyed and derived from the statuses
// stored. No imports: the cutover's converter runs this module from the sources on Node (cli/lib/cutover/kopje-runtime.js),
// and the text of CONVERSATIONS_BACKFILL is also in migration 0009_conversations (test/migrations.test.ts checks it).
//
// A conversation row belongs to a local account and is keyed, as Mastodon keys it, by its thread and its participants:
//   - the thread is statuses.thread, Mastodon's conversation_id: written once when a status is stored, and never
//     changed. A reply to a status stored takes that status's thread; a received status that names its conversation
//     (Mastodon's `conversation`) takes that identifier (remote-statuses.ts); otherwise a reply to a status not stored
//     takes the uri it names (in_reply_to_uri), and any other status its own uri (the trigger statuses_thread of
//     migration 0009). Deleting a status or a conversation changes no other status's thread;
//   - the participants are the status's author and the accounts it mentions (not silently), less the row's owner, as
//     a JSON array of account ids in order (AccountConversation.participants_from_status).

// The longest conversation identifier a received status may name, in UTF-8 bytes; a longer one, or an empty one, is
// none. The receive path (federation/remote-status.ts) and the backfill (conversationSql) check the same.
export const MAX_CONVERSATION_BYTES = 4096

// Whether `conversation` is an identifier a status's thread may take.
export function isConversationId(conversation: unknown): conversation is string {
	if (typeof conversation !== 'string') {
		return false
	}
	const bytes = new TextEncoder().encode(conversation).length
	return bytes > 0 && bytes <= MAX_CONVERSATION_BYTES
}

// The conversation the received object `raw` (a statuses.raw expression, JSON or NULL) names, by isConversationId's
// checks; NULL when it names none.
export function conversationSql(raw: string): string {
	return `(CASE WHEN json_type(${raw}, '$.conversation') = 'text'
		AND length(CAST(json_extract(${raw}, '$.conversation') AS BLOB)) BETWEEN 1 AND ${MAX_CONVERSATION_BYTES}
		THEN json_extract(${raw}, '$.conversation') END)`
}

// The participants of the status `s` (a statuses alias) for the owner `owner`: its author and its mentions (not
// silent), less the owner, as a JSON array of account ids in order.
export function participantsSql(s: string, owner: string): string {
	return `(SELECT json_group_array(p ORDER BY p) FROM (SELECT ${s}.account_id AS p
			UNION SELECT pm.account_id FROM status_mentions pm WHERE pm.status_id = ${s}.id AND pm.silent = 0)
		WHERE p <> ${owner})`
}

// The threads of the statuses stored and the conversations of the direct ones, as the write path makes them, in work
// that grows linearly with the statuses:
//   1. the thread of every status, as the receive path gives it, from the start of each chain down: a status that
//      replies to no status stored takes the conversation its stored object (raw) names, by the receive path's
//      checks, else in_reply_to_uri, else its own uri; each reply below it takes its thread. A status in a cycle of
//      replies, or below one, starts no chain and takes the same as a start would;
//   2. each (owner, status), as Mastodon's own migration of account conversations made them: a direct status (not a
//      boost) of a local author, for its author, and one a local account holds a mention notification of, for that
//      account (NotifyService#push_to_conversation!);
//   3. a conversation of each owner, thread and participants, its last status the newest, unread when that status is
//      someone else's, numbered in the order their first status came; and its statuses.
// Two work tables hold the steps and are dropped at the end. With no conversation made, the counter the insert left
// goes too, so an empty Store stays empty.
export const CONVERSATIONS_BACKFILL = `CREATE TABLE conversation_threads (
  id TEXT NOT NULL PRIMARY KEY,
  thread TEXT NOT NULL
) WITHOUT ROWID;

INSERT INTO conversation_threads (id, thread)
WITH RECURSIVE down (id, thread) AS (
  SELECT id, COALESCE(${conversationSql('raw')}, in_reply_to_uri, uri) FROM statuses WHERE in_reply_to_id IS NULL
  UNION ALL
  SELECT s.id, down.thread FROM down JOIN statuses s ON s.in_reply_to_id = down.id
)
SELECT id, thread FROM down;

UPDATE statuses SET thread = COALESCE((SELECT t.thread FROM conversation_threads t WHERE t.id = statuses.id),
  ${conversationSql('raw')}, in_reply_to_uri, uri);

DROP TABLE conversation_threads;

CREATE TABLE conversation_backfill_members (
  account_id TEXT NOT NULL,
  thread TEXT NOT NULL,
  participants TEXT NOT NULL,
  status_id TEXT NOT NULL
);

INSERT INTO conversation_backfill_members (account_id, thread, participants, status_id)
SELECT o.account_id, s.thread, ${participantsSql('s', 'o.account_id')}, o.status_id
FROM (
  SELECT s.account_id, s.id AS status_id FROM statuses s JOIN accounts a ON a.id = s.account_id
  WHERE s.visibility = 'direct' AND s.reblog_of_id IS NULL AND a.domain IS NULL
  UNION
  SELECT n.account_id, s.id FROM statuses s JOIN notifications n ON n.status_id = s.id AND n.type = 'mention'
  WHERE s.visibility = 'direct' AND s.reblog_of_id IS NULL
) o
JOIN statuses s ON s.id = o.status_id;

INSERT INTO conversations (account_id, thread, participants, last_status_id, unread)
SELECT g.account_id, g.thread, g.participants, g.last_status_id, ls.account_id <> g.account_id
FROM (
  SELECT account_id, thread, participants, max(status_id) AS last_status_id, min(status_id) AS first_status_id
  FROM conversation_backfill_members
  GROUP BY account_id, thread, participants
) g
JOIN statuses ls ON ls.id = g.last_status_id
ORDER BY g.first_status_id, g.account_id;

INSERT INTO conversation_statuses (conversation_id, status_id)
SELECT c.id, m.status_id FROM conversation_backfill_members m
JOIN conversations c ON c.account_id = m.account_id AND c.thread = m.thread AND c.participants = m.participants;

DROP TABLE conversation_backfill_members;

DELETE FROM sqlite_sequence WHERE name = 'conversations' AND seq = 0;`

// Gives every status its thread and fills the conversations of a database whose conversation tables are empty: the
// cutover's converter, once the rows it carries are written (its inserts may come before their parents' links).
export function backfillConversations(db: { exec(sql: string): unknown }): void {
	db.exec(CONVERSATIONS_BACKFILL)
}
