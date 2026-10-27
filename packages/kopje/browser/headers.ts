// The headers the browser job serves with each fixture (design §10.11), as pinned literals. The page headers equal
// what the Worker sends for that page type (test/browser-headers.test.ts), and the asset headers what public/_headers
// gives (test-node/stylesheet.test.ts), so the browser runs under the production CSP.

import { L1_SCRIPT, STYLESHEET } from '../src/web/asset-versions.js'

// The preload of the stylesheet every page links (design §5, amendment A1): its fingerprinted path, a build value.
const PRELOAD = `<${STYLESHEET}>; rel=preload; as=style`

// A public page: WEB-2 (CSP without script, no framing, media inline), WEB-5 (exact type, nosniff), design §5.
export const PUBLIC_PAGE_HEADERS: Readonly<Record<string, string>> = {
	'content-type': 'text/html; charset=UTF-8',
	'content-security-policy':
		"default-src 'none'; style-src 'self'; img-src 'self' https:; media-src 'self' https:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
	'x-frame-options': 'DENY',
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'same-origin',
	'cache-control': 'public, max-age=60',
	vary: 'Accept',
	link: PRELOAD,
}

// A public page that loads the L1 bundle (design §7.5) on the instance kopje.test: its CSP names exactly the bundle,
// at its fingerprinted path (a build value), and enforces Trusted Types.
export const L1_PAGE_HEADERS: Readonly<Record<string, string>> = {
	...PUBLIC_PAGE_HEADERS,
	'content-security-policy': `default-src 'none'; script-src https://kopje.test${L1_SCRIPT}; style-src 'self'; img-src 'self' https:; media-src 'self' https:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'`,
}

// A page of a signed-in user or of a form (settings, sign-in messages, /authorize_interaction, the OAuth pages): never
// cached.
export const PRIVATE_PAGE_HEADERS: Readonly<Record<string, string>> = {
	'content-type': 'text/html; charset=UTF-8',
	'content-security-policy':
		"default-src 'none'; style-src 'self'; img-src 'self' https:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
	'x-frame-options': 'DENY',
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'same-origin',
	'cache-control': 'no-store',
	link: PRELOAD,
}

// The 500 page of a browser's page request (app.ts): a private page's headers, varying with Accept as the JSON
// answered in its place does; the 503 page adds maintenanceError's Retry-After.
export const ERROR_PAGE_HEADERS: Readonly<Record<string, string>> = { ...PRIVATE_PAGE_HEADERS, vary: 'Accept' }

export const UNAVAILABLE_PAGE_HEADERS: Readonly<Record<string, string>> = {
	...ERROR_PAGE_HEADERS,
	'retry-after': '600',
}

// A handoff page (design §8, amendment A7): the script-free CSP without media, kept by no shared cache, revalidated.
export const HANDOFF_PAGE_HEADERS: Readonly<Record<string, string>> = {
	...PRIVATE_PAGE_HEADERS,
	'cache-control': 'private, no-cache',
}

// The embed page of the instance kopje.test: framable by any site, with its one script named exactly.
export const EMBED_PAGE_HEADERS: Readonly<Record<string, string>> = {
	'content-type': 'text/html; charset=UTF-8',
	'content-security-policy':
		"default-src 'none'; script-src https://kopje.test/assets/embed-status.js; style-src 'self'; img-src 'self' https:; media-src 'self' https:; form-action 'self'; base-uri 'none'",
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'same-origin',
	'cache-control': 'public, max-age=180',
	link: PRELOAD,
}

// What public/_headers adds to every file under /assets, and to the fingerprinted stylesheet and script.
export const ASSET_HEADERS: Readonly<Record<string, string>> = { 'x-content-type-options': 'nosniff' }

export const FINGERPRINTED_HEADERS: Readonly<Record<string, string>> = {
	...ASSET_HEADERS,
	'cache-control': 'public, max-age=31536000, immutable',
}

// The types the job serves the files with. Under nosniff a stylesheet applies only as text/css and a script only with
// a JavaScript type, so a page that loads either here would load it in production too.
export const ASSET_TYPES: Readonly<Record<string, string>> = {
	css: 'text/css; charset=utf-8',
	js: 'text/javascript; charset=utf-8',
	png: 'image/png',
}

// A cached remote file (/media/r/<token>/<file>, web/media.ts serveRemoteMedia; MEDIA-4): its stored type, nosniff
// and a sandboxing CSP, so a file that is also a document never runs as one. The Worker adds an etag and
// content-length, and a content-range to a 206 (test/browser-headers.test.ts compares the rest).
export function remoteMediaHeaders(type: string): Readonly<Record<string, string>> {
	return {
		'content-type': type,
		'accept-ranges': 'bytes',
		'cache-control': 'public, max-age=31536000, immutable',
		'x-content-type-options': 'nosniff',
		'content-security-policy': "default-src 'none'; sandbox",
		'cross-origin-resource-policy': 'cross-origin',
		'access-control-allow-origin': '*',
	}
}
