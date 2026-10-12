import { assertPublicShape, dnsCheckHost, type RequestSigner } from './loader'
import { type DeliveryOutcome, LEASE_MS } from '../domain/deliveries'
import { errorFields } from '../platform/error-message'

// The delivery sink (NET-2, NET-3): one signed POST of one activity to one inbox.
//   - The inbox passes NET-1's host rules (https, no credentials, no literal IP or local name, public addresses by
//     DNS) before every POST, since a stored inbox URL may resolve elsewhere by now.
//   - Redirects are never followed: a 3xx is a failure and retried. Following one would send a non-public body, and
//     its signature, to a target nobody checked (Fedify and Mastodon follow them; Kopje does not).
//   - The body is the stored activity, as application/activity+json (what Mastodon and Fedify send), signed by its
//     author's key with draft-cavage HTTP Signatures and a Digest (Fedify's signRequest via the keyring). Fedify's
//     own sending path (sendActivity, its queue) is not used: it follows redirects and owns retries and keys
//     (test/fedify-usage.test.ts).
//   - The POST, response included, ends after DELIVERY_TIMEOUT_MS, well inside the Store's lease.
//   - The answer is classified as Mastodon's DeliveryWorker does: 2xx delivered; 401, 408, 429, other 4xx is permanent
//     except those three, 501 permanent, any other status or a network error retried. Fedify stops only on 404 and
//     410; Mastodon's wider rule spares servers that refuse an activity for good.
export const DELIVERY_TIMEOUT_MS = 30_000
export const ACTIVITY_CONTENT_TYPE = 'application/activity+json'

if (DELIVERY_TIMEOUT_MS >= LEASE_MS) {
	throw new Error('a delivery must time out before its lease ends')
}

export type PostDeps = {
	fetch: typeof fetch
	checkHost?: (url: URL) => Promise<void>
	userAgent: string
	timeoutMs?: number
}

const SALVAGEABLE_4XX = new Set([401, 408, 429])

export function classifyStatus(status: number): DeliveryOutcome {
	if (status >= 200 && status < 300) {
		return { kind: 'delivered', status }
	}
	if (status >= 300 && status < 400) {
		return { kind: 'failed', status, error: `redirect not followed (HTTP ${status})`, permanent: false }
	}
	const permanent = status === 501 || (status >= 400 && status < 500 && !SALVAGEABLE_4XX.has(status))
	return { kind: 'failed', status, error: `HTTP ${status}`, permanent }
}

class Timeout extends Error {}

export async function postActivity(
	deps: PostDeps,
	inbox: string,
	body: string,
	sign: RequestSigner
): Promise<DeliveryOutcome> {
	let url: URL
	try {
		url = new URL(inbox)
		assertPublicShape(url)
	} catch {
		// Never becomes deliverable: the stored URL itself is refused.
		return { kind: 'failed', status: null, error: 'refused inbox URL', permanent: true }
	}
	try {
		await (deps.checkHost ?? dnsCheckHost)(url)
	} catch {
		// DNS may fail for a while; retried like any transient failure until the attempts run out.
		return { kind: 'failed', status: null, error: 'refused or unresolved host', permanent: false }
	}
	const timeoutMs = deps.timeoutMs ?? DELIVERY_TIMEOUT_MS
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(new Timeout()), timeoutMs)
	const aborted = new Promise<never>((_, reject) => {
		controller.signal.addEventListener('abort', () => reject(controller.signal.reason as Error), { once: true })
	})
	const sending = (async () => {
		const request = await sign(
			new Request(url, {
				method: 'POST',
				headers: { 'content-type': ACTIVITY_CONTENT_TYPE, accept: ACTIVITY_CONTENT_TYPE, 'user-agent': deps.userAgent },
				body,
				redirect: 'manual',
				signal: controller.signal,
			})
		)
		const response = await deps.fetch(request)
		// Only the status matters; the body is not read.
		await response.body?.cancel().catch(() => {})
		return classifyStatus(response.status)
	})()
	sending.catch(() => {})
	try {
		return await Promise.race([sending, aborted])
	} catch (error) {
		if (error instanceof Timeout) {
			return { kind: 'failed', status: null, error: `timed out after ${timeoutMs} ms`, permanent: false }
		}
		// DATA-5: the error class only; a message may carry the URL.
		return { kind: 'failed', status: null, error: `network error (${errorFields(error).error})`, permanent: false }
	} finally {
		clearTimeout(timer)
	}
}

// The Queue message that rings the delivery doorbell. It carries nothing: the Store's deliveries are the work.
export type DeliverMessage = { kind: 'deliver' }

// Queues allow at most 12 hours of delay, which is also the longest retry wait.
export const MAX_DOORBELL_DELAY_SECONDS = 12 * 60 * 60

export async function ringDoorbell(queue: Queue, delaySeconds = 0): Promise<void> {
	const delay = Math.max(0, Math.min(Math.ceil(delaySeconds), MAX_DOORBELL_DELAY_SECONDS))
	const message: DeliverMessage = { kind: 'deliver' }
	await queue.send(message, delay === 0 ? {} : { delaySeconds: delay })
}

export function isDeliverMessage(body: unknown): body is DeliverMessage {
	return typeof body === 'object' && body !== null && (body as { kind?: unknown }).kind === 'deliver'
}
