import { jsonBytes } from '../answer-budget'
import { viewableStatusIds } from '../audience'
import { type Status, type StatusLink, statusLinks } from '../status-presenter'
import { linkAcct, linkUrl, type PageBudget, PARENT_ENTRY_BYTES, replyOf } from './budget'
import type { Db } from '../../db/sql'

// Parent links (design §2): a reply-to line needs its parent's URL and author, which a Status does not carry. Only a
// parent the anonymous viewer may see by itself (VIS-12, as the status page judges its own parent) is linked; any
// other leaves no entry, so the page names nothing of it. A link's url and acct are within the shared bounds of
// budget.ts: a parent whose url or acct passes them is not linked, and its reply shows without the line.

export type ParentLink = StatusLink

// The parent of a status, if the anonymous viewer may see it.
export function parentLink(db: Db, parentId: string | null): ParentLink | null {
	return parentId === null ? null : (parentLinks(db, [parentId]).get(parentId) ?? null)
}

function parentLinks(db: Db, parentIds: readonly string[]): Map<string, ParentLink> {
	const links = new Map<string, ParentLink>()
	for (const [id, link] of statusLinks(db, viewableStatusIds(db, null, parentIds))) {
		const url = linkUrl(link.url)
		const acct = linkAcct(link.acct)
		if (url !== null && acct !== null) {
			links.set(id, { url, acct })
		}
	}
	return links
}

// The parent links of a page's admitted statuses, by the parent's id: one batched rule check and one projection. Each
// admitted reply reserved PARENT_ENTRY_BYTES (budget.ts statusItemBytes). Each entry is measured and kept only within
// that reservation, and what the entries do not use goes back to the budget.
export function listParents(db: Db, budget: PageBudget, statuses: readonly Status[]): Record<string, ParentLink> {
	const replies = statuses.flatMap((status) => replyOf(status) ?? [])
	const links = parentLinks(db, replies)
	const parents: Record<string, ParentLink> = {}
	let unused = replies.length * PARENT_ENTRY_BYTES
	for (const id of replies) {
		const link = links.get(id)
		if (link === undefined || Object.hasOwn(parents, id)) {
			continue
		}
		const bytes = jsonBytes({ [id]: link }) - 2 + 1
		if (bytes <= PARENT_ENTRY_BYTES) {
			parents[id] = link
			unused -= bytes
		}
	}
	budget.remaining += unused
	budget.ceiling += unused
	return parents
}
