// WebP images built in workerd for the card image suites, with libwebp's own encoder from the pinned @jsquash/webp, and
// its decoder for the tests' stand-in of Images' RGBA output (test/images-binding.ts localRgba, which the media suites
// use too). A devDependency the Worker never bundles: only test files import this module.
import webpDecoderFactory from '@jsquash/webp/codec/dec/webp_dec.js'
import webpDecoderWasm from '@jsquash/webp/codec/dec/webp_dec.wasm'
import webpEncoderFactory from '@jsquash/webp/codec/enc/webp_enc.js'
import webpEncoderWasm from '@jsquash/webp/codec/enc/webp_enc.wasm'
import { defaultOptions } from '@jsquash/webp/meta.js'

import type { Rgba } from '../src/platform/blurhash'

type Encoder = { encode(data: BufferSource, width: number, height: number, options: object): Uint8Array | null }
type Decoder = { decode(data: BufferSource): Rgba | null }

function instantiate<T>(factory: unknown, wasm: WebAssembly.Module): Promise<T> {
	return (factory as (options: object) => Promise<T>)({
		noInitialRun: true,
		instantiateWasm(imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance) => void) {
			const instance = new WebAssembly.Instance(wasm, imports)
			done(instance)
			return {}
		},
	})
}

let encoder: Promise<Encoder> | null = null
let decoder: Promise<Decoder> | null = null

// Deterministic noise (or one colour), so a lossy encoder cannot shrink the image to nothing.
export function rgba(width: number, height: number, fill: 'noise' | 'flat' = 'noise'): Uint8ClampedArray {
	const data = new Uint8ClampedArray(width * height * 4)
	let seed = 0x9e3779b9
	for (let i = 0; i < data.length; i++) {
		if (fill === 'flat') {
			data[i] = i % 4 === 3 ? 255 : 128
			continue
		}
		seed = (seed ^ (seed << 13)) >>> 0
		seed = (seed ^ (seed >>> 17)) >>> 0
		seed = (seed ^ (seed << 5)) >>> 0
		data[i] = seed & 0xff
	}
	return data
}

export async function encodeWebp(
	width: number,
	height: number,
	options: { fill?: 'noise' | 'flat' } = {}
): Promise<Uint8Array> {
	encoder ??= instantiate<Encoder>(webpEncoderFactory, webpEncoderWasm)
	const result = (await encoder).encode(rgba(width, height, options.fill), width, height, {
		...defaultOptions,
		quality: 75,
		method: 0,
		lossless: 0,
	})
	if (result === null) {
		throw new Error('encoding failed')
	}
	return new Uint8Array(result)
}

// The RGBA of a WebP fixture or output; throws when libwebp cannot decode it.
export async function decodeFixture(bytes: Uint8Array): Promise<Rgba> {
	decoder ??= instantiate<Decoder>(webpDecoderFactory, webpDecoderWasm)
	const result = (await decoder).decode(bytes)
	if (result === null) {
		throw new Error('decoding failed')
	}
	return { data: new Uint8ClampedArray(result.data), width: result.width, height: result.height }
}
