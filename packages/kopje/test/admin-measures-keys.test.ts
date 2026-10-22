import { describe, expect, it } from 'vitest'

import {
	ADMIN_SCOPES,
	followed,
	followersOn,
	localAccounts,
	type Measure,
	measure,
	remoteAccountsOn,
	reportsOf,
} from './admin-measure-helpers'
import { bearer, sql, userToken } from './api-helpers'
import { storeReceive } from './inbox-store-helpers'
import { DAY_MS } from './read-helpers'
import { world, type World } from './remote-suspension-helpers'

// The measures of POST /api/v1/admin/measures besides instance_follows (test/admin-measures.test.ts), against
// Mastodon 4.5.11's Admin::Metrics::Measure classes: new_users, opened_reports and resolved_reports with their windows
// and previous_total (base_measure.rb:88-98), instance_accounts, instance_followers, instance_reports and
// instance_media_attachments, the refused keys (MD-2), and stored times that cannot be read.

const D = 'd.example'
const point = (date: string, value: string) => ({ date, value })

async function only(w: World, body: Record<string, unknown>): Promise<Measure> {
	const answer = await measure(w, body)
	expect(answer.status, JSON.stringify(answer.body)).toBe(200)
	const measures = answer.body as Measure[]
	expect(measures).toHaveLength(1)
	return measures[0]!
}

// The local accounts' created_at, the five of world() at `at` and the others as given.
async function localsAt(w: World, at: string): Promise<void> {
	await sql(w.h.store, 'UPDATE local_accounts SET created_at = ?', at)
}

const newUsers = (start_at: string, end_at: string) => ({ keys: ['new_users'], start_at, end_at })

const instance = (key: string, domain: unknown, extra: Record<string, unknown> = {}, top = {}) => ({
	keys: [key],
	[key]: { domain, ...extra },
	...top,
})

describe('the measure new_users', () => {
	it('total the local accounts from the start date 00:00 to the end date 00:00, and give each day', async () => {
		const w = await world()
		await localsAt(w, '2026-09-01T00:00:00.000Z')
		await localAccounts(w, 2, '2026-10-01T00:00:00.000Z')
		await localAccounts(w, 3, '2026-10-01T23:59:59.999Z')
		await localAccounts(w, 1, '2026-10-02T12:00:00.000Z')
		// The end day counts in the total only at 00:00:00.000 exactly (Date..Date on a timestamp), in the series whole.
		await localAccounts(w, 4, '2026-10-03T00:00:00.000Z')
		await localAccounts(w, 5, '2026-10-03T00:00:00.001Z')
		const m = await only(w, newUsers('2026-10-01', '2026-10-03'))
		expect(m).toEqual({
			key: 'new_users',
			unit: null,
			total: String(2 + 3 + 1 + 4),
			previous_total: '2',
			data: [point('2026-10-01', '5'), point('2026-10-02', '1'), point('2026-10-03', '9')],
		})
		// measure_serializer.rb: previous_total for a measure in the time range, no human_value.
		expect(Object.keys(m)).toEqual(['key', 'unit', 'total', 'previous_total', 'data'])
		// The previous window: each date moved back by the length (2 days), so 2026-09-29 to 2026-10-01 00:00 above,
		// and here 2026-10-01 to 2026-10-03 00:00.
		const later = await only(w, newUsers('2026-10-03', '2026-10-05'))
		expect(later.previous_total).toBe('10')
		expect(later.total).toBe(String(4 + 5))
		// A same-day range: the window is that midnight alone, the series that whole day.
		expect(await only(w, newUsers('2026-10-03', '2026-10-03'))).toMatchObject({
			total: '4',
			previous_total: '4',
			data: [point('2026-10-03', '9')],
		})
		// The total's end date past the axis' last point: the axis ends at 2026-10-02 (12:00 + 1 day > 06:00), the
		// window still reaches 2026-10-03 00:00.
		expect(await only(w, newUsers('2026-10-01T12:00:00Z', '2026-10-03T06:00:00Z'))).toMatchObject({
			total: '10',
			data: [point('2026-10-01', '5'), point('2026-10-02', '1')],
		})
		// end_at before start_at: no axis, an empty window.
		expect(await only(w, newUsers('2026-10-03', '2026-10-01'))).toMatchObject({ total: '0', data: [] })
	})

	it('read the dates as written for the windows and as UTC instants for the axis', async () => {
		const w = await world()
		await localsAt(w, '2026-09-01T00:00:00.000Z')
		await localAccounts(w, 1, '2026-10-01T00:00:00.000Z')
		await localAccounts(w, 2, '2026-10-02T00:00:00.000Z')
		await localAccounts(w, 16, '2026-10-07T12:00:00.000Z')
		await localAccounts(w, 4, '2026-10-08T00:00:00.000Z')
		await localAccounts(w, 8, '2026-10-09T00:00:00.000Z')
		// 23:00 at -02:00 is 2026-10-02 01:00 UTC: the window starts at the date written (2026-10-01), the axis at
		// 2026-10-02 (DateTime#to_date keeps the offset; Rails quotes the instant in UTC).
		expect(await only(w, newUsers('2026-10-01T23:00:00-02:00', '2026-10-02T23:00:00-02:00'))).toMatchObject({
			total: '3',
			data: [point('2026-10-02', '2'), point('2026-10-03', '0')],
		})
		// The previous window shifts by the exact length, then floors: 1.5 days back from 2026-10-10 and 2026-10-11 is
		// 2026-10-08 and 2026-10-09.
		expect(await only(w, newUsers('2026-10-10T12:00:00Z', '2026-10-12T00:00:00Z'))).toMatchObject({
			previous_total: String(4 + 8),
		})
		// One nanosecond more than two days moves both dates back past a midnight: 2026-10-07 to 2026-10-09, which holds
		// 2026-10-07 12:00, where two days exactly give 2026-10-08 to 2026-10-10.
		expect(await only(w, newUsers('2026-10-10T00:00:00Z', '2026-10-12T00:00:00.000000001Z'))).toMatchObject({
			previous_total: String(16 + 4 + 8),
		})
		expect(await only(w, newUsers('2026-10-10T00:00:00Z', '2026-10-12T00:00:00Z'))).toMatchObject({
			previous_total: String(4 + 8),
		})
		expect(await only(w, newUsers('2026-10-10T00:00:00Z', '2026-10-11T00:00:00.000000001Z'))).toMatchObject({
			previous_total: String(4 + 8),
		})
		expect(await only(w, newUsers('2026-10-10T00:00:00Z', '2026-10-11T00:00:00Z'))).toMatchObject({
			previous_total: '8',
		})
		// Microseconds, not milliseconds, end the axis: 0.5 ms after midnight to 0.4 ms after a later midnight takes
		// two steps, not three.
		expect(
			(await only(w, newUsers('2026-10-01T00:00:00.0005Z', '2026-10-03T00:00:00.0004Z'))).data.map((p) => p.date)
		).toEqual(['2026-10-01', '2026-10-02'])
		expect(
			(await only(w, newUsers('2026-10-01T00:00:00.0004Z', '2026-10-03T00:00:00.0004Z'))).data.map((p) => p.date)
		).toEqual(['2026-10-01', '2026-10-02', '2026-10-03'])
		// Sub-microsecond differences do not reach the axis (Rails quotes microseconds, truncated).
		expect((await only(w, newUsers('2026-10-01T00:00:00.0000009Z', '2026-10-03T00:00:00.0000001Z'))).data).toHaveLength(
			3
		)
	})

	it('need both dates (422; Mastodon answers 500)', async () => {
		const w = await world()
		for (const dates of [{}, { start_at: '2026-10-01' }, { end_at: '2026-10-01' }, { start_at: '', end_at: '' }]) {
			for (const key of ['new_users', 'opened_reports', 'resolved_reports']) {
				expect(
					await measure(w, {
						keys: ['instance_media_attachments', key],
						...dates,
						instance_media_attachments: { domain: D },
					})
				).toEqual({
					status: 422,
					body: { error: `measure ${key} needs start_at and end_at` },
				})
			}
		}
	})
})

describe('the dates a measure accepts', () => {
	it('lie from 1583-01-01 to 9998-12-31, as written and as UTC instants; others answer 422 to every caller', async () => {
		const w = await world()
		const alice = await userToken(w.h, 'alice@example.com', ADMIN_SCOPES)
		const invalid = { status: 422, body: { error: 'Invalid date supplied' } }
		for (const [start, end] of [
			['1583-01-01', '1583-01-02'],
			['1583-01-01T00:00:00Z', '1583-01-01T00:00:00Z'],
			['9998-12-30', '9998-12-31'],
			['9998-12-31T23:59:59.999999999Z', '9998-12-31T23:59:59.999999999Z'],
		]) {
			const answer = await measure(w, newUsers(start!, end!))
			expect(answer.status, `${start} ${end}`).toBe(200)
			expect((answer.body as Measure[])[0]!.data.every((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date))).toBe(true)
		}
		for (const [start, end] of [
			['1582-12-31', '1583-01-02'],
			['1583-01-01', '9999-01-01'],
			['9999-01-01', '9999-01-02'],
			// Written within the years, but an instant outside: 9999-01-01 01:00 UTC, and 1582-12-31 23:00 UTC.
			['9998-12-31', '9998-12-31T23:00:00-02:00'],
			['1583-01-01T01:00:00+02:00', '1583-01-02'],
			['0001-01-01', '0001-01-02'],
		]) {
			for (const token of [w.admin, alice, null]) {
				expect(await measure(w, newUsers(start!, end!), token), `${start} ${end}`).toEqual(invalid)
				expect(await measure(w, { ...instance('instance_follows', D), start_at: start, end_at: end }, token)).toEqual(
					invalid
				)
			}
		}
	})
	it('count a previous window before the Gregorian reform in the proleptic Gregorian calendar', async () => {
		const w = await world()
		await localsAt(w, '2026-10-01T00:00:00.000Z')
		await localAccounts(w, 1, '1581-12-25T00:00:00.000Z')
		await localAccounts(w, 2, '1582-01-01T00:00:00.000Z')
		await localAccounts(w, 4, '1582-06-01T12:00:00.000Z')
		await localAccounts(w, 8, '1583-01-01T00:00:00.000Z')
		// L is 365 days: Kopje's previous window is 1582-01-01 to 1583-01-01 00:00. Ruby's Date - 365 is Julian before
		// 1582-10-15, so Mastodon's starts on 1581-12-22 and would count the 1581-12-25 account too (1 + 2 + 4 + 8).
		expect(await only(w, newUsers('1583-01-01', '1584-01-01'))).toMatchObject({
			total: '8',
			previous_total: String(2 + 4 + 8),
		})
	})
})

describe('the measures opened_reports and resolved_reports', () => {
	it('count the reports filed, local and inbound, and those resolved, by action_taken_at', async () => {
		const w = await world()
		const base = await remoteAccountsOn(w, 2, D)
		const remote = String(base + 1).padStart(18, '0')
		const other = String(base + 2).padStart(18, '0')
		await reportsOf(w, 2, w.alice.id, remote, '2026-10-01T10:00:00.000Z')
		// Inbound Flags: a remote reporter of a local account.
		await reportsOf(w, 3, other, w.bob.id, '2026-10-02T10:00:00.000Z')
		await reportsOf(w, 1, w.alice.id, remote, '2026-09-20T10:00:00.000Z', '2026-10-02T10:00:00.000Z')
		await reportsOf(w, 4, w.alice.id, remote, '2026-10-01T11:00:00.000Z', '2026-10-03T00:00:00.000Z')
		const range = { start_at: '2026-10-01', end_at: '2026-10-03' }
		expect(await only(w, { keys: ['opened_reports'], ...range })).toEqual({
			key: 'opened_reports',
			unit: null,
			total: '9',
			previous_total: '0',
			data: [point('2026-10-01', '6'), point('2026-10-02', '3'), point('2026-10-03', '0')],
		})
		expect(await only(w, { keys: ['resolved_reports'], ...range })).toEqual({
			key: 'resolved_reports',
			unit: null,
			total: '5',
			previous_total: '0',
			data: [point('2026-10-01', '0'), point('2026-10-02', '1'), point('2026-10-03', '4')],
		})
		// A reopened report (action_taken_at back to NULL) is unresolved again, through the admin API.
		const [id] = await sql<{ id: number }>(
			w.h.store,
			'SELECT id FROM reports WHERE action_taken_at IS NOT NULL LIMIT 1'
		)
		const reopened = await w.h.request(`/api/v1/admin/reports/${id!.id}/reopen`, bearer(w.admin, { method: 'POST' }))
		expect(reopened.status).toBe(200)
		expect((await only(w, { keys: ['resolved_reports'], ...range })).total).toBe('4')
		expect((await only(w, { keys: ['opened_reports'], ...range })).total).toBe('9')
	})
})

describe('the instance_* measures', () => {
	it("instance_accounts: count the domain's accounts not being deleted, all time; the series of the domain itself", async () => {
		const w = await world()
		const base = await remoteAccountsOn(w, 4, D)
		await remoteAccountsOn(w, 2, 'sub.d.example')
		await remoteAccountsOn(w, 5, 'other.example')
		await sql(w.h.store, "UPDATE accounts SET created_at = '2026-10-01T05:00:00.000Z' WHERE domain IS NOT NULL")
		// A deletion in progress (its Delete arrived, the purge has not ended) is not counted.
		await sql(
			w.h.store,
			"UPDATE accounts SET deleted_at = '2026-10-01T06:00:00.000Z' WHERE id = ?",
			String(base + 1).padStart(18, '0')
		)
		const m = await only(w, instance('instance_accounts', D))
		expect(m).toEqual({ key: 'instance_accounts', unit: null, total: '3', data: [] })
		expect(Object.keys(m)).toEqual(['key', 'unit', 'total', 'data'])
		const range = { start_at: '2026-10-01', end_at: '2026-10-02' }
		expect(await only(w, instance('instance_accounts', D, { include_subdomains: true }, range))).toEqual({
			key: 'instance_accounts',
			unit: null,
			total: '5',
			data: [point('2026-10-01', '3'), point('2026-10-02', '0')],
		})
		expect((await only(w, instance('instance_accounts', 'sub.d.example'))).total).toBe('2')
		// No local account is on a domain; an absent or empty domain counts 0 (Mastodon counts the local accounts).
		for (const domain of ['', null, 'kopje.test', 'nothing.example']) {
			expect(await only(w, instance('instance_accounts', domain, {}, range))).toEqual({
				key: 'instance_accounts',
				unit: null,
				total: '0',
				data: [point('2026-10-01', '0'), point('2026-10-02', '0')],
			})
		}
	})

	it("instance_followers: count the domain's accounts' accepted follows of local accounts", async () => {
		const w = await world()
		await followersOn(w, w.alice.id, 3, D)
		await followersOn(w, w.bob.id, 2, 'sub.d.example')
		await followersOn(w, w.carol.id, 4, D, 'pending')
		// Local accounts' follows of the domain are instance_follows, not instance_followers.
		await followed(w, w.dan.id, 6, D)
		expect(await only(w, instance('instance_followers', D))).toEqual({
			key: 'instance_followers',
			unit: null,
			total: '3',
			data: [],
		})
		expect((await only(w, instance('instance_followers', D, { include_subdomains: '1' }))).total).toBe('5')
		expect((await only(w, instance('instance_follows', D))).total).toBe('6')
	})

	it("instance_follows: date a local account's request by the request when the remote Accept comes later", async () => {
		const w = await world()
		const base = await remoteAccountsOn(w, 1, D)
		const remote = String(base + 1).padStart(18, '0')
		await sql(w.h.store, 'UPDATE accounts SET locked = 1, inbox_url = ? WHERE id = ?', `https://${D}/inbox`, remote)
		// Day A: the follow API sends the request.
		const requested = await w.h.request(`/api/v1/accounts/${remote}/follow`, bearer(w.alice.token, { method: 'POST' }))
		expect(requested.status).toBe(200)
		const [row] = await sql<{ uri: string; state: string; created_at: string }>(
			w.h.store,
			'SELECT uri, state, created_at FROM follows WHERE account_id = ? AND target_account_id = ?',
			w.alice.id,
			remote
		)
		expect(row!.state).toBe('pending')
		const dayA = row!.created_at.slice(0, 10)
		const day = (n: number) => new Date(Date.parse(dayA) + n * DAY_MS).toISOString().slice(0, 10)
		const range = { start_at: day(0), end_at: day(2) }
		expect((await only(w, instance('instance_follows', D, {}, range))).total).toBe('0')
		// Day B: the inbox Accept, as the Worker hands it to the Store once verified.
		const [actor] = await sql<{ uri: string }>(w.h.store, 'SELECT uri FROM accounts WHERE id = ?', remote)
		const accepted = await storeReceive(
			w.h.store,
			actor!.uri,
			{
				type: 'Accept',
				id: `${actor!.uri}#accepts/1`,
				object: { id: row!.uri, type: 'Follow', actor: null, object: null },
			},
			Date.parse(dayA) + 2 * DAY_MS
		)
		expect(accepted).toMatchObject({ applied: true })
		expect(await sql(w.h.store, 'SELECT state, created_at FROM follows WHERE uri = ?', row!.uri)).toEqual([
			{ state: 'accepted', created_at: row!.created_at },
		])
		expect(await only(w, instance('instance_follows', D, {}, range))).toMatchObject({
			total: '1',
			data: [point(day(0), '1'), point(day(1), '0'), point(day(2), '0')],
		})
	})

	it('instance_followers: date an accepted request by the request (Kopje keeps its created_at)', async () => {
		const w = await world()
		await sql(w.h.store, 'UPDATE accounts SET locked = 1 WHERE id = ?', w.alice.id)
		await followersOn(w, w.alice.id, 1, D, 'pending')
		await sql(w.h.store, "UPDATE follows SET created_at = '2026-10-01T09:00:00.000Z'")
		const [request] = await sql<{ id: string }>(
			w.h.store,
			"SELECT account_id AS id FROM follows WHERE state = 'pending'"
		)
		const range = { start_at: '2026-10-01', end_at: '2026-10-02' }
		expect((await only(w, instance('instance_followers', D, {}, range))).total).toBe('0')
		const authorized = await w.h.request(
			`/api/v1/follow_requests/${request!.id}/authorize`,
			bearer(w.alice.token, { method: 'POST' })
		)
		expect(authorized.status).toBe(200)
		expect(await only(w, instance('instance_followers', D, {}, range))).toMatchObject({
			total: '1',
			data: [point('2026-10-01', '1'), point('2026-10-02', '0')],
		})
	})

	it('instance_reports: count the reports whose target is on the domain', async () => {
		const w = await world()
		const base = await remoteAccountsOn(w, 2, D)
		const sub = await remoteAccountsOn(w, 1, 'sub.d.example')
		const id = (n: number) => String(n).padStart(18, '0')
		await reportsOf(w, 3, w.alice.id, id(base + 1), '2026-10-01T10:00:00.000Z')
		await reportsOf(w, 2, w.bob.id, id(sub + 1), '2026-10-01T10:00:00.000Z')
		// An inbound Flag of a local account, by an account on the domain: not a report of the domain.
		await reportsOf(w, 4, id(base + 2), w.carol.id, '2026-10-01T10:00:00.000Z')
		const range = { start_at: '2026-10-01', end_at: '2026-10-01' }
		expect(await only(w, instance('instance_reports', D, {}, range))).toEqual({
			key: 'instance_reports',
			unit: null,
			total: '3',
			data: [point('2026-10-01', '3')],
		})
		expect(await only(w, instance('instance_reports', D, { include_subdomains: true }, range))).toMatchObject({
			total: '5',
			data: [point('2026-10-01', '3')],
		})
	})

	it('instance_media_attachments: always 0 bytes, converted remote media included', async () => {
		const w = await world()
		const base = await remoteAccountsOn(w, 1, D)
		// A converted remote attachment: its URL only, no stored file.
		await sql(
			w.h.store,
			`INSERT INTO media_attachments (id, account_id, type, url)
			VALUES ('700000000000000001', ?, 'image', 'https://d.example/m.png')`,
			String(base + 1).padStart(18, '0')
		)
		const range = { start_at: '2026-10-01', end_at: '2026-10-02' }
		const m = await only(w, instance('instance_media_attachments', D, { include_subdomains: true }, range))
		expect(m).toEqual({
			key: 'instance_media_attachments',
			unit: 'bytes',
			total: '0',
			human_value: '0 Bytes',
			data: [point('2026-10-01', '0'), point('2026-10-02', '0')],
		})
		expect(Object.keys(m)).toEqual(['key', 'unit', 'total', 'human_value', 'data'])
	})
})

describe('the keys Kopje does not serve (MD-2)', () => {
	it('answer 422 to the OAuth admin and 403 to everyone else, the whole request', async () => {
		const w = await world()
		const alice = await userToken(w.h, 'alice@example.com', ADMIN_SCOPES)
		const range = { start_at: '2026-10-01', end_at: '2026-10-02' }
		for (const key of [
			'active_users',
			'interactions',
			'tag_accounts',
			'tag_uses',
			'tag_servers',
			'instance_statuses',
		]) {
			const body = { keys: [key], [key]: { id: '1', domain: D }, ...range }
			expect(await measure(w, body)).toEqual({ status: 422, body: { error: `measure ${key} is not served` } })
			for (const token of [alice, null]) {
				expect(await measure(w, body, token)).toEqual({ status: 403, body: { error: 'This action is not allowed' } })
			}
			const mixed = {
				...instance('instance_follows', D, {}, range),
				keys: ['instance_follows', key],
				[key]: { id: '1' },
			}
			expect(await measure(w, mixed)).toEqual({ status: 422, body: { error: `measure ${key} is not served` } })
		}
	})
})

describe('stored times that cannot be read', () => {
	const unreadable = (key: string) => ({
		status: 422,
		body: { error: `measure ${key}: stored times not readable; the total is not known` },
	})

	it('answer 422, never a count without them', async () => {
		const w = await world()
		await localsAt(w, '2026-10-01T00:00:00.000Z')
		const range = { start_at: '2026-10-01', end_at: '2026-10-02' }
		expect((await only(w, newUsers(range.start_at, range.end_at))).total).toBe('5')
		const values: [string, string][] = [
			["'now'", 'now'],
			["'2026-10-01 00:00:00'", 'SQLite datetime'],
			["'2026-10-01T00:00:00.000Z' || char(0)", 'a NUL after a valid value'],
			["'2026-10-01T00:00:00' || char(0) || '00Z'", 'a NUL inside'],
			["CAST(x'323032362d31302d30315430303a30303a30302e303030c0' AS TEXT)", 'malformed UTF-8'],
			["'2026-10-01T00:00:00.000Z' || printf('%.100000c', ' ')", 'oversized'],
			["'2026-10-01T00:00:00.000+00:00'", 'another zone suffix'],
			["'2026-10-01T00:00:00.0Z'", 'a short fraction'],
			["'2026-10-01T00:00:00.00000Z'", 'a long fraction'],
			["'2026-10-01T24:00:00.000Z'", 'hour 24'],
			["'2026-02-30T00:00:00.000Z'", 'no such day'],
		]
		for (const [value, why] of values) {
			await sql(w.h.store, `UPDATE local_accounts SET created_at = ${value} WHERE account_id = ?`, w.dan.id)
			expect(await measure(w, newUsers(range.start_at, range.end_at)), why).toEqual(unreadable('new_users'))
		}
		await sql(w.h.store, "UPDATE local_accounts SET created_at = '2026-10-01T00:00:00.000Z'")
		// An unresolved report's NULL action_taken_at is no time, not an unreadable one.
		await reportsOf(w, 2, w.alice.id, w.bob.id, '2026-10-01T01:00:00.000Z')
		expect((await only(w, { keys: ['resolved_reports'], ...range })).total).toBe('0')
		await reportsOf(w, 1, w.alice.id, w.bob.id, 'now', '2026-10-01T02:00:00.000Z')
		expect(await measure(w, { keys: ['opened_reports'], ...range })).toEqual(unreadable('opened_reports'))
		expect((await only(w, { keys: ['resolved_reports'], ...range })).total).toBe('1')
		await reportsOf(w, 1, w.alice.id, w.bob.id, '2026-10-01T03:00:00.000Z', 'now')
		expect(await measure(w, { keys: ['resolved_reports'], ...range })).toEqual(unreadable('resolved_reports'))
	})

	it('instance_*: only a time the series needs (on the domain itself, with dates)', async () => {
		const w = await world()
		await remoteAccountsOn(w, 2, D)
		await remoteAccountsOn(w, 1, 'sub.d.example')
		await sql(w.h.store, "UPDATE accounts SET created_at = 'now' WHERE domain = 'sub.d.example'")
		const range = { start_at: '2026-10-01', end_at: '2026-10-02' }
		expect((await only(w, instance('instance_accounts', D, { include_subdomains: true }, range))).total).toBe('3')
		await sql(w.h.store, "UPDATE accounts SET created_at = 'now' WHERE domain = ?", D)
		expect((await only(w, instance('instance_accounts', D, { include_subdomains: true }))).total).toBe('3')
		expect(await measure(w, instance('instance_accounts', D, {}, range))).toEqual(unreadable('instance_accounts'))
	})
})
