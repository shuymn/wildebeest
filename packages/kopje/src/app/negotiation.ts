import type { RouterRoute } from 'hono/types'

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

// A media range of an Accept: its type and subtype and its media parameters, names in lower case, and its q.
export type MediaRange = { type: string; subtype: string; params: readonly (readonly [string, string])[]; q: number }

// `text` cut at each `separator` outside a quoted-string (RFC 9110 §5.6.4, with its backslash escapes).
function split(text: string, separator: string): string[] {
	const parts: string[] = []
	let start = 0
	let quoted = false
	for (let i = 0; i < text.length; i++) {
		const char = text[i]
		if (quoted && char === '\\') {
			i++
		} else if (char === '"') {
			quoted = !quoted
		} else if (!quoted && char === separator) {
			parts.push(text.slice(start, i))
			start = i + 1
		}
	}
	parts.push(text.slice(start))
	return parts
}

// RFC 9110 §5.6.2's token, §5.6.4's quoted-string (qdtext and quoted-pair as Latin-1 code units, as a header value
// reaches the Worker) and §5.6.6's parameter: a token name, "=" with no whitespace around it, and a token or
// quoted-string value.
const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+"
const QUOTED = '"(?:[\\t \\x21\\x23-\\x5b\\x5d-\\x7e\\x80-\\xff]|\\\\[\\t \\x20-\\x7e\\x80-\\xff])*"'
const MEDIA_RANGE = new RegExp(`^(${TOKEN})/(${TOKEN})$`)
const PARAMETER = new RegExp(`^(${TOKEN})=(${TOKEN}|${QUOTED})$`)

// HTTP's optional whitespace (RFC 9110 §5.6.3): spaces and tabs only, never other Unicode whitespace.
function trimOws(text: string): string {
	return text.replace(/^[ \t]+|[ \t]+$/g, '')
}

// A parameter's value: a token as written, or a quoted-string's content unescaped.
function parameterValue(raw: string): string {
	return raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, '$1') : raw
}

// The media ranges of an Accept header (RFC 9110 §12.5.1), in their order. q may stand anywhere among a range's
// parameters (RFC 9110 dropped accept-ext, and recipients still read q where they find it); every other parameter is a
// media parameter. A range that cannot be read (a type or subtype that is not a token, a parameter that is not
// §5.6.6's, a q that is not one qvalue: empty, out of range, past three decimals, quoted or repeated) is left out:
// neither 1 nor 0 is what the client wrote, so it counts like any other range the header cannot express. Hono's
// parser (hono/utils/accept) reads such a q as 1 and drops a parameter it cannot read, so it is not used.
export function parseAccept(accept: string): MediaRange[] {
	const ranges: MediaRange[] = []
	for (const part of split(accept, ',')) {
		const [media = '', ...rest] = split(part, ';').map(trimOws)
		if (media === '' && rest.length === 0) {
			continue
		}
		const match = MEDIA_RANGE.exec(media)
		const params: [string, string][] = []
		let q: number | null = null
		let readable = match !== null
		for (const piece of rest) {
			if (piece === '' || !readable) {
				continue
			}
			const parameter = PARAMETER.exec(piece)
			const name = parameter?.[1]?.toLowerCase()
			const raw = parameter?.[2] ?? ''
			if (name === undefined) {
				readable = false
			} else if (name !== 'q') {
				params.push([name, parameterValue(raw)])
			} else if (q !== null || !QVALUE.test(raw)) {
				readable = false
			} else {
				q = Number(raw)
			}
		}
		if (readable && match !== null) {
			ranges.push({ type: match[1]!.toLowerCase(), subtype: match[2]!.toLowerCase(), params, q: q ?? 1 })
		}
	}
	return ranges
}

// Whether a range's media parameter has the representation's value: a charset's case-insensitively, any other's as
// written.
function parameterMatches(media: MediaType, name: string, value: string): boolean {
	return media.params[name] === (name === 'charset' ? value.toLowerCase() : value)
}

// The q an Accept gives a representation (RFC 9110 §12.5.1): that of the most specific range matching it. A range
// matches when its type does (*/*, type/*, or type/subtype) and each of its media parameters equals the
// representation's, a wildcard's included; the most specific is the one of the most specific type, then of the most
// parameters, the first of equals. 0 when none matches. hono/accepts' matcher ranks by q first and ignores
// parameters, so it is not used either.
export function quality(ranges: readonly MediaRange[], media: MediaType): number {
	const [mediaType, mediaSubtype] = media.type.split('/')
	let best: [number, number] = [-1, -1]
	let q = 0
	for (const range of ranges) {
		const { type, subtype, params } = range
		const rank =
			type === '*' && subtype === '*'
				? 0
				: type === mediaType && subtype === '*'
					? 1
					: type === mediaType && subtype === mediaSubtype
						? 2
						: -1
		if (rank === -1 || !params.every(([name, value]) => parameterMatches(media, name, value))) {
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
