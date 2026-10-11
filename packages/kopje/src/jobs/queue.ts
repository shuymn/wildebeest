import { processInbox, type InboxDeps } from '../federation/inbox'
import { type SpoolMessage, spoolMessageOptions } from '../federation/spool'
import { readConfig } from '../platform/config'
import { errorMessage } from '../platform/error-message'
import { StoreUnavailableError } from '../platform/store-errors'

// Delay before a spooled request is offered again while maintenance lasts.
export const SPOOL_REQUEUE_DELAY_SECONDS = 1800
// Delay before a message that failed to process is retried. Retries count against max_retries (wrangler.jsonc).
export const QUEUE_RETRY_DELAY_SECONDS = 60

// Replays spooled inbox requests. While maintenance lasts (env or Store), each one is sent again as a fresh message
// and the original is acked: message.retry() would count against max_retries and drop the request after a long
// enough maintenance. A fresh message also starts a fresh 14-day retention; spooledAt keeps the original time.
// message.retry() is kept for real processing errors.
export async function handleQueue(batch: MessageBatch, env: Env, deps: InboxDeps): Promise<void> {
	const config = readConfig(env)
	// An invalid env counts as maintenance, so nothing is replayed through a misconfigured Worker.
	const maintenance = !config.ok || config.config.MAINTENANCE !== 'off'
	for (const message of batch.messages) {
		const body = message.body
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
			await processInbox(env, deps, body.spooledAt)
			message.ack()
		} catch (error) {
			if (error instanceof StoreUnavailableError) {
				await requeue(message, body, env.QUEUE)
			} else {
				console.error({ event: 'kopje.spool.replay.failed', id: message.id, error: errorMessage(error) })
				message.retry({ delaySeconds: QUEUE_RETRY_DELAY_SECONDS })
			}
		}
	}
}

async function requeue(message: Message, body: SpoolMessage, queue: Queue): Promise<void> {
	try {
		await queue.send(body, { ...spoolMessageOptions, delaySeconds: SPOOL_REQUEUE_DELAY_SECONDS })
		message.ack()
	} catch (error) {
		// The copy was not sent; keep the original instead (this one does count as a retry).
		console.error({ event: 'kopje.spool.requeue.failed', id: message.id, error: errorMessage(error) })
		message.retry({ delaySeconds: QUEUE_RETRY_DELAY_SECONDS })
	}
}

function isSpoolMessage(body: unknown): body is SpoolMessage {
	const m = body as Partial<SpoolMessage> | null
	return typeof m === 'object' && m !== null && m.kind === 'spool' && m.body instanceof Uint8Array
}
