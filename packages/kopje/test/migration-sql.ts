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

// The name a CREATE INDEX statement names (after UNIQUE and IF NOT EXISTS) and the position of ON, or null for a
// schema-qualified or malformed name.
function indexOf(s: SqlToken[]): { name: string; on: number } | null {
  let at = isWord(s[1], "UNIQUE") ? 3 : 2;
  if (isWord(s[at], "IF") && isWord(s[at + 1], "NOT") && isWord(s[at + 2], "EXISTS")) {
    at += 3;
  }
  const name = s[at];
  return name?.kind === "word" && isWord(s[at + 1], "ON") ? { name: name.text, on: at + 1 } : null;
}

// The last CREATE INDEX statement of each name among `files`, as its tokens' text.
function indexDefinitions(files: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const sql of files) {
    const tokens = tokenizeSql(sql);
    const split = typeof tokens === "string" ? [] : statements(sql, tokens);
    for (const { tokens: s } of typeof split === "string" ? [] : split) {
      const index = isWord(s[0], "CREATE") ? indexOf(s) : null;
      if (index !== null) {
        out.set(index.name, s.map((t) => t.text).join(" "));
      }
    }
  }
  return out;
}

// A file declared foreignKeys: 'unchanged' may hold only statements that cannot change a reference or a key of the
// schema it leaves:
//   ALTER TABLE <name> ADD [COLUMN] ... with no REFERENCES and no generated column (GENERATED, or AS followed by '(');
//   CREATE TRIGGER (its body's writes are checked as they run) and DROP TRIGGER (a trigger holds no key or
//   reference); CREATE INDEX that is not UNIQUE;
//   DML (INSERT, UPDATE, DELETE, REPLACE, SELECT, WITH), checked statement by statement (foreign keys are immediate,
//   and no migration may defer them);
//   a work table: CREATE TABLE <name> with no REFERENCES, which the file drops (DROP TABLE <name>) before it ends, and
//   which no file (`earlier`, the migrations before it, or this one) names after REFERENCES, so no row anywhere
//   refers to it and dropping it cascades nothing; any index on it, UNIQUE included, and DROP INDEX of one;
//   DROP INDEX of an index that is not UNIQUE when the file later creates it again exactly as the last of `earlier`
//   that created it (the same statement), since an index that is not UNIQUE is no key a reference can name.
// Anything else (CREATE VIEW, CREATE UNIQUE INDEX on a table the file did not create, DROP of anything else, RENAME,
// DROP COLUMN, TEMP objects, ...) is refused, and so is a trigger named BEGIN, CASE or END.
export function unchangedProblem(sql: string, earlier: readonly string[] = []): string | null {
  const tokens = tokenizeSql(sql);
  if (typeof tokens === "string") {
    return tokens;
  }
  const split = statements(sql, tokens);
  if (typeof split === "string") {
    return split;
  }
  const work = new Set<string>();
  const workIndexes = new Set<string>();
  const dropped = new Set<string>();
  const definitions = indexDefinitions(earlier);
  // The tables any file names after REFERENCES (a schema-qualified name by its last part); null when one cannot be
  // read (a quoted name, or a file that does not tokenize), so that no work table is allowed.
  let referenced: Set<string> | null = new Set<string>();
  for (const file of [...earlier, sql]) {
    const all = tokenizeSql(file);
    if (typeof all === "string") {
      referenced = null;
      break;
    }
    for (const [i, t] of all.entries()) {
      if (!isWord(t, "REFERENCES")) {
        continue;
      }
      const at = isPunct(all[i + 2], ".") ? i + 3 : i + 1;
      const name = all[at];
      if (name?.kind !== "word") {
        referenced = null;
        break;
      }
      referenced.add(name.text);
    }
    if (referenced === null) {
      break;
    }
  }
  for (const { tokens: s, trigger } of split) {
    const word = (i: number) => (s[i]?.kind === "word" ? s[i].text : null);
    if (trigger) {
      if (word(1) !== "TRIGGER") {
        return `CREATE ${word(1) ?? ""} TRIGGER is not allowed`;
      }
      let name = isWord(s[2], "IF") && isWord(s[3], "NOT") && isWord(s[4], "EXISTS") ? 5 : 2;
      if (isPunct(s[name + 1], ".")) {
        name += 2;
      }
      if (BLOCK_WORDS.has(word(name) ?? "")) {
        return `a trigger named ${word(name)} is not allowed`;
      }
    } else if (word(0) === "ALTER") {
      const add = word(1) === "TABLE" && s[2] !== undefined && s[2].kind !== "punct" && word(3) === "ADD";
      const generated = s.some((t, i) => isWord(t, "GENERATED") || (isWord(t, "AS") && isPunct(s[i + 1], "(")));
      if (!add || generated || s.some((t) => isWord(t, "REFERENCES"))) {
        return "only ALTER TABLE ... ADD COLUMN without REFERENCES or a generated column is allowed";
      }
    } else if (word(0) === "CREATE" && word(1) === "TABLE") {
      const name = word(2);
      if (name === null || isPunct(s[3], ".") || ["IF", "TEMP", "TEMPORARY"].includes(name)) {
        return "a work table needs a plain name";
      }
      if (s.some((t) => isWord(t, "REFERENCES"))) {
        return `the work table ${name} holds a REFERENCES`;
      }
      if (referenced === null || referenced.has(name)) {
        return `the work table ${name} is named after REFERENCES`;
      }
      if (work.has(name) || dropped.has(name)) {
        return `the work table ${name} is created twice`;
      }
      work.add(name);
    } else if (word(0) === "CREATE") {
      const index = indexOf(s);
      const table = index === null ? null : word(index.on + 1);
      if (word(1) === "INDEX" || word(1) === "UNIQUE") {
        if (index === null || table === null) {
          return "an index needs a plain name and table";
        }
        if (work.has(table)) {
          workIndexes.add(index.name);
          continue;
        }
        if (word(1) === "UNIQUE") {
          return `CREATE UNIQUE INDEX on ${table}, a table the file did not create, is not allowed`;
        }
        continue;
      }
      return `CREATE ${word(1) ?? ""} is not allowed`;
    } else if (word(0) === "DROP" && word(1) === "TRIGGER") {
      continue;
    } else if (word(0) === "DROP" && word(1) === "TABLE") {
      const name = word(2);
      if (name === null || s.length !== 3 || !work.has(name)) {
        return `DROP TABLE of ${name ?? s[2]?.text ?? ""}, a table the file did not create, is not allowed`;
      }
      work.delete(name);
      dropped.add(name);
    } else if (word(0) === "DROP" && word(1) === "INDEX") {
      const name = word(2);
      if (name === null || s.length !== 3) {
        return "DROP INDEX needs a plain name";
      }
      if (workIndexes.has(name)) {
        continue;
      }
      const definition = definitions.get(name);
      const again = split.slice(split.findIndex((x) => x.tokens === s) + 1).find((x) => {
        const index = isWord(x.tokens[0], "CREATE") ? indexOf(x.tokens) : null;
        return index?.name === name;
      });
      if (
        definition === undefined ||
        definition.startsWith("CREATE UNIQUE") ||
        again === undefined ||
        again.tokens.map((t) => t.text).join(" ") !== definition
      ) {
        return `DROP INDEX ${name} is allowed only when the file creates it again as it was, and it is not UNIQUE`;
      }
    } else if (!DML.has(word(0) ?? "")) {
      return `${word(0) ?? s[0]?.text ?? ""} is not allowed`;
    }
  }
  const left = [...work];
  return left.length === 0 ? null : `the work table ${left.join(", ")} is not dropped`;
}
