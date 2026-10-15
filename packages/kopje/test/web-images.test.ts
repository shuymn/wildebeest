import { env } from 'cloudflare:workers'

import { describe, expect, it } from 'vitest'

import { bearer, json, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { PNG_PLAIN } from './fixtures/images'
import { bytes, mediaForm, pathOf, r2Keys, TestCodec } from './media-helpers'
import { community, outbound, remoteAccount, remoteFollows } from './status-helpers'
import { type Browser, csrfOf, ORIGIN, signIn } from './web-helpers'
import { sweepMedia } from '../src/mastodon/media'

// Avatar and header from the settings page, through B4b's upload pipeline (MEDIA-*, RES-6), with WEB-1 and WEB-4.

async function setup() {
	const codec = new TestCodec()
	const h = await community(['alice'], 'read write follow', { images: () => codec })
	const browser = await signIn(h)
	return { ...h, browser }
}

function uploadImage(
	h: Awaited<ReturnType<typeof setup>>,
	browser: Browser,
	kind: 'avatar' | 'header',
	fields: Record<string, string>,
	origin: string | null = ORIGIN
) {
	const headers: Record<string, string> = { cookie: browser.cookie }
	if (origin !== null) {
		headers.origin = origin
	}
	const body = mediaForm(bytes(PNG_PLAIN), fields, 'p.png', 'image/png')
	return h.request(`/settings/${kind}`, { method: 'POST', headers, body })
}

async function account(h: Awaited<ReturnType<typeof setup>>) {
	const [row] = await sql<{ avatar_url: string | null; header_url: string | null }>(
		h.store,
		'SELECT avatar_url, header_url FROM accounts WHERE username = ?',
		'alice'
	)
	return row
}

describe('profile images', () => {
	it('sets the avatar and header from re-encoded uploads and keeps them out of the media API', async () => {
		const h = await setup()
		const csrf = await csrfOf(h, h.browser)
		const avatar = await uploadImage(h, h.browser, 'avatar', { csrf })
		expect(avatar.status).toBe(303)
		expect(avatar.headers.get('location')).toBe('/settings?notice=avatar')
		expect((await uploadImage(h, h.browser, 'header', { csrf })).status).toBe(303)
		const urls = await account(h)
		expect(urls?.avatar_url).toMatch(/^https:\/\/kopje\.test\/media\/[A-Za-z0-9_-]+\/full\.png$/)
		expect(urls?.header_url).toMatch(/^https:\/\/kopje\.test\/media\/[A-Za-z0-9_-]+\/full\.png$/)
		expect((await h.request(pathOf(urls?.avatar_url ?? null))).status).toBe(200)
		const rows = await sql<{ id: string; gc_at: string | null; status_id: string | null }>(
			h.store,
			'SELECT id, gc_at, status_id FROM media_attachments ORDER BY id'
		)
		expect(rows.map((row) => [row.gc_at, row.status_id])).toEqual([
			[null, null],
			[null, null],
		])
		// The API shows them as the account's images, and cannot read, describe or attach them as uploads.
		const { alice } = h.users
		const me = await (
			await h.request('/api/v1/accounts/verify_credentials', bearer(alice.token))
		).json<{
			avatar: string
		}>()
		expect(me.avatar).toBe(urls?.avatar_url)
		for (const row of rows) {
			expect((await h.request(`/api/v1/media/${row.id}`, bearer(alice.token))).status).toBe(404)
			const put = await h.request(
				`/api/v1/media/${row.id}`,
				bearer(alice.token, { ...json({ description: 'x' }), method: 'PUT' })
			)
			expect(put.status).toBe(404)
			const attach = await h.request(
				'/api/v1/statuses',
				bearer(alice.token, json({ status: 'x', media_ids: [row.id] }))
			)
			expect((await attach.json<{ media_attachments: unknown[] }>()).media_attachments).toEqual([])
		}
		// The page shows the new avatar.
		expect(await (await h.request('/@alice')).text()).toContain(`src="${urls?.avatar_url}"`)
	})

	it('dooms the image it replaces', async () => {
		const h = await setup()
		const csrf = await csrfOf(h, h.browser)
		await uploadImage(h, h.browser, 'avatar', { csrf })
		const first = (await account(h))?.avatar_url
		await uploadImage(h, h.browser, 'avatar', { csrf })
		const second = (await account(h))?.avatar_url
		expect(second).not.toBe(first)
		const rows = await sql<{ id: string; url: string; file_token: string; gc_at: string | null }>(
			h.store,
			'SELECT id, url, file_token, gc_at FROM media_attachments'
		)
		const old = rows.find((row) => row.url === first)
		const current = rows.find((row) => row.url === second)
		expect(old?.gc_at).not.toBeNull()
		expect(current?.gc_at).toBeNull()
		// The sweep deletes the replaced image's files and row, and keeps the current one.
		await sweepMedia(env, { build: () => env.CF_VERSION_METADATA.id, now: () => NOW, store: () => h.store })
		expect(await r2Keys(`files/${old?.file_token}/`)).toEqual([])
		expect(await r2Keys(`originals/${old?.id}`)).toEqual([])
		expect(await r2Keys(`files/${current?.file_token}/`)).toHaveLength(2)
		expect(await r2Keys(`originals/${current?.id}`)).toHaveLength(1)
		expect((await h.request(pathOf(second ?? null))).status).toBe(200)
		expect(await sql(h.store, 'SELECT url FROM media_attachments')).toEqual([{ url: second }])
	})

	it('removes the avatar or header through the API, dooms its upload and federates the Update', async () => {
		const h = await setup()
		const { alice } = h.users
		await remoteFollows(h.store, await remoteAccount(h.store, 'fan'), alice.id)
		const csrf = await csrfOf(h, h.browser)
		await uploadImage(h, h.browser, 'avatar', { csrf })
		await uploadImage(h, h.browser, 'header', { csrf })
		const before = await account(h)
		const rows = await sql<{ id: string; url: string; file_token: string }>(
			h.store,
			'SELECT id, url, file_token FROM media_attachments'
		)
		const avatar = rows.find((row) => row.url === before?.avatar_url)
		const header = rows.find((row) => row.url === before?.header_url)
		// An Update supersedes the earlier ones, so the latest is the one to read.
		const latestUpdate = async () =>
			(await outbound(h.store)).filter((o) => o.activity.type === 'Update').at(-1)?.activity
		const uploadsUpdate = await latestUpdate()

		const removed = await h.request('/api/v1/profile/avatar', bearer(alice.token, { method: 'DELETE' }))
		expect(removed.status).toBe(200)
		const credential = await removed.json<{ avatar: string; header: string; source: unknown }>()
		expect(credential).toMatchObject({ avatar: `${ORIGIN}/assets/avatar.png`, header: before?.header_url })
		expect(credential.source).toBeDefined()
		expect(await account(h)).toEqual({ avatar_url: null, header_url: before?.header_url })
		// The sweep after the response deleted the avatar's upload and files; the header's stay.
		expect(await r2Keys(`files/${avatar?.file_token}/`)).toEqual([])
		expect(await r2Keys(`originals/${avatar?.id}`)).toEqual([])
		expect(await r2Keys(`files/${header?.file_token}/`)).toHaveLength(2)
		expect(await sql(h.store, 'SELECT id FROM media_attachments')).toEqual([{ id: header?.id }])
		const update = await latestUpdate()
		expect(update?.id).not.toBe(uploadsUpdate?.id)
		expect(update?.object).not.toHaveProperty('icon')
		expect(update?.object).toMatchObject({ image: { type: 'Image', url: before?.header_url } })

		const headerRemoved = await h.request('/api/v1/profile/header', bearer(alice.token, { method: 'DELETE' }))
		expect(await headerRemoved.json()).toMatchObject({ header: `${ORIGIN}/assets/header.png` })
		expect(await account(h)).toEqual({ avatar_url: null, header_url: null })
		expect(await sql(h.store, 'SELECT id FROM media_attachments')).toEqual([])
		const headerUpdate = await latestUpdate()
		expect(headerUpdate?.id).not.toBe(update?.id)
		expect(headerUpdate?.object).not.toHaveProperty('image')

		// Removing an image the account does not have changes nothing and sends nothing.
		const again = await h.request('/api/v1/profile/avatar', bearer(alice.token, { method: 'DELETE' }))
		expect(again.status).toBe(200)
		expect((await latestUpdate())?.id).toBe(headerUpdate?.id)
	})

	it('keeps an upload the other profile image still names', async () => {
		const h = await setup()
		const csrf = await csrfOf(h, h.browser)
		await uploadImage(h, h.browser, 'avatar', { csrf })
		const url = (await account(h))?.avatar_url
		// Both images naming one upload, as a converted account may.
		await sql(h.store, 'UPDATE accounts SET header_url = ? WHERE username = ?', url, 'alice')
		const removed = await h.request('/api/v1/profile/avatar', bearer(h.users.alice.token, { method: 'DELETE' }))
		expect(removed.status).toBe(200)
		expect(await sql(h.store, 'SELECT url, gc_at FROM media_attachments')).toEqual([{ url, gc_at: null }])
		expect((await h.request(pathOf(url ?? null))).status).toBe(200)
	})

	it('refuses a foreign, null or missing Origin and a wrong token before any transformation (WEB-1, WEB-4)', async () => {
		const h = await setup()
		const csrf = await csrfOf(h, h.browser)
		for (const origin of [null, 'null', 'https://evil.example']) {
			expect((await uploadImage(h, h.browser, 'avatar', { csrf }, origin)).status).toBe(403)
		}
		for (const fields of [{}, { csrf: 'forged' }] as Record<string, string>[]) {
			expect((await uploadImage(h, h.browser, 'header', fields)).status).toBe(403)
		}
		expect(await account(h)).toEqual({ avatar_url: null, header_url: null })
		// Refused before Images: no transformation was charged (the reservation counted the attempt only).
		const transforms = await sql<{ name: string }>(h.store, "SELECT name FROM kopje_state WHERE name LIKE 'images_%'")
		expect(transforms).toEqual([])
	})

	it('needs a session', async () => {
		const h = await setup()
		const response = await uploadImage(h, { session: '', cookie: '' }, 'avatar', { csrf: 'x' })
		expect(response.status).toBe(403)
		expect(await sql(h.store, 'SELECT id FROM media_attachments')).toEqual([])
	})
})
