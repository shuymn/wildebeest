// The Unicode tables a hashtag key's fixed point rests on (src/domain/tag-name.ts normalizeTag), derived from the
// runtime's own normalization: test-node/tag-key-fixed-points.test.ts proves from them that two passes are a fixed
// point, and it and test/tag-key-tables.test.ts compare them with the literals of 0087_tag_key_fixed_points on Node and
// in workerd, so the proof holds for the Store's runtime and for the migration's SQL.
//
// A character is eligible when normalizeOnce keeps it as it is: NFKC leaves it, it is lowercase, and it is no letter of
// the folding table and no character a hashtag cannot hold. Combining classes are not exposed by JavaScript, so they
// are read from canonical reordering: a nonstarter is a character that reorders against U+0334 (class 1) or U+0345
// (class 240, the highest), and the class order is the order NFD sorts two of them in. A primary composite Y (NFC
// leaves it, its NFD has two or more code points) composes from NFC of its NFD without the last code point, followed by
// that last one: in canonical order the pair NFC meets is that one, and no other (a pair whose mark has a lower class
// than its first character's last piece is never reached, as NFC sorts the marks of a run first).

import { normalizeOnce } from "../src/domain/tag-name.js";

const HANGUL_FIRST = 0xac00;
const HANGUL_LAST = 0xd7a3;

export type TagKeyTables = {
  // 1 at each eligible code point.
  eligible: Uint8Array;
  // Each nonstarter that does not decompose, with the rank of its combining class (1 for the lowest).
  rank: Map<number, number>;
  // The canonical decomposition of each eligible character that has one, Hangul syllables left out.
  pieces: Map<number, number[]>;
  // Primary composites by first * 0x110000 + second, Hangul left out (composite()).
  pairs: Map<number, number>;
};

export function isHangulSyllable(cp: number): boolean {
  return cp >= HANGUL_FIRST && cp <= HANGUL_LAST;
}

function isSurrogate(cp: number): boolean {
  return cp >= 0xd800 && cp <= 0xdfff;
}

export function codePoints(text: string): number[] {
  return [...text].map((c) => c.codePointAt(0)!);
}

export function deriveTagKeyTables(): TagKeyTables {
  const eligible = new Uint8Array(0x110000);
  const nonstarters: number[] = [];
  for (let cp = 0; cp < 0x110000; cp++) {
    if (isSurrogate(cp)) {
      continue;
    }
    const c = String.fromCodePoint(cp);
    if (c.normalize("NFKC") === c && c.toLowerCase() === c && normalizeOnce(c) === c) {
      eligible[cp] = 1;
    }
    if (c.normalize("NFD") === c && (reorders(c, "\u0334") || reorders("\u0345", c))) {
      nonstarters.push(cp);
    }
  }
  const above = (a: number, b: number) => reorders(String.fromCodePoint(a), String.fromCodePoint(b));
  nonstarters.sort((a, b) => (above(a, b) ? 1 : above(b, a) ? -1 : 0));
  const rank = new Map<number, number>();
  let r = 0;
  nonstarters.forEach((cp, i) => {
    if (i === 0 || above(cp, nonstarters[i - 1]!)) {
      r++;
    }
    rank.set(cp, r);
  });
  const rankOf = (cp: number) => rank.get(cp) ?? 0;
  const pieces = new Map<number, number[]>();
  const pairs = new Map<number, number>();
  for (let cp = 0; cp < 0x110000; cp++) {
    if (isSurrogate(cp) || isHangulSyllable(cp)) {
      continue;
    }
    const y = String.fromCodePoint(cp);
    const nfd = codePoints(y.normalize("NFD"));
    if (eligible[cp] === 1 && nfd.length > 1) {
      pieces.set(cp, nfd);
    }
    if (nfd.length < 2 || y.normalize("NFC") !== y) {
      continue;
    }
    const last = nfd.at(-1)!;
    const first = codePoints(String.fromCodePoint(...nfd.slice(0, -1)).normalize("NFC"));
    if (first.length !== 1) {
      throw new Error(`U+${hex(cp)}: the NFD before its last code point does not compose to one character`);
    }
    const before = codePoints(String.fromCodePoint(first[0]!).normalize("NFD")).at(-1)!;
    if (rankOf(last) !== 0 && rankOf(last) < rankOf(before)) {
      throw new Error(`U+${hex(cp)}: its last code point sorts before the piece it follows`);
    }
    if (String.fromCodePoint(first[0]!, last).normalize("NFC") !== y) {
      throw new Error(`U+${hex(cp)}: its pair does not compose to it`);
    }
    pairs.set(first[0]! * 0x110000 + last, cp);
  }
  return { eligible, rank, pieces, pairs };
}

function reorders(a: string, b: string): boolean {
  return (a + b).normalize("NFD") === b + a;
}

export function hex(cp: number): string {
  return cp.toString(16).toUpperCase().padStart(4, "0");
}

// The composite NFC makes of the starter `x` and the next code point `m` it is not blocked from, if any: the pairs, and
// Hangul's L + V and LV + T.
export function composite(tables: TagKeyTables, x: number, m: number): number | undefined {
  if (x >= 0x1100 && x <= 0x1112 && m >= 0x1161 && m <= 0x1175) {
    return HANGUL_FIRST + ((x - 0x1100) * 21 + (m - 0x1161)) * 28;
  }
  if (isHangulSyllable(x) && (x - HANGUL_FIRST) % 28 === 0 && m >= 0x11a8 && m <= 0x11c2) {
    return x + m - 0x11a7;
  }
  return tables.pairs.get(x * 0x110000 + m);
}

// Every code point that is the second of a composite, Hangul's V and T included.
export function seconds(tables: TagKeyTables): Set<number> {
  const out = new Set<number>();
  for (const key of tables.pairs.keys()) {
    out.add(key % 0x110000);
  }
  for (let cp = 0x1161; cp <= 0x1175; cp++) {
    out.add(cp);
  }
  for (let cp = 0x11a8; cp <= 0x11c2; cp++) {
    out.add(cp);
  }
  return out;
}

// NFC as the migration computes it, from the tables: each character's pieces (a Hangul syllable is one), each run of
// nonstarters sorted stably by class, then composed left to right onto the last starter.
export function tableNfc(tables: TagKeyTables, text: string): string {
  const rankOf = (cp: number) => tables.rank.get(cp) ?? 0;
  const expanded = codePoints(text).flatMap((cp) => tables.pieces.get(cp) ?? [cp]);
  const sorted: number[] = [];
  for (let i = 0; i < expanded.length;) {
    let j = i;
    while (j < expanded.length && rankOf(expanded[j]!) > 0) {
      j++;
    }
    if (j === i) {
      sorted.push(expanded[i]!);
      i++;
      continue;
    }
    sorted.push(...expanded.slice(i, j).toSorted((a, b) => rankOf(a) - rankOf(b)));
    i = j;
  }
  const out: number[] = [];
  let x: number | null = null;
  let left: number[] = [];
  for (const m of sorted) {
    const r = rankOf(m);
    if (x === null) {
      if (r === 0) {
        x = m;
      } else {
        out.push(m);
      }
      continue;
    }
    const y = composite(tables, x, m);
    if (y !== undefined && (left.length === 0 || (r > 0 && rankOf(left.at(-1)!) < r))) {
      x = y;
    } else if (r === 0) {
      out.push(x, ...left);
      x = m;
      left = [];
    } else {
      left.push(m);
    }
  }
  if (x !== null) {
    out.push(x, ...left);
  }
  return String.fromCodePoint(...out);
}

// The rows of the migration's lookup tables, as the runtime gives them.
export type TagKeyRows = {
  chars: [number, number][];
  triggers: [number, number][];
  pieces: [number, number, number][];
  ccc: [number, number][];
  pairs: [number, number, number][];
};

function ranges(flags: (cp: number) => boolean): [number, number][] {
  const out: [number, number][] = [];
  for (let cp = 0; cp < 0x110000; cp++) {
    if (!flags(cp)) {
      continue;
    }
    const last = out.at(-1);
    if (last !== undefined && last[1] === cp - 1) {
      last[1] = cp;
    } else {
      out.push([cp, cp]);
    }
  }
  return out;
}

// A trigger is an eligible character NFC can change a name at: a nonstarter, or one whose first piece is the second of
// a composite. A name of eligible characters with none is NFC already: each character's pieces recompose to it, and
// nothing before can take its first piece.
export function tagKeyRows(tables: TagKeyTables): TagKeyRows {
  const second = seconds(tables);
  const first = (cp: number) => tables.pieces.get(cp)?.[0] ?? cp;
  return {
    chars: ranges((cp) => tables.eligible[cp] === 1),
    triggers: ranges(
      (cp) => tables.eligible[cp] === 1 && ((tables.rank.get(first(cp)) ?? 0) > 0 || second.has(first(cp))),
    ),
    pieces: [...tables.pieces]
      .toSorted(([a], [b]) => a - b)
      .flatMap(([cp, list]) => list.map((piece, j): [number, number, number] => [cp, j, piece])),
    ccc: [...tables.rank].toSorted(([a], [b]) => a - b),
    pairs: [...tables.pairs]
      .map(([key, y]): [number, number, number] => [Math.floor(key / 0x110000), key % 0x110000, y])
      .toSorted((a, b) => a[0] - b[0] || a[1] - b[1]),
  };
}

// The same rows as the migration's INSERT ... VALUES literals hold them.
export function migrationRows(sql: string): TagKeyRows {
  const values = (table: string, width: number) => {
    const match = new RegExp(`INSERT INTO ${table} \\([^)]*\\) VALUES([^;]*);`).exec(sql);
    if (match === null) {
      throw new Error(`no INSERT INTO ${table}`);
    }
    const numbers = [...match[1]!.matchAll(/0x[0-9A-F]+|\d+/g)].map((m) => Number(m[0]));
    const rows: number[][] = [];
    for (let i = 0; i < numbers.length; i += width) {
      rows.push(numbers.slice(i, i + width));
    }
    return rows;
  };
  return {
    chars: values("tag_key_chars", 2) as [number, number][],
    triggers: values("tag_key_triggers", 2) as [number, number][],
    pieces: values("tag_nfc_pieces", 3) as [number, number, number][],
    ccc: values("tag_nfc_ccc", 2) as [number, number][],
    pairs: values("tag_nfc_pairs", 3) as [number, number, number][],
  };
}
