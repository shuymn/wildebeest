import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach } from "vitest";

import {
  createKopjeDatabase,
  loadDump,
  migrationRecords,
  readCatalog,
  writeDump,
} from "../cli/lib/cutover/kopje-db.js";
import { convertExport, verifyConversion } from "../cli/lib/cutover/run.js";
import { buildLegacyFixture, type FixtureOptions } from "./legacy-fixture.js";

// Shared steps of the converter suites: a temporary directory per test, exports written from synthetic fixtures,
// conversion and verification as the CLI runs them, and tampering that keeps a dump self-consistent.

const BASE_TIME = Date.parse("2026-10-20T00:00:00.000Z");

export type Categories = Record<
  string,
  { expected: number; actual: number; missing: number; extra: number; changed: number }
>;

export function workspace() {
  const state = { dir: "" };
  beforeEach(async () => {
    state.dir = await mkdtemp(join(tmpdir(), "kopje-cutover-"));
  });
  afterEach(async () => {
    await rm(state.dir, { recursive: true, force: true });
  });
  return state;
}

export async function writeExport(dir: string, texts: Map<string, string>, name = "export"): Promise<string> {
  const path = join(dir, name);
  await mkdir(path);
  for (const [table, text] of texts) {
    await writeFile(join(path, `${table}.sql`), text);
  }
  return path;
}

// Rewrites each SQL file of an export for which `rewrite` returns new text; returns how many it rewrote.
export async function rewriteExport(
  exportPath: string,
  rewrite: (text: string) => string | undefined,
): Promise<number> {
  let rewritten = 0;
  for (const name of (await readdir(exportPath)).filter((n) => n.endsWith(".sql"))) {
    const next = rewrite(await readFile(join(exportPath, name), "utf8"));
    if (next !== undefined) {
      await writeFile(join(exportPath, name), next);
      rewritten++;
    }
  }
  return rewritten;
}

export async function exportOf(dir: string, options: FixtureOptions, name = "export"): Promise<string> {
  return writeExport(dir, (await buildLegacyFixture(options)).texts, name);
}

export async function convert(
  dir: string,
  exportPath: string,
  extra: {
    acceptDeletions?: boolean;
    acceptTruncation?: boolean;
    env?: Record<string, string>;
    out?: string;
    baseTime?: number;
    imagesDir?: string;
    acceptMissingImages?: boolean | undefined;
  } = {},
) {
  const outDir = join(dir, extra.out ?? "out");
  const result = await convertExport({
    exportPath,
    outDir,
    acceptDeletions: extra.acceptDeletions ?? false,
    acceptTruncation: extra.acceptTruncation ?? false,
    baseTime: extra.baseTime ?? BASE_TIME,
    env: extra.env ?? {},
    version: "test",
    imagesDir: extra.imagesDir,
    acceptMissingImages: extra.acceptMissingImages ?? false,
  });
  return { ...result, dumpPath: join(outDir, "kopje.dump") };
}

export async function verify(
  exportPath: string,
  dumpPath: string,
  options: {
    acceptDeletions?: boolean;
    acceptTruncation?: boolean;
    imagesDir?: string;
    acceptMissingImages?: boolean;
  } = {},
) {
  const { ok, report } = await verifyConversion({
    exportPath,
    dumpPath,
    acceptDeletions: options.acceptDeletions ?? false,
    acceptTruncation: options.acceptTruncation ?? false,
    baseTime: 0,
    env: {},
    imagesDir: options.imagesDir,
    acceptMissingImages: options.acceptMissingImages ?? false,
  });
  return { ok, report, categories: (report as { categories?: Categories }).categories ?? {} };
}

export function failing(categories: Categories): string[] {
  return Object.entries(categories)
    .filter(([, c]) => c.missing + c.extra + c.changed > 0)
    .map(([name]) => name);
}

// The converted data as a local database with the Store schema (a dump is a valid script for one).
export async function opened(dumpPath: string) {
  const db = createKopjeDatabase();
  loadDump(db, await readFile(dumpPath, "utf8"));
  return db;
}

// Applies SQL to a converted dump and writes it again as a self-consistent dump (as a converter bug would produce).
export async function tampered(dir: string, dumpPath: string, sql: string): Promise<string> {
  const db = await opened(dumpPath);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(sql);
  const path = join(dir, `tampered-${Math.random().toString(36).slice(2)}.dump`);
  writeDump(db, {
    path,
    catalog: readCatalog(db),
    migrations: migrationRecords(),
    createdAt: new Date(BASE_TIME).toISOString(),
    source: { build: "test", version: "test" },
  });
  db.close();
  return path;
}
