import { describe, expect, it } from 'vitest'

import * as rules from '../cli/lib/cutover/upload-rules.js'
import * as images from '../src/platform/images'
import { FILE_TOKEN } from '../src/platform/media-files'
import { randomToken } from '../src/security/tokens'

// The CLI restates the upload path's rules for `images-export` and `convert --images` (cli/lib/cutover/upload-rules.js),
// because it cannot load src/platform/images.ts on Node. These are the same rules.
describe('the upload rules the cutover restates', () => {
	it('have the same limits and sizing as src/platform/images.ts', () => {
		expect([rules.IMAGE_SIZE_LIMIT, rules.IMAGE_MATRIX_LIMIT, rules.FULL_EDGE, rules.SMALL_EDGE]).toEqual([
			images.IMAGE_SIZE_LIMIT,
			images.IMAGE_MATRIX_LIMIT,
			images.FULL_EDGE,
			images.SMALL_EDGE,
		])
		for (const size of [
			{ width: 1, height: 1 },
			{ width: 5000, height: 3000 },
			{ width: 3000, height: 5000 },
			{ width: 3841, height: 1 },
			{ width: 641, height: 427 },
			{ width: 10000, height: 3 },
		]) {
			for (const edge of [rules.FULL_EDGE, rules.SMALL_EDGE]) {
				expect(rules.fit(size, edge)).toEqual(images.fit(size, edge))
			}
		}
	})

	it('describe the file tokens the upload path makes', () => {
		const token = randomToken()
		expect(token).toMatch(rules.TOKEN_SHAPE)
		expect(token).toMatch(FILE_TOKEN)
	})
})
