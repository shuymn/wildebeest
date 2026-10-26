import { type Account, accountByAddress, ACCOUNT_FROM, presentAccountById } from '../accounts'
import { ANSWER_BYTES } from '../answer-budget'
import { availableJoinedSql } from '../audience'
import type { Status } from '../status-presenter'
import { isHashtagName } from '../status-text'
import { accountStatusesWithin } from '../timelines'
import { admitMandatory, LONGEST_STATUS_STUB, pageBudget, type StatusStub, statusList } from './budget'
import { listParents, type ParentLink } from './parents'
import { anonymous, localUsername, pagePresent, pageRead, type Site } from './site'
import type { Db } from '../../db/sql'
import { normalizeDomain } from '../../platform/domain-name'

export const PROFILE_PAGE_SIZE = 20

// A status id cursor of a page URL (design §4); anything else (null) serves the first page.
export function pageCursor(value: string | null | undefined): string | null {
	return value !== undefined && value !== null && /^\d{1,19}$/.test(value) ? value : null
}

export type ProfileInput = { handle: string; maxId: string | null; tag: string | null; now: number }

export type ProfilePage =
	| {
			status: 'ok'
			account: Account
			// The posts newest first; when the first did not fit beside the account, none, and its stub (design §2).
			statuses: Status[]
			stub: StatusStub | null
			parents: Record<string, ParentLink>
			// The older page's max_id, when one follows.
			next: string | null
	  }
	| { status: 'not_found' }
	| { status: 'suspended' }
	// A remote account's featured hashtag URL: its profile on its own server.
	| { status: 'redirect'; location: string }

// A local account's page as Mastodon's "Posts" tab shows it to a signed-out visitor: its own public and unlisted posts,
// newest first, replies to others and boosts left out (accountStatuses with exclude_replies and exclude_reblogs, as an
// anonymous viewer). `maxId` pages older posts. With `tag` (a featured hashtag's URL, /@username/tagged/:tag), only
// the posts with that hashtag; a name that is not a hashtag is not found. A suspended account is gone (410).
export const webProfilePage = pageRead<ProfileInput, ProfilePage>((db, input, site) =>
	profilePageWithin(db, input, site, ANSWER_BYTES)
)

// The read, within `answerBytes` (tests pass less to reach the stub at a small size).
export function profilePageWithin(db: Db, input: ProfileInput, site: Site, answerBytes: number): ProfilePage {
	const { handle, tag, now } = input
	const maxId = pageCursor(input.maxId)
	const username = localUsername(handle, site.domain)
	if (username === null) {
		return tag === null ? { status: 'not_found' } : remoteTagged(db, handle, site)
	}
	if (username === '' || (tag !== null && !isHashtagName(tag))) {
		return { status: 'not_found' }
	}
	const row = db.first<{ id: string; available: number }>(
		`SELECT a.id, ${availableJoinedSql('a', 'l')} AS available FROM ${ACCOUNT_FROM}
		WHERE a.domain IS NULL AND lower(a.username) = lower(?)`,
		username
	)
	if (row === undefined) {
		return { status: 'not_found' }
	}
	if (row.available === 0) {
		return { status: 'suspended' }
	}
	const options = anonymous(site, now)
	const account = presentAccountById(db, row.id, pagePresent(site))
	if (account === undefined) {
		return { status: 'not_found' }
	}
	const budget = pageBudget(
		{
			status: 'ok',
			account: null,
			statuses: [],
			stub: LONGEST_STATUS_STUB,
			parents: {},
			next: '9'.repeat(19),
			site,
		} satisfies Omit<Extract<ProfilePage, { status: 'ok' }>, 'account'> & { account: null; site: Site },
		answerBytes
	)
	admitMandatory(budget, account)
	const list = statusList(budget)
	const read = accountStatusesWithin(
		db,
		{
			account: row.id,
			page: {
				limit: PROFILE_PAGE_SIZE,
				...(maxId === null ? {} : { maxId }),
			},
			onlyMedia: false,
			excludeReplies: true,
			excludeReblogs: true,
			pinned: false,
			tagged: tag,
			present: pagePresent(site),
		},
		options.viewer,
		list.admission
	)
	const statuses = read?.page.items ?? []
	return {
		status: 'ok',
		account,
		statuses,
		stub: list.stub(),
		parents: listParents(db, budget, statuses),
		next: read?.more === true ? read.page.oldest : null,
	}
}

// /@username@domain/tagged/:tag of a remote account (featured-tags.ts taggedUrl): its profile on its own server, while
// it is available; Kopje shows no remote account's posts by hashtag.
function remoteTagged(db: Db, handle: string, site: Site): ProfilePage {
	const [username = '', domain = '', ...rest] = handle.replace(/^@/, '').split('@')
	if (username === '' || domain === '' || rest.length > 0) {
		return { status: 'not_found' }
	}
	const account = accountByAddress(db, username, normalizeDomain(domain) ?? domain.toLowerCase(), pagePresent(site))
	if (account === null || account.suspended === true || account.acct === account.username) {
		return { status: 'not_found' }
	}
	return { status: 'redirect', location: account.url }
}
