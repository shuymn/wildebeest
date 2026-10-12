import type { Handler } from 'hono'

import { type InboundRequest, type InboxOutcome, receiveInbound } from './inbound'
import type { LoaderDeps } from './loader'
import { readConfig, userKek } from '../platform/config'
import { errorFields } from '../platform/error-message'
import { isActivityPubMediaType, parseMediaType } from '../platform/media-type'
import { callStore, type StoreResolver } from '../platform/store-client'
import { StoreUnavailableError } from '../platform/store-errors'
import type { KeyGen } from '../security/key-wrap'

export const INBOX_ROUTES = ['/inbox', '/ap/users/:username/inbox', '/actor/inbox']

export type InboxDeps = {
	build: (env: Env) => string
	store: StoreResolver
	now: () => number
	keygen: KeyGen
	loader: Omit<LoaderDeps, 'userAgent'>
}

// A message that asks for a round of the Store's inbound jobs (purges and Moves, domain/inbox.ts runInboundJobs).
// It carries nothing: the jobs and their progress live in the Store, so a lost or repeated message changes nothing.
export type JobsMessage = { kind: 'inbound-jobs' }

export async function requestInboundJobs(queue: Queue, delaySeconds?: number): Promise<boolean> {
	try {
		await queue.send({ kind: 'inbound-jobs' } satisfies JobsMessage, delaySeconds === undefined ? {} : { delaySeconds })
		return true
	} catch (error) {
		console.error({ event: 'kopje.jobs.enqueue.failed', ...errorFields(error) })
		return false
	}
}

const PERSONAL_INBOX = /^\/ap\/users\/([^/]+)\/inbox$/

// The username a personal inbox path names, as written (Hono does not decode it either), or null for a shared inbox.
export function inboxRecipient(path: string): string | null {
	return PERSONAL_INBOX.exec(path)?.[1] ?? null
}

export type InboxPrecheck = 'ok' | 'not-found' | 'unsupported-media-type'

// What can be refused before anything is spooled: a body that is not ActivityStreams (415), and a personal inbox that
// does not name a local account with its exact stored username (404, ID-5). If the Store cannot answer, the request
// passes, to be spooled and checked again on replay.
export async function precheckInbox(
	env: Env,
	deps: Pick<InboxDeps, 'build' | 'store'>,
	request: Request
): Promise<InboxPrecheck> {
	const media = parseMediaType(request.headers.get('content-type') ?? '')
	if (media === null || !isActivityPubMediaType(media)) {
		return 'unsupported-media-type'
	}
	const username = inboxRecipient(new URL(request.url).pathname)
	if (username === null) {
		return 'ok'
	}
	try {
		const exists = await callStore(() => deps.store(env).inboxOwnerExists(deps.build(env), { username }))
		return exists ? 'ok' : 'not-found'
	} catch (error) {
		if (error instanceof StoreUnavailableError) {
			return 'ok'
		}
		throw error
	}
}

// Inbox processing, shared by the endpoint and spool replay. A maintenance refusal surfaces as StoreUnavailableError
// (the endpoint spools, replay requeues). A remaining purge is handed to the Queue. The endpoint passes the domain the
// setup gate read and has run precheckInbox already; replay reads and checks both again.
export async function processInbox(
	env: Env,
	deps: InboxDeps,
	request: InboundRequest,
	live?: { domain: string }
): Promise<InboxOutcome | { status: 404; reason: string }> {
	const build = deps.build(env)
	const store = () => deps.store(env)
	const domain = live?.domain ?? (await callStore(() => store().instanceDomain(build)))
	if (domain === null) {
		throw new StoreUnavailableError('maintenance')
	}
	const recipient = inboxRecipient(new URL(request.url).pathname)
	if (
		live === undefined &&
		recipient !== null &&
		!(await callStore(() => store().inboxOwnerExists(build, { username: recipient })))
	) {
		return { status: 404, reason: 'unknown-inbox' }
	}
	const config = readConfig(env)
	const outcome = await receiveInbound(
		{
			domain,
			build,
			store,
			kek: config.ok ? userKek(config.config) : '',
			now: deps.now,
			keygen: deps.keygen,
			loader: deps.loader,
			recipient,
		},
		request
	)
	if (outcome.status !== 202) {
		// Our own reason codes only: nothing the request supplied (DATA-5).
		console.log({ event: 'kopje.inbox.refused', status: outcome.status, reason: outcome.reason })
	}
	if (outcome.jobsPending === true) {
		// The jobs are durable in the Store: if this send fails, cron continues them.
		await requestInboundJobs(env.QUEUE)
	}
	return outcome
}

export function inboxHandler(
	deps: InboxDeps
): Handler<{ Bindings: Env; Variables: { inboxBody: Uint8Array; domain: string } }> {
	return async (c) => {
		const raw = c.req.raw
		const request = {
			url: raw.url,
			method: raw.method,
			headers: [...raw.headers],
			body: c.get('inboxBody'),
			receivedAt: deps.now(),
		}
		const outcome = await processInbox(c.env, deps, request, { domain: c.get('domain') })
		return c.body(null, outcome.status)
	}
}
