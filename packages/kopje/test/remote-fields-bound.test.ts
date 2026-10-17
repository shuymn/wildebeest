import { describe, expect, it } from 'vitest'

import { seedFollows, sql } from './api-helpers'
import { ALICE, setup, type Setup } from './inbox-status-helpers'
import {
	ACCOUNT_COLUMNS,
	ACCOUNT_FROM,
	type AccountRow,
	type Field,
	MAX_REMOTE_FIELDS,
	presentAccount,
} from '../src/domain/accounts'
import { sanitizeRemoteHtml } from '../src/security/html'

// A remote account's profile fields are projected bounded (REMOTE_ATTACHMENT_SQL): a row carries at most what the
// presenter shows, whatever the size of the stored actor document (RES-2), and shows the same fields as the whole
// attachment does.

const ORIGIN = 'https://kopje.test'
const DOMAIN = 'fields.example'
// The projection's ceiling: MAX_REMOTE_FIELDS entries of a 255-character name and a 4,096-character value, each
// character at most six once JSON-escaped, plus the JSON punctuation.
const PROJECTED_CEILING = MAX_REMOTE_FIELDS * ((255 + 4096) * 6 + 32) + 2

const field = (name: string, value: string) => ({ type: 'PropertyValue', name, value })

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

// The projected attachment of each account, and its length in characters.
async function projected(t: Setup, ids: readonly string[]): Promise<{ attachment: string; length: number }[]> {
	return sql<{ attachment: string; length: number }>(
		t.store,
		`SELECT attachment, length(attachment) AS length FROM (SELECT ${ACCOUNT_COLUMNS} FROM ${ACCOUNT_FROM}
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

// The account's fields as the presenter shows them from the bounded projection, and from the whole attachment.
async function bothWays(t: Setup, id: string): Promise<{ bounded: Field[]; whole: Field[] }> {
	const [row] = await sql<AccountRow & { whole: string | null }>(
		t.store,
		`SELECT ${ACCOUNT_COLUMNS}, a.raw -> '$.attachment' AS whole FROM ${ACCOUNT_FROM} WHERE a.id = ?`,
		id
	)
	const { whole, ...bounded } = row!
	return { bounded: presentAccount(bounded, { origin: ORIGIN }).fields, whole: wholeFields(whole) }
}

describe('remote profile fields are projected bounded (RES-2)', () => {
	it('reads one account and a page of 80 with a 1.5 MiB attachment within the bound', async () => {
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
			expect(row.length).toBeLessThanOrEqual(PROJECTED_CEILING)
		}
		const total = rows.reduce((sum, row) => sum + row.length, 0)
		expect(total).toBeLessThanOrEqual(80 * PROJECTED_CEILING)
		// The huge values are cut to 255 and 4,096 characters before they leave SQLite.
		const [cut] = JSON.parse(rows.find((row) => row.attachment.includes('"b"'))!.attachment) as {
			name: string
			value: string
		}[]
		expect([cut!.name.length, cut!.value.length]).toEqual([255, 4096])
	})

	it('projects the same size for 20 and 20,000 fields', async () => {
		const t = await setup()
		const [small, large] = await remoteFollowers(t, 2)
		const fields = (count: number) => Array.from({ length: count }, (_, i) => field(`f${i % 10}`, `<p>v${i % 10}</p>`))
		await storeAttachment(t, [small!], fields(20))
		await storeAttachment(t, [large!], fields(20_000))
		const [a, b] = await projected(t, [small!, large!])
		expect(a!.length).toBe(b!.length)
		expect(a!.attachment).toBe(b!.attachment)
	})

	it('shows a normal actor’s fields as Mastodon does, and as the whole attachment does', async () => {
		const t = await setup()
		const [id] = await remoteFollowers(t, 1)
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
		const { bounded, whole } = await bothWays(t, id!)
		expect(bounded).toEqual(shown.body.fields)
		expect(JSON.stringify(bounded)).toBe(JSON.stringify(whole))
	})

	it('cuts at the limits as the presenter does, and keeps its filters', async () => {
		const t = await setup()
		const ids = await remoteFollowers(t, 6)
		const astral = '🦬'.repeat(300)
		const cases: unknown[] = [
			// More than MAX_REMOTE_FIELDS, with names and values at and past the limits (astral characters: SQLite counts
			// code points, JavaScript code units).
			[
				...Array.from({ length: MAX_REMOTE_FIELDS + 4 }, (_, i) =>
					field(`${i}`.padEnd(255 + (i % 3) - 1, 'n'), 'v'.repeat(4096 + (i % 3) - 1))
				),
			],
			[field(astral, astral), field('a', '🦬'.repeat(4096))],
			// One object rather than a list.
			field('Only', 'one'),
			// type as a list, as an object, missing; non-string names and values; non-object entries.
			[
				{ type: ['PropertyValue', 'Other'], name: 'listed', value: 'yes' },
				{ type: { x: 'PropertyValue' }, name: 'object type', value: 'no' },
				{ type: [['PropertyValue']], name: 'nested type', value: 'no' },
				{ name: 'untyped', value: 'no' },
				{ type: 'PropertyValue', name: 1, value: 'no' },
				{ type: 'PropertyValue', name: 'no value' },
				{ type: 'PropertyValue', name: 'null value', value: null },
				['PropertyValue', 'n', 'v'],
				'PropertyValue',
				null,
				field('', ''),
			],
			// No attachment at all, and an empty one.
			undefined,
			[],
		]
		for (const [i, attachment] of cases.entries()) {
			await storeAttachment(t, [ids[i]!], attachment)
		}
		const results = await Promise.all(ids.map((id) => bothWays(t, id)))
		for (const { bounded, whole } of results) {
			expect(JSON.stringify(bounded)).toBe(JSON.stringify(whole))
		}
		expect(results[0]!.bounded).toHaveLength(MAX_REMOTE_FIELDS)
		expect(results[0]!.bounded.map((f) => [f.name.length, f.value.length])).toContainEqual([255, 4096])
		expect(results[2]!.bounded.map((f) => f.name)).toEqual(['Only'])
		expect(results[3]!.bounded.map((f) => f.name)).toEqual(['listed', ''])
		expect(results[4]!.bounded).toEqual([])
		expect(results[5]!.bounded).toEqual([])
	})
})
