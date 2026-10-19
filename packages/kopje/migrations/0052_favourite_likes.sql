-- Kopje Store schema 0052: the outstanding Like ids of a remote favourite. Never edit after release (checksummed).
--
-- A remote favourite (one per actor and status, as before) tracks the ids of the actor's Likes of the status
-- whose Undo has not arrived, and exists while it tracks one, or while it is legacy (src/domain/inbox.ts, like and
-- undoInteraction; ID-7). A server that replaces a reaction undoes the old Like and sends a new one, which arrive in
-- either order, so an Undo removes only its own id.
--
--   favourite_likes          one row per tracked Like id: with the favourite's retained id, at most MAX_TRACKED_LIKES
--                            (4) per favourite, and an id once in the instance (a Like id names one activity). uri
--                            is within ACTIVITY_ID_LIMIT (4,096 JSON-escaped UTF-8 bytes, the CHECK
--                            like_id_within_4096_json_bytes; 682 bytes cannot escape past it). received_at is the
--                            Store's own clock in ms since the epoch: an id older than LIKE_RETIRE_AFTER_MS by it may
--                            make room for a new Like at the cap (a retained id has none and is never retired).
--   favourite_likes_uri      UNIQUE, the rows by Like id: an Undo finds its own id. inbox.ts names it (INDEXED BY), so
--                            the actor's favourites are never ranged over; renaming or dropping it breaks those reads.
--   favourite_likes_favourite  a favourite's ids: its count at the cap, and the cascade of its delete.
--   favourites_like_uri      favourites by stored Like id, then actor (partial: uri set): a Like's admission finds an
--                            id any favourite retains, and an Undo the actor's own, each in one seek (inbox.ts names
--                            it, INDEXED BY).
--   favourite_likes_cap      BEFORE INSERT: RAISE(ABORT, 'favourite_likes: more than 4 Like ids for one favourite')
--                            when the favourite's rows and its retained id already make 4, so the bound holds for
--                            imported dumps too and a favourite's delete cascades at most 4 rows (RES-6).
--
-- Nothing is copied: a remote favourite stored before this file keeps its Like id in favourites.uri, retained as one
-- of its outstanding ids. Nothing moves or clears it but its own Undo, typed or not, which clears it (and removes the
-- favourite when no tracked id remains); an Undo naming the status removes only a favourite with no id at all (a
-- converted one). No bound applies to a retained id (the CHECK covers favourite_likes only). favourites.uri is used
-- for interaction matching only for a local favourite (its own Like id) and for a remote favourite's retained id; dumps
-- carry it verbatim.
--
-- Cost: an empty table, its two indexes and a trigger, and one index over the favourites holding a Like id. Measured
-- on the benchmark store of test/bench/migration-cost.ts (1,000,000 accounts, 2,000,000 favourites each holding a Like
-- id, and the rest of that store) in workerd's local Durable Object SQLite, timing the whole upgrade through the kernel
-- (its bookmark, this file's transaction and the verification): 7,644, 7,894 and 7,997 ms at load averages of 2.9 to
-- 3.9, within the 10,000 ms each migration file may take.

CREATE TABLE favourite_likes (
  id INTEGER PRIMARY KEY,
  favourite_id INTEGER NOT NULL REFERENCES favourites (id) ON DELETE CASCADE,
  uri TEXT NOT NULL CONSTRAINT like_id_within_4096_json_bytes
    CHECK (length(CAST(uri AS BLOB)) <= 682 OR length(CAST(json_quote(uri) AS BLOB)) <= 4098),
  received_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX favourite_likes_uri ON favourite_likes (uri);
CREATE INDEX favourite_likes_favourite ON favourite_likes (favourite_id);

CREATE INDEX favourites_like_uri ON favourites (uri, account_id) WHERE uri IS NOT NULL;

CREATE TRIGGER favourite_likes_cap BEFORE INSERT ON favourite_likes
WHEN (SELECT count(*) FROM favourite_likes WHERE favourite_id = NEW.favourite_id)
  + IFNULL((SELECT uri IS NOT NULL FROM favourites WHERE id = NEW.favourite_id), 0) >= 4
BEGIN
  SELECT RAISE(ABORT, 'favourite_likes: more than 4 Like ids for one favourite');
END;
