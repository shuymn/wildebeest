import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";

import { MIGRATIONS } from "../src/db/migrations";
import type { Claim, ClaimedDelivery, DeliveryOutcome } from "../src/domain/deliveries";
import { STORE_JOB_FAMILIES } from "../src/jobs/queue";
import type { StoreStub } from "../src/platform/store-client";
import { type KernelOptions, type Migration, StoreKernel } from "../src/platform/store-kernel";

// The build identity of this test run: the Workers version id that both the Worker and the Store see.
export const BUILD = env.CF_VERSION_METADATA.id;

// The shipped migrations by name, in order, and the newest: what a migrated Store reports as applied.
export const MIGRATION_NAMES = MIGRATIONS.map((m) => m.name);
export const LATEST_MIGRATION = MIGRATION_NAMES.at(-1);

// Each test gets its own Store object, so test files can run in parallel without sharing state.
export function freshStore(): StoreStub {
  return env.STORE.getByName(crypto.randomUUID());
}

// A kernel of this build with logging silenced.
export function testKernel(
  state: DurableObjectState,
  migrations: readonly Migration[] = MIGRATIONS,
  extra: Partial<KernelOptions> = {},
): StoreKernel {
  return new StoreKernel(state, { build: BUILD, migrations, log: () => {}, ...extra });
}

// A Store the shipped migrations brought up to date. Applying them costs about 0.4 s a Store, most of a typical
// test's time, so the upgrade runs once in a template Store per worker and each Store replays its schema and rows
// (test/migrated-store.test.ts compares the two). The image is the same for every test, so it may outlive a suite
// (vitest.config.ts). Suites of the upgrade itself start from freshStore().
export async function migratedStore(): Promise<StoreStub> {
  const image = await (migratedImage ??= takeMigratedImage());
  const store = freshStore();
  await runInDurableObject(store, async (_instance, state) => {
    // As the upgrade records it: this Store's bookmark before the first file, and when each file was applied.
    const bookmark = await state.storage.getCurrentBookmark();
    const now = Date.now();
    const sql = state.storage.sql;
    state.storage.transactionSync(() => {
      // Rows before indexes and triggers, so that no trigger fires on a row the upgrade already left.
      for (const statement of image.tables) {
        sql.exec(statement);
      }
      for (const { insert, values } of image.rows) {
        for (const row of values) {
          sql.exec(insert, ...row);
        }
      }
      for (const statement of image.others) {
        sql.exec(statement);
      }
      sql.exec("UPDATE kopje_migrations SET applied_at = ?", now);
      sql.exec("INSERT OR REPLACE INTO kopje_state (name, value) VALUES ('upgrade_bookmark', ?)", bookmark);
    });
  });
  return store;
}

// The CREATE statements of a migrated Store's tables and of its other objects (indexes, triggers, views), each in
// the order the upgrade made them, and the rows of each table that has any, with the INSERT that writes them back.
// workerd's own tables (_cf_*) and SQLite's (sqlite_*), with the indexes SQLite makes for constraints, come with the
// Store or its statements.
type MigratedImage = {
  tables: string[];
  others: string[];
  rows: { insert: string; values: SqlStorageValue[][] }[];
};

let migratedImage: Promise<MigratedImage> | undefined;

async function takeMigratedImage(): Promise<MigratedImage> {
  const template = freshStore();
  const result = await runInDurableObject(template, (_instance, state) => testKernel(state).upgrade());
  if (!result.ok) {
    throw new Error(`the template Store's upgrade failed: ${result.reason}: ${result.detail}`);
  }
  return runInDurableObject(template, (_instance, state) => {
    const sql = state.storage.sql;
    const objects = sql
      .exec<{ type: string; name: string; sql: string }>(
        "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND substr(name, 1, 4) <> '_cf_' AND substr(name, 1, 7) <> 'sqlite_' ORDER BY rowid",
      )
      .toArray();
    const tables = objects.filter((o) => o.type === "table");
    const rows: MigratedImage["rows"] = [];
    for (const { name } of tables) {
      const cursor = sql.exec(`SELECT * FROM "${name}"`);
      const values = [...cursor.raw()];
      if (values.length > 0) {
        const columns = cursor.columnNames.map((c) => `"${c}"`).join(", ");
        const params = cursor.columnNames.map(() => "?").join(", ");
        rows.push({ insert: `INSERT INTO "${name}" (${columns}) VALUES (${params})`, values });
      }
    }
    return {
      tables: tables.map((o) => o.sql),
      others: objects.filter((o) => o.type !== "table").map((o) => o.sql),
      rows,
    };
  });
}

// The Store's part of a jobs round (STORE_JOB_FAMILIES, jobs/queue.ts), each family in turn and without the round's
// error boundaries: whether any family has work left, and whether any staged deliveries.
export async function runStoreJobs(
  store: StoreStub,
  build: string,
  input: { now: number },
): Promise<{ pending: boolean; delivers: boolean }> {
  let pending = false;
  let delivers = false;
  for (const { run } of STORE_JOB_FAMILIES) {
    const result = await run(store, build, input);
    pending = pending || result.pending;
    delivers = delivers || result.delivers;
  }
  return { pending, delivers };
}

// Fixes the instance domain, as /setup does, so federation routes are reachable.
export async function completeSetup(store: StoreStub): Promise<void> {
  await runInDurableObject(store, (_instance, state) => {
    state.storage.sql.exec("INSERT INTO instance_settings (name, value) VALUES ('domain', 'kopje.test')");
  });
}

// Settles an RPC call and returns its rejection. Handing an RPC promise straight to expect().rejects leaves the
// pipelined promise unhandled in the pool.
export async function rejectionOf(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => undefined,
    (error: unknown) => error,
  );
}

export function tableNames(sql: SqlStorage): string[] {
  return sql
    .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .toArray()
    .map((row) => row.name);
}

export type SentClaim = Omit<Claim, "deliveries"> & { deliveries: (ClaimedDelivery & { body: string })[] };

// A claim, with each claimed row's body as its confirmation reads it in the same lease, right after: what the Worker
// sends (confirmDelivery). Every claimed row must still be sendable.
export async function claimSent(
  store: StoreStub,
  input: { now: number; leaseToken: string; limit?: number },
): Promise<SentClaim> {
  const claim = await store.claimDeliveries(BUILD, input);
  const deliveries: SentClaim["deliveries"] = [];
  for (const delivery of claim.deliveries) {
    const confirmation = await store.confirmDelivery(BUILD, {
      id: delivery.id,
      leaseToken: input.leaseToken,
      now: input.now,
    });
    if (confirmation.status !== "send") {
      throw new Error(`delivery ${delivery.id} claimed, then ${confirmation.status} at confirmation`);
    }
    deliveries.push({ ...delivery, body: confirmation.body });
  }
  return { ...claim, deliveries };
}

// One claim at `now`: each claimed row is confirmed, and each one confirmation lets through is completed with
// `outcome` (null: left leased), one row at a time. Returns the claim and, in order, each sent row's inbox and body.
export async function claimAndSettle(
  store: StoreStub,
  input: { now: number; leaseToken: string; outcome: DeliveryOutcome | null },
): Promise<{ claim: Claim; sent: { inbox: string; body: string }[] }> {
  const { now, leaseToken, outcome } = input;
  const claim = await store.claimDeliveries(BUILD, { now, leaseToken });
  const sent: { inbox: string; body: string }[] = [];
  for (const delivery of claim.deliveries) {
    const confirmation = await store.confirmDelivery(BUILD, { id: delivery.id, leaseToken, now });
    if (confirmation.status === "send") {
      sent.push({ inbox: delivery.inbox, body: confirmation.body });
      if (outcome !== null) {
        await store.completeDelivery(BUILD, { id: delivery.id, leaseToken, now, outcome });
      }
    }
  }
  return { claim, sent };
}

// An email whose local part holds the three letters JavaScript's case folding treats unlike SQLite's lower() (AUTH-9,
// platform/login-email.ts), and its variants: each Unicode one equals it after JavaScript's trim() and toLowerCase(),
// and the sign-in's rule reads it as another email; the ASCII one is the same email.
export const FOLDED_EMAIL = "kim.straße.i̇ris@example.com";
export const UNICODE_EMAIL_VARIANTS = [
  "Kim.straße.i̇ris@example.com",
  "kim.straẞe.i̇ris@example.com",
  "kim.straße.İris@example.com",
  ` ${FOLDED_EMAIL} `,
] as const;
export const ASCII_EMAIL_VARIANT = "KIM.straße.i̇ris@EXAMPLE.com";
