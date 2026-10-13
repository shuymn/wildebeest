# Cutover from a legacy Wildebeest instance: the converter

The whole cutover, step by step, is [cutover-runbook.md](cutover-runbook.md); this page documents its conversion step.

`kopje-admin convert` turns the D1 database of a legacy Wildebeest instance into a Kopje dump
([dump-format.md](dump-format.md)) that `kopje-admin import` loads into an empty Store. `kopje-admin verify-conversion`
checks a dump against the legacy data with expectations it computes on its own. Both run offline on the operator's
machine: they read files, write files, and never contact the legacy instance, Cloudflare or anything else (DATA-11).

The exports hold everything the instance knows, direct messages, emails and wrapped private keys included. Keep them,
the dump and the working directory on an encrypted disk, and never paste them anywhere. What the commands print, and
the manifest, are safe to share: counts, stop codes and digests only (DATA-13, "Reporting format" below).

## Supported legacy instances

| Line                                       | Version | Migration level                       |
| ------------------------------------------ | ------- | ------------------------------------- |
| T1: the Wildebeest line in this repository | 0.1.0   | 0010 or below, 0018, 0023, 0035, 0039 |
| T2: cloudflare/wildebeest                  | 0.0.1   | 0010 or below                         |

Below 0011 both lines have the same schema, so the converter reports them together as `T1 or T2`. An export whose
`d1_migrations` is not a prefix of the canonical migrations (a fork with migrations of its own, or an alpha D1), or
whose schema differs from the canonical schema at its level, is refused.

## Input: the export

Export every table except the full-text index (`search_fts` and its shadow tables), each with
`wrangler d1 export <db> --remote --table <table> --output <table>.sql`. `d1_migrations` must be among them. The
converter takes either a directory of such files (every `*.sql` file in it) or one file of them concatenated, as the
legacy backup job writes it. A `sqlite_sequence` export is optional; when present, the notification counter continues
from it instead of from the largest notification id.

The export is only read, by a strict grammar, and nothing from it runs:

- `PRAGMA foreign_keys`/`defer_foreign_keys` is accepted and ignored, as are index, trigger, view and virtual table
  definitions.
- `CREATE TABLE <name> (<definition>) [WITHOUT ROWID | STRICT]` is validated (no `AS SELECT`, no subquery, nothing after
  the definition). Before it runs, its `DEFAULT`, `CHECK` and generated-column expressions must equal the canonical ones
  for the detected level; only then does it run, in an empty scratch database that never receives a row, to fingerprint
  the columns. Bookkeeping tables (`d1_migrations`, `sqlite_*`, `_cf_*`) never get the export's DDL: their rows are read
  by column name into a fixed schema of the converter's own.
- `INSERT INTO <name> [(<columns>)] VALUES (<literal>, ...)[, (...)]` is accepted with literals only: `NULL`, `TRUE`,
  `FALSE`, numbers, strings, blobs, and the `replace('<text>', '<marker>', char(<n>, ...))` form SQLite's `.dump` writes
  for control characters, nested at most twice (`replace(replace('<text>','\r',char(13)),'\n',char(10))` is the most
  it writes). The values are decoded and bound as parameters. An expansion is sized before it is built: one decoded
  literal may hold at most 16 Mi UTF-16 units and all literals of one pass over the export at most 1 Gi
  (`decoded-data-too-large`).
- Anything else (`INSERT ... SELECT`, a function or expression in `VALUES`, `UPDATE`, `DELETE`, `DROP`, `ATTACH`, other
  pragmas) stops the conversion with a fixed code (`invalid-insert`, `invalid-literal`, `invalid-create-table`,
  `unexpected-statement`).

**Limits.** One file may hold at most 512 MiB (a JavaScript string's limit) and the whole export 1 GiB. The converter
reads one file at a time, twice (schema, then rows), and keeps the legacy and the Kopje databases in memory, about three
times the export at peak. Larger exports stop with `export-too-large`; they are far past what a single-user or small
legacy instance reaches.

## Steps

1. **Level.** `d1_migrations` gives the level; the schema fingerprint (every exported table's columns, types,
   defaults and keys) must equal the canonical schema at that level. The canonical legacy migrations ship with the CLI
   (`cli/legacy-migrations`, a byte-identical copy of the repository's frozen `/migrations`).
2. **Bridge.** The rows are loaded into a local database with the canonical schema at that level, and the remaining
   canonical migrations bring it to 0039, one at a time. `randomblob()` is replaced by a fixed stream, and rows a bridge
   migration creates with the current time (0010's web UI client) get the base time, so the result is the same on every
   run. Before the bridge runs, the addressing of every object and outbox row is captured as exported (below). Some migrations remove rows (0007 drops push subscriptions, 0017 keeps one reblog per
   outbox row, 0021 removes duplicate remote objects, 0034 duplicate favourites, 0038 duplicate reply links). Every
   removal is counted per migration and table, and the converter stops unless `--accept-deletions` is given.
3. **Convert** into a local database with the Store schema (below).
4. **Check keys.** One KEK must unwrap every local user's key (DATA-14).
5. **Write** `<out>/kopje.dump` and `<out>/manifest.json`. Each is written under a fresh temporary name created
   exclusively with mode 0600 and published with `link(2)`, which refuses an existing name: an existing file or
   symbolic link at either name, or an output directory that is a link, makes the converter refuse (`output-exists`,
   `output-not-a-directory`) without touching it.

```
kopje-admin convert <export> --out <dir> --base-time <time> [--accept-deletions] [--accept-truncation]
                    [--catalog <file>] [--domain <host>]
kopje-admin verify-conversion <export> <dump file> [--accept-deletions] [--accept-truncation]
```

- `--base-time` (ISO 8601 UTC) fixes the time ids are assigned against, so the same export gives the same dump. It is
  recorded in the manifest.
- `--catalog` takes the target's `kopje-admin catalog` output. Without it the converter uses the catalog of its own
  schema; `import` refuses a dump whose catalog differs from the target's either way.
- `--accept-truncation` accepts HTML longer than the sanitizer's limit (50,000 UTF-16 units), whose end is then cut.
  Without it such a value stops the conversion, and `verify-conversion` fails, both counted.
- `--domain` refuses an export whose local accounts are on another domain. The domain is otherwise taken as it is.
- The KEK candidates come from the environment: the empty KEK always, and the values of `userKEK` and `USER_KEY` (the
  legacy secret names) when they are set. The values are never printed.
- Exit codes: `convert` 0 when the dump is written, 3 when it stopped for a decision (the manifest says why), 2 on a
  usage error; `verify-conversion` 0 on PASS, 1 on FAIL.

## What the conversion does

**Ids.** Accounts, statuses, media and lists get 18-digit TEXT ids. A legacy API id that already has 18 digits stays
the id; all of them are reserved before any new id is drawn, so a drawn id never takes one. Any other (a UUID) becomes `legacy_id`, which the API and `/@user/<id>` resolve, and the row gets a new id:
local rows from their creation time, remote rows from `published` truncated to the second plus 0 to 999 ms; the low
bits come from the base time and the row's URI, never from a random source. Account ids that 0020 generated during the
bridge, and acct-shaped ids of the upstream era, are not kept as legacy ids. A local status whose URL still ends with
the UUID it was created with keeps that UUID as `legacy_id`. Notifications keep their INTEGER ids; duplicates by
(recipient, type, sender, status) keep the smallest. The counter continues past the larger of the exported
`sqlite_sequence` value and the largest id, as an exact integer.

**URIs.** Local actors and statuses keep their URIs (`https://<domain>/ap/users/<name>`, `/ap/o/<uuid>`). A remote
status takes its original URI, and the uuid of its legacy proxy id `/ap/o/<uuid>` is kept in `statuses.legacy_ap_o`. A
remote status that lost its original URI keeps the proxy as its URI (counted). A local image keeps the uuid of its
`/ap/o/<uuid>` in `media_attachments.legacy_ap_o`. These federation URLs keep answering after the import: a remote
proxy moves (301) to its original while the status is public and the original is https; a local image is its Image
document to ActivityPub clients while its status is public or unlisted; anything else is the same 404 as an unknown id.

**Content.** Status content, earlier versions and bios go through Kopje's HTML sanitizer, so the Store holds only HTML
it would have stored itself (HTML-1). Source text, spoilers, sensitivity, hashtags, mentions and edit history carry
over; remote statuses and actors keep the legacy JSON as `raw`, byte for byte.

**The audience never widens (DATA-15).** Who may read a status is what legacy allowed
(`packages/backend/src/mastodon/status_visibility.ts`, `isVisible`): it reads the object's own `to` and `cc` and the
followers collection of its stored author (`objects.original_actor_id`). All three are captured as exported, before any
bridge migration runs: 0002 gives every outbox row Public by default, which 0016 turns into its `to`, and 0021 rewrites
the stored author from `attributedTo`, so bridged values are never an audience. A non-public object whose author a bridge
migration changed stops the conversion (`statuses:author-changed-audience`).

- Addresses are read by legacy's rule (`getApId` in `packages/backend/src/activitypub/objects/index.ts`): a string is
  parsed as a URL and compared in its normalized form, and an object stands for its `id`, recursively. An address legacy
  could not read (an object with only `href`, null, a number, a relative URL), or a missing followers collection where it
  is needed, made legacy fail on the object; such a status stops the conversion
  (`statuses:addressing-legacy-could-not-read`) rather than being guessed. The converter is stricter than legacy in one
  way: an unreadable address anywhere in `to` or `cc` stops it, also where legacy's search would have ended earlier.
- The author's followers collection is compared as legacy compares it: `actorFromRow` keeps the stored `followers`
  property as spelled (and builds `<actor id>/followers` only when it is missing), and `detectVisibility` matches that
  string literally against the normalized addresses. Where the literal and the normalized comparison would disagree (a
  stored value with an upper-case host or `:443`, say), the conversion stops (`statuses:followers-spelling-ambiguous`)
  rather than choose between a direct and a followers-only audience.

- Visibility is legacy's: public with Public in `to`; with the author's followers in `to`, unlisted when Public is also in
  `cc`, else followers-only; otherwise direct. Only the full Public URI counts, as in legacy.
- Recipients (`status_mentions`): for public and unlisted statuses, the tagged known accounts, and the other addressed
  known accounts as silent ones. For a followers-only status, none: legacy let a follower read it only while the follow
  was accepted, and a recipient row would be a grant that outlives an unfollow, so in Kopje only an accepted follow,
  checked when the status is read, lets anyone read it. The API therefore shows no mentions on a migrated followers-only
  status (they stay in `raw`). For a direct status, exactly the known accounts in `to` (silent unless tagged; a direct status with
  a silent recipient is stored as `limited`, the same audience). A Mention tag or `cc` entry outside that set is no
  recipient: it stays in `raw` and is counted as `mentionsNotRecipients`.
- A local status whose exported outbox row disagrees with its own addressing (`statuses:addressing-conflict`), and a
  boost whose outbox row has no exported audience (levels below 0002, `reblogs:audience-unknown`), stop the conversion
  instead of being guessed. A boost's visibility is its outbox row's, by the same rule; a boost has recipients only when
  it is direct (the known accounts in its `to`).

**Media.** Attachments point to their existing URLs (local images stay where the legacy instance stored them); nothing
is downloaded. Unattached local images are kept without a status.

**Relationships.** Follows, favourites, boosts, bookmarks, blocks, mutes, domain blocks and lists carry over. A
follow's `uri` is its legacy value, or for a local follower the id of its latest Follow activity; an accepted follow
with no Follow record keeps `uri` NULL and is counted. Self-follows, self-blocks and self-mutes cannot exist in Kopje
and are left out (counted). Counters are recomputed.

**Clients and settings.** OAuth clients keep their id, secret and scopes. Legacy settings take Kopje's names:
`server name` becomes `title` and `server description` becomes `description` (both shown by `/api/v1/instance`);
`extended description` and `privacy policy` are kept as `extended_description` and `privacy_policy` for the matching
Mastodon endpoints, which Kopje does not serve yet. Rules become `rules`. Any other setting name stops the conversion
(`settings:unknown-name`), since it could collide with Kopje's own settings.
Access tokens, push subscriptions, app credentials, the outbox and inbox queues and the full-text index are not carried
over: users sign in again and clients register push again.

**Stops.** The converter writes no dump when it finds rows it cannot carry over (`conversion.problems`: rows in tables
the legacy code never wrote, unknown object types, statuses whose author is not local where it must be, duplicate
URIs, lists without 18-digit ids, and the like), when rows reference accounts or statuses that do not exist and
`--accept-deletions` is not given (`conversion.dropped`), or when no single KEK candidate unwraps every key.

## Verification

`verify-conversion` computes expected records from the legacy data by its own code path, which shares no mapping with
the converter (only Kopje's HTML sanitizer, a runtime transformation of the Store, whose output a test pins by hand),
taking every audience from the addressing captured before the bridge, and reads actual records from a dump. Records are keyed by AP URIs, never by assigned ids, and compared as exact values:

| Category                                                                                                                           | Record                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accounts`                                                                                                                         | locality, local username, display name, bio, avatar, header, lock                                                                                   |
| `keys`                                                                                                                             | email, wrapped key bytes, salt bytes, public key                                                                                                    |
| `raw`                                                                                                                              | the legacy JSON of every remote account and status                                                                                                  |
| `statuses`                                                                                                                         | author, content, source, spoiler, sensitivity, time                                                                                                 |
| `audience`                                                                                                                         | legacy visibility, the recipients (silent ones included), and for a non-public status the author legacy authorized with                             |
| `replies`, `aliases`                                                                                                               | inReplyTo and the linked parent; remote proxy uuid to original URI                                                                                  |
| `counters`                                                                                                                         | the notification counter                                                                                                                            |
| `edits`, `attachments`, `media`                                                                                                    | versions in order; URLs and descriptions in order; each old image id with its URL, its owner (the stored author) and the status showing it, or none |
| `boosts` (with visibility and recipients), `follows` (Follow record or NULL, reblogs, notify), `favourites`                        | by the URIs of both ends                                                                                                                            |
| `bookmarks`, `blocks`, `mutes`, `domain_blocks`, `lists` (policy, exclusive), `list_accounts`, `notifications`, `clients` (scopes) | by URI or kept id                                                                                                                                   |
| `legacy_ids`, `settings`                                                                                                           | each expected key must resolve to the same value (extra keys allowed)                                                                               |

Any missing, extra or changed record FAILs: missing content, content rewritten to the same length, a dropped
relationship, a recipient removed or added, a widened visibility, a dropped reply link and a count difference all do
(DATA-12). Content over the sanitizer's limit fails too unless `--accept-truncation` is given (`truncation.overLimit`). Run it twice in a cutover: on the converted dump
before importing, and on a `kopje-admin dump` of the Store after the import.

## Reporting format

Everything printed and the manifest are safe to paste, on success and on failure alike. They never contain rows, URIs,
emails, keys, KEK values or the domain (only its SHA-256). Failures carry fixed codes; an untrusted name (a table, an
object type) appears only as a 12-hex-digit SHA-256 prefix, and a parser or database error only as its class name.

`manifest.json` (also printed by `convert`):

| Field            | Content                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tool`           | command, converter format version, package version                                                                                                                                                           |
| `baseTime`       | the base time ids were assigned against                                                                                                                                                                      |
| `source`         | `level`, `levelName`, `line`, `schemaFingerprint`, `migrationsApplied`, `rowsLoaded` per legacy table, `deletions` (migration, table, rows), `foreignKeyViolations` after the bridge, `notificationSequence` |
| `kek`            | `candidates` (names), `users` (a 12-hex-digit digest of each actor URI and the candidate name that unwraps its key, or null), `uniform`, `kek`, `emptyKek`                                                   |
| `conversion`     | `domainSha256`, `localAccounts`, and per-code counts: `problems`, `dropped`, `normalized`, `legacyIds`                                                                                                       |
| `tables`         | per Store table: rows and checksum, as in the dump trailer                                                                                                                                                   |
| `dump`           | file name, SHA-256 of the file, and the trailer's body digest                                                                                                                                                |
| `exportBytes`    | the size of the export read                                                                                                                                                                                  |
| `result`, `stop` | `converted`, or `stopped` with a fixed `code`, a fixed `message` and `detail` (counts, levels, digests)                                                                                                      |

`verify-conversion` prints `{ "result": "PASS" | "FAIL", "categories": { <name>: { expected, actual, missing, extra,
changed, expectedSha256, actualSha256 } }, "truncation": { overLimit, accepted } }`. The digests are SHA-256 over the sorted records of each side, so two runs
can be compared without seeing any record.
