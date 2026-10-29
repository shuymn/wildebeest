import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { normalizeOnce, normalizeTag } from "../src/domain/tag-name.js";
import {
  codePoints,
  composite,
  deriveTagKeyTables,
  hex,
  seconds,
  tableNfc,
  tagKeyLiterals,
  tagKeyRows,
  type TagKeyTables,
} from "../test/tag-key-tables.js";

// normalizeTag (src/domain/tag-name.ts) is normalizeOnce twice. Call a character eligible when normalizeOnce keeps it
// as it is. Every character normalizeOnce leaves is eligible, and an eligible one's NFKD is its NFD, so on a name k of
// eligible characters NFKC is NFC, and normalizeOnce(k) = NFC(k) as long as (C) holds: every character of NFC(k) is
// eligible. Then normalizeOnce(normalizeOnce(k)) = NFC(NFC(k)) = NFC(k), which makes normalizeTag a fixed point.
//
// (C) is proved by a search of every state NFC's composition can reach over a name of eligible characters, of any
// length. A state is (X, B, L, P): X the starter being composed onto, B the class of the last piece left unabsorbed (or
// none), L the class of the last piece taken from the run (NFC takes a run's pieces in class order, equal classes in
// string order), P the pieces of the character being read that are not taken yet. Moves:
//   1. take the character's next piece;
//   2. take a mark that follows the character in the name, if its class is at least L and lower than the next piece's
//      (it sorts before it), or at least L once the character's pieces are taken;
//   3. once they are taken, end the name, or read a character whose first piece composes with X while nothing is left
//      unabsorbed (Hangul V and T, the second parts of Indic vowels), its other pieces next; any other character starts
//      a run of its own, whose states are explored from its own start.
// A piece is absorbed when nothing is left unabsorbed (a starter needs this) or the last left has a lower class, and X
// and it compose; absorbing leaves B as it is. A starter not absorbed ends the run: X and the pieces left are output.
// Marks of one class that are the second of no composite only set B, so one stands for them all. What must be eligible
// is only what is output: each X, and each piece of the character read that is left over (a mark that follows is
// eligible already); a composite on the way (å while composing ǻ) may not be.

type Search = { states: number; violations: string[] };

function search(tables: TagKeyTables): Search {
  const rankOf = (cp: number) => tables.rank.get(cp) ?? 0;
  const second = seconds(tables);
  const rests: number[][] = [];
  const restIds = new Map<string, number>();
  const restId = (list: number[]) => {
    const key = list.join(",");
    let id = restIds.get(key);
    if (id === undefined) {
      id = rests.length;
      restIds.set(key, id);
      rests.push(list);
    }
    return id;
  };
  const EMPTY = restId([]);
  const starts = new Map<string, [number, number]>();
  const chained = new Map<string, [number, number]>();
  const marks: number[] = [];
  const standIns = new Map<number, number>();
  for (let cp = 0; cp < 0x110000; cp++) {
    if (tables.eligible[cp] !== 1) {
      continue;
    }
    const pieces = codePoints(String.fromCodePoint(cp).normalize("NFD"));
    const [head, ...rest] = pieces;
    if (rankOf(head!) === 0) {
      const start: [number, number] = [head!, restId(rest)];
      starts.set(start.join(), start);
      if (second.has(head!)) {
        chained.set(start.join(), start);
      }
    } else if (pieces.length > 1) {
      throw new Error(`U+${hex(cp)}: an eligible nonstarter decomposes`);
    } else if (second.has(cp)) {
      marks.push(cp);
    } else if (!standIns.has(rankOf(cp))) {
      standIns.set(rankOf(cp), cp);
    }
  }
  marks.push(...standIns.values());
  const NONE = 63;
  const seen = new Set<number>();
  const stack: number[] = [];
  const violations: string[] = [];
  const key = (x: number, b: number, l: number, rest: number) => ((rest * 64 + b) * 64 + l) * 0x110000 + x;
  const push = (x: number, b: number, l: number, rest: number) => {
    const k = key(x, b, l, rest);
    if (!seen.has(k)) {
      seen.add(k);
      stack.push(k);
    }
  };
  const output = (cp: number, what: string) => {
    if (tables.eligible[cp] !== 1 && violations.length < 20) {
      violations.push(`${what} U+${hex(cp)}`);
    }
  };
  const take = (x: number, b: number, m: number, own: boolean, rest: number) => {
    const r = rankOf(m);
    const y = composite(tables, x, m);
    if (r === 0) {
      if (b === NONE && y !== undefined) {
        push(y, NONE, 0, rest);
      } else {
        output(x, "starter");
        push(m, NONE, 0, rest);
      }
    } else if ((b === NONE || b < r) && y !== undefined) {
      push(y, b, r, rest);
    } else {
      if (own) {
        output(m, "piece");
      }
      push(x, r, r, rest);
    }
  };
  for (const [x, rest] of starts.values()) {
    push(x, NONE, 0, rest);
  }
  while (stack.length > 0) {
    const k = stack.pop()!;
    const x = k % 0x110000;
    let q = (k - x) / 0x110000;
    const l = q % 64;
    q = (q - l) / 64;
    const b = q % 64;
    const rest = rests[(q - b) / 64]!;
    if (rest.length > 0) {
      const next = rest[0]!;
      take(x, b, next, true, restId(rest.slice(1)));
      if (rest.every((cp) => rankOf(cp) > 0)) {
        for (const m of marks) {
          if (rankOf(m) >= l && rankOf(m) < rankOf(next)) {
            take(x, b, m, false, restId(rest));
          }
        }
      }
    } else {
      output(x, "end");
      for (const m of marks) {
        if (rankOf(m) >= l) {
          take(x, b, m, false, EMPTY);
        }
      }
      if (b === NONE) {
        for (const [s, next] of chained.values()) {
          const y = composite(tables, x, s);
          if (y !== undefined) {
            push(y, NONE, 0, next);
          }
        }
      }
    }
  }
  return { states: seen.size, violations };
}

const TABLES = deriveTagKeyTables(normalizeOnce);
const ELIGIBLE = TABLES.eligible;

function isEligibleText(text: string): boolean {
  return codePoints(text).every((cp) => ELIGIBLE[cp] === 1);
}

describe("hashtag keys are fixed points (#1257)", () => {
  it("derives Unicode 17's tables from this runtime", () => {
    // As Node 24.22.1 / ICU 78.3 gives them: eligible characters, nonstarters, their classes, primary composites.
    expect([ELIGIBLE.reduce((n, e) => n + e, 0), TABLES.rank.size, new Set(TABLES.rank.values()).size]).toEqual([
      142_990, 964, 55,
    ]);
    expect(TABLES.pairs.size).toBe(961);
  });

  it("holds the tables 0087_tag_key_fixed_points holds, as scripts/tag-key-literals.mjs prints them", () => {
    const sql = readFileSync(new URL("../migrations/0087_tag_key_fixed_points.sql", import.meta.url), "utf8");
    const printed = execFileSync(
      process.execPath,
      [fileURLToPath(new URL("../scripts/tag-key-literals.mjs", import.meta.url))],
      { encoding: "utf8", maxBuffer: 1 << 24 },
    );
    expect(printed).toBe(tagKeyLiterals(tagKeyRows(TABLES)));
    // A released migration never changes: the generator's output today is the file's.
    expect(sql).toContain(`\n\n${printed}\n`);
  }, 60_000);

  it("leaves only eligible characters, whose NFKD is their NFD", () => {
    const left: string[] = [];
    const compatible: string[] = [];
    for (let cp = 0; cp < 0x110000; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) {
        continue;
      }
      const c = String.fromCodePoint(cp);
      if (!isEligibleText(normalizeOnce(c))) {
        left.push(hex(cp));
      }
      if (ELIGIBLE[cp] === 1 && c.normalize("NFKD") !== c.normalize("NFD")) {
        compatible.push(hex(cp));
      }
    }
    expect([left, compatible]).toEqual([[], []]);
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 40 }), (text) => isEligibleText(normalizeOnce(text))),
      { numRuns: 20_000 },
    );
  });

  it("composes as the runtime's NFC does, from the tables", () => {
    const second = seconds(TABLES);
    const pool: number[] = [0x61, 0x3b1, 0xac00, 0xac01];
    for (let cp = 0; cp < 0x110000; cp++) {
      const composes = TABLES.pieces.has(cp) || second.has(cp) || TABLES.rank.has(cp) || (cp >= 0x1100 && cp <= 0x11ff);
      if (ELIGIBLE[cp] === 1 && composes) {
        pool.push(cp);
      }
    }
    for (const key of TABLES.pairs.keys()) {
      const first = Math.floor(key / 0x110000);
      if (ELIGIBLE[first] === 1) {
        pool.push(first);
      }
    }
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...pool), { minLength: 1, maxLength: 8 }), (cps) => {
        const text = String.fromCodePoint(...cps);
        return tableNfc(TABLES, text) === text.normalize("NFC");
      }),
      { numRuns: 100_000 },
    );
  });

  it("reaches no state of NFC over eligible names that outputs a character normalizeOnce changes", () => {
    const started = Date.now();
    const result = search(TABLES);
    console.info({ event: "tag-key-search", states: result.states, ms: Date.now() - started });
    expect(result.violations).toEqual([]);
    expect(result.states).toBeGreaterThan(1_000_000);
  }, 300_000);

  it("finds the violation when a composite NFC reaches is not eligible", () => {
    // 가 (U+AC00), the composite of ᄀ ᅡ, taken out: the search reaches it through move 3 and reports it.
    const eligible = Uint8Array.from(ELIGIBLE);
    eligible[0xac00] = 0;
    const result = search({ ...TABLES, eligible });
    expect(result.violations).toContain("end U+AC00");
  }, 300_000);

  it("gives normalizeTag its own key back, and Mastodon's wherever Mastodon's is a fixed point", () => {
    const keys = new Set<string>();
    for (let cp = 0; cp < 0x110000; cp++) {
      if (cp < 0xd800 || cp > 0xdfff) {
        keys.add(normalizeTag(`a${String.fromCodePoint(cp)}`));
      }
    }
    expect([...keys].filter((key) => normalizeTag(key) !== key)).toEqual([]);
    expect(normalizeTag("\u1100\u0301\u1161")).toBe("\uAC00");
    expect(normalizeOnce(normalizeOnce("\u1100\u0301\u1161"))).not.toBe(normalizeOnce("\u1100\u0301\u1161"));
  });
});
