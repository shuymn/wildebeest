import { fetchKeyDetailed, verifyRequestDetailed } from '@fedify/fedify'
import { CryptographicKey } from '@fedify/vocab'
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
		// The pair differs only in the identity the document claims through the alias. The embedded key id equals the
		// signing keyId and the owner stays the attacker in both, so only Fedify's origin checks on parsed ids tell them
		// apart: fetchKey's check of the actor id against the document URL, and vocab's check of the embedded key id
		// against the actor id. Either one alone rejects the victim claim; with both removed, it verifies.
		const keyId = `${ATTACKER}#main-key`
		const claiming = (id: string) =>
			aliased({ aliasId: id, publicKey: { id: keyId, owner: ATTACKER, publicKeyPem: LEGACY.pubkey } })
		const signer = await createKeyring(LEGACY.kek).signerFor({ ...LEGACY, keyId: new URL(keyId) })
		const signed = () => signer.sign(new Request('https://social.example/inbox'))

		const honest = await context(servingAliased(claiming(ATTACKER)))
		expect(await verifyRequestDetailed(await signed(), { documentLoader: honest.documentLoader })).toMatchObject({
			verified: true,
		})

		const victim = await context(servingAliased(claiming(VICTIM)))
		expect(await verifyRequestDetailed(await signed(), { documentLoader: victim.documentLoader })).toEqual({
			verified: false,
			reason: { type: 'invalidSignature', keyId: new URL(keyId) },
		})
		// Not a fetch failure: the document loads, and Fedify refuses the key it names.
		const fetched = await fetchKeyDetailed(new URL(keyId), CryptographicKey, { documentLoader: victim.documentLoader })
		expect(fetched).toEqual({ key: null, cached: false })
	})
})
