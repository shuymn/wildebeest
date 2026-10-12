import { describe, expect, it } from 'vitest'

import { parseMediaType } from '../src/platform/media-type'

describe('parseMediaType', () => {
	it('lowercases the essence and parameter names, and reads quoted and unquoted values', () => {
		const media = parseMediaType(' Application/LD+JSON ;Charset=UTF-8; PROFILE="a \\"b\\" c" ;x=y;')
		expect(media?.essence).toBe('application/ld+json')
		expect([...(media?.parameters ?? [])]).toEqual([
			['charset', 'UTF-8'],
			['profile', 'a "b" c'],
			['x', 'y'],
		])
	})

	it('keeps a semicolon and a comma inside a quoted value', () => {
		expect(parseMediaType('a/b; foo="x;profile=y,z"')?.parameters).toEqual(new Map([['foo', 'x;profile=y,z']]))
	})

	it('reads an unquoted profile URI, the one exception to unquoted values being tokens', () => {
		expect(parseMediaType('a/b;profile=https://www.w3.org/ns/activitystreams')?.parameters).toEqual(
			new Map([['profile', 'https://www.w3.org/ns/activitystreams']])
		)
	})

	it.each([
		'',
		'json',
		'application/',
		'a/b c',
		'a/b; foo',
		'a/b; foo=',
		'a/b; foo="unterminated',
		'a/b; =x',
		'a/b/c',
		// Combined values (a header folded from several fields) are not one media type.
		'application/activity+json; charset=utf-8,application/json',
		'application/activity+json, application/json',
		'a/b; profile=https://www.w3.org/ns/activitystreams,https://example.com/x',
		// Outside profile, an unquoted value must be a token.
		'a/b; charset=utf/8',
		'a/b; x=a:b',
		// A repeated parameter is refused, conflicting or not, so no precedence rule decides the profile.
		'a/b; profile="x"; profile="y"',
		'a/b; profile="x"; PROFILE="x"',
		'a/b; x=y; x=z',
	])('refuses %j', (header) => {
		expect(parseMediaType(header)).toBeNull()
	})
})
