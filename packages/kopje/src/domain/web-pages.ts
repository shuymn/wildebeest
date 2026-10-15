import { type Account, ACCOUNT_COLUMNS, ACCOUNT_FROM, type AccountRow, type Present, presentAccount } from './accounts'
import { NOT_A_REPLY_TO_OTHERS, statusReads, viewableStatusId } from './audience'
import { readOperation } from './operation'
import { presentStatus, presentStatuses, type Status } from './status-presenter'
import { isHashtagName } from './status-text'
import { resolveStatusId } from './statuses'
import { normalizeTag } from './tag-name'

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
	const read = statusReads(null, { viewer: '?1' })
	const ids = read
		.select(
			db,
			'visible',
			{
				where: 's.account_id = ?2 AND s.reblog_of_id IS NULL',
				and: `${NOT_A_REPLY_TO_OTHERS} AND (?3 IS NULL OR s.id < ?3)${
					tag === null ? '' : ' AND EXISTS (SELECT 1 FROM status_tags t WHERE t.status_id = s.id AND t.name = ?5)'
				}`,
				tail: 'ORDER BY s.id DESC LIMIT ?4',
			},
			null,
			row.id,
			maxId !== null && STATUS_ID.test(maxId) ? maxId : null,
			PROFILE_PAGE_SIZE + 1,
			...(tag === null ? [] : [normalizeTag(tag)])
		)
		.map((status) => status.id)
	const next = ids.length > PROFILE_PAGE_SIZE ? (ids[PROFILE_PAGE_SIZE - 1] ?? null) : null
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
		const read = statusReads(null, { viewer: '?1' })
		const row = read.select<{ in_reply_to_id: string | null; username: string }>(
			db,
			'visible',
			{
				join: 'JOIN accounts au ON au.id = s.account_id',
				where: 's.id = ?2 AND au.domain IS NULL AND lower(au.username) = lower(?3) AND s.reblog_of_id IS NULL',
				columns: { in_reply_to_id: 's.in_reply_to_id', username: 'au.username' },
			},
			null,
			resolved,
			username
		)[0]
		if (row === undefined) {
			return { status: 'not_found' }
		}
		if (resolved !== id) {
			return { status: 'moved', username: row.username, id: resolved }
		}
		const status = presentStatus(db, row.id, {
			...present,
			viewer: { accountId: null, now: new Date(now).toISOString() },
		})
		if (status === null) {
			return { status: 'not_found' }
		}
		const parentId = row.in_reply_to_id === null ? null : viewableStatusId(db, null, row.in_reply_to_id)
		const parent =
			parentId === null
				? null
				: presentStatus(db, parentId, { ...present, viewer: { accountId: null, now: new Date(now).toISOString() } })
		return {
			status: 'ok',
			value: status,
			parent: parent === null ? null : { url: parent.url ?? parent.uri, acct: parent.account.acct },
		}
	}
)
