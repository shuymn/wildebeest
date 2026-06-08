-- Phase 1.7: Backfill interaction_count for existing remote data (Stance A — CRITICAL)
-- Must run before cleanup worker is enabled. Safe to re-run (full recompute).

UPDATE objects
SET interaction_count =
  (SELECT COUNT(*) FROM actor_favourites f
     JOIN actors fa ON f.actor_id = fa.id
     WHERE f.object_id = objects.id
       AND EXISTS (
         SELECT 1 FROM users u
         WHERE u.actor_id = fa.id
       ))
  + (SELECT COUNT(*) FROM actor_reblogs r
     JOIN actors ra ON r.actor_id = ra.id
     WHERE r.object_id = objects.id
       AND EXISTS (
         SELECT 1 FROM users u
         WHERE u.actor_id = ra.id
       ))
WHERE local = 0;

UPDATE actors
SET interaction_count =
  (SELECT COUNT(*) FROM actor_following af
     JOIN actors aa ON af.actor_id = aa.id
     WHERE af.target_actor_id = actors.id
       AND EXISTS (
         SELECT 1 FROM users u
         WHERE u.actor_id = aa.id
       )
       AND af.state = 'accepted')
WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.actor_id = actors.id);
