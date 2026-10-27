import { INBOX_ROUTES } from '../federation/inbox-request'

// Content negotiation between the web pages and the documents served at the same paths.

// An ActivityPub client asks for the object, a browser for the page (content negotiation on /@user and /@user/:id).
export function wantsActivityPub(accept: string | undefined): boolean {
	return accept !== undefined && /application\/(activity\+json|ld\+json)/i.test(accept)
}

// The paths whose every answer is a document, never a page, whoever asks: the APIs (the admin API's included), the
// OAuth endpoints other than the consent page (token, revoke, userinfo, introspect, token/info), the well-known and
// NodeInfo documents, the inboxes and media files.
const DOCUMENT_PATHS = [
	/^\/api\//,
	/^\/admin(?:\/|$)/,
	/^\/oauth\/(?!authorize$)/,
	/^\/\.well-known\//,
	/^\/nodeinfo(?:\/|$)/,
	/^\/media\//,
	...INBOX_ROUTES.map((route) => new RegExp(`^${route.replace(/:[a-z]+/g, '[^/]+')}$`)),
]

// Whether an Accept header prefers text/html (RFC 9110 §12.5.1): it names text/html with a q above 0 and no other
// range with a higher q. A browser's navigation names text/html first; an API client's Accept does not name it.
function prefersHtml(accept: string): boolean {
	let html = 0
	let other = 0
	for (const range of accept.split(',')) {
		const [type = '', ...params] = range.split(';').map((part) => part.trim().toLowerCase())
		const q = params.find((param) => param.startsWith('q='))
		const weight = q === undefined ? 1 : Number(q.slice(2))
		if (!Number.isFinite(weight)) {
			continue
		}
		if (type === 'text/html') {
			html = Math.max(html, weight)
		} else {
			other = Math.max(other, weight)
		}
	}
	return html > 0 && html >= other
}

// A browser asking for a page: a GET or HEAD whose Accept prefers text/html and asks for no ActivityPub document (the
// public pages' rule, wantsActivityPub), outside the document paths. app.ts answers it its error pages; every other
// request keeps the API's answers.
export function pageRequest(method: string, path: string, accept: string | undefined): boolean {
	return (
		(method === 'GET' || method === 'HEAD') &&
		accept !== undefined &&
		prefersHtml(accept) &&
		!wantsActivityPub(accept) &&
		!DOCUMENT_PATHS.some((pattern) => pattern.test(path))
	)
}
