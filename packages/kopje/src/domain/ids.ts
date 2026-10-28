import type { Db } from "../db/sql";

// A new generation of a quote's work (quotes.ts): drawn by every write the rule at the column names (migration
// 0033_quotes). Kept here, in a module that imports nothing, because inbox.ts builds a statement with it when it is
// loaded, whichever module of the domain's import cycle is loaded first.
export const NEW_GENERATION = "(abs(random()) % 9007199254740991)";

// API IDs: 18-digit snowflakes, (ms << 16) | 16 random bits, kept as TEXT and never read as JS numbers.

// Returns an integer in [0, maxExclusive).
export type RandomInt = (maxExclusive: number) => number;

// Masks to the smallest power of two covering the range and draws again when the value falls outside it, so the
// result stays uniform (modulo would bias it). maxExclusive must be in [1, 2^31].
export const cryptoRandomInt: RandomInt = (maxExclusive) => {
  const mask = 2 ** Math.ceil(Math.log2(maxExclusive)) - 1;
  const buffer = new Uint32Array(1);
  for (;;) {
    const value = (crypto.getRandomValues(buffer)[0] ?? 0) & mask;
    if (value < maxExclusive) {
      return value;
    }
  }
};

// IDs before this date would have fewer than 18 digits.
const EARLIEST_MS = Date.UTC(2018, 4, 10);

function snowflakeValue(ms: number, random: RandomInt): bigint {
  return (BigInt(ms) << 16n) | BigInt(random(0x10000));
}

function format(id: bigint): string {
  const text = id.toString();
  if (text.length !== 18) {
    throw new RangeError(`snowflake out of range: ${text}`);
  }
  return text;
}

const LAST_LOCAL_ID = "last_local_id";

// Allocates a local ID: max((now << 16) | rand16, last + 1), so IDs strictly increase even within one millisecond
// or when the clock goes back. The last ID lives in the Store state table, and the call must run inside the write
// operation that uses the ID, so both commit or roll back together. The clock comes from the caller (inside a DO,
// Date.now() does not advance during a request).
export function allocateLocalId(db: Db, nowMs: number, random: RandomInt = cryptoRandomInt): string {
  const last = db.first<{ value: string }>("SELECT value FROM kopje_state WHERE name = ?", LAST_LOCAL_ID)?.value;
  const candidate = snowflakeValue(Math.max(nowMs, EARLIEST_MS), random);
  const id = format(last !== undefined && candidate <= BigInt(last) ? BigInt(last) + 1n : candidate);
  db.run("INSERT OR REPLACE INTO kopje_state (name, value) VALUES (?, ?)", LAST_LOCAL_ID, id);
  return id;
}

// Remote objects use `published` truncated to the second plus 0-999 random ms. Future or unparsable times use now;
// times before 2018-05-10 are raised to that date.
export function remoteId(published: string, nowMs: number, random: RandomInt = cryptoRandomInt): string {
  const parsed = Date.parse(published);
  const ms = Math.max(Number.isNaN(parsed) || parsed > nowMs ? nowMs : parsed, EARLIEST_MS);
  return format(snowflakeValue(Math.floor(ms / 1000) * 1000 + random(1000), random));
}

const MAX_ID_ATTEMPTS = 5;

// Inserts with a generated ID and generates a new one when the ID collides. Other UNIQUE violations propagate.
export function insertWithFreshId<T>(table: string, generate: () => string, insert: (id: string) => T): T {
  for (let attempt = 1; ; attempt++) {
    const id = generate();
    try {
      return insert(id);
    } catch (error) {
      const collided = error instanceof Error && error.message.includes(`UNIQUE constraint failed: ${table}.id`);
      if (!collided || attempt >= MAX_ID_ATTEMPTS) {
        throw error;
      }
    }
  }
}

// Ruby's whitespace (ISSPACE): space, \t, \n, \v, \f and \r. No other character is skipped.
const RUBY_SPACE = new Set([" ", "\t", "\n", "\v", "\f", "\r"]);
const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";

// An id as Ruby's String#to_i reads it, as decimal text (Mastodon maps media_ids and allowed_mentions with
// `.map(&:to_i)`): leading Ruby whitespace skipped, an optional sign, an optional 0d or 0D prefix, then digits with
// single underscores between them; "0" when there is no number, and never "-0". Text only, never a JS number, so ids
// above 2^53 stay exact; the result is never longer than `value`.
export function requestedId(value: string): string {
  let i = 0;
  while (RUBY_SPACE.has(value[i] ?? "")) {
    i++;
  }
  const negative = value[i] === "-";
  if (value[i] === "-" || value[i] === "+") {
    i++;
  }
  if (value[i] === "0" && (value[i + 1] === "d" || value[i + 1] === "D")) {
    i += 2;
  }
  let digits = "";
  while (isDigit(value[i])) {
    digits += value[i];
    i++;
    if (value[i] === "_" && isDigit(value[i + 1])) {
      i++;
    }
  }
  const number = digits.replace(/^0+/, "");
  return number === "" ? "0" : negative ? `-${number}` : number;
}

// The stored form of an id requestedId read: ids are kept as 18-character TEXT, which an imported id fills with leading
// zeros (000000000000000123), so a number of at most 18 digits is padded to it. Anything else names no stored row and
// is returned as it is.
export function storedIdOf(requested: string): string {
  return /^\d{1,18}$/.test(requested) ? requested.padStart(18, "0") : requested;
}
