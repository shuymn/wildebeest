import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  compareFingerprints,
  type Fingerprint,
  fingerprintExport,
  parseManifest,
  sequenceFile,
  TABLES_SQL,
} from "../cli/lib/cutover/fingerprint.js";
import { convert, workspace, writeExport } from "./cutover-helpers.js";
import { buildLegacyFixture, exportDatabase } from "./legacy-fixture.js";

// Cutover step 5: two exports of the legacy D1, taken some time apart, must have equal fingerprints. Every row is
// hashed whole (its table, every column and value with its type), so any change to a row, a value moved between rows
// and a row added or removed change it, and sqlite_sequence pins the notification counter. DATA-16: the fingerprint and
// the comparison carry table names, counts and digests only.

const space = workspace();

async function live() {
  const fixture = await buildLegacyFixture({ level: 39, live: true });
  const db = fixture.database!;
  let n = 0;
  // An export of the live database as it is now, and its fingerprint.
  const take = async (): Promise<{ path: string; fingerprint: Fingerprint }> => {
    const path = await writeExport(space.dir, exportDatabase(db, { sequence: true }), `export-${++n}`);
    return { path, fingerprint: fingerprintExport(path) };
  };
  return { db, take, fixture };
}

async function changedBy(write: (db: DatabaseSync) => void) {
  const { db, take } = await live();
  const before = await take();
  write(db);
  return compareFingerprints(before.fingerprint, (await take()).fingerprint);
}

const firstObject = "(SELECT min(rowid) FROM objects)";

describe("the fingerprint of an export", () => {
  it("is the same for two exports while nothing writes, and counts every row", async () => {
    const { db, take } = await live();
    const first = await take();
    const second = await take();
    expect(compareFingerprints(first.fingerprint, second.fingerprint)).toMatchObject({ result: "PASS", changed: [] });
    const objects = (db.prepare("SELECT count(*) AS n FROM objects").get() as { n: number }).n;
    expect(first.fingerprint.tables.objects?.rows).toBe(objects);
    expect(objects).toBeGreaterThan(1);
    expect(first.fingerprint.notificationSequence).toMatch(/^\d+$/);
  });

  it("holds table names, counts and digests only (DATA-16)", async () => {
    const { take, fixture } = await live();
    const text = JSON.stringify((await take()).fingerprint);
    for (const user of fixture.users) {
      expect(text).not.toContain(user.email);
      expect(text).not.toContain(user.uri);
    }
    expect(text).not.toContain("kopje.test");
  });

  // Writes the legacy consumer or a forgotten route could make. Each must FAIL, the changed table named.
  it.each<[string, (db: DatabaseSync) => void, string]>([
    ["an inserted row", (db) => db.exec(`INSERT INTO peers (domain) VALUES ('new.example')`), "peers"],
    ["a deleted row", (db) => db.exec("DELETE FROM objects WHERE rowid = (SELECT max(rowid) FROM objects)"), "objects"],
    [
      "a short value changed at the same length",
      (db) => db.exec(`UPDATE objects SET cdate = replace(cdate, '09:', '19:') WHERE rowid = ${firstObject}`),
      "objects",
    ],
    [
      "values swapped between two rows",
      (db) =>
        db.exec(`UPDATE objects SET properties = CASE rowid
					WHEN (SELECT min(rowid) FROM objects) THEN (SELECT properties FROM objects WHERE rowid = (SELECT max(rowid) FROM objects))
					ELSE (SELECT properties FROM objects WHERE rowid = (SELECT min(rowid) FROM objects)) END
					WHERE rowid IN ((SELECT min(rowid) FROM objects), (SELECT max(rowid) FROM objects))`),
      "objects",
    ],
    [
      "two characters swapped in the middle of a long value",
      (db) => {
        const row = db
          .prepare(`SELECT rowid AS r, properties AS p FROM objects WHERE rowid = ${firstObject}`)
          .get() as {
          r: number;
          p: string;
        };
        const i = Math.floor(row.p.length / 2);
        let j = i;
        while (row.p[j] === row.p[j + 1]) {
          j++;
        }
        const swapped = `${row.p.slice(0, j)}${row.p[j + 1]}${row.p[j]}${row.p.slice(j + 2)}`;
        db.prepare("UPDATE objects SET properties = ? WHERE rowid = ?").run(swapped, row.r);
      },
      "objects",
    ],
    [
      "content emptied to the same length",
      (db) =>
        db.exec(`UPDATE objects SET properties = json_set(properties, '$.content',
					substr('                                                  ', 1, length(json_extract(properties, '$.content'))))
					WHERE rowid = (SELECT min(rowid) FROM objects WHERE json_extract(properties, '$.content') IS NOT NULL)`),
      "objects",
    ],
    [
      "only the notification counter moved",
      (db) => db.exec(`UPDATE sqlite_sequence SET seq = seq + 5 WHERE name = 'actor_notifications'`),
      "sqlite_sequence",
    ],
  ])("changes with %s", async (_name, write, table) => {
    expect(await changedBy(write)).toMatchObject({ result: "FAIL", changed: [table] });
  });

  it("passes a write that changes no value", async () => {
    expect(await changedBy((db) => db.exec("UPDATE peers SET domain = domain"))).toMatchObject({ result: "PASS" });
  });

  it("keeps the notification counter after every notification was deleted, and refuses an export without it", async () => {
    const { db } = await live();
    db.exec("DELETE FROM actor_notifications");
    const counter = (
      db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'actor_notifications'").get() as {
        seq: number;
      }
    ).seq;
    expect(counter).toBeGreaterThan(0);
    const withCounter = await writeExport(space.dir, exportDatabase(db, { sequence: true }), "emptied");
    expect(fingerprintExport(withCounter)).toMatchObject({ notificationSequence: String(counter) });
    const without = await writeExport(space.dir, exportDatabase(db), "emptied-without");
    expect(() => fingerprintExport(without)).toThrow(/sequence-missing/);
  });

  it("reads an exported sqlite_sequence without a notification row as never allocated", async () => {
    const { db } = await live();
    db.exec("DELETE FROM actor_notifications");
    const texts = exportDatabase(db);
    texts.set("sqlite_sequence", "");
    const path = await writeExport(space.dir, texts, "never-allocated");
    expect(fingerprintExport(path)).toMatchObject({ notificationSequence: null });
  });

  it("reads the reset D1 writes before the counter rows, once and before them only", async () => {
    const { db, take } = await live();
    const { path, fingerprint } = await take();
    const text = await readFile(join(path, "sqlite_sequence.sql"), "utf8");
    expect(text).toContain('DELETE FROM sqlite_sequence;\nINSERT INTO "sqlite_sequence"');
    expect(fingerprint.notificationSequence).toMatch(/^\d+$/);

    // A reset without rows is an exported, empty sqlite_sequence, whatever its file is called.
    db.exec("DELETE FROM actor_notifications");
    const texts = exportDatabase(db);
    texts.set("counters", "DELETE FROM sqlite_sequence;\n");
    expect(fingerprintExport(await writeExport(space.dir, texts, "reset-only"))).toMatchObject({
      notificationSequence: null,
    });

    for (const [name, sequence] of [
      ["twice", `DELETE FROM sqlite_sequence;\n${text}`],
      ["after the rows", `${text}DELETE FROM sqlite_sequence;\n`],
      ["quoted", text.replace("DELETE FROM sqlite_sequence;", 'DELETE FROM "sqlite_sequence";')],
    ] as const) {
      const other = exportDatabase(db, { sequence: true });
      other.set("sqlite_sequence", sequence);
      const exportPath = await writeExport(space.dir, other, `reset-${name.replaceAll(" ", "-")}`);
      expect(() => fingerprintExport(exportPath), name).toThrow(/unexpected-statement/);
    }
  });

  it("refuses an export without the notification counter, which the conversion would lose", async () => {
    const { db } = await live();
    const path = await writeExport(space.dir, exportDatabase(db), "no-sequence");
    expect(() => fingerprintExport(path)).toThrow(/sequence-missing/);
  });
});

describe("the export against the conversion manifest", () => {
  async function converted() {
    const { db, take } = await live();
    const final = await take();
    const { manifest } = await convert(space.dir, final.path);
    return { db, final, manifest };
  }

  it("passes when the converted export is the fingerprinted one", async () => {
    const { final, manifest } = await converted();
    const report = compareFingerprints(final.fingerprint, final.fingerprint, parseManifest(manifest));
    expect(report).toMatchObject({ result: "PASS", exportDiffers: [] });
  });

  it("ignores D1's own tables, _cf_KV and d1_kv, in an export that has them", async () => {
    const { db } = await live();
    const texts = exportDatabase(db, { sequence: true });
    const plain = fingerprintExport(await writeExport(space.dir, texts, "without-platform"));
    texts.set(
      "_cf_KV",
      "PRAGMA defer_foreign_keys=TRUE;\nCREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID;\n" +
        `INSERT INTO "_cf_KV" ("key","value") VALUES('k',X'00');\n`,
    );
    texts.set(
      "d1_kv",
      "PRAGMA defer_foreign_keys=TRUE;\nCREATE TABLE d1_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);\n" +
        `INSERT INTO "d1_kv" ("key","value") VALUES('k','v');\n`,
    );
    const path = await writeExport(space.dir, texts, "with-platform");
    const fingerprint = fingerprintExport(path);
    expect(fingerprint).toEqual(plain);
    const { manifest } = await convert(space.dir, path, { out: "out-platform" });
    expect(compareFingerprints(fingerprint, fingerprint, parseManifest(manifest))).toMatchObject({
      result: "PASS",
      exportDiffers: [],
    });
  });

  it("fails on another count or another notification counter", async () => {
    const { final, manifest } = await converted();
    const parsed = parseManifest(manifest);
    const fewer = { ...parsed, rowsLoaded: { ...parsed.rowsLoaded, objects: (parsed.rowsLoaded.objects ?? 0) - 1 } };
    expect(compareFingerprints(final.fingerprint, final.fingerprint, fewer)).toMatchObject({
      result: "FAIL",
      exportDiffers: ["objects"],
    });
    const counter = { ...parsed, notificationSequence: "1" };
    expect(compareFingerprints(final.fingerprint, final.fingerprint, counter)).toMatchObject({
      result: "FAIL",
      exportDiffers: ["sqlite_sequence"],
    });
  });

  it("requires exactly the counted tables, even at zero rows", async () => {
    const { final, manifest } = await converted();
    const parsed = parseManifest(manifest);
    const empty = Object.entries(parsed.rowsLoaded).find(([, n]) => n === 0)?.[0];
    expect(empty).toBeDefined();
    const missing = {
      ...parsed,
      rowsLoaded: Object.fromEntries(Object.entries(parsed.rowsLoaded).filter(([t]) => t !== empty)),
    };
    expect(compareFingerprints(final.fingerprint, final.fingerprint, missing)).toMatchObject({
      result: "FAIL",
      exportDiffers: [empty],
    });
    // Bookkeeping keys with the export's own counts differ too: they are not counted tables.
    for (const [name, count] of [
      ["no_such_table", 0],
      ["sqlite_sequence", 999],
      ["d1_migrations", 999],
      ["sqlite_sequence", final.fingerprint.tables.sqlite_sequence!.rows],
      ["d1_migrations", final.fingerprint.tables.d1_migrations!.rows],
    ] as const) {
      const extra = { ...parsed, rowsLoaded: { ...parsed.rowsLoaded, [name]: count } };
      expect(compareFingerprints(final.fingerprint, final.fingerprint, extra), name).toMatchObject({
        result: "FAIL",
        exportDiffers: [name],
      });
    }
  });

  it("accepts only a complete conversion manifest", async () => {
    const { manifest } = await converted();
    const source = manifest.source as Record<string, unknown>;
    for (const broken of [
      {},
      { migrations: [], tables: [] },
      { ...manifest, source: { ...source, rowsLoaded: undefined } },
      { ...manifest, source: { ...source, rowsLoaded: {} } },
      { ...manifest, source: { ...source, rowsLoaded: { objects: -1 } } },
      { ...manifest, result: "stopped" },
      { ...manifest, tool: { command: "kopje-admin catalog" } },
    ]) {
      expect(() => parseManifest(broken)).toThrow(/not-a-conversion-manifest/);
    }
  });
});

describe("kopje-admin fingerprint", () => {
  const cli = fileURLToPath(new URL("../cli/kopje-admin.js", import.meta.url));
  const run = async (args: string[]) => {
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [cli, ...args]);
      return { code: 0, stdout, stderr };
    } catch (error) {
      const e = error as { code: number; stdout: string; stderr: string };
      return { code: e.code, stdout: e.stdout, stderr: e.stderr };
    }
  };

  it("lists every table to export but SQLite's, D1's own and the full-text index's", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE actors (id TEXT);
			CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
			CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID;
			CREATE TABLE d1_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE VIRTUAL TABLE search_fts USING fts5(body)`);
    const tables = db.prepare(TABLES_SQL).all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(["actors", "d1_migrations"]);
  });

  it("fingerprints and compares exports through the real CLI", async () => {
    expect((await run(["fingerprint", "tables-sql"])).stdout.trim()).toBe(TABLES_SQL);
    const { db, take } = await live();
    const first = await take();
    const second = await take();
    const a = join(space.dir, "a.json");
    const b = join(space.dir, "b.json");
    await writeFile(a, (await run(["fingerprint", "export", first.path])).stdout);
    await writeFile(b, (await run(["fingerprint", "export", second.path])).stdout);
    const same = await run(["fingerprint", "compare", a, b]);
    expect(same.code).toBe(0);
    expect(JSON.parse(same.stdout)).toMatchObject({ result: "PASS" });

    db.exec(`INSERT INTO peers (domain) VALUES ('late.example')`);
    await writeFile(b, (await run(["fingerprint", "export", (await take()).path])).stdout);
    const differs = await run(["fingerprint", "compare", a, b]);
    expect(differs.code).toBe(1);
    expect(JSON.parse(differs.stdout)).toMatchObject({ result: "FAIL", changed: ["peers"] });
    expect(differs.stdout + (await readFile(b, "utf8"))).not.toContain("late.example");

    const notManifest = join(space.dir, "catalog.json");
    await writeFile(notManifest, JSON.stringify({ migrations: [], tables: [] }));
    const refused = await run(["fingerprint", "compare", a, a, "--manifest", notManifest]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("not-a-conversion-manifest");
  });

  it("writes sqlite_sequence from its query answer, accepting names and integers only", () => {
    const answer = [{ results: [{ name: "actor_notifications", seq: 42 }], success: true, meta: {} }];
    expect(sequenceFile(answer)).toBe(
      `INSERT INTO "sqlite_sequence" ("name","seq") VALUES('actor_notifications',42);\n`,
    );
    expect(() => sequenceFile([{ results: [{ name: "x'); DROP", seq: 1 }] }])).toThrow(/invalid-sequence-row/);
    expect(() => sequenceFile([{ results: [{ name: "x", seq: "1" }] }])).toThrow(/invalid-sequence-row/);
  });
});
