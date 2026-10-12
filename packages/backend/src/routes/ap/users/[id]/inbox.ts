import { Hono } from 'hono'

import { getUserId, isLocalAccount } from '@wildebeest/backend/accounts'
import type { Activity } from '@wildebeest/backend/activitypub/activities'
import * as actors from '@wildebeest/backend/activitypub/actors'
import { getApId } from '@wildebeest/backend/activitypub/objects'
import { getVAPIDKeys } from '@wildebeest/backend/config'
import { type Database, getDatabase } from '@wildebeest/backend/database'
import type { HonoEnv, InboxMessageBody, Queue } from '@wildebeest/backend/types'
import { MessageType } from '@wildebeest/backend/types'
import { parseHandle } from '@wildebeest/backend/utils/handle'
import { generateDigestHeader } from '@wildebeest/backend/utils/http-signing-cavage'
import { parseRequest } from '@wildebeest/backend/utils/httpsigjs/parser'
import { fetchKeyOwner, verifySignature } from '@wildebeest/backend/utils/httpsigjs/verifier'
import type { JWK } from '@wildebeest/backend/webpush/jwk'

const app = new Hono<HonoEnv>()

app.all<'/:id/inbox'>(async ({ req, env }) => {
	let signerId: string
	try {
		const parsedSignature = parseRequest(req.raw)
		const keyOwner = await fetchKeyOwner(parsedSignature)
		if (keyOwner === null) {
			return new Response('signature key not found', { status: 401 })
		}
		const valid = await verifySignature(parsedSignature, keyOwner.key)
		if (!valid) {
			return new Response('invalid signature', { status: 401 })
		}
		signerId = keyOwner.ownerId.toString()
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

	// The signature proves who sent the request; the activity is only accepted
	// when it claims to come from that very actor.
	let activityActor: string
	try {
		activityActor = getApId(activity.actor).toString()
	} catch {
		return new Response('invalid actor', { status: 401 })
	}
	if (activityActor !== signerId) {
		console.warn(`activity actor ${activityActor} does not match the signature key owner ${signerId}`)
		return new Response('actor does not match signature', { status: 401 })
	}

	const domain = new URL(req.url).hostname
	return handleRequest(
		domain,
		getDatabase(env),
		req.param('id'),
		activity,
		signerId,
		env.QUEUE,
		env.userKEK,
		getVAPIDKeys(env)
	)
})

async function handleRequest(
	domain: string,
	db: Database,
	id: string,
	activity: Activity,
	signerId: string,
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
		signerId,
		activity,
		userKEK,
		vapidKeys,
	})

	return new Response('', { status: 200 })
}

export default app
