import { type Account, admitAccounts, type Present } from "./accounts";
import { ARRAY_ANSWER_BYTES } from "./answer-budget";
import { listedForSql } from "./audience";
import { optionalUserReadOperation } from "./auth";

// The profile directory (Mastodon 4.5's Api::V1::DirectoriesController, GET /api/v1/directory): the discoverable
// accounts (Account.discoverable), the most recently active first (`order=active`, AccountStat.by_recent_status) or the
// newest first (`order=new`), all of them or the local ones (`local`), paged by `offset` and `limit`.
//
// An account is listed when it is discoverable (accounts.discoverable = 1: a local account's setting, or what a remote
// actor published; an actor that published nothing is not) and R12 lists it to the viewer (listedForSql): it is
// available (R1: not suspended, not being deleted), and the viewer neither blocks nor mutes it nor blocks its domain,
// nor does it block the viewer. That is Mastodon's Account.discoverable less its silenced and moved terms (Kopje has
// no silences and does not record a move), with not_excluded_by_account and not_domain_blocked_by_account for a
// signed-in viewer (a local account is never on a blocked domain, so `local` changes nothing there).
//
// `order=active` orders by the account's newest public, unlisted or private status (accounts.last_status_id, kept by
// the triggers of migration 0021_directory: the status whose date the presenter shows as last_status_at), accounts
// without one last, then by id, newest first.
//
// Work is bounded (RES-7). A page reads the partial index of its order (discoverable accounts only, all or local) from
// the start: at most DIRECTORY_WINDOW times offset + limit entries, each judged by R12 through lookups by key, and
// answers the entries the rule lists from `offset`. So a page reads in proportion to offset + limit, never the
// accounts that are not discoverable nor those below the window; when more than half of the window is hidden from the
// viewer (accounts they block or mute, or unavailable ones), the page comes back short. The window is a prefix of the
// directory, so every page is a slice of what the full directory would list. An offset above MAX_DIRECTORY_OFFSET
// answers no accounts. The answer is within ANSWER_BYTES (RES-3), its profiles read for the page only: past it, the
// page holds fewer accounts (an offset endpoint, docs/response-inventory.md).

export const DIRECTORY_DEFAULT_LIMIT = 40;
export const DIRECTORY_MAX_LIMIT = 80;
export const MAX_DIRECTORY_OFFSET = 400;
export const DIRECTORY_WINDOW = 2;

export type DirectoryOrder = "active" | "new";

export type DirectoryInput = { order: DirectoryOrder; local: boolean; offset: number; limit: number; present: Present };

// Each order's partial indexes (all discoverable accounts, the local ones) and its terms over the window `w`.
const ORDERS: Record<DirectoryOrder, { all: string; local: string; by: (w: string) => string }> = {
  active: {
    all: "accounts_directory_active",
    local: "accounts_directory_local_active",
    by: (w) => `${w}last_status_id DESC, ${w}id DESC`,
  },
  new: { all: "accounts_directory_new", local: "accounts_directory_local_new", by: (w) => `${w}id DESC` },
};

export const directory = optionalUserReadOperation<DirectoryInput, Account[]>(
  (db, { order, local, offset, limit, present }, { accountId: viewerId, now }) => {
    if (offset > MAX_DIRECTORY_OFFSET || limit <= 0) {
      return [];
    }
    const sort = ORDERS[order];
    const rows = db.all<{ id: string }>(
      `SELECT w.id
			FROM (SELECT id, last_status_id FROM accounts INDEXED BY ${local ? sort.local : sort.all}
				WHERE discoverable = 1 ${local ? "AND domain IS NULL" : ""} ORDER BY ${sort.by("")} LIMIT ?1) w
			WHERE ${listedForSql("w.id", "?2", "?3")}
			ORDER BY ${sort.by("w.")} LIMIT ?4 OFFSET ?5`,
      DIRECTORY_WINDOW * (offset + limit),
      viewerId,
      now,
      limit,
      offset,
    );
    const ids = rows.map((row) => row.id);
    return admitAccounts(db, ids, present, ARRAY_ANSWER_BYTES, true).items;
  },
);
