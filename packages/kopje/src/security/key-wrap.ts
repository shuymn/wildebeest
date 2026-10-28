// Private key wrapping, byte-compatible with legacy Wildebeest's key operations, so the cutover moves wrapped keys as
// bytes without re-wrapping:
//   wrapping key : PBKDF2 (SHA-256, 10000 iterations) of the UTF-8 KEK with a 16-byte random salt -> AES-256-GCM
//   privkey      : AES-GCM of the PKCS#8 DER, IV = the same 16-byte salt, no additional data, 128-bit tag appended
//   pubkey       : SPKI DER as a single base64 line between "-----BEGIN PUBLIC KEY-----" and the END line
// Keys are RSASSA-PKCS1-v1_5 with SHA-256 and a 4096-bit modulus.

export type WrappedKey = { privkey: Uint8Array; salt: Uint8Array }

export const RSA_ALGORITHM = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const

const PBKDF2_ITERATIONS = 10000
const SALT_BYTES = 16
const PEM_HEADER = '-----BEGIN PUBLIC KEY-----'
const PEM_FOOTER = '-----END PUBLIC KEY-----'

// Produces the key pair of a new actor. Tests inject a pre-generated pair; 4096-bit generation is slow.
export type KeyGen = () => Promise<CryptoKeyPair>

export const generateRsaKeyPair: KeyGen = async () =>
	(await crypto.subtle.generateKey(
		{ ...RSA_ALGORITHM, modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]) },
		true,
		['sign', 'verify']
	)) as CryptoKeyPair

async function wrappingKey(kek: string, salt: Uint8Array): Promise<CryptoKey> {
	const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(kek), 'PBKDF2', false, ['deriveKey'])
	return crypto.subtle.deriveKey(
		{ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
		material,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	)
}

export async function wrapPkcs8(kek: string, pkcs8: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
	const key = await wrappingKey(kek, salt)
	return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: salt }, key, pkcs8))
}

// Throws when the KEK is wrong or the bytes were altered (the GCM tag does not verify).
export async function unwrapPkcs8(kek: string, { privkey, salt }: WrappedKey): Promise<Uint8Array> {
	const key = await wrappingKey(kek, salt)
	return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: salt }, key, privkey))
}

// Whether one KEK unwraps what the other wraps. They need not be equal strings: PBKDF2's HMAC pads a short KEK with
// zero bytes, so '' and '\0', or a KEK and the same KEK with a NUL appended, wrap alike.
export async function wrapsAlike(a: string, b: string): Promise<boolean> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
	const privkey = await wrapPkcs8(a, new Uint8Array(1), salt)
	try {
		await unwrapPkcs8(b, { privkey, salt })
		return true
	} catch {
		return false
	}
}

// The same private key wrapped under another KEK, with a fresh salt (the KEK rewrap, app/key-rewrap.ts). Throws as
// unwrapPkcs8 does when `from` does not unwrap it.
export async function rewrapPkcs8(from: string, to: string, key: WrappedKey): Promise<WrappedKey> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
	return { privkey: await wrapPkcs8(to, await unwrapPkcs8(from, key), salt), salt }
}

// Extractable because Fedify refuses non-extractable keys; the key lives only as long as the request using it.
export function importPrivateKey(pkcs8: Uint8Array): Promise<CryptoKey> {
	return crypto.subtle.importKey('pkcs8', pkcs8, RSA_ALGORITHM, true, ['sign'])
}

export function importPublicKeyPem(pem: string): Promise<CryptoKey> {
	const body = pem.trim().slice(PEM_HEADER.length, -PEM_FOOTER.length).replace(/\s+/g, '')
	return crypto.subtle.importKey('spki', base64ToBytes(body), RSA_ALGORITHM, true, ['verify'])
}

export async function exportPublicKeyPem(publicKey: CryptoKey): Promise<string> {
	const spki = new Uint8Array((await crypto.subtle.exportKey('spki', publicKey)) as ArrayBuffer)
	return `${PEM_HEADER}\n${bytesToBase64(spki)}\n${PEM_FOOTER}`
}

// A new key pair, wrapped with the KEK in the legacy format.
export async function generateWrappedKey(
	kek: string,
	keygen: KeyGen = generateRsaKeyPair
): Promise<WrappedKey & { pubkey: string }> {
	const pair = await keygen()
	const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer)
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
	return { privkey: await wrapPkcs8(kek, pkcs8, salt), salt, pubkey: await exportPublicKeyPem(pair.publicKey) }
}

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = ''
	for (const byte of bytes) {
		binary += String.fromCharCode(byte)
	}
	return btoa(binary)
}

export function base64ToBytes(base64: string): Uint8Array {
	return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
}
