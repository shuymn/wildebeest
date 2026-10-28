import { quoteIdentifier } from "./dump-format";

// The canonical literal of each stored value, and its way back into SQLite as a bound parameter.
//
// Values are read as exact bytes and encoded here rather than with SQLite's quote(): quote() doubles BLOBs inside
// SQLite (past its 2 MB value limit), truncates TEXT at NUL, and spells REAL differently across SQLite versions; a
// TEXT read as a JS string replaces invalid UTF-8. The canonical literals are:
//
//   NULL                      NULL
//   INTEGER                   decimal, exact 64-bit                       (read as CAST(v AS TEXT))
//   REAL                      ECMAScript Number#toString of the double, with ".0" added when it has neither "." nor
//                             "e"; -0.0, 9e999 and -9e999 for -0, +Infinity and -Infinity
//   TEXT, valid UTF-8, no NUL '...' with ' doubled
//   TEXT, otherwise           CAST(X'<hex of the exact bytes>' AS TEXT)  (read as CAST(v AS BLOB))
//   BLOB                      X'<HEX>'
//
// Every literal is a valid SQLite expression of the same storage class, and the encoding is one-to-one, so a checksum
// over literals covers the exact stored bytes.

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).toUpperCase().padStart(2, "0"));
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => HEX[byte] ?? "00").join("");
}

export function fromHex(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes.buffer;
}

function realLiteral(value: number): string {
  if (value === Infinity) {
    return "9e999";
  }
  if (value === -Infinity) {
    return "-9e999";
  }
  if (Object.is(value, -0)) {
    return "-0.0";
  }
  const text = String(value);
  return /[.e]/.test(text) ? text : `${text}.0`;
}

export function textLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function bytesOf(value: SqlStorageValue): Uint8Array {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array();
}

// The SQL that reads a column as (storage class, exact value) for valueLiteral.
export function readColumn(column: string): string[] {
  const q = quoteIdentifier(column);
  return [
    `typeof(${q})`,
    `CASE typeof(${q}) WHEN 'integer' THEN CAST(${q} AS TEXT) WHEN 'text' THEN CAST(${q} AS BLOB) ELSE ${q} END`,
  ];
}

export function valueLiteral(type: SqlStorageValue, value: SqlStorageValue): string {
  switch (type) {
    case "null":
      return "NULL";
    case "integer":
      return value as string;
    case "real":
      return realLiteral(value as number);
    case "text": {
      const bytes = bytesOf(value);
      let text: string | null;
      try {
        text = utf8.decode(bytes);
      } catch {
        text = null;
      }
      return text === null || text.includes("\0") ? `CAST(X'${toHex(bytes)}' AS TEXT)` : textLiteral(text);
    }
    case "blob":
      return `X'${toHex(bytesOf(value))}'`;
    default:
      throw new Error(`unexpected storage class ${JSON.stringify(type)}`);
  }
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

export class LiteralError extends Error {}

// A literal as an SQL expression with bound parameters, so statement text stays short (the platform limits a
// statement to 100 KB) and every storage class is kept: integers go in as text and are cast, since a JS number always
// binds as REAL.
function bindLiteral(literal: string): { expr: string; params: SqlStorageValue[] } {
  if (literal === "NULL") {
    return { expr: "NULL", params: [] };
  }
  if (literal.startsWith("'")) {
    return { expr: "?", params: [literal.slice(1, -1).replaceAll("''", "'")] };
  }
  if (literal.startsWith("CAST(")) {
    return { expr: "CAST(? AS TEXT)", params: [fromHex(literal.slice(7, -10))] };
  }
  if (literal.startsWith("X") || literal.startsWith("x")) {
    return { expr: "?", params: [fromHex(literal.slice(2, -1))] };
  }
  if (/^-?\d+$/.test(literal)) {
    const value = BigInt(literal);
    if (value < INT64_MIN || value > INT64_MAX) {
      throw new LiteralError(`integer out of range: ${literal}`);
    }
    return { expr: "CAST(? AS INTEGER)", params: [value.toString()] };
  }
  return { expr: "?", params: [Number(literal)] };
}

// Binds a list of literals: their expressions and the flattened parameters.
export function bindAll(literals: readonly string[]): { exprs: string[]; params: SqlStorageValue[] } {
  const exprs: string[] = [];
  const params: SqlStorageValue[] = [];
  for (const literal of literals) {
    const bound = bindLiteral(literal);
    exprs.push(bound.expr);
    params.push(...bound.params);
  }
  return { exprs, params };
}
