import type { Db } from "../../db/sql";
import { httpUrl } from "../../platform/http-url";
import type { Account, Present } from "../accounts";
import { statusReads } from "../audience";
import { contextOf } from "../auth";
import { readOperation } from "../operation";
import { presentation, presentStatus, type Status, statusStream } from "../status-presenter";
import {
  contextAncestors,
  type EditVersion,
  editVersions,
  interactorsWithin,
  resolveStatusId,
  statusQuotesWithin,
} from "../statuses";
import { statusRepliesWithin } from "../timelines";
import {
  accountList,
  admitMandatory,
  altCopyBytes,
  admitStrict,
  charge,
  LONGEST_STATUS_STUB,
  type PageBudget,
  pageBudget,
  pageItemBytes,
  type StatusStub,
  statusList,
  WEB_PAGE_BYTES,
} from "./budget";
import { LONGEST_PAGING, type PageCursor, type Paging, pagingOf } from "./paging";
import { listParents, type ParentLink, parentLink } from "./parents";
import { anonymous, localUsername, pageRead, type Site } from "./site";

export const REPLIES_PAGE_SIZE = 20;

// The quotes and the accounts a status page's tabs list at a time (20 statuses, 40 accounts), the API's
// default pages of GET /api/v1/statuses/:id/quotes and /favourited_by and /reblogged_by.
export const QUOTES_PAGE_SIZE = 20;
export const INTERACTORS_PAGE_SIZE = 40;

// A status page's tabs: its replies (the page itself), the accounts that boosted it, those that
// favourited it, and its quotes.
export type StatusTabKind = "replies" | "reblogs" | "favourites" | "quotes";

// What the page shows beside the status: one tab at the request's cursor, or nothing (the embed, and the ActivityPub
// form of the status page, which forwards to the object endpoint).
type StatusTab = { kind: StatusTabKind; cursor: PageCursor };

export type StatusInput = { handle: string; id: string; now: number; tab: StatusTab | null };

// A tab's list on its page, newest first but for the replies (oldest first). The replies and the quotes
// are statuses, of which a first that did not fit is its stub; the quotes have their parent links (the replies' parent
// is the page's status). The boosts and favourites are the accounts that made them.
export type TabList =
  | { kind: "replies"; statuses: Status[]; stub: StatusStub | null }
  | { kind: "quotes"; statuses: Status[]; stub: StatusStub | null; parents: Record<string, ParentLink> }
  | { kind: "reblogs" | "favourites"; accounts: Account[] };

// The status's thread: its ancestors an anonymous viewer may see, oldest first; its tab's list on the
// request's page; and the page's paging facts, `newest` and `oldest` by the tab's cursor whatever the direction the
// page was read in.
export type Thread = { ancestors: Status[]; list: TabList; paging: Paging };

// A status's edit history on its page: its recorded versions newest first, as many as
// fit its share whole, and how many older ones were left out. Null when the status has no recorded versions (never
// edited, or edited with no history kept) and on the embed.
export type PageHistory = { versions: EditVersion[]; leftOut: number };

export type StatusPage =
  | { status: "ok"; value: Status; parent: ParentLink | null; thread: Thread | null; history: PageHistory | null }
  | { status: "moved"; username: string; id: string }
  | { status: "not_found" };

// A local status by the path's handle and id (an API id, or a legacy id, which moves to the API id): the status page
// and the embed (embed mode shows the status, its parent link and quote, and nothing else). VIS-4: only a
// public or unlisted original of a local account that is not suspended; anything else, of another author, a boost, a
// remote status or no status at all, is the same not_found. The parent is linked only when the anonymous viewer may
// see it (VIS-12). The status and its parent link are the page's head (budget.ts); with a tab, its thread follows,
// then its edit history.
export const webStatusPage = pageRead<StatusInput, StatusPage>((db, input, site) =>
  statusPageWithin(db, input, site, WEB_PAGE_BYTES),
);

// The read, within `answerBytes` (tests pass less to reach the stub at a small size).
export function statusPageWithin(db: Db, input: StatusInput, site: Site, answerBytes: number): StatusPage {
  const { handle, id, now, tab } = input;
  const username = localUsername(handle, site.domain);
  if (username === null || username === "") {
    return { status: "not_found" };
  }
  const resolved = resolveStatusId(db, id);
  if (resolved === null) {
    return { status: "not_found" };
  }
  const row = pageStatus(db, { id: resolved, username });
  if (row === undefined) {
    return { status: "not_found" };
  }
  if (resolved !== id) {
    return { status: "moved", username: row.username, id: resolved };
  }
  const options = anonymous(site, now);
  const status = presentStatus(db, row.id, options);
  if (status === null) {
    return { status: "not_found" };
  }
  // The head of the page's budget; the status page's later parts take what it leaves.
  const budget = pageBudget(
    {
      status: "ok",
      value: null,
      parent: null,
      thread: tab === null ? null : emptyThread(tab.kind),
      history: LONGEST_HISTORY_FRAME,
      site,
    } satisfies Omit<Extract<StatusPage, { status: "ok" }>, "value"> & { value: null; site: Site },
    answerBytes,
  );
  admitMandatory(budget, status, altCopyBytes(status));
  const parent = parentLink(db, row.in_reply_to_id);
  admitMandatory(budget, parent);
  if (tab === null) {
    return { status: "ok", value: status, parent, thread: null, history: null };
  }
  // The thread in this order: the tab's first item (a reply or quote, or its stub; an account, whole), then the
  // ancestors, nearest first, within half of what is left, then the rest of the list, strictly; the ancestors past the
  // first that does not fit are left out, the farthest first, so the list keeps its room. The ancestors need no
  // parent links (each one's is the one before it, or a status the thread does not show), nor do the replies (their
  // parent is the page's status); the quotes have theirs, reserved as each is admitted. Each ancestor, reply and quote
  // links to its own page, or to its origin, where the thread goes on.
  const up = contextAncestors(db, options.viewer, row.id).toReversed();
  const near = statusStream(db, presentation(db, up, options), up);
  // The list runs afterHead once, whether it read an item or none.
  const ancestors: Status[] = [];
  const admitAncestors = () => {
    const share = { remaining: Math.floor(Math.max(0, budget.remaining) / 2), ceiling: budget.ceiling };
    const admitted = admitStrict(share, near, pageItemBytes);
    charge(budget, admitted.bytes);
    ancestors.push(...admitted.items);
  };
  const { list, paging } = tabList(db, row.id, tab, options, budget, admitAncestors);
  return {
    status: "ok",
    value: status,
    parent,
    thread: { ancestors: ancestors.toReversed(), list, paging },
    history: pageHistory(db, row.id, budget),
  };
}

// The tab's page of the status `id`, read by the API's own body for the same list (an anonymous viewer: the
// replies' statusRepliesWithin, interactorsWithin, statusQuotesWithin), within the page budget.
function tabList(
  db: Db,
  id: string,
  { kind, cursor }: StatusTab,
  options: ReturnType<typeof anonymous>,
  budget: PageBudget,
  afterHead: () => void,
): { list: TabList; paging: Paging } {
  switch (kind) {
    case "replies": {
      const list = statusList(budget, { size: pageItemBytes, afterHead });
      const read = statusRepliesWithin(
        db,
        { id, page: { limit: REPLIES_PAGE_SIZE, ...cursor }, present: options },
        options.viewer,
        list.admission,
      );
      return {
        list: { kind, statuses: read.page.items.toReversed(), stub: list.stub() },
        paging: pagingOf({ newest: read.page.newest, oldest: read.page.oldest, more: read.more }),
      };
    }
    case "quotes": {
      const list = statusList(budget, { afterHead });
      const page = { limit: QUOTES_PAGE_SIZE, ...cursor };
      const read = statusQuotesWithin(db, { id, page, present: options }, options.viewer, false, list.admission);
      return {
        list: { kind, statuses: read.items, stub: list.stub(), parents: listParents(db, budget, read.items) },
        paging: pagingOf({ newest: read.newest, oldest: read.oldest, more: read.more }),
      };
    }
    case "reblogs":
    case "favourites": {
      const read = interactorsWithin(
        db,
        {
          id,
          kind: kind === "reblogs" ? "reblogged_by" : "favourited_by",
          page: { limit: INTERACTORS_PAGE_SIZE, ...cursor },
          present: options,
        },
        options.viewer,
        accountList(budget, afterHead),
      );
      return {
        list: { kind, accounts: read.page.items },
        paging: pagingOf({ newest: read.page.newest, oldest: read.page.oldest, more: read.more }),
      };
    }
  }
}

// The longest empty thread of a tab: what a status page's frame reserves for it (the list's stub, or none for the
// accounts, whose first is charged whole; budget.ts accountList).
function emptyThread(kind: StatusTabKind): Thread {
  const list: TabList =
    kind === "replies"
      ? { kind, statuses: [], stub: LONGEST_STATUS_STUB }
      : kind === "quotes"
        ? { kind, statuses: [], stub: LONGEST_STATUS_STUB, parents: {} }
        : { kind, accounts: [] };
  return { ancestors: [], list, paging: LONGEST_PAGING };
}

// What a page's edit history may take at most: 512 KiB of the page budget, of its versions' JSON with
// their separators.
export const WEB_HISTORY_BYTES = 512 * 1024;

// The history's frame, with the count of versions left out at its longest: a page's frame reserves it whatever the
// read finds (VIS-4: the answer's shape says nothing of the status's history).
const LONGEST_HISTORY_FRAME: PageHistory = { versions: [], leftOut: Number.MAX_SAFE_INTEGER };

// The history, strict: versions newest first while each fits whole within the lesser of what the
// page budget leaves and WEB_HISTORY_BYTES; the first that does not ends them, and it and every older one are counted
// as left out. No version is ever cut or admitted past its share.
function pageHistory(db: Db, statusId: string, budget: PageBudget): PageHistory | null {
  const versions = editVersions(db, statusId);
  if (versions.count === 0) {
    return null;
  }
  const share: PageBudget = { remaining: Math.min(budget.remaining, WEB_HISTORY_BYTES), ceiling: budget.ceiling };
  const admitted = admitStrict(share, versions.newestFirst, pageItemBytes);
  charge(budget, admitted.bytes);
  return { versions: admitted.items, leftOut: versions.count - admitted.consumed };
}

// VIS-4's read of the status page: the status by id under the local account the path names, or by its object URI
// (/ap/o/<uuid>, which names no account), if an anonymous viewer may see it and it is not a boost. The embed and
// /authorize_interaction's local permalinks (domain/interaction.ts) reach it through targetStatus.
function pageStatus(db: Db, by: { id: string; username: string } | { uri: string }) {
  const read = statusReads(null, { viewer: "?1" });
  const byId = "id" in by;
  return read.select<{ in_reply_to_id: string | null; username: string }>(
    db,
    "visible",
    {
      join: "JOIN accounts au ON au.id = s.account_id",
      where: `${byId ? "s.id = ?2 AND lower(au.username) = lower(?3)" : "s.uri = ?2"} AND au.domain IS NULL AND s.reblog_of_id IS NULL`,
      columns: { in_reply_to_id: "s.in_reply_to_id", username: "au.username" },
    },
    null,
    ...(byId ? [by.id, by.username] : [by.uri]),
  )[0];
}

export type EmbeddedStatus = { status: "ok"; value: Status; domain: string } | { status: "not_found" };

// The status a URL of this instance names, if it may be embedded: exactly when its status page shows it (VIS-4), as
// Mastodon embeds a status unless it is hidden? (private, direct or limited). The URL forms are the status page's,
// /@username/:id (an API id or a legacy id), and the object URI, /ap/o/<uuid> (Mastodon's StatusFinder takes its
// /users/:username/statuses/:id); anything else is not found.
export const embeddedStatus = readOperation<{ url: string; present: Present; now: number }, EmbeddedStatus>(
  (db, { url, present, now }) => {
    const domain = db.first<{ value: string }>("SELECT value FROM instance_settings WHERE name = 'domain'")?.value;
    const target = domain === undefined ? null : statusTarget(url, domain);
    if (domain === undefined || target === null) {
      return { status: "not_found" };
    }
    const row = targetStatus(db, target);
    const status = row === undefined ? null : presentStatus(db, row.id, { ...present, viewer: contextOf(null, now) });
    return status === null ? { status: "not_found" } : { status: "ok", value: status, domain };
  },
);

// The status a parsed URL (statusTarget) names, its API or legacy id resolved, if the status page shows it.
export function targetStatus(db: Db, target: { id: string; username: string } | { uri: string }) {
  if ("uri" in target) {
    return pageStatus(db, target);
  }
  const id = resolveStatusId(db, target.id);
  return id === null ? undefined : pageStatus(db, { id, username: target.username });
}

const STATUS_PATH = /^\/(@[^/]+)\/([^/]+)\/?$/;
const OBJECT_PATH = /^\/ap\/o\/([^/]+)\/?$/;

// Where an http(s) URL of this instance's host points: a status page (Mastodon's StatusFinder: a local URL routed to
// StatusesController#show), or an object URI. Null for anything else.
export function statusTarget(url: string, domain: string): { id: string; username: string } | { uri: string } | null {
  const parsed = httpUrl(url);
  if (parsed === null || parsed.host !== domain.toLowerCase()) {
    return null;
  }
  const object = OBJECT_PATH.exec(parsed.pathname);
  if (object !== null) {
    return { uri: `https://${domain}/ap/o/${object[1] ?? ""}` };
  }
  const page = STATUS_PATH.exec(parsed.pathname);
  if (page === null) {
    return null;
  }
  try {
    const username = localUsername(decodeURIComponent(page[1] ?? ""), domain);
    const id = decodeURIComponent(page[2] ?? "");
    return username === null || username === "" ? null : { id, username };
  } catch {
    return null;
  }
}
