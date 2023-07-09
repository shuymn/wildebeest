import {
	cacheActivityObject,
	CreateActivity,
	createActivityId,
	getActivityObject,
	PUBLIC_GROUP,
} from 'wildebeest/backend/src/activitypub/activities'
import { Actor } from 'wildebeest/backend/src/activitypub/actors'
import { actorURL, getActorById, getAndCache } from 'wildebeest/backend/src/activitypub/actors'
import { addObjectInInbox } from 'wildebeest/backend/src/activitypub/actors/inbox'
import { addObjectInOutbox } from 'wildebeest/backend/src/activitypub/actors/outbox'
import { cacheObject, get, getAPId, getObjectByOriginalId } from 'wildebeest/backend/src/activitypub/objects'
import { Note } from 'wildebeest/backend/src/activitypub/objects/note'
import { Database } from 'wildebeest/backend/src/database'
import { createNotification, sendMentionNotification } from 'wildebeest/backend/src/mastodon/notification'
import { insertReply } from 'wildebeest/backend/src/mastodon/reply'
import { parseHandle } from 'wildebeest/backend/src/utils/parse'
import { JWK } from 'wildebeest/backend/src/webpush/jwk'

export function createCreateActivity(domain: string, actor: Actor, object: Note): CreateActivity {
	return {
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
		id: createActivityId(domain),
		type: 'Create',
		actor: actor.id,
		object,
		to: object.to,
		cc: object.cc,
		published: object.published ? object.published : undefined,
	}
}

function extractID(domain: string, s: string | URL): string {
	return s.toString().replace(`https://${domain}/ap/users/`, '')
}

// https://www.w3.org/TR/activitypub/#create-activity-inbox
export async function handleCreateActivity(
	domain: string,
	activity: CreateActivity,
	db: Database,
	adminEmail: string,
	vapidKeys: JWK
) {
	activity.object = getActivityObject(activity)
	const actorId = getAPId(activity.actor)

	// FIXME: download any attachment Objects

	let recipients: Array<string> = []
	let target = PUBLIC_GROUP

	if (Array.isArray(activity.to) && activity.to.length > 0) {
		recipients = [...recipients, ...activity.to.map((to): string => getAPId(to).toString())]

		if (activity.to.length !== 1) {
			console.warn("multiple `Activity.to` isn't supported")
		}
		target = getAPId(activity.to[0]).toString()
	}
	if (Array.isArray(activity.cc) && activity.cc.length > 0) {
		recipients = [...recipients, ...activity.cc.map((cc): string => getAPId(cc).toString())]
	}

	const objectId = getAPId(activity.object)
	const res = await cacheActivityObject(domain, activity.object, db, actorId, objectId)
	if (res === null) {
		return
	}

	if (!res.created) {
		// Object already existed in our database. Probably a duplicated
		// message
		return
	}
	const obj = res.object

	const actor = await getAndCache(actorId, db)

	// This note is actually a reply to another one, record it in the replies
	// table.
	if (obj.type === 'Note' && obj.inReplyTo) {
		const inReplyToObjectId = new URL(obj.inReplyTo)
		let inReplyToObject = await getObjectByOriginalId(db, inReplyToObjectId)

		if (inReplyToObject === null) {
			const remoteObject = await get(inReplyToObjectId)
			const res = await cacheObject(domain, db, remoteObject, actorId, inReplyToObjectId, false)
			inReplyToObject = res.object
		}

		await insertReply(db, actor, obj, inReplyToObject)
	}

	const fromActor = await getAndCache(actorId, db)
	// Add the object in the originating actor's outbox, allowing other
	// actors on this instance to see the note in their timelines.
	await addObjectInOutbox(db, fromActor, obj, activity.published, target)

	for (const recipient of recipients) {
		const url = new URL(recipient)
		if (url.hostname !== domain) {
			console.warn('recipients is not for this instance')
			continue
		}

		const handle = parseHandle(extractID(domain, recipient))
		if (!isLocalAccount(domain, handle)) {
			console.warn('activity not for current instance')
			continue
		}

		const person = await getActorById(db, actorURL(domain, handle))
		if (person === null) {
			console.warn(`person ${recipient} not found`)
			continue
		}

		// FIXME: check if the actor mentions the person
		const notifId = await createNotification(db, 'mention', person, fromActor, obj)
		await Promise.all([
			await addObjectInInbox(db, person, obj),
			await sendMentionNotification(db, fromActor, person, notifId, adminEmail, vapidKeys),
		])
	}
}
