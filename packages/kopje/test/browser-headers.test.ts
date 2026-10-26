import { describe, expect, it } from 'vitest'

import { setSetting } from './api-helpers'
import { pathOf } from './media-helpers'
import { community, post } from './status-helpers'
import { EMBED_PAGE_HEADERS, L1_PAGE_HEADERS, PRIVATE_PAGE_HEADERS, PUBLIC_PAGE_HEADERS } from '../browser/headers'

// The browser job (design §10.11) serves its fixtures with pinned header literals; these are exactly the headers the
// Worker sends for each page type it renders, so the browser runs under the production CSP and cannot drift from it.

describe('the browser job headers', () => {
	it('equal every header the Worker sends with each fixture page type', async () => {
		const h = await community(['alice'])
		const status = await post(h, h.users.alice, { status: 'hello', spoiler_text: 'careful' })
		await setSetting(h.store, 'privacy_policy', '<p>Policy</p>')
		const pages: [string, Readonly<Record<string, string>>, number][] = [
			['/@alice', L1_PAGE_HEADERS, 200],
			[pathOf(String(status.url)), L1_PAGE_HEADERS, 200],
			['/about', PUBLIC_PAGE_HEADERS, 200],
			['/privacy-policy', PUBLIC_PAGE_HEADERS, 200],
			['/@nobody', PUBLIC_PAGE_HEADERS, 404],
			[`${pathOf(String(status.url))}/embed`, EMBED_PAGE_HEADERS, 200],
			['/authorize_interaction', PRIVATE_PAGE_HEADERS, 200],
		]
		for (const [path, pinned, code] of pages) {
			const response = await h.request(path)
			expect(response.status, path).toBe(code)
			expect(Object.fromEntries(response.headers), path).toEqual(pinned)
		}
	})
})
