import { isActorType } from '@wildebeest/backend/activitypub/actors'
import { UA } from '@wildebeest/backend/config/ua'
import { ParsedSignature } from '@wildebeest/backend/utils/httpsigjs/parser'
import { str2ab, importPublicKey } from '@wildebeest/backend/utils/key-ops'

type PublicKey = {
	id?: string
	owner?: string
	publicKeyPem?: string
}

// Either an actor document embedding its key, or a standalone key document
// (GoToSocial style) pointing back at its `owner`.
type KeyDocument = {
	id?: string
	type?: string
	owner?: string
	publicKey?: PublicKey
	publicKeyPem?: string
}

// The actor the signature key provably belongs to, with that actor's key.
export type SignatureKeyOwner = {
	ownerId: URL
	key: CryptoKey
}

export async function verifySignature(parsedSignature: ParsedSignature, key: CryptoKey): Promise<boolean> {
	return crypto.subtle.verify(
		'RSASSA-PKCS1-v1_5',
		key,
		str2ab(atob(parsedSignature.signature)),
		str2ab(parsedSignature.signingString)
	)
}

async function fetchDocument(url: string): Promise<KeyDocument | null> {
	const res = await fetch(url, {
		headers: {
			Accept: 'application/activity+json',
			'User-Agent': UA,
		},
	})
	if (!res.ok) {
		if (res.status !== 410) {
			console.warn(`failed to fetch keys from "${url}", returned ${res.status}.`)
		}
		return null
	}
	return await res.json<KeyDocument>()
}

function parseUrl(value: string | undefined): URL | null {
	if (!value) {
		return null
	}
	try {
		return new URL(value)
	} catch {
		return null
	}
}

// Resolve `keyId` to the actor that owns it and return that actor's key.
//
// The owner is only trusted when it is served from the same origin as the
// `keyId` and when the owner actor itself claims `keyId` as its `publicKey.id`:
// otherwise any server could claim to hold the key of any actor.
export async function fetchKeyOwner(parsedSignature: ParsedSignature): Promise<SignatureKeyOwner | null> {
	const keyId = parsedSignature.keyId
	const keyIdUrl = parseUrl(keyId)
	if (keyIdUrl === null) {
		console.warn('invalid keyId in signature')
		return null
	}

	const document = await fetchDocument(keyId)
	if (document === null) {
		return null
	}

	// Mastodon/Misskey/Pleroma: `keyId` is a fragment of the actor document.
	if (document.type !== undefined && isActorType(document.type)) {
		return keyOwnerFromActor(document, keyId, keyIdUrl)
	}

	// GoToSocial: `keyId` is a standalone key document referencing its owner.
	const ownerUrl = parseUrl(document.owner ?? document.publicKey?.owner)
	if (ownerUrl === null) {
		console.warn(`document at "${keyId}" is neither an actor nor a key with an owner`)
		return null
	}
	if (ownerUrl.hostname !== keyIdUrl.hostname) {
		console.warn(`key "${keyId}" claims an owner on another host`)
		return null
	}

	const owner = await fetchDocument(ownerUrl.toString())
	if (owner === null) {
		return null
	}
	if (owner.type === undefined || !isActorType(owner.type)) {
		console.warn(`owner "${ownerUrl.toString()}" of key "${keyId}" is not an actor`)
		return null
	}
	return keyOwnerFromActor(owner, keyId, keyIdUrl)
}

async function keyOwnerFromActor(actor: KeyDocument, keyId: string, keyIdUrl: URL): Promise<SignatureKeyOwner | null> {
	const ownerId = parseUrl(actor.id)
	if (ownerId === null) {
		console.warn(`actor owning key "${keyId}" has no id`)
		return null
	}
	if (ownerId.hostname !== keyIdUrl.hostname) {
		console.warn(`key "${keyId}" is not served by the host of its owner`)
		return null
	}
	if (actor.publicKey?.id !== keyId) {
		console.warn(`actor ${ownerId.toString()} does not list key "${keyId}"`)
		return null
	}
	if (!actor.publicKey.publicKeyPem) {
		console.warn(`actor ${ownerId.toString()} has no key material`)
		return null
	}
	return { ownerId, key: await importPublicKey(actor.publicKey.publicKeyPem) }
}
