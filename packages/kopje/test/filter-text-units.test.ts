import { runInDurableObject } from 'cloudflare:test'

import fc from 'fast-check'
import { describe, expect, inject, it } from 'vitest'

import { apiHarness, bearer, json, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { acceptQuote, ORIGIN } from './budget-helpers'
import { BUILD } from './helpers'
import { ADMIN_AUD, ADMIN_EMAIL, importViaRpc, setAccess } from './ops-helpers'
import { longestString, observedSql, type SqlRow } from './read-helpers'
import { community, post, remoteAccount, type User } from './status-helpers'
import { Db } from '../src/db/sql'
import { ANSWER_BYTES } from '../src/domain/answer-budget'
import type { VisibleStatusId } from '../src/domain/audience'
import { MAX_FILTER_REQUEST_TEXT, MAX_FILTER_TEXT } from '../src/domain/filters'
import { deleteStatusBatch } from '../src/domain/inbox'
import { htmlToPlainText } from '../src/domain/plain-text'
import { storeRemoteStatus, updateRemoteStatus } from '../src/domain/remote-statuses'
import {
	FILTER_TEXT_UNITS_SQL,
	filterTextBoundSql,
	filterTextTargets,
	measureFilterText,
	type PresentOptions,
	presentation,
	presentStatusesWithin,
	type Status,
	statusStream,
	storedSearchableText,
} from '../src/domain/status-presenter'
import { parseRemoteStatus } from '../src/federation/remote-status'
import type { StoreStub } from '../src/platform/store-client'
import { pollOptionsSql } from '../src/platform/stored-bounds'
import { remotePlainText } from '../src/security/html'

// statuses.filter_text_units (migration 0079_filter_text_units) and the filter text level read from it: each writer
// stores the presenter's own measure (storedSearchableText), an unmeasured row's level reads filterTextBoundSql, an
// upper bound of the same length (property P), and the charge keeps an answer within MAX_FILTER_REQUEST_TEXT whatever
// the figures say (RES-2, RES-3, VIS-18).

const NOW_ISO = new Date(NOW).toISOString()
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public'
const REMOTE_URI = 'https://remote.example/users/carol'

type FilterResult = { keyword_matches: string[] | null }

function inStore<T>(store: StoreStub, fn: (db: Db, sql: SqlStorage) => T): Promise<T> {
	return runInDurableObject(store, (_instance, state) => fn(new Db(state.storage.sql), state.storage.sql))
}

function storedUnits(sql: SqlStorage, id: string): unknown {
	return sql.exec('SELECT filter_text_units AS u FROM statuses WHERE id = ?', id).one().u
}

// The figure the presenter's own function gives for the stored row, as the column must hold it.
function presenterUnits(db: Db, id: string): number | null {
	const text = storedSearchableText(db, id, NOW_ISO)
	return text === null ? null : Math.min(text.length, MAX_FILTER_TEXT)
}

async function filterFor(h: Awaited<ReturnType<typeof community>>, user: User, keyword: string, wholeWord = true) {
	const response = await h.request(
		'/api/v2/filters',
		bearer(
			user.token,
			json({ title: 'f', context: ['public'], keywords_attributes: [{ keyword, whole_word: wholeWord }] })
		)
	)
	expect(response.status).toBe(200)
}

function options(viewer: string): PresentOptions {
	return { origin: ORIGIN, viewer: { accountId: viewer, now: NOW_ISO } }
}

// Unattached processed media of `account`, as an import may hold it (a description past what the upload API takes,
// up to 0048's stored bound): what a local post or edit attaches by id and keeps the description of.
async function importedMedia(store: StoreStub, account: string, descriptions: readonly string[]): Promise<string[]> {
	const ids = descriptions.map(() => nextMediaId())
	for (const [i, id] of ids.entries()) {
		await sql(
			store,
			`INSERT INTO media_attachments (id, account_id, type, url, description)
			VALUES (?1, ?2, 'image', 'https://kopje.test/media/' || ?1 || '.png', ?3)`,
			id,
			account,
			descriptions[i]!
		)
	}
	return ids
}

function note(n: number | string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: `https://remote.example/objects/${n}`,
		type: 'Note',
		attributedTo: REMOTE_URI,
		content: '<p>hello</p>',
		published: '2026-10-11T23:00:00Z',
		to: [PUBLIC],
		cc: [],
		...extra,
	}
}

function attachments(descriptions: readonly string[]) {
	return descriptions.map((name, i) => ({
		type: 'Document',
		mediaType: 'image/png',
		url: `https://remote.example/media/${i}.png`,
		name,
	}))
}

function question(n: number | string, choices: readonly string[], extra: Record<string, unknown> = {}) {
	return note(n, {
		type: 'Question',
		endTime: '2026-10-13T00:00:00Z',
		oneOf: choices.map((name) => ({ type: 'Note', name, replies: { type: 'Collection', totalItems: 0 } })),
		...extra,
	})
}

const CTX = { now: NOW, origin: 'https://kopje.test', deliveredTo: null, fetched: true }

function storeNote(db: Db, author: string, object: Record<string, unknown>): string {
	const input = parseRemoteStatus(object)
	expect(input).not.toBeNull()
	const outcome = storeRemoteStatus(db, { id: author, uri: REMOTE_URI }, input!, CTX)
	expect(outcome).toMatchObject({ applied: true })
	return outcome.statusId!
}

function updateNote(db: Db, author: string, object: Record<string, unknown>): void {
	const input = parseRemoteStatus(object)
	expect(input).not.toBeNull()
	expect(updateRemoteStatus(db, { id: author, uri: REMOTE_URI }, input!, CTX)).toMatchObject({
		applied: true,
		reason: 'edited',
	})
}

describe('each writer stores the measure of what it stored', () => {
	it('a local post with media, and one with a poll (scheduled publication is the same writePost)', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const media = await importedMedia(h.store, alice.id, ['first \u{1f600}', 'second'])
		const withMedia = await post(h, alice, { status: 'a & b', spoiler_text: 'cw', media_ids: media })
		const withPoll = await post(h, alice, {
			status: 'which?',
			poll: { options: ['cats', 'dogs'], expires_in: 3600 },
		})
		await inStore(h.store, (db, sql) => {
			expect(storedSearchableText(db, withMedia.id, NOW_ISO)).toBe('cw\n\na & b\n\nfirst \u{1f600}\n\nsecond')
			expect(storedUnits(sql, withMedia.id)).toBe(presenterUnits(db, withMedia.id))
			expect(storedSearchableText(db, withPoll.id, NOW_ISO)).toBe('\n\nwhich?\n\ncats\n\ndogs\n\n')
			expect(storedUnits(sql, withPoll.id)).toBe(presenterUnits(db, withPoll.id))
		})
	})

	it('a local edit that changes only a description, and one that changes only a poll choice', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const [m] = await importedMedia(h.store, alice.id, ['short'])
		const withMedia = await post(h, alice, { status: 'text', media_ids: [m] })
		const withPoll = await post(h, alice, { status: 'which?', poll: { options: ['cats', 'dogs'], expires_in: 3600 } })
		const before = await inStore(h.store, (_db, sql) => [storedUnits(sql, withMedia.id), storedUnits(sql, withPoll.id)])
		const edit = async (id: string, body: Record<string, unknown>) => {
			const response = await h.request(`/api/v1/statuses/${id}`, bearer(alice.token, json(body, { method: 'PUT' })))
			expect(response.status, await response.clone().text()).toBe(200)
		}
		await edit(withMedia.id, {
			status: 'text',
			media_ids: [m],
			media_attributes: [{ id: m, description: 'a much longer description' }],
		})
		await edit(withPoll.id, { status: 'which?', poll: { options: ['cats', 'hamsters'], expires_in: 3600 } })
		await inStore(h.store, (db, sql) => {
			expect(storedSearchableText(db, withMedia.id, NOW_ISO)).toBe('\n\ntext\n\na much longer description')
			expect(storedSearchableText(db, withPoll.id, NOW_ISO)).toBe('\n\nwhich?\n\ncats\n\nhamsters\n\n')
			const after = [storedUnits(sql, withMedia.id), storedUnits(sql, withPoll.id)]
			expect(after).toEqual([presenterUnits(db, withMedia.id), presenterUnits(db, withPoll.id)])
			expect(after[0]).not.toBe(before[0])
			expect(after[1]).not.toBe(before[1])
		})
	})

	it('a remote create, and remote updates that change only a description or only a poll choice', async () => {
		const h = await community(['alice'])
		const carol = await remoteAccount(h.store, 'carol')
		await inStore(h.store, (db, sql) => {
			const created = storeNote(db, carol, question(1, ['cats', 'dogs'], { attachment: attachments(['photo']) }))
			expect(storedSearchableText(db, created, NOW_ISO)).toBe('\n\nhello\n\ncats\n\ndogs\n\nphoto')
			expect(storedUnits(sql, created)).toBe(presenterUnits(db, created))

			const described = storeNote(db, carol, note(2, { attachment: attachments(['photo']) }))
			const polled = storeNote(db, carol, question(3, ['cats', 'dogs']))
			const before = [storedUnits(sql, described), storedUnits(sql, polled)]
			const updated = '2026-10-11T23:30:00Z'
			updateNote(db, carol, note(2, { updated, attachment: attachments(['a much longer description']) }))
			updateNote(db, carol, question(3, ['cats', 'hamsters'], { updated }))
			expect(storedSearchableText(db, described, NOW_ISO)).toBe('\n\nhello\n\na much longer description')
			expect(storedSearchableText(db, polled, NOW_ISO)).toBe('\n\nhello\n\ncats\n\nhamsters\n\n')
			const after = [storedUnits(sql, described), storedUnits(sql, polled)]
			expect(after).toEqual([presenterUnits(db, described), presenterUnits(db, polled)])
			expect(after[0]).not.toBe(before[0])
			expect(after[1]).not.toBe(before[1])
		})
	})
})

describe('a hide clears the measure in its own write', () => {
	it('writes a measured status as often as an unmeasured one: the stale trigger never fires for it', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const carol = await remoteAccount(h.store, 'carol')
		// Every write of a status row, counted by a trigger of this test: statuses_filter_text_stale's would add one.
		await sql(h.store, 'CREATE TABLE status_writes (id TEXT NOT NULL)')
		await sql(
			h.store,
			'CREATE TRIGGER status_writes_counted AFTER UPDATE ON statuses BEGIN INSERT INTO status_writes VALUES (NEW.id); END'
		)
		const local = [(await post(h, alice, { status: 'measured' })).id, (await post(h, alice, { status: 'not' })).id]
		const remote = await inStore(h.store, (db) => [storeNote(db, carol, note('h1')), storeNote(db, carol, note('h2'))])
		await inStore(h.store, (_db, sql) => {
			sql.exec('UPDATE statuses SET filter_text_units = NULL WHERE id IN (?, ?)', local[1]!, remote[1]!)
			expect([...local, ...remote].map((id) => storedUnits(sql, id))).toEqual([12, null, 9, null])
			sql.exec('DELETE FROM status_writes')
		})
		for (const id of local) {
			const response = await h.request(`/api/v1/statuses/${id}`, bearer(alice.token, { method: 'DELETE' }))
			expect(response.status).toBe(200)
		}
		await inStore(h.store, (db) => remote.forEach((id) => deleteStatusBatch(db, id, NOW)))
		await inStore(h.store, (_db, sql) => {
			const writes = (id: string) => sql.exec('SELECT count(*) AS n FROM status_writes WHERE id = ?', id).one().n
			expect(writes(local[0]!)).toBeGreaterThan(0)
			expect(writes(local[0]!)).toBe(writes(local[1]!))
			expect(writes(remote[0]!)).toBeGreaterThan(0)
			expect(writes(remote[0]!)).toBe(writes(remote[1]!))
		})
	})
})

// ---- The bound (property P)

let sequence = 0
const nextStatusId = () => `5${String(++sequence).padStart(17, '0')}`
const nextMediaId = () => `6${String(++sequence).padStart(17, '0')}`

const ENCODER = new TextEncoder()

// A stored text value: bytes bound as TEXT (CAST of a BLOB keeps them as they are, well-formed or not).
type Bytes = Uint8Array

const HTML_PIECES = [
	'<p>',
	'</p>',
	'</p><p>',
	'<br>',
	'<br />',
	'<br><br>',
	'&amp;',
	'&lt;',
	'&gt;',
	'&quot;',
	'&#39;',
	'&#128512;',
	'&#x1F600;',
	'&#1;',
	'&nbsp;',
	'&',
	'&#',
	'&#x;',
	'&amp;lt;',
	'&amp;amp;',
	'<script>a</script>',
	'<a href="https://a.example/">l</a>',
	'<span class="h-card">@x</span>',
	'"',
	"'",
	'<',
	'>',
	'\u0000',
	'\u{1f600}',
	'é',
	'\r\n',
	'\n',
	' ',
	'a',
]

const wellFormedText = fc
	.array(fc.oneof(fc.constantFrom(...HTML_PIECES), fc.string({ unit: 'binary', maxLength: 6 })), { maxLength: 24 })
	.map((pieces) => ENCODER.encode(pieces.join('')))

// Malformed UTF-8: a lead byte with continuation runs (C0 80 80 ...), truncated sequences, stray continuation and
// invalid bytes, each among well-formed text.
const malformedRun = fc.oneof(
	fc.integer({ min: 0, max: 40 }).map((n) => Uint8Array.from([0xc0, ...Array.from({ length: n }, () => 0x80)])),
	fc.constantFrom(
		Uint8Array.from([0xe2, 0x82]),
		Uint8Array.from([0xf0, 0x9f, 0x98]),
		Uint8Array.from([0x80]),
		Uint8Array.from([0xff]),
		Uint8Array.from([0xed, 0xa0, 0x80]),
		Uint8Array.from([0xf4, 0x90, 0x80, 0x80])
	),
	fc.uint8Array({ maxLength: 12 })
)

function concat(parts: readonly Bytes[]): Bytes {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
	let at = 0
	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}
	return out
}

const storedText = fc.oneof(
	wellFormedText,
	fc.array(fc.oneof(wellFormedText, malformedRun), { maxLength: 6 }).map(concat)
)

// A poll choice as raw JSON (well-formed, a string): raw characters, multibyte ones among them, and JSON escapes.
const JSON_PIECES = [
	'a',
	' ',
	'é',
	'\u{1f600}',
	'あ',
	'\\n',
	'\\"',
	'\\\\',
	'\\/',
	'\\u0000',
	'\\u00e9',
	'\\ud83d\\ude00',
	'\\t',
	'<b>',
	'&amp;',
]
const pollChoice = fc.array(fc.constantFrom(...JSON_PIECES), { maxLength: 12 }).map((pieces) => `"${pieces.join('')}"`)

type Fixture = {
	local: boolean
	spoiler: Bytes
	content: Bytes
	source: Bytes | null
	poll: string[] | null
	media: Bytes[]
}

const fixture: fc.Arbitrary<Fixture> = fc.record({
	local: fc.boolean(),
	spoiler: storedText,
	content: storedText,
	source: fc.option(storedText, { nil: null }),
	poll: fc.option(fc.array(pollChoice, { minLength: 1, maxLength: 100 }), { nil: null }),
	media: fc.array(storedText, { maxLength: 4 }),
})

const buffer = (bytes: Bytes) => bytes.slice().buffer

// Writes `f` as a status of `author` (local or remote), with its poll and shown media; the text columns hold the bytes
// as TEXT. Returns its id.
function writeFixture(
	sql: SqlStorage,
	author: string,
	f: {
		spoiler: SqlStorageValue
		content: SqlStorageValue
		source: SqlStorageValue
		poll: string | null
		media: SqlStorageValue[]
	},
	cast = true
): string {
	const id = nextStatusId()
	const text = (n: number) => (cast ? `CAST(?${n} AS TEXT)` : `?${n}`)
	sql.exec(
		`INSERT INTO statuses (id, uri, account_id, visibility, spoiler_text, content, source_text, published_at)
		VALUES (?1, 'https://kopje.test/ap/o/' || ?1, ?2, 'public', ${text(3)}, ${text(4)}, ${text(5)}, ?6)`,
		id,
		author,
		f.spoiler,
		f.content,
		f.source,
		NOW_ISO
	)
	if (f.poll !== null) {
		const count = (JSON.parse(f.poll) as unknown[]).length
		sql.exec(
			'INSERT INTO polls (status_id, options, tallies) VALUES (?, ?, ?)',
			id,
			f.poll,
			JSON.stringify(Array.from({ length: count }, () => 0))
		)
	}
	for (const [position, description] of f.media.entries()) {
		sql.exec(
			`INSERT INTO media_attachments (id, account_id, status_id, position, type, url, description)
			VALUES (?1, ?2, ?3, ?4, 'image', 'https://remote.example/m.png', ${text(5)})`,
			nextMediaId(),
			author,
			id,
			position,
			description
		)
	}
	return id
}

function boundOf(sql: SqlStorage, id: string): number {
	return sql.exec<{ b: number }>(`SELECT ${filterTextBoundSql('s')} AS b FROM statuses s WHERE s.id = ?`, id).one().b
}

async function authors() {
	const h = await community(['alice'])
	const remote = await remoteAccount(h.store, 'carol')
	return { h, local: h.users.alice.id, remote }
}

describe('the bound of an unmeasured status (property P)', () => {
	it('is at least the searchable text the presenter reads, well-formed or malformed', async () => {
		const { h, local, remote } = await authors()
		await inStore(h.store, (db, sql) => {
			fc.assert(
				fc.property(fixture, (f) => {
					const id = writeFixture(sql, f.local ? local : remote, {
						spoiler: buffer(f.spoiler),
						content: buffer(f.content),
						source: f.source === null ? null : buffer(f.source),
						poll: f.poll === null ? null : `[${f.poll.join(',')}]`,
						media: f.media.map(buffer),
					})
					const text = storedSearchableText(db, id, NOW_ISO)
					expect(text).not.toBeNull()
					expect(boundOf(sql, id)).toBeGreaterThanOrEqual(text!.length)
				}),
				{ numRuns: 400 }
			)
		})
	}, 120_000)

	it('is MAX_FILTER_TEXT for an odd input, whose measure is NULL with no JavaScript run on it', async () => {
		const { h, local, remote } = await authors()
		// After affinity: a BLOB in a text column (a number there is stored as its text), and a poll choice that is not
		// a JSON string.
		const oddPoll = fc.constantFrom('1e20', 'true', 'false', 'null', '[1]', '["a"]', '{"toString":null}', '{}', '-0')
		const odd = fc.oneof(
			fc.record({ column: fc.constantFrom('spoiler', 'content', 'source', 'media'), poll: fc.constant(null) }),
			fc.record({ column: fc.constant(null), poll: oddPoll })
		)
		await inStore(h.store, (db, sql) => {
			fc.assert(
				fc.property(odd, fc.boolean(), fc.uint8Array({ maxLength: 8 }), fc.nat(99), (o, isLocal, bytes, at) => {
					const blob = buffer(bytes)
					const choices = Array.from({ length: at + 1 }, (_, i) => `"c${i}"`)
					if (o.poll !== null) {
						choices[at] = o.poll
					}
					const id = writeFixture(
						sql,
						isLocal ? local : remote,
						{
							spoiler: o.column === 'spoiler' ? blob : '',
							content: o.column === 'content' ? blob : '<p>x</p>',
							source: o.column === 'source' ? blob : null,
							poll: `[${choices.join(',')}]`,
							media: o.column === 'media' ? ['a', blob] : ['a'],
						},
						false
					)
					expect(boundOf(sql, id)).toBe(MAX_FILTER_TEXT)
					sql.exec('UPDATE statuses SET filter_text_units = 0 WHERE id = ?', id)
					measureFilterText(db, id, NOW_ISO)
					expect(storedUnits(sql, id)).toBeNull()
				}),
				{ numRuns: 200 }
			)
		})
	}, 120_000)

	it('holds at the deterministic edges: a numeric choice, astral text, a BLOB content', async () => {
		const { h, local, remote } = await authors()
		await inStore(h.store, (db, sql) => {
			const empty = { spoiler: '', content: '', source: '', poll: null, media: [] }
			// (a) A choice the presenter shows as 21 digits from 7 bytes of JSON: past the byte bound unless odd.
			for (const poll of ['[1e20]', '[{"toString":null}]']) {
				const id = writeFixture(sql, local, { ...empty, poll }, false)
				expect(boundOf(sql, id), poll).toBe(MAX_FILTER_TEXT)
				measureFilterText(db, id, NOW_ISO)
				expect(storedUnits(sql, id), poll).toBeNull()
			}
			// (b) 1,000 astral characters: 2,000 code units in 4,000 bytes, so a bound in characters would fall short.
			const astral = writeFixture(sql, local, { ...empty, spoiler: '\u{1f600}'.repeat(1000) }, false)
			expect(storedSearchableText(db, astral, NOW_ISO)!.length).toBe(2_004)
			expect(boundOf(sql, astral)).toBe(4_004)
			// (c) A remote status whose content is a 1-byte BLOB: the presenter would throw on it.
			const binary = writeFixture(
				sql,
				remote,
				{ ...empty, source: null, content: buffer(Uint8Array.from([0x61])) },
				false
			)
			expect(sql.exec('SELECT typeof(content) AS t FROM statuses WHERE id = ?', binary).one().t).toBe('blob')
			expect(boundOf(sql, binary)).toBe(MAX_FILTER_TEXT)
			expect(() => measureFilterText(db, binary, NOW_ISO)).not.toThrow()
			expect(storedUnits(sql, binary)).toBeNull()
		})
	})
})

// ---- The level and the charge

// Statuses of `author` with the given spoiler and source (content ''), measured through measureFilterText unless
// `measured` is false, in order.
function writeLocal(db: Db, sql: SqlStorage, author: string, sources: readonly string[], measured = true): string[] {
	return sources.map((source) => {
		const id = writeFixture(sql, author, { spoiler: '', content: '', source, poll: null, media: [] }, false)
		if (measured) {
			measureFilterText(db, id, NOW_ISO)
		}
		return id
	})
}

const matchedCount = (statuses: readonly (Status | undefined)[]) =>
	statuses.filter((s) => ((s?.filtered ?? []) as FilterResult[]).some((r) => r.keyword_matches !== null)).length

describe('the filter text level', () => {
	it('tells 9,999 from 10,000: 40 long statuses after a short one share the allowance at 9,999', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await filterFor(h, alice, 'needle', false)
		await inStore(h.store, (db, sql) => {
			const ids = [
				...writeLocal(db, sql, bob.id, ['a']),
				...writeLocal(
					db,
					sql,
					bob.id,
					Array.from({ length: 40 }, () => `${'x'.repeat(9_992)}needle`)
				),
			]
			const texts = ids.map((id) => storedSearchableText(db, id, NOW_ISO)!)
			expect(texts[0]).toBe('\n\na\n\n')
			expect(texts.slice(1).every((t) => t.length === 10_002 && t.indexOf('needle') + 6 === 10_000)).toBe(true)
			expect(ids.map((id) => storedUnits(sql, id))).toEqual([5, ...Array.from({ length: 40 }, () => 10_000)])
			const visible = ids as VisibleStatusId[]
			const shared = presentation(db, visible, options(alice.id))
			expect(shared.level).toBe(9_999)
			const items = presentStatusesWithin(db, shared, visible, ANSWER_BYTES, true).items
			expect(items).toHaveLength(41)
			expect(matchedCount(items)).toBe(0)
			expect(shared.matched.units).toBe(5 + 40 * 9_999)
		})
	}, 60_000)

	it('reads the bound for unmeasured statuses, so it never matches past what the bound allows', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await filterFor(h, alice, 'needle', false)
		await inStore(h.store, (db, sql) => {
			const source = `${'x'.repeat(9_796)}needle${'y'.repeat(196)}`
			const ids = writeLocal(
				db,
				sql,
				bob.id,
				Array.from({ length: 41 }, () => source),
				false
			)
			expect(ids.every((id) => storedUnits(sql, id) === null)).toBe(true)
			expect(storedSearchableText(db, ids[0]!, NOW_ISO)!.indexOf('needle')).toBe(9_798)
			const visible = ids as VisibleStatusId[]
			const shared = presentation(db, visible, options(alice.id))
			expect(shared.level).toBe(Math.floor(MAX_FILTER_REQUEST_TEXT / 41))
			const items = presentStatusesWithin(db, shared, visible, ANSWER_BYTES, true).items
			expect(items).toHaveLength(41)
			expect(matchedCount(items)).toBe(0)
		})
	}, 60_000)

	it('charges each cut once when it is fixed, so figures below the texts never pass the allowance', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await filterFor(h, alice, 'needle', false)
		await inStore(h.store, (db, sql) => {
			const long = `needle${'x'.repeat(9_992)}`
			const exact = writeLocal(
				db,
				sql,
				bob.id,
				Array.from({ length: 39 }, () => long)
			)
			// Three statuses stored with 0 (an imported undercount) whose text is 10,002 units.
			const under = writeLocal(
				db,
				sql,
				bob.id,
				Array.from({ length: 3 }, () => long)
			)
			for (const id of under) {
				sql.exec('UPDATE statuses SET filter_text_units = 0 WHERE id = ?', id)
			}
			expect(storedSearchableText(db, under[0]!, NOW_ISO)!.length).toBe(10_002)
			const visible = [...exact, ...under] as VisibleStatusId[]
			const shared = presentation(db, visible, options(alice.id))
			expect(shared.level).toBe(Infinity)
			// Chunks of 39 and 3: the first chunk is charged before the second is read.
			const stream = statusStream(db, shared, visible, 39)
			const first = Array.from({ length: 39 }, () => stream.next().value)
			expect(shared.matched.units).toBe(390_000)
			expect(shared.cuts.size).toBe(39)
			const rest = [...stream]
			expect(rest).toHaveLength(3)
			expect(under.map((id) => shared.cuts.get(id))).toEqual([10_000, 0, 0])
			expect(shared.matched.units).toBe(MAX_FILTER_REQUEST_TEXT)
			expect(matchedCount([...first, ...rest])).toBe(40)
		})
	}, 60_000)

	it('reuses the cut of a quoted status prepared in an earlier chunk and not presented there', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await filterFor(h, alice, 'needle')
		const ids = await inStore(h.store, (db, sql) =>
			writeLocal(db, sql, bob.id, ['first', 'quoting needle', 'quoted needle text', 'again quoting'])
		)
		const [x, a, q, c] = ids as [string, string, string, string]
		await acceptQuote(h, a, q)
		await acceptQuote(h, c, q)
		await inStore(h.store, (db) => {
			const length = (id: string) => storedSearchableText(db, id, NOW_ISO)!.length
			const shared = presentation(db, [x, a, c] as VisibleStatusId[], options(alice.id))
			// The first chunk [x, a] prepares a and its quoted q; only x is read from it.
			const stream = statusStream(db, shared, [x, a] as VisibleStatusId[], 2)
			expect(stream.next().value?.id).toBe(x)
			expect(shared.quoted.has(q)).toBe(false)
			expect(shared.cuts.get(`quoted:${q}`)).toBe(length(q))
			// c, through another chunk, prepares q again.
			const [shown] = presentStatusesWithin(db, shared, [c] as VisibleStatusId[], ANSWER_BYTES, true).items
			expect(shared.quoted.has(q)).toBe(true)
			expect(shown?.quote).toMatchObject({ quoted_status: { id: q } })
			expect(shared.matched.units).toBe(length(x) + length(a) + length(q) + length(c))
		})
	})

	it('prepares only keys among the level’s targets, and matches chunked answers as whole ones (property I)', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const carol = await remoteAccount(h.store, 'carol')
		await filterFor(h, alice, 'needle', false)
		// 30 originals of 10,000 units with a needle at increasing depths, 10 boosts of them and 10 statuses quoting them
		// (some quoted twice): up to 60 targets, past what the allowance holds whole.
		const world = await inStore(h.store, (db, sql) => {
			const originals = writeLocal(
				db,
				sql,
				bob.id,
				Array.from({ length: 30 }, (_, i) => `${'x'.repeat(300 * i)}needle${'y'.repeat(9_992 - 300 * i)}`)
			)
			const boosts = originals.slice(0, 10).map((original) => {
				const id = nextStatusId()
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at)
					VALUES (?1, 'https://remote.example/boosts/' || ?1, ?2, ?3, 'public', ?4)`,
					id,
					carol,
					original,
					NOW_ISO
				)
				return id
			})
			const quoting = writeLocal(
				db,
				sql,
				bob.id,
				Array.from({ length: 10 }, (_, i) => `quoting ${i} ${'z'.repeat(9_000)}`)
			)
			return { originals, boosts, quoting }
		})
		for (const [i, id] of world.quoting.entries()) {
			await acceptQuote(h, id, world.originals[(i * 7) % 15]!)
		}
		const all = [...world.originals, ...world.boosts, ...world.quoting]
		await inStore(h.store, (db) => {
			const opts = options(alice.id)
			fc.assert(
				fc.property(
					fc.shuffledSubarray(all, { minLength: 1 }),
					fc.integer({ min: 1, max: 6 }),
					fc.nat(),
					(candidates, chunk, again) => {
						const visible = candidates as VisibleStatusId[]
						const shared = presentation(db, visible, opts)
						const chunked = presentStatusesWithin(db, shared, visible, Infinity, true, chunk).items
						// A re-admission pass presents a prefix again under the same presentation.
						const prefix = visible.slice(0, (again % visible.length) + 1)
						const repeated = presentStatusesWithin(db, shared, prefix, Infinity, true, chunk).items
						const keys = new Set(filterTextTargets(db, visible, opts).map((target) => target.key))
						expect([...shared.cuts.keys()].filter((key) => !keys.has(key))).toEqual([])
						expect(shared.matched.units).toBeLessThanOrEqual(MAX_FILTER_REQUEST_TEXT)
						const whole = presentStatusesWithin(
							db,
							presentation(db, visible, opts),
							visible,
							Infinity,
							true,
							visible.length
						).items
						expect(chunked).toEqual(whole)
						expect(repeated).toEqual(whole.slice(0, prefix.length))
					}
				),
				{ numRuns: 40 }
			)
		})
	}, 300_000)
})

// ---- Reads of the level pass

describe('the level pass reads figures, never text (RES-3)', () => {
	it('reads no text of 100 targets at the stored content bound, measured or not', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await filterFor(h, alice, 'needle')
		// The largest content and source 0048 keeps as raw ASCII: 131,072 JSON bytes less the quotes.
		const big = 'x'.repeat(131_070)
		for (const measured of [false, true]) {
			await inStore(h.store, (db, real) => {
				const ids = Array.from({ length: 100 }, () =>
					writeFixture(real, bob.id, { spoiler: '', content: big, source: big, poll: null, media: [] }, false)
				)
				if (measured) {
					ids.forEach((id) => measureFilterText(db, id, NOW_ISO))
				}
				const reads: { query: string; rows: readonly SqlRow[] }[] = []
				const observed = new Db(observedSql(real, (rows, query) => reads.push({ query, rows })))
				const shared = presentation(observed, ids as VisibleStatusId[], options(alice.id))
				expect(shared.level).toBe(Math.floor(MAX_FILTER_REQUEST_TEXT / 100))
				const level = reads.filter((read) => read.query === FILTER_TEXT_UNITS_SQL)
				expect(level).toHaveLength(1)
				expect(level[0]!.rows).toHaveLength(100)
				expect(level[0]!.rows.every((row) => row.units === MAX_FILTER_TEXT)).toBe(true)
				expect(Math.max(...reads.map((read) => longestString(read.rows)))).toBeLessThanOrEqual(64)
				const bytes = level[0]!.rows.reduce((sum, row) => sum + JSON.stringify(row).length, 0)
				expect(bytes).toBeLessThanOrEqual(100 * 64)
			})
		}
	}, 120_000)

	it('seeks each target by key with stale statistics, within the rows its inputs at their caps read (RES-7)', async () => {
		const h = await community(['alice', 'bob'])
		const { bob } = h.users
		await inStore(h.store, (_db, real) => {
			writeLocal(
				new Db(real),
				real,
				bob.id,
				Array.from({ length: 10 }, () => 'small'),
				false
			)
			real.exec('ANALYZE')
			real.exec("UPDATE sqlite_stat1 SET stat = '1 1' WHERE tbl = 'statuses'")
			real.exec('ANALYZE sqlite_schema')
			real.exec(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000)
				INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				SELECT printf('7%017d', i), 'https://kopje.test/ap/o/g' || i, ?1, 'public', '', ?2 FROM n`,
				bob.id,
				NOW_ISO
			)
		})
		// 100 unmeasured targets, each with every input at its cap: a poll of 100 choices (the schema's most) and 4
		// shown media (MAX_STATUS_MEDIA), with 4 unshown ones after them.
		const targets = await inStore(h.store, (_db, real) =>
			Array.from({ length: 100 }, () => {
				const choices = `[${Array.from({ length: 100 }, (_, i) => `"c${i}"`).join(',')}]`
				const id = writeFixture(
					real,
					bob.id,
					{
						spoiler: '',
						content: '<p>a</p>',
						source: 'a',
						poll: choices,
						media: ['d', 'd', 'd', 'd', 'h', 'h', 'h', 'h'],
					},
					false
				)
				real.exec('UPDATE media_attachments SET shown = 0 WHERE status_id = ? AND description = ?', id, 'h')
				return id
			})
		)
		await inStore(h.store, (_db, real) => {
			const plan = real
				.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${FILTER_TEXT_UNITS_SQL}`, JSON.stringify(targets))
				.toArray()
				.map((row) => row.detail)
			expect(plan).toContain('SEARCH s USING INDEX sqlite_autoindex_statuses_1 (id=?)')
			expect(plan.filter((detail) => /^SCAN (?!j\b)/.test(detail) && !detail.includes('VIRTUAL TABLE'))).toEqual([])
			expect(plan.some((detail) => detail.includes('sqlite_autoindex_polls_1'))).toBe(true)
			expect(
				real.exec("SELECT count(*) AS n FROM sqlite_stat1 WHERE tbl = 'statuses' AND stat = '1 1'").one().n
			).toBeGreaterThan(0)
			const read = () => {
				const cursor = real.exec<{ units: number }>(FILTER_TEXT_UNITS_SQL, JSON.stringify(targets))
				const rows = cursor.toArray()
				expect(rows).toHaveLength(100)
				return { rows, read: cursor.rowsRead }
			}
			// Per unmeasured target with every input at its cap, 128 rows as workerd counts them: its json_each row and
			// status, then twice (the odd-input check, then the bound) its poll with its 100 choices (json_each rows) and
			// its 4 shown media through media_attachments_status (status_id, shown) and by key; unshown media are not
			// walked. A measured target reads its json_each row and status only.
			const unmeasured = read()
			expect(unmeasured.rows.map((row) => row.units)).toEqual(targets.map((id) => boundOf(real, id)))
			expect(unmeasured.read).toBeLessThanOrEqual(100 * 128)
			real.exec(
				'UPDATE statuses SET filter_text_units = 1 WHERE id IN (SELECT value FROM json_each(?))',
				JSON.stringify(targets)
			)
			expect(read().read).toBeLessThanOrEqual(100 * 2)
		})
	}, 120_000)
})

// ---- Converted rows

describe('a cutover-converted status', () => {
	it('is unmeasured, and its level reads a bound at least its searchable text', async () => {
		const { dump } = inject('cutover')
		const h = await apiHarness()
		await setAccess(h.store, { access_team_domain: h.team.teamDomain })
		const authority = {
			kind: 'access',
			email: ADMIN_EMAIL,
			commonName: null,
			teamDomain: h.team.teamDomain,
			aud: ADMIN_AUD,
		} as const
		await importViaRpc(h.store, dump, 16 * 1024, authority)
		await h.store.publish(BUILD, authority)
		await inStore(h.store, (db, sql) => {
			const ids = sql
				.exec<{ id: string }>('SELECT id FROM statuses WHERE reblog_of_id IS NULL ORDER BY id')
				.toArray()
				.map((row) => row.id)
			expect(ids.length).toBeGreaterThan(5)
			expect(sql.exec('SELECT count(*) AS n FROM statuses WHERE filter_text_units IS NOT NULL').one().n).toBe(0)
			const units = new Map(
				sql
					.exec<{ id: string; units: number }>(FILTER_TEXT_UNITS_SQL, JSON.stringify(ids))
					.toArray()
					.map((row) => [row.id, row.units])
			)
			for (const id of ids) {
				expect(units.get(id), id).toBe(Math.min(boundOf(sql, id), MAX_FILTER_TEXT))
				expect(units.get(id), id).toBeGreaterThanOrEqual(presenterUnits(db, id)!)
				expect(presenterUnits(db, id), id).toBeGreaterThan(0)
			}
		})
	})
})

// ---- W: the measure at each writer's reachable maxima

type Components = { spoiler: string; text: string; poll: string[] | null; media: string[] }

// The segments searchableText joins, from the stored rows: the spoiler text, the text (a local status's source, a
// remote one's HTML as text), the poll's choices as the presenter reads them (pollOptionsSql), the shown descriptions.
function components(db: Db, id: string): Components {
	const row = db.first<{ spoiler: string; content: string; source: string | null; remote: number }>(
		`SELECT s.spoiler_text AS spoiler, s.content, s.source_text AS source, a.domain IS NOT NULL AS remote
		FROM statuses s JOIN accounts a ON a.id = s.account_id WHERE s.id = ?`,
		id
	)!
	const poll = db.first<{ options: string }>(
		`SELECT ${pollOptionsSql('options')} AS options FROM polls WHERE status_id = ? AND removed = 0`,
		id
	)
	const media = db
		.all<{ description: string }>(
			'SELECT description FROM media_attachments WHERE status_id = ? AND shown = 1 ORDER BY position LIMIT 4',
			id
		)
		.map((m) => m.description)
	return {
		spoiler: row.spoiler,
		text: row.remote === 1 ? remotePlainText(row.content) : (row.source ?? htmlToPlainText(row.content)),
		poll: poll === undefined ? null : (JSON.parse(poll.options) as string[]),
		media,
	}
}

function expectWitness(db: Db, sql: SqlStorage, id: string, sizes: Record<string, number>) {
	const c = components(db, id)
	const pollUnits = c.poll === null ? 0 : 2 + c.poll.reduce((sum, t) => sum + t.length, 0) + 2 * (c.poll.length - 1)
	const mediaUnits = c.media.reduce((sum, d) => sum + d.length, 0) + 2 * Math.max(c.media.length - 1, 0)
	const total = c.spoiler.length + 2 + c.text.length + pollUnits + 2 + mediaUnits
	expect(storedSearchableText(db, id, NOW_ISO)!.length).toBe(total)
	expect(storedUnits(sql, id)).toBe(Math.min(total, MAX_FILTER_TEXT))
	expect({
		spoiler: c.spoiler.length,
		text: c.text.length,
		choices: c.poll?.length ?? 0,
		choiceUnits: c.poll?.reduce((sum, t) => sum + t.length, 0) ?? 0,
		media: c.media.length,
		mediaUnits: c.media.reduce((sum, d) => sum + d.length, 0),
	}).toEqual(sizes)
	return total
}

// The elapsed ms of `run`, read across awaits (workerd's clock moves only between I/O events).
async function elapsed(run: () => Promise<unknown>): Promise<number> {
	const start = Date.now()
	await run()
	return Date.now() - start
}

// The measure alone, again over the stored row: what the operation spends on it.
async function measureMs(store: StoreStub, id: string): Promise<number> {
	return elapsed(() => inStore(store, (db) => measureFilterText(db, id, NOW_ISO)))
}

// Text and content warning at MAX_RAW_LENGTH together (10,000 code units), in 500 grapheme clusters as the counted
// length allows: astral and entity-spelled bases with combining marks.
const LOCAL_SPOILER = `a${'́'.repeat(19)}`.repeat(100)
const LOCAL_TEXT = `\u{1f600}${'́'.repeat(18)}&${'́'.repeat(19)}<${'́'.repeat(19)}`.repeat(133) + `&${'́'.repeat(19)}`
// Four choices of 50 grapheme clusters each, 81,500 code units and 162,950 UTF-8 bytes each, together within the
// 655,360 bytes of polls.options; the presenter reads each cut at 1,000.
const LOCAL_CHOICES = ['a', 'b', 'c', 'd'].map((base) => `${base}${'́'.repeat(1_629)}`.repeat(50))
// Descriptions at 0048's stored bound (10,000 code points), astral: 20,000 code units and 40,000 bytes each.
const DESCRIPTION_MAX = '\u{1f600}'.repeat(10_000)
// Raw remote HTML at REMOTE_HTML_RAW_LIMIT, dense in line breaks, paragraph ends and entities.
const REMOTE_HTML = `<p>${'a&amp;b<br><br>&lt;&#39;</p><p>'.repeat(50_000 / 32)}</p>`.slice(0, 50_000)
const REMOTE_SPOILER = 'w'.repeat(10_000)
const REMOTE_CHOICES = Array.from({ length: 100 }, (_, i) => `${String(i).padStart(3, '0')}${'é'.repeat(997)}`)

// The measure at these maxima took 2 to 10 ms locally (operations 14 to 38 ms) at a load average of about 10; the
// ceiling leaves room for a busy runner and still fails on a measure that grows with more than its stored inputs.
const CEILING_MS = 1_000

describe('W: the measure at each writer’s reachable maxima', () => {
	it('local posts and edits, with media and with a poll', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		expect(LOCAL_SPOILER.length + LOCAL_TEXT.length).toBe(10_000)
		const timings: Record<string, { op: number; measure: number }> = {}
		const postAt = async (name: string, body: Record<string, unknown>) => {
			let id = ''
			const op = await elapsed(async () => (id = (await post(h, alice, body)).id))
			timings[name] = { op, measure: await measureMs(h.store, id) }
			return id
		}
		const editAt = async (name: string, id: string, body: Record<string, unknown>) => {
			const op = await elapsed(async () => {
				const response = await h.request(`/api/v1/statuses/${id}`, bearer(alice.token, json(body, { method: 'PUT' })))
				expect(response.status, await response.clone().text()).toBe(200)
			})
			timings[name] = { op, measure: await measureMs(h.store, id) }
		}
		const media = () =>
			importedMedia(
				h.store,
				alice.id,
				Array.from({ length: 4 }, () => DESCRIPTION_MAX)
			)
		const withMedia = await postAt('post, media', {
			status: LOCAL_TEXT,
			spoiler_text: LOCAL_SPOILER,
			media_ids: await media(),
		})
		const withPoll = await postAt('post, poll', {
			status: LOCAL_TEXT,
			spoiler_text: LOCAL_SPOILER,
			poll: { options: LOCAL_CHOICES, expires_in: 3600 },
		})
		const minimalMedia = (await post(h, alice, { status: 'm' })).id
		const minimalPoll = (await post(h, alice, { status: 'p' })).id
		await editAt('edit, media', minimalMedia, {
			status: LOCAL_TEXT,
			spoiler_text: LOCAL_SPOILER,
			media_ids: await media(),
		})
		await editAt('edit, poll', minimalPoll, {
			status: LOCAL_TEXT,
			spoiler_text: LOCAL_SPOILER,
			poll: { options: LOCAL_CHOICES, expires_in: 3600 },
		})
		await inStore(h.store, (db, sql) => {
			const mediaSizes = {
				spoiler: 2_000,
				text: 8_000,
				choices: 0,
				choiceUnits: 0,
				media: 4,
				mediaUnits: 80_000,
			}
			const pollSizes = { ...mediaSizes, choices: 4, choiceUnits: 4_000, media: 0, mediaUnits: 0 }
			for (const id of [withMedia, minimalMedia]) {
				expect(expectWitness(db, sql, id, mediaSizes)).toBe(2_000 + 2 + 8_000 + 2 + 80_000 + 6)
			}
			for (const id of [withPoll, minimalPoll]) {
				expect(expectWitness(db, sql, id, pollSizes)).toBe(2_000 + 2 + 8_000 + 2 + 4_000 + 6 + 2)
				expect(sql.exec('SELECT length(CAST(options AS BLOB)) AS n FROM polls WHERE status_id = ?', id).one().n).toBe(
					4 * (162_950 + 2) + 5
				)
			}
		})
		console.log(JSON.stringify({ witness: 'W local', timings }))
		for (const { measure } of Object.values(timings)) {
			expect(measure).toBeLessThan(CEILING_MS)
		}
	}, 120_000)

	it('a remote create and update with text, poll and media at their maxima', async () => {
		const h = await community(['alice'])
		const carol = await remoteAccount(h.store, 'carol')
		const maximal = (n: number, extra: Record<string, unknown> = {}) =>
			question(n, REMOTE_CHOICES, {
				content: REMOTE_HTML,
				summary: REMOTE_SPOILER,
				attachment: attachments(Array.from({ length: 4 }, () => DESCRIPTION_MAX)),
				...extra,
			})
		const timings: Record<string, { op: number; measure: number }> = {}
		let created = ''
		timings.create = {
			op: await elapsed(() => inStore(h.store, (db) => (created = storeNote(db, carol, maximal(1))))),
			measure: 0,
		}
		timings.create.measure = await measureMs(h.store, created)
		const minimal = await inStore(h.store, (db) => storeNote(db, carol, note(2)))
		timings.update = {
			op: await elapsed(() =>
				inStore(h.store, (db) => updateNote(db, carol, maximal(2, { updated: '2026-10-11T23:30:00Z' })))
			),
			measure: await measureMs(h.store, minimal),
		}
		await inStore(h.store, (db, sql) => {
			for (const id of [created, minimal]) {
				const stored = sql
					.exec<{ content: number; spoiler: number }>(
						'SELECT length(CAST(content AS BLOB)) AS content, length(spoiler_text) AS spoiler FROM statuses WHERE id = ?',
						id
					)
					.one()
				expect(stored.spoiler).toBe(10_000)
				expect(stored.content).toBeGreaterThan(40_000)
				const c = components(db, id)
				const total = expectWitness(db, sql, id, {
					spoiler: 10_000,
					text: c.text.length,
					choices: 100,
					choiceUnits: 100_000,
					media: 4,
					mediaUnits: 80_000,
				})
				expect(total).toBe(10_000 + 2 + c.text.length + 2 + 100_000 + 198 + 2 + 80_000 + 6)
				// sanitize-html's text of the line breaks, paragraphs and entities: about 7 units per 31 bytes of HTML.
				expect(c.text.length).toBeGreaterThan(10_000)
			}
		})
		console.log(JSON.stringify({ witness: 'W remote', timings }))
		for (const { measure } of Object.values(timings)) {
			expect(measure).toBeLessThan(CEILING_MS)
		}
	}, 120_000)
})
