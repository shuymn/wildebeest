import type { Db } from "../../db/sql";
import { type Account } from "../accounts";
import { accountEndorsementsWithin } from "../endorsements";
import { accountFeaturedTagsOf, type FeaturedTag, MAX_FEATURED_TAGS } from "../featured-tags";
import { admitMandatory, admitStrict, pageBudget, WEB_PAGE_BYTES } from "./budget";
import { type PageCursor, type Paging, LONGEST_PAGING, pagingOf } from "./paging";
import { localPageAccount } from "./profile";
import { localUsername, pagePresent, pageRead, type Site } from "./site";
import { tagPageName } from "./tags";

// The endorsed accounts a page lists at a time: the API's default page, as for the follow lists.
export const ENDORSEMENTS_PAGE_SIZE = 40;

export type FeaturedInput = { handle: string; cursor: PageCursor };

// A featured hashtag as the API presents it, and the normalized name of the hashtag page that serves it (tagPageName),
// or null when none does (an imported name that is not a hashtag).
export type FeaturedTagLink = { featured: FeaturedTag; tag: string | null };

export type FeaturedPage =
  | {
      status: "ok";
      account: Account;
      // The account's featured hashtags, at most MAX_FEATURED_TAGS, as GET /api/v1/accounts/:id/featured_tags lists
      // them.
      tags: FeaturedTagLink[];
      // The accounts it endorses that R28 lists, by account id, newest first.
      accounts: Account[];
      paging: Paging;
    }
  | { status: "not_found" }
  | { status: "suspended" };

// /@username/featured of a local account, as an anonymous viewer reads it (VIS-4): its featured hashtags as
// accountFeaturedTags shows them, the first MAX_FEATURED_TAGS, on every page; and the accounts it endorses as
// accountEndorsements lists them (R28: available ones only; the same to every viewer), paged both ways by the API's
// cursor, the account id. A suspended account is gone (410), and another server's account is not found.
export const webFeaturedPage = pageRead<FeaturedInput, FeaturedPage>((db, input, site) =>
  featuredPageWithin(db, input, site, WEB_PAGE_BYTES),
);

// The read, within `answerBytes` (WEB_PAGE_BYTES; tests pass less to cut pages by bytes). The account
// and its hashtags are the head; the endorsed accounts are admitted strictly. The frame, the account, MAX_FEATURED_TAGS
// hashtags and one account, each at its maximum, fit WEB_PAGE_BYTES (test/web-featured-page.test.ts), so every page
// admits its first account, and a page cut by bytes continues from its last.
export function featuredPageWithin(db: Db, input: FeaturedInput, site: Site, answerBytes: number): FeaturedPage {
  const { handle, cursor } = input;
  const username = localUsername(handle, site.domain);
  if (username === null || username === "") {
    return { status: "not_found" };
  }
  const row = localPageAccount(db, username, site);
  if ("status" in row) {
    return row;
  }
  const { account } = row;
  const present = pagePresent(site);
  const budget = pageBudget(
    {
      status: "ok",
      account: null,
      tags: [],
      accounts: [],
      paging: LONGEST_PAGING,
      site,
    } satisfies Omit<Extract<FeaturedPage, { status: "ok" }>, "account"> & { account: null; site: Site },
    answerBytes,
  );
  admitMandatory(budget, account);
  const tags = accountFeaturedTagsOf(db, row.id, present.origin, MAX_FEATURED_TAGS).map((featured) => ({
    featured,
    tag: tagPageName(featured.name),
  }));
  admitMandatory(budget, tags);
  const list = accountEndorsementsWithin(
    db,
    row.id,
    { page: { limit: ENDORSEMENTS_PAGE_SIZE, ...cursor }, present },
    (entries) => admitStrict(budget, entries),
  );
  return {
    status: "ok",
    account,
    tags,
    accounts: list.page.items,
    paging: pagingOf({ newest: list.page.newest, oldest: list.page.oldest, more: list.more }),
  };
}
