import { Hono } from 'hono'

import { getLocalActorPublicKey, getUserId, getUserUrl, isLocalAccount } from '@wildebeest/backend/accounts'
import * as actors from '@wildebeest/backend/activitypub/actors'
import { type Database, getDatabase } from '@wildebeest/backend/database'
import type { HonoEnv } from '@wildebeest/backend/types'
import { cors } from '@wildebeest/backend/utils/cors'
import { parseHandle } from '@wildebeest/backend/utils/handle'

const app = new Hono<HonoEnv>()

app.get<'/:id'>(async ({ req, env }) => {
	const domain = new URL(req.url).hostname
	return handleRequest(domain, getDatabase(env), req.param('id'))
})

const headers = {
	...cors(),
	'content-type': 'application/activity+json; charset=utf-8',
	'Cache-Control': 'max-age=180, public',
}

async function handleRequest(domain: string, db: Database, id: string): Promise<Response> {
	const handle = parseHandle(id)

	if (!isLocalAccount(domain, handle)) {
		return new Response('', { status: 403 })
	}

	const actorId = getUserId(domain, handle)
	const person = await actors.getActorById(db, actorId)
	if (person === null) {
		return new Response('', { status: 404 })
	}

	// Serve the identity we control instead of the stored properties, which a
	// forged `Update` could have overwritten.
	const canonicalId = actorId.toString()
	const identity = {
		id: actorId,
		inbox: new URL(canonicalId + '/inbox'),
		outbox: new URL(canonicalId + '/outbox'),
		following: new URL(canonicalId + '/following'),
		followers: new URL(canonicalId + '/followers'),
		url: getUserUrl(domain, handle).toString(),
		publicKey: (await getLocalActorPublicKey(db, actorId)) ?? undefined,
	}

	const res = {
		// TODO: should this be part of the actor object?
		'@context': [
			'https://www.w3.org/ns/activitystreams',
			'https://w3id.org/security/v1',
			{
				toot: 'http://joinmastodon.org/ns#',
				discoverable: 'toot:discoverable',
				alsoKnownAs: {
					'@id': 'as:alsoKnownAs',
					'@type': '@id',
				},
			},
		],

		...person,
		...identity,
	}

	return new Response(JSON.stringify(res), { status: 200, headers })
}

export default app
