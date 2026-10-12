import { describe, expect, it } from 'vitest'

import { fixtureKeyGen, LEGACY, LEGACY_EMPTY_KEK, verifyCavage } from './federation-helpers'
import {
	bytesToBase64,
	exportPublicKeyPem,
	generateWrappedKey,
	importPublicKeyPem,
	unwrapPkcs8,
	wrapPkcs8,
} from '../src/security/key-wrap'
import { checkKey, createKeyring } from '../src/security/keyring'

const KEY_ID = new URL('https://social.example/ap/users/alice#main-key')

describe('legacy key wrapping compatibility', () => {
	it('unwraps a key wrapped by the legacy code to the same PKCS#8 bytes', async () => {
		expect(bytesToBase64(await unwrapPkcs8(LEGACY.kek, LEGACY))).toBe(bytesToBase64(LEGACY.pkcs8))
		expect(bytesToBase64(await unwrapPkcs8('', LEGACY_EMPTY_KEK))).toBe(bytesToBase64(LEGACY_EMPTY_KEK.pkcs8))
	})

	it('wraps to exactly the bytes the legacy code produced for the same key, KEK and salt', async () => {
		expect(bytesToBase64(await wrapPkcs8(LEGACY.kek, LEGACY.pkcs8, LEGACY.salt))).toBe(bytesToBase64(LEGACY.privkey))
		expect(bytesToBase64(await wrapPkcs8('', LEGACY_EMPTY_KEK.pkcs8, LEGACY_EMPTY_KEK.salt))).toBe(
			bytesToBase64(LEGACY_EMPTY_KEK.privkey)
		)
	})

	it('writes the public key in the legacy PEM layout', async () => {
		expect(await exportPublicKeyPem(await importPublicKeyPem(LEGACY.pubkey))).toBe(LEGACY.pubkey)
		expect(LEGACY.pubkey).toMatch(/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=]+\n-----END PUBLIC KEY-----$/)
	})

	it('refuses a wrong KEK and altered bytes', async () => {
		await expect(unwrapPkcs8('wrong', LEGACY)).rejects.toThrow()
		await expect(unwrapPkcs8('', LEGACY)).rejects.toThrow()
		const altered = LEGACY.privkey.slice()
		altered[10] = (altered[10] ?? 0) ^ 1
		await expect(unwrapPkcs8(LEGACY.kek, { privkey: altered, salt: LEGACY.salt })).rejects.toThrow()
	})

	it('generates wrapped keys in the same format, with a fresh 16-byte salt', async () => {
		const generated = await generateWrappedKey('kek', fixtureKeyGen)
		expect(generated.salt).toHaveLength(16)
		expect(generated.pubkey).toBe(LEGACY_EMPTY_KEK.pubkey)
		expect(bytesToBase64(await unwrapPkcs8('kek', generated))).toBe(bytesToBase64(LEGACY_EMPTY_KEK.pkcs8))
		expect(bytesToBase64(await wrapPkcs8('kek', LEGACY_EMPTY_KEK.pkcs8, generated.salt))).toBe(
			bytesToBase64(generated.privkey)
		)
	})
})

describe('keyring', () => {
	it('returns a signer that signs requests verifiable with the stored public key', async () => {
		const signer = await createKeyring(LEGACY.kek).signerFor({ ...LEGACY, keyId: KEY_ID })
		expect(signer.keyId).toBe(KEY_ID)

		const signed = await signer.sign(new Request('https://remote.example/users/bob', { method: 'GET' }))
		expect(signed.headers.get('signature')).toContain(`keyId="${KEY_ID.href}"`)
		expect(await verifyCavage(signed, LEGACY.pubkey)).toBe(true)
		expect(await verifyCavage(signed, LEGACY_EMPTY_KEK.pubkey)).toBe(false)
	})

	it('fails to produce a signer with the wrong KEK', async () => {
		await expect(createKeyring('wrong').signerFor({ ...LEGACY, keyId: KEY_ID })).rejects.toThrow()
	})
})

describe('key check', () => {
	it('passes a key that unwraps and matches its stored public key', async () => {
		expect(await checkKey(LEGACY.kek, LEGACY)).toBe('ok')
		expect(await checkKey('', LEGACY_EMPTY_KEK)).toBe('ok')
	})

	it('reports a key the KEK cannot unwrap', async () => {
		expect(await checkKey('wrong', LEGACY)).toBe('unwrap-failed')
	})

	it('reports a private key that does not match the stored public key', async () => {
		expect(await checkKey(LEGACY.kek, { ...LEGACY, pubkey: LEGACY_EMPTY_KEK.pubkey })).toBe('pubkey-mismatch')
		expect(await checkKey(LEGACY.kek, { ...LEGACY, pubkey: 'not a pem' })).toBe('pubkey-mismatch')
	})
})
