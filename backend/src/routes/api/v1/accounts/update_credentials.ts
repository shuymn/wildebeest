// https://docs.joinmastodon.org/methods/accounts/#update_credentials

import { Hono } from 'hono'

import { createUpdateActivity } from 'wildebeest/backend/src/activitypub/activities/update'
import type { Actor } from 'wildebeest/backend/src/activitypub/actors'
import * as actors from 'wildebeest/backend/src/activitypub/actors'
import { updateActorProperty } from 'wildebeest/backend/src/activitypub/actors'
import { deliverFollowers } from 'wildebeest/backend/src/activitypub/deliver'
import { getApId } from 'wildebeest/backend/src/activitypub/objects'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import * as errors from 'wildebeest/backend/src/errors'
import { getPreference, loadLocalMastodonAccount } from 'wildebeest/backend/src/mastodon/account'
import * as images from 'wildebeest/backend/src/media/image'
import type { DeliverMessageBody, HonoEnv, Queue } from 'wildebeest/backend/src/types'
import type { CredentialAccount } from 'wildebeest/backend/src/types/account'
import { cors } from 'wildebeest/backend/src/utils/cors'
import { actorToHandle } from 'wildebeest/backend/src/utils/handle'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

const app = new Hono<HonoEnv>()

app.patch(async ({ req, env }) => {
	if (!env.data.connectedActor) {
		return errors.notAuthorized('no connected user')
	}
	return handleRequest(
		await getDatabase(env),
		req.raw,
		env.data.connectedActor,
		env.CF_ACCOUNT_ID,
		env.CF_API_TOKEN,
		env.userKEK,
		env.QUEUE
	)
})

async function handleRequest(
	db: Database,
	request: Request,
	connectedActor: Actor,

	accountId: string,
	apiToken: string,

	userKEK: string,
	queue: Queue<DeliverMessageBody>
): Promise<Response> {
	const domain = new URL(request.url).hostname
	const actorId = getApId(connectedActor)

	// update actor
	{
		const formData = await request.formData()

		if (formData.has('display_name')) {
			const value = formData.get('display_name')!
			await updateActorProperty(db, actorId, 'name', value)
		}

		if (formData.has('note')) {
			const value = formData.get('note')!
			await updateActorProperty(db, actorId, 'summary', value)
		}

		if (formData.has('avatar')) {
			const value = formData.get('avatar')! as any

			const config = { accountId, apiToken }
			const url = await images.uploadAvatar(value, config)
			await updateActorProperty(db, actorId, 'icon.url', url.toString())
		}

		if (formData.has('header')) {
			const value = formData.get('header')! as any

			const config = { accountId, apiToken }
			const url = await images.uploadHeader(value, config)
			await updateActorProperty(db, actorId, 'image.url', url.toString())
		}

		// TODO: update preferences
	}

	// reload the current user and sent back updated infos
	{
		const actor = await actors.getActorById(db, actorId)
		if (actor === null) {
			return errors.notAuthorized('user not found')
		}
		const user = await loadLocalMastodonAccount(db, actor, { ...actorToHandle(actor), domain: null })
		const preference = await getPreference(db, actor)

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

		// send updates
		const activity = await createUpdateActivity(db, domain, connectedActor, actor)
		await deliverFollowers(db, userKEK, connectedActor, activity, queue)

		return new Response(JSON.stringify(res), { headers })
	}
}

export default app
