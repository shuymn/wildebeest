import type { Db } from "../db/sql";

// Candidate windows: the bound, the cut and the continuation of every paged read whose rule hides rows, and the cursor
// rule its candidates keep, are docs/visibility.md "Read bounds" (RES-7).

// The candidates of a read for a page of `limit`: three pages, at least 40, and never fewer than a stream's.
export function readWindow(limit: number): number {
  return Math.max(3 * limit, 40);
}

// The candidates of each stream of a merged read (home, a list, a hashtag timeline's names): two pages, at least 40.
export function streamWindow(limit: number): number {
  return Math.max(2 * limit, 40);
}

// A window: its candidates in cursor order, each with `o`, the bits of the streams it came from (a merged read's rule
// may differ by stream), and whether it ended before the cursor's range did.
export type Window = { readonly candidates: readonly { id: string; o: number }[]; readonly cut: boolean };

// The window of streams merged (home's, a list's, a hashtag timeline's). `streams` selects (id, k, o) rows: each
// stream k's candidates from the cursor in cursor order, at most `per` each, and o a bit of the stream's kind (a power
// of two, or 0), which the candidate carries ORed over its streams.
// A stream that gave `per` ended there, so the merged window ends at the highest such end (the lowest when ascending):
// below it a stream may have candidates that were not read. The window is the candidates from the cursor to that end,
// at most `size`. A single stream (one k, per = size) is the plain case. The parameters are the caller's.
export function mergedWindow(
  db: Db,
  query: { streams: string; ascending: boolean; per: number; size: number },
  ...params: SqlStorageValue[]
): Window {
  const order = query.ascending ? "ASC" : "DESC";
  const [toward, end] = query.ascending ? ["<=", "max"] : [">=", "min"];
  const highest = query.ascending ? "min" : "max";
  const rows = db.all<{ id: string; o: number; bound: string | null }>(
    `WITH c(id, k, o) AS MATERIALIZED (${query.streams}),
		f(bound) AS (SELECT ${highest}(edge) FROM (SELECT ${end}(id) AS edge FROM c GROUP BY k HAVING count(*) >= ${int(query.per)}))
		SELECT id, sum(DISTINCT o) AS o, (SELECT bound FROM f) AS bound FROM c
		WHERE (SELECT bound FROM f) IS NULL OR id ${toward} (SELECT bound FROM f)
		GROUP BY id ORDER BY id ${order} LIMIT ${int(query.size) + 1}`,
    ...params,
  );
  const cut = rows.length > query.size || (rows[0]?.bound ?? null) !== null;
  return { candidates: rows.slice(0, query.size).map(({ id, o }) => ({ id: String(id), o })), cut };
}

// The window of one stream: `candidates` selects (id) rows, the stream's candidates from the cursor in cursor order,
// at most `size`, so a full window may end before the range does. An INTEGER cursor is selected as TEXT, exact above
// 2^53.
export function singleWindow(db: Db, candidates: string, size: number, ...params: SqlStorageValue[]): Window {
  return windowOf(
    db.all<{ id: string }>(candidates, ...params).map(({ id }) => String(id)),
    size,
  );
}

// The window of one stream read already: at most `size` candidate ids in cursor order.
export function windowOf(ids: readonly string[], size: number): Window {
  return { candidates: ids.map((id) => ({ id, o: 0 })), cut: ids.length >= size };
}

export function windowJson(window: Window): string {
  return JSON.stringify(window.candidates);
}

// The page of a window: of the rows the rule passed (`passed`, keyed by candidate), the first `limit` in cursor order,
// newest first. Its far end is the last of them when the page is full, else the window's last candidate when the
// window was cut, so a next page starts below what this one read; its near end is the first of them, or the window's
// first candidate when none passed. `cut`: the next link is offered whatever the page holds. `more`: a row may lie past
// the far end: a row the rule passed lies past the page in the window, or the window was cut. An uncut window holds
// every candidate of the cursor's range, so without either no row a page would show lies past it.
export function windowPage<R>(
  window: Window,
  passed: readonly R[],
  key: (row: R) => string,
  limit: number,
  ascending: boolean,
): { rows: R[]; newest: string | null; oldest: string | null; cut: boolean; more: boolean } {
  const byKey = new Map(passed.map((row) => [key(row), row]));
  const ordered = window.candidates.flatMap(({ id }) => byKey.get(id) ?? []);
  const taken = ordered.slice(0, limit);
  const full = taken.length >= limit;
  const first = taken[0];
  const last = taken.at(-1);
  const near = first !== undefined ? key(first) : window.cut ? (window.candidates[0]?.id ?? null) : null;
  const far =
    full && last !== undefined
      ? key(last)
      : window.cut
        ? (window.candidates.at(-1)?.id ?? null)
        : last === undefined
          ? null
          : key(last);
  const cut = window.cut && !full;
  const more = ordered.length > limit || window.cut;
  return ascending
    ? { rows: taken.reverse(), newest: far, oldest: near, cut, more }
    : { rows: taken, newest: near, oldest: far, cut, more };
}

function int(n: number): number {
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(`a window size must be a positive integer, not ${n}`);
  }
  return n;
}
