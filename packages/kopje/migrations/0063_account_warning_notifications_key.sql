-- Kopje Store schema 0063: the natural key of notifications with their account warning. Never edit after release
-- (checksummed).
--
-- notifications_natural (0041_report_notifications_key) gains the warning (0062), so a second warning of the same
-- account keeps its moderation_warning notification. Every other notification has no warning, so its key is
-- unchanged, and reads by the key's leading columns still use it.
--
-- Cost: the index is rebuilt over every notification (a sort of the notifications); nothing else is read. It is kept
-- apart from 0062, as 0041 is from 0040.
-- Measured on the benchmark store of test/bench/migration-cost.ts (1,000,000 accounts, 3,000,000 follows, 2,000,000
-- statuses with their mentions and tags, 2,000,000 notifications, 200,000 quotes, 10,000 reports, 20 local accounts)
-- in workerd's local Durable Object SQLite, with the whole Store's foreign keys verified:
-- 8,394 ms for the upgrade of this file through the kernel (8,528 ms in a second run), and 8,441 to 8,541 ms for the
-- release range 0058_profile_credentials to this file in one upgrade, within the budget.

DROP INDEX notifications_natural;

CREATE UNIQUE INDEX notifications_natural ON notifications
  (account_id, type, from_account_id, IFNULL(status_id, ''), IFNULL(report_id, 0), IFNULL(account_warning_id, 0));
