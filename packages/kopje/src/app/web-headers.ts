import { L1_SCRIPT, STYLESHEET } from '../web/asset-versions'
import { EMBED_SCRIPT } from '../web/pages/embed'

// The header sets of the web pages.
//
//   - WEB-2: every page has a CSP with no script source, frame-ancestors 'none' and X-Frame-Options DENY, except the
//     public pages that load the L1 bundle, whose CSP names exactly that file and enforces Trusted Types, and the embed
//     page, which any site may frame and which runs one script; pages of a signed-in user are never cached (no-store),
//     and the handoff pages never by a shared cache; WEB-3: none of these routes sends CORS headers (only the API's
//     paths are opened in app.ts); WEB-5: every answer has its exact type and nosniff.
//   - Every page that links the stylesheet preloads it: its fingerprinted path, the one the page links, so a browser or
//     Early Hints fetches it while the page is made.

// The directives every policy shares, in their order: nothing by default, a page's one script (if any) right after
// that, then the stylesheet, images, media where the page plays it, same-origin forms and no <base>. Media plays inline
// only on the public pages and the embed, from this origin or another server's https URL, as their images load; the
// private pages' policy has no media-src.
const csp = (script: string | null, media: boolean, ...rest: string[]) =>
	[
		"default-src 'none'",
		...(script === null ? [] : [`script-src ${script}`]),
		"style-src 'self'; img-src 'self' https:",
		...(media ? ["media-src 'self' https:"] : []),
		"form-action 'self'; base-uri 'none'",
		...rest,
	].join('; ')

const NO_FRAMING = "frame-ancestors 'none'"

const CSP = csp(null, false, NO_FRAMING)

export const PRELOAD = `<${STYLESHEET}>; rel=preload; as=style`

const FRAMING = { 'content-security-policy': CSP, 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff' }

// Public pages may be kept briefly; they vary with Accept (the same URL serves ActivityPub documents).
export const PUBLIC_HEADERS = {
	...FRAMING,
	'content-security-policy': csp(null, true, NO_FRAMING),
	'referrer-policy': 'same-origin',
	'cache-control': 'public, max-age=60',
	vary: 'Accept',
	link: PRELOAD,
}

// A public page that loads the L1 bundle: its CSP names exactly the bundle's fingerprinted URL (never 'self', inline
// or unsafe-*), and, since the bundle writes no HTML, script or script URL sink, no Trusted Types policy may be made.
export function l1Headers(domain: string) {
	return {
		...PUBLIC_HEADERS,
		'content-security-policy': csp(
			`https://${domain}${L1_SCRIPT}`,
			true,
			NO_FRAMING,
			"require-trusted-types-for 'script'",
			"trusted-types 'none'"
		),
	}
}

// The embed page (Mastodon's StatusesController#embed, which drops X-Frame-Options and frame-ancestors): any site may
// frame it, so it has neither; its one script is named exactly. Kept 180 s, as Mastodon's (expires_in 180).
export function embedHeaders(domain: string) {
	return {
		'content-security-policy': csp(`https://${domain}${EMBED_SCRIPT}`, true),
		'x-content-type-options': 'nosniff',
		'referrer-policy': 'same-origin',
		'cache-control': 'public, max-age=180',
		link: PRELOAD,
	}
}

// The handoff pages: the script-free CSP of a page without media, never kept by a shared cache, and revalidated on
// every use (`private, no-cache`, not `no-store`, so the back/forward cache keeps the page the viewer leaves for their
// server). Their 404 is the public pages' ordinary one.
export const HANDOFF_HEADERS = {
	...FRAMING,
	'referrer-policy': 'same-origin',
	'cache-control': 'private, no-cache',
	link: PRELOAD,
}

// Pages of a signed-in user, and every answer of the sign-in flow. `same-origin`, not `no-referrer`: under
// `no-referrer` browsers send `Origin: null` on a same-origin form post (Fetch, "serializing a request origin"), and
// every form here is checked by its Origin (WEB-1). Other origins still get no referrer.
export const PRIVATE_HEADERS = {
	...FRAMING,
	'referrer-policy': 'same-origin',
	'cache-control': 'no-store',
	link: PRELOAD,
}
