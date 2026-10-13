import { classifyRequest } from './app/gate'
import { hasSignatureShape, precheckInboxRequest } from './federation/inbox-request'
import { acceptable, answerFromSnapshot } from './federation/snapshot'
import { type Admission, createAdmission, INBOX_BODY_LIMIT, spoolInbox } from './federation/spool'
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
export { MAINTENANCE_RETRY_AFTER_SECONDS } from './mastodon/errors'
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

// Optional: a Rate Limiting binding of the Pages project, keyed by client IP, if the platform offers one there.
export const SPOOL_RATE_LIMIT_BINDING = 'KOPJE_SPOOL_RATE_LIMIT'
export { SPOOL_BACKLOG_BYTES, SPOOL_BACKLOG_MESSAGES } from './federation/spool'

export type MaintenanceEnv = {
	[SPOOL_QUEUE_BINDING]?: Queue
	[SPOOL_RATE_LIMIT_BINDING]?: { limit(options: { key: string }): Promise<{ success: boolean }> }
}

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
	const domain = snapshot.domain
	const inboxes = new Set(snapshot.inboxes)
	const documents = new Map(Object.entries(snapshot.documents))
	const admission = createAdmission(now)
	return {
		fetch: async (request, env) =>
			withHeaders(await answer(request, env, { domain, inboxes, documents }, now, admission)),
	}
}

async function answer(
	request: Request,
	env: MaintenanceEnv,
	{ domain, inboxes, documents }: { domain: string; inboxes: Set<string>; documents: Map<string, Snapshot> },
	now: () => number,
	admission: Admission
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
		// Flooding the spool takes a signature of the right shape, within the rate limit and the backlog budget.
		if (!hasSignatureShape(request.headers)) {
			return new Response(null, { status: 401 })
		}
		const queue = env[SPOOL_QUEUE_BINDING]
		if (queue === undefined) {
			console.error({ event: 'kopje.maintenance.queue-missing' })
			return unavailable()
		}
		const limiter = env[SPOOL_RATE_LIMIT_BINDING]
		const client = request.headers.get('cf-connecting-ip')
		if (limiter !== undefined && client !== null && !(await limiter.limit({ key: client })).success) {
			console.warn({ event: 'kopje.maintenance.rate-limited' })
			return unavailable(429)
		}
		if (await admission.full(queue)) {
			console.warn({ event: 'kopje.maintenance.backlog-full' })
			return unavailable()
		}
		return spoolInbox(request, body, queue, now())
	}
	if (requestClass === 'always') {
		const snapshot = await answerFromSnapshot(request, (key) => Promise.resolve(documents.get(key) ?? null))
		if (snapshot !== null) {
			return snapshot
		}
		const variant = answerVariant(request, domain, documents)
		if (variant !== null) {
			return variant
		}
	}
	return unavailable()
}

const ACTOR_PATH = /^\/ap\/users\/[^/]+$/
const ACCT = /^acct:([^@]+)@([^@]+)$/

// The other answers Kopje's dispatchers give that the snapshot can tell exactly, since it holds every local actor:
//   - WebFinger for acct:<user>@<domain> in any case: the user's answer, its subject the user as asked and the domain
//     in lower case (Fedify's answer); an unknown user, another domain, or another URL of this origin but the
//     instance actor's: 404;
//   - an actor path that is not a local actor's exact path, asked as JSON: 404, as Kopje (actor paths keep case).
// Anything else (a foreign URL, a malformed query) is left to 503.
function answerVariant(request: Request, domain: string, documents: Map<string, Snapshot>): Response | null {
	const url = new URL(request.url)
	const body = (text: string | null) => (request.method === 'HEAD' ? null : text)
	if (ACTOR_PATH.test(url.pathname)) {
		if (!acceptable(request, url)) {
			return null
		}
		return new Response(body('Not Found'), { status: 404, headers: { vary: 'Accept' } })
	}
	if (url.pathname !== '/.well-known/webfinger') {
		return null
	}
	const resources = url.searchParams.getAll('resource')
	const resource = resources.length === 1 ? resources[0]! : null
	if (resource === null) {
		return null
	}
	const notFound = () => new Response(body('Not Found'), { status: 404 })
	const acct = ACCT.exec(resource)
	if (acct !== null) {
		const [, user, host] = acct as unknown as [string, string, string]
		if (host.toLowerCase() !== domain) {
			return notFound()
		}
		const canonical = [...documents.keys()].find(
			(key) => key.toLowerCase() === `webfinger:acct:${user}@${domain}`.toLowerCase()
		)
		if (canonical === undefined) {
			return notFound()
		}
		const snapshot = documents.get(canonical)!
		const answer = JSON.parse(snapshot.body) as Record<string, unknown>
		return new Response(body(JSON.stringify({ ...answer, subject: `acct:${user}@${domain}` })), {
			headers: { 'content-type': snapshot.contentType, 'access-control-allow-origin': '*' },
		})
	}
	// The instance actor's URI is answered after the import, but its key does not exist yet: 503.
	try {
		const target = new URL(resource)
		return target.origin === `https://${domain}` && target.pathname !== '/actor' ? notFound() : null
	} catch {
		return null
	}
}

// Kopje's own maintenance answer, Retry-After included, so the whole cutover window answers alike.
function unavailable(status: 429 | 503 = 503): Response {
	const response = maintenanceError()
	return status === 503 ? response : new Response(response.body, { status, headers: response.headers })
}

function withHeaders(response: Response): Response {
	const copy = new Response(response.body, response)
	copy.headers.set('x-content-type-options', 'nosniff')
	return copy
}
