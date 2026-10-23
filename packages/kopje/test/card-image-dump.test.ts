import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { cardWorld, pageWith } from './card-image-helpers'
import { migratedStore } from './helpers'
import { copyConfig, dumpViaRpc, importViaRpc, setAccess } from './ops-helpers'
import { encodeWebp } from './webp-fixtures'
import { selectSql } from '../src/db/columns'
import { claimCardImages } from '../src/domain/card-images'
import { claimCards, recordCard } from '../src/domain/link-cards'
import { type CardRow, presentCard } from '../src/domain/status-presenter'
import { CARD_COLUMN_MAP, SHOWN_CARD_JOIN, SHOWN_CARD_SQL } from '../src/domain/status-rows'
import type { StoreStub } from '../src/platform/store-client'

// Card images in dumps (AM12, docs/dump-format.md "What is not in a dump"): card_images and the tombstones are left
// out, status_cards keeps its image links, and the restored Store shows the cards without their images, takes no
// such copy as a donor, collects nothing, and fetches an image again for a new record.

const cards = (store: StoreStub) =>
	sql<{ status_id: string; image_url: string; image_id: string | null; image_description: string }>(
		store,
		'SELECT status_id, image_url, image_id, image_description FROM status_cards ORDER BY status_id'
	)

describe('card images in dumps', () => {
	it('are left out with their tombstones, the links kept, and the cards shown without them', async () => {
		const w = await cardWorld({ IMAGES_CARD_MONTHLY_TRANSFORMS: '10' })
		const body = await encodeWebp(64, 48)
		w.addRoutes({
			'https://site.example/stored': pageWith('https://cdn.example/stored.webp', 'Stored alt'),
			'https://cdn.example/stored.webp': () => new Response(body),
		})
		const stored = await w.postLink('https://site.example/stored')
		await w.cardRound()
		expect(await w.imageRound()).toMatchObject({ stored: 1 })
		w.addRoutes({ 'https://site.example/pending': pageWith('https://cdn.example/pending.webp', 'Pending alt') })
		const pending = await w.postLink('https://site.example/pending')
		await w.cardRound()
		// A claim's tombstone besides: the pending image claimed and never recorded.
		expect((await w.op(claimCardImages, { now: NOW, tokens: ['c'.repeat(43)], share: 10 })).claims).toHaveLength(1)
		const images = await w.images()
		expect(images.map((row) => row.stored_at === null)).toEqual([false, true])
		expect(await w.orphans()).toHaveLength(1)

		const { text } = await dumpViaRpc(w.h.store)
		expect(text).not.toMatch(/INSERT INTO "card_images"/)
		expect(text).not.toMatch(/INSERT INTO "media_orphans"/)
		const target = await migratedStore()
		await copyConfig(w.h.store, target)
		await setAccess(target)
		expect((await importViaRpc(target, text)).report).toMatchObject({ ok: true, problems: [] })
		expect(await sql(target, 'SELECT id FROM card_images')).toEqual([])
		expect(await sql(target, 'SELECT file_token FROM media_orphans')).toEqual([])
		const restored = await cards(target)
		expect(restored).toEqual(await cards(w.h.store))
		expect(restored.map((row) => [row.status_id, row.image_id !== null])).toEqual([
			[stored, true],
			[pending, true],
		])

		// Presented without an image or blurhash, with the alt text.
		const presented = await runInDurableObject(target, (_instance, state) =>
			state.storage.sql
				.exec<CardRow>(
					`SELECT ${selectSql(CARD_COLUMN_MAP)} FROM (SELECT value FROM json_each(?1)) j ${SHOWN_CARD_JOIN}
					WHERE ${SHOWN_CARD_SQL}`,
					JSON.stringify([stored, pending])
				)
				.toArray()
				.map((row) => presentCard({ visibility: 'public' }, row, 'https://kopje.test'))
		)
		expect(presented.map((card) => [card?.image, card?.blurhash, card?.image_description])).toEqual([
			[null, null, 'Stored alt'],
			[null, null, 'Pending alt'],
		])

		// The GC changes nothing (it collects stored rows only, and there are none).
		const op = <I, O>(operation: { run: (sql: SqlStorage, input: I) => O }, input: I) =>
			runInDurableObject(target, (_instance, s) => operation.run(s.storage.sql, input))
		expect(await op(claimCardImages, { now: NOW + 1, tokens: [], share: 0 })).toMatchObject({
			collected: 0,
			expired: 0,
			dropped: 0,
		})
		expect(await cards(target)).toEqual(restored)

		// A new status of the stored card's URL: the restored copy, whose image row is gone, is no donor, so the card is
		// fetched; its record inserts one pending row for the same image URL.
		const [{ id }] = (await sql<{ id: string }>(
			target,
			`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			SELECT '900000000000000001', 'https://kopje.test/s/new', account_id, 'public', 'x', published_at
			FROM statuses WHERE id = ? RETURNING id`,
			stored
		)) as [{ id: string }]
		await sql(
			target,
			"INSERT INTO status_cards (status_id, url, due_at, enqueued_at, generation) VALUES (?, 'https://site.example/stored', ?2, ?2, 1)",
			id,
			NOW + 1
		)
		const claimed = await op(claimCards, { now: NOW + 2 })
		expect(claimed).toMatchObject({ attached: 0 })
		const [claim] = claimed.claims
		expect(claim?.statusId).toBe(id)
		expect(
			await op(recordCard, {
				statusId: id,
				token: claim!.token,
				generation: claim!.generation,
				now: NOW + 3,
				outcome: {
					kind: 'card',
					fields: {
						title: 'Title',
						description: '',
						authorName: '',
						authorUrl: '',
						providerName: '',
						providerUrl: '',
						language: null,
						publishedAt: null,
						type: 'link',
						width: 0,
						height: 0,
						embedSrc: '',
						iframeWidth: null,
						iframeHeight: null,
						imageUrl: 'https://cdn.example/stored.webp',
						imageDescription: 'Stored alt',
					},
				},
			})
		).toEqual({ held: true })
		const [inserted] = await sql<{ id: string; source_url: string; due_at: number | null }>(
			target,
			'SELECT id, source_url, due_at FROM card_images'
		)
		expect(inserted).toMatchObject({ source_url: 'https://cdn.example/stored.webp', due_at: NOW + 3 })
		expect((await cards(target)).find((row) => row.status_id === id)?.image_id).toBe(inserted!.id)
		for (const row of images) {
			await env.MEDIA.delete(`files/${row.token}/full`)
		}
	}, 120_000)
})
