import { runInDurableObject } from "cloudflare:test";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { Db, rowHeapBytes } from "../src/db/sql";
import {
  audienceTargets,
  beginRetraction,
  type DeliveryEnvelope,
  EMIT_BYTES,
  expandPending,
  forwardSubject,
  PROVENANCE_MAX,
  STAGE_MIN_ROWS,
  stageRetraction,
  STAGING_BYTES,
  STAGING_READ,
  supersedeEarlier,
  TARGET_CHUNK_BYTES,
  type Target,
} from "../src/domain/deliveries";
import { PURGE_BATCH } from "../src/domain/inbox";
import type { StoreStub } from "../src/platform/store-client";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { BUILD, migratedStore } from "./helpers";
import { writtenBy } from "./inbox-store-helpers";
import { ACCESS, copyConfig, dumpViaRpc, ensureAdmin, importViaRpc } from "./ops-helpers";
import { watchedCursor } from "./read-helpers";

// RES-6: a retraction's targets staged from per-source cursors (deliveries.ts stageRetraction) over calls of at most
// maxRows rows each are audienceTargets' targets read whole at the start, each once.

const SIGNER = "100000000000000001";
const STATUS = "200000000000000001";
const STATUS_URI = "https://kopje.test/ap/o/s";
const PARENT = "200000000000000002";

const ACCOUNT = (i: number) => `3${String(i).padStart(17, "0")}`;
const BOOST = (i: number) => `4${String(i).padStart(17, "0")}`;
const QUOTE = (i: number) => `5${String(i).padStart(17, "0")}`;

// Inboxes, NUL and astral characters among them, and two that are no deliverable inbox.
const POOL = [
  "https://h0.example/inbox",
  "https://h1.example/inbox",
  "https://h1.example/users/a/inbox",
  "https://h2.example/in\u0000box",
  "https://h3.example/\u{1F600}/inbox",
  "https://h4.example/inbox",
  "http://h5.example/inbox",
  "",
];

type Remote = {
  inbox: number;
  shared: number | null;
  variant: number;
  follower: boolean;
  mentioned: boolean;
  listed: boolean;
  named: boolean;
  boosts: number;
  quotes: number;
  votes: number[];
};

type World = {
  remotes: Remote[];
  addressed: boolean;
  followers: boolean;
  distributable: boolean;
  parent: number;
  chunks: number[][];
  next: number;
  deliveries: number[];
  receipts: number[];
};

const VARIANTS = ["", "\u0000x", "\u{1F600}"];

const remote = fc.record({
  inbox: fc.integer({ min: 0, max: POOL.length - 1 }),
  shared: fc.option(fc.integer({ min: 0, max: POOL.length - 1 }), { nil: null }),
  variant: fc.integer({ min: 0, max: VARIANTS.length - 1 }),
  follower: fc.boolean(),
  mentioned: fc.boolean(),
  listed: fc.boolean(),
  named: fc.boolean(),
  boosts: fc.integer({ min: 0, max: 2 }),
  quotes: fc.integer({ min: 0, max: 1 }),
  votes: fc.uniqueArray(fc.constantFrom(0, 1, 2.5), { maxLength: 3 }),
});

const world: fc.Arbitrary<World> = fc.record({
  remotes: fc.array(remote, { maxLength: 24 }),
  addressed: fc.boolean(),
  followers: fc.boolean(),
  distributable: fc.boolean(),
  parent: fc.integer({ min: -1, max: 23 }),
  chunks: fc.array(fc.array(fc.integer({ min: 0, max: POOL.length - 1 }), { minLength: 1, maxLength: 5 }), {
    maxLength: 3,
  }),
  next: fc.integer({ min: 0, max: 3 }),
  deliveries: fc.array(fc.integer({ min: 0, max: POOL.length - 1 }), { maxLength: 6 }),
  receipts: fc.uniqueArray(fc.integer({ min: 0, max: POOL.length - 1 }), { maxLength: 6 }),
});

// The signer, its hidden status (a Delete's), and the world's remote accounts and their rows.
function seed(sql: SqlStorage, w: World): DeliveryEnvelope {
  sql.exec(
    `INSERT INTO accounts (id, uri, username, domain) VALUES (?1, 'https://kopje.test/ap/users/alice', 'alice', NULL)`,
    SIGNER,
  );
  sql.exec(
    "INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'a@example.com', X'00', X'00', 'k')",
    SIGNER,
  );
  w.remotes.forEach((r, i) => {
    sql.exec(
      "INSERT INTO accounts (id, uri, username, domain, inbox_url, shared_inbox_url) VALUES (?, ?, ?, ?, ?, ?)",
      ACCOUNT(i),
      `https://h${i % 5}.example/users/u${i}${VARIANTS[r.variant]}`,
      `u${i}`,
      `h${i % 5}.example`,
      POOL[r.inbox]!,
      r.shared === null ? null : POOL[r.shared]!,
    );
  });
  const parent = w.parent >= 0 && w.parent < w.remotes.length;
  if (parent) {
    sql.exec(
      `INSERT INTO statuses (id, uri, account_id, visibility, published_at) VALUES (?, 'https://h0.example/p', ?, 'public', ?)`,
      PARENT,
      ACCOUNT(w.parent),
      new Date(NOW).toISOString(),
    );
  }
  sql.exec(
    `INSERT INTO statuses (id, uri, account_id, visibility, published_at, withdrawn, in_reply_to_id, in_reply_to_uri)
		VALUES (?, ?, ?, 'direct', ?, 1, ?, ?)`,
    STATUS,
    STATUS_URI,
    SIGNER,
    new Date(NOW).toISOString(),
    parent ? PARENT : null,
    parent ? "https://h0.example/p" : null,
  );
  sql.exec(`INSERT INTO polls (status_id, options, tallies) VALUES (?, '["a","b","c"]', '[0,0,0]')`, STATUS);
  w.remotes.forEach((r, i) => {
    if (r.follower) {
      sql.exec(
        "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
        ACCOUNT(i),
        SIGNER,
      );
    }
    if (r.mentioned) {
      sql.exec(
        "INSERT INTO status_mentions (status_id, account_id, silent, requires_mention, author_id) VALUES (?, ?, ?, 1, ?)",
        STATUS,
        ACCOUNT(i),
        r.named ? 0 : 1,
        SIGNER,
      );
    }
    for (let b = 0; b < r.boosts; b++) {
      sql.exec(
        `INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at, withdrawn)
				VALUES (?, ?, ?, ?, 'public', ?, ?)`,
        BOOST(i * 10 + b),
        `https://h0.example/b/${i}/${b}`,
        ACCOUNT(i),
        STATUS,
        new Date(NOW).toISOString(),
        b === 0 ? 0 : 1,
      );
    }
    for (let q = 0; q < r.quotes; q++) {
      sql.exec(
        `INSERT INTO statuses (id, uri, account_id, visibility, published_at) VALUES (?, ?, ?, 'public', ?)`,
        QUOTE(i * 10 + q),
        `https://h0.example/q/${i}/${q}`,
        ACCOUNT(i),
        new Date(NOW).toISOString(),
      );
      sql.exec(
        `INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, updated_at)
				VALUES (?, ?, ?, ?, 'accepted', '')`,
        QUOTE(i * 10 + q),
        STATUS_URI,
        STATUS,
        SIGNER,
      );
    }
    for (const choice of r.votes) {
      sql.exec("INSERT INTO poll_votes (poll_id, account_id, choice) VALUES (?, ?, ?)", STATUS, ACCOUNT(i), choice);
    }
  });
  // An earlier Create of the status: its chunks not yet expanded, its rows in every state, and the receipts.
  const create = sql
    .exec<{ id: number }>(
      `INSERT INTO outbound_activities (account_id, body, object_uri, retracts, created_at)
			VALUES (?, '{"activity":{"type":"Create"},"audience":{"followers":false,"accounts":[]}}', ?, 0, 0) RETURNING id`,
      SIGNER,
      STATUS_URI,
    )
    .one().id;
  for (const chunk of w.chunks) {
    sql.exec(
      "INSERT INTO outbound_targets (activity_id, targets, next) VALUES (?, ?, ?)",
      create,
      JSON.stringify(chunk.map((i) => ({ inbox: POOL[i], addressee: null }))),
      Math.min(w.next, chunk.length - 1),
    );
  }
  const states = ["queued", "pending", "leased", "gave_up"];
  w.deliveries.forEach((i, n) => {
    const state = states[n % states.length]!;
    sql.exec(
      `INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at, lease_token)
			VALUES (?, ?, ?, 'x', ?, 0, 0, ?)`,
      create,
      SIGNER,
      POOL[i]!,
      state,
      state === "leased" ? "t" : null,
    );
  });
  for (const i of w.receipts) {
    sql.exec(
      "INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at) VALUES (?, ?, ?, 0)",
      STATUS,
      POOL[i]!,
      SIGNER,
    );
  }
  const named = w.remotes.flatMap((r, i) =>
    r.named ? [`https://h${i % 5}.example/users/u${i}${VARIANTS[r.variant]}`] : [],
  );
  return {
    activity: {
      type: "Delete",
      id: `${STATUS_URI}#delete`,
      actor: "https://kopje.test/ap/users/alice",
      object: STATUS_URI,
      ...(w.addressed ? { to: named } : {}),
    },
    audience: {
      followers: w.followers,
      accounts: w.remotes.flatMap((r, i) => (r.listed ? [ACCOUNT(i)] : [])),
      status: STATUS,
      ...(w.distributable ? { distributable: true } : {}),
      pollVoters: STATUS,
    },
  };
}

// A target as a staged retraction writes it: its provenance without domains (staged retractions carry account
// provenance only), and only when chunked() admits it.
function comparable(t: Target): string | null {
  const rest: Target = { ...t };
  delete rest.domains;
  const json = JSON.stringify(rest);
  return new TextEncoder().encode(json).byteLength + 3 <= TARGET_CHUNK_BYTES ? json : null;
}

// Stages the intent call by call, each call's maxRows the next of `rows`, each in its own transaction: the calls and
// the most rows a call wrote above its maxRows (0 when none did).
function stageAll(state: DurableObjectState, rows: readonly number[], cap = 5000): { calls: number; over: number } {
  const db = new Db(state.storage.sql, (fn) => state.storage.transactionSync(fn));
  const changes = () => db.first<{ n: number }>("SELECT total_changes() AS n")!.n;
  let over = 0;
  for (let call = 0; call < cap; call++) {
    const maxRows = rows[call % rows.length]!;
    const before = changes();
    const done = state.storage.transactionSync(() => stageRetraction(db, SIGNER, STATUS_URI, maxRows));
    over = Math.max(over, changes() - before - maxRows);
    if (done) {
      return { calls: call + 1, over };
    }
  }
  throw new Error("the staging did not end");
}

function written(sql: SqlStorage, intent: string): string[] {
  return sql
    .exec<{ targets: string }>(
      "SELECT targets FROM outbound_targets WHERE activity_id = CAST(? AS INTEGER) ORDER BY id",
      intent,
    )
    .toArray()
    .flatMap((c) => (JSON.parse(c.targets) as Target[]).map((t) => JSON.stringify(t)));
}

async function staged(w: World, rows: readonly number[]) {
  const store: StoreStub = await migratedStore();
  return runInDurableObject(store, (_instance, state) => {
    const sql = state.storage.sql;
    const envelope = state.storage.transactionSync(() => seed(sql, w));
    const db = new Db(sql);
    const oracle = audienceTargets(db, SIGNER, envelope.activity, envelope.audience)
      .map(comparable)
      .filter((t): t is string => t !== null);
    const intent = state.storage.transactionSync(() => beginRetraction(db, SIGNER, envelope, NOW, 1, "bounded")!);
    const run = stageAll(state, rows);
    return {
      oracle,
      written: written(sql, intent),
      ...run,
      left: sql
        .exec<{ n: number }>(
          "SELECT (SELECT count(*) FROM retraction_stagings) + (SELECT count(*) FROM retraction_reach) AS n",
        )
        .one().n,
      staged: sql
        .exec<{ staged: string | null }>("SELECT staged FROM outbound_activities WHERE id = ?", intent)
        .toArray(),
    };
  });
}

describe("a staged retraction (RES-6)", () => {
  it("writes audienceTargets’ targets at the start, each once, within each call’s maxRows", async () => {
    await fc.assert(
      fc.asyncProperty(
        world,
        fc.array(fc.integer({ min: STAGE_MIN_ROWS, max: 500 }), { minLength: 1, maxLength: 8 }),
        async (w, rows) => {
          const result = await staged(w, rows);
          expect(result.over).toBe(0);
          expect(new Set(result.written).size).toBe(result.written.length);
          expect([...result.written].toSorted()).toEqual([...result.oracle].toSorted());
          expect(result.left).toBe(0);
          expect(result.staged.every((s) => s.staged === null)).toBe(true);
        },
      ),
      { numRuns: 30 },
    );
  }, 300_000);
});

// A SqlStorage over `real` that adds each statement's rows read (cursor.rowsRead) and the UTF-8 bytes of the text it
// returned to `meter`.
// With `plans`, each statement's query plan (EXPLAIN QUERY PLAN with its parameters) is kept, once per SQL text.
function metered(
  real: SqlStorage,
  meter: { reads: number; bytes: number; json?: number; accounts?: number; shares?: number },
  plans?: Map<string, string[]>,
): SqlStorage {
  const encoder = new TextEncoder();
  return {
    exec: (query: string, ...params: SqlStorageValue[]) => {
      if (plans !== undefined && !plans.has(query)) {
        plans.set(
          query,
          real
            .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...params)
            .toArray()
            .map((row) => row.detail),
        );
      }
      const cursor = real.exec(query, ...params);
      return watchedCursor(
        cursor,
        () => {
          meter.reads += cursor.rowsRead;
          if (/json_each\(\(SELECT/.test(query)) {
            meter.json = (meter.json ?? 0) + cursor.rowsRead;
          }
        },
        (rows) => {
          // The rows pulled from the pages of the audience's accounts (stagedList).
          if (meter.accounts !== undefined && params[1] === "$.audience.accounts") {
            meter.accounts += rows.length;
          }
          if (meter.shares !== undefined && params[1] === "$.audience.shares") {
            meter.shares += rows.length;
          }
          for (const value of rows.flatMap((row) => Object.values(row))) {
            meter.bytes += typeof value === "string" ? encoder.encode(value).byteLength : 0;
          }
        },
      );
    },
  } as unknown as SqlStorage;
}

// A plan line that scans a table: the json_each pages and the inner pages they join (w) are no table.
const scanned = (line: string) => line.startsWith("SCAN ") && !/VIRTUAL TABLE|CONSTANT ROW|^SCAN [jtw]\b/.test(line);

// maxRows drawn in [STAGE_MIN_ROWS, PURGE_BATCH] by a fixed generator, so a failure replays.
function drawnRows(n: number): number[] {
  let x = 12345;
  return Array.from({ length: n }, () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return STAGE_MIN_ROWS + (x % (PURGE_BATCH - STAGE_MIN_ROWS + 1));
  });
}

// Every source past STAGING_READ at once, grown after the statistics were taken: 5,000 followers on distinct inboxes
// (one at TARGET_CHUNK_BYTES raw bytes, one past it), 600 silent mentions (personal copies), 600 boosters and one
// account with 600 boosts, 600 quoters, 600 voters and one with 100 choices (fractional ones too), 600 addressed
// accounts in the envelope, 10,000 earlier intents without rows (more than a call reads, all below the retraction), a
// Create with 600 targets not expanded (the first chunk mid-way), a chunk near the row limit and one of 20,000
// elements, and 600 rows in every state, and 600 receipts with one past TARGET_CHUNK_BYTES.
async function cappedWorld(): Promise<{ store: StoreStub; envelope: DeliveryEnvelope }> {
  const store = await migratedStore();
  const envelope = await runInDurableObject(store, (_instance, state) => {
    const sql = state.storage.sql;
    const base = state.storage.transactionSync(() =>
      seed(sql, {
        remotes: [{ ...REMOTE, follower: true, mentioned: true, boosts: 1, quotes: 1, votes: [0], listed: true }],
        addressed: true,
        followers: true,
        distributable: true,
        parent: 0,
        chunks: [[0, 1]],
        next: 0,
        deliveries: [0],
        receipts: [0],
      }),
    );
    sql.exec("ANALYZE");
    const n = (count: number, body: string, ...params: SqlStorageValue[]) =>
      sql.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count}) ${body}`, ...params);
    state.storage.transactionSync(() => {
      n(
        6000,
        `INSERT INTO accounts (id, uri, username, domain, inbox_url)
				SELECT printf('6%017d', i), 'https://f' || i || '.example/u', 'u', 'f' || i || '.example',
					'https://f' || i || '.example/in' || char(0) || 'box' || char(128512) FROM n`,
      );
      for (const [i, bytes] of [
        [5001, TARGET_CHUNK_BYTES],
        [5002, TARGET_CHUNK_BYTES + 1],
      ] as const) {
        const prefix = "https://big.example/";
        sql.exec(
          "UPDATE accounts SET inbox_url = ? || replace(hex(zeroblob(?)), '00', 'x') WHERE id = printf('6%017d', ?)",
          prefix,
          bytes - prefix.length,
          i,
        );
      }
      n(
        5002,
        `INSERT INTO follows (account_id, target_account_id, state) SELECT printf('6%017d', i), ?, 'accepted' FROM n`,
        SIGNER,
      );
      n(
        600,
        `INSERT INTO status_mentions (status_id, account_id, silent, requires_mention, author_id)
				SELECT ?1, printf('6%017d', i), 1, 1, ?2 FROM n`,
        STATUS,
        SIGNER,
      );
      n(
        600,
        `INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at)
				SELECT printf('7%017d', i), 'https://f.example/b/' || i, printf('6%017d', 600 + i), ?1, 'public', '2026-01-01' FROM n`,
        STATUS,
      );
      n(
        600,
        `INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at, withdrawn)
				SELECT printf('7%017d', 1000 + i), 'https://f.example/bb/' || i, printf('6%017d', 1201), ?1, 'public', '2026-01-01',
					i > 1 FROM n`,
        STATUS,
      );
      n(
        600,
        `INSERT INTO statuses (id, uri, account_id, visibility, published_at)
				SELECT printf('8%017d', i), 'https://f.example/q/' || i, printf('6%017d', 1201 + i), 'public', '2026-01-01' FROM n`,
      );
      n(
        600,
        `INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, updated_at)
				SELECT printf('8%017d', i), ?1, ?2, ?3, 'accepted', '' FROM n`,
        STATUS_URI,
        STATUS,
        SIGNER,
      );
      n(
        600,
        `INSERT INTO poll_votes (poll_id, account_id, choice) SELECT ?1, printf('6%017d', 1801 + i), 0 FROM n`,
        STATUS,
      );
      n(
        100,
        `INSERT INTO poll_votes (poll_id, account_id, choice) SELECT ?1, printf('6%017d', 2402), (i - 1) / 2.0 FROM n`,
        STATUS,
      );
      n(
        10_000,
        `INSERT INTO outbound_activities (account_id, body, object_uri, retracts, created_at)
				SELECT ?1, '{"activity":{"type":"Update"},"audience":{"followers":false,"accounts":[]}}', ?2, 0, 0 FROM n`,
        SIGNER,
        STATUS_URI,
      );
      const create = sql
        .exec<{ id: number }>(
          `INSERT INTO outbound_activities (account_id, body, object_uri, retracts, created_at)
					VALUES (?, '{"activity":{"type":"Create"},"audience":{"followers":false,"accounts":[]}}', ?, 0, 0) RETURNING id`,
          SIGNER,
          STATUS_URI,
        )
        .one().id;
      for (let c = 0; c < 6; c++) {
        sql.exec(
          "INSERT INTO outbound_targets (activity_id, targets, next) VALUES (?, ?, ?)",
          create,
          JSON.stringify(
            Array.from({ length: 100 }, (_, i) => ({
              inbox: `https://c${c * 100 + i}.example/inbox`,
              addressee: null,
            })),
          ),
          c === 0 ? 50 : 0,
        );
      }
      // Imported chunks at the stored maxima: one near the row limit (three inboxes past the bound and one
      // target), one of 20,000 elements that are no target.
      sql.exec(
        "INSERT INTO outbound_targets (activity_id, targets) VALUES (?, ?)",
        create,
        JSON.stringify([
          ...[0, 1, 2].map((i) => ({ inbox: `https://g${i}.example/${"g".repeat(600_000)}`, addressee: null })),
          { inbox: "https://g.example/inbox", addressee: null },
        ]),
      );
      sql.exec(
        "INSERT INTO outbound_targets (activity_id, targets) VALUES (?, ?)",
        create,
        JSON.stringify(Array.from({ length: 20_000 }, () => 0)),
      );
      n(
        600,
        `INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at, lease_token)
				SELECT ?1, ?2, 'https://d' || i || '.example/inbox', 'x',
					CASE i % 4 WHEN 0 THEN 'queued' WHEN 1 THEN 'pending' WHEN 2 THEN 'leased' ELSE 'gave_up' END, 0, 0,
					CASE i % 4 WHEN 2 THEN 't' END FROM n`,
        create,
        SIGNER,
      );
      n(
        600,
        `INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at)
				SELECT ?1, 'https://e' || i || '.example/inbox', ?2, 0 FROM n`,
        STATUS,
        SIGNER,
      );
      sql.exec(
        `INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at)
				VALUES (?1, 'https://e3.example/' || replace(hex(zeroblob(?3)), '00', 'x'), ?2, 0)`,
        STATUS,
        SIGNER,
        TARGET_CHUNK_BYTES,
      );
    });
    const audience = base.audience as Record<string, unknown>;
    return {
      ...base,
      audience: {
        ...base.audience,
        accounts: [
          ...(audience.accounts as string[]),
          ...Array.from({ length: 600 }, (_, i) => `6${String(2403 + i).padStart(17, "0")}`),
        ],
      },
    };
  });
  return { store, envelope };
}

// The table rows a staging call reads at most: gathering, three a raw candidate (its index entry and two seeks) and the
// receipts' page walked again by its cursor's update (one a candidate); merging, a read and an upsert a target (maxRows
// at most); writing out, the page, its range delete's offset and its rows (maxRows each at most); the fixed seeks.
function tableReads(maxRows: number): number {
  return 4 * STAGING_READ + 3 * maxRows + 64;
}

// The elements json_each steps over in a call (SQLite parses an array whole; a position is reached by passing those
// before it): the chunks examined, STAGING_BYTES of them and one at the row limit, and the body's two lists, at two
// bytes an element at least ('0,').
function jsonSteps(body: number): number {
  return (STAGING_BYTES + ROW_LIMIT) / 2 + body;
}

// The stored bytes of what the Worker reads of the intent's body each call (deliveries.ts INTENT_COLUMNS): the activity,
// read whole, and the audience's scalars, each returned as json_extract gives it (a string, or an object's JSON).
type IntentText = { activity: number; scalars: number };
function intentText(sql: SqlStorage, intent: string): IntentText {
  return sql
    .exec<IntentText>(
      `SELECT length(CAST(json_extract(body, '$.activity') AS BLOB)) AS activity,
				coalesce(length(CAST(json_extract(body, '$.audience.followers') AS BLOB)), 0)
					+ coalesce(length(CAST(json_extract(body, '$.audience.status') AS BLOB)), 0)
					+ coalesce(length(CAST(json_extract(body, '$.audience.pollVoters') AS BLOB)), 0) AS scalars
			FROM outbound_activities WHERE id = ?`,
      intent,
    )
    .one();
}

// The text a staging call returns at most (UTF-8 bytes as the Worker decodes it, three a stored byte at most), for an
// intent whose activity and audience scalars hold `text` stored bytes: see the cap witness below.
const ROW_LIMIT = 2 * 1024 * 1024;
function textCeiling(text: IntentText): number {
  // The projected values within STAGING_BYTES, or a uri past the bound read first to be compared with a name of the
  // activity (within its decoded bytes), and the row that crosses it: three values at the bound.
  const values = Math.max(STAGING_BYTES, 3 * text.activity) + 3 * TARGET_CHUNK_BYTES;
  // The staged page within EMIT_BYTES and the row that crosses it, the ids (a list's element is an 18-digit id or
  // NULL), and each staged row's accounts read twice (merge, page); the activity and the audience's scalars.
  const page = EMIT_BYTES + TARGET_CHUNK_BYTES;
  const ids = STAGING_READ * (2 * 1024 + 4 * 20);
  return values + page + ids + 3 * (text.activity + text.scalars);
}

const REMOTE: Remote = {
  inbox: 0,
  shared: null,
  variant: 0,
  follower: false,
  mentioned: false,
  listed: false,
  named: false,
  boosts: 0,
  quotes: 0,
  votes: [],
};

describe("a staged retraction’s calls at every source’s cap (RES-6)", () => {
  it("reads, returns and writes within their derived bounds in each call, and stages what audienceTargets finds", async () => {
    const { store, envelope } = await cappedWorld();
    const warned = vi.spyOn(console, "warn");
    const result = await runInDurableObject(store, (_instance, state) => {
      const real = state.storage.sql;
      const oracle = audienceTargets(new Db(real), SIGNER, envelope.activity, envelope.audience)
        .map(comparable)
        .filter((t): t is string => t !== null);
      const intent = state.storage.transactionSync(() =>
        beginRetraction(new Db(real), SIGNER, envelope, NOW, 1, "bounded")!,
      );
      const rows = drawnRows(997);
      const calls: { reads: number; bytes: number; json: number; wrote: number; maxRows: number }[] = [];
      const plans = new Map<string, string[]>();
      for (let call = 0; call < 2000; call++) {
        const meter = { reads: 0, bytes: 0, json: 0 };
        const db = new Db(metered(real, meter, plans), (fn) => state.storage.transactionSync(fn));
        const changes = () => new Db(real).first<{ n: number }>("SELECT total_changes() AS n")!.n;
        const maxRows = rows[call % rows.length]!;
        const before = changes();
        const done = state.storage.transactionSync(() => stageRetraction(db, SIGNER, STATUS_URI, maxRows));
        calls.push({ ...meter, wrote: changes() - before, maxRows });
        if (done) {
          break;
        }
      }
      return {
        calls,
        plans: [...plans],
        oracle,
        written: written(real, intent),
        receipts: real.exec<{ n: number }>("SELECT count(*) AS n FROM outbound_receipts").one().n,
        body: real
          .exec<{ n: number }>("SELECT length(CAST(body AS BLOB)) AS n FROM outbound_activities WHERE id = ?", intent)
          .one().n,
        text: intentText(real, intent),
      };
    });
    const oversized = warned.mock.calls.filter(
      ([e]) => (e as { event?: string }).event === "kopje.delivery.oversized_target",
    );
    warned.mockRestore();
    expect(result.calls.length).toBeGreaterThan(20);
    // Under statistics taken before the growth, no statement scans a table: each walks its index from a key
    // (RES-7). The json_each pages and the inner pages they join (w) are no table.
    const scans = result.plans.flatMap(([query, plan]) => plan.filter(scanned).map((line) => `${line} in ${query}`));
    expect(scans).toEqual([]);
    for (const [i, call] of result.calls.entries()) {
      expect(call.wrote, `call ${i}`).toBeLessThanOrEqual(call.maxRows);
      expect(call.reads - call.json, `call ${i}`).toBeLessThanOrEqual(tableReads(call.maxRows));
      expect(call.json, `call ${i}`).toBeLessThanOrEqual(jsonSteps(result.body));
      expect(call.bytes, `call ${i}`).toBeLessThanOrEqual(textCeiling(result.text));
    }
    expect(new Set(result.written).size).toBe(result.written.length);
    expect([...result.written].toSorted()).toEqual([...result.oracle].toSorted());
    // The receipt past TARGET_CHUNK_BYTES is deleted, never a target; the inbox at the cap is refused by chunked's
    // rule, the one past it never reaches the Worker; each is logged.
    expect(result.receipts).toBe(601);
    expect(result.written.some((t) => t.includes("big.example") || t.includes("e3.example/x"))).toBe(false);
    expect(oversized.length).toBeGreaterThan(0);
  }, 600_000);
});

// A world seeded with its retraction recorded (beginRetraction), `extra` run before the oracle (audienceTargets at the
// start) is taken.
async function prepared(w: World, extra: (sql: SqlStorage) => void = () => {}, addressed?: Partial<DeliveryEnvelope>) {
  const store = await migratedStore();
  const { intent, oracle } = await runInDurableObject(store, (_instance, state) => {
    const sql = state.storage.sql;
    const seeded = state.storage.transactionSync(() => {
      const envelope = seed(sql, w);
      extra(sql);
      return { ...envelope, ...addressed };
    });
    const db = new Db(sql);
    return {
      oracle: audienceTargets(db, SIGNER, seeded.activity, seeded.audience)
        .map(comparable)
        .filter((t): t is string => t !== null),
      intent: state.storage.transactionSync(() => beginRetraction(db, SIGNER, seeded, NOW, 1, "bounded")!),
    };
  });
  const call = (maxRows: number) =>
    writtenBy(store, (db) => stageRetraction(db, SIGNER, STATUS_URI, maxRows)).then(({ result, rows }) => ({
      done: result,
      wrote: rows,
    }));
  const staging = async () =>
    (
      await sql<{ phase: string; after_id: string | null; after_row: string | null; after_index: number | null }>(
        store,
        `SELECT phase, CAST(after_id AS TEXT) AS after_id, CAST(after_row AS TEXT) AS after_row, after_index
				FROM retraction_stagings WHERE id = (SELECT CAST(staged AS INTEGER) FROM outbound_activities WHERE id = ?)`,
        intent,
      )
    )[0];
  // Calls of maxRows until `until` holds (or the staging ends); each within its maxRows.
  const until = async (maxRows: number, stop: () => Promise<boolean>) => {
    for (let n = 0; n < 2000; n++) {
      if (await stop()) {
        return false;
      }
      const { done, wrote } = await call(maxRows);
      expect(wrote).toBeLessThanOrEqual(maxRows);
      if (done) {
        return true;
      }
    }
    throw new Error("the staging did not end");
  };
  const finish = (maxRows = STAGE_MIN_ROWS) => until(maxRows, () => Promise.resolve(false));
  const targets = async () => runInDurableObject(store, (_instance, state) => written(state.storage.sql, intent));
  const left = async () =>
    (
      await sql<{ n: number }>(
        store,
        "SELECT (SELECT count(*) FROM retraction_stagings) + (SELECT count(*) FROM retraction_reach) AS n",
      )
    )[0]!.n;
  return { store, intent, oracle, call, staging, until, finish, targets, left };
}

const EMPTY: World = {
  remotes: [],
  addressed: true,
  followers: true,
  distributable: true,
  parent: -1,
  chunks: [],
  next: 0,
  deliveries: [],
  receipts: [],
};

const inboxesOf = (targets: readonly string[]) => targets.map((t) => (JSON.parse(t) as Target).inbox);

describe("a staged retraction’s malformed and oversized values (RES-6, DATA-6)", () => {
  it("resumes past a receipt whose inbox ends in a raw FF byte, and drains a malformed staged key", async () => {
    const t = await prepared(EMPTY, (sql) => {
      for (let i = 0; i < 12; i++) {
        sql.exec(
          `INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at)
					VALUES (?1, CASE WHEN ?3 = '5' THEN CAST(CAST('https://e5.example/inbox' AS BLOB) || X'FF' AS TEXT)
						ELSE 'https://e' || ?3 || '.example/inbox' END, ?2, 0)`,
          STATUS,
          SIGNER,
          String(i),
        );
      }
    });
    // Into the receipts, then a staged row an import left with a malformed key.
    expect(await t.until(STAGE_MIN_ROWS, async () => (await t.staging())?.phase === "receipts")).toBe(false);
    await t.call(STAGE_MIN_ROWS);
    await sql(
      t.store,
      `INSERT INTO retraction_reach (staging_id, neutral, key, accounts)
			SELECT CAST(staged AS INTEGER), 1, CAST(X'68747470733A2F2F6D2E6578616D706C652FFF' AS TEXT), '[]'
			FROM outbound_activities WHERE id = ?`,
      t.intent,
    );
    expect(await t.finish()).toBe(true);
    const reached = inboxesOf(await t.targets());
    for (let i = 0; i < 12; i++) {
      expect(
        reached.some((inbox) => inbox.startsWith(`https://e${i}.example/inbox`)),
        String(i),
      ).toBe(true);
    }
    expect(reached.filter((inbox) => inbox.startsWith("https://e5.example/inbox"))).toHaveLength(1);
    // The imported row is written out as it decodes, and drained by its raw key.
    expect(reached.filter((inbox) => inbox.startsWith("https://m.example/"))).toHaveLength(1);
    expect(await t.left()).toBe(0);
  }, 120_000);

  it("merges into a staged row an import left with other values than account ids, within its CHECK", async () => {
    // More followers on one inbox than a call reads, so a later call merges into the row.
    const t = await prepared(
      EMPTY,
      (sql) => followers(sql, STAGING_READ + 10, () => "https://one.example/inbox"),
      ONLY_FOLLOWERS,
    );
    expect((await t.call(PURGE_BATCH)).done).toBe(false);
    expect((await t.staging())?.phase).toBe("followers");
    // The staged row of the followers' inbox, its accounts replaced by 16 strings filling the CHECK's 1,024 bytes.
    const filler = JSON.stringify(Array.from({ length: 16 }, (_, i) => `${i}`.padEnd(60, "v")));
    expect(new TextEncoder().encode(filler).byteLength).toBeGreaterThan(1024 - 21);
    expect(
      await sql(
        t.store,
        "UPDATE retraction_reach SET accounts = ? WHERE key = 'https://one.example/inbox' RETURNING 1",
        filler,
      ),
    ).toHaveLength(1);
    expect(await t.finish()).toBe(true);
    const [target] = (await t.targets()).map((x) => JSON.parse(x) as Target);
    expect(target!.inbox).toBe("https://one.example/inbox");
    expect(target!.accounts!.every((id) => /^[0-9]{18}$/.test(id))).toBe(true);
  }, 120_000);

  it("refuses, logs and passes a target chunked() would refuse, whatever its stored bytes", async () => {
    const warned = vi.spyOn(console, "warn");
    const t = await prepared(
      { ...EMPTY, remotes: [true, false, true].map((follower) => ({ ...REMOTE, follower })) },
      (sql) => {
        // A follower's inbox of 180,000 malformed bytes (within the raw bound, past it once decoded); an addressed
        // account whose personal copy is a 300 KiB uri at a 300 KiB inbox (each within the bound, not both).
        sql.exec(
          `UPDATE accounts SET inbox_url = 'https://m.example/' || CAST(unhex(replace(hex(zeroblob(180000)), '00', 'FF')) AS TEXT)
					WHERE id = ?`,
          ACCOUNT(0),
        );
        sql.exec(
          `UPDATE accounts SET uri = 'https://u.example/' || replace(hex(zeroblob(307200)), '00', 'u'),
						inbox_url = 'https://u.example/' || replace(hex(zeroblob(307200)), '00', 'i') WHERE id = ?`,
          ACCOUNT(1),
        );
      },
      {
        audience: {
          followers: true,
          accounts: [ACCOUNT(1)],
          status: STATUS,
          distributable: true,
          pollVoters: STATUS,
        },
      },
    );
    expect(await t.finish()).toBe(true);
    const events = warned.mock.calls.filter(
      ([e]) => (e as { event?: string }).event === "kopje.delivery.oversized_target",
    );
    warned.mockRestore();
    expect(events.length).toBeGreaterThan(0);
    // The logged events carry a count, never a value.
    expect(JSON.stringify(events).includes("m.example")).toBe(false);
    const written = await t.targets();
    expect(written.some((x) => x.includes("m.example") || x.includes("u.example"))).toBe(false);
    expect([...written].toSorted()).toEqual([...t.oracle].toSorted());
    expect(t.oracle.some((x) => x.includes(`h2.example`) || x.includes("h0.example"))).toBe(true);
    expect(await t.left()).toBe(0);
  }, 120_000);

  it("reaches an account whose uri is past the bound at its shared inbox when to names it, and refuses its copy else", async () => {
    const past = (c: string) => `https://big.example/${c.repeat(TARGET_CHUNK_BYTES)}`;
    const t = await prepared(
      {
        ...EMPTY,
        remotes: [
          { ...REMOTE, listed: true, shared: 1 },
          { ...REMOTE, listed: true, shared: 2 },
        ],
      },
      (sql) => {
        sql.exec("UPDATE accounts SET uri = ? WHERE id = ?", past("n"), ACCOUNT(0));
        sql.exec("UPDATE accounts SET uri = ? WHERE id = ?", past("p"), ACCOUNT(1));
      },
      {
        activity: {
          type: "Delete",
          id: `${STATUS_URI}#delete`,
          actor: "https://kopje.test/ap/users/alice",
          object: STATUS_URI,
          to: [past("n")],
        },
        audience: { followers: false, accounts: [ACCOUNT(0), ACCOUNT(1)] },
      },
    );
    expect(await t.finish()).toBe(true);
    const reached = inboxesOf(await t.targets());
    expect(reached).toContain(POOL[1]);
    expect(reached).not.toContain(POOL[2]);
    expect([...(await t.targets())].toSorted()).toEqual([...t.oracle].toSorted());
  }, 120_000);

  it("sends one personal copy for two raw uris one decoded addressee, at the lower account id’s inbox", async () => {
    // The lower id boosts (read after the envelope's accounts, which name the higher id).
    const t = await prepared(
      { ...EMPTY, remotes: [{ ...REMOTE, boosts: 1 }, { ...REMOTE }] },
      (sql) => oneAddressee(sql, "https://low.example/inbox", "https://high.example/inbox"),
      {
        audience: { followers: false, accounts: [ACCOUNT(1)], status: STATUS, distributable: true },
      },
    );
    expect(await t.finish()).toBe(true);
    const written = (await t.targets()).map((x) => JSON.parse(x) as Target);
    const personal = written.filter((x) => x.addressee !== null);
    expect(personal).toHaveLength(1);
    expect(personal[0]!.inbox).toBe("https://low.example/inbox");
    expect([...(await t.targets())].toSorted()).toEqual([...t.oracle].toSorted());
  }, 120_000);
});

// `n` remote followers of the signer, each on its own inbox https://f<i>.example/inbox, ids 9 and 17 digits.
function followers(sql: SqlStorage, n: number, inbox = (i: number) => `https://f${i}.example/inbox`, from = 1): void {
  for (let i = from; i < from + n; i++) {
    sql.exec(
      `INSERT INTO accounts (id, uri, username, domain, inbox_url) VALUES (?, ?, 'f', 'f.example', ?)`,
      `9${String(i).padStart(17, "0")}`,
      `https://f.example/u/${i}`,
      inbox(i),
    );
    sql.exec(
      "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
      `9${String(i).padStart(17, "0")}`,
      SIGNER,
    );
  }
}

const ONLY_FOLLOWERS: Partial<DeliveryEnvelope> = {
  activity: {
    type: "Delete",
    id: `${STATUS_URI}#delete`,
    actor: "https://kopje.test/ap/users/alice",
    object: STATUS_URI,
  },
  audience: { followers: true, accounts: [] },
};

describe("a staged retraction’s sources in flow order (RES-6)", () => {
  it("reaches a row that completes during the rows’ walk, through its receipt", async () => {
    const t = await prepared(EMPTY, (sql) => {
      const create = sql
        .exec<{ id: number }>(`SELECT id FROM outbound_activities WHERE object_uri = ? AND retracts = 0`, STATUS_URI)
        .one().id;
      // The highest ids are due first, so the claim takes rows the walk has not reached.
      for (let i = 1; i <= 40; i++) {
        sql.exec(
          `INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
					VALUES (?, ?, ?, ?, 'pending', ?, 0)`,
          create,
          SIGNER,
          `https://d${i}.example/inbox`,
          `https://d${i}.example`,
          NOW - i,
        );
      }
    });
    expect(
      await t.until(STAGE_MIN_ROWS, async () => {
        const s = await t.staging();
        return s?.phase === "deliveries" && s.after_row !== null;
      }),
    ).toBe(false);
    const claim = await t.store.claimDeliveries(BUILD, { now: NOW, leaseToken: "gate" });
    const passed = Number((await t.staging())!.after_row);
    const ids = claim.deliveries.map((d) => Number(d.id));
    expect(ids.some((id) => id > passed)).toBe(true);
    for (const d of claim.deliveries) {
      await t.store.completeDelivery(BUILD, {
        id: d.id,
        leaseToken: "gate",
        now: NOW,
        outcome: { kind: "delivered", status: 202 },
      });
    }
    expect(await sql(t.store, "SELECT count(*) AS n FROM outbound_receipts")).toEqual([{ n: claim.deliveries.length }]);
    expect(await t.finish()).toBe(true);
    const reached = new Set(inboxesOf(await t.targets()));
    for (let i = 1; i <= 40; i++) {
      expect(reached.has(`https://d${i}.example/inbox`), String(i)).toBe(true);
    }
  }, 120_000);

  it("reaches a target expanded during the walk of the targets not yet expanded, through its row", async () => {
    const t = await prepared(EMPTY, (sql) => {
      const create = sql
        .exec<{ id: number }>(`SELECT id FROM outbound_activities WHERE object_uri = ? AND retracts = 0`, STATUS_URI)
        .one().id;
      for (let c = 0; c < 3; c++) {
        sql.exec(
          "INSERT INTO outbound_targets (activity_id, targets) VALUES (?, ?)",
          create,
          JSON.stringify(
            Array.from({ length: 30 }, (_, i) => ({ inbox: `https://c${c * 30 + i}.example/inbox`, addressee: null })),
          ),
        );
      }
    });
    expect(
      await t.until(STAGE_MIN_ROWS, async () => {
        const s = await t.staging();
        return s?.phase === "unexpanded" && s.after_index !== null;
      }),
    ).toBe(false);
    await runInDurableObject(t.store, (_instance, state) =>
      state.storage.transactionSync(() => expandPending(new Db(state.storage.sql), NOW, 60)),
    );
    expect(await t.finish()).toBe(true);
    const reached = new Set(inboxesOf(await t.targets()));
    for (let i = 0; i < 90; i++) {
      expect(reached.has(`https://c${i}.example/inbox`), String(i)).toBe(true);
    }
  }, 120_000);

  it("reaches a follower at the inbox it has when the walk passes it, and no follow made after it began", async () => {
    const t = await prepared(EMPTY, (sql) => followers(sql, 20), ONLY_FOLLOWERS);
    expect(
      await t.until(STAGE_MIN_ROWS, async () => {
        const s = await t.staging();
        return s?.phase === "followers" && s.after_id !== null;
      }),
    ).toBe(false);
    // The last follower moves to an inbox that sorts before every other; a new follower comes.
    await sql(
      t.store,
      "UPDATE accounts SET inbox_url = 'https://a.example/moved' WHERE id = ?",
      `9${String(20).padStart(17, "0")}`,
    );
    await runInDurableObject(t.store, (_instance, state) =>
      state.storage.transactionSync(() => followers(state.storage.sql, 1, () => "https://late.example/inbox", 21)),
    );
    expect(await t.finish()).toBe(true);
    const reached = new Set(inboxesOf(await t.targets()));
    expect(reached.has("https://a.example/moved")).toBe(true);
    expect(reached.has("https://f20.example/inbox")).toBe(false);
    expect(reached.has("https://late.example/inbox")).toBe(false);
    for (let i = 1; i < 20; i++) {
      expect(reached.has(`https://f${i}.example/inbox`), String(i)).toBe(true);
    }
  }, 120_000);
});

describe("a staging that ends before it is written (RES-6)", () => {
  it("is marked ended when its retraction is superseded, unseen by an intent that takes its id, and swept", async () => {
    // The earlier Create keeps a row, so the retraction holds the highest intent id.
    const t = await prepared({ ...EMPTY, deliveries: [0] }, (sql) => followers(sql, 30), ONLY_FOLLOWERS);
    for (let n = 0; n < 3; n++) {
      expect((await t.call(STAGE_MIN_ROWS)).done).toBe(false);
    }
    const staged = () =>
      sql<{ id: string; ended: number; rows: number }>(
        t.store,
        `SELECT CAST(id AS TEXT) AS id, ended, (SELECT count(*) FROM retraction_reach WHERE staging_id = h.id) AS rows
				FROM retraction_stagings h ORDER BY id`,
      );
    const [first] = await staged();
    expect(first).toMatchObject({ ended: 0 });
    expect(first!.rows).toBeGreaterThan(0);
    // Superseded (supersedeIntent, as a later retraction's job does), its intent dropped: no row is left of it.
    await runInDurableObject(t.store, (_instance, state) =>
      state.storage.transactionSync(() => supersedeEarlier(new Db(state.storage.sql), SIGNER, STATUS_URI, 10)),
    );
    expect(await staged()).toMatchObject([{ id: first!.id, ended: 1, rows: first!.rows }]);
    expect(await sql(t.store, "SELECT 1 FROM outbound_activities WHERE id = ?", t.intent)).toEqual([]);
    // A new retraction of the status takes the dropped intent's id, and stages from its own row.
    const again = await runInDurableObject(t.store, (_instance, state) =>
      state.storage.transactionSync(() =>
        beginRetraction(new Db(state.storage.sql), SIGNER, ONLY_FOLLOWERS as DeliveryEnvelope, NOW, 1, "bounded"),
      ),
    );
    expect(again).toBe(t.intent);
    expect(await t.finish()).toBe(true);
    const reached = inboxesOf(await t.targets());
    expect(new Set(reached).size).toBe(reached.length);
    expect(reached.length).toBe(30 + 1);
    expect(await staged()).toMatchObject([{ id: first!.id, ended: 1, rows: first!.rows }]);
    for (let round = 0; round < 10 && (await staged()).length > 0; round++) {
      expect((await t.store.sweepDeliveries(BUILD, { now: NOW })).swept).toBeLessThanOrEqual(500);
    }
    expect(await t.left()).toBe(0);
  }, 120_000);

  it("is marked ended when a later retraction supersedes it, which counts that row before it writes", async () => {
    const t = await prepared(EMPTY, (sql) => followers(sql, 30), ONLY_FOLLOWERS);
    expect((await t.call(STAGE_MIN_ROWS)).done).toBe(false);
    // Superseding the earlier Create and the staging retraction: an update and a delete each, and the staging's end.
    const record = (maxRows: number) =>
      writtenBy(t.store, (db) => beginRetraction(db, SIGNER, ONLY_FOLLOWERS as DeliveryEnvelope, NOW, maxRows));
    const refused = await record(2 * 2 + 1);
    expect(refused).toEqual({ result: null, rows: 0 });
    const recorded = await record(2 * 2 + 1 + 1);
    expect(recorded.result).not.toBeNull();
    expect(recorded.rows).toBeLessThanOrEqual(2 * 2 + 1 + 1);
    expect(await sql(t.store, "SELECT ended FROM retraction_stagings")).toEqual([{ ended: 1 }]);
  }, 120_000);
});

describe("a staged retraction’s stored state (RES-6)", () => {
  it.each([["0\nhttps://f1.example/inbox\n"], ["05"], ["other"]])(
    "starts anew when staged holds %j, which names no staging of this intent",
    async (value) => {
      const t = await prepared(EMPTY, (sql) => followers(sql, 12), ONLY_FOLLOWERS);
      // Another retraction's staging, live: an import's staged value may name it.
      const other = await runInDurableObject(t.store, (_instance, state) => {
        const db = new Db(state.storage.sql);
        return state.storage.transactionSync(() => {
          const id = beginRetraction(
            db,
            SIGNER,
            {
              ...ONLY_FOLLOWERS,
              activity: { type: "Delete", id: "https://kopje.test/ap/o/t#delete", object: "https://kopje.test/ap/o/t" },
            } as DeliveryEnvelope,
            NOW,
            1,
            "bounded",
          )!;
          stageRetraction(db, SIGNER, "https://kopje.test/ap/o/t", STAGE_MIN_ROWS);
          return db.first<{ staged: string }>("SELECT staged FROM outbound_activities WHERE id = ?", id)!.staged;
        });
      });
      const before = await sql(t.store, "SELECT * FROM retraction_stagings WHERE id = ?", other);
      await sql(
        t.store,
        "UPDATE outbound_activities SET staged = ? WHERE id = ?",
        value === "other" ? other : value,
        t.intent,
      );
      expect(await t.finish()).toBe(true);
      const reached = inboxesOf(await t.targets());
      expect(reached.length).toBe(12);
      expect(new Set(reached).size).toBe(12);
      expect(await sql(t.store, "SELECT * FROM retraction_stagings WHERE id = ?", other)).toEqual(before);
    },
    120_000,
  );

  it("rolls a failing call back whole in its job batch, which records the attempt, and finishes on the retry", async () => {
    const t = await prepared(
      EMPTY,
      (sql) => {
        followers(sql, 8);
        sql.exec(
          "INSERT INTO inbound_jobs (kind, key, actor_uri, created_at) VALUES ('delete', ?, 'https://kopje.test/ap/users/alice', 0)",
          STATUS,
        );
      },
      ONLY_FOLLOWERS,
    );
    await sql(
      t.store,
      `CREATE TRIGGER test_third_reach BEFORE INSERT ON retraction_reach
			WHEN (SELECT count(*) FROM retraction_reach) >= 2 BEGIN SELECT RAISE(ABORT, 'refused'); END`,
    );
    const state = () =>
      sql(
        t.store,
        `SELECT (SELECT count(*) FROM retraction_stagings) AS stagings, (SELECT count(*) FROM retraction_reach) AS reach,
					(SELECT count(*) FROM sqlite_sequence WHERE name = 'retraction_stagings') AS sequence,
					(SELECT staged FROM outbound_activities WHERE id = ?) AS staged,
					(SELECT attempts FROM inbound_jobs WHERE kind = 'delete' AND key = ?) AS attempts`,
        t.intent,
        STATUS,
      );
    await t.store.runInboundJobs(BUILD, { now: NOW });
    expect(await state()).toEqual([{ stagings: 0, reach: 0, sequence: 0, staged: "", attempts: 1 }]);
    await sql(t.store, "DROP TRIGGER test_third_reach");
    for (let round = 1; round < 20; round++) {
      if (!(await t.store.runInboundJobs(BUILD, { now: NOW + round * 60 * 60_000 })).pending) {
        break;
      }
    }
    const reached = inboxesOf(await t.targets());
    expect([...reached].toSorted()).toEqual(
      Array.from({ length: 8 }, (_, i) => `https://f${i + 1}.example/inbox`).toSorted(),
    );
  }, 120_000);

  it("moves its cursor alone in a call that meets only targets it has staged", async () => {
    const t = await prepared(
      EMPTY,
      (sql) => followers(sql, 3 * STAGING_READ, () => "https://shared.example/inbox"),
      ONLY_FOLLOWERS,
    );
    expect(await t.call(PURGE_BATCH)).toEqual({ done: false, wrote: 2 + 1 + 1 });
    const at = (await t.staging())!.after_id;
    expect(await t.call(PURGE_BATCH)).toEqual({ done: false, wrote: 1 });
    expect(Number((await t.staging())!.after_id)).toBeGreaterThan(Number(at));
    expect(await sql(t.store, "SELECT json_array_length(accounts) AS n FROM retraction_reach")).toEqual([
      { n: PROVENANCE_MAX + 1 },
    ]);
  }, 120_000);
});

describe("a staged retraction across calls (RES-6)", () => {
  it("merges the recipients behind a target over the calls that reach it", async () => {
    // 40 followers on two shared inboxes, a call at a time of STAGE_MIN_ROWS rows: each target is reached in many.
    const t = await prepared(
      EMPTY,
      (sql) => followers(sql, 40, (i) => `https://s${i % 2}.example/inbox`),
      ONLY_FOLLOWERS,
    );
    expect(t.oracle.some((x) => x.includes('"many":true'))).toBe(true);
    expect(await t.finish()).toBe(true);
    expect([...(await t.targets())].toSorted()).toEqual([...t.oracle].toSorted());
    // 10 followers on one inbox: its account ids listed, merged over the calls.
    const u = await prepared(EMPTY, (sql) => followers(sql, 10, () => "https://one.example/inbox"), ONLY_FOLLOWERS);
    expect(await u.finish()).toBe(true);
    expect(await u.targets()).toEqual(u.oracle);
    expect((JSON.parse(u.oracle[0]!) as Target).accounts).toHaveLength(10);
  }, 120_000);

  it("keeps the lower account id’s inbox for one decoded addressee reached in two calls", async () => {
    // The higher id is in the envelope's accounts, read first; six mentions fill that call; the lower id boosts.
    const t = await prepared(
      {
        ...EMPTY,
        remotes: [
          { ...REMOTE, boosts: 1 },
          { ...REMOTE },
          ...Array.from({ length: 6 }, () => ({ ...REMOTE, mentioned: true })),
        ],
      },
      (sql) => oneAddressee(sql, "https://low.example/inbox", "https://high.example/inbox"),
      { audience: { followers: false, accounts: [ACCOUNT(1)], status: STATUS, distributable: true } },
    );
    expect(await t.finish()).toBe(true);
    const personal = (await t.targets())
      .map((x) => JSON.parse(x) as Target)
      .filter((x) => x.inbox.includes(".example/inbox") && x.addressee?.startsWith("https://x.example/u"));
    expect(personal.map((x) => x.inbox)).toEqual(["https://low.example/inbox"]);
    expect([...(await t.targets())].toSorted()).toEqual([...t.oracle].toSorted());
  }, 120_000);

  it("writes out its last targets and ends within the maxRows of the call that empties the set", async () => {
    const t = await prepared(EMPTY, (sql) => followers(sql, 12), ONLY_FOLLOWERS);
    expect(await t.until(STAGE_MIN_ROWS, async () => (await t.staging())?.phase === "emit")).toBe(false);
    const [{ n }] = (await sql<{ n: number }>(t.store, "SELECT count(*) AS n FROM retraction_reach")) as [
      { n: number },
    ];
    expect(n).toBeGreaterThan(STAGE_MIN_ROWS);
    // The rows and their chunk, then the staging's end: room for the rows and one chunk, two rows short of the end.
    let last = { done: false, wrote: 0 };
    for (let call = 0; call < 20 && !last.done; call++) {
      const left = (await sql<{ n: number }>(t.store, "SELECT count(*) AS n FROM retraction_reach"))[0]!.n;
      const maxRows = Math.max(STAGE_MIN_ROWS, left + 2);
      last = await t.call(maxRows);
      expect(last.wrote, `call ${call}`).toBeLessThanOrEqual(maxRows);
    }
    expect(last.done).toBe(true);
    expect(await t.left()).toBe(0);
  }, 120_000);

  it("keeps its intent while every chunk it has written is delivered, and writes the rest", async () => {
    const t = await prepared(EMPTY, (sql) => followers(sql, 12), ONLY_FOLLOWERS);
    expect(await t.until(STAGE_MIN_ROWS, async () => (await t.staging())?.phase === "emit")).toBe(false);
    const counts = async () =>
      (
        await sql<{ targets: number; deliveries: number; reach: number; intent: number; staged: number }>(
          t.store,
          `SELECT (SELECT count(*) FROM outbound_targets WHERE activity_id = ?1) AS targets,
						(SELECT count(*) FROM deliveries WHERE activity_id = ?1) AS deliveries,
						(SELECT count(*) FROM retraction_reach) AS reach,
						(SELECT count(*) FROM outbound_activities WHERE id = ?1) AS intent,
						(SELECT count(*) FROM outbound_activities WHERE id = ?1 AND staged IS NOT NULL) AS staged`,
          t.intent,
        )
      )[0]!;
    // A partial write-out: a chunk written, reach rows left for later calls.
    expect((await t.call(STAGE_MIN_ROWS)).done).toBe(false);
    expect((await t.staging())?.phase).toBe("emit");
    const partial = await counts();
    expect(partial.targets).toBeGreaterThan(0);
    expect(partial.reach).toBeGreaterThan(0);
    // Claims and delivers every row of the intent until it holds none: each completion drops its row and asks
    // dropSettledActivity to delete the intent, which only its staged IS NULL refuses.
    const delivered: string[] = [];
    const drain = async () => {
      for (let round = 0; round < 50; round++) {
        const left = await counts();
        if (left.targets === 0 && left.deliveries === 0) {
          return;
        }
        const claim = await t.store.claimDeliveries(BUILD, { now: NOW, leaseToken: `drain-${round}` });
        for (const d of claim.deliveries) {
          const [row] = await sql<{ activity_id: string; inbox_url: string }>(
            t.store,
            "SELECT CAST(activity_id AS TEXT) AS activity_id, inbox_url FROM deliveries WHERE id = CAST(? AS INTEGER)",
            d.id,
          );
          expect(row?.activity_id).toBe(t.intent);
          const completion = await t.store.completeDelivery(BUILD, {
            id: d.id,
            leaseToken: `drain-${round}`,
            now: NOW,
            outcome: { kind: "delivered", status: 202 },
          });
          expect(completion.status).toBe("delivered");
          delivered.push(row!.inbox_url);
        }
      }
      throw new Error("the deliveries did not drain");
    };
    await drain();
    expect(delivered.length).toBeGreaterThan(0);
    expect(await counts()).toMatchObject({ targets: 0, deliveries: 0, intent: 1, staged: 1 });
    expect((await counts()).reach).toBeGreaterThan(0);
    // The rest is written, and once endStaging clears staged the same statement deletes the settled intent.
    expect(await t.finish()).toBe(true);
    await drain();
    expect(delivered.toSorted()).toEqual(inboxesOf(t.oracle).toSorted());
    expect(new Set(delivered).size).toBe(12);
    expect(await t.left()).toBe(0);
    expect((await counts()).intent).toBe(0);
  }, 120_000);
});

// The staging the intent's staged names, set to `phase` with the staged rows `rows` inserts (?1: its id), as an import
// may leave it.
async function stagedAs(t: Awaited<ReturnType<typeof prepared>>, phase: string, rows: string): Promise<string> {
  return runInDurableObject(t.store, (_instance, state) =>
    state.storage.transactionSync(() => {
      const sql = state.storage.sql;
      const id = sql
        .exec<{ id: string }>(
          `INSERT INTO retraction_stagings (activity_id, follow_bound, phase) VALUES (?, 0, ?)
					RETURNING CAST(id AS TEXT) AS id`,
          t.intent,
          phase,
        )
        .one().id;
      sql.exec("UPDATE outbound_activities SET staged = ? WHERE id = ?", id, t.intent);
      sql.exec(rows, id);
      return id;
    }),
  );
}

describe("a staged retraction’s writing out (RES-6)", () => {
  it("prices a page by the staged rows it deletes, refused ones too, and the chunks it writes", async () => {
    const t = await prepared(EMPTY, () => {}, ONLY_FOLLOWERS);
    // 401 targets (five chunks), then four rows whose JSON chunked() refuses (100,000 escaped control characters
    // each), sorting last. A call of 409 rows has 406 after the staging's end: its page is 405 rows, and the five
    // chunks fit only with the first 401 deleted.
    await stagedAs(
      t,
      "emit",
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 405)
			INSERT INTO retraction_reach (staging_id, neutral, key, accounts)
			SELECT CAST(?1 AS INTEGER), 1, CASE WHEN i <= 401 THEN printf('https://r%03d.example/inbox', i)
				ELSE 'https://z' || i || '.example/' || replace(hex(zeroblob(100000)), '00', char(1)) END, '[]' FROM n`,
    );
    expect(await t.call(409)).toEqual({ done: false, wrote: 401 + 5 });
    expect(await t.finish()).toBe(true);
    const reached = inboxesOf(await t.targets());
    expect(reached).toEqual(
      Array.from({ length: 401 }, (_, i) => `https://r${String(i + 1).padStart(3, "0")}.example/inbox`),
    );
    expect(await t.left()).toBe(0);
  }, 120_000);
});

describe("a staged forward (RES-6, VIS-3)", () => {
  it("resolves its shares as it reaches them and reaches the followers after them, each call within its bounds", async () => {
    // 600 shares that resolve to no boost of the signer (an import's), then its boost 50 times, its uri of 300,000
    // bytes (an import's), which stays in SQL, with receipts and an earlier Announce's rows; the signer's followers.
    const ORIGINAL = "https://r.example/o/1";
    const BOOSTED = `https://kopje.test/ap/o/${"b".repeat(300_000)}`;
    const shares = [
      ...Array.from({ length: 600 }, (_, i) => (i % 100 === 0 ? i : `9${String(i).padStart(17, "0")}`)),
      ...Array.from({ length: 50 }, () => BOOST(1)),
    ];
    const envelope: DeliveryEnvelope = {
      activity: { type: "Delete", id: `${ORIGINAL}#delete`, actor: "https://r.example/users/x", object: ORIGINAL },
      audience: { followers: false, accounts: [], shares } as DeliveryEnvelope["audience"],
    };
    const store = await migratedStore();
    const result = await runInDurableObject(store, (_instance, state) => {
      const real = state.storage.sql;
      state.storage.transactionSync(() => seed(real, EMPTY));
      // Statistics taken before the growth.
      real.exec("ANALYZE");
      state.storage.transactionSync(() => {
        followers(real, 30);
        real.exec(
          `INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at, withdrawn)
					VALUES (?, ?, ?, ?, 'public', '2026-01-01', 1)`,
          BOOST(1),
          BOOSTED,
          SIGNER,
          STATUS,
        );
        for (let i = 0; i < 20; i++) {
          real.exec(
            "INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at) VALUES (?, ?, ?, 0)",
            BOOST(1),
            `https://e${i}.example/inbox`,
            SIGNER,
          );
        }
        const announce = real
          .exec<{ id: number }>(
            `INSERT INTO outbound_activities (account_id, body, object_uri, retracts, created_at)
						VALUES (?, '{"activity":{"type":"Announce"},"audience":{"followers":true,"accounts":[]}}', ?, 0, 0)
						RETURNING id`,
            SIGNER,
            BOOSTED,
          )
          .one().id;
        for (let i = 0; i < 5; i++) {
          real.exec(
            `INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
						VALUES (?, ?, ?, 'x', 'pending', 0, 0)`,
            announce,
            SIGNER,
            `https://d${i}.example/inbox`,
          );
        }
      });
      const oracle = audienceTargets(new Db(real), SIGNER, envelope.activity, envelope.audience)
        .map(comparable)
        .filter((x): x is string => x !== null);
      const intent = state.storage.transactionSync(() =>
        beginRetraction(new Db(real), SIGNER, envelope, NOW, 1, "bounded")!,
      );
      const subject = forwardSubject(ORIGINAL);
      const calls: { reads: number; bytes: number; json: number; shares: number; wrote: number; maxRows: number }[] =
        [];
      const plans = new Map<string, string[]>();
      const rows = drawnRows(97);
      for (let call = 0; call < 500; call++) {
        const meter = { reads: 0, bytes: 0, json: 0, shares: 0 };
        const db = new Db(metered(real, meter, plans), (fn) => state.storage.transactionSync(fn));
        const changes = () => new Db(real).first<{ n: number }>("SELECT total_changes() AS n")!.n;
        const maxRows = rows[call % rows.length]!;
        const before = changes();
        const done = state.storage.transactionSync(() => stageRetraction(db, SIGNER, subject, maxRows, intent));
        calls.push({ ...meter, wrote: changes() - before, maxRows });
        if (done) {
          break;
        }
      }
      const body = real
        .exec<{ n: number }>("SELECT length(CAST(body AS BLOB)) AS n FROM outbound_activities WHERE id = ?", intent)
        .one().n;
      return {
        oracle,
        written: written(real, intent),
        calls,
        body,
        text: intentText(real, intent),
        plans: [...plans],
      };
    });
    expect(result.calls.length).toBeGreaterThan(2);
    // Every share's element was pulled and counted, the page each call leaves open closed at its end.
    expect(result.calls.reduce((n, call) => n + call.shares, 0)).toBeGreaterThanOrEqual(shares.length);
    expect(result.plans.flatMap(([query, plan]) => plan.filter(scanned).map((line) => `${line} in ${query}`))).toEqual(
      [],
    );
    for (const [i, call] of result.calls.entries()) {
      expect(call.wrote, `call ${i}`).toBeLessThanOrEqual(call.maxRows);
      expect(call.reads - call.json, `call ${i}`).toBeLessThanOrEqual(tableReads(call.maxRows));
      expect(call.json, `call ${i}`).toBeLessThanOrEqual(jsonSteps(result.body));
      expect(call.bytes, `call ${i}`).toBeLessThanOrEqual(textCeiling(result.text));
    }
    const reached = new Set(inboxesOf(result.written));
    for (let i = 1; i <= 30; i++) {
      expect(reached.has(`https://f${i}.example/inbox`), `follower ${i}`).toBe(true);
    }
    expect(reached.has("https://e0.example/inbox") && reached.has("https://d0.example/inbox")).toBe(true);
    expect(new Set(result.written).size).toBe(result.written.length);
    expect([...result.written].toSorted()).toEqual([...result.oracle].toSorted());
  }, 300_000);
});

describe("the sweep of an ended staging (RES-6)", () => {
  it("drains more staged rows than SWEEP_BATCH, each of 512 KiB, within SWEEP_BATCH rows a round", async () => {
    const t = await prepared(EMPTY, () => {}, ONLY_FOLLOWERS);
    await stagedAs(
      t,
      "followers",
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 501)
			INSERT INTO retraction_reach (staging_id, neutral, key, accounts)
			SELECT CAST(?1 AS INTEGER), 1, printf('https://k%04d.example/', i) || replace(hex(zeroblob(?2)), '00', 'x'), '[]'
			FROM n`.replace("?2", String(TARGET_CHUNK_BYTES - "https://k0001.example/".length)),
    );
    // Superseded: its staging ended, its intent dropped.
    await runInDurableObject(t.store, (_instance, state) =>
      state.storage.transactionSync(() => supersedeEarlier(new Db(state.storage.sql), SIGNER, STATUS_URI, 10)),
    );
    expect(await sql(t.store, "SELECT ended FROM retraction_stagings")).toEqual([{ ended: 1 }]);
    const swept: number[] = [];
    for (let round = 0; round < 5 && (await t.left()) > 0; round++) {
      swept.push((await t.store.sweepDeliveries(BUILD, { now: NOW })).swept);
    }
    // 501 rows and the staging's own: the first round deletes 499 and keeps room for the staging's row.
    expect(swept).toEqual([499, 3]);
    expect(await t.left()).toBe(0);
  }, 300_000);
});

describe("the heap of a staging call (RES-6)", () => {
  it("is bounded by the per-column maxima its reads and budgets admit", () => {
    // rowHeapBytes' model ("Heap at 8 MiB per answer" in docs/threat-model.md): 64 bytes an object, 32 a value, two a
    // code unit, which UTF-8 bytes bound. SQLite parses every stored list and chunk; the Worker holds only rows.
    const text = (units: number) => "x".repeat(units);
    const id = text(18);
    // Gathering: STAGING_READ candidate rows; their text within STAGING_BYTES, or a uri past the bound read first for
    // a name within the body (ROW_LIMIT at most), and the row that crosses it (three values at the bound), each
    // target's key held twice (its own and the map's); up to PROVENANCE_MAX + 1 account ids for each of PURGE_BATCH
    // targets (the rows a call may write) and a resolved share for each candidate.
    const candidate = rowHeapBytes({
      key: id,
      id,
      uri: "",
      uri_bytes: 0,
      inbox_url: "",
      inbox_url_bytes: 0,
      reach: "",
      reach_bytes: 0,
    });
    const values = 2 * 2 * (Math.max(STAGING_BYTES, ROW_LIMIT) + 3 * TARGET_CHUNK_BYTES);
    const provenance = PURGE_BATCH * ((PROVENANCE_MAX + 1) * rowHeapBytes({ id }) + rowHeapBytes({ from: id }));
    const shares = STAGING_READ * rowHeapBytes({ id });
    const gathering = 1.25 * STAGING_READ * candidate + values + provenance + shares;
    // Writing out: STAGING_READ staged rows (accounts at the CHECK's 1,024 bytes); their keys and inboxes, whose JSON
    // (json_quote, which their decoded JSON never exceeds in code units) is within EMIT_BYTES and the row that
    // crosses it at the bound; each target's JSON, at most that and its provenance, and the chunks joined from it;
    // one target's UTF-8 measure (three bytes a code unit).
    const staged = rowHeapBytes({
      neutral: 0,
      accounts: text(1024),
      unknown: 0,
      json: 0,
      refused: 0,
      key: "",
      inbox: "",
    });
    const page = EMIT_BYTES + TARGET_CHUNK_BYTES;
    const json = 2 * (page + STAGING_READ * 2 * 1024);
    const writing = 1.25 * STAGING_READ * staged + 2 * page + 2 * json + 3 * (TARGET_CHUNK_BYTES + 2 * 1024);
    const own = gathering + writing;
    console.log(JSON.stringify({ event: "retraction-staging-heap", gathering, writing, own }));
    expect(own).toBeLessThan(32 * 1024 * 1024);
  });
});

describe("a staged retraction in a dump (RES-6)", () => {
  it.each([
    ["gathering", "followers"],
    ["writing out", "emit"],
  ])(
    "goes on %s in the Store restored from it, to the same targets",
    async (_name, phase) => {
      const t = await prepared(EMPTY, (sql) => followers(sql, 40), ONLY_FOLLOWERS);
      expect(await t.until(STAGE_MIN_ROWS, async () => (await t.staging())?.phase === phase)).toBe(false);
      if (phase === "emit") {
        expect((await t.call(STAGE_MIN_ROWS + 2)).done).toBe(false);
        expect((await t.targets()).length).toBeGreaterThan(0);
      }
      expect(await t.left()).toBeGreaterThan(1);
      await ensureAdmin(t.store);
      const { text } = await dumpViaRpc(t.store);
      const target = await migratedStore();
      await copyConfig(t.store, target);
      const { report } = await importViaRpc(target, text);
      expect(report).toMatchObject({ ok: true, foreignKeyViolations: 0 });
      expect(await target.publish(BUILD, ACCESS)).toMatchObject({ ok: true });
      const state = (store: StoreStub) =>
        sql(store, "SELECT * FROM retraction_stagings ORDER BY id").then(async (stagings) => ({
          stagings,
          reach: await sql(store, "SELECT * FROM retraction_reach ORDER BY staging_id, neutral, key"),
        }));
      expect(await state(target)).toEqual(await state(t.store));
      const done = await runInDurableObject(target, (_instance, state) => {
        expect(stageAll(state, [STAGE_MIN_ROWS], 200).over).toBe(0);
        return written(state.storage.sql, t.intent);
      });
      expect(new Set(done).size).toBe(done.length);
      expect([...done].toSorted()).toEqual([...t.oracle].toSorted());
    },
    120_000,
  );
});

describe("the end of a staging superseded with its retraction (RES-6)", () => {
  it("is the third row of each superseded retraction still staging, as the request maxima count it", async () => {
    const t = await prepared(EMPTY, () => {}, ONLY_FOLLOWERS);
    // Ten more retractions of the status still staging, each with its staging (only an import holds them), no rows.
    await runInDurableObject(t.store, (_instance, state) =>
      state.storage.transactionSync(() => {
        const sql = state.storage.sql;
        for (let i = 0; i < 10; i++) {
          const intent = sql
            .exec<{ id: number }>(
              `INSERT INTO outbound_activities (account_id, body, object_uri, retracts, staged, created_at)
							VALUES (?, '{"activity":{"type":"Delete"},"audience":{"followers":true,"accounts":[]}}', ?, 1, '', 0)
							RETURNING id`,
              SIGNER,
              STATUS_URI,
            )
            .one().id;
          const staging = sql
            .exec<{ id: number }>(
              "INSERT INTO retraction_stagings (activity_id, follow_bound, phase) VALUES (?, 0, 'followers') RETURNING id",
              intent,
            )
            .one().id;
          sql.exec("UPDATE outbound_activities SET staged = ? WHERE id = ?", String(staging), intent);
        }
      }),
    );
    const superseded = await writtenBy(t.store, (db) => supersedeEarlier(db, SIGNER, STATUS_URI, 12));
    // The earlier Create and the retraction not staged yet: an update and a drop each; then the ten, three rows each.
    expect(superseded.rows).toBe(2 + 2 + 3 * 10);
    expect(await sql(t.store, "SELECT count(*) AS n FROM retraction_stagings WHERE ended = 1")).toEqual([{ n: 10 }]);
  }, 120_000);
});

// Stages the prepared retraction to its end in calls of `maxRows`, each metered: the most text a call returned, and the
// stored bytes of what it reads of the body (intentText).
async function meteredFinish(t: Awaited<ReturnType<typeof prepared>>, maxRows = STAGE_MIN_ROWS) {
  return runInDurableObject(t.store, (_instance, state) => {
    const real = state.storage.sql;
    const text = intentText(real, t.intent);
    let bytes = 0;
    for (let call = 0; call < 2000; call++) {
      const meter = { reads: 0, bytes: 0 };
      const db = new Db(metered(real, meter), (fn) => state.storage.transactionSync(fn));
      const done = state.storage.transactionSync(() => stageRetraction(db, SIGNER, STATUS_URI, maxRows));
      bytes = Math.max(bytes, meter.bytes);
      if (done) {
        return { bytes, text };
      }
    }
    throw new Error("the staging did not end");
  });
}

// The world's retraction, staged to its end, against audienceTargets at the start (the oracle).
async function staysTheOracle(t: Awaited<ReturnType<typeof prepared>>): Promise<string[]> {
  expect(await t.finish()).toBe(true);
  const written = await t.targets();
  expect(new Set(written).size).toBe(written.length);
  expect([...written].toSorted()).toEqual([...t.oracle].toSorted());
  expect(await t.left()).toBe(0);
  return inboxesOf(written);
}

// ACCOUNT(0) and ACCOUNT(1) given raw uris that differ only in a last byte (FF, FE: malformed, each decoding to one
// addressee, built in SQL), at the inboxes `low` and `high`.
function oneAddressee(sql: SqlStorage, low: string, high: string): void {
  for (const [i, byte, inbox] of [
    [0, "FF", low],
    [1, "FE", high],
  ] as const) {
    sql.exec(
      `UPDATE accounts SET uri = CAST(CAST('https://x.example/u' AS BLOB) || unhex(?) AS TEXT), inbox_url = ? WHERE id = ?`,
      byte,
      inbox,
      ACCOUNT(i),
    );
  }
}

const delete_ = (to?: string[]) => ({
  type: "Delete",
  id: `${STATUS_URI}#delete`,
  actor: "https://kopje.test/ap/users/alice",
  object: STATUS_URI,
  ...(to === undefined ? {} : { to }),
});

describe("a staged retraction reads its sources as audienceTargets does (RES-6)", () => {
  it("charges the values of an account that is no recipient", async () => {
    // Eight local accounts listed, each with a uri and inboxes of 400,000 bytes.
    const big = (c: string) => `'https://kopje.test/' || replace(hex(zeroblob(400000)), '00', '${c}')`;
    const ids = Array.from({ length: 8 }, (_, i) => `7${String(i).padStart(17, "0")}`);
    const t = await prepared(
      EMPTY,
      (sql) => {
        for (const id of ids) {
          sql.exec(
            `INSERT INTO accounts (id, uri, username, domain, inbox_url, shared_inbox_url)
						VALUES (?, ${big("u")} || ?1, 'l' || ?1, NULL, ${big("i")}, ${big("s")})`,
            id,
          );
        }
      },
      { activity: delete_([]), audience: { followers: false, accounts: ids } },
    );
    const { bytes, text } = await meteredFinish(t);
    expect(bytes).toBeLessThanOrEqual(textCeiling(text));
    expect(bytes).toBeGreaterThan(STAGING_BYTES);
    expect(await t.targets()).toEqual([]);
  }, 120_000);

  it("passes receipts whose inbox is a BLOB", async () => {
    const t = await prepared(EMPTY, (sql) => {
      for (let i = 0; i < 5; i++) {
        sql.exec(
          "INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at) VALUES (?, ?, ?, 0)",
          STATUS,
          `https://e${i}.example/inbox`,
          SIGNER,
        );
      }
      for (const blob of ["X'68747470733A2F2F622E6578616D706C652F696E626F78'", "X'00'"]) {
        sql.exec(
          `INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at) VALUES (?, ${blob}, ?, 0)`,
          STATUS,
          SIGNER,
        );
      }
    });
    const reached = await staysTheOracle(t);
    expect(reached.filter((inbox) => inbox.startsWith("https://e"))).toHaveLength(5);
  }, 120_000);

  it("reads no rows of an earlier retraction, the one a call resumes at included", async () => {
    // 300 earlier intents about the status, every other one a retraction, each with a row of its own inbox.
    const t = await prepared(EMPTY, (sql) => {
      for (let i = 0; i < 300; i++) {
        const id = sql
          .exec<{ id: number }>(
            `INSERT INTO outbound_activities (account_id, body, object_uri, retracts, created_at)
						VALUES (?, '{"activity":{"type":"Update"},"audience":{"followers":false,"accounts":[]}}', ?, ?, 0)
						RETURNING id`,
            SIGNER,
            STATUS_URI,
            i % 2,
          )
          .one().id;
        sql.exec(
          `INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
					VALUES (?, ?, ?, 'x', 'pending', 0, 0)`,
          id,
          SIGNER,
          `https://k${i}.example/inbox`,
        );
      }
    });
    const reached = await staysTheOracle(t);
    expect(reached.filter((inbox) => inbox.startsWith("https://k"))).toHaveLength(150);
  }, 120_000);

  it("reaches the voters of a REAL generation, and targets past a REAL next", async () => {
    const t = await prepared(
      {
        ...EMPTY,
        remotes: [
          { ...REMOTE, inbox: 1, votes: [0] },
          { ...REMOTE, inbox: 5 },
        ],
      },
      (sql) => {
        sql.exec("UPDATE polls SET generation = 0.5 WHERE status_id = ?", STATUS);
        sql.exec(
          "INSERT INTO poll_votes (poll_id, account_id, choice, generation) VALUES (?, ?, 0, 0.5)",
          STATUS,
          ACCOUNT(1),
        );
        const create = sql
          .exec<{ id: number }>("SELECT id FROM outbound_activities WHERE object_uri = ? AND retracts = 0", STATUS_URI)
          .one().id;
        sql.exec(
          "INSERT INTO outbound_targets (activity_id, targets, next) VALUES (?, ?, 0.5)",
          create,
          JSON.stringify([0, 1, 2].map((i) => ({ inbox: `https://n${i}.example/inbox`, addressee: null }))),
        );
      },
    );
    const reached = await staysTheOracle(t);
    expect(reached).toContain(POOL[5]);
    expect(reached).not.toContain(POOL[1]);
    expect(reached.filter((inbox) => inbox.startsWith("https://n")).toSorted()).toEqual([
      "https://n1.example/inbox",
      "https://n2.example/inbox",
    ]);
  }, 120_000);

  it("reads an audience whose accounts are an object, a truthy followers and a target held as JSON text", async () => {
    const t = await prepared(
      {
        ...EMPTY,
        remotes: [
          { ...REMOTE, inbox: 1 },
          { ...REMOTE, inbox: 2, follower: true },
        ],
      },
      (sql) => {
        const create = sql
          .exec<{ id: number }>("SELECT id FROM outbound_activities WHERE object_uri = ? AND retracts = 0", STATUS_URI)
          .one().id;
        sql.exec(
          "INSERT INTO outbound_targets (activity_id, targets) VALUES (?, ?)",
          create,
          JSON.stringify([JSON.stringify({ inbox: "https://j.example/inbox", addressee: null })]),
        );
      },
      {
        activity: delete_(),
        audience: { followers: 1, accounts: { a: ACCOUNT(0) } } as unknown as DeliveryEnvelope["audience"],
      },
    );
    const reached = await staysTheOracle(t);
    expect(reached).toEqual(expect.arrayContaining([POOL[1], POOL[2], "https://j.example/inbox"]));
  }, 120_000);

  it("reaches at its shared inbox an account whose uri past the bound decodes to a name of to", async () => {
    const name = `https://big.example/${"n".repeat(TARGET_CHUNK_BYTES)}�`;
    const t = await prepared(
      { ...EMPTY, remotes: [{ ...REMOTE, listed: true, shared: 1 }] },
      (sql) => {
        sql.exec(
          `UPDATE accounts SET uri = CAST(CAST(? AS BLOB) || X'FF' AS TEXT) WHERE id = ?`,
          name.slice(0, -1),
          ACCOUNT(0),
        );
      },
      { activity: delete_([name]), audience: { followers: false, accounts: [ACCOUNT(0)] } },
    );
    expect(await staysTheOracle(t)).toContain(POOL[1]);
  }, 120_000);

  it("keeps the lower account id’s refusal for one decoded addressee reached in two calls", async () => {
    // As above, the lower id's inbox past the bound: audienceTargets keeps it, and chunked() refuses the copy.
    const t = await prepared(
      {
        ...EMPTY,
        remotes: [
          { ...REMOTE, boosts: 1 },
          { ...REMOTE },
          ...Array.from({ length: 6 }, () => ({ ...REMOTE, mentioned: true })),
        ],
      },
      (sql) => oneAddressee(sql, `https://low.example/${"i".repeat(TARGET_CHUNK_BYTES)}`, "https://high.example/inbox"),
      { audience: { followers: false, accounts: [ACCOUNT(1)], status: STATUS, distributable: true } },
    );
    const reached = await staysTheOracle(t);
    expect(reached).not.toContain("https://high.example/inbox");
  }, 120_000);
});

describe("a staged retraction’s cursor saves (RES-6)", () => {
  it("writes no row for a resumed receipts page’s save, whose cursor moved in SQL", async () => {
    const t = await prepared(EMPTY, (sql) => {
      for (let i = 0; i < 1500; i++) {
        sql.exec(
          "INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at) VALUES (?, ?, ?, 0)",
          STATUS,
          `https://e${String(i).padStart(4, "0")}.example/inbox`,
          SIGNER,
        );
      }
    });
    const cursor = async () =>
      (
        await sql<{ phase: string; after_key: string | null }>(
          t.store,
          "SELECT phase, after_key FROM retraction_stagings WHERE id = (SELECT CAST(staged AS INTEGER) FROM outbound_activities WHERE id = ?)",
          t.intent,
        )
      )[0];
    expect(await t.until(PURGE_BATCH, async () => (await cursor())?.after_key != null)).toBe(false);
    const staged = async () => (await sql<{ n: number }>(t.store, "SELECT count(*) AS n FROM retraction_reach"))[0]!.n;
    const before = await staged();
    const { done, wrote } = await t.call(PURGE_BATCH);
    expect(done).toBe(false);
    expect(await cursor()).toMatchObject({ phase: "receipts" });
    // The staged rows and the cursor's update in SQL, and nothing for the save.
    expect(wrote).toBe((await staged()) - before + 1);
  }, 120_000);
});

describe("a staged retraction’s write-out, refused rows first (RES-6)", () => {
  it("prices each chunk by the rows before it, refused ones included", async () => {
    const t = await prepared(EMPTY, () => {}, ONLY_FOLLOWERS);
    // Five rows whose JSON chunked() refuses (87,400 escaped control characters each), sorting first, then 401
    // targets. A call of 410 rows has 407 after the staging's end: its page is 406 rows, and three chunks fit with
    // the 305 rows through them (308 rows written); a fourth would need 409.
    await stagedAs(
      t,
      "emit",
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 406)
			INSERT INTO retraction_reach (staging_id, neutral, key, accounts)
			SELECT CAST(?1 AS INTEGER), 1, CASE WHEN i > 5 THEN printf('https://r%03d.example/inbox', i - 5)
				ELSE 'https://a' || i || '.example/' || replace(hex(zeroblob(87400)), '00', char(1)) END, '[]' FROM n`,
    );
    expect(await t.call(410)).toEqual({ done: false, wrote: 305 + 3 });
    expect(await t.finish()).toBe(true);
    const reached = inboxesOf(await t.targets());
    expect(reached).toEqual(
      Array.from({ length: 401 }, (_, i) => `https://r${String(i + 1).padStart(3, "0")}.example/inbox`),
    );
    expect(await t.left()).toBe(0);
  }, 120_000);
});

// A local status's delete job for the world's status, run round by round until it holds no staging: each round's
// attempts (the runner records one for a batch that throws or does not advance its job).
async function jobRounds(t: Awaited<ReturnType<typeof prepared>>, rounds = 60): Promise<number[]> {
  const attempts: number[] = [];
  for (let round = 0; round < rounds; round++) {
    await t.store.runInboundJobs(BUILD, { now: NOW + round * 60 * 60_000 });
    const [row] = await sql<{ attempts: number; staged: string | null }>(
      t.store,
      `SELECT (SELECT attempts FROM inbound_jobs WHERE kind = 'delete' AND key = ?1) AS attempts,
				(SELECT staged FROM outbound_activities WHERE id = ?2) AS staged`,
      STATUS,
      t.intent,
    );
    attempts.push(row!.attempts);
    if (row!.staged === null) {
      return attempts;
    }
  }
  throw new Error(`the staging did not end: ${JSON.stringify(attempts)}`);
}

const DELETE_JOB =
  "INSERT INTO inbound_jobs (kind, key, actor_uri, created_at) VALUES ('delete', ?, 'https://kopje.test/ap/users/alice', 0)";

describe("a staged retraction’s reads under its one rule (RES-6)", () => {
  it("counts a nested seek before the next row, and consumes a uri past STAGING_BYTES that a name matches", async () => {
    // The audience's accounts: 497 elements that can be no account id, then A (its uri 550,000 bytes, named), one
    // more such element, then B (its uri 1,100,000 bytes, past STAGING_BYTES, named). A costs its row, its seek and
    // its uri's read: the 500th read of the first call, so the element after it waits for the next call.
    const long = (c: string, n: number) => `https://big.example/${c.repeat(n)}`;
    const [a, b] = [ACCOUNT(0), ACCOUNT(1)];
    const t = await prepared(
      {
        ...EMPTY,
        remotes: [
          { ...REMOTE, shared: 1 },
          { ...REMOTE, shared: 2 },
        ],
      },
      (sql) => {
        sql.exec("UPDATE accounts SET uri = ? WHERE id = ?", long("a", 550_000), a);
        sql.exec("UPDATE accounts SET uri = ? WHERE id = ?", long("b", 1_100_000), b);
        sql.exec(DELETE_JOB, STATUS);
      },
      {
        activity: delete_([long("a", 550_000), long("b", 1_100_000)]),
        audience: {
          followers: false,
          accounts: [...Array.from({ length: 497 }, (_, i) => i + 1), a, 0, b] as unknown as string[],
        },
      },
    );
    // The first call pulls the 498 elements through A and no more: the next pull waits for its admission.
    const first = await runInDurableObject(t.store, (_instance, state) => {
      const meter = { reads: 0, bytes: 0, accounts: 0 };
      const db = new Db(metered(state.storage.sql, meter), (fn) => state.storage.transactionSync(fn));
      const done = state.storage.transactionSync(() => stageRetraction(db, SIGNER, STATUS_URI, PURGE_BATCH));
      return { done, pulled: meter.accounts };
    });
    expect(first).toEqual({ done: false, pulled: 498 });
    expect(await t.staging()).toMatchObject({ phase: "accounts", after_index: 498 });
    // The job's rounds end the staging, none of them without progress.
    expect((await jobRounds(t)).every((n) => n === 0)).toBe(true);
    const reached = inboxesOf(await t.targets());
    expect(reached).toEqual(expect.arrayContaining([POOL[1], POOL[2]]));
    expect([...(await t.targets())].toSorted()).toEqual([...t.oracle].toSorted());
  }, 300_000);

  it("reads whether an earlier intent retracts before its rows, beyond a call’s reads", async () => {
    // An earlier retraction of the status with 5,000 delivery rows and 5,000 chunks, none of them evidence.
    const t = await prepared(EMPTY, (sql) => {
      const id = sql
        .exec<{ id: number }>(
          `INSERT INTO outbound_activities (account_id, body, object_uri, retracts, created_at)
					VALUES (?, '{"activity":{"type":"Delete"},"audience":{"followers":false,"accounts":[]}}', ?, 1, 0)
					RETURNING id`,
          SIGNER,
          STATUS_URI,
        )
        .one().id;
      sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
				INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
				SELECT ?1, ?2, 'https://x' || i || '.example/inbox', 'x', 'pending', 0, 0 FROM n`,
        id,
        SIGNER,
      );
      sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
				INSERT INTO outbound_targets (activity_id, targets)
				SELECT ?1, json_array(json_object('inbox', 'https://y' || i || '.example/inbox', 'addressee', NULL)) FROM n`,
        id,
      );
    });
    const calls = await runInDurableObject(t.store, (_instance, state) => {
      const real = state.storage.sql;
      const out: { reads: number; json: number }[] = [];
      for (let call = 0; call < 200; call++) {
        const meter = { reads: 0, bytes: 0, json: 0 };
        const db = new Db(metered(real, meter), (fn) => state.storage.transactionSync(fn));
        const done = state.storage.transactionSync(() => stageRetraction(db, SIGNER, STATUS_URI, STAGE_MIN_ROWS));
        out.push(meter);
        if (done) {
          return out;
        }
      }
      throw new Error("the staging did not end");
    });
    for (const [i, call] of calls.entries()) {
      expect(call.reads - call.json, `call ${i}`).toBeLessThanOrEqual(tableReads(STAGE_MIN_ROWS));
    }
    const written = await t.targets();
    expect([...written].toSorted()).toEqual([...t.oracle].toSorted());
    expect(inboxesOf(written).some((inbox) => /^https:\/\/[xy]/.test(inbox))).toBe(false);
  }, 300_000);

  it("reads no rows of the earlier retraction a resumed call’s cursor names", async () => {
    const t = await prepared(EMPTY, (sql) => {
      const id = sql
        .exec<{ id: number }>(
          `INSERT INTO outbound_activities (account_id, body, object_uri, retracts, created_at)
					VALUES (?, '{"activity":{"type":"Delete"},"audience":{"followers":false,"accounts":[]}}', ?, 1, 0)
					RETURNING id`,
          SIGNER,
          STATUS_URI,
        )
        .one().id;
      sql.exec(
        `INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
				VALUES (?, ?, 'https://z.example/inbox', 'x', 'pending', 0, 0)`,
        id,
        SIGNER,
      );
    });
    // A call that ended as its walk reached that retraction (an import's, or a call's last read).
    await stagedAs(
      t,
      "deliveries",
      `UPDATE retraction_stagings SET after_id = (SELECT id FROM outbound_activities WHERE retracts = 1 AND staged IS NULL)
			WHERE id = CAST(?1 AS INTEGER)`,
    );
    expect(await t.finish()).toBe(true);
    expect(inboxesOf(await t.targets())).not.toContain("https://z.example/inbox");
  }, 120_000);

  it("reaches an account whose uri is a BLOB at its shared inbox, for an activity that addresses no one", async () => {
    const t = await prepared(
      { ...EMPTY, remotes: [{ ...REMOTE, listed: true, shared: 3 }] },
      (sql) => {
        sql.exec(`UPDATE accounts SET uri = X'68747470733A2F2F622E6578616D706C652F75' WHERE id = ?`, ACCOUNT(0));
      },
      { activity: delete_(), audience: { followers: false, accounts: [ACCOUNT(0)] } },
    );
    expect(await staysTheOracle(t)).toContain(POOL[3]);
  }, 120_000);

  it("steps over at most the allowance of chunks past its first, each near the row limit of shortest elements", async () => {
    // Three chunks of 995,000 elements ('0', no target), each expanded but for its last ten: SQLite steps over the
    // elements before `next` to reach them. A call examines the first and stops before the second.
    const t = await prepared(EMPTY, (sql) => {
      const create = sql
        .exec<{ id: number }>("SELECT id FROM outbound_activities WHERE object_uri = ? AND retracts = 0", STATUS_URI)
        .one().id;
      const zeros = `[${Array.from({ length: 995_000 }, () => "0").join(",")}]`;
      for (let c = 0; c < 3; c++) {
        sql.exec("INSERT INTO outbound_targets (activity_id, targets, next) VALUES (?, ?, 994990)", create, zeros);
      }
    });
    const calls = await runInDurableObject(t.store, (_instance, state) => {
      const real = state.storage.sql;
      const body = real
        .exec<{ n: number }>("SELECT length(CAST(body AS BLOB)) AS n FROM outbound_activities WHERE id = ?", t.intent)
        .one().n;
      const out: { json: number; body: number }[] = [];
      for (let call = 0; call < 200; call++) {
        const meter = { reads: 0, bytes: 0, json: 0 };
        const db = new Db(metered(real, meter), (fn) => state.storage.transactionSync(fn));
        const done = state.storage.transactionSync(() => stageRetraction(db, SIGNER, STATUS_URI, PURGE_BATCH));
        out.push({ json: meter.json, body });
        if (done) {
          return out;
        }
      }
      throw new Error("the staging did not end");
    });
    expect(Math.max(...calls.map((c) => c.json))).toBeGreaterThan(990_000);
    for (const [i, call] of calls.entries()) {
      expect(call.json, `call ${i}`).toBeLessThanOrEqual(jsonSteps(call.body));
    }
  }, 300_000);
});

describe("a staged retraction’s audience scalars (RES-6)", () => {
  it("returns within the text ceiling a followers value of 1,900,000 malformed bytes", async () => {
    const t = await prepared(EMPTY, () => {}, ONLY_FOLLOWERS);
    // Built in SQL, so the 0xFF bytes are stored as they are, from a chunk of 950,000 concatenated twice (no value
    // along the way past SQLite's length limit); a string is truthy, so the followers are read.
    await sql(
      t.store,
      `WITH x(f) AS (SELECT CAST(unhex(replace(hex(zeroblob(950000)), '00', 'FF')) AS TEXT))
			UPDATE outbound_activities SET body = json_set(body, '$.audience.followers', (SELECT f || f FROM x)) WHERE id = ?`,
      t.intent,
    );
    const [stored] = await sql<{ bytes: number; ff: number; fffd: number; activity: number }>(
      t.store,
      `SELECT length(CAST(body AS BLOB)) AS bytes, instr(CAST(body AS BLOB), X'FF') AS ff,
				instr(CAST(body AS BLOB), X'EFBFBD') AS fffd, length(CAST(json_extract(body, '$.activity') AS BLOB)) AS activity
			FROM outbound_activities WHERE id = ?`,
      t.intent,
    );
    expect(stored).toMatchObject({ fffd: 0 });
    expect(stored!.ff).toBeGreaterThan(0);
    expect(stored!.bytes).toBeGreaterThan(1_900_000);
    expect(stored!.bytes).toBeLessThan(ROW_LIMIT);
    expect(stored!.activity).toBeLessThan(200);
    const { bytes, text } = await meteredFinish(t, PURGE_BATCH);
    // Decoded, the value alone is three times its stored bytes.
    expect(bytes).toBeGreaterThan(3 * 1_900_000);
    expect(bytes).toBeLessThanOrEqual(textCeiling(text));
  }, 300_000);
});

describe("the meter of these witnesses", () => {
  it("counts a page its reader leaves before the end once the page is closed, and nothing before", async () => {
    const store = await migratedStore();
    const counted = await runInDurableObject(store, (_instance, state) => {
      const meter = { reads: 0, bytes: 0 };
      const db = new Db(metered(state.storage.sql, meter));
      const page = db.iterate<{ v: string }>(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100) SELECT printf('%05d', i) AS v FROM n",
      );
      const rows = page[Symbol.iterator]();
      rows.next();
      rows.next();
      const open = { ...meter };
      rows.return?.(undefined);
      return { open, closed: { ...meter } };
    });
    expect(counted.open).toEqual({ reads: 0, bytes: 0 });
    expect(counted.closed.bytes).toBe(2 * 5);
    expect(counted.closed.reads).toBeGreaterThan(0);
  });
});

describe("a staged retraction’s lists hold ids only (RES-6)", () => {
  it("reads as no id an element of 18 digits, a NUL and a suffix, and returns none of it", async () => {
    // The audience's accounts: three elements of an account's id, a NUL and 550,000 malformed bytes (an import's;
    // three bytes each once decoded), then an account whose uri and inboxes each hold 524,000 bytes.
    const big = (c: string) => `https://kopje.test/${c.repeat(524_000 - 19)}`;
    const t = await prepared(
      { ...EMPTY, remotes: [{ ...REMOTE }, { ...REMOTE }] },
      (sql) => {
        sql.exec(
          "UPDATE accounts SET uri = ?, inbox_url = ?, shared_inbox_url = ? WHERE id = ?",
          big("u"),
          big("i"),
          big("s"),
          ACCOUNT(1),
        );
      },
      { activity: delete_(), audience: { followers: false, accounts: [ACCOUNT(1)] } },
    );
    // Built in SQL, so the 0xFF bytes are stored as they are (the Worker would decode each to U+FFFD).
    await sql(
      t.store,
      `WITH x(e) AS (SELECT '"' || ?2 || '\\u0000' || CAST(unhex(replace(hex(zeroblob(550000)), '00', 'FF')) AS TEXT) || '",')
			UPDATE outbound_activities SET body = replace(body, '"accounts":[', '"accounts":[' || (SELECT e || e || e FROM x))
			WHERE id = ?1`,
      t.intent,
      ACCOUNT(0),
    );
    const [stored] = await sql<{ n: number; bytes: number; ff: number; fffd: number }>(
      t.store,
      `SELECT json_array_length(body, '$.audience.accounts') AS n, length(CAST(body AS BLOB)) AS bytes,
				instr(CAST(body AS BLOB), X'FF') AS ff, instr(CAST(body AS BLOB), X'EFBFBD') AS fffd
			FROM outbound_activities WHERE id = ?`,
      t.intent,
    );
    // Four elements, the malformed bytes raw and none decoded, within the row limit.
    expect(stored).toMatchObject({ n: 4, fffd: 0 });
    expect(stored!.ff).toBeGreaterThan(0);
    expect(stored!.bytes).toBeGreaterThan(3 * 550_000);
    expect(stored!.bytes).toBeLessThan(ROW_LIMIT);
    const { bytes, text } = await meteredFinish(t, PURGE_BATCH);
    expect(bytes).toBeLessThanOrEqual(textCeiling(text));
    const written = await t.targets();
    expect([...written].toSorted()).toEqual([...t.oracle].toSorted());
    expect(inboxesOf(written)).toEqual([big("s")]);
  }, 300_000);
});
