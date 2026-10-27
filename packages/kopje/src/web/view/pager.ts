import type { PageCursor, Paging } from '../../domain/web-pages/paging'

// The pager of a newest-first list, from the request's cursor, the read's paging facts and the list's cursor-less URL
// `base`. Pure: it follows only those facts, never the number of items shown.
//
// | Request  | Older (?max_id=)                       | Newer (?min_id=)                                          |
// | none     | oldest when more                       | none                                                      |
// | max_id=X | oldest when more                       | newest when known; else ?min_id=X−1, or the first page    |
// |          |                                        | for X = 0                                                 |
// | min_id=X | oldest when known; else the first page | newest when more                                          |
//
// An end is unknown when the read passed no row on that side of X: none was a candidate, or every candidate of a
// window that was not cut was hidden by availability. Either way no row a page shows lies there. For min_id=X the older
// page (?max_id=X+1) then shows what the first page shows; for max_id=X the newer page starts at X itself
// (?min_id=X−1), so walking back from an empty last page passes over nothing. X−1 is a boundary derived from the
// request alone, not an item's id: it may equal a hidden status's id and discloses nothing of it.
//
// No older link names id 0, the lowest a cursor takes: nothing lies below it, and the empty page it would open could
// link back only to the first page, past the rows between.

export type PagerLinks = { newer: string | null; older: string | null }

// A link to the list at `base` by a cursor, or null: none for no id, and no max_id of 0 (nothing lies below it).
function pageLink(base: string) {
	return (name: 'max_id' | 'min_id', id: string | null) =>
		id === null || (name === 'max_id' && BigInt(id) === 0n) ? null : `${base}?${name}=${id}`
}

// The links of a read below max_id=X, either list's: toward newer ids, `newest` when known, else from X itself
// (?min_id=X−1, or the first page for X = 0); toward older ids, `oldest` when more lies past it.
function belowMax(base: string, maxId: string, paging: Paging): PagerLinks {
	const link = pageLink(base)
	const below = BigInt(maxId) - 1n
	return {
		newer:
			paging.newest !== null ? link('min_id', paging.newest) : below < 0n ? base : link('min_id', below.toString()),
		older: paging.more ? link('max_id', paging.oldest) : null,
	}
}

export function newestFirstPager(base: string, cursor: PageCursor, paging: Paging): PagerLinks {
	const link = pageLink(base)
	if (cursor === null) {
		return { newer: null, older: paging.more ? link('max_id', paging.oldest) : null }
	}
	if ('maxId' in cursor) {
		return belowMax(base, cursor.maxId, paging)
	}
	return {
		newer: paging.more ? link('min_id', paging.newest) : null,
		older: paging.oldest !== null ? link('max_id', paging.oldest) : base,
	}
}

// The pager of an oldest-first list: a status's replies. With no cursor or with
// `min_id` the read ascends from the cursor, with `max_id` it descends below it; `newest` and `oldest` are its ends
// by id either way.
//
// | Request  | Earlier (?max_id=)                      | Later (?min_id=)                                         |
// | none     | none                                    | newest when more                                         |
// | min_id=X | oldest when known; else ?max_id=X+1     | newest when more                                         |
// | max_id=X | oldest when more                        | newest when known; else ?min_id=X−1, or the first page   |
// |          |                                         | for X = 0                                                |
//
// An unknown end means no row a page shows lies on that side of X, so the link starts at X itself (?max_id=X+1,
// ?min_id=X−1): a return from an empty page then passes over no reply. These are boundaries derived from the request
// alone, never an item's id. An earlier link never names id 0 and stays within the 19 digits a cursor takes.

export type RepliesPagerLinks = { earlier: string | null; later: string | null }

const LAST_CURSOR = 10n ** 19n - 1n

export function repliesPager(base: string, cursor: PageCursor, paging: Paging): RepliesPagerLinks {
	const link = pageLink(base)
	if (cursor === null) {
		return { earlier: null, later: paging.more ? link('min_id', paging.newest) : null }
	}
	if ('maxId' in cursor) {
		const { newer, older } = belowMax(base, cursor.maxId, paging)
		return { earlier: older, later: newer }
	}
	const above = BigInt(cursor.minId) + 1n
	return {
		earlier:
			paging.oldest !== null
				? link('max_id', paging.oldest)
				: link('max_id', (above > LAST_CURSOR ? LAST_CURSOR : above).toString()),
		later: paging.more ? link('min_id', paging.newest) : null,
	}
}
