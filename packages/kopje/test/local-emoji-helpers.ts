import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

import { seedAccount } from './api-helpers'
import { BUILD, completeSetup, migratedStore } from './helpers'
import { TestCodec } from './media-helpers'
import { ACCESS, ADMIN_EMAIL, setAccess } from './ops-helpers'
import { type EmojiUploadResult, uploadEmoji } from '../src/mastodon/emoji-upload'
import type { ImageCodec } from '../src/platform/images'
import type { ImportAuthority } from '../src/platform/store-admin'
import type { StoreStub } from '../src/platform/store-client'
import { randomToken } from '../src/security/tokens'

// Local custom emoji fixtures (migration 0055_local_custom_emojis, domain/local-emojis.ts): PNGs of exact edges and
// bytes, a Store with Access and an OAuth admin, and the production upload path.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n
	for (let k = 0; k < 8; k++) {
		c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
	}
	return c >>> 0
})

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff
	for (const byte of bytes) {
		c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
	}
	return (c ^ 0xffffffff) >>> 0
}

function adler32(bytes: Uint8Array): number {
	let a = 1
	let b = 0
	for (const byte of bytes) {
		a = (a + byte) % 65521
		b = (b + a) % 65521
	}
	return ((b << 16) | a) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length)
	const view = new DataView(out.buffer)
	view.setUint32(0, data.length)
	out.set(new TextEncoder().encode(type), 4)
	out.set(data, 8)
	view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
	return out
}

function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
	let at = 0
	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}
	return out
}

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const STORED_BLOCK = 65_535

function ihdr(width: number, height: number, colorType: number): Uint8Array {
	const data = new Uint8Array(13)
	const view = new DataView(data.buffer)
	view.setUint32(0, width)
	view.setUint32(4, height)
	data.set([8, colorType, 0, 0, 0], 8)
	return chunk('IHDR', data)
}

// A zlib stream of `raw` in stored (uncompressed) deflate blocks: `blocks` of them at least, the extra ones empty.
function storedZlib(raw: Uint8Array, blocks: number): Uint8Array {
	const parts: Uint8Array[] = [new Uint8Array([0x78, 0x01])]
	const needed = Math.max(1, Math.ceil(raw.length / STORED_BLOCK))
	for (let i = 0; i < blocks; i++) {
		const data = i < needed ? raw.subarray(i * STORED_BLOCK, (i + 1) * STORED_BLOCK) : new Uint8Array()
		const header = new Uint8Array(5)
		header[0] = i === blocks - 1 ? 1 : 0
		new DataView(header.buffer).setUint16(1, data.length, true)
		new DataView(header.buffer).setUint16(3, ~data.length & 0xffff, true)
		parts.push(header, data)
	}
	const tail = new Uint8Array(4)
	new DataView(tail.buffer).setUint32(0, adler32(raw))
	parts.push(tail)
	return concat(parts)
}

// A valid RGBA PNG of `width` x `height` pixels (all transparent) of exactly `bytes` bytes: stored deflate blocks, the
// extra ones empty (5 bytes each), the stream split over up to five IDAT chunks (12 bytes each) to reach the length.
export function pngOfBytes(bytes: number, width: number, height: number): Uint8Array {
	const raw = new Uint8Array(height * (1 + 4 * width))
	const needed = Math.max(1, Math.ceil(raw.length / STORED_BLOCK))
	// signature, IHDR, IEND, the zlib header and checksum, one IDAT's framing.
	const fixed = 8 + 25 + 12 + 6 + 12 + raw.length
	for (let idats = 1; idats <= 5; idats++) {
		const rest = bytes - fixed - 12 * (idats - 1)
		if (rest >= 5 * needed && rest % 5 === 0) {
			const stream = storedZlib(raw, rest / 5)
			const step = Math.ceil(stream.length / idats)
			const parts = Array.from({ length: idats }, (_, i) => chunk('IDAT', stream.subarray(i * step, (i + 1) * step)))
			const png = concat([SIGNATURE, ihdr(width, height, 6), ...parts, chunk('IEND', new Uint8Array())])
			if (png.length !== bytes) {
				throw new Error(`built ${png.length} bytes, not ${bytes}`)
			}
			return png
		}
	}
	throw new Error(`no ${width}x${height} PNG of ${bytes} bytes`)
}

// A small, compressed grayscale PNG of `width` x `height` pixels (all black).
export async function pngOf(width: number, height: number): Promise<Uint8Array> {
	const raw = new Uint8Array(height * (1 + width))
	const deflated = new Uint8Array(
		await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer()
	)
	return concat([SIGNATURE, ihdr(width, height, 0), chunk('IDAT', deflated), chunk('IEND', new Uint8Array())])
}

export function base64(bytes: Uint8Array): string {
	let binary = ''
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
	}
	return btoa(binary)
}

// A migrated, set-up Store whose Access admin is ACCESS and whose OAuth admin is the local account `admin` (adminId).
export async function emojiStore(existing?: StoreStub): Promise<{ store: StoreStub; adminId: string }> {
	const store = existing ?? (await migratedStore())
	await setAccess(store)
	await completeSetup(store)
	const adminId = await seedAccount(store, { username: 'admin', email: ADMIN_EMAIL })
	return { store, adminId }
}

export const MONTHLY_TRANSFORMS = 5000

// One emoji upload through the production path (mastodon/emoji-upload.ts), with the given codec (a TestCodec over the
// local Images binding by default) and body fields.
export async function addEmoji(
	store: StoreStub,
	shortcode: string,
	options: {
		image?: Uint8Array
		codec?: ImageCodec
		body?: Record<string, unknown>
		now?: () => number
		token?: string
		monthlyTransforms?: number
		authority?: ImportAuthority
	} = {}
): Promise<EmojiUploadResult> {
	const image = options.image ?? (await pngOf(16, 16))
	return uploadEmoji(
		{
			build: BUILD,
			store,
			bucket: env.MEDIA,
			images: options.codec ?? new TestCodec(),
			now: options.now ?? Date.now,
			authority: options.authority ?? ACCESS,
			monthlyTransforms: options.monthlyTransforms ?? MONTHLY_TRANSFORMS,
			token: options.token ?? randomToken(),
		},
		{ shortcode, image: base64(image), ...options.body }
	)
}

// The emoji of an upload that must succeed.
export async function added(store: StoreStub, shortcode: string, options: Parameters<typeof addEmoji>[2] = {}) {
	const result = await addEmoji(store, shortcode, options)
	if (!result.ok) {
		throw new Error(`emoji upload failed: ${result.code} ${result.message}`)
	}
	return result.emoji
}

// An emoji row inserted as an import would write it (no API): a kept local PNG upload of `owner` with the given meta,
// and its custom_emojis row. Returns the media id and token.
export async function seedEmojiRow(
	store: StoreStub,
	options: {
		id: string
		shortcode: string
		owner: string
		meta?: string | null
		category?: string | null
		disabled?: boolean
		createdAt?: string
		// The stored token and full url (default: a fresh token's url on https://kopje.test).
		token?: string
		url?: string
	}
): Promise<{ id: string; token: string }> {
	const token = options.token ?? randomToken()
	const url = options.url ?? `https://kopje.test/media/${token}/full.png`
	await runInDurableObject(store, (_instance, state) => {
		state.storage.sql.exec(
			`INSERT INTO media_attachments (id, account_id, type, url, preview_url, file_token, content_type, meta,
				processed, gc_at, created_at)
			VALUES (?, ?, 'image', ?, ?, ?, 'image/png', ?, 1, NULL, '2026-10-12T00:00:00.000Z')`,
			options.id,
			options.owner,
			url,
			url.replace(/\/full\.(png|jpg)$/, '/small.png'),
			token,
			options.meta === undefined
				? '{"original":{"width":16,"height":16},"small":{"width":16,"height":16}}'
				: options.meta
		)
		state.storage.sql.exec(
			`INSERT INTO custom_emojis (id, shortcode, category, disabled, created_at) VALUES (?, ?, ?, ?, ?)`,
			options.id,
			options.shortcode,
			options.category ?? null,
			options.disabled === true ? 1 : 0,
			options.createdAt ?? '2026-10-12T00:00:00.000Z'
		)
	})
	return { id: options.id, token }
}

// The most Emoji tags a local status's snapshot resolves to within STATUS_EMOJIS_BYTES (RES-3): every entry's url at
// its shortest (a file token of 32 characters, as an import may hold) and every name at its shortest, so as many
// entries as fit, padded to exactly `bytes` presented bytes by lengthening names. Inserted as an import writes them
// (owner's kept PNG uploads and their emoji rows); the snapshot, as stored.
export async function localSnapshotAtCap(
	store: StoreStub,
	owner: string,
	bytes: number,
	options: { origin?: string; base?: bigint } = {}
): Promise<string> {
	const origin = options.origin ?? 'https://kopje.test'
	const base = options.base ?? 170_000_000_000_000_000n
	const url = (i: number) => `${origin}/media/${`t${i}`.padEnd(32, 'x')}/full.png`
	const entry = (n: number, u: number) => 67 + n + 2 * u
	const u = url(0).length
	const count = Math.min(64, Math.floor((bytes - 1) / entry(2, u)))
	let spare = bytes - 1 - count * entry(2, u)
	const pairs: [string, string][] = []
	for (let i = 0; i < count; i++) {
		const extra = Math.min(126, Math.ceil(spare / (count - i)))
		spare -= extra
		const name = `${i.toString(36).padStart(2, '0')}${'_'.repeat(extra)}`
		pairs.push([name, url(i)])
	}
	await runInDurableObject(store, (_instance, state) => {
		for (const [i, [name, link]] of pairs.entries()) {
			const id = String(base + BigInt(i))
			state.storage.sql.exec(
				`INSERT INTO media_attachments (id, account_id, type, url, preview_url, file_token, content_type, meta,
					processed)
				VALUES (?, ?, 'image', ?, ?, ?, 'image/png', '{"original":{"width":1,"height":1}}', 1)`,
				id,
				owner,
				link,
				link.replace('/full.png', '/small.png'),
				`t${i}`.padEnd(32, 'x')
			)
			state.storage.sql.exec(
				"INSERT INTO custom_emojis (id, shortcode, created_at) VALUES (?, ?, '2026-10-12T00:00:00.000Z')",
				id,
				name
			)
		}
	})
	return JSON.stringify(pairs)
}
