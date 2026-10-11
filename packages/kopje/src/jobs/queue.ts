// Delay before a retried batch comes back. delay x max_retries (100, wrangler.jsonc) is about 50 hours, far longer
// than any maintenance window, so spooled requests are not dropped by the retry limit.
export const QUEUE_RETRY_DELAY_SECONDS = 1800

// In maintenance the queue handler keeps every message for later. B0 has no consumers yet (spool replay and
// delivery come later), so every message is kept the same way.
export function handleQueue(batch: MessageBatch): void {
	batch.retryAll({ delaySeconds: QUEUE_RETRY_DELAY_SECONDS })
}
