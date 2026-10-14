# Cutover from a legacy Wildebeest instance: the converter

The whole cutover, step by step, is [cutover-runbook.md](cutover-runbook.md); this page documents its conversion step.

`kopje-admin convert` turns the D1 database of a legacy Wildebeest instance into a Kopje dump
([dump-format.md](dump-format.md)) that `kopje-admin import` loads into an empty Store. `kopje-admin verify-conversion`
checks a dump against the legacy data with expectations it computes on its own. Both run offline on the operator's
machine: they read files, write files, and never contact the legacy instance, Cloudflare or anything else (DATA-11).
The one step that downloads is `kopje-admin images-export`, which fetches the legacy instance's images from Cloudflare
Images before the conversion ("Media" below).

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
from it instead of from the largest notification id. `wrangler d1 export --table sqlite_sequence` writes no
`CREATE TABLE` for it, but a `DELETE FROM sqlite_sequence;` before its rows; that statement is accepted as it is (below),
so the file needs no editing.

The export is only read, by a strict grammar, and nothing from it runs:

- `PRAGMA foreign_keys`/`defer_foreign_keys` is accepted and ignored, as are index, trigger, view and virtual table
  definitions.
- `CREATE TABLE <name> (<definition>) [WITHOUT ROWID | STRICT]` is validated (no `AS SELECT`, no subquery, nothing after
  the definition). Before it runs, its `DEFAULT`, `CHECK` and generated-column expressions must equal the canonical ones
  for the detected level; only then does it run, in an empty scratch database that never receives a row, to fingerprint
  the columns. Bookkeeping tables (`d1_migrations`, `sqlite_*`, `_cf_*`) never get the export's DDL: their rows are read
  by column name into a fixed schema of the converter's own.
- `DELETE FROM sqlite_sequence`, exactly as D1 writes it, is accepted once, before any `sqlite_sequence` row, and does
  nothing (the converter reads the counter rows into a fixed schema of its own). Written any other way, a second time
  or after a counter row, it stops the conversion (`unexpected-statement`).
- `INSERT INTO <name> [(<columns>)] VALUES (<literal>, ...)[, (...)]` is accepted with literals only: `NULL`, `TRUE`,
  `FALSE`, numbers, strings, blobs, and the `replace('<text>', '<marker>', char(<n>, ...))` form SQLite's `.dump` writes
  for control characters, nested at most twice (`replace(replace('<text>','\r',char(13)),'\n',char(10))` is the most
  it writes). The values are decoded and bound as parameters. An expansion is sized before it is built: one decoded
  literal may hold at most 16 Mi UTF-16 units and all literals of one pass over the export at most 1 Gi
  (`decoded-data-too-large`).
- Anything else (`INSERT ... SELECT`, a function or expression in `VALUES`, `UPDATE`, any other `DELETE`, `DROP`,
  `ATTACH`, other pragmas) stops the conversion with a fixed code (`invalid-insert`, `invalid-literal`, `invalid-create-table`,
  `unexpected-statement`).

**Limits.** One file may hold at most 512 MiB (a JavaScript string's limit) and the whole export 1 GiB. The converter
reads one file at a time, twice (schema, then rows), and keeps the legacy and the Kopje databases in memory, about three
times the export at peak. Larger exports stop with `export-too-large`; they are far past what a single-user or small
legacy instance reaches.

## Steps

1. **Level.** `d1_migrations` gives the level; the schema fingerprint (every exported table's columns, types,
   defaults and keys) must equal the canonical schema at that level. The canonical legacy migrations ship with the CLI
   (`cli/legacy-migrations`, a byte-identical copy of the repository's frozen `/migrations`). Columns are matched by
   name, not position, and each must have the canonical type, default, primary key position, generated kind and
   `DEFAULT`, `CHECK` and generated expressions; table constraint expressions must match in order, and a missing or an
   extra table or column is a mismatch (`schema-mismatch`). One variance is accepted: a column that is nullable in the
   export where the canonical one is `NOT NULL`, as long as no row of the export holds `NULL` in it (or leaves it to a
   `NULL` default); one that does stops the conversion (`null-in-not-null-column`). The manifest lists such columns
   (`source.nullableInExport`). A T1 instance that ran an earlier form of 0020 has this variance in `actors.type`:
   that form dropped the column and added it back as a generated `NOT NULL` column, which fails on a table with an
   actor whose properties have no type; the column then came back as a plain nullable column (`ALTER TABLE ADD
COLUMN`), after `mastodon_id`, and the final form of 0020 fills it from the properties.
   The rows are always loaded by column name into the canonical schema, so the bridge starts from the canonical column
   order and constraints whatever the export's.
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
   `output-not-a-directory`) without touching it. With `--images`, `<out>/originals/` (a new directory) receives the
   original of every mapped image, each file created exclusively with mode 0600 ("Media" below).

```
kopje-admin images-export <export> --images-account <hash> --out <images dir> [--account-id <id>]
kopje-admin convert <export> --out <dir> --base-time <time> [--accept-deletions] [--accept-truncation]
                    [--catalog <file>] [--domain <host>] [--images <images dir> [--accept-missing-images]]
kopje-admin verify-conversion <export> <dump file> [--accept-deletions] [--accept-truncation]
                    [--images <images dir> [--accept-missing-images]]
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
- `--images` maps the references to the operator's Cloudflare Images account to local media, from what `images-export`
  wrote to that directory. Without it, every image URL stays as it is, the legacy instance's Cloudflare Images
  included: `--images` is needed to stop depending on Cloudflare Images. `--accept-missing-images` carries on although
  images `images-export` could not download leave their references out; without it, `convert` stops and
  `verify-conversion` fails on them (both counted). Pass the same `--images` to `verify-conversion`.
- Exit codes: `convert` 0 when the dump is written, 3 when it stopped for a decision (the manifest says why), 2 on a
  usage error; `verify-conversion` 0 on PASS, 1 on FAIL; `images-export` 0 when every image is downloaded, 3 when one
  is missing or it refuses (a fixed code), 1 when Cloudflare answers with an error (rerun it to continue).

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
over; hashtags (the object's `Hashtag` tags and legacy's `note_hashtags`) are named as Kopje names them (NFKC,
lowercase, without `#`), and a status's language is read as Kopje reads a remote object's (the primary subtag of the
first language in `contentMap`, else `nameMap`, `summaryMap`, when it is two or three letters); remote statuses and
actors keep the legacy JSON as `raw`, byte for byte. A lone surrogate in carried text (half of a character outside the
Basic Multilingual Plane, as a cut string leaves it in legacy JSON) cannot be stored as UTF-8, so it becomes U+FFFD,
counted as `text:lone-surrogate-replaced`; `raw` keeps the escaped original.

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
  instead of being guessed. An outbox row written before 0016 was applied (by `d1_migrations.applied_at`) holds only
  the single target it was written with, which 0016 copied into `to` with an empty `cc`, so it agrees when that target
  is within the status's own `to` or `cc`; the status keeps its own audience either way. Without a usable `applied_at`
  for 0016, every row is compared as written. A boost's visibility is its outbox row's, by the same rule; a boost has recipients only when
  it is direct (the known accounts in its `to`).

**Media.** Legacy stored local images (avatars, headers, attachments) in Cloudflare Images and wrote their delivery
URLs, `https://imagedelivery.net/<account hash>/<image id>/<variant>`, into actor properties, statuses, earlier
versions of edited statuses and activities. Without `--images`, attachments, avatars and headers keep these URLs and
nothing is downloaded: the media keeps working only while the images stay in Cloudflare Images. Unattached local images
are kept without a status either way. To move the images into Kopje's own media (R2):

1. `kopje-admin images-export <export> --images-account <hash> --out <images dir>` reads the export and collects every
   image id under the operator's account hash (the `<hash>` in the URLs above) from actor and object properties and
   the earlier versions of edited statuses: the columns whose URLs reach Kopje. Activities are not read; the converter
   keeps only Follow and Like ids from them. It downloads each image once, the original through the Images API
   (`GET /accounts/<account id>/images/v1/<image id>/blob`) when `--account-id` is given with an API token that can
   read Images in `CF_IMAGES_TOKEN`, and otherwise the variant URL found in the data, which may be resized; it asks for
   any type, so Images serves the stored format rather than converting it to WebP or AVIF. The token
   is read from the environment only, sent only to the API, never with a redirect, and redacted from what is printed.
   Each file is checked as Kopje checks an upload: its type from its signature (JPEG, PNG, GIF or WebP; AVIF, SVG and
   HEIC are refused), at most 16 MiB and 16,777,216 pixels, with dimensions read from its header. It is written to
   `<images dir>/originals/<image id>` with mode 0600, and `<images dir>/images.json` records, per image id, its SHA-256,
   type, size and source, and a secret (32 random bytes, base64url, as Kopje makes file tokens) from which the converter
   derives the file token of every media row that shows the image. An image Cloudflare answers 404 for, or one that
   fails a check, is recorded as `missing` with its reason. A rerun, on the same or a later export of the same instance,
   keeps every image whose file still has its digest and fetches only the rest; an image keeps its secret through every
   state, so one that comes back after being missing gets the same URLs. `images.json` is refused when it was written for
   another account hash or domain (`images-file-differs`). Any other error answer stops the run (`images-fetch-failed`,
   exit 1) after saving what it downloaded. It prints counts only.
2. `convert --images <images dir>` maps each local reference under the operator's account (profiles of local accounts,
   attachments of local statuses and of their earlier versions, unattached local images) to local media as Kopje's
   upload path makes it: a media row with a file token of its own, the served type (PNG stays PNG; JPEG, GIF and WebP
   become WebP), `url` and `preview_url` at `https://<domain>/media/<token>/{full,small}.<png|webp>`, and `meta` with
   the full size (within 3840 pixels) and the preview size (within 640) computed as the upload path sizes them. An
   avatar or header becomes the account's profile image: an unattached row with no `gc_at`, whose full URL
   `avatar_url` or `header_url` holds. An image that only earlier versions of a status show gets an unattached row
   too, one per status, so its files are kept. An earlier version that shows an image the status still shows names that
   row's files, with the description that version had. Every row, also when several show the same image, has its own token,
   files and original, so Kopje's per-row lifecycle (the sweep after a deletion, backups, the rebuild) needs nothing
   else. The token is HMAC-SHA256 under the image's secret of the row's key, base64url (43 characters, the shape of
   Kopje's tokens): `profile\n<actor URI>\n<avatar|header>`, `attachment\n<status URI>\n<position>`,
   `image\n<Image object id>` for an unattached image, `edit\n<status URI>\n<image id>`. A token so depends only on
   `images.json` and the legacy data, and cannot be derived from public URIs without the secret. A local profile image
   that is one of legacy's defaults, an image under cloudflare/wildebeest's default account
   (`NkfPDviynOyTAOI79ar_GQ`) or Mastodon's `missing.png` that legacy hotlinked as its default avatar, becomes `NULL`,
   so Kopje's own default applies (counted as `upstream`). URLs of other accounts stay as they are (`foreign`), and so does
   everything of remote accounts. A `missing` image's reference is left out: the avatar or header becomes `NULL`, the
   attachment is removed. A URL under the operator's account that `images.json` does not map stops the conversion
   (`images-unmapped`): run `images-export` on this export first. The ids depend only on the base time and the tokens
   on `images.json`, so the same inputs give the same dump.
3. The originals go to R2 under the key Kopje keeps an original at, `originals/<media id>`: `convert` writes one per
   row to `<out>/originals/<media id>` (`images.originals` in the manifest counts them), checking each against its
   digest (`images-original-mismatch` when one changed), and the operator puts them into the media bucket with
   Wrangler, as a backup restore does ([backup.md](backup.md)), before the import is published. The runbook's loop
   stops at the first failed put and checks the count.
4. The served files (`files/<token>/full` and `small` in R2) are made from the originals by Kopje's own re-encoding.
   That step is `kopje-admin media-rebuild`, run after the import and before publication (runbook step 8); until it has
   run, the mapped URLs answer 404. It also corrects each row's sizes, which the conversion took from the image header
   (EXIF rotation ignored).
5. Other servers keep the old avatar and header URLs in their copy of each local actor until they fetch it again. The
   conversion lists the local accounts whose avatar or header it changed (mapped, or made `NULL`) in the dump, as the
   `kopje_state` row `profile_updates` (a JSON array of account ids; [dump-format.md](dump-format.md)), and writes no
   such row when nothing changed or without `--images`. Publication records the list in one transaction, so it is
   bounded: more than 100 changed local profiles, far beyond the single-user or small instances Kopje is for, stop
   the conversion (`profile-updates-over-limit`), and the importer refuses a list with a repeated id or more than 100. Publication (`kopje-admin publish --yes`) records, in the
   transaction that makes the Store writable, one `Update(Person)` per listed account, the one a profile edit sends: to
   the account's followers, with the new `icon` and `image` (none where the profile now uses Kopje's default). It
   deletes the row in the same transaction, so a repeated `publish` records nothing more and a dump of the published
   Store never holds the row. `publish` reports the count as `profileUpdates`. A suspended account is skipped.
   `publish` is refused while a dump holds its freeze (`dump-in-progress`), so a dump is of one state.

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

**What `--accept-deletions` drops.** Besides the rows bridge migrations remove (Steps), `conversion.dropped` counts rows
the conversion leaves out because legacy never showed them, or showed them only through what is also left out:

- notifications owned by a remote account (`notifications:owner-remote`): legacy notified the author of a boosted or
  liked status whoever it was, but listed only a local user's own notifications;
- attachments without a `url` (`attachments:without-url`): legacy showed an attachment only by its `url`;
- statuses whose author is not among the exported accounts (`statuses:unknown-author`): legacy reached them only by
  fetching the author live when one was shown; and with them the boosts of such statuses
  (`reblogs:unknown-account-or-status`) and the parent link of replies to them (the reply keeps its `inReplyTo` URI);
- rows that reference an account or status that does not exist (`*:unknown-account`, `*:unknown-status`).

Read `conversion.dropped` in the manifest before passing the flag: every code there should be one of these kinds.

## Verification

`verify-conversion` computes expected records from the legacy data by its own code path, which shares no mapping with
the converter (only Kopje's HTML sanitizer, a runtime transformation of the Store, whose output a test pins by hand),
taking every audience from the addressing captured before the bridge, and reads actual records from a dump. Records are keyed by AP URIs, never by assigned ids, and compared as exact values:

| Category                                                                                                                                                           | Record                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accounts`                                                                                                                                                         | locality, local username, display name, bio, avatar, header, lock, actor type, discoverability                                                                                                                  |
| `profile_updates`                                                                                                                                                  | with `--images`: the local accounts whose avatar or header changed, which publication announces; a repeated one fails                                                                                           |
| `keys`                                                                                                                                                             | per local account: email, wrapped key bytes, salt bytes, public key, aliases (`alsoKnownAs`), posting visibility, sensitivity and language                                                                      |
| `raw`                                                                                                                                                              | the legacy JSON of every remote account and status                                                                                                                                                              |
| `statuses`                                                                                                                                                         | author, content, source, spoiler, sensitivity, time, language, edit time, hashtags                                                                                                                              |
| `audience`                                                                                                                                                         | legacy visibility, the recipients (silent ones included), and for a non-public status the author legacy authorized with                                                                                         |
| `replies`, `aliases`                                                                                                                                               | inReplyTo and the linked parent; remote proxy uuid to original URI                                                                                                                                              |
| `counters`                                                                                                                                                         | the notification counter                                                                                                                                                                                        |
| `edits`, `attachments`, `media`                                                                                                                                    | versions in order, each with what it shows (URL, preview, description, sizes); URLs and descriptions in order; each old image id with its URL, its owner (the stored author) and the status showing it, or none |
| `media_files`                                                                                                                                                      | with `--images`: per file token, the full and preview URLs, the served type, and the full and preview sizes                                                                                                     |
| `boosts` (with visibility and recipients), `follows` (Follow record or NULL, reblogs, notify, languages), `favourites` (Like record or NULL)                       | by the URIs of both ends                                                                                                                                                                                        |
| `bookmarks`, `blocks` (Block record or NULL), `mutes`, `domain_blocks`, `lists` (policy, exclusive), `list_accounts`, `notifications`, `clients` (scopes, website) | by URI or kept id                                                                                                                                                                                               |
| `legacy_ids`, `settings`                                                                                                                                           | each expected key must resolve to the same value (extra keys allowed)                                                                                                                                           |

Any missing, extra or changed record FAILs: missing content, content rewritten to the same length, a dropped
relationship, a recipient removed or added, a widened visibility, a dropped reply link and a count difference all do
(DATA-12). Content over the sanitizer's limit fails too unless `--accept-truncation` is given (`truncation.overLimit`). A domain block whose value is no domain name, which the conversion drops, fails too unless `--accept-deletions` is given (`dropped`). Run it twice in a cutover: on the converted dump
before importing, and on a `kopje-admin dump` of the Store after the import.

With `--images`, the expected avatars, headers, attachments, old image URLs and `media_files` come from `images.json`
and the instance origin alone, by code that does not share the converter's mapping: a URL, a token, a served type or a
size that differs fails. So does a URL under the operator's account that `images.json` does not map, and a missing
image unless `--accept-missing-images` is given (`images.unmapped`, `images.missing`).

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
| `images`         | with `--images`: references `mapped`, left out as `missing`, `upstream` defaults dropped, `foreign` kept, `unmapped`, `originals` written (one per row), `acceptMissing`                                     |
| `result`, `stop` | `converted`, or `stopped` with a fixed `code`, a fixed `message` and `detail` (counts, levels, digests)                                                                                                      |

`verify-conversion` prints `{ "result": "PASS" | "FAIL", "categories": { <name>: { expected, actual, missing, extra,
changed, expectedSha256, actualSha256 } }, "truncation": { overLimit, accepted }, "dropped": { <code>: count, accepted } }`. The digests are SHA-256 over the sorted records of each side, so two runs
can be compared without seeing any record.
