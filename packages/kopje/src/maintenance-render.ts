import { Db } from './db/sql'
import { type LocalActor, localActorOf } from './domain/actors'
import { fetchFederation } from './federation/routes'
import { snapshotKey } from './federation/snapshot'
import { MAINTENANCE_SNAPSHOT_FORMAT, type MaintenanceSnapshot } from './maintenance'
import type { StoreStub } from './platform/store-client'
import { StoreUnavailableError } from './platform/store-errors'
import { isStorableSnapshot, type Snapshot } from './platform/store-kernel'

// The converter's shared functions, for the npm package, which ships no sources (cli/lib/cutover/kopje-runtime.js).
export { backfillConversations } from './domain/conversation-rows'
export { languageOf } from './domain/language'
export { normalizeSearchText } from './domain/search-text'
export { hashtagObjectName, normalizeTag } from './domain/tag-name'
export { blockedDomain } from './platform/domain-name'
export { sniffImageType } from './platform/image-bytes'
export { REMOTE_HTML_RAW_LIMIT, remoteHtmlText, sanitizeRemoteHtml } from './security/html'

// Renders the cutover's maintenance snapshot (src/maintenance-worker.ts) with Kopje's own code: the local actors are
// read from the converted Store database by the Store's own query (domain/actors.ts, localActorOf), and their actor
// documents and WebFinger answers are rendered by the Worker's own dispatchers (federation/routes.ts, fetchFederation),
// keyed as the Worker keys its snapshots (federation/snapshot.ts). `kopje-admin maintenance-worker` runs this bundle on
// Node; test/maintenance-worker.test.ts checks that a real Store serves the same bytes after the import.

// The part of SqlStorage that Db uses, over any synchronous SQLite (the CLI passes node:sqlite).
export type SqlRunner = (query: string, params: unknown[]) => Record<string, SqlStorageValue>[]

export type RenderInput = { domain: string; sql: SqlRunner; now?: number }

export async function renderMaintenanceSnapshot({
	domain,
	sql,
	now = Date.now(),
}: RenderInput): Promise<MaintenanceSnapshot> {
	const db = new Db({
		exec: (query: string, ...params: unknown[]) => {
			const rows = sql(query, params)
			return { toArray: () => rows, rowsWritten: 0 }
		},
	} as unknown as SqlStorage)
	const usernames = db
		.all<{
			username: string
		}>(
			'SELECT a.username FROM accounts a JOIN local_accounts l ON l.account_id = a.id WHERE a.domain IS NULL ORDER BY a.username'
		)
		.map((row) => row.username)
	const actors = usernames.map((username) => {
		const actor = localActorOf(db, username)
		if (actor === null) {
			throw new Error('a local account has no actor')
		}
		return actor
	})
	const origin = `https://${domain}`
	const documents: Record<string, Snapshot> = {}
	for (const actor of actors) {
		const id = `${origin}/ap/users/${actor.username}`
		const requests = [
			new Request(id, { headers: { accept: 'application/activity+json' } }),
			new Request(`${origin}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${actor.username}@${domain}`)}`),
			new Request(`${origin}/.well-known/webfinger?resource=${encodeURIComponent(id)}`),
		]
		for (const request of requests) {
			const url = new URL(request.url)
			const key = snapshotKey(url)
			const { response, state } = await fetchFederation(
				{
					domain,
					build: 'kopje-maintenance',
					store: () => snapshotStore(actors),
					kek: '',
					now: () => now,
					keygen: () => Promise.reject(new Error('no key is made for the maintenance snapshot')),
					loader: { fetch: () => Promise.reject(new Error('no fetch is made for the maintenance snapshot')) },
				},
				request,
				url
			)
			if (key === null || state.storeError !== null || response.status !== 200) {
				throw new Error(`an actor document did not render (HTTP ${response.status})`)
			}
			const body = await response.text()
			if (!isStorableSnapshot(key, body)) {
				throw new Error('an actor document is larger than a snapshot may be')
			}
			documents[key] = { contentType: response.headers.get('content-type') ?? 'application/json', body }
		}
	}
	return { format: MAINTENANCE_SNAPSHOT_FORMAT, domain, inboxes: usernames, documents }
}

// The Store as the dispatchers see it while rendering: the local actors (case-insensitively, as getLocalActor), no
// keys. Anything else would need data the snapshot does not have, and fails.
function snapshotStore(actors: LocalActor[]): StoreStub {
	const byName = new Map(actors.map((actor) => [actor.username.toLowerCase(), actor]))
	const calls: Record<string, (build: string, input: { username: string }) => Promise<unknown>> = {
		localActor: (_build, { username }) => Promise.resolve(byName.get(username.toLowerCase()) ?? null),
		localKey: () => Promise.resolve(null),
	}
	return new Proxy({} as StoreStub, {
		get: (_target, name) => {
			if (typeof name !== 'string' || name === 'then') {
				return undefined
			}
			return calls[name] ?? (() => Promise.reject(new StoreUnavailableError('maintenance')))
		},
	})
}
