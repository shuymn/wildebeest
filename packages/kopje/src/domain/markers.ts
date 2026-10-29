import type { Db } from "../db/sql";
import { userReadOperation, userWriteOperation } from "./auth";
import { blank } from "./lists";

// Timeline markers (Mastodon 4.5's Marker and Api::V1::MarkersController): where a user stopped reading home and
// notifications, so that another client can continue from there. One row per account and timeline (migration
// 0010_markers). last_read_id is kept as sent; nothing checks that it names a status or a notification, as Mastodon
// checks nothing either. No status is shown, so no visibility rule applies.
//
// Mastodon updates a marker under optimistic locking (lock_version) and answers 409 when another request changed it
// first. The Store runs one write at a time, each in its own transaction, so a write always sees the latest version
// and never conflicts: of two concurrent updates, the later one wins, each counted in the version.

// Marker::TIMELINES, in the order an update answers them.
export const MARKER_TIMELINES = ["home", "notifications"] as const;

export type MarkerTimeline = (typeof MARKER_TIMELINES)[number];

// Mastodon keeps last_read_id as a bigint, which bounds it. Kopje keeps the string as sent, up to this many
// characters (RES-1).
export const MAX_LAST_READ_ID = 255;

// REST::MarkerSerializer.
type Marker = { last_read_id: string; version: number; updated_at: string };

export type Markers = Partial<Record<MarkerTimeline, Marker>>;

type MarkerRow = Marker & { timeline: MarkerTimeline };

// The viewer's markers of `timelines` (at most one row per timeline: the account's rows are read through the key).
function markersOf(db: Db, accountId: string, timelines: readonly MarkerTimeline[]): Markers {
  const rows = db.all<MarkerRow>(
    "SELECT timeline, last_read_id, version, updated_at FROM markers WHERE account_id = ?",
    accountId,
  );
  const markers: Markers = {};
  for (const timeline of timelines) {
    const row = rows.find((r) => r.timeline === timeline);
    if (row !== undefined) {
      markers[timeline] = { last_read_id: row.last_read_id, version: row.version, updated_at: row.updated_at };
    }
  }
  return markers;
}

// GET /api/v1/markers: the viewer's markers of the timelines asked for; a timeline without one is left out.
export const getMarkers = userReadOperation<{ timelines: MarkerTimeline[] }, Markers>((db, input, { accountId }) =>
  markersOf(db, accountId, input.timelines),
);

// A timeline an update names, with the last_read_id sent for it (undefined: none).
export type MarkerUpdate = { timeline: MarkerTimeline; lastReadId: string | undefined };

export type SaveMarkersResult = { status: "ok"; markers: Markers } | { status: "invalid"; errors: string[] };

// Marker's validation of last_read_id (presence), with Rails' message, and Kopje's bound.
function lastReadIdErrors(lastReadId: string): string[] {
  if (blank(lastReadId)) {
    return ["Last read can't be blank"];
  }
  if ([...lastReadId].length > MAX_LAST_READ_ID) {
    return [`Last read is too long (maximum is ${MAX_LAST_READ_ID} characters)`];
  }
  return [];
}

// POST /api/v1/markers: each timeline named, in Marker::TIMELINES order, gets its marker (find_or_create_by: a new one
// reads "0" at version 0, the column defaults) and then the last_read_id sent, if any. A value that changes the
// marker counts a version and sets updated_at, so a new marker's first value is version 1; the same value changes
// nothing (update! saves no unchanged record).
// The first invalid value refuses the whole request with its errors, and nothing changes (Marker.transaction).
export const saveMarkers = userWriteOperation<{ updates: MarkerUpdate[] }, SaveMarkersResult>(
  (db, { updates }, { accountId, now }) => {
    for (const { lastReadId } of updates) {
      const errors = lastReadId === undefined ? [] : lastReadIdErrors(lastReadId);
      if (errors.length > 0) {
        return { status: "invalid", errors };
      }
    }
    const at = new Date(now).toISOString();
    for (const { timeline, lastReadId } of updates) {
      db.run(
        `INSERT INTO markers (account_id, timeline, last_read_id, version, updated_at) VALUES (?, ?, '0', 0, ?)
				ON CONFLICT (account_id, timeline) DO NOTHING`,
        accountId,
        timeline,
        at,
      );
      if (lastReadId !== undefined) {
        db.run(
          `UPDATE markers SET last_read_id = ?3, version = version + 1, updated_at = ?4
					WHERE account_id = ?1 AND timeline = ?2 AND last_read_id <> ?3`,
          accountId,
          timeline,
          lastReadId,
          at,
        );
      }
    }
    return {
      status: "ok",
      markers: markersOf(
        db,
        accountId,
        updates.map((u) => u.timeline),
      ),
    };
  },
);
