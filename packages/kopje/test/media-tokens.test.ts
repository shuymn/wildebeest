import { runInDurableObject } from 'cloudflare:test'

import { beforeEach, describe, expect, it } from 'vitest'

import { adminClaims, adminHarness, adminTeam, setTeamAccess } from './access-helpers'
import { type AccessTeam, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { PNG_PLAIN } from './fixtures/images'
import { base64, emojiStore, pngOf } from './local-emoji-helpers'
import { bytes, mediaForm, r2Keys, TestCodec, upload } from './media-helpers'
import { community } from './status-helpers'
import { Db } from '../src/db/sql'
import { insertReservation } from '../src/domain/media'
import type { StoreStub } from '../src/platform/store-client'

// A file token is unique across every owner of files/<token>/: an upload's or emoji's reservation whose token a stored
// card image, a tombstone (a card image claim's included) or another upload holds is refused before anything is
// counted, charged, encoded or written, and answered 503.

type Owner = 'card_images' | 'media_orphans' | 'media_attachments'
const OWNERS: Owner[] = ['card_images', 'media_orphans', 'media_attachments']
const IMAGE_ID = '100000000000000777'

// Makes `token` held by `owner`, as each owner stores one.
function hold(state: DurableObjectState, owner: Owner, token: string, accountId: string): void {
	const sql = state.storage.sql
	if (owner === 'card_images') {
		sql.exec(
			`INSERT INTO card_images (id, source_url, enqueued_at, token, width, height, stored_at)
			VALUES (?, 'https://i.example/a.png', 1, ?, 1, 1, 1)`,
			IMAGE_ID,
			token
		)
	} else if (owner === 'media_orphans') {
		sql.exec(
			"INSERT INTO media_orphans (file_token, media_id, delete_after) VALUES (?, ?, '2026-10-24T00:00:00.000Z')",
			token,
			IMAGE_ID
		)
	} else {
		sql.exec(
			`INSERT INTO media_attachments (id, account_id, type, url, file_token, processed, gc_at, created_at)
			VALUES (?, ?, 'image', '', ?, 1, NULL, '2026-10-12T00:00:00.000Z')`,
			IMAGE_ID,
			accountId,
			token
		)
	}
}

// What a refused reservation must leave untouched: the reservations, the attempt and transformation counters.
async function trace(store: StoreStub) {
	const [counters] = await sql<{ n: number }>(
		store,
		"SELECT count(*) AS n FROM kopje_state WHERE name GLOB 'media_attempts:*' OR name GLOB 'images_*transforms:*'"
	)
	const [rows] = await sql<{ n: number }>(store, `SELECT count(*) AS n FROM media_attachments WHERE id <> ?`, IMAGE_ID)
	return { counters: counters!.n, reservations: rows!.n, files: (await r2Keys('files/')).length }
}

// A Store stub that makes the token of each `method` call held by `owner` right before the call reaches the Store.
function seeding(store: StoreStub, method: string, owner: Owner, accountId: () => string): StoreStub {
	return new Proxy(store, {
		get: (target, key) => {
			const real = Reflect.get(target, key) as unknown
			if (key !== method || typeof real !== 'function') {
				return real
			}
			const stub = target as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
			return async (build: string, input: { token: string }) => {
				await runInDurableObject(store, (_instance, state) => hold(state, owner, input.token, accountId()))
				return stub[method]!(build, input)
			}
		},
	}) as StoreStub
}

describe('the uniqueness of file tokens across their owners', () => {
	it.each(OWNERS)('inserts no reservation whose token %s holds, whatever its caller checked', async (owner) => {
		const h = await community(['alice'])
		const token = `taken-${owner}-${'x'.repeat(32)}`
		const inserted = await runInDurableObject(h.store, (_instance, state) => {
			hold(state, owner, token, h.users.alice.id)
			return insertReservation(new Db(state.storage.sql), h.users.alice.id, token, NOW)
		})
		expect(inserted).toEqual({ retry: true })
		const [held] = await sql<{ n: number }>(
			h.store,
			`SELECT (SELECT count(*) FROM media_attachments WHERE file_token = ?1)
				+ (SELECT count(*) FROM card_images WHERE token = ?1) + (SELECT count(*) FROM media_orphans WHERE file_token = ?1) AS n`,
			token
		)
		expect(held!.n).toBe(1)
	})

	it.each(OWNERS)(
		'answers an upload whose token %s takes meanwhile with 503: no reservation, encode or put',
		async (owner) => {
			const codec = new TestCodec()
			let alice = ''
			const h = await community(['alice'], 'read write follow', {
				images: () => codec,
				wrapStore: (store) => seeding(store, 'reserveMedia', owner, () => alice),
			})
			alice = h.users.alice.id
			const before = await trace(h.store)
			const response = await upload(h, h.users.alice, mediaForm(bytes(PNG_PLAIN), {}, 'a.png', 'image/png'))
			expect(response.status).toBe(503)
			expect(await response.json()).toEqual({ error: 'The upload could not be reserved; try again' })
			expect(codec.encodeCalls).toEqual([])
			expect(codec.infoCalls).toBe(0)
			expect(await trace(h.store)).toEqual(before)
		}
	)
})

describe('the uniqueness of file tokens for emoji', () => {
	let team: AccessTeam

	beforeEach(async () => {
		team = await adminTeam()
	})

	it.each(OWNERS)('answers an emoji whose token %s takes with 503, charging nothing', async (owner) => {
		const { store, adminId } = await emojiStore()
		await setTeamAccess(store, team)
		const codec = new TestCodec()
		const { post } = adminHarness(
			seeding(store, 'reserveEmoji', owner, () => adminId),
			team,
			{},
			undefined,
			() => codec
		)
		const before = await trace(store)
		const response = await post(adminClaims(), '/admin/emojis', { shortcode: 'blob', image: base64(await pngOf(4, 4)) })
		expect(response.status).toBe(503)
		expect(await response.json()).toMatchObject({ code: 'upload-retry' })
		expect(codec.encodeCalls).toEqual([])
		expect(await trace(store)).toEqual(before)
		expect(await sql(store, 'SELECT id FROM custom_emojis')).toEqual([])
	})
})
