// Domain names of remote accounts, parsed one way everywhere they are compared or stored: WebFinger subjects and
// addresses (federation/resolve.ts), the host of an actor id (the fallback domain of an account), address search and
// lookup, and domain-block matching.

// A domain from an address or a WebFinger subject: lowercase, IDNA to ASCII (punycode), and only a hostname of at
// least two labels: no port, userinfo, path, query, trailing dot, IP literal or anything else the URL parser would
// read differently from the string. null when it is not exactly such a hostname.
export function normalizeDomain(raw: string): string | null {
	if (raw === '' || /[\s/\\?#@:[\]%]/.test(raw) || raw.endsWith('.')) {
		return null
	}
	let url: URL
	try {
		url = new URL(`https://${raw}/`)
	} catch {
		return null
	}
	const host = url.hostname
	if (url.port !== '' || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.host !== host) {
		return null
	}
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || !host.includes('.') || host.endsWith('.')) {
		return null
	}
	return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null
}

// The domain an actor id's host gives an account, as Mastodon takes it (Addressable::URI#normalized_host, without the
// port): the hostname, lowercase and punycode, without a trailing dot or a port. The id itself is kept whole for
// origin checks. A host the normalizer refuses (the loader refuses such hosts anyway) is used as the URL parser reads
// it, without its trailing dot.
export function hostDomain(uri: string): string {
	const host = new URL(uri).hostname.replace(/\.$/, '')
	return normalizeDomain(host) ?? host
}

// An address: user@domain, @user@domain or acct:user@domain, split into its parts first and its domain then
// normalized, so Unicode and punycode spellings of a domain are the same address. null when it is not one.
const USERNAME = /^[a-z0-9_]+([a-z0-9_.-]+[a-z0-9_]+)?$/i

export function parseAddress(query: string): { username: string; domain: string } | null {
	const parts = query
		.replace(/^acct:/, '')
		.replace(/^@/, '')
		.split('@')
	if (parts.length !== 2) {
		return null
	}
	const [username = '', raw = ''] = parts
	const domain = normalizeDomain(raw)
	return USERNAME.test(username) && domain !== null ? { username, domain } : null
}
