import { getActorByMastodonId } from '@wildebeest/backend/activitypub/actors'
import type { Database } from '@wildebeest/backend/database'
import { loadMastodonAccount } from '@wildebeest/backend/mastodon/account'
import type { MastodonAccount } from '@wildebeest/backend/types/account'
import type { MastodonList, RepliesPolicy } from '@wildebeest/backend/types/list'
import { actorToHandle } from '@wildebeest/backend/utils/handle'
import { generateMastodonId } from '@wildebeest/backend/utils/id'

type ListRow = {
	id: string
	title: string
	replies_policy: RepliesPolicy
	exclusive: number
}

function toMastodonList(row: ListRow): MastodonList {
	return {
		id: row.id,
		title: row.title,
		replies_policy: row.replies_policy,
		exclusive: row.exclusive === 1,
	}
}

export async function getListsForOwner(db: Database, accountId: string): Promise<MastodonList[]> {
	const { results } = await db
		.prepare(
			`
SELECT id, title, replies_policy, exclusive
FROM lists
WHERE account_id = ?
ORDER BY title ASC
`
		)
		.bind(accountId)
		.all<ListRow>()
	return (results ?? []).map(toMastodonList)
}

export async function getListById(db: Database, listId: string, ownerAccountId: string): Promise<MastodonList | null> {
	const row = await db
		.prepare(
			`
SELECT id, title, replies_policy, exclusive
FROM lists
WHERE id = ? AND account_id = ?
`
		)
		.bind(listId, ownerAccountId)
		.first<ListRow>()
	return row ? toMastodonList(row) : null
}

export async function createList(
	db: Database,
	accountId: string,
	title: string,
	repliesPolicy: RepliesPolicy = 'list',
	exclusive = false
): Promise<MastodonList> {
	const id = await generateMastodonId(db, 'lists', new Date())
	const out = await db
		.prepare(
			`
INSERT INTO lists (id, account_id, title, replies_policy, exclusive)
VALUES (?, ?, ?, ?, ?)
`
		)
		.bind(id, accountId, title, repliesPolicy, exclusive ? 1 : 0)
		.run()
	if (!out.success) {
		throw new Error('SQL error: ' + out.error)
	}
	return { id, title, replies_policy: repliesPolicy, exclusive }
}

export async function updateList(
	db: Database,
	listId: string,
	ownerAccountId: string,
	updates: { title?: string; replies_policy?: RepliesPolicy; exclusive?: boolean }
): Promise<MastodonList | null> {
	const existing = await getListById(db, listId, ownerAccountId)
	if (!existing) {
		return null
	}

	const title = updates.title ?? existing.title
	const replies_policy = updates.replies_policy ?? existing.replies_policy
	const exclusive = updates.exclusive ?? existing.exclusive

	const out = await db
		.prepare(
			`
UPDATE lists
SET title = ?, replies_policy = ?, exclusive = ?, updated_at = (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'))
WHERE id = ? AND account_id = ?
`
		)
		.bind(title, replies_policy, exclusive ? 1 : 0, listId, ownerAccountId)
		.run()
	if (!out.success) {
		throw new Error('SQL error: ' + out.error)
	}
	return { id: listId, title, replies_policy, exclusive }
}

export async function deleteList(db: Database, listId: string, ownerAccountId: string): Promise<boolean> {
	const out = await db.prepare('DELETE FROM lists WHERE id = ? AND account_id = ?').bind(listId, ownerAccountId).run()
	if (!out.success) {
		throw new Error('SQL error: ' + out.error)
	}
	return out.meta.changes > 0
}

export async function getListsContainingAccount(
	db: Database,
	ownerAccountId: string,
	targetAccountId: string
): Promise<MastodonList[]> {
	const { results } = await db
		.prepare(
			`
SELECT lists.id, lists.title, lists.replies_policy, lists.exclusive
FROM lists
INNER JOIN list_accounts ON list_accounts.list_id = lists.id
WHERE lists.account_id = ? AND list_accounts.account_id = ?
ORDER BY lists.title ASC
`
		)
		.bind(ownerAccountId, targetAccountId)
		.all<ListRow>()
	return (results ?? []).map(toMastodonList)
}

export async function getListMemberAccounts(
	domain: string,
	db: Database,
	listId: string,
	ownerAccountId: string
): Promise<MastodonAccount[] | null> {
	const list = await getListById(db, listId, ownerAccountId)
	if (!list) {
		return null
	}

	const { results } = await db
		.prepare(
			`
SELECT actors.mastodon_id
FROM list_accounts
INNER JOIN actors ON actors.id = list_accounts.account_id
WHERE list_accounts.list_id = ?
`
		)
		.bind(listId)
		.all<{ mastodon_id: string | null }>()

	const accounts: MastodonAccount[] = []
	for (const row of results ?? []) {
		if (!row.mastodon_id) {
			continue
		}
		const actor = await getActorByMastodonId(db, row.mastodon_id)
		if (actor) {
			accounts.push(await loadMastodonAccount(db, domain, actor, actorToHandle(actor), false))
		}
	}
	return accounts
}

export async function addAccountsToList(
	db: Database,
	listId: string,
	ownerAccountId: string,
	accountMastodonIds: string[]
): Promise<MastodonList | null> {
	const list = await getListById(db, listId, ownerAccountId)
	if (!list) {
		return null
	}

	const batch = []
	const stmt = db.prepare(
		db.qb.insertOrIgnore(`
INTO list_accounts (list_id, account_id)
VALUES (?, ?)
`)
	)

	for (const mastodonId of accountMastodonIds) {
		const actor = await getActorByMastodonId(db, mastodonId)
		if (!actor) {
			continue
		}
		batch.push(stmt.bind(listId, actor.id.toString()))
	}

	if (batch.length > 0) {
		await db.batch(batch)
	}
	return list
}

export async function removeAccountsFromList(
	db: Database,
	listId: string,
	ownerAccountId: string,
	accountMastodonIds: string[]
): Promise<MastodonList | null> {
	const list = await getListById(db, listId, ownerAccountId)
	if (!list) {
		return null
	}

	for (const mastodonId of accountMastodonIds) {
		const actor = await getActorByMastodonId(db, mastodonId)
		if (!actor) {
			continue
		}
		const out = await db
			.prepare('DELETE FROM list_accounts WHERE list_id = ? AND account_id = ?')
			.bind(listId, actor.id.toString())
			.run()
		if (!out.success) {
			throw new Error('SQL error: ' + out.error)
		}
	}
	return list
}

export async function getListMemberActorIds(db: Database, listId: string): Promise<string[]> {
	const { results } = await db
		.prepare('SELECT account_id FROM list_accounts WHERE list_id = ?')
		.bind(listId)
		.all<{ account_id: string }>()
	return (results ?? []).map((r) => r.account_id)
}
