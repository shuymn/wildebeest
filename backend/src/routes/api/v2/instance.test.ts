import { strict as assert } from 'node:assert/strict'

import app from 'wildebeest/backend/src'
import type { Env } from 'wildebeest/backend/src/types'
import { InstanceConfigV2 } from 'wildebeest/backend/src/types/configs'
import { makeDB, createTestUser, assertStatus, assertCORS, assertJSON } from 'wildebeest/backend/test/utils'

const userKEK = 'test_kek23'
const domain = 'cloudflare.com'

describe('/api/v2/instance', () => {
	test('return the instance infos v2', async () => {
		const env = {
			INSTANCE_TITLE: 'a',
			ADMIN_EMAIL: 'b',
			INSTANCE_DESCR: 'c',
		} as Env

		const db = await makeDB()
		await createTestUser(domain, db, userKEK, env.ADMIN_EMAIL, undefined, true)

		const req = new Request(`https://${domain}/api/v2/instance`)
		const res = await app.fetch(req, { ...env, DATABASE: db })
		await assertStatus(res, 200)
		assertCORS(res)
		assertJSON(res)

		{
			const data = await res.json<InstanceConfigV2>()
			assert.equal(data.domain, domain)
			assert.equal(data.title, 'a')
			assert(data.version.includes('Wildebeest'))
			assert.equal(data.source_url, 'https://github.com/cloudflare/wildebeest')
			assert.equal(data.description, 'c')
			assert.equal(data.usage.users.active_month, 1)
			assert.equal(
				data.thumbnail.url,
				'https://imagedelivery.net/NkfPDviynOyTAOI79ar_GQ/b24caf12-5230-48c4-0bf7-2f40063bd400/thumbnail'
			)
			assert.equal(data.thumbnail.blurhash, undefined)
			assert.equal(data.thumbnail.versions, undefined)
			assert.equal(data.languages.length, 1)
			assert.equal(data.languages[0], 'en')
			assert.equal(data.configuration.accounts.max_featured_tags, 10)
			assert.equal(data.configuration.statuses.max_characters, 500)
			assert.equal(data.configuration.statuses.max_media_attachments, 4)
			assert.equal(data.configuration.statuses.characters_reserved_per_url, 23)
			assert.equal(data.configuration.media_attachments.supported_mime_types.length, 6)
			assert.equal(data.configuration.media_attachments.supported_mime_types[0], 'image/jpeg')
			assert.equal(data.configuration.media_attachments.supported_mime_types[1], 'image/png')
			assert.equal(data.configuration.media_attachments.supported_mime_types[2], 'image/gif')
			assert.equal(data.configuration.media_attachments.supported_mime_types[3], 'image/heic')
			assert.equal(data.configuration.media_attachments.supported_mime_types[4], 'image/heif')
			assert.equal(data.configuration.media_attachments.supported_mime_types[5], 'image/webp')
			assert.equal(data.configuration.media_attachments.image_size_limit, 16777216)
			assert.equal(data.configuration.media_attachments.image_matrix_limit, 33177600)
			assert.equal(data.configuration.media_attachments.video_size_limit, 0)
			assert.equal(data.configuration.media_attachments.video_frame_rate_limit, 0)
			assert.equal(data.configuration.media_attachments.video_matrix_limit, 0)
			assert.equal(data.configuration.polls.max_options, 4)
			assert.equal(data.configuration.polls.max_characters_per_option, 50)
			assert.equal(data.configuration.polls.min_expiration, 300)
			assert.equal(data.configuration.polls.max_expiration, 2629746)
			assert.equal(data.configuration.translation.enabled, false)
			assert.equal(data.registrations.enabled, false)
			assert.equal(data.registrations.approval_required, false)
			assert.equal(data.registrations.message, null)
			assert.equal(data.contact.email, 'b')
			assert.equal(data.contact.account!.acct, 'b')
			assert.equal(data.contact.account!.display_name, 'b')
			assert.equal(data.contact.account!.username, 'b')
			assert.equal(data.contact.account!.url, 'https://cloudflare.com/@b')
			assert.equal(data.rules.length, 0)
			assert.ok(data.contact.account!.id)
		}
	})
})
