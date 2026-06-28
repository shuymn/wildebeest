import type { Actor } from '@wildebeest/backend/activitypub/actors'
import type { Database } from '@wildebeest/backend/database'
import type { MastodonId } from '@wildebeest/backend/types'

import { getResultsField } from './utils'

export type DomainBlock = {
	id: string
	domain: string
}

type DomainBlockCursor = {
	id: string
	created_at: string
}

type DomainBlockListOptions = {
	limit: number
	maxId?: string
	sinceId?: string
	minId?: string
}

// Normalize a domain the same way for storage, comparison and deletion so that
// `Example.com`, ` example.com ` and `example.com` collapse to a single block.
export function normalizeDomain(domain: string): string {
	return domain.trim().toLowerCase()
}

export async function insertDomainBlock(db: Database, actor: Pick<Actor, 'id'>, domain: string): Promise<void> {
	const normalized = normalizeDomain(domain)
	const { success, error } = await db
		.prepare(
			db.qb.insertOrIgnore(`
INTO domain_blocks (id, account_id, domain)
VALUES (?, ?, ?)
`)
		)
		.bind(crypto.randomUUID(), actor.id.toString(), normalized)
		.run()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}
}

export async function deleteDomainBlock(db: Database, actor: Pick<Actor, 'id'>, domain: string): Promise<void> {
	const normalized = normalizeDomain(domain)
	const { success, error } = await db
		.prepare(`DELETE FROM domain_blocks WHERE account_id = ? AND domain = ?`)
		.bind(actor.id.toString(), normalized)
		.run()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}
}

async function getDomainBlockCursor(
	db: Database,
	actor: Pick<Actor, 'id'>,
	id: string | undefined
): Promise<DomainBlockCursor | null> {
	if (!id) {
		return null
	}
	return db
		.prepare(
			`
SELECT id, created_at
FROM domain_blocks
WHERE account_id = ? AND id = ?
`
		)
		.bind(actor.id.toString(), id)
		.first<DomainBlockCursor>()
}

export async function getDomainBlocks(
	db: Database,
	actor: Pick<Actor, 'id'>,
	{ limit, maxId, sinceId, minId }: DomainBlockListOptions
): Promise<DomainBlock[]> {
	const lowerBoundId = sinceId ?? minId
	const [max, min] = await Promise.all([
		getDomainBlockCursor(db, actor, maxId),
		getDomainBlockCursor(db, actor, lowerBoundId),
	])

	if ((maxId && max === null) || (lowerBoundId && min === null)) {
		return []
	}

	const filters: string[] = []
	const bindings: Array<string | number> = [actor.id.toString()]
	if (max) {
		filters.push(`AND (created_at < ? OR (created_at = ? AND id < ?))`)
		bindings.push(max.created_at, max.created_at, max.id)
	}
	if (min) {
		filters.push(`AND (created_at > ? OR (created_at = ? AND id > ?))`)
		bindings.push(min.created_at, min.created_at, min.id)
	}
	bindings.push(limit)

	const statement = db
		.prepare(
			`
SELECT id, domain
FROM domain_blocks
WHERE account_id = ?
${filters.join('\n')}
ORDER BY created_at DESC, id DESC
LIMIT ?
`
		)
		.bind(...bindings)

	const { success, error, results } = await statement.all<DomainBlock>()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}
	return results ?? []
}

export function getDomainBlockedMastodonIds(
	db: Database,
	actor: Pick<Actor, 'id'>,
	targetIds: MastodonId[]
): Promise<MastodonId[]> {
	if (targetIds.length === 0) {
		return Promise.resolve([])
	}

	const placeholders = targetIds.map(() => '?').join(', ')
	const statement = db
		.prepare(
			`
SELECT actors.mastodon_id
FROM actors
WHERE actors.mastodon_id IN (${placeholders})
  AND EXISTS (
    SELECT 1
    FROM domain_blocks
    WHERE domain_blocks.account_id = ? AND domain_blocks.domain = actors.domain
  )
`
		)
		.bind(...targetIds, actor.id.toString())

	return getResultsField(statement, 'mastodon_id')
}
