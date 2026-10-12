import type { Context } from 'hono'

import { keyOfPath, SERVED_TYPES } from '../platform/media-files'

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
