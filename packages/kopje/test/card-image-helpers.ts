import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { BUILD } from './helpers'
import { community, post } from './status-helpers'
import { decodeFixture } from './webp-fixtures'
import { type CardImagesDeps, cardImagesRound } from '../src/federation/card-images'
import { type LinkCardsDeps, linkCardsRound } from '../src/federation/link-cards'
import { imagesCodec } from '../src/platform/images'
import type { StoreOperation } from '../src/platform/store-kernel'

// A community whose card rounds run over routed pages (federation/link-cards.ts), for the card image suites.

// One output() a stand-in binding was asked for: a copy of the input it was given, its transforms and its options.
export type OutputCall = { input: Uint8Array; transforms: ImageTransform[]; options: ImageOutputOptions }

// The chunks of `stream`, read without detaching them.
async function chunksOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
	const chunks: Uint8Array[] = []
	const reader = stream.getReader()
	for (let read = await reader.read(); !read.done; read = await reader.read()) {
		chunks.push(read.value)
	}
	return chunks
}

// The local Images binding (or `binding` over it) with Images' 'rgba' output, which miniflare refuses with 9520: the
// chain's still WebP of the same input and transforms, decoded by the fixture decoder and answered as Images answers
// it, a raw buffer of 4 × w × h bytes as application/octet-stream (federation/card-images.ts I15). The binding is given
// the caller's own chunks, so a test can still see that they are not detached. Every output() is recorded.
export function localRgba(binding: ImagesBinding = env.IMAGES): { binding: ImagesBinding; outputs: OutputCall[] } {
	const outputs: OutputCall[] = []
	const stand = {
		info: (stream: ReadableStream<Uint8Array>) => binding.info(stream),
		input: (stream: ReadableStream<Uint8Array>) => {
			const transforms: ImageTransform[] = []
			const transformer = {
				transform: (options: ImageTransform) => {
					transforms.push(options)
					return transformer
				},
				output: async (options: ImageOutputOptions) => {
					const chunks = await chunksOf(stream)
					outputs.push({ input: new Uint8Array(await new Blob(chunks).arrayBuffer()), transforms, options })
					let real = binding.input(
						new ReadableStream<Uint8Array>({
							start(controller) {
								chunks.forEach((chunk) => controller.enqueue(chunk))
								controller.close()
							},
						})
					)
					for (const transform of transforms) {
						real = real.transform(transform)
					}
					if (options.format !== 'rgba') {
						return real.output(options)
					}
					const webp = await real.output({ format: 'image/webp', anim: false })
					const pixels = await decodeFixture(new Uint8Array(await new Response(webp.image()).arrayBuffer()))
					return { image: () => new Blob([pixels.data]).stream(), contentType: () => 'application/octet-stream' }
				},
			}
			return transformer
		},
	}
	return { binding: stand as unknown as ImagesBinding, outputs }
}

// An Images binding whose info() answers `info` (then `outputInfo`), whose WebP output streams `output` or fails with
// `encodeFail`, and whose RGBA output streams `rgba` (none by default) or fails with `rgbaFail`. Every output() is
// recorded in `outputs`.
export function fakeBinding(options: {
	info?: { format: string; width?: number; height?: number }
	output?: ReadableStream<Uint8Array> | Uint8Array
	infoFail?: number
	outputInfoFail?: number
	encodeFail?: number
	outputInfo?: { format: string; width?: number; height?: number }
	rgba?: ReadableStream<Uint8Array> | Uint8Array
	rgbaFail?: number
}): ImagesBinding & { outputs: OutputCall[] } {
	let infos = 0
	const outputs: OutputCall[] = []
	const fail = (code: number) => Promise.reject(Object.assign(new Error('injected'), { code }))
	const body = (from: ReadableStream<Uint8Array> | Uint8Array | undefined) =>
		from instanceof ReadableStream ? from : new Blob([from ?? new Uint8Array()]).stream()
	const binding = {
		info: () => {
			infos++
			if (options.infoFail !== undefined && infos === 1) {
				return fail(options.infoFail)
			}
			if (options.outputInfoFail !== undefined && infos === 2) {
				return fail(options.outputInfoFail)
			}
			return Promise.resolve(infos === 1 ? options.info : (options.outputInfo ?? options.info))
		},
		input: (stream: ReadableStream<Uint8Array>) => {
			const transforms: ImageTransform[] = []
			const transformer = {
				transform: (transform: ImageTransform) => {
					transforms.push(transform)
					return transformer
				},
				output: async (output: ImageOutputOptions) => {
					const input = new Uint8Array(await new Blob(await chunksOf(stream)).arrayBuffer())
					outputs.push({ input, transforms, options: output })
					if (output.format === 'rgba') {
						return options.rgbaFail !== undefined
							? fail(options.rgbaFail)
							: { image: () => body(options.rgba), contentType: () => 'application/octet-stream' }
					}
					return options.encodeFail !== undefined
						? fail(options.encodeFail)
						: { image: () => body(options.output), contentType: () => 'image/webp' }
				},
			}
			return transformer
		},
	}
	return Object.assign(binding as unknown as ImagesBinding, { outputs })
}

type Route = (request: Request) => Response | Promise<Response>

const HTML = { 'content-type': 'text/html; charset=utf-8' }

// A page whose card names `image` (og:image) and its alt text.
export const pageWith =
	(image: string, alt = '') =>
	() =>
		new Response(
			`<html><head><title>Title</title><meta property="og:image" content="${image}"><meta property="og:image:alt" content="${alt}"></head></html>`,
			{ headers: HTML }
		)

type CardRow = {
	status_id: string
	image_url: string
	image_id: string | null
	image_description: string
	fetched_at: number | null
}

type ImageRow = {
	id: string
	source_url: string
	due_at: number | null
	enqueued_at: number
	claim: number
	attempts: number
	token: string | null
	width: number | null
	height: number | null
	blurhash: string | null
	stored_at: number | null
}

export async function cardWorld(overrides: Record<string, unknown> = {}) {
	const h = await community(['alice'], 'read write follow', {}, overrides)
	const { alice } = h.users
	const clock = { t: NOW }
	h.now.mockImplementation(() => clock.t)
	const requests: string[] = []
	let routes: Record<string, Route> = {}
	const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(input, init)
		requests.push(`${request.method} ${request.url}`)
		const route = routes[request.url]
		return Promise.resolve(route === undefined ? new Response('missing', { status: 404 }) : route(request))
	}
	const deps = (): LinkCardsDeps => ({
		build: () => BUILD,
		store: () => h.store,
		now: () => clock.t,
		keygen: () => Promise.reject(new Error('no keys')),
		loader: { fetch, checkHost: () => Promise.resolve() },
	})
	let tokens = 0
	const imageDeps = (extra: Partial<CardImagesDeps> = {}): CardImagesDeps => ({
		...deps(),
		images: () => imagesCodec(localRgba().binding),
		randomToken: () => `k${String(++tokens).padStart(42, '0')}`,
		...extra,
	})
	const op = <I, O>(operation: StoreOperation<I, O>, input: I) =>
		runInDurableObject(h.store, (_instance, s) => operation.run(s.storage.sql, input))
	return {
		h,
		alice,
		clock,
		requests,
		fetch,
		op,
		addRoutes: (more: Record<string, Route>) => {
			routes = { ...routes, ...more }
		},
		cardRound: () => linkCardsRound(h.env as unknown as Env, deps()),
		imageDeps,
		imageRound: (extra: Partial<CardImagesDeps> = {}, env: Record<string, unknown> = {}) =>
			cardImagesRound({ ...h.env, ...env } as unknown as Env, imageDeps(extra)),
		postLink: async (url: string) => (await post(h, alice, { status: `see ${url}` })).id,
		card: async (id: string) =>
			(
				await sql<CardRow>(
					h.store,
					'SELECT status_id, image_url, image_id, image_description, fetched_at FROM status_cards WHERE status_id = ?',
					id
				)
			)[0],
		images: () => sql<ImageRow>(h.store, 'SELECT * FROM card_images ORDER BY id'),
		orphans: () =>
			sql<{ file_token: string; media_id: string; delete_after: string }>(
				h.store,
				'SELECT file_token, media_id, delete_after FROM media_orphans ORDER BY delete_after, file_token'
			),
	}
}

export type CardWorld = Awaited<ReturnType<typeof cardWorld>>
