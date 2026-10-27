// The cursors of a page URL and the paging facts of a page read. A cursor is the API's own for the same
// list (a status id for statuses), as `max_id` or `min_id`, of at most 19 digits; anything else serves the first page.

// A request's cursor: older than `maxId`, newer than `minId`, or none (the first page). A request with both reads by
// `max_id`.
export type PageCursor = { maxId: string } | { minId: string } | null

// An id a page URL takes (^\d{1,19}$), or null.
function cursorId(value: string | null | undefined): string | null {
	return value !== undefined && value !== null && /^\d{1,19}$/.test(value) ? value : null
}

export function pageCursor(maxId: string | null | undefined, minId: string | null | undefined): PageCursor {
	const older = cursorId(maxId)
	if (older !== null) {
		return { maxId: older }
	}
	const newer = cursorId(minId)
	return newer === null ? null : { minId: newer }
}

// What a page tells its pager: the ends of what it read, each only as an id a page URL
// takes, and whether more lies past its far end in its direction of travel (the window or page was full, or cut).
export type Paging = { newest: string | null; oldest: string | null; more: boolean }

// The longest paging facts: what a page's frame reserves.
export const LONGEST_PAGING: Paging = { newest: '9'.repeat(19), oldest: '9'.repeat(19), more: true }

// A list read's metadata (any list: statuses, follows), its ends kept only as ids a page URL takes.
export function pagingOf(read: Paging | null): Paging {
	return read === null
		? { newest: null, oldest: null, more: false }
		: { newest: cursorId(read.newest), oldest: cursorId(read.oldest), more: read.more }
}
