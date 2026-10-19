-- Kopje Store schema 0052: the outstanding Like ids of a remote favourite. Never edit after release (checksummed).
--
-- A remote favourite (one per actor and status, as before) tracks the ids of the actor's Likes of the status
-- whose Undo has not arrived, and exists while it tracks one, or while it is legacy (src/domain/inbox.ts, like and
-- undoInteraction; ID-7). A server that replaces a reaction undoes the old Like and sends a new one, which arrive in
-- either order, so an Undo removes only its own id.
--
--   favourite_likes          one row per tracked Like id: at most MAX_TRACKED_LIKES (4) per favourite, and an id
--                            once in the instance (a Like id names one activity). uri is within ACTIVITY_ID_LIMIT
--                            (4,096 JSON-escaped UTF-8 bytes, the CHECK like_id_within_4096_json_bytes; 682 bytes
--                            cannot escape past it). received_at is the Store's own clock in ms since the epoch: an id
--                            older than LIKE_RETIRE_AFTER_MS by it may make room for a new Like at the cap.
--   favourite_likes_uri      UNIQUE, the rows by Like id: an Undo finds its own id. inbox.ts names it (INDEXED BY), so
--                            the actor's favourites are never ranged over; renaming or dropping it breaks those reads.
--   favourite_likes_favourite  a favourite's ids: its count at the cap, and the cascade of its delete.
--   favourites_like_uri      favourites by actor and stored Like id (partial: uri set): an Undo naming the id of a
--                            not-yet-tracked remote favourite finds it without ranging over the actor's favourites
--                            (inbox.ts names it, INDEXED BY).
--   favourite_likes_cap      BEFORE INSERT: RAISE(ABORT, 'favourite_likes: more than 4 Like ids for one favourite'),
--                            so the bound holds for imported dumps too and a favourite's delete cascades at most 4
--                            rows (RES-6).
--
-- Nothing is copied: a remote favourite stored before this file tracks no id and is legacy. Its favourites.uri stays as
-- its one outstanding Like id until it is tracked: an Undo of that id, typed or not, removes the favourite, an Undo
-- naming its status removes it and records both ids, and a new Like moves the id into favourite_likes (and clears
-- favourites.uri) before tracking its own. favourites.uri is used for interaction matching only for a local favourite
-- and for a not-yet-tracked remote favourite; dumps carry it verbatim.
--
-- Cost: an empty table, its two indexes and a trigger, and one index over the favourites holding a Like id. Measured
-- on the benchmark store of test/bench/migration-cost.ts (1,000,000 accounts, 2,000,000 favourites each holding a Like
-- id, and the rest of that store) in workerd's local Durable Object SQLite, timing the whole upgrade through the kernel
-- (its bookmark, this file's transaction and the verification): 7,569 to 7,859 ms in four runs at load averages of 4
-- to 8, within the 10,000 ms each migration file may take; 10,199 and 13,965 ms in two runs at load averages of 6 to
-- 9.5.

CREATE TABLE favourite_likes (
  id INTEGER PRIMARY KEY,
  favourite_id INTEGER NOT NULL REFERENCES favourites (id) ON DELETE CASCADE,
  uri TEXT NOT NULL CONSTRAINT like_id_within_4096_json_bytes
    CHECK (length(CAST(uri AS BLOB)) <= 682 OR length(CAST(json_quote(uri) AS BLOB)) <= 4098),
  received_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX favourite_likes_uri ON favourite_likes (uri);
CREATE INDEX favourite_likes_favourite ON favourite_likes (favourite_id);

CREATE INDEX favourites_like_uri ON favourites (account_id, uri) WHERE uri IS NOT NULL;

CREATE TRIGGER favourite_likes_cap BEFORE INSERT ON favourite_likes
WHEN (SELECT count(*) FROM favourite_likes WHERE favourite_id = NEW.favourite_id) >= 4
BEGIN
  SELECT RAISE(ABORT, 'favourite_likes: more than 4 Like ids for one favourite');
END;
