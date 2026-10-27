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

// The q an Accept gives a representation (RFC 9110 §12.5.1): that of the most specific range matching it, a range
// with media parameters (more of them more specific) over its bare type/subtype, over type/*, over */*; the first of
// equally specific ranges. 0 when none matches. hono/accepts' matcher ranks by q first and ignores parameters, so
// only Hono's parser (parseAccept) is used.
export function quality(ranges: readonly Accept[], media: MediaType): number {
	const [mediaType, mediaSubtype] = media.type.split('/')
	let best = -1
	let q = 0
	for (const range of ranges) {
		const [type = '', subtype = ''] = range.type.toLowerCase().split('/')
		const params = Object.entries(range.params)
			.map(([name, value]) => [name.toLowerCase(), value.toLowerCase()] as const)
			.filter(([name]) => name !== 'q')
		let specificity: number
		if (type === '*' && subtype === '*') {
			specificity = 0
		} else if (type === mediaType && subtype === '*') {
			specificity = 1
		} else if (type === mediaType && subtype === mediaSubtype) {
			if (!params.every(([name, value]) => media.params[name] === value)) {
				continue
			}
			specificity = 2 + params.length
		} else {
			continue
		}
		if (specificity > best) {
			best = specificity
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
