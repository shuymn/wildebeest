import { strict as assert } from 'node:assert/strict'

import { PUBLIC_GROUP } from '@wildebeest/backend/activitypub/activities'
import { detectVisibility } from '@wildebeest/backend/mastodon/status_visibility'

describe('mastodon/status_visibility', () => {
	test('detects visibility from URL and object recipients', () => {
		const followers = new URL('https://example.com/users/alice/followers')

		assert.equal(
			detectVisibility({
				to: [new URL(PUBLIC_GROUP)],
				cc: [],
				followers,
			}),
			'public'
		)
		assert.equal(
			detectVisibility({
				to: [{ id: followers }],
				cc: [{ id: new URL(PUBLIC_GROUP) }],
				followers,
			}),
			'unlisted'
		)
		assert.equal(
			detectVisibility({
				to: [{ id: followers }],
				cc: [],
				followers,
			}),
			'private'
		)
		assert.equal(
			detectVisibility({
				to: [new URL('https://example.com/users/bob')],
				cc: [],
				followers,
			}),
			'direct'
		)
	})
})
