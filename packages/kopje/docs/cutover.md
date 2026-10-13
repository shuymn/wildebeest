# Cutover from a legacy Wildebeest instance: the converter

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

The export is only read. The loader runs nothing from it: each `INSERT` goes into a staging table of the table it
names, and any statement other than a table definition, an index or trigger definition (ignored), a row or a
`PRAGMA foreign_keys`/`defer_foreign_keys` makes the converter refuse the export.

## Steps

1. **Level.** `d1_migrations` gives the level; the schema fingerprint (every exported table's columns, types,
   defaults and keys) must equal the canonical schema at that level. The canonical legacy migrations ship with the CLI
   (`cli/legacy-migrations`, a byte-identical copy of the repository's frozen `/migrations`).
2. **Bridge.** The rows are loaded into a local database with the canonical schema at that level, and the remaining
   canonical migrations bring it to 0039, one at a time. `randomblob()` is replaced by a fixed stream, so the result is
   the same on every run. Some migrations remove rows (0007 drops push subscriptions, 0017 keeps one reblog per
   outbox row, 0021 removes duplicate remote objects, 0034 duplicate favourites, 0038 duplicate reply links). Every
   removal is counted per migration and table, and the converter stops unless `--accept-deletions` is given.
3. **Convert** into a local database with the Store schema (below).
4. **Check keys.** One KEK must unwrap every local user's key (DATA-14).
5. **Write** `<out>/kopje.dump` and `<out>/manifest.json`, both mode 0600.

```
kopje-admin convert <export> --out <dir> --base-time <time> [--accept-deletions] [--catalog <file>] [--domain <host>]
kopje-admin verify-conversion <export> <dump file> [--accept-deletions]
```

- `--base-time` (ISO 8601 UTC) fixes the time ids are assigned against, so the same export gives the same dump. It is
  recorded in the manifest.
- `--catalog` takes the target's `kopje-admin catalog` output. Without it the converter uses the catalog of its own
  schema; `import` refuses a dump whose catalog differs from the target's either way.
- `--domain` refuses an export whose local accounts are on another domain. The domain is otherwise taken as it is.
- The KEK candidates come from the environment: the empty KEK always, and the values of `userKEK` and `USER_KEY` (the
  legacy secret names) when they are set. The values are never printed.
- Exit codes: `convert` 0 when the dump is written, 3 when it stopped for a decision (the manifest says why), 2 on a
  usage error; `verify-conversion` 0 on PASS, 1 on FAIL.

## What the conversion does

**Ids.** Accounts, statuses, media and lists get 18-digit TEXT ids. A legacy API id that already has 18 digits stays
the id. Any other (a UUID) becomes `legacy_id`, which the API and `/@user/<id>` resolve, and the row gets a new id:
local rows from their creation time, remote rows from `published` truncated to the second plus 0 to 999 ms; the low
bits come from the base time and the row's URI, never from a random source. Account ids that 0020 generated during the
bridge, and acct-shaped ids of the upstream era, are not kept as legacy ids. A local status whose URL still ends with
the UUID it was created with keeps that UUID as `legacy_id`. Notifications keep their INTEGER ids; duplicates by
(recipient, type, sender, status) keep the smallest.

**URIs.** Local actors and statuses keep their URIs (`https://<domain>/ap/users/<name>`, `/ap/o/<uuid>`). A remote
status takes its original URI, and the uuid of its legacy proxy id `/ap/o/<uuid>` is kept in `statuses.legacy_ap_o`. A
remote status that lost its original URI keeps the proxy as its URI (counted). A local image keeps the uuid of its
`/ap/o/<uuid>` in `media_attachments.legacy_ap_o`.

**Content.** Status content, earlier versions and bios go through Kopje's HTML sanitizer, so the Store holds only HTML
it would have stored itself (HTML-1). Source text, spoilers, sensitivity, hashtags, mentions and edit history carry
over; remote statuses and actors keep the legacy JSON as `raw`, byte for byte. Visibility follows Mastodon's rule
(public in to, public in cc, the author's followers in to, otherwise direct; a direct status that addresses a known
account it does not mention is limited), from the outbox row for local statuses. This differs from the legacy display in
one case: an object with Public only in cc was shown as direct and is now unlisted.

**Media.** Attachments point to their existing URLs (local images stay where the legacy instance stored them); nothing
is downloaded. Unattached local images are kept without a status.

**Relationships.** Follows, favourites, boosts, bookmarks, blocks, mutes, domain blocks and lists carry over. A
follow's `uri` is its legacy value, or for a local follower the id of its latest Follow activity; an accepted follow
with no Follow record keeps `uri` NULL and is counted. Self-follows, self-blocks and self-mutes cannot exist in Kopje
and are left out (counted). Counters are recomputed.

**Clients and settings.** OAuth clients keep their id and secret. Server settings and rules go to `instance_settings`.
Access tokens, push subscriptions, app credentials, the outbox and inbox queues and the full-text index are not carried
over: users sign in again and clients register push again.

**Stops.** The converter writes no dump when it finds rows it cannot carry over (`conversion.problems`: rows in tables
the legacy code never wrote, unknown object types, statuses whose author is not local where it must be, duplicate
URIs, lists without 18-digit ids, and the like), when rows reference accounts or statuses that do not exist and
`--accept-deletions` is not given (`conversion.dropped`), or when no single KEK candidate unwraps every key.

## Verification

`verify-conversion` computes expected records from the bridged legacy data by its own code path, which shares no
mapping with the converter (only Kopje's HTML sanitizer, a runtime transformation of the Store), and reads actual
records from a dump. Records are keyed by AP URIs, never by assigned ids, and compared as exact values:

| Category                                                                                              | Record                                                                |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `accounts`                                                                                            | locality, local username, display name, bio, avatar, header, lock     |
| `keys`                                                                                                | email, wrapped key bytes, salt bytes, public key                      |
| `raw`                                                                                                 | the legacy JSON of every remote account and status                    |
| `statuses`                                                                                            | author, content, source, spoiler, sensitivity, time, reach            |
| `edits`, `attachments`, `media`                                                                       | versions in order; URLs and descriptions in order; old image ids      |
| `boosts`, `follows` (with the Follow record or NULL), `favourites`                                    | by the URIs of both ends                                              |
| `bookmarks`, `blocks`, `mutes`, `domain_blocks`, `lists`, `list_accounts`, `notifications`, `clients` | by URI or kept id                                                     |
| `legacy_ids`, `settings`                                                                              | each expected key must resolve to the same value (extra keys allowed) |

Any missing, extra or changed record FAILs: missing content, content rewritten to the same length, a dropped
relationship, a widened DM and a count difference all do (DATA-12). Run it twice in a cutover: on the converted dump
before importing, and on a `kopje-admin dump` of the Store after the import.

## Reporting format

Everything printed and the manifest are safe to paste. They never contain rows, URIs, emails, keys, KEK values or the
domain (only its SHA-256).

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
| `result`, `stop` | `converted`, or `stopped` with a code and reasons                                                                                                                                                            |

`verify-conversion` prints `{ "result": "PASS" | "FAIL", "categories": { <name>: { expected, actual, missing, extra,
changed, expectedSha256, actualSha256 } } }`. The digests are SHA-256 over the sorted records of each side, so two runs
can be compared without seeing any record.
