import type { Database } from '@wildebeest/backend/database'

export async function isLocalActorId(db: Database, actorId: string): Promise<boolean> {
	const row = await db.prepare('SELECT 1 AS yes FROM users WHERE actor_id = ?').bind(actorId).first<{ yes: 1 }>()
	return row?.yes === 1
}

export async function incrementRemoteObjectInteractionCountForLocalActor(
	db: Database,
	objectId: string,
	actorId: string
): Promise<void> {
	const out = await db
		.prepare(
			`
UPDATE objects
SET interaction_count = interaction_count + 1
WHERE id = ?
  AND local = 0
  AND EXISTS (SELECT 1 FROM users WHERE users.actor_id = ?)
`
		)
		.bind(objectId, actorId)
		.run()
	if (!out.success) {
		throw new Error('SQL error: ' + out.error)
	}
}

export async function incrementObjectInteractionCount(db: Database, objectId: string): Promise<void> {
	const out = await db
		.prepare(
			`
UPDATE objects
SET interaction_count = interaction_count + 1
WHERE id = ? AND local = 0
`
		)
		.bind(objectId)
		.run()
	if (!out.success) {
		throw new Error('SQL error: ' + out.error)
	}
}

export async function decrementObjectInteractionCount(db: Database, objectId: string): Promise<void> {
	const out = await db
		.prepare(
			`
UPDATE objects
SET interaction_count = MAX(0, interaction_count - 1)
WHERE id = ? AND local = 0
`
		)
		.bind(objectId)
		.run()
	if (!out.success) {
		throw new Error('SQL error: ' + out.error)
	}
}

export async function incrementActorInteractionCount(db: Database, actorId: string): Promise<void> {
	const out = await db
		.prepare(
			`
UPDATE actors
SET interaction_count = interaction_count + 1
WHERE id = ?
  AND NOT EXISTS (SELECT 1 FROM users WHERE users.actor_id = actors.id)
`
		)
		.bind(actorId)
		.run()
	if (!out.success) {
		throw new Error('SQL error: ' + out.error)
	}
}

export async function decrementActorInteractionCount(db: Database, actorId: string): Promise<void> {
	const out = await db
		.prepare(
			`
UPDATE actors
SET interaction_count = MAX(0, interaction_count - 1)
WHERE id = ?
  AND NOT EXISTS (SELECT 1 FROM users WHERE users.actor_id = actors.id)
`
		)
		.bind(actorId)
		.run()
	if (!out.success) {
		throw new Error('SQL error: ' + out.error)
	}
}
