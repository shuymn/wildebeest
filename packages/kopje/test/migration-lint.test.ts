import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { MIGRATIONS } from "../src/db/migrations";
import { freshStore, testKernel as kernel } from "./helpers";
import { BREAK_WITNESSES } from "./migration-fixtures";
import { forbiddenProblem, unchangedProblem } from "./migration-sql";

const DECLARED = MIGRATIONS.filter((m) => m.foreignKeys === "unchanged");
// The files before a migration, which a declared file's work tables and recreated indexes are judged against.
const before = (name: string) =>
  MIGRATIONS.slice(
    0,
    MIGRATIONS.findIndex((m) => m.name === name),
  ).map((m) => m.sql);

const HIDDEN = "DROP INDEX p_key; DROP TABLE p; CREATE TABLE p (id TEXT); CREATE UNIQUE INDEX p_key ON p (id);";
const LONG = "x".repeat(256);

describe("migration lint", () => {
  it("finds no PRAGMA or DEFERRABLE in any migration, past the comments that mention them", () => {
    for (const m of MIGRATIONS) {
      expect(forbiddenProblem(m.sql), m.name).toBeNull();
    }
    expect(MIGRATIONS.some((m) => m.sql.includes("PRAGMA foreign_key_check"))).toBe(true);
  });

  it("accepts every file declared foreignKeys: unchanged", () => {
    expect(DECLARED.map((m) => m.name)).toEqual([
      "0058_profile_credentials",
      "0059_contact_and_activity",
      "0060_account_moves",
      "0061_account_static_images",
      "0064_status_applications",
      "0065_media_blurhash",
      "0066_field_verification",
      "0073_actor_document_revision",
      "0074_last_status_lookup",
      "0076_field_link_checks",
      "0078_featured_tags_order",
      "0079_filter_text_units",
      "0080_inbound_job_attempts",
      "0082_public_replies",
      "0084_family_job_attempts",
      "0086_authorized_apps",
      "0087_tag_key_fixed_points",
    ]);
    for (const m of DECLARED) {
      expect(unchangedProblem(m.sql, before(m.name)), m.name).toBeNull();
    }
  });

  it.each([
    "SELECT '--'; PRAGMA defer_foreign_keys=ON; UPDATE c SET x='missing'; SELECT '--'; PRAGMA defer_foreign_keys=OFF;",
    "SELECT 'a\n--'; PRAGMA x;",
    "CREATE TABLE t (a REFERENCES p DEFERRABLE INITIALLY DEFERRED);",
    "select 1; pragma foreign_keys = off;",
  ])("refuses a PRAGMA or DEFERRABLE in %j", (sql) => {
    expect(forbiddenProblem(sql)).toMatch(/is not allowed in a migration/);
  });

  it("accepts PRAGMA and DEFERRABLE inside comments, strings and quoted identifiers", () => {
    expect(forbiddenProblem(`-- PRAGMA x\nSELECT 'PRAGMA', "DEFERRABLE" /* PRAGMA */;`)).toBeNull();
  });

  it.each([
    "ALTER TABLE t ADD COLUMN c TEXT REFERENCES p (id);",
    "ALTER TABLE t ADD COLUMN c CONSTRAINT k REFERENCES p (id);",
    "ALTER TABLE t ADD COLUMN c AS (1);",
    "ALTER TABLE t ADD COLUMN c INTEGER GENERATED ALWAYS AS (1) VIRTUAL;",
    "ALTER TABLE t RENAME TO u;",
    "ALTER TABLE t RENAME COLUMN a TO b;",
    "ALTER TABLE t DROP COLUMN c;",
    "CREATE TABLE t (a);",
    "CREATE VIEW v AS SELECT 1;",
    "CREATE UNIQUE INDEX i ON t (a);",
    "CREATE TEMP TRIGGER x BEFORE INSERT ON t BEGIN SELECT 1; END;",
    "DROP INDEX i;",
    "DROP TABLE t;",
    "PRAGMA foreign_keys = OFF;",
    ...BREAK_WITNESSES.map((w) => w.breaking),
    // Words SQLite reads as identifiers, balanced so that counting them as blocks would hide the statements between.
    `SELECT 1 AS begin; ${HIDDEN} SELECT 1 AS end;`,
    `SELECT 1 AS "begin"; SELECT 1 AS end; ${HIDDEN}`,
    `CREATE TRIGGER begin BEFORE INSERT ON t BEGIN SELECT 1; END; ${HIDDEN}`,
    `CREATE TRIGGER main.end BEFORE INSERT ON t BEGIN SELECT 1; END;`,
    `CREATE TRIGGER x BEFORE INSERT ON t BEGIN SELECT NEW.begin; END; ${HIDDEN} SELECT 1 AS end;`,
    `CREATE TRIGGER x BEFORE INSERT ON t BEGIN SELECT 1 AS end; ${HIDDEN} END;`,
    `CREATE TRIGGER x BEFORE UPDATE OF end ON t BEGIN SELECT 1; END;`,
    `CREATE TRIGGER x BEFORE INSERT ON t WHEN NEW.end BEGIN SELECT 1; END;`,
    `CREATE TRIGGER x BEFORE INSERT ON t BEGIN SELECT CASE WHEN NEW.end THEN 1 END; END;`,
    "CREATE TRIGGER x BEFORE INSERT ON t BEGIN SELECT 1;",
    "CREATE TRIGGER x BEFORE INSERT ON t;",
    "UPDATE t SET a = CASE WHEN a THEN 1 END;",
    // The tokenizer splits non-ASCII and words past 256 characters, where SQLite reads one identifier.
    `SELECT 1 AS λbegin; ${HIDDEN} SELECT 1 AS λend;`,
    `SELECT 1 AS ${LONG}begin; ${HIDDEN} SELECT 1 AS ${LONG}end;`,
    `SELECT 1 AS ${LONG}1;`,
  ])("refuses a declaration over %j", (sql) => {
    expect(unchangedProblem(sql)).not.toBeNull();
  });

  it.each([
    "ALTER TABLE t ADD COLUMN c INTEGER CHECK (c IS NULL OR CAST(c AS INTEGER) = c);",
    "ALTER TABLE t ADD c TEXT COLLATE NOCASE DEFAULT 'x';",
    "CREATE INDEX x ON t (a);",
    "DROP TRIGGER x;",
    "CREATE INDEX IF NOT EXISTS x ON t (a) WHERE a IS NOT NULL;",
    `CREATE TRIGGER x AFTER UPDATE OF a ON t
		WHEN CASE WHEN NEW.a IS NULL THEN 0 ELSE CASE WHEN NEW.a > 0 THEN 1 END END
		BEGIN
			UPDATE u SET b = (SELECT CASE WHEN NEW.a THEN 2 END);
			DELETE FROM v WHERE c = NEW.a;
		END;
		INSERT INTO u (b) VALUES (1);`,
    'WITH n AS (SELECT 1) INSERT INTO u SELECT * FROM n; DELETE FROM u; REPLACE INTO u VALUES (1); SELECT 1 AS "end";',
  ])("accepts a declaration over %j", (sql) => {
    expect(unchangedProblem(sql)).toBeNull();
  });

  // Work tables and recreated indexes, judged against the files before (`earlier`).
  const EARLIER = [
    `CREATE TABLE t (a, b); CREATE INDEX i ON t (a); CREATE UNIQUE INDEX u ON t (b);
		CREATE INDEX iq ON t ("a"); CREATE INDEX il ON t (a) WHERE b = 'x'; CREATE INDEX ir ON t (a) WHERE b > 1;`,
  ];
  it.each([
    ["a work table with a REFERENCES", "CREATE TABLE w (a REFERENCES t (a)); DROP TABLE w;"],
    [
      "a work table with a schema-qualified REFERENCES",
      "CREATE TABLE w (a, FOREIGN KEY (a) REFERENCES main.t); DROP TABLE w;",
    ],
    ["a work table left undropped", "CREATE TABLE w (a); INSERT INTO w VALUES (1);"],
    ["a work table dropped before it is created", "DROP TABLE w; CREATE TABLE w (a);"],
    ["a work table created twice", "CREATE TABLE w (a); DROP TABLE w; CREATE TABLE w (a); DROP TABLE w;"],
    ["a TEMP work table", "CREATE TEMP TABLE w (a); DROP TABLE w;"],
    ["a schema-qualified work table", "CREATE TABLE main.w (a); DROP TABLE main.w;"],
    ["dropping a real table", "DROP TABLE t;"],
    ["dropping a real table under IF EXISTS", "DROP TABLE IF EXISTS t;"],
    ["an index dropped and not recreated", "DROP INDEX i;"],
    ["an index recreated with another definition", "DROP INDEX i; CREATE INDEX i ON t (b);"],
    ["an index recreated before it is dropped", "CREATE INDEX IF NOT EXISTS i ON t (a); DROP INDEX i;"],
    ["a UNIQUE index dropped and recreated", "DROP INDEX u; CREATE UNIQUE INDEX u ON t (b);"],
    ["a UNIQUE index on a real table", "CREATE UNIQUE INDEX v ON t (a);"],
    [
      "a work index under IF NOT EXISTS named as an earlier UNIQUE index",
      "CREATE TABLE w (b); CREATE UNIQUE INDEX IF NOT EXISTS u ON w (b); DROP INDEX u; DROP TABLE w;",
    ],
    ["an index recreated on another quoted column", 'DROP INDEX iq; CREATE INDEX iq ON t ("b");'],
    ["an index recreated with another string", "DROP INDEX il; CREATE INDEX il ON t (a) WHERE b = 'y';"],
    ["an index recreated with another number", "DROP INDEX ir; CREATE INDEX ir ON t (a) WHERE b > 2;"],
  ])("refuses %s", (_label, sql) => {
    expect(unchangedProblem(sql, EARLIER)).not.toBeNull();
  });

  it("reads the earlier files whole, CASE included, and refuses when one cannot be read", () => {
    const sql = "DROP INDEX i; CREATE INDEX i ON t (a);";
    // The last earlier file makes i UNIQUE after a CASE: dropping and recreating it plain is refused.
    const remade = [
      "CREATE TABLE t (a); CREATE INDEX i ON t (a);",
      "SELECT CASE WHEN 1 THEN 2 END; DROP INDEX i;\nCREATE UNIQUE INDEX i ON t (a);",
    ];
    expect(unchangedProblem(sql, remade)).toMatch(/creates it again as it was/);
    expect(unchangedProblem(sql, [remade[0]!])).toBeNull();
    expect(unchangedProblem(sql, [remade[0]!, "SELECT CASE WHEN 1 THEN 2;"])).toMatch(/cannot be read/);
  });

  it("refuses a work table that an earlier file names after REFERENCES, or after a quoted name", () => {
    const sql = "CREATE TABLE w (a); DROP TABLE w;";
    expect(unchangedProblem(sql, ["CREATE TABLE c (x REFERENCES w (a));"])).toMatch(/named after REFERENCES/);
    expect(unchangedProblem(sql, ['CREATE TABLE c (x REFERENCES "t" (a));'])).toMatch(/named after REFERENCES/);
    expect(unchangedProblem(sql, EARLIER)).toBeNull();
  });

  it.each([
    [
      "a work table with keys, indexes and writes, dropped",
      `CREATE TABLE w (a TEXT PRIMARY KEY, b UNIQUE) WITHOUT ROWID; CREATE UNIQUE INDEX w_b ON w (b);
			CREATE INDEX w_a ON w (a) WHERE a IS NOT NULL; INSERT INTO w SELECT a, b FROM t; UPDATE t SET a = 1;
			DROP INDEX w_b; DROP TABLE w;`,
    ],
    ["an index dropped and recreated as it was", "DROP INDEX i; UPDATE t SET a = 1; CREATE INDEX i ON t (a);"],
    [
      "indexes recreated with their quoted names, strings and numbers, spaced and cased otherwise",
      `DROP INDEX iq; DROP INDEX il; DROP INDEX ir; create index iq on t ( "a" );
			CREATE INDEX il ON t (a) -- a comment
			WHERE b = 'x'; CREATE INDEX ir ON t (a) WHERE b > 1;`,
    ],
  ])("accepts %s", (_label, sql) => {
    expect(unchangedProblem(sql, EARLIER)).toBeNull();
  });
});

// Each declared file applied to a populated Store: the tables keep their pages, no unique index goes, and every
// reference still holds. It catches a realistic mistake the lint might miss.
describe.each(DECLARED.map((m) => [m.name]))("%s applied to a populated Store", (name) => {
  const at = MIGRATIONS.findIndex((m) => m.name === name);

  const shape = (sql: SqlStorage) => {
    const tables = sql
      .exec<{ name: string; rootpage: number }>(
        // workerd's own tables (_cf_*) are not the schema's and refuse the pragmas.
        "SELECT name, rootpage FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 4) <> '_cf_' ORDER BY name",
      )
      .toArray();
    // Each unique index (a primary key's and UNIQUE constraints' included) with its table and columns.
    const unique = tables.flatMap(({ name }) =>
      sql
        .exec<{ name: string }>('SELECT name FROM pragma_index_list(?) WHERE "unique" = 1 ORDER BY name', name)
        .toArray()
        .map((index) => ({
          table: name,
          index: index.name,
          columns: sql
            .exec<{ name: string | null }>("SELECT name FROM pragma_index_info(?) ORDER BY seqno", index.name)
            .toArray()
            .map((c) => c.name),
        })),
    );
    return { tables, unique };
  };

  it("changes no table, unique key or reference", async () => {
    const store = freshStore();
    await runInDurableObject(store, async (_instance, state) => {
      const sql = state.storage.sql;
      await state.storage.deleteAlarm();
      expect(await kernel(state, MIGRATIONS.slice(0, at)).upgrade()).toMatchObject({ ok: true });
      const [local, remote, status, reply] = [
        "100000000000000001",
        "100000000000000002",
        "200000000000000001",
        "200000000000000002",
      ];
      // The ids are constants: workerd binds parameters only to the last of several statements.
      sql.exec(
        `INSERT INTO accounts (id, uri, username, domain) VALUES
					('${local}', 'https://kopje.test/ap/users/a', 'a', NULL), ('${remote}', 'https://remote.test/users/b', 'b', 'remote.test');
				INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES ('${local}', 'a@example.com', X'00', X'00', 'k');
				INSERT INTO follows (account_id, target_account_id, state) VALUES ('${local}', '${remote}', 'accepted'), ('${remote}', '${local}', 'accepted');
				INSERT INTO statuses (id, uri, account_id, visibility, published_at) VALUES
					('${status}', 'https://kopje.test/ap/o/1', '${local}', 'public', '2026-01-01T00:00:00.000Z');
				INSERT INTO statuses (id, uri, account_id, visibility, in_reply_to_id, in_reply_to_uri, published_at) VALUES
					('${reply}', 'https://remote.test/o/2', '${remote}', 'public', '${status}', 'https://kopje.test/ap/o/1', '2026-01-01T00:00:00.000Z');
				INSERT INTO status_mentions (status_id, account_id) VALUES ('${reply}', '${local}');
				INSERT INTO status_tags (status_id, name) VALUES ('${status}', 'cats');
				INSERT INTO notifications (account_id, type, from_account_id, status_id) VALUES ('${local}', 'mention', '${remote}', '${reply}');
				INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('c', 's', 'n', 'urn:x', 'read');
				INSERT INTO oauth_tokens (token_hash, kind, client_id, scopes, account_id) VALUES ('h', 'access', 'c', 'read', '${local}');`,
      );
      // Every child table seeded above holds a row whose reference is checked.
      const children = [
        "local_accounts",
        "follows",
        "statuses",
        "status_mentions",
        "status_tags",
        "notifications",
        "oauth_tokens",
      ];
      for (const table of children) {
        expect(sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).one().n, table).toBeGreaterThan(0);
      }
      expect(sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
      const before = shape(sql);
      expect(before.unique.some((u) => u.table === "accounts")).toBe(true);

      expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({ ok: true, applied: [name] });
      const after = shape(sql);
      expect(after.tables).toEqual(before.tables);
      expect(after.unique).toEqual(expect.arrayContaining(before.unique));
      expect(sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
    });
  });
});

// The premise the declaration's argument rests on (Migration in src/platform/store-kernel.ts): every reference's
// column has its parent key's declared type, so the immediate check, which compares by the parent's affinity, and the
// whole-Store check agree on which parent a child matches (with different types, an INSERT OR REPLACE can delete a
// parent a child still matches, and only the whole-Store check finds the orphan). Each reference of the schema each
// declared file runs on, and of the latest.
describe("the references of the schema a declared file runs on", () => {
  const mismatches = (sql: SqlStorage): { pairs: number; wrong: string[] } => {
    const tables = sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 4) <> '_cf_' AND name <> 'sqlite_sequence'",
      )
      .toArray()
      .map((row) => row.name);
    const typeOf = (table: string, column: string) =>
      sql
        .exec<{ type: string }>("SELECT type FROM pragma_table_info(?) WHERE name = ?", table, column)
        .toArray()[0]
        ?.type.toUpperCase() ?? null;
    let pairs = 0;
    const wrong: string[] = [];
    for (const table of tables) {
      const keys = sql
        .exec<{ id: number; seq: number; table: string; from: string; to: string | null }>(
          'SELECT id, seq, "table", "from", "to" FROM pragma_foreign_key_list(?)',
          table,
        )
        .toArray();
      for (const key of keys) {
        const parentKey =
          key.to ??
          sql
            .exec<{ name: string }>("SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk", key.table)
            .toArray()[key.seq]?.name ??
          null;
        const child = typeOf(table, key.from);
        const parent = parentKey === null ? null : typeOf(key.table, parentKey);
        pairs++;
        if (child === null || parent === null || child !== parent) {
          wrong.push(`${table}.${key.from} (${child}) -> ${key.table}.${parentKey} (${parent})`);
        }
      }
    }
    return { pairs, wrong };
  };

  it("gives each reference its parent key's declared type", async () => {
    const store = freshStore();
    await runInDurableObject(store, async (_instance, state) => {
      const sql = state.storage.sql;
      await state.storage.deleteAlarm();
      const wrong: string[] = [];
      let pairs = 0;
      for (const [at, m] of MIGRATIONS.entries()) {
        if (m.foreignKeys === "unchanged") {
          expect(await kernel(state, MIGRATIONS.slice(0, at)).upgrade()).toMatchObject({ ok: true });
          const found = mismatches(sql);
          wrong.push(...found.wrong.map((w) => `before ${m.name}: ${w}`));
          pairs = found.pairs;
        }
      }
      expect(await kernel(state).upgrade()).toMatchObject({ ok: true });
      const latest = mismatches(sql);
      wrong.push(...latest.wrong.map((w) => `latest: ${w}`));
      expect(wrong).toEqual([]);
      expect([pairs, latest.pairs].every((n) => n > 50)).toBe(true);
    });
  }, 120_000);

  it("finds a reference whose column has another type than its parent key, and a key named by the primary key", async () => {
    const store = freshStore();
    await runInDurableObject(store, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("CREATE TABLE p (id TEXT PRIMARY KEY, k TEXT UNIQUE)");
      sql.exec("CREATE TABLE ch (f INTEGER REFERENCES p (id), g TEXT REFERENCES p)");
      expect(mismatches(sql)).toEqual({ pairs: 2, wrong: ["ch.f (INTEGER) -> p.id (TEXT)"] });
    });
  });
});
