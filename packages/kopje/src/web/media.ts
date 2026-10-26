import type { Context } from 'hono'

import { keyOfPath, keyOfRemotePath, REMOTE_SERVED_TYPES, SERVED_TYPES } from '../platform/media-files'

// GET /media/<token>/<full|small>.<ext>: the re-encoded files of local uploads, from R2.
//
//   - The URL is a capability: the token is 32 random bytes the Store holds (accepted risk "non-public media is
//     readable by anyone who holds its unguessable URL"). Media of private and direct statuses is served the same way;
//     the URL is shown only to viewers who may see the status (VIS-1), and deleting the media deletes the files.
//   - Only files/<token>/<variant> keys can be read; originals are never served (MEDIA-2).
//   - The type comes from the stored object and must be one of SERVED_TYPES (raster images only); anything else is
//     refused, never sent as stored. nosniff and a sandboxing CSP keep a file from running as instance content
//     (MEDIA-4).
//
// The Store is not consulted, so serving works in maintenance and does not load the Store.

export const MEDIA_ROUTE = '/media/:token/:file'

const NOT_FOUND = () =>
	new Response('Not Found', {
		status: 404,
		headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' },
	})

export async function serveMedia(c: Context<{ Bindings: Env }>): Promise<Response> {
	const path = keyOfPath(c.req.param('token') ?? '', c.req.param('file') ?? '')
	if (path === null) {
		return NOT_FOUND()
	}
	const object = await c.env.MEDIA.get(path.key)
	if (object === null) {
		return NOT_FOUND()
	}
	const type = object.httpMetadata?.contentType ?? ''
	if (SERVED_TYPES.get(type) !== path.extension) {
		await object.body.cancel()
		console.error({ event: 'kopje.media.type_refused' })
		return NOT_FOUND()
	}
	return new Response(object.body, {
		headers: {
			'content-type': type,
			'content-length': String(object.size),
			etag: object.httpEtag,
			// A token names one set of files for good: they are replaced only by a new upload with a new token.
			'cache-control': 'public, max-age=31536000, immutable',
			'x-content-type-options': 'nosniff',
			'content-security-policy': "default-src 'none'; sandbox",
			'cross-origin-resource-policy': 'cross-origin',
			'access-control-allow-origin': '*',
		},
	})
}

// GET and HEAD /media/r/<token>/<full|still>.<ext>: the cache of remote media (domain/remote-media.ts, MEDIA-7), from
// R2, with no Store read (it works in maintenance).
//
//   - The URL is a capability: the token is 32 random bytes the Store drew at a claim.
//   - Only remote/<token>/<variant> keys can be read (keyOfRemotePath).
//   - The stored type must be one of REMOTE_SERVED_TYPES and be the one the extension names; anything else is refused
//     (404, its body cancelled). nosniff and the sandboxing CSP keep a file inert on the instance origin (MEDIA-4).
//   - One range (a-b, a- or -n) answers 206 with its Content-Range, an unsatisfiable one 416; a malformed or
//     multi-part range answers 200 with the whole file. If-Range is ignored (a token's files never change); a matching
//     If-None-Match answers 304.

export const REMOTE_MEDIA_ROUTE = '/media/r/:token/:file'

type ByteRange = { offset: number; length?: number } | { suffix: number }

// One byte range of a Range header (RFC 9110 section 14.1.2), or null for none, a malformed one or several.
export function byteRange(header: string | null): ByteRange | null {
	const match = header === null ? null : /^bytes=(\d{0,16})-(\d{0,16})$/.exec(header.trim())
	if (match === null) {
		return null
	}
	const [, first = '', last = ''] = match
	if (first === '' && last === '') {
		return null
	}
	if (first === '') {
		return { suffix: Number(last) }
	}
	const offset = Number(first)
	if (last === '') {
		return { offset }
	}
	const end = Number(last)
	return end < offset ? null : { offset, length: end - offset + 1 }
}

function remoteHeaders(object: R2Object, type: string): Headers {
	return new Headers({
		'content-type': type,
		etag: object.httpEtag,
		'accept-ranges': 'bytes',
		'cache-control': 'public, max-age=31536000, immutable',
		'x-content-type-options': 'nosniff',
		'content-security-policy': "default-src 'none'; sandbox",
		'cross-origin-resource-policy': 'cross-origin',
		'access-control-allow-origin': '*',
	})
}

// Whether `range` selects no byte of an object of `size` bytes (RFC 9110 §14.1.1): an empty suffix, or a first byte
// past the end.
function unsatisfiable(range: R2Range, size: number): boolean {
	if ('suffix' in range) {
		return range.suffix === 0
	}
	return (range.offset ?? 0) >= size
}

// If-None-Match against the object's tag (RFC 9110 §13.1.2): `*`, or a list of tags any of which equals it by the
// weak comparison (a W/ prefix ignored on either side).
export function noneMatchHolds(header: string, tag: string): boolean {
	const opaque = (value: string) => value.trim().replace(/^W\//, '')
	if (header.trim() === '*') {
		return true
	}
	return header.split(',').some((candidate) => candidate.trim() !== '' && opaque(candidate) === opaque(tag))
}

export async function serveRemoteMedia(c: Context<{ Bindings: Env }>): Promise<Response> {
	const path = keyOfRemotePath(c.req.param('token') ?? '', c.req.param('file') ?? '')
	if (path === null) {
		return NOT_FOUND()
	}
	const bucket = c.env.MEDIA
	const head = c.req.method === 'HEAD'
	const etag = c.req.header('if-none-match')
	const range = head ? null : byteRange(c.req.header('range') ?? null)
	let object: R2Object | null
	try {
		if (range !== null && 'suffix' in range && range.suffix === 0) {
			throw new RangeError('an empty suffix range')
		}
		object = head
			? await bucket.head(path.key)
			: await bucket.get(path.key, {
					...(range === null ? {} : { range }),
					...(etag === undefined ? {} : { onlyIf: new Headers({ 'if-none-match': etag }) }),
				})
	} catch (error) {
		// R2 refuses an unsatisfiable range: confirmed against the size, from a head of the object. Any other failure is
		// the bucket's, and answers as one.
		if (range === null) {
			throw error
		}
		const found = await bucket.head(path.key)
		if (found === null || !typeAllowed(found, path.extension)) {
			return NOT_FOUND()
		}
		if (!unsatisfiable(range, found.size)) {
			throw error
		}
		const headers = remoteHeaders(found, found.httpMetadata?.contentType ?? '')
		headers.set('content-range', `bytes */${found.size}`)
		return new Response(null, { status: 416, headers })
	}
	if (object === null) {
		return NOT_FOUND()
	}
	const body = hasBody(object) ? object.body : null
	if (!typeAllowed(object, path.extension)) {
		await body?.cancel()
		console.warn({ event: 'kopje.remote_media.type_refused' })
		return NOT_FOUND()
	}
	const headers = remoteHeaders(object, object.httpMetadata?.contentType ?? '')
	// A GET whose If-None-Match matched gets no body back (onlyIf); a HEAD compares the tag itself, as R2 does.
	if (body === null && etag !== undefined && (!head || noneMatchHolds(etag, object.httpEtag))) {
		return new Response(null, { status: 304, headers })
	}
	if (body === null) {
		headers.set('content-length', String(object.size))
		return new Response(null, { headers })
	}
	const served = object.range
	if (range !== null && served !== undefined && 'offset' in served && served.offset !== undefined) {
		const length = served.length ?? object.size - served.offset
		headers.set('content-length', String(length))
		headers.set('content-range', `bytes ${served.offset}-${served.offset + length - 1}/${object.size}`)
		return new Response(body, { status: 206, headers })
	}
	headers.set('content-length', String(object.size))
	return new Response(body, { headers })
}

function hasBody(object: R2Object): object is R2ObjectBody {
	return 'body' in object
}

// Whether the object's stored type is a served remote type and the one `extension` names.
function typeAllowed(object: R2Object, extension: string): boolean {
	return REMOTE_SERVED_TYPES.get(object.httpMetadata?.contentType ?? '') === extension
}
