import { describe, expect, it } from "vitest";

import {
  chainDigest,
  END_LINE as CLI_END,
  HEADER_PREFIX as CLI_HEADER,
  IMPORT_CHUNK_BYTES,
  IMPORT_CHUNK_STATEMENTS,
  statementChunks,
  TRAILER_PREFIX as CLI_TRAILER,
} from "../cli/lib/format.js";
import {
  DumpParseError,
  END_LINE,
  HEADER_PREFIX,
  insertTemplate,
  linkTemplate,
  parseStatements,
  renderTemplate,
  scanLiteral,
  type TableSpec,
  TRAILER_PREFIX,
  utf8Length,
} from "../src/platform/dump-format";
import { readOnlyProblem } from "../src/platform/readonly-sql";
import { Sha256, sha256Hex } from "../src/platform/sha256";
import { IMPORT_CHUNK_WORK_BYTES, MAX_IMPORT_CHUNK_STATEMENTS } from "../src/platform/store-admin";
import { memoryIO } from "./ops-helpers";

async function subtleHex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("Sha256", () => {
  it("matches WebCrypto for lengths around block boundaries", async () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const data = Uint8Array.from({ length }, (_, i) => (i * 31 + 7) & 0xff);
      expect(sha256Hex(data), `length ${length}`).toBe(await subtleHex(data));
    }
  });

  it("continues identically after save and restore at any split", async () => {
    const data = Uint8Array.from({ length: 300 }, (_, i) => (i * 13) & 0xff);
    const expected = await subtleHex(data);
    for (const split of [0, 1, 63, 64, 65, 200, 300]) {
      const first = new Sha256().update(data.subarray(0, split));
      const resumed = Sha256.restore(first.save()).update(data.subarray(split));
      expect(resumed.hex(), `split ${split}`).toBe(expected);
    }
  });

  it("rejects a malformed saved state", () => {
    expect(() => Sha256.restore("nope")).toThrow("invalid hash state");
    expect(() => Sha256.restore(`${"0".repeat(64)}:3:`)).toThrow("invalid hash state");
  });

  // FIPS 180-2 / NIST CSRC example vectors.
  const NIST: [string, string][] = [
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
    [
      "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
      "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1",
    ],
    ["a".repeat(1_000_000), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"],
  ];

  it("produces the NIST example digests", () => {
    for (const [message, digest] of NIST) {
      expect(sha256Hex(message), `${message.length} bytes`).toBe(digest);
    }
  });

  it("produces the NIST digests when saved and restored at random split points", () => {
    // A fixed-seed generator keeps failures reproducible.
    let seed = 0x2545f491;
    const random = (max: number) => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) % (max + 1);
    };
    for (const [message, digest] of NIST) {
      const bytes = new TextEncoder().encode(message);
      for (let round = 0; round < 25; round++) {
        const cuts = [random(bytes.length), random(bytes.length), random(bytes.length)].sort((a, b) => a - b);
        let hash = new Sha256();
        let at = 0;
        for (const cut of [...cuts, bytes.length]) {
          hash = Sha256.restore(hash.update(bytes.subarray(at, cut)).save());
          at = cut;
        }
        expect(hash.hex(), `${message.length} bytes split at ${cuts.join(",")}`).toBe(digest);
      }
    }
  });
});

describe("dump format", () => {
  const statuses: TableSpec = {
    name: "statuses",
    columns: ["id", "content", "reblog_of_id"],
    order: { by: "rowid" },
    key: ["id"],
    deferred: ["reblog_of_id"],
  };

  it("keeps the CLI constants and chain digest in step with the Store", async () => {
    expect([CLI_HEADER, CLI_TRAILER, CLI_END]).toEqual([HEADER_PREFIX, TRAILER_PREFIX, END_LINE]);
    expect([IMPORT_CHUNK_BYTES, IMPORT_CHUNK_STATEMENTS]).toEqual([
      IMPORT_CHUNK_WORK_BYTES,
      MAX_IMPORT_CHUNK_STATEMENTS,
    ]);
    const chunk = new TextEncoder().encode("INSERT ...;\n");
    expect(await chainDigest("abc", chunk)).toBe(new Sha256().update("abc").update(chunk).hex());
  });

  // The Store bounds a chunk's work by its statements as well as its bytes: many short rows write as many index
  // entries as a few long ones write pages.
  it("splits import chunks by statement count as well as by bytes", async () => {
    const line = (n: number) => `INSERT INTO "t" ("a") VALUES (${n});\n`;
    const body = Array.from({ length: 4500 }, (_, n) => line(n)).join("");
    const io = memoryIO(new Map([["b", new TextEncoder().encode(body)]]));
    const counts: number[] = [];
    let joined = "";
    for await (const chunk of statementChunks(io, "b", 0, body.length, 1 << 20, 2000)) {
      const text = new TextDecoder().decode(chunk.bytes);
      counts.push(text.split("\n").length - 1);
      joined += text;
    }
    expect(counts).toEqual([2000, 2000, 500]);
    expect(joined).toBe(body);
    // A single statement over the byte bound still goes alone.
    const long = `INSERT INTO "t" ("a") VALUES ('${"x".repeat(300)}');\n`;
    const io2 = memoryIO(new Map([["c", new TextEncoder().encode(line(1) + long + line(2))]]));
    const sizes: number[] = [];
    for await (const chunk of statementChunks(io2, "c", 0, line(1).length + long.length + line(2).length, 100, 2000)) {
      sizes.push(chunk.bytes.byteLength);
    }
    expect(sizes).toEqual([line(1).length, long.length, line(2).length]);
  });
  it("scans every literal form quote() produces", () => {
    for (const literal of [
      "NULL",
      "0",
      "-42",
      "9223372036854775807",
      "1.0",
      "-0.5",
      "1.5e+300",
      "9.0e+999",
      "'it''s'",
      "''",
      "X'00FF'",
      "X''",
      "CAST(X'610062' AS TEXT)",
    ]) {
      expect(scanLiteral(`${literal},`, 0), literal).toBe(literal.length);
    }
    for (const bad of ["'open", "X'0'", "X'GG'", "1.", "--1", "NUL", "CAST(X'00' AS BLOB)", "(SELECT 1)"]) {
      expect(scanLiteral(bad, 0), bad).not.toBe(bad.length);
    }
  });

  it("accepts only exact template statements of catalog tables", () => {
    const insert = `${renderTemplate(insertTemplate(statuses), ["'1'", "'a;\nb'", "NULL"])}\n`;
    const link = `${renderTemplate(linkTemplate(statuses), ["'1'", "'1'"])}\n`;
    expect(link).toBe(`UPDATE "statuses" SET "reblog_of_id"='1' WHERE "id"='1';\n`);
    expect(parseStatements(insert + link, [statuses]).map((s) => s.kind)).toEqual(["insert", "link"]);

    const refused = [
      `INSERT INTO "accounts" ("id") VALUES ('1');\n`,
      `INSERT INTO "statuses" ("id","content") VALUES ('1','a');\n`,
      `INSERT INTO "statuses" ("id","content","reblog_of_id") VALUES ('1','a',NULL);DROP TABLE statuses;\n`,
      `INSERT INTO "statuses" ("id","content","reblog_of_id") VALUES ('1',(SELECT 1),NULL);\n`,
      `INSERT INTO "statuses" ("id","content","reblog_of_id") VALUES ('1','a',NULL); -- c\n`,
      `DELETE FROM "statuses";\n`,
      `UPDATE "statuses" SET "content"='x' WHERE "id"='1';\n`,
      `INSERT INTO "statuses" ("id","content","reblog_of_id") VALUES ('1','a',NULL);`,
    ];
    for (const text of refused) {
      expect(() => parseStatements(text, [statuses]), text).toThrow(DumpParseError);
    }
  });

  it("counts UTF-8 bytes", () => {
    for (const text of ["abc", "é", "✓", "🦬", "a🦬b\u0000"]) {
      expect(utf8Length(text)).toBe(new TextEncoder().encode(text).byteLength);
    }
  });
});

describe("read-only SQL check", () => {
  it("accepts single SELECT and WITH statements", () => {
    for (const sql of [
      "SELECT 1",
      "select count(*) from statuses;",
      "SELECT ';' AS semi, 'DELETE FROM x' AS text",
      'SELECT "delete" FROM t',
      "SELECT replace(content, 'a', 'b') FROM statuses",
      "WITH x AS (SELECT 1 AS n) SELECT n FROM x",
      "SELECT * FROM pragma_table_info('statuses')",
      "SELECT 1 /* DELETE */ -- UPDATE\n",
    ]) {
      expect(readOnlyProblem(sql), sql).toBeNull();
    }
  });

  it("refuses writes, multiple statements and other statement kinds", () => {
    for (const sql of [
      "",
      "DELETE FROM statuses",
      "WITH x AS (SELECT 1) DELETE FROM statuses",
      "WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x",
      "WITH x AS (SELECT 1) REPLACE INTO t VALUES (1)",
      "SELECT 1; DELETE FROM statuses",
      "SELECT 1;;",
      "SELECT 1; -- trailing\nDROP TABLE statuses",
      "/* SELECT */ DELETE FROM statuses",
      "-- SELECT\nUPDATE statuses SET content = 1",
      "PRAGMA foreign_keys = OFF",
      "ATTACH DATABASE 'x' AS y",
      "VACUUM",
      "SELECT 1 /* unterminated",
      "SELECT 'unterminated",
      "SELECT * FROM t WHERE x IN (SELECT 1) UNION SELECT load_extension(1)",
      "select 1 where 1 = (insert into t values (1))",
    ]) {
      expect(readOnlyProblem(sql), sql).not.toBeNull();
    }
  });
});
