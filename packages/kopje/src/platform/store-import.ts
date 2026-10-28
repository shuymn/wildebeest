import {
  hasRows,
  MAX_PROFILE_UPDATES,
  parseProfileUpdates,
  PROFILE_UPDATES,
  type ScannedRow,
  SEQUENCE_TABLE,
  STATE_TABLE,
} from "./dump-catalog";
import {
  DUMP_FORMAT,
  type DumpHeader,
  DumpParseError,
  type DumpTrailer,
  type MigrationRecord,
  type ParsedStatement,
  parseStatements,
  quoteIdentifier,
  type TableResult,
  type TableSpec,
  utf8Length,
} from "./dump-format";
import { bindAll, LiteralError, textLiteral } from "./dump-literals";
import { errorMessage } from "./error-message";

// Checks the shape of a header that came from a caller. The catalog and migrations are compared separately.
export function parseHeader(value: unknown): DumpHeader {
  const h = value as Partial<DumpHeader> | null;
  const ok =
    typeof h === "object" &&
    h !== null &&
    h.format === DUMP_FORMAT &&
    typeof h.createdAt === "string" &&
    typeof h.source === "object" &&
    h.source !== null &&
    Array.isArray(h.migrations) &&
    h.migrations.every((m) => typeof m?.name === "string" && typeof m?.checksum === "string") &&
    Array.isArray(h.tables) &&
    h.tables.every((t) => typeof t?.name === "string" && Array.isArray(t?.columns));
  if (!ok) {
    throw new ImportError("invalid-header", `not a kopje dump header of format ${DUMP_FORMAT}`);
  }
  return h as DumpHeader;
}

export function parseTrailer(value: unknown): DumpTrailer {
  const t = value as Partial<DumpTrailer> | null;
  const ok =
    typeof t === "object" &&
    t !== null &&
    Array.isArray(t.tables) &&
    t.tables.every(
      (r) => typeof r?.name === "string" && Number.isSafeInteger(r?.rows) && typeof r?.checksum === "string",
    ) &&
    typeof t.body === "object" &&
    t.body !== null &&
    Number.isSafeInteger(t.body.statements) &&
    Number.isSafeInteger(t.body.bytes) &&
    typeof t.body.sha256 === "string";
  if (!ok) {
    throw new ImportError("invalid-trailer", "not a kopje dump trailer");
  }
  return t as DumpTrailer;
}

// Expected failures of an import step. The code crosses the RPC boundary as part of the result.
export class ImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ImportError";
  }
}

function canonicalTable(t: TableSpec): string {
  return JSON.stringify([t.name, t.columns, t.order, t.key, t.deferred]);
}

// A dump may restore fewer kopje_state names than this Store does (a dump from a version before a name was added),
// never one this Store does not.
function onlyWithin(dump: TableSpec["only"], mine: TableSpec["only"]): boolean {
  if (dump === undefined || mine === undefined) {
    return dump === mine;
  }
  return dump.column === mine.column && dump.values.every((value) => mine.values.includes(value));
}

// Returns why the dump's tables differ from this Store's catalog, or null when they are the same.
export function catalogDifference(dump: readonly TableSpec[], target: readonly TableSpec[]): string | null {
  const names = (list: readonly TableSpec[]) => list.map((t) => t.name).join(",");
  if (names(dump) !== names(target)) {
    return `tables differ: dump has [${names(dump)}], this Store has [${names(target)}]`;
  }
  for (const [i, table] of dump.entries()) {
    const mine = target[i];
    if (mine === undefined || canonicalTable(table) !== canonicalTable(mine) || !onlyWithin(table.only, mine.only)) {
      return `table ${table.name} differs from this Store's definition`;
    }
  }
  return null;
}

export function migrationDifference(
  dump: readonly MigrationRecord[],
  applied: readonly MigrationRecord[],
): string | null {
  const text = (list: readonly MigrationRecord[]) => list.map((m) => `${m.name}:${m.checksum}`).join(",");
  return text(dump) === text(applied)
    ? null
    : `dump migrations [${dump.map((m) => m.name).join(",")}] differ from this Store's [${applied.map((m) => m.name).join(",")}]`;
}

// Rows that are configuration of this Store rather than data: they do not make it non-empty.
export type Bootstrap = { table: string; column: string; values: readonly string[] };

// A Store with no rows in any dumped table (kopje_state counts only its dumped names, bootstrap rows not at all).
export function isEmpty(sql: SqlStorage, tables: readonly TableSpec[], bootstrap?: Bootstrap): boolean {
  return tables.every((t) => !hasRows(sql, t, bootstrap?.table === t.name ? bootstrap : undefined));
}

// Link statements are not applied with their chunk. A link changes the size of its row's record, and SQLite rewrites
// such a record whole, overflow pages included: its cost follows the size of the row it points at, not the bytes of
// the statement, so a chunk of short links can rewrite many times its own size. A link is checked against its target
// row and staged in kopje_state under LINK_PREFIX and its statement ordinal (never dumped: not an allowlisted name);
// applyStagedLinks applies the staged links in steps bounded by the bytes they rewrite.
const LINK_PREFIX = "import_link:";
const LINK_RANGE = `name >= '${LINK_PREFIX}' AND name < 'import_link;'`;
// A link carries only key values (its deferred columns reference primary keys), so a longer one is refused with its
// chunk; this bounds what a step holds in memory per link.
export const MAX_LINK_STATEMENT_BYTES = 64 * 1024;

// Executes validated statements. parseStatements matched each against a template of this Store's catalog; the
// literals are then bound as parameters (bindLiteral), which keeps the statement text short whatever the value size
// (the platform limits a statement to 100 KB) and keeps every storage class exact. `first` is the ordinal of the
// first statement in the body, which names the staged links in body order.
export function applyStatements(sql: SqlStorage, statements: readonly ParsedStatement[], first: number): void {
  const columnLists = new Map<string, string>();
  for (const [index, statement] of statements.entries()) {
    const table = quoteIdentifier(statement.table.name);
    const bound = bind(statement.literals);
    if (statement.kind === "link") {
      if (utf8Length(statement.text) > MAX_LINK_STATEMENT_BYTES) {
        throw new ImportError("link-too-large", `a link may hold at most ${MAX_LINK_STATEMENT_BYTES} bytes`);
      }
      const key = bind(statement.literals.slice(statement.table.deferred.length));
      const exists = sql.exec(`SELECT 1 FROM ${table} WHERE ${keyMatch(statement.table, key.exprs)}`, ...key.params);
      if (exists.toArray().length === 0) {
        throw new ImportError("link-target-missing", `link to a missing ${statement.table.name} row`);
      }
      sql.exec(
        "INSERT INTO kopje_state (name, value) VALUES (?, ?)",
        `${LINK_PREFIX}${String(first + index).padStart(16, "0")}`,
        statement.text,
      );
      continue;
    }
    const name = statement.literals[0] ?? "";
    if (statement.table.name === STATE_TABLE) {
      // The names the dump's header declares, which catalogDifference checked against this Store's.
      if (!(statement.table.only?.values ?? []).some((allowed) => textLiteral(allowed) === name)) {
        throw new ImportError("state-not-allowed", `kopje_state ${name} is not restorable`);
      }
      if (name === textLiteral(PROFILE_UPDATES) && parseProfileUpdates(bound.params[1]) === null) {
        throw new ImportError(
          "state-invalid",
          `kopje_state ${PROFILE_UPDATES} is not a list of at most ${MAX_PROFILE_UPDATES} distinct account ids`,
        );
      }
    }
    if (statement.table.name === SEQUENCE_TABLE) {
      // AUTOINCREMENT inserts above created their own counter rows; the dumped value replaces them.
      const nameBound = bindAll([name]);
      sql.exec(`DELETE FROM ${table} WHERE name = ${nameBound.exprs[0]}`, ...nameBound.params);
    }
    let columns = columnLists.get(statement.table.name);
    if (columns === undefined) {
      columns = statement.table.columns.map(quoteIdentifier).join(",");
      columnLists.set(statement.table.name, columns);
    }
    sql.exec(`INSERT INTO ${table} (${columns}) VALUES (${bound.exprs.join(",")})`, ...bound.params);
  }
}

// A boost of a boost (a status whose reblog_of_id names a status that has one) is refused at verification: no Kopje
// writer starts such a chain (an inbound Announce and a conversion boost originals only), and a status deletion or a
// purge that meets one cannot remove it, so its job parks (RES-6). Checked on each statuses row the checksum scan
// reads (store-dump.ts checksumStep), once every staged link is applied, so in either link order: one seek of the
// named status by its key per boost the call scans, so the candidates a call examines are bounded by its scan.
export class BoostChainCheck {
  constructor(private readonly sql: SqlStorage) {}

  readonly check = (spec: TableSpec, row: ScannedRow): string | null => {
    const at = spec.name === "statuses" ? spec.columns.indexOf("reblog_of_id") : -1;
    const literal = at === -1 ? undefined : row.literals[at];
    if (literal === undefined || literal === "NULL") {
      return null;
    }
    const bound = bind([literal]);
    const chained = this.sql
      .exec(`SELECT 1 AS x FROM statuses WHERE id = ${bound.exprs[0]} AND reblog_of_id IS NOT NULL`, ...bound.params)
      .toArray();
    return chained.length === 0
      ? null
      : "statuses: a boost of a boost (reblog_of_id names a status that is itself a boost); Kopje stores no boost of a boost, so this dump cannot be restored";
  };
}

export function hasStagedLinks(sql: SqlStorage): boolean {
  return (
    sql.exec<{ found: number }>(`SELECT EXISTS (SELECT 1 FROM kopje_state WHERE ${LINK_RANGE}) AS found`).one()
      .found === 1
  );
}

// Applies staged links in body order, at most maxLinks, and stops once the rows they rewrote reach maxBytes (one link
// always goes in, so a single large row still makes progress). Links are read one at a time, so a step holds one
// staged link in memory whatever the budget. Returns whether staged links remain.
export function applyStagedLinks(
  sql: SqlStorage,
  tables: readonly TableSpec[],
  maxBytes: number,
  maxLinks: number,
): boolean {
  let rewritten = 0;
  let last: string | null = null;
  for (let applied = 0; applied < maxLinks && rewritten < maxBytes; applied++) {
    const next = nextStagedLink(sql, last);
    if (next === null) {
      break;
    }
    const { name, value } = next;
    let statement;
    try {
      statement = parseStatements(`${value}\n`, tables)[0];
    } catch (error) {
      throw new ImportError("invalid-chunk", error instanceof DumpParseError ? error.message : "invalid staged link");
    }
    if (statement?.kind !== "link") {
      throw new ImportError("invalid-chunk", "a staged link is not a link statement");
    }
    const { deferred } = statement.table;
    const bound = bind(statement.literals);
    const table = quoteIdentifier(statement.table.name);
    const set = deferred.map((c, i) => `${quoteIdentifier(c)} = ${bound.exprs[i]}`).join(", ");
    const match = keyMatch(statement.table, bound.exprs.slice(deferred.length));
    let rows;
    try {
      const update = `UPDATE ${table} SET ${set} WHERE ${match} RETURNING ${rowBytes(statement.table)} AS size`;
      rows = sql.exec<{ size: number }>(update, ...bound.params).toArray();
    } catch (error) {
      // A constraint the value breaks (a dangling reference, a CHECK): the import cannot complete.
      throw new ImportError("link-failed", `a ${statement.table.name} link failed: ${errorMessage(error)}`);
    }
    if (rows.length === 0) {
      throw new ImportError("link-target-missing", `link to a missing ${statement.table.name} row`);
    }
    rewritten += rows[0]?.size ?? 0;
    last = name;
  }
  if (last !== null) {
    sql.exec(`DELETE FROM kopje_state WHERE ${LINK_RANGE} AND name <= ?`, last);
  }
  return hasStagedLinks(sql);
}

function nextStagedLink(sql: SqlStorage, after: string | null): { name: string; value: string } | null {
  const query = `SELECT name, value FROM kopje_state WHERE ${LINK_RANGE} AND name > ? ORDER BY name LIMIT 1`;
  return sql.exec<{ name: string; value: string }>(query, after ?? "").toArray()[0] ?? null;
}

// Removes up to `limit` staged links (a reset). Returns how many were removed.
export function dropStagedLinks(sql: SqlStorage, limit: number): number {
  return sql.exec(
    `DELETE FROM kopje_state WHERE name IN (SELECT name FROM kopje_state WHERE ${LINK_RANGE} ORDER BY name LIMIT ?)`,
    limit,
  ).rowsWritten;
}

function bind(literals: readonly string[]): { exprs: string[]; params: SqlStorageValue[] } {
  try {
    return bindAll(literals);
  } catch (error) {
    throw new ImportError("invalid-chunk", error instanceof LiteralError ? error.message : "invalid literal");
  }
}

// The stored bytes of a row, as an SQL expression: what rewriting it costs.
export function rowBytes(spec: TableSpec): string {
  return spec.columns.map((c) => `coalesce(octet_length(${quoteIdentifier(c)}), 0)`).join(" + ");
}

function keyMatch(spec: TableSpec, exprs: readonly string[]): string {
  return spec.key.map((c, i) => `${quoteIdentifier(c)} = ${exprs[i]}`).join(" AND ");
}

export type VerifyReport = {
  ok: boolean;
  tables: {
    name: string;
    rows: number;
    expectedRows: number;
    checksum: string;
    expectedChecksum: string;
    ok: boolean;
  }[];
  foreignKeyViolations: number;
  problems: string[];
};

export function compareResults(
  computed: readonly TableResult[],
  trailer: DumpTrailer,
  foreignKeyViolations: number,
): VerifyReport {
  const problems: string[] = [];
  const expected = new Map(trailer.tables.map((t) => [t.name, t]));
  const tables = computed.map((c) => {
    const want = expected.get(c.name);
    const ok = want !== undefined && want.rows === c.rows && want.checksum === c.checksum;
    if (want === undefined) {
      problems.push(`${c.name} is missing from the trailer`);
    } else if (!ok) {
      const checksum = want.checksum === c.checksum ? "matches" : "differs";
      problems.push(`${c.name}: ${c.rows} rows (expected ${want.rows}), checksum ${checksum}`);
    }
    return {
      name: c.name,
      rows: c.rows,
      expectedRows: want?.rows ?? -1,
      checksum: c.checksum,
      expectedChecksum: want?.checksum ?? "",
      ok,
    };
  });
  for (const name of expected.keys()) {
    if (!computed.some((c) => c.name === name)) {
      problems.push(`${name} is in the trailer but not in this Store`);
    }
  }
  if (foreignKeyViolations > 0) {
    problems.push(`foreign_key_check reported ${foreignKeyViolations} violation(s)`);
  }
  return { ok: problems.length === 0, tables, foreignKeyViolations, problems };
}
