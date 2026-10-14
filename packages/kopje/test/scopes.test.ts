import { describe, expect, it } from 'vitest'

import { ROUTES } from '../src/mastodon/routes'
import { grants, grantsAny, parseScopes, type Scope, withinScopes } from '../src/security/scopes'

describe('scope hierarchy', () => {
	it.each<[string[], Scope, boolean]>([
		[['read'], 'read', true],
		[['read'], 'read:accounts', true],
		[['read:accounts'], 'read:accounts', true],
		[['read:accounts'], 'read', false],
		[['read:accounts'], 'read:statuses', false],
		[['write'], 'write:follows', true],
		[['write'], 'read:accounts', false],
		[['follow'], 'read:follows', true],
		[['follow'], 'write:follows', true],
		[['follow'], 'read:blocks', true],
		[['follow'], 'write:mutes', true],
		[['follow'], 'read:accounts', false],
		[['follow'], 'write:statuses', false],
		[['push'], 'read:notifications', false],
		[['admin:read'], 'admin:read:accounts', true],
		[['admin:read'], 'read:accounts', false],
		[['read'], 'admin:read:accounts', false],
		[['profile'], 'profile', true],
		[['profile'], 'read:accounts', false],
		[['profile'], 'read', false],
		[['read'], 'profile', false],
		[['read:accounts'], 'profile', false],
		[[], 'read', false],
	])('%j covers %s: %s', (granted, required, expected) => {
		expect(grants(granted, required)).toBe(expected)
	})

	it('parses scope strings', () => {
		expect(parseScopes(undefined)).toEqual(['read'])
		expect(parseScopes('  ')).toEqual(['read'])
		expect(parseScopes('read write read')).toEqual(['read', 'write'])
		expect(parseScopes('read+write:media')).toEqual(['read', 'write:media'])
		expect(parseScopes('read everything')).toBeNull()
		expect(parseScopes('read:*')).toBeNull()
		expect(parseScopes('profile')).toEqual(['profile'])
		expect(parseScopes('profile read:statuses')).toEqual(['profile', 'read:statuses'])
		expect(parseScopes('profile:read')).toBeNull()
	})

	it('accepts any one of several required scopes', () => {
		const verifyCredentials = ['profile', 'read:accounts'] as const
		expect(grantsAny(['profile'], verifyCredentials)).toBe(true)
		expect(grantsAny(['read'], verifyCredentials)).toBe(true)
		expect(grantsAny(['read:accounts'], verifyCredentials)).toBe(true)
		expect(grantsAny(['read:statuses', 'write'], verifyCredentials)).toBe(false)
		expect(grantsAny(['profile'], 'read:statuses')).toBe(false)
		expect(grantsAny([], [])).toBe(false)
	})

	it('checks requested scopes against registered ones through the hierarchy', () => {
		expect(withinScopes(['read:accounts', 'write:follows'], ['read', 'write'])).toBe(true)
		expect(withinScopes(['read:accounts'], ['follow'])).toBe(false)
		expect(withinScopes(['read'], ['read:accounts'])).toBe(false)
		expect(withinScopes(['profile'], ['read'])).toBe(false)
		expect(withinScopes(['read:accounts'], ['profile'])).toBe(false)
		expect(withinScopes(['profile'], ['profile', 'read'])).toBe(true)
	})
})

describe('route table', () => {
	it('declares the access of every route and keeps fixed paths before :id', () => {
		const paths = ROUTES.map((route) => `${route.method} ${route.path}`)
		expect(new Set(paths).size).toBe(paths.length)
		const byId = paths.indexOf('GET /api/v1/accounts/:id')
		for (const fixed of ['verify_credentials', 'relationships', 'search', 'lookup', 'familiar_followers']) {
			expect(paths.indexOf(`GET /api/v1/accounts/${fixed}`)).toBeLessThan(byId)
		}
	})
})
