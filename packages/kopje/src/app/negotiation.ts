import type { RouterRoute } from 'hono/types'
import { type Accept, parseAccept } from 'hono/utils/accept'

// Content negotiation between the web pages and the documents served at the same paths, and between app.ts's error
// pages and the API's error answers.

// An ActivityPub client asks for the object, a browser for the page (content negotiation on /@user and /@user/:id).
export function wantsActivityPub(accept: string | undefined): boolean {
	return accept !== undefined && /application\/(activity\+json|ld\+json)/i.test(accept)
}

// A representation offered: its type and parameters, in lower case.
export type MediaType = { type: string; params: Readonly<Record<string, string>> }

export const HTML: MediaType = { type: 'text/html', params: { charset: 'utf-8' } }
export const PLAIN_TEXT: MediaType = { type: 'text/plain', params: { charset: 'utf-8' } }
export const JSON_TYPE: MediaType = { type: 'application/json', params: {} }

// A qvalue as RFC 9110 §12.4.2 writes it: 0 to 1 with at most three decimals.
const QVALUE = /^(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/

// The q an Accept gives a representation (RFC 9110 §12.5.1): that of the most specific range matching it. A range
// matches when its type does (*/*, type/*, or type/subtype) and each of its media parameters (those before its q; the
// rest are accept-ext) equals the representation's, a wildcard's included; the most specific is the one of the most
// specific type, then of the most parameters, the first of equals. A range whose q is not a qvalue is malformed and
// matches nothing: Hono's parser reads it as 1, and neither 1 nor 0 is what the client wrote, so it is left out like
// any other range the header cannot express. 0 when none matches. hono/accepts' matcher ranks by q first and ignores
// parameters, so only Hono's parser (parseAccept) is used.
export function quality(ranges: readonly Accept[], media: MediaType): number {
	const [mediaType, mediaSubtype] = media.type.split('/')
	let best: [number, number] = [-1, -1]
	let q = 0
	for (const range of ranges) {
		const [type = '', subtype = ''] = range.type.toLowerCase().split('/')
		const entries = Object.entries(range.params).map(([name, value]) => [name.toLowerCase(), value] as const)
		const at = entries.findIndex(([name]) => name === 'q')
		if (at !== -1 && !QVALUE.test(entries[at]![1].trim())) {
			continue
		}
		const params = at === -1 ? entries : entries.slice(0, at)
		const rank =
			type === '*' && subtype === '*'
				? 0
				: type === mediaType && subtype === '*'
					? 1
					: type === mediaType && subtype === mediaSubtype
						? 2
						: -1
		if (rank === -1 || !params.every(([name, value]) => media.params[name] === value.toLowerCase())) {
			continue
		}
		if (rank > best[0] || (rank === best[0] && params.length > best[1])) {
			best = [rank, params.length]
			q = range.q
		}
	}
	return q
}

// Whether a negotiated answer is the page: the Accept gives HTML a higher q than the document (so above 0), and asks
// for no ActivityPub document. A tie, and a request without Accept, keep the document.
export function prefersPage(accept: string | undefined, document: MediaType): boolean {
	if (accept === undefined || wantsActivityPub(accept)) {
		return false
	}
	const ranges = parseAccept(accept)
	return quality(ranges, HTML) > quality(ranges, document)
}

export function isRead(method: string): boolean {
	return method === 'GET' || method === 'HEAD'
}

// The namespaces of documents, never pages: the APIs (the admin API's included), the OAuth endpoints other than the
// consent page, the well-known and NodeInfo documents, ActivityPub (/ap, /actor, /inbox, /users, /emojis), media,
// assets and health. A path no route serves there keeps its plain 404.
const DOCUMENT_PATHS =
	/^\/(?:api|admin|ap|actor|inbox|users|emojis|nodeinfo|media|assets|health|\.well-known)(?:\/|$)|^\/oauth\/(?!authorize$)/

export function documentPath(path: string): boolean {
	return DOCUMENT_PATHS.test(path)
}

// The GET routes of the routers that serve pages; a request one of them matched is a page's, whatever the handler that
// failed (a route's path as app.route('/', router) mounts it).
export function pageRoutes(
	routers: readonly { routes: readonly RouterRoute[] }[]
): (matched: readonly RouterRoute[]) => boolean {
	const paths = new Set(routers.flatMap((router) => router.routes.filter((r) => r.method === 'GET').map((r) => r.path)))
	return (matched) => matched.some((route) => route.method === 'GET' && paths.has(route.path))
}
