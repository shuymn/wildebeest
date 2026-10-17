-- Kopje Store schema 0041: the natural key of notifications with their report. Never edit after release
-- (checksummed).
--
-- notifications_natural (0000_initial) gains the report (0040), so a reporter's reports of two accounts each keep their
-- admin.report notification: without it, the key held one per reporter, and the second would replace the first. Every
-- other notification has no report, so its key is unchanged, and reads by the key's leading columns still use it.
--
-- Cost: the index is rebuilt over every notification (a sort of the notifications); nothing else is read. It is kept
-- apart from 0040, whose own cost is the schema verification every file pays. Measured on the benchmark store of
-- test/bench/migration-cost.ts (1,000,000 accounts, 3,000,000 follows, 2,000,000 statuses with their mentions and tags,
-- 2,000,000 notifications, 200,000 quotes, 10,000 reports, 20 local accounts) in workerd's local Durable Object SQLite:
-- 4,959 ms for the upgrade of this file through the kernel (its bookmark, transaction and schema verification; 4,951
-- and 4,978 ms in two more runs) on an idle machine, just within the 5,000 ms each migration file may take (a sixth of
-- the 30 s limit). On a loaded machine (load average 9 to 19) it took 4,897 to 7,566 ms.
-- Splitting does not lower it: every file also pays the schema verification, and dropping the old key in a file of
-- its own measured 7,482 ms.

DROP INDEX notifications_natural;

CREATE UNIQUE INDEX notifications_natural ON notifications (account_id, type, from_account_id, IFNULL(status_id, ''), IFNULL(report_id, 0));
