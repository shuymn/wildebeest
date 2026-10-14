import { describe, expect, inject, it } from 'vitest'

import { apiHarness, bearer, login, sql } from './api-helpers'
import { BUILD } from './helpers'
import { ADMIN_AUD, ADMIN_EMAIL, dumpViaRpc, importViaRpc, setAccess, splitDump } from './ops-helpers'
import { actualFromDump, compareConversion } from '../cli/lib/cutover/verify-actual.js'

// The cutover end to end: a synthetic legacy export (level 0039) converted by the CLI code in the global setup
// (test-node/cutover-global-setup.ts) is imported into a real Store, served through the API, and then checked against
// expectations computed independently from the legacy export (DATA-12). The fixture's domain is the harness's.

declare module 'vitest' {
	export interface ProvidedContext {
		cutover: { dump: string; expected: Record<string, Record<string, string>> }
	}
}

const AP = { headers: { accept: 'application/activity+json' } }

async function imported() {
	const { dump, expected } = inject('cutover')
	const h = await apiHarness()
	// The /admin Access binding on the harness's own team, so the import and the sign-ins share one team.
	await setAccess(h.store, { access_team_domain: h.team.teamDomain })
	const authority = {
		kind: 'access',
		email: ADMIN_EMAIL,
		commonName: null,
		teamDomain: h.team.teamDomain,
		aud: ADMIN_AUD,
	} as const
	const { report } = await importViaRpc(h.store, dump, 16 * 1024, authority)
	// What the runbook's step 9 does: an imported Store is readonly until published.
	await h.store.publish(BUILD, authority)
	return { h, report, dump, expected }
}

describe('cutover import of a converted legacy export', () => {
	it('imports into an empty Store, which declares the same catalog, and passes the independent check', async () => {
		const { h, report, dump, expected } = await imported()
		expect(report).toMatchObject({ ok: true, foreignKeyViolations: 0, problems: [] })
		const header = splitDump(dump).header as { tables: unknown; migrations: unknown }
		expect(header.tables).toEqual((await h.store.catalog(BUILD)).tables)

		// The Store's own dump after the import, checked against the legacy export.
		const { text } = await dumpViaRpc(h.store)
		const result = await compareConversion(expected, actualFromDump(text))
		const failing = Object.entries(result.categories).filter(([, c]) => c.missing + c.extra + c.changed > 0)
		expect(failing).toEqual([])
		expect(result.result).toBe('PASS')
		expect(result.categories.statuses?.expected).toBeGreaterThan(5)
	})

	it('serves accounts, statuses, relationships, edits and legacy ids through the API', async () => {
		const { h } = await imported()
		const { token } = await login(h, { email: 'alice@example.com' })
		const get = async (path: string) => {
			const response = await h.request(path, bearer(token))
			expect(response.status, path).toBe(200)
			return (await response.json()) as Record<string, unknown> & Record<string, unknown>[]
		}

		const me = await get('/api/v1/accounts/verify_credentials')
		expect(me).toMatchObject({ username: 'alice', acct: 'alice', locked: false })
		expect(me.id).toMatch(/^\d{18}$/)
		expect(me.statuses_count).toBe(7)
		expect(me.source).toMatchObject({ privacy: 'unlisted', sensitive: true, language: 'ja' })

		// Bob's legacy UUID still resolves (accounts.legacy_id), to his new id.
		const bob = await get('/api/v1/accounts/7b0c6c1e-2f43-4c43-9f6e-1d7d0c7f2a10')
		expect(bob).toMatchObject({ username: 'Bob', locked: true })
		expect(bob.id).toMatch(/^\d{18}$/)

		// Relationships, including an accepted follow with no Follow record and a pending one.
		const remote = await sql<{ id: string; uri: string }>(
			h.store,
			"SELECT id, uri FROM accounts WHERE uri IN ('https://remote.example/users/r0', 'https://remote.example/users/r1', 'https://remote.example/users/r2') ORDER BY uri"
		)
		const ids = remote.map((r) => r.id)
		const relationships = await get(`/api/v1/accounts/relationships?${ids.map((id) => `id[]=${id}`).join('&')}`)
		expect(relationships.map((r) => [r.following, r.requested, r.followed_by])).toEqual([
			[true, false, false],
			[false, true, false],
			[false, false, true],
		])
		// show_reblogs=0 of the legacy follow is kept.
		expect(relationships[0]?.showing_reblogs).toBe(false)

		// A status by a legacy UUID; its history has both versions; the DM stays private to its audience.
		const unlisted = await get('/api/v1/statuses/d9a3c8e0-7f1b-4c2a-a4d3-8f3e2b1c0d55')
		expect(unlisted).toMatchObject({ visibility: 'unlisted', spoiler_text: 'CW: spoilers', sensitive: true })
		const [edited] = await sql<{ id: string }>(h.store, "SELECT id FROM statuses WHERE content LIKE '%second version%'")
		const history = await get(`/api/v1/statuses/${edited?.id ?? ''}/history`)
		expect(history.map((v) => v.content)).toEqual([
			'<p>edited text, first version</p>',
			'<p>edited text, second version</p>',
		])
		const [dm] = await sql<{ id: string }>(h.store, "SELECT id FROM statuses WHERE content LIKE '%secret direct%'")
		expect(await get(`/api/v1/statuses/${dm?.id ?? ''}`)).toMatchObject({ visibility: 'direct' })
		expect((await h.request(`/api/v1/statuses/${dm?.id ?? ''}`)).status).toBe(404)

		// The home timeline holds the converted statuses; media keeps its old URLs.
		const home = await get('/api/v1/timelines/home')
		expect(home.length).toBeGreaterThan(3)
		const [withMedia] = await sql<{ id: string }>(
			h.store,
			"SELECT id FROM statuses WHERE content LIKE '%Wildebeest day%'"
		)
		const status = await get(`/api/v1/statuses/${withMedia?.id ?? ''}`)
		expect(status.media_attachments).toEqual([
			expect.objectContaining({
				type: 'image',
				url: 'https://images.example/media/image-1/usercontent',
				description: 'a wildebeest',
			}),
		])
		// Its Hashtag and legacy's recorded names, as Kopje names them.
		expect(status.tags).toEqual([
			expect.objectContaining({ name: '#foo' }),
			expect.objectContaining({ name: '#hash' }),
			expect.objectContaining({ name: '#wide' }),
			expect.objectContaining({ name: 'wildebeest' }),
		])
		expect(status.favourites_count).toBe(2)
		expect(status.reblogs_count).toBe(1)
	})

	it('serves old /ap/o/<uuid> URIs and moves /@user/<legacy id> to the new id', async () => {
		const { h } = await imported()
		const [publicNote] = await sql<{ id: string; uri: string }>(
			h.store,
			"SELECT id, uri FROM statuses WHERE content LIKE '%Wildebeest day%'"
		)
		const uri = new URL(publicNote?.uri ?? '')
		expect(uri.pathname).toMatch(/^\/ap\/o\/0f0f0f0f-/)
		const note = await h.request(uri.pathname, AP)
		expect(note.status).toBe(200)
		expect(await note.json()).toMatchObject({ id: publicNote?.uri, type: 'Note' })

		const [unlisted] = await sql<{ id: string }>(
			h.store,
			"SELECT id FROM statuses WHERE legacy_id = 'd9a3c8e0-7f1b-4c2a-a4d3-8f3e2b1c0d55'"
		)
		const page = await h.request('/@alice/d9a3c8e0-7f1b-4c2a-a4d3-8f3e2b1c0d55')
		expect(page.status).toBe(301)
		expect(page.headers.get('location')).toBe(`/@alice/${unlisted?.id ?? ''}`)
	})

	it('keeps legacy /ap/o aliases without showing more than their status', async () => {
		const { h } = await imported()
		const alias = async (content: string) =>
			(
				await sql<{ legacy_ap_o: string; uri: string }>(
					h.store,
					'SELECT legacy_ap_o, uri FROM statuses WHERE content LIKE ?',
					`%${content}%`
				)
			)[0]
		// A public remote status: its old proxy moves to the original.
		const remote = await alias('こんにちは')
		const moved = await h.request(`/ap/o/${remote?.legacy_ap_o ?? ''}`, AP)
		expect(moved.status).toBe(301)
		expect(moved.headers.get('location')).toBe(remote?.uri)
		expect((await h.request(`/ap/o/${remote?.legacy_ap_o ?? ''}`)).status).toBe(301)
		// A remote DM and an unknown id answer the same 404.
		const dm = await alias('a DM to alice')
		expect(dm?.legacy_ap_o).toMatch(/^0f0f0f0f-/)
		const hidden = await h.request(`/ap/o/${dm?.legacy_ap_o ?? ''}`, AP)
		const unknown = await h.request('/ap/o/0f0f0f0f-0000-4000-8000-999999999999', AP)
		expect([hidden.status, unknown.status]).toEqual([404, 404])
		expect(await hidden.text()).toBe(await unknown.text())

		// A local image attached to a public status is its Image document; an unattached one is not found.
		const images = await sql<{ legacy_ap_o: string; attached: number }>(
			h.store,
			`SELECT m.legacy_ap_o, m.status_id IS NOT NULL AS attached FROM media_attachments m
			LEFT JOIN statuses s ON s.id = m.status_id
			WHERE m.legacy_ap_o IS NOT NULL AND (s.visibility IS NULL OR s.visibility = 'public') ORDER BY attached DESC`
		)
		const image = await h.request(`/ap/o/${images[0]?.legacy_ap_o ?? ''}`, AP)
		expect(image.status).toBe(200)
		expect(image.headers.get('content-type')).toMatch(/^application\/activity\+json/)
		expect(await image.json()).toEqual({
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: `https://kopje.test/ap/o/${images[0]?.legacy_ap_o ?? ''}`,
			type: 'Image',
			attributedTo: 'https://kopje.test/ap/users/alice',
			url: 'https://images.example/media/image-1/usercontent',
			name: 'a wildebeest',
		})
		expect((await h.request(`/ap/o/${images[images.length - 1]?.legacy_ap_o ?? ''}`, AP)).status).toBe(404)
		// An image attached to a followers-only status is not served either.
		const [hiddenRow] = await sql<{ legacy_ap_o: string }>(
			h.store,
			"SELECT m.legacy_ap_o FROM media_attachments m JOIN statuses s ON s.id = m.status_id WHERE s.visibility = 'private'"
		)
		expect(hiddenRow?.legacy_ap_o).toMatch(/^0f0f0f0f-/)
		const hiddenImage = await h.request(`/ap/o/${hiddenRow?.legacy_ap_o ?? ''}`, AP)
		const unknownAgain = await h.request('/ap/o/0f0f0f0f-0000-4000-8000-999999999998', AP)
		expect([hiddenImage.status, unknownAgain.status]).toEqual([404, 404])
		expect(await hiddenImage.text()).toBe(await unknownAgain.text())
	})

	it('lets a follow, checked when read, decide who reads a migrated followers-only status', async () => {
		const { h } = await imported()
		const { token } = await login(h, { email: 'bob@example.com', scope: 'read write follow' })
		const request = (path: string, init: RequestInit = {}) => h.request(path, bearer(token, init))
		const [status] = await sql<{ id: string; account_id: string }>(
			h.store,
			"SELECT id, account_id FROM statuses WHERE content LIKE '%followers only%'"
		)
		const [reply] = await sql<{ id: string }>(h.store, "SELECT id FROM statuses WHERE content LIKE '%Bob answers%'")
		const id = status?.id ?? ''
		// The status mentions Bob, but the mention grants nothing: no recipient rows.
		expect(await sql(h.store, 'SELECT 1 FROM status_mentions WHERE status_id = ?', id)).toEqual([])

		// Bob follows alice: he reads it directly, in his reply's context, through a bookmark and a notification.
		expect((await request(`/api/v1/statuses/${id}`)).status).toBe(200)
		expect((await request(`/api/v1/statuses/${id}/bookmark`, { method: 'POST' })).status).toBe(200)
		const reads = async () => ({
			status: (await request(`/api/v1/statuses/${id}`)).status,
			context: (
				(await (await request(`/api/v1/statuses/${reply?.id ?? ''}/context`)).json()) as { ancestors: { id: string }[] }
			).ancestors.map((s) => s.id),
			bookmarks: ((await (await request('/api/v1/bookmarks')).json()) as { id: string }[])
				.map((s) => s.id)
				.filter((x) => x === id),
			notifications: ((await (await request('/api/v1/notifications')).json()) as { status?: { id: string } }[])
				.map((n) => n.status?.id)
				.filter((x) => x === id),
		})
		expect(await reads()).toEqual({ status: 200, context: [id], bookmarks: [id], notifications: [id] })

		// After unfollowing, legacy's isVisible would deny him; so does Kopje, everywhere.
		expect((await request(`/api/v1/accounts/${status?.account_id ?? ''}/unfollow`, { method: 'POST' })).status).toBe(
			200
		)
		expect(await reads()).toEqual({ status: 404, context: [], bookmarks: [], notifications: [] })
	})

	it('serves the same actor URLs and keys, and the legacy instance settings', async () => {
		const { h } = await imported()
		const actor = await h.request('/ap/users/alice', AP)
		expect(actor.status).toBe(200)
		const [key] = await sql<{ pubkey: string }>(
			h.store,
			"SELECT l.pubkey FROM local_accounts l JOIN accounts a ON a.id = l.account_id WHERE a.uri = 'https://kopje.test/ap/users/alice'"
		)
		const document = (await actor.json()) as { id: string; publicKey: { id: string; publicKeyPem: string } }
		expect(document.id).toBe('https://kopje.test/ap/users/alice')
		expect(document.publicKey.id).toBe('https://kopje.test/ap/users/alice#main-key')
		// The same key as the legacy instance served (Fedify wraps the PEM at 64 columns).
		const bare = (pem: string) => pem.replace(/\s+/g, '')
		expect(bare(document.publicKey.publicKeyPem)).toBe(bare(key?.pubkey ?? ''))
		expect((await h.request('/ap/users/Bob', AP)).status).toBe(200)

		const instance = (await (await h.request('/api/v1/instance')).json()) as Record<string, unknown>
		expect(instance).toMatchObject({ title: 'Fixture Herd', short_description: 'A synthetic legacy instance' })
		expect(instance.rules).toEqual([
			{ id: '1', text: 'No spam' },
			{ id: '2', text: 'スパム禁止' },
		])
	})
})
