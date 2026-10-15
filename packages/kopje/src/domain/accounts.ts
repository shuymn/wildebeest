import { followActivity, followAnswerActivity, followUri, recordOutbound, undoFollowActivity } from './activities'
import { actorSnapshot, recordActorUpdate } from './actor-update'
import {
	activeMuteJoinSql,
	availableSql,
	blocksSql,
	domainBlocksSql,
	filteredForSql,
	findableBySql,
	followableBySql,
	followListedSql,
	followListsShownSql,
	hidesCollectionsSql,
	REACHES_FOLLOWERS_SQL,
} from './audience'
import { optionalUserReadOperation, userReadOperation, userWriteOperation } from './auth'
import { retractFollow } from './inbox'
import { notify } from './notifications'
import { readOperation } from './operation'
import { htmlToPlainText, plainTextToHtml } from './plain-text'
import { accountSearchText, queryTerms } from './search-text'
import { renderFieldValue } from './status-text'
import type { Db } from '../db/sql'
import { normalizeDomain, parseAddress } from '../platform/domain-name'
import { httpUrl } from '../platform/http-url'
import { sanitizeRemoteHtml } from '../security/html'

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
	// Whether the account hides its network (Account#hide_collections): set by a local account; null for a remote
	// account, whose setting Kopje does not learn.
	hide_collections: boolean | null
	emojis: []
	fields: Field[]
	suspended?: true
}

// A profile field (Mastodon's Account::Field): the name as plain text, the value as HTML. Local fields come from
// local_accounts.fields, remote ones from the actor's attachments.
export type Field = { name: string; value: string; verified_at: null }

// A local field as the owner wrote it (plain text), stored in local_accounts.fields.
export type FieldSource = { name: string; value: string }

// Mastodon's limits for local fields (Account::DEFAULT_FIELDS_SIZE, 255 characters each).
export const MAX_FIELDS = 4
export const MAX_FIELD_NAME = 255
export const MAX_FIELD_VALUE = 255

export type Visibility = 'public' | 'unlisted' | 'private' | 'direct'

export type CredentialAccount = Account & {
	source: {
		privacy: Visibility
		sensitive: boolean
		language: string | null
		note: string
		fields: (FieldSource & { verified_at: null })[]
		follow_requests_count: number
		hide_collections: boolean
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
	requested_by: boolean
	blocking: boolean
	blocked_by: boolean
	muting: boolean
	muting_notifications: boolean
	muting_expires_at: string | null
	requested: boolean
	domain_blocking: boolean
	endorsed: boolean
	note: string
}

// Plain defaults shipped as static assets (public/assets), for accounts without an avatar or header.
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
	// A remote account whose deletion has started; null otherwise.
	deleted_at: string | null
	last_status_at: string | null
	// local_accounts.fields and hide_collections; null for a remote account.
	local_fields: string | null
	hide_collections: number | null
	// A remote account's `attachment`, as JSON (fields are read from raw, as the design keeps them).
	attachment: string | null
}

export const ACCOUNT_COLUMNS = `a.id, a.uri, a.username, a.domain, a.actor_type, a.display_name, a.note, a.url, a.avatar_url,
	a.header_url, a.locked, a.discoverable, a.followers_count, a.following_count, a.statuses_count, a.created_at,
	l.suspended_at, a.deleted_at,
	(SELECT substr(s.published_at, 1, 10) FROM statuses s
		WHERE s.account_id = a.id AND s.visibility IN ${REACHES_FOLLOWERS_SQL} ORDER BY s.id DESC LIMIT 1)
		AS last_status_at,
	l.fields AS local_fields, l.hide_collections,
	CASE WHEN a.domain IS NOT NULL THEN a.raw -> '$.attachment' END AS attachment`

export const ACCOUNT_FROM = 'accounts a LEFT JOIN local_accounts l ON l.account_id = a.id'

// A local account's url is derived from its actor URI, which carries the instance origin.
// An account's profile URL. A stored url is used only when it is http(s) (HTML-3); otherwise it is derived from the
// actor URI, which carries the account's origin, or from this instance's origin when the URI is not http(s) either.
export function accountUrl(
	row: { url: string | null; uri: string; username: string; domain: string | null },
	origin: string
): string {
	const actor = httpUrl(row.uri)
	return httpUrl(row.url)?.href ?? (actor === null ? `${origin}/@${acctOf(row)}` : `${actor.origin}/@${row.username}`)
}

export function acctOf(row: { username: string; domain: string | null }): string {
	return row.domain === null ? row.username : `${row.username}@${row.domain}`
}

// An unavailable account (R1: suspended, or a remote account whose deletion has started) is shown redacted, as
// Mastodon's REST::AccountSerializer shows an unavailable one: no display name, note, fields or emojis, the default
// avatar and header, locked, bot and discoverable false, and `suspended: true`.
export function presentAccount(row: AccountRow, { origin }: Present): Account {
	const suspended = row.suspended_at !== null || row.deleted_at !== null
	// Stored URLs are shown only when they are http(s) (httpUrl); anything else reads as unset.
	const url = accountUrl(row, origin)
	const avatar = (suspended ? null : httpUrl(row.avatar_url)?.href) ?? `${origin}${DEFAULT_AVATAR}`
	const header = (suspended ? null : httpUrl(row.header_url)?.href) ?? `${origin}${DEFAULT_HEADER}`
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
		hide_collections: row.hide_collections === null ? null : row.hide_collections === 1,
		emojis: [],
		fields: suspended
			? []
			: row.domain === null
				? fieldSources(row.local_fields).map(presentField)
				: remoteFields(row.attachment),
		...(suspended ? { suspended: true as const } : {}),
	}
}

// Stored local fields; anything that is not a name and value pair of strings is skipped.
export function fieldSources(stored: string | null): FieldSource[] {
	if (stored === null) {
		return []
	}
	const parsed = JSON.parse(stored) as unknown
	return (Array.isArray(parsed) ? parsed : []).flatMap((entry: unknown) => {
		if (typeof entry !== 'object' || entry === null) {
			return []
		}
		const { name, value } = entry as Record<string, unknown>
		return typeof name === 'string' && typeof value === 'string' ? [{ name, value }] : []
	})
}

// HTML-2: the name stays plain text (JSON consumers escape it); the value is escaped and its URLs linked.
function presentField(field: FieldSource): Field {
	return { name: field.name, value: renderFieldValue(field.value), verified_at: null }
}

// Fields a remote profile shows: its PropertyValue attachments (ProcessAccountService#property_values), the name as
// plain text and the value as sanitized HTML (HTML-1, its links http(s) only, HTML-3), as Mastodon renders them. Kopje's
// bounds (RES-2): at most MAX_REMOTE_FIELDS, names cut at 255 code units, values at FIELD_VALUE_RAW_LIMIT before
// sanitizing.
export const MAX_REMOTE_FIELDS = 16
const FIELD_NAME_LIMIT = 255
const FIELD_VALUE_RAW_LIMIT = 4096

function remoteFields(attachment: string | null): Field[] {
	if (attachment === null) {
		return []
	}
	const parsed = JSON.parse(attachment) as unknown
	const fields: Field[] = []
	for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
		if (fields.length >= MAX_REMOTE_FIELDS) {
			break
		}
		if (typeof entry !== 'object' || entry === null) {
			continue
		}
		const { type, name, value } = entry as Record<string, unknown>
		const types = Array.isArray(type) ? type : [type]
		if (!types.includes('PropertyValue') || typeof name !== 'string' || typeof value !== 'string') {
			continue
		}
		fields.push({
			name: name.slice(0, FIELD_NAME_LIMIT),
			value: sanitizeRemoteHtml(value.slice(0, FIELD_VALUE_RAW_LIMIT)),
			verified_at: null,
		})
	}
	return fields
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
					normalizeDomain(domain) ?? domain.toLowerCase(),
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

export function credentialAccount(db: Db, accountId: string, present: Present): CredentialAccount | null {
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
			fields: fieldSources(row.local_fields).map((field) => ({ ...field, verified_at: null })),
			follow_requests_count: local.follow_requests_count,
			hide_collections: row.hide_collections === 1,
		},
		// Every user has Mastodon's default role (id -99) until roles exist. permissions is a string (design §4).
		role: { id: '-99', name: '', permissions: '0', color: '', highlighted: false },
	}
}

export const verifyCredentials = userReadOperation<{ present: Present }, CredentialAccount | null>(
	(db, { present }, viewer) => credentialAccount(db, viewer.accountId, present)
)

// GET /oauth/userinfo (Mastodon's OAuthUserinfoSerializer): OpenID Connect claims of the token's own account, with the
// display name, profile URL and avatar as the account presenter shows them.
export type Userinfo = {
	iss: string
	sub: string
	name: string
	preferred_username: string
	profile: string
	picture: string
}

export const userinfo = userReadOperation<{ present: Present }, Userinfo | null>((db, { present }, viewer) => {
	const row = accountRow(db, viewer.accountId)
	if (row === undefined) {
		return null
	}
	const account = presentAccount(row, present)
	return {
		iss: `${present.origin}/`,
		sub: row.uri,
		name: account.display_name,
		preferred_username: account.username,
		profile: account.url,
		picture: account.avatar,
	}
})

// GET /api/v1/preferences (Mastodon's REST::PreferencesSerializer): the posting defaults the account stores, and
// Mastodon's defaults for the reading preferences Kopje has no setting for. The language is null when none is set.
export type Preferences = {
	'posting:default:visibility': Visibility
	'posting:default:sensitive': boolean
	'posting:default:language': string | null
	'reading:expand:media': 'default'
	'reading:expand:spoilers': false
}

export const preferences = userReadOperation<object, Preferences | null>((db, _input, { accountId }) => {
	const row = db.first<Omit<CredentialRow, 'follow_requests_count'>>(
		'SELECT default_visibility, default_sensitive, default_language FROM local_accounts WHERE account_id = ?',
		accountId
	)
	return row === undefined
		? null
		: {
				'posting:default:visibility': row.default_visibility,
				'posting:default:sensitive': row.default_sensitive === 1,
				'posting:default:language': row.default_language,
				'reading:expand:media': 'default',
				'reading:expand:spoilers': false,
			}
})

export type CredentialChanges = {
	displayName?: string
	note?: string
	locked?: boolean
	bot?: boolean
	discoverable?: boolean
	hideCollections?: boolean
	privacy?: Visibility
	sensitive?: boolean
	language?: string | null
	// Replaces every field; lengths and count are validated by the caller.
	fields?: FieldSource[]
}

// Lengths and values are validated by the caller. display_name and the note are plain text: display_name is stored
// as is (JSON consumers escape it), the note is stored as escaped paragraphs.
export const updateCredentials = userWriteOperation<
	{ changes: CredentialChanges; present: Present; now: number },
	CredentialAccount | null
>((db, { changes, present, now }, { accountId }) => {
	const current = db.first<{ username: string; display_name: string; actor_type: string; hide_collections: number }>(
		`SELECT a.username, a.display_name, a.actor_type, l.hide_collections
		FROM accounts a JOIN local_accounts l ON l.account_id = a.id WHERE a.id = ?`,
		accountId
	)
	if (current === undefined) {
		return null
	}
	const before = actorSnapshot(db, accountId)
	const displayName = changes.displayName ?? current.display_name
	const hide = bit(changes.hideCollections)
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
			default_language = CASE WHEN ? THEN ? ELSE default_language END,
			fields = COALESCE(?, fields), hide_collections = COALESCE(?, hide_collections)
		WHERE account_id = ?`,
		changes.privacy ?? null,
		bit(changes.sensitive),
		changes.language === undefined ? 0 : 1,
		changes.language ?? null,
		changes.fields === undefined ? null : JSON.stringify(changes.fields.slice(0, MAX_FIELDS)),
		hide,
		accountId
	)
	// Other servers learn of the change (Update(Person)), only if the published document changed, or if the account
	// shows or hides its network: the document does not carry that, but a server that receives the Update fetches the
	// collections again and learns it from them, as Mastodon's ProcessAccountService does.
	const hideChanged = hide !== null && hide !== current.hide_collections
	recordActorUpdate(db, accountId, hideChanged ? null : before, now)
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
	muting_expires_at: string | null
	domain_blocking: number
}

// The viewer's relationships with each account, as they stand at `now` (an expired mute no longer counts).
export function relationshipsOf(db: Db, viewerId: string, accountIds: string[], now: number): Relationship[] {
	const rows = db.all<RelationshipRow>(
		`SELECT a.id,
			fo.state AS following, fo.show_reblogs, fo.notify, fo.languages,
			fb.state AS followed_by,
			${blocksSql('?1', 'a.id')} AS blocking,
			${blocksSql('a.id', '?1')} AS blocked_by,
			m.account_id IS NOT NULL AS muting, m.hide_notifications AS muting_notifications, m.expires_at AS muting_expires_at,
			${domainBlocksSql('?1', 'a.id')} AS domain_blocking
		FROM json_each(?2) j
		JOIN accounts a ON a.id = j.value
		LEFT JOIN follows fo ON fo.account_id = ?1 AND fo.target_account_id = a.id
		LEFT JOIN follows fb ON fb.account_id = a.id AND fb.target_account_id = ?1
		${activeMuteJoinSql('m', '?1', 'a.id', '?3')}
		ORDER BY j.key`,
		viewerId,
		JSON.stringify(accountIds),
		new Date(now).toISOString()
	)
	return rows.map((row) => ({
		id: row.id,
		following: row.following === 'accepted',
		showing_reblogs: row.following !== null && row.show_reblogs === 1,
		notifying: row.following !== null && row.notify === 1,
		languages: row.languages === null ? null : (JSON.parse(row.languages) as string[]),
		followed_by: row.followed_by === 'accepted',
		requested_by: row.followed_by === 'pending',
		blocking: row.blocking === 1,
		blocked_by: row.blocked_by === 1,
		muting: row.muting === 1,
		muting_notifications: row.muting_notifications === 1,
		muting_expires_at: row.muting_expires_at,
		requested: row.following === 'pending',
		domain_blocking: row.domain_blocking === 1,
		endorsed: false,
		note: '',
	}))
}

export const MAX_RELATIONSHIP_IDS = 100

export const relationships = userReadOperation<{ ids: string[] }, Relationship[]>(
	(db, { ids }, { accountId: viewerId, now }) => {
		const resolved = ids
			.slice(0, MAX_RELATIONSHIP_IDS)
			.map((id) => resolveAccountId(db, id))
			.filter((id) => id !== null)
		return relationshipsOf(db, viewerId, [...new Set(resolved)], now)
	}
)

// GET /api/v1/accounts/familiar_followers (Mastodon's FamiliarFollowersPresenter): for each requested account, the
// accounts the viewer follows that follow it. Both follows are accepted ones (VIS-8). As Mastodon's
// FamiliarFollowersController and FamiliarFollowersPresenter: an unknown or suspended account has no entry; an account
// that hides its network has an entry with no accounts, whoever asks (the account itself included); a follower that
// hides its network, or is suspended, is left out. So is a follower the viewer filters out of lists (filteredForSql: a
// block, a mute that applies at the request time, or a block of its domain).
// Bounds (RES-3, RES-7): at most MAX_FAMILIAR_FOLLOWERS_IDS accounts. For each, the candidates are the viewer's own
// accepted follows (at most FAMILIAR_FOLLOWERS_WINDOW, through the partial index of accepted follows), each checked
// for an accepted follow of the account through the unique pair index (CROSS JOIN keeps SQLite to that order), so
// the work never grows with the account's other followers and a match is never pushed out by them. At most
// MAX_FAMILIAR_FOLLOWERS are shown, newest follow of the account first.
export const MAX_FAMILIAR_FOLLOWERS_IDS = 20
// Above Mastodon's default follow limit (7,500), which Kopje does not enforce: a match past the viewer's first 10,000
// accepted follows (in index order, by account id) is not shown (an accepted risk).
export const FAMILIAR_FOLLOWERS_WINDOW = 10_000
export const MAX_FAMILIAR_FOLLOWERS = 80

export type FamiliarFollowers = { id: string; accounts: Account[] }

export const familiarFollowers = userReadOperation<{ ids: string[]; present: Present }, FamiliarFollowers[]>(
	(db, { ids, present }, _viewer, { accountId: viewerId, now }) => {
		const resolved = ids
			.slice(0, MAX_FAMILIAR_FOLLOWERS_IDS)
			.map((id) => resolveAccountId(db, id))
			.filter((id) => id !== null)
		return [...new Set(resolved)].flatMap((target) => {
			const row = db.first<{ hidden: number }>(
				`SELECT ${hidesCollectionsSql('?1')} AS hidden WHERE ${availableSql('?1')}`,
				target
			)
			if (row === undefined) {
				return []
			}
			if (row.hidden === 1) {
				return [{ id: target, accounts: [] }]
			}
			const followers = db
				.all<{ id: string }>(
					`SELECT x.account_id AS id
					FROM (SELECT target_account_id FROM follows WHERE account_id = ?2 AND state = 'accepted' LIMIT ?3) mine
					CROSS JOIN follows x ON x.account_id = mine.target_account_id AND x.target_account_id = ?1 AND x.state = 'accepted'
					WHERE ${availableSql('x.account_id')} AND NOT ${hidesCollectionsSql('x.account_id')}
						AND NOT ${filteredForSql('x.account_id', '?2', '?5')}
					ORDER BY x.id DESC LIMIT ?4`,
					target,
					viewerId,
					FAMILIAR_FOLLOWERS_WINDOW,
					MAX_FAMILIAR_FOLLOWERS,
					now
				)
				.map((row) => row.id)
			const accounts = presentAccountsById(db, followers, present)
			return [{ id: target, accounts: followers.flatMap((id) => accounts.get(id) ?? []) }]
		})
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
// ranks first, then local accounts. Only accounts the viewer may find are listed (findableBySql, R14): not suspended,
// and not on a domain the viewer blocks.
export const searchAccounts = userReadOperation<SearchInput, Account[]>((db, input, viewer) =>
	findAccounts(db, input, viewer.accountId)
)

// The work of an account search is bounded (RES-7): it matches only candidates from indexed sources, never the whole
// table: every local account, the accounts whose address is exactly the query (username, or username@domain), up to
// ACCOUNT_PREFIX_LIMIT accounts whose username starts with the first term, and the ACCOUNT_RECENT_LIMIT accounts the
// instance learned of most recently. With following, the sources are the exact address among accepted follows and up
// to ACCOUNT_RECENT_LIMIT accepted follows (a partial index holds accepted follows only, so pending ones are never
// read). An exact address is always found. Trade-off: a remote account known for long is found by its address or its
// username prefix, not by a word of its display name.
export const ACCOUNT_PREFIX_LIMIT = 1000
export const ACCOUNT_RECENT_LIMIT = 5000

// The largest code point, as UTF-8 compares: every string with a prefix sorts below prefix + this.
const PREFIX_END = '\u{10FFFF}'

export function findAccounts(db: Db, input: SearchInput, viewerId: string): Account[] {
	// An address is read with the shared parser, so a Unicode domain finds the account stored under its punycode.
	const address = parseAddress(input.query.trim())
	const query = (address === null ? input.query : `${address.username}@${address.domain}`)
		.trim()
		.replace(/^@/, '')
		.replace(new RegExp(`@${escapeRegExp(input.localDomain)}$`, 'i'), '')
	const terms = queryTerms(query)
	if (terms.length === 0) {
		return []
	}
	const where = terms.map((variants) => `(${variants.map(() => 'instr(a.search_text, ?) > 0').join(' OR ')})`)
	const exactUsername = (query.split('@')[0] ?? '').toLowerCase()
	const prefix = (terms[0]?.[0] ?? '').replace(/^@/, '').split('@')[0] ?? ''
	// The exact address: "user" is any account with that username, "user@domain" that one remote account.
	const [exactUser = '', exactDomain] = query.toLowerCase().split('@')
	const exact =
		exactDomain === undefined
			? 'SELECT id FROM accounts WHERE lower(username) = ?'
			: 'SELECT id FROM accounts WHERE domain = ? AND lower(username) = ?'
	const exactParams: SqlStorageValue[] = exactDomain === undefined ? [exactUser] : [exactDomain, exactUser]
	const candidates = input.following
		? `SELECT target_account_id AS id FROM (SELECT target_account_id FROM follows
				WHERE account_id = ? AND state = 'accepted' LIMIT ${ACCOUNT_RECENT_LIMIT})
			UNION SELECT e.id FROM (${exact} LIMIT ${ACCOUNT_PREFIX_LIMIT}) e
				JOIN follows f ON f.account_id = ? AND f.target_account_id = e.id AND f.state = 'accepted'`
		: `SELECT account_id AS id FROM local_accounts
			UNION SELECT id FROM (${exact} LIMIT ${ACCOUNT_PREFIX_LIMIT})
			UNION SELECT id FROM (SELECT id FROM accounts WHERE lower(username) >= ? AND lower(username) < ?
				LIMIT ${ACCOUNT_PREFIX_LIMIT})
			UNION SELECT id FROM (SELECT id FROM accounts ORDER BY rowid DESC LIMIT ${ACCOUNT_RECENT_LIMIT})`
	const candidateParams: SqlStorageValue[] = input.following
		? [viewerId, ...exactParams, viewerId]
		: [...exactParams, prefix, `${prefix}${PREFIX_END}`]
	const ids = db
		.all<{ id: string }>(
			`WITH candidates(id) AS (${candidates})
			SELECT a.id FROM candidates c JOIN accounts a ON a.id = c.id
			WHERE ${findableBySql('a.id', '?')} AND ${where.join(' AND ')}
			ORDER BY lower(a.username) = ? DESC, a.domain IS NULL DESC, a.followers_count DESC, a.id
			LIMIT ? OFFSET ?`,
			...candidateParams,
			viewerId,
			...terms.flat(),
			exactUsername,
			input.limit,
			input.offset
		)
		.map((row) => row.id)
	const accounts = presentAccountsById(db, ids, input.present)
	return ids.flatMap((id) => {
		const account = accounts.get(id)
		return account === undefined ? [] : [account]
	})
}

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
	// The change cannot be recorded right now (answered 503).
	| { status: 'unavailable' }

type TargetRow = {
	id: string
	domain: string | null
	locked: number
	available: number
	followable: number
}

function followTarget(db: Db, viewerId: string, target: string): TargetRow | null {
	const id = resolveAccountId(db, target)
	if (id === null) {
		return null
	}
	return (
		db.first<TargetRow>(
			`SELECT a.id, a.domain, a.locked, ${availableSql('a.id')} AS available,
				${followableBySql('a.id', '?1')} AS followable
			FROM accounts a WHERE a.id = ?2`,
			viewerId,
			id
		) ?? null
	)
}

// Follows or updates the options of an existing follow. A local unlocked target is followed at once; a locked or
// remote target gets a pending request (a remote Accept arrives over federation). A local target is notified
// (follow, or follow_request when locked) in the same transaction; a remote target is sent a Follow (its id kept in
// follows.uri, which the remote Accept must match) and stays pending until that Accept arrives (VIS-8, VIS-9). As
// in Mastodon's FollowService, a suspended target is not found, and a block either way or a domain block of the
// viewer forbids the follow.
export const follow = userWriteOperation<FollowInput, RelationshipResult>((db, input, { accountId: viewerId }) => {
	const target = followTarget(db, viewerId, input.target)
	if (target === null || target.available === 0) {
		return { status: 'not_found' }
	}
	if (target.followable === 0) {
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
		const edge = db.first<{ id: string }>(
			`INSERT INTO follows (account_id, target_account_id, state, show_reblogs, notify, languages, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING CAST(id AS TEXT) AS id`,
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
		} else if (edge !== undefined) {
			const activity = remoteFollow(db, viewerId, target, edge.id, null)
			db.run('UPDATE follows SET uri = ? WHERE id = CAST(? AS INTEGER)', activity.followUri, edge.id)
			recordOutbound(db, viewerId, followActivity(activity), input.now)
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
	return relationshipResult(db, viewerId, target.id, input.now)
})

export const unfollow = userWriteOperation<{ target: string; now: number }, RelationshipResult>(
	(db, { target: targetId, now }, { accountId: viewerId }) => {
		const target = followTarget(db, viewerId, targetId)
		if (target === null) {
			return { status: 'not_found' }
		}
		const removed = db.first<{ id: string; uri: string | null }>(
			'DELETE FROM follows WHERE account_id = ? AND target_account_id = ? RETURNING CAST(id AS TEXT) AS id, uri',
			viewerId,
			target.id
		)
		// A remote follow, accepted or still requested, is undone there too (UnfollowService).
		if (removed !== undefined && target.domain !== null) {
			recordOutbound(db, viewerId, undoFollowActivity(remoteFollow(db, viewerId, target, removed.id, removed.uri)), now)
		}
		// The follow's notification goes with it, as Mastodon destroys a notification with its activity.
		db.run(
			"DELETE FROM notifications WHERE account_id = ? AND from_account_id = ? AND type IN ('follow', 'follow_request')",
			target.id,
			viewerId
		)
		recountFollows(db, viewerId, target)
		return relationshipResult(db, viewerId, target.id, now)
	}
)

// The Follow of a remote follow edge. Migrated edges may have no stored uri; they get the id this instance would
// have given them (a remote server matches an Undo by actor and object as well).
function remoteFollow(db: Db, viewerId: string, target: TargetRow, edgeId: string, uri: string | null) {
	const actorUri = db.first<{ uri: string }>('SELECT uri FROM accounts WHERE id = ?', viewerId)?.uri ?? ''
	const targetUri = db.first<{ uri: string }>('SELECT uri FROM accounts WHERE id = ?', target.id)?.uri ?? ''
	return { followUri: uri ?? followUri(actorUri, edgeId), actorUri, targetUri, targetId: target.id }
}

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

export function relationshipResult(db: Db, viewerId: string, targetId: string, now: number): RelationshipResult {
	const [relationship] = relationshipsOf(db, viewerId, [targetId], now)
	return relationship === undefined ? { status: 'not_found' } : { status: 'ok', relationship }
}

// Keyset pages over an edge table's INTEGER id (a paging cursor only). max_id and since_id page backwards from the
// newest; min_id pages forwards from the given cursor and is returned newest first as well. Cursors stay strings:
// they are read with CAST(id AS TEXT) and compared in SQL, never as JS numbers (which are exact only up to 2^53).
export type PageQuery = { maxId?: string; sinceId?: string; minId?: string; limit: number }

// The cursor on an edge table's INTEGER id as a plain range, with `max` and `min` the cursor parameters (NULL for none):
// no cursor is a REAL beyond either end of the INTEGER range, so every id is inside it (SQLite compares the two types by
// value). A read in an index ending in the id then starts at the cursor, not at the newest.
export function edgeRangeSql(column: string, max: string, min: string): string {
	return `${column} < coalesce(CAST(${max} AS INTEGER), 1e19) AND ${column} > coalesce(CAST(${min} AS INTEGER), -1e19)`
}

// newest and oldest are the cursors of the rows the page read. read is how many it read, when the presenter may leave
// some out (a hide filter): the next page is offered when the read filled the page, as Mastodon decides it from the
// statuses it loaded.
export type Page<T> = { items: T[]; newest: string | null; oldest: string | null; read?: number }

export type ListFollowsInput = {
	account: string
	direction: 'followers' | 'following'
	page: PageQuery
	present: Present
}

// GET /api/v1/accounts/:id/followers and /following as the viewer (null: anonymous) may see them (R13, Mastodon's
// FollowerAccountsController and FollowingAccountsController): accepted follows, newest first. Nothing is listed when
// the account is suspended, or, to anyone but itself, when it hides its network or blocks the viewer
// (followListsShownSql). Others do not see the accounts they block, mute or are blocked by (followListedSql), left out
// before LIMIT. An unknown account is not found.
export const listFollows = optionalUserReadOperation<ListFollowsInput, Page<Account> | null>(
	(db, { account, direction, page, present }, { accountId: viewerId, now }) => {
		const id = resolveAccountId(db, account)
		if (id === null) {
			return null
		}
		if (db.first(`SELECT 1 AS shown WHERE ${followListsShownSql('?1', '?2')}`, id, viewerId) === undefined) {
			return { items: [], newest: null, oldest: null }
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
			AND ${followListedSql('a.id', '?1', '?5', '?6')}
		ORDER BY f.id ${ascending ? 'ASC' : 'DESC'} LIMIT ?4`,
			id,
			page.maxId ?? null,
			lower,
			page.limit,
			viewerId,
			now
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

// Follow requests to the viewer (Mastodon's FollowRequestsController and AuthorizeFollowService/RejectFollowService).
// Only the followed account decides (VIS-9): the viewer is the target, from the credential, never from the request.
export const listFollowRequests = userReadOperation<{ page: PageQuery; present: Present }, Page<Account>>(
	(db, { page, present }, { accountId: viewerId }) => {
		const ascending = page.minId !== undefined
		const rows = db.all<AccountRow & { cursor: string }>(
			`SELECT CAST(f.id AS TEXT) AS cursor, ${ACCOUNT_COLUMNS}
			FROM follows f JOIN accounts a ON a.id = f.account_id LEFT JOIN local_accounts l ON l.account_id = a.id
			WHERE f.target_account_id = ?1 AND f.state = 'pending'
				AND (?2 IS NULL OR f.id < CAST(?2 AS INTEGER)) AND (?3 IS NULL OR f.id > CAST(?3 AS INTEGER))
			ORDER BY f.id ${ascending ? 'ASC' : 'DESC'} LIMIT ?4`,
			viewerId,
			page.maxId ?? null,
			page.minId ?? page.sinceId ?? null,
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

// Authorizes or rejects a pending follow of the viewer. A remote requester gets the Accept or Reject at its personal
// inbox, named after its Follow (followAnswerActivity). The follow_request notification goes either way.
export const answerFollowRequest = userWriteOperation<
	{ account: string; decision: 'authorize' | 'reject'; now: number },
	RelationshipResult
>((db, { account, decision, now }, { accountId: viewerId }) => {
	const requesterId = resolveAccountId(db, account)
	const request =
		requesterId === null
			? undefined
			: db.first<{ id: string; uri: string | null; requester_uri: string; remote: number }>(
					`SELECT CAST(f.id AS TEXT) AS id, f.uri, a.uri AS requester_uri, a.domain IS NOT NULL AS remote
					FROM follows f JOIN accounts a ON a.id = f.account_id
					WHERE f.account_id = ? AND f.target_account_id = ? AND f.state = 'pending'`,
					requesterId,
					viewerId
				)
	if (requesterId === null || request === undefined) {
		return { status: 'not_found' }
	}
	if (decision === 'authorize') {
		db.run("UPDATE follows SET state = 'accepted' WHERE id = CAST(? AS INTEGER)", request.id)
	} else {
		// A rejected remote Follow is recorded as retracted (retractFollow), so a redelivery of it does not ask again
		// (ID-7); a Misskey pair id is not recorded, and its redelivery asks again (the pair limit). If it
		// cannot be recorded (the requester's retraction cap), nothing changes.
		if (request.remote === 1 && request.uri !== null && !retractFollow(db, request.requester_uri, request.uri, now)) {
			return { status: 'unavailable' }
		}
		db.run('DELETE FROM follows WHERE id = CAST(? AS INTEGER)', request.id)
	}
	db.run(
		"DELETE FROM notifications WHERE account_id = ? AND from_account_id = ? AND type = 'follow_request'",
		viewerId,
		requesterId
	)
	if (request.remote === 1) {
		const viewerUri = db.first<{ uri: string }>('SELECT uri FROM accounts WHERE id = ?', viewerId)?.uri ?? ''
		recordOutbound(
			db,
			viewerId,
			followAnswerActivity(decision === 'authorize' ? 'Accept' : 'Reject', {
				localActorUri: viewerUri,
				followerUri: request.requester_uri,
				followerId: requesterId,
				followUri: request.uri,
				edgeId: request.id,
			}),
			now
		)
	}
	db.run(
		`UPDATE accounts SET followers_count =
			(SELECT COUNT(*) FROM follows WHERE target_account_id = ?1 AND state = 'accepted') WHERE id = ?1`,
		viewerId
	)
	return relationshipResult(db, viewerId, requesterId, now)
})
