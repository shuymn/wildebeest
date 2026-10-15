// How a conversation (Mastodon's AccountConversation, the direct-message list) is keyed and derived from the statuses
// stored. No imports: the cutover's converter runs this module from the sources on Node (cli/lib/cutover/kopje-runtime.js),
// and the text of CONVERSATIONS_BACKFILL is also in migration 0009_conversations (test/migrations.test.ts checks it).
//
// A conversation row belongs to a local account and is keyed, as Mastodon keys it, by its thread and its participants:
//   - the thread stands for Mastodon's conversation_id, which a status takes from the status it replies to. Kopje
//     stores no such column, so the thread is the uri of the status a reply chain starts at: walking up from the status
//     through the parents stored (in_reply_to_id), the status the walk ends at gives the uri its in_reply_to_uri names
//     (a parent never stored, or deleted since), else its own. A status already in a conversation keeps the thread it
//     was given, and a reply takes the thread of the nearest status above it that is in one, so deleting a status of a
//     thread does not split what follows it from what was there before;
//   - the participants are the status's author and the accounts it mentions (not silently), less the row's owner, as
//     a JSON array of account ids in order (AccountConversation.participants_from_status).

// The parents the write path walks up at most, as a user's context reads its ancestors (statuses.ts); a cycle in remote
// data ends there too.
export const THREAD_DEPTH = 4096

// The thread of the status `id` (an SQL expression) for the write path: the walk stops at a status already in a
// conversation, whose thread it takes, else at the start of the chain or THREAD_DEPTH parents up.
export function threadSql(id: string): string {
	return `(WITH RECURSIVE tu (id, depth) AS (SELECT ${id}, 0
			UNION ALL
			SELECT ts.in_reply_to_id, tu.depth + 1 FROM tu JOIN statuses ts ON ts.id = tu.id
			WHERE ts.in_reply_to_id IS NOT NULL AND tu.depth < ${THREAD_DEPTH}
				AND NOT EXISTS (SELECT 1 FROM conversation_statuses tm WHERE tm.status_id = tu.id))
		SELECT COALESCE((SELECT tc.thread FROM conversation_statuses tm JOIN conversations tc ON tc.id = tm.conversation_id
				WHERE tm.status_id = tt.id LIMIT 1), tt.in_reply_to_uri, tt.uri)
		FROM (SELECT id FROM tu ORDER BY depth DESC LIMIT 1) te JOIN statuses tt ON tt.id = te.id)`
}

// The participants of the status `s` (a statuses alias) for the owner `owner`: its author and its mentions (not
// silent), less the owner, as a JSON array of account ids in order.
export function participantsSql(s: string, owner: string): string {
	return `(SELECT json_group_array(p ORDER BY p) FROM (SELECT ${s}.account_id AS p
			UNION SELECT pm.account_id FROM status_mentions pm WHERE pm.status_id = ${s}.id AND pm.silent = 0)
		WHERE p <> ${owner})`
}

// The conversations of the direct statuses stored, as the write path would have made them adding each status in
// order, in work that grows with the direct statuses and the statuses above them (each read a few times):
//   1. the direct statuses (not boosts) and every status above them, each once, with its parent;
//   2. the thread of each, from the start of each chain down (a status in a cycle of replies, which has none, takes
//      its own in_reply_to_uri);
//   3. each (owner, status), as Mastodon's own migration of account conversations made them: a direct status of a
//      local author, for its author, and one a local account holds a mention notification of, for that account
//      (NotifyService#push_to_conversation!);
//   4. a conversation of each owner, thread and participants, its last status the newest, unread when that status is
//      someone else's, numbered in the order their first status came; and its statuses.
// Two work tables hold the steps and are dropped at the end. With no conversation made, the counter the insert left
// goes too, so an empty Store stays empty.
export const CONVERSATIONS_BACKFILL = `CREATE TABLE conversation_backfill (
  id TEXT NOT NULL PRIMARY KEY,
  parent TEXT,
  thread TEXT
) WITHOUT ROWID;

INSERT INTO conversation_backfill (id, parent)
WITH RECURSIVE up (id) AS (
  SELECT id FROM statuses WHERE visibility = 'direct' AND reblog_of_id IS NULL
  UNION
  SELECT s.in_reply_to_id FROM up JOIN statuses s ON s.id = up.id WHERE s.in_reply_to_id IS NOT NULL
)
SELECT up.id, s.in_reply_to_id FROM up JOIN statuses s ON s.id = up.id;

CREATE INDEX conversation_backfill_parent ON conversation_backfill (parent);

UPDATE conversation_backfill SET thread = d.thread
FROM (
  WITH RECURSIVE down (id, thread) AS (
    SELECT b.id, COALESCE(s.in_reply_to_uri, s.uri) FROM conversation_backfill b JOIN statuses s ON s.id = b.id
    WHERE b.parent IS NULL
    UNION ALL
    SELECT b.id, down.thread FROM down JOIN conversation_backfill b ON b.parent = down.id
  )
  SELECT id, thread FROM down
) d
WHERE d.id = conversation_backfill.id;

CREATE TABLE conversation_backfill_members (
  account_id TEXT NOT NULL,
  thread TEXT NOT NULL,
  participants TEXT NOT NULL,
  status_id TEXT NOT NULL
);

INSERT INTO conversation_backfill_members (account_id, thread, participants, status_id)
SELECT o.account_id, COALESCE(b.thread, s.in_reply_to_uri, s.uri), ${participantsSql('s', 'o.account_id')}, o.status_id
FROM (
  SELECT s.account_id, s.id AS status_id FROM conversation_backfill b JOIN statuses s ON s.id = b.id
    JOIN accounts a ON a.id = s.account_id
  WHERE s.visibility = 'direct' AND s.reblog_of_id IS NULL AND a.domain IS NULL
  UNION
  SELECT n.account_id, s.id FROM conversation_backfill b JOIN statuses s ON s.id = b.id
    JOIN notifications n ON n.status_id = s.id AND n.type = 'mention'
  WHERE s.visibility = 'direct' AND s.reblog_of_id IS NULL
) o
JOIN statuses s ON s.id = o.status_id
JOIN conversation_backfill b ON b.id = o.status_id;

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

DROP TABLE conversation_backfill;

DELETE FROM sqlite_sequence WHERE name = 'conversations' AND seq = 0;`

// Fills the conversations of a database whose conversation tables are empty: the cutover's converter, once the rows
// it carries are written.
export function backfillConversations(db: { exec(sql: string): unknown }): void {
	db.exec(CONVERSATIONS_BACKFILL)
}
