import { ParsedSignature } from 'wildebeest/backend/src/utils/httpsigjs/parser'
import { str2ab, importPublicKey } from 'wildebeest/backend/src/utils/key-ops'
import { UA } from 'wildebeest/config/ua'

interface Profile {
	publicKey: {
		id: string
		owner: string
		publicKeyPem: string
	}
}

export async function verifySignature(parsedSignature: ParsedSignature, key: CryptoKey): Promise<boolean> {
	return crypto.subtle.verify(
		'RSASSA-PKCS1-v1_5',
		key,
		str2ab(atob(parsedSignature.signature)),
		str2ab(parsedSignature.signingString)
	)
}

export async function fetchKey(parsedSignature: ParsedSignature): Promise<CryptoKey | null> {
	const url = parsedSignature.keyId
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

	const parsedResponse = await res.json<Profile>()
	return importPublicKey(parsedResponse.publicKey.publicKeyPem)
}
