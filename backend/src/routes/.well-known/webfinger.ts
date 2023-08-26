// https://www.rfc-editor.org/rfc/rfc7033

import { Hono } from 'hono'

import { getActorByRemoteHandle } from 'wildebeest/backend/src/activitypub/actors'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { HonoEnv } from 'wildebeest/backend/src/types'
import { parseHandle, actorToAcct } from 'wildebeest/backend/src/utils/handle'
import { WebFingerResponse } from 'wildebeest/backend/src/webfinger'

const app = new Hono<HonoEnv>()

app.get(async (c) => {
	return handleRequest(c.req.raw, await getDatabase(c.env))
})

const headers = {
	'content-type': 'application/jrd+json',
	'cache-control': 'max-age=3600, public',
}

export async function handleRequest(request: Request, db: Database): Promise<Response> {
	const url = new URL(request.url)
	const domain = url.hostname
	const resource = url.searchParams.get('resource')
	if (!resource) {
		return new Response('', { status: 400 })
	}

	const parts = resource.split(':')
	if (parts.length !== 2 || parts[0] !== 'acct') {
		return new Response('', { status: 400 })
	}

	const handle = parseHandle(parts[1])
	if (handle.domain === null) {
		return new Response('', { status: 400 })
	}
	if (handle.domain !== domain) {
		return new Response('', { status: 404 })
	}

	const actor = await getActorByRemoteHandle(db, handle)
	if (actor === null) {
		return new Response('', { status: 404 })
	}

	const jsonLink = actor.id.toString()

	const res: WebFingerResponse = {
		subject: `acct:${actorToAcct(actor)}`,
		aliases: [jsonLink],
		links: [
			{
				rel: 'self',
				type: 'application/activity+json',
				href: jsonLink,
			},
		],
	}

	return new Response(JSON.stringify(res), { headers })
}

export default app
