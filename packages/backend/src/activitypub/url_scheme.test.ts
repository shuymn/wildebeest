import { strict as assert } from 'node:assert/strict'

import { CreateActivity, PUBLIC_GROUP } from '@wildebeest/backend/activitypub/activities'
import * as activityHandler from '@wildebeest/backend/activitypub/activities/handle'
import { getAndCacheActor } from '@wildebeest/backend/activitypub/actors'
import { getApId } from '@wildebeest/backend/activitypub/objects'
import { Note } from '@wildebeest/backend/activitypub/objects/note'
import { createTestUser, makeDB } from '@wildebeest/backend/test/utils'
import type { JWK } from '@wildebeest/backend/webpush/jwk'

const adminEmail = 'admin@example.com'
const domain = 'cloudflare.com'
const userKEK = 'test_kek_url_scheme'
const vapidKeys = {} as JWK
const remoteActorId = 'https://example.com/actor'

function serveRemoteActor(extra: Record<string, unknown> = {}) {
	globalThis.fetch = (input) => {
		const url = input instanceof URL || typeof input === 'string' ? input.toString() : input.url
		if (url === remoteActorId) {
			return Promise.resolve(
				new Response(JSON.stringify({ id: remoteActorId, type: 'Person', preferredUsername: 'actor', ...extra }))
			)
		}
		return Promise.reject(new Error('unexpected request to ' + url))
	}
}

describe('Remote URL fields', () => {
	test('a remote actor keeps only web URLs', async () => {
		const db = makeDB()
		serveRemoteActor({
			url: 'javascript:alert(1)',
			icon: { type: 'Image', url: 'javascript:alert(2)' },
			image: { type: 'Image', url: 'https://example.com/header.png' },
			tag: [
				{ type: 'Emoji', name: ':evil:', icon: { type: 'Image', url: 'javascript:alert(3)' } },
				{ type: 'Emoji', name: ':ok:', icon: { type: 'Image', url: 'https://example.com/ok.png' } },
			],
		})

		assert.ok(await getAndCacheActor(getApId(remoteActorId), db))

		const row = await db
			.prepare('SELECT properties FROM actors WHERE id=?1')
			.bind(remoteActorId)
			.first<{ properties: string }>()
		assert.ok(row)
		const properties = JSON.parse(row.properties) as {
			url?: string
			icon?: unknown
			image: { url: string }
			tag: { name: string }[]
		}
		assert.equal(properties.url, undefined)
		assert.equal(properties.icon, undefined)
		assert.equal(properties.image.url, 'https://example.com/header.png')
		assert.deepEqual(
			properties.tag.map((t: { name: string }) => t.name),
			[':ok:']
		)
	})

	test('a remote Note keeps only web URLs', async () => {
		const db = makeDB()
		const recipient = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		serveRemoteActor()

		const activity: CreateActivity<Note> = {
			type: 'Create',
			id: getApId('https://example.com/create/1'),
			actor: getApId(remoteActorId),
			to: [PUBLIC_GROUP],
			cc: [recipient.id],
			object: {
				id: 'https://example.com/note',
				type: 'Note',
				url: 'javascript:alert(1)',
				content: 'hi',
				attributedTo: remoteActorId,
				attachment: [
					{ type: 'Document', mediaType: 'image/png', url: 'javascript:alert(2)' },
					{ type: 'Document', mediaType: 'image/png', url: 'https://example.com/a.png' },
				],
				tag: [{ type: 'Emoji', name: ':evil:', icon: { type: 'Image', url: 'javascript:alert(3)' } }],
				to: [PUBLIC_GROUP],
				cc: [recipient.id],
				sensitive: false,
			} as unknown as Note,
		}
		await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

		const row = await db.prepare('SELECT properties FROM objects').first<{ properties: string }>()
		assert.ok(row)
		const properties = JSON.parse(row.properties) as { url?: string; attachment: { url: string }[]; tag: unknown[] }
		assert.equal(properties.url, undefined)
		assert.deepEqual(
			properties.attachment.map((a: { url: string }) => a.url),
			['https://example.com/a.png']
		)
		assert.deepEqual(properties.tag, [])
	})
})
