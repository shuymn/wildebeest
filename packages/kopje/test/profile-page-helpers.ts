import { expect } from "vitest";

import { jsonBytes } from "../src/domain/answer-budget";
import { LONGEST_STATUS_STUB } from "../src/domain/web-pages/budget";
import { pageCursor, type Paging } from "../src/domain/web-pages/paging";
import type { Site } from "../src/domain/web-pages/site";
import type { StoreStub } from "../src/platform/store-client";
import { STRINGS } from "../src/web/strings";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { attr, type Element, one, parseHtml, query, text } from "./web-dom";
import { olderOf } from "./web-helpers";

// The page reads of the feed pages (the profile tabs, the hashtag page) in tests: walking their older pages, their
// frames and pins; and walking a paged list's HTML both ways (the feeds, the follow lists).

// What a walk reads of a page: its stub, its statuses and its paging facts.
type ListPage = { stub: { id: string } | null; statuses: readonly { id: string }[]; paging: Paging };

// A feed page read walked by its older cursor from the first page to the last: the ids each page showed or
// stubbed, in order, and what each page held. Every page moves on: its continuation is the last item it consumed.
export async function walkProfile<P extends ListPage>(read: (maxId: string | null) => Promise<P>, requests = 100) {
  const seen: string[] = [];
  const pages: { shown: number; stub: boolean }[] = [];
  let maxId: string | null = null;
  for (let request = 0; ; request++) {
    expect(request).toBeLessThan(requests);
    const page = await read(maxId);
    const ids = [...(page.stub === null ? [] : [page.stub.id]), ...page.statuses.map((status) => status.id)];
    seen.push(...ids);
    pages.push({ shown: page.statuses.length, stub: page.stub !== null });
    maxId = olderOf(page);
    if (maxId === null) {
      break;
    }
    expect(ids.length).toBeGreaterThan(0);
    expect(maxId).toBe(ids.at(-1));
  }
  return { seen, pages };
}

// Pins `ids` for `account` in that order, a second apart up to NOW, so the last is the newest pin.
export async function pinStatuses(store: StoreStub, account: string, ids: readonly string[]): Promise<void> {
  for (const [i, id] of ids.entries()) {
    await sql(
      store,
      "INSERT INTO status_pins (account_id, status_id, created_at) VALUES (?, ?, ?)",
      account,
      id,
      new Date(NOW - 1000 * (ids.length - i)).toISOString(),
    );
  }
}

// The frame a profile answer reserves, stated apart from the read's own: its shape with no pins or posts,
// the longest stub, both paging ends at 19 digits, and the site facts.
export function profileFrameBytes(site: Site): number {
  return jsonBytes({
    status: "ok",
    account: null,
    pins: [],
    statuses: [],
    stub: LONGEST_STATUS_STUB,
    parents: {},
    paging: { newest: "9".repeat(19), oldest: "9".repeat(19), more: true },
    site,
  });
}

// The frame a hashtag answer reserves, stated apart from the read's own: its shape with the name, no posts, the
// longest stub, both paging ends at 19 digits, and the site facts.
export function tagFrameBytes(tag: string, site: Site): number {
  return jsonBytes({
    status: "ok",
    tag,
    statuses: [],
    stub: LONGEST_STATUS_STUB,
    parents: {},
    paging: { newest: "9".repeat(19), oldest: "9".repeat(19), more: true },
    site,
  });
}

// A walk's page reader through the route: each page answers 200.
export function viaRoute(h: { request: (path: string) => Promise<Response> }) {
  return async (url: string) => {
    const response = await h.request(url);
    expect([url, response.status]).toEqual([url, 200]);
    return response.text();
  };
}

// The links a page's pager offers, by their names (their full labels): null for one it does not offer.
export function pagerLinks(main: Element, texts: { newer: string; older: string }) {
  const pager = query(main, "nav", "pager")[0];
  const link = (name: string) =>
    pager === undefined
      ? null
      : (query(pager, "a")
          .filter((a) => attr(a, "aria-label") === name)
          .map((a) => attr(a, "href"))[0] ?? null);
  return { newer: link(texts.newer), older: link(texts.older) };
}

// The link a card names: its date link, or a stub's.
export function cardLink(article: Element): string {
  const link = query(query(article, "p", "meta")[0] ?? article, "a")[0];
  expect(link, "a card links its post").toBeDefined();
  return attr(link!, "href") ?? "";
}

// Every cursor a page names (its pager's and any other link's).
export function cursorsOf(main: Element): string[] {
  return query(main, "a").flatMap((a) => {
    const params = new URL(attr(a, "href") ?? "", "https://kopje.test").searchParams;
    return ["max_id", "min_id"].flatMap((name) => params.getAll(name));
  });
}

// The URL's cursor, as the route reads it.
export function cursorOf(url: string) {
  const params = new URL(url, "https://kopje.test").searchParams;
  return pageCursor(params.get("max_id"), params.get("min_id"));
}

// Whether every cursor of the page at `url` is one of `candidates` or a boundary one step from the page's own cursor
// (src/web/view/pager.ts): never another id.
export function expectCursors(url: string, cursors: readonly string[], candidates: ReadonlySet<string>) {
  const own = cursorOf(url);
  const x = own === null ? null : BigInt("maxId" in own ? own.maxId : own.minId);
  for (const cursor of cursors) {
    const boundary = x !== null && (BigInt(cursor) === x + 1n || BigInt(cursor) === x - 1n);
    expect([url, cursor, candidates.has(cursor) || boundary]).toEqual([url, cursor, true]);
  }
}

// What a page's account list shows (the follow lists, the Featured tab's endorsed accounts): each row's profile link,
// the pager's links by their texts `pager`, and the empty lines.
export function shownAccounts(html: string, pager: { newer: string; older: string }) {
  const main = one(parseHtml(html), "main");
  const list = query(main, "ul", "accounts")[0];
  const items =
    list === undefined
      ? []
      : query(list, "li").map((li) => {
          const link = query(li, "a", "name")[0];
          expect(link, "a row links its account").toBeDefined();
          return attr(link!, "href") ?? "";
        });
  return { items, ...pagerLinks(main, pager), empty: query(main, "p", "muted").map(text) };
}

// What a feed page shows: its pinned posts and its list (each card's link: its date link, or a stub's), the links of
// its reply-to lines, and its pager.
export function shownFeed(html: string) {
  const main = one(parseHtml(html), "main");
  const pins: string[] = [];
  const items: string[] = [];
  for (const article of query(main, "article")) {
    const link = query(query(article, "p", "meta")[0]!, "a")[0];
    expect(link, "a card links its post").toBeDefined();
    const label = query(article, "p", "label")[0];
    (label !== undefined && text(label) === STRINGS.post.pinned ? pins : items).push(attr(link!, "href") ?? "");
  }
  const replyTo = query(main, "p", "reply-to").flatMap((p) => query(p, "a").map((a) => attr(a, "href") ?? ""));
  return { pins, items, replyTo, ...pagerLinks(main, STRINGS.pager) };
}

// What a walk reads of a page's HTML: its items in order and its pager's links.
type ShownPage = { items: string[]; newer: string | null; older: string | null };

// A paged list walked to its oldest end by its older links, and back to its newest end by its newer links:
// the items of each walk newest first, the number each page of the older walk showed, the first page as `shown` read
// it, and every page's HTML. `shown` reads a page's items and pager; `check` asserts what each page must hold.
export async function walkPages<P extends ShownPage>(
  get: (url: string) => Promise<string>,
  base: string,
  shown: (html: string) => P,
  check: (url: string, page: P) => void = () => {},
) {
  const pages: string[] = [];
  const visited = new Set<string>();
  const open = async (url: string) => {
    expect(visited.has(url), `${url} is visited once a walk`).toBe(false);
    visited.add(url);
    expect(visited.size).toBeLessThan(200);
    const html = await get(url);
    pages.push(html);
    const page = shown(html);
    check(url, page);
    return page;
  };
  const down: string[] = [];
  const sizes: number[] = [];
  let url = base;
  let page = await open(base);
  const first = page;
  for (;;) {
    down.push(...page.items);
    sizes.push(page.items.length);
    if (page.older === null) {
      break;
    }
    url = page.older;
    page = await open(url);
  }
  visited.clear();
  visited.add(url);
  const upPages: string[][] = [page.items];
  while (page.newer !== null) {
    page = await open(page.newer);
    upPages.push(page.items);
  }
  return { down, up: upPages.toReversed().flat(), sizes, first, pages };
}

// A walk (walkPages) of a list of exactly `pages` full pages of `size`, nothing left out: each side a pager offers
// leads to a full page, so the walk opens every page going down and all but the last again going up, never an empty
// one past either end.
export function expectFullPages(
  walked: { sizes: number[]; pages: string[]; down: string[]; up: string[] },
  size: number,
  pages: number,
) {
  expect(walked.sizes).toEqual(Array.from({ length: pages }, () => size));
  expect(walked.pages).toHaveLength(2 * pages - 1);
  expect(new Set(walked.down).size).toBe(size * pages);
  expect(walked.up).toEqual(walked.down);
}

// A feed page walked both ways (walkPages), with the first page's pins: pins lead only the first page.
export async function walkFeed(get: (url: string) => Promise<string>, base: string) {
  const walked = await walkPages(get, base, shownFeed, (url, page) => {
    expect(url === base || page.pins.length === 0, `${url} shows no pins`).toBe(true);
  });
  return { ...walked, pins: walked.first.pins };
}
