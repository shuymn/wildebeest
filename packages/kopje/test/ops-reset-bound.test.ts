import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { BUILD, migratedStore, testKernel } from './helpers'
import {
	ACCESS,
	ADMIN_AUD,
	ADMIN_EMAIL,
	dumpViaRpc,
	footprint,
	SERVICE_CLIENT_ID,
	seedStore,
	setAccess,
	splitDump,
	TEAM_DOMAIN,
} from './ops-helpers'
import { MIGRATIONS } from '../src/db/migrations'
import { StoreAdmin } from '../src/platform/store-admin'
import type { StoreStub } from '../src/platform/store-client'

const BATCH = 25

async function headerOf(): Promise<unknown> {
	const source = await migratedStore()
	await seedStore(source, 0)
	return splitDump((await dumpViaRpc(source)).text).header
}

async function importing(): Promise<{ store: StoreStub; id: string }> {
	const store = await migratedStore()
	await setAccess(store)
	const begun = await store.importBegin(BUILD, ACCESS, await headerOf())
	if (!begun.ok) throw new Error(begun.message)
	return { store, id: begun.progress.id }
}

function id(n: number): string {
	return String(120_000_000_000_000_000n + BigInt(n))
}

describe('reset steps are bounded', () => {
	it('clears wide and deep self-references in bounded batches and leaves the Store exactly empty', async () => {
		const { store, id: importId } = await importing()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			const now = '2026-10-12T00:00:00.000Z'
			// One remote account per boost: a status can be boosted once per account.
			for (let a = 0; a <= 300; a++) {
				sql.exec(
					"INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, ?, 'r.test')",
					id(a),
					`https://r.test/u/${a}`,
					`u${a}`
				)
			}
			const status = (n: number, reblogOf: string | null, replyTo: string | null, account = 0) =>
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, reblog_of_id, in_reply_to_uri, in_reply_to_id, visibility, published_at)
					 VALUES (?, ?, ?, ?, ?, ?, 'public', ?)`,
					id(n),
					`https://r.test/s/${n}`,
					id(account),
					reblogOf,
					replyTo === null ? null : `https://r.test/s/${replyTo}`,
					replyTo,
					now
				)
			// Wide: one status boosted 300 times. Deep: a chain of 1,100 boosts of boosts (a cascade deeper than
			// SQLite's trigger depth), and 300 replies to one status.
			status(1, null, null)
			for (let n = 2; n <= 301; n++) status(n, id(1), null, n - 1)
			status(1000, null, null)
			for (let n = 1001; n <= 2100; n++) status(n, id(n - 1), null)
			status(3000, null, null)
			for (let n = 3001; n <= 3300; n++) status(n, null, id(3000))
			sql.exec("INSERT INTO sqlite_sequence (name, seq) VALUES ('notifications', 41)")
			sql.exec("INSERT OR REPLACE INTO kopje_state (name, value) VALUES ('last_local_id', ?)", id(9))

			const admin = new StoreAdmin(state, testKernel(state, MIGRATIONS), {
				source: { build: BUILD, version: 't' },
				log: () => {},
				resetBatchRows: BATCH,
			})
			let done = false
			let calls = 0
			while (!done) {
				const before = footprint(sql)
				const step = await admin.importReset(BUILD, ACCESS, importId, false, 1)
				if (!step.ok) throw new Error(step.message)
				done = step.done
				expect(before - footprint(sql), `step ${calls}`).toBeLessThanOrEqual(BATCH)
				calls++
			}
			expect(calls).toBeGreaterThan((301 + 1101 + 301 + 301) / BATCH)
			// Exactly empty: no row of any dumped table is left (only the configuration rows of instance_settings).
			expect(footprint(sql)).toBe(sql.exec<{ n: number }>('SELECT count(*) AS n FROM instance_settings').one().n)
			expect(sql.exec('SELECT count(*) AS n FROM sqlite_sequence').one().n).toBe(0)
			expect(sql.exec("SELECT count(*) AS n FROM kopje_state WHERE name = 'last_local_id'").one().n).toBe(0)
		})
	})
})

// RES-6: unlinking rewrites each row whole, so a reset call that unlinks stops after the row that brings its rewritten
// bytes to the step budget (1 MiB), however few rows that is.
describe('a reset call that unlinks large rows', () => {
	it('rewrites a bounded number of bytes', async () => {
		const ROW = 300_000
		const { store, id: importId } = await importing()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(
				"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://r.test/u/0', 'u0', 'r.test')",
				id(0)
			)
			for (let n = 1; n <= 9; n++) {
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, in_reply_to_uri, in_reply_to_id, visibility, search_text, published_at)
					 VALUES (?, ?, ?, ?, ?, 'public', ?, '2026-10-12T00:00:00.000Z')`,
					id(n),
					`https://r.test/s/${n}`,
					id(0),
					n === 1 ? null : 'https://r.test/s/1',
					n === 1 ? null : id(1),
					'x'.repeat(ROW)
				)
			}
			const linked = () =>
				sql.exec<{ n: number }>('SELECT count(*) AS n FROM statuses WHERE in_reply_to_id IS NOT NULL').one().n
			const admin = new StoreAdmin(state, testKernel(state, MIGRATIONS), {
				source: { build: BUILD, version: 't' },
				log: () => {},
			})
			let calls = 0
			while (linked() > 0) {
				const before = linked()
				const step = await admin.importReset(BUILD, ACCESS, importId)
				if (!step.ok) throw new Error(step.message)
				expect(step.done).toBe(false)
				expect(before - linked(), `call ${calls}`).toBeLessThanOrEqual(Math.ceil((1024 * 1024) / ROW))
				calls++
			}
			expect(calls).toBeGreaterThan(1)
			expect(await admin.importReset(BUILD, ACCESS, importId)).toMatchObject({ ok: true, done: true })
		})
	})
})

describe('a lost upgrade wake-up', () => {
	it('is scheduled again when a reset is retried and answered from its receipt', async () => {
		const { store, id: importId } = await importing()
		await runInDurableObject(store, async (_instance, state) => {
			let failAlarm = false
			const storage = new Proxy(state.storage, {
				get(target, property) {
					if (property === 'setAlarm' && failAlarm) {
						return () => Promise.reject(new Error('alarm write failed'))
					}
					const value = Reflect.get(target, property) as unknown
					return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
				},
			})
			const ctx = { storage } as unknown as DurableObjectState
			// A deploy brought a migration while the import ran: the upgrade waits for the reset.
			const kernel = testKernel(ctx, [...MIGRATIONS, { name: '9999_probe', sql: 'CREATE TABLE probe (a)' }])
			const admin = new StoreAdmin(ctx, kernel, { source: { build: BUILD, version: 't' }, log: () => {} })
			await kernel.state()
			await state.storage.deleteAlarm()

			failAlarm = true
			await expect(admin.importReset(BUILD, ACCESS, importId)).rejects.toThrow('alarm write failed')
			failAlarm = false
			expect(await state.storage.getAlarm()).toBeNull()

			expect(await admin.importReset(BUILD, ACCESS, importId)).toMatchObject({ ok: true, done: true })
			expect(await state.storage.getAlarm()).not.toBeNull()
		})
	})
})

describe('the Access binding of a write', () => {
	const service = {
		kind: 'access',
		email: null,
		commonName: SERVICE_CLIENT_ID,
		teamDomain: TEAM_DOMAIN,
		aud: ADMIN_AUD,
	} as const

	it.each([
		['admin email', ACCESS, "UPDATE instance_settings SET value = 'next@kopje.test' WHERE name = 'admin_email'"],
		[
			'service token client id',
			service,
			"UPDATE instance_settings SET value = 'next.access' WHERE name = 'access_service_token_client_id'",
		],
		[
			'team domain',
			ACCESS,
			"UPDATE instance_settings SET value = 'other.cloudflareaccess.com' WHERE name = 'access_team_domain'",
		],
		['admin AUD', ACCESS, "UPDATE instance_settings SET value = 'other-aud' WHERE name = 'access_admin_aud'"],
	])('refuses a write after the %s changed', async (_field, authority, change) => {
		const store = await migratedStore()
		await setAccess(store)
		expect(await store.setConfig(BUILD, authority, { domain: 'kopje.test' })).toMatchObject({ ok: true })
		await runInDurableObject(store, (_instance, state) => {
			state.storage.sql.exec(change)
		})
		expect(await store.setConfig(BUILD, authority, { domain: 'x.test' })).toMatchObject({
			ok: false,
			code: 'wrong-authority',
		})
		expect(await store.importBegin(BUILD, authority, await headerOf())).toMatchObject({
			ok: false,
			code: 'wrong-authority',
		})
	})

	it('accepts a team domain written with a scheme or a trailing slash', async () => {
		const store = await migratedStore()
		await setAccess(store, { access_team_domain: `https://${TEAM_DOMAIN}/` })
		expect(await store.setConfig(BUILD, ACCESS, { domain: 'kopje.test' })).toMatchObject({ ok: true })
	})

	// Reset steps carry no authority of their own: they run in the RPC that was authorized, without yielding, and the
	// configuration they would be checked against cannot change while the import exists. Each new call checks again.
	it('keeps the configuration frozen during a reset and checks each continuing call', async () => {
		const { store, id: importId } = await importing()
		await runInDurableObject(store, async (_instance, state) => {
			// Some imported rows, so one step of one row leaves the reset unfinished.
			for (let a = 0; a < 5; a++) {
				state.storage.sql.exec(
					"INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, ?, 'r.test')",
					id(a),
					`https://r.test/u/${a}`,
					`u${a}`
				)
			}
			const admin = new StoreAdmin(state, testKernel(state), {
				source: { build: BUILD, version: 't' },
				log: () => {},
				resetBatchRows: 1,
			})
			await admin.importReset(BUILD, ACCESS, importId, false, 1)
		})
		expect(await store.setConfig(BUILD, ACCESS, { admin_email: 'next@kopje.test' })).toMatchObject({
			code: 'import-in-progress',
		})
		const stranger = { ...ACCESS, email: `x${ADMIN_EMAIL}` }
		expect(await store.importReset(BUILD, stranger, importId)).toMatchObject({ ok: false, code: 'wrong-authority' })
		expect(await store.importReset(BUILD, { ...ACCESS, aud: 'other-aud' }, importId)).toMatchObject({
			ok: false,
			code: 'wrong-authority',
		})
	})
})
