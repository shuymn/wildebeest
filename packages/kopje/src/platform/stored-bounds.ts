// RES-2: the stored bounds of the columns a remote server controls or a converted row may carry. Each column has a
// projection P, the SQL builder below, and a writer that ingestion, the local write paths, the cutover's conversion and
// its verification apply. Migration 0048_stored_bounds and its triggers are generated from P, and reads take the
// columns of STORED_COLUMNS as stored; pollOptionsSql is also the read projection of polls.options. Every writer's
// output, as SQLite stores it, is a fixed point of the column's P, and P(P(x)) = P(x) for any stored string
// (test/stored-bounds.test.ts).
//
// Text writers replace a lone surrogate with U+FFFD and remove U+0000 (storedText), then cut by code points, as
// SQLite's substr and length count them. JSON-bounded columns (bio, content, content warning, source text) keep the
// writers of security/html.ts, applied to storedText's output.
//
// No relative imports: the cutover runs it from the sources on Node (cli/lib/cutover/kopje-runtime.js). The JSON
// bounds of security/html.ts and the status URI bound of identity-bounds.ts are therefore repeated here;
// test/stored-bounds.test.ts pins them equal.

// Display names, in code points.
export const DISPLAY_NAME_LIMIT = 2048;
// Profile URLs (url, avatar, header), in UTF-8 bytes; a serialized URL is ASCII.
export const PROFILE_URL_LIMIT = 2048;
// A status's url, in UTF-8 bytes, as identity-bounds.ts STATUS_URI_LIMIT bounds its uri.
export const STATUS_URL_LIMIT = 4096;
// A media URL (url, preview_url), in UTF-8 bytes, and as a presented JSON string: an href is ASCII, and JSON escapes
// none of its characters to more than two bytes (controls, spaces and quotes are percent-encoded).
export const MEDIA_URL_LIMIT = 2048;
export const MEDIA_URL_JSON_BYTES = 2 * MEDIA_URL_LIMIT + 2;
// A media row's meta, in UTF-8 bytes: the stored dimensions ({"original":{...},"small":{...}}) take about 80.
export const MEDIA_META_BYTES = 1024;
// A media description, in code points, as Mastodon's MAX_DESCRIPTION_HARD_LENGTH_LIMIT.
export const MAX_MEDIA_DESCRIPTION_LENGTH = 10_000;
// A poll's choices (RES-4): at most this many, each at most this many code points as read.
export const MAX_REMOTE_OPTIONS = 100;
export const MAX_REMOTE_OPTION_LENGTH = 1000;
// polls.options as its CHECK bounds it (migration 0013), in UTF-8 bytes; an edit's poll_options past it reads as none.
export const POLL_OPTIONS_BYTES = 655_360;
// The JSON-string bounds of security/html.ts (REMOTE_BIO_BYTES, STATUS_CONTENT_BYTES, SPOILER_BYTES), in UTF-8 bytes
// of the escaped string with its quotes.
export const BIO_JSON_BYTES = 64 * 1024;
export const CONTENT_JSON_BYTES = 128 * 1024;
export const SPOILER_JSON_BYTES = 16 * 1024;

// ---- Projections (P)

// SQLite's substr and length stop at an embedded NUL, so a string is cut only when its UTF-8 bytes pass the limit
// (a code point is never longer than its bytes). A string containing a NUL is kept whole while its UTF-8 bytes fit
// the limit; otherwise it may come out shorter than a cut in code units would be, never longer.
export function cutSql(column: string, limit: number): string {
  return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${limit} THEN ${column} ELSE substr(${column}, 1, ${limit}) END`;
}

// `column` when its JSON string (json_quote: quotes and escapes, as JSON.stringify writes them) is at most `bytes`
// UTF-8 bytes, else `over`. json_quote measures it only below the raw bound, so its escaped copy stays far below
// SQLite's largest string.
export function jsonBoundSql(column: string, bytes: number, over: string): string {
  return `CASE WHEN length(CAST(${column} AS BLOB)) > ${bytes} THEN ${over}
	WHEN length(CAST(json_quote(${column}) AS BLOB)) > ${bytes} THEN ${over} ELSE ${column} END`;
}

// A text value cut to its first `bytes` UTF-8 bytes, counted as bytes: SQLite's length and substr count characters,
// skipping continuation bytes, so a malformed imported value would pass a character cut whole. Each byte presents as
// at most six JSON bytes (a control character escaped, or a malformed byte decoded to U+FFFD: three).
export function byteCut(column: string, bytes: number): string {
  return `CAST(substr(CAST(${column} AS BLOB), 1, ${bytes}) AS TEXT)`;
}

// A NULL past `bytes` UTF-8 bytes.
export function byteBoundSql(column: string, bytes: number): string {
  return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${bytes} THEN ${column} END`;
}

// accounts.display_name: cut at DISPLAY_NAME_LIMIT code points.
export function displayNameSql(column: string): string {
  return cutSql(column, DISPLAY_NAME_LIMIT);
}

// accounts.note: '' past BIO_JSON_BYTES as a JSON string.
export function noteSql(column: string): string {
  return jsonBoundSql(column, BIO_JSON_BYTES, "''");
}

// accounts.url, avatar_url and header_url: NULL past PROFILE_URL_LIMIT.
export function profileUrlSql(column: string): string {
  return byteBoundSql(column, PROFILE_URL_LIMIT);
}

// statuses.content and status_edits.content: '' past CONTENT_JSON_BYTES as a JSON string. The status keeps its url,
// which links its original.
export function contentSql(column: string): string {
  return jsonBoundSql(column, CONTENT_JSON_BYTES, "''");
}

// statuses.source_text: '' past CONTENT_JSON_BYTES (a local one is at most 10,000 code units, 60 KB escaped).
export function sourceTextSql(column: string): string {
  return jsonBoundSql(column, CONTENT_JSON_BYTES, "''");
}

// statuses.spoiler_text and status_edits.spoiler_text: past SPOILER_JSON_BYTES, cut to the code points that fit
// however they escape (6 bytes each at most), so the warning stays.
export function spoilerSql(column: string): string {
  return jsonBoundSql(column, SPOILER_JSON_BYTES, `substr(${column}, 1, ${Math.floor((SPOILER_JSON_BYTES - 2) / 6)})`);
}

// statuses.url: NULL past STATUS_URL_LIMIT, so it reads as its uri.
export function statusUrlSql(column: string): string {
  return byteBoundSql(column, STATUS_URL_LIMIT);
}

// media_attachments.url and preview_url: NULL past MEDIA_URL_LIMIT, as an invalid one. url is NOT NULL, so its
// writer stores '' instead, which presentMedia shows as null.
export function mediaUrlSql(column: string): string {
  return byteBoundSql(column, MEDIA_URL_LIMIT);
}

// media_attachments.description: cut at MAX_MEDIA_DESCRIPTION_LENGTH code points.
export function mediaDescriptionSql(column: string): string {
  return cutSql(column, MAX_MEDIA_DESCRIPTION_LENGTH);
}

// media_attachments.meta: NULL past MEDIA_META_BYTES, as no meta.
export function mediaMetaSql(column: string): string {
  return byteBoundSql(column, MEDIA_META_BYTES);
}

// A poll's choices (polls.options, status_edits.poll_options) as a JSON array: the first MAX_REMOTE_OPTIONS, each cut
// at MAX_REMOTE_OPTION_LENGTH (cutSql); NULL (no poll) past POLL_OPTIONS_BYTES. A stored choice is longer only in a
// converted row; a vote names it as stored (polls.ts cut_options). An edit's snapshot stores P of the poll's choices,
// evaluated inside SQLite (statuses.ts recordEdit).
export function pollOptionsSql(column: string): string {
  return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${POLL_OPTIONS_BYTES} THEN
		(SELECT json_group_array(${cutSql("value", MAX_REMOTE_OPTION_LENGTH)} ORDER BY key) FROM json_each(${column})
			WHERE key < ${MAX_REMOTE_OPTIONS}) END`;
}

// ---- Writers

const ENCODER = new TextEncoder();

// `value` when its UTF-8 bytes as SQLite stores it are at most `bytes` (a lone surrogate takes three bytes, as U+FFFD
// or as workerd binds it), else none.
function withinBytes(value: string | null, bytes: number): string | null {
  return value !== null && ENCODER.encode(value).length <= bytes ? value : null;
}

// Text as stored: well-formed and without U+0000. workerd binds a lone surrogate as its three-byte surrogate encoding,
// which reads back as three U+FFFD; replaced first, it is one U+FFFD either way. Mastodon's JSON parsing refuses
// invalid UTF-8, so nothing it would keep is lost. PostgreSQL text cannot hold U+0000, so Mastodon never stores one;
// SQLite's substr and length stop at it.
export function storedText(text: string): string {
  const wellFormed = text.toWellFormed();
  return wellFormed.includes("\u0000") ? wellFormed.replaceAll("\u0000", "") : wellFormed;
}

// The first `limit` code points of `text`. A string has at least as many code units as code points.
export function cutCodePoints(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  let points = 0;
  let end = 0;
  for (const char of text) {
    if (points === limit) {
      return text.slice(0, end);
    }
    points++;
    end += char.length;
  }
  return text;
}

// accounts.display_name as stored: storedText's output, at most DISPLAY_NAME_LIMIT code points.
export function storedDisplayName(text: string): string {
  return cutCodePoints(storedText(text), DISPLAY_NAME_LIMIT);
}

// media_attachments.description as stored: storedText's output, at most MAX_MEDIA_DESCRIPTION_LENGTH code points.
export function storedMediaDescription(text: string): string {
  return cutCodePoints(storedText(text), MAX_MEDIA_DESCRIPTION_LENGTH);
}

// accounts.url, avatar_url and header_url as stored: none past PROFILE_URL_LIMIT.
export function storedProfileUrl(url: string | null): string | null {
  return withinBytes(url, PROFILE_URL_LIMIT);
}

// statuses.url as stored: none past STATUS_URL_LIMIT.
export function storedStatusUrl(url: string | null): string | null {
  return withinBytes(url, STATUS_URL_LIMIT);
}

// media_attachments.preview_url as stored, and a media URL where none is a value: none past MEDIA_URL_LIMIT.
export function storedMediaLink(url: string | null): string | null {
  return withinBytes(url, MEDIA_URL_LIMIT);
}

// media_attachments.url as stored (NOT NULL): '' past MEDIA_URL_LIMIT. A row with a file token holds a URL Kopje
// built (platform/media-files.ts mediaUrl), always within it.
export function storedMediaUrl(url: string): string {
  return storedMediaLink(url) ?? "";
}

// media_attachments.meta as stored: none past MEDIA_META_BYTES.
export function storedMediaMeta(meta: string | null): string | null {
  return withinBytes(meta, MEDIA_META_BYTES);
}

// ---- Migration 0048_stored_bounds and its triggers

// A covered column: its projection P and, where P's value cannot be stored (a NOT NULL column), what is stored.
type StoredColumn = {
  column: string;
  projection: (column: string) => string;
  // A JSON-bounded column's bound: a value of at most a sixth of it (less the quotes) in UTF-8 bytes cannot escape past
  // it, so the test skips P (and json_quote) for it.
  jsonBytes?: number;
  stored?: (column: string) => string;
};

// The columns 0048_stored_bounds and its triggers cover. accounts.uri and username, statuses.uri, status_tags.name,
// polls.options and status_edits.media_json keep their read-time projections and are not here;
// media_attachments.blurhash has triggers of its own (0065_media_blurhash).
export const STORED_COLUMNS: Readonly<Record<string, readonly StoredColumn[]>> = {
  statuses: [
    { column: "content", projection: contentSql, jsonBytes: CONTENT_JSON_BYTES },
    { column: "spoiler_text", projection: spoilerSql, jsonBytes: SPOILER_JSON_BYTES },
    { column: "source_text", projection: sourceTextSql, jsonBytes: CONTENT_JSON_BYTES },
    { column: "url", projection: statusUrlSql },
  ],
  accounts: [
    { column: "display_name", projection: displayNameSql },
    { column: "note", projection: noteSql, jsonBytes: BIO_JSON_BYTES },
    { column: "url", projection: profileUrlSql },
    { column: "avatar_url", projection: profileUrlSql },
    { column: "header_url", projection: profileUrlSql },
  ],
  media_attachments: [
    // A row with a file token holds a URL mediaUrl (media-files.ts) built within the bound; the migration checks it.
    {
      column: "url",
      projection: mediaUrlSql,
      stored: (column) => `coalesce(${mediaUrlSql(column)}, '')`,
    },
    { column: "preview_url", projection: mediaUrlSql },
    { column: "description", projection: mediaDescriptionSql },
    { column: "meta", projection: mediaMetaSql },
  ],
  status_edits: [
    { column: "content", projection: contentSql, jsonBytes: CONTENT_JSON_BYTES },
    { column: "spoiler_text", projection: spoilerSql, jsonBytes: SPOILER_JSON_BYTES },
    { column: "poll_options", projection: pollOptionsSql },
  ],
};

// The BEFORE INSERT and BEFORE UPDATE OF `watched` triggers `<prefix>_insert` and `<prefix>_update` on `table` that
// abort with `message` when `when` holds of the NEW row.
function boundTriggers(prefix: string, table: string, watched: string, when: string, message: string): string[] {
  const body = `BEGIN\n  SELECT RAISE(ABORT, '${message}');\nEND;`;
  return [
    `CREATE TRIGGER ${prefix}_insert BEFORE INSERT ON ${table}\nWHEN ${when}\n${body}`,
    `CREATE TRIGGER ${prefix}_update BEFORE UPDATE OF ${watched} ON ${table}\nWHEN ${when}\n${body}`,
  ];
}

// True when `column` is not a fixed point of its projection: P(x) IS NOT x, with JSON-bounded columns short of a sixth
// of their bound skipped before P.
function pastBoundSql({ projection, jsonBytes }: StoredColumn, column: string): string {
  const moved = `(${projection(column)}) IS NOT ${column}`;
  return jsonBytes === undefined
    ? moved
    : `CASE WHEN length(CAST(${column} AS BLOB)) <= ${Math.floor((jsonBytes - 2) / 6)} THEN 0 ELSE ${moved} END`;
}

// Migration 0048_stored_bounds after its header (test/migrations.test.ts compares them): the tokened media URL check,
// one rewrite per table, then triggers that refuse a write where P(NEW.x) IS NOT NEW.x.
export function storedBoundsMigrationSql(): string {
  const statements = [
    `CREATE TABLE stored_bounds_check (
  n INTEGER CONSTRAINT tokened_media_url_within_2048_bytes CHECK (n = 0)
);`,
    `INSERT INTO stored_bounds_check
SELECT count(*) FROM media_attachments
WHERE file_token IS NOT NULL AND length(CAST(url AS BLOB)) > ${MEDIA_URL_LIMIT};`,
    "DROP TABLE stored_bounds_check;",
  ];
  for (const [table, columns] of Object.entries(STORED_COLUMNS)) {
    const set = columns.map((c) => `  ${c.column} = ${(c.stored ?? c.projection)(c.column)}`).join(",\n");
    const where = columns.map((c) => pastBoundSql(c, c.column)).join("\n  OR ");
    statements.push(`UPDATE ${table} SET\n${set}\nWHERE ${where};`);
  }
  for (const [table, columns] of Object.entries(STORED_COLUMNS)) {
    const when = columns.map((c) => pastBoundSql(c, `NEW.${c.column}`)).join("\n  OR ");
    const names = columns.map((c) => c.column).join(", ");
    statements.push(...boundTriggers(`${table}_bounds`, table, names, when, `${table}: a value past its stored bound`));
  }
  return `${statements.join("\n\n")}\n`;
}

// ---- Instance settings: migration 0049_instance_bounds and its triggers

// The instance's public settings (instance_settings rows, data rather than configuration: access-settings.ts
// CONFIG_KEYS). Each name has a projection P, the SQL value stored for a value, NULL where no row is stored, and a
// writer, its JS twin over storedText's output. The admin write (domain/instance.ts setInstanceSettings) refuses what
// its writer would change or drop; the cutover's conversion and verification store the writer's output and count
// what it changed (cli/lib/cutover). Reads take these rows as stored.

// title, in code points (at most 4 KiB): a label, cut past the bound. Mastodon sets no limit.
export const INSTANCE_TITLE_LIMIT = 1024;
// description, in code points: Mastodon's DESCRIPTION_LIMIT (app/models/form/admin_settings.rb:86,107), cut past it.
export const INSTANCE_DESCRIPTION_LIMIT = 200;
// contact_email, in UTF-8 bytes (RFC 5321's path limit); no row past it.
export const CONTACT_EMAIL_BYTES = 254;
// rules, a JSON array, in UTF-8 bytes; no row past it (a cut array is not JSON).
export const INSTANCE_RULES_BYTES = 65_536;
// extended_description, privacy_policy and terms_of_service, HTML in UTF-8 bytes; no row past it (a cut document
// loses its end). At most 50,000 UTF-16 code units too, so security/html.ts REMOTE_HTML_RAW_LIMIT never cuts one.
export const INSTANCE_DOCUMENT_BYTES = 50_000;

export const INSTANCE_DOCUMENTS = ["extended_description", "privacy_policy", "terms_of_service"] as const;
export type InstanceDocument = (typeof INSTANCE_DOCUMENTS)[number];

// show_domain_blocks and show_domain_blocks_rationale, as Mastodon's settings (config/settings.yml:29-30).
export const DOMAIN_BLOCKS_SHOWN = ["disabled", "users", "all"] as const;
export type DomainBlocksShown = (typeof DOMAIN_BLOCKS_SHOWN)[number];

// The characters a blank value consists of, SQL's and JS's alike: space, tab, LF, VT, FF and CR. Not String#trim's
// set, which SQLite's trim cannot list (it includes U+00A0, U+3000 and the other Unicode spaces).
const BLANK_CODES = [32, 9, 10, 11, 12, 13];
const BLANK = new Set(BLANK_CODES.map((code) => String.fromCharCode(code)));

export function isBlank(text: string): boolean {
  for (const char of text) {
    if (!BLANK.has(char)) {
      return false;
    }
  }
  return true;
}

// `text` without blank characters at either end.
export function trimBlank(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && BLANK.has(text[start] ?? "")) {
    start++;
  }
  while (end > start && BLANK.has(text[end - 1] ?? "")) {
    end--;
  }
  return text.slice(start, end);
}

function blankSql(column: string): string {
  return `trim(${column}, char(${BLANK_CODES.join(", ")})) = ''`;
}

// A calendar date, YYYY-MM-DD, as SQLite's date() writes it.
function isCalendarDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return false;
  }
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

// A time as Date#toISOString writes it for years 0 to 9999 (24 bytes), as SQLite's strftime('%Y-%m-%dT%H:%M:%fZ').
export function isIsoTime(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text)) {
    return false;
  }
  const parsed = new Date(text);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === text;
}

function isJsonArray(text: string): boolean {
  try {
    return Array.isArray(JSON.parse(text));
  } catch {
    return false;
  }
}

const ISO_TIME_FORMAT = "%Y-%m-%dT%H:%M:%fZ";

// A setting's projection P and writer. `cut`, for a name cut past its bound: the value 0049 rewrites it to before it
// deletes the rows whose P is NULL.
type InstanceSettingBound = {
  projection: (column: string) => string;
  writer: (value: string) => string | null;
  cut?: (column: string) => string;
};

// Text cut at `points` code points, and no row when blank.
function cutText(points: number): InstanceSettingBound {
  return {
    projection: (column) =>
      `CASE WHEN ${blankSql(cutSql(column, points))} THEN NULL ELSE ${cutSql(column, points)} END`,
    writer: (value) => {
      const cut = cutCodePoints(storedText(value), points);
      return isBlank(cut) ? null : cut;
    },
    cut: (column) => cutSql(column, points),
  };
}

// Text of at most `bytes` UTF-8 bytes, and no row when blank or past them.
function boundedText(bytes: number): InstanceSettingBound {
  return {
    projection: (column) =>
      `CASE WHEN length(CAST(${column} AS BLOB)) > ${bytes} THEN NULL WHEN ${blankSql(column)} THEN NULL ELSE ${column} END`,
    writer: (value) => {
      const text = withinBytes(storedText(value), bytes);
      return text === null || isBlank(text) ? null : text;
    },
  };
}

// One of `values`, else no row.
function oneOf(values: readonly string[]): InstanceSettingBound {
  return {
    projection: (column) => `CASE WHEN ${column} IN (${values.map((v) => `'${v}'`).join(", ")}) THEN ${column} END`,
    writer: (value) => (values.includes(value) ? value : null),
  };
}

const DOCUMENT = boundedText(INSTANCE_DOCUMENT_BYTES);
const SHOWN = oneOf(DOMAIN_BLOCKS_SHOWN);
// A document's stamp (the time an admin write changed it): written only by setInstanceSettings. SQLite's strftime
// writes an hour of 24 back as given, which Date#toISOString never writes.
const STAMP: InstanceSettingBound = {
  projection: (column) =>
    `CASE WHEN length(CAST(${column} AS BLOB)) = 24 AND substr(${column}, 12, 2) < '24'
	AND strftime('${ISO_TIME_FORMAT}', ${column}) = ${column} THEN ${column} END`,
  writer: (value) => (isIsoTime(value) ? value : null),
};

// Every bounded name. Other names (CONFIG_KEYS, the instance actor's key, the web client) are not covered.
export const INSTANCE_SETTING_BOUNDS = {
  title: cutText(INSTANCE_TITLE_LIMIT),
  description: cutText(INSTANCE_DESCRIPTION_LIMIT),
  contact_email: boundedText(CONTACT_EMAIL_BYTES),
  rules: {
    projection: (column) =>
      `CASE WHEN length(CAST(${column} AS BLOB)) > ${INSTANCE_RULES_BYTES} THEN NULL
	WHEN json_valid(${column}) THEN CASE WHEN json_type(${column}) = 'array' THEN ${column} END END`,
    writer: (value) => {
      const text = withinBytes(storedText(value), INSTANCE_RULES_BYTES);
      return text !== null && isJsonArray(text) ? text : null;
    },
  },
  extended_description: DOCUMENT,
  privacy_policy: DOCUMENT,
  terms_of_service: DOCUMENT,
  terms_of_service_effective_date: {
    projection: (column) =>
      `CASE WHEN length(CAST(${column} AS BLOB)) = 10 AND ${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
	AND date(${column}) = ${column} THEN ${column} END`,
    writer: (value) => (isCalendarDate(value) ? value : null),
  },
  show_domain_blocks: SHOWN,
  show_domain_blocks_rationale: SHOWN,
  extended_description_updated_at: STAMP,
  privacy_policy_updated_at: STAMP,
} as const satisfies Record<string, InstanceSettingBound>;

export type InstanceSettingName = keyof typeof INSTANCE_SETTING_BOUNDS;

export const INSTANCE_SETTING_NAMES = Object.keys(INSTANCE_SETTING_BOUNDS) as InstanceSettingName[];

// The value `name` stores for `value` (storedText's output where it is text), or null for no row.
export function storedInstanceSetting(name: InstanceSettingName, value: string): string | null {
  return INSTANCE_SETTING_BOUNDS[name].writer(value);
}

// True when a row named `name` holding `value` is not a fixed point of its name's P; 0 for an uncovered name.
function settingPastBoundSql(name: string, value: string): string {
  const cases = INSTANCE_SETTING_NAMES.map(
    (n) => `WHEN '${n}' THEN (${INSTANCE_SETTING_BOUNDS[n].projection(value)}) IS NOT ${value}`,
  );
  return `CASE ${name}\n  ${cases.join("\n  ")}\n  ELSE 0 END`;
}

// Migration 0049_instance_bounds after its header (test/migrations.test.ts compares them): the cut names rewritten,
// then every row whose P is NULL deleted, then triggers that refuse a write where P(NEW.value) IS NOT NEW.value, and
// the partial index of the public block list (domain/instance-domain-blocks.ts publicDomainBlocks).
export function instanceBoundsMigrationSql(): string {
  const statements: string[] = [];
  const names = INSTANCE_SETTING_NAMES.map((n) => `'${n}'`).join(", ");
  for (const name of INSTANCE_SETTING_NAMES) {
    const { cut } = INSTANCE_SETTING_BOUNDS[name] as InstanceSettingBound;
    if (cut !== undefined) {
      statements.push(
        `UPDATE instance_settings SET value = ${cut("value")}\nWHERE name = '${name}' AND (${cut("value")}) IS NOT value;`,
      );
    }
  }
  statements.push(
    `DELETE FROM instance_settings\nWHERE name IN (${names}) AND ${settingPastBoundSql("name", "value")};`,
  );
  const when = settingPastBoundSql("NEW.name", "NEW.value");
  statements.push(
    ...boundTriggers(
      "instance_settings_bounds",
      "instance_settings",
      "name, value",
      when,
      "instance_settings: a value past its stored bound",
    ),
  );
  statements.push(
    "CREATE INDEX instance_domain_blocks_public ON instance_domain_blocks (domain) WHERE severity = 'suspend';",
  );
  return `${statements.join("\n\n")}\n`;
}

// ---- Custom emoji snapshots: migration 0053_custom_emoji_snapshots and its triggers

// statuses.emojis, status_edits.emojis and accounts.emojis (RES-2): NULL, or a JSON array of [shortcode, url] pairs in
// tag order, written by domain/custom-emojis.ts emojiSnapshot and presented by its presentEmojis. A shortcode matches
// EMOJI_SHORTCODE, as Mastodon's MAX_SHORTCODE_SIZE (app/models/custom_emoji.rb:29) and Misskey's name column
// (models/Emoji.ts) bound it; a url is http(s), at most EMOJI_URL_LIMIT bytes and within EMOJI_URL_ALPHABET, so a
// presented entry needs no JSON escape. A boost row's value is never read (status-rows.ts STATUS_COLUMN_MAP).
export const EMOJI_SHORTCODE = /^[A-Za-z0-9_+-]{1,128}$/;
export const EMOJI_SHORTCODE_LIMIT = 128;
// In UTF-8 bytes of the normalized href: Misskey's url columns hold 512 characters (models/Emoji.ts).
export const EMOJI_URL_LIMIT = 512;
// '!' to '~' but '"' and '\': a literal '\' can survive WHATWG normalization in a query or fragment.
export const EMOJI_URL_ALPHABET = /^[!#-[\]-~]+$/;
// Emoji tags examined per object (RES-1), and entries per snapshot.
export const MAX_EMOJI_TAGS = 64;
export const MAX_EMOJIS = 64;
// The presented JSON bytes of Status.emojis (and StatusEdit's, and a Poll's, a subset) and of Account.emojis; also the
// stored UTF-8 bytes of the columns. Entries are {"shortcode":n,"url":u,"static_url":u,"visible_in_picker":true}.
// For shortcode length n and URL length u, a nonempty presented array occupies
// 1 + Σ(EMOJI_ENTRY_BYTES + n + 2u) bytes, including separators (presentedEmojiBytes).
export const STATUS_EMOJIS_BYTES = 12_288;
export const ACCOUNT_EMOJIS_BYTES = 6_144;
export const EMOJI_ENTRY_BYTES = 67;

// The cached copies of a remote snapshot's emoji, read with its row (domain/remote-media.ts, MEDIA-7): for its first
// EMOJI_CACHE_LIMIT entries in snapshot order, those whose (domain, url) slot holds a stored file, a JSON array of
// [entry index, packed object] (token:ext:still_ext, at most 74 bytes); '[]' when none is cached, NULL for a local or
// empty snapshot. The limit is the Store's memory bound (RES-3): an entry past it, or one not cached, keeps its remote
// URL. Read through remote_media_emoji, one seek an entry. domain/custom-emojis.ts presents what it holds.
export const EMOJI_CACHE_LIMIT = 16;
// At most `[15,"<74>"]` and its separator an entry, and the brackets.
export const EMOJI_CACHE_BYTES = 2 + EMOJI_CACHE_LIMIT * 82;
export function emojiCacheSql(snapshot: string, domain: string): string {
  return `CASE WHEN ${domain} IS NOT NULL AND ${snapshot} IS NOT NULL THEN (SELECT json_group_array(json_array(ee.key,
		ce.token || ':' || ce.ext || ':' || COALESCE(ce.still_ext, ''))) FROM json_each(${snapshot}) ee
		CROSS JOIN remote_media ce INDEXED BY ${REMOTE_MEDIA_EMOJI_INDEX} ON ce.kind = 'emoji' AND ce.domain = ${domain}
			AND ce.url = json_extract(ee.value, '$[1]')
		WHERE ee.key < ${EMOJI_CACHE_LIMIT} AND ce.token IS NOT NULL) END`;
}

// The remote media category of an attachment's type (a slot's `category`): image, video (gifv too) or audio; NULL for
// unknown, which is never cached. remoteMediaCategory is the same rule in code.
export function mediaCategorySql(type: string): string {
  return `CASE ${type} WHEN 'image' THEN 'image' WHEN 'gifv' THEN 'video' WHEN 'video' THEN 'video' WHEN 'audio' THEN 'audio' END`;
}

export function remoteMediaCategory(type: string): "image" | "video" | "audio" | null {
  return type === "image" ? "image" : type === "gifv" || type === "video" ? "video" : type === "audio" ? "audio" : null;
}

// The window of a status's attachment rows (`status` its id's SQL) its removal reads for cache slots at a time:
// MEDIA_SLOT_WINDOW of them, local uploads included, as media_attachments_status holds them, so what is read stays
// bounded however many rows of either kind the status has; the conditions are judged inside it. The removal's media
// steps take rows from the same front (inbox.ts STATUS_CHILDREN), so the window moves as they go.
export const MEDIA_SLOT_WINDOW = 64;
export function statusMediaWindowSql(status: string): string {
  return `SELECT id, file_token FROM media_attachments INDEXED BY media_attachments_status WHERE status_id = ${status}
		LIMIT ${MEDIA_SLOT_WINDOW}`;
}

// Whether the slot `r` is the current one of the remote attachment row `m`: its file (kind attachment, the row's url
// and the category of its current type) or its icon (kind thumbnail, the row's preview_url), byte for byte. The one
// rule the cache's eligibility (domain/remote-media.ts slotOwnsSql) and the presenter (mediaCacheSql) share.
export function mediaSlotOwnsSql(r: string, m: string): string {
  return `(${m}.file_token IS NULL AND ${m}.account_id = ${r}.account_id
		AND CASE ${r}.kind
			WHEN 'attachment' THEN CAST(${m}.url AS BLOB) = CAST(${r}.url AS BLOB) AND ${mediaCategorySql(`${m}.type`)} = ${r}.category
			WHEN 'thumbnail' THEN CAST(${m}.preview_url AS BLOB) = CAST(${r}.url AS BLOB)
			ELSE 0 END)`;
}

// The cached copy of the remote attachment row `m`'s `kind` (its file, or its icon) as a packed object
// (token:ext:still_ext, at most 74 bytes), or NULL: its slot through remote_media_owner, one seek, while it is the
// current one (mediaSlotOwnsSql) and holds a stored file. Read with the row (status-rows.ts STATUS_MEDIA_COLUMN_MAP).
export function mediaCacheSql(m: string, kind: "attachment" | "thumbnail"): string {
  return `(SELECT rc.token || ':' || rc.ext || ':' || COALESCE(rc.still_ext, '') FROM remote_media rc
		INDEXED BY ${REMOTE_MEDIA_OWNER_INDEX} WHERE rc.owner_id = ${m}.id AND rc.kind = '${kind}' AND rc.token IS NOT NULL
			AND ${mediaSlotOwnsSql("rc", m)})`;
}

// The presented JSON bytes of `pairs` as Status.emojis: none needs an escape (EMOJI_SHORTCODE, EMOJI_URL_ALPHABET).
export function presentedEmojiBytes(pairs: readonly (readonly [string, string])[]): number {
  return pairs.length === 0
    ? 2
    : 1 + pairs.reduce((sum, [n, u]) => sum + EMOJI_ENTRY_BYTES + n.length + 2 * u.length, 0);
}

// Whether `url` may be stored and presented as an emoji's: http(s), within EMOJI_URL_LIMIT and EMOJI_URL_ALPHABET.
export function isEmojiUrl(url: string): boolean {
  return url.length <= EMOJI_URL_LIMIT && EMOJI_URL_ALPHABET.test(url) && /^https?:\/\/./.test(url);
}

// The JS twin of emojisPastBoundSql: whether `text`, as stored, is a snapshot within `bytes` (NULL is).
export function emojisValid(text: string | null, bytes: number): boolean {
  if (text === null) {
    return true;
  }
  if (text.includes("\u0000") || new TextEncoder().encode(text).length > bytes) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_EMOJIS) {
    return false;
  }
  const names = new Set<string>();
  const pairs: [string, string][] = [];
  for (const entry of parsed as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      return false;
    }
    const [name, url] = entry as unknown[];
    if (typeof name !== "string" || typeof url !== "string" || !EMOJI_SHORTCODE.test(name) || !isEmojiUrl(url)) {
      return false;
    }
    if (names.has(name)) {
      return false;
    }
    names.add(name);
    pairs.push([name, url]);
  }
  return presentedEmojiBytes(pairs) <= bytes;
}

// True when `column` holds a value emojisValid refuses: false for NULL, true for a value that is not text. Judged as
// stored: the byte bound first, so nothing else scans a value past it; then a raw NUL anywhere (SQLite's JSON
// functions stop at one, so a complete value followed by NUL and anything would pass them); then the shape, each
// element (`->>` decodes escapes, and a decoded name or url whose bytes and characters differ holds a NUL or a
// non-ASCII character), the names once each, and the presented size.
export function emojisPastBoundSql(column: string, bytes: number): string {
  const name = "e.value ->> '$[0]'";
  const url = "e.value ->> '$[1]'";
  const element = `CASE WHEN e.type <> 'array' THEN 1
		WHEN json_array_length(e.value) <> 2 THEN 1
		WHEN json_type(e.value, '$[0]') <> 'text' OR json_type(e.value, '$[1]') <> 'text' THEN 1
		WHEN length(CAST(${name} AS BLOB)) NOT BETWEEN 1 AND ${EMOJI_SHORTCODE_LIMIT} THEN 1
		WHEN length(CAST(${name} AS BLOB)) <> length(${name}) THEN 1
		WHEN ${name} GLOB '*[^A-Za-z0-9_+-]*' THEN 1
		WHEN length(CAST(${url} AS BLOB)) > ${EMOJI_URL_LIMIT} THEN 1
		WHEN length(CAST(${url} AS BLOB)) <> length(${url}) THEN 1
		WHEN NOT (${url} GLOB 'https://?*' OR ${url} GLOB 'http://?*') THEN 1
		WHEN ${url} GLOB '*[^!-~]*' OR ${url} GLOB '*["\\]*' THEN 1
		ELSE 0 END`;
  return `CASE WHEN ${column} IS NULL THEN 0
	WHEN typeof(${column}) <> 'text' THEN 1
	WHEN length(CAST(${column} AS BLOB)) > ${bytes} THEN 1
	WHEN instr(CAST(${column} AS BLOB), X'00') > 0 THEN 1
	WHEN NOT json_valid(${column}) THEN 1
	WHEN json_type(${column}) <> 'array' THEN 1
	WHEN json_array_length(${column}) NOT BETWEEN 1 AND ${MAX_EMOJIS} THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(${column}) e WHERE ${element}) THEN 1
	WHEN (SELECT count(DISTINCT ${name}) FROM json_each(${column}) e) <> json_array_length(${column}) THEN 1
	WHEN 1 + (SELECT sum(${EMOJI_ENTRY_BYTES} + length(${name}) + 2 * length(${url})) FROM json_each(${column}) e)
		> ${bytes} THEN 1
	ELSE 0 END`;
}

// The snapshot columns and their stored bounds.
export const EMOJI_COLUMNS: Readonly<Record<"statuses" | "status_edits" | "accounts", number>> = {
  statuses: STATUS_EMOJIS_BYTES,
  status_edits: STATUS_EMOJIS_BYTES,
  accounts: ACCOUNT_EMOJIS_BYTES,
};

// Migration 0053_custom_emoji_snapshots after its header (test/migrations.test.ts compares them): the three columns,
// added without a default or CHECK so no row is read, then triggers that refuse a write where emojisPastBoundSql holds.
export function emojiBoundsMigrationSql(): string {
  const statements = Object.keys(EMOJI_COLUMNS).map((table) => `ALTER TABLE ${table} ADD COLUMN emojis TEXT;`);
  for (const [table, bytes] of Object.entries(EMOJI_COLUMNS)) {
    const when = emojisPastBoundSql("NEW.emojis", bytes);
    statements.push(
      ...boundTriggers(`${table}_emojis`, table, "emojis", when, `${table}: emojis past their stored bound`),
    );
  }
  return `${statements.join("\n\n")}\n`;
}

// ---- Local custom emoji: migration 0055_local_custom_emojis

// custom_emojis.shortcode (RES-2): 2 to 128 ASCII letters, digits and underscores, as Mastodon's SHORTCODE_ONLY_RE,
// MINIMUM_SHORTCODE_SIZE and MAX_SHORTCODE_SIZE for a local emoji (app/models/custom_emoji.rb:28-38, 50-51). A subset
// of EMOJI_SHORTCODE, so a local snapshot passes the 0053 triggers.
export const LOCAL_EMOJI_SHORTCODE = /^[A-Za-z0-9_]{2,128}$/;
// custom_emojis.category: at most this many code points within EMOJI_CATEGORY_BYTES UTF-8 bytes, with no C0 control
// or DEL. The CHECK bounds the stored bytes only: SQLite cannot judge UTF-8 well-formedness, so presentedCategory
// judges the decoded value again.
export const EMOJI_CATEGORY_LENGTH = 64;
export const EMOJI_CATEGORY_BYTES = 256;
// Enabled local emoji at most (RES-3: the whole list is one answer); disabled ones are not counted.
export const MAX_ENABLED_EMOJIS = 1000;

// oxlint-disable-next-line no-control-regex
const CATEGORY_CONTROL = /[\u0000-\u001f\u007f]/;

// Whether `items` (a string's code points, a segmenter's graphemes) yields more than `max`, reading no further than the
// one past it.
export function yieldsMoreThan(items: Iterable<unknown>, max: number): boolean {
  const iterator = items[Symbol.iterator]();
  for (let count = 0; !iterator.next().done;) {
    if (++count > max) {
      return true;
    }
  }
  return false;
}

// Whether `text`, as decoded, is a category that may be stored and presented: well-formed, 1 to EMOJI_CATEGORY_LENGTH
// code points within EMOJI_CATEGORY_BYTES UTF-8 bytes, and no C0 control or DEL.
export function isEmojiCategory(text: string): boolean {
  if (text === "" || text.length > EMOJI_CATEGORY_BYTES || !text.isWellFormed() || CATEGORY_CONTROL.test(text)) {
    return false;
  }
  if (yieldsMoreThan(text, EMOJI_CATEGORY_LENGTH)) {
    return false;
  }
  return ENCODER.encode(text).length <= EMOJI_CATEGORY_BYTES;
}

// A category from the admin API: made well-formed (workerd stores a bound lone surrogate as its three-byte encoding,
// which no check of the stored bytes would see), trimmed, then judged. null for an empty value (no category);
// undefined when it is refused.
export function storedEmojiCategory(raw: string): string | null | undefined {
  const text = raw.toWellFormed().trim();
  if (text === "") {
    return null;
  }
  return isEmojiCategory(text) ? text : undefined;
}

// A stored category as it is presented: the value when isEmojiCategory holds for it as decoded, else none (an
// imported value of malformed UTF-8 can pass the CHECK and decode to more, or to replacement characters).
export function presentedCategory(stored: string | null): string | null {
  return stored !== null && isEmojiCategory(stored) ? stored : null;
}

// ---- Announcements: migration 0056_announcements

// announcements.text (RES-1, RES-2): plain text as the Access admin wrote it, 1 to ANNOUNCEMENT_TEXT_BYTES UTF-8 bytes,
// with no NUL, not blank. A text within the bytes decodes to at most as many UTF-16 code units (a malformed byte
// becomes one U+FFFD), so it never passes status-text.ts MAX_RAW_LENGTH when presented.
export const ANNOUNCEMENT_TEXT_BYTES = 10_000;
// Announcements at most, and published or scheduled ones at most (RES-3, RES-4: the list holds every published one).
export const MAX_ANNOUNCEMENTS = 1000;
export const MAX_LIVE_ANNOUNCEMENTS = 16;
// announcement_reactions.name, in UTF-8 bytes, judged before the emoji pattern runs (RES-2); names per announcement
// (Mastodon's ReactionValidator::LIMIT).
export const REACTION_NAME_BYTES = 128;
export const MAX_REACTION_NAMES = 8;

// Plain text an admin write stores, or null when it is refused: made well-formed (a bound lone surrogate would be
// stored as its three-byte encoding), then refused when it holds a NUL or its UTF-8 passes `bytes` (a string of more
// code units than `bytes` passes them without being encoded).
function adminPlainText(raw: string, bytes: number): string | null {
  const text = raw.toWellFormed();
  if (text.includes("\u0000") || text.length > bytes) {
    return null;
  }
  return ENCODER.encode(text).length <= bytes ? text : null;
}

// The text an announcement stores, or null when it is refused: adminPlainText's, also refused when blank after
// JavaScript's trim (which removes every character SQLite's ASCII trim of the CHECK does, and Unicode spaces).
export function storedAnnouncementText(raw: string): string | null {
  const text = adminPlainText(raw, ANNOUNCEMENT_TEXT_BYTES);
  return text === null || text.trim() === "" ? null : text;
}

// ---- Trends: migration 0057_trends

// trend_tags and trend_statuses rows at most: TREND_ALLOWED_ROWS the round keeps allowed and TREND_REVIEW_POOL awaiting
// review or rejected (RES-4); TREND_STATUSES_PER_AUTHOR rows of one author; decisions per review table.
export const TREND_ALLOWED_ROWS = 200;
export const TREND_REVIEW_POOL = 50;
export const MAX_TREND_TAGS = TREND_ALLOWED_ROWS + TREND_REVIEW_POOL;
export const MAX_TREND_STATUSES = TREND_ALLOWED_ROWS + TREND_REVIEW_POOL;
export const TREND_STATUSES_PER_AUTHOR = 3;
export const MAX_TREND_REVIEWS = 10_000;
// A stored score and peak at most (the round clamps what it scores; RES-2).
export const TREND_SCORE_MAX = 1e15;
// A trend or review tag name (RES-2): 1 to TREND_TAG_NAME_BYTES UTF-8 bytes, no NUL, at most TREND_TAG_NAME_LENGTH
// characters as SQLite's length counts them, and no ASCII but what a normalized hashtag holds (0-9, _ and a-z;
// tag-name.ts normalizeTag). The GLOB pattern is 14 bytes (workerd refuses one over 50).
export const TREND_TAG_NAME_BYTES = 1024;
export const TREND_TAG_NAME_LENGTH = 256;

// The name rule over `column`, as the CHECKs of 0057 write it and the round filters a status's hashtags with it.
export function trendTagNameCheckSql(column: string): string {
  return `typeof(${column}) = 'text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${TREND_TAG_NAME_BYTES}
    AND instr(CAST(${column} AS BLOB), x'00') = 0 AND length(${column}) <= ${TREND_TAG_NAME_LENGTH}
    AND ${column} NOT GLOB ('*[' || char(1) || '-/:-^\`{-' || char(127) || ']*')`;
}

// The trends settings (Mastodon's `trends` and `trendable_by_default`, config/settings.yml), 'true' or 'false', bound
// by the triggers of 0057 rather than 0049's (whose literal stays instanceBoundsMigrationSql's).
export const TREND_SETTING_BOUNDS = {
  trends: oneOf(["true", "false"]),
  trendable_by_default: oneOf(["true", "false"]),
} as const satisfies Record<string, InstanceSettingBound>;

export type TrendSettingName = keyof typeof TREND_SETTING_BOUNDS;

// ---- The contact account and activity: migration 0059_contact_and_activity

// contact_username (Mastodon's site_contact_username, config/settings.yml): the address of an account Kopje knows,
// `username` for a local one or `username@domain`, as the admin write stores it (domain/instance.ts). In UTF-8 bytes:
// a username of at most REMOTE_USERNAME_LIMIT (identity-bounds.ts, repeated here; test/stored-bounds.test.ts pins
// them equal), `@` and a domain name of at most 253. P checks the storage class, then the bytes, then NUL, then the
// structure: only ASCII letters, digits and `-._@`, one `@` at most and at neither end, and a username part of at most
// REMOTE_USERNAME_LIMIT bytes. Each GLOB pattern is at most 19 bytes (workerd refuses one over 50).
export const CONTACT_USERNAME_LIMIT = 255;
export const CONTACT_USERNAME_BYTES = CONTACT_USERNAME_LIMIT + 1 + 253;

const CONTACT_ALPHABET = /^[-.0-9@A-Z_a-z]+$/;

// True when a text `column` (no NUL, within the bytes) breaks the structure: a character outside the alphabet, `@` at
// either end or more than one, or a username part past CONTACT_USERNAME_LIMIT. CASE-free, for the migration's DELETE.
function contactStructurePastSql(column: string): string {
  return `${column} = '' OR ${column} GLOB '*[^-.0-9@A-Z_a-z]*' OR ${column} GLOB '@*' OR ${column} GLOB '*@'
	OR ${column} GLOB '*@*@*'
	OR (instr(${column}, '@') = 0 AND length(${column}) > ${CONTACT_USERNAME_LIMIT})
	OR instr(${column}, '@') - 1 > ${CONTACT_USERNAME_LIMIT}`;
}

function contactUsernameSql(column: string): string {
  return `CASE WHEN typeof(${column}) <> 'text' THEN NULL
	WHEN length(CAST(${column} AS BLOB)) > ${CONTACT_USERNAME_BYTES} THEN NULL
	WHEN instr(CAST(${column} AS BLOB), x'00') > 0 THEN NULL
	WHEN ${contactStructurePastSql(column)} THEN NULL
	ELSE ${column} END`;
}

// True when `column` is not a fixed point of P (P(x) IS NOT x), written without CASE so a migration's DELETE may use it
// (test/migration-lint.test.ts); test/stored-bounds.test.ts holds the two equal.
export function contactUsernamePastBoundSql(column: string): string {
  return `${column} IS NOT NULL AND (typeof(${column}) <> 'text'
	OR length(CAST(${column} AS BLOB)) > ${CONTACT_USERNAME_BYTES}
	OR instr(CAST(${column} AS BLOB), x'00') > 0
	OR ${contactStructurePastSql(column)})`;
}

// P's JS twin: the value itself, or null where P is NULL.
export function storedContactUsername(value: string): string | null {
  if (ENCODER.encode(value).length > CONTACT_USERNAME_BYTES || !CONTACT_ALPHABET.test(value)) {
    return null;
  }
  const parts = value.split("@");
  return parts.length > 2 || parts.some((part) => part === "") || parts[0]!.length > CONTACT_USERNAME_LIMIT
    ? null
    : value;
}

// Bound by the triggers of 0059 rather than 0049's or 0057's.
export const CONTACT_SETTING_BOUNDS = {
  contact_username: { projection: contactUsernameSql, writer: storedContactUsername },
} as const satisfies Record<string, InstanceSettingBound>;

export type ContactSettingName = keyof typeof CONTACT_SETTING_BOUNDS;

// Mastodon's `activity_api_enabled` (config/settings.yml), 'true' or 'false', bound by the triggers of 0072
// (activityMigrationSql); no row reads as 'true', Mastodon's default.
export const ACTIVITY_SETTING_BOUNDS = {
  activity_api_enabled: oneOf(["true", "false"]),
} as const satisfies Record<string, InstanceSettingBound>;

type ActivitySettingName = keyof typeof ACTIVITY_SETTING_BOUNDS;

export type StoredSettingName = InstanceSettingName | TrendSettingName | ContactSettingName | ActivitySettingName;

function settingBound(name: StoredSettingName): InstanceSettingBound {
  if (name in TREND_SETTING_BOUNDS) {
    return TREND_SETTING_BOUNDS[name as TrendSettingName];
  }
  if (name in ACTIVITY_SETTING_BOUNDS) {
    return ACTIVITY_SETTING_BOUNDS[name as ActivitySettingName];
  }
  return name in CONTACT_SETTING_BOUNDS
    ? CONTACT_SETTING_BOUNDS[name as ContactSettingName]
    : INSTANCE_SETTING_BOUNDS[name as InstanceSettingName];
}

// The value `name` stores for `value` (null: no row), through 0049's bounds, 0057's, 0059's or 0072's.
export function storedSetting(name: StoredSettingName, value: string): string | null {
  return settingBound(name).writer(value);
}

// The projection of a stored setting `name` over `column`, through 0049's bounds, 0057's, 0059's or 0072's.
export function settingProjectionSql(name: StoredSettingName, column: string): string {
  return settingBound(name).projection(column);
}

// local_accounts.active_on: the UTC day of the account's last authenticated request (domain/auth.ts noteActivity),
// NULL or a calendar date YYYY-MM-DD of 10 bytes, held by a CHECK for imports too.
export const ACTIVE_ON_CHECK = "active_on_date";

// A UTC day as the CHECKs of 0059 (active_on) and 0072 (the activity tables) hold it: text, exactly 10 bytes, no NUL,
// then the structure YYYY-MM-DD of a calendar date (date() reads it back as itself). The GLOB pattern is 44 bytes.
function utcDayCheckSql(column: string): string {
  return `typeof(${column}) = 'text'
    AND length(CAST(${column} AS BLOB)) = 10 AND instr(CAST(${column} AS BLOB), x'00') = 0
    AND ${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(${column}) IS ${column}`;
}

// The UTC day of `now` as utcDayCheckSql accepts it, or null for a time outside the years 0 to 9999.
export function utcDay(now: number): string | null {
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const day = date.toISOString().slice(0, 10);
  return isCalendarDate(day) ? day : null;
}

// Migration 0059_contact_and_activity after its header (test/migrations.test.ts compares them): the column, an existing
// contact_username row that is not a fixed point of P deleted (a dump restored before 0059 may carry one), then the
// triggers.
export function contactActivityMigrationSql(): string {
  const when = `NEW.name = 'contact_username' AND (${contactUsernamePastBoundSql("NEW.value")})`;
  return `${[
    `ALTER TABLE local_accounts ADD COLUMN active_on TEXT
  CONSTRAINT ${ACTIVE_ON_CHECK} CHECK (active_on IS NULL OR (${utcDayCheckSql("active_on")}));`,
    `DELETE FROM instance_settings\nWHERE name = 'contact_username' AND (${contactUsernamePastBoundSql("value")});`,
    "-- 0049's triggers end in ELSE 0 and 0057's name only the trends settings; these bound contact_username.",
    ...boundTriggers(
      "instance_settings_contact",
      "instance_settings",
      "name, value",
      when,
      "instance_settings: a value past its stored bound",
    ),
  ].join("\n\n")}\n`;
}

// A stored time read as the 24-byte ISO form Kopje writes (hour 00 to 23, read back by strftime as itself), else NULL:
// the bytes judged before strftime reads the value, so a long imported value costs one length.
export function isoTimeSql(column: string): string {
  return `(${STAMP.projection(column)})`;
}

// ---- Profile credentials: migration 0058_profile_credentials

// accounts.indexable as stored: NULL (a remote account not stored again since 0058), or the integer 0 or 1. True when
// `column` holds anything else: the type first (an integer has no bytes to bound or NUL to hold), then the value.
export function indexablePastBoundSql(column: string): string {
  return `CASE WHEN ${column} IS NULL THEN 0
	WHEN typeof(${column}) <> 'integer' THEN 1
	WHEN ${column} NOT IN (0, 1) THEN 1
	ELSE 0 END`;
}

// Migration 0058_profile_credentials after its header (test/migrations.test.ts compares them): accounts.indexable,
// added without a default or CHECK so no row is read, with triggers that refuse a write where indexablePastBoundSql
// holds; and the unlock acceptance cursor (domain/unlock-accepts.ts), whose CHECK reads the local accounts only.
export function profileBoundsMigrationSql(): string {
  return `${[
    "ALTER TABLE accounts ADD COLUMN indexable INTEGER;",
    `ALTER TABLE local_accounts ADD COLUMN accept_requests_after INTEGER
  CONSTRAINT accept_requests_after_cursor CHECK (accept_requests_after IS NULL
    OR (typeof(accept_requests_after) = 'integer' AND accept_requests_after >= 0));`,
    ...boundTriggers(
      "accounts_indexable",
      "accounts",
      "indexable",
      indexablePastBoundSql("NEW.indexable"),
      "accounts: indexable past its stored bound",
    ),
  ].join("\n\n")}\n`;
}

// ---- Account moves: migration 0060_account_moves

// accounts.moved_to_account_id: NULL, or the 18-digit id of another account, on a remote row only (Mastodon's
// Account#moved_to_account_id, set from the actor document's movedTo and by a verified Move: domain/inbox.ts). No
// foreign key holds it: the purge of a remote account clears the references to it first (PURGED_ACCOUNT_REFERENCES in
// domain/inbox.ts). True when `NEW` holds anything else, judged in order: the storage class, the bytes, NUL, the
// structure (digits only), then the row (another account's id, and a remote row).
export const MOVED_TO_ID_BYTES = 18;

export function movedToPastBoundSql(row: string): string {
  const column = `${row}.moved_to_account_id`;
  return `CASE WHEN ${column} IS NULL THEN 0
	WHEN typeof(${column}) <> 'text' THEN 1
	WHEN length(CAST(${column} AS BLOB)) <> ${MOVED_TO_ID_BYTES} THEN 1
	WHEN instr(CAST(${column} AS BLOB), x'00') > 0 THEN 1
	WHEN ${column} GLOB '*[^0-9]*' THEN 1
	WHEN ${column} = ${row}.id THEN 1
	WHEN ${row}.domain IS NULL THEN 1
	ELSE 0 END`;
}

// The partial index the purge's clearing step and completion check seek references through.
export const MOVED_TO_INDEX = "accounts_moved_to";

// Migration 0060_account_moves after its header (test/migrations.test.ts compares them): the column, added without a
// default or CHECK so no row is read; its partial index; and triggers that refuse a write where movedToPastBoundSql
// holds.
export function accountMovesMigrationSql(): string {
  return `${[
    "ALTER TABLE accounts ADD COLUMN moved_to_account_id TEXT;",
    `CREATE INDEX ${MOVED_TO_INDEX} ON accounts (moved_to_account_id) WHERE moved_to_account_id IS NOT NULL;`,
    ...boundTriggers(
      "accounts_moved_to",
      "accounts",
      "moved_to_account_id, domain",
      movedToPastBoundSql("NEW"),
      "accounts: moved_to_account_id past its stored bound",
    ),
  ].join("\n\n")}\n`;
}

// ---- Account static images: migration 0061_account_static_images

// accounts.avatar_static_url and header_static_url: NULL ("the same as the image"), or the still preview URL of the
// upload the image names (domain/media.ts profileAssignSql), in UTF-8 bytes. Kopje's preview URLs are mediaUrl's
// (platform/media-files.ts): 'https://', a host of at most 253 bytes, ':65535', '/media/', a token of at most 64 bytes
// and '/small.webp' make at most 349, so a longer one is not copied and the account shows its image.
export const STATIC_URL_LIMIT = 512;

// The WHEN lines that judge one stored static value, in order: the storage class (TEXT affinity stores a number as
// its text, so only a BLOB is refused), the raw bytes (an imported value may be malformed UTF-8, which length counts
// as fewer characters), then NUL.
function staticValueCases(value: string): string {
  return `WHEN ${value} IS NULL THEN 0
	WHEN typeof(${value}) <> 'text' THEN 1
	WHEN length(CAST(${value} AS BLOB)) > ${STATIC_URL_LIMIT} THEN 1
	WHEN instr(CAST(${value} AS BLOB), x'00') > 0 THEN 1`;
}

// True when `value` is no static value accounts may store: what the writer judges before it copies a preview URL.
export function staticUrlPastBoundSql(value: string): string {
  return `CASE ${staticValueCases(value)}
	ELSE 0 END`;
}

// True when `row` holds a static past its stored bound, or one where the structure allows none: on a remote row (a
// remote document never sets one, ID-3), or without its image.
export function staticImagesPastBoundSql(row: string): string {
  return (["avatar", "header"] as const)
    .map(
      (image) => `CASE ${staticValueCases(`${row}.${image}_static_url`)}
	WHEN ${row}.domain IS NOT NULL THEN 1
	WHEN ${row}.${image}_url IS NULL THEN 1
	ELSE 0 END`,
    )
    .join("\n\tOR ");
}

// Migration 0061_account_static_images after its header (test/migrations.test.ts compares them): the two columns,
// added without a default or CHECK so no row is read, and triggers that refuse a write where staticImagesPastBoundSql
// holds. Every existing row holds NULL in both, which is within the bound.
export function accountStaticImagesMigrationSql(): string {
  return `${[
    "ALTER TABLE accounts ADD COLUMN avatar_static_url TEXT;",
    "ALTER TABLE accounts ADD COLUMN header_static_url TEXT;",
    ...boundTriggers(
      "accounts_static_images",
      "accounts",
      "avatar_url, header_url, avatar_static_url, header_static_url, domain",
      staticImagesPastBoundSql("NEW"),
      "accounts: static image past its stored bound",
    ),
  ].join("\n\n")}\n`;
}

// ---- Account warnings: migrations 0062_account_warnings and 0063_account_warning_notifications_key

// account_warnings.text (RES-1, RES-2): the admin's plain text as sent, at most WARNING_TEXT_BYTES UTF-8 bytes with no
// NUL; empty when none was sent. Mastodon sets no bound (and a NUL is its 500). Within the bytes it decodes to at most
// as many UTF-16 code units, a malformed byte becoming one U+FFFD.
export const WARNING_TEXT_BYTES = 10_000;
// account_warnings.status_ids: NULL, or a JSON array of at most WARNING_STATUS_IDS 18-digit status ids (the report's
// own bound, MAX_REPORT_STATUSES in domain/reports.ts), so at most WARNING_STATUS_IDS_BYTES of '[', ']', the quoted ids
// and their commas.
export const WARNING_STATUS_IDS = 100;
export const WARNING_STATUS_ID_BYTES = 18;
export const WARNING_STATUS_IDS_BYTES = 2 + WARNING_STATUS_IDS * (WARNING_STATUS_ID_BYTES + 3) - 1;

// The text an admin action stores (adminPlainText at WARNING_TEXT_BYTES), or null when it is refused (422).
export function storedWarningText(raw: string): string | null {
  return adminPlainText(raw, WARNING_TEXT_BYTES);
}

const WARNING_STATUS_ID = /^[0-9]{18}$/;

// The writer twin of warningStatusIdsPastBoundSql: the ids of stored status_ids, or null for none or when the rule
// refuses them (a restored report is bound only by its own CHECK, which does not judge the elements; a warning's own
// are held by its triggers, so the presenter never throws on one). Judged in the trigger's order: bytes, NUL, JSON,
// array, length, elements.
export function warningStatusIdsOf(raw: string | null): string[] | null {
  if (raw === null || raw.length > WARNING_STATUS_IDS_BYTES || raw.includes("\u0000")) {
    return null;
  }
  if (ENCODER.encode(raw).length > WARNING_STATUS_IDS_BYTES) {
    return null;
  }
  let ids: unknown;
  try {
    ids = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(ids) || ids.length > WARNING_STATUS_IDS) {
    return null;
  }
  return ids.every((id): id is string => typeof id === "string" && WARNING_STATUS_ID.test(id)) ? ids : null;
}

// The status_ids a warning stores for a report's stored status_ids, as JSON.stringify writes the ids warningStatusIdsOf
// accepts (within the bytes when they pass), or null.
export function storedWarningStatusIds(raw: string | null): string | null {
  const ids = warningStatusIdsOf(raw);
  return ids === null ? null : JSON.stringify(ids);
}

// The scalar parts of the status_ids bound, held by a CHECK for imports too: the storage class, the raw bytes (an
// imported value may be malformed UTF-8, which length counts as fewer characters), NUL, then the JSON structure.
// json_type and json_array_length run only on valid JSON (AND stops at the first false operand).
export function warningStatusIdsCheckSql(column: string): string {
  return `${column} IS NULL OR (typeof(${column}) = 'text'
      AND length(CAST(${column} AS BLOB)) <= ${WARNING_STATUS_IDS_BYTES} AND instr(CAST(${column} AS BLOB), x'00') = 0
      AND json_valid(${column}) AND json_type(${column}) = 'array'
      AND json_array_length(${column}) <= ${WARNING_STATUS_IDS})`;
}

// True when `column` holds status_ids past the bound, judged in order: the CHECK's scalar parts, then every element an
// 18-digit decimal id as TEXT, judged on its decoded bytes, then NUL (a JSON escape decodes to a NUL that GLOB stops
// at), then digits (a CHECK may not read json_each, so triggers judge the elements, as 0053 does).
export function warningStatusIdsPastBoundSql(column: string): string {
  return `CASE WHEN ${column} IS NULL THEN 0
	WHEN typeof(${column}) <> 'text' THEN 1
	WHEN length(CAST(${column} AS BLOB)) > ${WARNING_STATUS_IDS_BYTES} THEN 1
	WHEN instr(CAST(${column} AS BLOB), x'00') > 0 THEN 1
	WHEN NOT json_valid(${column}) THEN 1
	WHEN json_type(${column}) <> 'array' THEN 1
	WHEN json_array_length(${column}) > ${WARNING_STATUS_IDS} THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(${column}) e WHERE e.type <> 'text'
		OR length(CAST(e.value AS BLOB)) <> ${WARNING_STATUS_ID_BYTES} OR instr(CAST(e.value AS BLOB), x'00') > 0
		OR e.value GLOB '*[^0-9]*') THEN 1
	ELSE 0 END`;
}

// The partial unique index of the notification of each warning (LocalNotificationWorker keys it by its activity, the
// warning); its `account_warning_id = ?` serves the foreign key.
export const NOTIFICATIONS_WARNING_INDEX = "notifications_account_warning";

// Migration 0062_account_warnings after its header (test/migrations.test.ts compares them): the table with its CHECKs
// and cascade index, triggers that refuse a write where warningStatusIdsPastBoundSql holds, then the notification's
// column, added without a default or CHECK so no row is read, and its partial unique index.
export function accountWarningsMigrationSql(): string {
  return `${[
    `CREATE TABLE account_warnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_account_id TEXT NOT NULL REFERENCES local_accounts (account_id) ON DELETE CASCADE,
  action TEXT NOT NULL CONSTRAINT account_warning_action CHECK (action = 'none'),
  text TEXT NOT NULL DEFAULT '' CONSTRAINT account_warning_text_within_${WARNING_TEXT_BYTES}_bytes
    CHECK (typeof(text) = 'text' AND length(CAST(text AS BLOB)) <= ${WARNING_TEXT_BYTES}
      AND instr(CAST(text AS BLOB), x'00') = 0),
  status_ids TEXT
    CONSTRAINT account_warning_status_ids_within_${WARNING_STATUS_IDS}_ids_and_${WARNING_STATUS_IDS_BYTES}_bytes
    CHECK (${warningStatusIdsCheckSql("status_ids")}),
  created_at TEXT NOT NULL CONSTRAINT account_warning_created_at_iso
    CHECK (typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at AND substr(created_at, 12, 2) BETWEEN '00' AND '23')
);`,
    "CREATE INDEX account_warnings_target ON account_warnings (target_account_id);",
    ...boundTriggers(
      "account_warnings_status_ids",
      "account_warnings",
      "status_ids",
      warningStatusIdsPastBoundSql("NEW.status_ids"),
      "account_warnings: status_ids past its stored bound",
    ),
    "ALTER TABLE notifications ADD COLUMN account_warning_id INTEGER REFERENCES account_warnings (id) ON DELETE CASCADE;",
    `CREATE UNIQUE INDEX ${NOTIFICATIONS_WARNING_INDEX} ON notifications (account_warning_id)
  WHERE account_warning_id IS NOT NULL;`,
  ].join("\n\n")}\n`;
}

// ---- Status applications: migration 0064_status_applications

// statuses.application_id: NULL, or the client_id of the app a local original was posted through (Mastodon's
// Status#application_id, AUTH-6: the credential's client), in UTF-8 bytes. Kopje's client ids are 43 base64url
// characters (security/tokens.ts randomToken) and a converted legacy client's a UUID, so 64 holds both. No foreign key
// holds it (Mastodon has none, schema.rb): removing an app writes no status row, and an id whose app is gone reads as
// no app (RES-6). True when `row` holds anything else, judged in order: the storage class, the bytes, NUL, the
// structure (base64url characters), then the row (a boost, or a remote author: Mastodon records an app on neither).
export const APP_ID_BYTES = 64;
const APP_ID = new RegExp(`^[A-Za-z0-9_-]{1,${APP_ID_BYTES}}$`);

export function applicationIdPastBoundSql(row: string): string {
  const column = `${row}.application_id`;
  return `CASE WHEN ${column} IS NULL THEN 0
	WHEN typeof(${column}) <> 'text' THEN 1
	WHEN length(CAST(${column} AS BLOB)) NOT BETWEEN 1 AND ${APP_ID_BYTES} THEN 1
	WHEN instr(CAST(${column} AS BLOB), x'00') > 0 THEN 1
	WHEN ${column} GLOB '*[^0-9A-Za-z_-]*' THEN 1
	WHEN ${row}.reblog_of_id IS NOT NULL THEN 1
	WHEN (SELECT a.domain FROM accounts a WHERE a.id = ${row}.account_id) IS NOT NULL THEN 1
	ELSE 0 END`;
}

// The application_id a local original stores for the client `value`: it when the bound's value cases accept it, else
// none (the post is written without an app rather than refused).
export function storedApplicationId(value: unknown): string | null {
  return typeof value === "string" && APP_ID.test(value) ? value : null;
}

// The bounds of an app's name and website as a status presents them (REST::StatusSerializer's application).
// A name: APP_NAME_LIMIT code points (Mastodon's ApplicationExtension APP_NAME_LIMIT), so at most APP_NAME_BYTES UTF-8
// bytes and APP_NAME_JSON_BYTES as a JSON string. A website: APP_WEBSITE_LIMIT UTF-8 bytes (isAppWebsite).
export const APP_NAME_LIMIT = 60;
export const APP_NAME_BYTES = 4 * APP_NAME_LIMIT;
export const APP_NAME_JSON_BYTES = 6 * APP_NAME_LIMIT + 2;
export const APP_WEBSITE_LIMIT = 2000;
export const APP_WEBSITE_JSON_BYTES = 2 * APP_WEBSITE_LIMIT + 2;

// The characters no app website may hold, those that end or split an HTML attribute or a URL in common parsers: C0
// controls, the space, DEL, C1 controls (U+0085 NEL is not in \s), other whitespace (\s), and " ' < > \ ^ ` { | }.
// None needs escaping in JSON.
// oxlint-disable-next-line no-control-regex
const WEBSITE_EXCLUDED = /[\u0000-\u0020\u007f-\u009f"'<>\\^`{|}]|\s/u;

// Whether `text`, as decoded, is an app website registration accepts and a status presents as stored: well-formed (so
// its JSON is its UTF-8 bytes and the quotes) with no excluded character, within APP_WEBSITE_LIMIT UTF-8 bytes and
// APP_WEBSITE_JSON_BYTES as JSON, and an http(s) URL with a host by the WHATWG parser. Mastodon's UrlValidator
// (Addressable::URI.parse, an http(s) scheme and a host) may accept some of the excluded characters
// (docs/mastodon-deviations.md, Posting).
export function isAppWebsite(text: string): boolean {
  if (text.length > APP_WEBSITE_LIMIT || !text.isWellFormed() || WEBSITE_EXCLUDED.test(text)) {
    return false;
  }
  if (
    ENCODER.encode(text).length > APP_WEBSITE_LIMIT ||
    ENCODER.encode(JSON.stringify(text)).length > APP_WEBSITE_JSON_BYTES
  ) {
    return false;
  }
  try {
    const url = new URL(text);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}

// The read projections of oauth_clients.name and website for a status (RES-2): NULL for another storage class (no JSON
// function sees a BLOB) or past the raw bytes a presented value may hold, so a row reads at most APP_NAME_BYTES and
// APP_WEBSITE_LIMIT bytes of them whatever was imported. The presenter judges the decoded value again
// (presentedAppName, isAppWebsite): malformed bytes decode to U+FFFD, three bytes each.
export function appNameSql(column: string): string {
  return `CASE WHEN typeof(${column}) = 'text' THEN ${byteBoundSql(column, APP_NAME_BYTES)} END`;
}

export function appWebsiteSql(column: string): string {
  return `CASE WHEN typeof(${column}) = 'text' THEN ${byteBoundSql(column, APP_WEBSITE_LIMIT)} END`;
}

// A stored app name as a status presents it: the name when, as decoded, it is 1 to APP_NAME_LIMIT code points within
// APP_NAME_BYTES UTF-8 bytes and APP_NAME_JSON_BYTES as a JSON string, with no U+0000 (which no registration keeps:
// storedText's rule), else none.
export function presentedAppName(name: string | null): string | null {
  if (name === null || name === "" || name.length > APP_NAME_BYTES || name.includes("\u0000")) {
    return null;
  }
  if (yieldsMoreThan(name, APP_NAME_LIMIT)) {
    return null;
  }
  return ENCODER.encode(name).length <= APP_NAME_BYTES &&
    ENCODER.encode(JSON.stringify(name)).length <= APP_NAME_JSON_BYTES
    ? name
    : null;
}

// Migration 0064_status_applications after its header (test/migrations.test.ts compares them): the column, added
// without a default or CHECK so no row is read, and triggers that refuse a write where applicationIdPastBoundSql holds.
// Every existing row holds NULL, which is within the bound.
export function statusApplicationsMigrationSql(): string {
  return `${[
    "ALTER TABLE statuses ADD COLUMN application_id TEXT;",
    ...boundTriggers(
      "statuses_application",
      "statuses",
      "application_id, reblog_of_id, account_id",
      applicationIdPastBoundSql("NEW"),
      "statuses: application_id past its stored bound",
    ),
  ].join("\n\n")}\n`;
}

// media_attachments.blurhash: NULL, or a BlurHash Mastodon's MediaAttachmentParser#supported_blurhash? keeps (its
// parser/media_attachment_parser.rb, the blurhash gem's Blurhash.components): base83 characters, x and y components
// of 1 to 5 each (the size flag, its first character: x = flag mod 9 + 1, y = floor(flag / 9) + 1), and 4 + 2xy
// characters, so 6 to BLURHASH_BYTES ASCII bytes. Mastodon's character check is line-anchored (Ruby's ^ and $), so it
// keeps a valid first line followed by anything; Kopje checks the whole string (docs/mastodon-deviations.md, Media).
// True when `value` holds anything else, judged in order: the storage class, the bytes, NUL, the structure (base83
// only, which also makes the string ASCII), the size flag, then the length.
export const BLURHASH_BYTES = 54;
export const BLURHASH_MIN = 6;
export const BASE83 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~";
const BLURHASH = new RegExp(`^[0-9A-Za-z#$%*+,\\-.:;=?@[\\]^_{|}~]{${BLURHASH_MIN},${BLURHASH_BYTES}}$`);
const BLURHASH_COMPONENTS = 5;

export function blurhashPastBoundSql(value: string): string {
  return `CASE WHEN ${value} IS NULL THEN 0
	WHEN typeof(${value}) <> 'text' THEN 1
	WHEN length(CAST(${value} AS BLOB)) NOT BETWEEN ${BLURHASH_MIN} AND ${BLURHASH_BYTES} THEN 1
	WHEN instr(CAST(${value} AS BLOB), x'00') > 0 THEN 1
	WHEN rtrim(${value}, '${BASE83}') <> '' THEN 1
	WHEN (SELECT f % 9 >= ${BLURHASH_COMPONENTS} OR f / 9 >= ${BLURHASH_COMPONENTS}
			OR length(${value}) <> 4 + 2 * (f % 9 + 1) * (f / 9 + 1)
		FROM (SELECT instr('${BASE83}', substr(${value}, 1, 1)) - 1 AS f)) THEN 1
	ELSE 0 END`;
}

// The blurhash a remote attachment stores for the value it was sent with: it when the bound's value cases accept it,
// else none (the attachment is stored without one rather than refused). The presenter applies it again to what it
// reads, so an imported value it would refuse is never shown.
export function storedBlurhash(value: unknown): string | null {
  if (typeof value !== "string" || !BLURHASH.test(value)) {
    return null;
  }
  const flag = BASE83.indexOf(value[0]!);
  const x = (flag % 9) + 1;
  const y = Math.floor(flag / 9) + 1;
  return x <= BLURHASH_COMPONENTS && y <= BLURHASH_COMPONENTS && value.length === 4 + 2 * x * y ? value : null;
}

// Migration 0065_media_blurhash after its header (test/migrations.test.ts compares them): the column, added without a
// default or CHECK so no row is read, and triggers that refuse a write where blurhashPastBoundSql holds. Every existing
// row holds NULL, which is within the bound. No row condition: Mastodon keeps a blurhash on local and remote media.
export function mediaBlurhashMigrationSql(): string {
  return `${[
    "ALTER TABLE media_attachments ADD COLUMN blurhash TEXT;",
    ...boundTriggers(
      "media_attachments_blurhash",
      "media_attachments",
      "blurhash",
      blurhashPastBoundSql("NEW.blurhash"),
      "media_attachments: blurhash past its stored bound",
    ),
  ].join("\n\n")}\n`;
}

// ---- Field verification: migration 0066_field_verification

// Mastodon's limits for local fields (Account::DEFAULT_FIELDS_SIZE, 255 characters each): what Kopje's writer stores
// and presentation keeps (accounts.ts fieldSources), in code points.
export const MAX_FIELDS = 4;
export const MAX_FIELD_NAME = 255;
export const MAX_FIELD_VALUE = 255;

// local_accounts.fields as the verification reads it (domain/field-links.ts): at most LOCAL_FIELDS_BYTES UTF-8 bytes,
// which hold Kopje's writer at its worst (4 fields of 255-character names and values, each character a control that
// JSON escapes to six bytes: test/field-links.test.ts computes it), and at most LOCAL_FIELDS elements. Only a converted
// or imported row can hold more; it is never verified, and its fields are presented by fieldSources' rule.
export const LOCAL_FIELDS_BYTES = 16_384;
/** @alias */
export const LOCAL_FIELDS = MAX_FIELDS;
// A verifiable value, in UTF-8 bytes: the value limit (Account::Field::MAX_CHARACTERS_LOCAL) of printable ASCII, one
// byte each.
/** @alias */
export const FIELD_LINK_VALUE_BYTES = MAX_FIELD_VALUE;
// local_accounts.verified_links: NULL, or a JSON array of 1 to VERIFIED_LINKS [value, verified at] pairs, one per
// distinct value, within VERIFIED_LINKS_BYTES (at most 4 × (2 + 2 × 255 + 3 + 26) + 5 = 2,169 bytes of JSON when every
// value character escapes to two bytes).
const VERIFIED_LINKS = MAX_FIELDS;
export const VERIFIED_LINKS_BYTES = 4096;
// local_accounts.links_attempts: claims of an account's links since the last finish (domain/field-links.ts).
export const FIELD_LINK_MAX_ATTEMPTS = 2;

// `column` when it is fields presentation reads (accounts.ts fieldSources): text of at most LOCAL_FIELDS_BYTES raw
// bytes with no raw NUL, else NULL. Its structure is judged in the Worker, which keeps the entries Kopje's writer
// produces.
export function presentedLocalFieldsSql(column: string): string {
  return `CASE WHEN typeof(${column}) = 'text' AND length(CAST(${column} AS BLOB)) <= ${LOCAL_FIELDS_BYTES}
		AND instr(CAST(${column} AS BLOB), x'00') = 0 THEN ${column} END`;
}

// `column` when it is fields the verification reads, else NULL: the storage class, the raw bytes, a raw NUL (SQLite's
// JSON functions stop at one, so a valid array followed by NUL and anything would pass them), then the structure.
export function boundedLocalFieldsSql(column: string): string {
  return `CASE WHEN typeof(${column}) = 'text' AND length(CAST(${column} AS BLOB)) <= ${LOCAL_FIELDS_BYTES}
		AND instr(CAST(${column} AS BLOB), x'00') = 0 AND json_valid(${column}) AND json_type(${column}) = 'array'
		AND json_array_length(${column}) <= ${LOCAL_FIELDS} THEN ${column} END`;
}

// Whether the decoded text `value` is a value the verification may hold: 1 to FIELD_LINK_VALUE_BYTES bytes, no NUL
// (a JSON escape decodes to one, which GLOB stops at), printable ASCII only (so its bytes are its characters).
export function fieldLinkValueSql(value: string): string {
  return `(length(CAST(${value} AS BLOB)) BETWEEN 1 AND ${FIELD_LINK_VALUE_BYTES}
		AND instr(CAST(${value} AS BLOB), x'00') = 0 AND ${value} NOT GLOB '*[^!-~]*')`;
}

// True when `column` holds verified_links past its bound, judged in order: the storage class, the raw bytes, a raw
// NUL, the structure (a JSON array of 1 to VERIFIED_LINKS elements, each a pair of texts), each value by its decoded
// bytes (fieldLinkValueSql), each time by isoTimeSql, then the values once each.
export function verifiedLinksPastBoundSql(column: string): string {
  const value = "e.value ->> '$[0]'";
  const at = "e.value ->> '$[1]'";
  const element = `CASE WHEN e.type <> 'array' THEN 1
		WHEN json_array_length(e.value) <> 2 THEN 1
		WHEN json_type(e.value, '$[0]') <> 'text' OR json_type(e.value, '$[1]') <> 'text' THEN 1
		WHEN NOT ${fieldLinkValueSql(value)} THEN 1
		WHEN ${isoTimeSql(at)} IS NULL THEN 1
		ELSE 0 END`;
  return `CASE WHEN ${column} IS NULL THEN 0
	WHEN typeof(${column}) <> 'text' THEN 1
	WHEN length(CAST(${column} AS BLOB)) > ${VERIFIED_LINKS_BYTES} THEN 1
	WHEN instr(CAST(${column} AS BLOB), x'00') > 0 THEN 1
	WHEN NOT json_valid(${column}) THEN 1
	WHEN json_type(${column}) <> 'array' THEN 1
	WHEN json_array_length(${column}) NOT BETWEEN 1 AND ${VERIFIED_LINKS} THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(${column}) e WHERE ${element}) THEN 1
	WHEN (SELECT count(DISTINCT ${value}) FROM json_each(${column}) e) <> json_array_length(${column}) THEN 1
	ELSE 0 END`;
}

// A non-negative integer column's CHECK, within `max` when given.
function countCheck(column: string, nullable: boolean, max?: number): string {
  const range = max === undefined ? `${column} >= 0` : `${column} BETWEEN 0 AND ${max}`;
  const bounded = `typeof(${column}) = 'integer' AND ${range}`;
  return nullable ? `${column} IS NULL OR (${bounded})` : bounded;
}

// Migration 0066_field_verification after its header (test/migrations.test.ts compares them): the scheduling columns
// with CHECKs (each ALTER scans the local accounts to check its own), and verified_links, added without a default or
// CHECK, with triggers that refuse a write where verifiedLinksPastBoundSql holds. Every existing row holds NULL or the
// default, within the bounds.
export function fieldVerificationMigrationSql(): string {
  return `${[
    `ALTER TABLE local_accounts ADD COLUMN links_due_at INTEGER
  CONSTRAINT links_due_at_time CHECK (${countCheck("links_due_at", true)});`,
    `ALTER TABLE local_accounts ADD COLUMN links_hold_until INTEGER
  CONSTRAINT links_hold_until_time CHECK (${countCheck("links_hold_until", true)});`,
    `ALTER TABLE local_accounts ADD COLUMN links_claim INTEGER NOT NULL DEFAULT 0
  CONSTRAINT links_claim_count CHECK (${countCheck("links_claim", false)});`,
    `ALTER TABLE local_accounts ADD COLUMN links_attempts INTEGER NOT NULL DEFAULT 0
  CONSTRAINT links_attempts_count CHECK (${countCheck("links_attempts", false, FIELD_LINK_MAX_ATTEMPTS)});`,
    "ALTER TABLE local_accounts ADD COLUMN verified_links TEXT;",
    ...boundTriggers(
      "local_accounts_verified_links",
      "local_accounts",
      "verified_links",
      verifiedLinksPastBoundSql("NEW.verified_links"),
      "local_accounts: verified_links past its stored bound",
    ),
  ].join("\n\n")}\n`;
}

// ---- Unverified field links: migration 0076_field_link_checks

// local_accounts.unverified_links: NULL, or a JSON array of 1 to UNVERIFIED_LINKS distinct values (texts, each
// fieldLinkValueSql), within UNVERIFIED_LINKS_BYTES raw UTF-8 bytes (at most 4 × (2 + 2 × 255) + 5 = 2,053 bytes of
// JSON when every value character escapes to two bytes).
const UNVERIFIED_LINKS = LOCAL_FIELDS;
export const UNVERIFIED_LINKS_BYTES = 4096;

// True when `column` holds unverified_links past its bound, judged in order: the storage class, the raw bytes, a raw
// NUL, the structure (a JSON array of 1 to UNVERIFIED_LINKS elements), each element a text by its decoded bytes
// (fieldLinkValueSql), then the values once each.
export function unverifiedLinksPastBoundSql(column: string): string {
  return `CASE WHEN ${column} IS NULL THEN 0
	WHEN typeof(${column}) <> 'text' THEN 1
	WHEN length(CAST(${column} AS BLOB)) > ${UNVERIFIED_LINKS_BYTES} THEN 1
	WHEN instr(CAST(${column} AS BLOB), x'00') > 0 THEN 1
	WHEN NOT json_valid(${column}) THEN 1
	WHEN json_type(${column}) <> 'array' THEN 1
	WHEN json_array_length(${column}) NOT BETWEEN 1 AND ${UNVERIFIED_LINKS} THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(${column}) e WHERE e.type <> 'text' OR NOT ${fieldLinkValueSql("e.value")}) THEN 1
	WHEN (SELECT count(DISTINCT e.value) FROM json_each(${column}) e) <> json_array_length(${column}) THEN 1
	ELSE 0 END`;
}

// Migration 0076_field_link_checks after its header (test/migrations.test.ts compares them): unverified_links, added
// without a default or CHECK so no row is read or rewritten, and triggers that refuse a write where
// unverifiedLinksPastBoundSql holds. Every existing row holds NULL.
export function fieldLinkChecksMigrationSql(): string {
  return `${[
    "ALTER TABLE local_accounts ADD COLUMN unverified_links TEXT;",
    ...boundTriggers(
      "local_accounts_unverified_links",
      "local_accounts",
      "unverified_links",
      unverifiedLinksPastBoundSql("NEW.unverified_links"),
      "local_accounts: unverified_links past its stored bound",
    ),
  ].join("\n\n")}\n`;
}

// ---- Status cards: migration 0067_status_cards

// status_cards (domain/link-cards.ts): one row per public or unlisted original status, pending or attached, holding
// the card's fields (Mastodon's PreviewCard and PreviewCardsStatus, as one copy per status). Bounds, each in its unit:
// url, author_url and provider_url in UTF-8 bytes (a serialized URL is ASCII; url is web-page.ts WEB_PAGE_URL_LIMIT,
// test/link-cards.test.ts pins them equal); the texts as JSON-escaped UTF-8 bytes with their quotes, so a stored text
// is at most two fewer raw bytes; language in UTF-8 bytes (mn-Mong, the longest of trend-languages.ts TREND_LANGUAGES).
// Mastodon bounds only the url (PreviewCard validates no text); the others are Kopje's, set so a status with its cards
// stays within RES-3's budgets (test/status-bounds.test.ts, the table of maxima).
export const CARD_URL_LIMIT = 2048;
export const CARD_OPTIONAL_URL_LIMIT = 1024;
export const CARD_TITLE_JSON_BYTES = 512;
export const CARD_DESCRIPTION_JSON_BYTES = 1024;
export const CARD_NAME_JSON_BYTES = 512;
export const CARD_LANGUAGE_BYTES = 7;
// status_cards.attempts: claims of a pending row since it was enqueued or released (domain/link-cards.ts).
export const CARD_MAX_ATTEMPTS = 2;
// The largest counter or time in ms a row holds: a JavaScript safe integer, so each crosses RPC whole.
export const SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;

// A counter or time column as read: an integer within 0..`max`, else NULL (link-cards.ts, remote-field-links.ts).
export function storedCountSql(column: string, max = SAFE_INTEGER_MAX): string {
  return `CASE WHEN typeof(${column}) = 'integer' AND ${column} BETWEEN 0 AND ${max} THEN ${column} END`;
}

// The card's texts with their bounds, in column order.
export const CARD_TEXTS = {
  title: CARD_TITLE_JSON_BYTES,
  description: CARD_DESCRIPTION_JSON_BYTES,
  author_name: CARD_NAME_JSON_BYTES,
  provider_name: CARD_NAME_JSON_BYTES,
} as const;
export type CardText = keyof typeof CARD_TEXTS;

// The characters no stored or presented card URL holds besides controls, spaces and non-ASCII: those that end or split
// an HTML attribute or a URL. One GLOB pattern of 13 bytes (workerd refuses one over 50).
const CARD_URL_EXCLUDED_GLOB = '*["<>\\^`{|}]*';

// The WHEN lines that refuse `value` as a card text of at most `jsonBytes`, in order: the storage class, the raw bytes,
// NUL, then the JSON-escaped bytes (json_quote escapes as JSON.stringify does).
function cardTextCases(value: string, jsonBytes: number): string {
  return `WHEN typeof(${value}) <> 'text' THEN 1
	WHEN length(CAST(${value} AS BLOB)) > ${jsonBytes - 2} THEN 1
	WHEN instr(CAST(${value} AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(${value}) AS BLOB)) > ${jsonBytes} THEN 1`;
}

// True when `value` is no card text of at most `jsonBytes`: the rule the triggers and the writers share.
export function cardTextPastSql(value: string, jsonBytes: number): string {
  return `CASE ${cardTextCases(value, jsonBytes)}
	ELSE 0 END`;
}

// The WHEN lines that refuse `value` as a card URL, in order: the storage class, the raw bytes, NUL, then the
// structure: https (for the card's url) or http(s) (`optional`, which may also be ''), printable ASCII only, and none
// of CARD_URL_EXCLUDED_GLOB's characters.
function cardUrlCases(value: string, optional: boolean): string {
  const scheme = optional
    ? `NOT (${value} GLOB 'https://?*' OR ${value} GLOB 'http://?*')`
    : `${value} NOT GLOB 'https://?*'`;
  return `WHEN typeof(${value}) <> 'text' THEN 1
	WHEN length(CAST(${value} AS BLOB)) > ${optional ? CARD_OPTIONAL_URL_LIMIT : CARD_URL_LIMIT} THEN 1
	WHEN instr(CAST(${value} AS BLOB), x'00') > 0 THEN 1${optional ? `\n\tWHEN ${value} = '' THEN 0` : ""}
	WHEN ${scheme} THEN 1
	WHEN ${value} GLOB '*[^!-~]*' THEN 1
	WHEN ${value} GLOB '${CARD_URL_EXCLUDED_GLOB}' THEN 1`;
}

// True when `value` is no card URL (optional: author_url or provider_url, which may be '').
export function cardUrlPastSql(value: string, optional: boolean): string {
  return `CASE ${cardUrlCases(value, optional)}
	ELSE 0 END`;
}

// True when `value` is no stored language: NULL is one; else 2 to CARD_LANGUAGE_BYTES ASCII letters and hyphens.
export function cardLanguagePastSql(value: string): string {
  return `CASE WHEN ${value} IS NULL THEN 0
	WHEN typeof(${value}) <> 'text' THEN 1
	WHEN length(CAST(${value} AS BLOB)) NOT BETWEEN 2 AND ${CARD_LANGUAGE_BYTES} THEN 1
	WHEN instr(CAST(${value} AS BLOB), x'00') > 0 THEN 1
	WHEN ${value} GLOB '*[^A-Za-z-]*' THEN 1
	ELSE 0 END`;
}

// A counter or time column's case: an integer from 0 to `max` (NULL too when nullable).
function cardCountCase(value: string, nullable: boolean, max: number): string {
  const refused = `typeof(${value}) <> 'integer' OR ${value} NOT BETWEEN 0 AND ${max}`;
  return nullable ? `WHEN ${value} IS NOT NULL AND (${refused}) THEN 1` : `WHEN ${refused} THEN 1`;
}

// The WHEN condition of migration 0067's triggers, frozen as released: its file is compared by bytes
// (test/migrations.test.ts), so it reads none of the current bounds or predicates, which later migrations may change.
const STATUS_CARDS_0067_WHEN = `CASE WHEN typeof(NEW.status_id) <> 'text' THEN 1
	WHEN length(CAST(NEW.status_id AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(NEW.status_id AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.status_id GLOB '*[^0-9]*' THEN 1
	WHEN CASE WHEN typeof(NEW.url) <> 'text' THEN 1
	WHEN length(CAST(NEW.url AS BLOB)) > 2048 THEN 1
	WHEN instr(CAST(NEW.url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.url NOT GLOB 'https://?*' THEN 1
	WHEN NEW.url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.url GLOB '*["<>\\^\`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.due_at IS NOT NULL AND (typeof(NEW.due_at) <> 'integer' OR NEW.due_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN typeof(NEW.enqueued_at) <> 'integer' OR NEW.enqueued_at NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.claim) <> 'integer' OR NEW.claim NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.attempts) <> 'integer' OR NEW.attempts NOT BETWEEN 0 AND 2 THEN 1
	WHEN typeof(NEW.generation) <> 'integer' OR NEW.generation NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN NEW.fetched_at IS NOT NULL AND (typeof(NEW.fetched_at) <> 'integer' OR NEW.fetched_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN CASE WHEN typeof(NEW.title) <> 'text' THEN 1
	WHEN length(CAST(NEW.title AS BLOB)) > 510 THEN 1
	WHEN instr(CAST(NEW.title AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.title) AS BLOB)) > 512 THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.description) <> 'text' THEN 1
	WHEN length(CAST(NEW.description AS BLOB)) > 1022 THEN 1
	WHEN instr(CAST(NEW.description AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.description) AS BLOB)) > 1024 THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.author_name) <> 'text' THEN 1
	WHEN length(CAST(NEW.author_name AS BLOB)) > 510 THEN 1
	WHEN instr(CAST(NEW.author_name AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.author_name) AS BLOB)) > 512 THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.provider_name) <> 'text' THEN 1
	WHEN length(CAST(NEW.provider_name AS BLOB)) > 510 THEN 1
	WHEN instr(CAST(NEW.provider_name AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.provider_name) AS BLOB)) > 512 THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.author_url) <> 'text' THEN 1
	WHEN length(CAST(NEW.author_url AS BLOB)) > 1024 THEN 1
	WHEN instr(CAST(NEW.author_url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.author_url = '' THEN 0
	WHEN NOT (NEW.author_url GLOB 'https://?*' OR NEW.author_url GLOB 'http://?*') THEN 1
	WHEN NEW.author_url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.author_url GLOB '*["<>\\^\`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.provider_url) <> 'text' THEN 1
	WHEN length(CAST(NEW.provider_url AS BLOB)) > 1024 THEN 1
	WHEN instr(CAST(NEW.provider_url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.provider_url = '' THEN 0
	WHEN NOT (NEW.provider_url GLOB 'https://?*' OR NEW.provider_url GLOB 'http://?*') THEN 1
	WHEN NEW.provider_url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.provider_url GLOB '*["<>\\^\`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN NEW.language IS NULL THEN 0
	WHEN typeof(NEW.language) <> 'text' THEN 1
	WHEN length(CAST(NEW.language AS BLOB)) NOT BETWEEN 2 AND 7 THEN 1
	WHEN instr(CAST(NEW.language AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.language GLOB '*[^A-Za-z-]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.published_at IS NOT NULL AND (CASE WHEN length(CAST(NEW.published_at AS BLOB)) = 24 AND substr(NEW.published_at, 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.published_at) = NEW.published_at THEN NEW.published_at END) IS NULL THEN 1
	ELSE 0 END`;

// The WHEN lines that refuse the row `row` by the rules 0067_status_cards introduced, column by column in order:
// status_id (an 18-digit snowflake as TEXT, as statuses.id), url, the counters and times, the texts, the optional
// URLs, language and published_at (isoTimeSql), over the current bounds and predicates.
function statusCardBaseCases(row: string): string {
  const c = (name: string) => `${row}.${name}`;
  const texts = Object.entries(CARD_TEXTS).map(([name, bytes]) => `WHEN ${cardTextPastSql(c(name), bytes)} THEN 1`);
  return `WHEN typeof(${c("status_id")}) <> 'text' THEN 1
	WHEN length(CAST(${c("status_id")} AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(${c("status_id")} AS BLOB), x'00') > 0 THEN 1
	WHEN ${c("status_id")} GLOB '*[^0-9]*' THEN 1
	WHEN ${cardUrlPastSql(c("url"), false)} THEN 1
	${cardCountCase(c("due_at"), true, SAFE_INTEGER_MAX)}
	${cardCountCase(c("enqueued_at"), false, SAFE_INTEGER_MAX)}
	${cardCountCase(c("claim"), false, SAFE_INTEGER_MAX)}
	${cardCountCase(c("attempts"), false, CARD_MAX_ATTEMPTS)}
	${cardCountCase(c("generation"), false, SAFE_INTEGER_MAX)}
	${cardCountCase(c("fetched_at"), true, SAFE_INTEGER_MAX)}
	${texts.join("\n\t")}
	WHEN ${cardUrlPastSql(c("author_url"), true)} THEN 1
	WHEN ${cardUrlPastSql(c("provider_url"), true)} THEN 1
	WHEN ${cardLanguagePastSql(c("language"))} THEN 1
	WHEN ${c("published_at")} IS NOT NULL AND ${isoTimeSql(c("published_at"))} IS NULL THEN 1`;
}

// A stored card text as presented: the value when, as decoded, it is a string of at most `jsonBytes` code units,
// well-formed, with no U+0000, within `jsonBytes` - 2 UTF-8 bytes and `jsonBytes` as a JSON string, else ''. An
// imported value of malformed UTF-8 can pass the triggers and decode to more (U+FFFD, three bytes each).
export function presentedCardText(value: unknown, jsonBytes: number): string {
  if (typeof value !== "string" || value.length > jsonBytes || !value.isWellFormed() || value.includes("\u0000")) {
    return "";
  }
  return ENCODER.encode(value).length <= jsonBytes - 2 && ENCODER.encode(JSON.stringify(value)).length <= jsonBytes
    ? value
    : "";
}

// What no presented card URL holds as decoded: C0 controls, the space, DEL, C1 controls, U+FFFD (a stored value that
// is not well-formed UTF-8 decodes to it), other whitespace, and the characters of CARD_URL_EXCLUDED_GLOB.
// oxlint-disable-next-line no-control-regex
const CARD_URL_REFUSED = /[\u0000-\u0020\u007f-\u009f\ufffd"<>\\^`{|}]|\s/u;

// A stored card URL as presented (HTML-3): judged as decoded (a string of at most `limit` code units,
// well-formed, no refused character, within `limit` UTF-8 bytes), then normalized (an http(s) URL by the WHATWG
// parser, its href within `limit` bytes and `limit` + 2 as a JSON string). Else null. `limit`: CARD_URL_LIMIT for the
// card's url, CARD_OPTIONAL_URL_LIMIT for author_url and provider_url.
export function presentedCardUrl(value: unknown, limit = CARD_URL_LIMIT): string | null {
  if (
    typeof value !== "string" ||
    value.length > limit ||
    !value.isWellFormed() ||
    CARD_URL_REFUSED.test(value) ||
    ENCODER.encode(value).length > limit
  ) {
    return null;
  }
  let href: string;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    href = url.href;
  } catch {
    return null;
  }
  return href.length <= limit && ENCODER.encode(JSON.stringify(href)).length <= limit + 2 ? href : null;
}

// The partial indexes of status_cards (domain/link-cards.ts names them in INDEXED BY).
export const CARD_DUE_INDEX = "status_cards_due";
export const CARD_EXPIRY_INDEX = "status_cards_expiry";
export const CARD_CLAIMED_INDEX = "status_cards_claimed";
export const CARD_FRESH_INDEX = "status_cards_fresh";

// The columns 0067's update trigger watches (frozen with it).
const STATUS_CARDS_0067_COLUMNS = [
  "status_id",
  "url",
  "due_at",
  "enqueued_at",
  "claim",
  "attempts",
  "generation",
  "title",
  "description",
  "author_name",
  "author_url",
  "provider_name",
  "provider_url",
  "language",
  "published_at",
  "fetched_at",
];

// Migration 0067_status_cards after its header (test/migrations.test.ts compares them), frozen as released:
// the empty table with its structural CHECKs, its four partial indexes, and triggers that refuse a write where
// STATUS_CARDS_0067_WHEN holds.
export function statusCardsMigrationSql(): string {
  return `${[
    `CREATE TABLE status_cards (
  status_id TEXT NOT NULL PRIMARY KEY REFERENCES statuses (id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  due_at INTEGER,
  enqueued_at INTEGER NOT NULL,
  claim INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  author_name TEXT NOT NULL DEFAULT '',
  author_url TEXT NOT NULL DEFAULT '',
  provider_name TEXT NOT NULL DEFAULT '',
  provider_url TEXT NOT NULL DEFAULT '',
  language TEXT,
  published_at TEXT,
  fetched_at INTEGER,
  CONSTRAINT status_card_pending_or_attached CHECK ((fetched_at IS NULL) = (due_at IS NOT NULL)),
  CONSTRAINT status_card_attached_title CHECK (fetched_at IS NULL OR length(CAST(title AS BLOB)) > 0)
) WITHOUT ROWID;`,
    `CREATE INDEX status_cards_due ON status_cards (due_at, status_id) WHERE due_at IS NOT NULL;`,
    `CREATE INDEX status_cards_expiry ON status_cards (enqueued_at) WHERE due_at IS NOT NULL;`,
    `CREATE INDEX status_cards_claimed ON status_cards (url, due_at, status_id) WHERE attempts > 0;`,
    `CREATE INDEX status_cards_fresh ON status_cards (url, fetched_at) WHERE fetched_at IS NOT NULL;`,
    ...boundTriggers(
      "status_cards_bounds",
      "status_cards",
      STATUS_CARDS_0067_COLUMNS.join(", "),
      STATUS_CARDS_0067_WHEN,
      "status_cards: a value past its stored bound",
    ),
  ].join("\n\n")}\n`;
}

// ---- Remote field verification: migration 0068_remote_field_verification

// remote_field_links (domain/remote-field-links.ts): one row per remote account with a field link to verify, holding
// what the cron's round checks and what it found. Bounds, each in its unit:
// - REMOTE_FIELD_INDEXES: the fields a remote account shows (account-columns.ts MAX_REMOTE_FIELDS; test pins them
//   equal), an entry's index among them from 0;
// - REMOTE_VERIFIED_SHOWN: the entries `links` holds, the first candidates in shown order;
// - REMOTE_FIELD_LINK_BYTES: an href, in UTF-8 bytes of printable ASCII: the longest X of Mastodon's shortest
//   double-quoted anchor `<a href="X">X</a>` within Account::Field::MAX_CHARACTERS_COMPAT, floor((2047 - 15) / 2);
// - REMOTE_LINK_BACK_BYTES: link_back, in UTF-8 bytes of printable ASCII (identity-bounds.ts ACTOR_URI_LIMIT and
//   PROFILE_URL_LIMIT, which the link back is one of);
// - REMOTE_FIELD_LINKS_BYTES: `links`, in UTF-8 bytes of its canonical JSON: 1 + 4 × 1,052 + 3 + 1, an entry at most
//   [15,"<1016 bytes>","<24 bytes>",1], no href character JSON-escaped (test/status-bounds.test.ts derives it).
export const REMOTE_FIELD_INDEXES = 16;
export const REMOTE_VERIFIED_SHOWN = 4;
export const REMOTE_FIELD_LINK_BYTES = 1016;
export const REMOTE_LINK_BACK_BYTES = 2048;
export const REMOTE_FIELD_LINKS_BYTES = 4213;

// The WHEN lines that refuse the decoded text `value` as an href of an entry, in order: its bytes, NUL (a JSON escape
// decodes to one, which GLOB stops at), printable ASCII only, none of CARD_URL_EXCLUDED_GLOB's characters (those that
// end or split an HTML attribute or a URL), then the https:// prefix.
function remoteFieldHrefCases(value: string): string {
  return `WHEN length(CAST(${value} AS BLOB)) NOT BETWEEN 1 AND ${REMOTE_FIELD_LINK_BYTES} THEN 1
	WHEN instr(CAST(${value} AS BLOB), x'00') > 0 THEN 1
	WHEN ${value} GLOB '*[^!-~]*' THEN 1
	WHEN ${value} GLOB '${CARD_URL_EXCLUDED_GLOB}' THEN 1
	WHEN ${value} NOT GLOB 'https://?*' THEN 1`;
}

// True when `column` holds no `links` value, judged in order, each step only once every earlier one passed: the
// storage class, the raw bytes, a raw NUL, json_valid, the canonical form (json() of it, by bytes, and no escape,
// which json() keeps and no stored character needs: no padding, no other spelling), the shape and types (an array of
// 1 to REMOTE_VERIFIED_SHOWN entries, each [integer, text, null or text, integer]), each decoded element (the href,
// remoteFieldHrefCases; the time by isoTimeSql), then the invariants: indexes from 0 to REMOTE_FIELD_INDEXES - 1
// strictly increasing, checked 0 or 1, and a verified entry checked. The writer's drop rule
// (domain/remote-field-links.ts) and the triggers share it.
export function remoteFieldLinksPastBoundSql(column: string): string {
  const element = (path: string) => `e.value ->> '${path}'`;
  const shape = `CASE WHEN e.type <> 'array' THEN 1
		WHEN json_array_length(e.value) <> 4 THEN 1
		WHEN json_type(e.value, '$[0]') <> 'integer' OR json_type(e.value, '$[1]') <> 'text' THEN 1
		WHEN json_type(e.value, '$[2]') NOT IN ('null', 'text') OR json_type(e.value, '$[3]') <> 'integer' THEN 1
		ELSE 0 END`;
  const decoded = `CASE ${remoteFieldHrefCases(element("$[1]"))}
		WHEN json_type(e.value, '$[2]') = 'text' AND ${isoTimeSql(element("$[2]"))} IS NULL THEN 1
		ELSE 0 END`;
  const invariant = `CASE WHEN ${element("$[0]")} NOT BETWEEN 0 AND ${REMOTE_FIELD_INDEXES - 1} THEN 1
		WHEN ${element("$[3]")} NOT IN (0, 1) THEN 1
		WHEN json_type(e.value, '$[2]') = 'text' AND ${element("$[3]")} <> 1 THEN 1
		WHEN e.key > 0 AND ${element("$[0]")} <= (${column} ->> ('$[' || (e.key - 1) || '][0]')) THEN 1
		ELSE 0 END`;
  return `CASE WHEN typeof(${column}) <> 'text' THEN 1
	WHEN length(CAST(${column} AS BLOB)) > ${REMOTE_FIELD_LINKS_BYTES} THEN 1
	WHEN instr(CAST(${column} AS BLOB), x'00') > 0 THEN 1
	WHEN NOT json_valid(${column}) THEN 1
	WHEN CAST(json(${column}) AS BLOB) <> CAST(${column} AS BLOB) OR instr(${column}, '\\') > 0 THEN 1
	WHEN json_type(${column}) <> 'array' THEN 1
	WHEN json_array_length(${column}) NOT BETWEEN 1 AND ${REMOTE_VERIFIED_SHOWN} THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(${column}) e WHERE ${shape}) THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(${column}) e WHERE ${decoded}) THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(${column}) e WHERE ${invariant}) THEN 1
	ELSE 0 END`;
}

// True when `value` is no link back: text of 1 to REMOTE_LINK_BACK_BYTES bytes, no NUL, printable ASCII, http(s).
export function remoteLinkBackPastBoundSql(value: string): string {
  return `CASE WHEN typeof(${value}) <> 'text' THEN 1
	WHEN length(CAST(${value} AS BLOB)) NOT BETWEEN 1 AND ${REMOTE_LINK_BACK_BYTES} THEN 1
	WHEN instr(CAST(${value} AS BLOB), x'00') > 0 THEN 1
	WHEN ${value} GLOB '*[^!-~]*' THEN 1
	WHEN NOT (${value} GLOB 'https://?*' OR ${value} GLOB 'http://?*') THEN 1
	ELSE 0 END`;
}

// True when the row `row` holds a value past its stored bound, in order: the storage classes, the raw bytes and
// NUL of account_id (an 18-digit snowflake as TEXT, as accounts.id), link_back and links, then their structure
// (remoteLinkBackPastBoundSql, remoteFieldLinksPastBoundSql), then the counters and times. The table's CHECK holds
// that a row is armed (due_at and armed_at set) or not (both NULL).
export function remoteFieldLinkRowPastBoundSql(row: string): string {
  const c = (name: string) => `${row}.${name}`;
  return `CASE WHEN typeof(${c("account_id")}) <> 'text' OR typeof(${c("link_back")}) <> 'text'
		OR typeof(${c("links")}) <> 'text' THEN 1
	WHEN length(CAST(${c("account_id")} AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(${c("account_id")} AS BLOB), x'00') > 0 THEN 1
	WHEN ${c("account_id")} GLOB '*[^0-9]*' THEN 1
	WHEN ${remoteLinkBackPastBoundSql(c("link_back"))} THEN 1
	WHEN ${remoteFieldLinksPastBoundSql(c("links"))} THEN 1
	${cardCountCase(c("generation"), false, SAFE_INTEGER_MAX)}
	${cardCountCase(c("claim"), false, SAFE_INTEGER_MAX)}
	${cardCountCase(c("attempts"), false, FIELD_LINK_MAX_ATTEMPTS)}
	${cardCountCase(c("due_at"), true, SAFE_INTEGER_MAX)}
	${cardCountCase(c("armed_at"), true, SAFE_INTEGER_MAX)}
	${cardCountCase(c("hold_until"), true, SAFE_INTEGER_MAX)}
	${cardCountCase(c("checked_at"), true, SAFE_INTEGER_MAX)}
	ELSE 0 END`;
}

// The partial indexes of remote_field_links (domain/remote-field-links.ts names them in INDEXED BY).
export const REMOTE_LINK_DUE_INDEX = "remote_field_links_due";
export const REMOTE_LINK_EXPIRY_INDEX = "remote_field_links_expiry";

const REMOTE_FIELD_LINK_COLUMNS = [
  "account_id",
  "link_back",
  "links",
  "generation",
  "claim",
  "attempts",
  "due_at",
  "armed_at",
  "hold_until",
  "checked_at",
];

// Migration 0068_remote_field_verification after its header (test/migrations.test.ts compares them): the empty table
// with its CHECK, its two partial indexes, and triggers that refuse a write where remoteFieldLinkRowPastBoundSql holds.
export function remoteFieldLinksMigrationSql(): string {
  return `${[
    `CREATE TABLE remote_field_links (
  account_id TEXT NOT NULL PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  link_back TEXT NOT NULL,
  links TEXT NOT NULL,
  generation INTEGER NOT NULL,
  claim INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER,
  armed_at INTEGER,
  hold_until INTEGER,
  checked_at INTEGER,
  CONSTRAINT remote_field_links_armed CHECK ((due_at IS NULL) = (armed_at IS NULL))
) WITHOUT ROWID;`,
    `CREATE INDEX ${REMOTE_LINK_DUE_INDEX} ON remote_field_links (due_at, account_id) WHERE due_at IS NOT NULL;`,
    `CREATE INDEX ${REMOTE_LINK_EXPIRY_INDEX} ON remote_field_links (armed_at) WHERE due_at IS NOT NULL;`,
    ...boundTriggers(
      "remote_field_links_bounds",
      "remote_field_links",
      REMOTE_FIELD_LINK_COLUMNS.join(", "),
      remoteFieldLinkRowPastBoundSql("NEW"),
      "remote_field_links: a value past its stored bound",
    ),
  ].join("\n\n")}\n`;
}

// ---- Card embeds: migration 0069_card_embeds

// What an oEmbed or twitter:player card adds to status_cards (domain/link-cards.ts), and the cache of oEmbed endpoints
// per host (card_oembed_endpoints, Mastodon's oembed_endpoint:<host> cache, fetch_oembed_service.rb:4, 69-78). Bounds,
// each in its unit:
// - CARD_TYPES: card_type, an integer (link 0, photo 1, video 2);
// - CARD_DIMENSION_MAX: width, height, iframe_width and iframe_height, integers (iframe ones NULL when omitted);
// - CARD_EMBED_SRC_BYTES: embed_src, the video iframe's decoded src, in UTF-8 bytes of printable ASCII ('' for none);
//   CARD_EMBED_SRC_ESCAPED_BYTES: the same after its one HTML escape (& to &amp;, the only character it escapes);
// - OEMBED_TEMPLATE_BYTES: a cached endpoint template, in UTF-8 bytes of printable ASCII (web-page.ts
//   WEB_PAGE_URL_LIMIT; test/link-cards.test.ts pins them equal); a host, in bytes of the DOMAIN rule (253);
// - OEMBED_ENDPOINT_TTL_MS: a cached endpoint's life; expires_at, a time in ms from 0 to SAFE_INTEGER_MAX;
// - OEMBED_ENDPOINTS_MAX: the rows the writer keeps (an import may hold more; they expire, OEMBED_EXPIRE_BATCH a
//   claim).
export const CARD_TYPES = { link: 0, photo: 1, video: 2 } as const;
export type CardType = keyof typeof CARD_TYPES;
export const CARD_DIMENSION_MAX = 65_535;
export const CARD_EMBED_SRC_BYTES = 512;
export const CARD_EMBED_SRC_ESCAPED_BYTES = 512;
export const OEMBED_TEMPLATE_BYTES = 2048;
export const OEMBED_HOST_BYTES = 253;
export const OEMBED_ENDPOINT_TTL_MS = 24 * 60 * 60 * 1000;
export const OEMBED_ENDPOINTS_MAX = 2048;
export const OEMBED_EXPIRE_BATCH = 100;
// The placeholder of a template: every brace of one belongs to it, after an =.
export const OEMBED_PLACEHOLDER = "={url}";

// The WHEN lines that refuse `value` as an embed_src, in order: the storage class, the raw bytes, NUL, then '' (none)
// accepted, then the structure: http(s), printable ASCII only, none of CARD_URL_EXCLUDED_GLOB's characters,
// and its escaped form (each & four bytes longer) within CARD_EMBED_SRC_ESCAPED_BYTES.
function cardEmbedSrcCases(value: string): string {
  return `WHEN typeof(${value}) <> 'text' THEN 1
	WHEN length(CAST(${value} AS BLOB)) > ${CARD_EMBED_SRC_BYTES} THEN 1
	WHEN instr(CAST(${value} AS BLOB), x'00') > 0 THEN 1
	WHEN ${value} = '' THEN 0
	WHEN NOT (${value} GLOB 'http://?*' OR ${value} GLOB 'https://?*') THEN 1
	WHEN ${value} GLOB '*[^!-~]*' THEN 1
	WHEN ${value} GLOB '${CARD_URL_EXCLUDED_GLOB}' THEN 1
	WHEN length(CAST(${value} AS BLOB)) + 4 * (length(${value}) - length(replace(${value}, '&', '')))
		> ${CARD_EMBED_SRC_ESCAPED_BYTES} THEN 1`;
}

// The iframe src as rendered inside the double quotes of its attribute: & escaped once, as &amp;. The stored and
// presented value refuses "<> (CARD_URL_EXCLUDED_GLOB, presentedCardUrl), so no other character needs it; ' is
// legal inside double quotes.
export function embedSrcAttribute(src: string): string {
  return src.replaceAll("&", "&amp;");
}

// An iframe src as kept and presented (HTML-3): presentedCardUrl's rule within CARD_EMBED_SRC_BYTES (judged as
// decoded, then normalized: an absolute http(s) URL, no base), and its attribute form within
// CARD_EMBED_SRC_ESCAPED_BYTES. Else null.
export function presentedEmbedSrc(value: unknown): string | null {
  const href = presentedCardUrl(value, CARD_EMBED_SRC_BYTES);
  return href !== null && embedSrcAttribute(href).length <= CARD_EMBED_SRC_ESCAPED_BYTES ? href : null;
}

// A card's width or height (strict): a JSON integer from 0 to CARD_DIMENSION_MAX, or a string of 1 to 5 ASCII
// digits whose value is at most that; anything else (absent, null, '', a fraction, a sign, a unit) is 0.
const DIMENSION = /^[0-9]{1,5}$/;
export function cardDimension(value: unknown): number {
  return iframeDimension(value) ?? 0;
}

// An iframe's width or height attribute, or the same rule over an oEmbed field: the value as cardDimension reads it,
// else null (the attribute is omitted).
export function iframeDimension(value: unknown): number | null {
  const n = typeof value === "string" && DIMENSION.test(value) ? Number(value) : value;
  return Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= CARD_DIMENSION_MAX ? (n as number) : null;
}

// True when `value` is no embed_src: the rule the triggers and the writer share.
export function cardEmbedSrcPastSql(value: string): string {
  return `CASE ${cardEmbedSrcCases(value)}
	ELSE 0 END`;
}

// The card's dimension as stored: an integer within 0..CARD_DIMENSION_MAX, else `otherwise` (0, or NULL for an
// iframe's).
export function cardDimensionSql(value: string, otherwise: "0" | "NULL"): string {
  const read = storedCountSql(value, CARD_DIMENSION_MAX);
  return otherwise === "NULL" ? read : `coalesce(${read}, 0)`;
}

// The WHEN condition of migration 0069's triggers, frozen as released: 0070_card_images recreates the triggers over the
// current predicate (statusCardPastBoundSql), so 0069's file reads none of the current bounds.
const STATUS_CARDS_0069_WHEN = `CASE WHEN typeof(NEW.status_id) <> 'text' THEN 1
	WHEN length(CAST(NEW.status_id AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(NEW.status_id AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.status_id GLOB '*[^0-9]*' THEN 1
	WHEN CASE WHEN typeof(NEW.url) <> 'text' THEN 1
	WHEN length(CAST(NEW.url AS BLOB)) > 2048 THEN 1
	WHEN instr(CAST(NEW.url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.url NOT GLOB 'https://?*' THEN 1
	WHEN NEW.url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.url GLOB '*["<>\\^\`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.due_at IS NOT NULL AND (typeof(NEW.due_at) <> 'integer' OR NEW.due_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN typeof(NEW.enqueued_at) <> 'integer' OR NEW.enqueued_at NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.claim) <> 'integer' OR NEW.claim NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.attempts) <> 'integer' OR NEW.attempts NOT BETWEEN 0 AND 2 THEN 1
	WHEN typeof(NEW.generation) <> 'integer' OR NEW.generation NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN NEW.fetched_at IS NOT NULL AND (typeof(NEW.fetched_at) <> 'integer' OR NEW.fetched_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN CASE WHEN typeof(NEW.title) <> 'text' THEN 1
	WHEN length(CAST(NEW.title AS BLOB)) > 510 THEN 1
	WHEN instr(CAST(NEW.title AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.title) AS BLOB)) > 512 THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.description) <> 'text' THEN 1
	WHEN length(CAST(NEW.description AS BLOB)) > 1022 THEN 1
	WHEN instr(CAST(NEW.description AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.description) AS BLOB)) > 1024 THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.author_name) <> 'text' THEN 1
	WHEN length(CAST(NEW.author_name AS BLOB)) > 510 THEN 1
	WHEN instr(CAST(NEW.author_name AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.author_name) AS BLOB)) > 512 THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.provider_name) <> 'text' THEN 1
	WHEN length(CAST(NEW.provider_name AS BLOB)) > 510 THEN 1
	WHEN instr(CAST(NEW.provider_name AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.provider_name) AS BLOB)) > 512 THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.author_url) <> 'text' THEN 1
	WHEN length(CAST(NEW.author_url AS BLOB)) > 1024 THEN 1
	WHEN instr(CAST(NEW.author_url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.author_url = '' THEN 0
	WHEN NOT (NEW.author_url GLOB 'https://?*' OR NEW.author_url GLOB 'http://?*') THEN 1
	WHEN NEW.author_url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.author_url GLOB '*["<>\\^\`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.provider_url) <> 'text' THEN 1
	WHEN length(CAST(NEW.provider_url AS BLOB)) > 1024 THEN 1
	WHEN instr(CAST(NEW.provider_url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.provider_url = '' THEN 0
	WHEN NOT (NEW.provider_url GLOB 'https://?*' OR NEW.provider_url GLOB 'http://?*') THEN 1
	WHEN NEW.provider_url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.provider_url GLOB '*["<>\\^\`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN NEW.language IS NULL THEN 0
	WHEN typeof(NEW.language) <> 'text' THEN 1
	WHEN length(CAST(NEW.language AS BLOB)) NOT BETWEEN 2 AND 7 THEN 1
	WHEN instr(CAST(NEW.language AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.language GLOB '*[^A-Za-z-]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.published_at IS NOT NULL AND (CASE WHEN length(CAST(NEW.published_at AS BLOB)) = 24 AND substr(NEW.published_at, 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.published_at) = NEW.published_at THEN NEW.published_at END) IS NULL THEN 1
	WHEN typeof(NEW.card_type) <> 'integer' OR NEW.card_type NOT BETWEEN 0 AND 2 THEN 1
	WHEN typeof(NEW.width) <> 'integer' OR NEW.width NOT BETWEEN 0 AND 65535 THEN 1
	WHEN typeof(NEW.height) <> 'integer' OR NEW.height NOT BETWEEN 0 AND 65535 THEN 1
	WHEN CASE WHEN typeof(NEW.embed_src) <> 'text' THEN 1
	WHEN length(CAST(NEW.embed_src AS BLOB)) > 512 THEN 1
	WHEN instr(CAST(NEW.embed_src AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.embed_src = '' THEN 0
	WHEN NOT (NEW.embed_src GLOB 'http://?*' OR NEW.embed_src GLOB 'https://?*') THEN 1
	WHEN NEW.embed_src GLOB '*[^!-~]*' THEN 1
	WHEN NEW.embed_src GLOB '*["<>\\^\`{|}]*' THEN 1
	WHEN length(CAST(NEW.embed_src AS BLOB)) + 4 * (length(NEW.embed_src) - length(replace(NEW.embed_src, '&', '')))
		> 512 THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.iframe_width IS NOT NULL AND (typeof(NEW.iframe_width) <> 'integer' OR NEW.iframe_width NOT BETWEEN 0 AND 65535) THEN 1
	WHEN NEW.iframe_height IS NOT NULL AND (typeof(NEW.iframe_height) <> 'integer' OR NEW.iframe_height NOT BETWEEN 0 AND 65535) THEN 1
	WHEN (NEW.card_type = 2) <> (NEW.embed_src <> '') THEN 1
	WHEN NEW.embed_src = '' AND (NEW.iframe_width IS NOT NULL OR NEW.iframe_height IS NOT NULL) THEN 1
	ELSE 0 END`;

// The columns 0069's update trigger watches (frozen with it).
const STATUS_CARDS_0069_COLUMNS = [
  ...STATUS_CARDS_0067_COLUMNS,
  "card_type",
  "width",
  "height",
  "embed_src",
  "iframe_width",
  "iframe_height",
];

// A card image's alt text (status_cards.image_description, Mastodon's og:image:alt), in JSON-escaped UTF-8 bytes with
// its quotes; RES-3's spares at 4,096 bytes (test/status-bounds.test.ts) set it.
export const CARD_IMAGE_DESCRIPTION_JSON_BYTES = 256;

// True when `value` is no 18-digit snowflake as TEXT (NULL included): the storage class, the bytes, NUL, the digits.
function snowflakePastSql(value: string): string {
  return `CASE WHEN typeof(${value}) <> 'text' THEN 1
	WHEN length(CAST(${value} AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(${value} AS BLOB), x'00') > 0 THEN 1
	WHEN ${value} GLOB '*[^0-9]*' THEN 1
	ELSE 0 END`;
}

// True when the row `row` holds a value past its stored bound: 0067's rules (statusCardBaseCases), then card_type,
// width and height, embed_src (cardEmbedSrcPastSql), iframe_width and iframe_height (0069), then image_url ('' or a
// card URL, cardUrlPastSql), image_id (NULL or a snowflake) and image_description (a card text of
// CARD_IMAGE_DESCRIPTION_JSON_BYTES) of 0070, then link_type (LINK_TYPES), final_url ('' or a card URL) and public (0
// or 1) of 0071, then the invariants: a video card and only one holds an embed_src, no iframe dimension is kept without
// one, no image id without an image URL, and public = 1 only on an attached row with a final URL whose status is
// public (the membership of status_cards_public_link: one key seek of statuses). The CHECKs of the table hold the
// row's structure (pending or attached, an attached title).
export function statusCardPastBoundSql(row: string): string {
  const c = (name: string) => `${row}.${name}`;
  return `CASE ${statusCardBaseCases(row)}
	${cardCountCase(c("card_type"), false, CARD_TYPES.video)}
	${cardCountCase(c("width"), false, CARD_DIMENSION_MAX)}
	${cardCountCase(c("height"), false, CARD_DIMENSION_MAX)}
	WHEN ${cardEmbedSrcPastSql(c("embed_src"))} THEN 1
	${cardCountCase(c("iframe_width"), true, CARD_DIMENSION_MAX)}
	${cardCountCase(c("iframe_height"), true, CARD_DIMENSION_MAX)}
	WHEN ${c("image_url")} IS NOT '' AND ${cardUrlPastSql(c("image_url"), false)} THEN 1
	WHEN ${c("image_id")} IS NOT NULL AND ${snowflakePastSql(c("image_id"))} THEN 1
	WHEN ${cardTextPastSql(c("image_description"), CARD_IMAGE_DESCRIPTION_JSON_BYTES)} THEN 1
	${cardCountCase(c("link_type"), false, LINK_TYPES.article)}
	WHEN ${c("final_url")} IS NOT '' AND ${cardUrlPastSql(c("final_url"), false)} THEN 1
	${cardCountCase(c("public"), false, 1)}
	WHEN (${c("card_type")} = ${CARD_TYPES.video}) <> (${c("embed_src")} <> '') THEN 1
	WHEN ${c("embed_src")} = '' AND (${c("iframe_width")} IS NOT NULL OR ${c("iframe_height")} IS NOT NULL) THEN 1
	WHEN ${c("image_url")} IS '' AND ${c("image_id")} IS NOT NULL THEN 1
	WHEN ${c("public")} = 1 AND (${c("fetched_at")} IS NULL OR ${c("final_url")} = ''
		OR (SELECT ps.visibility FROM main.statuses ps WHERE ps.id = ${c("status_id")}) IS NOT 'public') THEN 1
	ELSE 0 END`;
}

// A card's link type (status_cards.link_type, Mastodon's PreviewCard link_type, link_details_extractor.rb:139-145):
// unknown, or an article (JSON-LD @type NewsArticle, or og:type article), independent of the card's type.
export const LINK_TYPES = { unknown: 0, article: 1 } as const;
export type LinkType = keyof typeof LINK_TYPES;

// The columns of status_cards from 0071 on, which its update trigger watches.
export const CARD_COLUMNS = [
  ...STATUS_CARDS_0069_COLUMNS,
  "image_url",
  "image_id",
  "image_description",
  "link_type",
  "final_url",
  "public",
] as const;

// The characters a template holds besides printable ASCII's refused: those that end or split an HTML attribute or a
// URL, braces apart (OEMBED_PLACEHOLDER's, judged after). One GLOB pattern of 11 bytes.
const OEMBED_TEMPLATE_EXCLUDED_GLOB = '*["<>\\^`|]*';

// True when `value` is no template, judged in order: the storage class, the raw bytes, NUL, https, printable
// ASCII, the excluded characters, at least one OEMBED_PLACEHOLDER, and no brace outside one. The triggers, the writer
// (domain/link-cards.ts recordCard) and the reader (claimCards) share it; the Worker's twin adds the URL checks
// (federation/card-oembed.ts).
export function oembedTemplatePastSql(value: string): string {
  return `CASE WHEN typeof(${value}) <> 'text' THEN 1
	WHEN length(CAST(${value} AS BLOB)) NOT BETWEEN 1 AND ${OEMBED_TEMPLATE_BYTES} THEN 1
	WHEN instr(CAST(${value} AS BLOB), x'00') > 0 THEN 1
	WHEN ${value} NOT GLOB 'https://?*' THEN 1
	WHEN ${value} GLOB '*[^!-~]*' THEN 1
	WHEN ${value} GLOB '${OEMBED_TEMPLATE_EXCLUDED_GLOB}' THEN 1
	WHEN instr(${value}, '${OEMBED_PLACEHOLDER}') = 0 THEN 1
	WHEN replace(${value}, '${OEMBED_PLACEHOLDER}', '') GLOB '*[{}]*' THEN 1
	ELSE 0 END`;
}

// The same rule over a JavaScript string, as SQLite would judge it bound as text (a lone surrogate binds as three
// bytes, which the printable ASCII rule refuses either way).
const TEMPLATE_REFUSED = /[^!-~]|["<>\\^`|]/;
export function isOembedTemplate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= OEMBED_TEMPLATE_BYTES &&
    value.startsWith("https://") &&
    value.length > "https://".length &&
    !TEMPLATE_REFUSED.test(value) &&
    value.includes(OEMBED_PLACEHOLDER) &&
    !/[{}]/.test(value.replaceAll(OEMBED_PLACEHOLDER, ""))
  );
}

// True when `value` is no cached host: text of 1 to OEMBED_HOST_BYTES bytes, no NUL, of a-z, 0-9, '.' and '-' only.
export function oembedHostPastSql(value: string): string {
  return `CASE WHEN typeof(${value}) <> 'text' THEN 1
	WHEN length(CAST(${value} AS BLOB)) NOT BETWEEN 1 AND ${OEMBED_HOST_BYTES} THEN 1
	WHEN instr(CAST(${value} AS BLOB), x'00') > 0 THEN 1
	WHEN ${value} GLOB '*[^a-z0-9.-]*' THEN 1
	ELSE 0 END`;
}

// True when the row `row` of card_oembed_endpoints holds a value past its stored bound: the host, the template, then
// expires_at.
export function oembedEndpointPastBoundSql(row: string): string {
  return `CASE WHEN ${oembedHostPastSql(`${row}.domain`)} THEN 1
	WHEN ${oembedTemplatePastSql(`${row}.template`)} THEN 1
	${cardCountCase(`${row}.expires_at`, false, SAFE_INTEGER_MAX)}
	ELSE 0 END`;
}

// The index card_oembed_endpoints' expiry walks (domain/link-cards.ts names it in INDEXED BY).
export const OEMBED_EXPIRY_INDEX = "card_oembed_endpoints_expiry";

// Migration 0069_card_embeds after its header (test/migrations.test.ts compares them): the six columns of status_cards
// with defaults every existing row passes (a link of 0 by 0, no embed), its triggers recreated over the frozen
// STATUS_CARDS_0069_WHEN and STATUS_CARDS_0069_COLUMNS, and the empty card_oembed_endpoints with its expiry index and
// triggers.
export function cardEmbedsMigrationSql(): string {
  return `${[
    [
      "ALTER TABLE status_cards ADD COLUMN card_type INTEGER NOT NULL DEFAULT 0;",
      "ALTER TABLE status_cards ADD COLUMN width INTEGER NOT NULL DEFAULT 0;",
      "ALTER TABLE status_cards ADD COLUMN height INTEGER NOT NULL DEFAULT 0;",
      "ALTER TABLE status_cards ADD COLUMN embed_src TEXT NOT NULL DEFAULT '';",
      "ALTER TABLE status_cards ADD COLUMN iframe_width INTEGER;",
      "ALTER TABLE status_cards ADD COLUMN iframe_height INTEGER;",
    ].join("\n"),
    "DROP TRIGGER status_cards_bounds_insert;\nDROP TRIGGER status_cards_bounds_update;",
    ...boundTriggers(
      "status_cards_bounds",
      "status_cards",
      STATUS_CARDS_0069_COLUMNS.join(", "),
      STATUS_CARDS_0069_WHEN,
      "status_cards: a value past its stored bound",
    ),
    `CREATE TABLE card_oembed_endpoints (
  domain TEXT NOT NULL PRIMARY KEY,
  template TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;`,
    `CREATE INDEX ${OEMBED_EXPIRY_INDEX} ON card_oembed_endpoints (expires_at, domain);`,
    ...boundTriggers(
      "card_oembed_endpoints_bounds",
      "card_oembed_endpoints",
      "domain, template, expires_at",
      oembedEndpointPastBoundSql("NEW"),
      "card_oembed_endpoints: a value past its stored bound",
    ),
  ].join("\n\n")}\n`;
}

// ---- Card images: migration 0070_card_images

// card_images (domain/card-images.ts): one row per image source URL a card names, pending or stored, and
// status_cards' link to it (image_url, image_id) with its alt text. Bounds, each in its unit:
// - CARD_IMAGE_BODY_LIMIT: a fetched image, in bytes after workerd's Content-Encoding decoding, exclusive (Mastodon's
//   8 MB, preview_card.rb LIMIT under vips): read as a prefix of one byte less and refused when the body is longer;
// - CARD_IMAGE_PIXELS: the stored image's target area (Mastodon's 230,400-pixel original style); CARD_DECODE_PIXELS
//   the most an output may hold, the target's box plus one line of the longer edge that Images may round up (230,400 +
//   31,744 for edges up to 31,744 pixels), so its RGBA output (federation/card-images.ts I15) is at most 1 MiB;
// - CARD_GIF_MATRIX_LIMIT: a GIF's pixels (Mastodon's attachmentable.rb GIF limit); other types IMAGE_MATRIX_LIMIT
//   (platform/images.ts); CARD_IMAGE_EDGE_MAX an edge of the source, the target and the stored image, in pixels;
// - CARD_IMAGE_OUTPUT_LIMIT: the stored WebP, in bytes, refused while it is read;
// - CARD_IMAGE_TOKEN_BYTES: a stored token (media-files.ts FILE_TOKEN), in ASCII bytes;
// - CARD_IMAGE_URL_BYTES: the presented image URL, in UTF-8 bytes of ASCII: 'https://' + a 253-byte host + '/media/' +
//   a token + '/full.webp';
// - CARD_IMAGE_MAX_ATTEMPTS: claims of a pending row since it was enqueued or released.
export const CARD_IMAGE_BODY_LIMIT = 8 * 1024 * 1024;
export const CARD_IMAGE_PIXELS = 230_400;
export const CARD_DECODE_PIXELS = 262_144;
export const CARD_GIF_MATRIX_LIMIT = 921_600;
/** @alias */
export const CARD_IMAGE_EDGE_MAX = CARD_DIMENSION_MAX;
export const CARD_IMAGE_OUTPUT_LIMIT = 512 * 1024;
export const CARD_IMAGE_TOKEN_MIN_BYTES = 32;
export const CARD_IMAGE_TOKEN_BYTES = 64;
export const CARD_IMAGE_URL_BYTES =
  "https://".length + 253 + "/media/".length + CARD_IMAGE_TOKEN_BYTES + "/full.webp".length;
export const CARD_IMAGE_MAX_ATTEMPTS = 2;

// The partial indexes of card_images and status_cards' image link (domain/card-images.ts names them in INDEXED BY).
export const CARD_IMAGE_DUE_INDEX = "card_images_due";
export const CARD_IMAGE_EXPIRY_INDEX = "card_images_expiry";
export const CARD_IMAGE_STORED_INDEX = "card_images_stored";
export const CARD_IMAGE_PENDING_INDEX = "card_images_pending";
export const CARD_IMAGE_STORED_ID_INDEX = "card_images_stored_id";
export const CARD_IMAGE_TOKEN_INDEX = "card_images_token";
export const CARD_IMAGE_LINK_INDEX = "status_cards_image";

// True when `value` is no stored token: NULL is one; else text of CARD_IMAGE_TOKEN_MIN_BYTES to
// CARD_IMAGE_TOKEN_BYTES bytes, no NUL, base64url only.
export function cardImageTokenPastSql(value: string): string {
  return `CASE WHEN ${value} IS NULL THEN 0
	WHEN typeof(${value}) <> 'text' THEN 1
	WHEN length(CAST(${value} AS BLOB)) NOT BETWEEN ${CARD_IMAGE_TOKEN_MIN_BYTES} AND ${CARD_IMAGE_TOKEN_BYTES} THEN 1
	WHEN instr(CAST(${value} AS BLOB), x'00') > 0 THEN 1
	WHEN ${value} GLOB '*[^A-Za-z0-9_-]*' THEN 1
	ELSE 0 END`;
}

// An edge of a stored image as stored: an integer from 1 to CARD_IMAGE_EDGE_MAX, else NULL.
export function cardImageEdgeSql(value: string): string {
  return `CASE WHEN typeof(${value}) = 'integer' AND ${value} BETWEEN 1 AND ${CARD_IMAGE_EDGE_MAX} THEN ${value} END`;
}

// True when the row `row` of card_images holds a value past its stored bound, column by column in order (the storage
// class, the bytes, NUL, the structure): id (a snowflake), source_url (cardUrlPastSql), the counters and times,
// token, width and height (1 to CARD_IMAGE_EDGE_MAX or NULL), blurhash (blurhashPastBoundSql); then the invariants:
// pending (due_at set) exactly while stored_at is NULL; a stored row holds a token, a width and a height; a pending
// row holds none of them and no blurhash.
export function cardImagePastBoundSql(row: string): string {
  const c = (name: string) => `${row}.${name}`;
  const edge = (name: string) =>
    `WHEN ${c(name)} IS NOT NULL AND (typeof(${c(name)}) <> 'integer' OR ${c(name)} NOT BETWEEN 1 AND ${CARD_IMAGE_EDGE_MAX}) THEN 1`;
  return `CASE WHEN ${snowflakePastSql(c("id"))} THEN 1
	WHEN ${cardUrlPastSql(c("source_url"), false)} THEN 1
	${cardCountCase(c("due_at"), true, SAFE_INTEGER_MAX)}
	${cardCountCase(c("enqueued_at"), false, SAFE_INTEGER_MAX)}
	${cardCountCase(c("claim"), false, SAFE_INTEGER_MAX)}
	${cardCountCase(c("attempts"), false, CARD_IMAGE_MAX_ATTEMPTS)}
	WHEN ${cardImageTokenPastSql(c("token"))} THEN 1
	${edge("width")}
	${edge("height")}
	WHEN ${blurhashPastBoundSql(c("blurhash"))} THEN 1
	${cardCountCase(c("stored_at"), true, SAFE_INTEGER_MAX)}
	WHEN (${c("due_at")} IS NULL) = (${c("stored_at")} IS NULL) THEN 1
	WHEN ${c("stored_at")} IS NOT NULL AND (${c("token")} IS NULL OR ${c("width")} IS NULL OR ${c("height")} IS NULL) THEN 1
	WHEN ${c("stored_at")} IS NULL AND (${c("token")} IS NOT NULL OR ${c("width")} IS NOT NULL OR ${c("height")} IS NOT NULL
		OR ${c("blurhash")} IS NOT NULL) THEN 1
	ELSE 0 END`;
}

export const CARD_IMAGE_COLUMNS = [
  "id",
  "source_url",
  "due_at",
  "enqueued_at",
  "claim",
  "attempts",
  "token",
  "width",
  "height",
  "blurhash",
  "stored_at",
] as const;

// The WHEN condition and the watched columns of migration 0070's triggers, frozen as released: 0071_link_trends
// recreates the triggers over the current predicate (statusCardPastBoundSql), so 0070's file reads none of the current
// bounds.
const STATUS_CARDS_0070_WHEN = `CASE WHEN typeof(NEW.status_id) <> 'text' THEN 1
	WHEN length(CAST(NEW.status_id AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(NEW.status_id AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.status_id GLOB '*[^0-9]*' THEN 1
	WHEN CASE WHEN typeof(NEW.url) <> 'text' THEN 1
	WHEN length(CAST(NEW.url AS BLOB)) > 2048 THEN 1
	WHEN instr(CAST(NEW.url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.url NOT GLOB 'https://?*' THEN 1
	WHEN NEW.url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.url GLOB '*["<>\\^\`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.due_at IS NOT NULL AND (typeof(NEW.due_at) <> 'integer' OR NEW.due_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN typeof(NEW.enqueued_at) <> 'integer' OR NEW.enqueued_at NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.claim) <> 'integer' OR NEW.claim NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.attempts) <> 'integer' OR NEW.attempts NOT BETWEEN 0 AND 2 THEN 1
	WHEN typeof(NEW.generation) <> 'integer' OR NEW.generation NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN NEW.fetched_at IS NOT NULL AND (typeof(NEW.fetched_at) <> 'integer' OR NEW.fetched_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN CASE WHEN typeof(NEW.title) <> 'text' THEN 1
	WHEN length(CAST(NEW.title AS BLOB)) > 510 THEN 1
	WHEN instr(CAST(NEW.title AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.title) AS BLOB)) > 512 THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.description) <> 'text' THEN 1
	WHEN length(CAST(NEW.description AS BLOB)) > 1022 THEN 1
	WHEN instr(CAST(NEW.description AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.description) AS BLOB)) > 1024 THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.author_name) <> 'text' THEN 1
	WHEN length(CAST(NEW.author_name AS BLOB)) > 510 THEN 1
	WHEN instr(CAST(NEW.author_name AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.author_name) AS BLOB)) > 512 THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.provider_name) <> 'text' THEN 1
	WHEN length(CAST(NEW.provider_name AS BLOB)) > 510 THEN 1
	WHEN instr(CAST(NEW.provider_name AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.provider_name) AS BLOB)) > 512 THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.author_url) <> 'text' THEN 1
	WHEN length(CAST(NEW.author_url AS BLOB)) > 1024 THEN 1
	WHEN instr(CAST(NEW.author_url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.author_url = '' THEN 0
	WHEN NOT (NEW.author_url GLOB 'https://?*' OR NEW.author_url GLOB 'http://?*') THEN 1
	WHEN NEW.author_url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.author_url GLOB '*["<>\\^\`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.provider_url) <> 'text' THEN 1
	WHEN length(CAST(NEW.provider_url AS BLOB)) > 1024 THEN 1
	WHEN instr(CAST(NEW.provider_url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.provider_url = '' THEN 0
	WHEN NOT (NEW.provider_url GLOB 'https://?*' OR NEW.provider_url GLOB 'http://?*') THEN 1
	WHEN NEW.provider_url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.provider_url GLOB '*["<>\\^\`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN NEW.language IS NULL THEN 0
	WHEN typeof(NEW.language) <> 'text' THEN 1
	WHEN length(CAST(NEW.language AS BLOB)) NOT BETWEEN 2 AND 7 THEN 1
	WHEN instr(CAST(NEW.language AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.language GLOB '*[^A-Za-z-]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.published_at IS NOT NULL AND (CASE WHEN length(CAST(NEW.published_at AS BLOB)) = 24 AND substr(NEW.published_at, 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.published_at) = NEW.published_at THEN NEW.published_at END) IS NULL THEN 1
	WHEN typeof(NEW.card_type) <> 'integer' OR NEW.card_type NOT BETWEEN 0 AND 2 THEN 1
	WHEN typeof(NEW.width) <> 'integer' OR NEW.width NOT BETWEEN 0 AND 65535 THEN 1
	WHEN typeof(NEW.height) <> 'integer' OR NEW.height NOT BETWEEN 0 AND 65535 THEN 1
	WHEN CASE WHEN typeof(NEW.embed_src) <> 'text' THEN 1
	WHEN length(CAST(NEW.embed_src AS BLOB)) > 512 THEN 1
	WHEN instr(CAST(NEW.embed_src AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.embed_src = '' THEN 0
	WHEN NOT (NEW.embed_src GLOB 'http://?*' OR NEW.embed_src GLOB 'https://?*') THEN 1
	WHEN NEW.embed_src GLOB '*[^!-~]*' THEN 1
	WHEN NEW.embed_src GLOB '*["<>\\^\`{|}]*' THEN 1
	WHEN length(CAST(NEW.embed_src AS BLOB)) + 4 * (length(NEW.embed_src) - length(replace(NEW.embed_src, '&', '')))
		> 512 THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.iframe_width IS NOT NULL AND (typeof(NEW.iframe_width) <> 'integer' OR NEW.iframe_width NOT BETWEEN 0 AND 65535) THEN 1
	WHEN NEW.iframe_height IS NOT NULL AND (typeof(NEW.iframe_height) <> 'integer' OR NEW.iframe_height NOT BETWEEN 0 AND 65535) THEN 1
	WHEN NEW.image_url IS NOT '' AND CASE WHEN typeof(NEW.image_url) <> 'text' THEN 1
	WHEN length(CAST(NEW.image_url AS BLOB)) > 2048 THEN 1
	WHEN instr(CAST(NEW.image_url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.image_url NOT GLOB 'https://?*' THEN 1
	WHEN NEW.image_url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.image_url GLOB '*["<>\\^\`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.image_id IS NOT NULL AND CASE WHEN typeof(NEW.image_id) <> 'text' THEN 1
	WHEN length(CAST(NEW.image_id AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(NEW.image_id AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.image_id GLOB '*[^0-9]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.image_description) <> 'text' THEN 1
	WHEN length(CAST(NEW.image_description AS BLOB)) > 254 THEN 1
	WHEN instr(CAST(NEW.image_description AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.image_description) AS BLOB)) > 256 THEN 1
	ELSE 0 END THEN 1
	WHEN (NEW.card_type = 2) <> (NEW.embed_src <> '') THEN 1
	WHEN NEW.embed_src = '' AND (NEW.iframe_width IS NOT NULL OR NEW.iframe_height IS NOT NULL) THEN 1
	WHEN NEW.image_url IS '' AND NEW.image_id IS NOT NULL THEN 1
	ELSE 0 END`;

const STATUS_CARDS_0070_COLUMNS = [...STATUS_CARDS_0069_COLUMNS, "image_url", "image_id", "image_description"];

// Migration 0070_card_images after its header (test/migrations.test.ts compares them): status_cards' three columns
// with defaults every existing row passes (no image, no alt text), the index of its image link, its triggers
// recreated over the frozen STATUS_CARDS_0070_WHEN and STATUS_CARDS_0070_COLUMNS, and the empty card_images with its
// indexes and triggers.
export function cardImagesMigrationSql(): string {
  return `${[
    [
      "ALTER TABLE status_cards ADD COLUMN image_url TEXT NOT NULL DEFAULT '';",
      "ALTER TABLE status_cards ADD COLUMN image_id TEXT;",
      "ALTER TABLE status_cards ADD COLUMN image_description TEXT NOT NULL DEFAULT '';",
    ].join("\n"),
    `CREATE INDEX ${CARD_IMAGE_LINK_INDEX} ON status_cards (image_id) WHERE image_id IS NOT NULL;`,
    "DROP TRIGGER status_cards_bounds_insert;\nDROP TRIGGER status_cards_bounds_update;",
    ...boundTriggers(
      "status_cards_bounds",
      "status_cards",
      STATUS_CARDS_0070_COLUMNS.join(", "),
      STATUS_CARDS_0070_WHEN,
      "status_cards: a value past its stored bound",
    ),
    `CREATE TABLE card_images (
  id TEXT NOT NULL PRIMARY KEY,
  source_url TEXT NOT NULL,
  due_at INTEGER,
  enqueued_at INTEGER NOT NULL,
  claim INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  token TEXT,
  width INTEGER,
  height INTEGER,
  blurhash TEXT,
  stored_at INTEGER
) WITHOUT ROWID;`,
    [
      `CREATE INDEX ${CARD_IMAGE_DUE_INDEX} ON card_images (due_at, id) WHERE due_at IS NOT NULL;`,
      `CREATE INDEX ${CARD_IMAGE_EXPIRY_INDEX} ON card_images (enqueued_at) WHERE due_at IS NOT NULL;`,
      `CREATE INDEX ${CARD_IMAGE_STORED_INDEX} ON card_images (source_url, stored_at) WHERE stored_at IS NOT NULL;`,
      `CREATE INDEX ${CARD_IMAGE_PENDING_INDEX} ON card_images (source_url) WHERE due_at IS NOT NULL;`,
      `CREATE INDEX ${CARD_IMAGE_STORED_ID_INDEX} ON card_images (id) WHERE stored_at IS NOT NULL;`,
      `CREATE UNIQUE INDEX ${CARD_IMAGE_TOKEN_INDEX} ON card_images (token) WHERE token IS NOT NULL;`,
    ].join("\n"),
    ...boundTriggers(
      "card_images_bounds",
      "card_images",
      CARD_IMAGE_COLUMNS.join(", "),
      cardImagePastBoundSql("NEW"),
      "card_images: a value past its stored bound",
    ),
  ].join("\n\n")}\n`;
}

// ---- Link trends: migration 0071_link_trends

// trend_links (domain/trends.ts roundLinks): the links the cron scores, by their card's final URL, at most
// MAX_TREND_LINKS (TREND_ALLOWED_ROWS allowed and TREND_REVIEW_POOL for review, RES-4); link_trend_reviews and
// link_provider_reviews: the Access admin's decisions on a link and on a publisher (a domain and its subdomains), at
// most MAX_TREND_REVIEWS each. Bounds, each in its unit: a URL by the card URL rule (cardUrlPastSql, CARD_URL_LIMIT
// bytes of printable ASCII); a domain in LINK_DOMAIN_BYTES ASCII bytes (a DNS name, normalizeDomain's form); a language
// by cardLanguagePastSql; a score from 0 to TREND_SCORE_MAX and its peak from the score to it; a time in the 24-byte
// ISO form (isoTimeSql).
export const MAX_TREND_LINKS = TREND_ALLOWED_ROWS + TREND_REVIEW_POOL;
export const LINK_DOMAIN_BYTES = 253;

// The indexes 0071 adds (domain/trends.ts names them in INDEXED BY): the public, attached copies of a final URL by
// status, the public boosts of an original by id, and the listed trend links by score.
export const CARD_PUBLIC_LINK_INDEX = "status_cards_public_link";
export const PUBLIC_BOOSTS_INDEX = "statuses_public_boosts";
export const TREND_LINKS_LISTED_INDEX = "trend_links_listed";

// True when `value` is no stored link domain, judged in order: the storage class, the bytes, NUL, then the structure
// (lowercase ASCII letters, digits, '-' and '.', at least two labels, no empty label). Each GLOB pattern is at most 15
// bytes.
export function linkDomainPastSql(value: string): string {
  return `CASE WHEN typeof(${value}) <> 'text' THEN 1
	WHEN length(CAST(${value} AS BLOB)) NOT BETWEEN 3 AND ${LINK_DOMAIN_BYTES} THEN 1
	WHEN instr(CAST(${value} AS BLOB), x'00') > 0 THEN 1
	WHEN ${value} GLOB '*[^a-z0-9.-]*' THEN 1
	WHEN ${value} NOT GLOB '?*.?*' OR ${value} GLOB '.*' OR ${value} GLOB '*.' OR ${value} GLOB '*..*' THEN 1
	ELSE 0 END`;
}

// The same rule over a JavaScript string: the domain itself, or null.
export function storedLinkDomain(value: string | null): string | null {
  return value !== null &&
    value.length >= 3 &&
    value.length <= LINK_DOMAIN_BYTES &&
    /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value)
    ? value
    : null;
}

// A score and its peak as stored (0057's trend_tag_scores, as cases).
function trendScoreCases(row: string): string {
  const c = (name: string) => `${row}.${name}`;
  return `WHEN typeof(${c("score")}) NOT IN ('integer', 'real') OR ${c("score")} NOT BETWEEN 0 AND ${TREND_SCORE_MAX} THEN 1
	WHEN typeof(${c("max_score")}) NOT IN ('integer', 'real')
		OR ${c("max_score")} NOT BETWEEN ${c("score")} AND ${TREND_SCORE_MAX} THEN 1`;
}

// True when the row `row` of trend_links holds a value past its stored bound, column by column: url, domain,
// language, the score and its peak, max_score_at.
export function trendLinkPastBoundSql(row: string): string {
  const c = (name: string) => `${row}.${name}`;
  return `CASE WHEN ${cardUrlPastSql(c("url"), false)} THEN 1
	WHEN ${linkDomainPastSql(c("domain"))} THEN 1
	WHEN ${cardLanguagePastSql(c("language"))} THEN 1
	${trendScoreCases(row)}
	WHEN ${isoTimeSql(c("max_score_at"))} IS NULL THEN 1
	ELSE 0 END`;
}

// True when the row `row` of a link review table holds a value past its stored bound: its key (`key`: the URL by the
// card URL rule, or the domain by linkDomainPastSql), trendable (0 or 1), reviewed_at.
export function linkReviewPastBoundSql(row: string, key: "url" | "domain"): string {
  const c = (name: string) => `${row}.${name}`;
  const keyPast = key === "url" ? cardUrlPastSql(c("url"), false) : linkDomainPastSql(c("domain"));
  return `CASE WHEN ${keyPast} THEN 1
	${cardCountCase(c("trendable"), false, 1)}
	WHEN ${isoTimeSql(c("reviewed_at"))} IS NULL THEN 1
	ELSE 0 END`;
}

// A cap trigger that refuses only a new key when `table` holds `max` rows (0057's shape).
function capTrigger(table: string, key: string, max: number): string {
  return `CREATE TRIGGER ${table}_cap BEFORE INSERT ON ${table}
WHEN NOT EXISTS (SELECT 1 FROM ${table} WHERE ${key} = NEW.${key}) AND (SELECT count(*) FROM ${table}) >= ${max}
BEGIN
  SELECT RAISE(ABORT, '${table}: more than ${max}');
END;`;
}

// Migration 0071_link_trends after its header (test/migrations.test.ts compares them): status_cards' three columns
// with defaults every existing row passes (unknown, no final URL, not public), its triggers recreated over
// statusCardPastBoundSql and CARD_COLUMNS, the two partial indexes, and the three empty tables with their triggers.
export function linkTrendsMigrationSql(): string {
  const review = (table: string, key: "url" | "domain") => [
    `CREATE TABLE ${table} (
  ${key} TEXT NOT NULL PRIMARY KEY,
  trendable INTEGER NOT NULL,
  reviewed_at TEXT NOT NULL
) WITHOUT ROWID;`,
    ...boundTriggers(
      `${table}_bounds`,
      table,
      `${key}, trendable, reviewed_at`,
      linkReviewPastBoundSql("NEW", key),
      `${table}: a value past its stored bound`,
    ),
    capTrigger(table, key, MAX_TREND_REVIEWS),
  ];
  return `${[
    [
      "ALTER TABLE status_cards ADD COLUMN link_type INTEGER NOT NULL DEFAULT 0;",
      "ALTER TABLE status_cards ADD COLUMN final_url TEXT NOT NULL DEFAULT '';",
      "ALTER TABLE status_cards ADD COLUMN public INTEGER NOT NULL DEFAULT 0;",
    ].join("\n"),
    "DROP TRIGGER status_cards_bounds_insert;\nDROP TRIGGER status_cards_bounds_update;",
    ...boundTriggers(
      "status_cards_bounds",
      "status_cards",
      CARD_COLUMNS.join(", "),
      statusCardPastBoundSql("NEW"),
      "status_cards: a value past its stored bound",
    ),
    [
      `CREATE INDEX ${CARD_PUBLIC_LINK_INDEX} ON status_cards (final_url, status_id)
  WHERE public = 1 AND fetched_at IS NOT NULL AND final_url <> '';`,
      `CREATE INDEX ${PUBLIC_BOOSTS_INDEX} ON statuses (reblog_of_id, id)
  WHERE reblog_of_id IS NOT NULL AND visibility = 'public';`,
    ].join("\n"),
    `CREATE TABLE trend_links (
  url TEXT NOT NULL PRIMARY KEY,
  domain TEXT NOT NULL,
  language TEXT,
  score REAL NOT NULL,
  max_score REAL NOT NULL,
  max_score_at TEXT NOT NULL
) WITHOUT ROWID;`,
    `CREATE INDEX ${TREND_LINKS_LISTED_INDEX} ON trend_links (score DESC, url) WHERE score >= 1;`,
    ...boundTriggers(
      "trend_links_bounds",
      "trend_links",
      "url, domain, language, score, max_score, max_score_at",
      trendLinkPastBoundSql("NEW"),
      "trend_links: a value past its stored bound",
    ),
    capTrigger("trend_links", "url", MAX_TREND_LINKS),
    ...review("link_trend_reviews", "url"),
    ...review("link_provider_reviews", "domain"),
  ].join("\n\n")}\n`;
}

// ---- Instance activity: migration 0072_activity_tracking (domain/instance-activity.ts)

// activity_counts: one row per kind and UTC day, value the day's count (1 to ACTIVITY_VALUE_MAX: the writers add 1 and
// stop there, so a window's sum of 6 days stays a safe integer of at most 13 digits). activity_logins: one row per UTC
// day and local account with a login that day, account_id an 18-digit id as TEXT (accounts.id's form), no foreign key.
export const ACTIVITY_KINDS = ["statuses", "registrations"] as const;
export const ACTIVITY_VALUE_MAX = 1_000_000_000_000;
const ACTIVITY_ID_BYTES = 18;

// Whether `id` is an account id activity_logins stores (its CHECK's JS twin): 18 ASCII digits.
export function isActivityAccountId(id: string): boolean {
  return /^[0-9]{18}$/.test(id);
}

// Migration 0072_activity_tracking after its header (test/migrations.test.ts compares them): the two tables with their
// CHECKs, an existing activity_api_enabled row that is not 'true' or 'false' deleted (0049's triggers let the name
// through), then its triggers.
export function activityMigrationSql(): string {
  const when = "NEW.name = 'activity_api_enabled' AND NEW.value IS NOT 'true' AND NEW.value IS NOT 'false'";
  return `${[
    `CREATE TABLE activity_counts (
  kind TEXT NOT NULL,
  day TEXT NOT NULL,
  value INTEGER NOT NULL,
  PRIMARY KEY (kind, day),
  CONSTRAINT activity_counts_kind CHECK (kind IN (${ACTIVITY_KINDS.map((k) => `'${k}'`).join(", ")})),
  CONSTRAINT activity_counts_day CHECK (${utcDayCheckSql("day")}),
  CONSTRAINT activity_counts_value CHECK (typeof(value) = 'integer' AND value BETWEEN 1 AND ${ACTIVITY_VALUE_MAX})
) WITHOUT ROWID;`,
    `CREATE TABLE activity_logins (
  day TEXT NOT NULL,
  account_id TEXT NOT NULL,
  PRIMARY KEY (day, account_id),
  CONSTRAINT activity_logins_day CHECK (${utcDayCheckSql("day")}),
  CONSTRAINT activity_logins_account_id CHECK (typeof(account_id) = 'text'
    AND length(CAST(account_id AS BLOB)) = ${ACTIVITY_ID_BYTES} AND instr(CAST(account_id AS BLOB), x'00') = 0
    AND account_id NOT GLOB '*[^0-9]*')
) WITHOUT ROWID;`,
    "DELETE FROM instance_settings\nWHERE name = 'activity_api_enabled' AND value IS NOT 'true' AND value IS NOT 'false';",
    "-- 0049's triggers end in ELSE 0, and 0057's and 0059's name other settings; these bound activity_api_enabled.",
    ...boundTriggers(
      "instance_settings_activity",
      "instance_settings",
      "name, value",
      when,
      "instance_settings: a value past its stored bound",
    ),
  ].join("\n\n")}\n`;
}

// ---- Actor document revisions: migration 0073_actor_document_revision (domain/remote-actors.ts upsertRemoteActor)

// accounts.document_revision: an integer from 0 to DOCUMENT_REVISION_MAX, a JavaScript safe integer so it crosses RPC
// whole. The Store issues a new one with every store of a remote actor's document (ID-1); a row the upgrade or a
// converted dump carries holds 0.
/** @alias */
export const DOCUMENT_REVISION_MAX = SAFE_INTEGER_MAX;

// True when `row` holds a revision past its stored bound: not an integer (INTEGER affinity has already stored numeric
// text and an integral REAL as one), or outside 0..DOCUMENT_REVISION_MAX.
function documentRevisionPastBoundSql(row: string): string {
  const column = `${row}.document_revision`;
  return `CASE WHEN typeof(${column}) <> 'integer' THEN 1
	WHEN ${column} NOT BETWEEN 0 AND ${DOCUMENT_REVISION_MAX} THEN 1
	ELSE 0 END`;
}

// A new revision for a row whose revision is the SQL `current` (null: a row being inserted, which takes a draw):
// `current` plus an increment of 1 to 2^53 - 1, modulo 2^53, so it always differs from `current` and a stored maximum
// never stops it from changing (no saturation). The increment is drawn from random(), not quite uniformly (two of the
// 2^53 draws give 1), so a repeat of a value an expectation read before is possible after two or more intervening
// stores, each with a chance of about 2^-52 at most: the accepted risk of quotes.generation's convention (domain/ids.ts
// NEW_GENERATION).
export function nextDocumentRevisionSql(current: string | null): string {
  const draw = `(random() & ${DOCUMENT_REVISION_MAX})`;
  return current === null
    ? draw
    : `(${current} + 1 + ${draw} % ${DOCUMENT_REVISION_MAX}) % ${DOCUMENT_REVISION_MAX + 1}`;
}

// Migration 0073_actor_document_revision after its header (test/migrations.test.ts compares them): the column, added
// with a constant default and no CHECK so no row is read or rewritten, and triggers that refuse a write where
// documentRevisionPastBoundSql holds.
export function documentRevisionMigrationSql(): string {
  return `${[
    "ALTER TABLE accounts ADD COLUMN document_revision INTEGER NOT NULL DEFAULT 0;",
    ...boundTriggers(
      "accounts_document_revision",
      "accounts",
      "document_revision",
      documentRevisionPastBoundSql("NEW"),
      "accounts: document_revision past its stored bound",
    ),
  ].join("\n\n")}\n`;
}

// ---- Filter text units: migration 0079_filter_text_units (domain/status-presenter.ts measureFilterText)

// statuses.filter_text_units: NULL (not measured), or an integer from 0 to FILTER_TEXT_UNITS_MAX, the UTF-16 code units
// of the status's searchable text cut at filters.ts MAX_FILTER_TEXT, which is this bound.
export const FILTER_TEXT_UNITS_MAX = 10_000;

// True when `column` holds filter_text_units past its stored bound: not NULL and not an integer (INTEGER affinity has
// already stored numeric text and an integral REAL as one), or outside 0..FILTER_TEXT_UNITS_MAX.
export function filterTextUnitsPastBoundSql(column: string): string {
  return `CASE WHEN ${column} IS NULL THEN 0
	WHEN typeof(${column}) <> 'integer' THEN 1
	WHEN ${column} NOT BETWEEN 0 AND ${FILTER_TEXT_UNITS_MAX} THEN 1
	ELSE 0 END`;
}

// Migration 0079_filter_text_units after its header (test/migrations.test.ts compares them): the column, added without
// a default or CHECK so no row is read or rewritten, triggers that refuse a write where filterTextUnitsPastBoundSql
// holds, and one that clears a measure a text change left behind (one row, by key).
export function filterTextUnitsMigrationSql(): string {
  return `${[
    "ALTER TABLE statuses ADD COLUMN filter_text_units INTEGER;",
    ...boundTriggers(
      "statuses_filter_text",
      "statuses",
      "filter_text_units",
      filterTextUnitsPastBoundSql("NEW.filter_text_units"),
      "statuses: filter_text_units past its stored bound",
    ),
    `CREATE TRIGGER statuses_filter_text_stale AFTER UPDATE OF content, spoiler_text, source_text ON statuses
WHEN NEW.filter_text_units IS NOT NULL
BEGIN
  UPDATE statuses SET filter_text_units = NULL WHERE id = NEW.id;
END;`,
  ].join("\n\n")}\n`;
}

// ---- Account invitations: migration 0081_account_invitations (domain/account-invitations.ts, AUTH-9)

// A local username: 1 to 30 ASCII letters, digits or underscores (setup's step 7 and an invitation alike), so its
// UTF-8 bytes, UTF-16 code units and code points are the same count.
export const LOCAL_USERNAME = /^[A-Za-z0-9_]{1,30}$/;
export const LOCAL_USERNAME_BYTES = 30;
// account_invitations.email, in UTF-8 bytes (RFC 5321's path limit, as set-email's MAX_EMAIL_LENGTH), and the
// invitations kept at most: local accounts are operator-sized (about 10, admin-authority.ts), and an invitation ends
// when its account is made.
export const INVITATION_EMAIL_BYTES = 254;
export const MAX_ACCOUNT_INVITATIONS = 10;

// The email an invitation stores, or null when it is refused: trimmed, then well-formed, within
// INVITATION_EMAIL_BYTES, and one '@' between two parts with no whitespace or control character. Stricter than the
// CHECK below (which refuses only NUL, ASCII controls, the space and DEL, and wants one '@' inside), so a write never
// fails on it.
export function storedInvitationEmail(raw: string): string | null {
  const email = raw.trim();
  if (!email.isWellFormed() || email.length > INVITATION_EMAIL_BYTES) {
    return null;
  }
  return ENCODER.encode(email).length <= INVITATION_EMAIL_BYTES && /^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+$/u.test(email)
    ? email
    : null;
}

// Migration 0081_account_invitations after its header (test/migrations.test.ts compares them): the table, its CHECKs
// (each judging the storage class, then the bytes, then NUL and controls, then the form), the email and the username
// unique by SQLite's lower() (the sign-in's rule, login-email.ts loginEmailMatchSql), the cap and the rule that an
// invitation is added or removed, never changed.
export function accountInvitationsMigrationSql(): string {
  const iso = (column: string) => `typeof(${column}) = 'text' AND length(CAST(${column} AS BLOB)) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) IS ${column} AND substr(${column}, 12, 2) BETWEEN '00' AND '23'`;
  return `${[
    `CREATE TABLE account_invitations (
  email TEXT NOT NULL,
  username TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CONSTRAINT account_invitation_email CHECK (typeof(email) = 'text'
    AND length(CAST(email AS BLOB)) BETWEEN 3 AND ${INVITATION_EMAIL_BYTES}
    AND instr(CAST(email AS BLOB), x'00') = 0
    AND email NOT GLOB ('*[' || char(1) || '-' || char(32) || char(127) || ']*')
    AND instr(email, '@') > 1 AND instr(substr(email, instr(email, '@') + 1), '@') = 0
    AND substr(email, -1) <> '@'),
  CONSTRAINT account_invitation_username CHECK (typeof(username) = 'text'
    AND length(CAST(username AS BLOB)) BETWEEN 1 AND ${LOCAL_USERNAME_BYTES}
    AND instr(CAST(username AS BLOB), x'00') = 0
    AND username NOT GLOB '*[^A-Za-z0-9_]*'),
  CONSTRAINT account_invitation_created_at_iso CHECK (${iso("created_at")})
);`,
    "CREATE UNIQUE INDEX account_invitations_email ON account_invitations (lower(email));",
    "CREATE UNIQUE INDEX account_invitations_username ON account_invitations (lower(username));",
    `CREATE TRIGGER account_invitations_cap BEFORE INSERT ON account_invitations
WHEN (SELECT count(*) FROM account_invitations) >= ${MAX_ACCOUNT_INVITATIONS}
BEGIN
  SELECT RAISE(ABORT, 'account_invitations: more than ${MAX_ACCOUNT_INVITATIONS}');
END;`,
    `CREATE TRIGGER account_invitations_immutable BEFORE UPDATE ON account_invitations
BEGIN
  SELECT RAISE(ABORT, 'account_invitations: an invitation is added or removed, never changed');
END;`,
  ].join("\n\n")}\n`;
}

// ---- Account counts (accounts.followers_count, following_count, statuses_count)
//
// INTEGER NOT NULL DEFAULT 0 with no CHECK or trigger (0000_initial): an imported row may hold TEXT, REAL or a BLOB of
// any size there, and adding a bound would rewrite every account. The bound is kept at both ends instead: every writer
// stores storedCount's values only (a local recount, or a remote account's learned count, remote-collections.ts
// completeCollectionRead), and every read that presents, ranks or sums a count takes presentedCountSql, so no stored
// value past it reaches the Worker or an aggregate.

// The largest count kept, a JavaScript safe integer: 16 decimal digits, presented as at most 16 JSON bytes.
export const MAX_ACCOUNT_COUNT = Number.MAX_SAFE_INTEGER;

// A count as stored (an account's, and a remote poll's tallies and voters): a safe integer from 0 to MAX_ACCOUNT_COUNT,
// otherwise null.
export function storedCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

// A stored count as read: the integer within storedCount's range, else 0 (an imported TEXT, REAL or BLOB never leaves
// SQLite, whatever its size).
export function presentedCountSql(column: string): string {
  return `CASE WHEN typeof(${column}) = 'integer' AND ${column} BETWEEN 0 AND ${MAX_ACCOUNT_COUNT} THEN ${column}
		ELSE 0 END`;
}

// ---- Remote media: migration 0077_remote_media

// The cache of remote media in the media bucket under remote/ (domain/remote-media.ts, the only writer of the three
// tables; MEDIA-7): remote_media holds one slot per remote file per owner, remote_media_objects one row per R2 token
// (reserved before any key exists, stored, or doomed until its deletion is confirmed) with the bytes it is charged,
// and remote_media_usage the sums. Bounds, each in its unit:
// - a slot's url: a card URL (cardUrlPastSql: https, at most CARD_URL_LIMIT printable ASCII bytes); its host and an
//   emoji slot's domain: a link domain (linkDomainPastSql, at most LINK_DOMAIN_BYTES ASCII bytes);
// - kind, category, extension and content type: one of the lists below;
// - REMOTE_MEDIA_MAX_ATTEMPTS: claims since the slot was enqueued or reset; REMOTE_MEDIA_DELETE_ATTEMPTS: failed
//   deletions of a doomed object (its backoff stops growing at a day well before);
// - a token: a server token (cardImageTokenPastSql, 32 to 64 base64url bytes);
// - hosts: a JSON array of at most REMOTE_MEDIA_HOSTS link domains, REMOTE_MEDIA_HOSTS_BYTES bytes;
// - every counter, charge and time: an integer from 0 to SAFE_INTEGER_MAX.
export const REMOTE_MEDIA_KINDS = ["avatar", "header", "attachment", "thumbnail", "emoji"] as const;
export const REMOTE_MEDIA_CATEGORIES = ["image", "video", "audio"] as const;
// The served types and the extension each is served under (media-files.ts REMOTE_SERVED_TYPES keeps the same map).
export const REMOTE_MEDIA_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mp4": "m4a",
  "audio/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/flac": "flac",
  "audio/wav": "wav",
} as const;
export const REMOTE_MEDIA_MAX_ATTEMPTS = 4;
export const REMOTE_MEDIA_DELETE_ATTEMPTS = 64;
export const REMOTE_MEDIA_HOSTS = 4;
export const REMOTE_MEDIA_HOSTS_BYTES = 2 + REMOTE_MEDIA_HOSTS * (LINK_DOMAIN_BYTES + 3);

// The indexes of the three tables (domain/remote-media.ts names them in INDEXED BY).
export const REMOTE_MEDIA_OWNER_INDEX = "remote_media_owner";
export const REMOTE_MEDIA_EMOJI_INDEX = "remote_media_emoji";
export const REMOTE_MEDIA_DUE_INDEX = "remote_media_due";
export const REMOTE_MEDIA_EXPIRY_INDEX = "remote_media_expiry";
export const REMOTE_MEDIA_ACCOUNT_INDEX = "remote_media_account";
export const REMOTE_OBJECTS_SLOT_INDEX = "remote_media_objects_slot";
export const REMOTE_OBJECTS_DUE_INDEX = "remote_media_objects_due";
export const REMOTE_OBJECTS_RETRY_INDEX = "remote_media_objects_retry";
export const REMOTE_OBJECTS_RESERVED_INDEX = "remote_media_objects_reserved";
export const REMOTE_OBJECTS_STORED_INDEX = "remote_media_objects_stored";
export const REMOTE_OBJECTS_VALIDATION_INDEX = "remote_media_objects_validation";

const sqlList = (values: readonly string[]) => `(${values.map((value) => `'${value}'`).join(", ")})`;
const REMOTE_EXTENSIONS = [...new Set(Object.values(REMOTE_MEDIA_TYPES))];

// True when `value` is neither NULL nor a stored remote media extension.
function remoteExtensionPastSql(value: string): string {
  return `CASE WHEN ${value} IS NULL THEN 0
	WHEN typeof(${value}) <> 'text' THEN 1
	WHEN ${value} NOT IN ${sqlList(REMOTE_EXTENSIONS)} THEN 1
	ELSE 0 END`;
}

// True when `value` is neither NULL nor a stored remote media content type.
function remoteTypePastSql(value: string): string {
  return `CASE WHEN ${value} IS NULL THEN 0
	WHEN typeof(${value}) <> 'text' THEN 1
	WHEN ${value} NOT IN ${sqlList(Object.keys(REMOTE_MEDIA_TYPES))} THEN 1
	ELSE 0 END`;
}

// True when the row `row` of remote_media holds a value past its stored bound, column by column in order (id is
// SQLite's rowid, which a BEFORE INSERT trigger reads as -1 before it is assigned), then the invariants: an emoji slot has no owner and a domain, any other an owner and an account; a slot points at its stored
// object (token, ext, stored_at) only while it is neither due nor failed, and a still extension only with it.
export function remoteMediaSlotPastBoundSql(row: string): string {
  const c = (name: string) => `${row}.${name}`;
  return `CASE WHEN typeof(${c("kind")}) <> 'text' OR ${c("kind")} NOT IN ${sqlList(REMOTE_MEDIA_KINDS)} THEN 1
	WHEN ${c("owner_id")} IS NOT NULL AND ${snowflakePastSql(c("owner_id"))} THEN 1
	WHEN ${c("account_id")} IS NOT NULL AND ${snowflakePastSql(c("account_id"))} THEN 1
	WHEN ${c("domain")} IS NOT NULL AND ${linkDomainPastSql(c("domain"))} THEN 1
	WHEN ${cardUrlPastSql(c("url"), false)} THEN 1
	WHEN ${linkDomainPastSql(c("host"))} THEN 1
	WHEN typeof(${c("category")}) <> 'text' OR ${c("category")} NOT IN ${sqlList(REMOTE_MEDIA_CATEGORIES)} THEN 1
	${cardCountCase(c("lane"), false, 1)}
	${cardCountCase(c("generation"), false, SAFE_INTEGER_MAX)}
	${cardCountCase(c("due_at"), true, SAFE_INTEGER_MAX)}
	${cardCountCase(c("enqueued_at"), false, SAFE_INTEGER_MAX)}
	${cardCountCase(c("claim"), false, SAFE_INTEGER_MAX)}
	${cardCountCase(c("attempts"), false, REMOTE_MEDIA_MAX_ATTEMPTS)}
	WHEN ${cardImageTokenPastSql(c("token"))} THEN 1
	WHEN ${remoteExtensionPastSql(c("ext"))} THEN 1
	WHEN ${remoteExtensionPastSql(c("still_ext"))} THEN 1
	${cardCountCase(c("stored_at"), true, SAFE_INTEGER_MAX)}
	${cardCountCase(c("failed_at"), true, SAFE_INTEGER_MAX)}
	${cardCountCase(c("seen_at"), true, SAFE_INTEGER_MAX)}
	WHEN (${c("owner_id")} IS NULL) <> (${c("kind")} = 'emoji') THEN 1
	WHEN (${c("account_id")} IS NULL) <> (${c("kind")} = 'emoji') THEN 1
	WHEN (${c("domain")} IS NULL) = (${c("kind")} = 'emoji') THEN 1
	WHEN (${c("token")} IS NULL) <> (${c("ext")} IS NULL) OR (${c("token")} IS NULL) <> (${c("stored_at")} IS NULL) THEN 1
	WHEN ${c("token")} IS NOT NULL AND (${c("due_at")} IS NOT NULL OR ${c("failed_at")} IS NOT NULL) THEN 1
	WHEN ${c("still_ext")} IS NOT NULL AND ${c("token")} IS NULL THEN 1
	WHEN ${c("failed_at")} IS NOT NULL AND ${c("due_at")} IS NOT NULL THEN 1
	ELSE 0 END`;
}

// True when `value` is no stored hosts list: NULL is one; else a JSON array of 1 to REMOTE_MEDIA_HOSTS link domains
// within REMOTE_MEDIA_HOSTS_BYTES bytes, judged in order (the storage class, the bytes, NUL, the JSON, each element).
export function remoteHostsPastSql(value: string): string {
  return `CASE WHEN ${value} IS NULL THEN 0
	WHEN typeof(${value}) <> 'text' THEN 1
	WHEN length(CAST(${value} AS BLOB)) > ${REMOTE_MEDIA_HOSTS_BYTES} THEN 1
	WHEN instr(CAST(${value} AS BLOB), x'00') > 0 THEN 1
	WHEN NOT json_valid(${value}) OR json_type(${value}) <> 'array' THEN 1
	WHEN json_array_length(${value}) NOT BETWEEN 1 AND ${REMOTE_MEDIA_HOSTS} THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(${value}) h WHERE h.type <> 'text' OR ${linkDomainPastSql("h.value")}) THEN 1
	ELSE 0 END`;
}

// True when the row `row` of remote_media_objects holds a value past its stored bound, then the invariants: a
// doomed object has a deletion time and no slot, a live one a slot and no deletion time; a stored object has its type
// and time, a reserved one neither; a still type only with a type.
export function remoteMediaObjectPastBoundSql(row: string): string {
  const c = (name: string) => `${row}.${name}`;
  return `CASE WHEN ${c("token")} IS NULL OR ${cardImageTokenPastSql(c("token"))} THEN 1
	WHEN ${c("slot_id")} IS NOT NULL AND (typeof(${c("slot_id")}) <> 'integer' OR ${c("slot_id")} NOT BETWEEN 1 AND ${SAFE_INTEGER_MAX}) THEN 1
	WHEN typeof(${c("state")}) <> 'text' OR ${c("state")} NOT IN ('reserved', 'stored', 'doomed') THEN 1
	${cardCountCase(c("charge"), false, SAFE_INTEGER_MAX)}
	WHEN typeof(${c("kind")}) <> 'text' OR ${c("kind")} NOT IN ${sqlList(REMOTE_MEDIA_KINDS)} THEN 1
	WHEN ${remoteTypePastSql(c("content_type"))} THEN 1
	WHEN ${remoteTypePastSql(c("still_type"))} THEN 1
	WHEN ${remoteHostsPastSql(c("hosts"))} THEN 1
	${cardCountCase(c("claimed_at"), false, SAFE_INTEGER_MAX)}
	${cardCountCase(c("stored_at"), true, SAFE_INTEGER_MAX)}
	${cardCountCase(c("due_at"), true, SAFE_INTEGER_MAX)}
	${cardCountCase(c("delete_attempts"), false, REMOTE_MEDIA_DELETE_ATTEMPTS)}
	WHEN (${c("state")} = 'doomed') <> (${c("due_at")} IS NOT NULL) THEN 1
	WHEN (${c("state")} = 'doomed') = (${c("slot_id")} IS NOT NULL) THEN 1
	WHEN ${c("state")} = 'stored' AND (${c("content_type")} IS NULL OR ${c("stored_at")} IS NULL) THEN 1
	WHEN ${c("state")} = 'reserved' AND (${c("content_type")} IS NOT NULL OR ${c("stored_at")} IS NOT NULL) THEN 1
	WHEN ${c("still_type")} IS NOT NULL AND ${c("content_type")} IS NULL THEN 1
	ELSE 0 END`;
}

// True when the usage row holds a value past its bound: the one row (id 1), its sums integers within range, the
// doomed bytes within the bytes.
export function remoteMediaUsagePastBoundSql(row: string): string {
  const c = (name: string) => `${row}.${name}`;
  return `CASE WHEN typeof(${c("id")}) <> 'integer' OR ${c("id")} <> 1 THEN 1
	${cardCountCase(c("bytes"), false, SAFE_INTEGER_MAX)}
	${cardCountCase(c("doomed"), false, SAFE_INTEGER_MAX)}
	${cardCountCase(c("pending"), false, SAFE_INTEGER_MAX)}
	WHEN ${c("doomed")} > ${c("bytes")} THEN 1
	ELSE 0 END`;
}

export const REMOTE_MEDIA_COLUMNS = [
  "id",
  "kind",
  "owner_id",
  "account_id",
  "domain",
  "url",
  "host",
  "category",
  "lane",
  "generation",
  "due_at",
  "enqueued_at",
  "claim",
  "attempts",
  "token",
  "ext",
  "still_ext",
  "stored_at",
  "failed_at",
  "seen_at",
] as const;

export const REMOTE_MEDIA_OBJECT_COLUMNS = [
  "token",
  "slot_id",
  "state",
  "charge",
  "kind",
  "content_type",
  "still_type",
  "hosts",
  "claimed_at",
  "stored_at",
  "due_at",
  "delete_attempts",
] as const;

// Migration 0077_remote_media after its header (test/migrations.test.ts compares them): the three empty tables, their
// indexes and bounds triggers, and the usage row. No existing table changes and none is read.
export function remoteMediaMigrationSql(): string {
  return `${[
    `CREATE TABLE remote_media (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  owner_id TEXT,
  account_id TEXT,
  domain TEXT,
  url TEXT NOT NULL,
  host TEXT NOT NULL,
  category TEXT NOT NULL,
  lane INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  due_at INTEGER,
  enqueued_at INTEGER NOT NULL,
  claim INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  token TEXT,
  ext TEXT,
  still_ext TEXT,
  stored_at INTEGER,
  failed_at INTEGER,
  seen_at INTEGER
);`,
    [
      `CREATE UNIQUE INDEX ${REMOTE_MEDIA_OWNER_INDEX} ON remote_media (owner_id, kind) WHERE owner_id IS NOT NULL;`,
      `CREATE UNIQUE INDEX ${REMOTE_MEDIA_EMOJI_INDEX} ON remote_media (domain, url) WHERE kind = 'emoji';`,
      `CREATE INDEX ${REMOTE_MEDIA_DUE_INDEX} ON remote_media (lane, due_at, id) WHERE due_at IS NOT NULL;`,
      `CREATE INDEX ${REMOTE_MEDIA_EXPIRY_INDEX} ON remote_media (enqueued_at) WHERE due_at IS NOT NULL;`,
      `CREATE INDEX ${REMOTE_MEDIA_ACCOUNT_INDEX} ON remote_media (account_id) WHERE account_id IS NOT NULL;`,
    ].join("\n"),
    ...boundTriggers(
      "remote_media_bounds",
      "remote_media",
      REMOTE_MEDIA_COLUMNS.join(", "),
      remoteMediaSlotPastBoundSql("NEW"),
      "remote_media: a value past its stored bound",
    ),
    `CREATE TABLE remote_media_objects (
  token TEXT NOT NULL PRIMARY KEY,
  slot_id INTEGER,
  state TEXT NOT NULL,
  charge INTEGER NOT NULL,
  kind TEXT NOT NULL,
  content_type TEXT,
  still_type TEXT,
  hosts TEXT,
  claimed_at INTEGER NOT NULL,
  stored_at INTEGER,
  due_at INTEGER,
  delete_attempts INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;`,
    [
      `CREATE UNIQUE INDEX ${REMOTE_OBJECTS_SLOT_INDEX} ON remote_media_objects (slot_id) WHERE slot_id IS NOT NULL;`,
      `CREATE INDEX ${REMOTE_OBJECTS_DUE_INDEX} ON remote_media_objects (due_at) WHERE state = 'doomed' AND delete_attempts = 0;`,
      `CREATE INDEX ${REMOTE_OBJECTS_RETRY_INDEX} ON remote_media_objects (due_at) WHERE state = 'doomed' AND delete_attempts > 0;`,
      `CREATE INDEX ${REMOTE_OBJECTS_RESERVED_INDEX} ON remote_media_objects (claimed_at) WHERE state = 'reserved';`,
      `CREATE INDEX ${REMOTE_OBJECTS_STORED_INDEX} ON remote_media_objects (kind, stored_at) WHERE state = 'stored';`,
      `CREATE INDEX ${REMOTE_OBJECTS_VALIDATION_INDEX} ON remote_media_objects (token) WHERE state = 'stored';`,
    ].join("\n"),
    ...boundTriggers(
      "remote_media_objects_bounds",
      "remote_media_objects",
      REMOTE_MEDIA_OBJECT_COLUMNS.join(", "),
      remoteMediaObjectPastBoundSql("NEW"),
      "remote_media_objects: a value past its stored bound",
    ),
    `CREATE TABLE remote_media_usage (
  id INTEGER PRIMARY KEY,
  bytes INTEGER NOT NULL,
  doomed INTEGER NOT NULL,
  pending INTEGER NOT NULL
);`,
    ...boundTriggers(
      "remote_media_usage_bounds",
      "remote_media_usage",
      "id, bytes, doomed, pending",
      remoteMediaUsagePastBoundSql("NEW"),
      "remote_media_usage: a value past its stored bound",
    ),
    "INSERT INTO remote_media_usage (id, bytes, doomed, pending) VALUES (1, 0, 0, 0);",
  ].join("\n\n")}\n`;
}
