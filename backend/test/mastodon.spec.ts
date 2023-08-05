import { strict as assert } from 'node:assert/strict'

import { moveFollowers } from 'wildebeest/backend/src/mastodon/follow'
import { enrichStatus } from 'wildebeest/backend/src/mastodon/microformats'
import type { Env } from 'wildebeest/backend/src/types'
import { InstanceConfig, InstanceConfigV2 } from 'wildebeest/backend/src/types/configs'
import * as blocks from 'wildebeest/functions/api/v1/blocks'
import * as custom_emojis from 'wildebeest/functions/api/v1/custom_emojis'
import * as v1_instance from 'wildebeest/functions/api/v1/instance'
import * as mutes from 'wildebeest/functions/api/v1/mutes'
import * as v2_instance from 'wildebeest/functions/api/v2/instance'

import { assertCache, assertCORS, assertJSON, assertStatus, createTestUser, makeDB } from './utils'

const userKEK = 'test_kek23'
const domain = 'cloudflare.com'

describe('Mastodon APIs', () => {
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

		test('return the instance infos v2', async () => {
			const env = {
				INSTANCE_TITLE: 'a',
				ADMIN_EMAIL: 'b',
				INSTANCE_DESCR: 'c',
			} as Env

			const db = await makeDB()
			await createTestUser(domain, db, userKEK, env.ADMIN_EMAIL, undefined, true)

			const res = await v2_instance.handleRequest(domain, db, env)
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

	describe('custom emojis', () => {
		test('returns an empty array', async () => {
			const res = await custom_emojis.onRequest()
			await assertStatus(res, 200)
			assertJSON(res)
			assertCORS(res)
			assertCache(res, 300)

			const data = await res.json<any>()
			assert.equal(data.length, 0)
		})
	})

	test('mutes returns an empty array', async () => {
		const res = await mutes.onRequest()
		await assertStatus(res, 200)
		assertJSON(res)

		const data = await res.json<any>()
		assert.equal(data.length, 0)
	})

	test('blocks returns an empty array', async () => {
		const res = await blocks.onRequest()
		await assertStatus(res, 200)
		assertJSON(res)

		const data = await res.json<any>()
		assert.equal(data.length, 0)
	})

	describe('Microformats', () => {
		test('convert mentions to HTML', async () => {
			const mentionsToTest = [
				{
					mention: '@sven2@example.com',
					expectedMentionSpan:
						'<span class="h-card"><a href="https://example.com/@sven2" class="u-url mention">@<span>sven2</span></a></span>',
				},
				{
					mention: '@test@example.eng.com',
					expectedMentionSpan:
						'<span class="h-card"><a href="https://example.eng.com/@test" class="u-url mention">@<span>test</span></a></span>',
				},
				{
					mention: '@test.a.b.c-d@example.eng.co.uk',
					expectedMentionSpan:
						'<span class="h-card"><a href="https://example.eng.co.uk/@test.a.b.c-d" class="u-url mention">@<span>test.a.b.c-d</span></a></span>',
				},
				{
					mention: '@testey@123456.abcdef',
					expectedMentionSpan:
						'<span class="h-card"><a href="https://123456.abcdef/@testey" class="u-url mention">@<span>testey</span></a></span>',
				},
				{
					mention: '@testey@123456.test.testey.abcdef',
					expectedMentionSpan:
						'<span class="h-card"><a href="https://123456.test.testey.abcdef/@testey" class="u-url mention">@<span>testey</span></a></span>',
				},
			]

			for (let i = 0, len = mentionsToTest.length; i < len; i++) {
				const { mention, expectedMentionSpan } = mentionsToTest[i]

				// List of mentioned actors, only the `id` is required so we can hack together an Actor
				const mentions: any = [
					{ id: new URL('https://example.com/sven2') },
					{ id: new URL('https://example.eng.com/test') },
					{ id: new URL('https://example.eng.co.uk/test.a.b.c-d') },
					{ id: new URL('https://123456.abcdef/testey') },
					{ id: new URL('https://123456.test.testey.abcdef/testey') },
				]

				assert.equal(enrichStatus(`hey ${mention} hi`, mentions), `<p>hey ${expectedMentionSpan} hi</p>`)
				assert.equal(enrichStatus(`${mention} hi`, mentions), `<p>${expectedMentionSpan} hi</p>`)
				assert.equal(enrichStatus(`${mention}\n\thein`, mentions), `<p>${expectedMentionSpan}\n\thein</p>`)
				assert.equal(enrichStatus(`hey ${mention}`, mentions), `<p>hey ${expectedMentionSpan}</p>`)
				assert.equal(enrichStatus(`${mention}`, mentions), `<p>${expectedMentionSpan}</p>`)
				assert.equal(enrichStatus(`@!@£${mention}!!!`, mentions), `<p>@!@£${expectedMentionSpan}!!!</p>`)
			}
		})

		test('handle invalid mention', () => {
			assert.equal(enrichStatus('hey @#-...@example.com', new Set()), '<p>hey @#-...@example.com</p>')
		})

		test('mention to invalid user', () => {
			assert.equal(enrichStatus('hey test@example.com', new Set()), '<p>hey test@example.com</p>')
		})

		test('convert links to HTML', () => {
			const linksToTest = [
				'https://cloudflare.com/abc',
				'https://cloudflare.com/abc/def',
				'https://www.cloudflare.com/123',
				'http://www.cloudflare.co.uk',
				'http://www.cloudflare.co.uk?test=test@123',
				'http://www.cloudflare.com/.com/?test=test@~123&a=b',
				'https://developers.cloudflare.com/workers/runtime-apis/request/#background',
				'https://a.test',
				'https://a.test/test',
				'https://a.test/test?test=test',
			]
			linksToTest.forEach((link) => {
				const url = new URL(link)
				const urlDisplayText = `${url.hostname}${url.pathname}`
				assert.equal(enrichStatus(`hey ${link} hi`, new Set()), `<p>hey <a href="${link}">${urlDisplayText}</a> hi</p>`)
				assert.equal(enrichStatus(`${link} hi`, new Set()), `<p><a href="${link}">${urlDisplayText}</a> hi</p>`)
				assert.equal(enrichStatus(`hey ${link}`, new Set()), `<p>hey <a href="${link}">${urlDisplayText}</a></p>`)
				assert.equal(enrichStatus(`${link}`, new Set()), `<p><a href="${link}">${urlDisplayText}</a></p>`)
				assert.equal(enrichStatus(`@!@£${link}!!!`, new Set()), `<p>@!@£<a href="${link}">${urlDisplayText}</a>!!!</p>`)
			})
		})

		test('convert tags to HTML', async () => {
			const tagsToTest = [
				{
					tag: '#test',
					expectedTagAnchor: '<a href="/tags/test" class="status-link hashtag">#test</a>',
				},
				{
					tag: '#123_joke_123',
					expectedTagAnchor: '<a href="/tags/123_joke_123" class="status-link hashtag">#123_joke_123</a>',
				},
				{
					tag: '#_123',
					expectedTagAnchor: '<a href="/tags/_123" class="status-link hashtag">#_123</a>',
				},
				{
					tag: '#example:',
					expectedTagAnchor: '<a href="/tags/example" class="status-link hashtag">#example</a>:',
				},
				{
					tag: '#tagA#tagB',
					expectedTagAnchor:
						'<a href="/tags/tagA" class="status-link hashtag">#tagA</a><a href="/tags/tagB" class="status-link hashtag">#tagB</a>',
				},
			]

			for (let i = 0, len = tagsToTest.length; i < len; i++) {
				const { tag, expectedTagAnchor } = tagsToTest[i]

				assert.equal(enrichStatus(`hey ${tag} hi`, new Set()), `<p>hey ${expectedTagAnchor} hi</p>`)
				assert.equal(enrichStatus(`${tag} hi`, new Set()), `<p>${expectedTagAnchor} hi</p>`)
				assert.equal(enrichStatus(`${tag}\n\thein`, new Set()), `<p>${expectedTagAnchor}\n\thein</p>`)
				assert.equal(enrichStatus(`hey ${tag}`, new Set()), `<p>hey ${expectedTagAnchor}</p>`)
				assert.equal(enrichStatus(`${tag}`, new Set()), `<p>${expectedTagAnchor}</p>`)
				assert.equal(enrichStatus(`@!@£${tag}!!!`, new Set()), `<p>@!@£${expectedTagAnchor}!!!</p>`)
			}
		})

		test('ignore invalid tags', () => {
			assert.equal(enrichStatus('tags cannot be empty like: #', new Set()), `<p>tags cannot be empty like: #</p>`)
			assert.equal(
				enrichStatus('tags cannot contain only numbers like: #123', new Set()),
				`<p>tags cannot contain only numbers like: #123</p>`
			)
		})
	})

	describe('Follow', () => {
		test('move followers', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

			globalThis.fetch = async (input: RequestInfo) => {
				if (input instanceof URL || typeof input === 'string') {
					if (input.toString() === 'https://example.com/user/a') {
						return new Response(
							JSON.stringify({ id: 'https://example.com/user/a', type: 'Actor', preferredUsername: 'a' })
						)
					}
					if (input.toString() === 'https://example.com/user/b') {
						return new Response(
							JSON.stringify({ id: 'https://example.com/user/b', type: 'Actor', preferredUsername: 'b' })
						)
					}
					if (input.toString() === 'https://example.com/user/c') {
						return new Response(
							JSON.stringify({ id: 'https://example.com/user/c', type: 'Actor', preferredUsername: 'c' })
						)
					}
					throw new Error(`unexpected request to "${input.toString()}"`)
				}
				throw new Error('unexpected request to ' + input.url)
			}

			const followers = ['https://example.com/user/a', 'https://example.com/user/b', 'https://example.com/user/c']

			await moveFollowers(domain, db, actor, followers)

			const { results, success } = await db.prepare('SELECT * FROM actor_following').all<any>()
			assert(success)
			assert(results)
			assert.equal(results.length, 3)
			assert.equal(results[0].state, 'accepted')
			assert.equal(results[0].actor_id, 'https://example.com/user/a')
			assert.equal(results[0].target_actor_acct, 'sven')
			assert.equal(results[1].state, 'accepted')
			assert.equal(results[1].actor_id, 'https://example.com/user/b')
			assert.equal(results[1].target_actor_acct, 'sven')
			assert.equal(results[2].state, 'accepted')
			assert.equal(results[2].actor_id, 'https://example.com/user/c')
			assert.equal(results[2].target_actor_acct, 'sven')
		})
	})
})
