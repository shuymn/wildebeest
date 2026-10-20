import { followActivity, followAnswerActivity, followUri, recordOutbound, undoFollowActivity } from './activities'
import { actorSnapshot, recordActorUpdate } from './actor-update'
import { admit, type Admitted, admittedPage, ANSWER_BYTES, ARRAY_ANSWER_BYTES, jsonBytes } from './answer-budget'
import {
	activeMuteJoinSql,
	availableJoinedSql,
	availableSql,
	blocksSql,
	domainBlocksSql,
	filteredForSql,
	findableBySql,
	followableBySql,
	followListedSql,
	followListsShownSql,
	hidesCollectionsSql,
	type QuotePolicyName,
	REACHES_FOLLOWERS_SQL,
} from './audience'
import { localRole, optionalUserReadOperation, type Role, userReadOperation, userWriteOperation } from './auth'
import { type CustomEmoji, localEmojiSnapshot, presentEmojis } from './custom-emojis'
import { retractFollow } from './inbox'
import { notify } from './notifications'
import { readOperation } from './operation'
import { htmlToPlainText, plainTextToHtml } from './plain-text'
import {
	actorUriSql,
	cutSql,
	DISPLAY_NAME_LIMIT,
	PROFILE_URL_LIMIT,
	USERNAME_LIMIT,
	usernameSql,
} from './profile-bounds'
import { accountSearchText, queryTerms } from './search-text'
import { renderFieldValue } from './status-text'
import { readWindow, singleWindow, type Window, windowJson, windowPage } from './windows'
import { type ColumnMap, selectSql } from '../db/columns'
import type { Db } from '../db/sql'
import { normalizeDomain, parseAddress } from '../platform/domain-name'
import { boundedHref, httpUrl } from '../platform/http-url'
import { ACCOUNT_EMOJIS_BYTES, storedDisplayName, storedText } from '../platform/stored-bounds'
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
	// Whether the account hides its network (Account#hide_collections): set by a local account, learned of a remote one
	// (remote-collections.ts); null for a remote account Kopje has not learned it of.
	hide_collections: boolean | null
	emojis: CustomEmoji[]
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

// Account::AttributionDomains::ATTRIBUTION_DOMAINS_LIMIT.
export const MAX_ATTRIBUTION_DOMAINS = 100

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
		attribution_domains: string[]
		quote_policy: QuotePolicyName
	}
	role: Role
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
	// R1, read live in the query that reads the row (availableJoinedSql): 0 for an unavailable account.
	available: number
	last_status_at: string | null
	// local_accounts.fields; null for a remote account. hide_collections: local_accounts' for a local account,
	// accounts' (null until learned) for a remote one.
	local_fields: string | null
	hide_collections: number | null
	// A remote account's PropertyValue attachments, bounded (REMOTE_ATTACHMENT_SQL), as JSON; null for a local one.
	attachment: string | null
	// The account's emoji snapshot (custom-emojis.ts); null for none.
	emojis: string | null
}

// Fields a remote profile shows: its PropertyValue attachments (ProcessAccountService#property_values), the name as
// plain text and the value as sanitized HTML (HTML-1, its links http(s) only, HTML-3), as Mastodon renders them.
// Kopje's bounds (RES-2): at most MAX_REMOTE_FIELDS, names cut at 255 code units, values at FIELD_VALUE_RAW_LIMIT
// before sanitizing, and REMOTE_FIELDS_BYTES in all. Mastodon keeps more: 50 fields
// (ActivityPub::ProcessAccountService::MAX_PROFILE_FIELDS) and 2,047 characters of each stripped name and value
// (Account::Field::MAX_CHARACTERS_COMPAT).
export const MAX_REMOTE_FIELDS = 16
const FIELD_NAME_LIMIT = 255
const FIELD_VALUE_RAW_LIMIT = 4096
// The most UTF-8 bytes of field JSON one account carries: read from SQLite (REMOTE_ATTACHMENT_SQL) and, again, shown
// (remoteFields). An answer of N presented accounts thus carries at most N × 32 KiB of fields; an answer of many
// (a list's members with limit=0, familiar followers) at most ANSWER_BYTES in all.
export const REMOTE_FIELDS_BYTES = 32 * 1024

// A remote account's attachment as ACCOUNT_COLUMN_MAP projects it, chosen and cut in SQL so that the stored actor
// document (up to the fetch budget, 2 MiB) never reaches the isolate: a JSON list of {name, value} entries in
// document order, at most MAX_REMOTE_FIELDS of them, the name cut (cutSql) at FIELD_NAME_LIMIT and the value at
// FIELD_VALUE_RAW_LIMIT code points, and only the leading entries whose JSON fits REMOTE_FIELDS_BYTES (size: the
// list's length in bytes once each entry and the ones before it are included). The bound is in bytes because
// escaping inflates characters up to six times. An entry counts when it is an object whose `type` is
// 'PropertyValue' or a list holding it and whose name and value are strings; an attachment that is one object
// counts as a list of one. SQLite counts code points where JavaScript counts code units, so remoteFields cuts again.
const REMOTE_ATTACHMENT_SQL = `CASE WHEN a.domain IS NOT NULL THEN (
		SELECT '[' || COALESCE(group_concat(k.entry, ',' ORDER BY k.key), '') || ']'
		FROM (SELECT c.key, c.entry, 1 + sum(length(CAST(c.entry AS BLOB)) + 1) OVER (ORDER BY c.key) AS size
			FROM (SELECT e.key, json_object('name', ${cutSql("e.value ->> '$.name'", FIELD_NAME_LIMIT)},
					'value', ${cutSql("e.value ->> '$.value'", FIELD_VALUE_RAW_LIMIT)}) AS entry
				FROM json_each(CASE json_type(a.raw, '$.attachment') WHEN 'array' THEN a.raw -> '$.attachment'
					ELSE json_array(a.raw -> '$.attachment') END) e
				WHERE e.type = 'object' AND json_type(e.value, '$.name') = 'text' AND json_type(e.value, '$.value') = 'text'
					AND json_type(e.value, '$.type') IN ('text', 'array')
					AND EXISTS (SELECT 1 FROM json_each(e.value, '$.type') t WHERE t.type = 'text' AND t.value = 'PropertyValue')
				ORDER BY e.key LIMIT ${MAX_REMOTE_FIELDS}) c) k
		WHERE k.size <= ${REMOTE_FIELDS_BYTES}) END`

// RES-2: stored profile bounds: platform/stored-bounds.ts; username and actor id read projections: profile-bounds.ts;
// fields: REMOTE_ATTACHMENT_SQL and remoteFields. Maxima: the account occurrence in docs/threat-model.md, "Maxima of
// presented units".
export const ACCOUNT_COLUMN_MAP = {
	id: 'a.id',
	uri: actorUriSql('a.uri'),
	username: usernameSql('a.username'),
	domain: 'a.domain',
	actor_type: 'a.actor_type',
	display_name: 'a.display_name',
	note: 'a.note',
	url: 'a.url',
	avatar_url: 'a.avatar_url',
	header_url: 'a.header_url',
	locked: 'a.locked',
	discoverable: 'a.discoverable',
	followers_count: 'a.followers_count',
	following_count: 'a.following_count',
	statuses_count: 'a.statuses_count',
	created_at: 'a.created_at',
	available: availableJoinedSql('a', 'l'),
	last_status_at: `(SELECT substr(s.published_at, 1, 10) FROM statuses s
		WHERE s.account_id = a.id AND s.visibility IN ${REACHES_FOLLOWERS_SQL} ORDER BY s.id DESC LIMIT 1)`,
	local_fields: 'l.fields',
	hide_collections: 'COALESCE(l.hide_collections, a.hide_collections)',
	attachment: REMOTE_ATTACHMENT_SQL,
	emojis: 'a.emojis',
} as const satisfies ColumnMap

export { DISPLAY_NAME_LIMIT, PROFILE_URL_LIMIT, USERNAME_LIMIT, usernameSql }

export const ACCOUNT_FROM = 'accounts a LEFT JOIN local_accounts l ON l.account_id = a.id'

// An answer of many accounts (a list's members and endorsements with limit=0, familiar followers) is within
// ANSWER_BYTES, the JSON around the accounts reserved first (only its first account, bounded by RES-2, may stand
// alone past it). A Mastodon user's account serializes to about 2 KiB, so 1,000 take a quarter of it; one at
// Misskey's profile limits to about 8 KiB (test/account-answer-bytes.test.ts measures both).
// Accounts read per query while an answer is filled: what is read past the budget is at most one chunk of accounts
// at their bound (RES-2), about 6 MB.
const ANSWER_CHUNK = 50

// The presented accounts of `ids` (accounts' ids), in order, `chunk` at a time, each with its serialized size (and a
// separator), an id with no account skipped: only the profiles asked for so far are read, so the attachment projection
// runs for those alone.
export function accountStream(
	db: Db,
	ids: readonly string[],
	present: Present,
	chunk = ANSWER_CHUNK
): () => { account: Account; bytes: number } | undefined {
	const accounts = accountsOf(db, ids, present, chunk)
	return () => {
		for (let next = accounts.next(); next.done !== true; next = accounts.next()) {
			if (next.value !== undefined) {
				return { account: next.value, bytes: jsonBytes(next.value) + 1 }
			}
		}
		return undefined
	}
}

// The presented accounts of `ids` (accounts' ids, each once), in order, while their serialized bytes stay within
// `budget`, read in chunks that stop once it is reached (admitAccounts). `leading`: the first account is shown whatever
// its size (RES-2 bounds it), so an answer continued from its last account moves on. `cut`: an account was left out,
// by the budget or for having none. `bytes`: the admitted accounts' JSON, each with a separator.
export function presentAccountsWithin(
	db: Db,
	ids: readonly string[],
	present: Present,
	budget: number,
	leading: boolean
): { items: Account[]; cut: boolean; bytes: number } {
	const { items, bytes } = admitAccounts(db, ids, present, budget, leading)
	return { items, cut: items.length < ids.length, bytes }
}

// The presented accounts of `ids` in order (an id may repeat), for an admission (admit) of items that embed them:
// read `chunk` at a time as the stream reaches them, undefined for an id with no account. What the stream holds past
// what its consumer kept is one chunk of accounts at their bound (RES-2).
export function* accountsOf(
	db: Db,
	ids: readonly string[],
	present: Present,
	chunk = ANSWER_CHUNK
): Generator<Account | undefined, undefined> {
	for (let next = 0; next < ids.length; next += chunk) {
		const slice = ids.slice(next, next + chunk)
		const rows = new Map(accountRowsOf(db, [...new Set(slice)]).map((row) => [row.id, row]))
		for (const id of slice) {
			const row = rows.get(id)
			yield row === undefined ? undefined : presentAccount(row, present)
		}
	}
}

// REST::DedupNotificationGroupSerializer::PartialAccountSerializer.
export type PartialAccount = Pick<Account, 'id' | 'acct' | 'locked' | 'bot' | 'url' | 'avatar' | 'avatar_static'>

type PartialRow = Pick<AccountRow, 'id' | 'uri' | 'username' | 'domain' | 'actor_type' | 'url' | 'avatar_url'> &
	Pick<AccountRow, 'locked' | 'available'>

// The partial accounts of `ids` in order (an id may repeat), as presentAccount shows those fields, reading only their
// columns, `chunk` at a time as the stream reaches them; undefined for an id with no account.
export function* partialAccountsOf(
	db: Db,
	ids: readonly string[],
	present: Present,
	chunk = ANSWER_CHUNK
): Generator<PartialAccount | undefined, undefined> {
	for (let next = 0; next < ids.length; next += chunk) {
		const slice = ids.slice(next, next + chunk)
		const rows = new Map(
			db
				.all<PartialRow>(
					`SELECT a.id, ${actorUriSql('a.uri')} AS uri, ${usernameSql('a.username')} AS username, a.domain, a.actor_type,
						a.url, a.avatar_url, a.locked,
						${availableJoinedSql('a', 'l')} AS available
					FROM json_each(?1) c CROSS JOIN accounts a ON a.id = c.value LEFT JOIN local_accounts l ON l.account_id = a.id`,
					JSON.stringify([...new Set(slice)])
				)
				.map((row) => [row.id, row])
		)
		for (const id of slice) {
			const row = rows.get(id)
			if (row === undefined) {
				yield undefined
				continue
			}
			const suspended = row.available === 0
			const avatar =
				(suspended ? null : boundedHref(row.avatar_url, PROFILE_URL_LIMIT)) ?? `${present.origin}${DEFAULT_AVATAR}`
			yield {
				id: row.id,
				acct: acctOf(row),
				locked: !suspended && row.locked === 1,
				bot: !suspended && (row.actor_type === 'Service' || row.actor_type === 'Application'),
				url: accountUrl(row, present.origin),
				avatar,
				avatar_static: avatar,
			}
		}
	}
}

// Admission of accounts (RES-3, admit): the accounts of `ids` in traversal order while their JSON fits `budget`, read
// in chunks of ANSWER_CHUNK; an id with no account is consumed.
export function admitAccounts(
	db: Db,
	ids: readonly string[],
	present: Present,
	budget: number,
	leading: boolean
): Admitted<Account> {
	return admit(accountsOf(db, ids, present), budget, leading)
}

// An account's profile URL. A stored url is used only when it is http(s) (HTML-3); otherwise it is derived from the
// actor URI, which carries the account's origin (a local account's carries the instance origin), or from this
// instance's origin when the URI is not http(s) either. Each is used only within PROFILE_URL_LIMIT as serialized
// (RES-2): a longer one falls back to the next, and to '' when none fits (a converted row of a long host and name).
export function accountUrl(
	row: { url: string | null; uri: string; username: string; domain: string | null },
	origin: string
): string {
	const actor = httpUrl(row.uri)
	return (
		boundedHref(row.url, PROFILE_URL_LIMIT) ??
		(actor === null ? null : boundedHref(`${actor.origin}/@${row.username}`, PROFILE_URL_LIMIT)) ??
		boundedHref(`${origin}/@${acctOf(row)}`, PROFILE_URL_LIMIT) ??
		''
	)
}

export function acctOf(row: { username: string; domain: string | null }): string {
	return row.domain === null ? row.username : `${row.username}@${row.domain}`
}

// An unavailable account (R1: suspended, or a remote account whose deletion has started, as the row's query read it
// live) is shown redacted, as Mastodon's REST::AccountSerializer shows an unavailable one: no display name, note,
// fields or emojis, the default avatar and header, locked, bot and discoverable false, and `suspended: true`.
function presentAccount(row: AccountRow, { origin }: Present): Account {
	const suspended = row.available === 0
	// Stored URLs are shown only when they are http(s) (httpUrl); anything else reads as unset.
	const url = accountUrl(row, origin)
	const avatar = (suspended ? null : boundedHref(row.avatar_url, PROFILE_URL_LIMIT)) ?? `${origin}${DEFAULT_AVATAR}`
	const header = (suspended ? null : boundedHref(row.header_url, PROFILE_URL_LIMIT)) ?? `${origin}${DEFAULT_HEADER}`
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
		emojis: suspended ? [] : presentEmojis(row.emojis, ACCOUNT_EMOJIS_BYTES),
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

// The fields shown, in document order, while the JSON of their names and values, in UTF-8 bytes, stays within
// REMOTE_FIELDS_BYTES: the first field that would pass it is dropped with all after it, never cut. This bounds what is
// returned and serialized, as REMOTE_ATTACHMENT_SQL bounds what is read (sanitizing can grow a value fivefold, `&` to
// `&amp;`). A response of N accounts thus carries at most N × 32 KiB of field names and values once serialized.
function remoteFields(attachment: string | null): Field[] {
	if (attachment === null) {
		return []
	}
	const fields: Field[] = []
	let bytes = 0
	for (const entry of JSON.parse(attachment) as { name: string; value: string }[]) {
		const name = entry.name.slice(0, FIELD_NAME_LIMIT)
		const value = sanitizeRemoteHtml(entry.value.slice(0, FIELD_VALUE_RAW_LIMIT))
		bytes += jsonBytes(name) + jsonBytes(value)
		if (bytes > REMOTE_FIELDS_BYTES) {
			break
		}
		fields.push({ name, value, verified_at: null })
	}
	return fields
}

// The fields a remote account whose document is `raw` will show, chosen and cut as presentation chooses and cuts them
// (REMOTE_ATTACHMENT_SQL over the document, then remoteFields): what the account's emoji snapshot is scanned over.
export function presentedRemoteFields(db: Db, raw: string, domain: string): Field[] {
	const row = db.first<{ attachment: string | null }>(
		`SELECT ${REMOTE_ATTACHMENT_SQL} AS attachment FROM (SELECT ?1 AS raw, ?2 AS domain) a`,
		raw,
		domain
	)
	return remoteFields(row?.attachment ?? null)
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

// Presented accounts by id, read in one query: for getAccounts' MAX_ACCOUNTS_BY_ID only.
function presentAccountsById(db: Db, ids: readonly string[], present: Present): Map<string, Account> {
	return new Map(
		db
			.all<AccountRow>(
				`SELECT ${selectSql(ACCOUNT_COLUMN_MAP)} FROM ${ACCOUNT_FROM} WHERE a.id IN (SELECT value FROM json_each(?1))`,
				JSON.stringify([...new Set(ids)])
			)
			.map((row) => [row.id, presentAccount(row, present)])
	)
}

// One presented account by id, bounded as a unit (RES-2); undefined for an id with no account.
export function presentAccountById(db: Db, id: string, present: Present): Account | undefined {
	const row = accountRow(db, id)
	return row === undefined ? undefined : presentAccount(row, present)
}

function accountRow(db: Db, id: string): AccountRow | undefined {
	return db.first<AccountRow>(`SELECT ${selectSql(ACCOUNT_COLUMN_MAP)} FROM ${ACCOUNT_FROM} WHERE a.id = ?`, id)
}

export const getAccount = readOperation<{ id: string; present: Present }, Account | null>((db, { id, present }) => {
	const resolved = resolveAccountId(db, id)
	const row = resolved === null ? undefined : accountRow(db, resolved)
	return row === undefined ? null : presentAccount(row, present)
})

// GET /api/v1/accounts?id[]= (AccountsController#index): the accounts getAccount shows one by one, read in one query,
// in the order asked, each once; an id that names no account is left out. Kopje has no unapproved accounts
// (`without_unapproved`). The caller limits the ids (MAX_ACCOUNTS_BY_ID).
export const MAX_ACCOUNTS_BY_ID = 40

export const getAccounts = readOperation<{ ids: string[]; present: Present }, Account[]>((db, { ids, present }) => {
	const resolved = [...new Set(ids.slice(0, MAX_ACCOUNTS_BY_ID).flatMap((id) => resolveAccountId(db, id) ?? []))]
	const accounts = presentAccountsById(db, resolved, present)
	return resolved.flatMap((id) => accounts.get(id) ?? [])
})

// domain null means a local account.
export const lookupAccount = readOperation<
	{ username: string; domain: string | null; present: Present },
	Account | null
>((db, { username, domain, present }) => {
	const row =
		domain === null
			? db.first<AccountRow>(
					`SELECT ${selectSql(ACCOUNT_COLUMN_MAP)} FROM ${ACCOUNT_FROM} WHERE a.domain IS NULL AND lower(a.username) = lower(?)`,
					username
				)
			: db.first<AccountRow>(
					`SELECT ${selectSql(ACCOUNT_COLUMN_MAP)} FROM ${ACCOUNT_FROM} WHERE a.domain = ? AND lower(a.username) = lower(?)`,
					normalizeDomain(domain) ?? domain.toLowerCase(),
					username
				)
	return row === undefined ? null : presentAccount(row, present)
})

type CredentialRow = {
	default_visibility: Visibility
	default_sensitive: number
	default_language: string | null
	default_quote_policy: QuotePolicyName
	attribution_domains: string
	follow_requests_count: number
}

export function credentialAccount(db: Db, accountId: string, present: Present): CredentialAccount | null {
	const row = accountRow(db, accountId)
	const local = db.first<CredentialRow>(
		`SELECT default_visibility, default_sensitive, default_language, default_quote_policy, attribution_domains,
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
			attribution_domains: JSON.parse(local.attribution_domains) as string[],
			quote_policy: local.default_quote_policy,
		},
		// The OAuth admin has the Owner role with the permissions Kopje serves; every other user the default role.
		role: localRole(db, accountId),
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
	'posting:default:quote_policy': QuotePolicyName
	'reading:expand:media': 'default'
	'reading:expand:spoilers': false
}

export const preferences = userReadOperation<object, Preferences | null>((db, _input, { accountId }) => {
	const row = db.first<Omit<CredentialRow, 'follow_requests_count' | 'attribution_domains'>>(
		'SELECT default_visibility, default_sensitive, default_language, default_quote_policy FROM local_accounts WHERE account_id = ?',
		accountId
	)
	return row === undefined
		? null
		: {
				'posting:default:visibility': row.default_visibility,
				'posting:default:sensitive': row.default_sensitive === 1,
				'posting:default:language': row.default_language,
				'posting:default:quote_policy': row.default_quote_policy,
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
	quotePolicy?: QuotePolicyName
	// Replaces every field; lengths and count are validated by the caller.
	fields?: FieldSource[]
	// Replaces every attribution domain; normalized and validated by the caller.
	attributionDomains?: string[]
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
	const changedName = changes.displayName === undefined ? null : storedDisplayName(changes.displayName)
	const displayName = changedName ?? current.display_name
	const hide = bit(changes.hideCollections)
	const actorType =
		changes.bot === undefined || !['Person', 'Service'].includes(current.actor_type)
			? current.actor_type
			: changes.bot
				? 'Service'
				: 'Person'
	// An unchanged display name stays as stored (RES-2): read into the Worker and bound again, a legacy value of lone
	// surrogate bytes would come back as three U+FFFD for each, past its bound.
	db.run(
		`UPDATE accounts SET display_name = COALESCE(?, display_name), note = COALESCE(?, note), locked = COALESCE(?, locked),
			discoverable = COALESCE(?, discoverable), actor_type = ?, search_text = ?
		WHERE id = ?`,
		changedName,
		changes.note === undefined ? null : plainTextToHtml(storedText(changes.note)),
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
			fields = COALESCE(?, fields), hide_collections = COALESCE(?, hide_collections),
			attribution_domains = COALESCE(?, attribution_domains),
			default_quote_policy = COALESCE(?, default_quote_policy)
		WHERE account_id = ?`,
		changes.privacy ?? null,
		bit(changes.sensitive),
		changes.language === undefined ? 0 : 1,
		changes.language ?? null,
		changes.fields === undefined ? null : JSON.stringify(changes.fields.slice(0, MAX_FIELDS)),
		hide,
		changes.attributionDomains === undefined ? null : JSON.stringify(changes.attributionDomains),
		changes.quotePolicy ?? null,
		accountId
	)
	// Every save takes the profile's local emoji again (custom-emojis.ts localEmojiSnapshot), from the stored display
	// name, note and fields, as Mastodon's Account#emojis reads them (app/models/account.rb:450-451, 486-488).
	const profile = db.first<{ display_name: string; note: string; fields: string }>(
		'SELECT a.display_name, a.note, l.fields FROM accounts a JOIN local_accounts l ON l.account_id = a.id WHERE a.id = ?',
		accountId
	)
	const texts =
		profile === undefined
			? []
			: [
					profile.display_name,
					profile.note,
					...fieldSources(profile.fields).flatMap((field) => [field.name, field.value]),
				]
	db.run('UPDATE accounts SET emojis = ? WHERE id = ?', localEmojiSnapshot(db, texts, ACCOUNT_EMOJIS_BYTES), accountId)
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
	endorsed: number
	note: string | null
}

// The viewer's relationships with each account, as they stand at `now` (an expired mute no longer counts), with the
// viewer's endorsement of it and the viewer's own private note on it (Account.endorsed_map and account_note_map), each
// read through its pair key.
export function relationshipsOf(db: Db, viewerId: string, accountIds: string[], now: number): Relationship[] {
	const rows = db.all<RelationshipRow>(
		`SELECT a.id,
			fo.state AS following, fo.show_reblogs, fo.notify, fo.languages,
			fb.state AS followed_by,
			${blocksSql('?1', 'a.id')} AS blocking,
			${blocksSql('a.id', '?1')} AS blocked_by,
			m.account_id IS NOT NULL AS muting, m.hide_notifications AS muting_notifications, m.expires_at AS muting_expires_at,
			${domainBlocksSql('?1', 'a.id')} AS domain_blocking,
			p.account_id IS NOT NULL AS endorsed, n.comment AS note
		FROM json_each(?2) j
		JOIN accounts a ON a.id = j.value
		LEFT JOIN follows fo ON fo.account_id = ?1 AND fo.target_account_id = a.id
		LEFT JOIN follows fb ON fb.account_id = a.id AND fb.target_account_id = ?1
		LEFT JOIN account_pins p ON p.account_id = ?1 AND p.target_account_id = a.id
		LEFT JOIN account_notes n ON n.account_id = ?1 AND n.target_account_id = a.id
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
		endorsed: row.endorsed === 1,
		note: row.note ?? '',
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
// MAX_FAMILIAR_FOLLOWERS are shown, newest follow of the account first, while the answer's accounts fit
// ANSWER_BYTES, shared among the requested accounts that have followers to show (sharedAnswer); past it,
// fewer are shown (Mastodon's answer has no paging).
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
		const entries = [...new Set(resolved)].flatMap((target) => {
			const row = db.first<{ hidden: number }>(
				`SELECT ${hidesCollectionsSql('?1')} AS hidden WHERE ${availableSql('?1')}`,
				target
			)
			if (row === undefined) {
				return []
			}
			if (row.hidden === 1) {
				return [{ id: target, followers: [] }]
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
			return [{ id: target, followers }]
		})
		// The answer's own JSON: brackets and each entry's id, keys and separator; accountStream counts each account's.
		const frame = entries.reduce((sum, entry) => sum + jsonBytes({ id: entry.id, accounts: [] }) + 1, 1)
		const shown = sharedAnswer(
			db,
			entries.map((entry) => entry.followers),
			present,
			ANSWER_BYTES - frame
		)
		return entries.map((entry, i) => ({ id: entry.id, accounts: shown[i] ?? [] }))
	}
)

// The presented accounts of each list, in order. Each round shares what is left of `budget` (serialized bytes)
// equally among lists with accounts left; unused shares go to the next round. So list order cannot change the answer,
// and large accounts cannot crowd others out. Profiles are read one at a time: at most one unshown account per list.
function sharedAnswer(db: Db, lists: readonly (readonly string[])[], present: Present, budget: number): Account[][] {
	const streams = lists.map((ids) => accountStream(db, ids, present, 1))
	const pending = streams.map((stream) => stream())
	const shown: Account[][] = lists.map(() => [])
	let left = budget
	for (;;) {
		const open = pending.flatMap((next, i) => (next === undefined ? [] : [i]))
		const share = Math.floor(left / Math.max(open.length, 1))
		let progress = false
		for (const i of open) {
			let allowance = share
			for (let next = pending[i]; next !== undefined && next.bytes <= allowance; next = pending[i]) {
				shown[i]!.push(next.account)
				allowance -= next.bytes
				left -= next.bytes
				pending[i] = streams[i]!()
				progress = true
			}
		}
		if (!progress) {
			return shown
		}
	}
}

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
// and not on a domain the viewer blocks. One answer within ANSWER_BYTES (RES-3): an offset endpoint, so a cut answer
// holds fewer accounts and a client advancing by the number received continues after them.
export const searchAccounts = userReadOperation<SearchInput, Account[]>(
	(db, input, viewer) =>
		presentAccountsWithin(db, findAccountIds(db, input, viewer.accountId), input.present, ARRAY_ANSWER_BYTES, true)
			.items
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

// The ids of the accounts the search finds, in its order.
export function findAccountIds(db: Db, input: SearchInput, viewerId: string): string[] {
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
	return db
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

export type FollowResult = RelationshipResult | { status: 'invalid'; errors: string[] }

// Mastodon's FollowLimitValidator, with its default MAX_FOLLOWS_THRESHOLD and MAX_FOLLOWS_RATIO: a local account may
// follow up to FOLLOW_LIMIT accounts, and past that up to FOLLOW_LIMIT_RATIO times its followers. Like Mastodon it
// counts accepted follows only (following_count), not pending requests.
export const FOLLOW_LIMIT = 7_500
export const FOLLOW_LIMIT_RATIO = 1.1

export function followLimit(counts: { following_count: number; followers_count: number }): number {
	return counts.following_count < FOLLOW_LIMIT
		? FOLLOW_LIMIT
		: Math.max(Math.round(counts.followers_count * FOLLOW_LIMIT_RATIO), FOLLOW_LIMIT)
}

// The validator's error for a new follow or request past the limit, or null while under it. It applies where Mastodon
// creates a Follow or FollowRequest without bypass_limit: the follow API only. Authorizing a request (local or a remote
// Accept) and a Move's follower transfer bypass it, as there. The following count is derived from the viewer's accepted
// follows (the partial index follows_accepted, the viewer's own rows only), not the cached following_count, so a stale
// cache cannot let a follow through; followers_count, for the ratio, is read from the row.
function followLimitError(db: Db, accountId: string): string | null {
	const counts = db.first<{ following_count: number; followers_count: number }>(
		`SELECT (SELECT COUNT(*) FROM follows WHERE account_id = ?1 AND state = 'accepted') AS following_count,
			followers_count
		FROM accounts WHERE id = ?1`,
		accountId
	)
	if (counts === undefined) {
		return null
	}
	const limit = followLimit(counts)
	return counts.following_count >= limit ? `You cannot follow more than ${limit} people` : null
}

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
// viewer forbids the follow. A new follow or request past the follow limit is refused (422); changing the options of
// an existing one is not, as the validator runs on create only.
export const follow = userWriteOperation<FollowInput, FollowResult>((db, input, { accountId: viewerId }) => {
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
		const limitError = followLimitError(db, viewerId)
		if (limitError !== null) {
			return { status: 'invalid', errors: [limitError] }
		}
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
function recountFollows(db: Db, viewerId: string, target: Pick<TargetRow, 'id' | 'domain'>): void {
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

// POST /api/v1/accounts/:id/note (Accounts::NotesController, AccountNote): the viewer's private note on any stored
// account, the viewer's own included. A blank comment (absent, empty or whitespace) deletes the note; a longer one than
// AccountNote::COMMENT_SIZE_LIMIT characters is refused with Rails' message, after the account is found. The note is
// kept as sent, and only its author is shown it (relationshipsOf).
export const MAX_NOTE_COMMENT = 2_000

export type NoteResult = RelationshipResult | { status: 'invalid'; errors: string[] }

export const setNote = userWriteOperation<{ target: string; comment: string | undefined; now: number }, NoteResult>(
	(db, { target, comment, now }, { accountId: viewerId }) => {
		const id = resolveAccountId(db, target)
		if (id === null) {
			return { status: 'not_found' }
		}
		// Ruby's String#blank?.
		if (comment === undefined || /^\s*$/u.test(comment)) {
			db.run('DELETE FROM account_notes WHERE account_id = ? AND target_account_id = ?', viewerId, id)
		} else if ([...comment].length > MAX_NOTE_COMMENT) {
			return { status: 'invalid', errors: [`Comment is too long (maximum is ${MAX_NOTE_COMMENT} characters)`] }
		} else {
			// An unchanged note is not written again (`@note.save! if @note.changed?`).
			db.run(
				`INSERT INTO account_notes (account_id, target_account_id, comment, created_at, updated_at)
				VALUES (?1, ?2, ?3, ?4, ?4)
				ON CONFLICT (account_id, target_account_id) DO UPDATE SET comment = excluded.comment,
					updated_at = excluded.updated_at
				WHERE comment IS NOT excluded.comment`,
				viewerId,
				id,
				comment,
				new Date(now).toISOString()
			)
		}
		return relationshipResult(db, viewerId, id, now)
	}
)

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

// A page of a list. `cut`: the read stopped at its candidate window (windows.ts) before the page filled, or an answer
// without a page stopped at ANSWER_BYTES, so the next link is offered however few items it holds.
export type Page<T> = { items: T[]; newest: string | null; oldest: string | null; cut?: boolean }

export type ListFollowsInput = {
	account: string
	direction: 'followers' | 'following'
	page: PageQuery
	present: Present
}

// The ids of a window of account ids (windows.ts) that `rule` (over `a`, the account row, and `l`, its local_accounts
// row) passes, each by its key, without their profiles.
export function windowAccountIds(db: Db, window: Window, rule: string): { id: string }[] {
	return window.candidates.length === 0
		? []
		: db.all<{ id: string }>(
				`SELECT a.id FROM json_each(?1) c CROSS JOIN accounts a ON a.id = json_extract(c.value, '$.id')
					LEFT JOIN local_accounts l ON l.account_id = a.id
				WHERE ${rule}`,
				windowJson(window)
			)
}

// The account rows of `ids`, in their order, each by its key: the profiles an answer presents, built for its own
// accounts only.
export function accountRowsOf(db: Db, ids: readonly string[]): AccountRow[] {
	if (ids.length === 0) {
		return []
	}
	const rows = new Map(
		db
			.all<AccountRow>(
				`SELECT ${selectSql(ACCOUNT_COLUMN_MAP)} FROM json_each(?1) c CROSS JOIN accounts a ON a.id = c.value
					LEFT JOIN local_accounts l ON l.account_id = a.id`,
				JSON.stringify(ids)
			)
			.map((row) => [row.id, row])
	)
	return ids.flatMap((id) => rows.get(id) ?? [])
}

// A page of accounts (the rows of a window's page, newest first, each by its cursor `key`), their profiles read for
// the page only (RES-2; candidate windows read ids alone), within ANSWER_BYTES (RES-3): admitted in traversal order,
// a page cut there continues from its last admitted account (admittedPage).
export function accountPage<R extends { id: string }>(
	db: Db,
	page: { rows: readonly R[]; newest: string | null; oldest: string | null; cut?: boolean },
	ascending: boolean,
	key: (row: R) => string,
	present: Present
): Page<Account> {
	return admittedPage(page, ascending, key, (traversal) =>
		admitAccounts(
			db,
			traversal.map((row) => row.id),
			present,
			ARRAY_ANSWER_BYTES,
			true
		)
	)
}

// GET /api/v1/accounts/:id/followers and /following as the viewer (null: anonymous) may see them (R13, Mastodon's
// FollowerAccountsController and FollowingAccountsController): accepted follows, newest first. Nothing is listed when
// the account is suspended, or, to anyone but itself, when it hides its network or blocks the viewer
// (followListsShownSql). Others do not see the accounts they block, mute or are blocked by (followListedSql). A page
// reads a window of readWindow(limit) of the account's follows from the cursor (windows.ts), then applies the rule to
// those; a follower that blocks the viewer is never a candidate (docs/visibility.md "Read bounds"), so its follow
// supplies no cursor. Followers read follows_target, following follows_following (migration 0043), both in id order.
// An unknown account is not found.
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
		const ascending = page.minId !== undefined
		const size = readWindow(page.limit)
		const window = singleWindow(
			db,
			`SELECT CAST(f.id AS TEXT) AS id FROM follows f
			WHERE f.${anchor} = ?1 AND f.state = 'accepted' AND ${edgeRangeSql('f.id', '?2', '?3')}
				AND (?5 IS NULL OR ?5 IS ?1 OR NOT ${blocksSql(`f.${other}`, '?5')})
			ORDER BY f.id ${ascending ? 'ASC' : 'DESC'} LIMIT ?4`,
			size,
			id,
			page.maxId ?? null,
			page.minId ?? page.sinceId ?? null,
			size,
			viewerId
		)
		const rows =
			window.candidates.length === 0
				? []
				: db.all<{ cursor: string; id: string }>(
						`SELECT CAST(f.id AS TEXT) AS cursor, a.id
						FROM json_each(?4) c CROSS JOIN follows f ON f.id = CAST(json_extract(c.value, '$.id') AS INTEGER)
							JOIN accounts a ON a.id = f.${other}
						WHERE ${followListedSql('a.id', '?1', '?2', '?3')}`,
						id,
						viewerId,
						now,
						windowJson(window)
					)
		const shown = windowPage(window, rows, (row) => row.cursor, page.limit, ascending)
		return accountPage(db, shown, ascending, (row) => row.cursor, present)
	}
)

// Follow requests to the viewer (Mastodon's FollowRequestsController and AuthorizeFollowService/RejectFollowService).
// Only the followed account decides (VIS-9): the viewer is the target, from the credential, never from the request.
// An unavailable requester (R1) is left out, as Mastodon lists Account.without_suspended, and listed again once it is
// available. A page reads a window of readWindow(limit) of the viewer's requests from the cursor (follows_target, in
// id order; windows.ts), then applies the rule to those (docs/visibility.md "Read bounds").
export const listFollowRequests = userReadOperation<{ page: PageQuery; present: Present }, Page<Account>>(
	(db, { page, present }, { accountId: viewerId }) => {
		const ascending = page.minId !== undefined
		const size = readWindow(page.limit)
		const window = singleWindow(
			db,
			`SELECT CAST(f.id AS TEXT) AS id FROM follows f
			WHERE f.target_account_id = ?1 AND f.state = 'pending' AND ${edgeRangeSql('f.id', '?2', '?3')}
			ORDER BY f.id ${ascending ? 'ASC' : 'DESC'} LIMIT ?4`,
			size,
			viewerId,
			page.maxId ?? null,
			page.minId ?? page.sinceId ?? null,
			size
		)
		const rows =
			window.candidates.length === 0
				? []
				: db.all<{ cursor: string; id: string }>(
						`SELECT CAST(f.id AS TEXT) AS cursor, a.id
						FROM json_each(?1) c CROSS JOIN follows f ON f.id = CAST(json_extract(c.value, '$.id') AS INTEGER)
							JOIN accounts a ON a.id = f.account_id LEFT JOIN local_accounts l ON l.account_id = a.id
						WHERE ${availableJoinedSql('a', 'l')}`,
						windowJson(window)
					)
		const shown = windowPage(window, rows, (row) => row.cursor, page.limit, ascending)
		return accountPage(db, shown, ascending, (row) => row.cursor, present)
	}
)

// Authorizes or rejects a pending follow of the viewer. A remote requester gets the Accept or Reject at its personal
// inbox, named after its Follow (followAnswerActivity). The follow_request notification goes either way. An
// unavailable requester (R1, R38) is not found, read in this transaction: a request authorized after its requester's
// suspension would leave a follower its suspension never severed.
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
					WHERE f.account_id = ?1 AND f.target_account_id = ?2 AND f.state = 'pending' AND ${availableSql('?1')}`,
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
	// The viewer's followers changed; an authorized local requester also follows one more account now.
	if (decision === 'authorize' && request.remote === 0) {
		recountFollows(db, requesterId, { id: viewerId, domain: null })
	} else {
		db.run(
			`UPDATE accounts SET followers_count =
				(SELECT COUNT(*) FROM follows WHERE target_account_id = ?1 AND state = 'accepted') WHERE id = ?1`,
			viewerId
		)
	}
	return relationshipResult(db, viewerId, requesterId, now)
})
