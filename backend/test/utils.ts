import { strict as assert } from 'node:assert/strict'

import { D1Database, D1DatabaseAPI } from '@miniflare/d1'
import * as SQLiteDatabase from 'better-sqlite3'
import { promises as fs } from 'fs'
import * as path from 'path'
import { createUser, User } from 'wildebeest/backend/src/accounts'
import { ApObjectId } from 'wildebeest/backend/src/activitypub/objects'
import type { Cache } from 'wildebeest/backend/src/cache'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import type { Client } from 'wildebeest/backend/src/mastodon/client'
import { createClient } from 'wildebeest/backend/src/mastodon/client'
import type { Queue } from 'wildebeest/backend/src/types'
import type { JWK } from 'wildebeest/backend/src/webpush/jwk'

export function isUrlValid(s: string) {
	let url
	try {
		url = new URL(s)
	} catch (err) {
		return false
	}
	return url.protocol === 'https:'
}

export async function makeDB(): Promise<Database> {
	const db = new SQLiteDatabase(':memory:')
	const db2 = new D1Database(new D1DatabaseAPI(db))

	// Manually run our migrations since @miniflare/d1 doesn't support it (yet).
	const migrations = await fs.readdir('./migrations/')

	for (let i = 0, len = migrations.length; i < len; i++) {
		const content = await fs.readFile(path.join('migrations', migrations[i]), 'utf-8')
		db.exec(content)
	}

	const env = { DATABASE: db2 } as any
	return getDatabase(env)
}

export function assertCORS(response: Response) {
	assert(response.headers.has('Access-Control-Allow-Origin'))
	assert(response.headers.has('Access-Control-Allow-Headers'))
}

export function assertJSON(response: Response) {
	assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
}

export function assertCache(response: Response, maxge: number) {
	assert(response.headers.has('cache-control'))
	assert(response.headers.get('cache-control')!.includes('max-age=' + maxge))
}

export async function assertStatus(response: Response, status: number) {
	if (response.status !== status) {
		assert.equal(response.status, status, await response.text())
	}
	assert.equal(response.status, status)
}

export async function streamToArrayBuffer(stream: ReadableStream) {
	let result = new Uint8Array(0)
	const reader = stream.getReader()
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
	db: Database,
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
		},

		async sendBatch(batch: Array<{ body: any }>) {
			for (let i = 0, len = batch.length; i < len; i++) {
				messages.push(batch[i].body)
			}
		},
	}
}

export function makeCache(): Cache {
	const cache: Record<string, unknown> = {}

	return {
		async get<T>(key: string): Promise<T | null> {
			if (cache[key]) {
				return cache[key] as T
			} else {
				return null
			}
		},

		async put<T>(key: string, value: T): Promise<void> {
			cache[key] = value
		},
	}
}

export function makeDOCache(): Pick<DurableObjectNamespace, 'idFromName' | 'get'> {
	const cache = makeCache()

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
	db: Database,
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
