import type { Page } from './accounts'
import { utf8Length } from '../platform/dump-format'

// RES-3: the UTF-8 bytes of one Mastodon API answer that presents statuses or accounts, as the Worker serializes it,
// its containers and separators included. The Store operation that returns the answer owns it, and the parts of a
// composite answer (search, a context, a profile page) share it. Every atomic item (a status with its boosted original
// and quoted status, an account) is at most 66% of it (docs/threat-model.md, "Maxima of presented units"), so an
// answer always admits its first item. docs/response-inventory.md lists every owner.
export const ANSWER_BYTES = 8 * 1024 * 1024

// The budget of the items of an answer that is one JSON array: its brackets, less the separator its last item does
// not take (admit counts one after every item).
export const ARRAY_ANSWER_BYTES = ANSWER_BYTES - 1

// The UTF-8 bytes of a value as JSON.
export function jsonBytes(value: unknown): number {
	return utf8Length(JSON.stringify(value))
}

// What admit took: the items, their bytes (each with a separator), how many of the walked entries were consumed (the
// admitted ones, and those with nothing to show before the first one left out), and whether one was left out.
export type Admitted<T> = { items: T[]; bytes: number; consumed: number; cut: boolean }

// Admission (RES-3): the items of `entries`, in traversal order, while their JSON, each with a separator, fits
// `budget`; it stops at the first item that does not fit. Each entry is presented only when it is reached, so what is
// held past the admitted items is the rows of one chunk (presentStatusesWithin) and one presented item. An entry
// presented as undefined (nothing to show) is consumed.
// `leading`: the first item is admitted whatever its size, so an answer continued from its last item moves on; every
// atomic item is below ANSWER_BYTES.
export function admit<T>(entries: Iterable<T | undefined>, budget: number, leading: boolean): Admitted<T> {
	const items: T[] = []
	let bytes = 0
	let consumed = 0
	for (const item of entries) {
		if (item !== undefined) {
			const size = jsonBytes(item) + 1
			if (bytes + size > budget && !(leading && items.length === 0)) {
				return { items, bytes, consumed, cut: true }
			}
			bytes += size
			items.push(item)
		}
		consumed++
	}
	return { items, bytes, consumed, cut: false }
}

// The value of each key as `stream` presents it, the keys (each once) in the order the answer first uses them: each is
// presented when it is first asked for, and a key used again is answered from what was presented, so an answer whose
// items share an embedded account or status (notifications, groups) presents and matches it once. What is held is
// what the answer used so far.
export function firstUses<T>(keys: readonly string[], stream: Iterator<T | undefined>): (key: string) => T | undefined {
	const seen = new Map<string, T | undefined>()
	let next = 0
	return (key) => {
		while (!seen.has(key) && next < keys.length) {
			const result = stream.next()
			seen.set(keys[next++] ?? '', result.done === true ? undefined : result.value)
		}
		return seen.get(key)
	}
}

// A page of an id cursor (newest first, as windowPage gives it) whose rows are admitted, the first whatever its size
// (admit with `leading`), in traversal order: newest first, or oldest first for min_id (`ascending`), shown newest
// first. Uncut, it is the page as read. Cut by the budget, it is Page.cut and continues from the last admitted row in
// traversal order: a byte-omitted row lies before any candidate-window continuation (docs/visibility.md "Read
// bounds"), which is dropped.
export function admittedPage<R, T>(
	page: { rows: readonly R[]; newest: string | null; oldest: string | null; cut?: boolean },
	ascending: boolean,
	key: (row: R) => string,
	admitRows: (traversal: readonly R[]) => Admitted<T>
): Page<T> {
	const traversal = ascending ? page.rows.toReversed() : page.rows
	const admitted = admitRows(traversal)
	const items = ascending ? admitted.items.toReversed() : admitted.items
	if (!admitted.cut) {
		return { items, newest: page.newest, oldest: page.oldest, cut: page.cut }
	}
	const last = traversal[admitted.consumed - 1]
	if (last === undefined) {
		throw new Error('a page admits its first row (admit with leading)')
	}
	return ascending
		? { items, newest: key(last), oldest: page.oldest, cut: true }
		: { items, newest: page.newest, oldest: key(last), cut: true }
}
