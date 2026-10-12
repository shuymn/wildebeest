/* global crypto */
// Client-side half of the dump format (src/platform/dump-format.ts is the Store's half and docs/dump-format.md the
// specification). Plain JS so the CLI runs from node_modules without a build step.

export const HEADER_PREFIX = '-- kopje-dump-header '
export const TRAILER_PREFIX = '-- kopje-dump-trailer '
export const END_LINE = '-- kopje-dump-end'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

/**
 * @typedef {{ size(path: string): Promise<number | null>,
 *   read(path: string, position: number, length: number): Promise<Uint8Array>,
 *   append(path: string, bytes: Uint8Array): Promise<void>,
 *   truncate(path: string, length: number): Promise<void>,
 *   readText(path: string): Promise<string | null>,
 *   writeTextAtomic(path: string, text: string): Promise<void>,
 *   remove(path: string): Promise<void>,
 *   sha256(path: string): Promise<string | null> }} FileIO
 */

/**
 * @typedef {{ header: Record<string, unknown> & { tables: unknown[] }, trailer: Record<string, unknown> & { body: { statements: number, bytes: number, sha256: string } },
 *   bodyStart: number, bodyEnd: number }} DumpFile
 */

const HEAD_PROBE = 4 * 1024 * 1024
const TAIL_PROBE = 4 * 1024 * 1024

/**
 * Locates header, body and trailer of a dump file without reading the body.
 * @param {FileIO} io
 * @param {string} path
 * @returns {Promise<DumpFile>}
 */
export async function readDumpFile(io, path) {
	const size = await io.size(path)
	if (size === null) {
		throw new Error(`${path} does not exist`)
	}
	const head = await io.read(path, 0, Math.min(size, HEAD_PROBE))
	const newline = head.indexOf(0x0a)
	const firstLine = newline === -1 ? '' : decoder.decode(head.subarray(0, newline))
	if (!firstLine.startsWith(HEADER_PREFIX)) {
		throw new Error(`${path} is not a kopje dump (no header line)`)
	}
	const header = JSON.parse(firstLine.slice(HEADER_PREFIX.length))
	// Work on bytes: the probe may start inside a multi-byte character of the body.
	const tailStart = Math.max(newline + 1, size - TAIL_PROBE)
	const tail = await io.read(path, tailStart, size - tailStart)
	const endBytes = encoder.encode(`\n${END_LINE}\n`)
	if (!startsWithAt(tail, endBytes, tail.length - endBytes.length)) {
		throw new Error(`${path} is incomplete: it does not end with "${END_LINE}"`)
	}
	const marker = encoder.encode(`\n${TRAILER_PREFIX}`)
	let lineStart = -1
	for (let i = tail.length - endBytes.length - marker.length; i >= 0; i--) {
		if (startsWithAt(tail, marker, i)) {
			lineStart = i + 1
			break
		}
	}
	if (lineStart === -1 && tailStart === newline + 1 && startsWithAt(tail, encoder.encode(TRAILER_PREFIX), 0)) {
		lineStart = 0
	}
	if (lineStart === -1) {
		throw new Error(`${path} has no trailer`)
	}
	const trailer = JSON.parse(
		decoder.decode(tail.subarray(lineStart + TRAILER_PREFIX.length, tail.length - endBytes.length))
	)
	const bodyEnd = tailStart + lineStart
	return { header, trailer, bodyStart: newline + 1, bodyEnd }
}

/**
 * Splits the statement body of a dump into chunks of whole statements, each at most maxBytes (a single larger
 * statement becomes its own chunk). A statement ends at ";\n" outside a quoted literal; quotes inside literals are
 * doubled, so toggling on every quote byte tracks literal boundaries. Reads the file in blocks.
 * @param {FileIO} io
 * @param {string} path
 * @param {number} start
 * @param {number} end
 * @param {number} maxBytes
 * @returns {AsyncGenerator<{ bytes: Uint8Array, offset: number }>}
 */
export async function* statementChunks(io, path, start, end, maxBytes) {
	const BLOCK = 1024 * 1024
	let chunkStart = start
	// Offset (absolute) just after the last complete statement within the pending bytes.
	let lastBoundary = start
	let inQuote = false
	let previous = 0
	let position = start
	while (position < end) {
		const block = await io.read(path, position, Math.min(BLOCK, end - position))
		for (let i = 0; i < block.length; i++) {
			const byte = block[i] ?? 0
			if (byte === 0x27) {
				inQuote = !inQuote
			} else if (byte === 0x0a && previous === 0x3b && !inQuote) {
				const boundary = position + i + 1
				if (boundary - chunkStart > maxBytes && lastBoundary > chunkStart) {
					yield { bytes: await io.read(path, chunkStart, lastBoundary - chunkStart), offset: chunkStart }
					chunkStart = lastBoundary
				}
				lastBoundary = boundary
			}
			previous = byte
		}
		position += block.length
	}
	if (lastBoundary !== end) {
		throw new Error(`the dump body does not end with a complete statement (at byte ${lastBoundary})`)
	}
	if (end > chunkStart) {
		yield { bytes: await io.read(path, chunkStart, end - chunkStart), offset: chunkStart }
	}
}

/**
 * SHA-256 of a text as UTF-8, in hex.
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function sha256Hex(text) {
	return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
}

/**
 * Chain digest of import chunks: digest_n = hex(sha256(digest_{n-1} || chunk_n)), digest_0 = ''.
 * @param {string} previous
 * @param {Uint8Array} chunk
 * @returns {Promise<string>}
 */
export async function chainDigest(previous, chunk) {
	const prefix = encoder.encode(previous)
	const data = new Uint8Array(prefix.byteLength + chunk.byteLength)
	data.set(prefix, 0)
	data.set(chunk, prefix.byteLength)
	return toHex(await crypto.subtle.digest('SHA-256', data))
}

/**
 * @param {Uint8Array} bytes
 * @param {Uint8Array} pattern
 * @param {number} at
 */
function startsWithAt(bytes, pattern, at) {
	if (at < 0 || at + pattern.length > bytes.length) {
		return false
	}
	for (let i = 0; i < pattern.length; i++) {
		if (bytes[at + i] !== pattern[i]) {
			return false
		}
	}
	return true
}

/** @param {ArrayBuffer} buffer */
function toHex(buffer) {
	return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('')
}

export { encoder as utf8 }
