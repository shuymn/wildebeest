import type { PageCursor, Paging } from '../../domain/web-pages/paging'

// The pager of a newest-first list (design §4, "Newest-first lists"), from the request's cursor, the read's paging
// facts and the list's cursor-less URL `base`. Pure: it follows only those facts, never the number of items shown.
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

export function newestFirstPager(base: string, cursor: PageCursor, paging: Paging): PagerLinks {
	const link = (name: 'max_id' | 'min_id', id: string | null) =>
		id === null || (name === 'max_id' && BigInt(id) === 0n) ? null : `${base}?${name}=${id}`
	if (cursor === null) {
		return { newer: null, older: paging.more ? link('max_id', paging.oldest) : null }
	}
	if ('maxId' in cursor) {
		const below = BigInt(cursor.maxId) - 1n
		return {
			newer:
				paging.newest !== null ? link('min_id', paging.newest) : below < 0n ? base : link('min_id', below.toString()),
			older: paging.more ? link('max_id', paging.oldest) : null,
		}
	}
	return {
		newer: paging.more ? link('min_id', paging.newest) : null,
		older: paging.oldest !== null ? link('max_id', paging.oldest) : base,
	}
}
