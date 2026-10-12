// URL fields taken from remote documents end up as links (`href`) in clients,
// so only web URLs are accepted: `javascript:`, `data:` and other schemes are
// dropped.
export function parseHttpUrl(value: unknown): URL | null {
	if (!(typeof value === 'string' || value instanceof URL)) {
		return null
	}
	let url: URL
	try {
		url = new URL(value)
	} catch {
		return null
	}
	return url.protocol === 'https:' || url.protocol === 'http:' ? url : null
}
