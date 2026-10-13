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
		expect(status.tags).toEqual([expect.objectContaining({ name: 'wildebeest' })])
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
})
