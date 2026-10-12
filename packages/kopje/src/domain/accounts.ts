import { userReadOperation, userWriteOperation } from './auth'
import { notify } from './notifications'
import { readOperation } from './operation'
import { htmlToPlainText, plainTextToHtml } from './plain-text'
import { accountSearchText, queryTerms } from './search-text'
import type { Db } from '../db/sql'

// Accounts as the Mastodon API (4.0.2) shows them: one presenter, and the account and relationship operations of B3.
// Every operation takes an account by its API id or by its legacy id (accounts.legacy_id); both resolve to the same
// row and responses always carry the API id. Ids are TEXT and are never read as numbers.

export type Present = { origin: string }

export type Account = {
	id: string
	username: string
	acct: string
	display_name: string
	locked: boolean
	bot: boolean
	discoverable: boolean | null
	group: boolean
	created_at: string
	note: string
	url: string
	avatar: string
	avatar_static: string
	header: string
	header_static: string
	followers_count: number
	following_count: number
	statuses_count: number
	last_status_at: string | null
	emojis: []
	fields: []
	suspended?: true
}

export type Visibility = 'public' | 'unlisted' | 'private' | 'direct'

export type CredentialAccount = Account & {
	source: {
		privacy: Visibility
		sensitive: boolean
		language: string | null
		note: string
		fields: []
		follow_requests_count: number
	}
	role: { id: string; name: string; permissions: string; color: string; highlighted: boolean }
}

export type Relationship = {
	id: string
	following: boolean
	showing_reblogs: boolean
	notifying: boolean
	languages: string[] | null
	followed_by: boolean
	blocking: boolean
	blocked_by: boolean
	muting: boolean
	muting_notifications: boolean
	requested: boolean
	domain_blocking: boolean
	endorsed: boolean
	note: string
}

// Placeholders until media (B4) ships real defaults as static assets.
const DEFAULT_AVATAR = '/assets/avatar.png'
const DEFAULT_HEADER = '/assets/header.png'

export type AccountRow = {
	id: string
	uri: string
	username: string
	domain: string | null
	actor_type: string
	display_name: string
	note: string
	url: string | null
	avatar_url: string | null
	header_url: string | null
	locked: number
	discoverable: number | null
	followers_count: number
	following_count: number
	statuses_count: number
	created_at: string
	suspended_at: string | null
	last_status_at: string | null
}

export const ACCOUNT_COLUMNS = `a.id, a.uri, a.username, a.domain, a.actor_type, a.display_name, a.note, a.url, a.avatar_url,
	a.header_url, a.locked, a.discoverable, a.followers_count, a.following_count, a.statuses_count, a.created_at,
	l.suspended_at,
	(SELECT substr(s.published_at, 1, 10) FROM statuses s
		WHERE s.account_id = a.id AND s.visibility IN ('public', 'unlisted', 'private') ORDER BY s.id DESC LIMIT 1)
		AS last_status_at`

export const ACCOUNT_FROM = 'accounts a LEFT JOIN local_accounts l ON l.account_id = a.id'

// A local account's url is derived from its actor URI, which carries the instance origin.
export function accountUrl(row: { url: string | null; uri: string; username: string }): string {
	return row.url ?? `${new URL(row.uri).origin}/@${row.username}`
}

export function acctOf(row: { username: string; domain: string | null }): string {
	return row.domain === null ? row.username : `${row.username}@${row.domain}`
}

// A suspended account is shown redacted, as Mastodon 4.0.2's REST::AccountSerializer does: no display name, note,
// fields or emojis, the default avatar and header, and locked, bot and discoverable false.
export function presentAccount(row: AccountRow, { origin }: Present): Account {
	const suspended = row.suspended_at !== null
	const url = accountUrl(row)
	const avatar = (suspended ? null : row.avatar_url) ?? `${origin}${DEFAULT_AVATAR}`
	const header = (suspended ? null : row.header_url) ?? `${origin}${DEFAULT_HEADER}`
	return {
		id: row.id,
		username: row.username,
		acct: acctOf(row),
		display_name: suspended ? '' : row.display_name,
		locked: !suspended && row.locked === 1,
		bot: !suspended && (row.actor_type === 'Service' || row.actor_type === 'Application'),
		discoverable: suspended ? false : row.discoverable === null ? null : row.discoverable === 1,
		group: row.actor_type === 'Group',
		created_at: row.created_at,
		note: suspended ? '' : row.note,
		url,
		avatar,
		avatar_static: avatar,
		header,
		header_static: header,
		followers_count: row.followers_count,
		following_count: row.following_count,
		statuses_count: row.statuses_count,
		last_status_at: row.last_status_at,
		emojis: [],
		fields: [],
		...(suspended ? { suspended: true as const } : {}),
	}
}

// API ids are 18 digits; legacy ids are UUIDs or other short strings. Anything longer is not an id.
const MAX_ID_LENGTH = 64

// Resolves an API id or a legacy id (the table's legacy_id) to the API id.
export function resolveApiId(db: Db, table: 'accounts' | 'statuses', id: string): string | null {
	if (id === '' || id.length > MAX_ID_LENGTH) {
		return null
	}
	const row =
		db.first<{ id: string }>(`SELECT id FROM ${table} WHERE id = ?`, id) ??
		db.first<{ id: string }>(`SELECT id FROM ${table} WHERE legacy_id = ?`, id)
	return row?.id ?? null
}

export function resolveAccountId(db: Db, id: string): string | null {
	return resolveApiId(db, 'accounts', id)
}

// Presented accounts by id, read in one query.
export function presentAccountsById(db: Db, ids: readonly string[], present: Present): Map<string, Account> {
	return new Map(
		db
			.all<AccountRow>(
				`SELECT ${ACCOUNT_COLUMNS} FROM ${ACCOUNT_FROM} WHERE a.id IN (SELECT value FROM json_each(?1))`,
				JSON.stringify([...new Set(ids)])
			)
			.map((row) => [row.id, presentAccount(row, present)])
	)
}

function accountRow(db: Db, id: string): AccountRow | undefined {
	return db.first<AccountRow>(`SELECT ${ACCOUNT_COLUMNS} FROM ${ACCOUNT_FROM} WHERE a.id = ?`, id)
}

export const getAccount = readOperation<{ id: string; present: Present }, Account | null>((db, { id, present }) => {
	const resolved = resolveAccountId(db, id)
	const row = resolved === null ? undefined : accountRow(db, resolved)
	return row === undefined ? null : presentAccount(row, present)
})

// domain null means a local account.
export const lookupAccount = readOperation<
	{ username: string; domain: string | null; present: Present },
	Account | null
>((db, { username, domain, present }) => {
	const row =
		domain === null
			? db.first<AccountRow>(
					`SELECT ${ACCOUNT_COLUMNS} FROM ${ACCOUNT_FROM} WHERE a.domain IS NULL AND lower(a.username) = lower(?)`,
					username
				)
			: db.first<AccountRow>(
					`SELECT ${ACCOUNT_COLUMNS} FROM ${ACCOUNT_FROM} WHERE a.domain = ? AND lower(a.username) = lower(?)`,
					domain.toLowerCase(),
					username
				)
	return row === undefined ? null : presentAccount(row, present)
})

type CredentialRow = {
	default_visibility: Visibility
	default_sensitive: number
	default_language: string | null
	follow_requests_count: number
}

function credentialAccount(db: Db, accountId: string, present: Present): CredentialAccount | null {
	const row = accountRow(db, accountId)
	const local = db.first<CredentialRow>(
		`SELECT default_visibility, default_sensitive, default_language,
			(SELECT COUNT(*) FROM follows WHERE target_account_id = ?1 AND state = 'pending') AS follow_requests_count
		FROM local_accounts WHERE account_id = ?1`,
		accountId
	)
	if (row === undefined || local === undefined) {
		return null
	}
	return {
		...presentAccount(row, present),
		source: {
			privacy: local.default_visibility,
			sensitive: local.default_sensitive === 1,
			language: local.default_language,
			note: htmlToPlainText(row.note),
			fields: [],
			follow_requests_count: local.follow_requests_count,
		},
		// Every user has Mastodon's default role (id -99) until roles exist. permissions is a string (design §4).
		role: { id: '-99', name: '', permissions: '0', color: '', highlighted: false },
	}
}

export const verifyCredentials = userReadOperation<{ present: Present }, CredentialAccount | null>(
	(db, { present }, viewer) => credentialAccount(db, viewer.accountId, present)
)

export type CredentialChanges = {
	displayName?: string
	note?: string
	locked?: boolean
	bot?: boolean
	discoverable?: boolean
	privacy?: Visibility
	sensitive?: boolean
	language?: string | null
}

// Lengths and values are validated by the caller. display_name and the note are plain text: display_name is stored
// as is (JSON consumers escape it), the note is stored as escaped paragraphs.
export const updateCredentials = userWriteOperation<
	{ changes: CredentialChanges; present: Present },
	CredentialAccount | null
>((db, { changes, present }, { accountId }) => {
	const current = db.first<{ username: string; display_name: string; actor_type: string }>(
		'SELECT a.username, a.display_name, a.actor_type FROM accounts a JOIN local_accounts l ON l.account_id = a.id WHERE a.id = ?',
		accountId
	)
	if (current === undefined) {
		return null
	}
	const displayName = changes.displayName ?? current.display_name
	const actorType =
		changes.bot === undefined || !['Person', 'Service'].includes(current.actor_type)
			? current.actor_type
			: changes.bot
				? 'Service'
				: 'Person'
	db.run(
		`UPDATE accounts SET display_name = ?, note = COALESCE(?, note), locked = COALESCE(?, locked),
			discoverable = COALESCE(?, discoverable), actor_type = ?, search_text = ?
		WHERE id = ?`,
		displayName,
		changes.note === undefined ? null : plainTextToHtml(changes.note),
		bit(changes.locked),
		bit(changes.discoverable),
		actorType,
		accountSearchText(current.username, null, displayName),
		accountId
	)
	db.run(
		`UPDATE local_accounts SET default_visibility = COALESCE(?, default_visibility),
			default_sensitive = COALESCE(?, default_sensitive),
			default_language = CASE WHEN ? THEN ? ELSE default_language END
		WHERE account_id = ?`,
		changes.privacy ?? null,
		bit(changes.sensitive),
		changes.language === undefined ? 0 : 1,
		changes.language ?? null,
		accountId
	)
	return credentialAccount(db, accountId, present)
})

function bit(value: boolean | undefined): number | null {
	return value === undefined ? null : value ? 1 : 0
}

type RelationshipRow = {
	id: string
	following: string | null
	show_reblogs: number | null
	notify: number | null
	languages: string | null
	followed_by: string | null
	blocking: number
	blocked_by: number
	muting: number
	muting_notifications: number | null
	domain_blocking: number
}

function relationshipsOf(db: Db, viewerId: string, accountIds: string[]): Relationship[] {
	const rows = db.all<RelationshipRow>(
		`SELECT a.id,
			fo.state AS following, fo.show_reblogs, fo.notify, fo.languages,
			fb.state AS followed_by,
			EXISTS (SELECT 1 FROM blocks WHERE account_id = ?1 AND target_account_id = a.id) AS blocking,
			EXISTS (SELECT 1 FROM blocks WHERE account_id = a.id AND target_account_id = ?1) AS blocked_by,
			m.account_id IS NOT NULL AS muting, m.hide_notifications AS muting_notifications,
			(a.domain IS NOT NULL AND EXISTS (SELECT 1 FROM domain_blocks WHERE account_id = ?1 AND domain = a.domain))
				AS domain_blocking
		FROM json_each(?2) j
		JOIN accounts a ON a.id = j.value
		LEFT JOIN follows fo ON fo.account_id = ?1 AND fo.target_account_id = a.id
		LEFT JOIN follows fb ON fb.account_id = a.id AND fb.target_account_id = ?1
		LEFT JOIN mutes m ON m.account_id = ?1 AND m.target_account_id = a.id
		ORDER BY j.key`,
		viewerId,
		JSON.stringify(accountIds)
	)
	return rows.map((row) => ({
		id: row.id,
		following: row.following === 'accepted',
		showing_reblogs: row.following !== null && row.show_reblogs === 1,
		notifying: row.following !== null && row.notify === 1,
		languages: row.languages === null ? null : (JSON.parse(row.languages) as string[]),
		followed_by: row.followed_by === 'accepted',
		blocking: row.blocking === 1,
		blocked_by: row.blocked_by === 1,
		muting: row.muting === 1,
		muting_notifications: row.muting_notifications === 1,
		requested: row.following === 'pending',
		domain_blocking: row.domain_blocking === 1,
		endorsed: false,
		note: '',
	}))
}

export const MAX_RELATIONSHIP_IDS = 100

export const relationships = userReadOperation<{ ids: string[] }, Relationship[]>(
	(db, { ids }, { accountId: viewerId }) => {
		const resolved = ids
			.slice(0, MAX_RELATIONSHIP_IDS)
			.map((id) => resolveAccountId(db, id))
			.filter((id) => id !== null)
		return relationshipsOf(db, viewerId, [...new Set(resolved)])
	}
)

export type SearchInput = {
	query: string
	limit: number
	offset: number
	following: boolean
	// The instance's own host: "alice@<host>" searches for the local alice.
	localDomain: string
	present: Present
}

// Local and known remote accounts whose search_text contains every term (in any of its variants). An exact username
// ranks first, then local accounts. Suspended local accounts are not listed.
export const searchAccounts = userReadOperation<SearchInput, Account[]>((db, input, viewer) => {
	const query = input.query
		.trim()
		.replace(/^@/, '')
		.replace(new RegExp(`@${escapeRegExp(input.localDomain)}$`, 'i'), '')
	const terms = queryTerms(query)
	if (terms.length === 0) {
		return []
	}
	const where = terms.map((variants) => `(${variants.map(() => 'instr(a.search_text, ?) > 0').join(' OR ')})`)
	const params: SqlStorageValue[] = terms.flat()
	if (input.following) {
		where.push(
			"EXISTS (SELECT 1 FROM follows f WHERE f.account_id = ? AND f.target_account_id = a.id AND f.state = 'accepted')"
		)
		params.push(viewer.accountId)
	}
	const exactUsername = (query.split('@')[0] ?? '').toLowerCase()
	const rows = db.all<AccountRow>(
		`SELECT ${ACCOUNT_COLUMNS} FROM ${ACCOUNT_FROM}
		WHERE l.suspended_at IS NULL AND ${where.join(' AND ')}
		ORDER BY lower(a.username) = ? DESC, a.domain IS NULL DESC, a.followers_count DESC, a.id
		LIMIT ? OFFSET ?`,
		...params,
		exactUsername,
		input.limit,
		input.offset
	)
	return rows.map((row) => presentAccount(row, input.present))
})

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export type FollowInput = {
	target: string
	reblogs?: boolean
	notify?: boolean
	languages?: string[] | null
	now: number
}

export type RelationshipResult =
	| { status: 'ok'; relationship: Relationship }
	| { status: 'not_found' }
	| { status: 'forbidden' }

type TargetRow = {
	id: string
	domain: string | null
	locked: number
	blocked: number
	suspended: number
	domain_blocked: number
}

function followTarget(db: Db, viewerId: string, target: string): TargetRow | null {
	const id = resolveAccountId(db, target)
	if (id === null) {
		return null
	}
	return (
		db.first<TargetRow>(
			`SELECT a.id, a.domain, a.locked,
				EXISTS (SELECT 1 FROM blocks WHERE (account_id = ?1 AND target_account_id = a.id)
					OR (account_id = a.id AND target_account_id = ?1)) AS blocked,
				l.suspended_at IS NOT NULL AS suspended,
				(a.domain IS NOT NULL AND EXISTS (SELECT 1 FROM domain_blocks WHERE account_id = ?1 AND domain = a.domain))
					AS domain_blocked
			FROM accounts a LEFT JOIN local_accounts l ON l.account_id = a.id WHERE a.id = ?2`,
			viewerId,
			id
		) ?? null
	)
}

// Follows or updates the options of an existing follow. A local unlocked target is followed at once; a locked or
// remote target gets a pending request (a remote Accept arrives over federation). A local target is notified
// (follow, or follow_request when locked) in the same transaction; delivery of the Follow activity comes with B2. As
// in Mastodon's FollowService, a suspended target is not found, and a block either way or a domain block of the
// viewer forbids the follow.
export const follow = userWriteOperation<FollowInput, RelationshipResult>((db, input, { accountId: viewerId }) => {
	const target = followTarget(db, viewerId, input.target)
	if (target === null || target.suspended === 1) {
		return { status: 'not_found' }
	}
	if (target.id === viewerId || target.blocked === 1 || target.domain_blocked === 1) {
		return { status: 'forbidden' }
	}
	// undefined keeps the current filter; null or an empty list means every language (no filter).
	const languages =
		input.languages === undefined
			? undefined
			: input.languages === null || input.languages.length === 0
				? null
				: JSON.stringify(input.languages)
	const existing = db.first(
		'SELECT 1 AS found FROM follows WHERE account_id = ? AND target_account_id = ?',
		viewerId,
		target.id
	)
	if (existing === undefined) {
		const state = target.domain === null && target.locked === 0 ? 'accepted' : 'pending'
		// TODO(B2): give a remote follow its Follow activity uri and queue the delivery in this transaction.
		db.run(
			`INSERT INTO follows (account_id, target_account_id, state, show_reblogs, notify, languages, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`,
			viewerId,
			target.id,
			state,
			bit(input.reblogs ?? true),
			bit(input.notify ?? false),
			languages ?? null,
			new Date(input.now).toISOString()
		)
		if (target.domain === null) {
			const type = state === 'accepted' ? 'follow' : 'follow_request'
			notify(db, { recipientId: target.id, type, fromId: viewerId, statusId: null, now: input.now })
		}
	} else {
		db.run(
			`UPDATE follows SET show_reblogs = COALESCE(?, show_reblogs), notify = COALESCE(?, notify),
				languages = CASE WHEN ? THEN ? ELSE languages END
			WHERE account_id = ? AND target_account_id = ?`,
			bit(input.reblogs),
			bit(input.notify),
			languages === undefined ? 0 : 1,
			languages ?? null,
			viewerId,
			target.id
		)
	}
	recountFollows(db, viewerId, target)
	return relationshipResult(db, viewerId, target.id)
})

export const unfollow = userWriteOperation<{ target: string }, RelationshipResult>(
	(db, { target: targetId }, { accountId: viewerId }) => {
		const target = followTarget(db, viewerId, targetId)
		if (target === null) {
			return { status: 'not_found' }
		}
		// TODO(B2): queue an Undo of the Follow for a remote target.
		db.run('DELETE FROM follows WHERE account_id = ? AND target_account_id = ?', viewerId, target.id)
		// The follow's notification goes with it, as Mastodon destroys a notification with its activity.
		db.run(
			"DELETE FROM notifications WHERE account_id = ? AND from_account_id = ? AND type IN ('follow', 'follow_request')",
			target.id,
			viewerId
		)
		recountFollows(db, viewerId, target)
		return relationshipResult(db, viewerId, target.id)
	}
)

// Counts are recomputed from the edges in the transaction that changed them. A remote account's counts are the
// cached values from its server and are left alone.
function recountFollows(db: Db, viewerId: string, target: TargetRow): void {
	db.run(
		`UPDATE accounts SET following_count =
			(SELECT COUNT(*) FROM follows WHERE account_id = ?1 AND state = 'accepted') WHERE id = ?1`,
		viewerId
	)
	if (target.domain === null) {
		db.run(
			`UPDATE accounts SET followers_count =
				(SELECT COUNT(*) FROM follows WHERE target_account_id = ?1 AND state = 'accepted') WHERE id = ?1`,
			target.id
		)
	}
}

function relationshipResult(db: Db, viewerId: string, targetId: string): RelationshipResult {
	const [relationship] = relationshipsOf(db, viewerId, [targetId])
	return relationship === undefined ? { status: 'not_found' } : { status: 'ok', relationship }
}

// Keyset pages over an edge table's INTEGER id (a paging cursor only). max_id and since_id page backwards from the
// newest; min_id pages forwards from the given cursor and is returned newest first as well. Cursors stay strings:
// they are read with CAST(id AS TEXT) and compared in SQL, never as JS numbers (which are exact only up to 2^53).
export type PageQuery = { maxId?: string; sinceId?: string; minId?: string; limit: number }

export type Page<T> = { items: T[]; newest: string | null; oldest: string | null }

export type ListFollowsInput = {
	account: string
	direction: 'followers' | 'following'
	page: PageQuery
	present: Present
}

export const listFollows = readOperation<ListFollowsInput, Page<Account> | null>(
	(db, { account, direction, page, present }) => {
		const id = resolveAccountId(db, account)
		if (id === null) {
			return null
		}
		const [anchor, other] =
			direction === 'followers' ? ['target_account_id', 'account_id'] : ['account_id', 'target_account_id']
		const lower = page.minId ?? page.sinceId ?? null
		const ascending = page.minId !== undefined
		const rows = db.all<AccountRow & { cursor: string }>(
			`SELECT CAST(f.id AS TEXT) AS cursor, ${ACCOUNT_COLUMNS}
		FROM follows f JOIN accounts a ON a.id = f.${other} LEFT JOIN local_accounts l ON l.account_id = a.id
		WHERE f.${anchor} = ?1 AND f.state = 'accepted'
			AND (?2 IS NULL OR f.id < CAST(?2 AS INTEGER)) AND (?3 IS NULL OR f.id > CAST(?3 AS INTEGER))
		ORDER BY f.id ${ascending ? 'ASC' : 'DESC'} LIMIT ?4`,
			id,
			page.maxId ?? null,
			lower,
			page.limit
		)
		if (ascending) {
			rows.reverse()
		}
		return {
			items: rows.map((row) => presentAccount(row, present)),
			newest: rows[0]?.cursor ?? null,
			oldest: rows.at(-1)?.cursor ?? null,
		}
	}
)
