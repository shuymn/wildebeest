-- Kopje Store schema 0052: the outstanding Like ids of a remote favourite. Never edit after release (checksummed).
--
-- A remote favourite (one per actor and status, as before) tracks the ids of the actor's Likes of the status
-- whose Undo has not arrived, and exists while it tracks one, or while it is legacy (src/domain/inbox.ts, like and
-- undoInteraction; ID-7). A server that replaces a reaction undoes the old Like and sends a new one, which arrive in
-- either order, so an Undo removes only its own id. favourites.uri is left only to a local favourite's own Like id.
--
--   favourite_likes          one row per tracked Like id: at most MAX_TRACKED_LIKES (4) per favourite, an id once per
--                            favourite. received_at is the receiving Store's time in ms since the epoch: an id older
--                            than LIKE_RETIRE_AFTER_MS may make room for a new Like at the cap (its Undo was lost).
--   favourite_likes_uri      the rows by Like id: an Undo finds its own id. inbox.ts names it (INDEXED BY), so the
--                            actor's favourites are never ranged over; renaming or dropping it breaks those reads.
--   favourite_likes_cap      BEFORE INSERT: RAISE(ABORT, 'favourite_likes: more than 4 Like ids for one favourite'),
--                            so the bound holds for imported dumps too and a favourite's delete cascades at most 4
--                            rows (RES-6).
--
-- Backfill: a remote favourite's stored Like id becomes its one tracked id, received at the favourite's created_at
-- (0 when that does not parse), and its favourites.uri is cleared. A remote favourite without a stored id (cutover,
-- import) tracks none: it is legacy, and an Undo naming its status removes it. Local accounts are found by
-- accounts_domain_username, so the statements read each favourite once and no account per favourite.
--
-- Cost: a scan of the favourites for each of the copy and the clear, a write of every remote favourite with an id,
-- and the index of the copied ids. Measured on the benchmark store of test/bench/migration-cost.ts (1,000,000
-- accounts, 2,000,000 favourites of which 500,000 hold a Like id, and the rest of that store) in workerd's local
-- Durable Object SQLite, timing the whole upgrade through the kernel (its bookmark, this file's transaction and the
-- verification): 8,000 to 8,766 ms in five runs at load averages of 3 to 7, within the 10,000 ms each migration file
-- may take; 10,920 and 21,743 ms in two runs at load averages above 7. With all 2,000,000 holding an id, 10,868 ms.

CREATE TABLE favourite_likes (
  id INTEGER PRIMARY KEY,
  favourite_id INTEGER NOT NULL REFERENCES favourites (id) ON DELETE CASCADE,
  uri TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  UNIQUE (favourite_id, uri)
);

INSERT INTO favourite_likes (favourite_id, uri, received_at)
SELECT f.id, f.uri, IFNULL(CAST((julianday(f.created_at) - 2440587.5) * 86400000 AS INTEGER), 0)
FROM favourites f
WHERE f.uri IS NOT NULL AND f.account_id NOT IN (SELECT id FROM accounts WHERE domain IS NULL);

UPDATE favourites SET uri = NULL
WHERE uri IS NOT NULL AND account_id NOT IN (SELECT id FROM accounts WHERE domain IS NULL);

CREATE INDEX favourite_likes_uri ON favourite_likes (uri);

CREATE TRIGGER favourite_likes_cap BEFORE INSERT ON favourite_likes
WHEN (SELECT count(*) FROM favourite_likes WHERE favourite_id = NEW.favourite_id) >= 4
BEGIN
  SELECT RAISE(ABORT, 'favourite_likes: more than 4 Like ids for one favourite');
END;
