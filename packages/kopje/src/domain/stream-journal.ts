import type { Db } from "../db/sql";

// The streaming journal's bound and the events that need no presenter at capture, for streaming.ts and the modules
// streaming.ts presents (announcements.ts), so neither imports the other.

// The journal stops recording once it spans this many ids: the fan-out stalled, and REST is authoritative.
export const JOURNAL_SPAN = 4096;

// The streaming API's announcement events (announcements.ts calls it on each write that changes what a listener may be
// shown): an `announcement` event (subject: the id) or an `announcement_reaction` one (subject: ["<id>","<name>"]) in
// the journal, one per write, while some account listens on `user` (the scope is checked when it is sent) and the
// journal is not full. Nothing is coalesced: a socket opened after an earlier event is sent each later write's own
// event (the hub sends an event only to sockets opened before it). The writes are admin- and user-rate, and
// JOURNAL_SPAN bounds the journal as for every event.
export function streamAnnouncement(
  db: Db,
  kind: "announcement" | "announcement_reaction",
  subject: string,
  now: string,
): void {
  if (db.first("SELECT 1 AS x FROM stream_subscriptions WHERE stream_key = 'user'") === undefined) {
    return;
  }
  if (journalFull(db, kind)) {
    return;
  }
  db.run("INSERT INTO stream_events (kind, subject, created_at) VALUES (?, ?, ?)", kind, subject, now);
}

// Whether the journal spans JOURNAL_SPAN ids (the fan-out stalled), logged for an event of `kind` it then refuses.
export function journalFull(db: Db, kind: string): boolean {
  const span = db.first<{ span: number }>(
    "SELECT coalesce((SELECT max(id) FROM stream_events) - (SELECT min(id) FROM stream_events), 0) AS span",
  );
  if ((span?.span ?? 0) < JOURNAL_SPAN) {
    return false;
  }
  console.warn({ event: "kopje.stream.journal-full", kind });
  return true;
}
