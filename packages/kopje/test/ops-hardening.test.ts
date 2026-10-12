import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it, vi } from 'vitest'

import { BUILD, migratedStore, testKernel } from './helpers'
import { ACCESS, ADMIN_EMAIL, dumpViaRpc, importChunks, seedStore, setAccess, splitDump } from './ops-helpers'
import { type AdminOptions, StoreAdmin } from '../src/platform/store-admin'
import type { StoreStub } from '../src/platform/store-client'

const TOKEN = { kind: 'import-token' } as const
const T0 = Date.parse('2026-10-12T00:00:00Z')
const MINUTE = 60 * 1000

function admin(state: DurableObjectState, options: Partial<AdminOptions> = {}): StoreAdmin {
	return new StoreAdmin(state, testKernel(state), { source: { build: BUILD, version: 't' }, log: () => {}, ...options })
}

async function dumpText(): Promise<string> {
	const source = await migratedStore()
	await seedStore(source, 30)
	return (await dumpViaRpc(source, 4096)).text
}

async function configured(): Promise<StoreStub> {
	const store = await migratedStore()
	await setAccess(store)
	return store
}

function configRows(state: DurableObjectState): string[] {
	return state.storage.sql
		.exec<{ row: string }>(
			"SELECT name || '=' || value AS row FROM instance_settings WHERE name IN ('domain', 'access_aud', 'access_team_domain', 'access_admin_aud', 'admin_email', 'access_service_token_client_id') ORDER BY name"
		)
		.toArray()
		.map((r) => r.row)
}

describe('Access authority is re-checked where the Store writes', () => {
	it('refuses a write from an admin who was revoked after the Worker authenticated the request', async () => {
		const store = await configured()
		const revokedAdmin = { ...ACCESS, email: ADMIN_EMAIL }
		// Another admin replaces the admin email while the first request is still in flight.
		await runInDurableObject(store, (_instance, state) => {
			state.storage.sql.exec("UPDATE instance_settings SET value = 'next@kopje.test' WHERE name = 'admin_email'")
		})
		expect(await store.setConfig(BUILD, revokedAdmin, { admin_email: ADMIN_EMAIL })).toMatchObject({
			ok: false,
			code: 'wrong-authority',
		})
		expect(await store.importBegin(BUILD, revokedAdmin, splitDump(await dumpText()).header)).toMatchObject({
			ok: false,
			code: 'wrong-authority',
		})
		const current = { ...ACCESS, email: 'NEXT@kopje.test' }
		expect(await store.setConfig(BUILD, current, { domain: 'kopje.test' })).toMatchObject({ ok: true })
	})
})

describe('session credentials', () => {
	it('compares session digests with the runtime timingSafeEqual', async () => {
		const text = await dumpText()
		const store = await migratedStore()
		const begun = await store.importBegin(BUILD, TOKEN, splitDump(text).header)
		if (!begun.ok || begun.session === undefined) throw new Error('no session')
		const secret = begun.session
		await runInDurableObject(store, async (_instance, state) => {
			const spy = vi.spyOn(crypto.subtle, 'timingSafeEqual')
			try {
				const chunk = (await importChunks(text, 1 << 20))[0]!
				await admin(state).importChunk(BUILD, { kind: 'import-session', secret }, begun.progress.id, 1, chunk)
				expect(spy).toHaveBeenCalled()
			} finally {
				spy.mockRestore()
			}
			// Only the digest is kept.
			const record = state.storage.sql
				.exec<{ value: string }>("SELECT value FROM kopje_state WHERE name = 'import'")
				.one()
			expect(record.value).not.toContain(secret)
		})
	})
})

describe('the idle clock of a token import', () => {
	it('is refreshed by an accepted duplicate chunk, a repeated finish and a verify step', async () => {
		const text = await dumpText()
		const store = await migratedStore()
		await runInDurableObject(store, async (_instance, state) => {
			const at = (ms: number) => admin(state, { now: () => ms })
			const begun = await at(T0).importBegin(BUILD, TOKEN, splitDump(text).header)
			if (!begun.ok || begun.session === undefined) throw new Error('no session')
			const session = { kind: 'import-session', secret: begun.session } as const
			const id = begun.progress.id
			const chunks = await importChunks(text, 4096)
			for (const [i, chunk] of chunks.entries()) {
				await at(T0).importChunk(BUILD, session, id, i + 1, chunk)
			}
			const stale = (ms: number) => at(ms).importReset(BUILD, TOKEN, id, true)

			// A retried chunk 14 minutes later counts as activity.
			expect(await at(T0 + 14 * MINUTE).importChunk(BUILD, session, id, 1, chunks[0]!)).toMatchObject({
				duplicate: true,
			})
			expect(await stale(T0 + 16 * MINUTE)).toMatchObject({ ok: false, code: 'import-not-idle' })

			const { trailer } = splitDump(text)
			await at(T0 + 20 * MINUTE).importFinish(BUILD, session, id, trailer)
			expect(await at(T0 + 34 * MINUTE).importFinish(BUILD, session, id, trailer)).toMatchObject({ ok: true })
			expect(await stale(T0 + 36 * MINUTE)).toMatchObject({ ok: false, code: 'import-not-idle' })

			// A bounded verify step that does not finish also counts.
			expect(await at(T0 + 48 * MINUTE).importVerify(BUILD, session, id, 1024)).toMatchObject({ done: false })
			expect(await stale(T0 + 50 * MINUTE)).toMatchObject({ ok: false, code: 'import-not-idle' })
		})
	})
})

describe('verification across a restart', () => {
	it('continues a partial verification in a recreated Store object', async () => {
		const text = await dumpText()
		const store = await configured()
		const begun = await store.importBegin(BUILD, ACCESS, splitDump(text).header)
		if (!begun.ok) throw new Error(begun.message)
		const id = begun.progress.id
		for (const [i, chunk] of (await importChunks(text, 4096)).entries()) {
			await store.importChunk(BUILD, ACCESS, id, i + 1, chunk)
		}
		await store.importFinish(BUILD, ACCESS, id, splitDump(text).trailer)
		await runInDurableObject(store, async (_instance, state) => {
			expect(await admin(state).importVerify(BUILD, ACCESS, id, 1024)).toMatchObject({ done: false })
		})
		await runInDurableObject(store, async (_instance, state) => {
			let result
			do {
				result = await admin(state).importVerify(BUILD, ACCESS, id, 1024)
			} while (result.ok && !result.done)
			expect(result).toMatchObject({ ok: true, done: true, report: { ok: true } })
		})
	})
})

describe('reset', () => {
	it('survives an interruption: configuration stays durable and the reset completes later', async () => {
		const text = await dumpText()
		const store = await configured()
		await store.setConfig(BUILD, ACCESS, { domain: 'kopje.test' })
		const begun = await store.importBegin(BUILD, ACCESS, splitDump(text).header)
		if (!begun.ok) throw new Error(begun.message)
		const id = begun.progress.id
		for (const [i, chunk] of (await importChunks(text, 4096)).entries()) {
			await store.importChunk(BUILD, ACCESS, id, i + 1, chunk)
		}
		let before: string[] = []
		await runInDurableObject(store, async (_instance, state) => {
			const record = JSON.parse(
				state.storage.sql.exec<{ value: string }>("SELECT value FROM kopje_state WHERE name = 'import'").one().value
			) as { bootstrap: { name: string; value: string }[] }
			before = record.bootstrap.map((r) => `${r.name}=${r.value}`)
			// One small step, then the object goes away (a deploy or an eviction).
			expect(await admin(state, { resetBatchRows: 5 }).importReset(BUILD, ACCESS, id, false, 1)).toMatchObject({
				ok: true,
				done: false,
			})
		})
		await runInDurableObject(store, async (_instance, state) => {
			// A new kernel and admin: the reset state and the configuration come from storage.
			const fresh = admin(state, { resetBatchRows: 5 })
			expect(await fresh.importProgress(ACCESS, id)).toMatchObject({ progress: { state: 'resetting' } })
			expect(await fresh.config()).toEqual({
				values: Object.fromEntries(before.map((row) => row.split(/=(.*)/s).slice(0, 2))),
			})
			let done = false
			for (let i = 0; i < 1000 && !done; i++) {
				const step = await fresh.importReset(BUILD, ACCESS, id)
				if (!step.ok) throw new Error(step.message)
				done = step.done
			}
			expect(done).toBe(true)
			expect(configRows(state)).toEqual(before)
			expect(state.storage.sql.exec('SELECT count(*) AS n FROM statuses').one().n).toBe(0)
			expect(state.storage.sql.exec('SELECT count(*) AS n FROM kopje_migrations').one().n).toBeGreaterThan(0)
		})
		expect(await store.importProgress(BUILD, ACCESS)).toEqual({ progress: null })
	})

	it('is bound to an import id: retries are safe and a late request cannot reset another import', async () => {
		const text = await dumpText()
		const header = splitDump(text).header
		const store = await configured()
		const first = await store.importBegin(BUILD, ACCESS, header)
		if (!first.ok) throw new Error(first.message)
		expect(await store.importReset(BUILD, ACCESS)).toMatchObject({ ok: false, code: 'import-id-required' })
		const reset = async (id: string) => {
			for (;;) {
				const step = await store.importReset(BUILD, ACCESS, id)
				if (!step.ok || step.done) return step
			}
		}
		expect(await reset(first.progress.id)).toMatchObject({ ok: true, done: true })
		// The response was lost: the same request again is answered from the receipt.
		expect(await reset(first.progress.id)).toMatchObject({ ok: true, done: true })

		const second = await store.importBegin(BUILD, ACCESS, header)
		if (!second.ok) throw new Error(second.message)
		expect(await store.importReset(BUILD, ACCESS, first.progress.id)).toMatchObject({
			ok: false,
			code: 'import-not-found',
		})
		expect(await store.importProgress(BUILD, ACCESS)).toMatchObject({ progress: { id: second.progress.id } })
	})
})

describe('configuration during an import', () => {
	it("shows the target's saved configuration, not the imported rows", async () => {
		const text = await dumpText()
		const store = await configured()
		await store.setConfig(BUILD, ACCESS, { domain: 'target.test' })
		const saved = await store.config(BUILD)
		const begun = await store.importBegin(BUILD, ACCESS, splitDump(text).header)
		if (!begun.ok) throw new Error(begun.message)
		expect(await store.config(BUILD)).toEqual(saved)
		for (const [i, chunk] of (await importChunks(text, 1 << 20)).entries()) {
			await store.importChunk(BUILD, ACCESS, begun.progress.id, i + 1, chunk)
		}
		// The dump's domain row is in the table now, but the configuration is still the target's.
		expect(await store.config(BUILD)).toEqual(saved)
	})
})
