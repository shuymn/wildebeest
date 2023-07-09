import {
	Activity,
	isAcceptActivity,
	isAnnounceActivity,
	isCreateActivity,
	isDeleteActivity,
	isFollowActivity,
	isLikeActivity,
	isMoveActivity,
	isUpdateActivity,
} from 'wildebeest/backend/src/activitypub/activities'
import { handleAcceptActivity } from 'wildebeest/backend/src/activitypub/activities/accept'
import { handleAnnounceActivity } from 'wildebeest/backend/src/activitypub/activities/announce'
import { handleCreateActivity } from 'wildebeest/backend/src/activitypub/activities/create'
import { handleDeleteActivity } from 'wildebeest/backend/src/activitypub/activities/delete'
import { handleFollowActivity } from 'wildebeest/backend/src/activitypub/activities/follow'
import { handleLikeActivity } from 'wildebeest/backend/src/activitypub/activities/like'
import { handleMoveActivity } from 'wildebeest/backend/src/activitypub/activities/move'
import { handleUpdateActivity } from 'wildebeest/backend/src/activitypub/activities/update'
import { Database } from 'wildebeest/backend/src/database'
import { JWK } from 'wildebeest/backend/src/webpush/jwk'

export async function handle(
	domain: string,
	activity: Activity,
	db: Database,
	userKEK: string,
	adminEmail: string,
	vapidKeys: JWK
) {
	if (isUpdateActivity(activity)) {
		return await handleUpdateActivity(activity, db)
	}
	if (isCreateActivity(activity)) {
		return await handleCreateActivity(domain, activity, db, adminEmail, vapidKeys)
	}
	if (isAcceptActivity(activity)) {
		return await handleAcceptActivity(domain, activity, db)
	}
	if (isFollowActivity(activity)) {
		return await handleFollowActivity(domain, activity, db, userKEK, adminEmail, vapidKeys)
	}
	if (isAnnounceActivity(activity)) {
		return await handleAnnounceActivity(domain, activity, db, adminEmail, vapidKeys)
	}
	if (isLikeActivity(activity)) {
		return await handleLikeActivity(activity, db, adminEmail, vapidKeys)
	}
	if (isDeleteActivity(activity)) {
		return await handleDeleteActivity(activity, db)
	}
	if (isMoveActivity(activity)) {
		return await handleMoveActivity(domain, activity, db)
	}
	console.warn(`Unsupported activity: ${activity.type}`)
}
