import { getUserId, isLocalAccount } from 'wildebeest/backend/src/accounts'
import {
	cacheActivityObject,
	CreateActivity,
	getActivityObject,
	insertActivity,
} from 'wildebeest/backend/src/activitypub/activities'
import { Actor, getActorById, getAndCacheActor } from 'wildebeest/backend/src/activitypub/actors'
import { addObjectInInbox } from 'wildebeest/backend/src/activitypub/actors/inbox'
import { addObjectInOutbox } from 'wildebeest/backend/src/activitypub/actors/outbox'
import { ApObject, getApId } from 'wildebeest/backend/src/activitypub/objects'
import { Note } from 'wildebeest/backend/src/activitypub/objects/note'
import { Database } from 'wildebeest/backend/src/database'
import { createNotification, sendMentionNotification } from 'wildebeest/backend/src/mastodon/notification'
import { toArray, unique } from 'wildebeest/backend/src/utils'
import { parseHandle } from 'wildebeest/backend/src/utils/handle'
import { RequiredProps } from 'wildebeest/backend/src/utils/type'
import { JWK } from 'wildebeest/backend/src/webpush/jwk'

export async function createCreateActivity(
	db: Database,
	domain: string,
	actor: Actor,
	object: RequiredProps<Note, 'published'>
): Promise<RequiredProps<CreateActivity, 'to' | 'cc' | 'published'>> {
	return await insertActivity(db, domain, actor, {
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
		type: 'Create',
		actor: actor.id,
		object,
		to: object.to,
		cc: object.cc,
		published: object.published,
	})
}

function extractID(domain: string, s: string | URL): string {
	return s.toString().replace(`https://${domain}/ap/users/`, '')
}

function isRecipientMatch(
	activity: Required<Pick<CreateActivity, 'to' | 'cc'>>,
	obj: Required<Pick<ApObject, 'to' | 'cc'>>
): boolean {
	const [actTo, actCc, objTo, objCc] = [activity.to, activity.cc, obj.to, obj.cc]
		.map(toArray)
		.map(unique)
		.map((arr) => arr.map((obj) => getApId(obj).toString()))

	if (actTo.length !== objTo.length || actCc.length !== objCc.length) {
		return false
	}

	return actTo.every((to) => objTo.includes(to)) && actCc.every((cc) => objCc.includes(cc))
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

	const actorId = getApId(activity.actor)
	const actor = await getAndCacheActor(actorId, db)
	if (!actor) {
		console.warn(`actor ${actorId} not found`)
		return
	}

	const res = await cacheActivityObject(domain, db, getActivityObject(activity), actor)
	if (!res?.created) {
		// Object already existed in our database. Probably a duplicated
		// message
		return
	}
	const obj = res.object

	if (!isRecipientMatch({ to: activity.to ?? [], cc: activity.cc ?? [] }, { to: obj.to ?? [], cc: obj.cc ?? [] })) {
		console.warn('activity recipients do not match object recipients.', {
			activity: { to: activity.to, cc: activity.cc },
			object: { to: obj.to, cc: obj.cc },
		})
		return
	}

	const recipients = new Map<string, URL>()

	const to = activity.to === undefined ? (obj.to === undefined ? [] : toArray(obj.to)) : toArray(activity.to)
	if (to.length > 0) {
		for (const target of to) {
			const targetId = getApId(target)
			const targetIdStr = targetId.toString()
			recipients.set(targetIdStr, targetId)
		}
	}

	const cc = activity.cc === undefined ? (obj.cc === undefined ? [] : toArray(obj.cc)) : toArray(activity.cc)
	if (cc.length > 0) {
		for (const target of cc) {
			const targetId = getApId(target)
			const targetIdStr = targetId.toString()
			recipients.set(targetIdStr, targetId)
		}
	}

	// Add the object in the originating actor's outbox, allowing other
	// actors on this instance to see the note in their timelines.
	await addObjectInOutbox(db, actor, obj, activity.to ?? obj.to, activity.cc ?? obj.cc, activity.published)

	for (const rec of recipients.values()) {
		if (!rec.toString().startsWith(`https://${domain}/ap/users/`)) {
			continue
		}

		const handle = parseHandle(extractID(domain, rec))
		if (!isLocalAccount(domain, handle)) {
			console.warn('activity not for current instance')
			continue
		}

		const person = await getActorById(db, getUserId(domain, handle))
		if (person === null) {
			console.warn(`person ${rec} not found`)
			continue
		}
		if (person.type !== 'Person') {
			console.warn(`person ${rec} is not a Person`)
			continue
		}

		const notifId = await createNotification(db, 'mention', person, actor, obj)
		await Promise.all([
			await addObjectInInbox(db, person, obj),
			await sendMentionNotification(db, actor, person, notifId, adminEmail, vapidKeys),
		])
	}
}
