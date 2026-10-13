import { classifyRequest } from './app/gate'
import { precheckInboxRequest } from './federation/inbox-request'
import { answerFromSnapshot } from './federation/snapshot'
import { INBOX_BODY_LIMIT, spoolInbox } from './federation/spool'
import { maintenanceError } from './mastodon/errors'
import { readBoundedBody } from './platform/body'
import type { Snapshot } from './platform/store-kernel'

// The cutover's maintenance worker (docs/cutover-runbook.md, step 3): a Pages `_worker.js` that replaces every route of
// a legacy Wildebeest Pages project while its data moves to Kopje. `kopje-admin maintenance-worker` writes it from
// this bundle and a snapshot that Kopje's own dispatchers rendered from the legacy export (src/maintenance-render.ts).
//
//   - Actor documents and WebFinger answers come from the snapshot, served by the rule of Kopje's own snapshot rescue
//     path (federation/snapshot.ts): the documents, URLs and keys Kopje serves after the cutover.
//   - Every inbox POST (shared and personal) is refused or spooled exactly as Kopje's gate does it, by Kopje's own code
//     (federation/inbox-request.ts, federation/spool.ts), into Kopje's Queue, with the request as received and the
//     time it arrived; Kopje replays it after the cutover and verifies its signature against that time (OPS-1).
//   - Anything else is 503 with Retry-After. Nothing here reads or writes the legacy bindings (OPS-4): the only write
//     is the spool message.
//
// The bundle runs on the legacy Pages project's own compatibility settings, so it imports no Node.js module and none
// of the federation stack (test-node/maintenance-worker.test.ts checks the bundle).

export const MAINTENANCE_SNAPSHOT_FORMAT = 1
// Peers retry within minutes; the cutover's downtime budget is 30 minutes.
export const MAINTENANCE_RETRY_AFTER_SECONDS = 600
// The Pages project's Queue producer binding for Kopje's Queue. Legacy instances bind their own Queue as QUEUE.
export const SPOOL_QUEUE_BINDING = 'KOPJE_QUEUE'

export type MaintenanceSnapshot = {
	format: typeof MAINTENANCE_SNAPSHOT_FORMAT
	domain: string
	// The local usernames as stored: a personal inbox is accepted only under one of these exact spellings (ID-5).
	inboxes: string[]
	// Kopje snapshot keys (federation/snapshot.ts, snapshotKey) to the documents Kopje rendered for them.
	documents: Record<string, Snapshot>
}

export type MaintenanceEnv = { [SPOOL_QUEUE_BINDING]?: Queue }

export function createMaintenanceWorker(
	snapshot: MaintenanceSnapshot,
	now: () => number = () => Date.now()
): ExportedHandler<MaintenanceEnv> {
	if (
		snapshot.format !== MAINTENANCE_SNAPSHOT_FORMAT ||
		typeof snapshot.domain !== 'string' ||
		!Array.isArray(snapshot.inboxes) ||
		typeof snapshot.documents !== 'object' ||
		snapshot.documents === null
	) {
		throw new Error('unsupported maintenance snapshot')
	}
	const inboxes = new Set(snapshot.inboxes)
	const documents = new Map(Object.entries(snapshot.documents))
	return {
		fetch: async (request, env) => withHeaders(await answer(request, env, inboxes, documents, now)),
	}
}

async function answer(
	request: Request,
	env: MaintenanceEnv,
	inboxes: Set<string>,
	documents: Map<string, Snapshot>,
	now: () => number
): Promise<Response> {
	const requestClass = classifyRequest(request.method, new URL(request.url).pathname)
	if (requestClass === 'inbox') {
		const body = await readBoundedBody(request, INBOX_BODY_LIMIT)
		if (body === 'too-large') {
			return new Response(null, { status: 413 })
		}
		const precheck = await precheckInboxRequest(request, (username) => Promise.resolve(inboxes.has(username)))
		if (precheck !== 'ok') {
			return new Response(null, { status: precheck === 'not-found' ? 404 : 415 })
		}
		const queue = env[SPOOL_QUEUE_BINDING]
		if (queue === undefined) {
			console.error({ event: 'kopje.maintenance.queue-missing' })
			return unavailable()
		}
		return spoolInbox(request, body, queue, now())
	}
	if (requestClass === 'always') {
		const snapshot = await answerFromSnapshot(request, (key) => Promise.resolve(documents.get(key) ?? null))
		if (snapshot !== null) {
			return snapshot
		}
	}
	return unavailable()
}

function unavailable(): Response {
	const response = maintenanceError()
	response.headers.set('retry-after', String(MAINTENANCE_RETRY_AFTER_SECONDS))
	return response
}

function withHeaders(response: Response): Response {
	const copy = new Response(response.body, response)
	copy.headers.set('x-content-type-options', 'nosniff')
	return copy
}

// The generated `_worker.js` defines KOPJE_MAINTENANCE_SNAPSHOT before this bundle (cli/lib/cutover/maintenance.js).
// Without it every request fails, so a bundle deployed on its own serves nothing.
declare const KOPJE_MAINTENANCE_SNAPSHOT: MaintenanceSnapshot | undefined

let worker: ExportedHandler<MaintenanceEnv> | undefined

export default {
	fetch: (request, env, ctx) => {
		worker ??= createMaintenanceWorker(
			typeof KOPJE_MAINTENANCE_SNAPSHOT === 'undefined'
				? ({ format: 0 } as unknown as MaintenanceSnapshot)
				: KOPJE_MAINTENANCE_SNAPSHOT
		)
		return worker.fetch!(request, env, ctx)
	},
} satisfies ExportedHandler<MaintenanceEnv>
