import type { Actor } from '@wildebeest/backend/activitypub/actors'
import type { Database } from '@wildebeest/backend/database'
import type { MastodonId } from '@wildebeest/backend/types'
import type { Relationship } from '@wildebeest/backend/types/account'

import { getBlockedByMastodonIds, getBlockedMastodonIds } from './block'
import {
	getFollowerMastodonIdsForTargets,
	getFollowingRelationshipsForTargets,
	getFollowingRequestedMastodonIdsForTargets,
} from './follow'
import { getMutedMastodonRelationships } from './mute'

export function makeRelationship(id: MastodonId, overrides: Partial<Omit<Relationship, 'id'>> = {}): Relationship {
	return {
		id,
		following: false,
		showing_reblogs: false,
		notifying: false,
		followed_by: false,
		blocking: false,
		blocked_by: false,
		muting: false,
		muting_notifications: false,
		requested: false,
		domain_blocking: false,
		endorsed: false,
		note: '',
		...overrides,
	}
}

export async function getRelationships(db: Database, actor: Actor, ids: MastodonId[]): Promise<Relationship[]> {
	const [following, followedBy, followingRequested, blocking, blockedBy, muting] = await Promise.all([
		getFollowingRelationshipsForTargets(db, actor, ids),
		getFollowerMastodonIdsForTargets(db, actor, ids),
		getFollowingRequestedMastodonIdsForTargets(db, actor, ids),
		getBlockedMastodonIds(db, actor, { limit: ids.length, targetIds: ids }),
		getBlockedByMastodonIds(db, actor, ids),
		getMutedMastodonRelationships(db, actor, { limit: ids.length, targetIds: ids }),
	])

	const followingMap = new Map(following.map((follow) => [follow.mastodon_id, follow]))
	const followedBySet = new Set(followedBy)
	const followingRequestedSet = new Set(followingRequested)
	const blockingSet = new Set(blocking)
	const blockedBySet = new Set(blockedBy)
	const mutingMap = new Map(muting.map((mute) => [mute.mastodon_id, mute.hide_notifications !== 0]))

	return ids.map((id) => {
		const follow = followingMap.get(id)
		return makeRelationship(id, {
			following: follow !== undefined,
			showing_reblogs: follow ? follow.show_reblogs !== 0 : false,
			notifying: follow?.notify === 1,
			languages: follow?.languages ? JSON.parse(follow.languages) : undefined,
			followed_by: followedBySet.has(id),
			requested: followingRequestedSet.has(id),
			blocking: blockingSet.has(id),
			blocked_by: blockedBySet.has(id),
			muting: mutingMap.has(id),
			muting_notifications: mutingMap.get(id) ?? false,
		})
	})
}

export async function getRelationship(db: Database, actor: Actor, id: MastodonId): Promise<Relationship> {
	const [relationship] = await getRelationships(db, actor, [id])
	return relationship
}
