// A stored URL as it may be emitted to clients and peers (HTML-3): parsed, absolute, and http: or https:, else null.
// Applied at the presenters, so imported and federated values are covered whatever was stored.
export function httpUrl(value: string | null): URL | null {
	if (value === null) {
		return null
	}
	try {
		const url = new URL(value)
		return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
	} catch {
		return null
	}
}

// URL parsing has already normalized IPv4 forms like 0x7f.1 or 2130706433 to dotted quads.
const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/

// NET-1's rules that need no lookup: https, no credentials, no literal IP, no local or single-label name. The rule a URL
// breaks, or null. Every outbound sink applies them (NET-3, federation/loader.ts, federation/web-page.ts), and so does
// Web Push registration before it stores an endpoint (PUSH-2).
export type PublicShapeViolation = 'scheme' | 'credentials' | 'ip-literal' | 'local-host'

export function publicShapeViolation(url: URL): PublicShapeViolation | null {
	if (url.protocol !== 'https:') {
		return 'scheme'
	}
	if (url.username !== '' || url.password !== '') {
		return 'credentials'
	}
	const host = url.hostname
	if (host.startsWith('[') || IPV4_LITERAL.test(host)) {
		return 'ip-literal'
	}
	if (host === 'localhost' || host.endsWith('.localhost') || !host.includes('.')) {
		return 'local-host'
	}
	return null
}

// publicShapeViolation as a message, or null.
export function publicShapeRefusal(url: URL): string | null {
	switch (publicShapeViolation(url)) {
		case 'scheme':
			return `Refused non-https URL: ${url.protocol}`
		case 'credentials':
			return 'Refused URL with credentials'
		case 'ip-literal':
			return `Refused literal IP host: ${url.hostname}`
		case 'local-host':
			return `Refused local host: ${url.hostname}`
		case null:
			return null
	}
}

// The serialized form of an http(s) URL when it is at most `limit` characters (a serialized URL is ASCII, so its
// length is its size in bytes), else null: a presented URL stays within its bound however it was derived or
// normalized (RES-2).
export function boundedHref(value: string | null, limit: number): string | null {
	const href = httpUrl(value)?.href ?? null
	return href !== null && href.length <= limit ? href : null
}
