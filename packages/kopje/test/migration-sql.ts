import { type SqlToken, tokenizeSql } from "../src/platform/readonly-sql";

// Lints of migration SQL (test/migration-lint.test.ts), over the tokens of src/platform/readonly-sql.ts, so comments,
// strings and quoted identifiers never hide a keyword or pass for one. Their threat assumption: Migration in
// src/platform/store-kernel.ts.

const isWord = (token: SqlToken | undefined, text: string): boolean => token?.kind === "word" && token.text === text;

// Every migration: no PRAGMA statement and no DEFERRABLE clause.
export function forbiddenProblem(sql: string): string | null {
  const tokens = tokenizeSql(sql);
  if (typeof tokens === "string") {
    return tokens;
  }
  const found = tokens.find((t) => isWord(t, "PRAGMA") || isWord(t, "DEFERRABLE"));
  return found === undefined ? null : `${found.text} is not allowed in a migration`;
}

type Statement = { tokens: SqlToken[]; trigger: boolean };

const BLOCK_WORDS = new Set(["BEGIN", "CASE", "END"]);

function startsTrigger(tokens: SqlToken[]): boolean {
  return (
    isWord(tokens[0], "CREATE") &&
    (isWord(tokens[1], "TRIGGER") ||
      ((isWord(tokens[1], "TEMP") || isWord(tokens[1], "TEMPORARY")) && isWord(tokens[2], "TRIGGER")))
  );
}

// The top-level statements, split at each ';'. Only a CREATE [TEMP] TRIGGER statement holds blocks: its one BEGIN
// opens the body, each CASE opens an expression, and END closes the innermost; the body's END must end the statement.
// Elsewhere BEGIN, CASE and END are refused, so a word that SQLite reads as an identifier (`AS begin`, a column named
// end) can neither open nor close a block. Refused too: unquoted non-ASCII and a word the tokenizer split (longer than
// its 256 characters), since SQLite reads either as part of one identifier.
function statements(sql: string, tokens: SqlToken[]): Statement[] | string {
  const out: Statement[] = [];
  let current: SqlToken[] = [];
  let blocks: ("BEGIN" | "CASE")[] = [];
  let body: "none" | "open" | "closed" = "none";
  const end = (): string | null => {
    const trigger = startsTrigger(current);
    if (trigger && (blocks.length > 0 || body !== "closed")) {
      return "a trigger statement must end with the END of its body";
    }
    if (current.length > 0) {
      out.push({ tokens: current, trigger });
    }
    current = [];
    blocks = [];
    body = "none";
    return null;
  };
  for (const [i, t] of tokens.entries()) {
    if (t.kind === "punct" && t.text.charCodeAt(0) > 0x7f) {
      return "unquoted non-ASCII is not allowed";
    }
    if ((t.kind === "word" || (t.kind === "other" && t.text === "0")) && /[A-Za-z0-9_$]/.test(sql[t.at - 1] ?? "")) {
      return "an unquoted identifier longer than 256 characters is not allowed";
    }
    if (t.kind === "punct" && t.text === ";" && blocks.length === 0) {
      const problem = end();
      if (problem !== null) {
        return problem;
      }
      continue;
    }
    current.push(t);
    if (t.kind !== "word" || !BLOCK_WORDS.has(t.text)) {
      continue;
    }
    if (!startsTrigger(current)) {
      return `${t.text} is allowed only in a trigger statement`;
    }
    if (body === "closed") {
      return `${t.text} after the END of a trigger's body`;
    }
    if (t.text === "CASE") {
      blocks.push("CASE");
    } else if (t.text === "BEGIN") {
      if (body !== "none" || blocks.length > 0) {
        return "BEGIN is allowed only once in a trigger statement, to open its body";
      }
      blocks.push("BEGIN");
      body = "open";
    } else {
      const closed = blocks.pop();
      if (closed === undefined) {
        return "END without a BEGIN or CASE";
      }
      const next = tokens[i + 1];
      if (closed === "BEGIN") {
        if (next !== undefined && !(next.kind === "punct" && next.text === ";")) {
          return "a trigger's body must end its statement";
        }
        body = "closed";
      }
    }
  }
  return blocks.length > 0 ? "unterminated BEGIN or CASE" : (end() ?? out);
}

const DML = new Set(["INSERT", "UPDATE", "DELETE", "REPLACE", "SELECT", "WITH"]);

const isPunct = (token: SqlToken | undefined, text: string): boolean => token?.kind === "punct" && token.text === text;
const isString = (token: SqlToken | undefined): boolean => token?.kind === "other" && token.text === "'";

// The work tables a declared file creates and drops, and the indexes of other tables it drops (each of which it
// creates again): what the dynamic checks of test/migration-lint.test.ts compare against the schema before and after
// the file. Only for a file unchangedProblem accepts.
export type DeclaredObjects = { workTables: string[]; droppedIndexes: string[] };

// A file declared foreignKeys: 'unchanged', judged before it runs. It is written in a narrow dialect, in every
// statement (DDL, triggers, DML and the table a write names): every name a plain unquoted ASCII word, never
// schema-qualified (main.) or quoted (a quoted string is a value, never a name), and no IF [NOT] EXISTS or TEMP
// anywhere. It may hold only statements that cannot change a reference or a key of the schema it leaves:
//   ALTER TABLE <name> ADD [COLUMN] ... with no REFERENCES and no generated column (GENERATED, or AS followed by '(');
//   CREATE TRIGGER (its body's writes are checked as they run) and DROP TRIGGER (a trigger holds no key or
//   reference); CREATE INDEX that is not UNIQUE;
//   DML (INSERT, UPDATE, DELETE, REPLACE, SELECT, WITH), checked statement by statement (foreign keys are immediate,
//   and no migration may defer them);
//   a work table: CREATE TABLE <name> with no REFERENCES, which the file drops (DROP TABLE <name>) before it ends; any
//   index on it, UNIQUE included, and DROP INDEX of one;
//   DROP INDEX of another table's index when the file creates an index of that name again after it.
// What only the schema can tell is checked by running the file (test/migration-lint.test.ts): that no reference names
// a work table before it, that none is left after it, and that every index the Store had before it is there after it
// with the same definition (so a dropped index was created again as it was, and was not UNIQUE).
// Anything else (CREATE VIEW, CREATE UNIQUE INDEX on a table the file did not create, DROP of anything else, RENAME,
// DROP COLUMN, ...) is refused, and so is a trigger named BEGIN, CASE or END.
export function unchangedProblem(sql: string): string | null {
  const objects = declaredObjects(sql);
  return typeof objects === "string" ? objects : null;
}

// The objects of a declared file (DeclaredObjects), or why unchangedProblem refuses it.
export function declaredObjects(sql: string): DeclaredObjects | string {
  const tokens = tokenizeSql(sql);
  if (typeof tokens === "string") {
    return tokens;
  }
  const quoted = tokens.find((t) => t.kind === "other" && (t.text === '"' || t.text === "`" || t.text === "["));
  if (quoted !== undefined) {
    return "a quoted name is not allowed";
  }
  const ifExists = tokens.find(
    (t, i) => isWord(t, "IF") && (isWord(tokens[i + 1], "EXISTS") || isWord(tokens[i + 1], "NOT")),
  );
  if (ifExists !== undefined || tokens.some((t) => isWord(t, "TEMP") || isWord(t, "TEMPORARY"))) {
    return "IF [NOT] EXISTS and TEMP are not allowed";
  }
  // A qualified name in any statement: the schema main before '.', or a string on either side of one (SQLite takes a
  // string where a name is expected).
  const qualified = tokens.find(
    (t, i) => isPunct(t, ".") && (isWord(tokens[i - 1], "MAIN") || isString(tokens[i - 1]) || isString(tokens[i + 1])),
  );
  if (qualified !== undefined) {
    return "a schema-qualified or quoted name is not allowed";
  }
  const split = statements(sql, tokens);
  if (typeof split === "string") {
    return split;
  }
  const work = new Set<string>();
  const dropped = new Set<string>();
  const workIndexes = new Set<string>();
  const droppedIndexes: string[] = [];
  for (const [at, { tokens: s, trigger }] of split.entries()) {
    const word = (i: number) => (s[i]?.kind === "word" ? s[i].text : null);
    // A plain name at position i: a word not followed by '.'.
    const name = (i: number) => (isPunct(s[i + 1], ".") ? null : word(i));
    if (trigger) {
      if (word(1) !== "TRIGGER") {
        return `CREATE ${word(1) ?? ""} TRIGGER is not allowed`;
      }
      if (name(2) === null || BLOCK_WORDS.has(word(2) ?? "")) {
        return `a trigger named ${s[2]?.text ?? ""} is not allowed`;
      }
    } else if (word(0) === "ALTER") {
      const add = word(1) === "TABLE" && name(2) !== null && word(3) === "ADD";
      const generated = s.some((t, i) => isWord(t, "GENERATED") || (isWord(t, "AS") && isPunct(s[i + 1], "(")));
      if (!add || generated || s.some((t) => isWord(t, "REFERENCES"))) {
        return "only ALTER TABLE ... ADD COLUMN without REFERENCES or a generated column is allowed";
      }
    } else if (word(0) === "CREATE" && word(1) === "TABLE") {
      const table = name(2);
      if (table === null) {
        return "a work table needs a plain name";
      }
      if (s.some((t) => isWord(t, "REFERENCES"))) {
        return `the work table ${table} holds a REFERENCES`;
      }
      if (work.has(table) || dropped.has(table)) {
        return `the work table ${table} is created twice`;
      }
      work.add(table);
    } else if (word(0) === "CREATE" && (word(1) === "INDEX" || (word(1) === "UNIQUE" && word(2) === "INDEX"))) {
      const pos = word(1) === "UNIQUE" ? 3 : 2;
      const index = name(pos);
      const table = isWord(s[pos + 1], "ON") ? name(pos + 2) : null;
      if (index === null || table === null) {
        return "an index needs a plain name and table";
      }
      if (work.has(table)) {
        workIndexes.add(index);
      } else if (word(1) === "UNIQUE") {
        return `CREATE UNIQUE INDEX on ${table}, a table the file did not create, is not allowed`;
      }
    } else if (word(0) === "DROP" && word(1) === "TRIGGER") {
      if (name(2) === null || s.length !== 3) {
        return "DROP TRIGGER needs a plain name";
      }
    } else if (word(0) === "DROP" && word(1) === "TABLE") {
      const table = name(2);
      if (table === null || s.length !== 3 || !work.has(table)) {
        return `DROP TABLE of ${s[2]?.text ?? ""}, a table the file did not create, is not allowed`;
      }
      work.delete(table);
      dropped.add(table);
    } else if (word(0) === "DROP" && word(1) === "INDEX") {
      const index = name(2);
      if (index === null || s.length !== 3) {
        return "DROP INDEX needs a plain name";
      }
      if (workIndexes.has(index)) {
        continue;
      }
      const again = split.slice(at + 1).some(({ tokens: x }) => {
        const unique = isWord(x[1], "UNIQUE");
        return isWord(x[0], "CREATE") && isWord(x[unique ? 2 : 1], "INDEX") && isWord(x[unique ? 3 : 2], index);
      });
      if (!again) {
        return `DROP INDEX ${index} is allowed only when the file creates it again`;
      }
      droppedIndexes.push(index);
    } else if (!DML.has(word(0) ?? "")) {
      return `${word(0) ?? s[0]?.text ?? ""} is not allowed`;
    } else {
      // The table a write names: after INTO, UPDATE (and its OR clause) and DELETE FROM, a plain word.
      const target = s.findIndex(
        (t, i) => isWord(t, "INTO") || (isWord(t, "UPDATE") && !isWord(s[i - 1], "OR")) || isWord(t, "DELETE"),
      );
      if (target !== -1) {
        let at = target + 1;
        if (isWord(s[target], "UPDATE") && isWord(s[at], "OR")) {
          at += 2;
        } else if (isWord(s[target], "DELETE")) {
          at += isWord(s[at], "FROM") ? 1 : 0;
        }
        if (name(at) === null) {
          return `a write to ${s[at]?.text ?? ""}, which is not a plain name, is not allowed`;
        }
      }
    }
  }
  const left = [...work];
  return left.length === 0
    ? { workTables: [...dropped], droppedIndexes }
    : `the work table ${left.join(", ")} is not dropped`;
}
