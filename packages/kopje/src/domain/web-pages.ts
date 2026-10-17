import { type Account, ACCOUNT_COLUMNS, ACCOUNT_FROM, type AccountRow, type Present, presentAccount } from './accounts'
import { NOT_A_REPLY_TO_OTHERS, statusReads, viewableStatusId } from './audience'
import { readOperation } from './operation'
import { presentStatus, presentStatuses, type Status } from './status-presenter'
import { isHashtagName } from './status-text'
import { resolveStatusId } from './statuses'
import { normalizeTag } from './tag-name'
import { readWindow, singleWindow, windowJson, windowPage } from './windows'
import type { Db } from '../db/sql'
import { httpUrl } from '../platform/http-url'

// What the public web pages show (B5): a local profile and a local status, to an anonymous viewer. Both go through the
// read rule with no viewer (visibleSql with NULL, VIS-1), so only public and unlisted statuses of an account that is
// not suspended appear, the same set the object endpoint serves (VIS-4).

export const PROFILE_PAGE_SIZE = 20

const STATUS_ID = /^\d{18}$/

export type ProfilePage =
	| { status: 'ok'; account: Account; statuses: Status[]; next: string | null }
	| { status: 'not_found' }
	| { status: 'suspended' }

// A local account's page: its profile and its own posts, newest first, as Mastodon's "Posts" tab shows them to a
// signed-out visitor (public and unlisted, replies to others and boosts left out). `maxId` pages older posts. With
// `tag` (a featured hashtag's URL, /@username/tagged/:tag), only the posts with that hashtag: the account's own posts are
// read from the cursor as without it, each checked for the hashtag by its key, so the read follows the account's own
// posts, never other accounts' posts with the hashtag; a name that is not a hashtag is not found.
export const profilePage = readOperation<
	{ username: string; maxId: string | null; tag?: string | null; present: Present; now: number },
	ProfilePage
>((db, { username, maxId, tag = null, present, now }) => {
	if (tag !== null && !isHashtagName(tag)) {
		return { status: 'not_found' }
	}
	const row = db.first<AccountRow>(
		`SELECT ${ACCOUNT_COLUMNS} FROM ${ACCOUNT_FROM} WHERE a.domain IS NULL AND lower(a.username) = lower(?)`,
		username
	)
	if (row === undefined) {
		return { status: 'not_found' }
	}
	if (row.suspended_at !== null) {
		return { status: 'suspended' }
	}
	// A window of the account's own posts from the cursor (statuses_account, windows.ts), then the rule over those: its
	// private and direct posts cost a window, not their number. One more than a page tells whether more follow.
	const size = readWindow(PROFILE_PAGE_SIZE + 1)
	const window = singleWindow(
		db,
		`SELECT s.id FROM statuses s WHERE s.account_id = ?1 AND s.reblog_of_id IS NULL AND ${NOT_A_REPLY_TO_OTHERS}
			AND (?2 IS NULL OR s.id < ?2)
			${tag === null ? '' : 'AND EXISTS (SELECT 1 FROM status_tags t WHERE t.status_id = s.id AND t.name = ?4)'}
		ORDER BY s.id DESC LIMIT ?3`,
		size,
		row.id,
		maxId !== null && STATUS_ID.test(maxId) ? maxId : null,
		size,
		...(tag === null ? [] : [normalizeTag(tag)])
	)
	const passed =
		window.candidates.length === 0
			? []
			: statusReads(null, { viewer: '?1' }).select(
					db,
					'visible',
					{ from: 'json_each(?2) c CROSS JOIN', join: "ON s.id = json_extract(c.value, '$.id')" },
					null,
					windowJson(window)
				)
	const shown = windowPage(window, passed, (status) => status.id, PROFILE_PAGE_SIZE + 1, false)
	const ids = shown.rows.map((status) => status.id)
	const next = ids.length > PROFILE_PAGE_SIZE ? (ids[PROFILE_PAGE_SIZE - 1] ?? null) : shown.cut ? shown.oldest : null
	return {
		status: 'ok',
		account: presentAccount(row, present),
		statuses: presentStatuses(db, ids.slice(0, PROFILE_PAGE_SIZE), {
			...present,
			viewer: { accountId: null, now: new Date(now).toISOString() },
		}),
		next,
	}
})

export type ParentLink = { url: string; acct: string }

export type StatusPage =
	| { status: 'ok'; value: Status; parent: ParentLink | null }
	| { status: 'moved'; username: string; id: string }
	| { status: 'not_found' }

// A local status by the path's username and id (an API id, or a legacy id, which moves to the API id). VIS-4: only a
// public or unlisted original of a local account that is not suspended; anything else, of another author, a boost, a
// remote status or no status at all, is the same not_found. The parent is linked only when the anonymous viewer may
// see it (VIS-12).
export const statusPage = readOperation<{ username: string; id: string; present: Present; now: number }, StatusPage>(
	(db, { username, id, present, now }) => {
		const resolved = resolveStatusId(db, id)
		if (resolved === null) {
			return { status: 'not_found' }
		}
		const row = pageStatus(db, { id: resolved, username })
		if (row === undefined) {
			return { status: 'not_found' }
		}
		if (resolved !== id) {
			return { status: 'moved', username: row.username, id: resolved }
		}
		const status = presentStatus(db, row.id, anonymous(present, now))
		if (status === null) {
			return { status: 'not_found' }
		}
		const parentId = row.in_reply_to_id === null ? null : viewableStatusId(db, null, row.in_reply_to_id)
		const parent = parentId === null ? null : presentStatus(db, parentId, anonymous(present, now))
		return {
			status: 'ok',
			value: status,
			parent: parent === null ? null : { url: parent.url ?? parent.uri, acct: parent.account.acct },
		}
	}
)

function anonymous(present: Present, now: number) {
	return { ...present, viewer: { accountId: null, now: new Date(now).toISOString() } }
}

// VIS-4's read of the status page: the status by id under the local account the path names, or by its object URI
// (/ap/o/<uuid>, which names no account), if an anonymous viewer may see it and it is not a boost.
function pageStatus(db: Db, by: { id: string; username: string } | { uri: string }) {
	const read = statusReads(null, { viewer: '?1' })
	const byId = 'id' in by
	return read.select<{ in_reply_to_id: string | null; username: string }>(
		db,
		'visible',
		{
			join: 'JOIN accounts au ON au.id = s.account_id',
			where: `${byId ? 's.id = ?2 AND lower(au.username) = lower(?3)' : 's.uri = ?2'} AND au.domain IS NULL AND s.reblog_of_id IS NULL`,
			columns: { in_reply_to_id: 's.in_reply_to_id', username: 'au.username' },
		},
		null,
		...(byId ? [by.id, by.username] : [by.uri])
	)[0]
}

// `/@alice` or `/@alice@this.domain`; null for another server's account (only local profiles are served).
export function localUsername(handle: string, domain: string): string | null {
	const name = handle.replace(/^@/, '')
	const at = name.indexOf('@')
	if (at === -1) {
		return name
	}
	return name.slice(at + 1).toLowerCase() === domain ? name.slice(0, at) : null
}

export type EmbeddedStatus = { status: 'ok'; value: Status; domain: string } | { status: 'not_found' }

// The status a URL of this instance names, if it may be embedded: exactly when its status page shows it (VIS-4), as
// Mastodon embeds a status unless it is hidden? (private, direct or limited). The URL forms are the status page's,
// /@username/:id (an API id or a legacy id), and the object URI, /ap/o/<uuid> (Mastodon's StatusFinder takes its
// /users/:username/statuses/:id); anything else is not found.
export const embeddedStatus = readOperation<{ url: string; present: Present; now: number }, EmbeddedStatus>(
	(db, { url, present, now }) => {
		const domain = db.first<{ value: string }>("SELECT value FROM instance_settings WHERE name = 'domain'")?.value
		const target = domain === undefined ? null : statusTarget(url, domain)
		if (domain === undefined || target === null) {
			return { status: 'not_found' }
		}
		let by: { id: string; username: string } | { uri: string } = target
		if ('id' in target) {
			const resolved = resolveStatusId(db, target.id)
			if (resolved === null) {
				return { status: 'not_found' }
			}
			by = { id: resolved, username: target.username }
		}
		const row = pageStatus(db, by)
		const status = row === undefined ? null : presentStatus(db, row.id, anonymous(present, now))
		return status === null ? { status: 'not_found' } : { status: 'ok', value: status, domain }
	}
)

const STATUS_PATH = /^\/(@[^/]+)\/([^/]+)\/?$/
const OBJECT_PATH = /^\/ap\/o\/([^/]+)\/?$/

// Where an http(s) URL of this instance's host points: a status page (Mastodon's StatusFinder: a local URL routed to
// StatusesController#show), or an object URI. Null for anything else.
function statusTarget(url: string, domain: string): { id: string; username: string } | { uri: string } | null {
	const parsed = httpUrl(url)
	if (parsed === null || parsed.host !== domain.toLowerCase()) {
		return null
	}
	const object = OBJECT_PATH.exec(parsed.pathname)
	if (object !== null) {
		return { uri: `https://${domain}/ap/o/${object[1] ?? ''}` }
	}
	const page = STATUS_PATH.exec(parsed.pathname)
	if (page === null) {
		return null
	}
	try {
		const username = localUsername(decodeURIComponent(page[1] ?? ''), domain)
		const id = decodeURIComponent(page[2] ?? '')
		return username === null || username === '' ? null : { id, username }
	} catch {
		return null
	}
}
