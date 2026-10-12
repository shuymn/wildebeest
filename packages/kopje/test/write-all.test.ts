import { describe, expect, it } from 'vitest'

import { writeAll } from '../cli/lib/write-all.js'

// A file handle whose write() accepts at most `limit` bytes per call, as a short write would.
function shortHandle(limit: number) {
	const written: number[] = []
	return {
		written,
		write(buffer: Uint8Array, offset: number, length: number) {
			const n = Math.min(limit, length)
			written.push(...buffer.subarray(offset, offset + n))
			return Promise.resolve({ bytesWritten: n })
		},
	}
}

describe('writeAll', () => {
	it('keeps writing after short writes until every byte is written', async () => {
		const handle = shortHandle(2)
		await writeAll(handle, new Uint8Array([1, 2, 3, 4, 5, 6, 7]))
		expect(handle.written).toEqual([1, 2, 3, 4, 5, 6, 7])
	})

	it('fails instead of looping when a write makes no progress', async () => {
		await expect(writeAll(shortHandle(0), new Uint8Array([1]))).rejects.toThrow('no progress')
	})
})
