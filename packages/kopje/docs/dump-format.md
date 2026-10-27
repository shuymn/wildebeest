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
    - All tables are included except `kopje_migrations`, `media_orphans`, `card_images`, `remote_media`,
      `remote_media_objects`, `remote_media_usage`, `backup_media`, `stream_*`, `_cf_*`, and `sqlite_*` other than
      `sqlite_sequence`.
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

An announcement is a row of `announcements` (migration `0056_announcements`): an 18-digit `id`; `text` of 1 to 10,000
UTF-8 bytes with no NUL and not blank in SQLite's ASCII sense; `starts_at` and `ends_at` both NULL or both set, the
end not before the start; `published_at`, `scheduled_at`, `created_at` and `updated_at` as `YYYY-MM-DDTHH:MM:SS.sssZ`
with an hour of 00 to 23 (NULL allowed but for the last two); `all_day` and `published` 0 or 1; a published row has
a `published_at` and no `scheduled_at`. At most 1,000 rows, and at most 16 published or scheduled. A scheduled row
whose time has passed is published by the next cron run. `announcement_reactions` rows name a local account and a
`name` of 1 to 128 bytes with no NUL, C0 control or DEL: the shortcode of their `custom_emoji_id`'s emoji (ASCII of
`A-Z a-z 0-9 _`), or, with no emoji, a name holding a character past ASCII; at most 8 names per announcement, one row
per name and account; a reaction whose emoji was disabled since still imports. `announcement_dismissals` rows are one
per local account and announcement. The tables come after `accounts`, `local_accounts` and `custom_emojis`. A chunk
past these fails with the CHECK's name (`announcement_id_is_a_snowflake`, `announcement_text_within_10000_bytes`,
`announcement_times_iso`, `announcement_range`, `announcement_flags`, `announcement_publication`,
`announcement_reaction_name_within_128_bytes`), `announcements: more than 1000`, `announcements: more than 16
published or scheduled`, `announcement_reactions: more than 8 names for one announcement`, `announcement_reactions: a
custom emoji reaction is named by its shortcode` or a `UNIQUE` or `FOREIGN KEY` failure. A dump taken before 0056
lists none of these tables: it restores into a Store at its own migrations (begin checks them), which then upgrades.
A file built from legacy data has no row.

Trends (migration `0057_trends`): `trend_tags` rows hold a hashtag `name` of 1 to 1,024 UTF-8 bytes with no NUL, at most
256 characters and no ASCII but `0-9 _ a-z`, a `score` and a `max_score` with 0 ≤ score ≤ max_score ≤ 1e15 and a 24-byte
ISO `max_score_at`; `trend_statuses` rows an 18-digit `status_id` and its author's `account_id`, a `score` from 0.3 to
1e15; at most 250 rows in each and 3 per author. `tag_trend_reviews` (a name of the same rule), `status_trend_reviews`
and `account_trend_reviews` hold `trendable` 0 or 1 and a 24-byte ISO `reviewed_at`, at most 10,000 each.
`instance_settings` rows named `trends` and `trendable_by_default` hold `true` or `false`. The tables come after
`statuses` and `accounts`. The rows are a snapshot: the next cron round works them out again, dropping a stored name
that is not well-formed UTF-8 or not in its normalized form and decaying a peak dated in the future from the round's
time. A chunk past these fails with the CHECK's name (`trend_tag_name`, `trend_tag_scores`,
`trend_tag_max_score_at_iso`, `trend_status_ids`, `trend_status_score`, `tag_trend_review_name`,
`tag_trend_review_at_iso`, `status_trend_review_at_iso`, `account_trend_review_at_iso`), `trend_tags: more than 250`,
`trend_statuses: more than 250`, `trend_statuses: more than 3 for one author`, `trend_statuses: account_id is the
status's author`, `tag_trend_reviews: more than 10000` (and the same for the other two review tables),
`instance_settings: a value past its stored bound`, or a `FOREIGN KEY` failure. A dump taken before 0057 lists none of
these tables: it restores into a Store at its own migrations, which then upgrades. A file built from legacy data has no
row.

Profile credentials (migration `0058_profile_credentials`): `accounts.indexable` is NULL (a remote account not stored
again since that migration, presented as false), or the integer 0 or 1; any other stored value, text that does not
read as 0 or 1 included, fails with `accounts: indexable past its stored bound`. `local_accounts.accept_requests_after`
is NULL (no unlock acceptance job) or a non-negative integer, the last `follows.id` the job passed; the job continues
after a restore. Any other value fails with `accept_requests_after_cursor`. A dump taken before 0058 has neither
column: it restores into a Store at its own migrations, which then upgrades. A file built from legacy data writes NULL
for both.

The contact account and activity (migration `0059_contact_and_activity`): `local_accounts.active_on` is NULL (never
recorded) or a UTC date `YYYY-MM-DD` of 10 bytes, the account's last day with an authenticated request; anything else
fails with `active_on_date`. An `instance_settings` row named `contact_username` holds an account's address, `user` or
`user@domain` (ASCII letters, digits and `-._`, one `@` at most and at neither end, a username of at most 255 bytes,
509 UTF-8 bytes in all, text only); anything else fails with `instance_settings: a value past its stored bound`. A dump
taken before 0059 has no `active_on`: it restores into a Store at its own migrations, which then upgrades, and the
upgrade deletes a `contact_username` row it carries outside that bound. A file built from legacy data writes NULL for
`active_on` and no `contact_username` row.

Account moves (migration `0060_account_moves`): `accounts.moved_to_account_id` is NULL, or the 18-digit id (text of
18 ASCII digits) of another account, on a remote row only; anything else, the row's own id and a local row included,
fails with `accounts: moved_to_account_id past its stored bound`. No foreign key holds it: an id that names no account
restores as it is and presents no `moved`. A dump taken before 0060 has no such column: it restores into a Store at its
own migrations, which then upgrades. A file built from legacy data writes NULL.

Static images (migration `0061_account_static_images`): `accounts.avatar_static_url` and `header_static_url` are NULL
(the static image is the image itself), or text of at most 512 UTF-8 bytes without NUL, only on a local row whose
`avatar_url` or `header_url` respectively is set; anything else fails with `accounts: static image past its stored
bound`. Kopje writes the still preview URL of the upload the image names. A local upload's `meta` may carry
`"animated": true` beside its sizes: its served file is animated, and its preview a still. A dump taken before 0061
has no such columns: it restores into a Store at its own migrations, which then upgrades. A file built from legacy data
writes NULL.

Account warnings (migration `0062_account_warnings`): an `account_warnings` row names a local account
(`target_account_id`, a `local_accounts` row) and holds `action` `none`; `text` of at most 10,000 UTF-8 bytes with no
NUL (empty for none); `status_ids` NULL or a JSON array of at most 100 ids, each a string of 18 ASCII digits, within
2,101 bytes and with no NUL; and `created_at` as `YYYY-MM-DDTHH:MM:SS.sssZ` with an hour of 00 to 23.
`notifications.account_warning_id` is NULL, or the warning of a `moderation_warning` notification, one notification per
warning; it is shown only to the warning's target, sent by that target. The table comes after `local_accounts` and
before `notifications`, and `sqlite_sequence` carries its id counter, so a restored Store never gives a warning id
twice. A chunk past these fails with the CHECK's name (`account_warning_action`,
`account_warning_text_within_10000_bytes`, `account_warning_status_ids_within_100_ids_and_2101_bytes`,
`account_warning_created_at_iso`), `account_warnings: status_ids past its stored bound`, or a `UNIQUE` or
`FOREIGN KEY` failure. A dump taken before 0062 has neither: it restores into a Store at its own migrations, which then
upgrades. A file built from legacy data has no row and writes NULL for the column.

Status applications (migration `0064_status_applications`): `statuses.application_id` is NULL, or the client id of the
app a local original was posted through: text of 1 to 64 ASCII bytes of base64url characters (`A-Z`, `a-z`, `0-9`, `-`,
`_`), on a local original only (no boost, no remote author); anything else fails with `statuses: application_id past
its stored bound`. No foreign key holds it: an id that names no `oauth_clients` row restores as it is and presents
`application: null`. A scheduled status's `params` keep their `application_id` as written; publication records it
only when it passes the same rule. A dump taken before 0064 has no such column: it restores into a Store at its own
migrations, which then upgrades. A file built from legacy data writes NULL.

Media BlurHash (migration `0065_media_blurhash`): `media_attachments.blurhash` is NULL, or text of 6 to 54 ASCII bytes
of base83 characters (`0-9`, `A-Z`, `a-z` and `#$%*+,-.:;=?@[]^_{|}~`) whose first character gives x and y components
of 1 to 5 each (its index i in that alphabet: x = i mod 9 + 1, y = floor(i / 9) + 1) and whose length is 4 + 2xy;
anything else fails with `media_attachments: blurhash past its stored bound`. A dump taken before 0065 has no such
column: it restores into a Store at its own migrations, which then upgrades. A file built from legacy data writes NULL.

Field verification (migration `0066_field_verification`): `local_accounts.links_due_at` and `links_hold_until` are NULL
or non-negative integers (milliseconds), `links_claim` a non-negative integer and `links_attempts` an integer from 0 to
2 (CHECKs `links_due_at_time`, `links_hold_until_time`, `links_claim_count` and `links_attempts_count`); a restored open
claim is claimed again after its hold. `verified_links` is NULL, or text of at most 4,096 UTF-8 bytes with no NUL: a
JSON array of 1 to 4 pairs `[value, time]` of texts, each value 1 to 255 bytes of printable ASCII once in the array and
each time in the 24-byte ISO form; anything else fails with `local_accounts: verified_links past its stored bound`. A
dump taken before 0066 has no such columns: it restores into a Store at its own migrations, which then upgrades. A file
built from legacy data writes the defaults.

Field link checks (migration `0076_field_link_checks`): `local_accounts.unverified_links` is NULL, or text of at most
4,096 UTF-8 bytes with no NUL: a JSON array of 1 to 4 texts, each 1 to 255 bytes of printable ASCII once decoded and
once in the array (the values checked and not verified since the last save); anything else fails with
`local_accounts: unverified_links past its stored bound`. A dump taken before 0076 has no such column: it restores into
a Store at its own migrations, which then upgrades. A file built from legacy data writes NULL.

Status cards (migration `0067_status_cards`): a `status_cards` row names its status (`status_id`, 18 ASCII digits, a
`statuses` row it goes with) and is pending (`due_at` set, `fetched_at` NULL) or attached (`fetched_at` set, `due_at`
NULL, a non-empty `title`; CHECKs `status_card_pending_or_attached` and `status_card_attached_title`). `url` is
`https://` text of at most 2,048 bytes of printable ASCII without `` "<>\^`{|} ``; `author_url` and `provider_url` are
`''` or the same rule over `http(s)://` within 1,024 bytes; `title`, `description`, `author_name` and `provider_name`
texts with no NUL within 512, 1,024, 512 and 512 JSON-escaped UTF-8 bytes; `language` NULL or 2 to 7 ASCII letters
and hyphens; `published_at` NULL or the 24-byte ISO form; `due_at`, `enqueued_at`, `claim`, `generation` and
`fetched_at` integers from 0 to 2^53 − 1 and `attempts` 0 to 2. Anything else fails with `status_cards: a value past
its stored bound`. A restored open claim is claimed again after its hold. A dump taken before 0067 has no such table:
it restores into a Store at its own migrations, which then upgrades. A file built from legacy data has no row.

Card images (migration `0070_card_images`): a `status_cards` row also holds `image_url` (`''`, or the `url` rule's
`https://` text), `image_id` (NULL or 18 ASCII digits; no foreign key, and a restored one names no row, since
`card_images` is not in a dump) and `image_description` (a text with no NUL within 256 JSON-escaped UTF-8 bytes); a row
without an `image_url` has no `image_id`. Anything else fails with `status_cards: a value past its stored bound`; a
row of a dump taken before 0070 takes the defaults (no image, no alt text). A restored card is shown without an image
and is not copied to another status; a status that records the same image URL later fetches it again.

Remote field verification (migration `0068_remote_field_verification`): a `remote_field_links` row names a remote
account (`account_id`, 18 ASCII digits, an `accounts` row it goes with). `link_back` is `http(s)://` text of 1 to 2,048
bytes of printable ASCII; `links` is the canonical JSON (as SQLite's `json()` writes it, no escape) of an array of 1 to
4 entries `[index, href, verified_at, checked]`, within 4,213 UTF-8 bytes with no NUL: `index` an integer from 0 to 15,
strictly increasing; `href` `https://` text of 1 to 1,016 bytes of printable ASCII without `` "<>\^`{|} ``;
`verified_at` null or the 24-byte ISO form; `checked` 0 or 1, and 1 when `verified_at` is set. `generation` and `claim`
are integers from 0 to 2^53 − 1, `attempts` 0 to 2, and `due_at`, `armed_at`, `hold_until` and `checked_at` NULL or
integers from 0 to 2^53 − 1, `due_at` and `armed_at` set together or neither (CHECK `remote_field_links_armed`).
Anything else fails with `remote_field_links: a value past its stored bound`. A restored open claim is claimed again
after its hold. A dump taken before 0068 has no such table: it restores into a Store at its own migrations, which then
upgrades. A file built from legacy data has no row.

Card embeds (migration `0069_card_embeds`): a `status_cards` row also holds `card_type` (an integer from 0 to 2: link,
photo, video), `width` and `height` (integers from 0 to 65,535), `embed_src` (`''`, or `http://` or `https://` text of
printable ASCII without `` "<>\^`{|} `` within 512 bytes, and within 512 once each `&` counts five) and `iframe_width`
and `iframe_height` (NULL or integers from 0 to 65,535); a video and only a video has an `embed_src`, and a row
without one has both iframe dimensions NULL. Anything else fails with `status_cards: a value past its stored bound`;
a row of a dump taken before 0069 takes the defaults (a link of 0 by 0 without an embed). A `card_oembed_endpoints`
row names a host (`domain`, 1 to 253 bytes of `a-z`, `0-9`, `.` and `-`) with an endpoint `template` (`https://` text
of 1 to 2,048 bytes of printable ASCII without `` "<>\^`| ``, holding `{url}` after an `=` and no other brace) and
`expires_at`, an integer from 0 to 2^53 − 1; anything else fails with `card_oembed_endpoints: a value past its stored
bound`. It has no foreign key; a restored row is used until it expires. Expired rows, then rows written for later
than a day ahead, are deleted, at most 100 a round, so a dump's rows past the writer's 2,048 go as they expire. A file
built from legacy data has no row.

Link trends (migration `0071_link_trends`): a `status_cards` row also holds `link_type` (0 unknown or 1 article),
`final_url` (`''`, or the `url` rule's `https://` text: the fetched page's URL after redirects, the card's trend
identity) and `public` (0 or 1). `public` = 1 only on an attached row with a non-empty `final_url` whose status (the
`statuses` row restored before it) is `public`; a pending row, a row without a final URL and one under an unlisted,
private, direct or limited status hold 0, and 0 on a row that would qualify is allowed (it only hides). A card stored
before 0071 (a Store upgraded in place, or a dump taken before 0071 restored into a Store at its own migrations, which
then upgrades) takes the defaults (unknown, no final URL, not public) and never trends. `reblog_of_id` is linked
after the rows, so a card on a boost may hold 1; trends read a status's card only while the status is a public
original, so it never counts. `trend_links` rows hold a `url` by the same rule, a `domain` of 3 to 253 bytes of
`a-z`, `0-9`, `-` and `.` (two labels at least, none empty), a `language` NULL or 2 to 7 ASCII letters and hyphens,
a `score` and a `max_score` with 0 ≤ score ≤ max_score ≤ 1e15 and a 24-byte ISO `max_score_at`, at most 250 rows;
`link_trend_reviews` (a `url` by the same rule) and `link_provider_reviews` (a `domain` by the same rule) hold
`trendable` 0 or 1 and a 24-byte ISO `reviewed_at`, at most 10,000 each. They have no foreign key. Anything else fails
with `status_cards: a value past its stored bound`, `trend_links: a value past its stored bound`,
`link_trend_reviews: a value past its stored bound`, `link_provider_reviews: a value past its stored bound`,
`trend_links: more than 250` or `link_trend_reviews: more than 10000` (and the same for the publishers). The rows are
a snapshot: the next cron round works the links out again, and since a dump holds no card image, a restored copy never
qualifies and a link trends again only from cards recorded after the restore. A file built from legacy data has no
row.

Instance activity (migration `0072_activity_tracking`): an `activity_counts` row holds a `kind` (`statuses` or
`registrations`), a `day` (text of exactly 10 bytes, a calendar date `YYYY-MM-DD` with no NUL) and a `value` (an
integer from 1 to 1e12), one per kind and day; an `activity_logins` row holds a `day` by the same rule and an
`account_id` (18 ASCII digits), one per day and account. Anything else fails with `CHECK constraint failed:
activity_counts_kind`, `activity_counts_day`, `activity_counts_value`, `activity_logins_day` or
`activity_logins_account_id`. `account_id` has no foreign key: a restored day keeps an id that names no account,
which counts as any other until it expires. Days before today minus 184 or after tomorrow are deleted by the cron, at
most 500 rows of each table a run; a later day is never read. The restore itself counts nothing. A file built from
legacy data has no row. An `instance_settings` row named `activity_api_enabled` holds `true` or `false`.

Actor document revisions (migration `0073_actor_document_revision`): `accounts.document_revision` is an integer from
0 to 2^53 - 1 (INTEGER affinity stores numeric text and an integral REAL as one); anything else, NULL included, fails
with `accounts: document_revision past its stored bound`. A restored row keeps its value, and the Store's next store
of that actor's document issues another (threat-model ID-1), the maximum included. A dump taken before 0073 has no
such column: it restores into a Store at its own migrations, which then upgrades, and every row reads 0. A file built
from legacy data leaves it at 0.

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
| `card_images`                                              | Card images, re-encoded with no original kept; a restored Store shows its cards without them (`status_cards` keeps the links)                          |
| `remote_media*`                                            | The cache of remote media and its R2 ledger: a target starts with an empty cache, shows remote URLs, and fetches them again                            |
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
