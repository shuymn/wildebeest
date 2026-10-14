// Mastodon's OAuth scopes (4.5) and the one rule that decides whether granted scopes cover a required one.
//
//   - A parent covers its children: `read` covers every `read:*`, `admin:read` covers every `admin:read:*`.
//   - The legacy `follow` scope covers the relationship scopes it was split into.
//   - Nothing else is implied (`write` does not cover `read`; `push` and `profile` stand alone, and `read` does not
//     cover `profile`).

const TOP_LEVEL = ['read', 'write', 'follow', 'push', 'profile', 'admin:read', 'admin:write'] as const

const CHILDREN = [
	'read:accounts',
	'read:blocks',
	'read:bookmarks',
	'read:favourites',
	'read:filters',
	'read:follows',
	'read:lists',
	'read:mutes',
	'read:notifications',
	'read:search',
	'read:statuses',
	'write:accounts',
	'write:blocks',
	'write:bookmarks',
	'write:conversations',
	'write:favourites',
	'write:filters',
	'write:follows',
	'write:lists',
	'write:media',
	'write:mutes',
	'write:notifications',
	'write:reports',
	'write:statuses',
	'admin:read:accounts',
	'admin:read:reports',
	'admin:read:domain_allows',
	'admin:read:domain_blocks',
	'admin:read:ip_blocks',
	'admin:read:email_domain_blocks',
	'admin:read:canonical_email_blocks',
	'admin:write:accounts',
	'admin:write:reports',
	'admin:write:domain_allows',
	'admin:write:domain_blocks',
	'admin:write:ip_blocks',
	'admin:write:email_domain_blocks',
	'admin:write:canonical_email_blocks',
] as const

export type Scope = (typeof TOP_LEVEL)[number] | (typeof CHILDREN)[number]

// Every scope a token can be issued with (parseScopes accepts these and no other).
export const SCOPES: readonly Scope[] = [...TOP_LEVEL, ...CHILDREN]

const KNOWN = new Set<string>(SCOPES)

const FOLLOW_EXPANSION = new Set<string>([
	'read:follows',
	'write:follows',
	'read:blocks',
	'write:blocks',
	'read:mutes',
	'write:mutes',
])

export const DEFAULT_SCOPES = 'read'

// Splits a scope string (space separated; `+` arrives already decoded to a space from forms and queries).
// Returns null if any scope is unknown or none is given.
export function parseScopes(text: string | undefined, fallback = DEFAULT_SCOPES): string[] | null {
	const source = text === undefined || text.trim() === '' ? fallback : text
	const scopes = [...new Set(source.split(/[\s+]+/).filter((s) => s !== ''))]
	return scopes.length > 0 && scopes.every((s) => KNOWN.has(s)) ? scopes : null
}

// What a route requires: one scope, or any one of several (Mastodon's doorkeeper_authorize! with more than one, as
// verify_credentials takes `profile` or `read:accounts`).
export type RequiredScope = Scope | readonly Scope[]

export function grantsAny(granted: readonly string[], required: RequiredScope): boolean {
	return (typeof required === 'string' ? [required] : required).some((scope) => grants(granted, scope))
}

export function grants(granted: readonly string[], required: Scope): boolean {
	return granted.some(
		(scope) =>
			scope === required || required.startsWith(`${scope}:`) || (scope === 'follow' && FOLLOW_EXPANSION.has(required))
	)
}

// Each requested scope must be covered by the scopes the client registered.
export function withinScopes(requested: readonly string[], registered: readonly string[]): boolean {
	return requested.every((scope) => KNOWN.has(scope) && grants(registered, scope as Scope))
}
