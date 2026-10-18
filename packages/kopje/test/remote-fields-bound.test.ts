import { describe, expect, it } from 'vitest'

import { seedFollows, sql } from './api-helpers'
import { ALICE, setup, type Setup } from './inbox-status-helpers'
import {
	ACCOUNT_COLUMNS,
	ACCOUNT_FROM,
	type Field,
	MAX_REMOTE_FIELDS,
	REMOTE_FIELDS_BYTES,
} from '../src/domain/accounts'
import { ANSWER_BYTES } from '../src/domain/answer-budget'
import { MAX_LIST_MEMBERS_ANSWERED } from '../src/domain/lists'
import { utf8Length } from '../src/platform/dump-format'
import { sanitizeRemoteHtml } from '../src/security/html'

// A remote account's profile fields are projected bounded (REMOTE_ATTACHMENT_SQL): a row carries at most what the
// presenter shows, whatever the size of the stored actor document (RES-2), and shows the same fields as the whole
// attachment does.

const DOMAIN = 'fields.example'
// A field at both character limits that escapes to six bytes a character in JSON: the projection's worst case.
const ESCAPED = { type: 'PropertyValue', name: '\u0001'.repeat(255), value: '\u0001'.repeat(4096) }

const field = (name: string, value: string) => ({ type: 'PropertyValue', name, value })
// Fields within every input bound whose values sanitizing grows fivefold (`&` to `&amp;`): the output's worst case.
const AMPERSANDS = Array.from({ length: MAX_REMOTE_FIELDS }, () => field('n'.repeat(255), '&'.repeat(4096)))

// The bytes of a presented account's field names and values once serialized as JSON: what remoteFields bounds.
const fieldBytes = (fields: readonly { name: string; value: string }[]) =>
	fields.reduce((sum, f) => sum + utf8Length(JSON.stringify(f.name)) + utf8Length(JSON.stringify(f.value)), 0)

async function remoteFollowers(t: Setup, count: number): Promise<string[]> {
	await seedFollows(t.store, ALICE, count, { direction: 'followers', domain: DOMAIN, base: 500_000 })
	const rows = await sql<{ id: string }>(t.store, 'SELECT id FROM accounts WHERE domain = ? ORDER BY id', DOMAIN)
	return rows.map((row) => row.id)
}

async function storeAttachment(t: Setup, ids: readonly string[], attachment: unknown): Promise<void> {
	await sql(
		t.store,
		'UPDATE accounts SET raw = ?1 WHERE id IN (SELECT value FROM json_each(?2))',
		JSON.stringify({ type: 'Person', attachment }),
		JSON.stringify(ids)
	)
}

// The projected attachment of each account, and its length in UTF-8 bytes.
async function projected(t: Setup, ids: readonly string[]): Promise<{ attachment: string; bytes: number }[]> {
	return sql<{ attachment: string; bytes: number }>(
		t.store,
		`SELECT attachment, length(CAST(attachment AS BLOB)) AS bytes FROM (SELECT ${ACCOUNT_COLUMNS} FROM ${ACCOUNT_FROM}
			WHERE a.id IN (SELECT value FROM json_each(?))) ORDER BY id`,
		JSON.stringify(ids)
	)
}

// The fields as the presenter showed them from the whole stored attachment, before the projection was bounded.
function wholeFields(attachment: string | null): Field[] {
	const parsed = attachment === null ? [] : (JSON.parse(attachment) as unknown)
	const fields: Field[] = []
	for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
		if (fields.length >= MAX_REMOTE_FIELDS) {
			break
		}
		if (typeof entry !== 'object' || entry === null) {
			continue
		}
		const { type, name, value } = entry as Record<string, unknown>
		const types = Array.isArray(type) ? type : [type]
		if (!types.includes('PropertyValue') || typeof name !== 'string' || typeof value !== 'string') {
			continue
		}
		fields.push({ name: name.slice(0, 255), value: sanitizeRemoteHtml(value.slice(0, 4096)), verified_at: null })
	}
	return fields
}

// The account's fields as the API shows them from the bounded projection, and from the whole attachment.
async function bothWays(t: Setup, id: string): Promise<{ bounded: Field[]; whole: Field[] }> {
	const [row] = await sql<{ whole: string | null }>(
		t.store,
		"SELECT raw -> '$.attachment' AS whole FROM accounts WHERE id = ?",
		id
	)
	const { body } = await t.api<{ fields: Field[] }>(`/api/v1/accounts/${id}`)
	return { bounded: body.fields, whole: wholeFields(row!.whole) }
}

describe('remote profile fields are projected bounded (RES-2)', () => {
	it('reads one account and a page of 80 with a 1.5 MiB attachment within the budget', async () => {
		const t = await setup()
		const ids = await remoteFollowers(t, 80)
		const huge = 'x'.repeat(512 * 1024)
		// Thousands of fields for half, a few huge values for the other half; each document is about 1.5 MiB.
		const many = Array.from({ length: 9_000 }, (_, i) => field(`name-${i}-${'n'.repeat(160)}`, 'v'))
		await storeAttachment(t, ids.slice(0, 40), many)
		await storeAttachment(t, ids.slice(40), [field(huge, huge), field('b', huge), field('c', huge)])
		const [raw] = await sql<{ size: number }>(
			t.store,
			'SELECT max(length(raw)) AS size FROM accounts WHERE domain = ?',
			DOMAIN
		)
		expect(raw!.size).toBeGreaterThan(1.5 * 1024 * 1024)

		const one = await t.api<{ fields: { name: string; value: string }[] }>(`/api/v1/accounts/${ids[0]}`)
		expect(one.body.fields).toHaveLength(MAX_REMOTE_FIELDS)
		const page = await t.api<{ fields: { name: string; value: string }[] }[]>(
			`/api/v1/accounts/${ALICE}/followers?limit=80`
		)
		expect(page.body).toHaveLength(80)
		expect(page.body.map((account) => account.fields.length).sort((x, y) => x - y)).toEqual([
			...Array.from({ length: 40 }, () => 3),
			...Array.from({ length: 40 }, () => MAX_REMOTE_FIELDS),
		])

		const rows = await projected(t, ids)
		expect(rows).toHaveLength(80)
		for (const row of rows) {
			expect(row.bytes).toBeLessThanOrEqual(REMOTE_FIELDS_BYTES)
		}
		// The huge values are cut to 255 and 4,096 characters before they leave SQLite.
		const [cut] = JSON.parse(rows.find((row) => row.attachment.includes('"b"'))!.attachment) as {
			name: string
			value: string
		}[]
		expect([cut!.name.length, cut!.value.length]).toEqual([255, 4096])
	})

	it('keeps the escaped worst case within the budget, for one account and for a page', async () => {
		const t = await setup()
		const ids = await remoteFollowers(t, 80)
		await storeAttachment(
			t,
			ids,
			Array.from({ length: MAX_REMOTE_FIELDS }, () => ESCAPED)
		)
		const rows = await projected(t, ids)
		for (const row of rows) {
			expect(row.bytes).toBeLessThanOrEqual(REMOTE_FIELDS_BYTES)
		}
		// One such entry is 26,127 bytes of JSON, so only the first fits.
		expect(JSON.parse(rows[0]!.attachment)).toEqual([{ name: ESCAPED.name, value: ESCAPED.value }])
		const page = await t.api<{ fields: { name: string }[] }[]>(`/api/v1/accounts/${ALICE}/followers?limit=80`)
		expect(page.body.map((account) => account.fields.length)).toEqual(Array.from({ length: 80 }, () => 1))
	})

	it('keeps the leading fields that fit the budget, in document order', async () => {
		const t = await setup()
		const [id] = await remoteFollowers(t, 1)
		// Each entry is 4,372 bytes of JSON: seven make 30,612 bytes, eight 34,985.
		const fields = Array.from({ length: MAX_REMOTE_FIELDS }, (_, i) => field(`${i}`.padEnd(255, 'n'), 'v'.repeat(4096)))
		await storeAttachment(t, [id!], fields)
		const { bounded, whole } = await bothWays(t, id!)
		expect(bounded).toEqual(whole.slice(0, 7))
	})

	it('bounds the shown fields after sanitizing, dropping whole fields', async () => {
		const t = await setup()
		const [id] = await remoteFollowers(t, 1)
		await storeAttachment(t, [id!], AMPERSANDS)
		// The read keeps seven fields (30,619 bytes); sanitized, one is 20,739 bytes and two would pass the budget.
		expect(JSON.parse((await projected(t, [id!]))[0]!.attachment)).toHaveLength(7)
		const { bounded, whole } = await bothWays(t, id!)
		expect(bounded).toEqual(whole.slice(0, 1))
		expect(bounded[0]!.value).toBe('&amp;'.repeat(4096))
		expect(fieldBytes(bounded)).toBeLessThanOrEqual(REMOTE_FIELDS_BYTES)
	})

	it(`answers a list of ${MAX_LIST_MEMBERS_ANSWERED} such members within the answer's bytes, 32 KiB of fields each`, async () => {
		const t = await setup()
		const ids = await remoteFollowers(t, MAX_LIST_MEMBERS_ANSWERED)
		await storeAttachment(t, ids, AMPERSANDS)
		const list = '800000000000000001'
		await sql(t.store, "INSERT INTO lists (id, account_id, title) VALUES (?, ?, 'l')", list, ALICE)
		await sql(
			t.store,
			'INSERT INTO list_accounts (list_id, account_id) SELECT ?, value FROM json_each(?)',
			list,
			JSON.stringify(ids)
		)
		const response = await t.request(`/api/v1/lists/${list}/accounts?limit=0`, {
			headers: { authorization: `Bearer ${t.tokens.alice}` },
		})
		const body = await response.text()
		const accounts = JSON.parse(body) as { fields: { name: string; value: string }[] }[]
		// Each member counts its seven projected fields, about 30 KiB, so the answer stops short and links on (RES-3).
		expect(accounts.length).toBeGreaterThan(200)
		expect(accounts.length).toBeLessThan(MAX_LIST_MEMBERS_ANSWERED)
		expect(response.headers.get('link')).toContain('rel="next"')
		for (const account of accounts) {
			expect(account.fields).toHaveLength(1)
			expect(fieldBytes(account.fields)).toBeLessThanOrEqual(REMOTE_FIELDS_BYTES)
		}
		expect(utf8Length(body)).toBeLessThanOrEqual(ANSWER_BYTES)
	})

	it('shows the same fields for 20 and 300 such fields, a 1.3 MB document', async () => {
		const t = await setup()
		const [small, large] = await remoteFollowers(t, 2)
		await storeAttachment(
			t,
			[small!],
			Array.from({ length: 20 }, () => AMPERSANDS[0])
		)
		await storeAttachment(
			t,
			[large!],
			Array.from({ length: 300 }, () => AMPERSANDS[0])
		)
		const [a, b] = [await bothWays(t, small!), await bothWays(t, large!)]
		expect(a.bounded).toEqual(b.bounded)
		expect(a.bounded).toHaveLength(1)
	})

	it('projects the same bytes for 20 and 20,000 fields, and for 20 and 2,000 escaped ones', async () => {
		const t = await setup()
		const [small, large, escapedSmall, escapedLarge] = await remoteFollowers(t, 4)
		const fields = (count: number) => Array.from({ length: count }, (_, i) => field(`f${i % 10}`, `<p>v${i % 10}</p>`))
		// 2,751 bytes of JSON each, so the byte budget binds before MAX_REMOTE_FIELDS: eleven fit.
		const escaped = (count: number) =>
			Array.from({ length: count }, () => field('\u0001'.repeat(255), '\u0001'.repeat(200)))
		await storeAttachment(t, [small!], fields(20))
		await storeAttachment(t, [large!], fields(20_000))
		await storeAttachment(t, [escapedSmall!], escaped(20))
		await storeAttachment(t, [escapedLarge!], escaped(2_000))
		const [a, b, c, d] = await projected(t, [small!, large!, escapedSmall!, escapedLarge!])
		expect(a!.attachment).toBe(b!.attachment)
		expect(c!.attachment).toBe(d!.attachment)
		expect(JSON.parse(d!.attachment)).toHaveLength(11)
		expect(d!.bytes).toBeLessThanOrEqual(REMOTE_FIELDS_BYTES)
	})

	it('shows a normal actor’s fields as Mastodon does, and as the whole attachment does', async () => {
		const t = await setup()
		const [id, full] = await remoteFollowers(t, 2)
		await storeAttachment(
			t,
			[id!],
			[
				field('Site', '<a href="https://example.com" rel="me">example.com</a>'),
				field('Pronouns', 'they/them'),
				field('Quote "x" \\ ü 🦬', '<p>a\nb</p>'),
				{ type: 'IdentityProof', name: 'skip', signatureValue: 'x' },
			]
		)
		// A Mastodon profile at its local limits: four fields of 255 characters, the values rendered with links.
		const link = (i: number) =>
			`<a href="https://example.com/${i}" target="_blank" rel="nofollow noopener me" translate="no">` +
			`<span class="invisible">https://</span><span class="">example.com/${i}</span><span class="invisible"></span></a>`
		await storeAttachment(
			t,
			[full!],
			Array.from({ length: 4 }, (_, i) => field('ü'.repeat(255), Array.from({ length: 10 }, () => link(i)).join(' ')))
		)
		const shown = await t.api<{ fields: unknown[] }>(`/api/v1/accounts/${id}`)
		expect(shown.body.fields).toEqual([
			{
				name: 'Site',
				value: '<a href="https://example.com" rel="nofollow noopener" target="_blank">example.com</a>',
				verified_at: null,
			},
			{ name: 'Pronouns', value: 'they/them', verified_at: null },
			{ name: 'Quote "x" \\ ü 🦬', value: '<p>a\nb</p>', verified_at: null },
		])
		const normal = await bothWays(t, id!)
		expect(normal.bounded).toEqual(shown.body.fields)
		expect(normal.bounded).toEqual(normal.whole)
		const atLimits = await bothWays(t, full!)
		expect(atLimits.bounded).toHaveLength(4)
		expect(atLimits.bounded).toEqual(atLimits.whole)
	})

	it('cuts at the limits as the presenter does, and keeps its filters', async () => {
		const t = await setup()
		const ids = await remoteFollowers(t, 7)
		const astral = '🦬'.repeat(300)
		let deep: unknown = 'PropertyValue'
		for (let i = 0; i < 30; i++) {
			deep = [deep]
		}
		const cases: unknown[] = [
			// More than MAX_REMOTE_FIELDS.
			Array.from({ length: MAX_REMOTE_FIELDS + 4 }, (_, i) => field(`f${i}`, `v${i}`)),
			// Names and values at and past the limits; astral characters (SQLite counts code points, JavaScript code
			// units).
			[
				...[-1, 0, 1].map((d) => field('n'.repeat(255 + d), 'v'.repeat(4096 + d))),
				field(astral, astral),
				field('a', '🦬'.repeat(4096)),
			],
			// One object rather than a list.
			field('Only', 'one'),
			// type as a list, as an object, missing; non-string names and values; non-object and deep entries.
			[
				{ type: ['PropertyValue', 'Other'], name: 'listed', value: 'yes' },
				{ type: { x: 'PropertyValue' }, name: 'object type', value: 'no' },
				{ type: [['PropertyValue']], name: 'nested type', value: 'no' },
				{ type: deep, name: 'deep type', value: 'no' },
				{ type: 'PropertyValue', name: deep, value: 'no' },
				{ name: 'untyped', value: 'no' },
				{ type: 'PropertyValue', name: 1, value: 'no' },
				{ type: 'PropertyValue', name: 'no value' },
				{ type: 'PropertyValue', name: 'null value', value: null },
				['PropertyValue', 'n', 'v'],
				deep,
				'PropertyValue',
				null,
				field('', ''),
			],
			// A deep attachment, no attachment at all, and an empty one.
			deep,
			undefined,
			[],
		]
		for (const [i, attachment] of cases.entries()) {
			await storeAttachment(t, [ids[i]!], attachment)
		}
		const results = await Promise.all(ids.map((id) => bothWays(t, id)))
		for (const { bounded, whole } of results) {
			expect(bounded).toEqual(whole)
		}
		expect(results[0]!.bounded.map((f) => f.name)).toEqual(Array.from({ length: MAX_REMOTE_FIELDS }, (_, i) => `f${i}`))
		expect(results[1]!.bounded.map((f) => [f.name.length, f.value.length])).toEqual([
			[254, 4095],
			[255, 4096],
			[255, 4096],
			[255, 600],
			[1, 4096],
		])
		expect(results[2]!.bounded.map((f) => f.name)).toEqual(['Only'])
		expect(results[3]!.bounded.map((f) => f.name)).toEqual(['listed', ''])
		for (const empty of results.slice(4)) {
			expect(empty.bounded).toEqual([])
		}
	})

	it('keeps a string with a NUL whole while its bytes fit the limit, and only ever shorter past it', async () => {
		const t = await setup()
		const [within, past] = await remoteFollowers(t, 2)
		await storeAttachment(
			t,
			[within!],
			[field('A\u0000B', 'ok'), field('name', 'x\u0000y\u0000'), field('\u0000', '\u0000')]
		)
		// Past the byte limits: a 102-character name of 302 bytes, and an ASCII value past 4,096 characters.
		await storeAttachment(t, [past!], [field(`A\u0000${'界'.repeat(100)}`, `v\u0000${'v'.repeat(5000)}`)])
		const [w, p] = await projected(t, [within!, past!])
		expect(JSON.parse(w!.attachment)).toEqual([
			{ name: 'A\u0000B', value: 'ok' },
			{ name: 'name', value: 'x\u0000y\u0000' },
			{ name: '\u0000', value: '\u0000' },
		])
		const shown = await bothWays(t, within!)
		expect(shown.bounded.map((f) => f.name)).toEqual(['A\u0000B', 'name', '\u0000'])
		expect(shown.bounded).toEqual(shown.whole)
		const api = await t.api<{ fields: { name: string }[] }>(`/api/v1/accounts/${within!}`)
		expect(api.body.fields.map((f) => f.name)).toEqual(['A\u0000B', 'name', '\u0000'])
		// SQLite's substr stops at the NUL: each string comes out as what precedes it.
		expect(JSON.parse(p!.attachment)).toEqual([{ name: 'A', value: 'v' }])
		const cut = await bothWays(t, past!)
		expect(cut.bounded).toEqual([{ name: 'A', value: 'v', verified_at: null }])
		expect(cut.whole.map((f) => [f.name.length, f.value.length])).toEqual([[102, 4096]])
	})
})
