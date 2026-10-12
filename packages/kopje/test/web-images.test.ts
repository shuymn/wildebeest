import { describe, expect, it } from 'vitest'

import { bearer, json, sql } from './api-helpers'
import { PNG_PLAIN } from './fixtures/images'
import { bytes, mediaForm, pathOf, TestCodec } from './media-helpers'
import { community } from './status-helpers'
import { type Browser, csrfOf, ORIGIN, signIn } from './web-helpers'

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
		const rows = await sql<{ url: string; gc_at: string | null }>(h.store, 'SELECT url, gc_at FROM media_attachments')
		expect(rows.find((row) => row.url === first)?.gc_at).not.toBeNull()
		expect(rows.find((row) => row.url === second)?.gc_at).toBeNull()
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
