import { signRequest } from '@fedify/fedify'

import { importPrivateKey, importPublicKeyPem, RSA_ALGORITHM, unwrapPkcs8, type WrappedKey } from './key-wrap'

// An actor whose private key this instance holds: a local user or the instance actor. The wrapped key and the
// authoritative public key come from the Store as stored.
export type KeyOwner = WrappedKey & { keyId: URL; pubkey: string }

// Signs an outgoing request as one actor (draft-cavage HTTP Signatures, RSA-SHA256). keyPair is there only because
// Fedify's key pairs dispatcher and authenticated document loader take a CryptoKeyPair; nothing else reads it.
export type Signer = {
	readonly keyId: URL
	readonly keyPair: CryptoKeyPair
	readonly sign: (request: Request) => Promise<Request>
}

// The keyring: given an actor, a signer for it. Private keys are unwrapped per call and never cached (a
// memoized extractable key would stay in memory for the isolate's lifetime, for no measured gain).
export type Keyring = { signerFor(actor: KeyOwner): Promise<Signer> }

// The KEK is the USER_KEK secret. An empty string is a legal KEK (legacy instances used it); healthReport warns.
export function createKeyring(kek: string): Keyring {
	return {
		async signerFor(actor) {
			const privateKey = await importPrivateKey(await unwrapPkcs8(kek, actor))
			const publicKey = await importPublicKeyPem(actor.pubkey)
			return {
				keyId: actor.keyId,
				keyPair: { privateKey, publicKey },
				sign: requestSigner(actor.keyId, privateKey),
			}
		},
	}
}

// Signing as a key Fedify hands back (its authenticated document loader receives the pair from signerFor).
export function requestSigner(keyId: URL, privateKey: CryptoKey): (request: Request) => Promise<Request> {
	return (request) => signRequest(request, privateKey, keyId, { spec: 'draft-cavage-http-signatures-12' })
}

export type KeyCheck = 'ok' | 'unwrap-failed' | 'pubkey-mismatch'

const PROBE = new TextEncoder().encode('kopje key check')

// Whether the actor's key unwraps with this KEK and a signature made with it verifies against the stored public key.
export async function checkKey(kek: string, actor: WrappedKey & { pubkey: string }): Promise<KeyCheck> {
	let signature: ArrayBuffer
	try {
		const privateKey = await importPrivateKey(await unwrapPkcs8(kek, actor))
		signature = await crypto.subtle.sign(RSA_ALGORITHM, privateKey, PROBE)
	} catch {
		return 'unwrap-failed'
	}
	try {
		const publicKey = await importPublicKeyPem(actor.pubkey)
		return (await crypto.subtle.verify(RSA_ALGORITHM, publicKey, signature, PROBE)) ? 'ok' : 'pubkey-mismatch'
	} catch {
		return 'pubkey-mismatch'
	}
}
