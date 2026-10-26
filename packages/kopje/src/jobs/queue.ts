import { type DeliveryDeps, handleDoorbells } from './deliver'
import { syncCollections } from '../federation/collections'
import { isDeliverMessage } from '../federation/delivery'
import { type InboxDeps, type JobsMessage, processInbox, requestInboundJobs, ringDeliveries } from '../federation/inbox'
import { verifyQuotes } from '../federation/quotes'
import { encodeSpoolRecord, inflate, spoolDigest, type SpoolMessage, spoolMessageOptions } from '../federation/spool'
import { type Config, readConfig } from '../platform/config'
import { errorFields } from '../platform/error-message'
import { callStore, type StoreStub } from '../platform/store-client'
import { StoreUnavailableError } from '../platform/store-errors'
import { generateRsaKeyPair } from '../security/key-wrap'

// Delay before a spooled request is offered again while maintenance lasts.
export const SPOOL_REQUEUE_DELAY_SECONDS = 1800
// Delay before a message that failed to process is retried. Retries count against max_retries (wrangler.jsonc).
export const QUEUE_RETRY_DELAY_SECONDS = 60

// Replays spooled inbox requests. While maintenance lasts (env or Store), each one is sent again as a fresh message
// and the original is acked: message.retry() would count against max_retries and drop the request after a long
// enough maintenance. A fresh message also starts a fresh 14-day retention; spooledAt keeps the original time.
// message.retry() is kept for real processing errors.
// Delivery doorbells (jobs/deliver.ts) share the Queue; however many a batch holds, they start one round.
// Inbound processing deps beyond the Store default to the platform's own (production passes them all).
export type QueueDeps = Pick<InboxDeps, 'build' | 'store'> &
	Partial<Omit<InboxDeps, 'build' | 'store'>> & { delivery?: Omit<DeliveryDeps, 'build' | 'store'> }

function inboxDepsOf(deps: QueueDeps): InboxDeps {
	return {
		build: deps.build,
		store: deps.store,
		now: deps.now ?? (() => Date.now()),
		keygen: deps.keygen ?? generateRsaKeyPair,
		loader: deps.loader ?? { fetch: (input, init) => fetch(input, init) },
	}
}

export async function handleQueue(batch: MessageBatch, env: Env, queueDeps: QueueDeps): Promise<void> {
	const deps = inboxDepsOf(queueDeps)
	const config = readConfig(env)
	// An invalid env counts as maintenance, so nothing is replayed through a misconfigured Worker.
	const maintenance = !config.ok || config.config.MAINTENANCE !== 'off'
	const doorbells = batch.messages.filter((message) => isDeliverMessage(message.body))
	if (doorbells.length > 0) {
		const delivery = queueDeps.delivery ?? { now: () => Date.now(), fetch: (input, init) => fetch(input, init) }
		await handleDoorbells(doorbells, env, { ...delivery, build: deps.build, store: deps.store })
	}
	// One jobs round per batch, however many jobs messages and replays with pending jobs it holds.
	let wantJobs = false
	for (const message of batch.messages) {
		if (isDeliverMessage(message.body)) {
			continue
		}
		const body = message.body
		if (isSetupProbe(body)) {
			await consumeProbe(message, body.id, env, deps)
			continue
		}
		if (isJobsMessage(body)) {
			// A nudge, never retried: the jobs are durable in the Store, and cron resumes them (RES-5).
			wantJobs = true
			message.ack()
			continue
		}
		if (!isSpoolMessage(body)) {
			console.error({ event: 'kopje.queue.unknown', id: message.id })
			message.retry({ delaySeconds: QUEUE_RETRY_DELAY_SECONDS })
			continue
		}
		// A request a cutover rollback already handed to the legacy instance is never journaled or replayed again, whatever
		// the mode: a copy of it may still be in the Queue (docs/cutover-runbook.md).
		const digest = await spoolDigest(body)
		const handedOff = await handedOffOrUnknown(digest, env, deps)
		if (handedOff === 'error') {
			message.retry({ delaySeconds: QUEUE_RETRY_DELAY_SECONDS })
			continue
		}
		if (handedOff === true) {
			console.log({ event: 'kopje.spool.handed-off', id: message.id })
			message.ack()
			continue
		}
		// A cutover being rolled back: the request goes to the Store's rollback journal, and from there to the legacy
		// instance. If the Store refuses it, it is held in the Queue as in maintenance.
		if (
			config.ok &&
			config.config.CUTOVER_ROLLBACK === 'journal' &&
			(await journal(body, digest, env, deps, config.config))
		) {
			message.ack()
			continue
		}
		if (maintenance || handedOff === null) {
			await requeue(message, body, env.QUEUE)
			continue
		}
		try {
			// The original request, verified against the time it was spooled (OPS-1).
			const outcome = await processInbox(
				env,
				deps,
				{
					url: body.url,
					method: body.method,
					headers: body.headers,
					body: await inflate(body.body),
					receivedAt: body.spooledAt,
				},
				'replay',
				'report'
			)
			if ('jobsPending' in outcome && outcome.jobsPending === true) {
				wantJobs = true
			}
			if (outcome.status === 503) {
				// A remote fetch failed in a way that may pass: try again later (counts as a retry).
				message.retry({ delaySeconds: QUEUE_RETRY_DELAY_SECONDS })
			} else {
				// Done, or refused for good (401, 404, 415): a refused request is dropped, as the live inbox answers it.
				message.ack()
			}
		} catch (error) {
			if (error instanceof StoreUnavailableError) {
				await requeue(message, body, env.QUEUE)
			} else {
				console.error({ event: 'kopje.spool.replay.failed', id: message.id, ...errorFields(error) })
				message.retry({ delaySeconds: QUEUE_RETRY_DELAY_SECONDS })
			}
		}
	}
	// In maintenance the nudges are dropped: cron resumes the jobs afterwards.
	if (wantJobs && !maintenance) {
		await jobsRound(env, deps)
	}
}

type FamilyRound = { pending: boolean; delivers: boolean }

// The Store's families of job rounds, in a jobs round's order, each its own Store call (RES-5).
export const STORE_JOB_FAMILIES: readonly {
	family: string
	run: (store: StoreStub, build: string, input: { now: number }) => Promise<FamilyRound>
}[] = [
	{ family: 'inbound', run: (store, build, input) => store.runInboundJobs(build, input) },
	{ family: 'domain_block_cleanups', run: (store, build, input) => store.runDomainBlockCleanups(build, input) },
	{ family: 'notification_requests', run: (store, build, input) => store.runNotificationRequestJobs(build, input) },
	{ family: 'moderation', run: (store, build, input) => store.runModerationJobs(build, input) },
	{ family: 'unlock_accepts', run: (store, build, input) => store.runUnlockAccepts(build, input) },
]

type Families = readonly { family: string; run: (env: Env, deps: InboxDeps) => Promise<FamilyRound> }[]

// The Store's families as the round calls them. Each call takes a fresh stub, so a failed call leaves none behind for
// the next family.
const STORE_FAMILIES: Families = STORE_JOB_FAMILIES.map(({ family, run }) => ({
	family,
	run: (env, deps) => callStore(() => run(deps.store(env), deps.build(env), { now: deps.now() })),
}))

// The Worker's families, whose rounds await network work.
const WORKER_FAMILIES: Families = [
	{ family: 'collections', run: async (env, deps) => ({ pending: await syncCollections(env, deps), delivers: false }) },
	{ family: 'quotes', run: async (env, deps) => ({ pending: await verifyQuotes(env, deps), delivers: false }) },
]

// Runs each family in turn, each its own error boundary; refused: the Store refused a call, which ends the round.
async function runFamilies(families: Families, env: Env, deps: InboxDeps): Promise<FamilyRound & { refused: boolean }> {
	let pending = false
	let delivers = false
	for (const { family, run } of families) {
		try {
			const result = await run(env, deps)
			pending = pending || result.pending
			delivers = delivers || result.delivers
		} catch (error) {
			if (error instanceof StoreUnavailableError) {
				return { pending: false, delivers, refused: true }
			}
			console.error({ event: 'kopje.jobs.family.failed', family, ...errorFields(error) })
		}
	}
	return { pending, delivers, refused: false }
}

// A round of every job family: the five Store calls (the inbound jobs, domain block cleanups, notification request
// jobs, moderation jobs and unlock acceptances), then the Worker's syncs of remote accounts' collections
// (federation/collections.ts) and verifications of received quotes (federation/quotes.ts), seven error boundaries in
// all. Their work and progress are durable in the Store, so the round is only nudged: one family's failure is logged
// and stops no other; the Store refusing (maintenance, a retryable or reset error) ends the round with nothing counted
// (cron resumes it). The deliveries the Store calls recorded are rung before the network work, and one jobs message
// asks for the next round while any family has work left (RES-5).
export async function jobsRound(env: Env, deps: InboxDeps): Promise<void> {
	const store = await runFamilies(STORE_FAMILIES, env, deps)
	if (store.delivers) {
		await ringDeliveries(env.QUEUE)
	}
	if (store.refused) {
		return
	}
	const worker = await runFamilies(WORKER_FAMILIES, env, deps)
	if (!worker.refused && (store.pending || worker.pending)) {
		await requestInboundJobs(env.QUEUE)
	}
}

// Cron: a jobs round every run, outside maintenance. This is what makes a purge or Move finish, and a sync or a
// verification run, even if every Queue message about it was lost.
export async function runScheduledJobs(env: Env, deps: InboxDeps): Promise<void> {
	const config = readConfig(env)
	if (!config.ok || config.config.MAINTENANCE !== 'off') {
		return
	}
	await jobsRound(env, deps)
}

// /setup's Queue check (domain/setup.ts): the probe is marked as received. A transient Store refusal (maintenance, an
// upgrade) is retried, so a received probe is not reported as lost; any other failure is logged and acked.
async function consumeProbe(message: Message, id: string, env: Env, deps: InboxDeps): Promise<void> {
	try {
		await callStore(() => deps.store(env).consumeSetupProbe(deps.build(env), { id, now: deps.now() }))
	} catch (error) {
		if (error instanceof StoreUnavailableError) {
			message.retry({ delaySeconds: QUEUE_RETRY_DELAY_SECONDS })
			return
		}
		console.error({ event: 'kopje.setup.probe_failed', id: message.id, ...errorFields(error) })
	}
	message.ack()
}

function isSetupProbe(body: unknown): body is { kind: 'setup-probe'; id: string } {
	const m = body as { kind?: unknown; id?: unknown } | null
	return typeof m === 'object' && m !== null && m.kind === 'setup-probe' && typeof m.id === 'string'
}

async function requeue(message: Message, body: SpoolMessage, queue: Queue): Promise<void> {
	try {
		await queue.send(body, { ...spoolMessageOptions, delaySeconds: SPOOL_REQUEUE_DELAY_SECONDS })
		message.ack()
	} catch (error) {
		// The copy was not sent; keep the original instead (this one does count as a retry).
		console.error({ event: 'kopje.spool.requeue.failed', id: message.id, ...errorFields(error) })
		message.retry({ delaySeconds: QUEUE_RETRY_DELAY_SECONDS })
	}
}

// A refused request (the journal at its quota, an import running) stays in the Queue as in maintenance, where it
// counts toward the backlog that bounds spool admission.
// null: the Store cannot tell now (maintenance, an upgrade); the request is held rather than replayed blind. 'error':
// a real failure, retried.
async function handedOffOrUnknown(digest: string, env: Env, deps: InboxDeps): Promise<boolean | null | 'error'> {
	try {
		return await callStore(() => deps.store(env).handedOff(deps.build(env), digest))
	} catch (error) {
		if (error instanceof StoreUnavailableError) {
			return null
		}
		console.error({ event: 'kopje.spool.handoff-check.failed', ...errorFields(error) })
		return 'error'
	}
}

async function journal(
	body: SpoolMessage,
	digest: string,
	env: Env,
	deps: InboxDeps,
	config: Config
): Promise<boolean> {
	try {
		const record = await encodeSpoolRecord(body)
		const limits = { entries: config.CUTOVER_JOURNAL_MAX_ENTRIES, bytes: config.CUTOVER_JOURNAL_MAX_BYTES }
		const result = (await callStore(
			() =>
				deps
					.store(env)
					.journalSpool(deps.build(env), { digest, spooledAt: body.spooledAt, record }, limits) as Promise<unknown>
		)) as { ok: boolean; code?: string }
		if (!result.ok) {
			console.warn({ event: 'kopje.spool.journal.refused', code: result.code })
		}
		return result.ok
	} catch (error) {
		console.error({ event: 'kopje.spool.journal.failed', ...errorFields(error) })
		return false
	}
}

function isJobsMessage(body: unknown): body is JobsMessage {
	const m = body as Partial<JobsMessage> | null
	return typeof m === 'object' && m !== null && m.kind === 'inbound-jobs'
}

function isSpoolMessage(body: unknown): body is SpoolMessage {
	const m = body as Partial<SpoolMessage> | null
	return typeof m === 'object' && m !== null && m.kind === 'spool' && m.body instanceof Uint8Array
}
