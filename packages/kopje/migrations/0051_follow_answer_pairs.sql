-- Kopje Store schema 0051: the account pair of a follow answer, and whether a delivery was ever claimed. Never edit
-- after release (checksummed).
--
-- A remote Follow cancels its pair's answers that were never claimed (src/domain/deliveries.ts cancelFollowAnswers,
-- NET-2, RES-6; the accepted risk in docs/threat-model.md covers the answers that were):
--
--   outbound_activities.follow_pair     the remote follower's account id on a local account's Accept or Reject of a
--                                       Follow; NULL on every other intent (a QuoteRequest's answer included).
--   outbound_activities_follow_pair     the unsettled answers of each (signer, follower) pair: what a Follow reads.
--   outbound_activities_follow_swept    the superseded answers by id: what sweepDeliveries reads to delete their
--                                       given-up rows before the 30-day retention.
--   deliveries.exposed                  1 once a claim has leased the row (it may have been POSTed); never set back
--                                       to 0. A row with 0 was never handed to a POST.
--
-- No stored row proves it was never claimed (an operator retry clears attempts, status and error), so every existing
-- delivery of a follow answer is backfilled as exposed. The pair is read from the answered Follow's actor, as the
-- answer names it (activities.ts followAnswerActivity), joined to the remote account with that uri.
--
-- Cost: two ALTERs (the CHECK on the added column tests every delivery), one scan of the outbound activities for the
-- backfill (a body without 'Follow' is not parsed), two partial index builds (a scan each) and an update of the
-- tagged answers' rows through deliveries_activity. Measured whole-file upgrade on the representative store in
-- test/bench/migration-cost.ts, in workerd's local Durable Object SQLite: 7.3–8.0 seconds; budget 20 seconds.

ALTER TABLE outbound_activities ADD COLUMN follow_pair TEXT;
ALTER TABLE deliveries ADD COLUMN exposed INTEGER NOT NULL DEFAULT 0 CHECK (exposed IN (0, 1));

UPDATE outbound_activities SET follow_pair =
  (SELECT a.id FROM accounts a WHERE a.uri = json_extract(body, '$.activity.object.actor') AND a.domain IS NOT NULL)
WHERE instr(body, 'Follow') > 0
  AND json_extract(body, '$.activity.type') IN ('Accept', 'Reject')
  AND json_extract(body, '$.activity.object.type') = 'Follow';

CREATE INDEX outbound_activities_follow_pair ON outbound_activities (account_id, follow_pair, id)
  WHERE follow_pair IS NOT NULL;
CREATE INDEX outbound_activities_follow_swept ON outbound_activities (id)
  WHERE follow_pair IS NOT NULL AND superseded = 1;

UPDATE deliveries SET exposed = 1
WHERE activity_id IN (SELECT id FROM outbound_activities WHERE follow_pair IS NOT NULL);
