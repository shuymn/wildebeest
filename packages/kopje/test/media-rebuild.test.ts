import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

import { beforeEach, describe, expect, it } from 'vitest'

import { type AccessTeam, adminClaims, adminHarness, adminTeam, serviceClaims, setTeamAccess } from './access-helpers'
import { NOW } from './app-helpers'
import { JPEG_ORIENTATION_6, PNG_PLAIN, WIDE_PNG } from './fixtures/images'
import { BUILD, migratedStore, rejectionOf } from './helpers'
import { bytes, TestCodec } from './media-helpers'
import { ACCESS, memoryIO } from './ops-helpers'
import { run } from '../cli/lib/main.js'
import { REBUILD_PAGE } from '../src/domain/media-rebuild'
import { MAX_BUILDS_PER_CALL } from '../src/mastodon/media-rebuild'
import type { StoreStub } from '../src/platform/store-client'
import { toStoreUnavailable } from '../src/platform/store-errors'
import { admitFlags, type OperatorFlags } from '../src/platform/store-flags'
import { randomToken } from '../src/security/tokens'

// kopje-admin media-rebuild (mastodon/media-rebuild.ts): served files made again from the originals of restored or moved
// media, MEDIA-2/MEDIA-3, and its narrow exemption from the operator gate (OPS-8).

let team: AccessTeam

beforeEach(async () => {
	team = await adminTeam()
})

const ACCOUNT = '110000000000000001'
let nextId = 0

function mediaId(): string {
	return String(120_000_000_000_000_000n + BigInt(++nextId))
}

type Row = { id: string; token: string }

async function setup(options: { codec?: TestCodec; env?: Record<string, unknown> } = {}) {
	const store = await migratedStore()
	await setTeamAccess(store, team)
	await runInDurableObject(store, (_instance, state) => {
		state.storage.sql.exec(
			"INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/alice', 'alice')",
			ACCOUNT
		)
	})
	const codec = options.codec ?? new TestCodec()
	const h = adminHarness(store, team, options.env ?? {}, undefined, () => codec)
	return { ...h, store, codec }
}

// A complete local media row, as a restore or `convert --images` leaves it: URLs, type and a meta that may be wrong.
async function addRow(
	store: StoreStub,
	options: { contentType?: string; original?: Uint8Array | null; files?: boolean; gcAt?: string | null } = {}
): Promise<Row> {
	const id = mediaId()
	const token = randomToken()
	const contentType = options.contentType ?? 'image/png'
	const extension = contentType === 'image/png' ? 'png' : 'webp'
	await runInDurableObject(store, (_instance, state) => {
		state.storage.sql.exec(
			`INSERT INTO media_attachments (id, account_id, type, url, preview_url, file_token, content_type, meta,
				processed, gc_at)
			VALUES (?, ?, 'image', ?, ?, ?, ?, '{"original":{"width":1,"height":1},"small":{"width":1,"height":1}}', 1, ?)`,
			id,
			ACCOUNT,
			`https://kopje.test/media/${token}/full.${extension}`,
			`https://kopje.test/media/${token}/small.${extension}`,
			token,
			contentType,
			options.gcAt ?? null
		)
	})
	if (options.original !== null) {
		await env.MEDIA.put(`originals/${id}`, options.original ?? bytes(PNG_PLAIN))
	}
	if (options.files === true) {
		for (const variant of ['full', 'small']) {
			await env.MEDIA.put(`files/${token}/${variant}`, bytes(PNG_PLAIN), { httpMetadata: { contentType } })
		}
	}
	return { id, token }
}

async function meta(store: StoreStub, id: string): Promise<unknown> {
	return runInDurableObject(
		store,
		(_instance, state) =>
			JSON.parse(
				state.storage.sql.exec<{ meta: string }>('SELECT meta FROM media_attachments WHERE id = ?', id).one().meta
			) as unknown
	)
}

async function transforms(store: StoreStub): Promise<number> {
	return runInDurableObject(store, (_instance, state) => {
		const row = state.storage.sql
			.exec<{ value: string }>("SELECT value FROM kopje_state WHERE name LIKE 'images_transforms:%'")
			.toArray()[0]
		return Number(row?.value ?? '0')
	})
}

async function files(row: Row): Promise<boolean[]> {
	return Promise.all(['full', 'small'].map(async (v) => (await env.MEDIA.head(`files/${row.token}/${v}`)) !== null))
}

type Step = {
	counts: Record<string, number>
	problems: { id: string; outcome: string; detail?: string }[]
	done: boolean
	next: string | null
	stopped: string | null
}

describe('media rebuild (MEDIA-2, MEDIA-3)', () => {
	it('makes both files of rows that lack them and corrects meta to the real output sizes', async () => {
		const h = await setup()
		const wide = await addRow(h.store, { original: bytes(WIDE_PNG) })
		const rotated = await addRow(h.store, { contentType: 'image/webp', original: bytes(JPEG_ORIENTATION_6) })
		const response = await h.post(adminClaims(), '/admin/media/rebuild')
		expect(response.status).toBe(200)
		const step = (await response.json()) as Step
		expect(step).toMatchObject({ done: true, stopped: null, problems: [] })
		expect(step.counts).toMatchObject({ built: 2, 'skipped-existing': 0 })
		expect(await files(wide)).toEqual([true, true])
		expect(await meta(h.store, wide.id)).toEqual({
			original: { width: 3840, height: 960 },
			small: { width: 640, height: 160 },
		})
		// The served file is re-encoded (no metadata) and meta has its real, rotated, dimensions.
		const served = await h.request(`/media/${rotated.token}/full.webp`)
		expect(served.headers.get('content-type')).toBe('image/webp')
		const info = await h.codec.real.info(new Uint8Array(await served.arrayBuffer()))
		expect(await meta(h.store, rotated.id)).toMatchObject({ original: { width: info.width, height: info.height } })
		expect((await h.request(`/media/${wide.token}/small.png`)).status).toBe(200)
		// Charged as uploads are: two transformations each.
		expect(await transforms(h.store)).toBe(4)
	})

	it('skips rows whose files exist, so a second run changes nothing', async () => {
		const h = await setup()
		const existing = await addRow(h.store, { files: true })
		const missing = await addRow(h.store)
		const first = (await (await h.post(adminClaims(), '/admin/media/rebuild')).json()) as Step
		expect(first.counts).toMatchObject({ built: 1, 'skipped-existing': 1 })
		expect(await meta(h.store, existing.id)).toMatchObject({ original: { width: 1, height: 1 } })
		const calls = h.codec.calls
		const second = (await (await h.post(adminClaims(), '/admin/media/rebuild')).json()) as Step
		expect(second.counts).toMatchObject({ built: 0, 'skipped-existing': 2 })
		expect(h.codec.calls).toBe(calls)
		expect(await files(missing)).toEqual([true, true])
	})

	it('leaves out remote, doomed and unfinished rows', async () => {
		const h = await setup()
		const doomed = await addRow(h.store, { gcAt: new Date(NOW - 1000).toISOString() })
		const unfinished = await addRow(h.store)
		await runInDurableObject(h.store, (_instance, state) => {
			state.storage.sql.exec("UPDATE media_attachments SET processed = 0, url = '' WHERE id = ?", unfinished.id)
		})
		await runInDurableObject(h.store, (_instance, state) => {
			state.storage.sql.exec(
				`INSERT INTO media_attachments (id, account_id, type, url) VALUES (?, ?, 'image', 'https://remote.test/a.png')`,
				mediaId(),
				ACCOUNT
			)
		})
		const step = (await (await h.post(adminClaims(), '/admin/media/rebuild')).json()) as Step
		expect(step.counts).toMatchObject({ built: 0, 'skipped-existing': 0, 'original-missing': 0 })
		expect(await files(doomed)).toEqual([false, false])
		expect(await files(unfinished)).toEqual([false, false])
	})

	it('reports a missing original and a type mismatch, and builds the rest', async () => {
		const h = await setup()
		const missing = await addRow(h.store, { original: null })
		// The row says WebP, but a PNG original is served as PNG: its URLs would be wrong, so it is not rebuilt.
		const mismatch = await addRow(h.store, { contentType: 'image/webp', original: bytes(PNG_PLAIN) })
		const good = await addRow(h.store)
		const step = (await (await h.post(adminClaims(), '/admin/media/rebuild')).json()) as Step
		expect(step.counts).toMatchObject({ built: 1, 'original-missing': 1, 'type-mismatch': 1 })
		expect(step.problems).toEqual([
			{ id: missing.id, outcome: 'original-missing' },
			{ id: mismatch.id, outcome: 'type-mismatch', detail: 'image/png is served as image/png' },
		])
		expect(await files(missing)).toEqual([false, false])
		expect(await files(mismatch)).toEqual([false, false])
		expect(await meta(h.store, mismatch.id)).toMatchObject({ original: { width: 1, height: 1 } })
		expect(await files(good)).toEqual([true, true])
		// Only the good row was charged.
		expect(await transforms(h.store)).toBe(2)
	})

	it('stops on the Images quota (9422) and on the monthly budget, leaving the row for the next run', async () => {
		const codec = new TestCodec()
		codec.failEncode = 9422
		const h = await setup({ codec })
		const row = await addRow(h.store)
		const quota = (await (await h.post(adminClaims(), '/admin/media/rebuild')).json()) as Step
		expect(quota).toMatchObject({ stopped: 'quota', done: false, next: null })
		expect(await files(row)).toEqual([false, false])

		const budget = await setup({ env: { IMAGES_MONTHLY_TRANSFORMS: '1' } })
		const unbuilt = await addRow(budget.store)
		const spent = (await (await budget.post(adminClaims(), '/admin/media/rebuild')).json()) as Step
		expect(spent).toMatchObject({ stopped: 'budget', done: false })
		expect(budget.codec.calls).toBe(0)
		expect(await files(unbuilt)).toEqual([false, false])
	})

	it('looks at bounded pages and builds a bounded number per call, resuming after `next`', async () => {
		const h = await setup()
		const rows: Row[] = []
		for (let i = 0; i < MAX_BUILDS_PER_CALL + REBUILD_PAGE + 2; i++) {
			rows.push(await addRow(h.store, { files: i >= MAX_BUILDS_PER_CALL + 1 }))
		}
		const first = (await (await h.post(adminClaims(), '/admin/media/rebuild')).json()) as Step
		expect(first.counts).toMatchObject({ built: MAX_BUILDS_PER_CALL })
		expect(first).toMatchObject({ done: false, next: rows[MAX_BUILDS_PER_CALL - 1]?.id })
		const second = (await (await h.post(adminClaims(), '/admin/media/rebuild', { after: first.next })).json()) as Step
		expect(second.counts).toMatchObject({ built: 1, 'skipped-existing': REBUILD_PAGE - 1 })
		expect(second).toMatchObject({ done: false, next: rows[MAX_BUILDS_PER_CALL + REBUILD_PAGE - 1]?.id })
		const third = (await (await h.post(adminClaims(), '/admin/media/rebuild', { after: second.next })).json()) as Step
		expect(third).toMatchObject({ done: true, counts: { 'skipped-existing': 2 } })
		for (const row of rows) {
			expect(await files(row)).toEqual([true, true])
		}
	})

	it('dry run reports without charging, encoding or writing', async () => {
		const h = await setup()
		const row = await addRow(h.store)
		await addRow(h.store, { original: null })
		const step = (await (await h.post(adminClaims(), '/admin/media/rebuild', { dryRun: true })).json()) as Step
		expect(step.counts).toMatchObject({ 'would-build': 1, built: 0, 'original-missing': 1 })
		expect(h.codec.calls).toBe(0)
		expect(await transforms(h.store)).toBe(0)
		expect(await files(row)).toEqual([false, false])
	})
})

describe('media rebuild and the operator gate (OPS-8)', () => {
	function flags(overrides: Partial<OperatorFlags>): OperatorFlags {
		return {
			maintenance: null,
			dump: null,
			import: null,
			import_receipt: null,
			import_reset: null,
			published: null,
			unpublished: null,
			...overrides,
		}
	}

	it('admits only the rebuild in readonly maintenance and while unpublished; never during an import or a dump', () => {
		const readonly = flags({ maintenance: { mode: 'readonly', at: NOW } })
		const unpublished = flags({ unpublished: { at: NOW, import: 'i' } })
		for (const held of [readonly, unpublished]) {
			expect(() => admitFlags(held, 'media-rebuild', NOW)).not.toThrow()
			expect(() => admitFlags(held, 'write', NOW)).toThrow()
		}
		expect(() => admitFlags(flags({ import: {} as never }), 'media-rebuild', NOW)).toThrow(/import-in-progress/)
		const dump = flags({ dump: { leaseUntil: NOW + 60_000 } as never })
		expect(() => admitFlags(dump, 'media-rebuild', NOW)).toThrow(/dump-in-progress/)
	})

	it('rebuilds in a Store that is unpublished or in readonly maintenance, where other writes stay refused', async () => {
		const h = await setup()
		await runInDurableObject(h.store, (_instance, state) => {
			state.storage.sql.exec(
				"INSERT INTO kopje_state (name, value) VALUES ('unpublished', ?)",
				JSON.stringify({ at: NOW, import: 'i' })
			)
		})
		const unpublished = await addRow(h.store, { original: bytes(WIDE_PNG) })
		expect(((await (await h.post(adminClaims(), '/admin/media/rebuild')).json()) as Step).counts.built).toBe(1)
		expect(await meta(h.store, unpublished.id)).toMatchObject({ original: { width: 3840, height: 960 } })
		const refused = await rejectionOf(h.store.expiredMedia(BUILD, { now: NOW, limit: 1 }))
		expect(toStoreUnavailable(refused)?.reason).toBe('unpublished')

		await runInDurableObject(h.store, (_instance, state) => {
			state.storage.sql.exec("DELETE FROM kopje_state WHERE name = 'unpublished'")
		})
		await h.store.setMaintenance(BUILD, true)
		const readonly = await addRow(h.store)
		expect(((await (await h.post(adminClaims(), '/admin/media/rebuild')).json()) as Step).counts.built).toBe(1)
		expect(await files(readonly)).toEqual([true, true])
		const stillRefused = await rejectionOf(h.store.expiredMedia(BUILD, { now: NOW, limit: 1 }))
		expect(toStoreUnavailable(stillRefused)?.reason).toBe('maintenance')
	})

	it('is refused while a dump holds the Store', async () => {
		const h = await setup()
		await addRow(h.store)
		expect((await h.store.dumpStart(BUILD)).ok).toBe(true)
		const response = await h.post(adminClaims(), '/admin/media/rebuild')
		expect(response.status).toBe(503)
		expect(await response.json()).toMatchObject({ code: 'dump-in-progress' })
	})
})

describe('media rebuild authorization', () => {
	it('is for the Access admin only: not anonymous, another identity, the import token or a session', async () => {
		const token = 'import-token-0123456789abcdef0123456789'
		const h = await setup({ env: { IMPORT_TOKEN: token } })
		const row = await addRow(h.store)
		const post = (headers: Record<string, string>) =>
			h.request('/admin/media/rebuild', { method: 'POST', headers, body: '{}' })
		expect((await post({})).status).toBe(401)
		expect((await post({ 'Kopje-Import-Token': token })).status).toBe(403)
		expect((await post({ 'Kopje-Import-Session': 'A'.repeat(43) })).status).toBe(403)
		expect((await h.post({ email: 'someone@kopje.test' }, '/admin/media/rebuild')).status).toBe(403)
		expect(await files(row)).toEqual([false, false])
		expect((await h.post(serviceClaims(), '/admin/media/rebuild')).status).toBe(200)
		expect(await files(row)).toEqual([true, true])
	})

	it('has the Store check the admin again where it writes', async () => {
		const h = await setup()
		const charge = (authority: Parameters<StoreStub['chargeMediaRebuild']>[1]['authority']) =>
			h.store.chargeMediaRebuild(BUILD, { authority, limit: 100, now: NOW })
		expect(await charge({ kind: 'import-token' })).toMatchObject({ status: 'denied' })
		expect(await charge({ ...ACCESS, teamDomain: team.teamDomain, aud: 'another-app' })).toMatchObject({
			status: 'denied',
		})
		expect(await charge({ ...ACCESS, teamDomain: team.teamDomain, email: 'someone@kopje.test' })).toMatchObject({
			status: 'denied',
		})
		expect(await charge({ ...ACCESS, teamDomain: team.teamDomain })).toEqual({ status: 'ok' })
		expect(await transforms(h.store)).toBe(2)
	})
})

describe('kopje-admin media-rebuild', () => {
	async function cli(h: Awaited<ReturnType<typeof setup>>, argv: string[]) {
		const out: string[] = []
		const err: string[] = []
		const fetch = async (input: string, init?: RequestInit) => {
			const headers = new Headers(init?.headers)
			headers.delete('CF-Access-Client-Id')
			headers.delete('CF-Access-Client-Secret')
			return h.as(serviceClaims(), new URL(input).pathname, { ...init, headers })
		}
		const code = await run({
			argv,
			env: {
				KOPJE_ADMIN_URL: 'https://admin.kopje.test',
				CF_ACCESS_CLIENT_ID: 'id',
				CF_ACCESS_CLIENT_SECRET: 'secret',
			},
			io: memoryIO(),
			stdout: { write: (text: string) => void out.push(text), isTTY: false },
			stderr: { write: (text: string) => void err.push(text), isTTY: false },
			fetch,
		})
		return { code, out: out.join(''), err: err.join('') }
	}

	it('runs to the end and exits 0, or 3 when rows need a decision or it stopped', async () => {
		const h = await setup()
		for (let i = 0; i < MAX_BUILDS_PER_CALL + 1; i++) {
			await addRow(h.store)
		}
		const dry = await cli(h, ['media-rebuild', '--dry-run'])
		expect(dry.code).toBe(0)
		expect(JSON.parse(dry.out)).toMatchObject({ dryRun: true, 'would-build': MAX_BUILDS_PER_CALL + 1, built: 0 })
		const done = await cli(h, ['media-rebuild'])
		expect(done.code).toBe(0)
		expect(JSON.parse(done.out)).toMatchObject({
			built: MAX_BUILDS_PER_CALL + 1,
			'skipped-existing': 0,
			'original-missing': 0,
			'type-mismatch': 0,
			'quota-stopped': false,
		})
		const missing = await addRow(h.store, { original: null })
		const decide = await cli(h, ['media-rebuild'])
		expect(decide.code).toBe(3)
		expect(JSON.parse(decide.out)).toMatchObject({
			'skipped-existing': MAX_BUILDS_PER_CALL + 1,
			'original-missing': 1,
			problems: [{ id: missing.id, outcome: 'original-missing' }],
		})
		h.codec.failEncode = 9422
		await addRow(h.store)
		const stopped = await cli(h, ['media-rebuild'])
		expect(stopped.code).toBe(3)
		expect(JSON.parse(stopped.out)).toMatchObject({ 'quota-stopped': true, stopped: 'quota' })
		expect(stopped.err).toContain('9422')
		expect((await cli(h, ['media-rebuild', 'extra'])).code).toBe(2)
	})
})
