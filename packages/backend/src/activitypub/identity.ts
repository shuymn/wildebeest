import { UA } from '@wildebeest/backend/config/ua'
import { isGone, isNotFound } from '@wildebeest/backend/utils'
import { parseHttpUrl } from '@wildebeest/backend/utils/url'

// The origin that actually served a response. `fetch` follows redirects, so
// this is the origin of the final URL, not of the requested one.
export function servedOrigin(requested: URL, res: Response): string | null {
	// Responses built in tests have no URL; real fetch responses always do.
	if (!res.url) {
		return requested.origin
	}
	return parseHttpUrl(res.url)?.origin ?? null
}

// Fetch the ActivityPub document identified by `id`.
//
// The document is only accepted when it was served by the origin of `id`
// (following a redirect to another origin is refused) and when it claims to be
// `id` itself: a server can never make us use a document under an id that it
// does not own, or under an id other than the one we asked for. Returns null
// when the document is missing or not trustworthy.
export async function fetchDocumentById<T extends { id?: unknown }>(id: URL): Promise<T | null> {
	const res = await fetch(id, {
		headers: {
			accept: 'application/activity+json',
			'User-Agent': UA,
		},
	})
	if (!res.ok) {
		if (isNotFound(res) || isGone(res)) {
			return null
		}
		throw new Error(`${id.toString()} returned: ${res.status}`)
	}

	if (servedOrigin(id, res) !== id.origin) {
		console.warn(`${id.toString()} was served by another origin (${res.url})`)
		return null
	}
	const document = await res.json<T>()
	if (document === null || typeof document !== 'object') {
		return null
	}
	const documentId = parseHttpUrl(document.id instanceof URL ? document.id.toString() : document.id)
	if (documentId === null || documentId.href !== id.href) {
		console.warn(`document fetched from ${id.toString()} claims another id`)
		return null
	}
	return document
}
