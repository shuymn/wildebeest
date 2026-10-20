import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { bearer, json, sql } from './api-helpers'
import { GIF, PNG_PLAIN } from './fixtures/images'
import { bytes, multipartForm, r2Keys, TestCodec } from './media-helpers'
import { aliceWithFollower } from './profile-fixtures'
import { scopedToken } from './read-helpers'
import { storeWith } from './setup-helpers'
import { outbound } from './status-helpers'
import { ORIGIN } from './web-helpers'
import { DOOMED_AT, profileReleaseSql } from '../src/domain/media'
import { API_BODY_LIMIT, FILE_PART_SLACK } from '../src/mastodon/params'
import { PROFILE_IMAGE_LIMIT } from '../src/platform/images'
import type { StoreStub } from '../src/platform/store-client'

// PATCH /api/v1/accounts/update_credentials with avatar and header files (multipart): the body and file bounds, the
// token checked before the body is read, Paperclip's validations, one transaction with one Update(Person), and the
// ownership of the uploads until it commits (mastodon/accounts.ts, mastodon/media.ts storeProfileImage).

const AVIF = new Uint8Array([0, 0, 0, 0x1c, ...new TextEncoder().encode('ftypavif'), 0, 0, 0, 0])

async function setup(wrapStore?: (store: StoreStub) => StoreStub) {
	const codec = new TestCodec()
	const h = await aliceWithFollower({ images: () => codec, wrapStore })
	return { ...h, codec }
}

type H = Awaited<ReturnType<typeof setup>>

const png = (name = 'a.png') => new File([bytes(PNG_PLAIN)], name, { type: 'image/png' })

const formOf = multipartForm

function patch(h: H, token: string, body: BodyInit, headers: Record<string, string> = {}, query = '') {
	return h.request(`/api/v1/accounts/update_credentials${query}`, {
		method: 'PATCH',
		body,
		headers: { authorization: `Bearer ${token}`, ...headers },
	})
}

async function answer(response: Response) {
	return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function profile(store: StoreStub) {
	const [row] = await sql<{ avatar_url: string | null; header_url: string | null; display_name: string }>(
		store,
		"SELECT avatar_url, header_url, display_name FROM accounts WHERE username = 'alice'"
	)
	return row
}

async function media(store: StoreStub) {
	return sql<{ id: string; url: string; gc_at: string | null; processed: number; file_token: string }>(
		store,
		'SELECT id, url, gc_at, processed, file_token FROM media_attachments ORDER BY id'
	)
}

// The R2 keys a request left behind (the bucket is shared by the file's tests).
async function keysAfter(request: () => Promise<Response>): Promise<{ response: Response; added: string[] }> {
	const before = new Set(await r2Keys())
	const response = await request()
	return { response, added: (await r2Keys()).filter((key) => !before.has(key)) }
}

async function updates(store: StoreStub) {
	return (await outbound(store)).filter((o) => o.activity.type === 'Update')
}

// A raw multipart body of exactly `size` bytes whose only part is an undeclared file (ignored), so its size is all the
// body bound sees.
function paddedMultipart(size: number): { body: Uint8Array; type: string } {
	const boundary = 'b'
	const head = `--${boundary}\r\nContent-Disposition: form-data; name="thumbnail"; filename="t.bin"\r\n\r\n`
	const tail = `\r\n--${boundary}--\r\n`
	const body = new Uint8Array(size)
	const encoder = new TextEncoder()
	body.set(encoder.encode(head))
	body.set(encoder.encode(tail), size - tail.length)
	return { body, type: `multipart/form-data; boundary=${boundary}` }
}

// A stream that fails the test if the handler pulls it.
function untouchable(): ReadableStream<Uint8Array> {
	// highWaterMark 0: pull runs only when a reader asks for bytes, not when the stream is made.
	return new ReadableStream(
		{
			pull() {
				throw new Error('the body was read')
			},
		},
		{ highWaterMark: 0 }
	)
}

describe('update_credentials: bounds', () => {
	it('takes a multipart body up to the text limit plus two files and refuses one byte more', async () => {
		const h = await setup()
		const limit = API_BODY_LIMIT + 2 * (PROFILE_IMAGE_LIMIT + FILE_PART_SLACK)
		expect(limit).toBe(17_858_560)
		const fits = paddedMultipart(limit)
		expect((await patch(h, h.users.alice.token, fits.body, { 'content-type': fits.type })).status).toBe(200)
		const over = paddedMultipart(limit + 1)
		expect(await answer(await patch(h, h.users.alice.token, over.body, { 'content-type': over.type }))).toEqual({
			status: 413,
			body: { error: 'Request body is too large' },
		})
	}, 60_000)

	it('keeps 1 MiB for JSON, and for the text of a multipart body', async () => {
		const h = await setup()
		const note = 'x'.repeat(API_BODY_LIMIT)
		const json = JSON.stringify({ note })
		expect((await patch(h, h.users.alice.token, json, { 'content-type': 'application/json' })).status).toBe(413)
		// The name's 4 bytes and the value's count: within the bound, the note's own validation answers.
		const text = await patch(h, h.users.alice.token, formOf([['note', note.slice(0, API_BODY_LIMIT - 4)]]))
		expect(text.status).toBe(422)
		const over = await patch(
			h,
			h.users.alice.token,
			formOf([['note', `${note.slice(0, API_BODY_LIMIT - 4)}\u{1F600}`]])
		)
		expect(over.status).toBe(413)
		// A 2 MiB text avatar replaced by an empty one still counts.
		const replaced = await patch(
			h,
			h.users.alice.token,
			formOf([
				['avatar', 'x'.repeat(2 * API_BODY_LIMIT)],
				['avatar', ''],
			])
		)
		expect(replaced.status).toBe(413)
	}, 60_000)
})

describe('update_credentials: the token before the body', () => {
	it('answers an invalid or under-scoped token without reading a multipart body', async () => {
		const h = await setup()
		const send = (token: string) =>
			h.request('/api/v1/accounts/update_credentials', {
				method: 'PATCH',
				body: untouchable(),
				headers: { authorization: `Bearer ${token}`, 'content-type': 'multipart/form-data; boundary=b' },
				duplex: 'half',
			} as RequestInit)
		expect((await send('not-a-token')).status).toBe(401)
		expect((await send(await scopedToken(h, 'read:accounts'))).status).toBe(403)
	})

	it('uploads both images with a token of write:accounts only', async () => {
		const h = await setup()
		const token = await scopedToken(h, 'write:accounts')
		const response = await patch(
			h,
			token,
			formOf([
				['avatar', png()],
				['header', png('h.png')],
			])
		)
		expect(response.status).toBe(200)
		const account = await response.json<{ avatar: string; header: string; avatar_static: string }>()
		const row = await profile(h.store)
		expect([account.avatar, account.header, account.avatar_static]).toEqual([
			row?.avatar_url,
			row?.header_url,
			row?.avatar_url,
		])
		expect(row?.avatar_url).toMatch(/^https:\/\/kopje\.test\/media\/[A-Za-z0-9_-]+\/full\.png$/)
		expect((await media(h.store)).map((m) => m.gc_at)).toEqual([null, null])
	})
})

describe('update_credentials: avatar and header', () => {
	it('applies images and text in one transaction with one Update(Person)', async () => {
		const h = await setup()
		const before = (await updates(h.store)).length
		const response = await patch(
			h,
			h.users.alice.token,
			formOf([
				['display_name', 'Alice'],
				['avatar', png()],
				['header', png('h.png')],
			])
		)
		expect(response.status).toBe(200)
		const sent = await updates(h.store)
		expect(sent.length - before).toBe(1)
		const row = await profile(h.store)
		expect(sent.at(-1)?.activity.object).toMatchObject({
			name: 'Alice',
			icon: { type: 'Image', url: row?.avatar_url },
			image: { type: 'Image', url: row?.header_url },
		})
		// Two transformations each (the full image and the preview).
		expect(h.codec.encodeCalls).toHaveLength(4)
	})

	it('takes 8,388,607 bytes and refuses 8,388,608, AVIF and a string, applying nothing', async () => {
		const h = await setup()
		const padded = (size: number) => {
			const file = new Uint8Array(size)
			file.set(bytes(PNG_PLAIN))
			return new File([file], 'big.png', { type: 'image/png' })
		}
		// The bytes past IEND are not read by the decoder.
		expect((await patch(h, h.users.alice.token, formOf([['avatar', padded(PROFILE_IMAGE_LIMIT - 1)]]))).status).toBe(
			200
		)
		const avatar = (await profile(h.store))?.avatar_url
		expect(
			await answer(await patch(h, h.users.alice.token, formOf([['avatar', padded(PROFILE_IMAGE_LIMIT)]])))
		).toEqual({
			status: 422,
			body: { error: 'Validation failed: Avatar file size must be less than 8 MB' },
		})
		const avif = new File([AVIF], 'a.avif', { type: 'image/avif' })
		expect(
			await answer(
				await patch(
					h,
					h.users.alice.token,
					formOf([
						['display_name', 'Changed'],
						['header', avif],
					])
				)
			)
		).toEqual({ status: 422, body: { error: 'Validation failed: Header content type is invalid' } })
		for (const parts of [
			[['avatar', 'x']],
			[
				['avatar', png()],
				['avatar', 'x'],
			],
		] as [string, string | File][][]) {
			expect(await answer(await patch(h, h.users.alice.token, formOf(parts)))).toEqual({
				status: 400,
				body: { error: 'Bad Request' },
			})
		}
		// A query value with no body part is the effective value too; JSON's as well.
		expect((await patch(h, h.users.alice.token, formOf([['note', 'n']]), {}, '?header=x')).status).toBe(400)
		expect(
			(
				await h.request(
					'/api/v1/accounts/update_credentials',
					bearer(h.users.alice.token, { ...json({ avatar: 'x' }), method: 'PATCH' })
				)
			).status
		).toBe(400)
		// A string then a file is the file; an empty value is absent.
		const last = await patch(
			h,
			h.users.alice.token,
			formOf([
				['header', 'x'],
				['header', png()],
				['avatar', ''],
			])
		)
		expect(last.status).toBe(200)
		const row = await profile(h.store)
		expect([row?.display_name, row?.avatar_url]).toEqual(['', avatar])
		expect(row?.header_url).not.toBeNull()
	}, 60_000)

	it('keeps an animated GIF as its own static (stills are not made)', async () => {
		const h = await setup()
		const gif = new File([bytes(GIF)], 'a.gif', { type: 'image/gif' })
		const account = await (
			await patch(h, h.users.alice.token, formOf([['avatar', gif]]))
		).json<{
			avatar: string
			avatar_static: string
		}>()
		expect(account.avatar_static).toBe(account.avatar)
	})
})

describe('update_credentials: upload ownership', () => {
	it('discards the avatar when the header fails after it, and applies nothing', async () => {
		const h = await setup()
		let encodes = 0
		const encode = h.codec.encode.bind(h.codec)
		h.codec.encode = (input, options) => (++encodes > 2 ? Promise.reject(new Error('down')) : encode(input, options))
		const { response, added } = await keysAfter(() =>
			patch(
				h,
				h.users.alice.token,
				formOf([
					['display_name', 'Never'],
					['avatar', png()],
					['header', png('h.png')],
				])
			)
		)
		expect(response.status).toBe(500)
		expect(await profile(h.store)).toEqual({ avatar_url: null, header_url: null, display_name: '' })
		// Both uploads were discarded and swept with their objects, the completed avatar's included.
		expect(await media(h.store)).toEqual([])
		expect(added).toEqual([])
	})

	it('discards the uploads when the Store answers upload_gone', async () => {
		const h = await setup((store) =>
			storeWith(store, {
				updateCredentials: async (...args: unknown[]) => {
					await sql(store, 'UPDATE media_attachments SET gc_at = ?', DOOMED_AT)
					return (store.updateCredentials as (...a: unknown[]) => Promise<unknown>)(...args)
				},
			})
		)
		const { response, added } = await keysAfter(() => patch(h, h.users.alice.token, formOf([['avatar', png()]])))
		expect(await answer(response)).toEqual({ status: 422, body: { error: 'Validation failed: The upload expired' } })
		expect(await profile(h.store)).toEqual({ avatar_url: null, header_url: null, display_name: '' })
		expect(await media(h.store)).toEqual([])
		expect(added).toEqual([])
	})

	it('discards an upload whose completion committed but whose answers were lost', async () => {
		let completions = 0
		const h = await setup((store) =>
			storeWith(store, {
				completeMedia: async (...args: unknown[]) => {
					await (store.completeMedia as (...a: unknown[]) => Promise<unknown>)(...args)
					completions++
					throw new Error('lost answer')
				},
			})
		)
		const { response, added } = await keysAfter(() => patch(h, h.users.alice.token, formOf([['avatar', png()]])))
		expect(response.status).toBe(500)
		// The completion and its retry both committed (completion is idempotent); the upload was then doomed and swept.
		expect(completions).toBe(2)
		expect(await profile(h.store)).toEqual({ avatar_url: null, header_url: null, display_name: '' })
		expect(await media(h.store)).toEqual([])
		expect(added).toEqual([])
	})
})

describe('profile image release', () => {
	it('dooms an imported avatar whose URL is malformed UTF-8, reading the account index at 10,000 uploads', async () => {
		const h = await setup()
		const alice = h.users.alice.id
		const raw = "CAST(X'68747470733a2f2f6b6f706a652e746573742f6d656469612f78ff2f66756c6c2e706e67' AS TEXT)"
		await runInDurableObject(h.store, (_instance, state) => {
			// The account's other uploads: kept, unattached rows of their own URLs, as many as the plan must not scan.
			state.storage.sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
				INSERT INTO media_attachments (id, account_id, type, url)
				SELECT CAST(910000000000000000 + i AS TEXT), ?1, 'image', 'https://kopje.test/media/k' || i || '/full.png' FROM n`,
				alice
			)
			state.storage.sql.exec(
				`INSERT INTO media_attachments (id, account_id, type, url) VALUES ('900000000000000001', ?1, 'image', ${raw})`,
				alice
			)
			state.storage.sql.exec(`UPDATE accounts SET avatar_url = ${raw} WHERE id = ?`, alice)
		})
		// No ANALYZE: the plan holds with no statistics.
		const plan = await runInDurableObject(h.store, (_instance, state) =>
			state.storage.sql
				.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${profileReleaseSql('avatar')}`, alice, 'x')
				.toArray()
				.map((row) => row.detail)
				.join('\n')
		)
		expect(plan).toMatch(/SEARCH media_attachments USING INDEX media_attachments_account \(account_id=\?\)/)
		expect(plan).not.toMatch(/SCAN/)
		expect((await patch(h, h.users.alice.token, formOf([['avatar', png()]]))).status).toBe(200)
		expect(await sql(h.store, "SELECT count(*) AS n FROM media_attachments WHERE id = '900000000000000001'")).toEqual([
			{ n: 0 },
		])
		expect(
			await sql(h.store, "SELECT count(*) AS n FROM media_attachments WHERE id LIKE '91%' AND gc_at IS NULL")
		).toEqual([{ n: 10_000 }])
	}, 60_000)

	it('keeps an upload both images name until the last of them is replaced', async () => {
		const h = await setup()
		expect((await patch(h, h.users.alice.token, formOf([['avatar', png()]]))).status).toBe(200)
		await sql(h.store, "UPDATE accounts SET header_url = avatar_url WHERE username = 'alice'")
		const [shared] = await media(h.store)
		const keys = [`files/${shared!.file_token}/full`, `files/${shared!.file_token}/small`, `originals/${shared!.id}`]
		const present = async () => (await r2Keys()).filter((key) => keys.includes(key)).sort()
		expect(await present()).toEqual([...keys].sort())
		// Replacing the header leaves the avatar naming it: the row and its objects stay, after the sweep too.
		expect((await patch(h, h.users.alice.token, formOf([['header', png('h.png')]]))).status).toBe(200)
		expect((await media(h.store)).find((row) => row.id === shared!.id)?.gc_at).toBeNull()
		expect(await present()).toEqual([...keys].sort())
		// Replacing the avatar, its last reference, releases it.
		expect((await patch(h, h.users.alice.token, formOf([['avatar', png('a2.png')]]))).status).toBe(200)
		expect((await media(h.store)).find((row) => row.id === shared!.id)).toBeUndefined()
		expect(await present()).toEqual([])
	})
})

describe('the settings page', () => {
	it('refuses an expired session without reading the body', async () => {
		const h = await setup()
		const response = await h.request('/settings/avatar', {
			method: 'POST',
			body: untouchable(),
			headers: {
				origin: ORIGIN,
				cookie: '__Host-kopje_session=expired',
				'content-type': 'multipart/form-data; boundary=b',
			},
			duplex: 'half',
		} as RequestInit)
		expect(response.status).toBe(302)
	})
})
