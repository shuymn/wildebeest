import { type Account, listFollowsWithin, presentAccountById } from '../accounts'
import { admitMandatory, admitStrict, pageBudget, WEB_PAGE_BYTES } from './budget'
import { type PageCursor, type Paging, LONGEST_PAGING, pagingOf } from './paging'
import { localPageAccount } from './profile'
import { anonymous, localUsername, pagePresent, pageRead, type Site } from './site'
import type { Db } from '../../db/sql'

// The follows a page lists at a time (design §2): Mastodon's web client asks for 40.
export const FOLLOWS_PAGE_SIZE = 40

export type FollowDirection = 'followers' | 'following'

export type FollowsInput = { handle: string; direction: FollowDirection; cursor: PageCursor; now: number }

export type FollowsPage =
	| {
			status: 'ok'
			account: Account
			// The account hides its network (R13): the page shows its counts and no list.
			hidden: boolean
			// The members, newest follow first.
			accounts: Account[]
			paging: Paging
	  }
	| { status: 'not_found' }
	| { status: 'suspended' }

// /@username/followers and /@username/following of a local account, as an anonymous viewer reads them (VIS-4, VIS-8,
// R13): its accepted follows, newest first, paged both ways by follow id, of the members that are available (an
// unavailable one, which the API lists redacted, is left out); nothing but the account when it hides its network. A
// suspended account is gone (410), and another server's account is not found.
export const webFollowsPage = pageRead<FollowsInput, FollowsPage>((db, input, site) =>
	followsPageWithin(db, input, site, WEB_PAGE_BYTES)
)

// The read, within `answerBytes` (WEB_PAGE_BYTES; tests pass less to cut pages by bytes). Admission is strict: the
// frame, the account and one member, each at the account maximum ("Maxima of presented units"), fit WEB_PAGE_BYTES
// (test/web-follow-lists.test.ts), so every page admits its first member, and a page cut by bytes continues from its
// last.
export function followsPageWithin(db: Db, input: FollowsInput, site: Site, answerBytes: number): FollowsPage {
	const { handle, direction, cursor, now } = input
	const username = localUsername(handle, site.domain)
	if (username === null || username === '') {
		return { status: 'not_found' }
	}
	const row = localPageAccount(db, username)
	if ('status' in row) {
		return row
	}
	const account = presentAccountById(db, row.id, pagePresent(site))
	if (account === undefined) {
		return { status: 'not_found' }
	}
	const budget = pageBudget(
		{
			status: 'ok',
			account: null,
			hidden: true,
			accounts: [],
			paging: LONGEST_PAGING,
			site,
		} satisfies Omit<Extract<FollowsPage, { status: 'ok' }>, 'account'> & { account: null; site: Site },
		answerBytes
	)
	admitMandatory(budget, account)
	const list = listFollowsWithin(
		db,
		{ account: row.id, direction, page: { limit: FOLLOWS_PAGE_SIZE, ...(cursor ?? {}) }, present: pagePresent(site) },
		anonymous(site, now).viewer,
		(entries) => admitStrict(budget, entries),
		'available'
	)
	return {
		status: 'ok',
		account,
		hidden: list?.shown === false,
		accounts: list?.page.items ?? [],
		paging: pagingOf(list === null ? null : { newest: list.page.newest, oldest: list.page.oldest, more: list.more }),
	}
}
