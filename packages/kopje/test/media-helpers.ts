import { env } from 'cloudflare:workers'

import { bearer, type ApiHarness } from './api-helpers'
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
// misbehave: fail with an Images error code, or return given bytes instead of a re-encoding (to inject EXIF).
export class TestCodec implements ImageCodec {
	readonly real = imagesCodec(env.IMAGES)
	infoCalls = 0
	encodeCalls: EncodeOptions[] = []
	failInfo: number | null = null
	failEncode: number | null = null
	encodeResult: Uint8Array | null = null
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
		return this.real.encode(bytes, options)
	}

	get calls(): number {
		return this.infoCalls + this.encodeCalls.length
	}
}
