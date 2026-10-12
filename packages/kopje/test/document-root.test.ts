import { fetchKeyDetailed } from '@fedify/fedify'
import { CryptographicKey, Note, Person } from '@fedify/vocab'
import { describe, expect, it } from 'vitest'

import { NOW } from './app-helpers'
import { fixtureKeyGen, LEGACY, seedLocalAccount, setDomain } from './federation-helpers'
import { BUILD, migratedStore } from './helpers'
import { createKopjeFederation, type FederationState } from '../src/federation/federation'

// ID-8: an ActivityPub-typed response whose body is a JSON string is a document URL to JSON-LD, which expansion would
// fetch through the context loader. That loader takes plain JSON, so an uploaded file could become an actor or key.
const ACTOR = 'https://remote.example/users/bob'
const KEY_ID = `${ACTOR}#main-key`
const UPLOAD = 'https://remote.example/media/upload.json'
const AP = { 'content-type': 'application/activity+json' }
const PLAIN = { 'content-type': 'application/json' }

const uploadedActor = {
	'@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
	id: ACTOR,
	type: 'Person',
	inbox: `${ACTOR}/inbox`,
	publicKey: { id: KEY_ID, owner: ACTOR, publicKeyPem: LEGACY.pubkey },
}

type Routes = Record<string, () => Response>

async function context(routes: Routes) {
	const store = await migratedStore()
	await setDomain(store, 'social.example')
	await seedLocalAccount(store, 'social.example', { id: '111111111111111111', username: 'Alice' })
	const requests: string[] = []
	const fetch = ((input: RequestInfo | URL) => {
		const request = input instanceof Request ? input : new Request(input)
		requests.push(request.url)
		const route = routes[request.url.replace(/#.*$/, '')]
		return Promise.resolve(route === undefined ? new Response('missing', { status: 404 }) : route())
	}) as typeof globalThis.fetch
	const state: FederationState = { resolvedUsername: null, source: null, storeError: null }
	const federation = createKopjeFederation(
		{
			domain: 'social.example',
			build: BUILD,
			store: () => store,
			kek: LEGACY.kek,
			now: () => NOW,
			keygen: fixtureKeyGen,
			loader: { fetch, checkHost: () => Promise.resolve() },
		},
		state
	)
	return { ctx: federation.createContext(new URL('https://social.example'), state), requests }
}

const indirection: Routes = {
	[ACTOR]: () => Response.json(UPLOAD, { headers: AP }),
	[UPLOAD]: () => Response.json(uploadedActor, { headers: PLAIN }),
}

describe('document roots', () => {
	it('does not turn a JSON-string document into an object through lookupObject', async () => {
		const { ctx, requests } = await context(indirection)
		expect(await ctx.lookupObject(ACTOR)).toBeNull()
		expect(requests).not.toContain(UPLOAD)

		// Control: the same actor served as an ActivityPub document is found.
		const honest = await context({ [ACTOR]: () => Response.json(uploadedActor, { headers: AP }) })
		expect(await honest.ctx.lookupObject(ACTOR)).toBeInstanceOf(Person)
	})

	it('does not lend a key through a JSON-string document', async () => {
		const { ctx, requests } = await context(indirection)
		const options = { documentLoader: ctx.documentLoader, contextLoader: ctx.contextLoader }
		expect(await fetchKeyDetailed(new URL(KEY_ID), CryptographicKey, options)).toMatchObject({ key: null })
		expect(requests).not.toContain(UPLOAD)

		const honest = await context({ [ACTOR]: () => Response.json(uploadedActor, { headers: AP }) })
		const found = await fetchKeyDetailed(new URL(KEY_ID), CryptographicKey, {
			documentLoader: honest.ctx.documentLoader,
			contextLoader: honest.ctx.contextLoader,
		})
		expect(found.key?.id?.href).toBe(KEY_ID)
	})

	it.each([
		['an array', [uploadedActor]],
		['a number', 1],
		['null', null],
	])('refuses a document whose root is %s', async (_label, body) => {
		const { ctx } = await context({ [ACTOR]: () => Response.json(body, { headers: AP }) })
		await expect(ctx.documentLoader(ACTOR)).rejects.toThrow(/not a JSON object/)
	})

	it('still loads an object whose remote @context is served as plain JSON', async () => {
		const contextUrl = 'https://remote.example/contexts/extra.json'
		const note = 'https://remote.example/notes/1'
		const { ctx, requests } = await context({
			[note]: () =>
				Response.json(
					{
						'@context': ['https://www.w3.org/ns/activitystreams', contextUrl],
						id: note,
						type: 'Note',
						content: 'hi',
						extra: 'x',
					},
					{ headers: AP }
				),
			[contextUrl]: () =>
				Response.json({ '@context': { extra: 'https://remote.example/ns#extra' } }, { headers: PLAIN }),
		})
		const found = await ctx.lookupObject(note)
		expect(found).toBeInstanceOf(Note)
		expect(found?.id?.href).toBe(note)
		expect(requests).toContain(contextUrl)
	})
})
