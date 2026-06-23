import type { Actor } from '@wildebeest/backend/activitypub/actors'
import { mastodonIdSymbol } from '@wildebeest/backend/activitypub/objects'
import { type Database } from '@wildebeest/backend/database'
import type { MastodonId } from '@wildebeest/backend/types'

import {
	deleteAccountRelationship,
	getSourceMastodonIdsForTargets,
	getTargetMastodonIds,
	insertAccountRelationship,
} from './account_relationship'
import { blockBetweenSql } from './block_sql'
import { removeFollowing } from './follow'

export async function insertBlock(db: Database, actor: Actor, target: Actor) {
	await insertAccountRelationship(db, 'blocks', actor, target)
}

export async function removeBlockRelatedFollows(db: Database, actor: Actor, target: Actor) {
	await removeFollowing(db, actor, target)
	await removeFollowing(db, target, actor)
}

export async function deleteBlock(db: Database, actor: Actor, target: Actor) {
	await deleteAccountRelationship(db, 'blocks', actor, target)
}

export function getBlockedMastodonIds(
	db: Database,
	actor: Actor,
	options: { limit: number; maxId?: MastodonId; targetIds?: MastodonId[] } = { limit: 40 }
): Promise<MastodonId[]> {
	return getTargetMastodonIds(db, 'blocks', actor, options)
}

export function getBlockedByMastodonIds(db: Database, actor: Actor, targetIds: MastodonId[]): Promise<MastodonId[]> {
	return getSourceMastodonIdsForTargets(db, 'blocks', actor, targetIds)
}

export async function hasBlockBetween(
	db: Database,
	actor: Pick<Actor, 'id'>,
	target: Pick<Actor, 'id'>
): Promise<boolean> {
	const actorId = actor.id.toString()
	const targetId = target.id.toString()
	const row = await db
		.prepare(
			`SELECT 1
FROM blocks
WHERE ${blockBetweenSql('?1', '?2')}
LIMIT 1`
		)
		.bind(actorId, targetId)
		.first()
	return row !== null
}

export function isSelfBlock(actor: Actor, target: Actor): boolean {
	return actor[mastodonIdSymbol] === target[mastodonIdSymbol]
}
