import { expect } from "vitest";

import { ANSWER_BYTES } from "../src/domain/answer-budget";
import { utf8Length } from "../src/platform/dump-format";
import { type ApiHarness, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { accountAtCap, statusAtCap } from "./emoji-fixtures";
import { MAX_BIO, maxFields } from "./profile-fixtures";
import { remoteAccount, type SeedStatus, seedStatus } from "./status-helpers";

// Fixtures and walks of the answer budget tests (RES-3).

export const ORIGIN = "https://kopje.test";
// A control character, which JSON escapes to six bytes.
export const C = "\u0001";
export const DAY = 86_400_000;

let sequence = 700_000_000_000_000_000n;
export const nextId = () => String(sequence++);

// A public remote status of about 0.98 MB of JSON: content of 20,000 escaping characters (and "needle", which search
// finds), a poll of 100 choices of 1,000, 4 attachments with descriptions of 10,000 and emojis at their presented
// bound, each at its bound (RES-2). Nine such pass ANSWER_BYTES, so a page of them is cut. `share` divides the
// content, the choices and the descriptions (pageStatus).
export async function bigStatus(
  h: ApiHarness,
  author: string,
  published: number,
  extra: Partial<Pick<SeedStatus, "tags" | "inReplyToId" | "visibility" | "mentions">> = {},
  share = 1,
): Promise<string> {
  const id = await seedStatus(h.store, {
    accountId: author,
    visibility: "public",
    content: `<p>needle ${C.repeat(20_000 / share)}</p>`,
    published,
    ...extra,
  });
  await sql(h.store, "UPDATE statuses SET emojis = ? WHERE id = ?", JSON.stringify(statusAtCap()), id);
  await sql(
    h.store,
    `INSERT INTO polls (status_id, options, tallies, votes_count, voters_count, expires_at)
		VALUES (?, ?, ?, 0, 0, ?)`,
    id,
    JSON.stringify(Array.from({ length: 100 }, () => C.repeat(1000 / share))),
    JSON.stringify(Array.from({ length: 100 }, () => 0)),
    new Date(NOW + DAY).toISOString(),
  );
  for (let position = 0; position < 4; position++) {
    await sql(
      h.store,
      `INSERT INTO media_attachments (id, account_id, status_id, position, type, url, description)
			VALUES (?, ?, ?, ?, 'image', 'https://remote.example/m.png', ?)`,
      nextId(),
      author,
      id,
      position,
      C.repeat(10_000 / share),
    );
  }
  return id;
}

// A status of about 0.13 MB of JSON, an eighth of bigStatus's parts with its emojis at their bound: nine pass a public
// page's WEB_PAGE_BYTES, so a page of them is cut.
export function pageStatus(
  h: ApiHarness,
  author: string,
  published: number,
  extra: Partial<Pick<SeedStatus, "tags" | "inReplyToId" | "visibility" | "mentions">> = {},
): Promise<string> {
  return bigStatus(h, author, published, extra, 8);
}

// An accepted quote of `target` by `status`.
export async function acceptQuote(h: Pick<ApiHarness, "store">, status: string, target: string) {
  return sql(
    h.store,
    `INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, updated_at)
		SELECT ?1, uri, id, account_id, 'accepted', ?3 FROM statuses WHERE id = ?2`,
    status,
    target,
    new Date(NOW).toISOString(),
  );
}

export type Answer<T> = {
  status: number;
  bytes: number;
  body: T;
  next: string | null;
  prev: string | null;
  link: string | null;
};

// The answer of a GET as the client receives it: its body's bytes and its Link header's next and prev paths.
export async function answer<T = { id: string }[]>(h: ApiHarness, path: string, token?: string): Promise<Answer<T>> {
  const response = await h.request(path, token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } });
  const text = await response.text();
  const link = (rel: string) => {
    const url = new RegExp(`<([^>]+)>; rel="${rel}"`).exec(response.headers.get("link") ?? "")?.[1];
    return url === undefined ? null : `${new URL(url).pathname}${new URL(url).search}`;
  };
  return {
    status: response.status,
    bytes: utf8Length(text),
    body: JSON.parse(text) as T,
    next: link("next"),
    prev: link("prev"),
    link: response.headers.get("link"),
  };
}

export type Walked = { ids: string[]; pages: { shown: string[]; bytes: number; cursor: string | null }[] };

// Walks a list by its Link header from `path`: `next` (older, newest first) or `prev` (newer, each page shown newest
// first, collected oldest first), following each link as the server returns it. Each page keeps the cursor its link
// carries.
export async function walk(h: ApiHarness, path: string, rel: "next" | "prev", token?: string): Promise<Walked> {
  return walkPages<{ id: string }[]>(h, path, rel, token, (body) => body.map((item) => item.id), 40);
}

// The walk of `walk` over answers of any shape: `shown` gives a page's item ids, in the order the page shows them;
// `each` sees each page's body; at most `pages` pages.
export async function walkPages<T>(
  h: ApiHarness,
  path: string,
  rel: "next" | "prev",
  token: string | undefined,
  shownOf: (body: T) => string[],
  pages: number,
  each: (body: T) => void = () => {},
): Promise<Walked> {
  const walked: Walked = { ids: [], pages: [] };
  for (let at: string | null = path; at !== null;) {
    const page: Answer<T> = await answer<T>(h, at, token);
    expect(page.status).toBe(200);
    expect(page.bytes).toBeLessThanOrEqual(ANSWER_BYTES);
    const shown = shownOf(page.body);
    if (shown.length === 0) {
      break;
    }
    const link: string | null = page[rel];
    const cursor =
      link === null ? null : new URLSearchParams(link.split("?")[1]).get(rel === "next" ? "max_id" : "min_id");
    walked.pages.push({ shown, bytes: page.bytes, cursor });
    each(page.body);
    walked.ids.push(...(rel === "next" ? shown : shown.toReversed()));
    at = link;
    expect(walked.pages.length).toBeLessThan(pages);
  }
  return walked;
}

// The first page of a bounded request (since_id, or both bounds) cut by the answer budget: a prefix of the uncut
// answer (`expected`, in traversal order), one more item of `size` past ANSWER_BYTES, and its link in Mastodon's
// form: the cursor of its last item in traversal order alone (max_id for next, min_id for prev), the request's other
// bound dropped as Mastodon's pagination_params drops it.
export async function expectByteCutFirstPage(
  h: ApiHarness,
  name: string,
  path: string,
  rel: "next" | "prev",
  token: string,
  expected: readonly string[],
  size: number,
  cursorOf: (id: string) => string = (id) => id,
): Promise<void> {
  const page: Answer<{ id: string }[]> = await answer(h, path, token);
  expect(page.bytes).toBeLessThanOrEqual(ANSWER_BYTES);
  const shown = page.body.map((item) => item.id);
  const traversal = rel === "next" ? shown : shown.toReversed();
  expect([name, traversal]).toEqual([name, expected.slice(0, traversal.length)]);
  expect([name, traversal.length < expected.length, page.bytes + size + 1 > ANSWER_BYTES]).toEqual([name, true, true]);
  const link = page[rel];
  const params = [...new URLSearchParams(link?.split("?")[1] ?? "").keys()].filter((key) => key.endsWith("_id"));
  expect([name, params]).toEqual([name, [rel === "next" ? "max_id" : "min_id"]]);
  const cursor = new URLSearchParams(link!.split("?")[1]).get(params[0]!);
  expect([name, cursor]).toEqual([name, cursorOf(traversal.at(-1)!)]);
}

// A walk cut by the answer budget: every status once, in order, at least one page cut by bytes (one more status of
// `size` would pass ANSWER_BYTES), and each such page continuing from its last status in traversal order (`cursorOf`
// gives its cursor: the status id, or a bookmark's or favourite's id).
export function expectByteCutWalk(
  name: string,
  walked: Walked,
  expected: readonly string[],
  rel: "next" | "prev",
  size: number,
  cursorOf: (id: string) => string = (id) => id,
): void {
  expect([name, walked.ids]).toEqual([name, expected]);
  const cut = walked.pages.filter((page) => page.bytes + size + 1 > ANSWER_BYTES);
  expect([name, cut.length]).not.toEqual([name, 0]);
  for (const page of cut) {
    const last = rel === "next" ? page.shown.at(-1)! : page.shown[0]!;
    expect([name, page.cursor]).toEqual([name, cursorOf(last)]);
  }
}

// `count` remote accounts named `prefix` and a number, in id order, each at its bounds (RES-2): a bio of 64 KiB,
// a display name of 2,048 escaping characters and 16 fields at theirs, about 121 KB of JSON each.
export async function maximalAccounts(h: ApiHarness, prefix: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = await remoteAccount(h.store, `${prefix}${String(i).padStart(3, "0")}`);
    await sql(
      h.store,
      "UPDATE accounts SET note = ?, display_name = ?, raw = ?, emojis = ? WHERE id = ?",
      MAX_BIO,
      C.repeat(2048),
      JSON.stringify({ type: "Person", attachment: maxFields() }),
      JSON.stringify(accountAtCap()),
      id,
    );
    ids.push(id);
  }
  return ids.toSorted();
}

let mentioned = 650_000_000_000_000_000n;

// A public status of about 2.4 MB of JSON, past a report's status allowance (REPORT_STATUS_BYTES): a big status that
// quotes another and mentions 200 accounts whose url is near its bound.
export async function hugeStatus(h: ApiHarness, author: string, published: number): Promise<string> {
  const quoted = await bigStatus(h, author, published - 1000);
  const id = await bigStatus(h, author, published);
  await acceptQuote(h, id, quoted);
  const base = mentioned;
  mentioned += 1000n;
  await sql(
    h.store,
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200)
		INSERT INTO accounts (id, uri, username, domain, url)
		SELECT printf('%018d', CAST(?1 AS INTEGER) + i), 'https://mentioned.example/users/' || ?1 || '-' || i,
			'm' || i, 'mentioned.example', ?2 || i FROM n`,
    String(base),
    `https://mentioned.example/@${"u".repeat(2000)}`,
  );
  await sql(
    h.store,
    `INSERT INTO status_mentions (status_id, account_id, silent, requires_mention, author_id)
		SELECT ?1, id, 0, 0, ?2 FROM accounts WHERE id > printf('%018d', CAST(?3 AS INTEGER))
			AND id <= printf('%018d', CAST(?3 AS INTEGER) + 200)`,
    id,
    author,
    String(base),
  );
  return id;
}
