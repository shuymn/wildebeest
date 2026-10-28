// Reads the statements of a Kopje dump (docs/dump-format.md) back into rows of canonical literals. Plain JS without
// Node APIs, so the conversion check runs on the CLI and inside the Workers test pool alike.

import { END_LINE, HEADER_PREFIX, TRAILER_PREFIX } from "../format.js";

/**
 * @typedef {{ kind: 'insert', table: string, columns: string[], literals: string[] }
 *   | { kind: 'link', table: string, set: [string, string][], where: [string, string][] }} DumpStatement
 */

/**
 * Splits a whole dump text into its header, statements and trailer.
 * @param {string} text
 * @returns {{ header: unknown, trailer: unknown, statements: Generator<DumpStatement> }}
 */
export function readDumpText(text) {
  const firstEnd = text.indexOf("\n");
  const first = text.slice(0, firstEnd);
  if (!first.startsWith(HEADER_PREFIX)) {
    throw new Error("not a kopje dump (no header line)");
  }
  if (!text.endsWith(`\n${END_LINE}\n`)) {
    throw new Error(`the dump is incomplete: it does not end with "${END_LINE}"`);
  }
  const trailerStart = text.lastIndexOf(`\n${TRAILER_PREFIX}`) + 1;
  if (trailerStart <= firstEnd) {
    throw new Error("the dump has no trailer");
  }
  const trailerLine = text.slice(trailerStart, text.length - END_LINE.length - 2);
  return {
    header: /** @type {unknown} */ (JSON.parse(first.slice(HEADER_PREFIX.length))),
    trailer: /** @type {unknown} */ (JSON.parse(trailerLine.slice(TRAILER_PREFIX.length))),
    statements: statements(text, firstEnd + 1, trailerStart),
  };
}

/**
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @returns {Generator<DumpStatement>}
 */
function* statements(text, start, end) {
  let at = start;
  while (at < end) {
    const parsed = parseStatement(text, at);
    yield parsed.statement;
    at = parsed.next;
  }
}

/**
 * @param {string} text
 * @param {number} at
 * @returns {{ statement: DumpStatement, next: number }}
 */
function parseStatement(text, at) {
  if (text.startsWith("INSERT INTO ", at)) {
    let i = at + "INSERT INTO ".length;
    const table = identifier(text, i);
    i = expect(text, table.next, " (");
    /** @type {string[]} */
    const columns = [];
    for (;;) {
      const column = identifier(text, i);
      columns.push(column.name);
      i = column.next;
      if (text[i] === ",") {
        i++;
        continue;
      }
      break;
    }
    i = expect(text, i, ") VALUES (");
    /** @type {string[]} */
    const literals = [];
    for (;;) {
      const end = scanLiteral(text, i);
      if (end === -1) {
        throw new Error(`invalid literal at offset ${i}`);
      }
      literals.push(text.slice(i, end));
      i = end;
      if (text[i] === ",") {
        i++;
        continue;
      }
      break;
    }
    i = expect(text, i, ");\n");
    if (literals.length !== columns.length) {
      throw new Error(`a row of ${table.name} has ${literals.length} values for ${columns.length} columns`);
    }
    return { statement: { kind: "insert", table: table.name, columns, literals }, next: i };
  }
  if (text.startsWith("UPDATE ", at)) {
    let i = at + "UPDATE ".length;
    const table = identifier(text, i);
    i = expect(text, table.next, " SET ");
    /** @param {string} separator */
    const pairs = (separator) => {
      /** @type {[string, string][]} */
      const out = [];
      for (;;) {
        const column = identifier(text, i);
        i = expect(text, column.next, "=");
        const end = scanLiteral(text, i);
        if (end === -1) {
          throw new Error(`invalid literal at offset ${i}`);
        }
        out.push([column.name, text.slice(i, end)]);
        i = end;
        if (text.startsWith(separator, i)) {
          i += separator.length;
          continue;
        }
        return out;
      }
    };
    const set = pairs(",");
    i = expect(text, i, " WHERE ");
    const where = pairs(" AND ");
    i = expect(text, i, ";\n");
    return { statement: { kind: "link", table: table.name, set, where }, next: i };
  }
  throw new Error(`unexpected statement at offset ${at}`);
}

/**
 * @param {string} text
 * @param {number} at
 * @param {string} fixed
 */
function expect(text, at, fixed) {
  if (!text.startsWith(fixed, at)) {
    throw new Error(`malformed statement at offset ${at}`);
  }
  return at + fixed.length;
}

/**
 * @param {string} text
 * @param {number} at
 */
function identifier(text, at) {
  if (text[at] !== '"') {
    throw new Error(`expected an identifier at offset ${at}`);
  }
  let i = at + 1;
  for (;;) {
    const q = text.indexOf('"', i);
    if (q === -1) {
      throw new Error("unterminated identifier");
    }
    if (text[q + 1] === '"') {
      i = q + 2;
      continue;
    }
    return { name: text.slice(at + 1, q).replaceAll('""', '"'), next: q + 1 };
  }
}

/**
 * Position just after the canonical literal starting at `at`, or -1.
 * @param {string} text
 * @param {number} at
 */
export function scanLiteral(text, at) {
  if (text[at] === "'") {
    let i = at + 1;
    for (;;) {
      const q = text.indexOf("'", i);
      if (q === -1) {
        return -1;
      }
      if (text[q + 1] === "'") {
        i = q + 2;
        continue;
      }
      return q + 1;
    }
  }
  if (text.startsWith("NULL", at)) {
    return at + 4;
  }
  if (text.startsWith("CAST(X'", at)) {
    const end = text.indexOf("' AS TEXT)", at + 7);
    return end === -1 ? -1 : end + 10;
  }
  if (text.startsWith("X'", at) || text.startsWith("x'", at)) {
    const end = text.indexOf("'", at + 2);
    return end === -1 ? -1 : end + 1;
  }
  const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(at, at + 40));
  return match === null ? -1 : at + match[0].length;
}

/**
 * The text of a TEXT literal, or null for NULL. Other storage classes are returned as their literal.
 * @param {string | undefined} literal
 * @returns {string | null}
 */
export function textOf(literal) {
  if (literal === undefined || literal === "NULL") {
    return null;
  }
  if (literal.startsWith("'")) {
    return literal.slice(1, -1).replaceAll("''", "'");
  }
  if (literal.startsWith("CAST(")) {
    const hex = literal.slice(7, -10);
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return new TextDecoder().decode(bytes);
  }
  return literal;
}
