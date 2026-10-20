# Kopje Store dump format, version 1

One format serves the scheduled backup ([backup.md](backup.md)), the cutover import from legacy Wildebeest, and
restore drills. A dump is a UTF-8 text file that is also a valid SQLite script for a database that already has the
Kopje schema.
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
		{
			"name": "kopje_state",
			"columns": ["name", "value"],
			"order": { "by": "key", "columns": ["name"] },
			"key": ["name"],
			"deferred": [],
			"only": { "column": "name", "values": ["last_local_id", "profile_updates"] }
		}
	]
}
```

- `migrations` must equal the target Store's applied migrations: same names and checksums, in the same order.
- `tables` must equal the target Store's catalog exactly, except that the `kopje_state` names in `only` may be a
  subset of the target's (a dump written before a name became restorable); the importer then accepts only the names
  the dump lists. The cutover tool should not derive it. It should fetch it from the empty target with
  `GET /admin/catalog` (or `kopje-admin catalog`) and copy `migrations` and `tables` from there.
- The catalog is read from the live schema:
    - All tables are included except `kopje_migrations`, `media_orphans`, `backup_media`, `stream_*`, `_cf_*`, and
      `sqlite_*` other than `sqlite_sequence`.
      The moderation log (`admin_actions`, migration `0029_admin_reports`) is included like any other table: a
      restored Store keeps who did what, and its ids, so the log keeps pruning its oldest rows.
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

Each stored value has exactly one canonical literal. The encoding is one-to-one with the stored storage class and
bytes, so the table checksums (below) cover the exact data:

| Value                                   | Literal                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NULL                                    | `NULL`                                                                                                                                                                                                                                                                                                                    |
| INTEGER                                 | `-?[0-9]+`, exact 64-bit                                                                                                                                                                                                                                                                                                  |
| REAL                                    | ECMAScript `Number#toString` of the double (shortest round-trip), with `.0` appended when it has neither `.` nor `e`: `1.0`, `0.1`, `1.2345678901234567`, `1e+300`, `5e-324`. Special values: `-0.0`, `9e999` (+Infinity), `-9e999` (-Infinity). A REAL is written as REAL in any column, including INTEGER-affinity ones |
| TEXT that is valid UTF-8 and has no NUL | `'...'` with `'` doubled. IDs are TEXT, e.g. `'110000000000000001'`                                                                                                                                                                                                                                                       |
| any other TEXT                          | `CAST(X'<HEX of the exact stored bytes>' AS TEXT)`                                                                                                                                                                                                                                                                        |
| BLOB                                    | `X'<HEX>'` (uppercase from the Store; either case is accepted)                                                                                                                                                                                                                                                            |

The literals are not SQLite's `quote()` output. `quote()` truncates TEXT at NUL, spells REAL differently across
SQLite versions, and expands BLOBs inside SQLite past its 2 MB value limit. The Store reads each value's exact bytes
(`CAST(v AS BLOB)` for TEXT, `CAST(v AS TEXT)` for INTEGER) and encodes it itself.

The importer validates each statement against its template, then binds every literal as a parameter instead of
executing the text, so a row of any size stays under the platform's 100 KB statement limit:

- INTEGER binds as `CAST(? AS INTEGER)` from its decimal text, which keeps it exact;
- REAL binds as a number;
- TEXT and BLOB bind as their bytes, with `CAST(? AS TEXT)` for the CAST form.

### Stored bounds

A remote favourite's Like ids are rows of `favourite_likes` (migration `0052_favourite_likes`): the ids of the
actor's Likes whose Undo has not arrived, each with the time the Store received it (`received_at`, ms since the
epoch), at most 4 per favourite, each id once in the file and within 4,096 JSON-escaped UTF-8 bytes. `favourites.uri`
is used for interaction matching only for a local favourite (its own Like id) and for a remote favourite's retained
id (the one a row stored before that migration kept, outstanding until its Undo, which counts among the 4); dumps carry
it verbatim, and no length bound applies to it. A remote favourite with neither a retained URI nor tracked ids is
legacy; an Undo naming its status removes it. A chunk holding more than four outstanding ids for one favourite,
including a retained URI, fails with `favourite_likes: more than 4 Like ids for one favourite`, a repeated id with
`UNIQUE constraint failed: favourite_likes.uri`, and a longer one with `like_id_within_4096_json_bytes`.

The custom emoji an object tagged are `statuses.emojis`, `status_edits.emojis` and `accounts.emojis` (migration
`0053_custom_emoji_snapshots`): NULL for none, or a JSON array of 1 to 64 `[shortcode, url]` pairs in tag order. A
shortcode is 1 to 128 ASCII characters of `A-Z a-z 0-9 _ + -`, each once in the array; a url is `http://` or
`https://`, at most 512 bytes, of the characters `!` to `~` but `"` and `\`. The text is at most 12,288 UTF-8 bytes
(6,144 for an account), and so are its entities as presented: a nonempty presented array occupies
`1 + Σ(67 + n + 2u)` bytes, where n is the shortcode length and u the URL length. No NUL may appear anywhere in the
text; `[]` is refused, write NULL. A boost row's value is never read. A file built from legacy data writes NULL
(legacy has no custom emoji, and `verify-conversion` fails on any other value). A chunk holding any other value fails
with `<table>: emojis past their stored bound`.

A local custom emoji is a row of `custom_emojis` (migration `0055_local_custom_emojis`) whose `id` is its image's
`media_attachments` id (an 18-digit snowflake). Its image must be a kept, complete local upload: of a local account,
`type` `image`, with a file token, `processed` 1, a non-empty `url`, no `status_id`, `scheduled_status_id` or `gc_at`,
`content_type` `image/png` or `image/webp`, and a `meta` whose `original.width` and `original.height` are JSON
integers from 1 to 1024 (the recorded size of the served image; the actual files are checked by `kopje-admin
media-rebuild`, which a restore runs). A `shortcode` is 2 to 128 ASCII characters of `A-Z a-z 0-9 _`, one per enabled
emoji; `category` is NULL or 1 to 256 bytes with no NUL, no C0 control and no DEL, and at most 64 SQLite characters (a
stored-bytes bound: a value that is not well-formed UTF-8 is judged again as decoded when it is presented, and left
out if it does not pass); `visible_in_picker` and `disabled` are 0 or 1; `created_at` is
`YYYY-MM-DDTHH:MM:SS.sssZ` with an hour of 00 to 23. At most 1,000 rows have `disabled` 0. The table comes after `media_attachments`. A chunk
past these fails with the CHECK's name (`custom_emoji_id_is_a_snowflake`, `custom_emoji_shortcode_2_to_128_ascii`,
`custom_emoji_category_within_256_bytes`, `custom_emoji_flags`, `custom_emoji_created_at_iso`), `custom_emojis: the
image is not a kept local upload within the emoji limits`, `custom_emojis: more than 1000 enabled` or `UNIQUE
constraint failed: custom_emojis.shortcode`. A file built from legacy data has no row (`verify-conversion` fails on
any).

A report (migration `0054_remote_reports`) names any account as its reporter (`account_id`), once per `uri` and
reported account, with `status_ids` of at most 100 ids within 2,101 UTF-8 bytes (compact JSON of 18-digit ids), a
`uri` within 4,096 JSON-escaped UTF-8 bytes and a `comment` within 20,000 UTF-8 bytes (and 5,000 code points up to any
NUL). A chunk past these fails with `report_status_ids_within_100_ids_and_2101_bytes`,
`report_uri_within_4096_json_bytes`, `report_comment_within_20000_bytes` or
`UNIQUE constraint failed: reports.uri, reports.target_account_id`. `sqlite_sequence` carries the report id counter,
so a restored Store never gives a report id twice.

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

| Excluded                                                   | Why                                                                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kopje_migrations`                                         | The header carries it. The target's own migration runner recreates it                                                                                  |
| `kopje_state` except `last_local_id` and `profile_updates` | `hold`, `upgrade` and `upgrade_bookmark` (a bookmark belongs to the source object), `maintenance`, `dump` and `import` describe one object at one time |
| `media_orphans`                                            | Tombstones of R2 objects to delete; a restored Store must not delete what it restores                                                                  |
| `backup_media`                                             | The scheduled backup's media index for one bucket ([backup.md](backup.md)); a restored Store starts a fresh media baseline                             |
| `stream_*`                                                 | The streaming API's registry of subscriptions, journal of events and position: state of the open sockets of one object                                 |
| `_cf_*`, `sqlite_*` (except `sqlite_sequence`)             | Platform and SQLite internals                                                                                                                          |

The importer refuses a `kopje_state` row whose name is not allowlisted. `profile_updates` is written only by
`convert --images`: a JSON array of the ids of the local accounts whose avatar or header the conversion changed
(the importer refuses any other value, a repeated id, or more than 100 ids, `state-invalid`). Publication sends each an `Update(Person)` and deletes the
row ([cutover.md](cutover.md), "Media"), so a dump of a published Store does not hold it.

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

`POST /admin/dump/finish` ends the dump's freeze and returns the trailer. The Store keeps a receipt until the next
dump starts, so repeating the finish with the same cursor returns the same trailer.

## Producing a file for import (cutover)

`kopje-admin convert` does this for a legacy Wildebeest export ([cutover.md](cutover.md)).

1. Read the catalog from the empty target: `GET /admin/catalog`.
2. Build the converted data in a local SQLite database created from the same migrations. Use the target's catalog
   order for tables, columns and rows.
3. Write each value as its canonical literal (the table above). Do not use `quote()`; read TEXT as bytes, and format
   REAL with ECMAScript's `Number#toString` (JavaScript's `String(x)`).
4. Compute each table checksum from the same literals.

## Import protocol

All of these are `POST` under `/admin/import` with JSON, except `chunk` and `progress`. A verified import leaves the
Store unpublished: it refuses every write (as in readonly) until `kopje-admin publish --yes` (`POST /admin/publish`, by
an Access admin, or with `IMPORT_TOKEN` while the Store has no admin access), so nothing is written or delivered before
you have checked it.

| Step     | Request                                                                                                              | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| begin    | `{ "header": {...} }`                                                                                                | Checks migrations, catalog and emptiness, then records an import. An Access admin who sends the same header again, while that import is still running, resumes it in the phase it reached (`receiving`, `finished` or `failed` with its report). After verification, `GET /admin/import/progress?id=<id>` answers from the receipt (`verified`, with its report); begin does not, since the Store is no longer empty. A begin with `IMPORT_TOKEN` also returns `session`, the credential that continues this import |
| chunk    | `?id=<id>&seq=<n>`, raw body of whole statements: at most 2,000 in at most 4 MiB, or one statement of at most 16 MiB | Validates every statement against the templates. Applies the rows and the progress record in one `transactionSync`. A link is checked against its target row and staged, not applied (see "Bounded work" below)                                                                                                                                                                                                                                                                                                     |
| finish   | `{ "id", "trailer" }`                                                                                                | Checks the trailer's tables, statement count, byte count and body SHA-256 against what was received                                                                                                                                                                                                                                                                                                                                                                                                                 |
| verify   | `{ "id" }`, repeated until `done`                                                                                    | Applies the staged links, then recomputes row counts and checksums in the Store, then runs `PRAGMA foreign_key_check`. On success the import record gives way to a receipt and the Store serves again                                                                                                                                                                                                                                                                                                               |
| progress | `GET ?id=<id>`                                                                                                       | The running import, or the receipt of the last verified one (`state: "verified"`, with its report). It includes `headerSha256` and `trailerSha256`, the digests of the header and trailer JSON as received, so a client can check that its file is the dump the Store has                                                                                                                                                                                                                                           |
| reset    | `{ "confirm": true, "id": "<id>" }`, repeated until `done`                                                           | Takes the Store back to before that import (see "Reset" below). Only the authority of that import may reset it. A retried request for an import already reset answers `done` again                                                                                                                                                                                                                                                                                                                                  |

- Chunk numbers start at 1. The progress record holds `lastSeq` and a chain digest:
  `digest_n = hex(sha256(digest_{n-1} || chunk_n))`, with `digest_0` = the empty string.
- After any error, read `GET /admin/import/progress` and compare `lastSeq` and `digest`. Do not assume a rollback:
  a timed-out transaction can still be durable.
- A resent chunk with `seq ≤ lastSeq` is reported as `duplicate` and is not applied again.
- A chunk over its bounds is refused with `chunk-too-large` and nothing of it is applied. `kopje-admin import` splits
  the body within them.
- `kopje-admin import` refuses to resume an import whose saved chunk limits exceed these bounds (an import begun by an
  earlier version), with `import-chunks-outdated`, before sending anything: run `import-reset` and import again.
- While an import record exists, every domain operation is refused and schema upgrades wait. `GET /admin/config`
  shows the target's own configuration, which the record holds. A failed verification
  needs `reset` and a new import. Verification or reset schedules any upgrade that waited.
- After verification, a receipt with the import's id, digests and report stays until the next import begins. A
  client whose verify response was lost reads the outcome there.

### Bounded work

Each call has to finish within the Durable Object's CPU limit, and what a call costs follows what it writes, not the
bytes it receives:

- A chunk writes its rows and every index entry they add, so it is bounded by statements as well as by bytes. A
  single row larger than the byte bound comes alone; the platform limits a stored row to 2 MB.
- A link is a short statement, but SQLite rewrites the whole row it changes, overflow pages included, so a chunk of
  links can rewrite many times its own size. The chunk only checks that each link's target row exists and that the link holds at most 64 KiB (it carries only key
  values; a longer one is refused with `link-too-large`), and stages the
  link (in `kopje_state`, under names that are never dumped). Verify reads the staged links one at a time and applies them in body order, a step
  per call that stops after the row that brings the rewritten bytes to 1 MiB or after 2,000 links; the checksums
  start in the call that applies the last of them. A link that cannot be applied (its value breaks a constraint) is
  refused at verify; the import then needs a reset.
- A reset that unlinks rows stops the call after one such step, bounded the same way.

### Authority

The Store checks each import step's authority inside the transaction that writes:

| Authority      | How                                                              | What it may do                                                                                                                                                                                                                                                                                                      |
| -------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access admin   | `Cf-Access-Jwt-Assertion` of the `/admin` application            | Begin an import and continue only imports begun this way. The Store checks the verified identity and Access binding (team domain and `/admin` AUD) against its own configuration in the writing transaction, so a request is refused once the admin, the team or the application changed after it was authenticated |
| `IMPORT_TOKEN` | header `Kopje-Import-Token` (at least 32 characters)             | Only while the Store is in bootstrap, meaning admin access is not usable. It may read health, version, catalog and config, set the config, begin an import while the Store also holds no data, and abandon a stale token import (below)                                                                             |
| import session | header `Kopje-Import-Session`, the `session` that begin returned | Only the import it was issued for: chunk, finish, verify, progress and reset. The Store keeps only its SHA-256                                                                                                                                                                                                      |

A request authorized for one import or mode cannot act on another. Once the import has begun, `IMPORT_TOKEN` opens
nothing except the stale-import recovery below. The CLI keeps the session in `<file>.import.json` (mode 0600).

### Reset

A reset never uses `deleteAll()`:

1. The import record turns into `resetting`; nothing else continues the import.
2. Bounded transactions of at most 2,000 rows each first drop the links the import staged, then set the references
   inside a table to NULL, then delete the rows, children before parents. The references are
   `statuses.reblog_of_id`, `statuses.in_reply_to_id`, and any column the catalog defers. No delete then cascades to
   or updates another row. Setting references to NULL rewrites rows, so such a step also stops after the row that
   brings the rewritten bytes to 1 MiB, and ends the call. Each call runs a few transactions, and the caller repeats
   the call until `done`.
3. The last transaction:
    - writes the configuration back exactly from the record;
    - removes the record;
    - leaves a reset receipt, so a retried request for the same import is answered `done`.

The configuration is never touched in between, and the schema stays. A request for another import id is refused. The
CLI names the import from `<file>.import.json`, or else from the running import.

Nothing continues a reset on its own; no alarm drives it. A reset interrupted by a restart, a deploy or a lost client
loses nothing. The Store stays `resetting` (refusing domain operations) until the reset is resumed by running
`kopje-admin import-reset` again.

The steps of one call carry no authority of their own. The call is authorized once, then runs its transactions without
yielding, and the configuration they would be checked against cannot change while the import exists (config is
refused). Each new call is authorized again. A retry answered from the receipt also schedules any upgrade that waited
for the reset.

#### Recovering a token import whose session was lost

If `<file>.import.json` is lost, nothing can continue the token import. Abandon it with
`kopje-admin import-reset --abandon-stale --import-token --yes`, or over the API: `POST /admin/import/reset` with
`{ "confirm": true, "id": "<id>", "abandonStale": true }` and `Kopje-Import-Token`. To learn the id, the token may
read `GET /admin/import/progress` for a token import while admin access is not usable.

The reset runs only when all of these hold:

- the import is a token import and is not verified;
- its session has made no successful step (chunk, finish or verify) for 15 minutes;
- admin access is still not usable.

It resets the import as above; a reset it started is continued the same way, without waiting again. Before the 15 minutes are up, the answer is
`409 import-not-idle`, with `resetAfter` giving the time the reset becomes possible. Then begin the import again.

This gives the token no new power: on an empty Store without admin access it could begin an import anyway.
`IMPORT_TOKEN` never resets an Access import.

### Configuration is not data

Everything the config operation sets is the Store's configuration, not data:

- `domain` (actor ids derive from it);
- `access_aud`, the `/oauth/authorize` application;
- `access_team_domain`, the Access team shared with `/oauth/authorize`;
- `access_admin_aud`, `admin_email` and `access_service_token_client_id` of the `/admin` application.

An import never touches configuration:

- These rows do not make the Store non-empty, so they can be set before the import.
- Begin moves them into the import record, and the Access rows among them keep authorizing the admin during the
  import.
- After verification, the Store's own rows come back exactly: imported values of these names are removed, and a name
  the Store did not have stays absent. A dump never changes the target's domain or who administers it.

They are set only with the explicit config operation, `GET`/`POST /admin/config` with
`{ "values": { "<name>": "<value>" | null } }`. Either an Access admin calls it, or `IMPORT_TOKEN` while the Store is
in bootstrap. It is refused while an import runs.

The cutover takes the instance values from the legacy settings and sets them with
`kopje-admin config --import-token name=value ...`, before or after importing the dump. Once the Access values make
admin access usable, the token stops working.
