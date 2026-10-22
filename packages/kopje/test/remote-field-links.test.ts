import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { blockDomain } from './domain-block-helpers'
import remote from './fixtures/mastodon-4.5.11-remote-links.json'
import { migratedStore } from './helpers'
import { actorDefaults } from './inbox-helpers'
import { observedSql } from './read-helpers'
import { Db } from '../src/db/sql'
import { MAX_REMOTE_FIELDS } from '../src/domain/accounts'
import { purgeBatch, receiveActivity, type RemoteActorInput, upsertRemoteActor } from '../src/domain/inbox'
import { REMOTE_LINK_RECHECK_MS } from '../src/domain/remote-field-links'
import { suspendRemote } from '../src/domain/remote-suspension'
import { REMOTE_FIELD_INDEXES, REMOTE_VERIFIED_SHOWN, SAFE_INTEGER_MAX } from '../src/platform/stored-bounds'

// The ingestion half of remote field verification (domain/remote-field-links.ts armRemoteFieldLinks, from inbox.ts
// upsertRemoteActor): which links a store tracks, what it carries over, and its fences.

const ORIGIN = 'https://kopje.test'
const URI = 'https://remote.example/users/a'
const link = (href: string) => `<a href="${href}">${href}</a>`
const A = 'https://a.example/'
const B = 'https://b.example/'
const C = 'https://c.example/'

type Row = {
	account_id: string
	link_back: string
	links: string
	generation: number
	claim: number
	attempts: number
	due_at: number | null
	armed_at: number | null
	hold_until: number | null
	checked_at: number | null
}

const property = (value: string, name = 'f') => ({ type: 'PropertyValue', name, value })

function actor(attachment: unknown, extra: Partial<RemoteActorInput> = {}, uri = URI): RemoteActorInput {
	return {
		...actorDefaults(),
		uri,
		username: 'a',
		domain: 'remote.example',
		displayName: 'a',
		inboxUrl: `${uri}/inbox`,
		movedTo: null,
		raw: JSON.stringify({ id: uri, attachment }),
		...extra,
	}
}

async function world() {
	const store = await migratedStore()
	const clock = { t: NOW }
	// One store of `input` in its own transaction, with the statements that touch remote_field_links counted.
	const put = (input: RemoteActorInput) =>
		runInDurableObject(store, (_instance, state) => {
			let statements = 0
			const counted = observedSql(state.storage.sql, (_rows, query) => {
				if (query.includes('remote_field_links')) {
					statements++
				}
			})
			const stored = state.storage.transactionSync(() => upsertRemoteActor(new Db(counted), input, ORIGIN, clock.t))
			return { id: stored?.id, statements }
		})
	const row = async (uri = URI) =>
		(
			await sql<Row>(
				store,
				'SELECT r.* FROM remote_field_links r JOIN accounts a ON a.id = r.account_id WHERE a.uri = ?',
				uri
			)
		)[0]
	const links = async (uri = URI) => {
		const found = await row(uri)
		return found === undefined ? undefined : (JSON.parse(found.links) as unknown[])
	}
	return { store, clock, put, row, links }
}

describe('arming remote field links at a store', () => {
	it('tracks the first REMOTE_VERIFIED_SHOWN shown links, by their index among the shown fields', async () => {
		const w = await world()
		const hrefs = Array.from({ length: 6 }, (_, i) => `https://v${i}.example/`)
		const fields = [property('no link'), ...hrefs.map((href) => property(link(href))), { type: 'Note', name: 'x' }]
		const { statements } = await w.put(actor(fields))
		expect(statements).toBeLessThanOrEqual(2)
		expect(await w.links()).toEqual(hrefs.slice(0, REMOTE_VERIFIED_SHOWN).map((href, i) => [i + 1, href, null, 0]))
		expect(await w.row()).toMatchObject({ link_back: URI, due_at: NOW, armed_at: NOW, attempts: 0, claim: 0 })
		expect(REMOTE_FIELD_INDEXES).toBe(MAX_REMOTE_FIELDS)
	})

	it('takes the url as the link back only on the actor id’s hostname', async () => {
		const w = await world()
		await w.put(actor([property(link(A))], { url: 'https://remote.example/@a' }))
		expect((await w.row())!.link_back).toBe('https://remote.example/@a')
		await w.put(actor([property(link(A))], { url: 'https://elsewhere.example/@a' }))
		expect((await w.row())!.link_back).toBe(URI)
	})

	it('follows the attachment cases of the pinned Mastodon fixture, the over-acceptance ones refused', async () => {
		type Attachment = { attachment: unknown; links: number[]; reason: string; overAcceptance?: true }
		const cases = (remote as { attachments: { cases: Attachment[] } }).attachments.cases
		expect(cases.filter((c) => c.overAcceptance === true)).toHaveLength(3)
		for (const { attachment, links, reason } of cases) {
			const w = await world()
			await w.put(actor(attachment))
			const tracked = (await w.links()) ?? []
			expect(
				tracked.map((entry) => (entry as [number])[0]),
				reason
			).toEqual(links)
		}
	})

	it('deletes the row when no candidate is left, and stores no row for an account with none', async () => {
		const w = await world()
		await w.put(actor([property(link(A))]))
		expect(await w.row()).toBeDefined()
		const { statements } = await w.put(actor([property('text')]))
		expect(statements).toBe(1)
		expect(await w.row()).toBeUndefined()
	})

	it('carries a verification over from one donor per href while the link back stays', async () => {
		const w = await world()
		await w.put(actor([property(link(A)), property(link(A)), property(link(B))]))
		// The first A verified, the second unverified and checked (as a record would leave them), B checked recently.
		await sql(
			w.store,
			'UPDATE remote_field_links SET links = ?, checked_at = ?, due_at = NULL, armed_at = NULL',
			JSON.stringify([
				[0, A, '2026-10-01T00:00:00.000Z', 1],
				[1, A, null, 1],
				[2, B, null, 1],
			]),
			NOW
		)
		const before = (await w.row())!
		// Reordered: B first, then A twice and a new C. Each new entry takes the first stored entry with its href.
		w.clock.t = NOW + 1000
		await w.put(actor([property(link(B)), property(link(A)), property(link(A)), property(link(C))]))
		expect(await w.links()).toEqual([
			[0, B, null, 1],
			[1, A, '2026-10-01T00:00:00.000Z', 1],
			[2, A, '2026-10-01T00:00:00.000Z', 1],
			[3, C, null, 0],
		])
		const after = (await w.row())!
		expect(after.generation).toBe(before.generation + 1)
		expect(after).toMatchObject({ due_at: NOW + 1000, armed_at: NOW + 1000 })
		// A changed link back carries nothing over.
		await w.put(actor([property(link(B))], { url: 'https://remote.example/@a' }))
		expect(await w.links()).toEqual([[0, B, null, 0]])
	})

	it('checks an unverified link again at a store once its last negative check is a day old', async () => {
		const w = await world()
		await w.put(actor([property(link(A))]))
		await sql(
			w.store,
			'UPDATE remote_field_links SET links = ?, checked_at = ?, due_at = NULL, armed_at = NULL',
			JSON.stringify([[0, A, null, 1]]),
			NOW
		)
		const generation = (await w.row())!.generation
		w.clock.t = NOW + REMOTE_LINK_RECHECK_MS - 1
		await w.put(actor([property(link(A))]))
		expect(await w.row()).toMatchObject({ links: JSON.stringify([[0, A, null, 1]]), due_at: null, generation })
		w.clock.t = NOW + REMOTE_LINK_RECHECK_MS
		await w.put(actor([property(link(A))]))
		expect(await w.row()).toMatchObject({ links: JSON.stringify([[0, A, null, 0]]), due_at: w.clock.t, generation })
	})

	it('keeps an open claim and its hold across a store that changes nothing, and resets attempts on a change', async () => {
		const w = await world()
		await w.put(actor([property(link(A))]))
		await sql(
			w.store,
			'UPDATE remote_field_links SET claim = 5, attempts = 1, hold_until = ?, due_at = ?',
			NOW + 300_000,
			NOW + 300_000
		)
		await w.put(actor([property(link(A))]))
		expect(await w.row()).toMatchObject({ claim: 5, attempts: 1, due_at: NOW + 300_000, hold_until: NOW + 300_000 })
		await w.put(actor([property(link(B))]))
		expect(await w.row()).toMatchObject({ claim: 5, attempts: 0, due_at: NOW + 300_000 })
	})

	it('draws a fresh generation when the row is recreated, and deletes it when its generation is exhausted', async () => {
		const w = await world()
		await w.put(actor([property(link(A))]))
		const first = (await w.row())!.generation
		await w.put(actor([]))
		await w.put(actor([property(link(A))]))
		expect((await w.row())!.generation).not.toBe(first)
		await sql(w.store, 'UPDATE remote_field_links SET generation = ?', SAFE_INTEGER_MAX)
		// Unchanged: kept at the bound.
		await w.put(actor([property(link(A))]))
		expect((await w.row())!.generation).toBe(SAFE_INTEGER_MAX)
		// A change would pass it: the row goes, with its attestations.
		const { statements } = await w.put(actor([property(link(B))]))
		expect(statements).toBe(2)
		expect(await w.row()).toBeUndefined()
	})

	it('arms nothing on the frozen and covered paths', async () => {
		const w = await world()
		const { id } = await w.put(actor([property(link(A))]))
		await sql(w.store, 'DELETE FROM remote_field_links')
		await runInDurableObject(w.store, (_instance, state) => {
			suspendRemote(new Db(state.storage.sql), id!, null, NOW)
		})
		expect((await w.put(actor([property(link(A))]))).statements).toBe(0)
		expect(await w.row()).toBeUndefined()
		// A document whose host a domain block covers stores nothing either.
		const other = 'https://blocked.example/users/b'
		await blockDomain(w.store, 'blocked.example')
		expect((await w.put(actor([property(link(A))], { domain: 'blocked.example' }, other))).statements).toBe(0)
		expect(await w.row(other)).toBeUndefined()
	})

	it('stores at most two actors’ rows in a Move, with at most two statements each', async () => {
		const w = await world()
		const target = 'https://remote.example/users/t'
		const statements = await runInDurableObject(w.store, (_instance, state) => {
			let n = 0
			const counted = observedSql(state.storage.sql, (_rows, query) => {
				if (query.includes('remote_field_links')) {
					n++
				}
			})
			receiveActivity.run(counted, {
				now: NOW,
				storeNow: NOW,
				origin: ORIGIN,
				actorUri: URI,
				actor: actor([property(link(A))], { movedTo: target }),
				activity: { type: 'Move', id: `${URI}#moves/1`, target: actor([property(link(B))], {}, target) },
			})
			return n
		})
		expect(statements).toBeLessThanOrEqual(4)
		expect(await w.links()).toEqual([[0, A, null, 0]])
		expect(await w.links(target)).toEqual([[0, B, null, 0]])
	})

	it('is deleted by the purge of its account, within its batch', async () => {
		const w = await world()
		await w.put(actor([property(link(A))]))
		await sql(w.store, "UPDATE accounts SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE uri = ?", URI)
		await runInDurableObject(w.store, (_instance, state) =>
			state.storage.transactionSync(() => purgeBatch(new Db(state.storage.sql), URI, NOW))
		)
		expect(await sql(w.store, 'SELECT count(*) AS n FROM remote_field_links')).toEqual([{ n: 0 }])
		expect(await sql(w.store, 'SELECT count(*) AS n FROM accounts WHERE uri = ?', URI)).toEqual([{ n: 0 }])
	})
})
