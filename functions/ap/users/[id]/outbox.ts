import { getUserId } from 'wildebeest/backend/src/accounts'
import { getActorById } from 'wildebeest/backend/src/activitypub/actors'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import type { ContextData, Env } from 'wildebeest/backend/src/types'
import { isLocalHandle, parseHandle } from 'wildebeest/backend/src/utils/handle'

export const onRequest: PagesFunction<Env, any, ContextData> = async ({ request, env, params }) => {
	const domain = new URL(request.url).hostname
	return handleRequest(domain, await getDatabase(env), params.id as string, env.userKEK)
}

const headers = {
	'content-type': 'application/json; charset=utf-8',
}

// TODO: use userKEK
// eslint-disable-next-line unused-imports/no-unused-vars
export async function handleRequest(domain: string, db: Database, id: string, userKEK: string): Promise<Response> {
	const handle = parseHandle(id)

	if (!isLocalHandle(handle)) {
		return new Response('', { status: 403 })
	}

	const actorId = getUserId(domain, handle)
	const actor = await getActorById(db, actorId)
	if (actor === null) {
		return new Response('', { status: 404 })
	}

	// TODO: eventually move to a shared file
	const QUERY = `
SELECT count(*) as count
FROM outbox_objects
INNER JOIN objects ON objects.id = outbox_objects.object_id
WHERE outbox_objects.actor_id = ? AND objects.type = 'Note'
`

	const { success, error, results } = await db.prepare(QUERY).bind(actorId.toString()).all()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}
	const result: any = (results as any)[0]

	const out = {
		'@context': 'https://www.w3.org/ns/activitystreams',
		id: actor.outbox,
		type: 'OrderedCollection',
		totalItems: result.count,
		first: new URL(actor.outbox + '/page'),
		last: new URL(actor.outbox + '/page?min_id=0'),
	}
	return new Response(JSON.stringify(out), { headers })
}
