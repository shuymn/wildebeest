import { describe, expect, it } from 'vitest'

import { announcementAdmin, seedAnnouncement } from './announcement-helpers'
import { seedAccount, sql } from './api-helpers'
import { completeSetup, migratedStore } from './helpers'
import { seedEmojiRow } from './local-emoji-helpers'
import { copyConfig, dumpViaRpc, importViaRpc, setAccess } from './ops-helpers'
import type { StoreStub } from '../src/platform/store-client'

// Announcements in dumps (docs/dump-format.md "Stored bounds"): the three tables round-trip at their caps, an import
// is held to the CHECKs and triggers of 0056_announcements (refused with their names), and a reaction whose custom
// emoji was disabled since still imports.

const FUTURE = '2099-01-01T00:00:00.000Z'
const TABLES = ['announcements', 'announcement_reactions', 'announcement_dismissals']

async function rows(store: StoreStub) {
	return Promise.all(TABLES.map((table) => sql(store, `SELECT * FROM ${table} ORDER BY 1, 2`)))
}

async function source() {
	const store = await migratedStore()
	await setAccess(store)
	await completeSetup(store)
	const admin = announcementAdmin(store)
	const alice = await seedAccount(store, { username: 'alice', email: 'alice@example.com' })
	const bob = await seedAccount(store, { username: 'bob', email: 'bob@example.com' })
	const live: string[] = []
	for (let i = 0; i < 8; i++) {
		live.push((await admin.create({ text: i === 0 ? 'blankme' : `published ${i}` })).id)
		await admin.create({ text: `scheduled ${i}`, scheduledAt: FUTURE })
	}
	await seedAnnouncement(store, { id: '200000000000000001', text: 'draft', published: 0, published_at: null })
	const emoji = await seedEmojiRow(store, { id: '300000000000000001', shortcode: 'blob', owner: alice })
	const first = live[0]!
	for (const [name, emojiId] of ['1⃣', '2⃣', '3⃣', '4⃣', '5⃣', '6⃣', '7⃣']
		.map((n) => [n, null] as const)
		.concat([['blob', emoji.id] as const])) {
		for (const account of [alice, bob]) {
			await sql(
				store,
				'INSERT INTO announcement_reactions (announcement_id, account_id, name, custom_emoji_id) VALUES (?, ?, ?, ?)',
				first,
				account,
				name,
				emojiId
			)
		}
	}
	await sql(store, "UPDATE custom_emojis SET disabled = 1 WHERE id = '300000000000000001'")
	for (const id of live) {
		await sql(store, 'INSERT INTO announcement_dismissals (account_id, announcement_id) VALUES (?, ?)', alice, id)
	}
	return store
}

describe('announcements in dumps', () => {
	it('round-trip at the caps, with a reaction of a custom emoji disabled since', async () => {
		const store = await source()
		const { text } = await dumpViaRpc(store)
		const target = await migratedStore()
		await copyConfig(store, target)
		expect((await importViaRpc(target, text)).report).toMatchObject({ ok: true, problems: [] })
		expect(await rows(target)).toEqual(await rows(store))
		expect((await rows(target)).map((table) => table.length)).toEqual([17, 16, 8])
	}, 60_000)

	it('are refused on import past their bounds, with the constraint’s name', async () => {
		const store = await source()
		const { text } = await dumpViaRpc(store)
		const cases: [string, string, RegExp][] = [
			["'blankme'", "' '", /announcement_text_within_10000_bytes/],
			["'1⃣'", "'a'", /announcement_reaction_name_within_128_bytes/],
			[`'${FUTURE}'`, "'2099-01-01T24:00:00.000Z'", /announcement_times_iso/],
			["'blob'", "'blab'", /a custom emoji reaction is named by its shortcode|custom_emojis/],
		]
		for (const [from, to, refused] of cases) {
			const changed = text.replace(from, to)
			expect(changed, from).not.toBe(text)
			const target = await migratedStore()
			await copyConfig(store, target)
			await expect(importViaRpc(target, changed), from).rejects.toThrow(refused)
		}
	}, 120_000)
})
