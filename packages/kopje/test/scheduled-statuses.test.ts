import { runInDurableObject } from 'cloudflare:test'

import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'

import { type ApiHarness, bearer, json, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { BUILD } from './helpers'
import {
	community,
	follow,
	getJson,
	ids,
	post,
	remoteAccount,
	remoteFollows,
	type Status,
	type User,
} from './status-helpers'
import { expiredMedia } from '../src/domain/media'
import {
	DAILY_LIMIT,
	MAX_ATTEMPTS,
	PUBLISH_ROUND,
	publishScheduled as publishOne,
	RETRY_DELAYS_MS,
	TOTAL_LIMIT,
} from '../src/domain/scheduled-statuses'
import { publishScheduled } from '../src/jobs/scheduled'
import { parseScheduledAt } from '../src/mastodon/statuses'
import { sha256Hex } from '../src/security/tokens'

// Scheduled statuses (domain/scheduled-statuses.ts, mastodon/scheduled-statuses.ts), as Mastodon 4.5 has them:
// POST /api/v1/statuses with scheduled_at, the scheduled_statuses endpoints, ScheduledStatus's validations and limits,
// the media they hold, and the cron's publication through the path of an ordinary post.

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

type Scheduled = {
	id: string
	scheduled_at: string
	params: Record<string, unknown>
	media_attachments: { id: string }[]
}

const at = (ms: number) => new Date(ms).toISOString()

async function schedule(
	h: ApiHarness,
	user: User,
	body: Record<string, unknown>,
	headers: Record<string, string> = {}
): Promise<Response> {
	return h.request('/api/v1/statuses', bearer(user.token, json(body, { headers })))
}

async function scheduled(h: ApiHarness, user: User, body: Record<string, unknown>): Promise<Scheduled> {
	const response = await schedule(h, user, body)
	expect(response.status, await response.clone().text()).toBe(200)
	return response.json()
}

function send(h: ApiHarness, user: User, method: string, path: string, body: Record<string, unknown> = {}) {
	return h.request(path, bearer(user.token, json(body, { method })))
}

async function refusal(response: Response): Promise<{ status: number; body: unknown }> {
	return { status: response.status, body: await response.json() }
}

// A completed, unattached upload of the user's, attachable for a day.
async function upload(h: ApiHarness, user: User, n: number): Promise<string> {
	const id = String(800000000000000000n + BigInt(n))
	await sql(
		h.store,
		`INSERT INTO media_attachments (id, account_id, type, url, file_token, processed, gc_at)
		VALUES (?, ?, 'image', ?, ?, 1, ?)`,
		id,
		user.id,
		`https://kopje.test/files/t${n}/full`,
		`t${n}`,
		at(NOW + DAY)
	)
	return id
}

function round(h: ApiHarness, now: number, doorbell = vi.fn(() => Promise.resolve())) {
	return publishScheduled(h.env, { build: () => BUILD, now: () => now, store: () => h.store, doorbell })
}

async function count(h: ApiHarness, table: string): Promise<number> {
	return (await sql<{ n: number }>(h.store, `SELECT count(*) AS n FROM ${table}`))[0]?.n ?? 0
}

describe('scheduling a status', () => {
	it('answers a ScheduledStatus, as REST::ScheduledStatusSerializer shows it, and shows it to its owner', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const parent = await post(h, alice, { status: 'first' })
		const media = await upload(h, alice, 1)
		const when = at(NOW + HOUR)
		const created = await scheduled(h, alice, {
			status: 'later',
			scheduled_at: when,
			in_reply_to_id: parent.id,
			media_ids: [media],
			language: 'en',
			sensitive: 'true',
		})
		expect(created).toEqual({
			id: expect.stringMatching(/^\d{18}$/),
			scheduled_at: when,
			params: {
				text: 'later',
				poll: null,
				media_ids: [media],
				sensitive: true,
				spoiler_text: '',
				visibility: null,
				language: 'en',
				scheduled_at: null,
				in_reply_to_id: parent.id,
				application_id: null,
				idempotency: null,
				with_rate_limit: false,
				allowed_mentions: null,
				quoted_status_id: null,
				// None was sent: alice's default, resolved when it was scheduled.
				quote_approval_policy: 'public',
			},
			media_attachments: [expect.objectContaining({ id: media, type: 'image' })],
		})
		expect(await getJson(h, `/api/v1/scheduled_statuses/${created.id}`, alice.token)).toEqual({
			status: 200,
			body: created,
		})
		expect((await getJson(h, '/api/v1/scheduled_statuses', alice.token)).body).toEqual([created])
		// Not a status: nothing new to read.
		expect((await getJson(h, `/api/v1/statuses/${created.id}`, alice.token)).status).toBe(404)
		expect(await ids(h, '/api/v1/timelines/home', alice.token)).toEqual([parent.id])
	})

	it('posts at once when scheduled_at is not in the future, and refuses one too soon or unreadable', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const past = await schedule(h, alice, { status: 'now', scheduled_at: at(NOW - MINUTE) })
		expect(await past.json()).toMatchObject({ content: '<p>now</p>', visibility: 'public' })
		expect(await refusal(await schedule(h, alice, { status: 'soon', scheduled_at: at(NOW + 5 * MINUTE) }))).toEqual({
			status: 422,
			body: { error: 'Validation failed: Scheduled at date must be in the future' },
		})
		expect(await refusal(await schedule(h, alice, { status: 'x', scheduled_at: 'tomorrow' }))).toEqual({
			status: 422,
			body: { error: 'Record invalid' },
		})
		expect((await schedule(h, alice, { status: 'ok', scheduled_at: at(NOW + 5 * MINUTE + 1) })).status).toBe(200)
	})

	it('checks the post as an immediate one is checked', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const later = at(NOW + HOUR)
		const cases: [Record<string, unknown>, number, unknown][] = [
			[{ status: 'x'.repeat(501) }, 422, { error: 'Validation failed: Text character limit of 500 exceeded' }],
			[{ status: ' ' }, 422, { error: "Validation failed: Text can't be blank" }],
			[
				{ status: 'x', visibility: 'everyone' },
				422,
				{ error: 'Validation failed: Visibility is not included in the list' },
			],
			[
				{ status: 'x', 'poll[options][]': 'a' },
				422,
				{ error: "Validation failed: Deadline can't be blank, Choices must have more than one item" },
			],
			[{ status: 'x', media_ids: ['1', '2', '3', '4', '5'] }, 422, { error: 'Cannot attach more than 4 files' }],
			[
				{ status: 'x', in_reply_to_id: '999999999999999999' },
				404,
				{ error: 'The post you are trying to reply to does not appear to exist.' },
			],
		]
		for (const [body, status, error] of cases) {
			expect(await refusal(await schedule(h, alice, { ...body, scheduled_at: later })), JSON.stringify(body)).toEqual({
				status,
				body: error,
			})
		}
		expect(await count(h, 'scheduled_statuses')).toBe(0)
	})

	it(`allows ${TOTAL_LIMIT} in all and ${DAILY_LIMIT} a day, with Mastodon's messages`, async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const day = Date.parse('2026-10-20T00:00:00.000Z')
		// DAILY_LIMIT - 1 on the day, the rest the days after.
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO scheduled_statuses (id, account_id, scheduled_at, params)
			SELECT CAST(600000000000000000 + i AS TEXT), ?2,
				strftime('%Y-%m-%dT%H:%M:%fZ', ?3, '+' || (CASE WHEN i < ?4 THEN 0 ELSE i END) || ' days'), '{}' FROM n`,
			TOTAL_LIMIT - 2,
			alice.id,
			at(day + HOUR),
			DAILY_LIMIT - 1
		)
		const onDay = (hours: number) => ({ status: 'x', scheduled_at: at(day + hours * HOUR) })
		expect((await schedule(h, alice, onDay(23))).status).toBe(200)
		expect(await refusal(await schedule(h, alice, onDay(2)))).toEqual({
			status: 422,
			body: { error: `Validation failed: You have exceeded the limit of ${DAILY_LIMIT} scheduled posts for today` },
		})
		// The next UTC day has room; then the total is reached.
		expect((await schedule(h, alice, onDay(24))).status).toBe(200)
		expect(await refusal(await schedule(h, alice, onDay(-24 * 2)))).toEqual({
			status: 422,
			body: { error: `Validation failed: You have exceeded the limit of ${TOTAL_LIMIT} scheduled posts` },
		})
		expect(await refusal(await schedule(h, alice, { status: 'x', scheduled_at: at(NOW + MINUTE) }))).toEqual({
			status: 422,
			body: {
				error: `Validation failed: Scheduled at date must be in the future, You have exceeded the limit of ${TOTAL_LIMIT} scheduled posts`,
			},
		})
		// Another account's limits are its own.
		expect((await schedule(h, bob, onDay(2))).status).toBe(200)
	})

	it('answers a repeated Idempotency-Key with what the first request made', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const body = { status: 'once', scheduled_at: at(NOW + 10 * MINUTE) }
		const first = await (await schedule(h, alice, body, { 'Idempotency-Key': 'k1' })).json<Scheduled>()
		const again = await (await schedule(h, alice, body, { 'Idempotency-Key': 'k1' })).json<Scheduled>()
		expect(again).toEqual(first)
		expect(await count(h, 'scheduled_statuses')).toBe(1)
		// Once published, the repeat is answered with the status.
		await round(h, NOW + 10 * MINUTE)
		const published = await (await schedule(h, alice, body, { 'Idempotency-Key': 'k1' })).json<Status>()
		expect(published).toMatchObject({ content: '<p>once</p>' })
		expect(await count(h, 'statuses')).toBe(1)
		expect(await count(h, 'scheduled_statuses')).toBe(0)
	})
})

describe('an Idempotency-Key expires an hour after what it made', () => {
	const key = { 'Idempotency-Key': 'hour' }
	const keys = async (h: ApiHarness, table: string) =>
		(await sql<{ k: string | null }>(h.store, `SELECT client_key AS k FROM ${table} ORDER BY id`)).map((r) => r.k)

	it('answers the scheduled status within the hour; at the hour a repeat posts anew and frees the key', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const first = await (
			await schedule(h, alice, { status: 'later', scheduled_at: at(NOW + 3 * HOUR) }, key)
		).json<Scheduled>()
		h.now.mockReturnValue(NOW + HOUR - 1)
		expect(await (await schedule(h, alice, { status: 'again' }, key)).json()).toEqual(first)
		h.now.mockReturnValue(NOW + HOUR)
		const fresh = await schedule(h, alice, { status: 'again' }, key)
		expect(fresh.status).toBe(200)
		expect(await fresh.json()).toMatchObject({ content: '<p>again</p>' })
		const hash = await sha256Hex('hour')
		expect(await keys(h, 'scheduled_statuses')).toEqual([null])
		expect(await keys(h, 'statuses')).toEqual([hash])
		// The older scheduled status publishes without the key, which stays with the new status.
		await round(h, NOW + 3 * HOUR)
		expect(await count(h, 'scheduled_statuses')).toBe(0)
		expect(await keys(h, 'statuses')).toEqual([hash, null])
		h.now.mockReturnValue(NOW + HOUR + 1)
		expect(await (await schedule(h, alice, { status: 'third' }, key)).json()).toMatchObject({
			content: '<p>again</p>',
		})
	})

	it('a repeat that schedules again replaces the expired key without a unique error', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await scheduled(h, alice, { status: 'one', scheduled_at: at(NOW + 3 * HOUR) })
		await schedule(h, alice, { status: 'one', scheduled_at: at(NOW + 3 * HOUR) }, key)
		h.now.mockReturnValue(NOW + HOUR)
		const again = await schedule(h, alice, { status: 'two', scheduled_at: at(NOW + 4 * HOUR) }, key)
		expect(again.status).toBe(200)
		expect(await keys(h, 'scheduled_statuses')).toEqual([null, null, await sha256Hex('hour')])
	})

	it('keeps the key on a status published within the hour until an hour after the publication', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await schedule(h, alice, { status: 'soon', scheduled_at: at(NOW + 10 * MINUTE) }, key)
		await round(h, NOW + 10 * MINUTE)
		expect(await keys(h, 'statuses')).toEqual([await sha256Hex('hour')])
		h.now.mockReturnValue(NOW + 10 * MINUTE + HOUR - 1)
		expect(await (await schedule(h, alice, { status: 'repeat' }, key)).json()).toMatchObject({
			content: '<p>soon</p>',
		})
		h.now.mockReturnValue(NOW + 10 * MINUTE + HOUR)
		expect(await (await schedule(h, alice, { status: 'repeat' }, key)).json()).toMatchObject({
			content: '<p>repeat</p>',
		})
		expect(await keys(h, 'statuses')).toEqual([null, await sha256Hex('hour')])
	})

	it('publishes a status without the key when the key expired before the publication', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await schedule(h, alice, { status: 'late', scheduled_at: at(NOW + 3 * HOUR) }, key)
		await round(h, NOW + 3 * HOUR)
		expect(await keys(h, 'statuses')).toEqual([null])
		expect(await (await schedule(h, alice, { status: 'repeat' }, key)).json()).toMatchObject({
			content: '<p>repeat</p>',
		})
	})

	it('counts a restored created_at that is not a time Kopje writes as expired', async () => {
		for (const stored of ["'now'", "'not a time'", "strftime('%Y-%m-%dT%H:%M:%fZ', 'now') || char(0) || 'x'"]) {
			const h = await community(['alice'])
			const { alice } = h.users
			await schedule(h, alice, { status: 'kept', scheduled_at: at(NOW + 3 * HOUR) }, key)
			await sql(h.store, `UPDATE scheduled_statuses SET created_at = ${stored}`)
			const repeat = await schedule(h, alice, { status: 'anew' }, key)
			expect(await repeat.json(), stored).toMatchObject({ content: '<p>anew</p>' })
			expect(await keys(h, 'scheduled_statuses')).toEqual([null])
			// Published, it carries no key.
			await round(h, NOW + 3 * HOUR)
			expect(await keys(h, 'statuses')).toEqual([await sha256Hex('hour'), null])
		}
	})
})

describe('an Idempotency-Key shared by an immediate and a scheduled post', () => {
	it('answers a post without scheduled_at with the scheduled status the key reserved, and publishes once', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const key = { 'Idempotency-Key': 'shared' }
		const first = await (
			await schedule(h, alice, { status: 'once', scheduled_at: at(NOW + 10 * MINUTE) }, key)
		).json<Scheduled>()
		const now = await (await schedule(h, alice, { status: 'once' }, key)).json<Scheduled>()
		expect(now).toEqual(first)
		expect(await count(h, 'statuses')).toBe(0)
		await round(h, NOW + 10 * MINUTE)
		await round(h, NOW + 15 * MINUTE)
		expect(await count(h, 'statuses')).toBe(1)
		expect(await (await schedule(h, alice, { status: 'once' }, key)).json()).toMatchObject({ content: '<p>once</p>' })
		expect(await count(h, 'statuses')).toBe(1)
	})

	it('answers a scheduled post with the status the key already made, and schedules nothing', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const key = { 'Idempotency-Key': 'shared' }
		const posted = await (await schedule(h, alice, { status: 'once' }, key)).json<Status>()
		const again = await (await schedule(h, alice, { status: 'once', scheduled_at: at(NOW + HOUR) }, key)).json()
		expect(again).toMatchObject({ id: posted.id, content: '<p>once</p>' })
		expect(await count(h, 'scheduled_statuses')).toBe(0)
		await round(h, NOW + HOUR)
		expect(await count(h, 'statuses')).toBe(1)
	})
})

describe('the scheduled_statuses endpoints', () => {
	it('pages by id, newest first, with Link headers', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const made: string[] = []
		for (let i = 0; i < 5; i++) {
			made.push((await scheduled(h, alice, { status: `s${i}`, scheduled_at: at(NOW + (i + 1) * HOUR) })).id)
		}
		const newest = [...made].reverse()
		const first = await h.request('/api/v1/scheduled_statuses?limit=2', bearer(alice.token))
		expect((await first.json<Scheduled[]>()).map((s) => s.id)).toEqual(newest.slice(0, 2))
		expect(first.headers.get('link')).toBe(
			`<https://kopje.test/api/v1/scheduled_statuses?limit=2&max_id=${newest[1]}>; rel="next", ` +
				`<https://kopje.test/api/v1/scheduled_statuses?limit=2&min_id=${newest[0]}>; rel="prev"`
		)
		expect(await ids(h, `/api/v1/scheduled_statuses?max_id=${newest[1]}`, alice.token)).toEqual(newest.slice(2))
		expect(await ids(h, `/api/v1/scheduled_statuses?min_id=${made[0]}&limit=2`, alice.token)).toEqual([
			made[2],
			made[1],
		])
		expect(await ids(h, `/api/v1/scheduled_statuses?since_id=${made[2]}`, alice.token)).toEqual(newest.slice(0, 2))
	})

	it('changes scheduled_at only, with the validations run again', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const created = await scheduled(h, alice, { status: 'move me', scheduled_at: at(NOW + HOUR) })
		const moved = await send(h, alice, 'PUT', `/api/v1/scheduled_statuses/${created.id}`, {
			scheduled_at: at(NOW + 2 * HOUR),
			status: 'ignored',
		})
		expect(await moved.json()).toEqual({ ...created, scheduled_at: at(NOW + 2 * HOUR) })
		const patched = await send(h, alice, 'PATCH', `/api/v1/scheduled_statuses/${created.id}`, {
			scheduled_at: '2026-10-12T03:00:00+02:00',
		})
		expect(await patched.json()).toMatchObject({ scheduled_at: '2026-10-12T01:00:00.000Z' })
		expect(
			await refusal(await send(h, alice, 'PUT', `/api/v1/scheduled_statuses/${created.id}`, { scheduled_at: at(NOW) }))
		).toEqual({ status: 422, body: { error: 'Validation failed: Scheduled at date must be in the future' } })
		expect(
			await refusal(await send(h, alice, 'PUT', `/api/v1/scheduled_statuses/${created.id}`, { scheduled_at: 'soon' }))
		).toEqual({ status: 422, body: { error: 'Record invalid' } })
		expect((await getJson<Scheduled>(h, `/api/v1/scheduled_statuses/${created.id}`, alice.token)).body).toMatchObject({
			scheduled_at: '2026-10-12T01:00:00.000Z',
			params: { text: 'move me' },
		})
	})

	it('refuses a date the calendar does not have, on POST and PUT, as Mastodon does', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const created = await scheduled(h, alice, { status: 'x', scheduled_at: '2028-02-29T10:00:00Z' })
		expect(created.scheduled_at).toBe('2028-02-29T10:00:00.000Z')
		const path = `/api/v1/scheduled_statuses/${created.id}`
		for (const invalid of [
			'2027-02-29T10:00:00Z',
			'2026-11-31T10:00:00Z',
			'2026-12-01T24:30:00Z',
			'2026-12-01T10:60:00Z',
		]) {
			const invalidBody = { status: 422, body: { error: 'Record invalid' } }
			expect(await refusal(await schedule(h, alice, { status: 'x', scheduled_at: invalid })), invalid).toEqual(
				invalidBody
			)
			expect(await refusal(await send(h, alice, 'PUT', path, { scheduled_at: invalid })), invalid).toEqual(invalidBody)
		}
		// Ruby reads 24:00:00 as the next day's midnight.
		const midnight = await send(h, alice, 'PUT', path, { scheduled_at: '2026-12-01T24:00:00Z' })
		expect(await midnight.json()).toMatchObject({ scheduled_at: '2026-12-02T00:00:00.000Z' })
		expect(await count(h, 'scheduled_statuses')).toBe(1)
	})

	it("never shows or changes another account's scheduled status", async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const created = await scheduled(h, alice, { status: 'mine', scheduled_at: at(NOW + HOUR) })
		const path = `/api/v1/scheduled_statuses/${created.id}`
		const notFound = { status: 404, body: { error: 'Record not found' } }
		expect(await getJson(h, path, bob.token)).toEqual(notFound)
		expect(await refusal(await send(h, bob, 'PUT', path, { scheduled_at: at(NOW + 2 * HOUR) }))).toEqual(notFound)
		expect(await refusal(await send(h, bob, 'DELETE', path))).toEqual(notFound)
		expect(await ids(h, '/api/v1/scheduled_statuses', bob.token)).toEqual([])
		expect((await getJson<Scheduled>(h, path, alice.token)).body).toEqual(created)
	})

	it('deletes a scheduled status and detaches its media, attachable again for a day', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const media = await upload(h, alice, 1)
		const created = await scheduled(h, alice, { status: 'x', media_ids: [media], scheduled_at: at(NOW + HOUR) })
		const deleted = await send(h, alice, 'DELETE', `/api/v1/scheduled_statuses/${created.id}`)
		expect([deleted.status, await deleted.json()]).toEqual([200, {}])
		expect(await sql(h.store, 'SELECT scheduled_status_id, gc_at FROM media_attachments')).toEqual([
			{ scheduled_status_id: null, gc_at: at(NOW + DAY) },
		])
		expect(await post(h, alice, { status: 'again', media_ids: [media] })).toMatchObject({
			media_attachments: [expect.objectContaining({ id: media })],
		})
	})

	it('holds its media: not swept as unattached, not attached elsewhere, not made a profile image, not deleted', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const media = await upload(h, alice, 1)
		await scheduled(h, alice, { status: 'x', media_ids: [media], scheduled_at: at(NOW + 3 * DAY) })
		expect(await sql(h.store, 'SELECT gc_at FROM media_attachments')).toEqual([{ gc_at: null }])
		const due = await runInDurableObject(h.store, (_instance, state) =>
			expiredMedia.run(state.storage.sql, { now: NOW + 2 * DAY, limit: 100 })
		)
		expect(due).toEqual([])
		expect(await refusal(await schedule(h, alice, { status: 'other', media_ids: [media] }))).toEqual({
			status: 422,
			body: { error: `Media ${media} not found or already attached to another post` },
		})
		expect(await count(h, 'statuses')).toBe(0)
		const credential = { tokenHash: await sha256Hex(alice.token), scope: 'write', now: NOW } as const
		expect(
			await h.store.updateCredentials(BUILD, {
				credential,
				changes: {},
				images: { avatar: media },
				present: { origin: 'https://kopje.test' },
				now: NOW,
			})
		).toMatchObject({
			status: 'ok',
			value: { status: 'upload_gone' },
		})
		expect(await refusal(await send(h, alice, 'DELETE', `/api/v1/media/${media}`))).toEqual({
			status: 422,
			body: { error: 'Media attachment is currently used by a status' },
		})
		expect(await sql(h.store, 'SELECT gc_at FROM media_attachments')).toEqual([{ gc_at: null }])
	})
})

describe('publication', () => {
	it('publishes a due status once, through the path of an ordinary post', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await follow(h, bob, alice.id)
		await remoteFollows(h.store, await remoteAccount(h.store, 'dave'), alice.id)
		const media = await upload(h, alice, 1)
		const created = await scheduled(h, alice, {
			status: 'hello @bob #cats',
			media_ids: [media],
			scheduled_at: at(NOW + HOUR),
		})
		const doorbell = vi.fn(() => Promise.resolve())
		// Not due yet.
		await round(h, NOW + HOUR - 1, doorbell)
		expect(await count(h, 'statuses')).toBe(0)
		expect(doorbell).not.toHaveBeenCalled()
		// Two overlapping runs, then a third: one status.
		const publishedAt = NOW + HOUR + 3 * MINUTE
		await Promise.all([round(h, publishedAt, doorbell), round(h, publishedAt, doorbell)])
		await round(h, publishedAt + 5 * MINUTE, doorbell)
		expect(doorbell).toHaveBeenCalledTimes(1)
		const [status] = (await getJson<Status[]>(h, '/api/v1/timelines/home', bob.token)).body
		expect(status).toMatchObject({
			account: { id: alice.id },
			visibility: 'public',
			created_at: at(publishedAt),
			mentions: [expect.objectContaining({ id: bob.id })],
			tags: [expect.objectContaining({ name: 'cats' })],
			media_attachments: [expect.objectContaining({ id: media })],
		})
		expect(await count(h, 'statuses')).toBe(1)
		expect((await getJson(h, `/api/v1/scheduled_statuses/${created.id}`, alice.token)).status).toBe(404)
		expect(await sql(h.store, "SELECT type, from_account_id FROM notifications WHERE type = 'mention'")).toEqual([
			{ type: 'mention', from_account_id: alice.id },
		])
		expect(
			(await sql<{ body: string }>(h.store, 'SELECT body FROM outbound_activities')).map(
				(row) => (JSON.parse(row.body) as { activity: { type: string } }).activity.type
			)
		).toEqual(['Create'])
	})

	it("applies the author's defaults at the time of publication", async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await scheduled(h, alice, { status: 'later', scheduled_at: at(NOW + HOUR) })
		await sql(h.store, "UPDATE local_accounts SET default_visibility = 'unlisted' WHERE account_id = ?", alice.id)
		await round(h, NOW + HOUR)
		expect(await sql(h.store, 'SELECT visibility FROM statuses')).toEqual([{ visibility: 'unlisted' }])
	})

	it('drops a post that no longer passes, as PublishScheduledStatusWorker does, and frees its media', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const parent = await post(h, alice, { status: 'parent' })
		const media = await upload(h, alice, 1)
		await scheduled(h, alice, {
			status: 'reply',
			in_reply_to_id: parent.id,
			media_ids: [media],
			scheduled_at: at(NOW + HOUR),
		})
		await scheduled(h, bob, { status: 'suspended later', scheduled_at: at(NOW + HOUR) })
		expect((await send(h, alice, 'DELETE', `/api/v1/statuses/${parent.id}`)).status).toBe(200)
		await sql(h.store, 'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?', at(NOW), bob.id)
		await round(h, NOW + HOUR)
		expect(await count(h, 'statuses')).toBe(0)
		expect(await count(h, 'scheduled_statuses')).toBe(0)
		expect(await sql(h.store, 'SELECT status_id, scheduled_status_id, gc_at FROM media_attachments')).toEqual([
			{ status_id: null, scheduled_status_id: null, gc_at: at(NOW + HOUR + DAY) },
		])
	})

	it('refuses to schedule unusable media, and drops a post whose held media is gone when it is due', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		expect(
			await refusal(await schedule(h, alice, { status: 'x', media_ids: ['7'], scheduled_at: at(NOW + HOUR) }))
		).toEqual({ status: 422, body: { error: 'Media 7 not found or already attached to another post' } })
		expect(await count(h, 'scheduled_statuses')).toBe(0)
		const media = await upload(h, alice, 1)
		const held = await scheduled(h, alice, { status: 'x', media_ids: [media], scheduled_at: at(NOW + HOUR) })
		await sql(h.store, 'DELETE FROM media_attachments WHERE id = ?', media)
		// As PublishScheduledStatusWorker loses a post whose validate_media! raises.
		const publication = await runInDurableObject(h.store, (_instance, state) =>
			publishOne.run(state.storage.sql, { id: held.id, now: NOW + HOUR, objectId: crypto.randomUUID() })
		)
		expect(publication).toEqual({ status: 'dropped', reason: 'invalid' })
		expect(await count(h, 'statuses')).toBe(0)
		expect(await count(h, 'scheduled_statuses')).toBe(0)
	})

	it('waits while the Store is readonly, then publishes', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await scheduled(h, alice, { status: 'later', scheduled_at: at(NOW + HOUR) })
		expect(await h.store.setMaintenance(BUILD, true)).toEqual({ maintenance: true })
		await expect(round(h, NOW + HOUR)).rejects.toThrow()
		expect(await count(h, 'scheduled_statuses')).toBe(1)
		await h.store.setMaintenance(BUILD, false)
		await round(h, NOW + HOUR)
		expect(await count(h, 'statuses')).toBe(1)
	})

	it(`backs off what keeps failing, so later schedules publish, and drops it after ${MAX_ATTEMPTS} attempts`, async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const media = await upload(h, alice, 1)
		// An error that is not a refusal of the post: the Store rolls the publication back.
		await sql(
			h.store,
			`CREATE TRIGGER fail_publication BEFORE INSERT ON statuses WHEN NEW.source_text LIKE 'fail%'
			BEGIN SELECT RAISE(ABORT, 'injected failure'); END`
		)
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO scheduled_statuses (id, account_id, scheduled_at, params)
			SELECT CAST(600000000000000000 + i AS TEXT), ?2, strftime('%Y-%m-%dT%H:%M:%fZ', ?3, '+' || i || ' seconds'),
				json_object('text', 'fail ' || i, 'spoiler_text', '', 'sensitive', NULL, 'language', NULL, 'visibility', NULL,
					'in_reply_to_id', NULL, 'media_ids', NULL)
			FROM n`,
			PUBLISH_ROUND,
			alice.id,
			at(NOW + HOUR)
		)
		await sql(h.store, "UPDATE media_attachments SET scheduled_status_id = '600000000000000000', gc_at = NULL")
		// Due after them; written directly, as the rows above already fill the day's limit.
		const healthy = '600000000000000999'
		await sql(
			h.store,
			`INSERT INTO scheduled_statuses (id, account_id, scheduled_at, params) VALUES (?, ?, ?, json_object('text',
				'healthy', 'spoiler_text', '', 'sensitive', NULL, 'language', NULL, 'visibility', NULL, 'in_reply_to_id', NULL,
				'media_ids', NULL))`,
			healthy,
			alice.id,
			at(NOW + HOUR + MINUTE)
		)
		let t = NOW + HOUR + MINUTE
		await round(h, t)
		expect(await count(h, 'statuses')).toBe(0)
		t += 5 * MINUTE
		await round(h, t)
		expect(await sql(h.store, 'SELECT content FROM statuses')).toEqual([{ content: '<p>healthy</p>' }])
		expect((await getJson(h, `/api/v1/scheduled_statuses/${healthy}`, alice.token)).status).toBe(404)
		// The failures back off and are retried, each failing again, until the last attempt drops them and frees the media.
		const attempts = await sql<{ attempts: number }>(h.store, 'SELECT attempts FROM scheduled_statuses')
		expect(attempts.length).toBe(PUBLISH_ROUND)
		expect(attempts.every((row) => row.attempts >= 1 && row.attempts <= 2)).toBe(true)
		for (let run = 0; run < MAX_ATTEMPTS + 1; run++) {
			t += RETRY_DELAYS_MS.at(-1) ?? 0
			await round(h, t)
		}
		expect(await count(h, 'scheduled_statuses')).toBe(0)
		expect(await count(h, 'statuses')).toBe(1)
		const [freed] = await sql<{ scheduled_status_id: string | null; gc_at: string | null }>(
			h.store,
			'SELECT scheduled_status_id, gc_at FROM media_attachments'
		)
		expect(freed?.scheduled_status_id).toBeNull()
		expect(Date.parse(freed?.gc_at ?? '')).toBeGreaterThan(t)
	})

	it(`publishes at most ${PUBLISH_ROUND} a run, the earliest first`, async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO scheduled_statuses (id, account_id, scheduled_at, params)
			SELECT CAST(600000000000000000 + i AS TEXT), ?2, strftime('%Y-%m-%dT%H:%M:%fZ', ?3, '+' || i || ' seconds'),
				json_object('text', 'n' || i, 'spoiler_text', '', 'sensitive', NULL, 'language', NULL, 'visibility', NULL,
					'in_reply_to_id', NULL, 'media_ids', NULL)
			FROM n`,
			PUBLISH_ROUND + 5,
			alice.id,
			at(NOW)
		)
		await round(h, NOW + HOUR)
		expect(await count(h, 'statuses')).toBe(PUBLISH_ROUND)
		expect(await sql(h.store, 'SELECT min(id) AS first FROM scheduled_statuses')).toEqual([
			{ first: String(600000000000000000n + BigInt(PUBLISH_ROUND)) },
		])
		await round(h, NOW + HOUR)
		expect(await count(h, 'statuses')).toBe(PUBLISH_ROUND + 5)
	})
})

// Nothing of a scheduled status is shown, notified or delivered before its publication (R26, VIS-1): whatever is
// scheduled, by whom, mentioning whom and with which visibility, every other table stays as it was, and each account's
// scheduled statuses are its own.
describe('nothing leaks before publication', () => {
	const TABLES = [
		'statuses',
		'status_mentions',
		'status_tags',
		'notifications',
		'outbound_activities',
		'outbound_targets',
		'deliveries',
		'push_deliveries',
		'favourites',
		'bookmarks',
	]

	async function snapshot(h: ApiHarness): Promise<unknown> {
		const tables: Record<string, unknown> = {}
		for (const table of TABLES) {
			tables[table] = await sql(h.store, `SELECT * FROM ${table} ORDER BY 1, 2`)
		}
		tables.accounts = await sql(h.store, 'SELECT id, statuses_count FROM accounts ORDER BY id')
		return tables
	}

	it('writes nothing but the scheduled status, and shows it to its owner alone', async () => {
		const h = await community(['alice', 'bob', 'carol'])
		const users = [h.users.alice, h.users.bob, h.users.carol]
		await follow(h, h.users.bob, h.users.alice.id)
		await follow(h, h.users.carol, h.users.alice.id)
		const parent = await post(h, h.users.alice, { status: 'parent #cats' })
		const before = await snapshot(h)
		const actionArb = fc.record({
			author: fc.integer({ min: 0, max: 2 }),
			mentions: fc.subarray([0, 1, 2]),
			visibility: fc.constantFrom('public', 'unlisted', 'private', 'direct'),
			reply: fc.boolean(),
			offset: fc.integer({ min: 6, max: 60 * 24 * 3 }),
		})
		const names = ['alice', 'bob', 'carol']
		const owned: string[][] = [[], [], []]
		await fc.assert(
			fc.asyncProperty(actionArb, async (action) => {
				const author = users[action.author] as User
				const text = `${action.mentions.map((m) => `@${names[m]}`).join(' ')} later #cats`
				const created = await scheduled(h, author, {
					status: text,
					visibility: action.visibility,
					scheduled_at: at(NOW + action.offset * MINUTE),
					...(action.reply ? { in_reply_to_id: parent.id } : {}),
				})
				owned[action.author]?.push(created.id)
				expect(await snapshot(h)).toEqual(before)
				for (const [i, user] of users.entries()) {
					expect((await ids(h, '/api/v1/scheduled_statuses?limit=40', user.token)).sort()).toEqual(
						[...(owned[i] ?? [])].sort()
					)
					expect((await getJson(h, `/api/v1/scheduled_statuses/${created.id}`, user.token)).status).toBe(
						user === author ? 200 : 404
					)
					expect((await getJson(h, `/api/v1/statuses/${created.id}`, user.token)).status).toBe(404)
					expect(await ids(h, '/api/v1/timelines/home', user.token)).toEqual([parent.id])
				}
				expect(await ids(h, '/api/v1/timelines/public')).toEqual([parent.id])
				expect(await ids(h, '/api/v1/timelines/tag/cats')).toEqual([parent.id])
			}),
			{ numRuns: 12, seed: 20261015 }
		)
	}, 60_000)
})

describe('parseScheduledAt', () => {
	it('reads ISO 8601 times as Mastodon does, UTC when no offset is given', () => {
		expect(parseScheduledAt('2026-10-20T10:00:00Z')).toBe('2026-10-20T10:00:00.000Z')
		expect(parseScheduledAt('2026-10-20T10:00:00.123456+09:00')).toBe('2026-10-20T01:00:00.123Z')
		expect(parseScheduledAt('2026-10-20 10:00+0900')).toBe('2026-10-20T01:00:00.000Z')
		expect(parseScheduledAt('2026-10-20T10:00')).toBe('2026-10-20T10:00:00.000Z')
		expect(parseScheduledAt('2026-10-20')).toBe('2026-10-20T00:00:00.000Z')
		expect(parseScheduledAt('2028-02-29T10:00:00Z')).toBe('2028-02-29T10:00:00.000Z')
		expect(parseScheduledAt('2026-10-20T24:00:00+09:00')).toBe('2026-10-20T15:00:00.000Z')
		expect(parseScheduledAt('2026-10-20T10:00:60Z')).toBe('2026-10-20T10:00:59.000Z')
		for (const invalid of [
			'tomorrow',
			'2026-13-01T00:00:00Z',
			'2026-10-20T25:00:00Z',
			'2027-02-29T10:00:00Z',
			'2100-02-29T10:00:00Z',
			'2026-11-31T10:00:00Z',
			'2026-04-31',
			'2026-10-20T24:00:01Z',
			'2026-10-20T10:60:00Z',
			'2026-10-20T10:00:61Z',
			'x'.repeat(100),
			'',
		]) {
			expect(parseScheduledAt(invalid), invalid).toBeNull()
		}
	})
})
