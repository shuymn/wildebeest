import { verifyRequestDetailed } from '@fedify/fedify'
import { describe, expect, it } from 'vitest'

import { NOW } from './app-helpers'
import { fixtureKeyGen, LEGACY, seedLocalAccount, setDomain } from './federation-helpers'
import { BUILD, migratedStore } from './helpers'
import { createKopjeFederation, type FederationState } from '../src/federation/federation'
import { createSafeLoader } from '../src/federation/loader'
import { createKeyring } from '../src/security/keyring'

// A document served by remote.example that names a victim on another origin as its id through a JSON-LD alias
// ("aliasId" mapped to "@id"), which the loader's literal id/@id pre-filter cannot see. The identity that counts is
// the parsed object's id, and Fedify's consumers compare it with the final response origin.
const ATTACKER = 'https://remote.example/users/mallory'
const VICTIM = 'https://victim.example/users/bob'
const AP = { 'content-type': 'application/activity+json' }

function aliased(extra: Record<string, unknown> = {}) {
	return {
		'@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1', { aliasId: '@id' }],
		aliasId: VICTIM,
		type: 'Person',
		preferredUsername: 'bob',
		inbox: `${VICTIM}/inbox`,
		...extra,
	}
}

function servingAliased(document: unknown): typeof globalThis.fetch {
	return ((input: RequestInfo | URL) => {
		const request = input instanceof Request ? input : new Request(input)
		return Promise.resolve(Response.json(request.url.startsWith(ATTACKER) ? document : {}, { headers: AP }))
	}) as typeof globalThis.fetch
}

async function context(fetch: typeof globalThis.fetch) {
	const store = await migratedStore()
	await setDomain(store, 'social.example')
	await seedLocalAccount(store, 'social.example', { id: '111111111111111111', username: 'Alice' })
	const state: FederationState = { resolvedUsername: null, storeError: null, source: null }
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
	return federation.createContext(new URL('https://social.example'), state)
}

describe('remote identity behind a JSON-LD alias', () => {
	it('passes the literal pre-filter of the loader (the gap Fedify closes)', async () => {
		const loader = createSafeLoader({
			fetch: servingAliased(aliased()),
			checkHost: () => Promise.resolve(),
			userAgent: 'Kopje/test',
		})
		expect((await loader(ATTACKER)).documentUrl).toBe(ATTACKER)
	})

	it('is not returned as the victim by lookupObject', async () => {
		const ctx = await context(servingAliased(aliased()))
		expect(await ctx.lookupObject(ATTACKER)).toBeNull()

		// Control: the same document naming its own URL is returned.
		const honest = await context(servingAliased(aliased({ aliasId: ATTACKER })))
		expect((await honest.lookupObject(ATTACKER))?.id?.href).toBe(ATTACKER)
	})

	it('cannot lend its key to the victim in signature verification', async () => {
		const keyId = `${ATTACKER}#main-key`
		const document = aliased({ publicKey: { id: `${VICTIM}#main-key`, owner: VICTIM, publicKeyPem: LEGACY.pubkey } })
		const ctx = await context(servingAliased(document))
		const signer = await createKeyring(LEGACY.kek).signerFor({ ...LEGACY, keyId: new URL(keyId) })
		const signed = await signer.sign(new Request('https://social.example/inbox'))

		const result = await verifyRequestDetailed(signed, { documentLoader: ctx.documentLoader })
		expect(result.verified).toBe(false)

		// Control: the same key under the attacker's own id verifies.
		const own = aliased({ aliasId: ATTACKER, publicKey: { id: keyId, owner: ATTACKER, publicKeyPem: LEGACY.pubkey } })
		const honest = await context(servingAliased(own))
		expect(await verifyRequestDetailed(signed, { documentLoader: honest.documentLoader })).toMatchObject({
			verified: true,
		})
	})
})
