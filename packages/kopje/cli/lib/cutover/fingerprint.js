// `kopje-admin fingerprint`: the check that the legacy D1 stopped changing, on top of the write barrier of the cutover
// (docs/cutover-runbook.md, step 5). It compares two exports of the database taken some time apart; equal fingerprints
// say that nothing in the database changed between them, and the second export is the one converted.
//
// A fingerprint is computed from an export, offline, by the converter's own strict reader (sql-script.js; nothing in
// the export runs). Every row is hashed whole, with its table, every column name and every value exactly as exported
// (its type included), so a row's identity (its key) is bound to all of its values: a change of any value, a value
// moved between rows, a row added or removed all change it. A table's fingerprint is the SHA-256 of its rows' hashes
// in sorted order, so it does not depend on the order of the export. sqlite_sequence is a table like any other, which
// pins the notification counter (actor_notifications) the converter carries over.
//
// The output holds table names, row counts and digests only (DATA-16). Computing the same hash on D1 with SQL is not
// practical: D1 has no hash function, and a hash over whole values in SQL runs at about 1 MB/s for 2 KB rows and 0.3
// MB/s for 8 KB rows on a workstation (node:sqlite, a recursive CTE over the characters), growing with the square of
// the row size, far past D1's query time limit for a real database.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { checkSizes, exportFiles } from "./export-files.js";
import {
  decodeBudget,
  ExportError,
  exportOrder,
  isPlatformTable,
  parseStatement,
  splitStatements,
} from "./sql-script.js";

export const FINGERPRINT_FORMAT = "kopje-fingerprint/2";
const SEQUENCE_TABLE = "sqlite_sequence";
const NOTIFICATIONS = "actor_notifications";

// The table list of the export loop: every table but internal ones (sqlite_*, D1's _cf_* and d1_kv), virtual tables
// (the full-text index) and their shadow tables. sqlite_sequence is exported on its own (the runbook names it).
export const TABLES_SQL = [
  "SELECT m.name AS name FROM sqlite_schema AS m",
  "WHERE m.type = 'table'",
  "AND substr(m.name, 1, 7) <> 'sqlite_' AND substr(m.name, 1, 4) <> '_cf_' AND m.name <> 'd1_kv'",
  "AND m.sql NOT LIKE 'CREATE VIRTUAL TABLE%'",
  "AND NOT EXISTS (SELECT 1 FROM sqlite_schema AS v WHERE v.type = 'table' AND v.sql LIKE 'CREATE VIRTUAL TABLE%'",
  "AND substr(m.name, 1, length(v.name) + 1) = v.name || '_')",
  "ORDER BY m.name",
].join(" ");

// For a D1 whose sqlite_sequence cannot be exported with --table: its rows, to be turned into the export file by
// `fingerprint sequence-file`.
export const SEQUENCE_SQL = "SELECT name, seq FROM sqlite_sequence ORDER BY name";

export class FingerprintError extends Error {
  /**
   * @param {string} code
   * @param {Record<string, unknown>} [detail]
   */
  constructor(code, detail = {}) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

/** @param {unknown} value */
function typed(value) {
  if (value === null) {
    return ["null"];
  }
  if (typeof value === "bigint") {
    return ["integer", value.toString()];
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? ["integer", String(value)] : ["real", String(value)];
  }
  if (typeof value === "string") {
    return ["text", value];
  }
  if (value instanceof Uint8Array) {
    return ["blob", Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("")];
  }
  throw new FingerprintError("invalid-value");
}

/**
 * @typedef {{ format: string, tables: Record<string, { rows: number, sha256: string }>,
 *   notificationSequence: string | null }} Fingerprint
 */

/**
 * The fingerprint of an export: a directory of `wrangler d1 export --table` files, or one file of them.
 * @param {string} exportPath
 * @returns {Fingerprint}
 */
export function fingerprintExport(exportPath) {
  const files = exportFiles(exportPath);
  checkSizes(files);
  /** @type {Map<string, string[]>} */
  const hashes = new Map();
  /** @type {string | null} */
  let notificationSequence = null;
  const budget = decodeBudget();
  const order = exportOrder();
  for (const file of files) {
    for (const statement of splitStatements(readFileSync(file, "utf8"))) {
      const parsed = parseStatement(statement, budget);
      order(parsed);
      if ((parsed.kind === "create-table" || parsed.kind === "insert") && isPlatformTable(parsed.table)) {
        continue;
      }
      // The reset D1 writes before the counter rows says that sqlite_sequence was exported, as its CREATE would.
      if (parsed.kind === "create-table" || parsed.kind === "sequence-reset") {
        const table = parsed.kind === "create-table" ? parsed.table : SEQUENCE_TABLE;
        hashes.set(table, hashes.get(table) ?? []);
        continue;
      }
      if (parsed.kind !== "insert") {
        continue;
      }
      const list = hashes.get(parsed.table) ?? [];
      hashes.set(parsed.table, list);
      for (const row of parsed.rows) {
        const columns = parsed.columns ?? row.map((_, i) => `#${i}`);
        if (columns.length !== row.length) {
          throw new FingerprintError("invalid-row");
        }
        const cells = columns
          .map((column, i) => /** @type {[string, string[]]} */ ([column, typed(row[i])]))
          .toSorted((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
        list.push(
          createHash("sha256")
            .update(JSON.stringify([parsed.table, cells]))
            .digest("hex"),
        );
        if (parsed.table === SEQUENCE_TABLE) {
          const name = row[columns.indexOf("name")];
          const seq = row[columns.indexOf("seq")];
          if (name === NOTIFICATIONS && (typeof seq === "bigint" || typeof seq === "number")) {
            notificationSequence = BigInt(seq).toString();
          }
        }
      }
    }
  }
  // actor_notifications is AUTOINCREMENT: once it has had a row, sqlite_sequence holds its high-water mark, which the
  // converter must carry over, even after every notification was deleted. So an export with the notifications table
  // must carry sqlite_sequence itself: its rows, or its file (sqlite_sequence.sql, empty when nothing was ever
  // allocated). Without it, "never allocated" and "counter omitted" cannot be told apart.
  const sequenceExported = hashes.has(SEQUENCE_TABLE) || files.some((file) => basename(file) === "sqlite_sequence.sql");
  const notifications = hashes.get(NOTIFICATIONS);
  if (notifications !== undefined && !sequenceExported) {
    throw new FingerprintError("sequence-missing", { table: SEQUENCE_TABLE });
  }
  if (notifications !== undefined && notifications.length > 0 && notificationSequence === null) {
    throw new FingerprintError("sequence-missing", { table: NOTIFICATIONS });
  }
  if (sequenceExported && !hashes.has(SEQUENCE_TABLE)) {
    hashes.set(SEQUENCE_TABLE, []);
  }
  /** @type {Fingerprint['tables']} */
  const tables = {};
  for (const name of [...hashes.keys()].toSorted()) {
    const rows = /** @type {string[]} */ (hashes.get(name)).toSorted();
    tables[name] = { rows: rows.length, sha256: createHash("sha256").update(rows.join("\n")).digest("hex") };
  }
  return { format: FINGERPRINT_FORMAT, tables, notificationSequence };
}

/**
 * @param {unknown} value
 * @returns {Fingerprint}
 */
export function parseFingerprint(value) {
  const v = /** @type {Record<string, unknown>} */ (value);
  if (typeof v !== "object" || v === null || v.format !== FINGERPRINT_FORMAT) {
    throw new FingerprintError("not-a-fingerprint");
  }
  const tables = /** @type {Record<string, unknown>} */ (v.tables);
  if (typeof tables !== "object" || tables === null) {
    throw new FingerprintError("not-a-fingerprint");
  }
  for (const entry of Object.values(tables)) {
    const e = /** @type {Record<string, unknown>} */ (entry);
    if (
      typeof e !== "object" ||
      e === null ||
      !Number.isSafeInteger(e.rows) ||
      typeof e.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(e.sha256)
    ) {
      throw new FingerprintError("not-a-fingerprint");
    }
  }
  if (v.notificationSequence !== null && typeof v.notificationSequence !== "string") {
    throw new FingerprintError("not-a-fingerprint");
  }
  return /** @type {Fingerprint} */ (value);
}

/**
 * The converter's manifest, checked to be a complete conversion record: a converted run with a count for every
 * exported table.
 * @param {unknown} value
 * @returns {{ rowsLoaded: Record<string, number>, notificationSequence: string | null }}
 */
export function parseManifest(value) {
  const m = /** @type {Record<string, any>} */ (value);
  const tool = m?.tool;
  const source = m?.source;
  const rowsLoaded = source?.rowsLoaded;
  if (
    typeof m !== "object" ||
    m === null ||
    tool?.command !== "kopje-admin convert" ||
    m.result !== "converted" ||
    typeof rowsLoaded !== "object" ||
    rowsLoaded === null ||
    Array.isArray(rowsLoaded) ||
    Object.keys(rowsLoaded).length === 0 ||
    !Object.values(rowsLoaded).every((n) => Number.isSafeInteger(n) && n >= 0) ||
    (source.notificationSequence !== null && typeof source.notificationSequence !== "string")
  ) {
    throw new FingerprintError("not-a-conversion-manifest");
  }
  return { rowsLoaded, notificationSequence: source.notificationSequence };
}

// Tables the converter's count map does not cover: its own bookkeeping.
const UNCOUNTED = new Set([SEQUENCE_TABLE, "d1_migrations"]);

/**
 * PASS only when both fingerprints hold the same tables with the same rows. With a manifest, the export it converted
 * must also have exactly the fingerprinted tables and row counts, and the same notification high-water mark.
 * @param {Fingerprint} first
 * @param {Fingerprint} second
 * @param {{ rowsLoaded: Record<string, number>, notificationSequence: string | null }} [manifest]
 */
export function compareFingerprints(first, second, manifest) {
  /** @type {string[]} */
  const changed = [];
  for (const name of new Set([...Object.keys(first.tables), ...Object.keys(second.tables)])) {
    const a = first.tables[name];
    const b = second.tables[name];
    if (a === undefined || b === undefined || a.rows !== b.rows || a.sha256 !== b.sha256) {
      changed.push(name);
    }
  }
  /** @type {string[]} */
  const exportDiffers = [];
  if (manifest !== undefined) {
    // The exact key set, by membership: the manifest lists exactly the export's counted tables (bookkeeping tables
    // are left out of the export's side only, so a manifest that lists one differs), and then each count matches.
    const expected = new Set(Object.keys(second.tables).filter((name) => !UNCOUNTED.has(name)));
    const listed = new Set(Object.keys(manifest.rowsLoaded));
    for (const name of listed) {
      if (!expected.has(name)) {
        exportDiffers.push(name);
      }
    }
    for (const name of expected) {
      if (!listed.has(name) || second.tables[name]?.rows !== manifest.rowsLoaded[name]) {
        exportDiffers.push(name);
      }
    }
    if (manifest.notificationSequence !== second.notificationSequence) {
      exportDiffers.push(SEQUENCE_TABLE);
    }
  }
  const tables = Object.values(second.tables);
  return {
    result: changed.length === 0 && exportDiffers.length === 0 ? "PASS" : "FAIL",
    tables: tables.length,
    rows: tables.reduce((sum, t) => sum + t.rows, 0),
    changed: changed.toSorted(),
    ...(manifest === undefined ? {} : { exportDiffers: exportDiffers.toSorted() }),
  };
}

/**
 * The sqlite_sequence export file from the answer of SEQUENCE_SQL (`wrangler d1 execute --json`), for a D1 whose
 * sqlite_sequence cannot be exported with --table. Only names and integers are accepted.
 * @param {unknown} value
 */
export function sequenceFile(value) {
  const answer = Array.isArray(value) && value.length === 1 ? /** @type {Record<string, unknown>} */ (value[0]) : null;
  const rows = answer?.results;
  if (!Array.isArray(rows)) {
    throw new FingerprintError("not-a-result");
  }
  const lines = rows.map((row) => {
    const { name, seq } = /** @type {Record<string, unknown>} */ (row);
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !Number.isSafeInteger(seq)) {
      throw new FingerprintError("invalid-sequence-row");
    }
    return `INSERT INTO "sqlite_sequence" ("name","seq") VALUES('${name}',${String(seq)});`;
  });
  return `${lines.join("\n")}\n`;
}

export { ExportError };
