import { expect } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { olderOf } from './web-helpers'
import { jsonBytes } from '../src/domain/answer-budget'
import { LONGEST_STATUS_STUB } from '../src/domain/web-pages/budget'
import type { ProfilePage } from '../src/domain/web-pages/profile'
import type { Site } from '../src/domain/web-pages/site'
import type { StoreStub } from '../src/platform/store-client'

// The profile page read in tests: walking its older pages, seeding pins and its frame.

type ProfileOk = Extract<ProfilePage, { status: 'ok' }>

// A profile tab walked by its older cursor (design §4) from the first page to the last: the ids each page showed or
// stubbed, in order, and what each page held. Every page moves on: its continuation is the last item it consumed.
export async function walkProfile(read: (maxId: string | null) => Promise<ProfileOk>, requests = 100) {
	const seen: string[] = []
	const pages: { shown: number; stub: boolean }[] = []
	let maxId: string | null = null
	for (let request = 0; ; request++) {
		expect(request).toBeLessThan(requests)
		const page = await read(maxId)
		const ids = [...(page.stub === null ? [] : [page.stub.id]), ...page.statuses.map((status) => status.id)]
		seen.push(...ids)
		pages.push({ shown: page.statuses.length, stub: page.stub !== null })
		maxId = olderOf(page)
		if (maxId === null) {
			break
		}
		expect(ids.length).toBeGreaterThan(0)
		expect(maxId).toBe(ids.at(-1))
	}
	return { seen, pages }
}

// Pins `ids` for `account` in that order, a second apart up to NOW, so the last is the newest pin.
export async function pinStatuses(store: StoreStub, account: string, ids: readonly string[]): Promise<void> {
	for (const [i, id] of ids.entries()) {
		await sql(
			store,
			'INSERT INTO status_pins (account_id, status_id, created_at) VALUES (?, ?, ?)',
			account,
			id,
			new Date(NOW - 1000 * (ids.length - i)).toISOString()
		)
	}
}

// The frame a profile answer reserves (design §2), stated apart from the read's own: its shape with no pins or posts,
// the longest stub, both paging ends at 19 digits, and the site facts.
export function profileFrameBytes(site: Site): number {
	return jsonBytes({
		status: 'ok',
		account: null,
		pins: [],
		statuses: [],
		stub: LONGEST_STATUS_STUB,
		parents: {},
		paging: { newest: '9'.repeat(19), oldest: '9'.repeat(19), more: true },
		site,
	})
}
