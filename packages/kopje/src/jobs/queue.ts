import { type DeliveryDeps, handleDoorbells } from './deliver'
import { isDeliverMessage } from '../federation/delivery'
import { type InboxDeps, type JobsMessage, processInbox, requestInboundJobs, ringDeliveries } from '../federation/inbox'
import { type SpoolMessage, spoolMessageOptions } from '../federation/spool'
import { readConfig } from '../platform/config'
import { errorFields } from '../platform/error-message'
import { callStore } from '../platform/store-client'
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
			await runJobs(message, env, deps, maintenance)
			continue
		}
		if (!isSpoolMessage(body)) {
			console.error({ event: 'kopje.queue.unknown', id: message.id })
			message.retry({ delaySeconds: QUEUE_RETRY_DELAY_SECONDS })
			continue
		}
		if (maintenance) {
			await requeue(message, body, env.QUEUE)
			continue
		}
		try {
			// The original request, verified against the time it was spooled (OPS-1).
			const outcome = await processInbox(env, deps, {
				url: body.url,
				method: body.method,
				headers: body.headers,
				body: await inflate(body.body),
				receivedAt: body.spooledAt,
			})
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
}

// A round of the Store's inbound jobs. The jobs and their progress are durable in the Store, so this message is only a
// nudge: in maintenance it is dropped without a retry (cron resumes the jobs afterwards), and while jobs remain one
// fresh message asks for the next round.
async function runJobs(message: Message, env: Env, deps: InboxDeps, maintenance: boolean) {
	if (maintenance) {
		message.ack()
		return
	}
	try {
		const { pending, delivers } = await callStore(() =>
			deps.store(env).runInboundJobs(deps.build(env), { now: deps.now() })
		)
		if (delivers) {
			await ringDeliveries(env.QUEUE)
		}
		if (pending) {
			await requestInboundJobs(env.QUEUE)
		}
		message.ack()
	} catch (error) {
		if (error instanceof StoreUnavailableError) {
			message.ack()
			return
		}
		console.error({ event: 'kopje.jobs.failed', id: message.id, ...errorFields(error) })
		message.retry({ delaySeconds: QUEUE_RETRY_DELAY_SECONDS })
	}
}

// Cron: a round of inbound jobs every run, outside maintenance. This is what makes a purge or Move finish even if
// every Queue message about it was lost.
export async function runScheduledJobs(env: Env, deps: InboxDeps): Promise<void> {
	const config = readConfig(env)
	if (!config.ok || config.config.MAINTENANCE !== 'off') {
		return
	}
	try {
		const { pending, delivers } = await callStore(() =>
			deps.store(env).runInboundJobs(deps.build(env), { now: deps.now() })
		)
		if (delivers) {
			await ringDeliveries(env.QUEUE)
		}
		if (pending) {
			await requestInboundJobs(env.QUEUE)
		}
	} catch (error) {
		if (!(error instanceof StoreUnavailableError)) {
			console.error({ event: 'kopje.jobs.failed', ...errorFields(error) })
		}
	}
}

// /setup's Queue check (domain/setup.ts): the probe is marked as received, and acked whatever happens; a probe that
// could not be marked shows as not received, which is what the check reports.
async function consumeProbe(message: Message, id: string, env: Env, deps: InboxDeps): Promise<void> {
	try {
		await callStore(() => deps.store(env).consumeSetupProbe(deps.build(env), { id, now: deps.now() }))
	} catch (error) {
		if (!(error instanceof StoreUnavailableError)) {
			console.error({ event: 'kopje.setup.probe_failed', id: message.id, ...errorFields(error) })
		}
	}
	message.ack()
}

function isSetupProbe(body: unknown): body is { kind: 'setup-probe'; id: string } {
	const m = body as { kind?: unknown; id?: unknown } | null
	return typeof m === 'object' && m !== null && m.kind === 'setup-probe' && typeof m.id === 'string'
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))
	return new Uint8Array(await new Response(stream).arrayBuffer())
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

function isJobsMessage(body: unknown): body is JobsMessage {
	const m = body as Partial<JobsMessage> | null
	return typeof m === 'object' && m !== null && m.kind === 'inbound-jobs'
}

function isSpoolMessage(body: unknown): body is SpoolMessage {
	const m = body as Partial<SpoolMessage> | null
	return typeof m === 'object' && m !== null && m.kind === 'spool' && m.body instanceof Uint8Array
}
