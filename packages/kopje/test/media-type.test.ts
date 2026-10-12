import { describe, expect, it } from 'vitest'

import { parseMediaType } from '../src/platform/media-type'

describe('parseMediaType', () => {
	it('lowercases the essence and parameter names, and reads quoted and unquoted values', () => {
		const media = parseMediaType(' Application/LD+JSON ;Charset=UTF-8; PROFILE="a \\"b\\" c" ;x=y; x=z;')
		expect(media?.essence).toBe('application/ld+json')
		expect([...(media?.parameters ?? [])]).toEqual([
			['charset', 'UTF-8'],
			['profile', 'a "b" c'],
			['x', 'y'],
		])
	})

	it('keeps a semicolon inside a quoted value', () => {
		expect(parseMediaType('a/b; foo="x;profile=y"')?.parameters).toEqual(new Map([['foo', 'x;profile=y']]))
	})

	it.each(['', 'json', 'application/', 'a/b c', 'a/b; foo', 'a/b; foo=', 'a/b; foo="unterminated', 'a/b; =x', 'a/b/c'])(
		'refuses %j',
		(header) => {
			expect(parseMediaType(header)).toBeNull()
		}
	)
})
