import { runInDurableObject } from 'cloudflare:test'

import { parseFragment } from 'parse5'
import { describe, expect, it } from 'vitest'

import { setSetting, sql } from './api-helpers'
import { NOW } from './app-helpers'
import {
	ACCOUNT_EMOJIS_FULL,
	accountAtCap,
	emojiUrl,
	STATUS_EMOJIS_FULL,
	statusAtCap,
	statusShortNames,
} from './emoji-fixtures'
import { BUILD } from './helpers'
import { ALICE, setup, type Setup } from './inbox-status-helpers'
import { localSnapshotAtCap } from './local-emoji-helpers'
import { ESCAPED_STATIC_WITNESS, fullestFields, MAX_BIO, MOVED_ROW_SQLITE_MAX } from './profile-fixtures'
import { observedSql, rowsRead } from './read-helpers'
import { community, post, remoteAccount } from './status-helpers'
import { heap } from './status-row-fixtures'
import { blurhashOf } from './stored-bounds-fixtures'
import { selectSql } from '../src/db/columns'
import { Db, VALUE_BYTES } from '../src/db/sql'
import {
	getAccount,
	MAX_FIELD_NAME,
	MAX_FIELD_VALUE,
	MAX_FIELDS,
	MOVED_ACCOUNT_COLUMNS,
	MOVED_CREATED_AT_LIMIT,
	MOVED_DISPLAY_NAME_LIMIT,
	MOVED_EMOJIS_BYTES,
	MOVED_LAST_STATUS_AT_LIMIT,
	MOVED_URL_LIMIT,
	VERIFIED_AT_JSON_BYTES,
} from '../src/domain/accounts'
import { createActivity, getFeatured, noteOf, OUTBOX_BYTES, PIN_LIMIT, statusFacts } from '../src/domain/activities'
import { ANSWER_BYTES } from '../src/domain/answer-budget'
import { type VisibleStatusId } from '../src/domain/audience'
import { OWNER_ROLE } from '../src/domain/auth'
import { listConversations, MAX_PRESENTED_PARTICIPANTS } from '../src/domain/conversations'
import { MAX_FILTER_KEYWORD, MAX_FILTER_KEYWORDS, MAX_FILTER_TITLE, MAX_FILTERS } from '../src/domain/filters'
import { listGroupedNotifications } from '../src/domain/notification-groups'
import { listNotifications } from '../src/domain/notifications'
import { ACTOR_URI_LIMIT, PROFILE_URL_LIMIT, USERNAME_LIMIT } from '../src/domain/profile-bounds'
import { getAdminReport } from '../src/domain/reports'
import {
	MAX_MEDIA_DESCRIPTION_LENGTH,
	MAX_REMOTE_OPTION_LENGTH,
	MAX_REMOTE_OPTIONS,
	MAX_STATUS_MEDIA,
	MAX_STATUS_MENTION_ROWS,
	MAX_PRESENTED_TAGS,
	MAX_STATUS_TAGS,
	MAX_TAG_LENGTH,
	EDIT_MEDIA_BYTES,
	MEDIA_URL_JSON_BYTES,
	MEDIA_URL_LIMIT,
	SNAPSHOT_KEY_LIMIT,
} from '../src/domain/status-bounds'
import {
	type ChunkPlan,
	LARGE_ITEM_CHUNKS,
	PAGE_CHUNKS,
	presentation,
	presentedMediaUrl,
	presentStatusesWithin,
} from '../src/domain/status-presenter'
import { statusRowBoundSql } from '../src/domain/status-rows'
import { renderFieldValue } from '../src/domain/status-text'
import { getStatus, getStatuses, statusHistory } from '../src/domain/statuses'
import { parseRemoteStatus } from '../src/federation/remote-status'
import { utf8Length } from '../src/platform/dump-format'
import { DOMAIN_BYTES, MAX_LOCAL_ADDRESSED } from '../src/platform/identity-bounds'
import type { StoreOperation } from '../src/platform/store-kernel'
import {
	APP_NAME_BYTES,
	APP_NAME_LIMIT,
	APP_WEBSITE_LIMIT,
	BLURHASH_BYTES,
	MEDIA_META_BYTES,
	EMOJI_ENTRY_BYTES,
	EMOJI_SHORTCODE_LIMIT,
	EMOJI_URL_LIMIT,
	MAX_ACCOUNT_COUNT,
	presentedEmojiBytes,
	STATIC_URL_LIMIT,
	STATUS_EMOJIS_BYTES,
	VERIFIED_LINKS_BYTES,
	WARNING_STATUS_IDS,
	WARNING_STATUS_IDS_BYTES,
	WARNING_TEXT_BYTES,
} from '../src/platform/stored-bounds'
import {
	jsonStringBytes,
	REMOTE_BIO_BYTES,
	sanitizeRemoteContent,
	sanitizeRemoteHtml,
	SPOILER_BYTES,
	STATUS_CONTENT_BYTES,
} from '../src/security/html'
import { sha256Hex } from '../src/security/tokens'
import { STREAM_LIMITS } from '../src/stream-hub'

// RES-2: one presented status has a known size. Each column a remote server controls is bounded where it is stored
// (the stored-bound triggers of 0048_stored_bounds), and identities, hashtag names and poll choices again as they are
// read (status-bounds.ts), so a converted row leaves SQLite within them too. The maxima measured here are
// docs/threat-model.md's table (RES-3).

const ORIGIN = 'https://kopje.test'
// A control character: one code point that JSON escapes to six bytes, the most any code point takes.
const C = '\u0001'
// A remote host of 2,000 characters: an actor id of ACTOR_URI_LIMIT holds it, so no stored domain is longer.
const HOST = `${'d'.repeat(1992)}.example`

let sequence = 900_000_000_000_000_000n
const nextId = () => String(sequence++)

const atLimit = (prefix: string, limit: number) => prefix.padEnd(limit, 'u')

// How a fixture fills text at its bound: `escaped` with characters JSON escapes to six bytes (the most JSON for the
// fewest bytes read); `derived`, the same with mentioned accounts that have no stored url, so their url is derived
// from the host and the username; `raw` with what reads the most bytes from SQLite for each bound: ASCII where the
// bound is in bytes, and four-byte characters (W) where it is in characters. Emoji snapshots: at their presented
// bounds (escaped and derived), padded to their stored bounds (raw). `emoji-poll` is escaped with every poll's choices
// referencing the status's emoji in the fewest characters (statusShortNames), so each poll shows them all: the
// escaped poll, untouched, keeps the row bounds, and the conservative JSON (conservativeJson) both.
type Fill = 'escaped' | 'derived' | 'raw' | 'emoji-poll'
const FILLS = ['escaped', 'derived', 'raw', 'emoji-poll'] as const

// The emoji snapshots of a fill: a status's (its boost's own row too) and an account's.
const statusEmojis = (fill: Fill) =>
	fill === 'raw' ? STATUS_EMOJIS_FULL : JSON.stringify(fill === 'emoji-poll' ? statusShortNames() : statusAtCap())
const accountEmojis = (fill: Fill) => (fill === 'raw' ? ACCOUNT_EMOJIS_FULL : JSON.stringify(accountAtCap()))
// The 37 characters that reference every name of statusShortNames.
const SHORT_REFERENCES = statusShortNames()
	.map(([name]) => `:${name}:`)
	.join('')

// A report's comment at its stored bound for each fill (migration 0054_remote_reports, CHECK
// report_comment_within_20000_bytes): the most JSON an imported one holds (a NUL, which SQLite's length stops at, then
// 19,999 bytes of U+0001, each 6 JSON-escaped bytes), what Kopje's writers make at most in JSON (5,000 code points of
// U+0001), and the most SQLite bytes (5,000 four-byte code points); emoji-poll is escaped's.
const REPORT_COMMENTS: Record<Fill, string> = {
	escaped: '\u0000' + '\u0001'.repeat(19_999),
	derived: '\u0001'.repeat(5_000),
	raw: '𠀀'.repeat(5_000),
	'emoji-poll': '\u0000' + '\u0001'.repeat(19_999),
}
// A warning's text at its stored bound for each fill (migration 0062_account_warnings, CHECK
// account_warning_text_within_10000_bytes, which allows no NUL): 10,000 bytes of U+0001, each 6 JSON-escaped bytes,
// which Kopje's writer makes too (escaped, derived, emoji-poll); and 10,000 malformed bytes (raw: 0xFF, no UTF-8 lead
// byte), which an import may store and which read back as 10,000 three-byte U+FFFD.
const WARNING_TEXTS: Record<Fill, string | ArrayBuffer> = {
	escaped: '\u0001'.repeat(WARNING_TEXT_BYTES),
	derived: '\u0001'.repeat(WARNING_TEXT_BYTES),
	raw: new Uint8Array(WARNING_TEXT_BYTES).fill(0xff).buffer,
	'emoji-poll': '\u0001'.repeat(WARNING_TEXT_BYTES),
}
const W = '𠀀'
const RAW_BIO = `<p>${'x'.repeat(REMOTE_BIO_BYTES - 9)}</p>`

// The most JSON a nested moved-to account presents (accounts.ts presentMovedAccount), from its decoded limits at worst
// escaping: characters of six JSON bytes at each text limit, URLs and uri at MOVED_URL_LIMIT (JSON-measured), counts
// of 20 characters (any int64; presentedCountSql shows at most MAX_ACCOUNT_COUNT, 16), emojis of MOVED_EMOJIS_BYTES
// (a string of that many JSON bytes stands for them), and every key at once, a local account's (noindex, roles) and
// an unavailable one's (suspended) included.
const MOVED_ACCOUNT_JSON_MAX = utf8Length(
	JSON.stringify({
		id: '9'.repeat(18),
		username: C.repeat(USERNAME_LIMIT),
		acct: `${C.repeat(USERNAME_LIMIT)}@${C.repeat(DOMAIN_BYTES)}`,
		display_name: C.repeat(MOVED_DISPLAY_NAME_LIMIT),
		locked: false,
		bot: false,
		discoverable: false,
		indexable: false,
		group: false,
		created_at: C.repeat(MOVED_CREATED_AT_LIMIT),
		note: '',
		url: 'u'.repeat(MOVED_URL_LIMIT),
		uri: 'u'.repeat(MOVED_URL_LIMIT),
		avatar: 'u'.repeat(MOVED_URL_LIMIT),
		avatar_static: 'u'.repeat(MOVED_URL_LIMIT),
		header: 'u'.repeat(MOVED_URL_LIMIT),
		header_static: 'u'.repeat(MOVED_URL_LIMIT),
		followers_count: -(2 ** 63),
		following_count: -(2 ** 63),
		statuses_count: -(2 ** 63),
		last_status_at: C.repeat(MOVED_LAST_STATUS_AT_LIMIT),
		hide_collections: false,
		emojis: 'x'.repeat(MOVED_EMOJIS_BYTES - 2),
		fields: [],
		noindex: false,
		roles: [{ id: OWNER_ROLE.id, name: OWNER_ROLE.name, color: OWNER_ROLE.color }],
		suspended: true,
	})
)
// What a moved-to account's row reads at most: SQLite bytes (profile-fixtures.ts MOVED_ROW_SQLITE_MAX) and heap.
const MOVED_ROW_HEAP_MAX = MOVED_ACCOUNT_COLUMNS.rowHeap

// What presenting a nested account's emojis holds besides what it admits (custom-emojis.ts referencedEmojis), at
// three times its bytes: one entry at a time, its two literals as stored (a 128-character name and a 512-byte url,
// each character escaped to six bytes), their decoded strings, and the larger of the entry presented from them and a
// candidate href that normalization makes before rejecting it (each url character percent-encoded to three bytes).
// One presentation runs at a time, so an answer holds one.
const MOVED_EMOJI_LITERALS = 6 * EMOJI_SHORTCODE_LIMIT + 2 + (6 * EMOJI_URL_LIMIT + 2)
const MOVED_EMOJI_DECODED = EMOJI_SHORTCODE_LIMIT + EMOJI_URL_LIMIT
const MOVED_EMOJI_CANDIDATE = Math.max(
	EMOJI_ENTRY_BYTES + EMOJI_SHORTCODE_LIMIT + 2 * EMOJI_URL_LIMIT,
	3 * EMOJI_URL_LIMIT
)
const MOVED_EMOJI_SCRATCH = 3 * (MOVED_EMOJI_LITERALS + MOVED_EMOJI_DECODED + MOVED_EMOJI_CANDIDATE)

// The nested moved-to accounts a presented value shows (each `moved` that is an account).
function movedAccounts(value: unknown): unknown[] {
	if (Array.isArray(value)) {
		return value.flatMap(movedAccounts)
	}
	if (typeof value !== 'object' || value === null) {
		return []
	}
	return Object.entries(value).flatMap(([key, item]: [string, unknown]) =>
		key === 'moved' && typeof item === 'object' && item !== null ? [item] : movedAccounts(item)
	)
}

// The account a fill's presented account moved to (Account#moved, MOVED_ACCOUNT_COLUMNS), each column at its nested
// cap: escaped (and derived, emoji-poll), characters JSON escapes to six bytes at each decoded limit, URLs at
// MOVED_URL_LIMIT, counts at MAX_ACCOUNT_COUNT (the most presentedCountSql shows) and a display name that references
// emojis whose JSON fills MOVED_EMOJIS_BYTES; raw, four-byte characters where a limit is in characters and every
// column at its byte cap, the emoji snapshot at its stored bound. Its last status gives last_status_at.
const MOVED_REFERENCED = 3
// The longest url of MOVED_REFERENCED one-character entries whose presented JSON fits MOVED_EMOJIS_BYTES.
const MOVED_EMOJI_URL = Math.floor(((MOVED_EMOJIS_BYTES - 1) / MOVED_REFERENCED - EMOJI_ENTRY_BYTES - 1) / 2)
const MOVED_EMOJIS = Array.from({ length: MOVED_REFERENCED }, (_, i) => [
	String.fromCharCode(97 + i),
	emojiUrl(MOVED_EMOJI_URL, String(i)),
])
const MOVED_REFERENCES = MOVED_EMOJIS.map(([name]) => `:${name}:`).join('')

async function movedTarget(t: Setup, fill: Fill): Promise<string> {
	const id = nextId()
	const raw = fill === 'raw'
	const domain = raw ? `${'d'.repeat(DOMAIN_BYTES - 4)}.com` : C.repeat(DOMAIN_BYTES)
	const counted = raw ? W : C
	await sql(
		t.store,
		`INSERT INTO accounts (id, uri, username, domain, display_name, url, avatar_url, header_url, emojis, created_at,
			followers_count, following_count, statuses_count)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?11, ?11, ?11)`,
		id,
		atLimit(`https://moved.example/users/${id}/`, MOVED_URL_LIMIT),
		`${'u'.repeat(USERNAME_LIMIT - 18)}${id}`,
		domain,
		raw ? W.repeat(2048) : `${MOVED_REFERENCES}${C.repeat(2048 - MOVED_REFERENCES.length)}`,
		atLimit(`https://moved.example/@${id}/`, MOVED_URL_LIMIT),
		atLimit(`https://moved.example/a/${id}/`, MOVED_URL_LIMIT),
		atLimit(`https://moved.example/h/${id}/`, MOVED_URL_LIMIT),
		raw ? ACCOUNT_EMOJIS_FULL : JSON.stringify(MOVED_EMOJIS),
		counted.repeat(MOVED_CREATED_AT_LIMIT),
		MAX_ACCOUNT_COUNT
	)
	await sql(
		t.store,
		"INSERT INTO statuses (id, uri, account_id, visibility, published_at) VALUES (?, ?, ?, 'public', ?)",
		nextId(),
		`https://moved.example/statuses/${id}`,
		id,
		counted.repeat(MOVED_LAST_STATUS_AT_LIMIT)
	)
	return id
}

// A remote account with every profile column at its bound; `light`: only what a mention reads is at its bound. Its
// counts, light or not, at MAX_ACCOUNT_COUNT, the most a remote account learns. One that is not light moved to an
// account of its own at the nested caps (movedTarget).
async function maximalAccount(t: Setup, light = false, fill: Fill = 'escaped'): Promise<string> {
	const id = nextId()
	const username = `${'u'.repeat(USERNAME_LIMIT - 18)}${id}`
	await sql(
		t.store,
		`INSERT INTO accounts (id, uri, username, domain, display_name, note, url, avatar_url, header_url, raw, emojis,
			followers_count, following_count, statuses_count)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?12, ?12, ?12)`,
		id,
		atLimit(`https://${HOST}/users/${id}/`, ACTOR_URI_LIMIT),
		username,
		HOST,
		light ? '' : (fill === 'raw' ? W : C).repeat(2048),
		light ? '' : fill === 'raw' ? RAW_BIO : MAX_BIO,
		light && fill === 'derived' ? null : atLimit(`https://${HOST}/@${id}/`, PROFILE_URL_LIMIT),
		light ? null : atLimit(`https://${HOST}/a/${id}/`, PROFILE_URL_LIMIT),
		light ? null : atLimit(`https://${HOST}/h/${id}/`, PROFILE_URL_LIMIT),
		light ? null : JSON.stringify({ type: 'Person', attachment: fullestFields() }),
		light ? null : accountEmojis(fill),
		MAX_ACCOUNT_COUNT
	)
	if (!light) {
		await sql(t.store, 'UPDATE accounts SET moved_to_account_id = ? WHERE id = ?', await movedTarget(t, fill), id)
	}
	return id
}

type Parts = {
	content: string
	spoiler: string
	// The source text a local status keeps for editing; none for a remote one.
	source?: string | null
	media: { url: string; preview: string | null; description: string; meta: string | null; blurhash?: string | null }[]
	mentions: string[]
	tags: string[]
	poll: string[] | null
	uri?: string
	url?: string
	// The status a boost boosts; a boost's content is '' (the statuses CHECK).
	reblogOf?: string
	emojis?: string | null
}

// A public remote status of `author` with the given parts, written directly in SQL: the stored-bound triggers of
// 0048_stored_bounds accept every part at its bound.
async function storedStatus(t: Setup, author: string, parts: Parts): Promise<string> {
	const id = nextId()
	await sql(
		t.store,
		`INSERT INTO statuses (id, uri, url, account_id, reblog_of_id, visibility, spoiler_text, content, source_text,
			published_at, emojis)
		VALUES (?, ?, ?, ?, ?, 'public', ?, ?, ?, ?, ?)`,
		id,
		parts.uri ?? atLimit(`https://${HOST}/objects/${id}/`, 4096),
		parts.url ?? atLimit(`https://${HOST}/notes/${id}/`, 4096),
		author,
		parts.reblogOf ?? null,
		parts.spoiler,
		parts.reblogOf === undefined ? parts.content : '',
		parts.source ?? null,
		new Date(NOW - 60_000).toISOString(),
		parts.emojis ?? null
	)
	for (const [position, m] of parts.media.entries()) {
		await sql(
			t.store,
			`INSERT INTO media_attachments (id, account_id, status_id, position, type, url, preview_url, description, meta,
				focus_x, focus_y, blurhash)
			VALUES (?, ?, ?, ?, 'image', ?, ?, ?, ?, -1, -1, ?)`,
			nextId(),
			author,
			id,
			position,
			m.url,
			m.preview,
			m.description,
			m.meta,
			m.blurhash ?? null
		)
	}
	await sql(
		t.store,
		`INSERT INTO status_mentions (status_id, account_id, silent, requires_mention, author_id)
		SELECT ?, value, 0, 0, ? FROM json_each(?)`,
		id,
		author,
		JSON.stringify(parts.mentions)
	)
	await sql(
		t.store,
		'INSERT INTO status_tags (status_id, name, public) SELECT ?, value, 1 FROM json_each(?)',
		id,
		JSON.stringify(parts.tags)
	)
	if (parts.poll !== null) {
		await sql(
			t.store,
			`INSERT INTO polls (status_id, options, tallies, votes_count, voters_count, expires_at)
			VALUES (?, ?, ?, ?, ?, ?)`,
			id,
			JSON.stringify(parts.poll),
			JSON.stringify(parts.poll.map(() => Number.MAX_SAFE_INTEGER)),
			Number.MAX_SAFE_INTEGER,
			Number.MAX_SAFE_INTEGER,
			new Date(NOW + 86_400_000).toISOString()
		)
	}
	return id
}

// A meta of MEDIA_META_BYTES: the dimensions, padded with a key presentMedia does not read.
const MAX_META = (() => {
	const base = { original: { width: 100_000, height: 100_000 }, small: { width: 100_000, height: 100_000 }, x: '' }
	return JSON.stringify({ ...base, x: 'x'.repeat(1024 - JSON.stringify(base).length) })
})()

// A media URL of MEDIA_URL_LIMIT bytes that JSON escapes the most: a query of backslashes, which URL parsing keeps as
// they are (a query is not a path, and the query percent-encode set has no backslash), each two bytes in JSON.
const escapingUrl = (prefix: string) => prefix.padEnd(MEDIA_URL_LIMIT, '\\')
// The most JSON a presented blurhash takes: BLURHASH_BYTES base83 characters, none of which JSON escapes. A media
// URL's is MEDIA_URL_JSON_BYTES.
const BLURHASH_JSON_MAX = BLURHASH_BYTES + 2
const MEDIA_STRINGS = ['url', 'preview_url', 'remote_url', 'preview_remote_url', 'blurhash'] as const

// The attachments a presented value shows (each object with a preview_remote_url, which only a MediaAttachment has).
function presentedMedia(value: unknown): Record<string, unknown>[] {
	if (Array.isArray(value)) {
		return value.flatMap(presentedMedia)
	}
	if (typeof value !== 'object' || value === null) {
		return []
	}
	const own = 'preview_remote_url' in value ? [value as Record<string, unknown>] : []
	return [...own, ...Object.values(value).flatMap(presentedMedia)]
}

// What an attachment's URLs and blurhash lack of their maxima in its JSON (each of them is a string or null).
function mediaDeficit(media: Record<string, unknown>): number {
	return MEDIA_STRINGS.reduce(
		(sum, key) => sum + (key === 'blurhash' ? BLURHASH_JSON_MAX : MEDIA_URL_JSON_BYTES) - jsonBytes(media[key]),
		0
	)
}

// A tag name of MAX_TAG_LENGTH code points of four bytes each: the longest URL encodeURIComponent makes of one.
const maxTag = (i: number) => `${String.fromCodePoint(0x20000 + i)}${'𠀀'.repeat(MAX_TAG_LENGTH - 1)}`

// A status with every part at its bound: content and source text of STATUS_CONTENT_BYTES and a warning of
// SPOILER_BYTES as JSON strings (each the largest value its stored-bound trigger accepts), MAX_STATUS_MEDIA
// attachments at theirs, MAX_STATUS_MENTION_ROWS mentions of accounts at theirs, MAX_STATUS_TAGS tags and a poll of
// MAX_REMOTE_OPTIONS choices of MAX_REMOTE_OPTION_LENGTH escaping characters.
async function maximalParts(t: Setup, fill: Fill = 'escaped'): Promise<Parts> {
	const mentions: string[] = []
	for (let i = 0; i < MAX_STATUS_MENTION_ROWS; i++) {
		mentions.push(await maximalAccount(t, true, fill))
	}
	const counted = fill === 'raw' ? W : C
	const content = fill === 'raw' ? 'x'.repeat(STATUS_CONTENT_BYTES - 2) : C.repeat((STATUS_CONTENT_BYTES - 2) / 6)
	return {
		content,
		source: content,
		spoiler: fill === 'raw' ? 'x'.repeat(SPOILER_BYTES - 2) : C.repeat(Math.floor((SPOILER_BYTES - 2) / 6)),
		// URLs at their byte bound, of ASCII (raw) or of backslashes JSON escapes (the others); a 5x5 blurhash.
		media: Array.from({ length: MAX_STATUS_MEDIA }, (_, i) => ({
			url:
				fill === 'raw' ? atLimit(`https://${HOST}/m/${i}/`, MEDIA_URL_LIMIT) : escapingUrl(`https://m.example/${i}/?`),
			preview:
				fill === 'raw' ? atLimit(`https://${HOST}/p/${i}/`, MEDIA_URL_LIMIT) : escapingUrl(`https://p.example/${i}/?`),
			description: counted.repeat(MAX_MEDIA_DESCRIPTION_LENGTH),
			meta: MAX_META,
			blurhash: blurhashOf(5, 5, '~'),
		})),
		mentions,
		tags: Array.from({ length: MAX_STATUS_TAGS }, (_, i) => maxTag(i)),
		poll: Array.from({ length: MAX_REMOTE_OPTIONS }, (_, i) =>
			fill === 'emoji-poll' && i === 0
				? `${SHORT_REFERENCES}${counted.repeat(MAX_REMOTE_OPTION_LENGTH - SHORT_REFERENCES.length)}`
				: counted.repeat(MAX_REMOTE_OPTION_LENGTH)
		),
		emojis: statusEmojis(fill),
	}
}

// The heap of the rows one read returns under the model of "Heap at 8 MiB per answer" (docs/threat-model.md), by query
// (its SQL) and column: each query's rows (64 B each for the object), and for each column its values' heap summed and
// its largest value's (32 B and twice its UTF-8 bytes, which is at least RowMeter's twice its UTF-16 code units).
type ColumnHeap = { total: number; largest: number }
type Heaps = Map<string, { rows: number; columns: Map<string, ColumnHeap> }>

type Measure = {
	answer: unknown
	rows: number
	sqliteBytes: number
	longest: number
	profileBytes: number
	heaps: Heaps
}

// Runs a read over a SqlStorage that measures what leaves SQLite: the rows, the UTF-8 bytes of their values (eight per
// number), the longest value's bytes, and their heap by query and column.
async function measured<I>(t: Setup, operation: StoreOperation<I, unknown>, input: I): Promise<Measure> {
	return runInDurableObject(t.store, (_instance, state) => {
		let rows = 0
		let sqliteBytes = 0
		let longest = 0
		let profileBytes = 0
		const heaps: Heaps = new Map()
		const counting = observedSql(state.storage.sql, (read, query) => {
			const heap = heaps.get(query) ?? { rows: 0, columns: new Map<string, ColumnHeap>() }
			heaps.set(query, heap)
			for (const row of read) {
				rows++
				heap.rows++
				const profile = 'note' in row && 'display_name' in row
				for (const [column, value] of Object.entries(row)) {
					const text = typeof value === 'string' ? utf8Length(value) : null
					const bytes = text ?? 8
					sqliteBytes += bytes
					profileBytes += profile ? bytes : 0
					longest = Math.max(longest, bytes)
					const one = 32 + 2 * (text ?? 0)
					const sum = heap.columns.get(column) ?? { total: 0, largest: 0 }
					heap.columns.set(column, { total: sum.total + one, largest: Math.max(sum.largest, one) })
				}
			}
		})
		let answer = operation.run(counting, input) as Record<string, unknown>
		while (answer.status === 'ok' && 'value' in answer) {
			answer = answer.value as Record<string, unknown>
		}
		return { answer, rows, sqliteBytes, longest, profileBytes, heaps }
	})
}

const credential = async (t: Setup) => ({ tokenHash: await sha256Hex(t.tokens.alice), scope: 'read', now: NOW })

const read = async (t: Setup, operation: StoreOperation<never, unknown>, id: string) =>
	measured(t, operation, { credential: await credential(t), now: NOW, id, present: { origin: ORIGIN } } as never)

// The objects, arrays and strings a presented value holds.
function nodes(value: unknown): number {
	if (Array.isArray(value)) {
		return 1 + value.reduce((sum: number, item) => sum + nodes(item), 0)
	}
	if (typeof value === 'object' && value !== null) {
		return 1 + Object.values(value).reduce((sum: number, item) => sum + nodes(item), 0)
	}
	return typeof value === 'string' ? 1 : 0
}

const jsonBytes = (value: unknown) => utf8Length(JSON.stringify(value))

type Presented = Record<string, unknown> & {
	content: string
	spoiler_text: string
	uri: string
	url: string | null
	account: Record<string, unknown>
	media_attachments: Record<string, unknown>[]
	mentions: Record<string, unknown>[]
	tags: { name: string; url: string }[]
	poll: { options: { title: string }[] } | null
}

describe('a remote status is stored within its bounds (RES-2)', () => {
	const note = (extra: Record<string, unknown>) =>
		parseRemoteStatus({
			id: 'https://remote.example/notes/1',
			type: 'Note',
			attributedTo: 'https://remote.example/users/u',
			to: ['https://www.w3.org/ns/activitystreams#Public'],
			content: '<p>x</p>',
			...extra,
		})!

	it('sanitizes a fitting prefix of over-long content into well-formed HTML within STATUS_CONTENT_BYTES', () => {
		for (const content of [
			'<a>'.repeat(16_666),
			`<p>${'日本語の本文と<a href="https://example.com/a">リンク</a>です。'.repeat(2_000)}</p>`,
			`<p>${`${C}"<b>x</b>`.repeat(5_000)}</p>`,
		]) {
			const stored = note({ content }).content
			expect(stored).toBe(sanitizeRemoteContent(content))
			expect(jsonStringBytes(stored)).toBeLessThanOrEqual(STATUS_CONTENT_BYTES)
			expect(jsonStringBytes(stored)).toBeGreaterThan(STATUS_CONTENT_BYTES / 2)
			const errors: string[] = []
			parseFragment(stored, { onParseError: (error) => errors.push(error.code) })
			expect(errors.filter((code) => code !== 'control-character-in-input-stream')).toEqual([])
		}
	})

	it('refuses a status id over its bound in UTF-8 bytes, and ignores such a url', () => {
		const long = `https://remote.example/notes/${'é'.repeat(2_100)}`
		expect(note({ id: long })).toBeNull()
		expect(note({ url: long }).url).toBeNull()
		expect(note({ url: 'https://remote.example/@u/1' }).url).toBe('https://remote.example/@u/1')
	})

	it('cuts a content warning to SPOILER_BYTES at a code point, and refuses over-long media URLs', () => {
		const spoiler = note({ summary: '注意'.repeat(5_000) }).spoilerText
		expect(jsonStringBytes(spoiler)).toBeLessThanOrEqual(SPOILER_BYTES)
		expect(spoiler).toBe('注意'.repeat(5_000).slice(0, spoiler.length))
		expect(spoiler.length).toBe(Math.floor((SPOILER_BYTES - 2) / 3))
		const bisons = note({ summary: '🦬'.repeat(5_000) }).spoilerText
		expect(bisons).toBe('🦬'.repeat(Math.floor((SPOILER_BYTES - 2) / 4)))
		const long = atLimit('https://remote.example/media/', MEDIA_URL_LIMIT + 1)
		const fits = atLimit('https://remote.example/media/', MEDIA_URL_LIMIT)
		const media = note({
			attachment: [
				{ type: 'Document', mediaType: 'image/png', url: long },
				{ type: 'Document', mediaType: 'image/png', url: fits, icon: long },
			],
		}).media
		expect(media.map((m) => [m.url, m.previewUrl])).toEqual([[fits, null]])
	})
})

describe('a local status is written within its bounds (RES-2)', () => {
	it('refuses a post whose rendered mentions pass STATUS_CONTENT_BYTES, writing nothing', async () => {
		const h = await community(['alice'])
		const target = await remoteAccount(h.store, 'a')
		await sql(
			h.store,
			'UPDATE accounts SET url = ? WHERE id = ?',
			atLimit('https://remote.example/@a/', PROFILE_URL_LIMIT),
			target
		)
		const response = await h.request('/api/v1/statuses', {
			method: 'POST',
			headers: { authorization: `Bearer ${h.users.alice.token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ status: '@a@remote.example '.repeat(160) }),
		})
		expect(response.status).toBe(422)
		expect(await sql(h.store, 'SELECT id FROM statuses')).toEqual([])
		// Fewer mentions fit, and are rendered whole.
		const posted = await post(h, h.users.alice, { status: '@a@remote.example '.repeat(40) })
		expect(jsonStringBytes(posted.content!)).toBeLessThanOrEqual(STATUS_CONTENT_BYTES)
		expect(posted.mentions).toHaveLength(1)
	})
})

describe('a stored status is read within its bounds (RES-2)', () => {
	it('projects identities, hashtags and poll choices, and caps the rows, as the bytes leaving SQLite show', async () => {
		const t = await setup()
		const author = await maximalAccount(t)
		await sql(
			t.store,
			'UPDATE accounts SET uri = ? WHERE id = ?',
			atLimit(`https://${HOST}/users/long/`, ACTOR_URI_LIMIT + 1),
			author
		)
		const mentions: string[] = []
		for (let i = 0; i < MAX_STATUS_MENTION_ROWS + 50; i++) {
			mentions.push(await maximalAccount(t, true))
		}
		// A converted username of 64 KiB and an actor id past its bound, with no stored url.
		await sql(
			t.store,
			'UPDATE accounts SET username = ?, url = NULL, uri = ? WHERE id = ?',
			`u${'v'.repeat(64 * 1024)}`,
			atLimit('https://remote.example/users/u/', ACTOR_URI_LIMIT + 1),
			mentions[0]!
		)
		// A converted username outside Mastodon's remote format, of characters that escape to six bytes.
		await sql(t.store, 'UPDATE accounts SET username = ? WHERE id = ?', C.repeat(300), mentions[1]!)
		await sql(t.store, 'UPDATE accounts SET username = ? WHERE id = ?', `u\u0000${C.repeat(253)}`, mentions[2]!)
		const url = atLimit(`https://${HOST}/notes/long/`, 4096)
		const id = await storedStatus(t, author, {
			content: '<p>x</p>',
			spoiler: '',
			media: Array.from({ length: MAX_STATUS_MEDIA + 2 }, (_, i) => ({
				url: atLimit(`https://${HOST}/m/${i}/`, MEDIA_URL_LIMIT),
				preview: null,
				description: '',
				meta: null,
			})),
			mentions,
			tags: [
				...Array.from({ length: MAX_STATUS_TAGS + 50 }, (_, i) => `t${String(i).padStart(3, '0')}`),
				'a'.repeat(300),
			],
			poll: Array.from({ length: MAX_REMOTE_OPTIONS }, () => 'x'.repeat(6_000)),
			uri: atLimit(`https://${HOST}/objects/long/`, 4097),
			url,
		})
		const { answer, longest } = await read(t, getStatus, id)
		const status = answer as Presented
		expect([status.uri, status.url]).toEqual(['', url])
		expect(status.account.url).toBe(atLimit(`https://${HOST}/@${author}/`, PROFILE_URL_LIMIT))
		expect(status.media_attachments.map((m) => m.url)).toEqual(
			Array.from({ length: MAX_STATUS_MEDIA }, (_, i) => atLimit(`https://${HOST}/m/${i}/`, MEDIA_URL_LIMIT))
		)
		expect(status.mentions).toHaveLength(MAX_STATUS_MENTION_ROWS)
		expect(status.mentions.map((m) => m.id)).toEqual(mentions.toSorted().slice(0, MAX_STATUS_MENTION_ROWS))
		const cut = status.mentions.find((m) => m.id === mentions[0])!
		expect(cut).toEqual({
			id: mentions[0],
			username: `u${'v'.repeat(USERNAME_LIMIT - 1)}`,
			acct: `u${'v'.repeat(USERNAME_LIMIT - 1)}@${HOST}`,
			// Its url derived from the host and the username would pass PROFILE_URL_LIMIT: none fits, so ''.
			url: '',
		})
		// A NUL hides what follows it from GLOB; the username is still read within its JSON bound.
		const nul = status.mentions.find((m) => m.id === mentions[2])!
		expect(jsonStringBytes(nul.username as string)).toBeLessThanOrEqual(USERNAME_LIMIT + 2)
		expect(jsonStringBytes(nul.acct as string)).toBeLessThanOrEqual(USERNAME_LIMIT + 2 + HOST.length + 1)
		const odd = status.mentions.find((m) => m.id === mentions[1])!
		expect(odd.username).toBe(C.repeat(Math.floor(USERNAME_LIMIT / 6)))
		expect(jsonStringBytes(odd.username as string)).toBeLessThanOrEqual(USERNAME_LIMIT + 2)
		// The over-long name sorts first: it takes one of the MAX_PRESENTED_TAGS rows read and is left out.
		expect(status.tags.map((tag) => tag.name)).toEqual(
			Array.from({ length: MAX_PRESENTED_TAGS - 1 }, (_, i) => `t${String(i).padStart(3, '0')}`)
		)
		expect(status.poll!.options.map((o) => o.title)).toEqual(
			Array.from({ length: MAX_REMOTE_OPTIONS }, () => 'x'.repeat(MAX_REMOTE_OPTION_LENGTH))
		)
		// The longest value that left SQLite is the poll's choices as a JSON array, within their bound: the 64 KiB
		// username, the actor ids and the 600 KB of stored choices stayed.
		expect(longest).toBeLessThanOrEqual(MAX_REMOTE_OPTIONS * (6 * MAX_REMOTE_OPTION_LENGTH + 3) + 1)
	})

	it("projects edit history snapshots' media within their bounds", async () => {
		const t = await setup()
		const author = await maximalAccount(t)
		const id = await storedStatus(t, author, {
			content: '<p>now</p>',
			spoiler: '',
			media: [],
			mentions: [],
			tags: [],
			poll: null,
		})
		const snapshot = (i: number) => ({ id: `m${i}`, type: 'image', description: C.repeat(10_000) })
		await sql(
			t.store,
			`INSERT INTO status_edits (status_id, content, spoiler_text, media_json, poll_options, created_at) VALUES
				(?1, '<p>a</p>', '', ?2, NULL, ?3), (?1, '<p>b</p>', '', ?4, ?5, ?3)`,
			id,
			JSON.stringify(Array.from({ length: 10 }, (_, i) => snapshot(i))),
			new Date(NOW).toISOString(),
			// A small snapshot whose single fields are past their bounds: a long URL, description and meta.
			JSON.stringify([
				'not an attachment',
				...Array.from({ length: 6 }, (_, i) => ({
					id: `m${i}`,
					type: 'image',
					url: atLimit(`https://${HOST}/m/${i}/`, MEDIA_URL_LIMIT + i),
					preview_url: atLimit(`https://${HOST}/p/${i}/`, MEDIA_URL_LIMIT),
					description: 'd'.repeat(2 * MAX_MEDIA_DESCRIPTION_LENGTH),
					meta: i === 0 ? { original: { width: 1, height: 1 } } : { x: 'x'.repeat(2_000) },
					extra: 'x'.repeat(1_000),
				})),
			]),
			JSON.stringify(['a', 'b'])
		)
		const { answer, longest } = await read(t, statusHistory, id)
		const [first, second] = answer as {
			media_attachments: unknown[]
			poll: { options: { title: string }[] } | null
		}[]
		// Past EDIT_MEDIA_BYTES, a snapshot reads as no media.
		expect(first!.media_attachments).toEqual([])
		// The first MAX_STATUS_MEDIA entries (the string among them left out), each rebuilt within the column bounds.
		expect(second!.media_attachments).toEqual(
			Array.from({ length: MAX_STATUS_MEDIA - 1 }, (_, i) => ({
				id: `m${i}`,
				type: 'image',
				url: i === 0 ? atLimit(`https://${HOST}/m/0/`, MEDIA_URL_LIMIT) : null,
				preview_url: atLimit(`https://${HOST}/p/${i}/`, MEDIA_URL_LIMIT),
				remote_url: null,
				preview_remote_url: null,
				text_url: null,
				meta: i === 0 ? { original: { width: 1, height: 1 } } : null,
				description: 'd'.repeat(MAX_MEDIA_DESCRIPTION_LENGTH),
				blurhash: null,
			}))
		)
		expect(second!.poll!.options.map((o) => o.title)).toEqual(['a', 'b'])
		expect(longest).toBeLessThanOrEqual(STATUS_CONTENT_BYTES)
	})

	// The most JSON one snapshot entry holds as editMediaSql projects it, at the worst escaping: an id and a type of
	// SNAPSHOT_KEY_LIMIT escaping code points, four URLs at MEDIA_URL_JSON_BYTES, a meta of MEDIA_META_BYTES, a
	// description of MAX_MEDIA_DESCRIPTION_LENGTH escaping units and a blurhash at BLURHASH_JSON_MAX. EDIT_MEDIA_BYTES is
	// the smallest MAX_STATUS_MEDIA times a whole KiB that holds MAX_STATUS_MEDIA of them as a JSON array.
	it('derives the snapshot bound from the caps of one entry', () => {
		const url = '\\'.repeat(MEDIA_URL_LIMIT)
		const entry = {
			id: C.repeat(SNAPSHOT_KEY_LIMIT),
			type: C.repeat(SNAPSHOT_KEY_LIMIT),
			url,
			preview_url: url,
			remote_url: url,
			preview_remote_url: url,
			text_url: null,
			meta: JSON.parse(MAX_META) as unknown,
			description: C.repeat(MAX_MEDIA_DESCRIPTION_LENGTH),
			blurhash: blurhashOf(5, 5),
		}
		expect([jsonBytes(url), jsonBytes(entry.meta), jsonBytes(entry.blurhash)]).toEqual([
			MEDIA_URL_JSON_BYTES,
			MEDIA_META_BYTES,
			BLURHASH_JSON_MAX,
		])
		const four = jsonBytes(Array.from({ length: MAX_STATUS_MEDIA }, () => entry))
		const kib = Math.ceil(four / MAX_STATUS_MEDIA / 1024)
		expect({ entry: jsonBytes(entry), four, kib }).toEqual({ entry: 77_986, four: 311_949, kib: 77 })
		expect(EDIT_MEDIA_BYTES).toBe(MAX_STATUS_MEDIA * kib * 1024)
	})

	// Regression witness: a snapshot past the earlier bound (72 KiB an entry), within EDIT_MEDIA_BYTES, reads its
	// media.
	it('reads a snapshot of four entries of escaped descriptions and URLs', async () => {
		const t = await setup()
		const id = await storedStatus(t, await maximalAccount(t, true), {
			content: '<p>now</p>',
			spoiler: '',
			media: [],
			mentions: [],
			tags: [],
			poll: null,
		})
		const entries = Array.from({ length: MAX_STATUS_MEDIA }, (_, i) => ({
			id: `m${i}`,
			type: 'image',
			url: escapingUrl(`https://m.example/${i}/?`),
			preview_url: escapingUrl(`https://p.example/${i}/?`),
			remote_url: escapingUrl(`https://m.example/${i}/?`),
			preview_remote_url: escapingUrl(`https://p.example/${i}/?`),
			text_url: null,
			meta: null,
			description: C.repeat(MAX_MEDIA_DESCRIPTION_LENGTH),
			blurhash: blurhashOf(5, 5),
		}))
		const snapshot = JSON.stringify(entries)
		expect(utf8Length(snapshot)).toBeGreaterThan(MAX_STATUS_MEDIA * 72 * 1024)
		expect(utf8Length(snapshot)).toBeLessThanOrEqual(EDIT_MEDIA_BYTES)
		await sql(
			t.store,
			`INSERT INTO status_edits (status_id, content, spoiler_text, media_json, created_at)
			VALUES (?1, '<p>a</p>', '', ?2, ?3)`,
			id,
			snapshot,
			new Date(NOW).toISOString()
		)
		const { answer } = await read(t, statusHistory, id)
		expect((answer as { media_attachments: unknown[] }[])[0]!.media_attachments).toEqual(entries)
	})

	// Regression witness: the shared media URL rule judges the decoded value before normalization, so neither a value
	// past the byte bound that normalization shrinks, nor a NUL, control or malformed byte in a path or query that
	// normalization would percent-encode, is shown.
	it('judges a media URL as decoded, then as normalized', () => {
		const shrinking = `https://ok.example/${'x/../'.repeat(420)}a`
		expect([utf8Length(shrinking), new URL(shrinking).href]).toEqual([2_120, 'https://ok.example/a'])
		for (const value of [
			shrinking,
			'https://ok.example/a\u0000b',
			'https://ok.example/a\u0001b',
			'https://ok.example/a\u007fb',
			'https://ok.example/?q=\u0000',
			'https://ok.example/?q=\u001f',
			'https://ok.example/\ufffd',
			'https://ok.example/?\ud800',
			atLimit('https://ok.example/é', MEDIA_URL_LIMIT),
			atLimit('https://ok.example/ ', MEDIA_URL_LIMIT),
			'javascript:alert(1)',
			42,
		]) {
			expect(presentedMediaUrl(value), JSON.stringify(value)).toBeNull()
		}
		for (const [value, shown] of [
			['https://ok.example/a/./b/../c', 'https://ok.example/a/c'],
			['https://OK.example/é', 'https://ok.example/%C3%A9'],
			[atLimit('https://ok.example/', MEDIA_URL_LIMIT), atLimit('https://ok.example/', MEDIA_URL_LIMIT)],
			[escapingUrl('https://ok.example/?'), escapingUrl('https://ok.example/?')],
		]) {
			expect(presentedMediaUrl(value)).toBe(shown)
		}
	})

	// Regression witness: a stored meta that is not an object of dimensions shows no size,
	// and the attachment is still presented; so is a live URL whose path or query holds a NUL or a control.
	it('presents stored media whose meta or URLs are malformed', async () => {
		const t = await setup()
		const metas = ['null', '{"original":null}', '{"original":{"width":0,"height":1},"small":"x"}', '[1]']
		const id = await storedStatus(t, await maximalAccount(t, true), {
			content: '<p>now</p>',
			spoiler: '',
			media: metas.map((meta, i) => ({
				url: i === 0 ? 'https://ok.example/a\u0000b' : `https://ok.example/${i}`,
				preview: i === 1 ? 'https://ok.example/?q=\u0001' : null,
				description: '',
				meta,
			})),
			mentions: [],
			tags: [],
			poll: null,
		})
		const { answer } = await read(t, getStatus, id)
		const media = (answer as Presented).media_attachments
		expect(media.map((m) => [m.url, m.preview_url, m.remote_url, m.preview_remote_url, m.meta])).toEqual([
			[null, null, null, null, { focus: { x: -1, y: -1 } }],
			['https://ok.example/1', 'https://ok.example/1', 'https://ok.example/1', null, { focus: { x: -1, y: -1 } }],
			['https://ok.example/2', 'https://ok.example/2', 'https://ok.example/2', null, { focus: { x: -1, y: -1 } }],
			['https://ok.example/3', 'https://ok.example/3', 'https://ok.example/3', null, { focus: { x: -1, y: -1 } }],
		])
	})

	// Regression witness: each URL of an imported snapshot passes the presented-URL rule as decoded (presentedMediaUrl),
	// and its blurhash storedBlurhash's, as live media do; editMediaSql bounds their bytes only.
	it("judges an imported snapshot's URLs and blurhash as live media", async () => {
		const t = await setup()
		const id = await storedStatus(t, await maximalAccount(t, true), {
			content: '<p>now</p>',
			spoiler: '',
			media: [],
			mentions: [],
			tags: [],
			poll: null,
		})
		// U+007F stands for a byte 0xFF (malformed UTF-8) in the stored text.
		const MALFORMED = '\u007f'
		const ok = 'https://ok.example/a'
		const atCap = atLimit('https://ok.example/r/', MEDIA_URL_LIMIT)
		const entry = (i: number, fields: Record<string, unknown>) => ({ id: `m${i}`, type: 'image', ...fields })
		const entries = [
			entry(0, {
				url: 'javascript:alert(1)',
				preview_url: 'https://ok\u0001.example/',
				remote_url: 'https://ok\u0000.example/',
				preview_remote_url: `https://ok${MALFORMED}.example/`,
				blurhash: blurhashOf(5, 5),
			}),
			entry(1, {
				url: atLimit(`https://ok.example/${MALFORMED.repeat(8)}`, MEDIA_URL_LIMIT),
				preview_url: atLimit('https://ok.example/   ', MEDIA_URL_LIMIT),
				remote_url: atCap,
				preview_remote_url: `${atCap}u`,
				blurhash: 'LEHV6',
			}),
			entry(2, { url: ok, preview_url: ok, remote_url: ok, preview_remote_url: ok, blurhash: 42 }),
			entry(3, {
				url: ok,
				preview_url: 'https://ok.example/a\u0000b',
				remote_url: `https://ok.example/${MALFORMED}`,
				preview_remote_url: 'https://ok.example/?q=\u0001',
				blurhash: `${blurhashOf(1, 1)}\u0000`,
			}),
		]
		const bytes = new TextEncoder().encode(JSON.stringify(entries)).map((byte) => (byte === 0x7f ? 0xff : byte))
		await sql(
			t.store,
			`INSERT INTO status_edits (status_id, content, spoiler_text, media_json, created_at)
			VALUES (?1, '<p>a</p>', '', CAST(?2 AS TEXT), ?3)`,
			id,
			bytes.buffer as ArrayBuffer,
			new Date(NOW).toISOString()
		)
		const { answer } = await read(t, statusHistory, id)
		const shown = (answer as { media_attachments: Record<string, unknown>[] }[])[0]!.media_attachments
		const fields = (m: Record<string, unknown>) => MEDIA_STRINGS.map((key) => m[key])
		expect(shown.map(fields)).toEqual([
			[null, null, null, null, blurhashOf(5, 5)],
			[null, null, atCap, null, null],
			[ok, ok, ok, ok, null],
			[ok, null, null, null, null],
		])
	})
})

describe('each per-status cap reads a bounded number of rows (RES-7)', () => {
	it('reads at most its cap of rows whatever a converted status holds, each status once', async () => {
		const t = await setup()
		const author = await maximalAccount(t, true)
		const id = await storedStatus(t, author, {
			content: '<p>x</p>',
			spoiler: '',
			media: [],
			mentions: [],
			tags: [],
			poll: null,
		})
		const many = 10_000
		// Rejected rows that sort before the presented ones: over-long tag names, hidden media and silent mentions.
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?2 - 1)
			INSERT INTO status_tags (status_id, name, public) SELECT ?1, 'a' || printf('%05d', i) || ?3, 1 FROM n`,
			id,
			many,
			'x'.repeat(MAX_TAG_LENGTH)
		)
		await sql(t.store, "INSERT INTO status_tags (status_id, name, public) VALUES (?1, 'shown', 1)", id)
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?3 - 1)
			INSERT INTO media_attachments (id, account_id, status_id, position, type, url, shown)
			SELECT CAST(800000000000000000 + i AS TEXT), ?2, ?1, i, 'image', 'https://m.example/' || i, 0 FROM n`,
			id,
			author,
			many
		)
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT CAST(700000000000000000 + i AS TEXT), 'https://m.example/users/s' || i, 's' || i, 'm.example' FROM n`,
			many
		)
		await sql(
			t.store,
			`INSERT INTO status_mentions (status_id, account_id, silent, requires_mention, author_id)
			SELECT ?1, id, 1, 0, ?2 FROM accounts WHERE id BETWEEN '700000000000000000' AND '700000000000009999'`,
			id,
			author
		)
		const credentialOf = await credential(t)
		const rows = (ids: string[]) =>
			rowsRead(t, getStatuses as never, { credential: credentialOf, now: NOW, ids, present: { origin: ORIGIN } })
		const once = await rows([id])
		// The status, its account, at most MAX_STATUS_MENTION_ROWS mentions, MAX_PRESENTED_TAGS tags and MAX_STATUS_MEDIA
		// media, and a constant number of other rows; never the 30,000 rejected ones.
		expect(once).toBeLessThan(MAX_STATUS_MENTION_ROWS + MAX_PRESENTED_TAGS + MAX_STATUS_MEDIA + 200)
		// Repeating the id adds only the rows of reading the repeated ids, not another status's worth.
		expect(await rows([id, id, id, id])).toBeLessThanOrEqual(once + 8)
		const { answer } = await read(t, getStatus, id)
		expect(answer).toMatchObject({ media_attachments: [], mentions: [], tags: [] })
	})
})

describe('a conversation presents its first participants (RES-3)', () => {
	it('reads only the participants it presents out of SQLite, whatever the row stores', async () => {
		const t = await setup()
		const author = await maximalAccount(t, true)
		const id = await storedStatus(t, author, {
			content: '<p>x</p>',
			spoiler: '',
			media: [],
			mentions: [],
			tags: [],
			poll: null,
		})
		const stored = Array.from({ length: 5_000 }, (_, i) => String(600_000_000_000_000_000n + BigInt(i)))
		await sql(
			t.store,
			"INSERT INTO conversations (account_id, thread, participants, last_status_id) VALUES (?, 'th', ?, ?)",
			ALICE,
			JSON.stringify(stored),
			id
		)
		const listed = await measured(
			t,
			listConversations as never,
			{
				credential: await credential(t),
				page: { limit: 1 },
				present: { origin: ORIGIN },
			} as never
		)
		// The stored list is 105,000 bytes; what leaves SQLite is the last status with its author and URLs (about 15 KB)
		// and 12 ids of the list.
		expect(listed.sqliteBytes).toBeLessThan(30_000)
	})
})

describe('an ordinary status keeps its mentions and hashtags (RES-2)', () => {
	it('shows a current mention after more silent rows than the cap, as an edited status keeps them', async () => {
		const h = await community(['alice'])
		const bob = await remoteAccount(h.store, 'bob')
		const posted = await post(h, h.users.alice, { status: '@bob@remote.example hello' })
		// Recipients an edit removed stay as silent rows, without a cap, and may sort before the current one.
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT CAST(100000000000000000 + i AS TEXT), 'https://old.example/users/o' || i, 'o' || i, 'old.example' FROM n`,
			MAX_STATUS_MENTION_ROWS + 50
		)
		await sql(
			h.store,
			`INSERT INTO status_mentions (status_id, account_id, silent, requires_mention, author_id)
			SELECT ?1, id, 1, 0, ?2 FROM accounts WHERE domain = 'old.example'`,
			posted.id,
			h.users.alice.id
		)
		const response = await h.request(`/api/v1/statuses/${posted.id}`, {
			headers: { authorization: `Bearer ${h.users.alice.token}` },
		})
		const shown = (await response.json()) as { mentions: { id: string }[] }
		// The silent rows sort before the current mention.
		expect(bob > String(100_000_000_000_000_000n + BigInt(MAX_STATUS_MENTION_ROWS + 50))).toBe(true)
		expect(shown.mentions.map((m) => m.id)).toEqual([bob])
	})

	it('records a local hashtag past its bound, and leaves it out of the 70 presented when it sorts first', async () => {
		const h = await community(['alice'])
		const long = 'a'.repeat(MAX_TAG_LENGTH + 1)
		const cjk = Array.from({ length: MAX_PRESENTED_TAGS }, (_, i) => `#${String.fromCodePoint(0x4e00 + i)}`)
		const posted = await post(h, h.users.alice, { status: `#${long} ${cjk.join(' ')}` })
		// Stored and associated, as Mastodon records it.
		expect(
			await sql(h.store, 'SELECT name FROM status_tags WHERE status_id = ? AND name = ?', posted.id, long)
		).toEqual([{ name: long }])
		// It sorts before the others, takes one of the MAX_PRESENTED_TAGS rows read, and is left out: 69 are presented.
		expect(posted.tags.map((tag) => `#${tag.name}`).toSorted()).toEqual(cjk.toSorted().slice(0, MAX_PRESENTED_TAGS - 1))
	})

	it("keeps a local post with a hashtag past its bound on that hashtag's timeline, after an edit too", async () => {
		const h = await community(['alice'])
		const long = 'a'.repeat(MAX_TAG_LENGTH + 1)
		const posted = await post(h, h.users.alice, { status: `hello #${long}` })
		const timeline = async () => {
			const response = await h.request(`/api/v1/timelines/tag/${long}`, {
				headers: { authorization: `Bearer ${h.users.alice.token}` },
			})
			return ((await response.json()) as { id: string }[]).map((status) => status.id)
		}
		expect(await timeline()).toEqual([posted.id])
		const edited = await h.request(`/api/v1/statuses/${posted.id}`, {
			method: 'PUT',
			headers: { authorization: `Bearer ${h.users.alice.token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ status: `edited #${long}` }),
		})
		expect(edited.status).toBe(200)
		expect(await timeline()).toEqual([posted.id])
	})
})

// Realistic posts of each implementation at its own length limit, in Japanese with its own markup.
const misskey = () => {
	const mention = '<a href="https://misskey.example/@bob" class="u-url mention">@bob@misskey.example</a>'
	const tag = '<a href="https://misskey.example/tags/日本語" rel="tag">#日本語</a>'
	const link = '<a href="https://example.com/path/to/page">https://example.com/path/to/page</a>'
	return `<p><span>${Array.from({ length: 30 }, () => `${'本文の文章です。'.repeat(11)} ${mention} ${tag} ${link}<br>`).join('')}</span></p>`
}
const pleroma = () => {
	const mention =
		'<span class="h-card"><a class="u-url mention" data-user="AbCdEf123" href="https://pleroma.example/users/bob" ' +
		'rel="ugc">@<span>bob</span></a></span>'
	const tag = '<a class="hashtag" data-tag="日本語" href="https://pleroma.example/tag/日本語" rel="tag ugc">#日本語</a>'
	const link = '<a href="https://example.com/path/to/page" rel="ugc">https://example.com/path/to/page</a>'
	return Array.from({ length: 50 }, () => `${'本文の文章です。'.repeat(11)} ${mention} ${tag} ${link}<br/>`).join('')
}
const gotosocial = () => {
	const mention =
		'<span class="h-card"><a href="https://gts.example/@bob" class="mention" rel="nofollow noreferrer noopener" ' +
		'target="_blank">@<span>bob</span></a></span>'
	const tag =
		'<a href="https://gts.example/tags/日本語" class="mention hashtag" rel="tag nofollow noreferrer noopener" ' +
		'target="_blank">#<span>日本語</span></a>'
	return Array.from({ length: 50 }, () => `<p>${'本文の文章です。'.repeat(11)} ${mention} ${tag}</p>`).join('')
}
const mastodon = () =>
	'<p><span class="h-card" translate="no"><a href="https://mastodon.example/@bob" class="u-url mention">@<span>bob</span>' +
	`</a></span> ${'本文の文章です。'.repeat(55)}</p><p><a href="https://mastodon.example/tags/日本語" ` +
	'class="mention hashtag" rel="tag">#<span>日本語</span></a></p>'

describe('realistic content is never cut (RES-2)', () => {
	it.each([
		['Misskey (3,000 characters)', misskey],
		['Pleroma and Akkoma (5,000)', pleroma],
		['GoToSocial (5,000)', gotosocial],
		['Mastodon (500)', mastodon],
	])('keeps %s whole, as stored and as read', async (_name, html) => {
		const stored = sanitizeRemoteContent(html())
		expect(stored).toBe(sanitizeRemoteHtml(html()))
		expect(jsonStringBytes(stored)).toBeLessThan(STATUS_CONTENT_BYTES / 2)
		const spoiler = 'ネタバレ注意。'.repeat(70)
		expect(
			parseRemoteStatus({
				id: 'https://remote.example/notes/1',
				type: 'Note',
				to: ['https://www.w3.org/ns/activitystreams#Public'],
				content: html(),
				summary: spoiler,
			})
		).toMatchObject({ content: stored, spoilerText: spoiler })
		const t = await setup()
		const author = await maximalAccount(t, true)
		const id = await storedStatus(t, author, {
			content: stored,
			spoiler,
			media: [],
			mentions: [],
			tags: [],
			poll: null,
		})
		const { answer } = await read(t, getStatus, id)
		expect(answer).toMatchObject({ content: stored, spoiler_text: spoiler })
	})
})

// The viewer's own filters at their bounds (filters.ts): MAX_FILTERS of them in every context, each with a title of
// MAX_FILTER_TITLE characters and a keyword of MAX_FILTER_KEYWORD that the statuses' text holds, and each naming the
// given statuses, so every presented status carries every filter with a keyword match and its status matches.
async function maximalFilters(t: Setup, fill: Fill, statuses: readonly string[]): Promise<void> {
	// The first keyword is what the statuses hold, so it matches; the rest fill the filter's keywords.
	const matching = (fill === 'raw' ? 'x' : C).repeat(MAX_FILTER_KEYWORD)
	const other = (k: number) =>
		fill === 'raw' ? `${String.fromCodePoint(0x20000 + k)}${W.repeat(MAX_FILTER_KEYWORD - 1)}` : matching
	for (let i = 0; i < MAX_FILTERS; i++) {
		const filter = nextId()
		await sql(
			t.store,
			`INSERT INTO filters (id, account_id, title, context, action) VALUES (?, ?, ?, ?, 'warn')`,
			filter,
			ALICE,
			(fill === 'raw' ? W : C).repeat(MAX_FILTER_TITLE),
			JSON.stringify(['home', 'notifications', 'public', 'thread', 'account'])
		)
		for (let k = 0; k < MAX_FILTER_KEYWORDS; k++) {
			await sql(
				t.store,
				'INSERT INTO filter_keywords (id, filter_id, keyword, whole_word) VALUES (?, ?, ?, 0)',
				nextId(),
				filter,
				k === 0 ? matching : other(k)
			)
		}
		for (const status of statuses) {
			await sql(
				t.store,
				'INSERT INTO filter_statuses (id, filter_id, status_id) VALUES (?, ?, ?)',
				nextId(),
				filter,
				status
			)
		}
	}
}

type Shape = { sqlite: number; json: number; rows: number; nodes: number }

// A quote of a status and a boost of the quote, each part of every status at its bound and each account at its
// bounds, filled as `fill`, with alice's profile and filters at their bounds, the filters naming all three, her votes
// in every choice of both polls shown, and every flag of hers on each. The boost's own row holds every part its CHECK
// and triggers accept (all but content), and attachments, mentions, hashtags and a poll of its own, which the presenter
// neither reads nor shows.
async function maximalStatuses(fill: Fill) {
	const t = await setup()
	await sql(
		t.store,
		'UPDATE accounts SET display_name = ?, note = ?, url = ?, avatar_url = ?, header_url = ?, emojis = ? WHERE id = ?',
		(fill === 'raw' ? W : C).repeat(2048),
		fill === 'raw' ? RAW_BIO : MAX_BIO,
		atLimit(`https://kopje.test/@alice/`, PROFILE_URL_LIMIT),
		atLimit(`https://kopje.test/a/alice/`, PROFILE_URL_LIMIT),
		atLimit(`https://kopje.test/h/alice/`, PROFILE_URL_LIMIT),
		accountEmojis(fill),
		ALICE
	)
	const [booster, quoter, quotedAuthor] = [
		await maximalAccount(t, false, fill),
		await maximalAccount(t, false, fill),
		await maximalAccount(t, false, fill),
	]
	const quoted = await storedStatus(t, quotedAuthor, await maximalParts(t, fill))
	const quote = await storedStatus(t, quoter, await maximalParts(t, fill))
	await sql(
		t.store,
		`INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, updated_at)
		SELECT ?1, uri, id, account_id, 'accepted', ?3 FROM statuses WHERE id = ?2`,
		quote,
		quoted,
		new Date(NOW).toISOString()
	)
	const boost = await storedStatus(t, booster, { ...(await maximalParts(t, fill)), reblogOf: quote })
	await maximalFilters(t, fill, [quoted, quote, boost])
	const at = new Date(NOW).toISOString()
	for (const id of [quoted, quote]) {
		await sql(t.store, 'UPDATE polls SET multiple = 1 WHERE status_id = ?', id)
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ? - 1)
			INSERT INTO poll_votes (poll_id, account_id, choice, generation, created_at) SELECT ?, ?, i, 0, ? FROM n`,
			MAX_REMOTE_OPTIONS,
			id,
			ALICE,
			at
		)
	}
	for (const id of [quoted, quote, boost]) {
		await sql(t.store, 'INSERT INTO favourites (account_id, status_id, created_at) VALUES (?, ?, ?)', ALICE, id, at)
		await sql(t.store, 'INSERT INTO bookmarks (account_id, status_id, created_at) VALUES (?, ?, ?)', ALICE, id, at)
		await sql(
			t.store,
			"INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at) VALUES (?, ?, ?, ?, 'public', ?)",
			nextId(),
			`https://kopje.test/boosts/${id}`,
			ALICE,
			id,
			at
		)
	}
	return { t, quoted, quote, boost }
}

// What each fill measures: the table of maxima, and for each item of the heap model its rows by query and column (its
// JSON is the table's). Measured once per fill, by whichever test asks first.
type FillMeasure = {
	shapes: Record<string, Shape>
	heaps: Record<string, Heaps>
	// The nested moved-to accounts each shape shows: how many, and what their JSON lacks of MOVED_ACCOUNT_JSON_MAX.
	moved: Record<string, { count: number; deficit: number }>
	// The statuses each shape shows: how many, and what their `application` entries lack of APPLICATION_JSON_MAX.
	applications: Record<string, { count: number; deficit: number }>
	// The attachments each shape shows: how many, and what their URLs and blurhash lack of their maxima.
	media: Record<string, { count: number; deficit: number }>
	// The verified local fields each shape shows: how many, and what their values lack of LOCAL_FIELD_VALUE_JSON_MAX.
	localFields: Record<string, { count: number; deficit: number }>
	// The JSON of the fields of the account occurrence (a remote account's, at REMOTE_FIELDS_BYTES).
	accountFields: number
	// The moderation_warning notification as a stream payload: its JSON encoded again as a string (stream-hub.ts).
	warningPayload: number
}
const fills = new Map<Fill, Promise<FillMeasure>>()

function measureFill(fill: Fill): Promise<FillMeasure> {
	const measure = fills.get(fill) ?? measureShapes(fill)
	fills.set(fill, measure)
	return measure
}

async function measureShapes(fill: Fill): Promise<FillMeasure> {
	const { t, quoted, quote, boost } = await maximalStatuses(fill)
	const shape = (m: Measure): Shape => ({
		sqlite: m.sqliteBytes,
		json: jsonBytes(m.answer),
		rows: m.rows,
		nodes: nodes(m.answer),
	})
	const one = await read(t, getStatus, quoted)
	const pair = await read(t, getStatus, boost)
	// Every part at its bound is shown, and every filter with its match.
	const shown = one.answer as Presented & { filtered: { keyword_matches: string[]; status_matches: string[] }[] }
	expect(shown.media_attachments).toHaveLength(MAX_STATUS_MEDIA)
	expect(shown.mentions).toHaveLength(MAX_STATUS_MENTION_ROWS)
	expect(shown.tags).toHaveLength(MAX_PRESENTED_TAGS)
	expect(shown.poll!.options).toHaveLength(MAX_REMOTE_OPTIONS)
	expect(shown.filtered).toHaveLength(MAX_FILTERS)
	expect(shown.filtered[0]!.keyword_matches).toHaveLength(1)
	expect(shown.filtered[0]!.status_matches).toEqual([quoted])
	expect((pair.answer as { reblog: { quote: { quoted_status: unknown } } }).reblog.quote.quoted_status).not.toBeNull()
	// A conversation of alice's with more participants than presented, each at its bounds, whose last status is the
	// quote, read end to end.
	const participants: string[] = []
	for (let i = 0; i < MAX_PRESENTED_PARTICIPANTS + 8; i++) {
		participants.push(await maximalAccount(t, false, fill))
	}
	await sql(
		t.store,
		"INSERT INTO conversations (account_id, thread, participants, last_status_id) VALUES (?, 'th', ?, ?)",
		ALICE,
		JSON.stringify(participants.toSorted()),
		quote
	)
	const listed = await measured(
		t,
		listConversations as never,
		{
			credential: await credential(t),
			page: { limit: 1 },
			present: { origin: ORIGIN },
		} as never
	)
	const [talk] = (listed.answer as { items: { accounts: { id: string }[]; last_status: unknown }[] }).items
	expect(talk!.accounts.map((a) => a.id)).toEqual(participants.toSorted().slice(0, MAX_PRESENTED_PARTICIPANTS))
	expect(talk!.last_status).not.toBeNull()
	// A favourite group of alice's with its 8 sample accounts at their bounds, its status the quote, read as a page of
	// one group.
	for (let i = 0; i < 8; i++) {
		await sql(
			t.store,
			`INSERT INTO notifications (account_id, type, from_account_id, status_id, created_at, group_key)
			VALUES (?, 'favourite', ?, ?, ?, 'favourite-maximal-1')`,
			ALICE,
			await maximalAccount(t, false, fill),
			quote,
			new Date(NOW).toISOString()
		)
	}
	const grouped = await measured(
		t,
		listGroupedNotifications as never,
		{
			credential: await credential(t),
			page: { limit: 1 },
			types: [],
			excludeTypes: [],
			groupedTypes: null,
			includeFiltered: false,
			expandAccounts: 'full',
			present: { origin: ORIGIN },
		} as never
	)
	const { next: _next, prev: _prev, ...group } = grouped.answer as Record<string, unknown> & { accounts: unknown[] }
	expect(group.accounts).toHaveLength(8)
	// A report of the quoter naming the quote (its first status, past REPORT_STATUS_BYTES alone), by a remote reporter at
	// its bounds (an inbound Flag's, migration 0054_remote_reports) with the comment at its stored bound for the fill
	// (REPORT_COMMENTS), assigned to and resolved by alice (local accounts only), read by alice as the OAuth admin.
	await sql(t.store, "UPDATE local_accounts SET email = 'alice@kopje.test' WHERE account_id = ?", ALICE)
	await setSetting(t.store, 'admin_email', 'alice@kopje.test')
	const adminToken = 'admin-token'
	await sql(
		t.store,
		"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'test', ?, 'admin:read')",
		await sha256Hex(adminToken),
		ALICE
	)
	const reporter = await maximalAccount(t, false, fill)
	const [report] = await sql<{ id: string }>(
		t.store,
		`INSERT INTO reports (account_id, target_account_id, status_ids, uri, comment, created_at, assigned_account_id,
			action_taken_by_account_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING CAST(id AS TEXT) AS id`,
		reporter,
		(await sql<{ account_id: string }>(t.store, 'SELECT account_id FROM statuses WHERE id = ?', quote))[0]!.account_id,
		// status_ids at its stored bound: 100 ids (2,101 bytes), the rest naming no stored status.
		JSON.stringify([quote, quoted, ...Array.from({ length: 98 }, (_, i) => String(990000000000000000 + i))]),
		atLimit(`https://${HOST}/payloads/`, 4096),
		REPORT_COMMENTS[fill],
		new Date(NOW).toISOString(),
		ALICE,
		ALICE
	)
	// Its admin.report, as the OAuth admin's list of notifications presents it (the report as its reporter's entity).
	await sql(
		t.store,
		`INSERT INTO notifications (account_id, type, from_account_id, report_id, created_at)
		VALUES (?, 'admin.report', ?, ?, ?)`,
		ALICE,
		reporter,
		report!.id,
		new Date(NOW).toISOString()
	)
	const notified = await measured(
		t,
		listNotifications as never,
		{
			credential: await credential(t),
			page: { limit: 1 },
			types: ['admin.report'],
			excludeTypes: [],
			accountId: null,
			includeFiltered: false,
			present: { origin: ORIGIN },
		} as never
	)
	const [adminReport] = (notified.answer as { items: { report: { comment: string } }[] }).items
	expect(adminReport!.report.comment).toBe(REPORT_COMMENTS[fill])
	const reported = await measured(
		t,
		getAdminReport as never,
		{
			credential: { tokenHash: await sha256Hex(adminToken), scope: 'admin:read', now: NOW },
			id: report!.id,
			present: { origin: ORIGIN },
		} as never
	)
	const shownReport = (reported.answer as { report: { statuses: { id: string }[] } }).report
	expect(shownReport.statuses.map((status) => status.id)).toEqual([quote])
	// A moderation_warning of a local account at its bounds (the fill's maximal account made local: without the moved-to
	// account, actor document and fetch a local row may not hold, with MAX_FIELDS local fields at their limits: names
	// in the fill's character, values in it in the raw fill and otherwise linked URLs of '&', which linkHtml escapes
	// twice (localLinkValue), each verified; verified_links padded to its stored bound), its text at its stored bound
	// for the fill (WARNING_TEXTS) and status_ids of 100 ids, read by the target in v1 and v2: the account twice, as the
	// sender and as the warning's target_account.
	const target = await maximalAccount(t, false, fill)
	await sql(
		t.store,
		'UPDATE accounts SET moved_to_account_id = NULL, domain = NULL, raw = NULL, fetched_at = NULL WHERE id = ?',
		target
	)
	const fieldChar = fill === 'raw' ? W : C
	await sql(
		t.store,
		`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey, fields, verified_links)
		VALUES (?, ?, X'00', X'00', 'k', ?, ?)`,
		target,
		`${target}@kopje.test`,
		JSON.stringify(
			Array.from({ length: MAX_FIELDS }, (_, i) => ({
				name: fieldChar.repeat(MAX_FIELD_NAME),
				value: fill === 'raw' ? fieldChar.repeat(MAX_FIELD_VALUE) : localLinkValue(i),
			}))
		),
		JSON.stringify(
			Array.from({ length: MAX_FIELDS }, (_, i) => [localLinkValue(i), new Date(NOW).toISOString()])
		).padEnd(VERIFIED_LINKS_BYTES, ' ')
	)
	const targetToken = 'warned-token'
	await sql(
		t.store,
		"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'test', ?, 'read')",
		await sha256Hex(targetToken),
		target
	)
	const warningIds = Array.from({ length: WARNING_STATUS_IDS }, (_, i) => String(980000000000000000 + i))
	const [warningRow] = await sql<{ id: number }>(
		t.store,
		`INSERT INTO account_warnings (target_account_id, action, text, status_ids, created_at)
		VALUES (?, 'none', CAST(? AS TEXT), ?, ?) RETURNING id`,
		target,
		WARNING_TEXTS[fill],
		JSON.stringify(warningIds),
		new Date(NOW).toISOString()
	)
	await sql(
		t.store,
		`INSERT INTO notifications (account_id, type, from_account_id, account_warning_id, created_at)
		VALUES (?1, 'moderation_warning', ?1, ?2, ?3)`,
		target,
		warningRow!.id,
		new Date(NOW).toISOString()
	)
	const targetCredential = { tokenHash: await sha256Hex(targetToken), scope: 'read', now: NOW }
	const warned = await measured(
		t,
		listNotifications as never,
		{
			credential: targetCredential,
			page: { limit: 1 },
			types: ['moderation_warning'],
			excludeTypes: [],
			accountId: null,
			includeFiltered: false,
			present: { origin: ORIGIN },
		} as never
	)
	const [warningNotification] = (
		warned.answer as { items: { account: unknown; moderation_warning: { text: string; status_ids: string[] } }[] }
	).items
	const { text: warningText, status_ids: warningStatusIds } = warningNotification!.moderation_warning
	expect(jsonBytes(warningText)).toBe(fill === 'raw' ? 3 * WARNING_TEXT_BYTES + 2 : 6 * WARNING_TEXT_BYTES + 2)
	expect(jsonBytes(warningStatusIds)).toBe(WARNING_STATUS_IDS_BYTES)
	expect(warningNotification!.moderation_warning).toMatchObject({ target_account: warningNotification!.account })
	const warnedGroup = await measured(
		t,
		listGroupedNotifications as never,
		{
			credential: targetCredential,
			page: { limit: 1 },
			types: ['moderation_warning'],
			excludeTypes: [],
			groupedTypes: null,
			includeFiltered: false,
			expandAccounts: 'full',
			present: { origin: ORIGIN },
		} as never
	)
	const { next: _warnedNext, prev: _warnedPrev, ...warningGroup } = warnedGroup.answer as Record<string, unknown>
	// A favourite of the quote alice's policy filtered, by an account at its bounds, as include_filtered lists it: the
	// largest v1 notification of a status, and the only one presented with `filtered`.
	await sql(
		t.store,
		`INSERT INTO notifications (account_id, type, from_account_id, status_id, created_at, filtered)
		VALUES (?, 'favourite', ?, ?, ?, 1)`,
		ALICE,
		await maximalAccount(t, false, fill),
		quote,
		new Date(NOW).toISOString()
	)
	const filteredList = await measured(
		t,
		listNotifications as never,
		{
			credential: await credential(t),
			page: { limit: 1 },
			types: ['favourite'],
			excludeTypes: [],
			accountId: null,
			includeFiltered: true,
			present: { origin: ORIGIN },
		} as never
	)
	const [filteredNotification] = (filteredList.answer as { items: { filtered?: true; status: { id: string } }[] }).items
	expect(filteredNotification).toMatchObject({ filtered: true, status: { id: quote } })
	const account = (one.answer as Presented).account
	const two = await read(t, getStatus, quote)
	const answers: Record<string, unknown> = {
		account,
		status: one.answer,
		quote: two.answer,
		boostOfQuote: pair.answer,
		conversation: talk,
		group,
		report: shownReport,
		reportNotification: adminReport,
		warningNotification,
		warningGroup,
		filteredNotification,
	}
	// A notification row's `filtered` is read as one integer (NOTIFICATION_COLUMNS), 8 SQLite bytes for each row a
	// shape reads: the group's walk reads 10, the filtered favourite's list the 9 favourites of its window.
	const filteredReads = (m: Measure) =>
		[...m.heaps.values()].reduce((sum, heap) => sum + (heap.columns.get('filtered')?.total ?? 0) / VALUE_BYTES, 0)
	expect(
		[one, grouped, notified, warned, warnedGroup, filteredList].map((m) => filteredReads(m)),
		fill
	).toEqual([0, 10, 1, 1, 1, 9])
	return {
		warningPayload: utf8Length(JSON.stringify(JSON.stringify(warningNotification))),
		accountFields: jsonBytes((account as { fields: unknown }).fields),
		moved: Object.fromEntries(
			Object.entries(answers).map(([name, answer]) => {
				const nested = movedAccounts(answer)
				const deficit = nested.reduce((sum: number, value) => sum + MOVED_ACCOUNT_JSON_MAX - jsonBytes(value), 0)
				for (const value of nested) {
					expect(jsonBytes(value)).toBeLessThanOrEqual(MOVED_ACCOUNT_JSON_MAX)
				}
				return [name, { count: nested.length, deficit }]
			})
		),
		applications: Object.fromEntries(
			Object.entries(answers).map(([name, answer]) => {
				const shown = presentedStatuses(answer)
				const deficit = shown.reduce((sum: number, status) => sum + APPLICATION_JSON_MAX - applicationJson(status), 0)
				for (const status of shown) {
					expect(applicationJson(status)).toBeLessThanOrEqual(APPLICATION_JSON_MAX)
				}
				return [name, { count: shown.length, deficit }]
			})
		),
		localFields: Object.fromEntries(
			Object.entries(answers).map(([name, answer]) => {
				const shown = verifiedFields(answer)
				for (const field of shown) {
					expect(jsonBytes(field.value)).toBeLessThanOrEqual(LOCAL_FIELD_VALUE_JSON_MAX)
					expect(jsonBytes(field.verified_at)).toBe(VERIFIED_AT_JSON_BYTES)
				}
				const deficit = shown.reduce((sum, field) => sum + LOCAL_FIELD_VALUE_JSON_MAX - jsonBytes(field.value), 0)
				return [name, { count: shown.length, deficit }]
			})
		),
		media: Object.fromEntries(
			Object.entries(answers).map(([name, answer]) => {
				const shown = presentedMedia(answer)
				for (const media of shown) {
					for (const key of MEDIA_STRINGS) {
						expect(jsonBytes(media[key])).toBeLessThanOrEqual(
							key === 'blurhash' ? BLURHASH_JSON_MAX : MEDIA_URL_JSON_BYTES
						)
					}
				}
				return [name, { count: shown.length, deficit: shown.reduce((sum, media) => sum + mediaDeficit(media), 0) }]
			})
		),
		shapes: {
			account: { sqlite: one.profileBytes, json: jsonBytes(account), rows: 1, nodes: nodes(account) },
			status: shape(one),
			quote: shape(two),
			boostOfQuote: shape(pair),
			conversation: { ...shape({ ...listed, answer: talk }), sqlite: listed.sqliteBytes },
			group: shape({ ...grouped, answer: group }),
			report: shape({ ...reported, answer: shownReport }),
			reportNotification: shape({ ...notified, answer: adminReport }),
			warningNotification: shape({ ...warned, answer: warningNotification }),
			warningGroup: shape({ ...warnedGroup, answer: warningGroup }),
			filteredNotification: shape({ ...filteredList, answer: filteredNotification }),
		},
		heaps: {
			status: one.heaps,
			quote: two.heaps,
			boostOfQuote: pair.heaps,
			group: grouped.heaps,
			report: reported.heaps,
		},
	}
}

// An account's static images (migration 0061_account_static_images), each at its stored bound whatever the fills hold:
// the fills' accounts are remote, which hold none, and a local account's may hold both.
const STATIC_COLUMNS = new Set(['avatar_static_url', 'header_static_url'])
const STATIC_COLUMN_HEAP = VALUE_BYTES + 2 * STATIC_URL_LIMIT

// A status's app (migration 0064_status_applications), each column at its raw projection bound (stored-bounds.ts
// appNameSql, appWebsiteSql) on every status row whatever the fills hold: their statuses are remote, which show none,
// and every local original may name one.
const APPLICATION_COLUMN_HEAP: Readonly<Record<string, number>> = {
	application_name: VALUE_BYTES + 2 * APP_NAME_BYTES,
	application_website: VALUE_BYTES + 2 * APP_WEBSITE_LIMIT,
}
const APPLICATION_ROW_HEAP = Object.values(APPLICATION_COLUMN_HEAP).reduce((sum, heap) => sum + heap, 0)

// The most JSON a status's `application` entry adds, its separator included: a name of APP_NAME_LIMIT code points
// each escaped to six bytes, and a website of APP_WEBSITE_LIMIT bytes, which JSON writes as they are (isAppWebsite
// admits no character JSON escapes, and only well-formed text).
const APPLICATION_JSON_MAX =
	jsonBytes({ application: { name: C.repeat(APP_NAME_LIMIT), website: 'u'.repeat(APP_WEBSITE_LIMIT) } }) - 1

// What a presented status's `application` entry takes in its JSON, its separator included (0 when it has none).
function applicationJson(status: Record<string, unknown>): number {
	return 'application' in status ? jsonBytes({ application: status.application }) - 1 : 0
}

// The statuses a presented value shows (each object with a quote_approval, which only a Status has).
// A local field value at its bound that renderFieldValue links: a URL of MAX_FIELD_VALUE code units, its path '&'.
function localLinkValue(i: number): string {
	const prefix = `https://x.test/${i}`
	return prefix + '&'.repeat(MAX_FIELD_VALUE - prefix.length)
}

// The most JSON a local field value presents (renderFieldValue and linkHtml, src/domain/status-text.ts): every code
// unit at most twice (in a link's href and its shown text) as an HTML escape of at most six ASCII bytes (&quot;),
// which JSON keeps, and each link's markup once (its quotes escaped by JSON); a link holds at least 'http://' and a host character, and a separator
// from the next, so a value of MAX_FIELD_VALUE code units holds at most (MAX_FIELD_VALUE + 1) / 9 of them.
const LINK_MARKUP =
	'<a href="" target="_blank" rel="nofollow noopener noreferrer"><span class="invisible"></span><span class="ellipsis">' +
	'</span><span class="invisible"></span></a>'
const LOCAL_FIELD_VALUE_JSON_MAX =
	2 + 12 * MAX_FIELD_VALUE + (jsonBytes(LINK_MARKUP) - 2) * Math.floor((MAX_FIELD_VALUE + 1) / ('http://'.length + 2))

// The most JSON a local account's fields present: MAX_FIELDS names of control characters (six bytes each), each value
// at LOCAL_FIELD_VALUE_JSON_MAX and verified (VERIFIED_AT_JSON_BYTES).
const LOCAL_FIELDS_JSON_MAX =
	jsonBytes(
		Array.from({ length: MAX_FIELDS }, () => ({ name: C.repeat(MAX_FIELD_NAME), value: '', verified_at: '' }))
	) +
	MAX_FIELDS * (LOCAL_FIELD_VALUE_JSON_MAX - 2 + VERIFIED_AT_JSON_BYTES - 2)

// The presented fields with a verification time: a local account's verified fields.
function verifiedFields(value: unknown): { value: string; verified_at: string }[] {
	if (Array.isArray(value)) {
		return value.flatMap(verifiedFields)
	}
	if (typeof value !== 'object' || value === null) {
		return []
	}
	const own =
		'verified_at' in value && typeof value.verified_at === 'string'
			? [value as { value: string; verified_at: string }]
			: []
	return [...own, ...Object.values(value).flatMap(verifiedFields)]
}

function presentedStatuses(value: unknown): Record<string, unknown>[] {
	if (Array.isArray(value)) {
		return value.flatMap(presentedStatuses)
	}
	if (typeof value !== 'object' || value === null) {
		return []
	}
	const own = 'quote_approval' in value ? [value as Record<string, unknown>] : []
	return [...own, ...Object.values(value).flatMap(presentedStatuses)]
}

// An item's rows at their per-column maxima: for each query and column, the most any fill read (each fill puts a column
// at the bound in the unit that reads the most heap for it or the most JSON), summed, so a combination of columns no
// single fill holds is counted; a static image column at STATIC_COLUMN_HEAP and an app column at its
// APPLICATION_COLUMN_HEAP on every row. Returns their heap and the largest single row such a combination makes.
function perColumn(measures: readonly Heaps[]): { heap: number; largestRow: number } {
	const queries = new Map<string, { rows: number; columns: Map<string, ColumnHeap> }>()
	for (const heaps of measures) {
		for (const [query, { rows, columns }] of heaps) {
			const most = queries.get(query) ?? { rows: 0, columns: new Map<string, ColumnHeap>() }
			most.rows = Math.max(most.rows, rows)
			for (const [column, { total, largest }] of columns) {
				const was = most.columns.get(column) ?? { total: 0, largest: 0 }
				most.columns.set(column, { total: Math.max(was.total, total), largest: Math.max(was.largest, largest) })
			}
			queries.set(query, most)
		}
	}
	let heap = 0
	let largestRow = 0
	for (const [query, { rows, columns }] of queries) {
		// The moved-to accounts' rows at their caps, whatever the fills hold (MOVED_ROW_HEAP_MAX).
		if (query.includes(selectSql(MOVED_ACCOUNT_COLUMNS.columns))) {
			heap += rows * MOVED_ROW_HEAP_MAX
			largestRow = Math.max(largestRow, MOVED_ROW_HEAP_MAX)
			continue
		}
		const values = [...columns].map(([column, c]) => {
			const cap = STATIC_COLUMNS.has(column) ? STATIC_COLUMN_HEAP : APPLICATION_COLUMN_HEAP[column]
			return cap === undefined ? c : { total: rows * cap, largest: cap }
		})
		heap += 64 * rows + values.reduce((sum, c) => sum + c.total, 0)
		largestRow = Math.max(largestRow, 64 + values.reduce((sum, c) => sum + c.largest, 0))
	}
	return { heap, largestRow }
}

// The polls each shape shows (a quote shows its quoted status's too), and the most a poll's emojis add to its JSON.
const POLLS_SHOWN: Record<string, number> = {
	account: 0,
	status: 1,
	quote: 2,
	boostOfQuote: 2,
	conversation: 2,
	group: 2,
	report: 2,
	filteredNotification: 2,
}
const POLL_EMOJIS_JSON = STATUS_EMOJIS_BYTES - 2

// What a local account adds that the fills' remote account occurrence does not carry: noindex and roles with the
// Owner's badge (the largest role list a local account shows), each with its separator.
const LOCAL_ACCOUNT_KEYS_JSON =
	jsonBytes({ noindex: false, roles: [{ id: OWNER_ROLE.id, name: OWNER_ROLE.name, color: OWNER_ROLE.color }] }) - 1

// The conservative JSON of each shape: the escaped fill's, whose status and account emoji arrays are at their bounds,
// plus a poll's emoji array at its bound for each poll shown. No one fill holds both: the references a poll's choices
// need displace escaped characters (the emoji-poll fill), so this bounds every combination from above. The account
// occurrence adds a local account's keys, and what a local account's fields at LOCAL_FIELDS_JSON_MAX present past the
// remote one's, so it bounds a local account as well as the remote one measured. Each
// nested moved-to account counts at MOVED_ACCOUNT_JSON_MAX, what its caps allow at once, each status shown with an
// `application` at APPLICATION_JSON_MAX, as a local one may show it, and each attachment's four URLs at
// MEDIA_URL_JSON_BYTES and its blurhash at BLURHASH_JSON_MAX, and each verified local field's value at
// LOCAL_FIELD_VALUE_JSON_MAX.
async function conservativeJson(): Promise<Record<string, number>> {
	const { shapes, moved, applications, media, localFields, accountFields } = await measureFill('escaped')
	return Object.fromEntries(
		Object.entries(shapes).map(([name, shape]) => [
			name,
			shape.json +
				(POLLS_SHOWN[name] ?? 0) * POLL_EMOJIS_JSON +
				(name === 'account' ? LOCAL_ACCOUNT_KEYS_JSON + Math.max(0, LOCAL_FIELDS_JSON_MAX - accountFields) : 0) +
				moved[name]!.deficit +
				applications[name]!.deficit +
				media[name]!.deficit +
				localFields[name]!.deficit,
		])
	)
}

// The peaks of "Heap at 8 MiB per answer" (docs/threat-model.md, its model and terms) for answers whose largest item
// is one of `items`, with that item's rows and largest row at their per-column maxima, and its rejected item's JSON at
// its conservative bound.
async function peaks(items: readonly string[], chunks: ChunkPlan, state: number) {
	const measures = await Promise.all(FILLS.map(measureFill))
	const each = items.map((item) => perColumn(measures.map((m) => m.heaps[item]!)))
	const rows = 1.25 * Math.max(...each.map((e) => e.heap))
	const largestRow = Math.max(...each.map((e) => e.largestRow))
	const conservative = await conservativeJson()
	const json = Math.max(...items.map((item) => conservative[item]!))
	const rest = 3 * ANSWER_BYTES + 3 * json + MOVED_EMOJI_SCRATCH + state
	return {
		rows,
		largestRow,
		rejected: 3 * json,
		normal: Math.max(1.25 * chunks.cap, rows) + rest,
		backstop: 1.25 * (chunks.cap + largestRow) + rows + rest,
	}
}

// The nested moved-to account (Account#moved): its row and JSON maxima follow from its caps (MOVED_ACCOUNT_COLUMNS), so
// any target reads and presents within them: one at the caps (movedTarget), a full account at every profile bound, or
// an unavailable one.
describe('the moved-to account (RES-3)', () => {
	it('derives its maxima from its caps', () => {
		expect(MOVED_EMOJI_SCRATCH).toBe(18_060)
		expect({ json: MOVED_ACCOUNT_JSON_MAX, sqlite: MOVED_ROW_SQLITE_MAX, heap: MOVED_ROW_HEAP_MAX }).toEqual({
			json: 11_021,
			sqlite: 11_118,
			heap: 22_876,
		})
	})

	it.each<[string, Fill]>([
		['escaped', 'escaped'],
		['raw', 'raw'],
	])(
		'reads a full account at its bounds, available or not, as a target within them, %s',
		async (_name, fill) => {
			const t = await setup()
			const target = await maximalAccount(t, false, fill)
			// A domain a target is read with (DOMAIN_BYTES), the rest at every profile bound.
			await sql(t.store, 'UPDATE accounts SET domain = ? WHERE id = ?', `${'d'.repeat(DOMAIN_BYTES - 4)}.com`, target)
			const source = await maximalAccount(t, true, fill)
			await sql(t.store, 'UPDATE accounts SET moved_to_account_id = ? WHERE id = ?', target, source)
			for (const unavailable of [false, true]) {
				if (unavailable) {
					await sql(
						t.store,
						"UPDATE accounts SET suspended_at = '2026-01-01', suspension_source = 'account' WHERE id = ?",
						target
					)
				}
				const m = await measured(t, getAccount as never, { id: source, present: { origin: ORIGIN } } as never)
				const [rows] = [...m.heaps].filter(([query]) => query.includes(selectSql(MOVED_ACCOUNT_COLUMNS.columns)))
				expect(rows![1].rows).toBe(1)
				const heap = 64 + [...rows![1].columns.values()].reduce((sum, column) => sum + column.total, 0)
				expect(heap).toBeLessThanOrEqual(MOVED_ROW_HEAP_MAX)
				const moved = (m.answer as { moved: Record<string, unknown> }).moved
				expect(moved).toMatchObject({ id: target, ...(unavailable ? { suspended: true } : {}) })
				expect(jsonBytes(moved)).toBeLessThanOrEqual(MOVED_ACCOUNT_JSON_MAX)
			}
		},
		120_000
	)
})

// A local target's static images at their stored bound (migration 0061_account_static_images, STATIC_URL_LIMIT): a
// plain one, and one that serializes within PROFILE_URL_LIMIT but whose JSON passes it (192 malformed bytes, each
// %EF%BF%BD, and 309 backslashes, which JSON doubles). Each reads and presents within the nested account's caps, and
// the full account shows each within PROFILE_URL_LIMIT as JSON.
describe('static images (RES-2, RES-3)', () => {
	const PLAIN = `https://kopje.test/media/${'s'.repeat(STATIC_URL_LIMIT - 'https://kopje.test/media/'.length)}`
	const WITNESS = ESCAPED_STATIC_WITNESS

	it.each<[string, string | ArrayBuffer]>([
		['plain', PLAIN],
		['escaping', WITNESS],
	])(
		'of a local target at their bound stay within the nested caps and the full bounds, %s',
		async (_name, still) => {
			const t = await setup()
			const image = `https://kopje.test/media/${'i'.repeat(MOVED_URL_LIMIT - 'https://kopje.test/media/'.length)}`
			await sql(
				t.store,
				`UPDATE accounts SET avatar_url = ?1, header_url = ?1, avatar_static_url = CAST(?2 AS TEXT),
					header_static_url = CAST(?2 AS TEXT) WHERE id = ?3`,
				image,
				still,
				ALICE
			)
			expect(
				await sql(t.store, 'SELECT length(CAST(avatar_static_url AS BLOB)) AS n FROM accounts WHERE id = ?', ALICE)
			).toEqual([{ n: STATIC_URL_LIMIT }])
			const source = await maximalAccount(t, true)
			await sql(t.store, 'UPDATE accounts SET moved_to_account_id = ? WHERE id = ?', ALICE, source)
			const m = await measured(t, getAccount as never, { id: source, present: { origin: ORIGIN } } as never)
			const [rows] = [...m.heaps].filter(([query]) => query.includes(selectSql(MOVED_ACCOUNT_COLUMNS.columns)))
			expect(64 + [...rows![1].columns.values()].reduce((sum, column) => sum + column.total, 0)).toBeLessThanOrEqual(
				MOVED_ROW_HEAP_MAX
			)
			const moved = (m.answer as { moved: Record<string, string> }).moved
			expect(jsonBytes(moved)).toBeLessThanOrEqual(MOVED_ACCOUNT_JSON_MAX)
			expect(moved.avatar_static).toBe(typeof still === 'string' ? still : image)
			const full = (await measured(t, getAccount as never, { id: ALICE, present: { origin: ORIGIN } } as never))
				.answer as Record<string, string>
			for (const key of ['avatar', 'avatar_static', 'header', 'header_static']) {
				expect(utf8Length(JSON.stringify(full[key])), key).toBeLessThanOrEqual(PROFILE_URL_LIMIT + 2)
			}
			expect(full.avatar_static).toBe(typeof still === 'string' ? still : image)
		},
		120_000
	)
})

// A local original and a local quote of it, each posted through an app at the bounds a status reads and presents it
// within (migration 0064_status_applications): escaped, names of APP_NAME_LIMIT characters JSON escapes to six bytes;
// raw, the most bytes read (APP_NAME_LIMIT four-byte characters, and APP_NAME_BYTES of ASCII, read whole and shown as
// null); malformed, imported bytes (0xFF, no UTF-8 lead byte) that decode to U+FFFD, three bytes each. The fills'
// statuses are remote, which name none, so these are the witnesses of the app columns' caps (APPLICATION_COLUMN_HEAP,
// in RowMeter's unit: a malformed byte decodes to one code unit) and of APPLICATION_JSON_MAX.
describe('status applications (RES-2, RES-3)', () => {
	it('derives their maxima from the caps', () => {
		expect({ row: APPLICATION_ROW_HEAP, json: APPLICATION_JSON_MAX }).toEqual({ row: 4_544, json: 2_399 })
	})

	const bytes = (prefix: string, byte: number, length: number) =>
		new Uint8Array([...new TextEncoder().encode(prefix), ...Array(length - prefix.length).fill(byte)])
			.buffer as ArrayBuffer
	const utf8Bytes = (value: string | ArrayBuffer) => (typeof value === 'string' ? utf8Length(value) : value.byteLength)
	const SITE = 'https://kopje.test/'
	const ASCII_SITE = SITE.padEnd(APP_WEBSITE_LIMIT, 'u')
	type App = { name: string | ArrayBuffer; website: string | ArrayBuffer; shown: unknown }
	const FIXTURES: Record<string, [App, App]> = {
		escaped: [
			{
				name: C.repeat(APP_NAME_LIMIT),
				website: ASCII_SITE,
				shown: { name: C.repeat(APP_NAME_LIMIT), website: ASCII_SITE },
			},
			{
				name: `${C.repeat(APP_NAME_LIMIT - 1)}a`,
				website: ASCII_SITE,
				shown: { name: `${C.repeat(APP_NAME_LIMIT - 1)}a`, website: ASCII_SITE },
			},
		],
		raw: [
			{
				name: W.repeat(APP_NAME_LIMIT),
				website: ASCII_SITE,
				shown: { name: W.repeat(APP_NAME_LIMIT), website: ASCII_SITE },
			},
			{ name: 'n'.repeat(APP_NAME_BYTES), website: ASCII_SITE, shown: null },
		],
		malformed: [
			{
				name: bytes('', 0xff, APP_NAME_LIMIT),
				website: bytes(SITE, 0xff, APP_WEBSITE_LIMIT),
				shown: { name: '\ufffd'.repeat(APP_NAME_LIMIT), website: null },
			},
			{ name: bytes('', 0xff, APP_NAME_BYTES), website: bytes(SITE, 0xff, APP_WEBSITE_LIMIT), shown: null },
		],
	}

	it.each(Object.keys(FIXTURES))(
		'reads and presents them within their caps, %s',
		async (fill) => {
			const t = await setup()
			const [original, quoting] = FIXTURES[fill]!
			const ids: string[] = []
			for (const [i, app] of [original, quoting].entries()) {
				await sql(
					t.store,
					`INSERT INTO oauth_clients (id, secret, name, redirect_uris, website)
					VALUES (?, 's', CAST(? AS TEXT), 'urn:x', CAST(? AS TEXT))`,
					`app-${i}`,
					app.name,
					app.website
				)
				const id = nextId()
				await sql(
					t.store,
					`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, application_id)
					VALUES (?1, 'https://kopje.test/ap/o/' || ?1, ?2, 'public', '<p>x</p>', ?3, ?4)`,
					id,
					ALICE,
					new Date(NOW - 60_000).toISOString(),
					`app-${i}`
				)
				ids.push(id)
			}
			await sql(
				t.store,
				`INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, updated_at)
				SELECT ?1, uri, id, account_id, 'accepted', ?3 FROM statuses WHERE id = ?2`,
				ids[1]!,
				ids[0]!,
				new Date(NOW).toISOString()
			)
			expect(
				await sql(t.store, 'SELECT max(length(CAST(name AS BLOB))) AS n FROM oauth_clients WHERE id LIKE ?', 'app-%')
			).toEqual([{ n: Math.max(...[original, quoting].map((app) => utf8Bytes(app.name))) }])
			// The rows of the statuses query, each app column in RowMeter's unit.
			const { answer, largest } = await runInDurableObject(t.store, async (_instance, state) => {
				const most: Record<string, number> = {}
				const counting = observedSql(state.storage.sql, (rows) => {
					for (const row of rows) {
						for (const column of Object.keys(APPLICATION_COLUMN_HEAP)) {
							if (column in row) {
								const value = row[column]
								const heap = VALUE_BYTES + (typeof value === 'string' ? 2 * value.length : 0)
								most[column] = Math.max(most[column] ?? 0, heap)
							}
						}
					}
				})
				const input = { credential: await credential(t), now: NOW, id: ids[1], present: { origin: ORIGIN } }
				let result = getStatus.run(counting, input as never) as Record<string, unknown>
				while (result.status === 'ok' && 'value' in result) {
					result = result.value as Record<string, unknown>
				}
				return { answer: result as Record<string, unknown>, largest: most }
			})
			for (const [column, heap] of Object.entries(largest)) {
				expect(heap, column).toBeLessThanOrEqual(APPLICATION_COLUMN_HEAP[column]!)
			}
			expect(Object.keys(largest).toSorted()).toEqual(Object.keys(APPLICATION_COLUMN_HEAP).toSorted())
			const quoted = (answer.quote as { quoted_status: Record<string, unknown> }).quoted_status
			expect(answer).toHaveProperty('application', quoting.shown)
			expect(quoted).toHaveProperty('application', original.shown)
			for (const status of [answer, quoted]) {
				expect(applicationJson(status)).toBeLessThanOrEqual(APPLICATION_JSON_MAX)
			}
			if (fill === 'escaped') {
				expect(applicationJson(quoted)).toBe(APPLICATION_JSON_MAX)
			}
		},
		60_000
	)
})

describe('the table of maxima (RES-3)', () => {
	// docs/threat-model.md "Maxima of presented units" states these. An answer admits a whole item, so every atomic
	// shape stays within 85% of ANSWER_BYTES (8 MiB) with filters included, measured and conservative alike.
	const LIMIT = 0.85 * 8 * 1024 * 1024

	it.each<[string, Fill, Record<string, Shape>]>([
		[
			'the escaped worst case: the most JSON',
			'escaped',
			{
				account: { sqlite: 103_264, json: 140_480, rows: 1, nodes: 92 },
				status: { sqlite: 2_764_204, json: 2_675_794, rows: 1485, nodes: 2379 },
				quote: { sqlite: 4_955_051, json: 5_351_621, rows: 1918, nodes: 4760 },
				boostOfQuote: { sqlite: 5_101_497, json: 5_760_605, rows: 1975, nodes: 5719 },
				conversation: { sqlite: 6_309_230, json: 7_037_350, rows: 1944, nodes: 5855 },
				group: { sqlite: 5_814_621, json: 6_475_885, rows: 1953, nodes: 5508 },
				report: { sqlite: 5_264_452, json: 5_948_154, rows: 1933, nodes: 5075 },
				reportNotification: { sqlite: 812_421, json: 403_364, rows: 1061, nodes: 294 },
				warningNotification: { sqlite: 92_522, json: 290_370, rows: 9, nodes: 223 },
				warningGroup: { sqlite: 92_522, json: 290_559, rows: 9, nodes: 230 },
				filteredNotification: { sqlite: 5_063_783, json: 5_492_227, rows: 1941, nodes: 4856 },
			},
		],
		[
			'mentions whose url is derived',
			'derived',
			{
				account: { sqlite: 103_264, json: 140_480, rows: 1, nodes: 92 },
				status: { sqlite: 2_356_204, json: 2_266_194, rows: 1485, nodes: 2379 },
				quote: { sqlite: 4_139_051, json: 4_532_421, rows: 1918, nodes: 4760 },
				boostOfQuote: { sqlite: 4_285_497, json: 4_941_405, rows: 1975, nodes: 5719 },
				conversation: { sqlite: 5_493_230, json: 6_218_150, rows: 1944, nodes: 5855 },
				group: { sqlite: 4_998_621, json: 5_656_685, rows: 1953, nodes: 5508 },
				report: { sqlite: 4_433_452, json: 5_038_954, rows: 1933, nodes: 5075 },
				reportNotification: { sqlite: 797_421, json: 313_364, rows: 1061, nodes: 294 },
				warningNotification: { sqlite: 92_522, json: 290_370, rows: 9, nodes: 223 },
				warningGroup: { sqlite: 92_522, json: 290_559, rows: 9, nodes: 230 },
				filteredNotification: { sqlite: 4_247_783, json: 4_673_027, rows: 1941, nodes: 4856 },
			},
		],
		[
			'the raw worst case: the most bytes read from SQLite',
			'raw',
			{
				account: { sqlite: 123_257, json: 132_852, rows: 1, nodes: 80 },
				status: { sqlite: 4_444_976, json: 2_202_136, rows: 1485, nodes: 2367 },
				quote: { sqlite: 6_818_995, json: 4_404_305, rows: 1918, nodes: 4736 },
				boostOfQuote: { sqlite: 7_113_608, json: 4_652_063, rows: 1975, nodes: 5683 },
				conversation: { sqlite: 8_496_647, json: 5_998_498, rows: 1944, nodes: 5687 },
				group: { sqlite: 7_880_885, json: 5_467_545, rows: 1953, nodes: 5388 },
				report: { sqlite: 7_198_969, json: 4_877_392, rows: 1933, nodes: 5027 },
				reportNotification: { sqlite: 2_360_601, json: 288_108, rows: 1061, nodes: 270 },
				warningNotification: { sqlite: 133_535, json: 235_308, rows: 9, nodes: 215 },
				warningGroup: { sqlite: 133_535, json: 235_497, rows: 9, nodes: 222 },
				filteredNotification: { sqlite: 6_953_017, json: 4_537_283, rows: 1941, nodes: 4820 },
			},
		],
		[
			'short emoji references in every poll: the most poll emojis',
			'emoji-poll',
			{
				account: { sqlite: 103_264, json: 140_480, rows: 1, nodes: 92 },
				status: { sqlite: 2_763_356, json: 2_687_895, rows: 1485, nodes: 2431 },
				quote: { sqlite: 4_953_355, json: 5_375_823, rows: 1918, nodes: 4864 },
				boostOfQuote: { sqlite: 5_099_801, json: 5_784_807, rows: 1975, nodes: 5823 },
				conversation: { sqlite: 6_307_534, json: 7_061_552, rows: 1944, nodes: 5959 },
				group: { sqlite: 5_812_925, json: 6_500_087, rows: 1953, nodes: 5612 },
				report: { sqlite: 5_262_756, json: 5_972_356, rows: 1933, nodes: 5179 },
				reportNotification: { sqlite: 812_421, json: 403_364, rows: 1061, nodes: 294 },
				warningNotification: { sqlite: 92_522, json: 290_370, rows: 9, nodes: 223 },
				warningGroup: { sqlite: 92_522, json: 290_559, rows: 9, nodes: 230 },
				filteredNotification: { sqlite: 5_062_087, json: 5_516_429, rows: 1941, nodes: 4960 },
			},
		],
	])(
		'measures %s',
		async (_name, fill, expected) => {
			const { shapes } = await measureFill(fill)
			expect(shapes).toEqual(expected)
			for (const shape of Object.values(shapes)) {
				expect(shape.json).toBeLessThanOrEqual(LIMIT)
			}
		},
		300_000
	)

	// The conservative JSON of every shape is within the ceiling too, and bounds the emoji-poll fill, whose polls each
	// show the most emoji JSON less what their references displace (37 escaped characters: 185 bytes).
	it('keeps the conservative JSON of every shape within 85%, above every fill', async () => {
		const conservative = await conservativeJson()
		// Every presented account but the viewer's own shows a moved-to account, counted at MOVED_ACCOUNT_JSON_MAX.
		for (const fill of await Promise.all(FILLS.map(measureFill))) {
			expect(Object.fromEntries(Object.entries(fill.moved).map(([name, { count }]) => [name, count]))).toEqual({
				account: 1,
				status: 1,
				quote: 2,
				boostOfQuote: 3,
				conversation: 14,
				group: 10,
				report: 4,
				reportNotification: 2,
				warningNotification: 0,
				warningGroup: 0,
				filteredNotification: 3,
			})
		}
		// Each attachment shown counts its four URLs at MEDIA_URL_JSON_BYTES and its blurhash at BLURHASH_JSON_MAX; the
		// escaped fill's witnesses (backslash queries at the byte bound) come within the URL host and path of them.
		const { media } = await measureFill('escaped')
		console.info(`Media shown and their JSON deficit: ${JSON.stringify(media)}`)
		for (const { count, deficit } of Object.values(media)) {
			expect(deficit).toBeLessThanOrEqual(count * 4 * 2 * 'https://m.example/0/?'.length)
		}
		const [escaped, emojiPoll] = await Promise.all([measureFill('escaped'), measureFill('emoji-poll')])
		const displaced = SHORT_REFERENCES.length * 5
		for (const [name, json] of Object.entries(conservative)) {
			expect(json).toBeLessThanOrEqual(LIMIT)
			for (const fill of await Promise.all(FILLS.map(measureFill))) {
				expect(fill.shapes[name]!.json).toBeLessThanOrEqual(json)
			}
			expect(emojiPoll.shapes[name]!.json - escaped.shapes[name]!.json).toBe(
				(POLLS_SHOWN[name] ?? 0) * (POLL_EMOJIS_JSON - displaced)
			)
		}
		expect(conservative).toEqual({
			account: 147_990,
			status: 2_693_505,
			quote: 5_387_043,
			boostOfQuote: 5_801_116,
			conversation: 7_105_052,
			group: 6_532_827,
			report: 5_988_956,
			reportNotification: 408_744,
			warningNotification: 332_194,
			warningGroup: 332_383,
			filteredNotification: 5_530_339,
		})
	}, 600_000)

	// A moderation_warning is streamed as its notification's JSON encoded again as a string (stream-hub.ts), which
	// escapes each backslash and quote once more: the most of every fill, and the conservative payload (the escaped
	// fill's plus twice its notification's conservative JSON over its measured, as encoding again at most doubles a
	// byte), stay within the hub's payload limit.
	it('keeps the moderation_warning stream payload within the hub’s limit', async () => {
		const fills = await Promise.all(FILLS.map(measureFill))
		const payloads = fills.map((fill) => fill.warningPayload)
		const escaped = await measureFill('escaped')
		const conservative = await conservativeJson()
		const payload =
			escaped.warningPayload + 2 * (conservative.warningNotification! - escaped.shapes.warningNotification!.json)
		expect({ measured: Math.max(...payloads), conservative: payload }).toEqual({
			measured: 331_384,
			conservative: 415_032,
		})
		expect(payload).toBeLessThan(STREAM_LIMITS.payloadBytes)
		// The derived bounds of a local field value and of a local account's fields, and the fill's linked value.
		expect({
			value: LOCAL_FIELD_VALUE_JSON_MAX,
			fields: LOCAL_FIELDS_JSON_MAX,
			linked: jsonBytes(renderFieldValue(localLinkValue(0))),
		}).toEqual({ value: 7_822, fields: 37_677, linked: 2_594 })
	}, 600_000)

	// What an answer of many accounts reads past its budget (one chunk of accounts.ts ANSWER_CHUNK, 50, each with its
	// static images at their stored bound and its moved-to account) and what a page of 80 accounts serializes to at
	// most, from the account occurrence.
	it('bounds a chunk of accounts read past an answer and a page of 80, from the account occurrence', async () => {
		const { shapes } = await measureFill('raw')
		const conservative = await conservativeJson()
		expect({
			chunk: 50 * (shapes.account!.sqlite + 2 * STATIC_URL_LIMIT + MOVED_ROW_SQLITE_MAX),
			page: 80 * conservative.account!,
		}).toEqual({ chunk: 6_769_950, page: 11_839_200 })
	}, 600_000)

	// Half of the Store isolate's 128 MB. A timeline's largest item is a status, a quote or a boost of a quote; groups
	// and reports keep the presentation's state besides (10.1 and 12.5 MB, docs/threat-model.md) and pass half, below
	// the whole (the RES-3 gap).
	const HALF = 64_000_000
	it('keeps the peaks of the heap model within their bounds, from the maxima per column', async () => {
		const timelines = await peaks(['status', 'quote', 'boostOfQuote'], PAGE_CHUNKS, 0)
		const groups = await peaks(['group'], LARGE_ITEM_CHUNKS, 10_100_000)
		const reports = await peaks(['report'], LARGE_ITEM_CHUNKS, 12_500_000)
		const mb = (bytes: number) => (bytes / 1e6).toFixed(2)
		for (const [name, p] of Object.entries({ timelines, groups, reports })) {
			console.info(
				`Peak, ${name}: rows ${mb(p.rows)}, largest row ${mb(p.largestRow)}, rejected ${mb(p.rejected)}, normal ${mb(p.normal)}, backstop fired ${mb(p.backstop)} MB`
			)
		}
		console.info(`Timeline backstop fired: ${timelines.backstop} bytes, ${HALF - timelines.backstop} spare of ${HALF}`)
		expect(timelines.normal).toBeLessThanOrEqual(HALF)
		expect(timelines.backstop).toBeLessThanOrEqual(HALF)
		for (const p of [groups, reports]) {
			expect(p.backstop).toBeLessThanOrEqual(2 * HALF)
		}
	}, 900_000)

	// R (status-rows.ts), which statusStream plans its chunks by, is at least the heap RowMeter counts of the rows each
	// shape reads, with every part at its bound (maximalStatuses).
	it('bounds the rows each shape reads by R', async () => {
		const { t, quoted, quote, boost } = await maximalStatuses('raw')
		const measuredShapes = await runInDurableObject(t.store, (_instance, state) => {
			const real = state.storage.sql
			const viewer = { accountId: ALICE, now: new Date(NOW).toISOString() }
			return [quoted, quote, boost].map((id) => {
				const visible = [id as VisibleStatusId]
				const shared = presentation(new Db(real), visible, { origin: ORIGIN, viewer })
				let bytes = 0
				let rows = 0
				const counting = observedSql(real, (read) => {
					rows += read.length
					bytes += heap(read)
				})
				presentStatusesWithin(new Db(counting), shared, visible, Infinity, true, 1)
				const [bound] = real
					.exec<{ bytes: number }>(statusRowBoundSql(), JSON.stringify(visible), ALICE, MAX_FILTERS)
					.toArray()
				return { bytes, rows, bound: bound!.bytes }
			})
		})
		for (const shape of measuredShapes) {
			expect(shape.bytes).toBeLessThanOrEqual(shape.bound)
		}
		console.info(
			`R at the maxima (status, quote, boost of a quote): ${measuredShapes.map((m) => `${m.bound} for ${m.bytes} counted in ${m.rows} rows`).join('; ')}`
		)
	}, 300_000)

	// The largest atomic items through the real Store RPC (32 MiB per return): the boost of a quote alone, and an
	// answer of the boost, the quote and the quoted status, which admits the boost and stops at the quote. Raw fill is
	// the most serialized bytes (four-byte characters), escaped fill the most JSON.
	it.each<[string, Fill]>([
		['escaped', 'escaped'],
		['raw', 'raw'],
	])(
		'returns the largest atomic items through the Store RPC, %s',
		async (_name, fill) => {
			const { t, quoted, quote, boost } = await maximalStatuses(fill)
			const input = {
				credential: { ...(await credential(t)), scope: 'read' as const },
				now: NOW,
				present: { origin: ORIGIN },
			}
			const one = await t.store.getStatus(BUILD, { ...input, id: boost })
			const many = await t.store.getStatuses(BUILD, { ...input, ids: [boost, quote, quoted] })
			expect(one.status === 'ok' && one.value.status === 'ok' && one.value.value.id).toBe(boost)
			expect(many.status === 'ok' && many.value.map((s) => s.id)).toEqual([boost])
			const sizes = [jsonBytes(one), jsonBytes(many)]
			for (const size of sizes) {
				expect(size).toBeLessThanOrEqual(ANSWER_BYTES)
			}
			console.info(`Store RPC, ${fill}: the boost of a quote ${sizes[0]}, the lookup ${sizes[1]} JSON bytes`)
		},
		120_000
	)
})

describe('ActivityPub Notes of a local status at its bounds (RES-3)', () => {
	// A converted local status with every part at its bound,
	// built as statusFacts and noteOf build the object endpoint's Note, the outbox's Create and the featured
	// collection's Notes. docs/threat-model.md "Maxima of presented units" states the Note and the Create.
	it('measures the Note and the Create, within OUTBOX_BYTES, and five Notes of the featured collection', async () => {
		const t = await setup()
		const parts = await maximalParts(t)
		// Addressed to MAX_LOCAL_ADDRESSED accounts, each actor id at ACTOR_URI_LIMIT: the mentions above and more.
		const base = 950_000_000_000_000_000n
		const more = MAX_LOCAL_ADDRESSED - parts.mentions.length
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT CAST(?2 + i AS TEXT), substr(?3 || (?2 + i) || '/' || ?4, 1, ?5), 'a' || i, ?6 FROM n`,
			more,
			String(base),
			`https://${HOST}/users/`,
			'u'.repeat(ACTOR_URI_LIMIT),
			ACTOR_URI_LIMIT,
			HOST
		)
		parts.mentions = [...parts.mentions, ...Array.from({ length: more }, (_, i) => String(base + BigInt(i + 1)))]
		// A local emoji snapshot at exactly STATUS_EMOJIS_BYTES presented bytes, every entry resolved to an Emoji tag
		// (custom-emojis.ts localEmojiTags), with as many entries as fit (local-emoji-helpers.ts localSnapshotAtCap).
		parts.emojis = await localSnapshotAtCap(t.store, ALICE, STATUS_EMOJIS_BYTES)
		expect(presentedEmojiBytes(JSON.parse(parts.emojis) as [string, string][])).toBe(STATUS_EMOJIS_BYTES)
		const ids: string[] = []
		for (let i = 0; i < PIN_LIMIT; i++) {
			const id = await storedStatus(t, ALICE, parts)
			await sql(t.store, 'INSERT INTO status_pins (account_id, status_id) VALUES (?, ?)', ALICE, id)
			ids.push(id)
		}
		const measuredNote = await runInDurableObject(t.store, (_instance, state) => {
			let sqlite = 0
			let rows = 0
			const counting = observedSql(state.storage.sql, (read) => {
				for (const row of read) {
					rows++
					for (const value of Object.values(row)) {
						sqlite += typeof value === 'string' ? utf8Length(value) : 8
					}
				}
			})
			const facts = statusFacts(new Db(counting), ids[0]!, { reached: false })!
			const note = noteOf(facts)
			return {
				sqlite,
				rows,
				nodes: nodes(note),
				note: jsonBytes(note),
				create: jsonBytes(createActivity(facts).activity),
				tags: facts.tags.length,
				longest: Math.max(...facts.tags.map((tag) => [...tag.name].length)),
				mentions: facts.mentions.length,
				media: facts.media.length,
				emojis: facts.emojis.length,
				emojiTags: jsonBytes(facts.emojis),
			}
		})
		expect(measuredNote).toMatchObject({ tags: MAX_PRESENTED_TAGS, mentions: MAX_STATUS_MENTION_ROWS, media: 4 })
		expect(measuredNote.longest).toBeLessThanOrEqual(MAX_TAG_LENGTH)
		expect(measuredNote.create).toBeLessThanOrEqual(OUTBOX_BYTES)
		const featured = await runInDurableObject(t.store, (_instance, state) =>
			getFeatured.run(state.storage.sql, { username: 'alice' })
		)
		// Five such Notes pass the bound: the first ones are shown whole, the rest by their uri.
		let items = featured as unknown
		while (!Array.isArray(items)) {
			items = (items as { value: unknown }).value
		}
		const pins = items as { uri: string; note: string | null }[]
		const featuredBytes = jsonBytes(pins)
		expect(featuredBytes).toBeLessThanOrEqual(ANSWER_BYTES)
		const whole = pins.filter((item) => item.note !== null).length
		expect(whole).toBeGreaterThan(0)
		expect(whole).toBeLessThan(PIN_LIMIT)
		expect(pins).toHaveLength(PIN_LIMIT)
		// Three hashtags far past their bound, as a converted row may hold them, are left out, as the Status entity leaves
		// them out.
		const long = await storedStatus(t, ALICE, {
			...parts,
			mentions: [],
			media: [],
			poll: null,
			tags: [1, 2, 3].map((i) => `${i}${'x'.repeat(240_000)}`),
		})
		const shown = await runInDurableObject(t.store, (_instance, state) => {
			const facts = statusFacts(new Db(state.storage.sql), long, { reached: false })!
			return { tags: facts.tags.length, create: jsonBytes(createActivity(facts).activity) }
		})
		expect(shown.tags).toBe(0)
		expect(shown.create).toBeLessThan(200_000)
		expect({ ...measuredNote, featured: featuredBytes, whole }).toEqual({
			sqlite: 3_697_315,
			rows: 1_337,
			nodes: 3_165,
			note: 4_243_251,
			create: 6_299_312,
			tags: MAX_PRESENTED_TAGS,
			longest: MAX_TAG_LENGTH,
			mentions: MAX_STATUS_MENTION_ROWS,
			media: 4,
			emojis: 61,
			emojiTags: 14_850,
			featured: 4_454_249,
			whole: 1,
		})
	}, 300_000)
})
