import type { Page } from './accounts'

// RES-3: the UTF-8 bytes of one answer's JSON, containers and separators included; a composite answer's parts share
// it. Owners and admission: docs/response-inventory.md. Every atomic item is within 85% of it (docs/threat-model.md,
// "Maxima of presented units", which test/status-bounds.test.ts measures), so an answer always admits its first item.
export const ANSWER_BYTES = 8 * 1024 * 1024

// The budget of the items of an answer that is one JSON array: its brackets, less the separator its last item does
// not take (admit counts one after every item).
export const ARRAY_ANSWER_BYTES = ANSWER_BYTES - 1

// JSON.stringify's UTF-8 size without building its string, so measuring a multi-MB item holds no copy ("Heap at 8 MiB
// per answer" in docs/threat-model.md). Plain presenter data: toJSON applies (a Date); no BigInt or boxed primitives.
export function jsonBytes(value: unknown): number {
	return valueBytes(value) ?? 0
}

// undefined where JSON.stringify leaves the value out (an object's property) or writes null (an array's element).
function valueBytes(value: unknown): number | undefined {
	switch (typeof value) {
		case 'string':
			return stringBytes(value)
		case 'number':
			return Number.isFinite(value) ? String(value).length : 4
		case 'boolean':
			return value ? 4 : 5
		case 'undefined':
		case 'function':
		case 'symbol':
			return undefined
		case 'bigint':
			throw new TypeError('a BigInt has no JSON')
	}
	if (value === null) {
		return 4
	}
	const json = (value as { toJSON?: unknown }).toJSON
	if (typeof json === 'function') {
		return valueBytes((json as () => unknown).call(value))
	}
	if (Array.isArray(value)) {
		let bytes = 2 + Math.max(value.length - 1, 0)
		for (const item of value as unknown[]) {
			bytes += valueBytes(item) ?? 4
		}
		return bytes
	}
	let bytes = 2
	let members = 0
	for (const [key, item] of Object.entries(value as object)) {
		const size = valueBytes(item)
		if (size !== undefined) {
			bytes += (members++ > 0 ? 1 : 0) + stringBytes(key) + 1 + size
		}
	}
	return bytes
}

// A string as JSON: its quotes, two-character escapes, \u00XX for other control characters and lone surrogates (as
// JSON.stringify writes them), and UTF-8 for the rest.
function stringBytes(text: string): number {
	let bytes = 2
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i)
		if (c === 0x22 || c === 0x5c || c === 0x08 || c === 0x0c || c === 0x0a || c === 0x0d || c === 0x09) {
			bytes += 2
		} else if (c < 0x20) {
			bytes += 6
		} else if (c < 0x80) {
			bytes += 1
		} else if (c < 0x800) {
			bytes += 2
		} else if (c >= 0xd800 && c <= 0xdbff) {
			const next = text.charCodeAt(i + 1)
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4
				i++
			} else {
				bytes += 6
			}
		} else if (c >= 0xdc00 && c <= 0xdfff) {
			bytes += 6
		} else {
			bytes += 3
		}
	}
	return bytes
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

// Each key's value as `stream` presents it, presented once, in the order the answer first uses the keys: an account or
// status shared by items (notifications, groups) is presented and matched once. Holds only what the answer used so far.
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
