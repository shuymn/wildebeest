import type { Actor } from '@wildebeest/backend/activitypub/actors'
import type { Database } from '@wildebeest/backend/database'
import type { MastodonId } from '@wildebeest/backend/types'

import { getResultsField } from './utils'

type RelationshipTable = 'blocks' | 'mutes'

const TABLE_NAME: Record<RelationshipTable, string> = {
	blocks: 'blocks',
	mutes: 'mutes',
}

export async function insertAccountRelationship(
	db: Database,
	table: RelationshipTable,
	actor: Actor,
	target: Actor,
	options: { hideNotifications?: boolean } = {}
): Promise<void> {
	const isMute = table === 'mutes'
	const hideNotifications = options.hideNotifications ?? true
	const statement = isMute
		? db
				.prepare(
					`
INSERT INTO mutes (id, account_id, target_account_id, hide_notifications)
VALUES (?, ?, ?, ?)
ON CONFLICT (account_id, target_account_id) DO UPDATE SET hide_notifications = excluded.hide_notifications
`
				)
				.bind(crypto.randomUUID(), actor.id.toString(), target.id.toString(), hideNotifications ? 1 : 0)
		: db
				.prepare(
					db.qb.insertOrIgnore(`
INTO blocks (id, account_id, target_account_id)
VALUES (?, ?, ?)
`)
				)
				.bind(crypto.randomUUID(), actor.id.toString(), target.id.toString())

	const { success, error } = await statement.run()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}
}

export async function deleteAccountRelationship(
	db: Database,
	table: RelationshipTable,
	actor: Actor,
	target: Actor
): Promise<void> {
	const tableName = TABLE_NAME[table]
	const { success, error } = await db
		.prepare(`DELETE FROM ${tableName} WHERE account_id = ? AND target_account_id = ?`)
		.bind(actor.id.toString(), target.id.toString())
		.run()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}
}

export function getTargetMastodonIds(
	db: Database,
	table: RelationshipTable,
	actor: Actor,
	{ limit, maxId, targetIds }: { limit: number; maxId?: MastodonId; targetIds?: MastodonId[] } = { limit: 40 }
): Promise<MastodonId[]> {
	if (targetIds?.length === 0) {
		return Promise.resolve([])
	}

	const tableName = TABLE_NAME[table]
	const targetFilter = targetIds ? `AND actors.mastodon_id IN (${targetIds.map(() => '?').join(', ')})` : ''
	const statement = db
		.prepare(
			`
SELECT actors.mastodon_id
FROM ${tableName}
INNER JOIN actors ON actors.id = ${tableName}.target_account_id
WHERE ${tableName}.account_id = ?
  AND (? IS NULL OR actors.mastodon_id < ?)
  ${targetFilter}
ORDER BY actors.mastodon_id DESC
LIMIT ?
`
		)
		.bind(actor.id.toString(), maxId ?? null, maxId ?? null, ...(targetIds ?? []), limit)

	return getResultsField(statement, 'mastodon_id')
}

export function getSourceMastodonIdsForTargets(
	db: Database,
	table: RelationshipTable,
	actor: Actor,
	targetIds: MastodonId[]
): Promise<MastodonId[]> {
	if (targetIds.length === 0) {
		return Promise.resolve([])
	}

	const tableName = TABLE_NAME[table]
	const placeholders = targetIds.map(() => '?').join(', ')
	const statement = db
		.prepare(
			`
SELECT actors.mastodon_id
FROM ${tableName}
INNER JOIN actors ON actors.id = ${tableName}.account_id
WHERE ${tableName}.target_account_id = ?
  AND actors.mastodon_id IN (${placeholders})
`
		)
		.bind(actor.id.toString(), ...targetIds)

	return getResultsField(statement, 'mastodon_id')
}
