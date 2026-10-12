import { type Account, ACCOUNT_COLUMNS, ACCOUNT_FROM, type AccountRow, type Present, presentAccount } from './accounts'
import { canView, visibleSql } from './audience'
import { readOperation } from './operation'
import { presentStatus, presentStatuses, type Status } from './status-presenter'
import { resolveStatusId } from './statuses'
import { NOT_A_REPLY_TO_OTHERS } from './timelines'

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
// signed-out visitor (public and unlisted, replies to others and boosts left out). `maxId` pages older posts.
export const profilePage = readOperation<{ username: string; maxId: string | null; present: Present }, ProfilePage>(
	(db, { username, maxId, present }) => {
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
		const ids = db
			.all<{ id: string }>(
				`SELECT s.id FROM statuses s
				WHERE s.account_id = ?2 AND s.reblog_of_id IS NULL AND ${visibleSql('s', '?1')} AND ${NOT_A_REPLY_TO_OTHERS}
					AND (?3 IS NULL OR s.id < ?3)
				ORDER BY s.id DESC LIMIT ?4`,
				null,
				row.id,
				maxId !== null && STATUS_ID.test(maxId) ? maxId : null,
				PROFILE_PAGE_SIZE + 1
			)
			.map((status) => status.id)
		const next = ids.length > PROFILE_PAGE_SIZE ? (ids[PROFILE_PAGE_SIZE - 1] ?? null) : null
		return {
			status: 'ok',
			account: presentAccount(row, present),
			statuses: presentStatuses(db, ids.slice(0, PROFILE_PAGE_SIZE), { ...present, viewerId: null }),
			next,
		}
	}
)

export type ParentLink = { url: string; acct: string }

export type StatusPage =
	| { status: 'ok'; value: Status; parent: ParentLink | null }
	| { status: 'moved'; username: string; id: string }
	| { status: 'not_found' }

// A local status by the path's username and id (an API id, or a legacy id, which moves to the API id). VIS-4: only a
// public or unlisted original of a local account that is not suspended; anything else, of another author, a boost, a
// remote status or no status at all, is the same not_found. The parent is linked only when the anonymous viewer may
// see it (VIS-12).
export const statusPage = readOperation<{ username: string; id: string; present: Present }, StatusPage>(
	(db, { username, id, present }) => {
		const resolved = resolveStatusId(db, id)
		if (resolved === null) {
			return { status: 'not_found' }
		}
		const row = db.first<{ in_reply_to_id: string | null; username: string }>(
			`SELECT s.in_reply_to_id, au.username FROM statuses s JOIN accounts au ON au.id = s.account_id
			WHERE s.id = ?2 AND au.domain IS NULL AND lower(au.username) = lower(?3) AND s.reblog_of_id IS NULL
				AND ${visibleSql('s', '?1')}`,
			null,
			resolved,
			username
		)
		if (row === undefined) {
			return { status: 'not_found' }
		}
		if (resolved !== id) {
			return { status: 'moved', username: row.username, id: resolved }
		}
		const status = presentStatus(db, resolved, { ...present, viewerId: null })
		if (status === null) {
			return { status: 'not_found' }
		}
		const parentId = row.in_reply_to_id
		const parent =
			parentId !== null && canView(db, null, parentId)
				? presentStatus(db, parentId, { ...present, viewerId: null })
				: null
		return {
			status: 'ok',
			value: status,
			parent: parent === null ? null : { url: parent.url ?? parent.uri, acct: parent.account.acct },
		}
	}
)
