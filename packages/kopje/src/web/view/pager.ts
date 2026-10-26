import type { PageCursor, Paging } from '../../domain/web-pages/paging'

// The pager of a newest-first list (design §4, "Newest-first lists"), from the request's cursor, the read's paging
// facts and the list's cursor-less URL `base`. Pure: it follows only those facts, never the number of items shown.
//
// | Request    | Older (?max_id=)                                  | Newer (?min_id=)                                   |
// | none       | oldest when more                                  | none                                               |
// | max_id=X   | oldest when more                                  | newest when known; else ?min_id=X−1, or the first  |
// |            |                                                   | page for X = 0                                     |
// | min_id=X   | oldest when known; else the first page            | newest when more                                   |
//
// An end is unknown only when the read had no candidate on that side of X: for min_id=X nothing lies above X, so the
// older page (?max_id=X+1) is the first page; for max_id=X nothing lies below X, and the newer page starts at X itself
// (?min_id=X−1), so walking back from an empty last page passes over nothing.

export type PagerLinks = { newer: string | null; older: string | null }

export function newestFirstPager(base: string, cursor: PageCursor, paging: Paging): PagerLinks {
	const link = (name: 'max_id' | 'min_id', id: string | null) => (id === null ? null : `${base}?${name}=${id}`)
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
