// https://docs.joinmastodon.org/methods/accounts/#verify_credentials

import { getDatabase } from 'wildebeest/backend/src/database'
import * as errors from 'wildebeest/backend/src/errors'
import { getPreference, loadLocalMastodonAccount } from 'wildebeest/backend/src/mastodon/account'
import type { ContextData, Env } from 'wildebeest/backend/src/types'
import type { CredentialAccount } from 'wildebeest/backend/src/types/account'
import { cors } from 'wildebeest/backend/src/utils/cors'
import { actorToHandle } from 'wildebeest/backend/src/utils/handle'

export const onRequest: PagesFunction<Env, any, ContextData> = async ({ data, env }) => {
	if (!data.connectedActor) {
		return errors.notAuthorized('no connected user')
	}
	const db = await getDatabase(env)
	const user = await loadLocalMastodonAccount(db, data.connectedActor, {
		...actorToHandle(data.connectedActor),
		domain: null,
	})
	const preference = await getPreference(db, data.connectedActor)

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

	const headers = {
		...cors(),
		'content-type': 'application/json; charset=utf-8',
	}
	return new Response(JSON.stringify(res), { headers })
}
