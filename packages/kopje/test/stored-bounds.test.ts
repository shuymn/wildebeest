import { runInDurableObject } from 'cloudflare:test'

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { freshStore } from './helpers'
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
	withoutNul,
} from '../src/platform/stored-bounds'
import {
	cutJsonString,
	jsonStringBytes,
	REMOTE_BIO_BYTES,
	sanitizeRemoteBio,
	sanitizeRemoteContent,
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
	bounds: [Unit, number][]
	runs: number
}

const sanitizerRuns = 4
const COLUMNS: Column[] = [
	{
		name: 'accounts.display_name',
		projection: displayNameSql,
		writer: storedDisplayName,
		bounds: [
			['points', DISPLAY_NAME_LIMIT],
			['bytes', DISPLAY_NAME_LIMIT],
		],
		runs: 60,
	},
	{
		name: 'accounts.note',
		projection: noteSql,
		writer: (value) => sanitizeRemoteBio(withoutNul(value)),
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
		writer: (value) => sanitizeRemoteContent(withoutNul(value)),
		bounds: [
			['json', CONTENT_JSON_BYTES],
			['bytes', CONTENT_JSON_BYTES],
		],
		runs: sanitizerRuns,
	},
	{
		name: 'statuses.spoiler_text, status_edits.spoiler_text',
		projection: spoilerSql,
		writer: (value) => cutJsonString(withoutNul(value), SPOILER_JSON_BYTES),
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
		writer: (value) => cutJsonString(withoutNul(value), CONTENT_JSON_BYTES),
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
function checkColumn(sql: Sql, { projection, writer }: Column, input: string): void {
	expect(idempotent(sql, projection, input)).toBe(true)
	const written = writer(input)
	if (written !== null) {
		expect(valueOf(sql, `(${projection('?1')}) IS ?1`, written)).toBe(1)
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

	it('writers remove U+0000 and cut by code points', () => {
		fc.assert(
			fc.property(inputs([['points', DISPLAY_NAME_LIMIT]]), (input) => {
				const name = storedDisplayName(input)
				expect(name).not.toContain('\u0000')
				expect([...name].length).toBe(Math.min([...withoutNul(input)].length, DISPLAY_NAME_LIMIT))
			}),
			{ numRuns: 100 }
		)
		fc.assert(
			fc.property(inputs([['points', MAX_MEDIA_DESCRIPTION_LENGTH]]), (input) => {
				const description = storedMediaDescription(input)
				expect(description).not.toContain('\u0000')
				expect([...description].length).toBe(Math.min([...withoutNul(input)].length, MAX_MEDIA_DESCRIPTION_LENGTH))
			}),
			{ numRuns: 100 }
		)
	})

	// An edit's snapshot stores P of the poll's choices (polls.ts pollOptionsJson), so its writer is P itself.
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
