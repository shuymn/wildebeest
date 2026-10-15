import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

import { beforeEach, describe, expect, it } from 'vitest'

import { type AccessTeam, adminHarness, adminTeam, serviceClaims, setTeamAccess } from './access-helpers'
import { LEGACY, LEGACY_EMPTY_KEK, seedLocalAccount } from './federation-helpers'
import { BUILD, migratedStore } from './helpers'
import { ACCESS, memoryIO, setAccess } from './ops-helpers'
import { run } from '../cli/lib/main.js'
import { healthReport } from '../src/app/health'
import { rewrapKeys } from '../src/app/key-rewrap'
import { KEY_PAGE, type StoredKey } from '../src/domain/actors'
import { readConfig } from '../src/platform/config'
import type { StoreStub } from '../src/platform/store-client'
import {
	base64ToBytes,
	bytesToBase64,
	importPrivateKey,
	importPublicKeyPem,
	RSA_ALGORITHM,
	unwrapPkcs8,
} from '../src/security/key-wrap'
import { checkKey } from '../src/security/keyring'

// kopje-admin keys rewrap (app/key-rewrap.ts): the local keys move from USER_KEK_PREVIOUS to USER_KEK, the same key
// pairs under a new wrapping (DATA-14), checked before they are written and written only over what was read.

const DOMAIN = 'kopje.test'
const NEW_KEK = 'a new KEK, long and random enough for a test'

let team: AccessTeam

beforeEach(async () => {
	team = await adminTeam()
})

function accountId(n: number): string {
	return String(111_111_111_111_111_100n + BigInt(n))
}

async function seedUsers(store: StoreStub, count: number, key = LEGACY_EMPTY_KEK): Promise<void> {
	for (let n = 1; n <= count; n++) {
		await seedLocalAccount(store, DOMAIN, { id: accountId(n), username: `user${n}`, key })
	}
}

async function seedInstanceKey(store: StoreStub, key = LEGACY_EMPTY_KEK): Promise<void> {
	await runInDurableObject(store, (_instance, state) => {
		state.storage.sql.exec(
			"INSERT INTO instance_settings (name, value) VALUES ('instance_actor_key', ?)",
			JSON.stringify({ privkey: bytesToBase64(key.privkey), salt: bytesToBase64(key.salt), pubkey: key.pubkey })
		)
	})
}

// The stored keys by owner (null: the instance actor), read straight from the tables.
async function storedKeys(store: StoreStub): Promise<Map<string | null, StoredKey>> {
	return runInDurableObject(store, (_instance, state) => {
		const keys = new Map<string | null, StoredKey>()
		const rows = state.storage.sql
			.exec<{ username: string; privkey: ArrayBuffer; privkey_salt: ArrayBuffer; pubkey: string }>(
				'SELECT a.username, l.privkey, l.privkey_salt, l.pubkey FROM local_accounts l JOIN accounts a ON a.id = l.account_id'
			)
			.toArray()
		for (const row of rows) {
			keys.set(row.username, {
				privkey: new Uint8Array(row.privkey),
				salt: new Uint8Array(row.privkey_salt),
				pubkey: row.pubkey,
			})
		}
		const instance = state.storage.sql
			.exec<{ value: string }>("SELECT value FROM instance_settings WHERE name = 'instance_actor_key'")
			.toArray()[0]
		if (instance !== undefined) {
			const key = JSON.parse(instance.value) as { privkey: string; salt: string; pubkey: string }
			keys.set(null, { privkey: base64ToBytes(key.privkey), salt: base64ToBytes(key.salt), pubkey: key.pubkey })
		}
		return keys
	})
}

async function setup(overrides: Record<string, unknown> = { USER_KEK: NEW_KEK }) {
	const store = await migratedStore()
	await setTeamAccess(store, team)
	return { ...adminHarness(store, team, overrides), store }
}

type Step = {
	counts: { rewrapped: number; current: number; failed: number }
	failures: { owner: string; reason: string }[]
	done: boolean
	next: string | null
}

const PROBE = new TextEncoder().encode('signed before the rewrap')

describe('the Store side of the rewrap', () => {
	it('reads the keys in bounded pages, the instance actor last', async () => {
		const store = await migratedStore()
		await seedUsers(store, KEY_PAGE + 2)
		await seedInstanceKey(store)
		const first = await store.rewrapKeys(BUILD, { after: null })
		expect(first.keys.map((k) => k.owner)).toEqual(Array.from({ length: KEY_PAGE }, (_, i) => `user${i + 1}`))
		expect(first).toMatchObject({ done: false, next: accountId(KEY_PAGE) })
		const second = await store.rewrapKeys(BUILD, { after: first.next })
		expect(second.keys.map((k) => [k.account, k.owner])).toEqual([
			[accountId(KEY_PAGE + 1), `user${KEY_PAGE + 1}`],
			[accountId(KEY_PAGE + 2), `user${KEY_PAGE + 2}`],
			[null, null],
		])
		expect(second).toMatchObject({ done: true, next: accountId(KEY_PAGE + 2) })
	})

	it('writes a key only over the bytes that were read, and only for the Access admin', async () => {
		const store = await migratedStore()
		await setAccess(store)
		await seedUsers(store, 1)
		await seedInstanceKey(store)
		const read = { ...LEGACY_EMPTY_KEK }
		const stale = { privkey: LEGACY.privkey, salt: LEGACY.salt, pubkey: LEGACY_EMPTY_KEK.pubkey }
		const wrapped = { privkey: new Uint8Array([1, 2, 3]), salt: new Uint8Array(16).fill(7) }
		for (const account of [accountId(1), null]) {
			expect(await store.rewrapKey(BUILD, { authority: ACCESS, account, read: stale, wrapped })).toEqual({
				status: 'changed',
			})
			expect(
				await store.rewrapKey(BUILD, { authority: { kind: 'import-token' }, account, read, wrapped })
			).toMatchObject({ status: 'denied' })
		}
		const before = await storedKeys(store)
		expect(before.get('user1')?.privkey).toEqual(LEGACY_EMPTY_KEK.privkey)
		expect(before.get(null)?.privkey).toEqual(LEGACY_EMPTY_KEK.privkey)
		for (const account of [accountId(1), null]) {
			expect(await store.rewrapKey(BUILD, { authority: ACCESS, account, read, wrapped })).toEqual({ status: 'written' })
			// What was read is gone now: the same write again is refused.
			expect(await store.rewrapKey(BUILD, { authority: ACCESS, account, read, wrapped })).toEqual({ status: 'changed' })
		}
		const after = await storedKeys(store)
		for (const owner of ['user1', null]) {
			expect(after.get(owner)).toEqual({ ...wrapped, pubkey: LEGACY_EMPTY_KEK.pubkey })
		}
	})
})

describe('kopje-admin keys rewrap', () => {
	it('moves every key from the empty KEK to USER_KEK, keeping the key pairs', async () => {
		const h = await setup()
		await seedUsers(h.store, 2)
		await seedInstanceKey(h.store)
		const signature = await crypto.subtle.sign(RSA_ALGORITHM, await importPrivateKey(LEGACY_EMPTY_KEK.pkcs8), PROBE)
		const response = await h.post(serviceClaims(), '/admin/keys/rewrap')
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			counts: { rewrapped: 3, current: 0, failed: 0 },
			failures: [],
			done: true,
			next: accountId(2),
		})
		const keys = await storedKeys(h.store)
		const salts = new Set<string>()
		for (const key of keys.values()) {
			expect(key.pubkey).toBe(LEGACY_EMPTY_KEK.pubkey)
			expect(await checkKey(NEW_KEK, key)).toBe('ok')
			expect(await checkKey('', key)).toBe('unwrap-failed')
			salts.add(bytesToBase64(key.salt))
			// The same private key: a signature made before still verifies, and a new one made with it too.
			const publicKey = await importPublicKeyPem(key.pubkey)
			expect(await crypto.subtle.verify(RSA_ALGORITHM, publicKey, signature, PROBE)).toBe(true)
			const fresh = await crypto.subtle.sign(
				RSA_ALGORITHM,
				await importPrivateKey(await unwrapPkcs8(NEW_KEK, key)),
				PROBE
			)
			expect(new Uint8Array(fresh)).toEqual(new Uint8Array(signature))
		}
		// A fresh salt for each key.
		expect(salts.size).toBe(3)
		expect(salts.has(bytesToBase64(LEGACY_EMPTY_KEK.salt))).toBe(false)
	})

	it('changes nothing when run again', async () => {
		const h = await setup()
		await seedUsers(h.store, 1)
		await seedInstanceKey(h.store)
		await h.post(serviceClaims(), '/admin/keys/rewrap')
		const before = await storedKeys(h.store)
		expect(await (await h.post(serviceClaims(), '/admin/keys/rewrap')).json()).toMatchObject({
			counts: { rewrapped: 0, current: 2, failed: 0 },
			failures: [],
		})
		expect(await storedKeys(h.store)).toEqual(before)
	})

	it('moves from USER_KEK_PREVIOUS, and reports a key under another KEK without touching it', async () => {
		const h = await setup({ USER_KEK: NEW_KEK, USER_KEK_PREVIOUS: LEGACY.kek })
		await seedLocalAccount(h.store, DOMAIN, { id: accountId(1), username: 'alice', key: LEGACY })
		await seedLocalAccount(h.store, DOMAIN, { id: accountId(2), username: 'bob', key: LEGACY_EMPTY_KEK })
		await seedLocalAccount(h.store, DOMAIN, {
			id: accountId(3),
			username: 'carol',
			key: { ...LEGACY, pubkey: LEGACY_EMPTY_KEK.pubkey },
		})
		await seedInstanceKey(h.store, LEGACY)
		expect(await (await h.post(serviceClaims(), '/admin/keys/rewrap')).json()).toMatchObject({
			counts: { rewrapped: 2, current: 0, failed: 2 },
			failures: [
				{ owner: 'bob', reason: 'unwrap-failed' },
				{ owner: 'carol', reason: 'pubkey-mismatch' },
			],
		})
		const keys = await storedKeys(h.store)
		expect(await checkKey(NEW_KEK, keys.get('alice')!)).toBe('ok')
		expect(await checkKey(NEW_KEK, keys.get(null)!)).toBe('ok')
		const { privkey, salt, pubkey } = LEGACY_EMPTY_KEK
		expect(keys.get('bob')).toEqual({ privkey, salt, pubkey })
		expect(keys.get('carol')).toEqual({ privkey: LEGACY.privkey, salt: LEGACY.salt, pubkey })
	})

	it('refuses an empty USER_KEK and a USER_KEK equal to the previous KEK', async () => {
		for (const [overrides, code] of [
			[{}, 'kek-empty'],
			[{ USER_KEK: '' }, 'kek-empty'],
			[{ USER_KEK: NEW_KEK, USER_KEK_PREVIOUS: NEW_KEK }, 'kek-unchanged'],
			// Not equal strings, but they wrap alike (wrapsAlike).
			[{ USER_KEK: '\u0000' }, 'kek-empty'],
			[{ USER_KEK: `${NEW_KEK}\u0000`, USER_KEK_PREVIOUS: NEW_KEK }, 'kek-unchanged'],
		] as const) {
			const h = await setup(overrides)
			await seedUsers(h.store, 1)
			const response = await h.post(serviceClaims(), '/admin/keys/rewrap')
			expect(response.status).toBe(409)
			expect(await response.json()).toMatchObject({ code })
			expect((await storedKeys(h.store)).get('user1')?.privkey).toEqual(LEGACY_EMPTY_KEK.privkey)
		}
	})

	it('is for the Access admin only', async () => {
		const token = 'import-token-0123456789abcdef0123456789'
		const h = await setup({ USER_KEK: NEW_KEK, IMPORT_TOKEN: token })
		await seedUsers(h.store, 1)
		const post = (headers: Record<string, string>) =>
			h.request('/admin/keys/rewrap', { method: 'POST', headers, body: '{}' })
		expect((await post({})).status).toBe(401)
		expect((await post({ 'Kopje-Import-Token': token })).status).toBe(403)
		expect((await post({ 'Kopje-Import-Session': 'A'.repeat(43) })).status).toBe(403)
		expect((await h.post({ email: 'someone@kopje.test' }, '/admin/keys/rewrap')).status).toBe(403)
		expect((await h.post(serviceClaims(), '/admin/keys/rewrap', { after: 'user1' })).status).toBe(400)
		expect((await storedKeys(h.store)).get('user1')?.privkey).toEqual(LEGACY_EMPTY_KEK.privkey)
	})

	it('reports a key that changed after it was read, and leaves the change in place', async () => {
		const store = await migratedStore()
		await setAccess(store)
		await seedUsers(store, 1)
		// The Store answers the page as read, then the key changes before the write.
		const racing = {
			rewrapKeys: async (build: string, input: { after: string | null }) => {
				const page = await store.rewrapKeys(build, input)
				await runInDurableObject(store, (_instance, state) => {
					state.storage.sql.exec('UPDATE local_accounts SET privkey_salt = ?', new Uint8Array(16).fill(9).buffer)
				})
				return page
			},
			rewrapKey: (build: string, input: Parameters<StoreStub['rewrapKey']>[1]) => store.rewrapKey(build, input),
		} as unknown as StoreStub
		const step = await rewrapKeys(
			{ build: BUILD, store: racing, authority: ACCESS, kek: NEW_KEK, previous: '' },
			{ after: null }
		)
		expect(step).toMatchObject({
			ok: true,
			counts: { rewrapped: 0, failed: 1 },
			failures: [{ owner: 'user1', reason: 'changed' }],
		})
		expect((await storedKeys(store)).get('user1')?.salt).toEqual(new Uint8Array(16).fill(9))
	})

	it('never answers with key or KEK material', async () => {
		const previous = 'the previous KEK value'
		const h = await setup({ USER_KEK: NEW_KEK, USER_KEK_PREVIOUS: previous })
		await seedUsers(h.store, 1, LEGACY)
		await seedLocalAccount(h.store, DOMAIN, { id: accountId(2), username: 'bob', key: LEGACY_EMPTY_KEK })
		const texts = [await (await h.post(serviceClaims(), '/admin/keys/rewrap')).text()]
		texts.push(await (await h.post(serviceClaims(), '/admin/keys/rewrap', { after: null })).text())
		const stored = await storedKeys(h.store)
		const secrets = [NEW_KEK, previous, LEGACY.kek]
		for (const key of [LEGACY, LEGACY_EMPTY_KEK, ...stored.values()]) {
			secrets.push(bytesToBase64(key.privkey), bytesToBase64(key.salt))
		}
		for (const text of texts) {
			for (const secret of secrets) {
				expect(text).not.toContain(secret)
			}
		}
	})

	it('leaves a health report with no key failure and no empty-KEK warning', async () => {
		const h = await setup()
		await seedUsers(h.store, 2)
		await seedInstanceKey(h.store)
		const report = (kek: string) => healthReport(BUILD, readConfig({ ...env, USER_KEK: kek }), () => h.store)
		expect((await report('')).checks.keys).toMatchObject({ ok: true, warning: 'USER_KEK is empty' })
		await h.post(serviceClaims(), '/admin/keys/rewrap')
		expect((await report(NEW_KEK)).checks.keys).toEqual({ ok: true, count: 3, failures: [] })
	})
})

describe('the keys rewrap command', () => {
	async function cli(h: Awaited<ReturnType<typeof setup>>, argv: string[]) {
		const out: string[] = []
		const err: string[] = []
		const fetch = async (input: string, init?: RequestInit) => {
			const headers = new Headers(init?.headers)
			headers.delete('CF-Access-Client-Id')
			headers.delete('CF-Access-Client-Secret')
			return h.as(serviceClaims(), new URL(input).pathname, { ...init, headers })
		}
		const code = await run({
			argv,
			env: {
				KOPJE_ADMIN_URL: 'https://admin.kopje.test',
				CF_ACCESS_CLIENT_ID: 'id',
				CF_ACCESS_CLIENT_SECRET: 'secret',
			},
			io: memoryIO(),
			stdout: { write: (text: string) => void out.push(text), isTTY: false },
			stderr: { write: (text: string) => void err.push(text), isTTY: false },
			fetch,
		})
		return { code, out: out.join(''), err: err.join('') }
	}

	it('follows every page, prints the counts and exits 0', async () => {
		const h = await setup()
		await seedUsers(h.store, KEY_PAGE + 1)
		await seedInstanceKey(h.store)
		const result = await cli(h, ['keys', 'rewrap'])
		expect(result.code).toBe(0)
		expect(JSON.parse(result.out)).toEqual({ rewrapped: KEY_PAGE + 2, current: 0, failed: 0, failures: [] })
		const again = await cli(h, ['keys', 'rewrap'])
		expect(JSON.parse(again.out)).toEqual({ rewrapped: 0, current: KEY_PAGE + 2, failed: 0, failures: [] })
	})

	it('prints the failures and exits 3 when a key could not be moved', async () => {
		const h = await setup()
		await seedUsers(h.store, 1)
		await seedLocalAccount(h.store, DOMAIN, { id: accountId(2), username: 'bob', key: LEGACY })
		const result = await cli(h, ['keys', 'rewrap'])
		expect(result.code).toBe(3)
		expect(JSON.parse(result.out)).toEqual({
			rewrapped: 1,
			current: 0,
			failed: 1,
			failures: [{ owner: 'bob', reason: 'unwrap-failed' }],
		})
		expect(result.err).toContain('some keys were not rewrapped')
	})

	it('exits 1 on a refusal and 2 on a usage error', async () => {
		const h = await setup({})
		await seedUsers(h.store, 1)
		const refused = await cli(h, ['keys', 'rewrap'])
		expect(refused.code).toBe(1)
		expect(refused.err).toContain('set USER_KEK')
		expect((await cli(h, ['keys'])).code).toBe(2)
		expect((await cli(h, ['keys', 'rotate'])).code).toBe(2)
	})
})
