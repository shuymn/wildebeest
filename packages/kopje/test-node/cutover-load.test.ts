import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalLegacyDatabase, loadLegacyExport } from "../cli/lib/cutover/legacy-load.js";
import { digestOf, ExportError, parseStatement, splitStatements } from "../cli/lib/cutover/sql-script.js";
import { buildLegacyFixture } from "./legacy-fixture.js";

const T1_LEVELS = [0, 5, 10, 18, 23, 35, 39];

function errorOf(run: () => unknown): ExportError {
  try {
    run();
  } catch (error) {
    if (error instanceof ExportError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a LegacyLoadError");
}

describe("legacy migrations copy", () => {
  it("is the frozen copy of legacy migrations 0000 to 0039", () => {
    const copy = fileURLToPath(new URL("../cli/legacy-migrations/", import.meta.url));
    const names = readdirSync(copy).sort();
    expect(names).toHaveLength(40);
    expect(names[0]).toMatch(/^0000_/);
    expect(names.at(-1)).toMatch(/^0039_/);
    const hash = createHash("sha256");
    for (const name of names) {
      hash
        .update(`${name}\0`)
        .update(readFileSync(`${copy}${name}`))
        .update("\0");
    }
    expect(hash.digest("hex")).toBe("5c3f7c675d3a0ae8bbe063d95c90090fe10a1fb9d23b867638d3d652278a67f3");
  });
});

describe("export statements", () => {
  it("splits on semicolons outside literals, identifiers and comments, and keeps triggers whole", () => {
    const script = [
      "-- comment; with a semicolon\nPRAGMA defer_foreign_keys=TRUE;",
      `INSERT INTO "t" ("a","b") VALUES('x;y''z','line\n;');`,
      "CREATE TRIGGER tr AFTER INSERT ON t BEGIN DELETE FROM u; INSERT INTO u VALUES (1); END;",
      "INSERT INTO `t` VALUES(1, 2)",
    ].join("\n");
    const statements = [...splitStatements(script)];
    expect(statements).toHaveLength(4);
    expect(statements.map((s) => parseStatement(s).kind)).toEqual(["pragma", "insert", "ignored", "insert"]);
    expect(parseStatement(statements[1] ?? "")).toEqual({
      kind: "insert",
      table: "t",
      columns: ["a", "b"],
      rows: [["x;y'z", "line\n;"]],
    });
    expect(parseStatement(statements[3] ?? "")).toEqual({
      kind: "insert",
      table: "t",
      columns: null,
      rows: [[1n, 2n]],
    });
  });
});

describe("loading and bridging an export", () => {
  for (const level of T1_LEVELS) {
    it(`detects T1 level ${level} and bridges it to 0039`, async () => {
      const fixture = await buildLegacyFixture({ level });
      const { db, report } = loadLegacyExport({ texts: fixture.texts.values() });
      expect(report.level).toBe(level);
      expect(report.migrationsApplied).toHaveLength(39 - level);
      expect(report.deletions).toEqual([]);
      const users = db.prepare("SELECT count(*) AS n FROM users").get() as { n: number };
      expect(users.n).toBe(2);
      db.close();
    });
  }

  it("loads a T2 export written with the upstream DDL", async () => {
    const fixture = await buildLegacyFixture({ level: 10, line: "T2" });
    const { report } = loadLegacyExport({ texts: fixture.texts.values() });
    expect(report).toMatchObject({ level: 10, line: "T1 or T2", deletions: [] });
  });

  it("gives the same bridged data on every run (deterministic randomblob)", async () => {
    const fixture = await buildLegacyFixture({ level: 5 });
    const read = () => {
      const { db } = loadLegacyExport({ texts: fixture.texts.values() });
      const rows = db
        .prepare("SELECT id, secret FROM clients UNION ALL SELECT id, mastodon_id FROM actors ORDER BY 1")
        .all();
      db.close();
      return rows;
    };
    expect(read()).toEqual(read());
  });

  it("accepts one concatenated file as well as one file per table", async () => {
    const fixture = await buildLegacyFixture({ level: 39 });
    const { report } = loadLegacyExport({ texts: [[...fixture.texts.values()].join("\n")] });
    expect(report.level).toBe(39);
  });

  it("leaves out D1's own tables, _cf_KV and d1_kv, which D1 creates by itself", async () => {
    const fixture = await buildLegacyFixture({ level: 39 });
    const texts = new Map(fixture.texts);
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
    const { db, report } = loadLegacyExport({ texts: texts.values() });
    expect(report.level).toBe(39);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    expect(tables.map((t) => t.name).filter((name) => name === "d1_kv" || name.startsWith("_cf_"))).toEqual([]);
  });

  it("stops on rows the bridge removes until deletions are accepted, and reports their counts", async () => {
    const fixture = await buildLegacyFixture({ level: 5, withDeletions: true });
    const error = errorOf(() => loadLegacyExport({ texts: fixture.texts.values() }));
    expect(error.code).toBe("deletions-not-accepted");
    const { report } = loadLegacyExport({ texts: fixture.texts.values(), acceptDeletions: true });
    const by = (migration: string) => report.deletions.filter((d) => d.migration.startsWith(migration));
    expect(by("0007")).toEqual([{ migration: "0007_change_subscriptions_id", table: "subscriptions", rows: 1 }]);
    expect(by("0017")).toEqual([{ migration: "0017_change_actor_reblogs", table: "actor_reblogs", rows: 1 }]);
    expect(by("0021").find((d) => d.table === "objects")).toEqual({
      migration: "0021_update_objects",
      table: "objects",
      rows: 1,
    });
    expect(by("0034")).toEqual([{ migration: "0034_add_unique_actor_favourites", table: "actor_favourites", rows: 1 }]);
  });

  it("refuses unknown migrations, unsupported levels, schema drift and stray statements", async () => {
    const fixture = await buildLegacyFixture({ level: 39 });
    const texts = new Map(fixture.texts);

    const forked = new Map(texts);
    forked.set(
      "d1_migrations",
      `${texts.get("d1_migrations") ?? ""}INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(41,'0040_fork.sql','2024-01-01');\n`,
    );
    expect(errorOf(() => loadLegacyExport({ texts: forked.values() })).code).toBe("unknown-migrations");

    const partial = await buildLegacyFixture({ level: 20 });
    expect(errorOf(() => loadLegacyExport({ texts: partial.texts.values() })).code).toBe("unsupported-level");

    const drifted = new Map(texts);
    drifted.set("peers", 'CREATE TABLE "peers" ("domain" TEXT UNIQUE NOT NULL, "extra" TEXT);\n');
    expect(errorOf(() => loadLegacyExport({ texts: drifted.values() })).code).toBe("schema-mismatch");

    const missing = new Map(texts);
    missing.delete("lists");
    expect(errorOf(() => loadLegacyExport({ texts: missing.values() }))).toMatchObject({
      code: "schema-mismatch",
      detail: { missing: [digestOf("lists")] },
    });

    const hostile = new Map(texts);
    hostile.set("x", "DROP TABLE actors;\n");
    expect(errorOf(() => loadLegacyExport({ texts: hostile.values() })).code).toBe("unexpected-statement");
  });
});

describe("the sqlite_sequence reset D1 writes", () => {
  const RESET = "DELETE FROM sqlite_sequence;\n";
  const ROW = `INSERT INTO "sqlite_sequence" ("name","seq") VALUES('actor_notifications',12);\n`;

  it("is accepted in exactly the form D1 writes, and no other DELETE is", () => {
    expect(parseStatement("DELETE FROM sqlite_sequence")).toEqual({ kind: "sequence-reset" });
    for (const statement of [
      'DELETE FROM "sqlite_sequence"',
      "delete from sqlite_sequence",
      "DELETE  FROM sqlite_sequence",
      "DELETE FROM main.sqlite_sequence",
      "DELETE FROM sqlite_sequence WHERE name = 'actor_notifications'",
      "DELETE FROM sqlite_master",
      "DELETE FROM actors",
    ]) {
      expect(errorOf(() => parseStatement(statement)).code, statement).toBe("unexpected-statement");
    }
  });

  it("loads the counter after it, once and before the rows, and refuses it twice or after a row", async () => {
    const fixture = await buildLegacyFixture({ level: 39 });
    const withSequence = (text: string) => new Map([...fixture.texts, ["sqlite_sequence", text]]);
    const { db, report } = loadLegacyExport({ texts: withSequence(`${RESET}${ROW}`).values() });
    expect(report.notificationSequence).toBe("12");
    db.close();
    expect(loadLegacyExport({ texts: withSequence(RESET).values() }).report.notificationSequence).toBeNull();
    for (const text of [`${RESET}${RESET}${ROW}`, `${ROW}${RESET}`, `${RESET}${ROW}${RESET}`]) {
      expect(errorOf(() => loadLegacyExport({ texts: withSequence(text).values() })).code).toBe("unexpected-statement");
    }
    // Twice across files counts too: the order is the export's, file after file.
    const twice = withSequence(`${RESET}${ROW}`);
    twice.set("actors", `${RESET}${twice.get("actors") ?? ""}`);
    expect(errorOf(() => loadLegacyExport({ texts: twice.values() })).code).toBe("unexpected-statement");
  });
});

describe("an export whose actors.type was added back by ALTER TABLE ADD COLUMN", () => {
  const columns = (db: DatabaseSync, table: string) =>
    db.prepare('SELECT name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?)').all(table);
  const tableSql = (db: DatabaseSync, table: string) =>
    (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string }).sql;

  for (const level of [23, 35, 39]) {
    it(`is accepted at level ${level}, and the bridge still gives the canonical schema`, async () => {
      const fixture = await buildLegacyFixture({ level, actorTypeDrift: true });
      const exported = fixture.texts.get("actors") ?? "";
      expect(exported).toMatch(/"mastodon_id" TEXT,\s*`type` text/i);
      const { db, report } = loadLegacyExport({ texts: fixture.texts.values() });
      expect(report.nullableInExport).toEqual(["actors.type"]);
      const canonical = canonicalLegacyDatabase(39);
      for (const table of ["actors", "objects", "users"]) {
        expect(tableSql(db, table), table).toBe(tableSql(canonical, table));
        expect(columns(db, table), table).toEqual(columns(canonical, table));
      }
      canonical.close();
      const types = db.prepare("SELECT type, count(*) AS n FROM actors GROUP BY type ORDER BY type").all();
      expect(types.length).toBeGreaterThan(0);
      expect(types.every((t) => typeof (t as { type: unknown }).type === "string")).toBe(true);
      db.close();
    });
  }

  it("loads rows without a column list in the export order, by name", async () => {
    const fixture = await buildLegacyFixture({ level: 39, actorTypeDrift: true });
    const read = (texts: Iterable<string>) => {
      const { db } = loadLegacyExport({ texts });
      const rows = db.prepare("SELECT id, type, mastodon_id, username, domain FROM actors ORDER BY id").all();
      db.close();
      return rows;
    };
    const bare = new Map(fixture.texts);
    bare.set(
      "actors",
      (bare.get("actors") ?? "").replaceAll(/INSERT INTO "actors" \([^)]*\) VALUES/g, 'INSERT INTO "actors" VALUES'),
    );
    expect(bare.get("actors")).not.toContain('INSERT INTO "actors" (');
    expect(read(bare.values())).toEqual(read(fixture.texts.values()));
  });

  it("stops with a fixed code on a row that breaks the canonical NOT NULL", async () => {
    const fixture = await buildLegacyFixture({ level: 39, actorTypeDrift: true });
    const nulled = new Map(fixture.texts);
    const actors = nulled.get("actors") ?? "";
    expect(actors).toContain(",'Person',");
    nulled.set("actors", actors.replace(",'Person',", ",NULL,"));
    expect(errorOf(() => loadLegacyExport({ texts: nulled.values() }))).toMatchObject({
      code: "null-in-not-null-column",
      detail: { table: digestOf("actors") },
    });

    // A row that leaves the column out would get its NULL default.
    const omitted = new Map(fixture.texts);
    omitted.set(
      "actors",
      `${actors
        .split("\n")
        .filter((line) => !line.startsWith("INSERT"))
        .join("\n")}\nINSERT INTO "actors" ("id","properties") VALUES('https://remote.example/u/x','{}');\n`,
    );
    expect(errorOf(() => loadLegacyExport({ texts: omitted.values() })).code).toBe("null-in-not-null-column");
  });

  it("accepts any column that is nullable in the export only, under the same row check", async () => {
    const fixture = await buildLegacyFixture({ level: 39, actorTypeDrift: true });
    const texts = new Map(fixture.texts);
    const actors = texts.get("actors") ?? "";
    expect(actors).toContain('"cdate" DATETIME NOT NULL');
    texts.set("actors", actors.replace('"cdate" DATETIME NOT NULL', '"cdate" DATETIME'));
    const { db, report } = loadLegacyExport({ texts: texts.values() });
    db.close();
    expect(report.nullableInExport).toEqual(["actors.cdate", "actors.type"]);
    texts.set("actors", (texts.get("actors") ?? "").replace(/(VALUES\('[^']*'),'[^']*',/, "$1,NULL,"));
    expect(errorOf(() => loadLegacyExport({ texts: texts.values() })).code).toBe("null-in-not-null-column");
  });

  describe("a generated column nullable in the export only", () => {
    const GENERATED = `"type" TEXT NOT NULL GENERATED ALWAYS AS (json_extract(activity, '$.type')) STORED`;
    const literal = (value: unknown) =>
      value === null
        ? "NULL"
        : typeof value === "string"
          ? `'${value.replaceAll("'", "''")}'`
          : value instanceof Uint8Array
            ? `X'${Buffer.from(value).toString("hex")}'`
            : String(value as bigint | number);
    // The actor_activities export with its generated type relaxed, and its rows written without that column: with a
    // column list, or without one (values in the export's column order, generated columns left out).
    const activities = (text: string, form: "listed" | "omitted" | "bare", extra: string[] = []) => {
      const out: string[] = [];
      for (const statement of splitStatements(text)) {
        const parsed = parseStatement(statement);
        if (parsed.kind === "create-table") {
          expect(statement).toContain(GENERATED);
          out.push(`${statement.replace(GENERATED, GENERATED.replace(" NOT NULL", ""))};`);
        } else if (parsed.kind === "insert") {
          const columns = parsed.columns ?? [];
          const keep = columns.map((c, i) => [c, i] as const).filter(([c]) => form === "listed" || c !== "type");
          const values = (row: unknown[]) => `VALUES(${keep.map(([, i]) => literal(row[i])).join(",")})`;
          const list = form === "bare" ? "" : ` (${keep.map(([c]) => `"${c}"`).join(",")})`;
          for (const row of parsed.rows) {
            out.push(`INSERT INTO "actor_activities"${list} ${values(row)};`);
          }
        }
      }
      return `${[...out, ...extra].join("\n")}\n`;
    };

    for (const form of ["listed", "omitted", "bare"] as const) {
      it(`is computed by the canonical table (${form})`, async () => {
        const fixture = await buildLegacyFixture({ level: 39 });
        const texts = new Map(fixture.texts);
        texts.set("actor_activities", activities(texts.get("actor_activities") ?? "", form));
        const { db, report } = loadLegacyExport({ texts: texts.values() });
        expect(report.nullableInExport).toEqual(["actor_activities.type"]);
        const rows = db.prepare("SELECT count(*) AS n, count(type) AS typed FROM actor_activities").get() as {
          n: number;
          typed: number;
        };
        db.close();
        expect(rows.n).toBeGreaterThan(0);
        expect(rows.typed).toBe(rows.n);

        // An activity without a type computes NULL, which the canonical NOT NULL refuses.
        const bad = `('aa-untyped','https://kopje.test/ap/users/alice','2024-03-01 09:00:00.000','{}')`;
        const extra =
          form === "bare"
            ? `INSERT INTO "actor_activities" VALUES${bad};`
            : `INSERT INTO "actor_activities" ("id","actor_id","cdate","activity") VALUES${bad};`;
        texts.set("actor_activities", activities(fixture.texts.get("actor_activities") ?? "", form, [extra]));
        expect(errorOf(() => loadLegacyExport({ texts: texts.values() })).code).toBe("null-in-not-null-column");
      });
    }
  });

  it("still refuses any other column difference", async () => {
    const fixture = await buildLegacyFixture({ level: 39, actorTypeDrift: true });
    const actors = fixture.texts.get("actors") ?? "";
    const create = /CREATE TABLE[^;]*;/.exec(actors)?.[0] ?? "";
    expect(create).toContain("`type` text");
    for (const [name, changed] of [
      ["another type", create.replace("`type` text", "`type` integer")],
      ["a default", create.replace("`type` text", "`type` text DEFAULT 'Person'")],
      ["a check", create.replace("`type` text", "`type` text CHECK (type <> '')")],
      [
        "a generated column",
        create.replace("`type` text", "`type` text GENERATED ALWAYS AS (json_extract(properties, '$.type')) VIRTUAL"),
      ],
      ["NOT NULL where the canonical column is nullable", create.replace("`domain` text", "`domain` text NOT NULL")],
      ["an extra column", create.replace("`type` text", '`type` text, "extra" TEXT')],
      ["a missing column", create.replace(", `domain` text", "")],
      [
        "a primary key moved",
        create.replace("`type` text", "`type` text UNIQUE").replace(/"id" TEXT PRIMARY KEY/i, '"id" TEXT'),
      ],
    ] as const) {
      expect(changed, name).not.toBe(create);
      const texts = new Map(fixture.texts);
      texts.set("actors", `${changed}\n`);
      let code = "accepted";
      try {
        loadLegacyExport({ texts: texts.values() }).db.close();
      } catch (error) {
        code = error instanceof ExportError ? error.code : "failed";
      }
      expect(code, name).toBe("schema-mismatch");
    }
  });
});
