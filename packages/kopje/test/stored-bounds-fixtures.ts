import {
	BIO_JSON_BYTES,
	CONTENT_JSON_BYTES,
	DISPLAY_NAME_LIMIT,
	MAX_MEDIA_DESCRIPTION_LENGTH,
	MAX_REMOTE_OPTION_LENGTH,
	MAX_REMOTE_OPTIONS,
	MEDIA_META_BYTES,
	MEDIA_URL_LIMIT,
	PROFILE_URL_LIMIT,
	SPOILER_JSON_BYTES,
	STATUS_URL_LIMIT,
	STORED_COLUMNS,
} from '../src/platform/stored-bounds'

// RES-2: a value of each covered column (src/platform/stored-bounds.ts STORED_COLUMNS) at its stored bound and one
// past it, measured in the bound's own unit: JSON-escaped UTF-8 bytes with escapes (U+0001 takes six) and a character
// outside the BMP, code points of characters outside the BMP, or UTF-8 bytes.

const ASTRAL = '\u{1F600}'

// A JSON string of exactly `bytes` UTF-8 bytes with its quotes: 1,000 U+0001 (6 each), one astral character (4) and
// 'a' for the rest.
function json(bytes: number): string {
	return `${'\u0001'.repeat(1000)}${ASTRAL}${'a'.repeat(bytes - 2 - 6000 - 4)}`
}
// A URL of exactly `bytes` UTF-8 bytes.
const url = (bytes: number) => 'https://remote.example/'.padEnd(bytes, 'x')
// A JSON object of exactly `bytes` UTF-8 bytes.
const meta = (bytes: number) => `{"a":"${'x'.repeat(bytes - 8)}"}`
const options = (count: number, points: number) =>
	JSON.stringify(Array.from({ length: count }, () => ASTRAL.repeat(points)))

export type Bounded = { table: string; column: string; at: string; past: string[] }

// Each covered column, its value at the bound, and values one past it.
export const BOUNDED: Bounded[] = [
	{ table: 'statuses', column: 'content', at: json(CONTENT_JSON_BYTES), past: [json(CONTENT_JSON_BYTES + 1)] },
	{ table: 'statuses', column: 'spoiler_text', at: json(SPOILER_JSON_BYTES), past: [json(SPOILER_JSON_BYTES + 1)] },
	{ table: 'statuses', column: 'source_text', at: json(CONTENT_JSON_BYTES), past: [json(CONTENT_JSON_BYTES + 1)] },
	{ table: 'statuses', column: 'url', at: url(STATUS_URL_LIMIT), past: [url(STATUS_URL_LIMIT + 1)] },
	{
		table: 'accounts',
		column: 'display_name',
		at: ASTRAL.repeat(DISPLAY_NAME_LIMIT),
		past: [ASTRAL.repeat(DISPLAY_NAME_LIMIT + 1)],
	},
	{ table: 'accounts', column: 'note', at: json(BIO_JSON_BYTES), past: [json(BIO_JSON_BYTES + 1)] },
	{ table: 'accounts', column: 'url', at: url(PROFILE_URL_LIMIT), past: [url(PROFILE_URL_LIMIT + 1)] },
	{ table: 'accounts', column: 'avatar_url', at: url(PROFILE_URL_LIMIT), past: [url(PROFILE_URL_LIMIT + 1)] },
	{ table: 'accounts', column: 'header_url', at: url(PROFILE_URL_LIMIT), past: [url(PROFILE_URL_LIMIT + 1)] },
	{ table: 'media_attachments', column: 'url', at: url(MEDIA_URL_LIMIT), past: [url(MEDIA_URL_LIMIT + 1)] },
	{ table: 'media_attachments', column: 'preview_url', at: url(MEDIA_URL_LIMIT), past: [url(MEDIA_URL_LIMIT + 1)] },
	{
		table: 'media_attachments',
		column: 'description',
		at: ASTRAL.repeat(MAX_MEDIA_DESCRIPTION_LENGTH),
		past: [ASTRAL.repeat(MAX_MEDIA_DESCRIPTION_LENGTH + 1)],
	},
	{ table: 'media_attachments', column: 'meta', at: meta(MEDIA_META_BYTES), past: [meta(MEDIA_META_BYTES + 1)] },
	{ table: 'status_edits', column: 'content', at: json(CONTENT_JSON_BYTES), past: [json(CONTENT_JSON_BYTES + 1)] },
	{ table: 'status_edits', column: 'spoiler_text', at: json(SPOILER_JSON_BYTES), past: [json(SPOILER_JSON_BYTES + 1)] },
	{
		table: 'status_edits',
		column: 'poll_options',
		at: options(MAX_REMOTE_OPTIONS, MAX_REMOTE_OPTION_LENGTH),
		past: [
			options(MAX_REMOTE_OPTIONS + 1, 8),
			options(1, MAX_REMOTE_OPTION_LENGTH + 1),
			// Past POLL_OPTIONS_BYTES: 200 choices of 1,000 astral characters, 800,601 bytes.
			options(2 * MAX_REMOTE_OPTIONS, MAX_REMOTE_OPTION_LENGTH),
		],
	},
]

// The JSON-bounded columns, as table and column.
export const JSON_BOUNDED = Object.entries(STORED_COLUMNS).flatMap(([table, columns]) =>
	columns.filter((c) => c.jsonBytes !== undefined).map((c) => ({ table, column: c.column }))
)

// SQL that counts the rows of `table` whose covered columns are not all fixed points of their projections.
export function movedCountSql(table: string): string {
	const columns = STORED_COLUMNS[table] ?? []
	return `SELECT count(*) AS n FROM ${table} WHERE ${columns
		.map((c) => `(${c.projection(c.column)}) IS NOT ${c.column}`)
		.join(' OR ')}`
}

// What 0048_stored_bounds stores for each covered column of `table` (its projection, or '' for a media URL), by rowid.
export function storedSql(table: string): string {
	const columns = STORED_COLUMNS[table] ?? []
	const values = columns.map((c) => `(${(c.stored ?? c.projection)(c.column)}) AS ${c.column}`)
	return `SELECT rowid AS r, ${values.join(', ')} FROM ${table} ORDER BY rowid`
}

// The covered columns of `table` as stored, by rowid.
export function columnsSql(table: string): string {
	const columns = STORED_COLUMNS[table] ?? []
	return `SELECT rowid AS r, ${columns.map((c) => c.column).join(', ')} FROM ${table} ORDER BY rowid`
}

// A row's covered values: every column at its bound, every column past it together, 400,000 U+0001 in every
// JSON-bounded column (raw bytes past the bound, escaped six times that), or U+0000 inside every value past its bound
// (but the JSON ones, whose CHECKs refuse it).
export type Variant = 'at' | 'past' | 'flood' | 'nul'
export const VARIANTS: readonly Variant[] = ['at', 'past', 'flood', 'nul']

export function valuesOf(table: string, variant: Variant): Record<string, string> {
	const values: Record<string, string> = {}
	for (const b of BOUNDED.filter((b) => b.table === table)) {
		const past = b.past[0] ?? b.at
		if (variant === 'at') {
			values[b.column] = b.at
		} else if (variant === 'past') {
			values[b.column] = past
		} else if (variant === 'flood') {
			if (JSON_BOUNDED.some((j) => j.table === table && j.column === b.column)) {
				values[b.column] = '\u0001'.repeat(400_000)
			}
		} else if (b.column !== 'meta' && b.column !== 'poll_options') {
			values[b.column] = `${past.slice(0, 10)}\u0000${past.slice(10)}`
		}
	}
	return values
}

// The further values past a bound, each in a row of its own.
export const FURTHER_PAST: { table: string; column: string; value: string }[] = BOUNDED.flatMap((b) =>
	b.past.slice(1).map((value) => ({ table: b.table, column: b.column, value }))
)

// The first account and status of seedBounded, which own its other rows.
export const ACCOUNT = '100000000000000001'
export const STATUS = '200000000000000001'

export const TABLES = ['accounts', 'statuses', 'media_attachments', 'status_edits']
const PREFIX: Record<string, string> = { accounts: '1', statuses: '2', media_attachments: '3' }

// Inserts rows with the given covered values, numbered in each table from 1: the first account and status own the
// rest. Returns the row's key (its id, or its rowid for status_edits).
export function inserter(sql: SqlStorage) {
	const counts = new Map<string, number>()
	return (table: string, values: Record<string, string>): SqlStorageValue => {
		const n = (counts.get(table) ?? 0) + 1
		counts.set(table, n)
		const id = `${PREFIX[table] ?? ''}${String(n).padStart(17, '0')}`
		const base: Record<string, Record<string, SqlStorageValue>> = {
			accounts: { id, uri: `https://remote.example/u/${n}`, username: `u${n}`, domain: 'remote.example' },
			statuses: {
				id,
				uri: `https://remote.example/s/${n}`,
				account_id: ACCOUNT,
				visibility: 'public',
				published_at: '2026-10-01T00:00:00.000Z',
			},
			media_attachments: {
				id,
				account_id: ACCOUNT,
				status_id: STATUS,
				position: n,
				type: 'image',
				url: 'https://remote.example/m.png',
			},
			status_edits: { status_id: STATUS, created_at: '2026-10-01T00:00:00.000Z' },
		}
		const row: Record<string, SqlStorageValue> = { ...base[table], ...values }
		const columns = Object.keys(row)
		return sql
			.exec<{ k: SqlStorageValue }>(
				`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
				RETURNING ${table === 'status_edits' ? 'rowid' : 'id'} AS k`,
				...Object.values(row)
			)
			.one().k
	}
}

// The rows of every covered table in each variant, and one row of each further value past a bound.
export function seedBounded(sql: SqlStorage) {
	const insert = inserter(sql)
	for (const table of TABLES) {
		for (const variant of VARIANTS) {
			insert(table, valuesOf(table, variant))
		}
	}
	for (const { table, column, value } of FURTHER_PAST) {
		insert(table, { [column]: value })
	}
}
