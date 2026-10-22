import { expect } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { mastodonActor } from './inbox-helpers'
import { announce, AS, followed, mastodonNote, OTHER, setup } from './inbox-status-helpers'
import { ACCOUNT_STALE_MS } from '../src/domain/inbox'

// Fixtures of the stale-author refetch (domain/inbox.ts staleAccount), shared by test/inbox-stale-authors.test.ts and
// test/inbox-regressions.test.ts.

// Sets a stored account's fetched_at (the clock and the account's keys stay as they are).
export function ageAccount(t: { store: Parameters<typeof sql>[0] }, uri: string, fetchedAt: string | null) {
	return sql(t.store, 'UPDATE accounts SET fetched_at = ? WHERE uri = ?', fetchedAt, uri)
}

// bob, followed by alice, and erin on another server, stored by a first boost of hers and aged a day; nothing fetched
// yet. clock: the app's clock, which a test may move.
export async function staleAuthorWorld(clock = { now: NOW }) {
	const t = await setup(clock)
	const bob = await mastodonActor(t.web, 'bob')
	await followed(t, bob)
	const erin = await mastodonActor(t.web, 'erin', { origin: OTHER, key: 3 })
	const first = mastodonNote(erin)
	t.web.serve(first.id, { '@context': AS, ...first })
	expect(await t.post(bob, announce(bob, first.id))).toBe(202)
	expect(await sql(t.store, 'SELECT fetched_at FROM accounts WHERE uri = ?', erin.uri)).toEqual([
		{ fetched_at: new Date(NOW).toISOString() },
	])
	await ageAccount(t, erin.uri, new Date(NOW - ACCOUNT_STALE_MS).toISOString())
	t.web.fetched.length = 0
	return { t, bob, erin, clock }
}
