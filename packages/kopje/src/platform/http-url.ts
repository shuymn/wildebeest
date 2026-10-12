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
