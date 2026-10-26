import { ANSWER_BYTES } from '../answer-budget'
import type { Status } from '../status-presenter'
import { withinTagNameBound } from '../tag-bounds'
import { tagName } from '../tags'
import { tagTimelineWithin } from '../timelines'
import { LONGEST_STATUS_STUB, pageBudget, type StatusStub, statusList } from './budget'
import { type PageCursor, type Paging, LONGEST_PAGING, pagingOf } from './paging'
import { listParents, type ParentLink } from './parents'
import { anonymous, pagePresent, pageRead, type Site } from './site'
import type { Db } from '../../db/sql'

export const TAG_PAGE_SIZE = 20

export type TagPageInput = { name: string; cursor: PageCursor; now: number }

export type TagPage =
	| {
			status: 'ok'
			// The hashtag's normalized name: the page's heading and canonical path.
			tag: string
			// The posts newest first; when the first did not fit, none, and its stub.
			statuses: Status[]
			stub: StatusStub | null
			parents: Record<string, ParentLink>
			paging: Paging
	  }
	| { status: 'not_found' }

// /tags/:name (design §3): the hashtag's local public posts, replies included and boosts not, as the hashtag timeline
// lists them for an anonymous viewer with `local` (VIS-4; no remote posts, and no any, all or none), newest first,
// paged both ways by status id. A name that is not a hashtag, or whose normalized name passes the bound every
// hashtag Kopje lists is read by (tag-bounds.ts withinTagNameBound), is not found: no stored status presents such a
// hashtag (tagNameSql). A hashtag with no posts is an empty page, as Kopje keeps no table of hashtags.
export const webTagPage = pageRead<TagPageInput, TagPage>((db, input, site) =>
	tagPageWithin(db, input, site, ANSWER_BYTES)
)

// The read, within `answerBytes` (tests pass less to reach the stub at a small size).
export function tagPageWithin(db: Db, input: TagPageInput, site: Site, answerBytes: number): TagPage {
	const tag = tagName(input.name)
	if (tag === null || !withinTagNameBound(tag)) {
		return { status: 'not_found' }
	}
	// The frame holds the name itself: it is the page's head, within the bound above.
	const budget = pageBudget(
		{
			status: 'ok',
			tag,
			statuses: [],
			stub: LONGEST_STATUS_STUB,
			parents: {},
			paging: LONGEST_PAGING,
			site,
		} satisfies Extract<TagPage, { status: 'ok' }> & { site: Site },
		answerBytes
	)
	const list = statusList(budget)
	const read = tagTimelineWithin(
		db,
		{
			tag,
			any: [],
			all: [],
			none: [],
			local: true,
			remote: false,
			onlyMedia: false,
			page: { limit: TAG_PAGE_SIZE, ...(input.cursor ?? {}) },
			present: pagePresent(site),
		},
		anonymous(site, input.now).viewer,
		list.admission
	)
	const statuses = read.page.items
	return {
		status: 'ok',
		tag,
		statuses,
		stub: list.stub(),
		parents: listParents(db, budget, statuses),
		paging: pagingOf({ newest: read.page.newest, oldest: read.page.oldest, more: read.more }),
	}
}
