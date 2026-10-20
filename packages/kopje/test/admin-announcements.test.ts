import { env } from 'cloudflare:workers'

import { beforeEach, describe, expect, it } from 'vitest'

import { adminClaims, adminHarness, adminTeam, setTeamAccess, type AccessTeam } from './access-helpers'
import { announcementAdmin, seedAnnouncement, T0 } from './announcement-helpers'
import { seedAccount, sql } from './api-helpers'
import { BUILD, completeSetup, migratedStore } from './helpers'
import { ACCESS, setAccess } from './ops-helpers'
import type { AnnouncementInput } from '../src/domain/announcements'
import { handleScheduled } from '../src/jobs/scheduled'
import type { StoreStub } from '../src/platform/store-client'

// The Access admin's announcements (domain/announcements.ts, app/admin.ts /admin/announcements): Mastodon's
// Admin::AnnouncementsController semantics, each write logged (VIS-29, AUTH-5), the caps (RES-4), and the cron's round
// of scheduled publication and expiry (RES-6).

const FUTURE = '2099-01-01T00:00:00.000Z'
const id = (n: number) => String(200_000_000_000_000_000n + BigInt(n))

async function adminStore(): Promise<StoreStub> {
	const store = await migratedStore()
	await setAccess(store)
	await completeSetup(store)
	return store
}

const base: AnnouncementInput = { text: 'hello', startsAt: null, endsAt: null, allDay: false, scheduledAt: null }

async function log(store: StoreStub) {
	return sql<{ action: string; target_type: string; target_id: string; detail: string }>(
		store,
		'SELECT action, target_type, target_id, detail FROM admin_actions ORDER BY id'
	)
}

describe('the Access admin’s writes', () => {
	it('creates, changes, publishes, unpublishes and deletes as Mastodon does, each logged', async () => {
		const store = await adminStore()
		const admin = announcementAdmin(store)
		const before = new Date().toISOString()
		const now = await admin.create({ text: 'now', scheduledAt: '2020-01-01T00:00:00.000Z' })
		// Published now, its past schedule cleared (Announcement#set_published).
		expect(now).toMatchObject({ published: true, scheduled_at: null, text: 'now' })
		expect(now.published_at! >= before).toBe(true)
		expect(now.created_at).toBe(now.published_at)
		const later = await admin.create({ text: 'later', scheduledAt: FUTURE })
		expect(later).toMatchObject({ published: false, published_at: null, scheduled_at: FUTURE })
		// An update keeps published_at and sets updated_at; changing nothing logs nothing.
		await new Promise((resolve) => setTimeout(resolve, 5))
		const changed = await admin.update(now.id, {
			text: 'changed',
			startsAt: '2026-11-01T00:00:00.000Z',
			endsAt: '2026-11-01T00:00:00.000Z',
			allDay: true,
		})
		expect(changed).toMatchObject({ text: 'changed', published_at: now.published_at, all_day: true })
		expect(changed.updated_at > now.updated_at).toBe(true)
		expect(await admin.update(now.id, { text: 'changed', allDay: true })).toEqual(changed)
		expect(
			await store.updateAnnouncement(BUILD, { authority: ACCESS, id: now.id, changes: { scheduledAt: FUTURE } })
		).toMatchObject({
			ok: false,
			code: 'announcement-published',
		})
		// Publishing sets published_at to now, even when published, and clears the schedule.
		await new Promise((resolve) => setTimeout(resolve, 5))
		const republished = await admin.publish(now.id)
		expect(republished.published_at! > now.published_at!).toBe(true)
		const published = await admin.publish(later.id)
		expect(published).toMatchObject({ published: true, scheduled_at: null })
		expect(await admin.unpublish(later.id)).toMatchObject({ published: false, scheduled_at: null })
		// An unpublished row may be scheduled, and unscheduled.
		expect(await admin.update(later.id, { scheduledAt: FUTURE })).toMatchObject({ scheduled_at: FUTURE })
		expect(await admin.update(later.id, { scheduledAt: null })).toMatchObject({ scheduled_at: null })
		// Delete cascades to reactions and dismissals; the log keeps 200 code units of the text.
		const long = await admin.create({ text: `${'x'.repeat(199)}\u{1F600}yz` })
		const alice = await seedAccount(store, { username: 'alice', email: 'alice@example.com' })
		await sql(
			store,
			"INSERT INTO announcement_reactions (announcement_id, account_id, name) VALUES (?, ?, '👍')",
			long.id,
			alice
		)
		await sql(store, 'INSERT INTO announcement_dismissals (account_id, announcement_id) VALUES (?, ?)', alice, long.id)
		expect(await admin.remove(long.id)).toBe(long.id)
		expect(await sql(store, 'SELECT count(*) AS n FROM announcement_reactions')).toEqual([{ n: 0 }])
		expect(await sql(store, 'SELECT count(*) AS n FROM announcement_dismissals')).toEqual([{ n: 0 }])
		const rows = await log(store)
		expect(rows.map((row) => [row.action, row.target_type, row.target_id])).toEqual([
			['create', 'Announcement', now.id],
			['create', 'Announcement', later.id],
			['update', 'Announcement', now.id],
			['publish', 'Announcement', now.id],
			['publish', 'Announcement', later.id],
			['unpublish', 'Announcement', later.id],
			['update', 'Announcement', later.id],
			['update', 'Announcement', later.id],
			['create', 'Announcement', long.id],
			['delete', 'Announcement', long.id],
		])
		expect(JSON.parse(rows[2]!.detail)).toEqual({
			excerpt: 'changed',
			changed: ['text', 'startsAt', 'endsAt', 'allDay'],
			identity: ACCESS.email,
		})
		// A surrogate pair is never split: 199 units, then the pair would pass 200.
		expect(JSON.parse(rows.at(-1)!.detail).excerpt).toBe('x'.repeat(199))
		expect(await store.adminAnnouncements(BUILD, {})).toMatchObject({
			announcements: [{ id: later.id }, { id: now.id }],
			next: null,
		})
	})

	it('judges the text, the times and the range, the writer as the CHECKs do', async () => {
		const store = await adminStore()
		const create = (input: Partial<typeof base>) =>
			store.createAnnouncement(BUILD, { authority: ACCESS, ...base, ...input })
		for (const text of ['', ' ', '　', '\t\n', 'a\u0000', 'x'.repeat(10_001), '日'.repeat(3334)]) {
			expect(await create({ text }), JSON.stringify(text.slice(0, 8))).toMatchObject({
				ok: false,
				code: 'invalid-text',
			})
		}
		for (const text of ['x'.repeat(10_000), '\u{1F600}'.repeat(2500), '日'.repeat(3333)]) {
			expect((await create({ text })).ok).toBe(true)
		}
		// A lone surrogate is stored as U+FFFD.
		const lone = await create({ text: 'a\uD83D' })
		expect(lone).toMatchObject({ ok: true, announcement: { text: 'a�' } })
		const times = [
			{ startsAt: T0, endsAt: null },
			{ startsAt: null, endsAt: T0 },
			{ startsAt: '2026-10-12T00:00:00.001Z', endsAt: T0 },
			{ startsAt: '2026-10-12T00:00:00Z', endsAt: '2026-10-12T00:00:00Z' },
			{ scheduledAt: '2026-10-12 00:00' },
		]
		for (const input of times) {
			expect(await create(input), JSON.stringify(input)).toMatchObject({ ok: false, code: 'invalid-times' })
		}
		expect((await create({ startsAt: T0, endsAt: T0 })).ok).toBe(true)
	})

	it('holds 16 live and 1,000 in all on every write that adds one (writer and trigger agree)', async () => {
		const store = await adminStore()
		const admin = announcementAdmin(store)
		const limit = { ok: false, code: 'announcement-limit' }
		for (let i = 0; i < 8; i++) {
			await admin.create()
			await admin.create({ scheduledAt: FUTURE })
		}
		expect(await store.createAnnouncement(BUILD, { authority: ACCESS, ...base })).toMatchObject(limit)
		expect(await store.createAnnouncement(BUILD, { authority: ACCESS, ...base, scheduledAt: FUTURE })).toMatchObject(
			limit
		)
		await seedAnnouncement(store, { id: id(1), text: 'draft', published: 0, published_at: null })
		expect(await store.publishAnnouncement(BUILD, { authority: ACCESS, id: id(1) })).toMatchObject(limit)
		expect(
			await store.updateAnnouncement(BUILD, { authority: ACCESS, id: id(1), changes: { scheduledAt: FUTURE } })
		).toMatchObject(limit)
		// A published one is published again; a scheduled one is published (no new live row).
		const listed = (await store.adminAnnouncements(BUILD, { limit: 50 })).announcements
		await admin.publish(listed.find((a) => a.published)!.id)
		await admin.publish(listed.find((a) => a.scheduled_at !== null)!.id)
		await admin.unpublish(listed.find((a) => a.published)!.id)
		await admin.publish(id(1))
		// 1,000 in all.
		await sql(
			store,
			`WITH RECURSIVE n(i) AS (SELECT 2 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO announcements (id, text, created_at, updated_at)
			SELECT CAST(200000000000000000 + i AS TEXT), 'x', ?2, ?2 FROM n`,
			1000 - 17 + 1,
			T0
		)
		expect(await sql(store, 'SELECT count(*) AS n FROM announcements')).toEqual([{ n: 1000 }])
		await admin.unpublish(id(1))
		expect(await store.createAnnouncement(BUILD, { authority: ACCESS, ...base })).toMatchObject({
			ok: false,
			code: 'announcement-limit',
			message: 'at most 1000 announcements are kept; delete one first',
		})
	}, 60_000)

	it('answers announcement-not-found and refuses every authority but Access', async () => {
		const store = await adminStore()
		const missing = { ok: false, code: 'announcement-not-found' }
		const input = { authority: ACCESS, id: id(9) }
		expect(await store.updateAnnouncement(BUILD, { ...input, changes: { text: 'x' } })).toMatchObject(missing)
		expect(await store.publishAnnouncement(BUILD, input)).toMatchObject(missing)
		expect(await store.unpublishAnnouncement(BUILD, input)).toMatchObject(missing)
		expect(await store.deleteAnnouncement(BUILD, input)).toMatchObject(missing)
		const { id: existing } = await announcementAdmin(store).create()
		for (const authority of [{ kind: 'import-token' } as const, { kind: 'import-session', secret: 'x' } as const]) {
			const refused = { ok: false, code: 'wrong-authority' }
			expect(await store.createAnnouncement(BUILD, { authority, ...base })).toMatchObject(refused)
			expect(await store.updateAnnouncement(BUILD, { authority, id: existing, changes: { text: 'x' } })).toMatchObject(
				refused
			)
			expect(await store.publishAnnouncement(BUILD, { authority, id: existing })).toMatchObject(refused)
			expect(await store.unpublishAnnouncement(BUILD, { authority, id: existing })).toMatchObject(refused)
			expect(await store.deleteAnnouncement(BUILD, { authority, id: existing })).toMatchObject(refused)
		}
		// Another Access identity than the configured admin is refused too.
		expect(
			await store.createAnnouncement(BUILD, { authority: { ...ACCESS, email: 'other@example.com' }, ...base })
		).toMatchObject({ ok: false, code: 'wrong-authority' })
		expect((await log(store)).map((row) => row.action)).toEqual(['create'])
	})
})

describe('/admin/announcements', () => {
	let team: AccessTeam

	beforeEach(async () => {
		team = await adminTeam()
	})

	async function harness() {
		const store = await adminStore()
		await setTeamAccess(store, team)
		return { store, ...adminHarness(store, team, { IMPORT_TOKEN: 'import-token-0123456789abcdef0123456789' }) }
	}

	it('creates, lists a page at a time, changes, publishes, unpublishes and deletes', async () => {
		const { post, as } = await harness()
		const json = async (response: Response) =>
			[response.status, await response.json<Record<string, unknown>>()] as const
		const [status, created] = await json(
			await post(adminClaims(), '/admin/announcements', {
				text: 'Hello',
				startsAt: '2026-11-01',
				endsAt: '2026-11-02T09:00:00+09:00',
				allDay: true,
				scheduledAt: '2099-01-01T09:00:00+09:00',
			})
		)
		expect(status).toBe(200)
		expect(created).toMatchObject({
			text: 'Hello',
			published: false,
			starts_at: '2026-11-01T00:00:00.000Z',
			ends_at: '2026-11-02T00:00:00.000Z',
			all_day: true,
			scheduled_at: FUTURE,
		})
		const announcementId = created.id as string
		expect(
			await json(await post(adminClaims(), `/admin/announcements/${announcementId}`, { scheduledAt: null }))
		).toEqual([200, expect.objectContaining({ scheduled_at: null })])
		expect(await json(await post(adminClaims(), `/admin/announcements/${announcementId}/publish`))).toEqual([
			200,
			expect.objectContaining({ published: true }),
		])
		expect(await json(await post(adminClaims(), `/admin/announcements/${announcementId}/unpublish`))).toEqual([
			200,
			expect.objectContaining({ published: false }),
		])
		for (let i = 0; i < 2; i++) {
			await post(adminClaims(), '/admin/announcements', { text: `n${i}` })
		}
		const first = await (
			await as(adminClaims(), '/admin/announcements?limit=2')
		).json<{
			announcements: { id: string; text: string }[]
			next: string | null
		}>()
		expect(first.announcements.map((a) => a.text)).toEqual(['n1', 'n0'])
		const second = await (
			await as(adminClaims(), `/admin/announcements?limit=2&before=${first.next}`)
		).json<{
			announcements: { id: string }[]
			next: string | null
		}>()
		expect(second).toEqual({ announcements: [expect.objectContaining({ id: announcementId })], next: null })
		expect(await json(await post(adminClaims(), `/admin/announcements/${announcementId}/delete`))).toEqual([
			200,
			{ deleted: announcementId },
		])
		expect((await as(adminClaims(), '/admin/announcements?before=x')).status).toBe(400)
	})

	it('answers each refusal with its status', async () => {
		const { post } = await harness()
		const status = async (path: string, body: unknown) => {
			const response = await post(adminClaims(), path, body)
			return [response.status, (await response.json<{ code?: string }>()).code]
		}
		expect(await status('/admin/announcements', {})).toEqual([400, 'invalid-text'])
		expect(await status('/admin/announcements', { text: ' ' })).toEqual([400, 'invalid-text'])
		expect(await status('/admin/announcements', { text: 7 })).toEqual([400, 'invalid-text'])
		expect(await status('/admin/announcements', { text: 'x', startsAt: 'soon', endsAt: null })).toEqual([
			400,
			'invalid-times',
		])
		expect(await status('/admin/announcements', { text: 'x', startsAt: '2026-11-01' })).toEqual([400, 'invalid-times'])
		expect(await status('/admin/announcements', { text: 'x', allDay: 'yes' })).toEqual([400, 'invalid-times'])
		expect(await status('/admin/announcements', { text: 'x', scheduledAt: 1 })).toEqual([400, 'invalid-times'])
		expect(await status(`/admin/announcements/${id(9)}`, { text: 'x' })).toEqual([404, 'announcement-not-found'])
		expect(await status(`/admin/announcements/${id(9)}/publish`, {})).toEqual([404, 'announcement-not-found'])
		const created = await (await post(adminClaims(), '/admin/announcements', { text: 'x' })).json<{ id: string }>()
		expect(await status(`/admin/announcements/${created.id}`, { scheduledAt: FUTURE })).toEqual([
			409,
			'announcement-published',
		])
		for (let i = 0; i < 15; i++) {
			await post(adminClaims(), '/admin/announcements', { text: 'x' })
		}
		expect(await status('/admin/announcements', { text: 'x' })).toEqual([409, 'announcement-limit'])
		// 10,000 three-byte URLs' worth of links: past 64 KiB of content.
		await post(adminClaims(), `/admin/announcements/${created.id}/delete`)
		const links = 'https://example.com/&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&& '
		expect(await status('/admin/announcements', { text: links.repeat(Math.floor(10_000 / links.length)) })).toEqual([
			422,
			'content-too-large',
		])
	})

	it('is refused for the import token and import sessions', async () => {
		const { request } = await harness()
		for (const headers of [
			{ 'Kopje-Import-Token': 'import-token-0123456789abcdef0123456789' },
			{ 'Kopje-Import-Session': 'a'.repeat(43) },
		] as Record<string, string>[]) {
			for (const [method, path] of [
				['GET', '/admin/announcements'] as const,
				['POST', '/admin/announcements'],
				['POST', `/admin/announcements/${id(1)}`],
				['POST', `/admin/announcements/${id(1)}/delete`],
			]) {
				const response = await request(path, {
					method,
					headers: { ...headers, 'content-type': 'application/json' },
					...(method === 'POST' ? { body: JSON.stringify({ text: 'x' }) } : {}),
				})
				expect(response.status, `${method} ${path}`).toBe(403)
			}
		}
	})
})

describe('the cron’s round', () => {
	const cron = (store: StoreStub, now: number) =>
		handleScheduled({ ...env, MAINTENANCE: 'off' } as unknown as Env, {
			build: () => BUILD,
			now: () => now,
			store: () => store,
		})

	it('publishes what is due at scheduled_at, and takes down what ended keeping updated_at, journaling nothing for it', async () => {
		const store = await adminStore()
		const admin = announcementAdmin(store)
		const scheduled = await admin.create({ scheduledAt: FUTURE })
		const ending = await admin.create({ startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2098-12-31T23:59:59.999Z' })
		// A user listens on `user`, so writes are journaled.
		await sql(
			store,
			"INSERT INTO stream_subscriptions (account_id, stream_key, sockets) VALUES ('100000000000000001', 'user', 1)"
		)
		await cron(store, Date.parse(FUTURE) - 1)
		expect(await sql(store, 'SELECT published FROM announcements WHERE id = ?', scheduled.id)).toEqual([
			{ published: 0 },
		])
		expect(await sql(store, 'SELECT kind, subject FROM stream_events')).toEqual([])
		await cron(store, Date.parse(FUTURE))
		const rows = await store.adminAnnouncements(BUILD, {})
		expect(rows.announcements).toEqual([
			{
				...ending,
				published: false,
				scheduled_at: null,
			},
			{
				...scheduled,
				published: true,
				published_at: FUTURE,
				scheduled_at: null,
				updated_at: FUTURE,
			},
		])
		expect(await sql(store, 'SELECT kind, subject FROM stream_events')).toEqual([
			{ kind: 'announcement', subject: scheduled.id },
		])
	})

	it('publishes a schedule at the live cap, and waits while the Store is in maintenance', async () => {
		const store = await adminStore()
		const admin = announcementAdmin(store)
		for (let i = 0; i < 15; i++) {
			await admin.create()
		}
		const last = await admin.create({ scheduledAt: FUTURE })
		await store.setMaintenance(BUILD, true)
		await cron(store, Date.parse(FUTURE))
		expect(await sql(store, 'SELECT published FROM announcements WHERE id = ?', last.id)).toEqual([{ published: 0 }])
		await store.setMaintenance(BUILD, false)
		await cron(store, Date.parse(FUTURE))
		expect(await sql(store, 'SELECT published, published_at FROM announcements WHERE id = ?', last.id)).toEqual([
			{ published: 1, published_at: FUTURE },
		])
		expect(await sql(store, 'SELECT count(*) AS n FROM announcements WHERE published = 1')).toEqual([{ n: 16 }])
	})

	it('imports past schedules, which the next round publishes', async () => {
		const store = await adminStore()
		await seedAnnouncement(store, { id: id(1), text: 'old', published: 0, published_at: null, scheduled_at: T0 })
		await cron(store, Date.parse(T0) + 1)
		expect(await sql(store, 'SELECT published, published_at FROM announcements')).toEqual([
			{ published: 1, published_at: T0 },
		])
	})
})
