import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'

import { beforeEach, describe, expect, inject, it } from 'vitest'

import { type AccessTeam, adminClaims, adminHarness, adminTeam, setTeamAccess } from './access-helpers'
import { sql } from './api-helpers'
import { inboxDeps, NOW } from './app-helpers'
import { fixtureKeyGen } from './federation-helpers'
import { BUILD, migratedStore } from './helpers'
import { mastodonActor, RemoteWeb, signedInit, type TestActor } from './inbox-helpers'
import { ACCESS, ADMIN_EMAIL, importViaRpc, splitDump } from './ops-helpers'
import { QueueSim } from './queue-sim'
import type { LegacyInboxMessage } from '../src/federation/legacy-inbox'
import { handleQueue } from '../src/jobs/queue'
import { createMaintenanceWorker, type MaintenanceSnapshot, SPOOL_QUEUE_BINDING } from '../src/maintenance'
import type { StoreStub } from '../src/platform/store-client'

// Rolling a cutover back (docs/cutover-runbook.md, "Rolling back"), on the converted legacy dump of the global setup:
//   - the cutover reset takes a Store with a completed import back to empty, only before publication (OPS-8);
//   - the requests Kopje spooled during the window go to the legacy Queue, verified, in spool order, and leave
//     nothing behind that a later cutover could replay (OPS-9). The legacy consumer's side is in
//     packages/consumer/test/rollback-drain.test.ts.

declare module 'vitest' {
	export interface ProvidedContext {
		cutover: { dump: string; expected: Record<string, Record<string, string>> }
		maintenance: { source: string; workerPath: string }
	}
}

const ORIGIN = 'https://kopje.test'
const VAPID = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' }
const TOKEN = { kind: 'import-token' } as const

let team: AccessTeam
beforeEach(async () => {
	team = await adminTeam()
})

const authority = () => ({ ...ACCESS, teamDomain: team.teamDomain })

async function importedStore(): Promise<StoreStub> {
	const store = await migratedStore()
	await setTeamAccess(store, team, { domain: 'kopje.test' })
	const { report } = await importViaRpc(store, inject('cutover').dump, 1 << 20, authority())
	expect(report).toMatchObject({ ok: true })
	return store
}

function snapshot(): MaintenanceSnapshot {
	const line = inject('maintenance').source.split('\n')[1]!
	return JSON.parse(line.slice('const KOPJE_MAINTENANCE_SNAPSHOT = '.length, -1)) as MaintenanceSnapshot
}

async function count(store: StoreStub, from: string, ...params: SqlStorageValue[]): Promise<number> {
	return (await sql<{ n: number }>(store, `SELECT count(*) AS n FROM ${from}`, ...params))[0]!.n
}

// What `kopje-admin cutover reset --yes` does: start the reset, then continue it as an import reset until it is done.
async function resetToEmpty(h: ReturnType<typeof adminHarness>): Promise<Response> {
	const started = await h.post(adminClaims(), '/admin/cutover/reset', { confirm: true })
	if (started.status !== 200) {
		return started
	}
	const body = (await started.clone().json()) as { id: string | null; done: boolean }
	let done = body.done
	while (!done) {
		const step = await h.post(adminClaims(), '/admin/import/reset', { confirm: true, id: body.id })
		expect(step.status).toBe(200)
		done = ((await step.json()) as { done: boolean }).done
	}
	return started
}

// A request to the app that settles its waitUntil work before it returns.
async function serve(store: StoreStub, overrides: Record<string, unknown>, path: string) {
	const h = adminHarness(store, team, overrides)
	const ctx = createExecutionContext()
	const response = await h.app.fetch(new Request(`${ORIGIN}${path}`), h.env, ctx)
	await waitOnExecutionContext(ctx)
	return response
}

describe('the cutover reset after a completed import (OPS-8)', () => {
	it('empties the Store, keeps its configuration, and lets a new import in', async () => {
		const store = await importedStore()
		const full = adminHarness(store, team, { MAINTENANCE: 'full' })
		expect(await count(store, 'statuses')).toBeGreaterThan(0)

		// A verified import has no running record: import-reset cannot take it back.
		expect(await store.importReset(BUILD, authority(), 'any')).toMatchObject({ ok: false, code: 'import-not-found' })

		const reset = await resetToEmpty(full)
		expect(reset.status).toBe(200)
		expect(await store.cutoverStatus(BUILD)).toMatchObject({ empty: true, published: null, import: null })
		expect(await count(store, 'statuses')).toBe(0)
		expect((await store.config(BUILD)).values).toMatchObject({ domain: 'kopje.test', admin_email: ADMIN_EMAIL })

		// Admin access stayed usable, so the next import goes through Access.
		const again = await importViaRpc(store, inject('cutover').dump, 1 << 20, authority())
		expect(again.report).toMatchObject({ ok: true })
	})

	it('re-arms IMPORT_TOKEN only once the Access values are removed', async () => {
		const store = await importedStore()
		const full = adminHarness(store, team, { MAINTENANCE: 'full' })
		expect((await resetToEmpty(full)).status).toBe(200)
		const { header } = splitDump(inject('cutover').dump)
		expect(await store.importBegin(BUILD, TOKEN, header)).toMatchObject({ ok: false, code: 'not-bootstrap' })
		expect(await store.setConfig(BUILD, authority(), { access_admin_aud: null })).toMatchObject({ ok: true })
		expect(await store.importBegin(BUILD, TOKEN, header)).toMatchObject({ ok: true })
	})

	it('is refused without MAINTENANCE=full, without confirmation, and to anyone but an Access admin', async () => {
		const store = await importedStore()
		const off = adminHarness(store, team, { MAINTENANCE: 'readonly' })
		const refused = await off.post(adminClaims(), '/admin/cutover/reset', { confirm: true })
		expect(refused.status).toBe(409)
		expect(await refused.json()).toMatchObject({ code: 'maintenance-required' })
		const full = adminHarness(store, team, {
			MAINTENANCE: 'full',
			IMPORT_TOKEN: 'import-token-0123456789abcdef0123456789',
		})
		expect((await full.post(adminClaims(), '/admin/cutover/reset', {})).status).toBe(400)
		const token = await full.request('/admin/cutover/reset', {
			method: 'POST',
			headers: { 'Kopje-Import-Token': 'import-token-0123456789abcdef0123456789' },
			body: JSON.stringify({ confirm: true }),
		})
		expect(token.status).toBe(403)
		expect(await store.cutoverReset(BUILD, TOKEN)).toMatchObject({ ok: false, code: 'wrong-authority' })
		expect(await count(store, 'statuses')).toBeGreaterThan(0)
	})

	it('is refused for good once the instance is published, by the operator or by serving', async () => {
		const byCommand = await importedStore()
		const full = adminHarness(byCommand, team, { MAINTENANCE: 'full' })
		expect((await full.post(adminClaims(), '/admin/cutover/publish')).status).toBe(200)
		const refused = await full.post(adminClaims(), '/admin/cutover/reset', { confirm: true })
		expect(refused.status).toBe(409)
		expect(await refused.json()).toMatchObject({ code: 'published' })

		// Serving with MAINTENANCE=off marks it too; a Store with no data is not marked by serving.
		const empty = await migratedStore()
		await serve(empty, { MAINTENANCE: 'off' }, '/health')
		expect((await empty.cutoverStatus(BUILD)).published).toBeNull()
		const held = await importedStore()
		await serve(held, { MAINTENANCE: 'readonly' }, '/health')
		expect((await held.cutoverStatus(BUILD)).published).toBeNull()
		const served = await importedStore()
		await serve(served, { MAINTENANCE: 'off' }, '/health')
		expect((await served.cutoverStatus(BUILD)).published).toMatchObject({ via: 'serving' })
		expect(await served.cutoverReset(BUILD, authority())).toMatchObject({ ok: false, code: 'published' })
		expect(await count(served, 'statuses')).toBeGreaterThan(0)
	})

	it('leaves an incomplete import to import-reset', async () => {
		const store = await migratedStore()
		await setTeamAccess(store, team, { domain: 'kopje.test' })
		const begun = await store.importBegin(BUILD, authority(), splitDump(inject('cutover').dump).header)
		if (!begun.ok) throw new Error(begun.message)
		expect(await store.cutoverReset(BUILD, authority())).toMatchObject({ ok: false, code: 'import-exists' })
		expect(await store.importReset(BUILD, authority(), begun.progress.id)).toMatchObject({ ok: true, done: true })
		expect((await store.cutoverStatus(BUILD)).empty).toBe(true)
	})
})

describe('the rollback drain (OPS-9)', () => {
	type Spooled = { queue: QueueSim; web: RemoteWeb; carol: TestActor; dave: TestActor }

	// A Follow and a Create from carol to alice, and a request signed with dave's key that claims carol, spooled by the
	// maintenance worker in that order.
	async function spooled(): Promise<Spooled> {
		const web = new RemoteWeb()
		const carol = await mastodonActor(web, 'carol')
		const dave = await mastodonActor(web, 'dave', { key: 1 })
		const worker = createMaintenanceWorker(snapshot(), () => NOW)
		const queue = new QueueSim()
		const post = async (path: string, init: RequestInit) => {
			const response = await worker.fetch!(
				new Request(`${ORIGIN}${path}`, init) as Request<unknown, IncomingRequestCfProperties>,
				{ [SPOOL_QUEUE_BINDING]: queue.queue },
				{} as ExecutionContext
			)
			expect(response.status).toBe(202)
		}
		const follow = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: `${carol.uri}#follows/1`,
			type: 'Follow',
			actor: carol.uri,
			object: `${ORIGIN}/ap/users/alice`,
		}
		const create = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: `${carol.uri}/statuses/1/activity`,
			type: 'Create',
			actor: carol.uri,
			to: [`${ORIGIN}/ap/users/alice`],
			object: {
				id: `${carol.uri}/statuses/1`,
				type: 'Note',
				attributedTo: carol.uri,
				to: [`${ORIGIN}/ap/users/alice`],
				content: '<p>hello</p>',
				attachment: [],
				published: '2026-10-12T00:00:00Z',
			},
		}
		await post('/ap/users/alice/inbox', await signedInit(carol, '/ap/users/alice/inbox', follow))
		await post('/inbox', await signedInit(carol, '/inbox', create))
		const forged = { ...follow, id: `${carol.uri}#follows/2` }
		await post('/inbox', await signedInit(carol, '/inbox', forged, { keyId: dave.keyId, privateKey: dave.privateKey }))
		return { queue, web, carol, dave }
	}

	async function journaled(store: StoreStub, { queue, web }: Spooled) {
		const env = {
			...adminHarness(store, team).env,
			MAINTENANCE: 'full',
			CUTOVER_ROLLBACK: 'journal',
			QUEUE: new QueueSim().queue,
		} as Env
		await queue.deliver((batch) =>
			handleQueue(
				batch,
				env,
				inboxDeps(() => store, web.loader)
			)
		)
		expect(queue.pending).toEqual([])
		expect(queue.retries).toBe(0)
	}

	function legacyQueue() {
		const sent: LegacyInboxMessage[] = []
		const queue = new QueueSim()
		queue.send.mockImplementation((body: unknown) => {
			sent.push(structuredClone(body) as LegacyInboxMessage)
			return Promise.resolve()
		})
		return { sent, queue: queue.queue }
	}

	function drainer(store: StoreStub, web: RemoteWeb, legacy: Queue | undefined) {
		const overrides = {
			MAINTENANCE: 'full',
			USER_KEK: 'legacy-kek',
			LEGACY_VAPID_JWK: JSON.stringify(VAPID),
			...(legacy === undefined ? {} : { LEGACY_QUEUE: legacy }),
		}
		const h = adminHarness(store, team, overrides, { keygen: fixtureKeyGen, loader: web.loader })
		return () => h.post(adminClaims(), '/admin/cutover/drain', { fallbackActor: `${ORIGIN}/ap/users/alice` })
	}

	it('journals spooled requests instead of holding them, and drains them to the legacy Queue in spool order', async () => {
		const store = await importedStore()
		const spool = await spooled()
		await journaled(store, spool)
		expect((await store.cutoverStatus(BUILD)).journal).toMatchObject({ pending: 3, unverified: 0 })

		const legacy = legacyQueue()
		const response = await drainer(store, spool.web, legacy.queue)()
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({
			sent: 2,
			unverified: 1,
			pending: 0,
			unverifiedTotal: 1,
			stopped: null,
		})
		expect(legacy.sent.map((m) => m.activity.type)).toEqual(['Follow', 'Create'])
		expect(legacy.sent[0]).toEqual({
			type: 1,
			actorId: `${ORIGIN}/ap/users/alice`,
			signerId: spool.carol.uri,
			activity: expect.objectContaining({ id: `${spool.carol.uri}#follows/1`, type: 'Follow' }),
			userKEK: 'legacy-kek',
			vapidKeys: VAPID,
		})
		// The shared-inbox Create goes to the local actor it addresses.
		expect(legacy.sent[1]!.actorId).toBe(`${ORIGIN}/ap/users/alice`)

		// The forged request is kept, not sent, and blocks the reset until the operator discards it.
		expect(await store.cutoverStatus(BUILD)).toMatchObject({ journal: { pending: 0, unverified: 1 } })
		const full = adminHarness(store, team, { MAINTENANCE: 'full' })
		const blocked = await full.post(adminClaims(), '/admin/cutover/reset', { confirm: true })
		expect(await blocked.json()).toMatchObject({ code: 'journal-not-empty' })
		expect((await full.post(adminClaims(), '/admin/cutover/discard-unverified', { confirm: true })).status).toBe(200)
		expect((await resetToEmpty(full)).status).toBe(200)

		// Nothing is left to replay: a later cutover's import and publication see neither request.
		const again = await importViaRpc(store, inject('cutover').dump, 1 << 20, authority())
		expect(again.report).toMatchObject({ ok: true })
		// Publication replays whatever Kopje's Queue still holds: the drained requests are no longer there.
		const env = { ...full.env, MAINTENANCE: 'off', QUEUE: new QueueSim().queue } as Env
		await spool.queue.deliver((batch) =>
			handleQueue(
				batch,
				env,
				inboxDeps(() => store, spool.web.loader)
			)
		)
		expect(
			await count(store, 'follows f JOIN accounts a ON a.id = f.account_id WHERE a.uri = ?', spool.carol.uri)
		).toBe(0)
		expect(await count(store, 'statuses WHERE uri = ?', `${spool.carol.uri}/statuses/1`)).toBe(0)
	})

	it('stops at a request that may verify later, so nothing after it overtakes it', async () => {
		const store = await importedStore()
		const spool = await spooled()
		await journaled(store, spool)
		spool.web.fail(spool.carol.uri, 503)
		const legacy = legacyQueue()
		const response = await drainer(store, spool.web, legacy.queue)()
		expect(await response.json()).toMatchObject({ sent: 0, stopped: 'key-unavailable', pending: 3 })
		expect(legacy.sent).toEqual([])
	})

	it('keeps the journal when the legacy Queue is not bound or refuses a message', async () => {
		const store = await importedStore()
		const spool = await spooled()
		await journaled(store, spool)
		const unbound = await drainer(store, spool.web, undefined)()
		expect(unbound.status).toBe(409)
		expect(await unbound.json()).toMatchObject({ code: 'legacy-binding-missing' })
		const failing = new QueueSim()
		failing.send.mockImplementation(() => Promise.reject(new Error('queue unavailable')))
		const response = await drainer(store, spool.web, failing.queue)()
		expect(await response.json()).toMatchObject({ sent: 0, stopped: 'legacy-queue-failed', pending: 2 })
	})

	it('journals nothing once the instance is published: the Queue holds the requests as in maintenance', async () => {
		const store = await importedStore()
		await store.markPublished(BUILD, 'command')
		const spool = await spooled()
		const env = {
			...adminHarness(store, team).env,
			MAINTENANCE: 'full',
			CUTOVER_ROLLBACK: 'journal',
			QUEUE: spool.queue.queue,
		} as Env
		await spool.queue.deliver((batch) =>
			handleQueue(
				batch,
				env,
				inboxDeps(() => store, spool.web.loader)
			)
		)
		expect(spool.queue.pending).toHaveLength(3)
		expect((await store.cutoverStatus(BUILD)).journal.pending).toBe(0)
	})

	it('accepts the drain from an Access admin only', async () => {
		const store = await importedStore()
		expect(await store.journalPage(BUILD, TOKEN, 10)).toMatchObject({ ok: false, code: 'wrong-authority' })
		expect(await store.journalSettle(BUILD, TOKEN, { sent: [], unverified: [] })).toMatchObject({
			ok: false,
			code: 'wrong-authority',
		})
	})
})
