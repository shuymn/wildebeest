// https://docs.joinmastodon.org/methods/preferences/#get

import { getDatabase } from 'wildebeest/backend/src/database'
import * as errors from 'wildebeest/backend/src/errors'
import { getPreference } from 'wildebeest/backend/src/mastodon/account'
import type { ContextData, Env } from 'wildebeest/backend/src/types'
import { Privacy, ReadingExpandMedia } from 'wildebeest/backend/src/types'
import { cors } from 'wildebeest/backend/src/utils/cors'

type PreferenceResponse = {
	'posting:default:visibility': Privacy
	'posting:default:sensitive': boolean
	'posting:default:language': string | null
	'reading:expand:media': ReadingExpandMedia
	'reading:expand:spoilers': boolean
}

export const onRequest: PagesFunction<Env, any, ContextData> = async ({ data, env }) => {
	if (!data.connectedActor) {
		return errors.notAuthorized('no connected user')
	}

	const preference = await getPreference(await getDatabase(env), data.connectedActor)
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
}
