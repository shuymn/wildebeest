import { env } from 'cloudflare:test'

import { createUser, User } from 'wildebeest/backend/src/accounts'
import { ApObjectId } from 'wildebeest/backend/src/activitypub/objects'
import type { Cache } from 'wildebeest/backend/src/cache'
import { type Database as DB, getDatabase } from 'wildebeest/backend/src/database'
import type { Client } from 'wildebeest/backend/src/mastodon/client'
import { createClient } from 'wildebeest/backend/src/mastodon/client'
import type { Queue } from 'wildebeest/backend/src/types'
import type { JWK } from 'wildebeest/backend/src/webpush/jwk'

export function isUrlValid(s: string) {
	let url
	try {
		url = new URL(s)
	} catch {
		return false
	}
	return url.protocol === 'https:'
}

export function makeDB(): DB {
	return getDatabase(env)
}

export function assertCORS(response: Response, request?: Request) {
	expect(response.headers.has('Access-Control-Allow-Origin')).toBeTruthy()
	if (request?.method === 'OPTIONS') {
		expect(response.headers.has('Access-Control-Allow-Headers')).toBeTruthy()
	}
}

export function assertJSON(response: Response) {
	expect(response.headers.get('content-type')).toMatch('application/json')
}

export function assertCache(response: Response, maxge: number) {
	expect(response.headers.has('cache-control')).toBeTruthy()
	expect(response.headers.get('cache-control')).toMatch('max-age=' + maxge)
}

export async function assertStatus(response: Response, status: number) {
	if (response.status !== status) {
		expect(response.status, await response.text()).toBe(status)
	}
	expect(response.status).toBe(status)
}

export async function streamToArrayBuffer(stream: ReadableStream) {
	let result = new Uint8Array(0)
	const reader = stream.getReader()
	// eslint-disable-next-line no-constant-condition
	while (true) {
		const { done, value } = await reader.read()
		if (done) {
			break
		}

		const newResult = new Uint8Array(result.length + value.length)
		newResult.set(result)
		newResult.set(value, result.length)
		result = newResult
	}
	return result
}

export async function createTestClient(
	db: DB,
	redirectUri = 'https://localhost',
	scopes = 'read follow'
): Promise<Client> {
	return createClient(db, 'test client', redirectUri, scopes, 'https://cloudflare.com')
}

type TestQueue = Queue<any> & { messages: Array<any> }

export function makeQueue(): TestQueue {
	const messages: Array<any> = []

	return {
		messages,

		async send(msg: any) {
			messages.push(msg)
			return Promise.resolve()
		},

		async sendBatch(batch: Array<{ body: any }>) {
			for (let i = 0, len = batch.length; i < len; i++) {
				messages.push(batch[i].body)
			}
			return Promise.resolve()
		},
	}
}

export function makeCache(): Cache {
	const cache: Record<string, unknown> = {}

	return {
		async get<T>(key: string): Promise<T | null> {
			if (cache[key]) {
				return Promise.resolve(cache[key] as T)
			} else {
				return Promise.resolve(null)
			}
		},

		async put<T>(key: string, value: T): Promise<void> {
			cache[key] = value
			return Promise.resolve()
		},
	}
}

export function makeDOCache(cache = makeCache()): Pick<DurableObjectNamespace, 'idFromName' | 'get'> {
	return {
		idFromName(name: string): DurableObjectId {
			return {
				name,
				toString() {
					return name
				},
				equals(other: DurableObjectId) {
					return this.toString() === other.toString()
				},
			}
		},
		get(id: DurableObjectId): DurableObjectStub {
			return {
				id,
				async fetch(key: string, data?: { body: string }): Promise<Response> {
					if (data) {
						const { key, value } = JSON.parse(data.body)
						await cache.put(key, value)
						return new Response()
					}
					key = key.replace('http://cache/', '')
					return new Response(JSON.stringify(await cache.get(key)))
				},
				connect(): Socket {
					return {} as Socket
				},
			}
		},
	}
}

export async function generateVAPIDKeys(): Promise<JWK> {
	const keyPair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
		'sign',
		'verify',
	])) as CryptoKeyPair
	const jwk = (await crypto.subtle.exportKey('jwk', keyPair.privateKey)) as JWK
	return jwk
}

export function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(Math.ceil(hex.length / 2))
	for (let i = 0; i < bytes.length; i++) {
		const start = i * 2
		bytes[i] = parseInt(hex.substring(start, start + 2), 16)
	}
	return bytes
}

export function createActivityId(domain: string): ApObjectId {
	const id = crypto.randomUUID()
	return new URL('/ap/a/' + id, 'https://' + domain)
}

export function createTestUser(
	domain: string,
	db: DB,
	userKEK: string,
	email: string,
	{ preferredUsername, name }: { preferredUsername?: string; name?: string } = {},
	admin = false
): Promise<User> {
	preferredUsername ??= email.split('@')[0]
	return createUser({
		domain,
		db,
		userKEK,
		email,
		preferredUsername,
		name: name ?? preferredUsername,
		admin,
	})
}
