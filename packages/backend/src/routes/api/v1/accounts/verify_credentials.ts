// https://docs.joinmastodon.org/methods/accounts/#verify_credentials

import { Hono } from 'hono'

import { getDatabase } from '@wildebeest/backend/database'
import * as errors from '@wildebeest/backend/errors'
import { getPreference, loadLocalMastodonAccount } from '@wildebeest/backend/mastodon/account'
import type { HonoEnv } from '@wildebeest/backend/types'
import type { CredentialAccount } from '@wildebeest/backend/types/account'
import { cors } from '@wildebeest/backend/utils/cors'
import { actorToHandle } from '@wildebeest/backend/utils/handle'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

const app = new Hono<HonoEnv>()

app.get(async ({ env }) => {
	if (!env.data.connectedActor) {
		return errors.notAuthorized('no connected user')
	}
	const db = getDatabase(env)
	const user = await loadLocalMastodonAccount(db, env.data.connectedActor, {
		...actorToHandle(env.data.connectedActor),
		domain: null,
	})
	const preference = await getPreference(db, env.data.connectedActor)

	const res: CredentialAccount = {
		...user,
		source: {
			note: user.note,
			fields: user.fields,
			privacy: preference.posting_default_visibility,
			sensitive: preference.posting_default_sensitive,
			language: preference.posting_default_language ?? '',
			follow_requests_count: 0,
		},
		role: {
			id: '0',
			name: 'user',
			color: '',
			position: 1,
			permissions: 0,
			highlighted: true,
			created_at: '2022-09-08T22:48:07.983Z',
			updated_at: '2022-09-08T22:48:07.983Z',
		},
	}

	return new Response(JSON.stringify(res), { headers })
})

export default app
