import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { NOW } from './app-helpers'
import {
	fixtureKeyGen,
	LEGACY,
	LEGACY_EMPTY_KEK,
	seedLocalAccount,
	setDomain,
	verifyCavage,
} from './federation-helpers'
import { BUILD, migratedStore } from './helpers'
import { createKopjeFederation, type FederationState } from '../src/federation/federation'
import { DoKvStore } from '../src/federation/kv-store'

const DOMAIN = 'social.example'
const NOTE = 'https://remote.example/notes/1'

async function setup(contentType = 'application/activity+json') {
	const store = await migratedStore()
	await setDomain(store, DOMAIN)
	await seedLocalAccount(store, DOMAIN, { id: '111111111111111111', username: 'Alice' })
	const requests: Request[] = []
	const fetch = ((input: RequestInfo | URL) => {
		const request = input instanceof Request ? input : new Request(input)
		requests.push(request)
		return Promise.resolve(Response.json({ id: NOTE, type: 'Note' }, { headers: { 'content-type': contentType } }))
	}) as typeof globalThis.fetch
	const state: FederationState = { resolvedUsername: null, source: null, storeError: null, ticket: null }
	const federation = createKopjeFederation(
		{
			domain: DOMAIN,
			build: BUILD,
			store: () => store,
			kek: LEGACY.kek,
			now: () => NOW,
			keygen: fixtureKeyGen,
			loader: { fetch, checkHost: () => Promise.resolve() },
		},
		state
	)
	const ctx = federation.createContext(new URL(`https://${DOMAIN}`), state)
	return { store, requests, ctx }
}

describe('signed fetches', () => {
	it('signs fetches without a specific recipient as the instance actor', async () => {
		const { requests, ctx } = await setup()
		await ctx.documentLoader(NOTE)

		const signature = requests[0]?.headers.get('signature') ?? ''
		expect(signature).toContain('keyId="https://social.example/actor#main-key"')
		expect(await verifyCavage(requests[0] as Request, LEGACY_EMPTY_KEK.pubkey)).toBe(true)
	})

	it("signs a recipient's fetches with the recipient's key", async () => {
		const { requests, ctx } = await setup()
		const loader = await ctx.getDocumentLoader({ identifier: 'Alice' })
		await loader(NOTE)

		expect(requests[0]?.headers.get('signature')).toContain('keyId="https://social.example/ap/users/Alice#main-key"')
		expect(await verifyCavage(requests[0] as Request, LEGACY.pubkey)).toBe(true)
	})

	it('caches signed documents per signing key, apart from each other and from unsigned ones', async () => {
		const { store, requests, ctx } = await setup()
		const alice = await ctx.getDocumentLoader({ identifier: 'Alice' })
		await alice(NOTE)
		await alice(NOTE)
		expect(requests).toHaveLength(1)
		await ctx.documentLoader(NOTE)
		expect(requests).toHaveLength(2)

		const keys = await runInDurableObject(store, (_instance, state) =>
			state.storage.sql
				.exec<{ key: string }>('SELECT key FROM fedify_kv WHERE key LIKE \'["_fedify","signedRemoteDocument"%\'')
				.toArray()
				.map((row) => JSON.parse(row.key) as string[])
		)
		expect(keys).toEqual(
			expect.arrayContaining([
				['_fedify', 'signedRemoteDocument', 'v2', 'https://social.example/actor#main-key', NOTE],
				['_fedify', 'signedRemoteDocument', 'v2', 'https://social.example/ap/users/Alice#main-key', NOTE],
			])
		)
	})

	it('has key pairs for local actors and the instance actor only', async () => {
		const { ctx } = await setup()
		expect((await ctx.getActorKeyPairs('Alice')).map((pair) => pair.keyId.href)).toEqual([
			'https://social.example/ap/users/Alice#main-key',
		])
		expect((await ctx.getActorKeyPairs('kopje:instance')).map((pair) => pair.keyId.href)).toEqual([
			'https://social.example/actor#main-key',
		])
		expect(await ctx.getActorKeyPairs('nobody')).toEqual([])
	})

	it('has no key pairs for a spelling other than the stored username', async () => {
		const { ctx } = await setup()
		expect(await ctx.getActorKeyPairs('alice')).toEqual([])
		expect(await ctx.getActorKeyPairs('ALICE')).toEqual([])
	})

	// Plain JSON-LD is a context, never an object (GHSA-jhrq-qvrm-qr36): only the context loader takes it.
	it('takes plain JSON-LD on the context loader only', async () => {
		const { ctx } = await setup('application/ld+json')
		await expect(ctx.documentLoader(NOTE)).rejects.toThrow(/Not an ActivityPub document/)
		const alice = await ctx.getDocumentLoader({ identifier: 'Alice' })
		await expect(alice(NOTE)).rejects.toThrow(/Not an ActivityPub document/)
		expect((await ctx.contextLoader(NOTE)).document).toMatchObject({ id: NOTE })
	})

	// A cache entry admitted under an older, looser acceptance policy is never served after the policy is tightened.
	it('ignores signed documents cached under the unversioned namespace', async () => {
		const { store, requests, ctx } = await setup()
		const stale = { contextUrl: null, documentUrl: NOTE, document: { id: NOTE, type: 'Note', content: 'stale' } }
		const kv = new DoKvStore(
			() => store,
			BUILD,
			() => NOW
		)
		await kv.set(['_fedify', 'signedRemoteDocument', 'https://social.example/actor#main-key', NOTE], stale)

		expect((await ctx.documentLoader(NOTE)).document).toEqual({ id: NOTE, type: 'Note' })
		expect(requests).toHaveLength(1)
	})
})
