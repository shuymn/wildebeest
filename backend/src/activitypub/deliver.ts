// https://www.w3.org/TR/activitypub/#delivery

import { type Database } from 'wildebeest/backend/src/database'
import { getFollowerIds } from 'wildebeest/backend/src/mastodon/follow'
import type { DeliverMessageBody, MessageSendRequest, Queue } from 'wildebeest/backend/src/types'
import { MessageType } from 'wildebeest/backend/src/types'
import { signRequest } from 'wildebeest/backend/src/utils/http-signing'
import { generateDigestHeader } from 'wildebeest/backend/src/utils/http-signing-cavage'
import { getFederationUA } from 'wildebeest/config/ua'

import type { Activity } from './activities'
import type { Actor } from './actors'

const MAX_BATCH_SIZE = 100

export async function deliverToActor<T extends Activity>(
	signingKey: CryptoKey,
	from: Actor,
	to: Actor,
	activity: T,
	domain: string
) {
	const headers = {
		Accept: 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
		'Content-Type': 'application/activity+json',
		'User-Agent': getFederationUA(domain),
	}

	const body = JSON.stringify(activity)
	console.log({ body })
	const req = new Request(to.inbox, {
		method: 'POST',
		body,
		headers,
	})
	const digest = await generateDigestHeader(body)
	req.headers.set('Digest', digest)
	await signRequest(req, signingKey, new URL(from.publicKey?.id ?? from.id))

	const res = await fetch(req)
	if (!res.ok) {
		const body = await res.text()
		throw new Error(`delivery to ${to.inbox} returned ${res.status}: ${body}`)
	}
	console.log(`${to.inbox} returned 200`)
}

// TODO: eventually move this to the queue worker, the backend can send a message
// to a collection (followers) and the worker creates the individual messages. More
// reliable and scalable.
export async function deliverFollowers(
	db: Database,
	userKEK: string,
	from: Actor,
	activity: Activity,
	queue: Queue<DeliverMessageBody>
) {
	const followers = await getFollowerIds(db, from)
	if (followers.length === 0) {
		// No one is following the user so no updates to send. Sad.
		return
	}

	const messages: Array<MessageSendRequest<DeliverMessageBody>> = followers.map((id) => {
		const body = {
			// Make sure the object is supported by `structuredClone()`, ie
			// removing the URL objects as they aren't cloneable.
			activity: JSON.parse(JSON.stringify(activity)),

			actorId: from.id.toString(),
			toActorId: id,
			type: MessageType.Deliver,
			userKEK,
		}
		return { body }
	})

	const promises = []

	// Send the messages as batch in the queue. Since queue support up to 100
	// messages per batch, send multiple batches.
	while (messages.length > 0) {
		const batch = messages.splice(0, MAX_BATCH_SIZE)
		promises.push(queue.sendBatch(batch))
	}

	await Promise.allSettled(promises)
}
