import { runInDurableObject } from 'cloudflare:test'

import { Person } from '@fedify/vocab'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { bearer } from './api-helpers'
import { NOW } from './app-helpers'
import { freshStore, migratedStore } from './helpers'
import { community } from './status-helpers'
import { loneSurrogates, movedCountSql, seedBounded, STATUS, TABLES } from './stored-bounds-fixtures'
import { MIGRATIONS } from '../src/db/migrations'
import { Db } from '../src/db/sql'
import { jsonBytes } from '../src/domain/answer-budget'
import { upsertRemoteActor } from '../src/domain/inbox'
import { MAX_SPOILER_LENGTH } from '../src/domain/remote-statuses'
import { MAX_RAW_LENGTH, parseStatusText, renderFieldValue, renderStatusHtml } from '../src/domain/status-text'
import { remoteActorInput } from '../src/federation/remote-actor'
import { parseRemoteStatus } from '../src/federation/remote-status'
import { STATUS_URI_LIMIT } from '../src/platform/identity-bounds'
import { mediaUrl, SERVED_TYPES } from '../src/platform/media-files'
import {
	BIO_JSON_BYTES,
	CONTENT_JSON_BYTES,
	contentSql,
	DISPLAY_NAME_LIMIT,
	displayNameSql,
	MAX_MEDIA_DESCRIPTION_LENGTH,
	MAX_REMOTE_OPTION_LENGTH,
	MAX_REMOTE_OPTIONS,
	MEDIA_META_BYTES,
	MEDIA_URL_LIMIT,
	mediaDescriptionSql,
	mediaMetaSql,
	mediaUrlSql,
	noteSql,
	POLL_OPTIONS_BYTES,
	PROFILE_URL_LIMIT,
	pollOptionsSql,
	profileUrlSql,
	sourceTextSql,
	SPOILER_JSON_BYTES,
	spoilerSql,
	STATUS_URL_LIMIT,
	statusUrlSql,
	storedDisplayName,
	storedMediaDescription,
	storedMediaLink,
	storedMediaMeta,
	storedMediaUrl,
	storedProfileUrl,
	storedStatusUrl,
	storedText,
} from '../src/platform/stored-bounds'
import {
	cutCodeUnits,
	cutJsonString,
	jsonStringBytes,
	REMOTE_BIO_BYTES,
	REMOTE_HTML_RAW_LIMIT,
	sanitizeRemoteBio,
	sanitizeRemoteContent,
	sanitizeRemoteHtml,
	SPOILER_BYTES,
	STATUS_CONTENT_BYTES,
} from '../src/security/html'

// RES-2 (src/platform/stored-bounds.ts): for every covered column, evaluated in the Store's SQLite, a writer's output
// as stored is a fixed point of the column's projection P, and P(P(x)) = P(x). The inputs are random strings with
// U+0000, characters outside the BMP, lone surrogates and characters JSON escapes, measured at each bound, one below
// and one past it, in the bound's own unit (code points, UTF-8 bytes, or UTF-8 bytes of the JSON string).
//
// Both are evaluated inside SQLite, as a trigger would compare them: workerd binds a lone surrogate as its three-byte
// surrogate encoding and reads those bytes back as three U+FFFD, so a value read into the Worker and bound again is
// not the stored value.

const ENCODER = new TextEncoder()

type Unit = 'points' | 'bytes' | 'json'
const UNIT_OF: Record<Unit, (char: string) => number> = {
	points: () => 1,
	bytes: (char) => ENCODER.encode(char).length,
	json: (char) => jsonStringBytes(char) - 2,
}

const ALPHABET = [
	'a',
	' ',
	'\u0000',
	'\u0001',
	'"',
	'\\',
	'\n',
	'<',
	'&',
	'\u007f',
	'é',
	' ',
	'日',
	'\u{1F600}',
	'\ud800',
	'\udc00',
]

// A deterministic stream of choices from a seed (mulberry32).
function random(seed: number): () => number {
	let state = seed >>> 0
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

type Mix = { seed: number; weights: number[]; padAt: number; alphabet: readonly string[] }

function mixOf(alphabet: readonly string[], least = 0): fc.Arbitrary<Mix> {
	return fc.record({
		seed: fc.integer(),
		weights: fc.array(fc.integer({ min: least, max: 8 }), { minLength: alphabet.length, maxLength: alphabet.length }),
		padAt: fc.double({ min: 0, max: 1, noNaN: true }),
		alphabet: fc.constant(alphabet),
	})
}

const mix = mixOf(ALPHABET)

// Canonical text: no U+0000, no lone surrogate, nothing JSON escapes or a sanitizer rewrites. HTML_ALPHABET's
// characters take three bytes and one code unit each, so HTML at a JSON bound stays within REMOTE_HTML_RAW_LIMIT.
const CANONICAL_ALPHABET = ['a', ' ', '\u00e9', '\u65e5', '\u{1F600}']
const HTML_ALPHABET = ['\u65e5', '\u672c', '\u30ab']

// A string of exactly `target` in `unit` (the JSON unit counts the quotes): characters drawn from ALPHABET by the
// mix's weights, then 'a' (one in every unit) at a drawn position for the rest. A lone high surrogate is never
// followed by a low one, so the measure of the whole is the sum of its characters'.
function measured({ seed, weights, padAt, alphabet }: Mix, unit: Unit, target: number): string {
	const next = random(seed)
	const total = weights.reduce((sum, weight) => sum + weight, 0)
	const pick = () => {
		let roll = next() * total
		for (const [i, weight] of weights.entries()) {
			roll -= weight
			if (roll < 0) {
				return alphabet[i] ?? 'a'
			}
		}
		return 'a'
	}
	const chars: string[] = []
	let used = unit === 'json' ? 2 : 0
	while (total > 0) {
		const char = pick()
		if (char === '\udc00' && chars.at(-1) === '\ud800') {
			continue
		}
		const size = UNIT_OF[unit](char)
		if (used + size > target) {
			break
		}
		chars.push(char)
		used += size
	}
	const at = Math.floor(padAt * chars.length)
	return [...chars.slice(0, at), 'a'.repeat(target - used), ...chars.slice(at)].join('')
}

const lengthIn = (unit: Unit, text: string) =>
	unit === 'json' ? jsonStringBytes(text) : [...text].reduce((sum, char) => sum + UNIT_OF[unit](char), 0)

// The inputs at each of `bounds`, one below and one past.
function inputs(bounds: [Unit, number][]): fc.Arbitrary<string> {
	const targets = bounds.flatMap(([unit, bound]) => [-1, 0, 1].map((delta) => [unit, bound + delta] as const))
	return fc.tuple(fc.constantFrom(...targets), mix).map(([[unit, target], m]) => measured(m, unit, target))
}

type Column = {
	name: string
	projection: (column: string) => string
	writer: (value: string) => string | null
	// A text column: its writer's output is well-formed and holds no U+0000.
	text?: true
	// Canonical inputs within the bound, at it and one below, which the writer and P keep unchanged; html wraps them
	// in a paragraph (the tags count toward the bound).
	kept: { unit: Unit; bound: number; html?: true }
	bounds: [Unit, number][]
	runs: number
}

const sanitizerRuns = 4

// A column bounded in UTF-8 bytes alone: inputs at its bound, the same bound for canonical values, 60 runs.
function byteColumn(name: string, projection: Column['projection'], writer: Column['writer'], bound: number): Column {
	return { name, kept: { unit: 'bytes', bound }, projection, writer, bounds: [['bytes', bound]], runs: 60 }
}
const COLUMNS: Column[] = [
	{
		name: 'accounts.display_name',
		kept: { unit: 'points', bound: DISPLAY_NAME_LIMIT },
		projection: displayNameSql,
		writer: storedDisplayName,
		text: true,
		bounds: [
			['points', DISPLAY_NAME_LIMIT],
			['bytes', DISPLAY_NAME_LIMIT],
		],
		runs: 60,
	},
	{
		name: 'accounts.note',
		kept: { unit: 'json', bound: BIO_JSON_BYTES, html: true },
		projection: noteSql,
		writer: (value) => sanitizeRemoteBio(storedText(value)),
		text: true,
		bounds: [
			['json', BIO_JSON_BYTES],
			['bytes', BIO_JSON_BYTES],
		],
		runs: sanitizerRuns,
	},
	byteColumn('accounts.url, avatar_url, header_url', profileUrlSql, storedProfileUrl, PROFILE_URL_LIMIT),
	{
		name: 'statuses.content, status_edits.content',
		kept: { unit: 'json', bound: CONTENT_JSON_BYTES, html: true },
		projection: contentSql,
		writer: (value) => sanitizeRemoteContent(storedText(value)),
		text: true,
		bounds: [
			['json', CONTENT_JSON_BYTES],
			['bytes', CONTENT_JSON_BYTES],
		],
		runs: sanitizerRuns,
	},
	{
		name: 'statuses.spoiler_text, status_edits.spoiler_text',
		kept: { unit: 'json', bound: SPOILER_JSON_BYTES },
		projection: spoilerSql,
		writer: (value) => cutJsonString(storedText(value), SPOILER_JSON_BYTES),
		text: true,
		bounds: [
			['json', SPOILER_JSON_BYTES],
			['bytes', SPOILER_JSON_BYTES],
			['points', Math.floor((SPOILER_JSON_BYTES - 2) / 6)],
		],
		runs: 60,
	},
	{
		name: 'statuses.source_text',
		kept: { unit: 'json', bound: CONTENT_JSON_BYTES },
		projection: sourceTextSql,
		writer: (value) => cutJsonString(storedText(value), CONTENT_JSON_BYTES),
		text: true,
		bounds: [
			['json', CONTENT_JSON_BYTES],
			['bytes', CONTENT_JSON_BYTES],
		],
		runs: 20,
	},
	byteColumn('statuses.url', statusUrlSql, storedStatusUrl, STATUS_URL_LIMIT),
	byteColumn('media_attachments.url', mediaUrlSql, storedMediaUrl, MEDIA_URL_LIMIT),
	byteColumn('media_attachments.preview_url', mediaUrlSql, storedMediaLink, MEDIA_URL_LIMIT),
	{
		name: 'media_attachments.description',
		kept: { unit: 'points', bound: MAX_MEDIA_DESCRIPTION_LENGTH },
		projection: mediaDescriptionSql,
		writer: storedMediaDescription,
		text: true,
		bounds: [
			['points', MAX_MEDIA_DESCRIPTION_LENGTH],
			['bytes', MAX_MEDIA_DESCRIPTION_LENGTH],
		],
		runs: 60,
	},
	byteColumn('media_attachments.meta', mediaMetaSql, storedMediaMeta, MEDIA_META_BYTES),
]

type Sql = DurableObjectState['storage']['sql']

// One value: `expression` over ?1 bound to `value`, as SQLite returns it.
function valueOf(sql: Sql, expression: string, value: string): SqlStorageValue {
	return sql.exec<{ v: SqlStorageValue }>(`SELECT ${expression} AS v`, value).one().v
}

// P(P(x)) IS P(x) for x bound to ?1, inside SQLite.
function idempotent(sql: Sql, projection: (column: string) => string, input: string): boolean {
	return valueOf(sql, `(${projection(`(${projection('?1')})`)}) IS (${projection('?1')})`, input) === 1
}

// P(P(x)) = P(x), and P(writer(x)) = writer(x) as stored.
function checkColumn(sql: Sql, { projection, writer, text }: Column, input: string): void {
	expect(idempotent(sql, projection, input)).toBe(true)
	const written = writer(input)
	if (written !== null) {
		expect(valueOf(sql, `(${projection('?1')}) IS ?1`, written)).toBe(1)
	}
	if (text === true) {
		expect(written?.isWellFormed()).toBe(true)
		expect(written).not.toContain('\u0000')
	}
}

describe('stored bounds (RES-2)', () => {
	it('repeats the bounds it shares with security/html.ts and identity-bounds.ts', () => {
		expect([BIO_JSON_BYTES, CONTENT_JSON_BYTES, SPOILER_JSON_BYTES, STATUS_URL_LIMIT]).toEqual([
			REMOTE_BIO_BYTES,
			STATUS_CONTENT_BYTES,
			SPOILER_BYTES,
			STATUS_URI_LIMIT,
		])
	})

	it('generates inputs of exactly the measure asked for', () => {
		fc.assert(
			fc.property(
				fc.constantFrom<Unit>('points', 'bytes', 'json'),
				fc.integer({ min: 2, max: 3000 }),
				mix,
				(unit, target, m) => {
					expect(lengthIn(unit, measured(m, unit, target))).toBe(target)
				}
			),
			{ numRuns: 300 }
		)
	})

	for (const column of COLUMNS) {
		it(`${column.name}: the writer and P keep a canonical value within the bound`, async () => {
			const { unit, bound, html } = column.kept
			const canonical = fc
				.tuple(fc.constantFrom(bound - 1, bound), mixOf(html === true ? HTML_ALPHABET : CANONICAL_ALPHABET, 1))
				.map(([target, m]) => (html === true ? `<p>${measured(m, unit, target - 7)}</p>` : measured(m, unit, target)))
			await runInDurableObject(freshStore(), (_instance, state) => {
				fc.assert(
					fc.property(canonical, (input) => {
						expect(lengthIn(unit, input)).toBeLessThanOrEqual(bound)
						expect(column.writer(input)).toBe(input)
						expect(valueOf(state.storage.sql, `(${column.projection('?1')}) IS ?1`, input)).toBe(1)
					}),
					{ numRuns: column.text === true && html === true ? 4 : 30 }
				)
			})
		})

		it(`${column.name}: P is idempotent and the writer's output is its fixed point`, async () => {
			await runInDurableObject(freshStore(), (_instance, state) => {
				fc.assert(
					fc.property(inputs(column.bounds), (input) => checkColumn(state.storage.sql, column, input)),
					{ numRuns: column.runs * column.bounds.length }
				)
			})
		}, 120_000)
	}

	it('runs where String.prototype.toWellFormed exists', () => {
		expect(typeof String.prototype.toWellFormed).toBe('function')
		expect(storedText('a\ud800b\u0000\udc00')).toBe('a\ufffdb\ufffd')
	})

	// An actor's display name of lone surrogates is stored as U+FFFD, three bytes each, and reads back at that size.
	it('stores a display name of lone surrogates from ingestion within three bytes a character, read back alike', async () => {
		const actor = await Person.fromJsonLd({
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: 'https://remote.example/users/s',
			type: 'Person',
			preferredUsername: 's',
			name: '\ud800'.repeat(DISPLAY_NAME_LIMIT),
			inbox: 'https://remote.example/users/s/inbox',
		})
		const input = await remoteActorInput(actor, {})
		expect(input).not.toBeNull()
		const store = await migratedStore()
		const stored = await runInDurableObject(store, (_instance, state) =>
			state.storage.transactionSync(() => {
				const db = new Db(state.storage.sql)
				upsertRemoteActor(db, input!, 'https://kopje.test', NOW)
				return db.first<{ name: string; bytes: number }>(
					'SELECT display_name AS name, length(CAST(display_name AS BLOB)) AS bytes FROM accounts WHERE uri = ?',
					'https://remote.example/users/s'
				)
			})
		)
		expect(stored?.bytes).toBeLessThanOrEqual(3 * DISPLAY_NAME_LIMIT)
		expect(ENCODER.encode(stored?.name).length).toBe(stored?.bytes)
		expect(stored?.name).toBe('\ufffd'.repeat(DISPLAY_NAME_LIMIT))
	})

	it('writers remove U+0000 and cut by code points', () => {
		for (const [writer, limit] of [
			[storedDisplayName, DISPLAY_NAME_LIMIT],
			[storedMediaDescription, MAX_MEDIA_DESCRIPTION_LENGTH],
		] as const) {
			fc.assert(
				fc.property(inputs([['points', limit]]), (input) => {
					const written = writer(input)
					expect(written).not.toContain('\u0000')
					expect([...written].length).toBe(Math.min([...storedText(input)].length, limit))
				}),
				{ numRuns: 100 }
			)
		}
	})

	// An edit's snapshot stores P of the poll's choices (statuses.ts recordEdit), so its writer is P itself.
	it('status_edits.poll_options: P is idempotent over JSON arrays of choices at each bound', async () => {
		const choice = (unit: Unit, target: number) => mix.map((m) => measured(m, unit, target))
		const near = (bound: number) => fc.constantFrom(bound - 1, bound, bound + 1)
		const choices = fc.oneof(
			// The number of choices at MAX_REMOTE_OPTIONS, each short.
			near(MAX_REMOTE_OPTIONS).chain((n) => fc.array(choice('points', 8), { minLength: n, maxLength: n })),
			// Choices at MAX_REMOTE_OPTION_LENGTH, in code points or bytes.
			fc.array(
				fc.oneof(
					near(MAX_REMOTE_OPTION_LENGTH).chain((n) => choice('points', n)),
					near(MAX_REMOTE_OPTION_LENGTH).chain((n) => choice('bytes', n))
				),
				{ minLength: 1, maxLength: 8 }
			)
		)
		// The whole array at POLL_OPTIONS_BYTES: long choices, the last padded to the size.
		const whole = fc
			.tuple(near(POLL_OPTIONS_BYTES), fc.array(choice('json', 20_000), { minLength: 40, maxLength: 40 }))
			.map(([target, parts]) => {
				const kept = [...parts]
				while (kept.length > 1 && jsonBytes(kept) > target) {
					kept.pop()
				}
				const size = jsonBytes(kept)
				kept[kept.length - 1] = `${kept.at(-1) ?? ''}${'a'.repeat(Math.max(0, target - size))}`
				return kept
			})
		await runInDurableObject(freshStore(), (_instance, state) => {
			const sql = state.storage.sql
			fc.assert(
				fc.property(fc.oneof(choices, whole), (options) => {
					expect(idempotent(sql, pollOptionsSql, JSON.stringify(options))).toBe(true)
				}),
				{ numRuns: 120 }
			)
		})
	}, 120_000)

	it('builds tokened media URLs within the bound on a host of 253 characters', async () => {
		const host = [63, 63, 63, 61].map((n, i) => String.fromCharCode(97 + i).repeat(n)).join('.')
		expect(host).toHaveLength(253)
		const token = 'T'.repeat(64)
		const urls = [...SERVED_TYPES.keys()].flatMap((type) =>
			(['full', 'small'] as const).map((variant) => mediaUrl(`https://${host}`, token, variant, type))
		)
		await runInDurableObject(freshStore(), (_instance, state) => {
			for (const url of urls) {
				expect(ENCODER.encode(url).length).toBeLessThanOrEqual(MEDIA_URL_LIMIT)
				expect(storedMediaUrl(url)).toBe(url)
				expect(valueOf(state.storage.sql, mediaUrlSql('?1'), url)).toBe(url)
			}
		})
		expect(Math.max(...urls.map((url) => url.length))).toBeLessThan(350)
	})
})

// Cuts that run after storedText split no surrogate pair, so the text writers' output stays well-formed: each case
// puts a pair across the cut.
describe('cuts after normalization (RES-2)', () => {
	const PAIR = '\u{1F600}'

	it('cuts by code units without splitting a pair', () => {
		expect(cutCodeUnits(`ab${PAIR}`, 3)).toBe('ab')
		expect(cutCodeUnits(`ab${PAIR}`, 4)).toBe(`ab${PAIR}`)
		expect(cutCodeUnits(`abc${PAIR}`, 3)).toBe('abc')
		expect(cutCodeUnits('\ud800\ud800x', 1)).toBe('\ud800')
	})

	it("keeps an ingested status's content warning, content and poll choices well-formed", () => {
		const status = parseRemoteStatus({
			id: 'https://remote.example/notes/1',
			type: 'Question',
			attributedTo: 'https://remote.example/users/r',
			summary: `${'a'.repeat(MAX_SPOILER_LENGTH - 1)}${PAIR}`,
			content: `${'c'.repeat(REMOTE_HTML_RAW_LIMIT - 1)}${PAIR}`,
			oneOf: [
				{ type: 'Note', name: `${'o'.repeat(MAX_REMOTE_OPTION_LENGTH - 1)}${PAIR}` },
				{ type: 'Note', name: '\ud800'.repeat(MAX_REMOTE_OPTION_LENGTH) },
			],
		})
		expect(status?.spoilerText).toBe('a'.repeat(MAX_SPOILER_LENGTH - 1))
		expect(status?.content).toBe('c'.repeat(REMOTE_HTML_RAW_LIMIT - 1))
		expect(status?.poll?.options).toEqual([
			'o'.repeat(MAX_REMOTE_OPTION_LENGTH - 1),
			'�'.repeat(MAX_REMOTE_OPTION_LENGTH),
		])
		expect(status?.poll?.cut).toEqual([0, 1])
	})

	it("keeps sanitized HTML well-formed where the bound's prefix search cuts it", () => {
		// 50,000 code units whose sanitized JSON passes both bounds, so the search halves through the pairs.
		const html = `<<${PAIR}`.repeat(REMOTE_HTML_RAW_LIMIT / 4)
		for (const [within, bytes] of [
			[sanitizeRemoteContent, STATUS_CONTENT_BYTES],
			[sanitizeRemoteBio, REMOTE_BIO_BYTES],
		] as const) {
			const output = within(html)
			expect(jsonStringBytes(sanitizeRemoteHtml(html))).toBeGreaterThan(bytes)
			expect(output.isWellFormed()).toBe(true)
			expect(jsonStringBytes(output)).toBeLessThanOrEqual(bytes)
			expect(output.length).toBeGreaterThan(0)
		}
	})

	it('keeps local composition well-formed where a link display or a field value is cut', () => {
		const url = `https://example.com/${'p'.repeat(17)}${PAIR}q`
		const html = renderStatusHtml(parseStatusText(`see ${url}`).segments, {
			mention: () => undefined,
			tagUrl: (name) => `https://kopje.test/tags/${name}`,
		})
		expect(html).toContain(`href="${url}"`)
		expect(html).toContain(`<span class="ellipsis">example.com/${'p'.repeat(17)}</span>`)
		expect(html.isWellFormed()).toBe(true)
		expect(renderFieldValue(`${'v'.repeat(MAX_RAW_LENGTH - 1)}${PAIR}`).isWellFormed()).toBe(true)
	})
})

// Migration 0048_stored_bounds keeps what the API shows: a converted-row fixture with every covered column at its
// bound, past it (all together), of 400,000 U+0001 and with U+0000, stored without the triggers as a Store before
// 0048 holds it, answers the same before and after the file's statements run.
describe('0048_stored_bounds and presented output (RES-2)', () => {
	it('answers the same for every converted row before and after the rewrite', async () => {
		const h = await community(['alice'])
		const { token } = h.users.alice
		await runInDurableObject(h.store, (_instance, state) => {
			const sql = state.storage.sql
			for (const table of TABLES) {
				sql.exec(`DROP TRIGGER ${table}_bounds_insert`)
				sql.exec(`DROP TRIGGER ${table}_bounds_update`)
			}
			seedBounded(sql)
			sql.exec("UPDATE statuses SET edited_at = '2026-10-02T00:00:00.000Z' WHERE id = ?", STATUS)
		})
		const ids = (table: string) =>
			runInDurableObject(h.store, (_instance, state) =>
				state.storage.sql
					.exec<{ id: string }>(`SELECT id FROM ${table} ORDER BY id`)
					.toArray()
					.map((row) => row.id)
			)
		const paths = [
			...(await ids('accounts')).filter((id) => id.startsWith('1')).map((id) => `/api/v1/accounts/${id}`),
			...(await ids('statuses')).filter((id) => id.startsWith('2')).map((id) => `/api/v1/statuses/${id}`),
			`/api/v1/statuses/${STATUS}/history`,
		]
		const answers = async () => {
			const read: [string, number, string][] = []
			for (const path of paths) {
				const response = await h.request(path, { headers: { authorization: `Bearer ${token}` } })
				read.push([path, response.status, await response.text()])
			}
			return read
		}
		const before = await answers()
		expect(before.map(([, status]) => status)).toEqual(paths.map(() => 200))
		const shown = (path: string) =>
			JSON.parse(before.find(([p]) => p === path)?.[2] ?? 'null') as Record<string, unknown>
		// The status at its bounds shows its four attachments, and its history every version.
		expect(shown(`/api/v1/statuses/${STATUS}`).media_attachments).toHaveLength(4)
		expect(shown(`/api/v1/statuses/${STATUS}/history`)).toHaveLength(8)
		const sql = MIGRATIONS.find((m) => m.name === '0048_stored_bounds')?.sql ?? ''
		const moved = await runInDurableObject(h.store, (_instance, state) => {
			const store = state.storage.sql
			const count = () => TABLES.map((table) => store.exec<{ n: number }>(movedCountSql(table)).one().n)
			const was = count()
			state.storage.transactionSync(() => store.exec(sql))
			return { was, now: count() }
		})
		expect(moved.was.every((n) => n > 0)).toBe(true)
		expect(moved.now).toEqual([0, 0, 0, 0])
		expect(await answers()).toEqual(before)
	}, 120_000)
})

// A display name of lone surrogate bytes at its bound is a fixed point SQLite stores as given, which a value read into
// the Worker and bound again is not (three U+FFFD for each): a profile update that leaves the display name keeps it in
// SQL, and the trigger accepts it.
describe('a legacy display name after 0048_stored_bounds (RES-2)', () => {
	it('keeps the stored bytes through a profile update that does not change the display name', async () => {
		const h = await community(['alice'])
		const { id, token } = h.users.alice
		const bytes = () =>
			runInDurableObject(
				h.store,
				(_instance, state) =>
					state.storage.sql
						.exec<{ h: string }>('SELECT hex(CAST(display_name AS BLOB)) AS h FROM accounts WHERE id = ?', id)
						.one().h
			)
		await runInDurableObject(h.store, (_instance, state) => {
			state.storage.sql.exec(
				'UPDATE accounts SET display_name = CAST(? AS TEXT) WHERE id = ?',
				loneSurrogates(DISPLAY_NAME_LIMIT),
				id
			)
		})
		const stored = await bytes()
		expect(stored).toBe('EDA080'.repeat(DISPLAY_NAME_LIMIT))
		const body = new FormData()
		body.set('note', 'a new bio')
		const response = await h.request('/api/v1/accounts/update_credentials', bearer(token, { method: 'PATCH', body }))
		expect(response.status).toBe(200)
		expect(await bytes()).toBe(stored)
	})
})
