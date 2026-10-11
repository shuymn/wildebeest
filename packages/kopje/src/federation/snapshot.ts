import { errorMessage } from '../platform/error-message'
import { callStore, type StoreStub } from '../platform/store-client'
import { isSnapshotKey, type Snapshot, SNAPSHOT_MAX_BODY_BYTES } from '../platform/store-kernel'

// Snapshots of the always-served GETs (design §4, maintenance mode): actor documents, WebFinger and NodeInfo. A
// healthy response is saved under the key of its request; while the Store refuses (version mismatch, pending or
// diverged schema), the Worker answers the same request from the snapshot through a rescue RPC instead of 503.
// Only canonical answers of existing actors are saved (federationHandler): the actor path and the acct: and actor URI
// WebFinger queries of each local actor, plus /actor and the three NodeInfo documents. Any other handle, resource or
// query string creates no row, so the rows stay bounded by the number of local actors.

const NODEINFO_PATHS = new Set(['/.well-known/nodeinfo', '/nodeinfo/2.0', '/nodeinfo/2.1'])
const ACTOR_PATH = /^\/ap\/users\/[^/]+$/

// The snapshot key of a request, or null for requests that never have one.
export function snapshotKey(url: URL): string | null {
	if (url.pathname === '/.well-known/webfinger') {
		const resource = url.searchParams.get('resource')
		return resource === null ? null : `webfinger:${resource}`
	}
	if (url.pathname === '/actor' || ACTOR_PATH.test(url.pathname) || NODEINFO_PATHS.has(url.pathname)) {
		return `path:${url.pathname}`
	}
	return null
}

// Actor documents are JSON-LD; a browser asking for HTML gets no snapshot (it would get the profile page).
function acceptable(request: Request, url: URL): boolean {
	if (url.pathname !== '/actor' && !ACTOR_PATH.test(url.pathname)) {
		return true
	}
	return /json/i.test(request.headers.get('accept') ?? '')
}

// A changed document is written at most once per interval per key; an unchanged one is not written again.
export const SNAPSHOT_SAVE_INTERVAL_MS = 60 * 1000

export type SnapshotSaver = (store: StoreStub, build: string, key: string, snapshot: Snapshot) => Promise<void>

// Remembers, per isolate, what each key last saved, so the Store write RPC happens only when a document changed (and
// not more often than the interval), not on every GET. The map is bounded like the keys (see federationHandler).
export function createSnapshotSaver(now: () => number): SnapshotSaver {
	const saved = new Map<string, { digest: string; at: number }>()
	return async (store, build, key, snapshot) => {
		if (!isSnapshotKey(key) || new TextEncoder().encode(snapshot.body).byteLength > SNAPSHOT_MAX_BODY_BYTES) {
			return
		}
		const digest = await sha256(`${snapshot.contentType}\n${snapshot.body}`)
		const last = saved.get(key)
		if (last !== undefined && (last.digest === digest || now() - last.at < SNAPSHOT_SAVE_INTERVAL_MS)) {
			return
		}
		try {
			await callStore(() => store.saveSnapshot(build, { key, ...snapshot }))
			saved.set(key, { digest, at: now() })
		} catch (error) {
			// A refused write (readonly) keeps the previous snapshot, which is what the rescue path should serve anyway.
			console.warn({ event: 'kopje.snapshot.save-failed', key, error: errorMessage(error) })
		}
	}
}

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

// The rescue answer of an always-served GET, or null when there is none. Only keys of the two snapshot shapes reach
// the Store, and only stored (size-capped) bodies come back.
export async function rescueFromSnapshot(request: Request, store: StoreStub, build: string): Promise<Response | null> {
	const url = new URL(request.url)
	const key = snapshotKey(url)
	if (key === null || !isSnapshotKey(key) || !acceptable(request, url)) {
		return null
	}
	let snapshot: Snapshot | null
	try {
		snapshot = await store.rescueSnapshot(build, key)
	} catch {
		return null
	}
	if (snapshot === null) {
		return null
	}
	return new Response(request.method === 'HEAD' ? null : snapshot.body, {
		headers: { 'content-type': snapshot.contentType, 'access-control-allow-origin': '*' },
	})
}
