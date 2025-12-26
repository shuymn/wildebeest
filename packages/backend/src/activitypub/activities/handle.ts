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
} from '@wildebeest/backend/activitypub/activities'
import { handleAcceptActivity } from '@wildebeest/backend/activitypub/activities/accept'
import { handleAnnounceActivity } from '@wildebeest/backend/activitypub/activities/announce'
import { handleCreateActivity } from '@wildebeest/backend/activitypub/activities/create'
import { handleDeleteActivity } from '@wildebeest/backend/activitypub/activities/delete'
import { handleFollowActivity } from '@wildebeest/backend/activitypub/activities/follow'
import { handleLikeActivity } from '@wildebeest/backend/activitypub/activities/like'
import { handleMoveActivity } from '@wildebeest/backend/activitypub/activities/move'
import { handleUpdateActivity } from '@wildebeest/backend/activitypub/activities/update'
import { Database } from '@wildebeest/backend/database'
import { JWK } from '@wildebeest/backend/webpush/jwk'

export async function handle(
	domain: string,
	activity: Activity,
	db: Database,
	userKEK: string,
	adminEmail: string,
	vapidKeys: JWK
) {
	if (isUpdateActivity(activity)) {
		return await handleUpdateActivity(domain, activity, db)
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
		return await handleLikeActivity(domain, activity, db, adminEmail, vapidKeys)
	}
	if (isDeleteActivity(activity)) {
		return await handleDeleteActivity(domain, activity, db)
	}
	if (isMoveActivity(activity)) {
		return await handleMoveActivity(domain, activity, db)
	}
	console.warn(`Unsupported activity: ${activity.type}`)
}
