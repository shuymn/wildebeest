// The headers the browser job serves with each fixture (design §10.11), as pinned literals. The page headers equal
// what the Worker sends for that page type (test/browser-headers.test.ts), and the asset headers what public/_headers
// gives (test-node/stylesheet.test.ts), so the browser runs under the production CSP.

import { STYLESHEET } from '../src/web/asset-versions'

// The preload of the stylesheet every page links (design §5, amendment A1): its fingerprinted path, a build value.
const PRELOAD = `<${STYLESHEET}>; rel=preload; as=style`

// A public page: WEB-2 (CSP without script, no framing), WEB-5 (exact type, nosniff), design §5.
export const PUBLIC_PAGE_HEADERS: Readonly<Record<string, string>> = {
	'content-type': 'text/html; charset=UTF-8',
	'content-security-policy':
		"default-src 'none'; style-src 'self'; img-src 'self' https:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
	'x-frame-options': 'DENY',
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'same-origin',
	'cache-control': 'public, max-age=60',
	vary: 'Accept',
	link: PRELOAD,
}

// The embed page of the instance kopje.test: framable by any site, with its one script named exactly.
export const EMBED_PAGE_HEADERS: Readonly<Record<string, string>> = {
	'content-type': 'text/html; charset=UTF-8',
	'content-security-policy':
		"default-src 'none'; script-src https://kopje.test/assets/embed-status.js; style-src 'self'; img-src 'self' https:; form-action 'self'; base-uri 'none'",
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'same-origin',
	'cache-control': 'public, max-age=180',
	link: PRELOAD,
}

// What public/_headers adds to every file under /assets, and to the fingerprinted stylesheet.
export const ASSET_HEADERS: Readonly<Record<string, string>> = { 'x-content-type-options': 'nosniff' }

export const STYLESHEET_HEADERS: Readonly<Record<string, string>> = {
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
