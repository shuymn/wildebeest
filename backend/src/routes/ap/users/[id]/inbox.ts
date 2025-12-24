import { Hono } from 'hono'

import { getUserId, isLocalAccount } from 'wildebeest/backend/src/accounts'
import type { Activity } from 'wildebeest/backend/src/activitypub/activities'
import * as actors from 'wildebeest/backend/src/activitypub/actors'
import { getVAPIDKeys } from 'wildebeest/backend/src/config'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import type { HonoEnv, InboxMessageBody } from 'wildebeest/backend/src/types'
import { MessageType } from 'wildebeest/backend/src/types'
import { parseHandle } from 'wildebeest/backend/src/utils/handle'
import { generateDigestHeader } from 'wildebeest/backend/src/utils/http-signing-cavage'
import { parseRequest } from 'wildebeest/backend/src/utils/httpsigjs/parser'
import { fetchKey, verifySignature } from 'wildebeest/backend/src/utils/httpsigjs/verifier'
import type { JWK } from 'wildebeest/backend/src/webpush/jwk'

const app = new Hono<HonoEnv>()

app.all<'/:id/inbox'>(async ({ req, env }) => {
	try {
		const parsedSignature = parseRequest(req.raw)
		const pubKey = await fetchKey(parsedSignature)
		if (pubKey === null) {
			return new Response('signature key not found', { status: 401 })
		}
		const valid = await verifySignature(parsedSignature, pubKey)
		if (!valid) {
			return new Response('invalid signature', { status: 401 })
		}
	} catch (err) {
		if (err instanceof Error) {
			console.warn(err.stack)
		} else {
			console.warn(err)
		}
		return new Response('signature verification failed', { status: 401 })
	}

	const body = await req.text()
	if (req.method == 'POST') {
		const digest = req.header('digest')
		const generatedDigest = await generateDigestHeader(body)
		if (digest != generatedDigest) {
			return new Response('invalid digest', { status: 401 })
		}
	}

	const activity = JSON.parse(body) as Activity
	const domain = new URL(req.url).hostname
	return handleRequest(domain, getDatabase(env), req.param('id'), activity, env.QUEUE, env.userKEK, getVAPIDKeys(env))
})

async function handleRequest(
	domain: string,
	db: Database,
	id: string,
	activity: Activity,
	queue: Queue<InboxMessageBody>,
	userKEK: string,
	vapidKeys: JWK
): Promise<Response> {
	const handle = parseHandle(id)

	if (!isLocalAccount(domain, handle)) {
		return new Response('', { status: 403 })
	}
	const actorId = getUserId(domain, handle)

	const actor = await actors.getActorById(db, actorId)
	if (actor === null) {
		return new Response('', { status: 404 })
	}

	await queue.send({
		type: MessageType.Inbox,
		actorId: actor.id.toString(),
		activity,
		userKEK,
		vapidKeys,
	})

	return new Response('', { status: 200 })
}

export default app
