import {
	type Account,
	ACCOUNT_COLUMNS,
	type AccountRow,
	type Page,
	type PageQuery,
	type Present,
	presentAccount,
	resolveAccountId,
} from './accounts'
import { availableSql } from './audience'
import { userReadOperation, userWriteOperation } from './auth'
import { allocateLocalId } from './ids'
import { statusCursor } from './statuses'
import type { Db } from '../db/sql'

// Lists (Mastodon 4.5's List and ListAccount, Api::V1::ListsController, Lists::AccountsController and
// Accounts::ListsController). A list belongs to a local account and holds accounts its owner follows or has asked to
// follow, or the owner itself (ListAccount#validate_relationship). A member's statuses reach the list once the follow
// is accepted: the list timeline (timelines.ts) reads the follow's state, so a request accepted later makes the
// member active. When a follow ends, its account leaves the follower's lists (the trigger of migration
// 0007_list_members, as Mastodon's foreign keys delete the membership with the follow). Only the owner sees or changes
// a list: anyone else's is not found.

// List::PER_ACCOUNT_LIMIT and List::TITLE_LENGTH_LIMIT.
export const MAX_LISTS = 50
export const MAX_LIST_TITLE = 256

// GET /api/v1/lists/:id/accounts with limit=0 answers every member (Lists::AccountsController#unlimited?). Kopje stops
// at this many, the newest by account id, so the accounts one answer presents (bios of remote accounts included) stay
// well within the isolate's memory (RES-3).
export const MAX_LIST_MEMBERS_ANSWERED = 1_000

export const REPLIES_POLICIES = ['followed', 'list', 'none'] as const

export type RepliesPolicy = (typeof REPLIES_POLICIES)[number]

// REST::ListSerializer.
export type List = { id: string; title: string; replies_policy: RepliesPolicy; exclusive: boolean }

type ListRow = { id: string; title: string; replies_policy: RepliesPolicy; exclusive: number }

const LIST_COLUMNS = 'id, title, replies_policy, exclusive'

function presentList(row: ListRow): List {
	return { id: row.id, title: row.title, replies_policy: row.replies_policy, exclusive: row.exclusive === 1 }
}

// The viewer's list `id`, if it is theirs.
export function ownList(db: Db, ownerId: string, id: string): ListRow | undefined {
	return db.first<ListRow>(`SELECT ${LIST_COLUMNS} FROM lists WHERE id = ? AND account_id = ?`, id, ownerId)
}

// GET /api/v1/lists: the viewer's lists, oldest first.
export const listLists = userReadOperation<object, List[]>((db, _input, { accountId }) =>
	db.all<ListRow>(`SELECT ${LIST_COLUMNS} FROM lists WHERE account_id = ? ORDER BY id`, accountId).map(presentList)
)

// GET /api/v1/lists/:id.
export const getList = userReadOperation<{ id: string }, List | null>((db, { id }, { accountId }) => {
	const row = ownList(db, accountId, id)
	return row === undefined ? null : presentList(row)
})

// The attributes a create or an update sets; undefined leaves one as it is (on create: its default). repliesPolicy is
// the parameter as sent, checked here.
export type ListChanges = { title?: string; repliesPolicy?: string; exclusive?: boolean }

export type ListResult =
	{ status: 'ok'; list: List } | { status: 'not_found' } | { status: 'invalid'; errors: string[] }

// Ruby's String#blank?: empty or whitespace only.
function blank(text: string): boolean {
	return /^\s*$/u.test(text)
}

// List's validations, in the order Mastodon runs them (the replies_policy enum, the title, then the per-account limit
// on create), with Rails' messages. `title` is the title the list would have.
function listErrors(db: Db, ownerId: string, title: string, changes: ListChanges, creating: boolean): string[] {
	const errors: string[] = []
	if (changes.repliesPolicy !== undefined && !(REPLIES_POLICIES as readonly string[]).includes(changes.repliesPolicy)) {
		errors.push('Replies policy is not included in the list')
	}
	if (blank(title)) {
		errors.push("Title can't be blank")
	}
	// Ruby counts characters (code points), not UTF-16 units.
	if ([...title].length > MAX_LIST_TITLE) {
		errors.push(`Title is too long (maximum is ${MAX_LIST_TITLE} characters)`)
	}
	if (creating) {
		const owned = db.first<{ n: number }>('SELECT count(*) AS n FROM lists WHERE account_id = ?', ownerId)?.n ?? 0
		if (owned >= MAX_LISTS) {
			errors.push('You have reached the maximum number of lists')
		}
	}
	return errors
}

// POST /api/v1/lists (List.create!): replies_policy defaults to list, exclusive to false.
export const createList = userWriteOperation<ListChanges & { now: number }, ListResult>((db, input, { accountId }) => {
	const title = input.title ?? ''
	const errors = listErrors(db, accountId, title, input, true)
	if (errors.length > 0) {
		return { status: 'invalid', errors }
	}
	const row = db.first<ListRow>(
		`INSERT INTO lists (id, account_id, title, replies_policy, exclusive, created_at) VALUES (?, ?, ?, ?, ?, ?)
			RETURNING ${LIST_COLUMNS}`,
		allocateLocalId(db, input.now),
		accountId,
		title,
		input.repliesPolicy ?? 'list',
		input.exclusive === true ? 1 : 0,
		new Date(input.now).toISOString()
	)
	if (row === undefined) {
		throw new Error('the list was not written')
	}
	return { status: 'ok', list: presentList(row) }
})

// PUT and PATCH /api/v1/lists/:id (List#update!): what is sent changes, the rest stays.
export const updateList = userWriteOperation<ListChanges & { id: string }, ListResult>((db, input, { accountId }) => {
	const list = ownList(db, accountId, input.id)
	if (list === undefined) {
		return { status: 'not_found' }
	}
	const title = input.title ?? list.title
	const errors = listErrors(db, accountId, title, input, false)
	if (errors.length > 0) {
		return { status: 'invalid', errors }
	}
	const row = db.first<ListRow>(
		`UPDATE lists SET title = ?, replies_policy = ?, exclusive = ? WHERE id = ? RETURNING ${LIST_COLUMNS}`,
		title,
		input.repliesPolicy ?? list.replies_policy,
		input.exclusive === undefined ? list.exclusive : input.exclusive ? 1 : 0,
		list.id
	)
	return row === undefined ? { status: 'not_found' } : { status: 'ok', list: presentList(row) }
})

// DELETE /api/v1/lists/:id: the list and its members (ON DELETE CASCADE). Whether it was the viewer's.
export const deleteList = userWriteOperation<{ id: string }, boolean>(
	(db, { id }, { accountId }) => db.run('DELETE FROM lists WHERE id = ? AND account_id = ?', id, accountId) > 0
)

// GET /api/v1/lists/:id/accounts: the members, unavailable accounts left out (Account.without_suspended), by account
// id, newest first, paged by the account id (paginate_by_max_id); page null answers every member (limit=0), up to
// MAX_LIST_MEMBERS_ANSWERED. A pending member is listed too. Null when the list is not the viewer's.
export const listAccounts = userReadOperation<
	{ id: string; page: PageQuery | null; present: Present },
	Page<Account> | null
>((db, { id, page, present }, { accountId }) => {
	if (ownList(db, accountId, id) === undefined) {
		return null
	}
	const ascending = page?.minId !== undefined
	const rows = db.all<AccountRow>(
		`SELECT ${ACCOUNT_COLUMNS}
		FROM list_accounts la JOIN accounts a ON a.id = la.account_id LEFT JOIN local_accounts l ON l.account_id = a.id
		WHERE la.list_id = ?1 AND (?2 IS NULL OR la.account_id < ?2) AND (?3 IS NULL OR la.account_id > ?3)
			AND ${availableSql('la.account_id')}
		ORDER BY la.account_id ${ascending ? 'ASC' : 'DESC'} LIMIT ?4`,
		id,
		statusCursor(page?.maxId),
		statusCursor(page?.minId ?? page?.sinceId),
		page?.limit ?? MAX_LIST_MEMBERS_ANSWERED
	)
	if (ascending) {
		rows.reverse()
	}
	return {
		items: rows.map((row) => presentAccount(row, present)),
		newest: rows[0]?.id ?? null,
		oldest: rows.at(-1)?.id ?? null,
	}
})

export type MembersResult = { status: 'ok' } | { status: 'not_found' } | { status: 'invalid'; errors: string[] }

// POST /api/v1/lists/:id/accounts (AddAccountsToListService): every id must name an account (else not found, and
// nothing changes), and each must be the owner or an account the owner follows or has asked to follow, and not a
// member yet; the first that is not refuses the whole request with its errors (ListAccount's validations, in order),
// and nothing changes.
export const addListAccounts = userWriteOperation<{ id: string; accounts: string[] }, MembersResult>(
	(db, input, { accountId }) => {
		const list = ownList(db, accountId, input.id)
		if (list === undefined) {
			return { status: 'not_found' }
		}
		const members = new Set<string>()
		for (const raw of input.accounts) {
			const member = resolveAccountId(db, raw)
			if (member === null) {
				return { status: 'not_found' }
			}
			members.add(member)
		}
		for (const member of members) {
			const found = db.first<{ member: number; follows: number }>(
				`SELECT EXISTS (SELECT 1 FROM list_accounts WHERE list_id = ?1 AND account_id = ?3) AS member,
					EXISTS (SELECT 1 FROM follows WHERE account_id = ?2 AND target_account_id = ?3) AS follows`,
				list.id,
				accountId,
				member
			)
			const errors = [
				...(found?.member === 1 ? ['Account has already been taken'] : []),
				...(member !== accountId && found?.follows !== 1 ? ['Account must be a followed account'] : []),
			]
			if (errors.length > 0) {
				return { status: 'invalid', errors }
			}
		}
		for (const member of members) {
			db.run('INSERT INTO list_accounts (list_id, account_id) VALUES (?, ?)', list.id, member)
		}
		return { status: 'ok' }
	}
)

// DELETE /api/v1/lists/:id/accounts (RemoveAccountsFromListService): the named members leave; an id that names no
// account or no member is passed over.
export const removeListAccounts = userWriteOperation<{ id: string; accounts: string[] }, boolean>(
	(db, input, { accountId }) => {
		const list = ownList(db, accountId, input.id)
		if (list === undefined) {
			return false
		}
		for (const raw of new Set(input.accounts)) {
			const member = resolveAccountId(db, raw)
			if (member !== null) {
				db.run('DELETE FROM list_accounts WHERE list_id = ? AND account_id = ?', list.id, member)
			}
		}
		return true
	}
)

// GET /api/v1/accounts/:id/lists: the viewer's lists that hold the account, oldest first; none for an unavailable
// account (Account#suspended?). Null when no account has the id.
export const accountLists = userReadOperation<{ account: string }, List[] | null>((db, input, { accountId }) => {
	const member = resolveAccountId(db, input.account)
	if (member === null) {
		return null
	}
	return db
		.all<ListRow>(
			`SELECT ${LIST_COLUMNS} FROM lists l WHERE ${holdingSql('?1', '?2')} AND ${availableSql('?2')} ORDER BY l.id`,
			accountId,
			member
		)
		.map(presentList)
})

// The lists `l` of `owner` that hold the account `x`: read from the owner's lists (lists_account, at most MAX_LISTS
// through the API), each checked through the (list_id, account_id) key, so the reads do not grow with the lists of
// other owners that hold the account.
function holdingSql(owner: string, x: string): string {
	return `l.account_id = ${owner}
		AND EXISTS (SELECT 1 FROM list_accounts lh WHERE lh.list_id = l.id AND lh.account_id = ${x})`
}

// The ids of the lists of `ownerId` that hold `accountId`.
export function listsHolding(db: Db, ownerId: string, accountId: string): string[] {
	return db
		.all<{ id: string }>(`SELECT l.id FROM lists l WHERE ${holdingSql('?1', '?2')}`, ownerId, accountId)
		.map((list) => list.id)
}
