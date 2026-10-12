import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { updateActorProperty } from '@wildebeest/backend/activitypub/actors'
import { getApId, mastodonIdSymbol } from '@wildebeest/backend/activitypub/objects'
import { defaultImages } from '@wildebeest/backend/config/accounts'
import { createPublicStatus } from '@wildebeest/backend/test/shared.utils'
import { assertStatus, createTestUser, makeDB } from '@wildebeest/backend/test/utils'

const userKEK = 'test_kek_sanitize_output'
const domain = 'cloudflare.com'

// Rows stored before the allowlist sanitizer existed may contain unsafe HTML; the API must not serve it.
describe('Mastodon API output sanitization', () => {
	test('status content and spoiler_text stored unsanitized are sanitized on output', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const note = await createPublicStatus(domain, db, actor, 'a post')

		const content =
			'<p onclick="alert(1)" style="color:red">hi<img src=x onerror="alert(2)"><a href="jav&#x61;script:alert(3)">x</a><svg><script>alert(4)</script></svg></p>'
		await db
			.prepare(`UPDATE objects SET properties=json_set(properties, '$.content', ?1, '$.spoiler_text', ?2) WHERE id=?3`)
			.bind(content, '<b onmouseover="alert(5)">cw</b>', getApId(note).toString())
			.run()

		const res = await app.fetch(new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}`), {
			DATABASE: db,
		})
		await assertStatus(res, 200)
		const data = await res.json<{ content: string; spoiler_text: string }>()
		assert.equal(data.content, '<p>hi<a rel="nofollow noopener noreferrer" target="_blank">x</a></p>')
		assert.equal(data.spoiler_text, 'cw')
	})

	test('account note and display_name stored unsanitized are sanitized on output', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		await updateActorProperty(db, getApId(actor), 'name', 'sven<img src=x onerror="alert(1)">')
		await updateActorProperty(
			db,
			getApId(actor),
			'summary',
			'<p style="x">bio<a href="data:text/html,evil" onclick="alert(2)">l</a><script>alert(3)</script></p>'
		)

		const res = await app.fetch(new Request(`https://${domain}/api/v1/accounts/${actor[mastodonIdSymbol]}`), {
			DATABASE: db,
			data: { connectedActor: actor },
		})
		await assertStatus(res, 200)
		const data = await res.json<{ display_name: string; note: string }>()
		assert.equal(data.display_name, 'sven')
		assert.equal(data.note, '<p>bio<a rel="nofollow noopener noreferrer" target="_blank">l</a></p>')
	})

	test('account URLs stored with a non-web scheme are not served', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		await db
			.prepare(
				`UPDATE actors SET properties=json_set(properties, '$.url', ?1, '$.icon', json(?2), '$.image', json(?3)) WHERE id=?4`
			)
			.bind(
				'javascript:alert(1)',
				JSON.stringify({ type: 'Image', url: 'javascript:alert(2)' }),
				JSON.stringify({ type: 'Image', url: 'data:text/html,evil' }),
				getApId(actor).toString()
			)
			.run()

		const res = await app.fetch(new Request(`https://${domain}/api/v1/accounts/${actor[mastodonIdSymbol]}`), {
			DATABASE: db,
			data: { connectedActor: actor },
		})
		await assertStatus(res, 200)
		const data = await res.json<{ url: string; avatar: string; header: string }>()
		assert.equal(data.url, '')
		assert.equal(data.avatar, defaultImages.avatar)
		assert.equal(data.header, defaultImages.header)
	})

	test('status and media URLs stored with a non-web scheme are not served', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const note = await createPublicStatus(domain, db, actor, 'a post')
		await db
			.prepare(`UPDATE objects SET properties=json_set(properties, '$.url', ?1, '$.attachment', json(?2)) WHERE id=?3`)
			.bind(
				'javascript:alert(1)',
				JSON.stringify([
					{ type: 'Document', mediaType: 'image/jpeg', url: 'javascript:alert(2)' },
					{ type: 'Document', mediaType: 'image/jpeg', url: 'https://example.com/image.jpg' },
				]),
				getApId(note).toString()
			)
			.run()

		const expectedUrl = `https://${domain}/@sven/${note[mastodonIdSymbol]}`
		{
			const res = await app.fetch(new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}`), {
				DATABASE: db,
			})
			await assertStatus(res, 200)
			const data = await res.json<{ url: string; media_attachments: { url: string }[] }>()
			assert.equal(data.url, expectedUrl)
			assert.deepEqual(
				data.media_attachments.map((m) => m.url),
				['https://example.com/image.jpg']
			)
		}
		{
			const res = await app.fetch(
				new Request(`https://${domain}/api/v1/accounts/${actor[mastodonIdSymbol]}/statuses`),
				{ DATABASE: db }
			)
			await assertStatus(res, 200)
			const [data] = await res.json<{ url: string; media_attachments: { url: string }[] }[]>()
			assert.equal(data.url, expectedUrl)
			assert.deepEqual(
				data.media_attachments.map((m) => m.url),
				['https://example.com/image.jpg']
			)
		}
	})
})
