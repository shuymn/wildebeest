import { strict as assert } from 'node:assert/strict'

import { loadItems } from '@wildebeest/backend/activitypub/objects/collection'

describe('Collection', () => {
	test('loadItems walks pages', async () => {
		const collection = {
			totalItems: 6,
			first: 'https://example.com/1',
		} as any

		globalThis.fetch = async (input: RequestInfo) => {
			if (input instanceof URL || typeof input === 'string') {
				if (input.toString() === 'https://example.com/1') {
					return new Response(
						JSON.stringify({
							next: 'https://example.com/2',
							orderedItems: ['a', 'b'],
						})
					)
				}
				if (input.toString() === 'https://example.com/2') {
					return new Response(
						JSON.stringify({
							next: 'https://example.com/3',
							orderedItems: ['c', 'd'],
						})
					)
				}
				if (input.toString() === 'https://example.com/3') {
					return new Response(
						JSON.stringify({
							orderedItems: ['e', 'f'],
						})
					)
				}

				throw new Error(`unexpected request to "${input.toString()}"`)
			}
			throw new Error('unexpected request to ' + input.url)
		}

		{
			const items = await loadItems(collection, 10)
			assert.deepEqual(items, ['a', 'b', 'c', 'd', 'e', 'f'])
		}
		{
			const items = await loadItems(collection, 3)
			assert.deepEqual(items.length, 3)
		}
	})
})
