import { describe, expect, it } from "vitest";

import { parse, sources, type Source } from "./source-scan.js";

// Cursor ranges are direct ranges (docs/visibility.md "Read bounds"). A range on a nullable parameter written as
// `(?2 IS NULL OR s.id < ?2)` is an OR, and SQLite does not seek a range through an index for an OR term: a page below
// a cursor then walks every row newer than the cursor. The direct form puts the absent cursor's bound in the value:
// `s.id < coalesce(?2, ':')` for TEXT ids (ABOVE_EVERY_ID and BELOW_EVERY_ID in src/domain/windows.ts), and
// edgeRangeSql (src/domain/windows.ts) for INTEGER ids.
//
// The rule: inside one pair of parentheses, a parameter tested for NULL, OR, then a comparison (<, >, <=, >=) between
// a column and that parameter, in either order around the OR and on either side of the operator, the parameter bare or
// in CAST(... AS type). A parameter is SQLite's: `?`, `?NNN`, `:name`, `@name` or `$name`. Not flagged: a column tested
// for NULL (`expires_at IS NULL OR expires_at > ?`, a lifetime, not a cursor), any other operator (`=`, `IS NOT`,
// `IN`), and bounds that are not parameters (a subquery, as windows.ts's merged bound over its materialized
// candidates).

const PARAM = String.raw`(?:\?\d*|[:@$][A-Za-z_]\w*)`;
const COLUMN = String.raw`[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?`;
const OP = String.raw`(?:<=|>=|<(?!>)|>)`;

function operand(param: string): string {
  return String.raw`(?:${param}|CAST\(\s*${param}\s+AS\s+\w+\s*\))`;
}

function comparison(param: string): string {
  return String.raw`(?:${COLUMN}\s*${OP}\s*${operand(param)}|${operand(param)}\s*${OP}\s*${COLUMN})`;
}

// The bare `?` names a new parameter each time, so a bare one is compared with a bare one; a named or numbered one must
// be the same on both sides of the OR. In the second shape the parameter is captured in each of the four places the
// comparison may hold it (column first or last, bare or in CAST); a group that did not take part matches the empty
// string, which leaves no parameter before IS NULL, so only the captured one matches.
const SHAPES = [
  new RegExp(String.raw`\(\s*(${PARAM})\s+IS\s+NULL\s+OR\s+${comparison(String.raw`(?:\1|\?(?!\d))`)}\s*\)`, "gi"),
  new RegExp(String.raw`\(\s*${comparison(String.raw`(${PARAM})`)}\s+OR\s+(?:\1|\2|\3|\4)\s+IS\s+NULL\s*\)`, "gi"),
];

function nullableRanges(text: string): { line: number; text: string }[] {
  const found = new Map<number, { line: number; text: string }>();
  for (const shape of SHAPES) {
    for (const match of text.matchAll(shape)) {
      const line = text.slice(0, match.index).split("\n").length;
      found.set(match.index, { line, text: match[0].replace(/\s+/g, " ") });
    }
  }
  return [...found.entries()].toSorted(([a], [b]) => a - b).map(([, value]) => value);
}

// Each match in the code of `all` (comments are no code), as `path:line: text`.
function find(all: readonly Source[]): string[] {
  return all.flatMap((source) => nullableRanges(parse(source).code).map((m) => `${source.path}:${m.line}: ${m.text}`));
}

const probe = (sql: string) => [{ path: "src/domain/probe.ts", text: `db.all(\`SELECT id FROM t WHERE ${sql}\`)` }];

describe("the nullable-range matcher", () => {
  it.each([
    "(?2 IS NULL OR s.id < ?2)",
    "(?2 IS NULL OR s.id > ?2)",
    "(?2 IS NULL OR s.id <= ?2)",
    "(?2 IS NULL OR s.id >= ?2)",
    "(?2 IS NULL OR b.id < CAST(?2 AS INTEGER))",
    "( ?12 is null or id >= cast( ?12 as integer ) )",
    "(?2 IS NULL OR ?2 > s.id)",
    "(s.id < ?2 OR ?2 IS NULL)",
    "(CAST(?3 AS INTEGER) <= id OR ?3 IS NULL)",
    "(:max IS NULL OR s.id < :max)",
    "(@min IS NULL OR s.id > @min)",
    "($max IS NULL OR id <= $max)",
    "(s.id >= :min OR :min IS NULL)",
    "(? IS NULL OR id < ?)",
    "(id < ? OR ? IS NULL)",
    "(?2 IS NULL\n\t\t\t\tOR s.id < ?2)",
  ])("catches %j", (sql) => {
    expect(find(probe(`a = ?1 AND ${sql} ORDER BY id`))).toHaveLength(1);
  });

  it.each([
    "(expires_at IS NULL OR expires_at > ?)",
    "(f.expires_at IS NULL OR f.expires_at > ?2)",
    "(?1 IS NULL OR lease_token IS NOT ?1)",
    "(?5 IS NULL OR n.type IN (SELECT value FROM json_each(?5)))",
    "(?7 IS NULL OR n.from_account_id = ?7)",
    "(?2 IS NULL OR s.id <> ?2)",
    "((SELECT bound FROM f) IS NULL OR id >= (SELECT bound FROM f))",
    "(?2 IS NULL OR s.id < ?3)",
    "(s.id < ?2 OR ?3 IS NULL)",
    "s.id < coalesce(?2, ':') AND s.id > coalesce(?3, '')",
    "b.id < coalesce(CAST(?2 AS INTEGER), 1e19)",
  ])("leaves %j", (sql) => {
    expect(find(probe(sql))).toEqual([]);
  });

  it("leaves a range named in a comment", () => {
    expect(
      find([{ path: "src/domain/probe.ts", text: "// not (?2 IS NULL OR s.id < ?2)\n/* (id < ? OR ? IS NULL) */" }]),
    ).toEqual([]);
  });

  it("names the line of each match", () => {
    const text = "db.all(`a\nWHERE (?2 IS NULL OR id < ?2)\nb\nAND (id > ?3 OR ?3 IS NULL)\n`)";
    expect(find([{ path: "src/domain/probe.ts", text }])).toEqual([
      "src/domain/probe.ts:2: (?2 IS NULL OR id < ?2)",
      "src/domain/probe.ts:4: (id > ?3 OR ?3 IS NULL)",
    ]);
  });
});

describe("cursor ranges in src", () => {
  it("are direct ranges, never a nullable parameter ORed with a comparison", () => {
    const files = sources("src");
    expect(files.length).toBeGreaterThan(50);
    const found = find(files);
    expect(found).toEqual([]);
  });
});
