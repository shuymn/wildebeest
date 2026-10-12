import { type DocumentLoader, exportSpki, verifyRequestDetailed } from '@fedify/fedify'
import { Temporal } from 'temporal-polyfill'
import { describe, expect, it } from 'vitest'

import { LEGACY, LEGACY_EMPTY_KEK, verifyCavage } from './federation-helpers'
import { createKeyring } from '../src/security/keyring'

// Signing and verification checked against Fedify's verifier and fixed vectors. Fedify reports a key it could not
// resolve as invalidSignature (fetchKey returns no key). A bare key document such as { "@context": security/v1,
// "type": "Key" } fails to parse ("Invalid type: Key"), which is why an earlier test saw a valid signature rejected.
// Every case here serves what Mastodon serves: an actor with the key embedded under publicKey.

const ACTOR = 'https://social.example/ap/users/alice'
const KEY_ID = new URL(`${ACTOR}#main-key`)

function actorLoader(pubkey: string): DocumentLoader {
	return (url) =>
		Promise.resolve({
			contextUrl: null,
			documentUrl: url,
			document: {
				'@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
				id: ACTOR,
				type: 'Person',
				inbox: `${ACTOR}/inbox`,
				publicKey: { id: KEY_ID.href, owner: ACTOR, publicKeyPem: pubkey },
			},
		})
}

describe('HTTP Signatures (draft-cavage)', () => {
	it("is accepted by Fedify's verifyRequest when signed by the keyring", async () => {
		const signer = await createKeyring(LEGACY.kek).signerFor({ ...LEGACY, keyId: KEY_ID })
		const signed = await signer.sign(new Request('https://remote.example/users/bob'))

		expect(await verifyRequestDetailed(signed, { documentLoader: actorLoader(LEGACY.pubkey) })).toMatchObject({
			verified: true,
			key: { id: KEY_ID },
		})
		expect(await verifyRequestDetailed(signed, { documentLoader: actorLoader(LEGACY_EMPTY_KEK.pubkey) })).toMatchObject(
			{ verified: false, reason: { type: 'invalidSignature' } }
		)
	})

	// Pinned: RSASSA-PKCS1-v1_5 is deterministic, so this exact Mastodon-shaped GET (keyId '#main-key',
	// algorithm="rsa-sha256", headers "(request-target) date host") signed with the legacy fixture key has one value.
	const PINNED = {
		url: 'https://remote.example/users/bob',
		date: 'Mon, 12 Oct 2026 00:00:00 GMT',
		signature: `keyId="${KEY_ID.href}",algorithm="rsa-sha256",headers="(request-target) date host",signature="SedL2nZZL9h1jqq+8v5RH915Upm3zMk+6yDEAzo9np4qKTIDI8OhFf312tdodXnOZIRmFP0jyZH9bhVH8VBSCnDL2QllfQFPIsqQjXmIagzQzmwc/9/AAPZBGtv+cgqr99qlDb4s43Xsznov0afBUjMOxsMRkNUyR5ur3GsDkIU7eKNCycL59bOWLgROn58WDqQEBWP35ROLR+Ix7PULvAtN7xUaVbp/EcKhhJ0j/bS6lj8sq+Vl1BXPVvtvIeXelF8elMbWhUCuKfzJXDr6EWO/K1G17EvlXmuuvOfTckyH8pOz+nZdneLIucgEOCx7MYZCygz2KQVQj4h0fejY35BbAc4W5nyy/pc4gSB0njDIOznKfiGybWtRY/7ICjJzXr28L64uPVFpBTclEjK0jqzH1jKcS33XNnuJGV9nyIyXLoGgvM3YIRrV7IVaL7BIsPWQxAmcjrmp0G7FlDf+i1Gn7d4m+ix+skr4lnSVwk8Lro/fsYalBLX2QB2E7sCMZUerQI3G3IZr78mQ1ZyFQB7RdYOiz+3ra7SZEpnuqMgoPf5AlsueRWT1n5Ts0ObKnwRFe/2DiwsKaMHsI1jxSkX95M8ym3fQQozpkG5M3WvTMil0W6oOTp0V4lcsJn22NR5dULOq5cHIN1dNeINcOR18EluHHumpPewTa4pLeaY="`,
	}

	it('reproduces a pinned signature, which both verifiers accept', async () => {
		const signer = await createKeyring(LEGACY.kek).signerFor({ ...LEGACY, keyId: KEY_ID })
		const signed = await signer.sign(new Request(PINNED.url, { headers: { date: PINNED.date } }))
		expect(signed.headers.get('signature')).toBe(PINNED.signature)

		const pinned = new Request(PINNED.url, {
			headers: { date: PINNED.date, host: 'remote.example', signature: PINNED.signature },
		})
		expect(await verifyCavage(pinned, LEGACY.pubkey)).toBe(true)
		expect(
			await verifyRequestDetailed(pinned, {
				documentLoader: actorLoader(LEGACY.pubkey),
				currentTime: Temporal.Instant.from('2026-10-12T00:00:00Z'),
			})
		).toMatchObject({ verified: true })
	})

	// Fedify's own test vector (src/sig/http.test.ts upstream, "verifyRequest() [draft-cavage]"), with the public
	// key of https://example.com/key from its fixtures.
	it("verifies Fedify's draft-cavage test vector with both verifiers", async () => {
		const publicKey = await crypto.subtle.importKey(
			'jwk',
			{
				kty: 'RSA',
				e: 'AQAB',
				n: 'yIB9rotX8G6r6_6toT-x24BUiQ_HaPH1Em9dOt4c94s-OPFoEdH7DY7Iym9A8LlH4JaGF8KD38bLHWe1S4x0jV3gHJKhK7veJfGZCKUENcQecBZ-YWUs5HWvUIX1vVB__0luHrg6BQKGOrSOE-WIAxyr0qsWCFfZzQrvSnUD2yvg1arJX2xhms14uxoRd5Kg9efKSCmmQaNEapicARUmFWrIEpGFa_nUUnqimssAGw1eZFqf3wA4TjhsuARBhGaJtv_3KEa016eMZxy3kDlOjZnXZTaTgWkXdodwUvy8563fes3Al6BlcS2iJ9qbtha8rSm0FHqoUKH73JsLPKQIwQ',
			},
			{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
			true,
			['verify']
		)
		const pem = await exportSpki(publicKey)
		const request = new Request('https://example.com/', {
			method: 'POST',
			body: 'Hello, world!',
			headers: {
				Accept: 'text/plain',
				'Content-Type': 'text/plain; charset=utf-8',
				Date: 'Tue, 05 Mar 2024 07:49:44 GMT',
				Digest: 'sha-256=MV9b23bQeMQ7isAGTkoBZGErH853yGk0W/yUx1iU7dM=',
				Signature:
					'keyId="https://example.com/key",headers="(request-target) accept content-type date digest host",signature="ZDeMzjBKPfJvkv4QaxAdOQxKCJ96pOzOCFhhGgGnlsw4N80oN4GEZ/n8nNKjpoW95Bcs8N0dZVSQHj3g08AReKIOXpun0tgmaWGKRcRT4kEhAW+uP1wVZPbuOIvVCEhMYv6+SbnttgX0GvN365BTZpxh7+gRrRC4mns5qV69cv45I5iJB0aw24GJW9u7lUAm6yDEh4N0aXfNqNRq3LHiuPqlDzSenfXbHr0UnAMaGuI4v9/uflu/jNi3hRX4Y/T+ngM1zvLvi/BjKK4I1rh520qnkrWpxz9ikLCjIMO7Dwh1nOsPzrZE2t43XHD3evdvm1RM5Ppes+M6DrfkfQuUBw=="',
			},
		})
		expect(await verifyCavage(request, pem)).toBe(true)
		const keyDocument: DocumentLoader = (url) =>
			Promise.resolve({
				contextUrl: null,
				documentUrl: url,
				document: {
					'@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
					id: 'https://example.com/person',
					type: 'Person',
					inbox: 'https://example.com/person/inbox',
					publicKey: { id: 'https://example.com/key', owner: 'https://example.com/person', publicKeyPem: pem },
				},
			})
		expect(
			await verifyRequestDetailed(request.clone(), {
				documentLoader: keyDocument,
				currentTime: Temporal.Instant.from('2024-03-05T07:49:44Z'),
			})
		).toMatchObject({ verified: true })
		const tampered = new Request(request, { headers: { ...Object.fromEntries(request.headers), accept: 'text/html' } })
		expect(await verifyCavage(tampered, pem)).toBe(false)
	})
})
