import { env } from 'cloudflare:workers'

import { describe, expect, inject, it } from 'vitest'

import { apiHarness, bearer, login, sql } from './api-helpers'
import { BUILD } from './helpers'
import { ADMIN_AUD, ADMIN_EMAIL, importViaRpc, setAccess } from './ops-helpers'
import { sweepMedia } from '../src/mastodon/media'

// Images moved out of Cloudflare Images by the cutover (`convert --images`, docs/cutover.md "Media") live by Kopje's
// own per-row media lifecycle: every row has its own token, files and original, so when two statuses show the same
// legacy image, deleting one of them with its media removes only that row's objects (test-node/cutover-global-setup.ts
// converts the fixture whose unlisted status shows the image of the public one again).

declare module 'vitest' {
	export interface ProvidedContext {
		cutoverImages: { dump: string; originals: Record<string, string> }
	}
}

describe('media moved from Cloudflare Images', () => {
	it('keeps the files of a status that shows the same image as a deleted one, through the real sweep', async () => {
		const { dump } = inject('cutoverImages')
		const h = await apiHarness()
		await setAccess(h.store, { access_team_domain: h.team.teamDomain })
		const authority = {
			kind: 'access',
			email: ADMIN_EMAIL,
			commonName: null,
			teamDomain: h.team.teamDomain,
			aud: ADMIN_AUD,
		} as const
		const { report } = await importViaRpc(h.store, dump, 16 * 1024, authority)
		expect(report).toMatchObject({ ok: true })
		await h.store.publish(BUILD, authority)

		// The objects the runbook puts (originals) and media-rebuild makes (files), for every moved row.
		const rows = await sql<{ id: string; file_token: string; content: string | null }>(
			h.store,
			`SELECT m.id, m.file_token, s.content FROM media_attachments m LEFT JOIN statuses s ON s.id = m.status_id
			WHERE m.file_token IS NOT NULL`
		)
		const keysOf = (row: { id: string; file_token: string }) => [
			`originals/${row.id}`,
			`files/${row.file_token}/full`,
			`files/${row.file_token}/small`,
		]
		for (const row of rows) {
			for (const key of keysOf(row)) {
				await env.MEDIA.put(key, new Uint8Array([1]))
			}
		}
		const shownBy = (content: string) => {
			const found = rows.find((r) => r.content?.includes(content) === true)
			if (found === undefined) {
				throw new Error(`no moved media for ${content}`)
			}
			return found
		}
		const deleted = shownBy('Wildebeest day')
		const kept = shownBy('unlisted, with a CW')
		expect(kept.file_token).not.toBe(deleted.file_token)

		const [status] = await sql<{ id: string }>(
			h.store,
			'SELECT s.id FROM statuses s JOIN media_attachments m ON m.status_id = s.id WHERE m.id = ?',
			deleted.id
		)
		const { token } = await login(h, { email: 'alice@example.com' })
		const response = await h.request(
			`/api/v1/statuses/${status?.id}?delete_media=true`,
			bearer(token, { method: 'DELETE' })
		)
		expect(response.status).toBe(200)
		await sweepMedia(env, {
			build: () => env.CF_VERSION_METADATA.id,
			now: () => Date.now() + 1000,
			store: () => h.store,
		})

		const present = async (keys: string[]) => {
			const found: string[] = []
			for (const key of keys) {
				if ((await env.MEDIA.head(key)) !== null) {
					found.push(key)
				}
			}
			return found
		}
		expect(await present(keysOf(deleted))).toEqual([])
		expect(await present(keysOf(kept))).toEqual(keysOf(kept))
		expect(await sql(h.store, 'SELECT id FROM media_attachments WHERE id = ?', kept.id)).toEqual([{ id: kept.id }])
	})
})
