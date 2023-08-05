// https://www.rfc-editor.org/rfc/rfc7033

import { getActorById } from 'wildebeest/backend/src/activitypub/actors'
import type { Env } from 'wildebeest/backend/src/types'
import type { WebFingerResponse } from 'wildebeest/backend/src/webfinger'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { handleToAcct, isLocalHandle, parseHandle } from 'wildebeest/backend/src/utils/handle'
import { getUserId, isLocalAccount } from 'wildebeest/backend/src/accounts'

export const onRequest: PagesFunction<Env, any> = async ({ request, env }) => {
	return handleRequest(request, await getDatabase(env))
}

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
	if (isLocalHandle(handle)) {
		return new Response('', { status: 400 })
	}
	if (!isLocalAccount(domain, handle)) {
		return new Response('', { status: 404 })
	}

	const actor = await getActorById(db, getUserId(domain, handle))
	if (actor === null) {
		return new Response('', { status: 404 })
	}

	const jsonLink = actor.id.toString()

	const res: WebFingerResponse = {
		subject: `acct:${handleToAcct(handle)}`,
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
