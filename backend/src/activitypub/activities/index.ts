import {
	type APObject,
	APObjectId,
	type APObjectOrId,
	cacheObject,
	getAPType,
} from 'wildebeest/backend/src/activitypub/objects'
import { Database } from 'wildebeest/backend/src/database'

export const PUBLIC_GROUP = 'https://www.w3.org/ns/activitystreams#Public'

export interface Activity extends APObject {
	actor: APObjectOrId
	object: APObjectOrId
	target?: APObjectOrId
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
	target: APObjectOrId
}

export interface UndoActivity extends Activity {
	type: 'Undo'
}

export function isUpdateActivity(obj: APObject): obj is UpdateActivity {
	return getAPType(obj) === 'Update'
}

export function isCreateActivity(obj: APObject): obj is CreateActivity {
	return getAPType(obj) === 'Create'
}

export function isAcceptActivity(obj: APObject): obj is AcceptActivity {
	return getAPType(obj) === 'Accept'
}

export function isFollowActivity(obj: APObject): obj is FollowActivity {
	return getAPType(obj) === 'Follow'
}

export function isAnnounceActivity(obj: APObject): obj is AnnounceActivity {
	return getAPType(obj) === 'Announce'
}

export function isLikeActivity(obj: APObject): obj is LikeActivity {
	return getAPType(obj) === 'Like'
}

export function isDeleteActivity(obj: APObject): obj is DeleteActivity {
	return getAPType(obj) === 'Delete'
}

export function isMoveActivity(obj: APObject): obj is MoveActivity {
	return getAPType(obj) === 'Move'
}

// Generate a unique ID. Note that currently the generated URL aren't routable.
export function createActivityId(domain: string): APObjectId {
	const id = crypto.randomUUID()
	return new URL('/ap/a/' + id, 'https://' + domain)
}

export function getActivityObject(activity: Activity): APObject {
	if (typeof activity.object === 'string' || activity.object instanceof URL) {
		throw new Error('`activity.object` must be of type object')
	}
	return activity.object
}

export async function cacheActivityObject(
	domain: string,
	obj: APObject,
	db: Database,
	originalActorId: URL,
	originalObjectId: URL
): Promise<ReturnType<typeof cacheObject> | null> {
	switch (obj.type) {
		case 'Note': {
			return cacheObject(domain, db, obj, originalActorId, originalObjectId, false)
		}

		default: {
			console.warn(`Unsupported Create object: ${obj.type}`)
			return null
		}
	}
}
