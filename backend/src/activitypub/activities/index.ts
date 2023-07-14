import {
	type ApObject,
	ApObjectId,
	type ApObjectOrId,
	cacheObject,
	getApType,
} from 'wildebeest/backend/src/activitypub/objects'
import { Database } from 'wildebeest/backend/src/database'

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

// Generate a unique ID. Note that currently the generated URL aren't routable.
export function createActivityId(domain: string): ApObjectId {
	const id = crypto.randomUUID()
	return new URL('/ap/a/' + id, 'https://' + domain)
}

export function getActivityObject(activity: Activity): ApObject {
	if (typeof activity.object === 'string' || activity.object instanceof URL) {
		throw new Error('`activity.object` must be of type object')
	}
	return activity.object
}

export async function cacheActivityObject(
	domain: string,
	obj: ApObject,
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
