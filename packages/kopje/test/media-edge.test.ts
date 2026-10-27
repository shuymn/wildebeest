import { env } from 'cloudflare:workers'

import { describe, expect, it } from 'vitest'

import { bearer, json, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { ANIMATED_GIF, ANIMATED_WEBP, AVIF, JPEG_ORIENTATION_6, PNG_PLAIN, WEBP_PLAIN } from './fixtures/images'
import { bytes, framesKeepingCodec, mediaForm, pngWithChunk, TestCodec, upload, uploaded } from './media-helpers'
import { community, getJson, post } from './status-helpers'
import { isAnimated, retainedMetadata } from '../src/platform/image-bytes'
import type { StoreStub } from '../src/platform/store-client'

// Failure and boundary cases of media: R2 writes that settle late, a lost completion response, the
// writer deadline, budget months across UTC rollover, field bounds, focus edits, and container strictness.

const MINUTE = 60 * 1000

type Options = {
	codec?: TestCodec
	wrapStore?: (store: StoreStub) => StoreStub
	bucket?: R2Bucket
}

async function users(options: Options = {}) {
	const codec = options.codec ?? new TestCodec()
	const h = await community(
		['alice', 'bob'],
		'read write follow',
		{ images: () => codec, wrapStore: options.wrapStore },
		options.bucket === undefined ? {} : { MEDIA: options.bucket }
	)
	return { ...h, codec }
}

const png = () => mediaForm(bytes(PNG_PLAIN), {}, 'a.png', 'image/png')

async function mediaKeysIn(prefixes: string[]): Promise<string[]> {
	const found: string[] = []
	for (const prefix of prefixes) {
		found.push(...(await env.MEDIA.list({ prefix })).objects.map((o) => o.key))
	}
	return found.sort()
}

async function rowKeys(store: StoreStub): Promise<string[]> {
	const rows = await sql<{ id: string; file_token: string }>(store, 'SELECT id, file_token FROM media_attachments')
	return rows.flatMap((r) => [`originals/${r.id}`, `files/${r.file_token}/`])
}

// A bucket whose put of the original fails at once while the served files land late.
function lateBucket(): R2Bucket {
	const real = env.MEDIA
	return {
		put: async (key: string, value: Uint8Array, options?: R2PutOptions) => {
			if (key.startsWith('originals/')) {
				throw new Error('put failed')
			}
			await new Promise((resolve) => setTimeout(resolve, 300))
			return real.put(key, value, options)
		},
		delete: (keys: string | string[]) => real.delete(keys),
		get: (key: string) => real.get(key),
		head: (key: string) => real.head(key),
		list: (options?: R2ListOptions) => real.list(options),
	} as unknown as R2Bucket
}

describe('upload recovery', () => {
	it('waits for every R2 write to settle before cleaning up, so no object outlives a failed upload', async () => {
		const h = await users({ bucket: lateBucket() })
		const response = await upload(h, h.users.alice, png())
		expect(response.status).toBe(500)
		const [row] = await sql<{ id: string; file_token: string }>(h.store, 'SELECT id, file_token FROM media_attachments')
		const token = (row as { file_token: string }).file_token
		await new Promise((resolve) => setTimeout(resolve, 600))
		expect(await mediaKeysIn([`files/${token}/`])).toEqual([])
	})

	it('keeps the files of an upload whose completion committed although its response was lost', async () => {
		let lost = 0
		const wrapStore = (store: StoreStub) =>
			new Proxy(store, {
				get(target, property) {
					if (property === 'completeMedia') {
						return async (...args: Parameters<StoreStub['completeMedia']>) => {
							const result = await target.completeMedia(...args)
							if (lost++ === 0) {
								throw new Error('response lost')
							}
							return result
						}
					}
					return Reflect.get(target, property) as unknown
				},
			})
		const h = await users({ wrapStore })
		const response = await upload(h, h.users.alice, png())
		expect(response.status).toBe(200)
		const media = await response.json<{ id: string; url: string }>()
		const [row] = await sql<{ file_token: string; processed: number }>(
			h.store,
			'SELECT file_token, processed FROM media_attachments WHERE id = ?',
			media.id
		)
		expect(row?.processed).toBe(1)
		expect(await mediaKeysIn([`files/${row?.file_token}/`, `originals/${media.id}`])).toHaveLength(3)
		expect((await h.request(new URL(media.url).pathname)).status).toBe(200)
	})

	it('refuses to complete an upload past its writer deadline and writes nothing to R2', async () => {
		const codec = new TestCodec()
		const h = await users({ codec })
		const encode = codec.encode.bind(codec)
		codec.encode = async (input, options) => {
			h.now.mockReturnValue(NOW + 16 * MINUTE)
			return encode(input, options)
		}
		const response = await upload(h, h.users.alice, png())
		expect(response.status).toBe(422)
		expect(await mediaKeysIn(await rowKeys(h.store))).toEqual([])
	})
})

describe('budget months', () => {
	const november = Date.parse('2026-11-01T00:00:05.000Z')

	it('never drops the counters of a later month when a delayed request arrives', async () => {
		const h = await users()
		h.now.mockReturnValue(november)
		expect((await upload(h, h.users.alice, png())).status).toBe(200)
		// A request that took its time before midnight reaches the Store after November's first upload.
		h.now.mockReturnValue(november - 10_000)
		expect((await upload(h, h.users.bob, png())).status).toBe(200)
		const counters = await sql<{ name: string; value: string }>(
			h.store,
			"SELECT name, value FROM kopje_state WHERE name LIKE 'images%' ORDER BY name"
		)
		expect(counters).toEqual([
			{ name: `images_account_transforms:2026-10:${h.users.bob.id}`, value: '3' },
			{ name: `images_account_transforms:2026-11:${h.users.alice.id}`, value: '3' },
			{ name: 'images_transforms:2026-10', value: '3' },
			{ name: 'images_transforms:2026-11', value: '3' },
		])
	})

	it('prunes only months before the previous one', async () => {
		const h = await users()
		for (const month of ['2026-08', '2026-09', '2026-10']) {
			await sql(h.store, 'INSERT INTO kopje_state (name, value) VALUES (?, ?)', `images_transforms:${month}`, '2')
		}
		h.now.mockReturnValue(november)
		expect((await upload(h, h.users.alice, png())).status).toBe(200)
		const names = await sql<{ name: string }>(
			h.store,
			"SELECT name FROM kopje_state WHERE name LIKE 'images\\_transforms:%' ESCAPE '\\' ORDER BY name"
		)
		expect(names.map((n) => n.name)).toEqual(['images_transforms:2026-10', 'images_transforms:2026-11'])
	})

	it('charges the month the transformations start in, even when they finish after midnight', async () => {
		const codec = new TestCodec()
		const h = await users({ codec })
		const midnight = Date.parse('2026-11-01T00:00:00.000Z')
		h.now.mockReturnValue(midnight - 1000)
		const encode = codec.encode.bind(codec)
		codec.encode = async (input, options) => {
			h.now.mockReturnValue(midnight + 1000)
			return encode(input, options)
		}
		expect((await upload(h, h.users.alice, png())).status).toBe(200)
		expect(await sql(h.store, "SELECT name, value FROM kopje_state WHERE name = 'images_transforms:2026-10'")).toEqual([
			{ name: 'images_transforms:2026-10', value: '3' },
		])
		expect(await sql(h.store, "SELECT name FROM kopje_state WHERE name = 'images_transforms:2026-11'")).toEqual([])
	})
})

describe('field bounds (RES-1)', () => {
	it('refuses an oversized focus or description field before any transformation', async () => {
		const h = await users()
		const focus = await upload(
			h,
			h.users.alice,
			mediaForm(bytes(PNG_PLAIN), { focus: `0.5,0.5${',0'.repeat(10_000)}` }, 'a.png', 'image/png')
		)
		expect(focus.status).toBe(422)
		const description = await upload(
			h,
			h.users.alice,
			mediaForm(bytes(PNG_PLAIN), { description: 'x'.repeat(2_000_000) }, 'a.png', 'image/png')
		)
		expect(description.status).toBe(422)
		expect(h.codec.calls).toBe(0)
	})
})

describe('focus through a status edit', () => {
	it('applies media_attributes[][focus] to own attached media and records it in history', async () => {
		const h = await users()
		const { alice, bob } = h.users
		const media = await uploaded(h, alice, png())
		const status = await post(h, alice, { status: 'x', media_ids: [media.id] })
		const edit = (token: string, attributes: Record<string, unknown>[]) =>
			h.request(
				`/api/v1/statuses/${status.id}`,
				bearer(token, json({ status: 'x', media_ids: [media.id], media_attributes: attributes }, { method: 'PUT' }))
			)
		const edited = await edit(alice.token, [{ id: media.id, focus: '0.25,-0.5' }])
		expect(edited.status).toBe(200)
		expect(await edited.json()).toMatchObject({ media_attachments: [{ meta: { focus: { x: 0.25, y: -0.5 } } }] })
		const history = await getJson<{ media_attachments: { meta: { focus: unknown } }[] }[]>(
			h,
			`/api/v1/statuses/${status.id}/history`,
			alice.token
		)
		expect(history.body.map((v) => v.media_attachments[0]?.meta.focus)).toEqual([
			{ x: 0, y: 0 },
			{ x: 0.25, y: -0.5 },
		])
		// Not another account's status, and an unchanged focus records no edit.
		expect((await edit(bob.token, [{ id: media.id, focus: '1,1' }])).status).toBe(404)
		await edit(alice.token, [{ id: media.id, focus: '0.25,-0.5' }])
		expect((await getJson<unknown[]>(h, `/api/v1/statuses/${status.id}/history`, alice.token)).body).toHaveLength(2)
	})
})

describe('container strictness (MEDIA-3)', () => {
	const riff = (body: Uint8Array) => {
		const out = new Uint8Array(8 + body.length)
		out.set(new TextEncoder().encode('RIFF'))
		new DataView(out.buffer).setUint32(4, body.length, true)
		out.set(body, 8)
		return out
	}
	const plainWebp = bytes(WEBP_PLAIN)
	const webpBody = plainWebp.subarray(8)
	const chunk = (type: string, data: string) => {
		const payload = new TextEncoder().encode(data)
		const out = new Uint8Array(8 + payload.length + (payload.length % 2))
		out.set(new TextEncoder().encode(type))
		new DataView(out.buffer).setUint32(4, payload.length, true)
		out.set(payload, 8)
		return out
	}

	it('refuses unknown PNG chunks and data after IEND', () => {
		expect(retainedMetadata(pngWithChunk(bytes(PNG_PLAIN), 'tIME', '\u0007ê\n\f\u0000\u0000\u0000'), 'image/png')).toBe(
			'segment'
		)
		expect(
			retainedMetadata(new Uint8Array([...bytes(PNG_PLAIN), ...new TextEncoder().encode('GPS 35N')]), 'image/png')
		).toBe('unreadable')
	})

	it('refuses unknown WebP chunks and data outside the RIFF extent', () => {
		expect(retainedMetadata(riff(new Uint8Array([...webpBody, ...chunk('META', 'owner')])), 'image/webp')).toBe(
			'segment'
		)
		expect(retainedMetadata(new Uint8Array([...plainWebp, ...new TextEncoder().encode('trailer')]), 'image/webp')).toBe(
			'unreadable'
		)
	})
})

describe('inputs beyond still images', () => {
	it('records an animated upload, serves its still preview, and keeps the record when completion is retried', async () => {
		let lost = 0
		const wrapStore = (store: StoreStub) =>
			new Proxy(store, {
				get(target, property) {
					if (property === 'completeMedia') {
						return async (...args: Parameters<StoreStub['completeMedia']>) => {
							const result = await target.completeMedia(...args)
							if (lost++ === 0) {
								throw new Error('response lost')
							}
							return result
						}
					}
					return Reflect.get(target, property) as unknown
				},
			})
		const h = await users({ codec: framesKeepingCodec(), wrapStore })
		const media = await uploaded(h, h.users.alice, mediaForm(bytes(ANIMATED_WEBP), {}, 'a.webp', 'image/webp'))
		expect(lost).toBe(2)
		expect(media.preview_url).not.toBe(media.url)
		expect(media.meta).not.toHaveProperty('animated')
		const servedBytes = async (url: string | null) =>
			new Uint8Array(await (await h.request(new URL(url ?? '').pathname)).arrayBuffer())
		expect(isAnimated(await servedBytes(media.url), 'image/webp')).toBe(true)
		expect(isAnimated(await servedBytes(media.preview_url), 'image/webp')).toBe(false)
		expect(
			await sql(
				h.store,
				"SELECT json_extract(meta, '$.animated') AS animated FROM media_attachments WHERE id = ?",
				media.id
			)
		).toEqual([{ animated: 1 }])
		const still = await uploaded(h, h.users.alice, png())
		expect(
			await sql(
				h.store,
				"SELECT json_type(meta, '$.animated') AS animated FROM media_attachments WHERE id = ?",
				still.id
			)
		).toEqual([{ animated: null }])
	})

	it('fails an upload whose preview comes back animated, keeping no file', async () => {
		const codec = new TestCodec()
		codec.encodeResponder = () => bytes(ANIMATED_WEBP)
		const h = await users({ codec })
		const response = await upload(h, h.users.alice, mediaForm(bytes(ANIMATED_WEBP), {}, 'a.webp', 'image/webp'))
		expect(response.status).toBe(500)
		expect(await mediaKeysIn(await rowKeys(h.store))).toEqual([])
	})

	// That the frames survive in the served file and the preview is a still is the release check of docs/setup.md
	// ("Still images of animated uploads").
	it('accepts a multi-frame GIF as WebP', async () => {
		const h = await users()
		const media = await uploaded(h, h.users.alice, mediaForm(bytes(ANIMATED_GIF), {}, 'a.gif', 'image/gif'))
		expect(media.url).toMatch(/\/full\.webp$/)
		expect(h.codec.encodeCalls.map((call) => call.format)).toEqual(['image/webp', 'image/webp', 'rgba'])
	})

	// Miniflare's local binding cannot read AVIF (sharp reports it as HEIF), so the service's answer is stood in for
	// here; decoding real AVIF is checked on a deployed instance.
	it('sends an AVIF to Images and serves WebP', async () => {
		const h = await users()
		h.codec.infoResult = { format: 'image/avif', width: 12, height: 9 }
		h.codec.encodeResult = bytes(WEBP_PLAIN)
		const media = await uploaded(h, h.users.alice, mediaForm(bytes(AVIF), {}, 'a.avif', 'image/avif'))
		expect(media.url).toMatch(/\/full\.webp$/)
		expect(h.codec.encodeCalls[0]).toEqual({ format: 'image/webp' })
	})

	it('reports the dimensions of the served file for an EXIF-rotated JPEG (rotation itself is checked on a deployed instance)', async () => {
		const h = await users()
		const media = await uploaded(h, h.users.alice, mediaForm(bytes(JPEG_ORIENTATION_6)))
		const served = new Uint8Array(await (await h.request(new URL(media.url ?? '').pathname)).arrayBuffer())
		const info = await h.codec.real.info(served)
		expect(media.meta?.original).toMatchObject({ width: info.width, height: info.height })
		expect(retainedMetadata(served, 'image/webp')).toBeNull()
	})
})
