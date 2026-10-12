import { Hono } from 'hono'

import { PUBLIC_GROUP } from '@wildebeest/backend/activitypub/activities'
import {
	type ApObject,
	getApId,
	getObjectById,
	getObjectUrl,
	isLocalObject,
	originalObjectIdSymbol,
} from '@wildebeest/backend/activitypub/objects'
import { isAttachedToPublicLocalObject, isImage } from '@wildebeest/backend/activitypub/objects/image'
import { type Database, getDatabase } from '@wildebeest/backend/database'
import type { HonoEnv } from '@wildebeest/backend/types'
import { toArray } from '@wildebeest/backend/utils'
import { cors } from '@wildebeest/backend/utils/cors'

const app = new Hono<HonoEnv>()

app.get<'/:id'>(async ({ req, env }) => {
	const domain = new URL(req.url).hostname
	return handleRequest(domain, getDatabase(env), req.param('id'))
})

const headers = {
	...cors(),
	'content-type': 'application/activity+json; charset=utf-8',
}

async function handleRequest(domain: string, db: Database, id: string): Promise<Response> {
	const objectUrl = getObjectUrl(domain, id)
	const obj = await getObjectById(domain, db, objectUrl)
	if (obj === null) {
		return new Response('', { status: 404 })
	}

	// Only local objects addressed to the public are served: remote cached copies are the remote
	// instance's to serve, and followers-only or direct objects must not be readable by anyone.
	if (!isLocalObject(domain, getApId(obj[originalObjectIdSymbol] ?? obj.id))) {
		return new Response('', { status: 404 })
	}
	if (isImage(obj)) {
		if (!(await isAttachedToPublicLocalObject(db, objectUrl))) {
			return new Response('', { status: 404 })
		}
	} else if (!isAddressedToPublic(obj)) {
		return new Response('', { status: 404 })
	}

	const res = {
		// TODO: should this be part of the object?
		'@context': [
			'https://www.w3.org/ns/activitystreams',
			{
				ostatus: 'http://ostatus.org#',
				atomUri: 'ostatus:atomUri',
				inReplyToAtomUri: 'ostatus:inReplyToAtomUri',
				conversation: 'ostatus:conversation',
				sensitive: 'as:sensitive',
				toot: 'http://joinmastodon.org/ns#',
				votersCount: 'toot:votersCount',
			},
		],

		...obj,
	}

	return new Response(JSON.stringify(res), { status: 200, headers })
}

function isAddressedToPublic({ to, cc }: Pick<ApObject, 'to' | 'cc'>): boolean {
	return [...toArray(to ?? []), ...toArray(cc ?? [])].some((target) => getApId(target).toString() === PUBLIC_GROUP)
}

export default app
