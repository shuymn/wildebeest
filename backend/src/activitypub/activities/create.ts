import { isLocalAccount } from 'wildebeest/backend/src/accounts/getAccount'
import {
	cacheActivityObject,
	CreateActivity,
	createActivityId,
	getActivityObject,
} from 'wildebeest/backend/src/activitypub/activities'
import { Actor } from 'wildebeest/backend/src/activitypub/actors'
import { actorURL, getActorById, getAndCache } from 'wildebeest/backend/src/activitypub/actors'
import { addObjectInInbox } from 'wildebeest/backend/src/activitypub/actors/inbox'
import { addObjectInOutbox } from 'wildebeest/backend/src/activitypub/actors/outbox'
import { cacheObject, get, getApId, getObjectByOriginalId } from 'wildebeest/backend/src/activitypub/objects'
import { Note } from 'wildebeest/backend/src/activitypub/objects/note'
import { Database } from 'wildebeest/backend/src/database'
import { createNotification, sendMentionNotification } from 'wildebeest/backend/src/mastodon/notification'
import { insertReply } from 'wildebeest/backend/src/mastodon/reply'
import { parseHandle } from 'wildebeest/backend/src/utils/handle'
import { RequiredProps } from 'wildebeest/backend/src/utils/type'
import { JWK } from 'wildebeest/backend/src/webpush/jwk'

export function createCreateActivity(domain: string, actor: Actor, object: RequiredProps<Note, 'published'>) {
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
		published: object.published,
	} satisfies CreateActivity
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
	// FIXME: download any attachment Objects

	const recipients: URL[] = []
	const targets: string[] = []

	const to = activity.to === undefined ? [] : Array.isArray(activity.to) ? activity.to : [activity.to]
	if (to.length > 0) {
		recipients.push(...to.map(getApId))
		targets.push(...to.map((s) => getApId(s).toString()))
	}
	const cc = activity.cc === undefined ? [] : Array.isArray(activity.cc) ? activity.cc : [activity.cc]
	if (cc.length > 0) {
		recipients.push(...cc.map(getApId))
	}

	activity.object = getActivityObject(activity)
	const actorId = getApId(activity.actor)
	const objectId = getApId(activity.object)
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
		const inReplyToObjectId = getApId(obj.inReplyTo)
		let inReplyToObject = await getObjectByOriginalId(db, inReplyToObjectId)

		if (inReplyToObject === null) {
			const remoteObject = await get<Note>(inReplyToObjectId)
			const res = await cacheObject<Note>(domain, db, remoteObject, actorId, inReplyToObjectId, false)
			inReplyToObject = res.object
		}

		await insertReply(db, actor, obj, inReplyToObject)
	}

	const fromActor = await getAndCache(actorId, db)
	// Add the object in the originating actor's outbox, allowing other
	// actors on this instance to see the note in their timelines.
	for (const t of targets) {
		await addObjectInOutbox(db, fromActor, obj, activity.published, t)
	}

	for (const url of recipients) {
		if (url.hostname !== domain) {
			continue
		}

		const handle = parseHandle(extractID(domain, url))
		if (!isLocalAccount(domain, handle)) {
			console.warn('activity not for current instance')
			continue
		}

		const person = await getActorById(db, actorURL(domain, handle))
		if (person === null) {
			console.warn(`person ${url} not found`)
			continue
		}
		if (person.type !== 'Person') {
			console.warn(`person ${url} is not a Person`)
			continue
		}

		const notifId = await createNotification(db, 'mention', person, fromActor, obj)
		await Promise.all([
			await addObjectInInbox(db, person, obj),
			await sendMentionNotification(db, fromActor, person, notifId, adminEmail, vapidKeys),
		])
	}
}
