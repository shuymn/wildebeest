import { runInDurableObject } from "cloudflare:test";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { accountsOf, ANSWER_CHUNK } from "../src/domain/accounts";
import { admit, admittedPage, ANSWER_BYTES, jsonBytes } from "../src/domain/answer-budget";
import { type VisibleStatusId } from "../src/domain/audience";
import { filterTextLimits, MAX_FILTER_REQUEST_TEXT } from "../src/domain/filters";
import { CACHED_IMAGE_BYTES, CACHED_IMAGE_KINDS } from "../src/domain/remote-media";
import {
  type PresentOptions,
  presentation,
  presentStatus,
  presentStatusesWithin,
} from "../src/domain/status-presenter";
import { WEB_PAGE_BYTES } from "../src/domain/web-pages/budget";
import { utf8Length } from "../src/platform/dump-format";
import { sha256Hex } from "../src/security/tokens";
import { type ApiHarness, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import {
  acceptQuote,
  answer,
  bigStatus,
  C,
  DAY,
  expectByteCutFirstPage,
  expectByteCutWalk,
  maximalAccounts,
  nextId,
  ORIGIN,
  pageStatus,
  walk,
  type Walked,
} from "./budget-helpers";
import { BUILD } from "./helpers";
import { observedSql } from "./read-helpers";
import { act, community, domainBlock, mute, post, remoteAccount, seedStatus } from "./status-helpers";
import { olderOf, postsTab } from "./web-helpers";

// RES-3: one answer that presents statuses is within ANSWER_BYTES as serialized, containers included, owned by the
// Store operation that returns it (docs/response-inventory.md). Items are admitted whole in traversal order, the
// first whatever its size; a cut page continues from its last admitted item in both directions; a context keeps the
// nearest ancestors and history the newest revisions; search, an offset endpoint, returns fewer results.

type World = Awaited<ReturnType<typeof world>>;

const run = (kind: "V" | "M", n: number) => Array.from({ length: n }, () => kind);

// Alice, a remote author of twenty big statuses (V[0] newest), tagged #big and #needle, which alice follows, lists,
// bookmarks and favourites; and a muted author whose 135 small public statuses lie between them, newest first:
// V[0..9], 115 muted, V[10..19], 20 muted. A public page of 40 reads a window of 120 candidates, so its first window,
// from either end, ends in muted statuses and is cut after ten big statuses, which the answer budget cuts first.
async function world() {
  const h = await community(["alice", "bob"]);
  const { alice } = h.users;
  const author = await remoteAccount(h.store, "big");
  const muted = await remoteAccount(h.store, "muted");
  await mute(h.store, alice.id, muted);
  const kinds = [...run("V", 10), ...run("M", 115), ...run("V", 10), ...run("M", 20)].toReversed();
  const big: string[] = [];
  const small: string[] = [];
  for (const [i, kind] of kinds.entries()) {
    const published = NOW - (kinds.length - i) * 60_000;
    if (kind === "V") {
      big.push(await bigStatus(h, author, published, { tags: ["big", "needle"] }));
    } else {
      small.push(await seedStatus(h.store, { accountId: muted, visibility: "public", published }));
    }
  }
  const V = big.toReversed();
  await sql(
    h.store,
    "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
    alice.id,
    author,
  );
  const list = nextId();
  await sql(h.store, "INSERT INTO lists (id, account_id, title) VALUES (?, ?, 'big')", list, alice.id);
  await sql(h.store, "INSERT INTO list_accounts (list_id, account_id) VALUES (?, ?)", list, author);
  for (const id of big) {
    await sql(h.store, "INSERT INTO bookmarks (account_id, status_id) VALUES (?, ?)", alice.id, id);
    await sql(h.store, "INSERT INTO favourites (account_id, status_id) VALUES (?, ?)", alice.id, id);
  }
  // Each status's bookmark and favourite id, the cursors of those lists.
  const edges = async (table: string) =>
    new Map(
      (
        await sql<{ id: string; status_id: string }>(h.store, `SELECT CAST(id AS TEXT) AS id, status_id FROM ${table}`)
      ).map((row) => [row.status_id, row.id]),
    );
  const size = Math.min(...(await Promise.all(V.map((id) => bytesOf(h, alice.token, id)))));
  return {
    h,
    alice,
    author,
    muted,
    V,
    small: small.toReversed(),
    list,
    bookmarks: await edges("bookmarks"),
    favourites: await edges("favourites"),
    size,
  };
}

// The JSON of one status as the viewer is shown it alone.
async function bytesOf(h: ApiHarness, token: string, id: string): Promise<number> {
  return (await answer<unknown>(h, `/api/v1/statuses/${id}`, token)).bytes;
}

async function statusBytes(w: World, id: string): Promise<number> {
  return bytesOf(w.h, w.alice.token, id);
}

// The statuses of `ids` presented as one whole, their rows read in one chunk, as a page was before admission.
function presentedWhole(db: Db, ids: readonly VisibleStatusId[], options: PresentOptions) {
  return presentStatusesWithin(db, presentation(db, ids, options), ids, Infinity, true, Math.max(ids.length, 1)).items;
}

describe("admission (RES-3)", () => {
  it("admits whole items while they fit, the first whatever its size", () => {
    const items = ["a".repeat(8), "b".repeat(8), "c".repeat(8)];
    const size = jsonBytes(items[0]) + 1;
    // Exactly the budget: all; one byte less: the last is the first rejected.
    expect(admit(items, 3 * size, true)).toEqual({ items, bytes: 3 * size, consumed: 3, cut: false });
    expect(admit(items, 3 * size - 1, true)).toEqual({
      items: items.slice(0, 2),
      bytes: 2 * size,
      consumed: 2,
      cut: true,
    });
    // An item past the whole budget is admitted first, and only first.
    expect(admit(items, 1, true)).toEqual({ items: items.slice(0, 1), bytes: size, consumed: 1, cut: true });
    expect(admit(items, 1, false)).toEqual({ items: [], bytes: 0, consumed: 0, cut: true });
    // Nothing to show is consumed, never admitted.
    expect(admit([undefined, "x", undefined], 4, true)).toEqual({ items: ["x"], bytes: 4, consumed: 3, cut: false });
  });

  it("counts JSON bytes as JSON.stringify writes them, without building the string", () => {
    const stringified = (value: unknown) => utf8Length(JSON.stringify(value));
    fc.assert(
      fc.property(fc.jsonValue({ stringUnit: "binary", maxDepth: 4 }), (value) => {
        expect(jsonBytes(value)).toBe(stringified(value));
      }),
      { numRuns: 2_000 },
    );
    const edges = [
      { a: undefined, b: [undefined, () => 1, null], c: new Date(0), d: -0, e: Number.NaN, f: Infinity },
      '\ud800x\udc00\u0000\u001f"\\\b\f\n\r\t\u007f\u0080\u07ff\u0800\uffff\ud83d\ude00',
      [],
      {},
    ];
    for (const value of edges) {
      expect(jsonBytes(value)).toBe(stringified(value));
    }
  });

  it("continues a cut page from its last admitted row, dropping a window continuation", () => {
    const rows = ["5", "4", "3", "2", "1"];
    const page = { rows, newest: "6", oldest: "0", cut: true };
    const two = (traversal: readonly string[]) => ({ items: traversal.slice(0, 2), bytes: 0, consumed: 2, cut: true });
    expect(admittedPage(page, false, (r) => r, two)).toEqual({
      items: ["5", "4"],
      newest: "6",
      oldest: "4",
      cut: true,
    });
    // min_id walks oldest first and shows newest first.
    expect(admittedPage(page, true, (r) => r, two)).toEqual({ items: ["2", "1"], newest: "2", oldest: "0", cut: true });
    const all = (traversal: readonly string[]) => ({ items: [...traversal], bytes: 0, consumed: 5, cut: false });
    expect(admittedPage(page, true, (r) => r, all)).toEqual({ items: rows, newest: "6", oldest: "0", cut: true });
  });
});

describe("status pages are answers within ANSWER_BYTES (RES-3)", () => {
  it("walk every status once in both directions, each cut by bytes, before a window continuation too", async () => {
    const w = await world();
    const { h, alice, V, size } = w;
    const lists = [
      ["public", "/api/v1/timelines/public?limit=40"],
      ["home", "/api/v1/timelines/home?limit=40"],
      ["list", `/api/v1/timelines/list/${w.list}?limit=40`],
      ["tag", "/api/v1/timelines/tag/big?limit=40"],
      ["account statuses", `/api/v1/accounts/${w.author}/statuses?limit=40`],
    ] as const;
    const inner = V.slice(1, 19);
    const firstPages: Partial<Record<"next" | "prev", Walked["pages"][number] | undefined>> = {};
    for (const [name, path] of lists) {
      const older = await walk(h, path, "next", alice.token);
      expectByteCutWalk(name, older, V, "next", size);
      const newer = await walk(h, `${path}&min_id=1`, "prev", alice.token);
      expectByteCutWalk(name, newer, V.toReversed(), "prev", size);
      if (name === "public") {
        firstPages.next = older.pages[0];
        firstPages.prev = newer.pages[0];
      }
      // since_id reads newest first above its bound; with max_id, between both, either way: a cut first page is a
      // prefix of the uncut answer, its link in Mastodon's form.
      const token = alice.token;
      await expectByteCutFirstPage(h, name, `${path}&since_id=${w.small.at(-1)!}`, "next", token, V, size);
      const down = `${path}&max_id=${V[0]!}&since_id=${V[19]!}`;
      await expectByteCutFirstPage(h, `${name} between`, down, "next", token, inner, size);
      const up = `${path}&min_id=${V[19]!}&max_id=${V[0]!}`;
      await expectByteCutFirstPage(h, `${name} between`, up, "prev", token, inner.toReversed(), size);
    }
    // The public timeline's first pages from either end: ten big statuses passed in a window cut at muted statuses,
    // cut by bytes before them, so the link continues from the last one shown, not from the window's end.
    for (const rel of ["next", "prev"] as const) {
      const first = firstPages[rel];
      expect(first!.shown.length).toBeLessThan(10);
      expect(first!.cursor).toBe(rel === "next" ? first!.shown.at(-1) : first!.shown[0]);
      // The first rejected status is the one that does not fit.
      expect(first!.bytes + size + 1).toBeGreaterThan(ANSWER_BYTES);
    }
    for (const [name, path, edges] of [
      ["bookmarks", "/api/v1/bookmarks?limit=40", w.bookmarks],
      ["favourites", "/api/v1/favourites?limit=40", w.favourites],
    ] as const) {
      const cursorOf = (id: string) => edges.get(id)!;
      expectByteCutWalk(name, await walk(h, path, "next", alice.token), V, "next", size, cursorOf);
      const ascending = await walk(h, `${path}&min_id=0`, "prev", alice.token);
      expectByteCutWalk(name, ascending, V.toReversed(), "prev", size, cursorOf);
      const token = alice.token;
      const since = `&since_id=${cursorOf(V[19]!)}`;
      await expectByteCutFirstPage(h, name, `${path}${since}`, "next", token, V.slice(0, 19), size, cursorOf);
      const down = `${path}&max_id=${cursorOf(V[0]!)}${since}`;
      await expectByteCutFirstPage(h, `${name} between`, down, "next", token, inner, size, cursorOf);
      const up = `${path}&min_id=${cursorOf(V[19]!)}&max_id=${cursorOf(V[0]!)}`;
      await expectByteCutFirstPage(h, `${name} between`, up, "prev", token, inner.toReversed(), size, cursorOf);
    }
  }, 600_000);

  it("answer pinned statuses without paging links, and walk quotes once each", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    // Ten of bob's big statuses, pinned in an order unlike their ids': newest pin first is P. X, unpinned, lies
    // between the newest two by id.
    const posts: string[] = [];
    let X = "";
    for (let i = 0; i < 10; i++) {
      if (i === 9) {
        X = await seedStatus(h.store, { accountId: bob.id, visibility: "public", published: NOW - 690_000 });
      }
      posts.push(await bigStatus(h, bob.id, NOW - (20 - i) * 60_000));
    }
    expect(X > posts[8]! && X < posts[9]!).toBe(true);
    const P = [3, 7, 0, 9, 1, 8, 2, 6, 4, 5].map((i) => posts[i]!);
    for (const [i, id] of P.toReversed().entries()) {
      await sql(
        h.store,
        "INSERT INTO status_pins (account_id, status_id, created_at) VALUES (?, ?, ?)",
        bob.id,
        id,
        new Date(NOW - DAY + i * 60_000).toISOString(),
      );
    }
    const size = Math.min(...(await Promise.all(posts.map((id) => bytesOf(h, alice.token, id)))));
    // Pinned answers carry no paging links (RES-3), cut or not: alice's two small pins, a small limit, a byte cut,
    // and status-id bounds with a byte cut.
    for (const text of ["one", "two"]) {
      const { id } = await post(h, alice, { status: text });
      await act(h, alice, `/api/v1/statuses/${id}/pin`);
    }
    const own = await answer(h, `/api/v1/accounts/${alice.id}/statuses?pinned=true`, alice.token);
    expect(own.body).toHaveLength(2);
    expect(own.link).toBeNull();
    const pinned = `/api/v1/accounts/${bob.id}/statuses?pinned=true&limit=40`;
    const two = await answer(h, `/api/v1/accounts/${bob.id}/statuses?pinned=true&limit=2`, alice.token);
    expect(two.body.map((s) => s.id)).toEqual(P.slice(0, 2));
    expect(two.link).toBeNull();
    const first = await answer(h, pinned, alice.token);
    const shown = first.body.map((s) => s.id);
    expect(shown.length).toBeLessThan(P.length);
    expect(shown).toEqual(P.slice(0, shown.length));
    expect(first.bytes + size + 1).toBeGreaterThan(ANSWER_BYTES);
    expect(first.link).toBeNull();
    // A max_id that is no pin keeps its status-id ceiling, cut or not.
    const below = await answer(h, `${pinned}&max_id=${X}`, alice.token);
    const under = P.filter((id) => id < X);
    expect(below.body.map((s) => s.id)).toEqual(under.slice(0, below.body.length));
    expect(below.body.length).toBeLessThan(under.length);
    expect(below.link).toBeNull();
    // min_id pages pins by status id, oldest first, within max_id too.
    const oldest = await answer(h, `${pinned}&min_id=1&max_id=${X}`, alice.token);
    const ascending = oldest.body.map((s) => s.id).toReversed();
    expect(ascending).toEqual(posts.slice(0, ascending.length));
    expect(ascending.length).toBeLessThan(9);
    expect(oldest.link).toBeNull();
    // Ten big statuses quoting a small one.
    const author = await remoteAccount(h.store, "quoter");
    const quoted = await seedStatus(h.store, { accountId: author, visibility: "public", published: NOW - 2 * DAY });
    const quoting: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = await bigStatus(h, author, NOW - DAY + i * 60_000);
      await acceptQuote(h, id, quoted);
      quoting.push(id);
    }
    const quoteSize = Math.min(...(await Promise.all(quoting.map((id) => bytesOf(h, alice.token, id)))));
    const quotes = `/api/v1/statuses/${quoted}/quotes?limit=40`;
    const newest = quoting.toReversed();
    expectByteCutWalk("quotes", await walk(h, quotes, "next", alice.token), newest, "next", quoteSize);
    expectByteCutWalk("quotes", await walk(h, `${quotes}&min_id=1`, "prev", alice.token), quoting, "prev", quoteSize);
  }, 300_000);

  it("reads at most one chunk of statuses past the cut out of SQLite", async () => {
    const w = await world();
    const one = await sqliteBytes(w, (db, viewer) => {
      const shared = presentation(db, [w.V[0] as VisibleStatusId], { origin: ORIGIN, viewer });
      return presentStatusesWithin(db, shared, [w.V[0] as VisibleStatusId], ANSWER_BYTES, true).items.length;
    });
    const page = await sqliteBytes(w, (db, viewer) => {
      const ids = w.V as VisibleStatusId[];
      const shared = presentation(db, ids, { origin: ORIGIN, viewer });
      return presentStatusesWithin(db, shared, ids, ANSWER_BYTES - 1, true).items.length;
    });
    expect(one.result).toBe(1);
    expect(page.result).toBeLessThan(w.V.length);
    // Rows are read in chunks planned by R (PAGE_CHUNKS), at most two of these statuses each: the chunks up to the
    // first rejected status, no more.
    const chunks = Math.ceil((page.result + 1) / 2);
    expect(page.largest).toBeLessThanOrEqual(2 * one.largest * 1.01);
    expect(page.bytes).toBeLessThanOrEqual(chunks * 2 * one.bytes * 1.01);
  });
});

describe("admission at a chunk boundary (RES-3)", () => {
  it("rejects the first status of a chunk of boosts of quotes after smaller statuses nearly fill the answer", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const author = await remoteAccount(h.store, "small");
    const quoter = await remoteAccount(h.store, "quoter");
    // Eight statuses of about 0.97 MB (four chunks of 2), then a chunk of two boosts of a quote of one, about 1.94 MB.
    const small: string[] = [];
    for (let i = 0; i < 8; i++) {
      small.push(await bigStatus(h, author, NOW - DAY + i * 60_000));
    }
    const quoted = await bigStatus(h, author, NOW - 2 * DAY);
    const quote = await bigStatus(h, quoter, NOW - 2 * DAY + 60_000);
    await acceptQuote(h, quote, quoted);
    const boosts: string[] = [];
    for (const name of ["b1", "b2"]) {
      const booster = await remoteAccount(h.store, name);
      boosts.push(await seedStatus(h.store, { accountId: booster, visibility: "public", reblogOfId: quote }));
    }
    const ids = [...small, ...boosts] as VisibleStatusId[];
    const result = await runInDurableObject(h.store, (_instance, state) => {
      const db = new Db(state.storage.sql);
      const options = { origin: ORIGIN, viewer: { accountId: alice.id, now: new Date(NOW).toISOString() } };
      const admitted = presentStatusesWithin(db, presentation(db, ids, options), ids, ANSWER_BYTES - 1, true);
      const boost = presentStatus(db, boosts[0] as VisibleStatusId, options);
      return { admitted, boost: jsonBytes(boost) };
    });
    expect(result.admitted.items.map((s) => s.id)).toEqual(small);
    expect(result.admitted).toMatchObject({ consumed: 8, cut: true });
    expect(result.admitted.bytes).toBe(result.admitted.items.reduce((sum, s) => sum + jsonBytes(s) + 1, 0));
    // The answer's JSON stays within the budget, and the boost would pass it.
    expect(jsonBytes(result.admitted.items)).toBeLessThanOrEqual(ANSWER_BYTES);
    expect(result.boost).toBeGreaterThan(1_800_000);
    expect(1 + result.admitted.bytes + result.boost).toBeGreaterThan(ANSWER_BYTES);
  }, 300_000);
});

// What a read takes out of SQLite as alice: all its bytes and the most one query returns.
async function sqliteBytes(
  w: World,
  read: (db: Db, viewer: { accountId: string; now: string }) => number,
): Promise<{ result: number; bytes: number; largest: number }> {
  return runInDurableObject(w.h.store, (_instance, state) => {
    let bytes = 0;
    let largest = 0;
    const counting = observedSql(state.storage.sql, (rows) => {
      let query = 0;
      for (const row of rows) {
        for (const value of Object.values(row)) {
          query += typeof value === "string" ? utf8Length(value) : 8;
        }
      }
      bytes += query;
      largest = Math.max(largest, query);
    });
    const result = read(new Db(counting), { accountId: w.alice.id, now: new Date(NOW).toISOString() });
    return { result, bytes, largest };
  });
}

describe("composite answers within ANSWER_BYTES (RES-3)", () => {
  it("keeps the nearest ancestors on half the budget, and the descendants on the rest", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const author = await remoteAccount(h.store, "thread");
    const chain: string[] = [];
    for (let i = 0; i < 14; i++) {
      chain.push(await bigStatus(h, author, NOW - (20 - i) * 60_000, i === 0 ? {} : { inReplyToId: chain[i - 1]! }));
    }
    const size = (await answer<unknown>(h, `/api/v1/statuses/${chain[1]!}`, alice.token)).bytes + 1;
    const frame = jsonBytes({ ancestors: [], descendants: [] });
    type Context = { ancestors: { id: string }[]; descendants: { id: string }[] };
    const context = async (at: number) => {
      const read = await answer<Context>(h, `/api/v1/statuses/${chain[at]!}/context`, alice.token);
      expect(read.bytes).toBeLessThanOrEqual(ANSWER_BYTES);
      return { ancestors: read.body.ancestors.map((s) => s.id), descendants: read.body.descendants.map((s) => s.id) };
    };
    // Every status here is the same size: half the budget takes `half`, and the descendants the rest.
    const half = Math.floor(Math.floor((ANSWER_BYTES - frame) / 2) / size);
    const rest = (taken: number) => Math.floor((ANSWER_BYTES - frame - taken * size) / size);
    const middle = await context(7);
    expect(middle.ancestors).toEqual(chain.slice(7 - half, 7));
    expect(middle.descendants).toEqual(chain.slice(8, 8 + rest(half)));
    // Few ancestors leave the rest to the descendants; no descendants leave the ancestors their half.
    const early = await context(1);
    expect(early.ancestors).toEqual(chain.slice(0, 1));
    expect(early.descendants).toEqual(chain.slice(2, 2 + rest(1)));
    expect(early.descendants.length).toBeGreaterThan(half);
    const last = await context(13);
    expect(last).toEqual({ ancestors: chain.slice(13 - half, 13), descendants: [] });
  }, 300_000);

  it("keeps the newest revisions of an edit history, oldest first", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const author = await remoteAccount(h.store, "editor");
    const status = await bigStatus(h, author, NOW - DAY);
    const edits = 16;
    for (let i = 0; i < edits; i++) {
      await sql(
        h.store,
        `INSERT INTO status_edits (status_id, content, spoiler_text, media_json, poll_options, created_at)
				VALUES (?, ?, ?, '[]', ?, ?)`,
        status,
        `<p>${String(i).padStart(2, "0")} ${C.repeat(20_000)}</p>`,
        String(i).padStart(2, "0"),
        JSON.stringify(Array.from({ length: 100 }, () => C.repeat(1000))),
        new Date(NOW - DAY + i * 60_000).toISOString(),
      );
    }
    const read = await answer<{ spoiler_text: string }[]>(h, `/api/v1/statuses/${status}/history`, alice.token);
    expect(read.bytes).toBeLessThanOrEqual(ANSWER_BYTES);
    const shown = read.body.map((edit) => Number(edit.spoiler_text));
    expect(shown.length).toBeLessThan(edits);
    expect(shown).toEqual(Array.from({ length: shown.length }, (_, i) => edits - shown.length + i));
    // The next older revision is the first that does not fit.
    const each = jsonBytes(read.body[0]) + 1;
    expect(read.bytes + each).toBeGreaterThan(ANSWER_BYTES);
  });

  it("answers a fixed-id lookup with the ids that fit, in the order asked", async () => {
    const w = await world();
    const query = w.V.map((id) => `id[]=${id}`).join("&");
    const read = await answer(w.h, `/api/v1/statuses?${query}`, w.alice.token);
    expect(read.bytes).toBeLessThanOrEqual(ANSWER_BYTES);
    const shown = read.body.map((s) => s.id);
    expect(shown).toEqual(w.V.slice(0, shown.length));
    expect(read.bytes + (await statusBytes(w, w.V[shown.length]!)) + 1).toBeGreaterThan(ANSWER_BYTES);
  }, 300_000);

  it("answers search as one answer: fewer statuses, the offset continuing after them", async () => {
    const w = await world();
    const { h, alice } = w;
    const found: string[] = [];
    for (let offset = 0, page = 0; page < 10; page++) {
      const read = await answer<{ accounts: unknown[]; statuses: { id: string }[]; hashtags: unknown[] }>(
        h,
        `/api/v2/search?q=needle&limit=40&offset=${offset}`,
        alice.token,
      );
      expect(read.bytes).toBeLessThanOrEqual(ANSWER_BYTES);
      if (read.body.statuses.length === 0) {
        break;
      }
      // A client advancing by the number received (Tusky, Ivory) continues after the cut; Mastodon's web client
      // takes a short answer for the last one.
      expect(page > 0 || read.body.statuses.length < w.V.length).toBe(true);
      found.push(...read.body.statuses.map((s) => s.id));
      offset += read.body.statuses.length;
    }
    expect(found).toEqual(w.V);
  }, 300_000);

  it("shares one budget among the resolved account, accounts, statuses and hashtags", async () => {
    const w = await world();
    const { h, alice } = w;
    const needles = await maximalAccounts(h, "needle", 45);
    const [resolved] = await maximalAccounts(h, "resolved", 1);
    const blocked = await remoteAccount(h.store, "needleblocked", "blocked.example");
    await domainBlock(h.store, alice.id, "blocked.example");
    const credential = { tokenHash: await sha256Hex(alice.token), scope: "read" as const, now: NOW };
    const search = async (resolvedAccountId: string) => {
      const found = await h.store.search(BUILD, {
        credential,
        query: "needle",
        types: ["accounts", "statuses", "hashtags"],
        limit: 40,
        offset: 0,
        following: false,
        localDomain: "kopje.test",
        present: { origin: ORIGIN },
        resolvedAccountId,
      });
      if (found.status !== "ok") {
        throw new Error(found.status);
      }
      return found.value;
    };
    const found = await search(resolved!);
    // The resolved account first, then the search's own, within the limit; the statuses that fit what the accounts
    // left; the hashtag after them.
    expect(found.accounts.map((a) => a.id)).toEqual([resolved, ...needles.slice(0, 39)]);
    expect(found.statuses.map((s) => s.id)).toEqual(w.V.slice(0, found.statuses.length));
    expect(found.statuses.length).toBeGreaterThan(0);
    expect(found.hashtags.map((t) => t.name)).toEqual(["needle"]);
    expect(jsonBytes(found)).toBeLessThanOrEqual(ANSWER_BYTES);
    // The next status is the first rejected: with it, the accounts and statuses alone pass the budget.
    const items = (list: readonly unknown[]) => list.reduce<number>((sum, item) => sum + jsonBytes(item) + 1, 0);
    const taken =
      jsonBytes({ accounts: [], statuses: [], hashtags: [] }) + items(found.accounts) + items(found.statuses);
    expect(taken + (await statusBytes(w, w.V[found.statuses.length]!)) + 1).toBeGreaterThan(ANSWER_BYTES);
    // A resolved account the viewer may not find is not put first.
    expect((await search(blocked)).accounts[0]?.id).toBe(needles[0]);
  }, 300_000);

  it("answers the account search within the budget, its offset continuing after a cut", async () => {
    const w = await world();
    const { h, alice } = w;
    const needles = await maximalAccounts(h, "needle", 90);
    const found: string[] = [];
    for (let offset = 0, page = 0; page < 10; page++) {
      const read = await answer(h, `/api/v1/accounts/search?q=needle&limit=80&offset=${offset}`, alice.token);
      expect(read.bytes).toBeLessThanOrEqual(ANSWER_BYTES);
      const shown = read.body.map((a) => a.id);
      if (shown.length === 0) {
        break;
      }
      if (page === 0) {
        // Cut by bytes: the next account would pass the budget.
        expect(shown.length).toBeLessThan(needles.length);
        const next = await answer<unknown>(h, `/api/v1/accounts/${needles[shown.length]!}`, alice.token);
        expect(read.bytes + next.bytes + 1).toBeGreaterThan(ANSWER_BYTES);
      }
      found.push(...shown);
      offset += shown.length;
    }
    expect(found).toEqual(needles);
  }, 300_000);

  it("shares a profile page between its account and its statuses, next following the last one shown", async () => {
    const h = await community(["bob"]);
    const { bob } = h.users;
    const posts: string[] = [];
    for (let i = 0; i < 12; i++) {
      posts.push(await pageStatus(h, bob.id, NOW - (20 - i) * 60_000));
    }
    const newest = posts.toReversed();
    const shown: string[] = [];
    let maxId: string | null = null;
    for (let page = 0; page < 5; page++) {
      const read = await h.store.webProfilePage(BUILD, postsTab("bob", maxId, NOW));
      expect(read.status).toBe("ok");
      if (read.status !== "ok") {
        return;
      }
      // A public page's budget.
      expect(jsonBytes(read)).toBeLessThanOrEqual(WEB_PAGE_BYTES);
      shown.push(...read.statuses.map((s) => s.id));
      if (olderOf(read) === null) {
        break;
      }
      expect(olderOf(read)).toBe(read.statuses.at(-1)!.id);
      maxId = olderOf(read);
    }
    expect(shown).toEqual(newest);
  }, 300_000);
});

describe("the shared filter allowance (RES-3)", () => {
  it("matches each status as the unchunked presentation does, past the allowance", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const author = await remoteAccount(h.store, "long");
    // 60 statuses of 9,000 code units (540,000 in all, past MAX_FILTER_REQUEST_TEXT), each with "needle" at a
    // different depth, so the level decides which match.
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) {
      const depth = 150 * i;
      const text = `${"x".repeat(depth)} needle ${"y".repeat(9_000 - depth)}`;
      ids.push(await seedStatus(h.store, { accountId: author, visibility: "public", content: `<p>${text}</p>` }));
    }
    await h.request("/api/v2/filters", {
      method: "POST",
      headers: { authorization: `Bearer ${alice.token}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "n", context: ["public"], keywords_attributes: [{ keyword: "needle" }] }),
    });
    const [whole, chunked] = await runInDurableObject(h.store, (_instance, state) => {
      const db = new Db(state.storage.sql);
      const options = { origin: ORIGIN, viewer: { accountId: alice.id, now: new Date(NOW).toISOString() } };
      const visible = ids as VisibleStatusId[];
      const shared = presentation(db, visible, options);
      return [
        presentedWhole(db, visible, options),
        [
          ...presentStatusesWithin(db, shared, visible.slice(0, 7), ANSWER_BYTES, true).items,
          ...presentStatusesWithin(db, shared, visible.slice(7), ANSWER_BYTES, true).items,
        ],
      ];
    });
    expect(chunked).toEqual(whole);
    // The allowance cuts as filterTextLimits gives it over the 60 texts: a needle matches when it ends by its level.
    const [level] = filterTextLimits(Array.from({ length: 60 }, () => 9_008));
    const matched = whole.map((s) => (s.filtered ?? []).length > 0);
    expect(matched).toEqual(ids.map((_, i) => 150 * i + 7 <= level!));
    expect(matched).toContain(false);
  }, 300_000);

  it("matches each status once over passes that present it again, within the allowance", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const author = await remoteAccount(h.store, "passes");
    // 80 statuses of 10,000 code units, presented three times under one presentation, as a grouped page's
    // re-admission passes present the groups they keep.
    const ids: string[] = [];
    for (let i = 0; i < 80; i++) {
      const content = `<p>needle ${"y".repeat(9_993)}</p>`;
      ids.push(await seedStatus(h.store, { accountId: author, visibility: "public", content }));
    }
    await h.request("/api/v2/filters", {
      method: "POST",
      headers: { authorization: `Bearer ${alice.token}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "n", context: ["public"], keywords_attributes: [{ keyword: "needle" }] }),
    });
    const result = await runInDurableObject(h.store, (_instance, state) => {
      const db = new Db(state.storage.sql);
      const options = { origin: ORIGIN, viewer: { accountId: alice.id, now: new Date(NOW).toISOString() } };
      const visible = ids as VisibleStatusId[];
      const shared = presentation(db, visible, options);
      const passes = [80, 79, 78].map((n) =>
        presentStatusesWithin(db, shared, visible.slice(0, n), ANSWER_BYTES, true),
      );
      return { passes: passes.map((pass) => pass.items), units: shared.matched.units, level: shared.level };
    });
    const [level] = filterTextLimits(Array.from({ length: 80 }, () => 10_000));
    expect(result.level).toBe(level);
    expect(result.units).toBe(80 * level!);
    expect(result.units).toBeLessThanOrEqual(MAX_FILTER_REQUEST_TEXT);
    expect(result.passes[1]).toEqual(result.passes[0]!.slice(0, 79));
    expect(result.passes[2]).toEqual(result.passes[0]!.slice(0, 78));
  }, 300_000);

  it("matches a status quoted by many once, within the allowance", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const author = await remoteAccount(h.store, "quoting");
    // Texts of 10,000 code units, each starting with the keyword, so every one matches.
    const long = `<p>needle ${"y".repeat(9_993)}</p>`;
    // A chain: the 40 statuses quote `quoted`, which quotes `first`.
    const first = await seedStatus(h.store, { accountId: author, visibility: "public", content: long });
    const quoted = await seedStatus(h.store, { accountId: author, visibility: "public", content: long });
    await acceptQuote(h, quoted, first);
    const statuses: string[] = [];
    for (let i = 0; i < 40; i++) {
      const id = await seedStatus(h.store, { accountId: author, visibility: "public", content: long });
      await acceptQuote(h, id, quoted);
      statuses.push(id);
    }
    // The quoted status also stands at the top, as the first of a chunk after statuses that quote it.
    const ids = [...statuses.slice(0, 2), quoted, ...statuses.slice(2)];
    await h.request("/api/v2/filters", {
      method: "POST",
      headers: { authorization: `Bearer ${alice.token}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "n", context: ["public"], keywords_attributes: [{ keyword: "needle" }] }),
    });
    const result = await runInDurableObject(h.store, (_instance, state) => {
      const db = new Db(state.storage.sql);
      const options = { origin: ORIGIN, viewer: { accountId: alice.id, now: new Date(NOW).toISOString() } };
      const visible = ids as VisibleStatusId[];
      const shared = presentation(db, visible, options);
      const items = presentStatusesWithin(db, shared, visible, ANSWER_BYTES, true).items;
      return { items, level: shared.level, units: shared.matched.units, whole: presentedWhole(db, visible, options) };
    });
    expect(result.items).toHaveLength(41);
    expect(result.items).toEqual(result.whole);
    // Every status matches, and so does each quoted status shown: `quoted` in the 40, `first` in `quoted` at the top.
    type Shown = { filtered?: unknown[]; quote: { quoted_status?: Shown | null } | null };
    const matched = (status: Shown | null | undefined) => (status?.filtered ?? []).length > 0;
    const shown = result.items as unknown as Shown[];
    expect(shown.every((s) => matched(s) && matched(s.quote?.quoted_status))).toBe(true);
    // 41 statuses and two quoted statuses, each matched once at the level: 43 texts, not 82.
    const [level] = filterTextLimits(Array.from({ length: 43 }, () => 10_000));
    expect(result.level).toBe(level);
    expect(result.units).toBe(43 * level!);
    expect(result.units).toBeLessThanOrEqual(MAX_FILTER_REQUEST_TEXT);
  }, 300_000);
});

describe("realistic content is never cut (RES-3)", () => {
  it("answers a page of 40 long realistic statuses whole", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const author = await remoteAccount(h.store, "real");
    // Pleroma's and Akkoma's 5,000 characters of Japanese with links, a poll of 4 and 4 described attachments.
    const text = `<p>${"東京在住のソフトウェア開発者です。".repeat(280)}<a href="https://example.com/">link</a></p>`;
    for (let i = 0; i < 40; i++) {
      const id = await seedStatus(h.store, { accountId: author, visibility: "public", content: text, tags: ["real"] });
      await sql(
        h.store,
        `INSERT INTO polls (status_id, options, tallies, votes_count, voters_count, expires_at)
				VALUES (?, '["はい","いいえ","たぶん","わからない"]', '[0,0,0,0]', 0, 0, ?)`,
        id,
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
          "写真の説明。".repeat(250),
        );
      }
    }
    const read = await answer(h, "/api/v1/timelines/tag/real?limit=40", alice.token);
    expect(read.body).toHaveLength(40);
    expect(read.bytes).toBeLessThan(ANSWER_BYTES / 4);
  }, 300_000);
});

describe("the Store RPC returns a maximal answer (RES-3)", () => {
  it("returns a timeline page, a context and search at the budget, under the 32 MiB RPC limit", async () => {
    const w = await world();
    const { h, alice } = w;
    // Ten replies under V[11], so its context passes the budget.
    let parent = w.V[11]!;
    for (let i = 0; i < 10; i++) {
      parent = await bigStatus(h, w.author, NOW - 1000 + i, { inReplyToId: parent });
    }
    const credential = { tokenHash: await sha256Hex(alice.token), scope: "read" as const, now: NOW };
    const present = { origin: ORIGIN };
    const page = await h.store.publicTimeline(BUILD, {
      credential,
      now: NOW,
      page: { limit: 40 },
      local: false,
      remote: false,
      onlyMedia: false,
      present,
    });
    const context = await h.store.statusContext(BUILD, { credential, now: NOW, id: w.V[11]!, present });
    const search = await h.store.search(BUILD, {
      credential,
      query: "needle",
      types: ["accounts", "statuses", "hashtags"],
      limit: 40,
      offset: 0,
      following: false,
      localDomain: "kopje.test",
      present,
    });
    const sizes = [page, context, search].map((value) => jsonBytes(value));
    for (const size of sizes) {
      expect(size).toBeGreaterThan(ANSWER_BYTES - 1_100_000);
      expect(size).toBeLessThanOrEqual(ANSWER_BYTES + 100);
    }
    console.info(`Store RPC answers (JSON bytes): page ${sizes[0]}, context ${sizes[1]}, search ${sizes[2]}`);
  }, 300_000);
});

// The cache of remote profile images (domain/remote-media.ts cachedImagesOf) adds one statement to each chunk of
// presented accounts, read outside the row heap: at most 2 × ANSWER_CHUNK ids (the chunk and its moved-to targets), one
// packed object of CACHED_IMAGE_BYTES a kind, so at most this many bytes a chunk.
describe("the cached images of a chunk of accounts (RES-3)", () => {
  it("reads them with one statement a chunk, within ids × kinds × the packed cap", async () => {
    const h = await community(["alice"]);
    const ids: string[] = [];
    for (let i = 0; i < ANSWER_CHUNK + 1; i++) {
      const id = await remoteAccount(h.store, `cached${i}`);
      await sql(
        h.store,
        "UPDATE accounts SET avatar_url = ?2, header_url = ?3 WHERE id = ?1",
        id,
        `https://remote.example/a${i}.gif`,
        `https://remote.example/h${i}.gif`,
      );
      for (const kind of CACHED_IMAGE_KINDS) {
        await sql(
          h.store,
          `INSERT INTO remote_media (kind, owner_id, account_id, url, host, category, lane, generation, enqueued_at,
						token, ext, still_ext, stored_at)
					SELECT ?2, id, id, CASE ?2 WHEN 'avatar' THEN avatar_url ELSE header_url END, 'remote.example', 'image', 0, 0,
						1, ?3, 'webp', 'webp', 1 FROM accounts WHERE id = ?1`,
          id,
          kind,
          `${kind[0]}${String(i).padStart(63, "0")}`,
        );
      }
      ids.push(id);
    }
    const reads = await runInDurableObject(h.store, (_instance, state) => {
      const statements: number[] = [];
      const db = new Db(
        observedSql(state.storage.sql, (rows, query) => {
          if (/FROM json_each\(\?1\) c CROSS JOIN \(SELECT value AS kind/.test(query)) {
            statements.push(
              rows.reduce((sum, row) => sum + (typeof row.packed === "string" ? row.packed.length : 0), 0),
            );
          }
        }),
      );
      const presented = [...accountsOf(db, ids, { origin: ORIGIN })];
      return { statements, presented: presented.filter((a) => a?.avatar.includes("/media/r/")).length };
    });
    const bound = 2 * ANSWER_CHUNK * CACHED_IMAGE_KINDS.length * CACHED_IMAGE_BYTES;
    expect({ bound, chunks: reads.statements.length, presented: reads.presented }).toEqual({
      bound: 14_800,
      chunks: 2,
      presented: ANSWER_CHUNK + 1,
    });
    for (const bytes of reads.statements) {
      expect(bytes).toBeLessThanOrEqual(bound);
    }
    // A full chunk at the 64-byte token cap: its packed objects are at the bound per id and kind.
    expect(reads.statements[0]).toBe(ANSWER_CHUNK * CACHED_IMAGE_KINDS.length * CACHED_IMAGE_BYTES);
  });
});
