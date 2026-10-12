import { describe, expect, it } from 'vitest'

import { bearer, json, sql } from './api-helpers'
import { LEGACY } from './federation-helpers'
import { PNG_PLAIN } from './fixtures/images'
import { bytes, mediaForm, TestCodec } from './media-helpers'
import { community, outbound, remoteAccount, remoteFollows } from './status-helpers'
import { csrfOf, ORIGIN, signIn } from './web-helpers'

// Profile changes reach other servers as Update(Person) through B2's delivery (VIS-3's "changes reach only the
// original audience" for an actor: its followers), and a later Update supersedes an earlier one.

async function setup() {
	const codec = new TestCodec()
	const h = await community(['alice'], 'read write follow', { images: () => codec })
	await sql(h.store, 'UPDATE local_accounts SET pubkey = ?', LEGACY.pubkey)
	const fan = await remoteAccount(h.store, 'fan', 'fans.example')
	await remoteFollows(h.store, fan, h.users.alice.id)
	return h
}

function patch(h: Awaited<ReturnType<typeof setup>>, body: unknown) {
	return h.request(
		'/api/v1/accounts/update_credentials',
		bearer(h.users.alice.token, { ...json(body), method: 'PATCH' })
	)
}

async function updates(h: Awaited<ReturnType<typeof setup>>) {
	const rows = await sql<{ superseded: number; body: string }>(
		h.store,
		"SELECT superseded, body FROM outbound_activities WHERE json_extract(body, '$.activity.type') = 'Update' ORDER BY id"
	)
	return rows.map((row) => ({
		superseded: row.superseded === 1,
		activity: (JSON.parse(row.body) as { activity: Record<string, unknown> & { object: Record<string, unknown> } })
			.activity,
	}))
}

describe('Update(Person)', () => {
	it('sends the changed profile to the followers, the latest edit only', async () => {
		const h = await setup()
		expect((await patch(h, { display_name: 'First' })).status).toBe(200)
		expect(
			(
				await patch(h, {
					display_name: 'Second',
					note: 'bio',
					fields_attributes: [{ name: 'Site', value: 'https://alice.example/' }],
				})
			).status
		).toBe(200)
		const sent = await updates(h)
		// The first edit's Update was still waiting: the second replaced it, and nothing of it remains.
		expect(sent.map((u) => u.superseded)).toEqual([false])
		const latest = sent[0]?.activity
		expect(latest).toMatchObject({
			type: 'Update',
			actor: `${ORIGIN}/ap/users/alice`,
			to: ['https://www.w3.org/ns/activitystreams#Public'],
			object: {
				id: `${ORIGIN}/ap/users/alice`,
				type: 'Person',
				name: 'Second',
				summary: '<p>bio</p>',
				attachment: [{ type: 'PropertyValue', name: 'Site' }],
				publicKey: { id: `${ORIGIN}/ap/users/alice#main-key`, publicKeyPem: LEGACY.pubkey },
			},
		})
		// Only the latest is delivered, as an Update (never turned into a Create), to the follower's server.
		const deliveries = await sql<{ type: string; name: string; inbox_url: string }>(
			h.store,
			`SELECT json_extract(o.body, '$.activity.type') AS type, json_extract(o.body, '$.activity.object.name') AS name,
				d.inbox_url FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id`
		)
		expect(deliveries).toEqual([{ type: 'Update', name: 'Second', inbox_url: 'https://fans.example/inbox' }])
		// The same document the actor endpoint publishes.
		const actor = await (
			await h.request('/ap/users/alice', { headers: { accept: 'application/activity+json' } })
		).json<Record<string, unknown>>()
		for (const key of ['id', 'type', 'preferredUsername', 'name', 'summary', 'url', 'inbox', 'followers']) {
			expect(latest?.object[key], key).toEqual(actor[key])
		}
	})

	it('sends nothing when the published profile does not change', async () => {
		const h = await setup()
		await patch(h, { source: { privacy: 'unlisted' } })
		await patch(h, { display_name: '' })
		expect(await updates(h)).toEqual([])
		expect(await outbound(h.store)).toEqual([])
	})

	it('sends the new avatar from the settings page', async () => {
		const h = await setup()
		const browser = await signIn(h)
		const form = mediaForm(bytes(PNG_PLAIN), { csrf: await csrfOf(h, browser) }, 'p.png', 'image/png')
		const response = await h.request('/settings/avatar', {
			method: 'POST',
			headers: { cookie: browser.cookie, origin: ORIGIN },
			body: form,
		})
		expect(response.status).toBe(303)
		const [avatar] = await sql<{ avatar_url: string }>(
			h.store,
			"SELECT avatar_url FROM accounts WHERE username = 'alice'"
		)
		const sent = await updates(h)
		expect(sent).toHaveLength(1)
		expect(sent[0]?.activity.object).toMatchObject({ icon: { type: 'Image', url: avatar?.avatar_url } })
	})
})
