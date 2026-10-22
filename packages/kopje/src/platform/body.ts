// Reads a request or response body up to a byte limit without buffering more than the limit plus one chunk. A
// declared Content-Length over the limit is refused before reading; otherwise the stream is cancelled as soon as the
// running total passes the limit. Every body read in the app and the document loader goes through here.
export async function readBoundedBody(message: Request | Response, limit: number): Promise<Uint8Array | 'too-large'> {
	const declared = Number(message.headers.get('content-length'))
	if (Number.isFinite(declared) && declared > limit) {
		await message.body?.cancel('body too large')
		return 'too-large'
	}
	if (message.body === null) {
		return new Uint8Array(0)
	}
	const reader = message.body.getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) {
			break
		}
		total += value.byteLength
		if (total > limit) {
			await reader.cancel('body too large')
			return 'too-large'
		}
		chunks.push(value)
	}
	const body = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		body.set(chunk, offset)
		offset += chunk.byteLength
	}
	return body
}

// A body's first `limit` bytes, for a reader that uses a prefix (federation/web-page.ts) rather than refusing what is
// longer. One buffer of limit + 1 bytes is filled in place (a BYOB reader on a byte stream, as native fetch bodies are)
// or by copying each chunk's remaining room (any other stream), so no chunk is retained; the one byte past the limit
// tells an exact-cap body (limitReached false) from a longer one, which is then cancelled. `observed` (at most
// limit + 1) is what was read, after workerd's own Content-Encoding decoding; Content-Length is never consulted. Each
// read goes through `guard` (a deadline or abort race); when it rejects, the stream is cancelled and the rejection
// passes on. Peak memory: the buffer, the returned copy of at most `limit` bytes and, on the copying path, the
// incoming chunk.
export type BodyPrefix = { bytes: Uint8Array; limitReached: boolean; observed: number }

export async function readBodyPrefix(
	body: ReadableStream<Uint8Array> | null,
	limit: number,
	guard: <T>(read: Promise<T>) => Promise<T> = (read) => read
): Promise<BodyPrefix> {
	if (body === null) {
		return { bytes: new Uint8Array(0), limitReached: false, observed: 0 }
	}
	const size = limit + 1
	let buffer = new ArrayBuffer(size)
	let offset = 0
	let byob: ReadableStreamBYOBReader | null = null
	try {
		byob = body.getReader({ mode: 'byob' })
	} catch {
		// Not a byte stream: the copying path below.
	}
	const reader = byob ?? body.getReader()
	try {
		if (byob !== null) {
			while (offset < size) {
				const { done, value } = await guard(byob.read(new Uint8Array(buffer, offset, size - offset)))
				// The view's buffer is detached by every read, the EOF read included: take it back each time.
				if (value === undefined) {
					// Only a stream cancelled elsewhere ends without the view; its bytes went with the buffer.
					throw new TypeError('Body stream was cancelled')
				}
				buffer = value.buffer as ArrayBuffer
				if (done) {
					break
				}
				offset += value.byteLength
			}
		} else {
			const dest = new Uint8Array(buffer)
			const chunks = reader as ReadableStreamDefaultReader<Uint8Array>
			while (offset < size) {
				const { done, value } = await guard(chunks.read())
				if (done) {
					break
				}
				const taken = Math.min(size - offset, value.byteLength)
				dest.set(value.subarray(0, taken), offset)
				offset += taken
			}
		}
	} catch (error) {
		reader.cancel().catch(() => {})
		throw error
	}
	const limitReached = offset > limit
	if (limitReached) {
		reader.cancel('body prefix read').catch(() => {})
	} else {
		reader.releaseLock()
	}
	return { bytes: new Uint8Array(buffer, 0, Math.min(offset, limit)).slice(), limitReached, observed: offset }
}
