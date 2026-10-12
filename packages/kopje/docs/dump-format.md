# Kopje Store dump format, version 1

One format serves the scheduled backup, the cutover import from legacy Wildebeest, and restore drills. A dump is a
UTF-8 text file that is also a valid SQLite script for a database that already has the Kopje schema.
`src/platform/dump-format.ts` (Store) and `cli/lib/format.js` (CLI) implement it.

## Layout

```
-- kopje-dump-header {header JSON}\n
<statement>\n
<statement>\n
...
-- kopje-dump-trailer {trailer JSON}\n
-- kopje-dump-end\n
```

- Line 1 is the header. The JSON is on one line.
- The body is a sequence of statements. Each statement ends with `;\n`. A string literal can contain raw newlines and
  `;`, so split statements only at `;\n` outside a quoted literal. Inside a literal, quotes are doubled, so toggling
  on every `'` byte tracks literal boundaries.
- The trailer line comes next, then the literal line `-- kopje-dump-end`. A file without the end line is truncated
  and must be rejected.
- Nothing else is allowed: no blank lines, comments, whitespace variants or transaction statements.

## Header

```json
{
  "format": 1,
  "createdAt": "2026-10-12T00:00:00.000Z",
  "source": { "build": "<workers version id>", "version": "<package version>" },
  "migrations": [{ "name": "0000_initial", "checksum": "<sha256 hex of the migration file>" }],
  "tables": [
    {
      "name": "statuses",
      "columns": ["id", "uri", "..."],
      "order": { "by": "rowid" },
      "key": ["id"],
      "deferred": ["reblog_of_id", "in_reply_to_id"]
    },
    { "name": "kopje_state", "columns": ["name", "value"], "order": { "by": "key", "columns": ["name"] },
      "key": ["name"], "deferred": [], "only": { "column": "name", "values": ["last_local_id"] } }
  ]
}
```

- `migrations` must equal the target Store's applied migrations: same names and checksums, in the same order.
- `tables` must equal the target Store's catalog exactly. The cutover tool should not derive it. It should fetch it
  from the empty target with `GET /admin/catalog` (or `kopje-admin catalog`) and copy `migrations` and `tables`
  from there.
- The catalog is read from the live schema:
  - All tables are included except `kopje_migrations`, `_cf_*`, and `sqlite_*` other than `sqlite_sequence`.
  - Columns are in declaration order.
  - `key` is the primary key.
  - `order` is `rowid` for rowid tables, and `key` (with the primary key columns) for WITHOUT ROWID tables and
    `sqlite_sequence` (by `name`).
- Table order puts parents before children; names break ties. `sqlite_sequence` is always last.
- `deferred` lists the foreign key columns that point to the same table, or to a later table in a cycle.

## Statements

Two templates exist. Each `<lit>` is a literal, and identifiers are double-quoted.

Row:

```
INSERT INTO "<table>" ("<c1>","<c2>",...,"<cN>") VALUES (<lit>,<lit>,...,<lit>);
```

- The statement lists every column of the table, in header order.
- Columns in `deferred` are written as `NULL`.

Link (only for tables with `deferred` columns):

```
UPDATE "<table>" SET "<d1>"=<lit>,"<d2>"=<lit> WHERE "<k1>"=<lit> AND "<k2>"=<lit>;
```

- The SET list has every deferred column, in header column order. The WHERE clause has every key column.
- The importer refuses a link that matches no row.

Literals follow SQLite's `quote()` output exactly:

| Value | Literal |
|---|---|
| NULL | `NULL` |
| INTEGER | `-?[0-9]+` (exact 64-bit) |
| REAL | `quote()` form, e.g. `1.0`, `0.1`, `1.5e+300`, `9.0e+999` (Infinity) |
| TEXT | `'...'` with `'` doubled. IDs are TEXT, e.g. `'110000000000000001'` |
| TEXT containing NUL | `CAST(X'<hex>' AS TEXT)`. `quote()` would truncate it at the NUL |
| BLOB | `X'<hex>'` (uppercase from the Store; either case is accepted) |

The importer executes the validated statement text as-is, so SQLite parses the literal and the storage class is
kept exactly. A JS number would bind as REAL.

### Body order

1. Rows, table by table in header order. Within a table, rows follow the table's `order`:
   - `rowid`: ascending rowid. For an INTEGER PRIMARY KEY table that is the key. Otherwise it is insertion order,
     so the file order becomes the rowid order of the target.
   - `key`: ascending by the key columns (BINARY collation, row-value comparison).
2. Links, for each table with deferred columns in header order, for every row where a deferred column is not NULL.
   They are ordered like the rows.

`sqlite_sequence` rows (`INSERT INTO "sqlite_sequence" ("name","seq") VALUES ('notifications',9);`) replace the
counter for that name. They come last, after the AUTOINCREMENT inserts that created counters of their own.

### What is not in a dump

These are excluded because they must not be restored blindly:

| Excluded | Why |
|---|---|
| `kopje_migrations` | The header carries it. The target's own migration runner recreates it |
| `kopje_state` except `last_local_id` | `hold`, `upgrade` and `upgrade_bookmark` (a bookmark belongs to the source object), `maintenance`, `dump` and `import` describe one object at one time |
| `_cf_*`, `sqlite_*` (except `sqlite_sequence`) | Platform and SQLite internals |

The importer refuses a `kopje_state` row whose name is not allowlisted.

## Trailer

```json
{
  "tables": [{ "name": "accounts", "rows": 2, "checksum": "<sha256 hex>" }],
  "body": { "statements": 18, "bytes": 4252, "sha256": "<sha256 hex of the body bytes>" }
}
```

- `tables` lists every header table, in header order.
- `rows` counts the table's rows. For `kopje_state`, it counts only the allowlisted rows.
- `checksum` is SHA-256 over, for each row in the table's order, the row's literals for all columns (deferred
  columns with their real value, not `NULL`) joined by `,`, followed by `\n`. An empty table has the checksum of
  empty input, `e3b0c442...b855`.
- `body` covers the statement lines exactly: all bytes between the header line and the trailer line.

## Producing a file for import (cutover)

1. Read the catalog from the empty target: `GET /admin/catalog`.
2. Build the converted data in a local SQLite database created from the same migrations. Use the target's catalog
   order for tables, columns and rows.
3. Write each value with SQLite's `quote()`, replacing TEXT that contains NUL with the CAST form.
4. Compute each table checksum from the same literals.

Use a SQLite whose `quote()` writes REAL values so they round-trip exactly; current releases do. Schema 0000 has no
REAL columns, so for now only INTEGER, TEXT, BLOB and NULL occur.

## Import protocol

All of these are `POST` under `/admin/import` with JSON, except `chunk`:

| Step | Request | Effect |
|---|---|---|
| begin | `{ "header": {...} }` | Checks migrations, catalog and emptiness, then records an import. With the same header it resumes the existing import |
| chunk | `?id=<id>&seq=<n>`, raw body of whole statements (≤ 16 MiB) | Validates every statement against the templates. Applies the chunk and the progress record in one `transactionSync` |
| finish | `{ "id", "trailer" }` | Checks the trailer's tables, statement count, byte count and body SHA-256 against what was received |
| verify | `{ "id" }`, repeated until `done` | Recomputes row counts and checksums in the Store, then runs `PRAGMA foreign_key_check`. On success it removes the import record, and the Store serves again |
| reset | `{ "confirm": true }` | Runs `deleteAll()`, which drops the schema too, then the migration runner. Allowed only under import or for a Store without data |

- Chunk numbers start at 1. The progress record holds `lastSeq` and a chain digest:
  `digest_n = hex(sha256(digest_{n-1} || chunk_n))`, with `digest_0` = the empty string.
- After any error, read `GET /admin/import/progress` and compare `lastSeq` and `digest`. Do not assume a rollback:
  a timed-out transaction can still be durable.
- A resent chunk with `seq ≤ lastSeq` is reported as `duplicate` and is not applied again.
- While an import record exists, every domain operation is refused. A failed verification needs `reset` and a new
  import.
- `IMPORT_TOKEN` (header `Kopje-Import-Token`, at least 32 characters) authorizes these endpoints in two cases:
  - while the Store is empty and has no Access settings;
  - for the rest of an import begun with the token.
