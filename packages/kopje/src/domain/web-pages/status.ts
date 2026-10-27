import type { Present } from '../accounts'
import { itemBytes } from '../answer-budget'
import { statusReads } from '../audience'
import { contextOf } from '../auth'
import { readOperation } from '../operation'
import { presentation, presentStatus, type Status, statusStream } from '../status-presenter'
import { contextAncestors, resolveStatusId } from '../statuses'
import { statusRepliesWithin } from '../timelines'
import {
	admitMandatory,
	admitStrict,
	charge,
	LONGEST_STATUS_STUB,
	pageBudget,
	type StatusStub,
	statusList,
	WEB_PAGE_BYTES,
} from './budget'
import { LONGEST_PAGING, type PageCursor, type Paging, pagingOf } from './paging'
import { type ParentLink, parentLink } from './parents'
import { anonymous, localUsername, pageRead, type Site } from './site'
import type { Db } from '../../db/sql'
import { httpUrl } from '../../platform/http-url'

export const REPLIES_PAGE_SIZE = 20

// What the page shows beside the status: its Replies tab at the request's cursor (design §3), or nothing (the embed,
// and the ActivityPub form of the status page, which forwards to the object endpoint).
export type StatusTab = { kind: 'replies'; cursor: PageCursor }

export type StatusInput = { handle: string; id: string; now: number; tab: StatusTab | null }

// The status's thread (design §2): its ancestors an anonymous viewer may see, oldest first; its direct replies on the
// tab's page, oldest first, or, when the first did not fit, none and its stub; and the page's paging facts, `newest`
// and `oldest` by status id whatever the direction the page was read in.
export type Thread = { ancestors: Status[]; replies: Status[]; stub: StatusStub | null; paging: Paging }

export type StatusPage =
	| { status: 'ok'; value: Status; parent: ParentLink | null; thread: Thread | null }
	| { status: 'moved'; username: string; id: string }
	| { status: 'not_found' }

// A local status by the path's handle and id (an API id, or a legacy id, which moves to the API id): the status page
// and the embed (design §2: embed mode shows the status, its parent link and quote, and nothing else). VIS-4: only a
// public or unlisted original of a local account that is not suspended; anything else, of another author, a boost, a
// remote status or no status at all, is the same not_found. The parent is linked only when the anonymous viewer may
// see it (VIS-12). The status and its parent link are the page's head (budget.ts); with a tab, its thread follows.
export const webStatusPage = pageRead<StatusInput, StatusPage>((db, input, site) =>
	statusPageWithin(db, input, site, WEB_PAGE_BYTES)
)

// The read, within `answerBytes` (tests pass less to reach the stub at a small size).
export function statusPageWithin(db: Db, input: StatusInput, site: Site, answerBytes: number): StatusPage {
	const { handle, id, now, tab } = input
	const username = localUsername(handle, site.domain)
	if (username === null || username === '') {
		return { status: 'not_found' }
	}
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
	const options = anonymous(site, now)
	const status = presentStatus(db, row.id, options)
	if (status === null) {
		return { status: 'not_found' }
	}
	// The head of the page's budget; the status page's later parts (design §2) take what it leaves.
	const budget = pageBudget(
		{
			status: 'ok',
			value: null,
			parent: null,
			thread: tab === null ? null : EMPTY_THREAD,
			site,
		} satisfies Omit<Extract<StatusPage, { status: 'ok' }>, 'value'> & { value: null; site: Site },
		answerBytes
	)
	admitMandatory(budget, status)
	const parent = parentLink(db, row.in_reply_to_id)
	admitMandatory(budget, parent)
	if (tab === null) {
		return { status: 'ok', value: status, parent, thread: null }
	}
	// The thread in design §2's order: the first reply (or its stub), then the ancestors, nearest first, within half of
	// what is left, then the rest of the replies, strictly; the ancestors past the first that does not fit are left
	// out, the farthest first, so the list keeps its room. The replies need no parent links (their parent is the page's
	// status), nor do the ancestors (each one's is the one before it, or a status the thread does not show). Each
	// ancestor and reply links to its own page, or to its origin, where the thread goes on.
	const up = contextAncestors(db, options.viewer, row.id).toReversed()
	const near = statusStream(db, presentation(db, up, options), up)
	let ancestors: Status[] | null = null
	const admitAncestors = () => {
		if (ancestors === null) {
			const share = { remaining: Math.floor(Math.max(0, budget.remaining) / 2), ceiling: budget.ceiling }
			const admitted = admitStrict(share, near)
			charge(budget, admitted.bytes)
			ancestors = admitted.items
		}
		return ancestors
	}
	const list = statusList(budget, { size: itemBytes, afterHead: admitAncestors })
	const read = statusRepliesWithin(
		db,
		{ id: row.id, page: { limit: REPLIES_PAGE_SIZE, ...(tab.cursor ?? {}) }, present: options },
		options.viewer,
		list.admission
	)
	return {
		status: 'ok',
		value: status,
		parent,
		thread: {
			ancestors: admitAncestors().toReversed(),
			replies: read.page.items.toReversed(),
			stub: list.stub(),
			paging: pagingOf({ newest: read.page.newest, oldest: read.page.oldest, more: read.more }),
		},
	}
}

// The longest empty thread: what a status page's frame reserves for it.
const EMPTY_THREAD: Thread = { ancestors: [], replies: [], stub: LONGEST_STATUS_STUB, paging: LONGEST_PAGING }

// VIS-4's read of the status page: the status by id under the local account the path names, or by its object URI
// (/ap/o/<uuid>, which names no account), if an anonymous viewer may see it and it is not a boost. The embed and
// /authorize_interaction's local permalinks (domain/interaction.ts) reach it through targetStatus.
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
		const row = targetStatus(db, target)
		const status = row === undefined ? null : presentStatus(db, row.id, { ...present, viewer: contextOf(null, now) })
		return status === null ? { status: 'not_found' } : { status: 'ok', value: status, domain }
	}
)

// The status a parsed URL (statusTarget) names, its API or legacy id resolved, if the status page shows it.
export function targetStatus(db: Db, target: { id: string; username: string } | { uri: string }) {
	if ('uri' in target) {
		return pageStatus(db, target)
	}
	const id = resolveStatusId(db, target.id)
	return id === null ? undefined : pageStatus(db, { id, username: target.username })
}

const STATUS_PATH = /^\/(@[^/]+)\/([^/]+)\/?$/
const OBJECT_PATH = /^\/ap\/o\/([^/]+)\/?$/

// Where an http(s) URL of this instance's host points: a status page (Mastodon's StatusFinder: a local URL routed to
// StatusesController#show), or an object URI. Null for anything else.
export function statusTarget(url: string, domain: string): { id: string; username: string } | { uri: string } | null {
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
