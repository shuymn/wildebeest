import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { listFollowRequests, type PageQuery } from "../src/domain/accounts";
import { listBlocks, listDomainBlocks, listMutes } from "../src/domain/blocks";
import { deliveriesReport } from "../src/domain/deliveries";
import { listScheduled } from "../src/domain/scheduled-statuses";
import type { StoreStub } from "../src/platform/store-client";
import type { StoreOperation } from "../src/platform/store-kernel";
import { NOW } from "./app-helpers";
import { migratedStore } from "./helpers";
import { watchedCursor } from "./read-helpers";

// Cursor ranges are direct ranges (docs/visibility.md "Read bounds"; test-node/range-predicates.test.ts keeps the
// nullable form out of src). Paging keeps Mastodon's max_id, since_id and min_id with or without a cursor, and a read
// with an index ending in its id seeks its cursor there, so a page below a cursor reads the same rows however many
// newer rows the list holds. Blocks, mutes and domain blocks have no such index (their pair indexes order by target):
// they read all of the viewer's rows and sort them, the plan recorded below, until one is added.

const PRESENT = { origin: "https://kopje.test" };
const TOKEN = "range-predicates-token";
const credential = { tokenHash: TOKEN, scope: "read", now: NOW } as const;
const VIEWER = "900000000000000001";
const TARGET = 500000000000000000n;
const SCHEDULED = 100000000000000000n;

// Row i (0 the oldest) of each list: its paging cursor and the item a page shows for it. The INTEGER ids are i + 1
// (each table starts empty); the scheduled statuses' TEXT ids follow SCHEDULED.
const target = (i: number) => String(TARGET + BigInt(i));
const integerCursor = (i: number) => String(i + 1);
const scheduledCursor = (i: number) => String(SCHEDULED + BigInt(i));

type Read = {
  name: string;
  operation: StoreOperation<never, unknown>;
  input: (page: PageQuery) => unknown;
  items: (output: unknown) => string[];
  item: (i: number) => string;
  cursor: (i: number) => string;
  // The statement that reads the page, and its access to the paged table, the same with and without a cursor.
  statement: RegExp;
  access: string;
  // The plan sorts the viewer's rows (no index ends in the id): left out of the growth case.
  sorts?: boolean;
  // deliveriesReport pages by `before` only (max_id).
  maxOnly?: boolean;
};

function answerOf(output: unknown): Record<string, unknown> {
  let value = output as Record<string, unknown>;
  while (value.status === "ok" && "value" in value) {
    value = value.value as Record<string, unknown>;
  }
  return value;
}

const pageItems = (output: unknown) =>
  (answerOf(output).items as ({ id: string } | string)[]).map((x) => (typeof x === "string" ? x : x.id));

const READS: Read[] = [
  {
    name: "blocks",
    operation: listBlocks,
    input: (page) => ({ credential, page, present: PRESENT }),
    items: pageItems,
    item: target,
    cursor: integerCursor,
    statement: /FROM blocks b /,
    access: "SEARCH b USING COVERING INDEX blocks_pair (account_id=?)",
    sorts: true,
  },
  {
    name: "mutes",
    operation: listMutes,
    input: (page) => ({ credential, page, present: PRESENT }),
    items: pageItems,
    item: target,
    cursor: integerCursor,
    statement: /FROM mutes m /,
    access: "SEARCH m USING INDEX mutes_pair (account_id=?)",
    sorts: true,
  },
  {
    name: "domain blocks",
    operation: listDomainBlocks,
    input: (page) => ({ credential, page }),
    items: pageItems,
    item: (i) => `d${i}.example`,
    cursor: integerCursor,
    statement: /FROM domain_blocks/,
    access: "SEARCH domain_blocks USING COVERING INDEX domain_blocks_pair (account_id=?)",
    sorts: true,
  },
  {
    name: "follow requests",
    operation: listFollowRequests,
    input: (page) => ({ credential, page, present: PRESENT }),
    items: pageItems,
    item: target,
    cursor: integerCursor,
    // The candidate window of the requests (windows.ts); the presented accounts are read by key after it.
    statement: /FROM follows f\s+WHERE/,
    access: "SEARCH f USING COVERING INDEX follows_target (target_account_id=? AND state=? AND rowid>? AND rowid<?)",
  },
  {
    name: "scheduled statuses",
    operation: listScheduled,
    input: (page) => ({ credential, page }),
    items: pageItems,
    item: scheduledCursor,
    cursor: scheduledCursor,
    statement: /FROM scheduled_statuses ss/,
    access: "SEARCH ss USING INDEX scheduled_statuses_account (account_id=? AND id>? AND id<?)",
  },
  {
    name: "given-up deliveries",
    operation: deliveriesReport,
    input: (page) => ({ before: page.maxId, limit: page.limit }),
    items: (output) => (answerOf(output).gaveUp as { id: string }[]).map((d) => d.id),
    item: integerCursor,
    cursor: integerCursor,
    statement: /FROM deliveries d /,
    access: "SEARCH d USING INTEGER PRIMARY KEY (rowid<?)",
    maxOnly: true,
  },
];

// The viewer's lists, `count` rows each, oldest first.
async function world(count: number): Promise<StoreStub> {
  const store = await migratedStore();
  await runInDurableObject(store, (_instance, state) => {
    const sql = state.storage.sql;
    const each = (query: string, ...params: SqlStorageValue[]) =>
      sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1) ${query}`,
        count,
        ...params,
      );
    sql.exec("INSERT INTO accounts (id, uri, username) VALUES (?, ?, ?)", VIEWER, "https://kopje.test/ap/users/v", "v");
    sql.exec(
      "INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'v@example.com', X'00', X'00', 'test')",
      VIEWER,
    );
    sql.exec(
      "INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('ranges', 'secret', 'ranges', 'urn:ietf:wg:oauth:2.0:oob', 'read')",
    );
    sql.exec(
      "INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'ranges', ?, 'read')",
      TOKEN,
      VIEWER,
    );
    each(
      `INSERT INTO accounts (id, uri, username, domain)
			SELECT CAST(?2 + i AS TEXT), 'https://remote.example/users/u' || i, 'u' || i, 'remote.example' FROM n`,
      String(TARGET),
    );
    each(
      "INSERT INTO blocks (account_id, target_account_id) SELECT ?2, CAST(?3 + i AS TEXT) FROM n",
      VIEWER,
      String(TARGET),
    );
    each(
      "INSERT INTO mutes (account_id, target_account_id) SELECT ?2, CAST(?3 + i AS TEXT) FROM n",
      VIEWER,
      String(TARGET),
    );
    each("INSERT INTO domain_blocks (account_id, domain) SELECT ?2, 'd' || i || '.example' FROM n", VIEWER);
    each(
      "INSERT INTO follows (account_id, target_account_id, state) SELECT CAST(?3 + i AS TEXT), ?2, 'pending' FROM n",
      VIEWER,
      String(TARGET),
    );
    each(
      `INSERT INTO scheduled_statuses (id, account_id, scheduled_at, params)
			SELECT CAST(?3 + i AS TEXT), ?2, '2099-01-01T00:00:00.000Z', '{}' FROM n`,
      VIEWER,
      String(SCHEDULED),
    );
    sql.exec(
      'INSERT INTO outbound_activities (id, account_id, body, created_at) VALUES (1, ?, \'{"activity":{"type":"Note"}}\', ?)',
      VIEWER,
      NOW,
    );
    each(
      `INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
			SELECT 1, ?2, 'https://remote.example/inbox', 'https://remote.example', 'gave_up', ?3, ?3 FROM n`,
      VIEWER,
      NOW,
    );
  });
  return store;
}

async function run(store: StoreStub, r: Read, page: PageQuery): Promise<string[]> {
  const output = await runInDurableObject(store, (_instance, state) =>
    r.operation.run(state.storage.sql, r.input(page) as never),
  );
  return r.items(output);
}

// The statement `r` reads its page with, as the operation runs it: its top-level plan (the presented accounts'
// correlated subqueries left out) and the rows it reads. The given-up deliveries' report also counts the whole
// backlog, by design, so only the page's statement is measured.
async function probe(store: StoreStub, r: Read, page: PageQuery): Promise<{ plan: string[]; rows: number }> {
  return runInDurableObject(store, (_instance, state) => {
    const real = state.storage.sql;
    const found: { plan: string[]; rows: number }[] = [];
    const capturing = {
      exec: (query: string, ...params: SqlStorageValue[]) => {
        const cursor = real.exec(query, ...params);
        if (!r.statement.test(query)) {
          return cursor;
        }
        const plan = real
          .exec<{ parent: number; detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...params)
          .toArray()
          .filter((row) => row.parent === 0)
          .map((row) => row.detail);
        const entry = { plan, rows: 0 };
        found.push(entry);
        return watchedCursor(cursor, () => (entry.rows += cursor.rowsRead));
      },
    } as unknown as SqlStorage;
    r.operation.run(capturing, r.input(page) as never);
    expect(found).toHaveLength(1);
    return found[0] ?? { plan: [], rows: 0 };
  });
}

describe("own lists paged by id", () => {
  it("keep max_id, since_id and min_id, with and without a cursor", async () => {
    const count = 12;
    const store = await world(count);
    const limit = 5;
    const all = Array.from({ length: count }, (_, i) => i);
    // The expected page: the rows strictly inside the bounds, newest first; min_id takes the oldest `limit` of them.
    const expected = (r: Read, max: number | null, min: number | null, ascending: boolean) => {
      const inside = all.filter((i) => (max === null || i < max) && (min === null || i > min));
      const page = ascending ? inside.slice(0, limit) : inside.toReversed().slice(0, limit);
      return page.toSorted((a, b) => b - a).map(r.item);
    };
    for (const r of READS) {
      const cases: [PageQuery, number | null, number | null, boolean][] = [
        [{ limit }, null, null, false],
        [{ limit, maxId: r.cursor(7) }, 7, null, false],
        [{ limit, maxId: r.cursor(0) }, 0, null, false],
        ...(r.maxOnly === true
          ? []
          : ([
              [{ limit, sinceId: r.cursor(3) }, null, 3, false],
              [{ limit, minId: r.cursor(3) }, null, 3, true],
              [{ limit, minId: r.cursor(count - 1) }, null, count - 1, true],
              [{ limit, maxId: r.cursor(10), sinceId: r.cursor(2) }, 10, 2, false],
              [{ limit, maxId: r.cursor(10), minId: r.cursor(2) }, 10, 2, true],
            ] as [PageQuery, number | null, number | null, boolean][])),
      ];
      for (const [page, max, min, ascending] of cases) {
        expect([r.name, page, await run(store, r, page)]).toEqual([r.name, page, expected(r, max, min, ascending)]);
      }
    }
  }, 120_000);

  it("seek their cursor where an index ends in the id, with or without one", async () => {
    const store = await world(30);
    for (const r of READS) {
      const pages: PageQuery[] =
        r.maxOnly === true
          ? [{ limit: 20 }, { limit: 20, maxId: r.cursor(25) }]
          : [
              { limit: 20 },
              { limit: 20, maxId: r.cursor(25) },
              { limit: 20, sinceId: r.cursor(5) },
              { limit: 20, minId: r.cursor(5) },
              { limit: 20, maxId: r.cursor(25), minId: r.cursor(5) },
            ];
      for (const page of pages) {
        const { plan } = await probe(store, r, page);
        expect([r.name, page, plan[0], plan.includes("USE TEMP B-TREE FOR ORDER BY")]).toEqual([
          r.name,
          page,
          r.access,
          r.sorts === true,
        ]);
      }
    }
  }, 120_000);

  it("read the same rows below a cursor with 100 or 20,000 newer rows", async () => {
    // 30 rows (ids below the cursor) are older than the newer ones; a page of 20 below the cursor, and a min_id page
    // of 20 above the oldest row.
    const older = 30;
    const grown: string[] = [];
    const rows = new Map<string, number[]>();
    for (const newer of [100, 20_000]) {
      const store = await world(older + newer);
      for (const r of READS.filter((read) => read.sorts !== true)) {
        const pages: [string, PageQuery][] = [
          ["max_id", { limit: 20, maxId: r.cursor(older) }],
          ...(r.maxOnly === true ? [] : ([["min_id", { limit: 20, minId: r.cursor(0) }]] as [string, PageQuery][])),
        ];
        for (const [kind, page] of pages) {
          const key = `${r.name} ${kind}`;
          const shown = await run(store, r, page);
          expect([key, shown.length]).toEqual([key, 20]);
          rows.set(key, [...(rows.get(key) ?? []), (await probe(store, r, page)).rows]);
        }
      }
    }
    expect([...rows.keys()]).toHaveLength(5);
    for (const [key, [few = 0, many = 0]] of rows) {
      if (many > few) {
        grown.push(`${key}: ${few} -> ${many}`);
      }
    }
    expect(grown).toEqual([]);
  }, 300_000);
});
