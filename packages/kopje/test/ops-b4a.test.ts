import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { bearer, json } from './api-helpers'
import { BUILD, migratedStore, testKernel } from './helpers'
import {
	ACCESS,
	copyConfig,
	dumpViaRpc,
	footprint,
	importChunks,
	importViaRpc,
	setAccess,
	splitDump,
	tableSnapshot,
} from './ops-helpers'
import { act, community, post } from './status-helpers'
import { StoreAdmin } from '../src/platform/store-admin'
import type { StoreStub } from '../src/platform/store-client'

// Dump, import and reset over data made through the statuses, timelines and notifications API.

async function b4aStore(): Promise<{ store: StoreStub; counts: Record<string, number> }> {
	const h = await community(['alice', 'bob'] as const)
	const { alice, bob } = h.users
	// A post with an Idempotency-Key (statuses.client_key), mentioning bob.
	const created = await h.request(
		'/api/v1/statuses',
		bearer(alice.token, json({ status: 'hello @bob' }, { headers: { 'Idempotency-Key': 'retry-1' } }))
	)
	expect(created.status).toBe(200)
	const first = (await created.json()) as { id: string }
	// An edit, a reply (in_reply_to_id and in_reply_to_account_id), a self-reply in the same thread, a boost, a
	// favourite and a bookmark; the reply, boost and favourite notify alice.
	expect(
		(
			await h.request(
				`/api/v1/statuses/${first.id}`,
				bearer(alice.token, json({ status: 'hello again @bob' }, { method: 'PUT' }))
			)
		).status
	).toBe(200)
	const reply = await post(h, bob, { status: '@alice hi', in_reply_to_id: first.id })
	await post(h, bob, { status: 'and more', in_reply_to_id: reply.id })
	for (const path of ['reblog', 'favourite', 'bookmark']) {
		expect((await act(h, bob, `/api/v1/statuses/${first.id}/${path}`)).status, path).toBe(200)
	}
	const counts = await runInDurableObject(h.store, (_instance, state) => {
		const count = (query: string) => state.storage.sql.exec<{ n: number }>(query).one().n
		return {
			edits: count('SELECT count(*) AS n FROM status_edits'),
			replies: count('SELECT count(*) AS n FROM statuses WHERE in_reply_to_id IS NOT NULL'),
			partners: count('SELECT count(*) AS n FROM statuses WHERE in_reply_to_account_id IS NOT NULL'),
			boosts: count('SELECT count(*) AS n FROM statuses WHERE reblog_of_id IS NOT NULL'),
			// A post stores its idempotency key's digest.
			idempotent: count('SELECT count(*) AS n FROM statuses WHERE client_key IS NOT NULL'),
			favourites: count('SELECT count(*) AS n FROM favourites'),
			bookmarks: count('SELECT count(*) AS n FROM bookmarks'),
			notifications: count('SELECT count(*) AS n FROM notifications'),
		}
	})
	return { store: h.store, counts }
}

describe('dump and import with B4a data', () => {
	it('round-trips statuses, edits, replies, boosts, notifications, favourites and bookmarks', async () => {
		const { store: source, counts } = await b4aStore()
		expect(counts).toMatchObject({ replies: 2, boosts: 1, idempotent: 1, favourites: 1, bookmarks: 1 })
		// An edit keeps the original text as an edit-history row as well; there is history either way.
		expect(counts.edits).toBeGreaterThan(0)
		expect(counts.partners).toBe(2)
		expect(counts.notifications).toBeGreaterThanOrEqual(3)

		const { text } = await dumpViaRpc(source, 4096)
		const target = await migratedStore()
		await copyConfig(source, target)
		const { report } = await importViaRpc(target, text, 4096)
		expect(report).toMatchObject({ ok: true, foreignKeyViolations: 0 })
		// kopje_state is per object (dumps keep only last_local_id), so it is compared on its own.
		const { kopje_state: targetState, ...targetData } = await tableSnapshot(target)
		const { kopje_state: sourceState, ...sourceData } = await tableSnapshot(source)
		expect(targetData).toEqual(sourceData)
		const lastId = (rows: string[] | undefined) => rows?.find((row) => row.startsWith('last_local_id='))
		expect(lastId(targetState)).toBe(lastId(sourceState))
		expect(lastId(sourceState)).toBeDefined()
		// AUTOINCREMENT counters came along.
		const sequence = (store: StoreStub) =>
			runInDurableObject(store, (_instance, state) =>
				state.storage.sql
					.exec<{ row: string }>("SELECT name || '=' || seq AS row FROM sqlite_sequence ORDER BY name")
					.toArray()
			)
		expect(await sequence(target)).toEqual(await sequence(source))
	})

	it('resets B4a data in bounded steps and leaves only the configuration', async () => {
		const { store: source } = await b4aStore()
		const { text } = await dumpViaRpc(source)
		const target = await migratedStore()
		await setAccess(target)
		const begun = await target.importBegin(BUILD, ACCESS, splitDump(text).header)
		if (!begun.ok) throw new Error(begun.message)
		for (const [i, chunk] of (await importChunks(text, 1 << 20)).entries()) {
			expect(await target.importChunk(BUILD, ACCESS, begun.progress.id, i + 1, chunk)).toMatchObject({ ok: true })
		}
		await runInDurableObject(target, async (_instance, state) => {
			const admin = new StoreAdmin(state, testKernel(state), {
				source: { build: BUILD, version: 't' },
				log: () => {},
				resetBatchRows: 2,
			})
			const sql = state.storage.sql
			let done = false
			while (!done) {
				const before = footprint(sql)
				const step = await admin.importReset(BUILD, ACCESS, begun.progress.id, false, 1)
				if (!step.ok) throw new Error(step.message)
				done = step.done
				expect(before - footprint(sql)).toBeLessThanOrEqual(2)
			}
			expect(footprint(sql)).toBe(sql.exec<{ n: number }>('SELECT count(*) AS n FROM instance_settings').one().n)
			expect(sql.exec('SELECT count(*) AS n FROM sqlite_sequence').one().n).toBe(0)
		})
	})
})
