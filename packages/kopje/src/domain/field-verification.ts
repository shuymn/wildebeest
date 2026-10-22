// Whether a local profile field's value is a link Kopje verifies (rel=me, domain/field-links.ts): a subset of
// Mastodon's Account::Field#verifiable? (app/models/account/field.rb:35-51, v4.5.11) on Addressable 2.9.0, so that a
// value Kopje verifies Mastodon would verify too. test/field-verification.test.ts holds it to the pinned expectations
// of test/fixtures/mastodon-4.5.11-verifiable.json and lists every value Mastodon accepts and Kopje does not.
//
// The value is split as Addressable splits it (RFC 3986 appendix B), then each part judged as written:
//   1. the scheme exactly "https" (ACCEPTED_SCHEMES, compared as written);
//   2. an authority with no "@" (any userinfo, an empty one included, makes Addressable's user non-nil) and no "%";
//   3. a port absent or exactly 443 (Mastodon has no port rule; the web-page sink requests the default port only);
//   4. a host of labels of 1 to 63 lowercase ASCII letters, digits, "_" and "-" joined by single dots, no trailing dot,
//      at most 253 characters, which the WHATWG parser keeps as written (so no IPv4 shorthand): Addressable's
//      normalized_host (downcase, unencode, IDNA ToASCII by label, a single trailing dot dropped) leaves such a host
//      unchanged, as libidn's ToASCII leaves an ASCII label of 1 to 63 characters;
//   5. a path empty or of RFC 3986 pchar and "/" with no "%" and no "." or ".." segment, which the WHATWG parser keeps
//      as written: Addressable's normalized_path re-encodes only characters outside pchar and removes dot segments
//      (and NFC-normalizes decoded percent sequences, which Kopje does not model: any "%" refuses);
//   6. a query and fragment of printable ASCII (Addressable reads neither for verifiable?).
// The rules that need a lookup (literal IPs, local and single-label names) are left to the sink, which refuses them
// before any request (federation/web-page.ts, NET-3).

const RFC3986 = /^(([^:/?#]+):)?(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?$/
const PRINTABLE = /^[!-~]*$/
const LABEL = /^[a-z0-9_-]{1,63}$/
const HOST_LIMIT = 253
// RFC 3986 pchar without pct-encoded, and "/".
const PATH = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/]*$/

export function verifiableLink(value: string): boolean {
	if (value.length === 0 || !PRINTABLE.test(value)) {
		return false
	}
	const parts = RFC3986.exec(value)
	if (parts === null || parts[2] !== 'https' || parts[4] === undefined) {
		return false
	}
	const authority = parts[4]
	const path = parts[5] ?? ''
	if (authority.includes('@') || authority.includes('%')) {
		return false
	}
	const colon = authority.lastIndexOf(':')
	const host = colon === -1 ? authority : authority.slice(0, colon)
	if (colon !== -1 && authority.slice(colon + 1) !== '443') {
		return false
	}
	if (host.length > HOST_LIMIT || !host.split('.').every((label) => LABEL.test(label))) {
		return false
	}
	if (!PATH.test(path) || path.split('/').some((segment) => segment === '.' || segment === '..')) {
		return false
	}
	let url: URL
	try {
		url = new URL(value)
	} catch {
		return false
	}
	return url.hostname === host && url.pathname === (path === '' ? '/' : path)
}
