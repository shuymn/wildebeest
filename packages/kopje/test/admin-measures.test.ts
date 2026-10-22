import { describe, expect, it } from 'vitest'

import {
	ADMIN_SCOPES,
	followed,
	followersOn,
	type Measure,
	measure,
	measureInput,
	MEASURES,
} from './admin-measure-helpers'
import { bearer, form, json, sql, userToken } from './api-helpers'
import { appTokenWith, rowsRead } from './read-helpers'
import { round, world, type World } from './remote-suspension-helpers'
import { adminMeasure, MEASURE_DAYS, MEASURE_ROWS } from '../src/domain/admin-measures'
import { SEVER_ROUND } from '../src/domain/remote-suspension'
import { MAX_MEASURE_KEYS } from '../src/mastodon/admin'

// The admin metrics (Api::V1::Admin::{Measures,Dimensions,Retention}Controller of Mastodon 4.5.11): the measure
// instance_follows (domain/admin-measures.ts; InstanceFollowsMeasure), its total, series, caps and answer shape
// (REST::Admin::MeasureSerializer), the request's order of refusals, and dimensions and retention answering `[]`.
// The other measures: test/admin-measures-keys.test.ts; walks, plans and budgets: test/admin-measures-bounds.test.ts.

const D = 'd.example'

// Fediblockhole's request (fetch_instance_follows, fediblockhole/__init__.py:546-549), with optional extras.
const follows = (domain: string, extra: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({
	keys: ['instance_follows'],
	instance_follows: { domain, ...extra },
	...top,
})

async function total(w: World, domain: string, extra: Record<string, unknown> = {}): Promise<string> {
	const answer = await measure(w, follows(domain, extra))
	expect(answer.status, JSON.stringify(answer.body)).toBe(200)
	return (answer.body as Measure[])[0]!.total
}

describe('the measure instance_follows', () => {
	it("count local accounts' accepted follows of the domain's accounts, as Mastodon's entity", async () => {
		const w = await world()
		await followed(w, w.alice.id, 3, D)
		await followed(w, w.bob.id, 2, 'sub.d.example')
		await followed(w, w.carol.id, 4, 'pending.example', 'pending')
		await followed(w, w.carol.id, 5, 'other.example')
		// Follows of local accounts: by remote accounts on the domain, and between local accounts.
		await sql(
			w.h.store,
			`INSERT INTO follows (account_id, target_account_id, state)
			SELECT id, ?, 'accepted' FROM accounts WHERE domain = ?`,
			w.dan.id,
			D
		)
		await sql(
			w.h.store,
			"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
			w.alice.id,
			w.bob.id
		)
		const answer = await measure(w, follows(D))
		// measure_serializer.rb:3-8: no human_value and no previous_total for this measure.
		expect(answer).toEqual({
			status: 200,
			body: [{ key: 'instance_follows', unit: null, total: '3', data: [] }],
		})
		expect(Object.keys((answer.body as Measure[])[0]!)).toEqual(['key', 'unit', 'total', 'data'])
		// Design change 8: include_subdomains in the total (instance_follows_measure.rb:20-24).
		expect(await total(w, D, { include_subdomains: true })).toBe('5')
		expect(await total(w, D, { include_subdomains: false })).toBe('3')
		expect(await total(w, 'sub.d.example')).toBe('2')
		expect(await total(w, 'other.example')).toBe('5')
		expect(await total(w, 'd.example.')).toBe('3')
		expect(await total(w, 'D.Example')).toBe('3')
		// A pending request is not a follow (row 20).
		expect(await total(w, 'pending.example')).toBe('0')
		expect(await total(w, 'pending.example', { include_subdomains: true })).toBe('0')
		expect(await total(w, 'example')).toBe('0')
		expect(await total(w, 'nothing.example')).toBe('0')
		expect(await total(w, '')).toBe('0')
	})

	it('count a follow that exists only on a subdomain 0 by default and 1 with include_subdomains', async () => {
		const w = await world()
		await followed(w, w.alice.id, 1, 'a.b.example')
		await followed(w, w.alice.id, 1, 'xb.example')
		expect(await total(w, 'b.example')).toBe('0')
		expect(await total(w, 'b.example', { include_subdomains: '1' })).toBe('1')
		const answer = await w.h.request(
			MEASURES,
			bearer(
				w.admin,
				form({
					'keys[]': 'instance_follows',
					'instance_follows[domain]': 'b.example',
					'instance_follows[include_subdomains]': 'true',
				})
			)
		)
		expect(((await answer.json()) as Measure[])[0]!.total).toBe('1')
	})

	it('give per-day counts by follows.created_at from start_at to end_at, both included, of the domain itself', async () => {
		const w = await world()
		await followed(w, w.alice.id, 6, D)
		await followed(w, w.bob.id, 2, 'sub.d.example')
		const ids = (await sql<{ id: number }>(w.h.store, 'SELECT id FROM follows ORDER BY id')).map((row) => row.id)
		const dates = [
			'2026-09-30',
			'2026-10-01',
			'2026-10-01',
			'2026-10-03',
			'2026-10-03',
			'2026-10-04',
			'2026-10-01',
			'2026-10-02',
		]
		for (const [i, id] of ids.entries()) {
			await sql(w.h.store, 'UPDATE follows SET created_at = ? WHERE id = ?', `${dates[i]}T23:59:59.999Z`, id)
		}
		const range = { start_at: '2026-10-01', end_at: '2026-10-03' }
		// A point's date as Rails serializes the axis' SQL date (query_helper.rb:6-8).
		const point = (date: string, value: string) => ({ date, value })
		expect((await measure(w, follows(D, {}, range))).body).toEqual([
			{
				key: 'instance_follows',
				unit: null,
				total: '6',
				data: [point('2026-10-01', '2'), point('2026-10-02', '0'), point('2026-10-03', '2')],
			},
		])
		// With include_subdomains the total counts the subdomain's follows, the series the domain's only, as 4.5.11's
		// account_domain_sql compares with a LIKE that has no wildcard (query_helper.rb:26-32).
		const subdomains = (await measure(w, follows(D, { include_subdomains: true }, range))).body as Measure[]
		expect(subdomains[0]!.total).toBe('8')
		expect(subdomains[0]!.data).toEqual([point('2026-10-01', '2'), point('2026-10-02', '0'), point('2026-10-03', '2')])
		// The axis steps a day at a time from the instant start_at names, then casts each step to its UTC date
		// (generate_series(start_at::timestamp, end_at::timestamp, '1 day')::date): from noon on 1 October to midnight
		// on 3 October gives two steps, 1 and 2 October; an offset is read into UTC first.
		const data = async (top: Record<string, string>) =>
			((await measure(w, follows(D, {}, top))).body as Measure[])[0]!.data
		expect(await data({ start_at: '2026-10-01T12:00:00Z', end_at: '2026-10-03' })).toEqual([
			point('2026-10-01', '2'),
			point('2026-10-02', '0'),
		])
		expect(await data({ start_at: '2026-10-01T12:00:00Z', end_at: '2026-10-03T12:00:00Z' })).toHaveLength(3)
		expect(await data({ start_at: '2026-10-01T23:00:00-02:00', end_at: '2026-10-03T00:30+00:00' })).toEqual([
			point('2026-10-02', '0'),
		])
		expect(await data({ start_at: '2026-10-01T12:00:00', end_at: '2026-10-02T11:59:59.999' })).toEqual([
			point('2026-10-01', '2'),
		])
		// No series without both dates, or when end_at is before start_at (generate_series gives none).
		for (const top of [
			{ start_at: '2026-10-01' },
			{ end_at: '2026-10-01' },
			{ start_at: '2026-10-02', end_at: '2026-10-01' },
		]) {
			expect((await measure(w, follows(D, {}, top))).body).toEqual([
				{ key: 'instance_follows', unit: null, total: '6', data: [] },
			])
		}
	})

	it(`cap the series at ${MEASURE_DAYS} days with 422`, async () => {
		const w = await world()
		await followed(w, w.alice.id, 1, D)
		const full = await measure(w, follows(D, {}, { start_at: '2025-01-01', end_at: '2026-01-01' }))
		expect(full.status).toBe(200)
		expect((full.body as Measure[])[0]!.data).toHaveLength(MEASURE_DAYS)
		expect(await measure(w, follows(D, {}, { start_at: '2025-01-01', end_at: '2026-01-02' }))).toEqual({
			status: 422,
			body: { error: `date range too long (at most ${MEASURE_DAYS} days)` },
		})
		// The cap counts the generated steps: a range that starts in the afternoon steps once less.
		const late = await measure(w, follows(D, {}, { start_at: '2025-01-01T12:00:00Z', end_at: '2026-01-02' }))
		expect((late.body as Measure[])[0]!.data).toHaveLength(MEASURE_DAYS)
	})

	it(`answer 422 above ${MEASURE_ROWS} walked follows, never an undercount, with reads bounded by the walk`, async () => {
		const w = await world()
		await followed(w, w.alice.id, MEASURE_ROWS - 3, 'big.example')
		await followed(w, w.bob.id, 1, D)
		// A pending request is walked (it is a stored edge) but not counted.
		await followed(w, w.carol.id, 2, 'pending.example', 'pending')
		expect(await total(w, D)).toBe('1')
		expect(await total(w, 'big.example')).toBe(String(MEASURE_ROWS - 3))
		const input = await measureInput(w, { key: 'instance_follows', domain: D, includeSubdomains: false, period: null })
		const atCap = await rowsRead(w.h, adminMeasure, input)
		// Accounts nobody follows and remote accounts' follows of local accounts are not walked: the walk starts at the
		// local accounts (CROSS JOIN), so none of their rows is read.
		await followersOn(w, w.carol.id, 30_000, 'fans.example')
		expect(await rowsRead(w.h, adminMeasure, input)).toBe(atCap)
		// One edge more, pending or not, wherever it points, and the total is not known.
		await followed(w, w.dan.id, 1, 'elsewhere.example', 'pending')
		expect(await measure(w, follows(D))).toEqual({
			status: 422,
			body: { error: `too many follows to count (more than ${MEASURE_ROWS}); the total is not known` },
		})
		await followed(w, w.dan.id, 10_000, 'more.example')
		expect((await measure(w, follows('more.example'))).status).toBe(422)
		// The walk stops at its cap: the reads past it do not grow with the follows.
		const beyond = await rowsRead(w.h, adminMeasure, input)
		expect(beyond).toBeLessThan(atCap + 50)
		// Per walked follow: its index entry, its row (state, created_at) and its target's row (domain).
		expect(atCap).toBeLessThan(4 * (MEASURE_ROWS + 1) + 100)
	}, 60_000)

	it('read the body before the policy, in retrieve order, after the optional token', async () => {
		const w = await world()
		await followed(w, w.alice.id, 2, D)
		const alice = await userToken(w.h, 'alice@example.com', ADMIN_SCOPES)
		const app = await appTokenWith(w.h, 'admin:read')
		// params.require(key) of a key that reads its object, and Date::Error, both before the policy (set_measures),
		// so to every caller: the admin, a user, an app token and no token.
		for (const token of [w.admin, alice, app, null]) {
			const missing = (key: string) => ({
				status: 400,
				body: { error: `param is missing or the value is empty or invalid: ${key}` },
			})
			expect(await measure(w, { keys: ['instance_follows'] }, token)).toEqual(missing('instance_follows'))
			expect(await measure(w, { keys: ['instance_follows'], instance_follows: {} }, token)).toMatchObject({
				status: 400,
			})
			for (const key of ['instance_accounts', 'instance_statuses', 'tag_uses', 'tag_accounts', 'tag_servers']) {
				expect(await measure(w, { keys: [key] }, token)).toEqual(missing(key))
			}
			for (const date of [
				'2026-02-30',
				'yesterday',
				'2026-10-01garbage',
				'2026-10-01T25:00',
				'2026-10-01T10:00+24:00',
			]) {
				expect(await measure(w, follows(D, {}, { start_at: date, end_at: '2026-10-01' }), token)).toEqual({
					status: 422,
					body: { error: 'Invalid date supplied' },
				})
			}
			// retrieve's order (measure.rb:21-26): the first known key's object, then the dates, then later keys' objects.
			const bad = { start_at: 'yesterday', end_at: '2026-10-01' }
			expect(await measure(w, { keys: ['new_users', 'instance_accounts'], ...bad }, token)).toEqual({
				status: 422,
				body: { error: 'Invalid date supplied' },
			})
			expect(await measure(w, { keys: ['nothing', 'instance_accounts', 'new_users'], ...bad }, token)).toEqual(
				missing('instance_accounts')
			)
			expect(await measure(w, { keys: ['new_users', 'instance_accounts'] }, token)).toEqual(
				missing('instance_accounts')
			)
		}
		// The optional token is checked before any of them (authorize_if_got_token!): an unknown token answers 401 and a
		// token without admin:read 403, whatever the body.
		const narrow = await userToken(w.h, 'alice@example.com', 'read')
		for (const body of [{ keys: ['instance_follows'] }, follows(D, {}, { start_at: 'yesterday' }), {}]) {
			expect((await measure(w, body, 'not-a-token')).status).toBe(401)
			expect(await measure(w, body, narrow)).toEqual({
				status: 403,
				body: { error: 'This action is outside the authorized scopes' },
			})
		}
		for (const token of [alice, app, null]) {
			for (const body of [follows(D), {}, { keys: ['active_users'] }, { keys: ['new_users'] }]) {
				expect(await measure(w, body, token)).toEqual({ status: 403, body: { error: 'This action is not allowed' } })
			}
		}
		// Measure.retrieve's filter_map: unknown keys are left out, each known key answers once per mention, in order.
		expect(await measure(w, {})).toEqual({ status: 200, body: [] })
		expect(await measure(w, { keys: ['nothing', 'constructor', '__proto__'] })).toEqual({ status: 200, body: [] })
		const answer = await measure(w, { ...follows(D), keys: ['nothing', 'instance_follows', 'instance_follows'] })
		expect(answer.body).toEqual([
			{ key: 'instance_follows', unit: null, total: '2', data: [] },
			{ key: 'instance_follows', unit: null, total: '2', data: [] },
		])
	})

	it(`bound the answer: at most ${MAX_MEASURE_KEYS} known keys, each computed once`, async () => {
		const w = await world()
		await followed(w, w.alice.id, 2, D)
		const alice = await userToken(w.h, 'alice@example.com', ADMIN_SCOPES)
		// Each repeat carries the whole series, so the keys are bounded: MAX_MEASURE_KEYS keys of a full year stay
		// within a known size, one more answers 422 (and 403 to anyone else).
		const year = { start_at: '2025-01-01', end_at: '2026-01-01' }
		const many = (n: number) => ({ ...follows(D, {}, year), keys: Array<string>(n).fill('instance_follows') })
		const full = await w.h.request(MEASURES, bearer(w.admin, json(many(MAX_MEASURE_KEYS))))
		expect(full.status).toBe(200)
		const bytes = (await full.arrayBuffer()).byteLength
		expect(bytes).toBeGreaterThan(MAX_MEASURE_KEYS * MEASURE_DAYS * 30)
		expect(bytes).toBeLessThan(MAX_MEASURE_KEYS * (MEASURE_DAYS + 1) * 40)
		expect(await measure(w, many(MAX_MEASURE_KEYS + 1))).toEqual({
			status: 422,
			body: { error: `too many measure keys (at most ${MAX_MEASURE_KEYS})` },
		})
		expect((await measure(w, many(MAX_MEASURE_KEYS + 1), alice)).status).toBe(403)
		// Only known keys count: one served key among many unknown is answered.
		const mixed = await measure(w, { ...follows(D), keys: ['instance_follows', ...Array<string>(20).fill('nothing')] })
		expect(mixed).toEqual({ status: 200, body: [{ key: 'instance_follows', unit: null, total: '2', data: [] }] })
	})

	it('falls as the domain job severs a blocked domain (row 20); a domain with only pending follows totals 0', async () => {
		const w = await world()
		// More follows than a severing round reads (SEVER_ROUND), so the total falls over several rounds.
		await followed(w, w.alice.id, SEVER_ROUND, D)
		await followed(w, w.bob.id, SEVER_ROUND + 50, D)
		await followed(w, w.carol.id, 3, 'pending.example', 'pending')
		const all = 2 * SEVER_ROUND + 50
		expect(await total(w, D)).toBe(String(all))
		expect(await total(w, 'pending.example')).toBe('0')
		const block = await w.h.request(
			'/api/v1/admin/domain_blocks',
			bearer(w.admin, json({ domain: D, severity: 'suspend' }))
		)
		expect(block.status).toBe(200)
		// The block commits at once; the follows end in the job's rounds, each in its own transaction.
		expect(await total(w, D)).toBe(String(all))
		const seen = [all]
		while ((await round(w.h.store)) !== null) {
			seen.push(Number(await total(w, D)))
		}
		expect(seen.at(-1)).toBe(0)
		expect(seen).toEqual([...seen].sort((a, b) => b - a))
		expect(new Set(seen).size).toBeGreaterThan(2)
	})
})

describe('dimensions and retention', () => {
	it('answer [] to the OAuth admin and 403 to everyone else', async () => {
		const w = await world()
		const alice = await userToken(w.h, 'alice@example.com', ADMIN_SCOPES)
		for (const path of ['/api/v1/admin/dimensions', '/api/v1/admin/retention']) {
			const body = { keys: ['languages'], start_at: '2026-10-01', end_at: '2026-10-02', frequency: 'day' }
			expect(await (await w.h.request(path, bearer(w.admin, json(body)))).json()).toEqual([])
			for (const init of [bearer(alice, json(body)), json(body)]) {
				const response = await w.h.request(path, init)
				expect(response.status).toBe(403)
				expect(await response.json()).toEqual({ error: 'This action is not allowed' })
			}
		}
	})
})
