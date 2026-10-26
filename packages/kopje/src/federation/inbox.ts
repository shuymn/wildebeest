import type { Handler } from 'hono'

import { ringDoorbell } from './delivery'
import { fetchesFirst, type InboundRequest, type InboxOutcome, parseActivity, receiveInbound } from './inbound'
import { inboxRecipient, type InboxPrecheck, precheckInboxRequest, signatureKeyId } from './inbox-request'
import type { LoaderDeps } from './loader'
import { notSetUp } from './setup-gate'
import type { InboxGate, InboxGateInput } from '../domain/inbox'
import { readConfig, userKek } from '../platform/config'
import { errorFields } from '../platform/error-message'
import { callStore, type StoreResolver, type StoreStub } from '../platform/store-client'
import { type MaintenanceReason, StoreUnavailableError } from '../platform/store-errors'
import type { KeyGen } from '../security/key-wrap'

export type InboxDeps = {
	build: (env: Env) => string
	store: StoreResolver
	now: () => number
	keygen: KeyGen
	loader: Omit<LoaderDeps, 'userAgent'>
}

// A message that asks for a jobs round (jobsRound in jobs/queue.ts). It carries nothing: the jobs and their progress
// live in the Store, so a lost or repeated message changes nothing, and it is never retried (RES-5).
export type JobsMessage = { kind: 'inbound-jobs' }

export async function ringDeliveries(queue: Queue): Promise<void> {
	try {
		await ringDoorbell(queue)
	} catch (error) {
		console.error({ event: 'kopje.delivery.doorbell.failed', ...errorFields(error) })
	}
}

export async function requestInboundJobs(queue: Queue, delaySeconds?: number): Promise<boolean> {
	try {
		await queue.send({ kind: 'inbound-jobs' } satisfies JobsMessage, delaySeconds === undefined ? {} : { delaySeconds })
		return true
	} catch (error) {
		console.error({ event: 'kopje.jobs.enqueue.failed', ...errorFields(error) })
		return false
	}
}

// A personal inbox of nobody is refused before anything is spooled (inbox-request.ts), when the env spools inbox
// requests (app.ts). If the Store cannot answer, the request passes, to be spooled and checked again on replay.
export async function precheckInbox(
	env: Env,
	deps: Pick<InboxDeps, 'build' | 'store'>,
	request: Request
): Promise<InboxPrecheck> {
	return precheckInboxRequest(request, async (username) => {
		try {
			return await callStore(() => deps.store(env).inboxOwnerExists(deps.build(env), { username }))
		} catch (error) {
			if (error instanceof StoreUnavailableError) {
				return true
			}
			throw error
		}
	})
}

// Inbox processing, shared by the endpoint ('live') and spool replay ('replay'). One Store read (inboxGate) comes
// before anything is verified or fetched, and prepares the first fetch when one follows; receiveActivity is the only
// other call in the common case, and prepares the fetch of a document it needs. A maintenance
// refusal surfaces as StoreUnavailableError (the endpoint spools, replay requeues). A remaining job is handed to the
// Queue ('send'), or only reported in the outcome's jobsPending ('report': the Queue consumer runs one jobs round for its
// whole batch).
export async function processInbox(
	env: Env,
	deps: InboxDeps,
	request: InboundRequest,
	mode: 'live' | 'replay',
	nudge: 'send' | 'report' = 'send'
): Promise<InboxOutcome | { status: 404; reason: 'unknown-inbox' } | { status: 503; reason: 'not-set-up' }> {
	const build = deps.build(env)
	const store = () => deps.store(env)
	const recipient = inboxRecipient(new URL(request.url).pathname)
	const headers = new Headers(request.headers)
	const parsed = parseActivity(request.body)
	const actor = parsed.actor ?? null
	const gate = await readInboxGate(store, build, {
		username: recipient,
		actor,
		keyId: signatureKeyId(headers),
		now: deps.now(),
		fetches: fetchesFirst(parsed),
		target: parsed.ok ? parsed.target : null,
	})
	// Before any loader or fetch: a Store that refuses writes (an unpublished import, maintenance) holds the request as
	// in maintenance, so nothing is signed with a local key for it (OPS-8). receiveActivity is admitted again in its own
	// transaction. The precedence differs by mode: live, an unknown inbox (404, ID-5) and setup (503) come before the
	// refusal, which spools; replay holds the request (requeues) while writes are refused or the domain is unset, and
	// only then drops one for an unknown inbox.
	if (mode === 'replay') {
		if (gate.refused !== null) {
			throw new StoreUnavailableError(gate.refused)
		}
		if (gate.domain === null) {
			throw new StoreUnavailableError('maintenance')
		}
		if (gate.ownerExists === false) {
			return { status: 404, reason: 'unknown-inbox' }
		}
	} else {
		if (gate.ownerExists === false) {
			return { status: 404, reason: 'unknown-inbox' }
		}
		if (gate.domain === null) {
			return { status: 503, reason: 'not-set-up' }
		}
		if (gate.refused !== null) {
			throw new StoreUnavailableError(gate.refused)
		}
	}
	const config = readConfig(env)
	const outcome = await receiveInbound(
		{
			domain: gate.domain,
			build,
			store,
			kek: config.ok ? userKek(config.config) : '',
			now: deps.now,
			keygen: deps.keygen,
			loader: deps.loader,
			recipient,
		},
		request,
		{
			headers,
			parsed,
			domainBlocked: gate.domainBlocked === true,
			key: gate.key,
			prefetch: gate.prefetch,
			revisions: gate.revisions,
		}
	)
	if (outcome.status !== 202) {
		// Our own reason codes only: nothing the request supplied (DATA-5).
		console.log({ event: 'kopje.inbox.refused', status: outcome.status, reason: outcome.reason })
	}
	if (outcome.delivers === true) {
		// The deliveries are durable in the Store: if this ring is lost, the delivery cron sends them.
		await ringDeliveries(env.QUEUE)
	}
	if (outcome.jobsPending === true && nudge === 'send') {
		// The jobs are durable in the Store: if this send fails, cron continues them.
		await requestInboundJobs(env.QUEUE)
	}
	return outcome
}

// Durable Object code rolls out eventually consistently, so during a deploy this Worker can reach a Store of the
// previous build, which has no inboxGate: the runtime refuses the call with a TypeError that callStore does not
// classify. Only when the Store then answers another build is that a version mismatch (spooled, or requeued on
// replay). Any other unclassified failure, a defect of this build included, is rethrown unchanged.
async function readInboxGate(
	store: () => StoreStub,
	build: string,
	input: InboxGateInput
): Promise<InboxGate & { refused: MaintenanceReason | null }> {
	try {
		return await callStore(() => store().inboxGate(build, input))
	} catch (error) {
		if (error instanceof StoreUnavailableError) {
			throw error
		}
		let answered: string
		try {
			answered = (await callStore(() => store().version(build))).build
		} catch (versionError) {
			// A Store that cannot answer now is in maintenance, as for any call; anything else leaves the original error.
			throw versionError instanceof StoreUnavailableError ? versionError : error
		}
		throw answered !== build ? new StoreUnavailableError('version-mismatch') : error
	}
}

export function inboxHandler(deps: InboxDeps): Handler<{ Bindings: Env; Variables: { inboxBody: Uint8Array } }> {
	return async (c) => {
		const raw = c.req.raw
		const request = {
			url: raw.url,
			method: raw.method,
			headers: [...raw.headers],
			body: c.get('inboxBody'),
			receivedAt: deps.now(),
		}
		const outcome = await processInbox(c.env, deps, request, 'live')
		return outcome.reason === 'not-set-up' ? notSetUp(c) : c.body(null, outcome.status)
	}
}
