import { describe, expect, it } from 'vitest'

import { trackedStream } from './stream-helpers'
import { readBodyPrefix } from '../src/platform/body'

// A byte stream over `chunks` that records whether each pull came with a BYOB request.
function byteStream(chunks: Uint8Array[]) {
	const state = { byobPulls: 0, cancelled: false }
	let index = 0
	const stream = new ReadableStream({
		type: 'bytes',
		pull(controller) {
			const chunk = chunks[index++]
			const request = controller.byobRequest
			if (chunk === undefined) {
				controller.close()
				request?.respond(0)
				return
			}
			if (request?.view) {
				state.byobPulls++
				const view = new Uint8Array(request.view.buffer, request.view.byteOffset, request.view.byteLength)
				const taken = Math.min(view.byteLength, chunk.byteLength)
				view.set(chunk.subarray(0, taken))
				request.respond(taken)
				if (taken < chunk.byteLength) {
					chunks.splice(index, 0, chunk.subarray(taken))
				}
			} else {
				controller.enqueue(chunk)
			}
		},
		cancel() {
			state.cancelled = true
		},
	})
	return { stream, state }
}

const bytes = (n: number, fill = 0x61) => new Uint8Array(n).fill(fill)

describe('readBodyPrefix', () => {
	it('reads a body of exactly the limit as complete, and one byte more as reaching it', async () => {
		const exact = await readBodyPrefix(trackedStream([bytes(6), bytes(4)]).stream, 10)
		expect(exact).toMatchObject({ limitReached: false, observed: 10 })
		expect(exact.bytes).toEqual(bytes(10))
		const over = trackedStream([bytes(6), bytes(5), bytes(100)])
		const longer = await readBodyPrefix(over.stream, 10)
		expect(longer).toMatchObject({ limitReached: true, observed: 11 })
		expect(longer.bytes).toEqual(bytes(10))
	})

	it('keeps no incoming chunk or larger buffer: the prefix has a buffer of its own length', async () => {
		const backing = new Uint8Array(8 * 1024 * 1024).fill(0x62)
		const { bytes: prefix } = await readBodyPrefix(trackedStream([backing.subarray(0, 4096)]).stream, 1024)
		expect(prefix.byteLength).toBe(1024)
		expect(prefix.buffer.byteLength).toBe(1024)
		const short = await readBodyPrefix(trackedStream([backing.subarray(0, 100)]).stream, 1024)
		expect(short.bytes.buffer.byteLength).toBe(100)
	})

	it('cancels the stream at the limit and pulls nothing after', async () => {
		const { stream, state } = trackedStream([bytes(8), bytes(8), bytes(8), bytes(8)])
		const result = await readBodyPrefix(stream, 10)
		expect(result.limitReached).toBe(true)
		await Promise.resolve()
		expect(state.cancelled).toBe(true)
		const pulls = state.pulls
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(state.pulls).toBe(pulls)
		expect(pulls).toBeLessThanOrEqual(3)
	})

	it('reads a byte stream with a BYOB reader into its own buffer', async () => {
		const { stream, state } = byteStream([bytes(3), bytes(20, 0x63)])
		const result = await readBodyPrefix(stream, 10)
		expect(state.byobPulls).toBeGreaterThan(0)
		expect(result).toMatchObject({ limitReached: true, observed: 11 })
		expect([...result.bytes]).toEqual([...bytes(3), ...bytes(7, 0x63)])
		expect(result.bytes.buffer.byteLength).toBe(10)
		expect(state.cancelled).toBe(true)
	})

	it('takes the buffer back from the EOF read of a BYOB reader', async () => {
		const { stream } = byteStream([bytes(4)])
		const result = await readBodyPrefix(stream, 10)
		expect(result).toMatchObject({ limitReached: false, observed: 4 })
		expect(result.bytes).toEqual(bytes(4))
	})

	it('reads a native Response body (a byte stream) through the BYOB path', async () => {
		expect(() => new Response('x').body?.getReader({ mode: 'byob' })).not.toThrow()
		const result = await readBodyPrefix(new Response(bytes(5000)).body, 4096)
		expect(result).toMatchObject({ limitReached: true, observed: 4097 })
		expect(result.bytes.byteLength).toBe(4096)
		const exact = await readBodyPrefix(new Response(bytes(4096)).body, 4096)
		expect(exact).toMatchObject({ limitReached: false, observed: 4096 })
	})

	it('waits past an exact-cap prefix for EOF, and a guard that gives up cancels the stream', async () => {
		const { stream, state } = trackedStream([bytes(10)], true)
		let reads = 0
		const guard = <T>(read: Promise<T>): Promise<T> => {
			reads++
			return reads === 1 ? read : Promise.reject(new Error('deadline'))
		}
		await expect(readBodyPrefix(stream, 10, guard)).rejects.toThrow('deadline')
		await Promise.resolve()
		expect(state.cancelled).toBe(true)
	})

	it('returns a view over its one buffer with copy: false, on both paths, and the same bytes', async () => {
		for (const make of [
			() => trackedStream([bytes(6), bytes(6)]).stream,
			() => byteStream([bytes(6), bytes(6)]).stream,
		]) {
			const view = await readBodyPrefix(make(), 10, undefined, { copy: false })
			const copied = await readBodyPrefix(make(), 10)
			expect(view).toMatchObject({ limitReached: true, observed: 11 })
			expect([...view.bytes]).toEqual([...copied.bytes])
			expect(view.bytes.byteLength).toBe(10)
			expect(view.bytes.buffer.byteLength).toBe(11)
			expect(copied.bytes.buffer.byteLength).toBe(10)
		}
	})

	it('reads an absent body as empty', async () => {
		expect(await readBodyPrefix(null, 10)).toEqual({ bytes: new Uint8Array(0), limitReached: false, observed: 0 })
	})
})
