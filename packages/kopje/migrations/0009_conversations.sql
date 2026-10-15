-- Kopje Store schema 0009: conversations, the direct-message list. Never edit after release (checksummed).
--
-- statuses.thread is Mastodon's conversation_id: the thread a status belongs to, written once when the status is
-- stored and never changed (the trigger statuses_thread below). A reply to a status stored takes that status's thread;
-- a reply to a status not stored takes the uri it names (in_reply_to_uri); any other status its own uri. Deleting a
-- status or a conversation changes no other status's thread.
--
-- conversations is Mastodon's account_conversations, written when a direct status is stored
-- (AccountConversation.add_status): a local author's own direct status goes into the author's conversation, and a
-- direct status a local account is notified of as a mention into that account's (NotifyService#push_to_conversation!).
-- A row is keyed by its owner, its thread and its participants (src/domain/conversation-rows.ts); it holds its
-- statuses (conversation_statuses), the newest of them, and whether it is unread. Its id is the API's.
--
-- A status leaves its conversations however it goes (a delete, an inbound Delete, a purge): its conversation_statuses
-- rows go with it (ON DELETE CASCADE), and the trigger conversation_statuses_removed moves the conversation's last status
-- back to the newest one left, or deletes the conversation when none is left (AccountConversation.remove_status).
--
-- The backfill gives every status stored its thread, from the start of each reply chain down, and makes the
-- conversations of the direct statuses as Mastodon's own migration of them did (MigrateAccountConversations): each
-- local author's direct statuses, and each direct status a local account holds a mention notification of. It is the
-- text of CONVERSATIONS_BACKFILL in src/domain/conversation-rows.ts, which the cutover's converter runs too, through
-- two work tables it drops at the end. It reads every status a few times and writes each once (its thread), and reads
-- each direct status's mentions and notifications.

ALTER TABLE statuses ADD COLUMN thread TEXT;

CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,           -- the API id, never reused: a deleted conversation stays gone
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,  -- its owner, a local account
  thread TEXT NOT NULL,                           -- the thread of its statuses (statuses.thread)
  participants TEXT NOT NULL CHECK (json_valid(participants)),  -- the other accounts: a JSON array of ids in order
  last_status_id TEXT NOT NULL,                   -- the newest of its statuses
  unread INTEGER NOT NULL DEFAULT 0 CHECK (unread IN (0, 1))
);

CREATE UNIQUE INDEX conversations_key ON conversations (account_id, thread, participants);
-- The list, newest last status first.
CREATE INDEX conversations_account ON conversations (account_id, last_status_id);

CREATE TABLE conversation_statuses (
  conversation_id INTEGER NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  status_id TEXT NOT NULL REFERENCES statuses (id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, status_id)
) WITHOUT ROWID;

CREATE INDEX conversation_statuses_status ON conversation_statuses (status_id);

CREATE TABLE conversation_threads (
  id TEXT NOT NULL PRIMARY KEY,
  thread TEXT NOT NULL
) WITHOUT ROWID;

INSERT INTO conversation_threads (id, thread)
WITH RECURSIVE down (id, thread) AS (
  SELECT id, COALESCE(in_reply_to_uri, uri) FROM statuses WHERE in_reply_to_id IS NULL
  UNION ALL
  SELECT s.id, down.thread FROM down JOIN statuses s ON s.in_reply_to_id = down.id
)
SELECT id, thread FROM down;

UPDATE statuses SET thread = COALESCE((SELECT t.thread FROM conversation_threads t WHERE t.id = statuses.id),
  in_reply_to_uri, uri);

DROP TABLE conversation_threads;

CREATE TABLE conversation_backfill_members (
  account_id TEXT NOT NULL,
  thread TEXT NOT NULL,
  participants TEXT NOT NULL,
  status_id TEXT NOT NULL
);

INSERT INTO conversation_backfill_members (account_id, thread, participants, status_id)
SELECT o.account_id, s.thread, (SELECT json_group_array(p ORDER BY p) FROM (SELECT s.account_id AS p
			UNION SELECT pm.account_id FROM status_mentions pm WHERE pm.status_id = s.id AND pm.silent = 0)
		WHERE p <> o.account_id), o.status_id
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

DELETE FROM sqlite_sequence WHERE name = 'conversations' AND seq = 0;

-- A status's thread, when it is stored: its parent's, read through the primary key, else in_reply_to_uri, else its uri.
-- A status written with its thread (an import, whose boosts and replies are linked after) keeps it.
CREATE TRIGGER statuses_thread AFTER INSERT ON statuses
WHEN NEW.thread IS NULL
BEGIN
  UPDATE statuses
    SET thread = COALESCE((SELECT p.thread FROM statuses p WHERE p.id = NEW.in_reply_to_id), NEW.in_reply_to_uri, NEW.uri)
    WHERE id = NEW.id;
END;

-- Reads the conversation's newest status left through the primary key: a few rows, however many it holds.
CREATE TRIGGER conversation_statuses_removed AFTER DELETE ON conversation_statuses
BEGIN
  UPDATE conversations
    SET last_status_id = (SELECT max(status_id) FROM conversation_statuses WHERE conversation_id = OLD.conversation_id)
    WHERE id = OLD.conversation_id AND last_status_id = OLD.status_id
      AND EXISTS (SELECT 1 FROM conversation_statuses WHERE conversation_id = OLD.conversation_id);
  DELETE FROM conversations WHERE id = OLD.conversation_id
    AND NOT EXISTS (SELECT 1 FROM conversation_statuses WHERE conversation_id = OLD.conversation_id);
END;
