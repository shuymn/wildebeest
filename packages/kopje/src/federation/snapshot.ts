import type { SnapshotSource } from '../domain/snapshot'
import { errorFields } from '../platform/error-message'
import { callStore, type StoreStub } from '../platform/store-client'
import { isSnapshotKey, sha256, type Snapshot, snapshotKind } from '../platform/store-kernel'

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
export function acceptable(request: Request, url: URL): boolean {
	if (!isActorPath(url)) {
		return true
	}
	return /json/i.test(request.headers.get('accept') ?? '')
}

// An unchanged document is written again at most once per interval per key; a changed one is written at once.
export const SNAPSHOT_SAVE_INTERVAL_MS = 60 * 1000

export type SnapshotSaver = (
	store: StoreStub,
	build: string,
	key: string,
	snapshot: Snapshot,
	source: SnapshotSource,
	renderedAt: number
) => Promise<void>

// Remembers, per isolate, what each key last saved, so a steady document does not cost a Store write RPC on every
// GET. Changed content is not throttled: only local data changes it, and a stale snapshot would outlive a key
// rotation. The map is bounded like the keys (see federationHandler).
export function createSnapshotSaver(now: () => number): SnapshotSaver {
	const saved = new Map<string, { digest: string; at: number }>()
	return async (store, build, key, snapshot, source, renderedAt) => {
		// An oversized body still goes to the Store, which drops the kept snapshot of the key.
		if (!isSnapshotKey(key)) {
			return
		}
		const digest = await sha256(`${snapshot.contentType}\n${snapshot.body}`)
		const last = saved.get(key)
		// A changed body is always saved (a key rotation or profile edit must reach the rescue path); an identical one
		// is re-saved at most once per interval.
		if (last !== undefined && last.digest === digest && now() - last.at < SNAPSHOT_SAVE_INTERVAL_MS) {
			return
		}
		try {
			// Only a stored body counts as saved: a refused one (stale source, oversized) must not suppress a later save.
			if (await callStore(() => store.saveSnapshot(build, { key, ...snapshot, source, renderedAt }))) {
				saved.set(key, { digest, at: now() })
			}
		} catch (error) {
			// A refused write (readonly) keeps the previous snapshot, which is what the rescue path should serve anyway.
			console.warn({ event: 'kopje.snapshot.save-failed', kind: snapshotKind(key), ...errorFields(error) })
		}
	}
}

// The rescue answer of an always-served GET, or null when there is none. Only keys of the two snapshot shapes reach
// the Store, and only stored (size-capped) bodies come back.
export function rescueFromSnapshot(request: Request, store: StoreStub, build: string): Promise<Response | null> {
	return answerFromSnapshot(request, (key) => store.rescueSnapshot(build, key))
}

// The answer of an always-served GET from the snapshot `find` returns for its key, or null. Shared by the rescue path
// and the cutover's maintenance worker (src/maintenance-worker.ts), so both answer the same requests the same way.
export async function answerFromSnapshot(
	request: Request,
	find: (key: string) => Promise<Snapshot | null>
): Promise<Response | null> {
	const url = new URL(request.url)
	const key = snapshotKey(url)
	if (key === null || !isSnapshotKey(key) || !acceptable(request, url)) {
		return null
	}
	let snapshot: Snapshot | null
	try {
		snapshot = await find(key)
	} catch {
		return null
	}
	if (snapshot === null) {
		return null
	}
	// The headers the live answer has (app.ts): an actor document is negotiated by Accept, and every document but the
	// instance actor's is open to browsers.
	const headers: Record<string, string> = { 'content-type': snapshot.contentType }
	if (isActorPath(url)) {
		headers.vary = 'Accept'
	}
	if (url.pathname !== '/actor') {
		headers['access-control-allow-origin'] = '*'
	}
	return new Response(request.method === 'HEAD' ? null : snapshot.body, { headers })
}

function isActorPath(url: URL): boolean {
	return url.pathname === '/actor' || ACTOR_PATH.test(url.pathname)
}
