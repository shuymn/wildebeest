import type { Present } from '../accounts'
import { statusReads } from '../audience'
import { contextOf } from '../auth'
import { readOperation } from '../operation'
import { presentStatus, type Status } from '../status-presenter'
import { type EditVersion, editVersions, resolveStatusId } from '../statuses'
import { admitMandatory, admitStrict, charge, pageBudget, type PageBudget } from './budget'
import { type ParentLink, parentLink } from './parents'
import { anonymous, localUsername, pageRead } from './site'
import type { Db } from '../../db/sql'
import { httpUrl } from '../../platform/http-url'

// `embed`: the embed's read, which holds the status, its parent link and quote, and nothing else (design §2).
export type StatusInput = { handle: string; id: string; now: number; embed?: boolean }

// A status's edit history on its page (design §2, §8 "Edit history"): its recorded versions newest first, as many as
// fit its share whole, and how many older ones were left out. Null when the status has no recorded versions (never
// edited, or edited with no history kept) and on the embed.
export type PageHistory = { versions: EditVersion[]; leftOut: number }

export type StatusPage =
	| { status: 'ok'; value: Status; parent: ParentLink | null; history: PageHistory | null }
	| { status: 'moved'; username: string; id: string }
	| { status: 'not_found' }

// A local status by the path's handle and id (an API id, or a legacy id, which moves to the API id): the status page
// and the embed (design §2: embed mode shows the status, its parent link and quote, and nothing else). VIS-4: only a
// public or unlisted original of a local account that is not suspended; anything else, of another author, a boost, a
// remote status or no status at all, is the same not_found. The parent is linked only when the anonymous viewer may
// see it (VIS-12). The status and its parent link are the page's head (budget.ts); its edit history comes last.
export const webStatusPage = pageRead<StatusInput, StatusPage>((db, { handle, id, now, embed = false }, site) => {
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
	const status = presentStatus(db, row.id, anonymous(site, now))
	if (status === null) {
		return { status: 'not_found' }
	}
	// The head of the page's budget; the status page's later parts (design §2) take what it leaves.
	const budget = pageBudget({ status: 'ok', value: null, parent: null, history: LONGEST_HISTORY_FRAME, site })
	admitMandatory(budget, status)
	const parent = parentLink(db, row.in_reply_to_id)
	admitMandatory(budget, parent)
	return { status: 'ok', value: status, parent, history: embed ? null : pageHistory(db, row.id, budget) }
})

// What a page's edit history may take at most (design §2): 512 KiB of the page budget, of its versions' JSON with
// their separators.
export const WEB_HISTORY_BYTES = 512 * 1024

// The history's frame, with the count of versions left out at its longest: a page's frame reserves it whatever the
// read finds (VIS-4: the answer's shape says nothing of the status's history).
const LONGEST_HISTORY_FRAME: PageHistory = { versions: [], leftOut: Number.MAX_SAFE_INTEGER }

// The history, strict (design §2, step 6): versions newest first while each fits whole within the lesser of what the
// page budget leaves and WEB_HISTORY_BYTES; the first that does not ends them, and it and every older one are counted
// as left out. No version is ever cut or admitted past its share.
function pageHistory(db: Db, statusId: string, budget: PageBudget): PageHistory | null {
	const versions = editVersions(db, statusId)
	if (versions.count === 0) {
		return null
	}
	const share: PageBudget = { remaining: Math.min(budget.remaining, WEB_HISTORY_BYTES), ceiling: budget.ceiling }
	const admitted = admitStrict(share, versions.newestFirst)
	charge(budget, admitted.bytes)
	return { versions: admitted.items, leftOut: versions.count - admitted.consumed }
}

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
