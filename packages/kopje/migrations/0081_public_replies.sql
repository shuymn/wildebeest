-- Kopje Store schema 0081: a status's public and unlisted replies in id order. Never edit after release (checksummed).
--
--   statuses_public_replies   statuses by (in_reply_to_id, id), of the replies that are public or unlisted: the
--                             candidates of a status page's Replies tab (src/domain/timelines.ts statusRepliesWithin),
--                             read from the page's cursor in id order, so a page reads a window of them however many
--                             private, direct or limited replies the status has, and none of those becomes a cursor
--                             (RES-7). The list is DISTRIBUTABLE_SQL's, in its order (src/domain/audience.ts), which
--                             SQLite needs to match the read to this index.
--
-- Cost: the index reads every statuses row once and holds the public and unlisted replies; nothing else is read or
-- written. Measured on the benchmark store of test/bench/migration-cost.ts in workerd's local Durable Object SQLite:
-- see the CHANGELOG entry of the release that adds it.

CREATE INDEX statuses_public_replies ON statuses (in_reply_to_id, id)
  WHERE in_reply_to_id IS NOT NULL AND visibility IN ('public', 'unlisted');
