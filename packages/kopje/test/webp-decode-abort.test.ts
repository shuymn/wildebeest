import { describe, expect, it } from 'vitest'

import { encodeWebp } from './webp-fixtures'
import { DECODER_MEMORY_BYTES, decoderState, decodeWebp } from '../src/platform/webp-decode'

// Its own file: the decoder it spends stays spent for the isolate, as in production.
describe('a decoder abort (AM16)', () => {
	it('answers null and spends the decoder, which is never instantiated again', async () => {
		expect((await decodeWebp(await encodeWebp(3, 3)))?.width).toBe(3)
		// Larger than the capped heap: libwebp's input copy cannot be allocated, and the glue aborts.
		expect(await decodeWebp(new Uint8Array(DECODER_MEMORY_BYTES + 1))).toBeNull()
		expect(await decoderState()).toEqual({ memoryBytes: null, spent: true })
		expect(await decodeWebp(await encodeWebp(3, 3))).toBeNull()
	})
})
