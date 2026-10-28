import { runInDurableObject } from "cloudflare:test";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Page, PageQuery } from "../src/domain/accounts";
import { type Notification, listNotifications } from "../src/domain/notifications";
import type { Status } from "../src/domain/status-presenter";
import { statusContext } from "../src/domain/statuses";
import { accountStatuses, homeTimeline, listTimeline, publicTimeline, tagTimeline } from "../src/domain/timelines";
import type { StoreStub } from "../src/platform/store-client";
import type { StoreOperation } from "../src/platform/store-kernel";
import { migratedStore } from "./helpers";
import { accountId, listId, runs, statusId, type World, worldArb, writeWorld } from "./policy-world";

// Filters on generated worlds (docs/visibility.md, "Filters"): each local viewer's read endpoints run before and after
// the viewer gets random filters. The output must be the unfiltered one, page after page (filters remove nothing; the
// client decides by context), and each status's `filtered` must name exactly the viewer's active filters that match it
// (a model of keyword and status matching below), whatever their context and action; a boost and its original report
// the same; nothing in `filtered` names a status other than the one it is on or its original, which the read rule let
// the viewer see (the unfiltered output is checked by the endpoint oracle); expired filters never match.

const CASES = 60;
const LIMIT = 3;
const PRESENT = { origin: "https://kopje.test" };
const CONTEXTS = ["home", "notifications", "public", "thread", "account"] as const;
type Context = (typeof CONTEXTS)[number];

type ModelFilter = {
  owner: number;
  contexts: Context[];
  action: "warn" | "hide" | "blur";
  expired: boolean;
  // Keywords on a status's text, `status <n>`: whole_word compares the whole number, otherwise a prefix of the digits.
  keywords: { n: number; wholeWord: boolean }[];
  statuses: number[];
};

type Case = {
  world: World;
  filters: ModelFilter[];
  notifications: { recipient: number; from: number; status: number }[];
};

const caseArb: fc.Arbitrary<Case> = fc
  .record({
    world: worldArb,
    filters: fc.array(
      fc.record({
        owner: fc.nat(),
        contexts: fc.subarray([...CONTEXTS], { minLength: 1 }),
        action: fc.constantFrom("warn" as const, "hide" as const, "blur" as const),
        expired: fc.boolean(),
        keywords: fc.array(fc.record({ n: fc.nat({ max: 25 }), wholeWord: fc.boolean() }), { maxLength: 3 }),
        statuses: fc.array(fc.nat(), { maxLength: 3 }),
      }),
      { maxLength: 8 },
    ),
  })
  .map(({ world, filters }) => {
    const locals = world.accounts.flatMap((account, x) => (account.local ? [x] : []));
    const pick = (items: readonly number[], n: number) => items[n % Math.max(items.length, 1)];
    const statuses = world.statuses.map((_, s) => s);
    return {
      world,
      filters: filters.flatMap((f) => {
        const owner = pick(locals, f.owner);
        return owner === undefined
          ? []
          : [{ ...f, owner, statuses: [...new Set(f.statuses.flatMap((s) => pick(statuses, s) ?? []))] }];
      }),
      // A favourite notification of every status, from its author, to every other local account: the
      // notifications endpoint then has the statuses the filters match, whatever the seed.
      notifications: locals.flatMap((recipient) =>
        world.statuses.flatMap((status, s) =>
          status.author === recipient ? [] : [{ recipient, from: status.author, status: s }],
        ),
      ),
    };
  });

const tokenOf = (x: number) => `policy-filters-${x}`;
const filterId = (i: number) => String(750000000000000000n + BigInt(i));

function writeFilters(sql: SqlStorage, c: Case): void {
  const now = Date.parse(c.world.now);
  c.filters.forEach((f, i) => {
    sql.exec(
      "INSERT INTO filters (id, account_id, title, context, action, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      filterId(i),
      accountId(f.owner),
      `f${i}`,
      JSON.stringify(f.contexts),
      f.action,
      new Date(now + (f.expired ? -60_000 : 3_600_000)).toISOString(),
    );
    f.keywords.forEach((k, j) => {
      sql.exec(
        "INSERT INTO filter_keywords (id, filter_id, keyword, whole_word) VALUES (?, ?, ?, ?)",
        String(760000000000000000n + BigInt(i * 10 + j)),
        filterId(i),
        `STATUS ${k.n}`,
        k.wholeWord ? 1 : 0,
      );
    });
    f.statuses.forEach((s, j) => {
      sql.exec(
        "INSERT INTO filter_statuses (id, filter_id, status_id) VALUES (?, ?, ?)",
        String(770000000000000000n + BigInt(i * 10 + j)),
        filterId(i),
        statusId(s),
      );
    });
  });
}

// The active filters of `viewer` that match the status `s` (CustomFilter.apply_cached_filters), by index.
function matching(c: Case, viewer: number, s: number): number[] {
  const proper = c.world.statuses[s]?.reblogOf ?? s;
  const text = `status ${proper}`;
  return c.filters.flatMap((f, i) => {
    if (f.owner !== viewer || f.expired) {
      return [];
    }
    const keyword = f.keywords.some((k) => (k.wholeWord ? proper === k.n : text.includes(`status ${k.n}`)));
    const named = f.statuses.includes(s) || f.statuses.includes(proper);
    return keyword || named ? [i] : [];
  });
}

const shown = new Set<string>();

describe("filters on generated worlds", () => {
  let store: StoreStub;
  beforeAll(async () => {
    store = await migratedStore();
    await runInDurableObject(store, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('filters', 'secret', 'filters', 'urn:ietf:wg:oauth:2.0:oob', 'read')",
      );
    });
  });

  afterAll(() => {
    // Each endpoint reported a hide filter and another filter in some case, so the property cannot pass vacuously.
    const endpoints = ["home", "list", "public", "tag", "account statuses", "context", "notifications"];
    expect([...shown].sort()).toEqual(endpoints.flatMap((e) => [`${e} hide`, `${e} other`]).sort());
  });

  it("removes nothing, and reports every active filter that matches each status", async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, async (c) => {
        const problems = await runInDurableObject(store, (_instance, state) => check(state.storage.sql, c));
        expect(problems).toEqual([]);
      }),
      runs(CASES, 20261015),
    );
  }, 120_000);
});

type Read = { name: string; read: (viewer: number, page: PageQuery) => Page<Status> | null };

function check(sql: SqlStorage, c: Case): string[] {
  const { world } = c;
  sql.exec("DELETE FROM oauth_tokens");
  sql.exec("DELETE FROM filters");
  sql.exec("DELETE FROM notifications");
  writeWorld(sql, world);
  world.accounts.forEach((account, x) => {
    if (account.local) {
      sql.exec(
        "INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'filters', ?, 'read')",
        tokenOf(x),
        accountId(x),
      );
    }
  });
  for (const n of c.notifications) {
    sql.exec(
      "INSERT OR IGNORE INTO notifications (account_id, type, from_account_id, status_id) VALUES (?, 'favourite', ?, ?)",
      accountId(n.recipient),
      accountId(n.from),
      statusId(n.status),
    );
  }
  const now = Date.parse(world.now);
  const problems: string[] = [];
  const indexOf = new Map(world.statuses.map((_, s) => [statusId(s), s]));
  const run = <T>(operation: StoreOperation<never, unknown>, input: unknown): T => {
    const result = operation.run(sql, input as never) as { status: string; value?: T };
    if (result.status !== "ok") {
      throw new Error(`not authorized: ${result.status}`);
    }
    return result.value as T;
  };
  const credentialOf = (viewer: number) => ({ tokenHash: tokenOf(viewer), scope: "read", now }) as const;
  const base = (viewer: number) => ({ credential: credentialOf(viewer), now, present: PRESENT });
  const timeline = { local: false, remote: false, onlyMedia: false };
  const accountInput = { onlyMedia: false, excludeReplies: false, excludeReblogs: false, pinned: false, tagged: null };

  const reads: Read[] = [
    { name: "home", read: (v, page) => run(homeTimeline, { ...base(v), page }) },
    { name: "public", read: (v, page) => run(publicTimeline, { ...base(v), ...timeline, page }) },
    {
      name: "tag",
      read: (v, page) => run(tagTimeline, { ...base(v), ...timeline, tag: "cats", any: [], all: [], none: [], page }),
    },
    ...world.accounts.map((_, x): Read => ({
      name: "account statuses",
      read: (v, page) => run(accountStatuses, { ...base(v), ...accountInput, account: accountId(x), page }),
    })),
    ...world.lists.map((list, l): Read => ({
      name: "list",
      read: (v, page) => (v === list.owner ? run(listTimeline, { ...base(v), id: listId(l), page }) : null),
    })),
  ];

  // Every page, LIMIT at a time, older pages from the oldest cursor of the rows each page read.
  const pages = (read: (page: PageQuery) => Page<Status> | null): Status[] => {
    const items: Status[] = [];
    let maxId: string | undefined;
    for (let i = 0; i < 64; i++) {
      const page = read(maxId === undefined ? { limit: LIMIT } : { limit: LIMIT, maxId });
      if (page === null || page.oldest === null) {
        break;
      }
      items.push(...page.items);
      maxId = page.oldest;
    }
    return items;
  };

  const viewers = world.accounts.flatMap((account, x) => (account.local && !account.suspended ? [x] : []));
  const ids = (statuses: Status[]) => statuses.map((status) => status.id);
  const before = new Map<string, Status[]>();
  const notificationsBefore = new Map<number, Notification[]>();
  const contextBefore = new Map<string, Status[]>();
  const contextOf = (v: number, s: number) => {
    const result = run<{ status: string; value?: { ancestors: Status[]; descendants: Status[] } }>(statusContext, {
      ...base(v),
      id: statusId(s),
    });
    return result.status === "ok" && result.value !== undefined
      ? [...result.value.ancestors, ...result.value.descendants]
      : [];
  };
  const notificationsOf = (v: number) =>
    run<Page<Notification>>(listNotifications, {
      ...base(v),
      page: { limit: 100 },
      types: [],
      excludeTypes: [],
      accountId: null,
    }).items;
  for (const v of viewers) {
    reads.forEach((r, i) =>
      before.set(
        `${v} ${i}`,
        pages((page) => r.read(v, page)),
      ),
    );
    notificationsBefore.set(v, notificationsOf(v));
    world.statuses.forEach((_, s) => contextBefore.set(`${v} ${s}`, contextOf(v, s)));
  }

  writeFilters(sql, c);

  // The same statuses as unfiltered, each with `filtered` as the model has it.
  const compare = (name: string, v: number, was: Status[], now: Status[]) => {
    if (JSON.stringify(ids(now)) !== JSON.stringify(ids(was))) {
      problems.push(`${name} of ${v}: shows [${ids(now).join(" ")}], unfiltered [${ids(was).join(" ")}]`);
    }
    for (const status of now) {
      const s = indexOf.get(status.id) ?? -1;
      const want = matching(c, v, s).map(filterId);
      const results = status.filtered ?? [];
      const got = results.map((r) => r.filter.id);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        problems.push(`${name} of ${v}: status ${s} filtered by [${got.join(" ")}], the model [${want.join(" ")}]`);
      }
      for (const r of results) {
        shown.add(`${name} ${r.filter.filter_action === "hide" ? "hide" : "other"}`);
      }
      const own = new Set([status.id, ...(status.reblog === null ? [] : [status.reblog.id])]);
      for (const r of results) {
        if ((r.status_matches ?? []).some((id) => !own.has(id))) {
          problems.push(`${name} of ${v}: status ${s} reports status matches ${JSON.stringify(r.status_matches)}`);
        }
      }
      if (status.reblog !== null && JSON.stringify(status.reblog.filtered) !== JSON.stringify(status.filtered)) {
        problems.push(`${name} of ${v}: boost ${s} and its original report different results`);
      }
    }
  };

  for (const v of viewers) {
    reads.forEach((r, i) =>
      compare(
        r.name,
        v,
        before.get(`${v} ${i}`) ?? [],
        pages((page) => r.read(v, page)),
      ),
    );
    world.statuses.forEach((_, s) => compare("context", v, contextBefore.get(`${v} ${s}`) ?? [], contextOf(v, s)));
    const was = notificationsBefore.get(v) ?? [];
    const nowNotifications = notificationsOf(v);
    if (JSON.stringify(nowNotifications.map((n) => n.id)) !== JSON.stringify(was.map((n) => n.id))) {
      problems.push(`notifications of ${v}: differ from the unfiltered ones`);
    }
    compare(
      "notifications",
      v,
      was.flatMap((n) => (n.status === undefined ? [] : [n.status])),
      nowNotifications.flatMap((n) => (n.status === undefined ? [] : [n.status])),
    );
  }
  return problems;
}
