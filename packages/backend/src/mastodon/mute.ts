import type { Actor } from '@wildebeest/backend/activitypub/actors'
import { type Database } from '@wildebeest/backend/database'
import type { MastodonId } from '@wildebeest/backend/types'

import { deleteAccountRelationship, getTargetMastodonIds, insertAccountRelationship } from './account_relationship'

export async function insertMute(db: Database, actor: Actor, target: Actor, hideNotifications = true) {
	await insertAccountRelationship(db, 'mutes', actor, target, { hideNotifications })
}

export async function deleteMute(db: Database, actor: Actor, target: Actor) {
	await deleteAccountRelationship(db, 'mutes', actor, target)
}

export function getMutedMastodonIds(
	db: Database,
	actor: Actor,
	options: { limit: number; maxId?: MastodonId; targetIds?: MastodonId[] } = { limit: 40 }
): Promise<MastodonId[]> {
	return getTargetMastodonIds(db, 'mutes', actor, options)
}

export type MutedMastodonRelationship = {
	mastodon_id: MastodonId
	hide_notifications: number
}

export async function getMutedMastodonRelationships(
	db: Database,
	actor: Actor,
	{ limit, maxId, targetIds }: { limit: number; maxId?: MastodonId; targetIds?: MastodonId[] } = { limit: 40 }
): Promise<MutedMastodonRelationship[]> {
	if (targetIds?.length === 0) {
		return []
	}

	const targetFilter = targetIds ? `AND actors.mastodon_id IN (${targetIds.map(() => '?').join(', ')})` : ''
	const statement = db
		.prepare(
			`
SELECT actors.mastodon_id, mutes.hide_notifications
FROM mutes
INNER JOIN actors ON actors.id = mutes.target_account_id
WHERE mutes.account_id = ?
  AND (? IS NULL OR actors.mastodon_id < ?)
  ${targetFilter}
ORDER BY actors.mastodon_id DESC
LIMIT ?
`
		)
		.bind(actor.id.toString(), maxId ?? null, maxId ?? null, ...(targetIds ?? []), limit)

	const { success, error, results } = await statement.all<MutedMastodonRelationship>()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}
	return results ?? []
}
