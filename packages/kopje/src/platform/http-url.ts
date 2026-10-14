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

// NET-1's rules that need no lookup: https, no credentials, no literal IP, no local or single-label name. The reason a
// URL breaks them, or null. Every outbound sink applies them (NET-3, federation/loader.ts), and so does Web Push
// registration before it stores an endpoint (PUSH-2).
export function publicShapeRefusal(url: URL): string | null {
	if (url.protocol !== 'https:') {
		return `Refused non-https URL: ${url.protocol}`
	}
	if (url.username !== '' || url.password !== '') {
		return 'Refused URL with credentials'
	}
	const host = url.hostname
	if (host.startsWith('[') || IPV4_LITERAL.test(host)) {
		return `Refused literal IP host: ${host}`
	}
	if (host === 'localhost' || host.endsWith('.localhost') || !host.includes('.')) {
		return `Refused local host: ${host}`
	}
	return null
}
