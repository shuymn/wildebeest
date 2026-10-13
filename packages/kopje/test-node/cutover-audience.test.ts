import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { convert, exportOf, failing, opened, verify, workspace } from './cutover-helpers.js'

// The audience never widens (DATA-15): visibility and recipients come from the addressing as exported, as legacy
// authorized it (packages/backend/src/mastodon/status_visibility.ts). Also ids, the notification counter, settings
// and determinism.

const space = workspace()
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public'

type Row = Record<string, unknown>

async function statusWith(dumpPath: string, content: string) {
	const db = await opened(dumpPath)
	const status = db.prepare('SELECT id, visibility FROM statuses WHERE content LIKE ?').get(`%${content}%`) as Row
	const mentions = (
		db
			.prepare(
				`SELECT a.uri, m.silent FROM status_mentions m JOIN accounts a ON a.id = m.account_id
				WHERE m.status_id = ? ORDER BY a.uri`
			)
			.all(status.id as string) as Row[]
	).map((m) => [m.uri, m.silent])
	db.close()
	return { visibility: status.visibility, mentions }
}

describe('the audience never widens (DATA-15)', () => {
	for (const level of [0, 1]) {
		it(`keeps a DM direct at level ${level}, where bridging fills the outbox with Public`, async () => {
			const exportPath = await exportOf(space.dir, { level })
			const { ok, dumpPath } = await convert(space.dir, exportPath)
			expect(ok).toBe(true)
			expect(await statusWith(dumpPath, 'a secret direct message')).toEqual({
				visibility: 'direct',
				mentions: [['https://remote.example/users/r0', 0]],
			})
			const { ok: verified, categories } = await verify(exportPath, dumpPath)
			expect(failing(categories)).toEqual([])
			expect(verified).toBe(true)
		})
	}

	it('gives a direct status exactly the accounts in to; tags and cc outside it are no recipients', async () => {
		const exportPath = await exportOf(space.dir, { level: 39 })
		const { manifest, dumpPath } = await convert(space.dir, exportPath)
		expect(await statusWith(dumpPath, 'only for r0')).toEqual({
			visibility: 'direct',
			mentions: [['https://remote.example/users/r0', 0]],
		})
		// A remote DM to alice that copies bob: only alice.
		expect(await statusWith(dumpPath, 'a DM to alice')).toEqual({
			visibility: 'direct',
			mentions: [['https://kopje.test/ap/users/alice', 0]],
		})
		// Followers-only: r2 follows alice and is a recipient; r3 does not and is not.
		expect(await statusWith(dumpPath, 'followers only')).toEqual({
			visibility: 'private',
			mentions: [['https://remote.example/users/r2', 0]],
		})
		const normalized = (manifest.conversion as { normalized: Record<string, number> }).normalized
		expect(normalized.mentionsNotRecipients).toBe(4)
	})

	it('refuses a local status whose outbox addressing disagrees with its own', async () => {
		const exportPath = await exportOf(space.dir, { level: 39 })
		const file = join(exportPath, 'outbox_objects.sql')
		// The DM's outbox row claims Public.
		const text = (await readFile(file, 'utf8')).replace(
			`'["https://remote.example/users/r0"]','[]'`,
			`'["${PUBLIC}"]','[]'`
		)
		await writeFile(file, text)
		const { ok, manifest } = await convert(space.dir, exportPath)
		expect(ok).toBe(false)
		expect((manifest.conversion as { problems: Record<string, number> }).problems).toMatchObject({
			'statuses:addressing-conflict': 1,
		})
	})

	it('refuses boosts below 0002, where the export has no audience for them', async () => {
		const exportPath = await exportOf(space.dir, { level: 1, boosts: true })
		const { ok, manifest } = await convert(space.dir, exportPath)
		expect(ok).toBe(false)
		expect((manifest.conversion as { problems: Record<string, number> }).problems).toEqual({
			'reblogs:audience-unknown': 2,
		})
	})
})

describe('ids', () => {
	it('keeps every 18-digit legacy id, even one a drawn id would have taken first', async () => {
		const exportPath = await exportOf(space.dir, { level: 39 })
		const first = await convert(space.dir, exportPath, { out: 'first' })
		let db = await opened(first.dumpPath)
		const drawn = (
			db.prepare("SELECT id FROM statuses WHERE legacy_id = 'd9a3c8e0-7f1b-4c2a-a4d3-8f3e2b1c0d55'").get() as Row
		).id as string
		db.close()
		// A later status (by rowid) whose legacy id is exactly the id the earlier UUID status was given.
		const later = ((BigInt(Date.parse('2024-03-01T09:00:00.000Z') + 130 * 60_000) << 16n) | 9n).toString()
		const file = join(exportPath, 'objects.sql')
		await writeFile(file, (await readFile(file, 'utf8')).replaceAll(later, drawn))
		const second = await convert(space.dir, exportPath, { out: 'second' })
		expect(second.ok).toBe(true)
		db = await opened(second.dumpPath)
		expect((db.prepare('SELECT content FROM statuses WHERE id = ?').get(drawn) as Row).content).toContain(
			'followers only'
		)
		expect(
			(db.prepare("SELECT id FROM statuses WHERE legacy_id = 'd9a3c8e0-7f1b-4c2a-a4d3-8f3e2b1c0d55'").get() as Row).id
		).not.toBe(drawn)
		db.close()
		expect((await verify(exportPath, second.dumpPath)).ok).toBe(true)
	})
})

describe('the notification counter continues past the legacy high-water mark', () => {
	const cases: [string, Parameters<typeof exportOf>[1], string][] = [
		['a deleted high-water notification', { level: 39, notificationSequence: 9n }, '10'],
		['an empty table with a sequence', { level: 39, notifications: false, notificationSequence: 5n }, '6'],
		[
			'a sequence above Number.MAX_SAFE_INTEGER',
			{ level: 39, notificationSequence: 9007199254740993n },
			'9007199254740994',
		],
		['no exported sequence (the largest id)', { level: 39 }, '9'],
	]
	for (const [name, options, next] of cases) {
		it(`with ${name}`, async () => {
			const exportPath = await exportOf(space.dir, options)
			const { ok, dumpPath } = await convert(space.dir, exportPath)
			expect(ok).toBe(true)
			const db = await opened(dumpPath)
			const inserted = db
				.prepare(
					`INSERT INTO notifications (account_id, type, from_account_id)
					VALUES ((SELECT account_id FROM local_accounts LIMIT 1), 'test', (SELECT id FROM accounts WHERE domain IS NOT NULL LIMIT 1))
					RETURNING CAST(id AS TEXT) AS id`
				)
				.get() as Row
			db.close()
			expect(inserted.id).toBe(next)
			expect((await verify(exportPath, dumpPath)).ok).toBe(true)
		})
	}
})

describe('instance settings', () => {
	it("map to Kopje's names, and an unknown name stops the conversion", async () => {
		const exportPath = await exportOf(space.dir, { level: 39 })
		const { dumpPath } = await convert(space.dir, exportPath)
		const db = await opened(dumpPath)
		expect(
			Object.fromEntries(
				(db.prepare('SELECT name, value FROM instance_settings ORDER BY name').all() as Row[]).map((r) => [
					r.name,
					r.value,
				])
			)
		).toEqual({
			description: 'A synthetic legacy instance',
			extended_description: '<p>私のサーバー</p>',
			rules: '[{"id":"1","text":"No spam"},{"id":"2","text":"スパム禁止"}]',
			title: 'Fixture Herd',
		})
		db.close()
		const file = join(exportPath, 'server_settings.sql')
		await writeFile(
			file,
			`${await readFile(file, 'utf8')}INSERT INTO "server_settings" ("setting_name","setting_value") VALUES('domain','x');\n`
		)
		const { ok, manifest } = await convert(space.dir, exportPath, { out: 'unknown' })
		expect(ok).toBe(false)
		expect((manifest.conversion as { problems: Record<string, number> }).problems).toEqual({
			'settings:unknown-name': 1,
		})
	})
})

describe('determinism', () => {
	for (const level of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 18, 23, 35, 39]) {
		it(`gives identical dumps at level ${level} whenever it runs`, async () => {
			const exportPath = await exportOf(space.dir, { level })
			const first = await convert(space.dir, exportPath, { out: 'a' })
			await new Promise((resolve) => setTimeout(resolve, 5))
			const second = await convert(space.dir, exportPath, { out: 'b' })
			expect(first.ok).toBe(true)
			expect(await readFile(second.dumpPath, 'utf8')).toBe(await readFile(first.dumpPath, 'utf8'))
		})
	}
})
