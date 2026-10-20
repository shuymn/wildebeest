import { describe, expect, it } from 'vitest'

import { apiHarness, bearer, json, login, seedAccount, sql } from './api-helpers'
import { LEGACY } from './federation-helpers'

// Local profile fields (Mastodon's fields_attributes): at most four, stored as plain text, presented escaped with
// http(s) URLs linked (HTML-2, HTML-3), in the API and as the actor's PropertyValue attachments.

async function withAlice() {
	const h = await apiHarness()
	await seedAccount(h.store, { username: 'alice', email: 'alice@example.com', displayName: 'Alice' })
	return h
}

describe('profile fields over the API', () => {
	it('replaces fields from fields_attributes, at most four', async () => {
		const h = await withAlice()
		const { token } = await login(h, { scope: 'read write' })
		const update = (body: unknown) =>
			h.request('/api/v1/accounts/update_credentials', bearer(token, { ...json(body), method: 'PATCH' }))
		const ok = await update({ fields_attributes: [{ name: 'a', value: 'b' }] })
		expect(ok.status).toBe(200)
		expect((await ok.json<{ fields: unknown[] }>()).fields).toEqual([{ name: 'a', value: 'b', verified_at: null }])
		const five = Array.from({ length: 5 }, (_, i) => ({ name: `n${i}`, value: `v${i}` }))
		expect((await update({ fields_attributes: five })).status).toBe(422)
		const cleared = await update({ fields_attributes: [] })
		expect((await cleared.json<{ fields: unknown[] }>()).fields).toEqual([])
		// An empty JSON object is a sent, empty hash: it clears the fields too, as does an object of empty members.
		for (const empty of [{}, { 0: {} }]) {
			await update({ fields_attributes: [{ name: 'a', value: 'b' }] })
			const response = await update({ fields_attributes: empty })
			expect((await response.json<{ fields: unknown[] }>()).fields).toEqual([])
		}
		// A body without fields_attributes keeps them.
		await update({ fields_attributes: [{ name: 'a', value: 'b' }] })
		expect((await (await update({ note: 'n' })).json<{ fields: unknown[] }>()).fields).toHaveLength(1)
	})

	it('publishes fields as PropertyValue attachments of the actor', async () => {
		const h = await withAlice()
		await sql(h.store, 'UPDATE local_accounts SET pubkey = ?', LEGACY.pubkey)
		const { token } = await login(h, { scope: 'read write' })
		await h.request(
			'/api/v1/accounts/update_credentials',
			bearer(token, {
				...json({ fields_attributes: [{ name: 'Site', value: 'https://alice.example/' }] }),
				method: 'PATCH',
			})
		)
		const actor = await (
			await h.request('/ap/users/alice', { headers: { accept: 'application/activity+json' } })
		).json<{ attachment: { type: string; name: string; value: string } }>()
		expect(actor.attachment).toMatchObject({ type: 'PropertyValue', name: 'Site' })
		expect(actor.attachment.value).toContain('href="https://alice.example/"')
	})
})
