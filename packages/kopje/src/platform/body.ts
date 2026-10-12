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
