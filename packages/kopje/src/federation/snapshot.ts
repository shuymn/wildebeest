import { errorMessage } from '../platform/error-message'
import { callStore, type StoreStub } from '../platform/store-client'
import type { Snapshot } from '../platform/store-kernel'

// Snapshots of the always-served GETs (design §4, maintenance mode): actor documents, WebFinger and NodeInfo. A
// healthy response is saved under the key of its request; while the Store refuses (version mismatch, pending or
// diverged schema), the Worker answers the same request from the snapshot through a rescue RPC instead of 503.
// Only canonical requests are saved (see federationRoutes), so the number of rows is bounded by the number of actors.

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

export async function saveSnapshot(store: StoreStub, build: string, key: string, snapshot: Snapshot): Promise<void> {
	try {
		await callStore(() => store.saveSnapshot(build, { key, ...snapshot }))
	} catch (error) {
		// A refused write (readonly) keeps the previous snapshot, which is what the rescue path should serve anyway.
		console.warn({ event: 'kopje.snapshot.save-failed', key, error: errorMessage(error) })
	}
}

// The rescue answer of an always-served GET, or null when there is none.
export async function rescueFromSnapshot(request: Request, store: StoreStub, build: string): Promise<Response | null> {
	const url = new URL(request.url)
	const key = snapshotKey(url)
	if (key === null || !acceptable(request, url)) {
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
