import { runInDurableObject } from 'cloudflare:test'

import { Person } from '@fedify/vocab'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { NOW } from './app-helpers'
import { freshStore, migratedStore } from './helpers'
import { Db } from '../src/db/sql'
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

type Mix = { seed: number; weights: number[]; padAt: number }

const mix: fc.Arbitrary<Mix> = fc.record({
	seed: fc.integer(),
	weights: fc.array(fc.nat({ max: 8 }), { minLength: ALPHABET.length, maxLength: ALPHABET.length }),
	padAt: fc.double({ min: 0, max: 1, noNaN: true }),
})

// A string of exactly `target` in `unit` (the JSON unit counts the quotes): characters drawn from ALPHABET by the
// mix's weights, then 'a' (one in every unit) at a drawn position for the rest. A lone high surrogate is never
// followed by a low one, so the measure of the whole is the sum of its characters'.
function measured({ seed, weights, padAt }: Mix, unit: Unit, target: number): string {
	const next = random(seed)
	const total = weights.reduce((sum, weight) => sum + weight, 0)
	const pick = () => {
		let roll = next() * total
		for (const [i, weight] of weights.entries()) {
			roll -= weight
			if (roll < 0) {
				return ALPHABET[i] ?? 'a'
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
	bounds: [Unit, number][]
	runs: number
}

const sanitizerRuns = 4
const COLUMNS: Column[] = [
	{
		name: 'accounts.display_name',
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
		projection: noteSql,
		writer: (value) => sanitizeRemoteBio(storedText(value)),
		text: true,
		bounds: [
			['json', BIO_JSON_BYTES],
			['bytes', BIO_JSON_BYTES],
		],
		runs: sanitizerRuns,
	},
	{
		name: 'accounts.url, avatar_url, header_url',
		projection: profileUrlSql,
		writer: storedProfileUrl,
		bounds: [['bytes', PROFILE_URL_LIMIT]],
		runs: 60,
	},
	{
		name: 'statuses.content, status_edits.content',
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
		projection: sourceTextSql,
		writer: (value) => cutJsonString(storedText(value), CONTENT_JSON_BYTES),
		text: true,
		bounds: [
			['json', CONTENT_JSON_BYTES],
			['bytes', CONTENT_JSON_BYTES],
		],
		runs: 20,
	},
	{
		name: 'statuses.url',
		projection: statusUrlSql,
		writer: storedStatusUrl,
		bounds: [['bytes', STATUS_URL_LIMIT]],
		runs: 60,
	},
	{
		name: 'media_attachments.url',
		projection: mediaUrlSql,
		writer: storedMediaUrl,
		bounds: [['bytes', MEDIA_URL_LIMIT]],
		runs: 60,
	},
	{
		name: 'media_attachments.preview_url',
		projection: mediaUrlSql,
		writer: storedMediaLink,
		bounds: [['bytes', MEDIA_URL_LIMIT]],
		runs: 60,
	},
	{
		name: 'media_attachments.description',
		projection: mediaDescriptionSql,
		writer: storedMediaDescription,
		text: true,
		bounds: [
			['points', MAX_MEDIA_DESCRIPTION_LENGTH],
			['bytes', MAX_MEDIA_DESCRIPTION_LENGTH],
		],
		runs: 60,
	},
	{
		name: 'media_attachments.meta',
		projection: mediaMetaSql,
		writer: storedMediaMeta,
		bounds: [['bytes', MEDIA_META_BYTES]],
		runs: 60,
	},
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
		it(`${column.name}: P is idempotent and the writer's output is its fixed point`, async () => {
			await runInDurableObject(freshStore(), (_instance, state) => {
				fc.assert(
					fc.property(inputs(column.bounds), (input) => checkColumn(state.storage.sql, column, input)),
					{ numRuns: column.runs * column.bounds.length }
				)
			})
		})
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
		fc.assert(
			fc.property(inputs([['points', DISPLAY_NAME_LIMIT]]), (input) => {
				const name = storedDisplayName(input)
				expect(name).not.toContain('\u0000')
				expect([...name].length).toBe(Math.min([...storedText(input)].length, DISPLAY_NAME_LIMIT))
			}),
			{ numRuns: 100 }
		)
		fc.assert(
			fc.property(inputs([['points', MAX_MEDIA_DESCRIPTION_LENGTH]]), (input) => {
				const description = storedMediaDescription(input)
				expect(description).not.toContain('\u0000')
				expect([...description].length).toBe(Math.min([...storedText(input)].length, MAX_MEDIA_DESCRIPTION_LENGTH))
			}),
			{ numRuns: 100 }
		)
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
				while (kept.length > 1 && ENCODER.encode(JSON.stringify(kept)).length > target) {
					kept.pop()
				}
				const size = ENCODER.encode(JSON.stringify(kept)).length
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
	})

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
