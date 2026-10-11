import { parseHttpUrl } from '@wildebeest/backend/utils/url'

// Fetch a remote document by URL and make sure the origin it was served from
// may speak for its `id`.
//
// A document served from the origin of its `id` is accepted. Otherwise, the
// document is refetched from its `id`, and that copy is only accepted when it
// claims the same `id`: a server can never make us cache a document under an
// id of another origin. Returns null when no trustworthy copy exists.
export async function fetchWithIdentity<T extends { id?: unknown }>(
	url: URL,
	fetchDocument: (url: URL) => Promise<T | null>
): Promise<T | null> {
	const document = await fetchDocument(url)
	if (document === null) {
		return null
	}
	const id = documentId(document)
	if (id === null) {
		console.warn(`document fetched from ${url.toString()} has no valid id`)
		return null
	}
	if (id.origin === url.origin) {
		return document
	}

	const refetched = await fetchDocument(id)
	if (refetched === null) {
		return null
	}
	if (documentId(refetched)?.toString() !== id.toString()) {
		console.warn(`document ${id.toString()} is not served by its own origin`)
		return null
	}
	return refetched
}

function documentId(document: { id?: unknown }): URL | null {
	return parseHttpUrl(document.id)
}
