// Inbox requests received while the Store cannot take them are spooled to the Queue and answered with 202.
// B0 handles requests that fit one message; splitting into inbound_spool parts and replay come later.

export const INBOX_BODY_LIMIT = 1024 * 1024
// Queue messages are limited to 128 KB; keep room for serialization overhead.
export const SPOOL_MESSAGE_LIMIT = 120 * 1024

export type SpoolMessage = {
	kind: 'spool'
	url: string
	method: string
	headers: [string, string][]
	body: Uint8Array // deflated
	spooledAt: number
}

export async function spoolInbox(request: Request, body: ArrayBuffer, queue: Queue, now: number): Promise<Response> {
	if (body.byteLength > INBOX_BODY_LIMIT) {
		return new Response(null, { status: 413 })
	}
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
		await queue.send(message, { contentType: 'v8' })
	} catch (error) {
		console.error({ event: 'kopje.spool.failed', error: error instanceof Error ? error.message : String(error) })
		return new Response(null, { status: 503 })
	}
	return new Response(null, { status: 202 })
}

async function deflate(body: ArrayBuffer): Promise<Uint8Array> {
	const stream = new Blob([body]).stream().pipeThrough(new CompressionStream('deflate'))
	return new Uint8Array(await new Response(stream).arrayBuffer())
}
