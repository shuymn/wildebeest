import { describe, expect, it } from 'vitest'

import { Params } from '../src/mastodon/params'

describe('Params#objects', () => {
	it('reads indexed (JSON) and sequential (form) objects', () => {
		const p = new Params([
			['media_attributes[1][id]', 'b'],
			['media_attributes[0][id]', 'a'],
			['media_attributes[0][description]', 'A'],
			['media_attributes[][id]', 'c'],
			['media_attributes[][description]', 'C'],
			['media_attributes[][id]', 'd'],
		])
		expect(p.objects('media_attributes')).toEqual([
			{ id: 'a', description: 'A' },
			{ id: 'b' },
			{ id: 'c', description: 'C' },
			{ id: 'd' },
		])
	})

	it('matches the name literally, regex metacharacters included', () => {
		const p = new Params([
			['a.b[0][id]', 'literal'],
			['axb[0][id]', 'wildcard'],
			['a\\b[0][id]', 'backslash'],
			['(x)[0][id]', 'group'],
		])
		expect(p.objects('a.b')).toEqual([{ id: 'literal' }])
		expect(p.objects('a\\b')).toEqual([{ id: 'backslash' }])
		expect(p.objects('(x)')).toEqual([{ id: 'group' }])
		expect(p.objects('.*')).toEqual([])
	})
})
