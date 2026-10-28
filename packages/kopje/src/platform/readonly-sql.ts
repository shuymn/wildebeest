// Static check of the admin's read-only SQL. It is the first of three layers (see StoreAdmin.query): this check, the
// statement's rowsWritten, and a transaction that is always rolled back. The platform's own authorizer refuses
// ATTACH and transaction statements as a fourth.
//
// Accepted: exactly one statement that starts with SELECT or WITH, optionally followed by one ';'. Comments, string
// literals and quoted identifiers are skipped when looking for keywords, so a keyword inside them is harmless, and a
// keyword hidden behind a comment is still found.

const FORBIDDEN = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "REPLACE",
  "CREATE",
  "DROP",
  "ALTER",
  "ATTACH",
  "DETACH",
  "PRAGMA",
  "VACUUM",
  "REINDEX",
  "ANALYZE",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
  "LOAD_EXTENSION",
]);

// A token outside comments: a word (upper-cased; at most 256 characters, so a longer one is split), one punctuation
// character (every character that starts no other token, non-ASCII ones included), or 'other' (a string, a quoted
// identifier or a number). at is its offset in the SQL. test/migration-sql.ts lints migrations with these tokens.
export type SqlToken = { kind: "word" | "punct" | "other"; text: string; at: number };

// The tokens of sql, or why it cannot be tokenized (an unterminated comment, string or quoted identifier).
export function tokenizeSql(sql: string): SqlToken[] | string {
  const tokens: SqlToken[] = [];
  let i = 0;
  const closing = (open: string, close: string, label: string): string | null => {
    let j = i + open.length;
    for (;;) {
      const end = sql.indexOf(close, j);
      if (end === -1) {
        return `unterminated ${label}`;
      }
      // A doubled quote inside a quoted token is an escaped quote.
      if (close.length === 1 && close !== "]" && sql[end + 1] === close) {
        j = end + 2;
        continue;
      }
      i = end + close.length;
      return null;
    }
  };
  while (i < sql.length) {
    const c = sql[i] ?? "";
    if (/\s/.test(c)) {
      i++;
    } else if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
    } else if (sql.startsWith("/*", i)) {
      const problem = closing("/*", "*/", "comment");
      if (problem !== null) {
        return problem;
      }
    } else if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      const start = i;
      const problem = closing(c, close, c === "'" ? "string" : "quoted identifier");
      if (problem !== null) {
        return problem;
      }
      tokens.push({ kind: "other", text: c, at: start });
    } else if (/[A-Za-z_]/.test(c)) {
      const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i, i + 256));
      const word = match?.[0] ?? c;
      tokens.push({ kind: "word", text: word.toUpperCase(), at: i });
      i += word.length;
    } else if (/[0-9]/.test(c)) {
      const match = /^[0-9A-Za-z_.]+/.exec(sql.slice(i, i + 256));
      tokens.push({ kind: "other", text: "0", at: i });
      i += match?.[0].length ?? 1;
    } else {
      tokens.push({ kind: "punct", text: c, at: i });
      i++;
    }
  }
  return tokens;
}

// Returns why the statement is refused, or null if it may run.
export function readOnlyProblem(sql: string): string | null {
  const tokens = tokenizeSql(sql);
  if (typeof tokens === "string") {
    return tokens;
  }
  const first = tokens[0];
  if (first === undefined) {
    return "empty statement";
  }
  if (first.kind !== "word" || (first.text !== "SELECT" && first.text !== "WITH")) {
    return "only a single SELECT or WITH statement is allowed";
  }
  for (const [i, token] of tokens.entries()) {
    if (token.kind === "punct" && token.text === ";" && i !== tokens.length - 1) {
      return "only a single statement is allowed";
    }
    if (token.kind === "word" && FORBIDDEN.has(token.text)) {
      // replace(x, y, z) is a read-only function; REPLACE INTO is a write.
      const next = tokens[i + 1];
      if (token.text === "REPLACE" && next?.kind === "punct" && next.text === "(") {
        continue;
      }
      return `${token.text} is not allowed in read-only SQL`;
    }
  }
  return null;
}
