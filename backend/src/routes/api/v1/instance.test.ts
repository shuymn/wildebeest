import { strict as assert } from 'node:assert/strict'

import * as v1_instance from 'wildebeest/backend/src/routes/api/v1/instance'
import type { Env } from 'wildebeest/backend/src/types'
import { InstanceConfig } from 'wildebeest/backend/src/types/configs'
import { makeDB, createTestUser, assertStatus, assertCORS, assertJSON } from 'wildebeest/backend/test/utils'

const userKEK = 'test_kek23'
const domain = 'cloudflare.com'

describe('instance', () => {
	test('return the instance infos v1', async () => {
		const env = {
			INSTANCE_TITLE: 'a',
			ADMIN_EMAIL: 'b',
			INSTANCE_DESCR: 'c',
		} as Env

		const db = await makeDB()
		await createTestUser(domain, db, userKEK, env.ADMIN_EMAIL, undefined, true)

		const res = await v1_instance.handleRequest(domain, db, env)
		await assertStatus(res, 200)
		assertCORS(res)
		assertJSON(res)

		{
			const data = await res.json<InstanceConfig>()
			assert.equal(data.uri, domain)
			assert.equal(data.title, 'a')
			assert.equal(data.short_description, 'c')
			assert.equal(data.description, 'c')
			assert.equal(data.email, 'b')
			assert(data.version.includes('Wildebeest'))
			assert.equal(data.stats.user_count, 1)
			assert.equal(data.stats.status_count, 0)
			assert.equal(data.stats.domain_count, 0)
			assert.equal(
				data.thumbnail,
				'https://imagedelivery.net/NkfPDviynOyTAOI79ar_GQ/b24caf12-5230-48c4-0bf7-2f40063bd400/thumbnail'
			)
			assert.equal(data.languages.length, 1)
			assert.equal(data.languages[0], 'en')
			assert.equal(data.registrations, false)
			assert.equal(data.approval_required, false)
			assert.equal(data.invites_enabled, false)
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
			assert.equal(data.contact_account!.acct, 'b')
			assert.equal(data.contact_account!.display_name, 'b')
			assert.equal(data.contact_account!.username, 'b')
			assert.equal(data.contact_account!.url, 'https://cloudflare.com/@b')
			assert.equal(data.rules.length, 0)
			assert.ok(data.contact_account!.id)
		}
	})

	test('adds a short_description if missing v1', async () => {
		const db = await makeDB()

		const env = {
			INSTANCE_DESCR: 'c',
			ADMIN_EMAIL: 'b',
		} as Env

		const res = await v1_instance.handleRequest(domain, db, env)
		await assertStatus(res, 200)

		{
			const data = await res.json<InstanceConfig>()
			assert.equal(data.short_description, 'c')
		}
	})
})
