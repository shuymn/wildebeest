import { Actor } from '@wildebeest/backend/activitypub/actors'
import {
	type ApObject,
	type ApObjectOrId,
	getAndCacheObject,
	getApType,
	Remote,
} from '@wildebeest/backend/activitypub/objects'
import { isNote, Note } from '@wildebeest/backend/activitypub/objects/note'
import { Database } from '@wildebeest/backend/database'
import { HTTPS } from '@wildebeest/backend/utils'
import { PartialProps } from '@wildebeest/backend/utils/type'

export const PUBLIC_GROUP = 'https://www.w3.org/ns/activitystreams#Public'

export type Activity<O extends ApObject = ApObject> = ApObject & {
	actor: ApObjectOrId<Actor>
	object: ApObjectOrId<O>
}

export type UpdateActivity<O extends ApObject = ApObject> = Activity<O> & {
	type: 'Update'
}

export type CreateActivity<O extends ApObject = ApObject> = Activity<O> & {
	type: 'Create'
}

export type AcceptActivity<O extends ApObject = ApObject> = Activity<O> & {
	type: 'Accept'
}

export type FollowActivity<O extends ApObject = ApObject> = Activity<O> & {
	type: 'Follow'
}

export type AnnounceActivity<O extends ApObject = ApObject> = Activity<O> & {
	type: 'Announce'
}

export type LikeActivity<O extends ApObject = ApObject> = Activity<O> & {
	type: 'Like'
}

export type DeleteActivity<O extends ApObject = ApObject> = Activity<O> & {
	type: 'Delete'
}

export type MoveActivity<O extends ApObject = ApObject, T extends ApObject = ApObject> = Activity<O> & {
	type: 'Move'
	target: ApObjectOrId<T>
}

export type UndoActivity<O extends ApObject = ApObject> = Activity<O> & {
	type: 'Undo'
}

export function isUpdateActivity(obj: ApObject): obj is UpdateActivity {
	return getApType(obj) === 'Update'
}

export function isCreateActivity(obj: ApObject): obj is CreateActivity {
	return getApType(obj) === 'Create'
}

export function isAcceptActivity(obj: ApObject): obj is AcceptActivity {
	return getApType(obj) === 'Accept'
}

export function isFollowActivity(obj: ApObject): obj is FollowActivity {
	return getApType(obj) === 'Follow'
}

export function isAnnounceActivity(obj: ApObject): obj is AnnounceActivity {
	return getApType(obj) === 'Announce'
}

export function isLikeActivity(obj: ApObject): obj is LikeActivity {
	return getApType(obj) === 'Like'
}

export function isDeleteActivity(obj: ApObject): obj is DeleteActivity {
	return getApType(obj) === 'Delete'
}

export function isMoveActivity(obj: ApObject): obj is MoveActivity {
	return getApType(obj) === 'Move'
}

export function getActivityObject(activity: Activity): ApObject {
	if (typeof activity.object === 'string' || activity.object instanceof URL) {
		throw new Error('`activity.object` must be of type object')
	}
	return activity.object
}

export async function cacheActivityObject<T extends ApObject>(
	domain: string,
	db: Database,
	obj: Remote<T>,
	actor: Actor
) {
	if (isNote(obj)) {
		return getAndCacheObject<Note>(domain, db, obj, actor)
	}
	console.warn(`Unsupported Create object: ${obj.type}`)
	return null
}

function getActivityUrl(domain: string, id: string): URL {
	return new URL('/ap/a/' + id, HTTPS + domain)
}

export async function insertActivity<T extends Activity>(
	db: Database,
	domain: string,
	actor: Actor,
	activity: PartialProps<T, 'id'>
): Promise<T> {
	// Generate a unique ID. Note that currently the generated URL aren't routable.
	const id = crypto.randomUUID()
	activity.id = getActivityUrl(domain, id)

	const result = await db
		.prepare(
			`
INSERT INTO actor_activities (id, actor_id, activity)
VALUES (?, ?, ?)
  `
		)
		.bind(id, actor.id.toString(), JSON.stringify(activity))
		.run()
	if (!result.success) {
		throw new Error('SQL error: ' + result.error)
	}
	return activity as T
}
