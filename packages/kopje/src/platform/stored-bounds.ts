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

// A NULL past `bytes` UTF-8 bytes.
function byteBoundSql(column: string, bytes: number): string {
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
function cutCodePoints(text: string, limit: number): string {
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
// polls.options and status_edits.media_json keep their read-time projections and are not here.
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

// The text an admin write stores, or null when it is refused: made well-formed (a bound lone surrogate would be stored
// as its three-byte encoding), then refused when blank after JavaScript's trim (which removes every character SQLite's
// ASCII trim of the CHECK does, and Unicode spaces), when it holds a NUL, or when its UTF-8 passes the bound.
export function storedAnnouncementText(raw: string): string | null {
	const text = raw.toWellFormed()
	if (text.trim() === '' || text.includes('\u0000') || text.length > ANNOUNCEMENT_TEXT_BYTES) {
		return null
	}
	return ENCODER.encode(text).length <= ANNOUNCEMENT_TEXT_BYTES ? text : null
}
