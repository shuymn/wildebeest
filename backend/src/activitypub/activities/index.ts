import { Actor } from 'wildebeest/backend/src/activitypub/actors'
import { type ApObject, type ApObjectOrId, cacheObject, getApType } from 'wildebeest/backend/src/activitypub/objects'
import { isNote } from 'wildebeest/backend/src/activitypub/objects/note'
import { Database } from 'wildebeest/backend/src/database'
import { PartialProps } from 'wildebeest/backend/src/utils/type'

export const PUBLIC_GROUP = 'https://www.w3.org/ns/activitystreams#Public'

export interface Activity extends ApObject {
	actor: ApObjectOrId
	object: ApObjectOrId
	target?: ApObjectOrId
}

export interface UpdateActivity extends Activity {
	type: 'Update'
}

export interface CreateActivity extends Activity {
	type: 'Create'
}

export interface AcceptActivity extends Activity {
	type: 'Accept'
}

export interface FollowActivity extends Activity {
	type: 'Follow'
}

export interface AnnounceActivity extends Activity {
	type: 'Announce'
}

export interface LikeActivity extends Activity {
	type: 'Like'
}

export interface DeleteActivity extends Activity {
	type: 'Delete'
}

export interface MoveActivity extends Activity {
	type: 'Move'
	target: ApObjectOrId
}

export interface UndoActivity extends Activity {
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
	obj: T,
	db: Database,
	originalActorId: URL,
	originalObjectId: URL
) {
	if (isNote(obj)) {
		return cacheObject(domain, db, obj, originalActorId, originalObjectId, false)
	}
	console.warn(`Unsupported Create object: ${obj.type}`)
	return null
}

export async function insertActivity<T extends Activity>(
	db: Database,
	domain: string,
	actor: Actor,
	activity: PartialProps<T, 'id'>
): Promise<T> {
	// Generate a unique ID. Note that currently the generated URL aren't routable.
	const id = crypto.randomUUID()
	activity.id = new URL('/ap/a/' + id, 'https://' + domain)

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
