import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

import { expect } from 'vitest'

import { sql } from './api-helpers'
import { ANIMATED_GIF, PNG_PLAIN } from './fixtures/images'
import { BUILD } from './helpers'
import { MASTODON } from './inbox-helpers'
import { setup } from './inbox-status-helpers'
import { bytes } from './media-helpers'
export { deferred } from './quote-helpers'
import { Db } from '../src/db/sql'
import { noteEmojiSnapshot, syncProfileFiles } from '../src/domain/remote-media'
import { type RemoteMediaDeps, remoteMediaRound } from '../src/federation/remote-media'
import type { StoreOperation } from '../src/platform/store-kernel'

// A federation harness for the cache of remote media (domain/remote-media.ts, federation/remote-media.ts): remote
// accounts seeded with profile image URLs, the files those URLs serve, the Store's operations run in one transaction,
// and the round over the real media bucket.

type Route = (request: Request) => Response | Promise<Response>

export const PNG = bytes(PNG_PLAIN)
export const GIF = bytes(ANIMATED_GIF)

type SlotRow = {
	id: number
	kind: string
	owner_id: string | null
	url: string
	host: string
	lane: number
	generation: number
	due_at: number | null
	enqueued_at: number
	claim: number
	attempts: number
	token: string | null
	ext: string | null
	still_ext: string | null
	stored_at: number | null
	failed_at: number | null
}

type ObjectRow = {
	token: string
	slot_id: number | null
	state: string
	charge: number
	kind: string
	content_type: string | null
	still_type: string | null
	hosts: string | null
	claimed_at: number
	stored_at: number | null
	due_at: number | null
	delete_attempts: number
}

let accounts = 0

export async function mediaWorld() {
	// The Store's remote media calls take the Store's own time (Date.now), so the round's tests run on it too.
	const clock = { now: Date.now() }
	const t = await setup(clock)
	const routes: Record<string, Route> = {}
	const requests: string[] = []
	const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(input, init)
		requests.push(`${request.method} ${request.url}`)
		const route = routes[request.url]
		return Promise.resolve(route === undefined ? new Response('missing', { status: 404 }) : route(request))
	}
	const op = <I, O>(operation: StoreOperation<I, O>, input: I) =>
		runInDurableObject(t.store, (_instance, state) =>
			state.storage.transactionSync(() => operation.run(state.storage.sql, input))
		)
	const db = <T>(work: (db: Db) => T) =>
		runInDurableObject(t.store, (_instance, state) =>
			state.storage.transactionSync(() => work(new Db(state.storage.sql)))
		)
	const deps = (extra: Partial<RemoteMediaDeps> = {}): RemoteMediaDeps => ({
		build: () => BUILD,
		store: () => t.store,
		now: () => clock.now,
		keygen: () => Promise.reject(new Error('no keys')),
		loader: { fetch, checkHost: () => Promise.resolve() },
		...extra,
	})
	const world = {
		t,
		clock,
		requests,
		op,
		db,
		serve: (url: string, body: Uint8Array | Route, headers: Record<string, string> = {}) => {
			routes[url] = typeof body === 'function' ? body : () => new Response(body, { headers })
		},
		// A remote account of `domain` with these profile image URLs, its slots enqueued as its storing branch does.
		remote: async (urls: { avatar?: string | null; header?: string | null } = {}, domain = 'files.example') => {
			const n = ++accounts
			const id = `6${String(n).padStart(17, '0')}`
			const avatar = urls.avatar === undefined ? `https://${domain}/a/${n}.png` : urls.avatar
			const header = urls.header === undefined ? null : urls.header
			await sql(
				t.store,
				`INSERT INTO accounts (id, uri, username, domain, avatar_url, header_url) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
				id,
				`https://${domain}/users/u${n}`,
				`u${n}`,
				domain,
				avatar,
				header
			)
			await db((d) => syncProfileFiles(d, id, { avatar, header }, clock.now))
			return { id, avatar, header }
		},
		// Changes the account's profile image URLs, as a refresh stores them, and syncs its slots.
		change: async (id: string, urls: { avatar: string | null; header: string | null }) => {
			await sql(
				t.store,
				'UPDATE accounts SET avatar_url = ?2, header_url = ?3 WHERE id = ?1',
				id,
				urls.avatar,
				urls.header
			)
			await db((d) => syncProfileFiles(d, id, urls, clock.now))
		},
		slots: () => sql<SlotRow>(t.store, 'SELECT * FROM remote_media ORDER BY id'),
		objects: () => sql<ObjectRow>(t.store, 'SELECT * FROM remote_media_objects ORDER BY claimed_at, token'),
		usage: async () =>
			(
				await sql<{ bytes: number; doomed: number; pending: number }>(
					t.store,
					'SELECT bytes, doomed, pending FROM remote_media_usage'
				)
			)[0]!,
		round: (extra: Partial<RemoteMediaDeps> = {}, env: Record<string, unknown> = {}) =>
			remoteMediaRound({ ...t.env, ...env }, deps(extra)),
		// The usage row equals the ledger's sums and the pending slots, exactly.
		exact: async () => {
			const [sums] = await sql<{ bytes: number; doomed: number; pending: number }>(
				t.store,
				`SELECT (SELECT coalesce(sum(charge), 0) FROM remote_media_objects) AS bytes,
					(SELECT coalesce(sum(charge), 0) FROM remote_media_objects WHERE state = 'doomed') AS doomed,
					(SELECT count(*) FROM remote_media WHERE due_at IS NOT NULL) AS pending`
			)
			expect(await world.usage()).toEqual(sums)
		},
	}
	return world
}

export type MediaWorld = Awaited<ReturnType<typeof mediaWorld>>

// Polls `until` every 10 ms (a call given up settles in a later task).
export async function settle(until: () => boolean): Promise<void> {
	while (!until()) {
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
}

// A bucket over the real one whose calls by method may be intercepted, each hook given the real call.
export function bucketWith(hooks: {
	delete?: (keys: string[], real: () => Promise<void>) => Promise<void>
	head?: (key: string, real: () => Promise<R2Object | null>) => Promise<R2Object | null>
	put?: (key: string, real: () => Promise<unknown>) => Promise<unknown>
}): R2Bucket {
	return new Proxy(env.MEDIA, {
		get: (target, key) => {
			const real = Reflect.get(target, key) as unknown
			if (typeof real !== 'function') {
				return real
			}
			const bound = (real as (...a: unknown[]) => unknown).bind(target)
			if (key === 'delete' && hooks.delete !== undefined) {
				return (keys: string | string[]) =>
					hooks.delete!(Array.isArray(keys) ? keys : [keys], () => bound(keys) as Promise<void>)
			}
			if (key === 'head' && hooks.head !== undefined) {
				return (k: string) => hooks.head!(k, () => bound(k) as Promise<R2Object | null>)
			}
			if (key === 'put' && hooks.put !== undefined) {
				return (k: string, ...rest: unknown[]) => hooks.put!(k, () => bound(k, ...rest) as Promise<unknown>)
			}
			return bound
		},
	})
}

// A Mastodon-shaped Emoji tag, its image under MASTODON.
export const emojiTag = (name: string) => ({
	id: `${MASTODON}/emojis/${name}`,
	type: 'Emoji',
	name: `:${name}:`,
	updated: '2026-10-01T00:00:00Z',
	icon: { type: 'Image', mediaType: 'image/png', url: `${MASTODON}/emoji/${name}.png` },
})

// A stored emoji snapshot of `urls`, named e0, e1, …
export const snapshot = (...urls: string[]) => JSON.stringify(urls.map((url, i) => [`e${i}`, url]))

// The emoji of `value` noted for `domain`, as a writer notes them (remote-media.ts noteEmojiSnapshot).
export const noteEmoji = (w: MediaWorld, value: string | null, domain: string | null) =>
	w.db((d) => noteEmojiSnapshot(d, value, domain, w.clock.now))
