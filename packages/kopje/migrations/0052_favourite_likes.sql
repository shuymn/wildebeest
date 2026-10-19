-- Kopje Store schema 0052: the outstanding Like ids of a remote favourite. Never edit after release (checksummed).
--
-- A remote favourite (one per actor and status, as before) tracks the ids of the actor's Likes of the status
-- whose Undo has not arrived, and exists while it tracks one, or while it is legacy (src/domain/inbox.ts, like and
-- undoInteraction; ID-7). A server that replaces a reaction undoes the old Like and sends a new one, which arrive in
-- either order, so an Undo removes only its own id. favourites.uri is left only to a local favourite's own Like id.
--
--   favourite_likes          one row per tracked Like id: at most MAX_TRACKED_LIKES (4) per favourite, and an id
--                            once in the instance (a Like id names one activity). uri is within ACTIVITY_ID_LIMIT
--                            (4,096 JSON-escaped UTF-8 bytes, the CHECK like_id_within_4096_json_bytes; 682 bytes
--                            cannot escape past it). received_at is the Store's own clock in ms since the epoch: an id
--                            older than LIKE_RETIRE_AFTER_MS by it may make room for a new Like at the cap.
--   favourite_likes_uri      UNIQUE, the rows by Like id: an Undo finds its own id. inbox.ts names it (INDEXED BY), so
--                            the actor's favourites are never ranged over; renaming or dropping it breaks those reads.
--   favourite_likes_favourite  a favourite's ids: its count at the cap, and the cascade of its delete.
--   favourite_likes_cap      BEFORE INSERT: RAISE(ABORT, 'favourite_likes: more than 4 Like ids for one favourite'),
--                            so the bound holds for imported dumps too and a favourite's delete cascades at most 4
--                            rows (RES-6).
--
-- Backfill: a remote favourite's stored Like id becomes its one tracked id, received at the favourite's created_at
-- (0 when that does not parse), and its favourites.uri is cleared. An id past the bound, or one a favourite of lower
-- id holds too (earlier ingestion keyed favourites by actor and status only), is not moved: that favourite is legacy,
-- and an Undo naming its status removes it. How many were not moved is left in kopje_state as
-- favourite_likes_dropped, {"past_bound": n, "repeated": n}, when any were. A remote favourite without a stored id
-- (cutover, import) tracks none and is legacy too. The rows are loaded before the indexes are built, each built once
-- from them; the repeated ids go through an index of their own first. Local accounts are found by
-- accounts_domain_username, so each statement reads each favourite once and no account per favourite.
--
-- Cost: a scan of the favourites for each of the copy and the clear, a write of every remote favourite with an id,
-- an index of the copied ids built and dropped for the repeated ones, and the two indexes. Measured on the benchmark
-- store of test/bench/migration-cost.ts (1,000,000 accounts, 2,000,000 favourites each holding a Like id, and the rest
-- of that store) in workerd's local Durable Object SQLite, timing the whole upgrade through the kernel (its bookmark,
-- this file's transaction and the verification): 13,108, 13,286 and 15,534 ms at load averages of 3 to 9, past the
-- 10,000 ms each migration file may take; a file that only creates the table takes 6,485 ms there.

CREATE TABLE favourite_likes (
  id INTEGER PRIMARY KEY,
  favourite_id INTEGER NOT NULL REFERENCES favourites (id) ON DELETE CASCADE,
  uri TEXT NOT NULL CONSTRAINT like_id_within_4096_json_bytes
    CHECK (length(CAST(uri AS BLOB)) <= 682 OR length(CAST(json_quote(uri) AS BLOB)) <= 4098),
  received_at INTEGER NOT NULL
);

INSERT INTO favourite_likes (favourite_id, uri, received_at)
SELECT f.id, f.uri, IFNULL(CAST((julianday(f.created_at) - 2440587.5) * 86400000 AS INTEGER), 0)
FROM favourites f
WHERE f.uri IS NOT NULL AND f.account_id NOT IN (SELECT id FROM accounts WHERE domain IS NULL)
  AND (length(CAST(f.uri AS BLOB)) <= 682 OR length(CAST(json_quote(f.uri) AS BLOB)) <= 4098)
ORDER BY f.id;

INSERT OR REPLACE INTO kopje_state (name, value)
VALUES ('favourite_likes_dropped', json_object('copied', changes()));

CREATE INDEX favourite_likes_repeated ON favourite_likes (uri);

DELETE FROM favourite_likes WHERE EXISTS (SELECT 1 FROM favourite_likes d INDEXED BY favourite_likes_repeated
  WHERE d.uri = favourite_likes.uri AND d.id < favourite_likes.id);

UPDATE kopje_state SET value = json_set(value, '$.repeated', changes()) WHERE name = 'favourite_likes_dropped';

DROP INDEX favourite_likes_repeated;

UPDATE favourites SET uri = NULL
WHERE uri IS NOT NULL AND account_id NOT IN (SELECT id FROM accounts WHERE domain IS NULL);

UPDATE kopje_state SET value = json_object('past_bound', changes() - (value ->> '$.copied'),
  'repeated', value ->> '$.repeated') WHERE name = 'favourite_likes_dropped';

DELETE FROM kopje_state WHERE name = 'favourite_likes_dropped' AND value = '{"past_bound":0,"repeated":0}';

CREATE UNIQUE INDEX favourite_likes_uri ON favourite_likes (uri);
CREATE INDEX favourite_likes_favourite ON favourite_likes (favourite_id);

CREATE TRIGGER favourite_likes_cap BEFORE INSERT ON favourite_likes
WHEN (SELECT count(*) FROM favourite_likes WHERE favourite_id = NEW.favourite_id) >= 4
BEGIN
  SELECT RAISE(ABORT, 'favourite_likes: more than 4 Like ids for one favourite');
END;
