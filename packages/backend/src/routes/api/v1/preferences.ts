// https://docs.joinmastodon.org/methods/preferences/#get

import { Hono } from 'hono'

import { getDatabase } from '@wildebeest/backend/database'
import * as errors from '@wildebeest/backend/errors'
import { getPreference } from '@wildebeest/backend/mastodon/account'
import type { HonoEnv } from '@wildebeest/backend/types'
import { Privacy, ReadingExpandMedia } from '@wildebeest/backend/types'
import { cors } from '@wildebeest/backend/utils/cors'

type PreferenceResponse = {
	'posting:default:visibility': Privacy
	'posting:default:sensitive': boolean
	'posting:default:language': string | null
	'reading:expand:media': ReadingExpandMedia
	'reading:expand:spoilers': boolean
}

const app = new Hono<HonoEnv>()

app.get(async ({ env }) => {
	if (!env.data.connectedActor) {
		return errors.notAuthorized('no connected user')
	}

	const preference = await getPreference(getDatabase(env), env.data.connectedActor)
	const res: PreferenceResponse = {
		'posting:default:visibility': preference.posting_default_visibility,
		'posting:default:sensitive': preference.posting_default_sensitive,
		'posting:default:language': preference.posting_default_language,
		'reading:expand:media': preference.reading_expand_media,
		'reading:expand:spoilers': preference.reading_expand_spoilers,
	}

	const headers = {
		...cors(),
		'content-type': 'application/json; charset=utf-8',
	}

	return new Response(JSON.stringify(res), { headers })
})

export default app
