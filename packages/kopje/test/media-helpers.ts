import { env } from 'cloudflare:workers'

import { bearer, type ApiHarness } from './api-helpers'
import { ANIMATED_WEBP } from './fixtures/images'
import type { User } from './status-helpers'
import {
	type EncodeOptions,
	type ImageCodec,
	ImageCodecError,
	type ImageInfo,
	imagesCodec,
} from '../src/platform/images'

// Media fixtures: base64 fixtures as bytes, multipart uploads, R2 listings, and a codec to stand in for Images.

export function bytes(base64: string): Uint8Array {
	return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
}

export function mediaForm(
	file: Uint8Array | string,
	fields: Record<string, string> = {},
	name = 'photo.jpg',
	type = 'image/jpeg'
): FormData {
	const form = new FormData()
	form.append('file', new File([file], name, { type }))
	for (const [key, value] of Object.entries(fields)) {
		form.append(key, value)
	}
	return form
}

// A multipart form of `parts` in order, repeated names kept.
export function multipartForm(parts: readonly [string, string | File][]): FormData {
	const form = new FormData()
	for (const [name, value] of parts) {
		form.append(name, value)
	}
	return form
}

export type Attachment = {
	id: string
	type: string
	url: string | null
	preview_url: string | null
	description: string | null
	meta: {
		original?: { width: number; height: number; size: string; aspect: number }
		small?: { width: number; height: number }
		focus?: { x: number; y: number }
	} | null
}

export function upload(h: ApiHarness, user: User, form: FormData, version: 'v1' | 'v2' = 'v2'): Promise<Response> {
	return h.request(`/api/${version}/media`, bearer(user.token, { method: 'POST', body: form }))
}

export async function uploaded(h: ApiHarness, user: User, form: FormData): Promise<Attachment> {
	const response = await upload(h, user, form)
	if (response.status !== 200) {
		throw new Error(`upload failed: ${response.status} ${await response.text()}`)
	}
	return response.json()
}

// Every R2 key in the media bucket under a prefix.
export async function r2Keys(prefix = ''): Promise<string[]> {
	const listed = await env.MEDIA.list({ prefix })
	return listed.objects.map((object) => object.key).sort()
}

// The served path of a media URL (https://kopje.test/media/...).
export function pathOf(url: string | null): string {
	if (url === null) {
		throw new Error('no url')
	}
	return new URL(url).pathname
}

// A codec over the local Images binding (Miniflare's, backed by sharp) that records calls and can be told to
// misbehave: fail with an Images error code, or return given bytes instead of a re-encoding (to inject EXIF), for
// every call (encodeResult) or per call (encodeResponder, given the call's options and its 0-based index; null falls
// through to the real binding). Miniflare's binding decodes only the first frame and ignores anim, so an animated
// output is stood in for through these.
export class TestCodec implements ImageCodec {
	readonly real = imagesCodec(env.IMAGES)
	infoCalls = 0
	encodeCalls: EncodeOptions[] = []
	failInfo: number | null = null
	failEncode: number | null = null
	encodeResult: Uint8Array | null = null
	encodeResponder: ((options: EncodeOptions, index: number) => Uint8Array | null) | null = null
	infoResult: ImageInfo | null = null

	info(bytes: Uint8Array): Promise<ImageInfo> {
		this.infoCalls++
		if (this.failInfo !== null) {
			return Promise.reject(new ImageCodecError(this.failInfo, 'injected'))
		}
		if (this.infoResult !== null && this.infoCalls === 1) {
			return Promise.resolve(this.infoResult)
		}
		return this.real.info(bytes)
	}

	encode(bytes: Uint8Array, options: EncodeOptions): Promise<Uint8Array> {
		this.encodeCalls.push(options)
		if (this.failEncode !== null) {
			return Promise.reject(new ImageCodecError(this.failEncode, 'injected'))
		}
		if (this.encodeResult !== null) {
			return Promise.resolve(this.encodeResult)
		}
		const given = this.encodeResponder?.(options, this.encodeCalls.length - 1) ?? null
		if (given !== null) {
			return Promise.resolve(given)
		}
		return this.real.encode(bytes, options)
	}

	get calls(): number {
		return this.infoCalls + this.encodeCalls.length
	}
}

// A TestCodec standing in for Images keeping an animated input's frames: Miniflare's binding decodes one frame only and
// ignores anim (docs/setup.md checks the real one), so every WebP served file (an encode without `still`) is
// ANIMATED_WEBP, and previews and other formats go through the local binding.
export function framesKeepingCodec(): TestCodec {
	const codec = new TestCodec()
	codec.encodeResponder = (options) =>
		options.format === 'image/webp' && options.still !== true ? bytes(ANIMATED_WEBP) : null
	return codec
}

const ascii = (value: string) => new TextEncoder().encode(value)

// A JPEG with one more segment right after its signature (the walker does not check what the segment means).
export function jpegWithSegment(jpeg: Uint8Array, marker: number, payload: Uint8Array | string): Uint8Array {
	const data = typeof payload === 'string' ? ascii(payload) : payload
	const length = data.length + 2
	return new Uint8Array([
		...jpeg.subarray(0, 2),
		0xff,
		marker,
		length >> 8,
		length & 0xff,
		...data,
		...jpeg.subarray(2),
	])
}

// A PNG with one more chunk after IHDR (CRC left zero: decoders are not involved).
export function pngWithChunk(png: Uint8Array, type: string, payload: string): Uint8Array {
	const data = ascii(payload)
	const header = new Uint8Array(8)
	new DataView(header.buffer).setUint32(0, data.length)
	header.set(ascii(type), 4)
	const ihdrEnd = 8 + 25
	return new Uint8Array([...png.subarray(0, ihdrEnd), ...header, ...data, 0, 0, 0, 0, ...png.subarray(ihdrEnd)])
}

// A minimal little-endian TIFF block for an EXIF segment holding one ASCII tag in IFD0 (no GPS IFD).
export function exifWithTag(tag: number, value: string): Uint8Array {
	const text = ascii(`${value}\0`)
	const tiff = new Uint8Array(8 + 2 + 12 + 4 + text.length)
	const view = new DataView(tiff.buffer)
	tiff.set(ascii('II*\0'))
	view.setUint32(4, 8, true)
	view.setUint16(8, 1, true)
	view.setUint16(10, tag, true)
	view.setUint16(12, 2, true)
	view.setUint32(14, text.length, true)
	view.setUint32(18, 26, true)
	tiff.set(text, 26)
	return new Uint8Array([...ascii('Exif\0\0'), ...tiff])
}
