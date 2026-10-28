import type { Db } from "../../db/sql";
import { normalizeDomain } from "../../platform/domain-name";
import { type Account, accountByAddress, ACCOUNT_FROM, presentAccountById } from "../accounts";
import { PIN_LIMIT } from "../activities";
import { availableJoinedSql } from "../audience";
import type { Status } from "../status-presenter";
import { isHashtagName } from "../status-text";
import { type AccountStatusesInput, accountStatusesWithin } from "../timelines";
import {
  admitMandatory,
  admitStrict,
  LONGEST_STATUS_STUB,
  pageBudget,
  statusItemBytes,
  type StatusStub,
  statusList,
  WEB_PAGE_BYTES,
} from "./budget";
import { type PageCursor, type Paging, LONGEST_PAGING, pagingOf } from "./paging";
import { listParents, type ParentLink } from "./parents";
import { anonymous, localUsername, pagePresent, pageRead, type Site } from "./site";

export const PROFILE_PAGE_SIZE = 20;

// The profile's tabs: Posts (/@username), Posts and replies (/with_replies), Media (/media), and a featured
// hashtag's posts (/tagged/:tag).
export type ProfileTab =
  | { kind: "posts" }
  | { kind: "with_replies" }
  | { kind: "media" }
  | { kind: "tagged"; tag: string };

export type ProfileInput = { handle: string; tab: ProfileTab; cursor: PageCursor; now: number };

export type ProfilePage =
  | {
      status: "ok";
      account: Account;
      // The Posts tab's first page: the account's pins, newest pin first, those that fit.
      pins: Status[];
      // The posts newest first; when the first did not fit beside the account and the pins, none, and its stub.
      statuses: Status[];
      stub: StatusStub | null;
      parents: Record<string, ParentLink>;
      paging: Paging;
    }
  | { status: "not_found" }
  | { status: "suspended" }
  // A remote account's featured hashtag URL: its profile on its own server.
  | { status: "redirect"; location: string };

// The filters of each tab over accountStatuses, as an anonymous viewer reads them (R11, VIS-4): Posts leaves out
// replies to others and lists the account's boosts whose boost and original an anonymous viewer may see (VIS-6); Posts
// and replies lists replies and no boosts; Media lists posts with media, replies included; a hashtag's lists its posts
// with the hashtag, replies included.
function tabFilters(
  tab: ProfileTab,
): Pick<AccountStatusesInput, "onlyMedia" | "excludeReplies" | "excludeReblogs" | "tagged"> {
  switch (tab.kind) {
    case "posts":
      return { onlyMedia: false, excludeReplies: true, excludeReblogs: false, tagged: null };
    case "with_replies":
      return { onlyMedia: false, excludeReplies: false, excludeReblogs: true, tagged: null };
    case "media":
      return { onlyMedia: true, excludeReplies: false, excludeReblogs: true, tagged: null };
    case "tagged":
      return { onlyMedia: false, excludeReplies: false, excludeReblogs: true, tagged: tab.tag };
  }
}

// A local account's profile tab as Mastodon's web client shows it to a signed-out visitor, newest first, paged both
// ways by status id. The Posts tab's first page shows the account's pins first, which stay in the list too. A tagged
// tab whose name is not a hashtag is not found. A suspended account is gone (410).
export const webProfilePage = pageRead<ProfileInput, ProfilePage>((db, input, site) =>
  profilePageWithin(db, input, site, WEB_PAGE_BYTES),
);

// The read, within `answerBytes` (tests pass less to reach the stub at a small size).
export function profilePageWithin(db: Db, input: ProfileInput, site: Site, answerBytes: number): ProfilePage {
  const { handle, tab, cursor, now } = input;
  const username = localUsername(handle, site.domain);
  if (username === null) {
    return tab.kind === "tagged" ? remoteTagged(db, handle, site) : { status: "not_found" };
  }
  if (username === "" || (tab.kind === "tagged" && !isHashtagName(tab.tag))) {
    return { status: "not_found" };
  }
  const row = localPageAccount(db, username, site);
  if ("status" in row) {
    return row;
  }
  const { account } = row;
  const options = anonymous(site, now);
  const budget = pageBudget(
    {
      status: "ok",
      account: null,
      pins: [],
      statuses: [],
      stub: LONGEST_STATUS_STUB,
      parents: {},
      paging: LONGEST_PAGING,
      site,
    } satisfies Omit<Extract<ProfilePage, { status: "ok" }>, "account"> & { account: null; site: Site },
    answerBytes,
  );
  admitMandatory(budget, account);
  const base = { account: row.id, present: pagePresent(site), ...tabFilters(tab) };
  // Pins, admitted strictly before the list: at most PIN_LIMIT, a local account's own (status-actions.ts).
  const pins =
    tab.kind === "posts" && cursor === null
      ? (accountStatusesWithin(
          db,
          { ...base, page: { limit: PIN_LIMIT }, excludeReplies: false, excludeReblogs: false, pinned: true },
          options.viewer,
          (entries) => admitStrict(budget, entries, statusItemBytes),
        )?.page.items ?? [])
      : [];
  const list = statusList(budget);
  const read = accountStatusesWithin(
    db,
    { ...base, page: { limit: PROFILE_PAGE_SIZE, ...cursor }, pinned: false },
    options.viewer,
    list.admission,
  );
  const statuses = read?.page.items ?? [];
  return {
    status: "ok",
    account,
    pins,
    statuses,
    stub: list.stub(),
    parents: listParents(db, budget, [...pins, ...statuses]),
    paging: pagingOf(read === null ? null : { newest: read.page.newest, oldest: read.page.oldest, more: read.more }),
  };
}

// The local account of a page's URL (its profile tabs, its follow lists, its Featured tab), by username in any case,
// with its stored id and its presentation on the stored domain: not found, or gone when it is suspended (Mastodon
// answers 410).
export function localPageAccount(
  db: Db,
  username: string,
  site: Site,
): { id: string; account: Account } | { status: "not_found" } | { status: "suspended" } {
  const row = db.first<{ id: string; available: number }>(
    `SELECT a.id, ${availableJoinedSql("a", "l")} AS available FROM ${ACCOUNT_FROM}
		WHERE a.domain IS NULL AND lower(a.username) = lower(?)`,
    username,
  );
  if (row === undefined) {
    return { status: "not_found" };
  }
  if (row.available === 0) {
    return { status: "suspended" };
  }
  const account = presentAccountById(db, row.id, pagePresent(site));
  return account === undefined ? { status: "not_found" } : { id: row.id, account };
}

// /@username@domain/tagged/:tag of a remote account (featured-tags.ts taggedUrl): its profile on its own server, while
// it is available; Kopje shows no remote account's posts by hashtag.
function remoteTagged(db: Db, handle: string, site: Site): ProfilePage {
  const [username = "", domain = "", ...rest] = handle.replace(/^@/, "").split("@");
  if (username === "" || domain === "" || rest.length > 0) {
    return { status: "not_found" };
  }
  const account = accountByAddress(db, username, normalizeDomain(domain) ?? domain.toLowerCase(), pagePresent(site));
  if (account === null || account.suspended === true || account.acct === account.username) {
    return { status: "not_found" };
  }
  return { status: "redirect", location: account.url };
}
