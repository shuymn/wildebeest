import { describe, expect, it } from 'vitest'

import { bearer, form, json, sql, userToken } from './api-helpers'
import { NOW } from './app-helpers'
import { rowsRead } from './read-helpers'
import { round, world, type World } from './remote-suspension-helpers'
import { instanceFollowsMeasure, MEASURE_DAYS, MEASURE_FOLLOWS } from '../src/domain/admin-measures'
import { SEVER_ROUND } from '../src/domain/remote-suspension'
import { sha256Hex } from '../src/security/tokens'

// The admin metrics (Api::V1::Admin::{Measures,Dimensions,Retention}Controller of Mastodon 4.5.11): the measure
// instance_follows (domain/admin-measures.ts; InstanceFollowsMeasure), its total, series, caps and answer shape
// (REST::Admin::MeasureSerializer), the keys left out, and dimensions and retention answering `[]`.

const ADMIN_SCOPES = 'read write admin:read admin:write'
const MEASURES = '/api/v1/admin/measures'
const D = 'd.example'

type Measure = { key: string; unit: null; total: string; data: { date: string; value: string }[] }

async function measure(w: World, body: Record<string, unknown>, token: string | null = w.admin) {
	const init = json(body)
	const response = await w.h.request(MEASURES, token === null ? init : bearer(token, init))
	return { status: response.status, body: (await response.json()) as unknown }
}

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

let next = 7_000_000_000_000

// `n` new remote accounts on `domain`, followed by `follower` in `state`.
async function followed(w: World, follower: string, n: number, domain: string, state = 'accepted'): Promise<void> {
	const base = next
	next += 1_000_000
	await sql(
		w.h.store,
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO accounts (id, uri, username, domain)
		SELECT printf('%018d', ?2 + i), 'https://' || ?3 || '/users/u' || (?2 + i), 'u' || i, ?3 FROM n`,
		n,
		base,
		domain
	)
	await sql(
		w.h.store,
		`INSERT INTO follows (account_id, target_account_id, state)
		SELECT ?1, id, ?2 FROM accounts WHERE domain = ?3 AND id > printf('%018d', ?4) AND id <= printf('%018d', ?4 + ?5)`,
		follower,
		state,
		domain,
		base,
		n
	)
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

	it('give per-day counts by follows.created_at from start_at to end_at, both included, subdomains too', async () => {
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
		const range = { start_at: '2026-10-01T12:00:00Z', end_at: '2026-10-03' }
		const point = (date: string, value: string) => ({ date: `${date}T00:00:00.000+00:00`, value })
		expect((await measure(w, follows(D, {}, range))).body).toEqual([
			{
				key: 'instance_follows',
				unit: null,
				total: '6',
				data: [point('2026-10-01', '2'), point('2026-10-02', '0'), point('2026-10-03', '2')],
			},
		])
		expect(((await measure(w, follows(D, { include_subdomains: true }, range))).body as Measure[])[0]!.data).toEqual([
			point('2026-10-01', '3'),
			point('2026-10-02', '1'),
			point('2026-10-03', '2'),
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
	})

	it(`answer 422 above ${MEASURE_FOLLOWS} walked follows, never an undercount, with reads bounded by the walk`, async () => {
		const w = await world()
		await followed(w, w.alice.id, MEASURE_FOLLOWS - 1, 'big.example')
		await followed(w, w.bob.id, 1, D)
		expect(await total(w, D)).toBe('1')
		expect(await total(w, 'big.example')).toBe(String(MEASURE_FOLLOWS - 1))
		const credential = { tokenHash: await sha256Hex(w.admin), scope: 'admin:read' as const, now: NOW }
		const input = { credential, domain: D, includeSubdomains: false, range: null }
		const atCap = await rowsRead(w.h, instanceFollowsMeasure, input)
		// Pending requests and accounts nobody follows are not walked.
		await followed(w, w.carol.id, 5_000, 'pending.example', 'pending')
		expect(await rowsRead(w.h, instanceFollowsMeasure, input)).toBe(atCap)
		// One follow more, wherever it points, and the total is not known.
		await followed(w, w.dan.id, 1, 'elsewhere.example')
		expect(await measure(w, follows(D))).toEqual({
			status: 422,
			body: { error: `too many follows to count (more than ${MEASURE_FOLLOWS}); the total is not known` },
		})
		await followed(w, w.dan.id, 10_000, 'more.example')
		expect((await measure(w, follows('more.example'))).status).toBe(422)
		// The walk stops at its cap: the reads past it do not grow with the follows.
		const beyond = await rowsRead(w.h, instanceFollowsMeasure, input)
		expect(beyond).toBeLessThan(atCap + 50)
		// Per walked follow: its index entry, its row (created_at) and its target's row (domain), and the bucket.
		expect(atCap).toBeLessThan(4 * (MEASURE_FOLLOWS + 1) + 100)
	})

	it('read the body before the policy, and leave out every key but instance_follows', async () => {
		const w = await world()
		await followed(w, w.alice.id, 2, D)
		const alice = await userToken(w.h, 'alice@example.com', ADMIN_SCOPES)
		// params.require(:instance_follows) and Date::Error, both before the policy (set_measures), so to every caller.
		for (const token of [w.admin, alice, null]) {
			expect(await measure(w, { keys: ['instance_follows'] }, token)).toEqual({
				status: 400,
				body: { error: 'param is missing or the value is empty or invalid: instance_follows' },
			})
			expect(await measure(w, { keys: ['instance_follows'], instance_follows: {} }, token)).toMatchObject({
				status: 400,
			})
			for (const date of ['2026-02-30', 'yesterday']) {
				expect(await measure(w, follows(D, {}, { start_at: date, end_at: '2026-10-01' }), token)).toEqual({
					status: 422,
					body: { error: 'Invalid date supplied' },
				})
			}
		}
		for (const token of [alice, null]) {
			for (const body of [follows(D), {}, { keys: ['active_users'] }]) {
				expect(await measure(w, body, token)).toEqual({ status: 403, body: { error: 'This action is not allowed' } })
			}
		}
		// Measure.retrieve's filter_map (measure.rb:21-26): unknown keys are left out, each served key answers once per
		// mention, in order.
		expect(await measure(w, {})).toEqual({ status: 200, body: [] })
		expect(await measure(w, { keys: ['active_users', 'new_users'] })).toEqual({ status: 200, body: [] })
		const answer = await measure(w, { ...follows(D), keys: ['active_users', 'instance_follows', 'instance_follows'] })
		expect(answer.body).toEqual([
			{ key: 'instance_follows', unit: null, total: '2', data: [] },
			{ key: 'instance_follows', unit: null, total: '2', data: [] },
		])
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
