import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { Db } from "../src/db/sql";
import {
  CARD_CLAIM_WALK,
  CARD_EXPIRE_BATCH,
  CARD_EXPIRE_MS,
  CARD_FRESH_MS,
  CARD_HOLD_MS,
  CARD_ROUND_CLAIMS,
  type CardFields,
  claimCards,
  enqueueCard,
  recordCard,
} from "../src/domain/link-cards";
import { suspendLocal, unsuspendLocal } from "../src/domain/suspension";
import {
  CARD_ACCEPT_LANGUAGE,
  CARD_ADMISSIONS,
  CARD_CHAINS,
  CARD_CONCURRENCY,
  CARD_FETCHES_MS,
  CARD_OEMBED_BODY_LIMIT,
  CARD_OWN_STORE_CALLS,
  CARD_ROUND_MS,
  CARD_STORE_CALLS,
  CARD_SUBREQUESTS,
  type LinkCardsDeps,
  linkCardsRound,
} from "../src/federation/link-cards";
import { CARD_OUTPUT_MAX_UNITS } from "../src/federation/link-details";
import { WEB_PAGE_MAX_REDIRECTS, WEB_PAGE_TIMEOUT_MS } from "../src/federation/web-page";
import { outputMaxUnits, SCAN_LIMITS } from "../src/platform/html-scan";
import type { StoreStub } from "../src/platform/store-client";
import {
  CARD_DIMENSION_MAX,
  OEMBED_ENDPOINT_TTL_MS,
  OEMBED_ENDPOINTS_MAX,
  OEMBED_EXPIRE_BATCH,
  OEMBED_TEMPLATE_BYTES,
  SAFE_INTEGER_MAX,
} from "../src/platform/stored-bounds";
import { bearer, json, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { blockDomain } from "./domain-block-helpers";
import { BUILD } from "./helpers";
import { linkCardRoundMemory } from "./memory-model";
import { plannedRun, scansOf, staleStatistics } from "./read-helpers";
import { community, post } from "./status-helpers";

// The cron's link card round (federation/link-cards.ts) over the Store's claim and record (domain/link-cards.ts).

// The 5-minute cron's rounds a day: the network claims a day at most.
const CARD_DAY_ROUNDS = (24 * 60) / 5;

const SITE = "https://site.example/a";
// A link card's type and dimensions (no embed).
const LINK = {
  type: "link",
  width: 0,
  height: 0,
  embedSrc: "",
  iframeWidth: null,
  iframeHeight: null,
  imageUrl: "",
  imageDescription: "",
  linkType: "unknown",
  finalUrl: "",
} as const;
const HTML = { "content-type": "text/html; charset=utf-8" };
const PAGE = '<html lang="en"><head><title> Site title </title><meta name="description" content="About"></head></html>';

type Route = (request: Request) => Response | Promise<Response>;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const page =
  (body = PAGE) =>
  () =>
    new Response(body, { headers: HTML });

type Row = {
  url: string;
  due_at: number | null;
  enqueued_at: number;
  claim: number;
  attempts: number;
  generation: number;
  title: string;
  description: string;
  fetched_at: number | null;
};

async function world() {
  const h = await community(["alice"]);
  const { alice } = h.users;
  const clock = { t: NOW };
  h.now.mockImplementation(() => clock.t);
  const requests: string[] = [];
  const headers: Headers[] = [];
  let routes: Record<string, Route> = {};
  const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(`${request.method} ${request.url}`);
    headers.push(request.headers);
    const route = routes[request.url];
    return Promise.resolve(route === undefined ? new Response("missing", { status: 404 }) : route(request));
  };
  const checks: string[] = [];
  let checkHost: (url: URL) => Promise<void> = () => Promise.resolve();
  const deps = (store: () => StoreStub = () => h.store, extra: Partial<LinkCardsDeps> = {}): LinkCardsDeps => ({
    build: () => BUILD,
    store,
    now: () => clock.t,
    keygen: () => Promise.reject(new Error("no keys")),
    loader: {
      fetch,
      checkHost: (url) => {
        checks.push(url.href);
        return checkHost(url);
      },
    },
    ...extra,
  });
  const round = (store?: () => StoreStub) => linkCardsRound(h.env, deps(store));
  const postLink = async (url: string, extra: Record<string, unknown> = {}) =>
    (await post(h, alice, { status: `see ${url}`, ...extra })).id;
  const row = async (id: string) =>
    (
      await sql<Row>(
        h.store,
        `SELECT url, due_at, enqueued_at, claim, attempts, generation, title, description, fetched_at FROM status_cards
				WHERE status_id = ?`,
        id,
      )
    )[0];
  const op = <I, O>(operation: { run: (sql: SqlStorage, input: I) => O }, input: I) =>
    runInDurableObject(h.store, (_instance, s) => operation.run(s.storage.sql, input));
  // A Store stub whose `method` calls are replaced by `replace` (the call's index among them, from 0).
  const wrapped = (method: string, replace: (n: number, real: () => Promise<unknown>) => Promise<unknown>) => {
    let n = 0;
    return new Proxy(h.store, {
      get: (target, key) => {
        const real = Reflect.get(target, key) as unknown;
        if (key !== method || typeof real !== "function") {
          return real;
        }
        // An RPC stub's method is called as a method: it has no apply.
        const stub = target as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
        return (...args: unknown[]) => replace(n++, () => stub[method]!(...args));
      },
    });
  };
  return {
    h,
    alice,
    clock,
    requests,
    headers,
    checks,
    setRoutes: (next: Record<string, Route>) => {
      routes = next;
    },
    setCheckHost: (next: (url: URL) => Promise<void>) => {
      checkHost = next;
    },
    round,
    postLink,
    row,
    op,
    wrapped,
  };
}

// Routes `url` to a page whose answer waits for `gate`, `reached` resolved once it is requested.
function held(w: Awaited<ReturnType<typeof world>>, url = SITE) {
  const gate = deferred();
  const reached = deferred();
  w.setRoutes({
    [url]: async () => {
      reached.resolve();
      await gate.promise;
      return page()();
    },
  });
  return { gate, reached };
}

// A cached oEmbed endpoint's template, and the endpoint cache as stored (card_oembed_endpoints).
const TEMPLATE = "https://provider.example/oembed?url={url}&format=json";
const cache = (w: Awaited<ReturnType<typeof world>>) =>
  sql<{ domain: string; template: string; expires_at: number }>(
    w.h.store,
    "SELECT domain, template, expires_at FROM card_oembed_endpoints ORDER BY domain",
  );

describe("the link card round", () => {
  it("fetches a claim's page through the sink and attaches its card", async () => {
    const w = await world();
    w.setRoutes({ [SITE]: page() });
    const id = await w.postLink(SITE);
    expect(await w.round()).toEqual({ claimed: 1, attached: 1, none: 0, unattempted: 0, released: 0, lost: 0 });
    expect(w.requests).toEqual([`GET ${SITE}`]);
    expect(w.headers[0]?.get("accept")).toBe("text/html");
    expect(w.headers[0]?.get("accept-language")).toBe(CARD_ACCEPT_LANGUAGE);
    expect(w.headers[0]?.get("user-agent")).toMatch(/^Kopje\/\S+ \(\+https:\/\/kopje\.test\/\) Bot$/);
    expect(await w.row(id)).toMatchObject({
      url: SITE,
      due_at: null,
      attempts: 0,
      title: "Site title",
      description: "About",
      fetched_at: NOW,
    });
    // Nothing more is due.
    expect(await w.round()).toMatchObject({ claimed: 0 });
  });

  it("gives no card for a blank title, a failed fetch or a refused URL, without retrying", async () => {
    const w = await world();
    w.setRoutes({
      "https://site.example/blank": page('<title> 　 </title><meta property="og:title" content="">'),
      "https://site.example/json": () => new Response("{}", { headers: { "content-type": "application/json" } }),
    });
    const ids = [
      await w.postLink("https://site.example/blank"),
      await w.postLink("https://site.example/json"),
      await w.postLink("https://site.example/missing"),
      await w.postLink("https://site.example:8443/port"),
    ];
    expect(await w.round()).toMatchObject({ claimed: 4, attached: 0, none: 4 });
    // The port was refused before any network step.
    expect(w.requests).toEqual([
      "GET https://site.example/blank",
      "GET https://site.example/json",
      "GET https://site.example/missing",
    ]);
    for (const id of ids) {
      expect(await w.row(id)).toBeUndefined();
    }
  });

  it("copies another status's fresh card at claim, and fetches when there is none", async () => {
    const w = await world();
    w.setRoutes({ [SITE]: page() });
    const first = await w.postLink(SITE);
    await w.round();
    w.clock.t += 1000;
    const second = await w.postLink(SITE);
    expect(await w.op(claimCards, { now: w.clock.t })).toMatchObject({ claims: [], attached: 1 });
    expect(await w.row(second)).toMatchObject({ title: "Site title", fetched_at: NOW, due_at: null, attempts: 0 });
    expect(w.requests).toEqual([`GET ${SITE}`]);
    // A copy older than CARD_FRESH_MS is not taken: the URL is fetched again for the next status.
    w.clock.t = NOW + CARD_FRESH_MS;
    const third = await w.postLink(SITE);
    expect(await w.op(claimCards, { now: w.clock.t })).toMatchObject({ claims: [{ statusId: third }], attached: 0 });
    expect(await w.row(first)).toMatchObject({ fetched_at: NOW });
  });

  it("claims the first CARD_ROUND_CLAIMS rows of seven and leaves the seventh untouched", async () => {
    const w = await world();
    const ids: string[] = [];
    for (let i = 0; i < CARD_ROUND_CLAIMS + 1; i++) {
      ids.push(await w.postLink(`https://site${i}.example/`));
    }
    const claimed = await w.op(claimCards, { now: w.clock.t });
    expect(claimed.claims.map((c) => c.statusId)).toEqual(ids.slice(0, CARD_ROUND_CLAIMS));
    expect(await w.row(ids.at(-1)!)).toMatchObject({ due_at: NOW, claim: 0, attempts: 0 });
    for (const id of ids.slice(0, CARD_ROUND_CLAIMS)) {
      expect(await w.row(id)).toMatchObject({ due_at: NOW + CARD_HOLD_MS, claim: 1, attempts: 1 });
    }
  });

  it("defers a row whose URL another row holds, within one walk and across rounds", async () => {
    const w = await world();
    const { gate, reached } = held(w);
    const a = await w.postLink(SITE);
    const b = await w.postLink(SITE);
    const first = w.round();
    await reached.promise;
    // The same walk deferred b to a's hold; a second round, while a's fetch is held, defers c as well.
    expect(await w.row(b)).toMatchObject({ due_at: NOW + CARD_HOLD_MS, attempts: 0, claim: 0 });
    w.clock.t += 1000;
    const c = await w.postLink(SITE);
    expect(await w.round()).toMatchObject({ claimed: 0 });
    expect(await w.row(c)).toMatchObject({ due_at: NOW + CARD_HOLD_MS, attempts: 0 });
    gate.resolve();
    expect(await first).toMatchObject({ claimed: 1, attached: 1 });
    w.clock.t = NOW + CARD_HOLD_MS;
    expect(await w.round()).toMatchObject({ claimed: 0 });
    // The copies keep the donor's fetched_at, the time a's record landed.
    for (const id of [a, b, c]) {
      expect(await w.row(id)).toMatchObject({ title: "Site title", fetched_at: NOW + 1000, due_at: null });
    }
    expect(w.requests).toEqual([`GET ${SITE}`]);
  });

  it("keeps an open hold past the expiry, so a later round still defers its URL", async () => {
    const w = await world();
    const { gate, reached } = held(w);
    const a = await w.postLink(SITE);
    w.clock.t = NOW + CARD_EXPIRE_MS - 1000;
    const first = w.round();
    await reached.promise;
    w.clock.t = NOW + CARD_EXPIRE_MS + 1000;
    const b = await w.postLink(SITE);
    const second = await w.op(claimCards, { now: w.clock.t });
    expect(second).toMatchObject({ expired: 0, claims: [], deferred: 1 });
    expect(await w.row(a)).toMatchObject({ attempts: 1 });
    expect(await w.row(b)).toMatchObject({ due_at: NOW + CARD_EXPIRE_MS - 1000 + CARD_HOLD_MS });
    gate.resolve();
    expect(await first).toMatchObject({ attached: 1 });
    expect(w.requests).toEqual([`GET ${SITE}`]);
  });

  it("releases a claim whose fetch runs into the deadline, so two such rounds drop no row", async () => {
    const w = await world();
    const ids: string[] = [];
    for (let i = 0; i < CARD_ROUND_CLAIMS; i++) {
      ids.push(await w.postLink(`https://site${i}.example/`));
    }
    for (const pass of [1, 2]) {
      const gate = deferred();
      let reached = 0;
      const both = deferred();
      w.setRoutes(
        Object.fromEntries(
          ids.map((_, i) => [
            `https://site${i}.example/`,
            async () => {
              if (++reached === CARD_CONCURRENCY) {
                both.resolve();
              }
              await gate.promise;
              return page()();
            },
          ]),
        ),
      );
      const start = w.clock.t;
      const running = w.round();
      await both.promise;
      // Two fetches in flight, four not started, as the fetches' deadline passes.
      w.clock.t = start + CARD_FETCHES_MS + 1;
      gate.resolve();
      expect(await running, `pass ${pass}`).toEqual({
        claimed: CARD_ROUND_CLAIMS,
        attached: 0,
        none: 0,
        unattempted: CARD_CONCURRENCY,
        released: CARD_ROUND_CLAIMS - CARD_CONCURRENCY,
        lost: 0,
      });
      for (const id of ids) {
        expect(await w.row(id), `pass ${pass}`).toMatchObject({ attempts: 0, fetched_at: null, claim: pass });
      }
      w.clock.t += 1000;
    }
  });

  it("expires a pending row after a day, never claiming it", async () => {
    const w = await world();
    const id = await w.postLink(SITE);
    w.clock.t = NOW + CARD_EXPIRE_MS + 1;
    expect(await w.op(claimCards, { now: w.clock.t })).toMatchObject({ expired: 1, claims: [] });
    expect(await w.row(id)).toBeUndefined();
  });
});

describe("the fences of a record", () => {
  it("drops the record of a claim whose status was edited or deleted during the fetch", async () => {
    const w = await world();
    const { gate, reached } = held(w);
    const edited = await w.postLink(SITE);
    const running = w.round();
    await reached.promise;
    const before = (await w.row(edited))!;
    const response = await w.h.request(
      `/api/v1/statuses/${edited}`,
      bearer(w.alice.token, json({ status: `again ${SITE}` }, { method: "PUT" })),
    );
    expect(response.status).toBe(200);
    gate.resolve();
    expect(await running).toMatchObject({ claimed: 1, attached: 0, lost: 1 });
    // The edit's reset: a new generation, pending at once, the claim token kept.
    const after = (await w.row(edited))!;
    expect(after).toMatchObject({ due_at: NOW, attempts: 0, claim: before.claim, fetched_at: null, title: "" });
    expect(after.generation).not.toBe(before.generation);

    const again = held(w, "https://site.example/b");
    const deleted = await w.postLink("https://site.example/b");
    await sql(w.h.store, "DELETE FROM status_cards WHERE status_id = ?", edited);
    const second = w.round();
    await again.reached.promise;
    expect((await w.h.request(`/api/v1/statuses/${deleted}`, bearer(w.alice.token, { method: "DELETE" }))).status).toBe(
      200,
    );
    again.gate.resolve();
    expect(await second).toMatchObject({ claimed: 1, lost: 1 });
    expect(await sql(w.h.store, "SELECT count(*) AS n FROM status_cards")).toEqual([{ n: 0 }]);
  });

  it("records the others when one claim's record fails", async () => {
    const w = await world();
    w.setRoutes({ [SITE]: page(), "https://site.example/b": page() });
    const a = await w.postLink(SITE);
    const b = await w.postLink("https://site.example/b");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = w.wrapped("recordCard", (n, real) => (n === 0 ? Promise.reject(new Error("boom")) : real()));
    expect(await w.round(() => failing)).toMatchObject({ claimed: 2, attached: 1, lost: 1 });
    error.mockRestore();
    const rows = [await w.row(a), await w.row(b)];
    expect(rows.filter((r) => r?.fetched_at === NOW)).toHaveLength(1);
    expect(rows.filter((r) => r?.attempts === 1 && r.fetched_at === null)).toHaveLength(1);
  });

  it("attaches the card of a status suspended and restored during the fetch (an accepted risk)", async () => {
    const w = await world();
    const { gate, reached } = held(w);
    const id = await w.postLink(SITE);
    const running = w.round();
    await reached.promise;
    await runInDurableObject(w.h.store, (_instance, s) => {
      const db = new Db(s.storage.sql);
      suspendLocal(db, w.alice.id, null, w.clock.t);
      unsuspendLocal(db, w.alice.id, w.clock.t + 1);
    });
    gate.resolve();
    expect(await running).toMatchObject({ attached: 1 });
    expect(await w.row(id)).toMatchObject({ fetched_at: NOW });
  });

  it("drops the record of a status suspended during the fetch", async () => {
    const w = await world();
    const { gate, reached } = held(w);
    const id = await w.postLink(SITE);
    const running = w.round();
    await reached.promise;
    await runInDurableObject(w.h.store, (_instance, s) => {
      suspendLocal(new Db(s.storage.sql), w.alice.id, null, w.clock.t);
    });
    gate.resolve();
    expect(await running).toMatchObject({ lost: 1 });
    expect(await w.row(id)).toMatchObject({ attempts: 1, fetched_at: null });
  });

  it("stores the texts as the triggers allow: a NUL removed, a title of NUL alone no card", async () => {
    const w = await world();
    const kept = await w.postLink(SITE);
    const dropped = await w.postLink("https://site.example/nul");
    const claims = (await w.op(claimCards, { now: w.clock.t })).claims;
    const card = (title: string) => ({
      kind: "card" as const,
      fields: {
        title,
        description: "\u009f\u0000d",
        authorName: "\u0000",
        authorUrl: "",
        providerName: "",
        providerUrl: "",
        language: null,
        publishedAt: null,
        ...LINK,
      },
    });
    expect(await w.op(recordCard, { ...claims[0]!, outcome: card("a\u0080\u0000b"), now: w.clock.t })).toEqual({
      held: true,
    });
    expect(await w.op(recordCard, { ...claims[1]!, outcome: card("\u0000"), now: w.clock.t })).toEqual({ held: true });
    expect(await w.row(kept)).toMatchObject({ title: "a\u0080b", description: "\u009fd", fetched_at: NOW });
    expect(await w.row(dropped)).toBeUndefined();
  });

  it("discards a late record of an older claim", async () => {
    const w = await world();
    const id = await w.postLink(SITE);
    const old = (await w.op(claimCards, { now: w.clock.t })).claims[0]!;
    w.clock.t += CARD_HOLD_MS;
    const current = (await w.op(claimCards, { now: w.clock.t })).claims[0]!;
    expect(current.token).toBe(old.token + 1);
    const fields = { title: "t", description: "", authorName: "", authorUrl: "", providerName: "", providerUrl: "" };
    const outcome = { kind: "card" as const, fields: { ...fields, language: null, publishedAt: null, ...LINK } };
    expect(await w.op(recordCard, { ...old, outcome, now: w.clock.t })).toEqual({ held: false });
    expect(await w.row(id)).toMatchObject({ attempts: 2, fetched_at: null });
    // A claim never recorded twice is given up.
    w.clock.t += CARD_HOLD_MS;
    expect(await w.op(claimCards, { now: w.clock.t })).toMatchObject({ givenUp: 1, claims: [] });
    expect(await w.row(id)).toBeUndefined();
  });
});

describe("the admission of each hop", () => {
  it("starts no fetch and follows no redirect once maintenance is entered during a DNS check", async () => {
    for (const redirect of [false, true]) {
      const w = await world();
      const gate = deferred();
      const reached = deferred();
      const target = redirect ? "https://next.example/" : SITE;
      w.setRoutes({
        [SITE]: redirect ? () => new Response(null, { status: 302, headers: { location: target } }) : page(),
        [target]: page(),
      });
      w.setCheckHost(async (url) => {
        if (url.href === target) {
          reached.resolve();
          await gate.promise;
        }
      });
      const id = await w.postLink(SITE);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const running = w.round();
      await reached.promise;
      await w.h.store.setMaintenance(BUILD, true);
      gate.resolve();
      expect(await running).toMatchObject({ claimed: 1, attached: 0, lost: 1 });
      error.mockRestore();
      expect(w.requests, `redirect: ${redirect}`).toEqual(redirect ? [`GET ${SITE}`] : []);
      await w.h.store.setMaintenance(BUILD, false);
      // The claim stays open (its release was refused too) and is claimed again after its hold.
      expect(await w.row(id)).toMatchObject({ attempts: 1, fetched_at: null });
    }
  });

  it.each([
    ["before", 0],
    ["after", 1],
  ])("releases a claim unattempted when a policy RPC fails %s the DNS check", async (_position, failing) => {
    const w = await world();
    w.setRoutes({ [SITE]: page() });
    const id = await w.postLink(SITE);
    const store = w.wrapped("webHopRefused", (n, real) =>
      n === failing ? Promise.reject(new Error("policy unreadable")) : real(),
    );
    expect(await w.round(() => store)).toMatchObject({ claimed: 1, unattempted: 1, none: 0 });
    expect(w.requests).toEqual([]);
    expect(await w.row(id)).toMatchObject({ due_at: NOW, attempts: 0, claim: 1, fetched_at: null });
  });

  it("gives no card for a host the domain policy refuses, before or after redirects", async () => {
    const w = await world();
    await blockDomain(w.h.store, "blocked.example");
    w.setRoutes({
      [SITE]: () => new Response(null, { status: 301, headers: { location: "https://blocked.example/" } }),
    });
    const direct = await w.postLink("https://blocked.example/x");
    const redirected = await w.postLink(SITE);
    expect(await w.round()).toMatchObject({ claimed: 2, none: 2 });
    expect(w.requests).toEqual([`GET ${SITE}`]);
    expect(await w.row(direct)).toBeUndefined();
    expect(await w.row(redirected)).toBeUndefined();
    expect(w.checks).toEqual([SITE]);
  });
});

describe("the transitions of a claim", () => {
  const ENDPOINT = "https://provider.example/oembed?url=https%3A%2F%2Fsite.example%2Fa&format=json";
  const declaring = (href = ENDPOINT, title = "Site title", extra = "") =>
    `<html><head><title>${title}</title><link rel="alternate" type="application/json+oembed" href="${href.replaceAll("&", "&amp;")}">${extra}</head></html>`;
  const DOC = { version: "1.0", type: "link", title: "Embed title", provider_name: "Provider" };
  const answer =
    (body: unknown, init: ResponseInit = {}) =>
    () =>
      new Response(typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body), init);
  const cached = (w: Awaited<ReturnType<typeof world>>, template = TEMPLATE) =>
    sql(
      w.h.store,
      "INSERT INTO card_oembed_endpoints (domain, template, expires_at) VALUES ('site.example', ?, ?)",
      template,
      w.clock.t + 1000,
    );
  // One claim of SITE through a round over `routes`: the round, the requests, the stored row and the cache.
  const claim = async (
    routes: Record<string, Route>,
    setup?: (w: Awaited<ReturnType<typeof world>>) => Promise<unknown>,
  ) => {
    const w = await world();
    await setup?.(w);
    w.setRoutes(routes);
    const id = await w.postLink(SITE);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const round = await w.round();
    const logged = log.mock.calls.map(([entry]) => entry as Record<string, unknown>);
    log.mockRestore();
    return { w, round, requests: w.requests, row: await w.row(id), cache: await cache(w), logged };
  };
  const titled = (row: Row | undefined) => row?.title;

  it.each<[string, Route, string | null]>([
    ["T3: a valid document", answer(DOC), "Embed title"],
    ["T4: a final status that is not 200", answer(DOC, { status: 404 }), "Site title"],
    ["T5: invalid JSON", answer('{"version":'), "Site title"],
    ["T5: invalid UTF-8", answer(new Uint8Array([0x7b, 0xc3, 0x28, 0x7d])), "Site title"],
    ["T5: an empty body", answer(""), "Site title"],
    ["T5: an unsupported encoding", answer(DOC, { headers: { "content-encoding": "deflate" } }), "Site title"],
    ["T6: a null root", answer("null"), "Site title"],
    ["T7: an array root", answer([DOC]), null],
    ["T7: a string root", answer('"x"'), null],
    ["T8: past the depth cap", answer(`{"a":${"[".repeat(40)}${"]".repeat(40)}}`), "Site title"],
    ["T9: an invalid version", answer({ ...DOC, version: "2.0" }), "Site title"],
    ["T9: a blank type", answer({ ...DOC, type: " " }), "Site title"],
    ["T10: a body past the limit", answer(`"${"a".repeat(CARD_OEMBED_BODY_LIMIT)}"`), null],
    ["T11: a network failure", () => Promise.reject(new Error("reset")), null],
    ["T11: too many redirects", answer(null, { status: 302, headers: { location: ENDPOINT } }), null],
    ["T11: a redirect to http", answer(null, { status: 302, headers: { location: "http://provider.example/" } }), null],
    ["T13: rich", answer({ ...DOC, type: "rich" }), "Site title"],
    ["T13: a photo without a url", answer({ ...DOC, type: "photo" }), "Site title"],
    ["T13: a photo whose url is a number", answer({ ...DOC, type: "photo", url: 7 }), "Site title"],
    ["T13: a photo whose url is a boolean", answer({ ...DOC, type: "photo", url: true }), "Site title"],
    ["T13: a photo whose url is an object", answer({ ...DOC, type: "photo", url: { x: 1 } }), "Site title"],
    ["T13: a photo whose url is an array", answer({ ...DOC, type: "photo", url: ["x"] }), "Site title"],
    ["T13: a blank title", answer({ ...DOC, title: " " }), "Site title"],
    ["T14: an unknown type", answer({ ...DOC, type: "foo" }), null],
    ["T15: a type that is not a string", answer({ ...DOC, type: 1 }), null],
  ])("the cold path: %s", async (_name, endpoint, title) => {
    const { round, requests, row, cache: rows, w } = await claim({ [SITE]: page(declaring()), [ENDPOINT]: endpoint });
    expect(round).toMatchObject(title === null ? { none: 1 } : { attached: 1 });
    expect(titled(row)).toBe(title ?? undefined);
    // Two chains at most: the page, then the endpoint (each redirect a hop of it).
    expect(requests.slice(0, 2)).toEqual([`GET ${SITE}`, `GET ${ENDPOINT}`]);
    expect(new Set(requests).size).toBeLessThanOrEqual(2);
    // T20: the endpoint cached under the page's host whatever the outcome.
    expect(rows).toEqual([
      { domain: "site.example", template: TEMPLATE, expires_at: w.clock.t + OEMBED_ENDPOINT_TTL_MS },
    ]);
  });

  it("a blocked endpoint host is no card, never requested", async () => {
    const { round, requests } = await claim({ [SITE]: page(declaring()), [ENDPOINT]: answer(DOC) }, (w) =>
      blockDomain(w.h.store, "provider.example"),
    );
    expect(round).toMatchObject({ none: 1 });
    expect(requests).toEqual([`GET ${SITE}`]);
  });

  it("upgrades an http endpoint to https, and tries none of another scheme or one the sink refuses", async () => {
    const upgraded = await claim({
      [SITE]: page(declaring(ENDPOINT.replace("https:", "http:"))),
      [ENDPOINT]: answer(DOC),
    });
    expect(upgraded.requests).toEqual([`GET ${SITE}`, `GET ${ENDPOINT}`]);
    expect(titled(upgraded.row)).toBe("Embed title");
    for (const href of [
      "ftp://provider.example/o?url=https://a",
      "https://10.0.0.1/o?url=https://a",
      "https://provider.example:8443/o",
    ]) {
      const refused = await claim({ [SITE]: page(declaring(href)) });
      expect(refused.requests, href).toEqual([`GET ${SITE}`]);
      expect(titled(refused.row)).toBe("Site title");
      expect(refused.cache).toEqual([]);
    }
  });

  it("caches no endpoint URL_REGEX makes no template of, and fetches it all the same", async () => {
    const plain = "https://provider.example/oembed/1";
    const { requests, row, cache: rows } = await claim({ [SITE]: page(declaring(plain)), [plain]: answer(DOC) });
    expect(requests).toEqual([`GET ${SITE}`, `GET ${plain}`]);
    expect(titled(row)).toBe("Embed title");
    expect(rows).toEqual([]);
  });

  it("a page with a blank title and a player is no card without an endpoint", async () => {
    const player = '<meta property="twitter:player" content="https://v.example/e/1">';
    const { round, row } = await claim({ [SITE]: page(`<title> </title>${player}`) });
    expect(round).toMatchObject({ none: 1 });
    expect(row).toBeUndefined();
  });

  it("stores a video from an endpoint and from twitter:player", async () => {
    const html = '<iframe src="https://v.example/e/1?a=1&amp;b=2" width="560" height="315"></iframe>';
    const video = await claim({
      [SITE]: page(declaring()),
      [ENDPOINT]: answer({ ...DOC, type: "video", html, width: 1280, height: 720 }),
    });
    const embed = (w: Awaited<ReturnType<typeof world>>) =>
      sql(w.h.store, "SELECT card_type, width, height, embed_src, iframe_width, iframe_height FROM status_cards");
    expect(await embed(video.w)).toEqual([
      {
        card_type: 2,
        width: 1280,
        height: 720,
        embed_src: "https://v.example/e/1?a=1&b=2",
        iframe_width: 560,
        iframe_height: 315,
      },
    ]);
    const metas = '<meta property="twitter:player" content="/e/2"><meta property="twitter:player:width" content="480">';
    const player = await claim({ [SITE]: page(`<title>Player</title>${metas}`) });
    expect(await embed(player.w)).toEqual([
      {
        card_type: 2,
        width: 480,
        height: 0,
        embed_src: "https://site.example/e/2",
        iframe_width: 480,
        iframe_height: null,
      },
    ]);
  });

  it("the cached path fetches the endpoint first, then on a fallback the page only, and never writes", async () => {
    const other = "https://other.example/oembed?url=x";
    const hit = await claim({ [ENDPOINT]: answer(DOC), [SITE]: page(declaring()) }, (w) => cached(w));
    expect(hit.requests).toEqual([`GET ${ENDPOINT}`]);
    expect(titled(hit.row)).toBe("Embed title");
    expect(hit.cache).toEqual([{ domain: "site.example", template: TEMPLATE, expires_at: hit.w.clock.t + 1000 }]);
    const fallback = await claim(
      { [ENDPOINT]: answer(DOC, { status: 500 }), [SITE]: page(declaring(other)), [other]: answer(DOC) },
      (w) => cached(w),
    );
    expect(fallback.requests).toEqual([`GET ${ENDPOINT}`, `GET ${SITE}`]);
    expect(titled(fallback.row)).toBe("Site title");
    // The TTL is not renewed, and the page's other endpoint is not cached.
    expect(fallback.cache).toEqual([
      { domain: "site.example", template: TEMPLATE, expires_at: fallback.w.clock.t + 1000 },
    ]);
    // A transport failure of the cached endpoint is no card, the page not fetched (Mastodon's rescue).
    const failed = await claim({ [ENDPOINT]: () => Promise.reject(new Error("reset")), [SITE]: page() }, (w) =>
      cached(w),
    );
    expect(failed.requests).toEqual([`GET ${ENDPOINT}`]);
    expect(failed.round).toMatchObject({ none: 1 });
    expect(failed.logged).toContainEqual(
      expect.objectContaining({ event: "kopje.link_cards.no_card", chain: "oembed", kind: "network" }),
    );
  });

  it("ignores a cached template whose expansion is past its bound or refused: the cold path", async () => {
    const long = `https://provider.example/o?url={url}&a={url}&b={url}&pad=${"p".repeat(OEMBED_TEMPLATE_BYTES - 120)}`;
    const { requests } = await claim({ [SITE]: page() }, (w) => cached(w, long));
    expect(requests).toEqual([`GET ${SITE}`]);
  });

  it("refuses a claim URL the sink refuses before any network or cache work", async () => {
    const w = await world();
    await sql(
      w.h.store,
      "INSERT INTO card_oembed_endpoints (domain, template, expires_at) VALUES ('site.example', ?, ?)",
      TEMPLATE,
      w.clock.t + 1000,
    );
    const id = await w.postLink("https://site.example:8443/a");
    expect(await w.round()).toMatchObject({ claimed: 1, none: 1 });
    expect(w.requests).toEqual([]);
    expect(w.checks).toEqual([]);
    expect(await w.row(id)).toBeUndefined();
  });

  it("the deadline passing during the endpoint chain leaves the claim unattempted, its endpoint cached", async () => {
    const w = await world();
    const reached = deferred();
    w.setRoutes({
      [SITE]: page(declaring()),
      [ENDPOINT]: async () => {
        reached.resolve();
        return new Promise<Response>(() => {});
      },
    });
    const id = await w.postLink(SITE);
    const start = w.clock.t;
    const running = w.round();
    await reached.promise;
    w.clock.t = start + CARD_FETCHES_MS + 1;
    expect(await running).toMatchObject({ claimed: 1, unattempted: 1 });
    expect(await w.row(id)).toMatchObject({ attempts: 0, fetched_at: null });
    expect(await cache(w)).toMatchObject([{ domain: "site.example", template: TEMPLATE }]);
  }, 30_000);
});

describe("the admission of each hop in either chain", () => {
  const ENDPOINT = "https://provider.example/oembed?url=https%3A%2F%2Fsite.example%2Fa";
  const DECLARING = `<title>Site title</title><link type="application/json+oembed" href="${ENDPOINT}">`;

  it("starts no endpoint request once maintenance is entered during chain 2's DNS check", async () => {
    const w = await world();
    const gate = deferred();
    const reached = deferred();
    w.setRoutes({
      [SITE]: page(DECLARING),
      [ENDPOINT]: () => new Response('{"version":"1.0","type":"link","title":"e"}'),
    });
    w.setCheckHost(async (url) => {
      if (url.hostname === "provider.example") {
        reached.resolve();
        await gate.promise;
      }
    });
    const id = await w.postLink(SITE);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const running = w.round();
    await reached.promise;
    await w.h.store.setMaintenance(BUILD, true);
    gate.resolve();
    expect(await running).toMatchObject({ claimed: 1, attached: 0, lost: 1 });
    error.mockRestore();
    expect(w.requests).toEqual([`GET ${SITE}`]);
    await w.h.store.setMaintenance(BUILD, false);
    expect(await w.row(id)).toMatchObject({ attempts: 1, fetched_at: null });
  });

  // The page's hop is admitted twice (calls 0 and 1), then the endpoint's (2 and 3).
  it.each([
    ["before", 2],
    ["after", 3],
  ])("releases a claim unattempted when a policy RPC of chain 2 fails %s its DNS check", async (_position, failing) => {
    const w = await world();
    w.setRoutes({
      [SITE]: page(DECLARING),
      [ENDPOINT]: () => new Response('{"version":"1.0","type":"link","title":"e"}'),
    });
    const id = await w.postLink(SITE);
    const store = w.wrapped("webHopRefused", (n, real) =>
      n === failing ? Promise.reject(new Error("policy unreadable")) : real(),
    );
    expect(await w.round(() => store)).toMatchObject({ claimed: 1, unattempted: 1, none: 0 });
    expect(w.requests).toEqual([`GET ${SITE}`]);
    expect(await w.row(id)).toMatchObject({ due_at: NOW, attempts: 0, fetched_at: null });
  });
});

describe("the stored embed and the oEmbed endpoint cache (0069_card_embeds)", () => {
  const fields = (extra: Partial<CardFields> = {}): CardFields => ({
    title: "Title",
    description: "",
    authorName: "",
    authorUrl: "",
    providerName: "",
    providerUrl: "",
    language: null,
    publishedAt: null,
    ...LINK,
    ...extra,
  });
  type Embed = {
    card_type: number;
    width: number;
    height: number;
    embed_src: string;
    iframe_width: number | null;
    iframe_height: number | null;
  };
  const embedOf = async (w: Awaited<ReturnType<typeof world>>, id: string) =>
    (
      await sql<Embed>(
        w.h.store,
        "SELECT card_type, width, height, embed_src, iframe_width, iframe_height FROM status_cards WHERE status_id = ?",
        id,
      )
    )[0];
  // `n` imported rows h<i>.example, live until `expires`.
  const imported = (w: Awaited<ReturnType<typeof world>>, n: number, expires: number) =>
    sql(
      w.h.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO card_oembed_endpoints (domain, template, expires_at) SELECT 'h' || i || '.example', ?2, ?3 FROM n`,
      n,
      TEMPLATE,
      expires,
    );

  it("stores a video, a photo and a link by the stored rules, a refused src as a link without iframe sizes", async () => {
    const w = await world();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(await w.postLink(`https://site${i}.example/`));
    }
    const claims = (await w.op(claimCards, { now: w.clock.t })).claims;
    const records: Partial<CardFields>[] = [
      {
        type: "video",
        width: 1280,
        height: 720,
        embedSrc: "https://v.example/e?a=1&b=2",
        iframeWidth: 560,
        iframeHeight: null,
      },
      { type: "video", width: 1, height: 2, embedSrc: 'https://v.example/"', iframeWidth: 560, iframeHeight: 315 },
      { type: "video", embedSrc: "", iframeWidth: 1 },
      { type: "photo", width: CARD_DIMENSION_MAX, height: CARD_DIMENSION_MAX + 1, embedSrc: "https://v.example/" },
      { type: "link", width: -1, height: 1.5, iframeWidth: 5 },
      { type: "rich" as never, width: 3, height: 4, embedSrc: "https://v.example/" },
    ];
    for (const [i, extra] of records.entries()) {
      expect(
        await w.op(recordCard, { ...claims[i]!, outcome: { kind: "card", fields: fields(extra) }, now: w.clock.t }),
      ).toEqual({
        held: true,
      });
    }
    const stored = await Promise.all(ids.map((id) => embedOf(w, id)));
    const none = { embed_src: "", iframe_width: null, iframe_height: null };
    expect(stored).toEqual([
      {
        card_type: 2,
        width: 1280,
        height: 720,
        embed_src: "https://v.example/e?a=1&b=2",
        iframe_width: 560,
        iframe_height: null,
      },
      { card_type: 0, width: 1, height: 2, ...none },
      { card_type: 0, width: 0, height: 0, ...none },
      { card_type: 1, width: CARD_DIMENSION_MAX, height: 0, ...none },
      { card_type: 0, width: 0, height: 0, ...none },
      { card_type: 0, width: 3, height: 4, ...none },
    ]);
  });

  it("resets the embed at an edit and copies it from a fresh donor", async () => {
    const w = await world();
    const first = await w.postLink(SITE);
    const [claim] = (await w.op(claimCards, { now: w.clock.t })).claims;
    const video = fields({
      type: "video",
      width: 4,
      height: 3,
      embedSrc: "https://v.example/",
      iframeWidth: 4,
      iframeHeight: 3,
    });
    await w.op(recordCard, { ...claim!, outcome: { kind: "card", fields: video }, now: w.clock.t });
    const embed = {
      card_type: 2,
      width: 4,
      height: 3,
      embed_src: "https://v.example/",
      iframe_width: 4,
      iframe_height: 3,
    };
    expect(await embedOf(w, first)).toEqual(embed);
    w.clock.t += 1000;
    const second = await w.postLink(SITE);
    expect(await w.op(claimCards, { now: w.clock.t })).toMatchObject({ attached: 1 });
    expect(await embedOf(w, second)).toEqual(embed);
    const response = await w.h.request(
      `/api/v1/statuses/${first}`,
      bearer(w.alice.token, json({ status: "again https://other.example/" }, { method: "PUT" })),
    );
    expect(response.status).toBe(200);
    expect(await embedOf(w, first)).toEqual({
      card_type: 0,
      width: 0,
      height: 0,
      embed_src: "",
      iframe_width: null,
      iframe_height: null,
    });
  });

  it("caches a cold claim’s endpoint with any held outcome, never one the fence refuses or the rules drop", async () => {
    const w = await world();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await w.postLink(`https://site${i}.example/`));
    }
    const claims = (await w.op(claimCards, { now: w.clock.t })).claims;
    const record = (
      i: number,
      outcome: Parameters<typeof recordCard.run>[1]["outcome"],
      endpoint: unknown,
      extra = {},
    ) => w.op(recordCard, { ...claims[i]!, outcome, endpoint: endpoint as never, now: w.clock.t, ...extra });
    await record(0, { kind: "card", fields: fields() }, { host: "a.example", template: TEMPLATE });
    await record(1, { kind: "none" }, { host: "b.example", template: TEMPLATE });
    await record(2, { kind: "unattempted" }, { host: "c.example", template: TEMPLATE });
    expect(await w.row(ids[2]!)).toMatchObject({ attempts: 0, fetched_at: null });
    // The fence refuses a stale token: nothing is cached.
    await record(3, { kind: "none" }, { host: "d.example", template: TEMPLATE }, { token: claims[3]!.token + 1 });
    // Refused by the stored rules, dropped without failing the record.
    for (const endpoint of [
      { host: "E.example", template: TEMPLATE },
      { host: "e.example", template: "https://provider.example/oembed?url=x" },
      { host: "e.example", template: `${TEMPLATE}\u0000` },
      { host: "e".repeat(254), template: TEMPLATE },
      { host: 7, template: TEMPLATE },
      "e.example",
    ]) {
      expect(await record(3, { kind: "unattempted" }, endpoint), JSON.stringify(endpoint)).toEqual({ held: true });
      const [again] = (await w.op(claimCards, { now: w.clock.t })).claims.filter((c) => c.statusId === ids[3]);
      claims[3] = again!;
    }
    const expires = w.clock.t + OEMBED_ENDPOINT_TTL_MS;
    expect(await cache(w)).toEqual(
      ["a.example", "b.example", "c.example"].map((domain) => ({ domain, template: TEMPLATE, expires_at: expires })),
    );
  });

  it("reads a live template for the claim URL’s host, within the TTL window", async () => {
    const w = await world();
    const now = w.clock.t;
    await sql(
      w.h.store,
      `INSERT INTO card_oembed_endpoints (domain, template, expires_at) VALUES
				('live.example', ?1, ?2), ('expired.example', ?1, ?3), ('future.example', ?1, ?4), ('www.live.example', ?1, ?2)`,
      TEMPLATE,
      now + 1,
      now,
      now + OEMBED_ENDPOINT_TTL_MS + 1,
    );
    for (const url of ["live.example/a", "expired.example/a", "future.example/a", "LIVE.example:443/b"]) {
      await w.postLink(`https://${url}`);
    }
    const claims = (await w.op(claimCards, { now })).claims;
    expect(claims.map((c) => [c.url, c.oembed])).toEqual([
      ["https://live.example/a", TEMPLATE],
      ["https://expired.example/a", null],
      ["https://future.example/a", null],
      ["https://live.example/b", TEMPLATE],
    ]);
  });

  it("keeps at most OEMBED_ENDPOINTS_MAX rows: a new host past them is dropped, a cached one replaced", async () => {
    const w = await world();
    await imported(w, OEMBED_ENDPOINTS_MAX, w.clock.t + 1000);
    const ids = [await w.postLink("https://a.example/"), await w.postLink("https://b.example/")];
    const claims = (await w.op(claimCards, { now: w.clock.t })).claims;
    await w.op(recordCard, {
      ...claims[0]!,
      outcome: { kind: "none" },
      endpoint: { host: "new.example", template: TEMPLATE },
      now: w.clock.t,
    });
    const replaced = "https://provider.example/o?u={url}";
    await w.op(recordCard, {
      ...claims[1]!,
      outcome: { kind: "none" },
      endpoint: { host: "h1.example", template: replaced },
      now: w.clock.t,
    });
    expect(await sql(w.h.store, "SELECT count(*) AS n FROM card_oembed_endpoints")).toEqual([
      { n: OEMBED_ENDPOINTS_MAX },
    ]);
    expect(
      await sql(w.h.store, "SELECT template FROM card_oembed_endpoints WHERE domain IN ('new.example', 'h1.example')"),
    ).toEqual([{ template: replaced }]);
    expect(ids).toHaveLength(2);
  });

  it(
    "expires at most OEMBED_EXPIRE_BATCH rows a claim, the expired first, then those past the window, by the index",
    { timeout: 60_000 },
    async () => {
      const w = await world();
      const now = w.clock.t;
      // 60 expired (h1..h60), 60 live, 60 written for past the window, by import.
      await sql(
        w.h.store,
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 180)
				INSERT INTO card_oembed_endpoints (domain, template, expires_at)
				SELECT printf('h%03d.example', i), ?1, CASE WHEN i <= 60 THEN ?2 - i WHEN i <= 120 THEN ?2 + i ELSE ?3 + i END FROM n`,
        TEMPLATE,
        now,
        now + OEMBED_ENDPOINT_TTL_MS,
      );
      const left = async () =>
        (await sql<{ domain: string }>(w.h.store, "SELECT domain FROM card_oembed_endpoints ORDER BY domain")).map(
          (r) => r.domain,
        );
      const name = (i: number) => `h${String(i).padStart(3, "0")}.example`;
      await w.op(claimCards, { now });
      // All 60 expired, then the 40 latest past the window.
      const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => name(from + i));
      expect(await left()).toEqual([...range(61, 120), ...range(121, 140)]);
      expect(OEMBED_EXPIRE_BATCH).toBe(100);
      await w.op(claimCards, { now });
      expect(await left()).toEqual(range(61, 120));
    },
  );

  it(
    "reads a bounded number of rows for the lookup, both expiry ends and the capacity, after ANALYZE and growth",
    { timeout: 120_000 },
    async () => {
      const w = await world();
      const now = w.clock.t;
      const grown = OEMBED_ENDPOINTS_MAX + 2;
      const statements = /card_oembed_endpoints/;
      const { before, after } = await staleStatistics(w.h, {
        settle: () => imported(w, 3, now + 1000),
        capture: async () => {
          await w.postLink("https://h1.example/a");
          const claimed = await plannedRun(w.h, statements, claimCards, { now });
          const [claim] = claimed.result.claims;
          expect(claim?.oembed).toBe(TEMPLATE);
          const recorded = await plannedRun(w.h, statements, recordCard, {
            ...claim!,
            outcome: { kind: "none" },
            endpoint: { host: "new.example", template: TEMPLATE },
            now,
          });
          await sql(w.h.store, "DELETE FROM card_oembed_endpoints WHERE domain = 'new.example'");
          return [...claimed.plans, ...recorded.plans];
        },
        grow: async () => {
          // Live rows to fill the table past its capacity, and a prefix of expired and far-future ones beyond what
          // one claim deletes.
          await sql(w.h.store, "DELETE FROM card_oembed_endpoints WHERE domain <> 'h1.example'");
          await sql(
            w.h.store,
            `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
						INSERT INTO card_oembed_endpoints (domain, template, expires_at)
						SELECT 'g' || i || '.example', ?2, CASE i % 3 WHEN 0 THEN ?3 - i WHEN 1 THEN ?3 + 1000 ELSE ?4 + i END FROM n`,
            3 * grown,
            TEMPLATE,
            now,
            now + OEMBED_ENDPOINT_TTL_MS,
          );
        },
      });
      for (const plans of [before, after]) {
        const by = (pattern: RegExp) => plans.find(({ query }) => pattern.test(query))!;
        const lookup = by(/SELECT CASE WHEN NOT/);
        const expired = by(/expires_at <= \?1 ORDER BY expires_at, domain/);
        const insert = by(/INSERT INTO card_oembed_endpoints/);
        for (const { query, plan } of [lookup, expired]) {
          expect(scansOf(plan, ["card_oembed_endpoints"]), `${query}\n${plan.join("\n")}`).toEqual([]);
        }
        expect(lookup.plan.join(" ")).toMatch(/SEARCH card_oembed_endpoints USING PRIMARY KEY \(domain=\?\)/);
        expect(expired.plan.join(" ")).toMatch(
          /USING (COVERING )?INDEX card_oembed_endpoints_expiry \(expires_at<\?\)/,
        );
        expect(lookup.rows).toBeLessThanOrEqual(1);
        expect(expired.rows).toBeLessThanOrEqual(4 * OEMBED_EXPIRE_BATCH);
        // Each delete reads its candidates by the index and each row it deletes (its key and its index entry):
        // a multiple of OEMBED_EXPIRE_BATCH, whatever the table holds. The capacity read: at most
        // OEMBED_ENDPOINTS_MAX index entries.
        expect(insert.rows).toBeLessThanOrEqual(OEMBED_ENDPOINTS_MAX + 2);
      }
      expect(await sql(w.h.store, "SELECT count(*) AS n FROM card_oembed_endpoints")).not.toEqual([{ n: 0 }]);
    },
  );

  it(
    "seeks the far end of the expiry by its index after ANALYZE and growth, deleting only the latest rows",
    { timeout: 120_000 },
    async () => {
      const w = await world();
      const now = w.clock.t;
      const expired = 40;
      const far = OEMBED_ENDPOINTS_MAX + 2;
      const farEnd = /expires_at > \?1 ORDER BY expires_at DESC/;
      const { before, after } = await staleStatistics(w.h, {
        settle: () => imported(w, 3, now + 1000),
        capture: async () => (await plannedRun(w.h, /card_oembed_endpoints/, claimCards, { now })).plans,
        grow: () =>
          // Fewer expired rows than a claim deletes, and more far-future ones than the writer's capacity.
          sql(
            w.h.store,
            `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 + ?2)
						INSERT INTO card_oembed_endpoints (domain, template, expires_at)
						SELECT printf('f%05d.example', i), ?3, CASE WHEN i <= ?1 THEN ?4 - i ELSE ?5 + i END FROM n`,
            expired,
            far,
            TEMPLATE,
            now,
            now + OEMBED_ENDPOINT_TTL_MS,
          ),
      });
      const [plan] = after.filter(({ query }) => farEnd.test(query));
      expect(plan, after.map(({ query }) => query).join("\n")).toBeDefined();
      expect(scansOf(plan!.plan, ["card_oembed_endpoints"]), plan!.plan.join("\n")).toEqual([]);
      expect(plan!.plan.join(" ")).toMatch(/USING (COVERING )?INDEX card_oembed_endpoints_expiry \(expires_at>\?\)/);
      expect(plan!.rows).toBeLessThanOrEqual(4 * OEMBED_EXPIRE_BATCH);
      expect(before.some(({ query }) => farEnd.test(query))).toBe(true);
      // All the expired rows, then the latest OEMBED_EXPIRE_BATCH - 40 of the far-future ones; the live ones kept.
      const left = await sql<{ expired: number; far: number; live: number; first: string; last: string }>(
        w.h.store,
        `SELECT sum(expires_at <= ?1) AS expired, sum(expires_at > ?2) AS far, sum(domain GLOB 'h*') AS live,
					min(CASE WHEN expires_at > ?2 THEN domain END) AS first, max(CASE WHEN expires_at > ?2 THEN domain END) AS last
				FROM card_oembed_endpoints`,
        now,
        now + OEMBED_ENDPOINT_TTL_MS,
      );
      const name = (i: number) => `f${String(i).padStart(5, "0")}.example`;
      expect(left).toEqual([
        {
          expired: 0,
          far: far - (OEMBED_EXPIRE_BATCH - expired),
          live: 3,
          first: name(expired + 1),
          last: name(expired + far - (OEMBED_EXPIRE_BATCH - expired)),
        },
      ]);
    },
  );
});

describe("the bounds of a round", () => {
  it("derives its budgets and hold", () => {
    expect([CARD_SUBREQUESTS, CARD_STORE_CALLS, CARD_ADMISSIONS, CARD_OWN_STORE_CALLS]).toEqual([144, 48, 48, 7]);
    // 48 requests and 96 DNS lookups; 48 policy reads before and 48 after the DNS checks.
    expect(CARD_SUBREQUESTS).toBe(CARD_ROUND_CLAIMS * CARD_CHAINS * (WEB_PAGE_MAX_REDIRECTS + 1) * 3);
    expect(CARD_HOLD_MS).toBeGreaterThanOrEqual(2 * CARD_ROUND_MS);
    expect(CARD_ROUND_CLAIMS * CARD_DAY_ROUNDS).toBe(1728);
    expect(CARD_ROUND_CLAIMS * CARD_CHAINS * CARD_DAY_ROUNDS).toBe(3456);
    // The chains, CARD_CONCURRENCY at a time, each at the sink's timeout: 40 s within the 50 s window.
    const chainsMs = Math.ceil(CARD_ROUND_CLAIMS / CARD_CONCURRENCY) * CARD_CHAINS * WEB_PAGE_TIMEOUT_MS;
    expect({ concurrency: CARD_CONCURRENCY, chains: CARD_CHAINS, chainsMs, window: CARD_FETCHES_MS }).toEqual({
      concurrency: 3,
      chains: 2,
      chainsMs: 40_000,
      window: 50_000,
    });
    expect(CARD_OEMBED_BODY_LIMIT).toBe(65_536);
  });

  // The memory model of one claim, held CARD_CONCURRENCY times at once: test/memory-model.ts.
  it("computes the memory model of a round from its bounds", () => {
    const { scriptParsed, page, documentParsed, retained, oembed, claim } = linkCardRoundMemory();
    expect({ scriptParsed, page, documentParsed, retained, oembed, claim, round: CARD_CONCURRENCY * claim }).toEqual({
      scriptParsed: 393_208,
      page: 2_773_112,
      documentParsed: 786_424,
      retained: 9_239,
      oembed: 1_205_335,
      claim: 2_773_112,
      round: 8_319_336,
    });
    // The links' share of the page phase: 64 links at their bounds, two bytes a unit.
    expect(2 * (CARD_OUTPUT_MAX_UNITS - outputMaxUnits({ ...SCAN_LIMITS, relMe: 0, links: 0 }))).toBe(409_600);
  });

  it("walks at most CARD_CLAIM_WALK due rows, deleting each one given up, the 65th left for the next claim", async () => {
    const w = await world();
    const ids: string[] = [];
    for (let i = 0; i < CARD_CLAIM_WALK + 1; i++) {
      ids.push(await w.postLink(`https://site.example/${i}`));
    }
    await sql(w.h.store, "UPDATE status_cards SET attempts = 2");
    const claim = () =>
      plannedRun(w.h, /FROM status_cards INDEXED BY status_cards_due WHERE due_at <= \?1\s+ORDER BY/, claimCards, {
        now: w.clock.t,
      });
    const first = await claim();
    expect(first.result).toMatchObject({ givenUp: CARD_CLAIM_WALK, claims: [] });
    expect(first.plans[0]?.rows).toBe(CARD_CLAIM_WALK);
    expect(await w.row(ids.at(-1)!)).toMatchObject({ attempts: 2 });
    expect((await claim()).result).toMatchObject({ givenUp: 1 });
    expect(await sql(w.h.store, "SELECT count(*) AS n FROM status_cards")).toEqual([{ n: 0 }]);
  });

  it("expires at most CARD_EXPIRE_BATCH rows a claim", { timeout: 60_000 }, async () => {
    const w = await world();
    const status = await w.postLink(SITE);
    // Expired rows of statuses of their own, due far later, so only the expiry reads them.
    await sql(
      w.h.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			SELECT printf('7%017d', i), 'https://kopje.test/s/' || i, ?2, 'public', 'x', '2026-10-12T00:00:00.000Z' FROM n`,
      CARD_EXPIRE_BATCH + 1,
      w.alice.id,
    );
    await sql(
      w.h.store,
      `INSERT INTO status_cards (status_id, url, due_at, enqueued_at, generation)
			SELECT id, 'https://site.example/old', ?1, 0, 1 FROM statuses WHERE id GLOB '7*'`,
      NOW + 10 * CARD_EXPIRE_MS,
    );
    w.clock.t = NOW + CARD_EXPIRE_MS - 1;
    const first = await w.op(claimCards, { now: w.clock.t });
    expect(first).toMatchObject({ expired: CARD_EXPIRE_BATCH });
    expect(
      await sql(w.h.store, "SELECT count(*) AS n FROM status_cards WHERE url = 'https://site.example/old'"),
    ).toEqual([{ n: 1 }]);
    expect((await w.op(claimCards, { now: w.clock.t })).expired).toBe(1);
    expect(await w.row(status)).toMatchObject({ attempts: 1 });
  });

  it("deletes a row whose next token would pass SAFE_INTEGER_MAX, and claims one that reaches it", async () => {
    const w = await world();
    const full = await w.postLink("https://site.example/full");
    const last = await w.postLink("https://site.example/last");
    await sql(
      w.h.store,
      "UPDATE status_cards SET claim = ?, generation = ? WHERE status_id = ?",
      SAFE_INTEGER_MAX,
      SAFE_INTEGER_MAX,
      full,
    );
    await sql(w.h.store, "UPDATE status_cards SET claim = ? WHERE status_id = ?", SAFE_INTEGER_MAX - 1, last);
    const claimed = await w.op(claimCards, { now: w.clock.t });
    expect(claimed.claims).toEqual([
      {
        statusId: last,
        token: SAFE_INTEGER_MAX,
        generation: expect.any(Number),
        url: "https://site.example/last",
        oembed: null,
      },
    ]);
    expect(await w.row(full)).toBeUndefined();
  });

  it(
    "reads a bounded number of rows for each lookup by URL, after ANALYZE and growth, hit and miss",
    { timeout: 120_000 },
    async () => {
      const w = await world();
      const hit = await w.postLink(SITE);
      const grown = 5_000;
      const statuses = (prefix: string) =>
        sql(
          w.h.store,
          `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				SELECT printf('${prefix}%017d', i), 'https://kopje.test/s/${prefix}' || i, ?2, 'public', 'x',
					'2026-10-12T00:00:00.000Z' FROM n`,
          grown,
          w.alice.id,
        );
      const statements = /status_cards/;
      const { before, after } = await staleStatistics(w.h, {
        capture: async () => {
          // The hit row first in the walk's order, ahead of the grown rows.
          await sql(w.h.store, "UPDATE status_cards SET claim = 0, attempts = 0, due_at = 0 WHERE status_id = ?", hit);
          return (await plannedRun(w.h, statements, claimCards, { now: w.clock.t })).plans;
        },
        grow: async () => {
          // A large prefix of expired holds and stale copies of the same URL, and many other pending rows due later.
          await statuses("8");
          await statuses("9");
          await sql(
            w.h.store,
            `INSERT INTO status_cards (status_id, url, due_at, enqueued_at, generation, claim, attempts)
					SELECT id, ?1, ?2, ?2, 1, 1, 1 FROM statuses WHERE id GLOB '8*'`,
            SITE,
            NOW - 1,
          );
          await sql(
            w.h.store,
            `INSERT INTO status_cards (status_id, url, enqueued_at, generation, title, fetched_at)
					SELECT id, ?1, 0, 1, 't', ?2 FROM statuses WHERE id GLOB '9*'`,
            SITE,
            NOW - CARD_FRESH_MS - 1,
          );
        },
      });
      for (const plans of [before, after]) {
        for (const { query, plan } of plans) {
          expect(
            scansOf(plan, ["status_cards", "t", "f", "h", "ce", "cm", "cq", "pl", "pa", "ps"]),
            `${query}\n${plan.join("\n")}`,
          ).toEqual([]);
        }
        // The hit row's two lookups, the first of the walk.
        const lookups = plans.filter(({ query }) => /CROSS JOIN status_cards [fh] INDEXED BY/.test(query)).slice(0, 2);
        expect(lookups.map(({ query }) => query.includes("status_cards_fresh"))).toEqual([true, false]);
        // The miss of each lookup reads its target row and no holder or donor: the expired holds and stale copies of
        // the URL are not met (a range seek on due_at and on fetched_at).
        expect(lookups.map(({ rows }) => rows)).toEqual([4, 2]);
      }
      // Hits: the 'after' walk claimed six of the grown rows, so their holds are open; then a copy is made fresh.
      const first = async () => {
        await sql(w.h.store, "UPDATE status_cards SET claim = 0, attempts = 0, due_at = 0 WHERE status_id = ?", hit);
        const run = await plannedRun(w.h, /CROSS JOIN status_cards [fh] INDEXED BY/, claimCards, { now: w.clock.t });
        return run.plans.slice(0, 2).map(({ query, rows }) => [query.includes("status_cards_fresh"), rows]);
      };
      expect(await first()).toEqual([
        [true, 4],
        [false, 2],
      ]);
      expect(await w.row(hit)).toMatchObject({ due_at: NOW + CARD_HOLD_MS, attempts: 0 });
      await sql(
        w.h.store,
        "UPDATE status_cards SET fetched_at = ?1 WHERE status_id = (SELECT min(id) FROM statuses WHERE id GLOB '9*')",
        NOW,
      );
      expect((await first()).slice(0, 1)).toEqual([[true, 5]]);
      expect(await w.row(hit)).toMatchObject({ due_at: null, fetched_at: NOW, title: "t" });
    },
  );
});

describe("the cron", () => {
  it("runs the round outside the env maintenance only, and logs a failed one", async () => {
    const { scheduledLinkCards } = await import("../src/jobs/scheduled");
    const w = await world();
    w.setRoutes({ [SITE]: page() });
    const id = await w.postLink(SITE);
    const deps = (store: StoreStub = w.h.store): LinkCardsDeps => ({
      build: () => BUILD,
      store: () => store,
      now: () => w.clock.t,
      keygen: () => Promise.reject(new Error("no keys")),
      loader: { fetch: (input, init) => globalThis.fetch(input, init), checkHost: () => Promise.resolve() },
    });
    await scheduledLinkCards({ ...w.h.env, MAINTENANCE: "on" } as unknown as Env, deps());
    expect(await w.row(id)).toMatchObject({ attempts: 0 });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = w.wrapped("claimCards", () => Promise.reject(new Error("boom")));
    await scheduledLinkCards({ ...w.h.env, MAINTENANCE: "off" } as unknown as Env, deps(failing));
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: "kopje.scheduled.link_cards_failed" }));
    error.mockRestore();
  });
});

describe("the trend identity of a card (0071_link_trends: link_type, final_url, public)", () => {
  type Identity = { link_type: number; final_url: string; public: number; fetched_at: number | null; title: string };
  const identity = async (w: Awaited<ReturnType<typeof world>>, id: string) =>
    (
      await sql<Identity>(
        w.h.store,
        "SELECT link_type, final_url, public, fetched_at, title FROM status_cards WHERE status_id = ?",
        id,
      )
    )[0];
  const ARTICLE = '<html><head><title>Article</title><meta property="og:type" content="article"></head></html>';
  const moved = (location: string) => () => new Response(null, { status: 301, headers: { location } });

  it("stores the page after redirects as the final URL, and none past the stored rule, attaching both", async () => {
    const w = await world();
    const [plain, redirected, refused] = ["https://site.example/a", "https://site.example/r", "https://site.example/p"];
    w.setRoutes({
      [plain]: page(ARTICLE),
      [redirected]: moved("https://site.example/after"),
      "https://site.example/after": page(),
      [refused]: moved("https://site.example/b|c"),
      "https://site.example/b|c": page(),
    });
    const ids = [await w.postLink(plain), await w.postLink(redirected), await w.postLink(refused)];
    expect(await w.round()).toMatchObject({ claimed: 3, attached: 3, lost: 0 });
    expect(await identity(w, ids[0]!)).toMatchObject({ link_type: 1, final_url: plain, public: 1 });
    expect(await identity(w, ids[1]!)).toMatchObject({
      link_type: 0,
      final_url: "https://site.example/after",
      public: 1,
    });
    // The refused final URL fails closed: no trend identity, the card attached as its twins are.
    expect(await identity(w, ids[2]!)).toMatchObject({
      final_url: "",
      public: 0,
      title: "Site title",
      fetched_at: NOW,
    });
  });

  it("sets public from the status: an unlisted status keeps its final URL and is never public", async () => {
    const w = await world();
    w.setRoutes({ [SITE]: page(ARTICLE) });
    const id = await w.postLink(SITE, { visibility: "unlisted" });
    expect(await w.round()).toMatchObject({ attached: 1 });
    expect(await identity(w, id)).toMatchObject({ link_type: 1, final_url: SITE, public: 0 });
  });

  it("takes the cold path's page for an oEmbed card (unknown), and the claim URL when a cached endpoint answers", async () => {
    const ENDPOINT = "https://provider.example/oembed?url=https%3A%2F%2Fsite.example%2Fa&format=json";
    const DOC = JSON.stringify({ version: "1.0", type: "link", title: "Embed title" });
    // Cold: the claim redirects to the article page, which declares the endpoint.
    const cold = await world();
    const declaring = `<html><head><title>t</title><meta property="og:type" content="article">
			<link rel="alternate" type="application/json+oembed" href="${ENDPOINT.replaceAll("&", "&amp;")}"></head></html>`;
    cold.setRoutes({
      [SITE]: moved("https://site.example/final"),
      "https://site.example/final": page(declaring),
      [ENDPOINT]: () => new Response(DOC),
    });
    const coldId = await cold.postLink(SITE);
    expect(await cold.round()).toMatchObject({ attached: 1 });
    expect(await identity(cold, coldId)).toMatchObject({
      title: "Embed title",
      link_type: 0,
      final_url: "https://site.example/final",
      public: 1,
    });
    // Cached: the endpoint answers and no page is fetched.
    const warm = await world();
    await sql(
      warm.h.store,
      "INSERT INTO card_oembed_endpoints (domain, template, expires_at) VALUES ('site.example', ?, ?)",
      TEMPLATE,
      warm.clock.t + 1000,
    );
    warm.setRoutes({ [ENDPOINT]: () => new Response(DOC) });
    const warmId = await warm.postLink(SITE);
    expect(await warm.round()).toMatchObject({ attached: 1 });
    expect(warm.requests).toEqual([`GET ${ENDPOINT}`]);
    expect(await identity(warm, warmId)).toMatchObject({
      title: "Embed title",
      link_type: 0,
      final_url: SITE,
      public: 1,
    });
    // Cached, falling back to the page: the page's final URL.
    const fallback = await world();
    await sql(
      fallback.h.store,
      "INSERT INTO card_oembed_endpoints (domain, template, expires_at) VALUES ('site.example', ?, ?)",
      TEMPLATE,
      fallback.clock.t + 1000,
    );
    fallback.setRoutes({
      [ENDPOINT]: () => new Response(DOC, { status: 404 }),
      [SITE]: moved("https://site.example/final"),
      "https://site.example/final": page(ARTICLE),
    });
    const fallbackId = await fallback.postLink(SITE);
    expect(await fallback.round()).toMatchObject({ attached: 1 });
    expect(await identity(fallback, fallbackId)).toMatchObject({
      title: "Article",
      link_type: 1,
      final_url: "https://site.example/final",
      public: 1,
    });
  });

  it("copies the donor's link type and final URL, never its public: the target's status decides", async () => {
    const w = await world();
    w.setRoutes({ [SITE]: page(ARTICLE) });
    const donor = await w.postLink(SITE);
    expect(await w.round()).toMatchObject({ attached: 1 });
    const unlisted = await w.postLink(SITE, { visibility: "unlisted" });
    const listed = await w.postLink(SITE);
    w.requests.length = 0;
    expect(await w.op(claimCards, { now: w.clock.t })).toMatchObject({ attached: 2, claims: [] });
    expect(w.requests).toEqual([]);
    expect(await identity(w, donor)).toMatchObject({ link_type: 1, final_url: SITE, public: 1 });
    expect(await identity(w, unlisted)).toMatchObject({ link_type: 1, final_url: SITE, public: 0, title: "Article" });
    expect(await identity(w, listed)).toMatchObject({ link_type: 1, final_url: SITE, public: 1, title: "Article" });
  });

  it("copies a donor fetched before 0071 (no final URL) as not public, and completes the claims of the batch", async () => {
    const w = await world();
    w.setRoutes({ [SITE]: page(ARTICLE), "https://other.example/": page(ARTICLE) });
    const donor = await w.postLink(SITE);
    expect(await w.round()).toMatchObject({ attached: 1 });
    // The donor as a row from before 0071 holds it: unknown, no final URL, not public.
    await sql(
      w.h.store,
      "UPDATE status_cards SET link_type = 0, final_url = '', public = 0 WHERE status_id = ?",
      donor,
    );
    const copy = await w.postLink(SITE);
    const other = await w.postLink("https://other.example/");
    const claimed = await w.op(claimCards, { now: w.clock.t });
    expect(claimed).toMatchObject({ attached: 1 });
    expect(claimed.claims.map((c) => c.statusId)).toEqual([other]);
    expect(await identity(w, copy)).toMatchObject({ link_type: 0, final_url: "", public: 0, title: "Article" });
    expect((await identity(w, copy))?.fetched_at).not.toBeNull();
  });

  it("resets link_type, final_url and public on enqueue", async () => {
    const w = await world();
    w.setRoutes({ [SITE]: page(ARTICLE) });
    const id = await w.postLink(SITE);
    expect(await w.round()).toMatchObject({ attached: 1 });
    expect(await identity(w, id)).toMatchObject({ link_type: 1, final_url: SITE, public: 1 });
    await runInDurableObject(w.h.store, (_instance, s) => {
      enqueueCard(new Db(s.storage.sql), id, "https://site.example/next", w.clock.t);
    });
    expect(await identity(w, id)).toMatchObject({ link_type: 0, final_url: "", public: 0, fetched_at: null });
  });
});
