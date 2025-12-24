import { strict as assert } from 'node:assert/strict'

import { getMentions } from 'wildebeest/backend/src/mastodon/status'
import { makeDB, createTestUser } from 'wildebeest/backend/test/utils'

const userKEK = 'test_kek4'
const domain = 'cloudflare.com'

describe('mastodon/status', () => {
	test('get mentions from status', async () => {
		const db = makeDB()
		await createTestUser(domain, db, userKEK, 'sven@example.com')

		globalThis.fetch = async (input: RequestInfo) => {
			if (input instanceof URL || typeof input === 'string') {
				if (input.toString() === 'https://instance.horse/.well-known/webfinger?resource=acct%3Asven%40instance.horse') {
					return new Response(
						JSON.stringify({
							links: [
								{
									rel: 'self',
									type: 'application/activity+json',
									href: 'https://instance.horse/users/sven',
								},
							],
						})
					)
				}
				if (input.toString() === 'https://example.com/.well-known/webfinger?resource=acct%3Aa%40example.com') {
					return new Response(
						JSON.stringify({
							links: [
								{
									rel: 'self',
									type: 'application/activity+json',
									href: 'https://example.com/users/a',
								},
							],
						})
					)
				}
				if (input.toString() === 'https://example.com/.well-known/webfinger?resource=acct%3Ab%40example.com') {
					return new Response(
						JSON.stringify({
							links: [
								{
									rel: 'self',
									type: 'application/activity+json',
									href: 'https://example.com/users/b',
								},
							],
						})
					)
				}
				if (input.toString() === 'https://example.com/.well-known/webfinger?resource=acct%3Ano-json%40example.com') {
					return new Response('not json', { status: 200 })
				}

				if (input.toString() === 'https://instance.horse/users/sven') {
					return new Response(
						JSON.stringify({
							id: 'https://instance.horse/users/sven',
							type: 'Person',
							preferredUsername: 'sven',
						})
					)
				}
				if (input.toString() === 'https://example.com/users/a') {
					return new Response(
						JSON.stringify({
							id: 'https://example.com/users/a',
							type: 'Person',
							preferredUsername: 'a',
						})
					)
				}
				if (input.toString() === 'https://example.com/users/b') {
					return new Response(
						JSON.stringify({
							id: 'https://example.com/users/b',
							type: 'Person',
							preferredUsername: 'b',
						})
					)
				}
			}

			if (input instanceof URL || typeof input === 'string') {
				throw new Error('unexpected request to ' + input.toString())
			} else {
				throw new Error('unexpected request to ' + input.url)
			}
		}

		{
			const mentions = await getMentions('test status', domain, db)
			assert.equal(mentions.size, 0)
		}

		{
			const mentions = await getMentions('no-json@actor.com', domain, db)
			assert.equal(mentions.size, 0)
		}

		{
			const mentions = await getMentions('@sven@instance.horse test status', domain, db)
			assert.equal(mentions.size, 1)
			assert.equal([...mentions][0].id.toString(), 'https://instance.horse/users/sven')
		}

		{
			// local account
			const mentions = await getMentions('@sven test status', domain, db)
			assert.equal(mentions.size, 1)
			assert.equal([...mentions][0].id.toString(), 'https://' + domain + '/ap/users/sven')
		}

		{
			const mentions = await getMentions('@a@example.com @b@example.com', domain, db)
			assert.equal(mentions.size, 2)
			assert.equal([...mentions][0].id.toString(), 'https://example.com/users/a')
			assert.equal([...mentions][1].id.toString(), 'https://example.com/users/b')
		}

		{
			const mentions = await getMentions('<p>@sven</p>', domain, db)
			assert.equal(mentions.size, 1)
			assert.equal([...mentions][0].id.toString(), 'https://' + domain + '/ap/users/sven')
		}

		{
			const mentions = await getMentions('<p>@unknown</p>', domain, db)
			assert.equal(mentions.size, 0)
		}

		{
			const mentions = await getMentions('@sven @sven @sven @sven', domain, db)
			assert.equal(mentions.size, 1)
		}
	})
})
