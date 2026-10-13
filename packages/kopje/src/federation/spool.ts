import { errorFields } from '../platform/error-message'

// Inbox requests received while the Store cannot take them are spooled to the Queue and answered with 202. A request
// must fit one message (no chunking): a larger one is answered 503 and not accepted.

export const INBOX_BODY_LIMIT = 1024 * 1024
// Queue messages are limited to 128 KB; keep room for serialization overhead.
export const SPOOL_MESSAGE_LIMIT = 120 * 1024

// Queue send options of a spool message: v8, so the deflated body travels as bytes.
export const spoolMessageOptions: QueueSendOptions = { contentType: 'v8' }

export type SpoolMessage = {
	kind: 'spool'
	url: string
	method: string
	headers: [string, string][]
	body: Uint8Array // deflated
	spooledAt: number
}

// The body was already read within INBOX_BODY_LIMIT (app/body.ts).
export async function spoolInbox(request: Request, body: Uint8Array, queue: Queue, now: number): Promise<Response> {
	const deflated = await deflate(body)
	const message: SpoolMessage = {
		kind: 'spool',
		url: request.url,
		method: request.method,
		headers: [...request.headers],
		body: deflated,
		spooledAt: now,
	}
	const envelope = new TextEncoder().encode(JSON.stringify({ ...message, body: null })).byteLength
	if (deflated.byteLength + envelope > SPOOL_MESSAGE_LIMIT) {
		return new Response(null, { status: 503 })
	}
	try {
		await queue.send(message, spoolMessageOptions)
	} catch (error) {
		console.error({ event: 'kopje.spool.failed', ...errorFields(error) })
		return new Response(null, { status: 503 })
	}
	return new Response(null, { status: 202 })
}

export async function deflate(body: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([body]).stream().pipeThrough(new CompressionStream('deflate'))
	return new Uint8Array(await new Response(stream).arrayBuffer())
}

export async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))
	return new Uint8Array(await new Response(stream).arrayBuffer())
}

// A spool message as one record of the cutover's rollback journal (inbound_spool, docs/cutover-runbook.md): the
// message as JSON with its deflated body in base64, deflated as a whole. Nothing is lost or reinterpreted, so the
// request can still be verified against the time it was spooled.
export async function encodeSpoolRecord(message: SpoolMessage): Promise<Uint8Array> {
	const json = JSON.stringify({ ...message, body: toBase64(message.body) })
	return deflate(new TextEncoder().encode(json))
}

export async function decodeSpoolRecord(bytes: Uint8Array): Promise<SpoolMessage | null> {
	try {
		const value = JSON.parse(new TextDecoder().decode(await inflate(bytes))) as Record<string, unknown>
		const headers = value.headers
		if (
			value.kind !== 'spool' ||
			typeof value.url !== 'string' ||
			typeof value.method !== 'string' ||
			typeof value.body !== 'string' ||
			typeof value.spooledAt !== 'number' ||
			!Array.isArray(headers) ||
			!headers.every((h) => Array.isArray(h) && h.length === 2 && h.every((part) => typeof part === 'string'))
		) {
			return null
		}
		return {
			kind: 'spool',
			url: value.url,
			method: value.method,
			headers: headers as [string, string][],
			body: fromBase64(value.body),
			spooledAt: value.spooledAt,
		}
	} catch {
		return null
	}
}

function toBase64(bytes: Uint8Array): string {
	let binary = ''
	for (const byte of bytes) {
		binary += String.fromCharCode(byte)
	}
	return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
	return Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
}
