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
export const DISPLAY_NAME_LIMIT = 2048
// Profile URLs (url, avatar, header), in UTF-8 bytes; a serialized URL is ASCII.
export const PROFILE_URL_LIMIT = 2048
// A status's url, in UTF-8 bytes, as identity-bounds.ts STATUS_URI_LIMIT bounds its uri.
export const STATUS_URL_LIMIT = 4096
// A media URL (url, preview_url), in UTF-8 bytes.
export const MEDIA_URL_LIMIT = 2048
// A media row's meta, in UTF-8 bytes: the stored dimensions ({"original":{...},"small":{...}}) take about 80.
export const MEDIA_META_BYTES = 1024
// A media description, in code points, as Mastodon's MAX_DESCRIPTION_HARD_LENGTH_LIMIT.
export const MAX_MEDIA_DESCRIPTION_LENGTH = 10_000
// A poll's choices (RES-4): at most this many, each at most this many code points as read.
export const MAX_REMOTE_OPTIONS = 100
export const MAX_REMOTE_OPTION_LENGTH = 1000
// polls.options as its CHECK bounds it (migration 0013), in UTF-8 bytes; an edit's poll_options past it reads as none.
export const POLL_OPTIONS_BYTES = 655_360
// The JSON-string bounds of security/html.ts (REMOTE_BIO_BYTES, STATUS_CONTENT_BYTES, SPOILER_BYTES), in UTF-8 bytes
// of the escaped string with its quotes.
export const BIO_JSON_BYTES = 64 * 1024
export const CONTENT_JSON_BYTES = 128 * 1024
export const SPOILER_JSON_BYTES = 16 * 1024

// ---- Projections (P)

// SQLite's substr and length stop at an embedded NUL, so a string is cut only when its UTF-8 bytes pass the limit
// (a code point is never longer than its bytes). A string containing a NUL is kept whole while its UTF-8 bytes fit
// the limit; otherwise it may come out shorter than a cut in code units would be, never longer.
export function cutSql(column: string, limit: number): string {
	return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${limit} THEN ${column} ELSE substr(${column}, 1, ${limit}) END`
}

// `column` when its JSON string (json_quote: quotes and escapes, as JSON.stringify writes them) is at most `bytes`
// UTF-8 bytes, else `over`. json_quote measures it only below the raw bound, so its escaped copy stays far below
// SQLite's largest string.
export function jsonBoundSql(column: string, bytes: number, over: string): string {
	return `CASE WHEN length(CAST(${column} AS BLOB)) > ${bytes} THEN ${over}
	WHEN length(CAST(json_quote(${column}) AS BLOB)) > ${bytes} THEN ${over} ELSE ${column} END`
}

// A text value cut to its first `bytes` UTF-8 bytes, counted as bytes: SQLite's length and substr count characters,
// skipping continuation bytes, so a malformed imported value would pass a character cut whole. Each byte presents as
// at most six JSON bytes (a control character escaped, or a malformed byte decoded to U+FFFD: three).
export function byteCut(column: string, bytes: number): string {
	return `CAST(substr(CAST(${column} AS BLOB), 1, ${bytes}) AS TEXT)`
}

// A NULL past `bytes` UTF-8 bytes.
export function byteBoundSql(column: string, bytes: number): string {
	return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${bytes} THEN ${column} END`
}

// accounts.display_name: cut at DISPLAY_NAME_LIMIT code points.
export function displayNameSql(column: string): string {
	return cutSql(column, DISPLAY_NAME_LIMIT)
}

// accounts.note: '' past BIO_JSON_BYTES as a JSON string.
export function noteSql(column: string): string {
	return jsonBoundSql(column, BIO_JSON_BYTES, "''")
}

// accounts.url, avatar_url and header_url: NULL past PROFILE_URL_LIMIT.
export function profileUrlSql(column: string): string {
	return byteBoundSql(column, PROFILE_URL_LIMIT)
}

// statuses.content and status_edits.content: '' past CONTENT_JSON_BYTES as a JSON string. The status keeps its url,
// which links its original.
export function contentSql(column: string): string {
	return jsonBoundSql(column, CONTENT_JSON_BYTES, "''")
}

// statuses.source_text: '' past CONTENT_JSON_BYTES (a local one is at most 10,000 code units, 60 KB escaped).
export function sourceTextSql(column: string): string {
	return jsonBoundSql(column, CONTENT_JSON_BYTES, "''")
}

// statuses.spoiler_text and status_edits.spoiler_text: past SPOILER_JSON_BYTES, cut to the code points that fit
// however they escape (6 bytes each at most), so the warning stays.
export function spoilerSql(column: string): string {
	return jsonBoundSql(column, SPOILER_JSON_BYTES, `substr(${column}, 1, ${Math.floor((SPOILER_JSON_BYTES - 2) / 6)})`)
}

// statuses.url: NULL past STATUS_URL_LIMIT, so it reads as its uri.
export function statusUrlSql(column: string): string {
	return byteBoundSql(column, STATUS_URL_LIMIT)
}

// media_attachments.url and preview_url: NULL past MEDIA_URL_LIMIT, as an invalid one. url is NOT NULL, so its
// writer stores '' instead, which presentMedia shows as null.
export function mediaUrlSql(column: string): string {
	return byteBoundSql(column, MEDIA_URL_LIMIT)
}

// media_attachments.description: cut at MAX_MEDIA_DESCRIPTION_LENGTH code points.
export function mediaDescriptionSql(column: string): string {
	return cutSql(column, MAX_MEDIA_DESCRIPTION_LENGTH)
}

// media_attachments.meta: NULL past MEDIA_META_BYTES, as no meta.
export function mediaMetaSql(column: string): string {
	return byteBoundSql(column, MEDIA_META_BYTES)
}

// A poll's choices (polls.options, status_edits.poll_options) as a JSON array: the first MAX_REMOTE_OPTIONS, each cut
// at MAX_REMOTE_OPTION_LENGTH (cutSql); NULL (no poll) past POLL_OPTIONS_BYTES. A stored choice is longer only in a
// converted row; a vote names it as stored (polls.ts cut_options). An edit's snapshot stores P of the poll's choices,
// evaluated inside SQLite (statuses.ts recordEdit).
export function pollOptionsSql(column: string): string {
	return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${POLL_OPTIONS_BYTES} THEN
		(SELECT json_group_array(${cutSql('value', MAX_REMOTE_OPTION_LENGTH)} ORDER BY key) FROM json_each(${column})
			WHERE key < ${MAX_REMOTE_OPTIONS}) END`
}

// ---- Writers

const ENCODER = new TextEncoder()

// `value` when its UTF-8 bytes as SQLite stores it are at most `bytes` (a lone surrogate takes three bytes, as U+FFFD
// or as workerd binds it), else none.
function withinBytes(value: string | null, bytes: number): string | null {
	return value !== null && ENCODER.encode(value).length <= bytes ? value : null
}

// Text as stored: well-formed and without U+0000. workerd binds a lone surrogate as its three-byte surrogate encoding,
// which reads back as three U+FFFD; replaced first, it is one U+FFFD either way. Mastodon's JSON parsing refuses
// invalid UTF-8, so nothing it would keep is lost. PostgreSQL text cannot hold U+0000, so Mastodon never stores one;
// SQLite's substr and length stop at it.
export function storedText(text: string): string {
	const wellFormed = text.toWellFormed()
	return wellFormed.includes('\u0000') ? wellFormed.replaceAll('\u0000', '') : wellFormed
}

// The first `limit` code points of `text`. A string has at least as many code units as code points.
export function cutCodePoints(text: string, limit: number): string {
	if (text.length <= limit) {
		return text
	}
	let points = 0
	let end = 0
	for (const char of text) {
		if (points === limit) {
			return text.slice(0, end)
		}
		points++
		end += char.length
	}
	return text
}

// accounts.display_name as stored: storedText's output, at most DISPLAY_NAME_LIMIT code points.
export function storedDisplayName(text: string): string {
	return cutCodePoints(storedText(text), DISPLAY_NAME_LIMIT)
}

// media_attachments.description as stored: storedText's output, at most MAX_MEDIA_DESCRIPTION_LENGTH code points.
export function storedMediaDescription(text: string): string {
	return cutCodePoints(storedText(text), MAX_MEDIA_DESCRIPTION_LENGTH)
}

// accounts.url, avatar_url and header_url as stored: none past PROFILE_URL_LIMIT.
export function storedProfileUrl(url: string | null): string | null {
	return withinBytes(url, PROFILE_URL_LIMIT)
}

// statuses.url as stored: none past STATUS_URL_LIMIT.
export function storedStatusUrl(url: string | null): string | null {
	return withinBytes(url, STATUS_URL_LIMIT)
}

// media_attachments.preview_url as stored, and a media URL where none is a value: none past MEDIA_URL_LIMIT.
export function storedMediaLink(url: string | null): string | null {
	return withinBytes(url, MEDIA_URL_LIMIT)
}

// media_attachments.url as stored (NOT NULL): '' past MEDIA_URL_LIMIT. A row with a file token holds a URL Kopje
// built (platform/media-files.ts mediaUrl), always within it.
export function storedMediaUrl(url: string): string {
	return storedMediaLink(url) ?? ''
}

// media_attachments.meta as stored: none past MEDIA_META_BYTES.
export function storedMediaMeta(meta: string | null): string | null {
	return withinBytes(meta, MEDIA_META_BYTES)
}

// ---- Migration 0048_stored_bounds and its triggers

// A covered column: its projection P and, where P's value cannot be stored (a NOT NULL column), what is stored.
type StoredColumn = {
	column: string
	projection: (column: string) => string
	// A JSON-bounded column's bound: a value of at most a sixth of it (less the quotes) in UTF-8 bytes cannot escape past
	// it, so the test skips P (and json_quote) for it.
	jsonBytes?: number
	stored?: (column: string) => string
}

// The columns 0048_stored_bounds and its triggers cover. accounts.uri and username, statuses.uri, status_tags.name,
// polls.options and status_edits.media_json keep their read-time projections and are not here;
// media_attachments.blurhash has triggers of its own (0065_media_blurhash).
export const STORED_COLUMNS: Readonly<Record<string, readonly StoredColumn[]>> = {
	statuses: [
		{ column: 'content', projection: contentSql, jsonBytes: CONTENT_JSON_BYTES },
		{ column: 'spoiler_text', projection: spoilerSql, jsonBytes: SPOILER_JSON_BYTES },
		{ column: 'source_text', projection: sourceTextSql, jsonBytes: CONTENT_JSON_BYTES },
		{ column: 'url', projection: statusUrlSql },
	],
	accounts: [
		{ column: 'display_name', projection: displayNameSql },
		{ column: 'note', projection: noteSql, jsonBytes: BIO_JSON_BYTES },
		{ column: 'url', projection: profileUrlSql },
		{ column: 'avatar_url', projection: profileUrlSql },
		{ column: 'header_url', projection: profileUrlSql },
	],
	media_attachments: [
		// A row with a file token holds a URL mediaUrl (media-files.ts) built within the bound; the migration checks it.
		{
			column: 'url',
			projection: mediaUrlSql,
			stored: (column) => `coalesce(${mediaUrlSql(column)}, '')`,
		},
		{ column: 'preview_url', projection: mediaUrlSql },
		{ column: 'description', projection: mediaDescriptionSql },
		{ column: 'meta', projection: mediaMetaSql },
	],
	status_edits: [
		{ column: 'content', projection: contentSql, jsonBytes: CONTENT_JSON_BYTES },
		{ column: 'spoiler_text', projection: spoilerSql, jsonBytes: SPOILER_JSON_BYTES },
		{ column: 'poll_options', projection: pollOptionsSql },
	],
}

// The BEFORE INSERT and BEFORE UPDATE OF `watched` triggers `<prefix>_insert` and `<prefix>_update` on `table` that
// abort with `message` when `when` holds of the NEW row.
function boundTriggers(prefix: string, table: string, watched: string, when: string, message: string): string[] {
	const body = `BEGIN\n  SELECT RAISE(ABORT, '${message}');\nEND;`
	return [
		`CREATE TRIGGER ${prefix}_insert BEFORE INSERT ON ${table}\nWHEN ${when}\n${body}`,
		`CREATE TRIGGER ${prefix}_update BEFORE UPDATE OF ${watched} ON ${table}\nWHEN ${when}\n${body}`,
	]
}

// True when `column` is not a fixed point of its projection: P(x) IS NOT x, with JSON-bounded columns short of a sixth
// of their bound skipped before P.
function pastBoundSql({ projection, jsonBytes }: StoredColumn, column: string): string {
	const moved = `(${projection(column)}) IS NOT ${column}`
	return jsonBytes === undefined
		? moved
		: `CASE WHEN length(CAST(${column} AS BLOB)) <= ${Math.floor((jsonBytes - 2) / 6)} THEN 0 ELSE ${moved} END`
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
		'DROP TABLE stored_bounds_check;',
	]
	for (const [table, columns] of Object.entries(STORED_COLUMNS)) {
		const set = columns.map((c) => `  ${c.column} = ${(c.stored ?? c.projection)(c.column)}`).join(',\n')
		const where = columns.map((c) => pastBoundSql(c, c.column)).join('\n  OR ')
		statements.push(`UPDATE ${table} SET\n${set}\nWHERE ${where};`)
	}
	for (const [table, columns] of Object.entries(STORED_COLUMNS)) {
		const when = columns.map((c) => pastBoundSql(c, `NEW.${c.column}`)).join('\n  OR ')
		const names = columns.map((c) => c.column).join(', ')
		statements.push(...boundTriggers(`${table}_bounds`, table, names, when, `${table}: a value past its stored bound`))
	}
	return `${statements.join('\n\n')}\n`
}

// ---- Instance settings: migration 0049_instance_bounds and its triggers

// The instance's public settings (instance_settings rows, data rather than configuration: access-settings.ts
// CONFIG_KEYS). Each name has a projection P, the SQL value stored for a value, NULL where no row is stored, and a
// writer, its JS twin over storedText's output. The admin write (domain/instance.ts setInstanceSettings) refuses what
// its writer would change or drop; the cutover's conversion and verification store the writer's output and count
// what it changed (cli/lib/cutover). Reads take these rows as stored.

// title, in code points (at most 4 KiB): a label, cut past the bound. Mastodon sets no limit.
export const INSTANCE_TITLE_LIMIT = 1024
// description, in code points: Mastodon's DESCRIPTION_LIMIT (app/models/form/admin_settings.rb:86,107), cut past it.
export const INSTANCE_DESCRIPTION_LIMIT = 200
// contact_email, in UTF-8 bytes (RFC 5321's path limit); no row past it.
export const CONTACT_EMAIL_BYTES = 254
// rules, a JSON array, in UTF-8 bytes; no row past it (a cut array is not JSON).
export const INSTANCE_RULES_BYTES = 65_536
// extended_description, privacy_policy and terms_of_service, HTML in UTF-8 bytes; no row past it (a cut document
// loses its end). At most 50,000 UTF-16 code units too, so security/html.ts REMOTE_HTML_RAW_LIMIT never cuts one.
export const INSTANCE_DOCUMENT_BYTES = 50_000

export const INSTANCE_DOCUMENTS = ['extended_description', 'privacy_policy', 'terms_of_service'] as const
export type InstanceDocument = (typeof INSTANCE_DOCUMENTS)[number]

// show_domain_blocks and show_domain_blocks_rationale, as Mastodon's settings (config/settings.yml:29-30).
export const DOMAIN_BLOCKS_SHOWN = ['disabled', 'users', 'all'] as const
export type DomainBlocksShown = (typeof DOMAIN_BLOCKS_SHOWN)[number]

// The characters a blank value consists of, SQL's and JS's alike: space, tab, LF, VT, FF and CR. Not String#trim's
// set, which SQLite's trim cannot list (it includes U+00A0, U+3000 and the other Unicode spaces).
const BLANK_CODES = [32, 9, 10, 11, 12, 13]
const BLANK = new Set(BLANK_CODES.map((code) => String.fromCharCode(code)))

export function isBlank(text: string): boolean {
	for (const char of text) {
		if (!BLANK.has(char)) {
			return false
		}
	}
	return true
}

// `text` without blank characters at either end.
export function trimBlank(text: string): string {
	let start = 0
	let end = text.length
	while (start < end && BLANK.has(text[start] ?? '')) {
		start++
	}
	while (end > start && BLANK.has(text[end - 1] ?? '')) {
		end--
	}
	return text.slice(start, end)
}

function blankSql(column: string): string {
	return `trim(${column}, char(${BLANK_CODES.join(', ')})) = ''`
}

// A calendar date, YYYY-MM-DD, as SQLite's date() writes it.
function isCalendarDate(text: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
		return false
	}
	const parsed = new Date(`${text}T00:00:00.000Z`)
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text
}

// A time as Date#toISOString writes it for years 0 to 9999 (24 bytes), as SQLite's strftime('%Y-%m-%dT%H:%M:%fZ').
function isIsoTime(text: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text)) {
		return false
	}
	const parsed = new Date(text)
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === text
}

function isJsonArray(text: string): boolean {
	try {
		return Array.isArray(JSON.parse(text))
	} catch {
		return false
	}
}

const ISO_TIME_FORMAT = '%Y-%m-%dT%H:%M:%fZ'

// A setting's projection P and writer. `cut`, for a name cut past its bound: the value 0049 rewrites it to before it
// deletes the rows whose P is NULL.
type InstanceSettingBound = {
	projection: (column: string) => string
	writer: (value: string) => string | null
	cut?: (column: string) => string
}

// Text cut at `points` code points, and no row when blank.
function cutText(points: number): InstanceSettingBound {
	return {
		projection: (column) =>
			`CASE WHEN ${blankSql(cutSql(column, points))} THEN NULL ELSE ${cutSql(column, points)} END`,
		writer: (value) => {
			const cut = cutCodePoints(storedText(value), points)
			return isBlank(cut) ? null : cut
		},
		cut: (column) => cutSql(column, points),
	}
}

// Text of at most `bytes` UTF-8 bytes, and no row when blank or past them.
function boundedText(bytes: number): InstanceSettingBound {
	return {
		projection: (column) =>
			`CASE WHEN length(CAST(${column} AS BLOB)) > ${bytes} THEN NULL WHEN ${blankSql(column)} THEN NULL ELSE ${column} END`,
		writer: (value) => {
			const text = withinBytes(storedText(value), bytes)
			return text === null || isBlank(text) ? null : text
		},
	}
}

// One of `values`, else no row.
function oneOf(values: readonly string[]): InstanceSettingBound {
	return {
		projection: (column) => `CASE WHEN ${column} IN (${values.map((v) => `'${v}'`).join(', ')}) THEN ${column} END`,
		writer: (value) => (values.includes(value) ? value : null),
	}
}

const DOCUMENT = boundedText(INSTANCE_DOCUMENT_BYTES)
const SHOWN = oneOf(DOMAIN_BLOCKS_SHOWN)
// A document's stamp (the time an admin write changed it): written only by setInstanceSettings. SQLite's strftime
// writes an hour of 24 back as given, which Date#toISOString never writes.
const STAMP: InstanceSettingBound = {
	projection: (column) =>
		`CASE WHEN length(CAST(${column} AS BLOB)) = 24 AND substr(${column}, 12, 2) < '24'
	AND strftime('${ISO_TIME_FORMAT}', ${column}) = ${column} THEN ${column} END`,
	writer: (value) => (isIsoTime(value) ? value : null),
}

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
			const text = withinBytes(storedText(value), INSTANCE_RULES_BYTES)
			return text !== null && isJsonArray(text) ? text : null
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
} as const satisfies Record<string, InstanceSettingBound>

export type InstanceSettingName = keyof typeof INSTANCE_SETTING_BOUNDS

export const INSTANCE_SETTING_NAMES = Object.keys(INSTANCE_SETTING_BOUNDS) as InstanceSettingName[]

// The value `name` stores for `value` (storedText's output where it is text), or null for no row.
export function storedInstanceSetting(name: InstanceSettingName, value: string): string | null {
	return INSTANCE_SETTING_BOUNDS[name].writer(value)
}

// True when a row named `name` holding `value` is not a fixed point of its name's P; 0 for an uncovered name.
function settingPastBoundSql(name: string, value: string): string {
	const cases = INSTANCE_SETTING_NAMES.map(
		(n) => `WHEN '${n}' THEN (${INSTANCE_SETTING_BOUNDS[n].projection(value)}) IS NOT ${value}`
	)
	return `CASE ${name}\n  ${cases.join('\n  ')}\n  ELSE 0 END`
}

// Migration 0049_instance_bounds after its header (test/migrations.test.ts compares them): the cut names rewritten,
// then every row whose P is NULL deleted, then triggers that refuse a write where P(NEW.value) IS NOT NEW.value, and
// the partial index of the public block list (domain/instance-domain-blocks.ts publicDomainBlocks).
export function instanceBoundsMigrationSql(): string {
	const statements: string[] = []
	const names = INSTANCE_SETTING_NAMES.map((n) => `'${n}'`).join(', ')
	for (const name of INSTANCE_SETTING_NAMES) {
		const { cut } = INSTANCE_SETTING_BOUNDS[name] as InstanceSettingBound
		if (cut !== undefined) {
			statements.push(
				`UPDATE instance_settings SET value = ${cut('value')}\nWHERE name = '${name}' AND (${cut('value')}) IS NOT value;`
			)
		}
	}
	statements.push(
		`DELETE FROM instance_settings\nWHERE name IN (${names}) AND ${settingPastBoundSql('name', 'value')};`
	)
	const when = settingPastBoundSql('NEW.name', 'NEW.value')
	statements.push(
		...boundTriggers(
			'instance_settings_bounds',
			'instance_settings',
			'name, value',
			when,
			'instance_settings: a value past its stored bound'
		)
	)
	statements.push(
		"CREATE INDEX instance_domain_blocks_public ON instance_domain_blocks (domain) WHERE severity = 'suspend';"
	)
	return `${statements.join('\n\n')}\n`
}

// ---- Custom emoji snapshots: migration 0053_custom_emoji_snapshots and its triggers

// statuses.emojis, status_edits.emojis and accounts.emojis (RES-2): NULL, or a JSON array of [shortcode, url] pairs in
// tag order, written by domain/custom-emojis.ts emojiSnapshot and presented by its presentEmojis. A shortcode matches
// EMOJI_SHORTCODE, as Mastodon's MAX_SHORTCODE_SIZE (app/models/custom_emoji.rb:29) and Misskey's name column
// (models/Emoji.ts) bound it; a url is http(s), at most EMOJI_URL_LIMIT bytes and within EMOJI_URL_ALPHABET, so a
// presented entry needs no JSON escape. A boost row's value is never read (status-rows.ts STATUS_COLUMN_MAP).
export const EMOJI_SHORTCODE = /^[A-Za-z0-9_+-]{1,128}$/
export const EMOJI_SHORTCODE_LIMIT = 128
// In UTF-8 bytes of the normalized href: Misskey's url columns hold 512 characters (models/Emoji.ts).
export const EMOJI_URL_LIMIT = 512
// '!' to '~' but '"' and '\': a literal '\' can survive WHATWG normalization in a query or fragment.
export const EMOJI_URL_ALPHABET = /^[!#-[\]-~]+$/
// Emoji tags examined per object (RES-1), and entries per snapshot.
export const MAX_EMOJI_TAGS = 64
export const MAX_EMOJIS = 64
// The presented JSON bytes of Status.emojis (and StatusEdit's, and a Poll's, a subset) and of Account.emojis; also the
// stored UTF-8 bytes of the columns. Entries are {"shortcode":n,"url":u,"static_url":u,"visible_in_picker":true}.
// For shortcode length n and URL length u, a nonempty presented array occupies
// 1 + Σ(EMOJI_ENTRY_BYTES + n + 2u) bytes, including separators (presentedEmojiBytes).
export const STATUS_EMOJIS_BYTES = 12_288
export const ACCOUNT_EMOJIS_BYTES = 6_144
export const EMOJI_ENTRY_BYTES = 67

// The presented JSON bytes of `pairs` as Status.emojis: none needs an escape (EMOJI_SHORTCODE, EMOJI_URL_ALPHABET).
export function presentedEmojiBytes(pairs: readonly (readonly [string, string])[]): number {
	return pairs.length === 0
		? 2
		: 1 + pairs.reduce((sum, [n, u]) => sum + EMOJI_ENTRY_BYTES + n.length + 2 * u.length, 0)
}

// Whether `url` may be stored and presented as an emoji's: http(s), within EMOJI_URL_LIMIT and EMOJI_URL_ALPHABET.
export function isEmojiUrl(url: string): boolean {
	return url.length <= EMOJI_URL_LIMIT && EMOJI_URL_ALPHABET.test(url) && /^https?:\/\/./.test(url)
}

// The JS twin of emojisPastBoundSql: whether `text`, as stored, is a snapshot within `bytes` (NULL is).
export function emojisValid(text: string | null, bytes: number): boolean {
	if (text === null) {
		return true
	}
	if (text.includes('\u0000') || new TextEncoder().encode(text).length > bytes) {
		return false
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		return false
	}
	if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_EMOJIS) {
		return false
	}
	const names = new Set<string>()
	const pairs: [string, string][] = []
	for (const entry of parsed as unknown[]) {
		if (!Array.isArray(entry) || entry.length !== 2) {
			return false
		}
		const [name, url] = entry as unknown[]
		if (typeof name !== 'string' || typeof url !== 'string' || !EMOJI_SHORTCODE.test(name) || !isEmojiUrl(url)) {
			return false
		}
		if (names.has(name)) {
			return false
		}
		names.add(name)
		pairs.push([name, url])
	}
	return presentedEmojiBytes(pairs) <= bytes
}

// True when `column` holds a value emojisValid refuses: false for NULL, true for a value that is not text. Judged as
// stored: the byte bound first, so nothing else scans a value past it; then a raw NUL anywhere (SQLite's JSON
// functions stop at one, so a complete value followed by NUL and anything would pass them); then the shape, each
// element (`->>` decodes escapes, and a decoded name or url whose bytes and characters differ holds a NUL or a
// non-ASCII character), the names once each, and the presented size.
export function emojisPastBoundSql(column: string, bytes: number): string {
	const name = "e.value ->> '$[0]'"
	const url = "e.value ->> '$[1]'"
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
		ELSE 0 END`
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
	ELSE 0 END`
}

// The snapshot columns and their stored bounds.
export const EMOJI_COLUMNS: Readonly<Record<'statuses' | 'status_edits' | 'accounts', number>> = {
	statuses: STATUS_EMOJIS_BYTES,
	status_edits: STATUS_EMOJIS_BYTES,
	accounts: ACCOUNT_EMOJIS_BYTES,
}

// Migration 0053_custom_emoji_snapshots after its header (test/migrations.test.ts compares them): the three columns,
// added without a default or CHECK so no row is read, then triggers that refuse a write where emojisPastBoundSql holds.
export function emojiBoundsMigrationSql(): string {
	const statements = Object.keys(EMOJI_COLUMNS).map((table) => `ALTER TABLE ${table} ADD COLUMN emojis TEXT;`)
	for (const [table, bytes] of Object.entries(EMOJI_COLUMNS)) {
		const when = emojisPastBoundSql('NEW.emojis', bytes)
		statements.push(
			...boundTriggers(`${table}_emojis`, table, 'emojis', when, `${table}: emojis past their stored bound`)
		)
	}
	return `${statements.join('\n\n')}\n`
}

// ---- Local custom emoji: migration 0055_local_custom_emojis

// custom_emojis.shortcode (RES-2): 2 to 128 ASCII letters, digits and underscores, as Mastodon's SHORTCODE_ONLY_RE,
// MINIMUM_SHORTCODE_SIZE and MAX_SHORTCODE_SIZE for a local emoji (app/models/custom_emoji.rb:28-38, 50-51). A subset
// of EMOJI_SHORTCODE, so a local snapshot passes the 0053 triggers.
export const LOCAL_EMOJI_SHORTCODE = /^[A-Za-z0-9_]{2,128}$/
// custom_emojis.category: at most this many code points within EMOJI_CATEGORY_BYTES UTF-8 bytes, with no C0 control
// or DEL. The CHECK bounds the stored bytes only: SQLite cannot judge UTF-8 well-formedness, so presentedCategory
// judges the decoded value again.
export const EMOJI_CATEGORY_LENGTH = 64
export const EMOJI_CATEGORY_BYTES = 256
// Enabled local emoji at most (RES-3: the whole list is one answer); disabled ones are not counted.
export const MAX_ENABLED_EMOJIS = 1000

// eslint-disable-next-line no-control-regex
const CATEGORY_CONTROL = /[\u0000-\u001f\u007f]/

// Whether `text`, as decoded, is a category that may be stored and presented: well-formed, 1 to EMOJI_CATEGORY_LENGTH
// code points within EMOJI_CATEGORY_BYTES UTF-8 bytes, and no C0 control or DEL.
export function isEmojiCategory(text: string): boolean {
	if (text === '' || text.length > EMOJI_CATEGORY_BYTES || !text.isWellFormed() || CATEGORY_CONTROL.test(text)) {
		return false
	}
	let points = 0
	for (const _ of text) {
		if (++points > EMOJI_CATEGORY_LENGTH) {
			return false
		}
	}
	return ENCODER.encode(text).length <= EMOJI_CATEGORY_BYTES
}

// A category from the admin API: made well-formed (workerd stores a bound lone surrogate as its three-byte encoding,
// which no check of the stored bytes would see), trimmed, then judged. null for an empty value (no category);
// undefined when it is refused.
export function storedEmojiCategory(raw: string): string | null | undefined {
	const text = raw.toWellFormed().trim()
	if (text === '') {
		return null
	}
	return isEmojiCategory(text) ? text : undefined
}

// A stored category as it is presented: the value when isEmojiCategory holds for it as decoded, else none (an
// imported value of malformed UTF-8 can pass the CHECK and decode to more, or to replacement characters).
export function presentedCategory(stored: string | null): string | null {
	return stored !== null && isEmojiCategory(stored) ? stored : null
}

// ---- Announcements: migration 0056_announcements

// announcements.text (RES-1, RES-2): plain text as the Access admin wrote it, 1 to ANNOUNCEMENT_TEXT_BYTES UTF-8 bytes,
// with no NUL, not blank. A text within the bytes decodes to at most as many UTF-16 code units (a malformed byte
// becomes one U+FFFD), so it never passes status-text.ts MAX_RAW_LENGTH when presented.
export const ANNOUNCEMENT_TEXT_BYTES = 10_000
// Announcements at most, and published or scheduled ones at most (RES-3, RES-4: the list holds every published one).
export const MAX_ANNOUNCEMENTS = 1000
export const MAX_LIVE_ANNOUNCEMENTS = 16
// announcement_reactions.name, in UTF-8 bytes, judged before the emoji pattern runs (RES-2); names per announcement
// (Mastodon's ReactionValidator::LIMIT).
export const REACTION_NAME_BYTES = 128
export const MAX_REACTION_NAMES = 8

// Plain text an admin write stores, or null when it is refused: made well-formed (a bound lone surrogate would be
// stored as its three-byte encoding), then refused when it holds a NUL or its UTF-8 passes `bytes` (a string of more
// code units than `bytes` passes them without being encoded).
function adminPlainText(raw: string, bytes: number): string | null {
	const text = raw.toWellFormed()
	if (text.includes('\u0000') || text.length > bytes) {
		return null
	}
	return ENCODER.encode(text).length <= bytes ? text : null
}

// The text an announcement stores, or null when it is refused: adminPlainText's, also refused when blank after
// JavaScript's trim (which removes every character SQLite's ASCII trim of the CHECK does, and Unicode spaces).
export function storedAnnouncementText(raw: string): string | null {
	const text = adminPlainText(raw, ANNOUNCEMENT_TEXT_BYTES)
	return text === null || text.trim() === '' ? null : text
}

// ---- Trends: migration 0057_trends

// trend_tags and trend_statuses rows at most: TREND_ALLOWED_ROWS the round keeps allowed and TREND_REVIEW_POOL awaiting
// review or rejected (RES-4); TREND_STATUSES_PER_AUTHOR rows of one author; decisions per review table.
export const TREND_ALLOWED_ROWS = 200
export const TREND_REVIEW_POOL = 50
export const MAX_TREND_TAGS = TREND_ALLOWED_ROWS + TREND_REVIEW_POOL
export const MAX_TREND_STATUSES = TREND_ALLOWED_ROWS + TREND_REVIEW_POOL
export const TREND_STATUSES_PER_AUTHOR = 3
export const MAX_TREND_REVIEWS = 10_000
// A stored score and peak at most (the round clamps what it scores; RES-2).
export const TREND_SCORE_MAX = 1e15
// A trend or review tag name (RES-2): 1 to TREND_TAG_NAME_BYTES UTF-8 bytes, no NUL, at most TREND_TAG_NAME_LENGTH
// characters as SQLite's length counts them, and no ASCII but what a normalized hashtag holds (0-9, _ and a-z;
// tag-name.ts normalizeTag). The GLOB pattern is 14 bytes (workerd refuses one over 50).
export const TREND_TAG_NAME_BYTES = 1024
export const TREND_TAG_NAME_LENGTH = 256

// The name rule over `column`, as the CHECKs of 0057 write it and the round filters a status's hashtags with it.
export function trendTagNameCheckSql(column: string): string {
	return `typeof(${column}) = 'text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${TREND_TAG_NAME_BYTES}
    AND instr(CAST(${column} AS BLOB), x'00') = 0 AND length(${column}) <= ${TREND_TAG_NAME_LENGTH}
    AND ${column} NOT GLOB ('*[' || char(1) || '-/:-^\`{-' || char(127) || ']*')`
}

// The trends settings (Mastodon's `trends` and `trendable_by_default`, config/settings.yml), 'true' or 'false', bound
// by the triggers of 0057 rather than 0049's (whose literal stays instanceBoundsMigrationSql's).
export const TREND_SETTING_BOUNDS = {
	trends: oneOf(['true', 'false']),
	trendable_by_default: oneOf(['true', 'false']),
} as const satisfies Record<string, InstanceSettingBound>

export type TrendSettingName = keyof typeof TREND_SETTING_BOUNDS

// ---- The contact account and activity: migration 0059_contact_and_activity

// contact_username (Mastodon's site_contact_username, config/settings.yml): the address of an account Kopje knows,
// `username` for a local one or `username@domain`, as the admin write stores it (domain/instance.ts). In UTF-8 bytes:
// a username of at most REMOTE_USERNAME_LIMIT (identity-bounds.ts, repeated here; test/stored-bounds.test.ts pins
// them equal), `@` and a domain name of at most 253. P checks the storage class, then the bytes, then NUL, then the
// structure: only ASCII letters, digits and `-._@`, one `@` at most and at neither end, and a username part of at most
// REMOTE_USERNAME_LIMIT bytes. Each GLOB pattern is at most 19 bytes (workerd refuses one over 50).
export const CONTACT_USERNAME_LIMIT = 255
export const CONTACT_USERNAME_BYTES = CONTACT_USERNAME_LIMIT + 1 + 253

const CONTACT_ALPHABET = /^[-.0-9@A-Z_a-z]+$/

// True when a text `column` (no NUL, within the bytes) breaks the structure: a character outside the alphabet, `@` at
// either end or more than one, or a username part past CONTACT_USERNAME_LIMIT. CASE-free, for the migration's DELETE.
function contactStructurePastSql(column: string): string {
	return `${column} = '' OR ${column} GLOB '*[^-.0-9@A-Z_a-z]*' OR ${column} GLOB '@*' OR ${column} GLOB '*@'
	OR ${column} GLOB '*@*@*'
	OR (instr(${column}, '@') = 0 AND length(${column}) > ${CONTACT_USERNAME_LIMIT})
	OR instr(${column}, '@') - 1 > ${CONTACT_USERNAME_LIMIT}`
}

function contactUsernameSql(column: string): string {
	return `CASE WHEN typeof(${column}) <> 'text' THEN NULL
	WHEN length(CAST(${column} AS BLOB)) > ${CONTACT_USERNAME_BYTES} THEN NULL
	WHEN instr(CAST(${column} AS BLOB), x'00') > 0 THEN NULL
	WHEN ${contactStructurePastSql(column)} THEN NULL
	ELSE ${column} END`
}

// True when `column` is not a fixed point of P (P(x) IS NOT x), written without CASE so a migration's DELETE may use it
// (test/migration-lint.test.ts); test/stored-bounds.test.ts holds the two equal.
export function contactUsernamePastBoundSql(column: string): string {
	return `${column} IS NOT NULL AND (typeof(${column}) <> 'text'
	OR length(CAST(${column} AS BLOB)) > ${CONTACT_USERNAME_BYTES}
	OR instr(CAST(${column} AS BLOB), x'00') > 0
	OR ${contactStructurePastSql(column)})`
}

// P's JS twin: the value itself, or null where P is NULL.
export function storedContactUsername(value: string): string | null {
	if (ENCODER.encode(value).length > CONTACT_USERNAME_BYTES || !CONTACT_ALPHABET.test(value)) {
		return null
	}
	const parts = value.split('@')
	return parts.length > 2 || parts.some((part) => part === '') || parts[0]!.length > CONTACT_USERNAME_LIMIT
		? null
		: value
}

// Bound by the triggers of 0059 rather than 0049's or 0057's.
export const CONTACT_SETTING_BOUNDS = {
	contact_username: { projection: contactUsernameSql, writer: storedContactUsername },
} as const satisfies Record<string, InstanceSettingBound>

export type ContactSettingName = keyof typeof CONTACT_SETTING_BOUNDS

export type StoredSettingName = InstanceSettingName | TrendSettingName | ContactSettingName

function settingBound(name: StoredSettingName): InstanceSettingBound {
	if (name in TREND_SETTING_BOUNDS) {
		return TREND_SETTING_BOUNDS[name as TrendSettingName]
	}
	return name in CONTACT_SETTING_BOUNDS
		? CONTACT_SETTING_BOUNDS[name as ContactSettingName]
		: INSTANCE_SETTING_BOUNDS[name as InstanceSettingName]
}

// The value `name` stores for `value` (null: no row), through 0049's bounds, 0057's or 0059's.
export function storedSetting(name: StoredSettingName, value: string): string | null {
	return settingBound(name).writer(value)
}

// The projection of a stored setting `name` over `column`, through 0049's bounds, 0057's or 0059's.
export function settingProjectionSql(name: StoredSettingName, column: string): string {
	return settingBound(name).projection(column)
}

// local_accounts.active_on: the UTC day of the account's last authenticated request (domain/auth.ts noteActivity),
// NULL or a calendar date YYYY-MM-DD of 10 bytes, held by a CHECK for imports too.
export const ACTIVE_ON_CHECK = 'active_on_date'

// Migration 0059_contact_and_activity after its header (test/migrations.test.ts compares them): the column, an existing
// contact_username row that is not a fixed point of P deleted (a dump restored before 0059 may carry one), then the
// triggers.
export function contactActivityMigrationSql(): string {
	const when = `NEW.name = 'contact_username' AND (${contactUsernamePastBoundSql('NEW.value')})`
	return `${[
		`ALTER TABLE local_accounts ADD COLUMN active_on TEXT
  CONSTRAINT ${ACTIVE_ON_CHECK} CHECK (active_on IS NULL OR (typeof(active_on) = 'text'
    AND length(CAST(active_on AS BLOB)) = 10 AND instr(CAST(active_on AS BLOB), x'00') = 0
    AND active_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(active_on) IS active_on));`,
		`DELETE FROM instance_settings\nWHERE name = 'contact_username' AND (${contactUsernamePastBoundSql('value')});`,
		"-- 0049's triggers end in ELSE 0 and 0057's name only the trends settings; these bound contact_username.",
		...boundTriggers(
			'instance_settings_contact',
			'instance_settings',
			'name, value',
			when,
			'instance_settings: a value past its stored bound'
		),
	].join('\n\n')}\n`
}

// A stored time read as the 24-byte ISO form Kopje writes (hour 00 to 23, read back by strftime as itself), else NULL:
// the bytes judged before strftime reads the value, so a long imported value costs one length.
export function isoTimeSql(column: string): string {
	return `(${STAMP.projection(column)})`
}

// ---- Profile credentials: migration 0058_profile_credentials

// accounts.indexable as stored: NULL (a remote account not stored again since 0058), or the integer 0 or 1. True when
// `column` holds anything else: the type first (an integer has no bytes to bound or NUL to hold), then the value.
export function indexablePastBoundSql(column: string): string {
	return `CASE WHEN ${column} IS NULL THEN 0
	WHEN typeof(${column}) <> 'integer' THEN 1
	WHEN ${column} NOT IN (0, 1) THEN 1
	ELSE 0 END`
}

// Migration 0058_profile_credentials after its header (test/migrations.test.ts compares them): accounts.indexable,
// added without a default or CHECK so no row is read, with triggers that refuse a write where indexablePastBoundSql
// holds; and the unlock acceptance cursor (domain/unlock-accepts.ts), whose CHECK reads the local accounts only.
export function profileBoundsMigrationSql(): string {
	return `${[
		'ALTER TABLE accounts ADD COLUMN indexable INTEGER;',
		`ALTER TABLE local_accounts ADD COLUMN accept_requests_after INTEGER
  CONSTRAINT accept_requests_after_cursor CHECK (accept_requests_after IS NULL
    OR (typeof(accept_requests_after) = 'integer' AND accept_requests_after >= 0));`,
		...boundTriggers(
			'accounts_indexable',
			'accounts',
			'indexable',
			indexablePastBoundSql('NEW.indexable'),
			'accounts: indexable past its stored bound'
		),
	].join('\n\n')}\n`
}

// ---- Account moves: migration 0060_account_moves

// accounts.moved_to_account_id: NULL, or the 18-digit id of another account, on a remote row only (Mastodon's
// Account#moved_to_account_id, set from the actor document's movedTo and by a verified Move: domain/inbox.ts). No
// foreign key holds it: the purge of a remote account clears the references to it first (PURGED_ACCOUNT_REFERENCES in
// domain/inbox.ts). True when `NEW` holds anything else, judged in order: the storage class, the bytes, NUL, the
// structure (digits only), then the row (another account's id, and a remote row).
export const MOVED_TO_ID_BYTES = 18

export function movedToPastBoundSql(row: string): string {
	const column = `${row}.moved_to_account_id`
	return `CASE WHEN ${column} IS NULL THEN 0
	WHEN typeof(${column}) <> 'text' THEN 1
	WHEN length(CAST(${column} AS BLOB)) <> ${MOVED_TO_ID_BYTES} THEN 1
	WHEN instr(CAST(${column} AS BLOB), x'00') > 0 THEN 1
	WHEN ${column} GLOB '*[^0-9]*' THEN 1
	WHEN ${column} = ${row}.id THEN 1
	WHEN ${row}.domain IS NULL THEN 1
	ELSE 0 END`
}

// The partial index the purge's clearing step and completion check seek references through.
export const MOVED_TO_INDEX = 'accounts_moved_to'

// Migration 0060_account_moves after its header (test/migrations.test.ts compares them): the column, added without a
// default or CHECK so no row is read; its partial index; and triggers that refuse a write where movedToPastBoundSql
// holds.
export function accountMovesMigrationSql(): string {
	return `${[
		'ALTER TABLE accounts ADD COLUMN moved_to_account_id TEXT;',
		`CREATE INDEX ${MOVED_TO_INDEX} ON accounts (moved_to_account_id) WHERE moved_to_account_id IS NOT NULL;`,
		...boundTriggers(
			'accounts_moved_to',
			'accounts',
			'moved_to_account_id, domain',
			movedToPastBoundSql('NEW'),
			'accounts: moved_to_account_id past its stored bound'
		),
	].join('\n\n')}\n`
}

// ---- Account static images: migration 0061_account_static_images

// accounts.avatar_static_url and header_static_url: NULL ("the same as the image"), or the still preview URL of the
// upload the image names (domain/media.ts profileAssignSql), in UTF-8 bytes. Kopje's preview URLs are mediaUrl's
// (platform/media-files.ts): 'https://', a host of at most 253 bytes, ':65535', '/media/', a token of at most 64 bytes
// and '/small.webp' make at most 349, so a longer one is not copied and the account shows its image.
export const STATIC_URL_LIMIT = 512

// The WHEN lines that judge one stored static value, in order: the storage class (TEXT affinity stores a number as
// its text, so only a BLOB is refused), the raw bytes (an imported value may be malformed UTF-8, which length counts
// as fewer characters), then NUL.
function staticValueCases(value: string): string {
	return `WHEN ${value} IS NULL THEN 0
	WHEN typeof(${value}) <> 'text' THEN 1
	WHEN length(CAST(${value} AS BLOB)) > ${STATIC_URL_LIMIT} THEN 1
	WHEN instr(CAST(${value} AS BLOB), x'00') > 0 THEN 1`
}

// True when `value` is no static value accounts may store: what the writer judges before it copies a preview URL.
export function staticUrlPastBoundSql(value: string): string {
	return `CASE ${staticValueCases(value)}
	ELSE 0 END`
}

// True when `row` holds a static past its stored bound, or one where the structure allows none: on a remote row (a
// remote document never sets one, ID-3), or without its image.
export function staticImagesPastBoundSql(row: string): string {
	return (['avatar', 'header'] as const)
		.map(
			(image) => `CASE ${staticValueCases(`${row}.${image}_static_url`)}
	WHEN ${row}.domain IS NOT NULL THEN 1
	WHEN ${row}.${image}_url IS NULL THEN 1
	ELSE 0 END`
		)
		.join('\n\tOR ')
}

// Migration 0061_account_static_images after its header (test/migrations.test.ts compares them): the two columns,
// added without a default or CHECK so no row is read, and triggers that refuse a write where staticImagesPastBoundSql
// holds. Every existing row holds NULL in both, which is within the bound.
export function accountStaticImagesMigrationSql(): string {
	return `${[
		'ALTER TABLE accounts ADD COLUMN avatar_static_url TEXT;',
		'ALTER TABLE accounts ADD COLUMN header_static_url TEXT;',
		...boundTriggers(
			'accounts_static_images',
			'accounts',
			'avatar_url, header_url, avatar_static_url, header_static_url, domain',
			staticImagesPastBoundSql('NEW'),
			'accounts: static image past its stored bound'
		),
	].join('\n\n')}\n`
}

// ---- Account warnings: migrations 0062_account_warnings and 0063_account_warning_notifications_key

// account_warnings.text (RES-1, RES-2): the admin's plain text as sent, at most WARNING_TEXT_BYTES UTF-8 bytes with no
// NUL; empty when none was sent. Mastodon sets no bound (and a NUL is its 500). Within the bytes it decodes to at most
// as many UTF-16 code units, a malformed byte becoming one U+FFFD.
export const WARNING_TEXT_BYTES = 10_000
// account_warnings.status_ids: NULL, or a JSON array of at most WARNING_STATUS_IDS 18-digit status ids (the report's
// own bound, MAX_REPORT_STATUSES in domain/reports.ts), so at most WARNING_STATUS_IDS_BYTES of '[', ']', the quoted ids
// and their commas.
export const WARNING_STATUS_IDS = 100
export const WARNING_STATUS_ID_BYTES = 18
export const WARNING_STATUS_IDS_BYTES = 2 + WARNING_STATUS_IDS * (WARNING_STATUS_ID_BYTES + 3) - 1

// The text an admin action stores (adminPlainText at WARNING_TEXT_BYTES), or null when it is refused (422).
export function storedWarningText(raw: string): string | null {
	return adminPlainText(raw, WARNING_TEXT_BYTES)
}

const WARNING_STATUS_ID = /^[0-9]{18}$/

// The writer twin of warningStatusIdsPastBoundSql: the ids of stored status_ids, or null for none or when the rule
// refuses them (a restored report is bound only by its own CHECK, which does not judge the elements; a warning's own
// are held by its triggers, so the presenter never throws on one). Judged in the trigger's order: bytes, NUL, JSON,
// array, length, elements.
export function warningStatusIdsOf(raw: string | null): string[] | null {
	if (raw === null || raw.length > WARNING_STATUS_IDS_BYTES || raw.includes('\u0000')) {
		return null
	}
	if (ENCODER.encode(raw).length > WARNING_STATUS_IDS_BYTES) {
		return null
	}
	let ids: unknown
	try {
		ids = JSON.parse(raw)
	} catch {
		return null
	}
	if (!Array.isArray(ids) || ids.length > WARNING_STATUS_IDS) {
		return null
	}
	return ids.every((id): id is string => typeof id === 'string' && WARNING_STATUS_ID.test(id)) ? ids : null
}

// The status_ids a warning stores for a report's stored status_ids, as JSON.stringify writes the ids warningStatusIdsOf
// accepts (within the bytes when they pass), or null.
export function storedWarningStatusIds(raw: string | null): string | null {
	const ids = warningStatusIdsOf(raw)
	return ids === null ? null : JSON.stringify(ids)
}

// The scalar parts of the status_ids bound, held by a CHECK for imports too: the storage class, the raw bytes (an
// imported value may be malformed UTF-8, which length counts as fewer characters), NUL, then the JSON structure.
// json_type and json_array_length run only on valid JSON (AND stops at the first false operand).
export function warningStatusIdsCheckSql(column: string): string {
	return `${column} IS NULL OR (typeof(${column}) = 'text'
      AND length(CAST(${column} AS BLOB)) <= ${WARNING_STATUS_IDS_BYTES} AND instr(CAST(${column} AS BLOB), x'00') = 0
      AND json_valid(${column}) AND json_type(${column}) = 'array'
      AND json_array_length(${column}) <= ${WARNING_STATUS_IDS})`
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
	ELSE 0 END`
}

// The partial unique index of the notification of each warning (LocalNotificationWorker keys it by its activity, the
// warning); its `account_warning_id = ?` serves the foreign key.
export const NOTIFICATIONS_WARNING_INDEX = 'notifications_account_warning'

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
    CHECK (${warningStatusIdsCheckSql('status_ids')}),
  created_at TEXT NOT NULL CONSTRAINT account_warning_created_at_iso
    CHECK (typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at AND substr(created_at, 12, 2) BETWEEN '00' AND '23')
);`,
		'CREATE INDEX account_warnings_target ON account_warnings (target_account_id);',
		...boundTriggers(
			'account_warnings_status_ids',
			'account_warnings',
			'status_ids',
			warningStatusIdsPastBoundSql('NEW.status_ids'),
			'account_warnings: status_ids past its stored bound'
		),
		'ALTER TABLE notifications ADD COLUMN account_warning_id INTEGER REFERENCES account_warnings (id) ON DELETE CASCADE;',
		`CREATE UNIQUE INDEX ${NOTIFICATIONS_WARNING_INDEX} ON notifications (account_warning_id)
  WHERE account_warning_id IS NOT NULL;`,
	].join('\n\n')}\n`
}

// ---- Status applications: migration 0064_status_applications

// statuses.application_id: NULL, or the client_id of the app a local original was posted through (Mastodon's
// Status#application_id, AUTH-6: the credential's client), in UTF-8 bytes. Kopje's client ids are 43 base64url
// characters (security/tokens.ts randomToken) and a converted legacy client's a UUID, so 64 holds both. No foreign key
// holds it (Mastodon has none, schema.rb): removing an app writes no status row, and an id whose app is gone reads as
// no app (RES-6). True when `row` holds anything else, judged in order: the storage class, the bytes, NUL, the
// structure (base64url characters), then the row (a boost, or a remote author: Mastodon records an app on neither).
export const APP_ID_BYTES = 64
const APP_ID = new RegExp(`^[A-Za-z0-9_-]{1,${APP_ID_BYTES}}$`)

export function applicationIdPastBoundSql(row: string): string {
	const column = `${row}.application_id`
	return `CASE WHEN ${column} IS NULL THEN 0
	WHEN typeof(${column}) <> 'text' THEN 1
	WHEN length(CAST(${column} AS BLOB)) NOT BETWEEN 1 AND ${APP_ID_BYTES} THEN 1
	WHEN instr(CAST(${column} AS BLOB), x'00') > 0 THEN 1
	WHEN ${column} GLOB '*[^0-9A-Za-z_-]*' THEN 1
	WHEN ${row}.reblog_of_id IS NOT NULL THEN 1
	WHEN (SELECT a.domain FROM accounts a WHERE a.id = ${row}.account_id) IS NOT NULL THEN 1
	ELSE 0 END`
}

// The application_id a local original stores for the client `value`: it when the bound's value cases accept it, else
// none (the post is written without an app rather than refused).
export function storedApplicationId(value: unknown): string | null {
	return typeof value === 'string' && APP_ID.test(value) ? value : null
}

// The bounds of an app's name and website as a status presents them (REST::StatusSerializer's application).
// A name: APP_NAME_LIMIT code points (Mastodon's ApplicationExtension APP_NAME_LIMIT), so at most APP_NAME_BYTES UTF-8
// bytes and APP_NAME_JSON_BYTES as a JSON string. A website: APP_WEBSITE_LIMIT UTF-8 bytes (isAppWebsite).
export const APP_NAME_LIMIT = 60
export const APP_NAME_BYTES = 4 * APP_NAME_LIMIT
export const APP_NAME_JSON_BYTES = 6 * APP_NAME_LIMIT + 2
export const APP_WEBSITE_LIMIT = 2000
export const APP_WEBSITE_JSON_BYTES = 2 * APP_WEBSITE_LIMIT + 2

// The characters no app website may hold, those that end or split an HTML attribute or a URL in common parsers: C0
// controls, the space, DEL, C1 controls (U+0085 NEL is not in \s), other whitespace (\s), and " ' < > \ ^ ` { | }.
// None needs escaping in JSON.
// eslint-disable-next-line no-control-regex
const WEBSITE_EXCLUDED = /[\u0000-\u0020\u007f-\u009f"'<>\\^`{|}]|\s/u

// Whether `text`, as decoded, is an app website registration accepts and a status presents as stored: well-formed (so
// its JSON is its UTF-8 bytes and the quotes) with no excluded character, within APP_WEBSITE_LIMIT UTF-8 bytes and
// APP_WEBSITE_JSON_BYTES as JSON, and an http(s) URL with a host by the WHATWG parser. Mastodon's UrlValidator
// (Addressable::URI.parse, an http(s) scheme and a host) may accept some of the excluded characters
// (docs/mastodon-deviations.md, Posting).
export function isAppWebsite(text: string): boolean {
	if (text.length > APP_WEBSITE_LIMIT || !text.isWellFormed() || WEBSITE_EXCLUDED.test(text)) {
		return false
	}
	if (
		ENCODER.encode(text).length > APP_WEBSITE_LIMIT ||
		ENCODER.encode(JSON.stringify(text)).length > APP_WEBSITE_JSON_BYTES
	) {
		return false
	}
	try {
		const url = new URL(text)
		return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== ''
	} catch {
		return false
	}
}

// The read projections of oauth_clients.name and website for a status (RES-2): NULL for another storage class (no JSON
// function sees a BLOB) or past the raw bytes a presented value may hold, so a row reads at most APP_NAME_BYTES and
// APP_WEBSITE_LIMIT bytes of them whatever was imported. The presenter judges the decoded value again
// (presentedAppName, isAppWebsite): malformed bytes decode to U+FFFD, three bytes each.
export function appNameSql(column: string): string {
	return `CASE WHEN typeof(${column}) = 'text' THEN ${byteBoundSql(column, APP_NAME_BYTES)} END`
}

export function appWebsiteSql(column: string): string {
	return `CASE WHEN typeof(${column}) = 'text' THEN ${byteBoundSql(column, APP_WEBSITE_LIMIT)} END`
}

// A stored app name as a status presents it: the name when, as decoded, it is 1 to APP_NAME_LIMIT code points within
// APP_NAME_BYTES UTF-8 bytes and APP_NAME_JSON_BYTES as a JSON string, with no U+0000 (which no registration keeps:
// storedText's rule), else none.
export function presentedAppName(name: string | null): string | null {
	if (name === null || name === '' || name.length > APP_NAME_BYTES || name.includes('\u0000')) {
		return null
	}
	let points = 0
	for (const _ of name) {
		if (++points > APP_NAME_LIMIT) {
			return null
		}
	}
	return ENCODER.encode(name).length <= APP_NAME_BYTES &&
		ENCODER.encode(JSON.stringify(name)).length <= APP_NAME_JSON_BYTES
		? name
		: null
}

// Migration 0064_status_applications after its header (test/migrations.test.ts compares them): the column, added
// without a default or CHECK so no row is read, and triggers that refuse a write where applicationIdPastBoundSql holds.
// Every existing row holds NULL, which is within the bound.
export function statusApplicationsMigrationSql(): string {
	return `${[
		'ALTER TABLE statuses ADD COLUMN application_id TEXT;',
		...boundTriggers(
			'statuses_application',
			'statuses',
			'application_id, reblog_of_id, account_id',
			applicationIdPastBoundSql('NEW'),
			'statuses: application_id past its stored bound'
		),
	].join('\n\n')}\n`
}

// media_attachments.blurhash: NULL, or a BlurHash Mastodon's MediaAttachmentParser#supported_blurhash? keeps (its
// parser/media_attachment_parser.rb, the blurhash gem's Blurhash.components): base83 characters, x and y components
// of 1 to 5 each (the size flag, its first character: x = flag mod 9 + 1, y = floor(flag / 9) + 1), and 4 + 2xy
// characters, so 6 to BLURHASH_BYTES ASCII bytes. Mastodon's character check is line-anchored (Ruby's ^ and $), so it
// keeps a valid first line followed by anything; Kopje checks the whole string (docs/mastodon-deviations.md, Media).
// True when `value` holds anything else, judged in order: the storage class, the bytes, NUL, the structure (base83
// only, which also makes the string ASCII), the size flag, then the length.
export const BLURHASH_BYTES = 54
export const BLURHASH_MIN = 6
export const BASE83 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~'
const BLURHASH = new RegExp(`^[0-9A-Za-z#$%*+,\\-.:;=?@[\\]^_{|}~]{${BLURHASH_MIN},${BLURHASH_BYTES}}$`)
const BLURHASH_COMPONENTS = 5

export function blurhashPastBoundSql(value: string): string {
	return `CASE WHEN ${value} IS NULL THEN 0
	WHEN typeof(${value}) <> 'text' THEN 1
	WHEN length(CAST(${value} AS BLOB)) NOT BETWEEN ${BLURHASH_MIN} AND ${BLURHASH_BYTES} THEN 1
	WHEN instr(CAST(${value} AS BLOB), x'00') > 0 THEN 1
	WHEN rtrim(${value}, '${BASE83}') <> '' THEN 1
	WHEN (SELECT f % 9 >= ${BLURHASH_COMPONENTS} OR f / 9 >= ${BLURHASH_COMPONENTS}
			OR length(${value}) <> 4 + 2 * (f % 9 + 1) * (f / 9 + 1)
		FROM (SELECT instr('${BASE83}', substr(${value}, 1, 1)) - 1 AS f)) THEN 1
	ELSE 0 END`
}

// The blurhash a remote attachment stores for the value it was sent with: it when the bound's value cases accept it,
// else none (the attachment is stored without one rather than refused). The presenter applies it again to what it
// reads, so an imported value it would refuse is never shown.
export function storedBlurhash(value: unknown): string | null {
	if (typeof value !== 'string' || !BLURHASH.test(value)) {
		return null
	}
	const flag = BASE83.indexOf(value[0]!)
	const x = (flag % 9) + 1
	const y = Math.floor(flag / 9) + 1
	return x <= BLURHASH_COMPONENTS && y <= BLURHASH_COMPONENTS && value.length === 4 + 2 * x * y ? value : null
}

// Migration 0065_media_blurhash after its header (test/migrations.test.ts compares them): the column, added without a
// default or CHECK so no row is read, and triggers that refuse a write where blurhashPastBoundSql holds. Every existing
// row holds NULL, which is within the bound. No row condition: Mastodon keeps a blurhash on local and remote media.
export function mediaBlurhashMigrationSql(): string {
	return `${[
		'ALTER TABLE media_attachments ADD COLUMN blurhash TEXT;',
		...boundTriggers(
			'media_attachments_blurhash',
			'media_attachments',
			'blurhash',
			blurhashPastBoundSql('NEW.blurhash'),
			'media_attachments: blurhash past its stored bound'
		),
	].join('\n\n')}\n`
}
