-- Kopje Store schema 0040: report notifications. Never edit after release (checksummed).
--
-- The OAuth admin is notified of a report (Mastodon's admin.report, ReportService#notify_staff!; src/domain/reports.ts,
-- R34, R37, VIS-29). The notification names its report:
--
--   notifications.report_id   the report an admin.report notification is about, NULL for every other type. It goes
--                             with its report (ON DELETE CASCADE): a remote account's purge deletes the pushes and the
--                             notifications of the reports of it before the reports (src/domain/inbox.ts), so no
--                             report's delete cascades to one.
--   notifications_report      one notification per report and recipient (LocalNotificationWorker keys a notification
--                             by its activity, the report); it also serves the foreign key and the purge, whose
--                             `report_id = ?` implies its predicate. 0041 adds the report to the natural key.
--
-- Cost: the ALTER is a change of the schema alone, and the partial index reads each notification once and holds none.
-- Measured on the benchmark store of test/bench/migration-cost.ts (1,000,000 accounts, 3,000,000 follows, 2,000,000
-- statuses with their mentions and tags, 2,000,000 notifications, 200,000 quotes, 10,000 reports, 20 local accounts)
-- in workerd's local Durable Object SQLite: 3,122 ms for the upgrade of this file through the kernel (its bookmark,
-- transaction and schema verification; 3,145 ms in a second run), within the per-file budget
-- (test/bench/migration-cost.ts).

ALTER TABLE notifications ADD COLUMN report_id INTEGER REFERENCES reports (id) ON DELETE CASCADE;

CREATE UNIQUE INDEX notifications_report ON notifications (report_id, account_id) WHERE report_id IS NOT NULL;
