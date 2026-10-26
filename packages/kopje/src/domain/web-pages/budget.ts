import { DOMAIN_BYTES, STATUS_URI_LIMIT } from '../../platform/identity-bounds'
import { STATUS_URL_LIMIT } from '../../platform/stored-bounds'
import { admit, type Admitted, ANSWER_BYTES, itemBytes, jsonBytes } from '../answer-budget'
import { USERNAME_LIMIT } from '../profile-bounds'
import type { Status } from '../status-presenter'
import type { StatusAdmission } from '../timelines'

// The composite budget of a page read (design §2, RES-3): one answer within ANSWER_BYTES, its JSON containers
// included, shared in a fixed priority. A page's frame is its answer shape with empty lists, cursors at their longest,
// every flag set and one stub reserved; then the mandatory head (the focal account or status with its parent link),
// then a list's first item (admitHead: the item, or its stub when it does not fit beside the head), then the rest of
// the list strictly (admitStrict: what fits, never more), each item with its parent link reserved; later parts take
// what is left. Admission never exceeds what remains, so the answer stays within ANSWER_BYTES whatever the parts hold.

export type PageBudget = { remaining: number }

// The budget of an answer whose frame is `frame` (the answer with nothing admitted).
export function pageBudget(frame: object, answerBytes = ANSWER_BYTES): PageBudget {
	return { remaining: answerBytes - jsonBytes(frame) }
}

// The head of a page, which every answer holds: within its unit maximum, far below what the frame leaves
// ("Maxima of presented units" in docs/threat-model.md).
export function admitMandatory(budget: PageBudget, value: unknown): void {
	budget.remaining -= jsonBytes(value)
	if (budget.remaining < 0) {
		throw new Error('a page head passed its answer budget')
	}
}

// The items of `entries` in traversal order while each fits what remains; the first that does not ends them (cut).
export function admitStrict<T>(
	budget: PageBudget,
	entries: Iterable<T | undefined>,
	size: (item: T) => number = itemBytes
): Admitted<T> {
	const admitted = admit(entries, budget.remaining, false, size)
	budget.remaining -= admitted.bytes
	return admitted
}

// A list's first item if it fits what remains, or else its stub, whose bytes the frame reserved.
export function admitHead<T, S>(
	budget: PageBudget,
	entry: T,
	stub: (entry: T) => S,
	size: (item: T) => number = itemBytes
): { item: T; bytes: number } | { stub: S } {
	const bytes = size(entry)
	if (bytes > budget.remaining) {
		return { stub: stub(entry) }
	}
	budget.remaining -= bytes
	return { item: entry, bytes }
}

// A list item that did not fit beside the head (design §2): enough to link it. For a boost, the original's link and
// author (amendment A2), which the presenter shows only when the anonymous viewer may see it; the id stays the boost's,
// the list's cursor.
export type StatusStub = { id: string; url: string; acct: string; created_at: string }

export function statusStub(status: Status): StatusStub {
	const target = status.reblog ?? status
	return { id: status.id, url: target.url ?? target.uri, acct: target.account.acct, created_at: target.created_at }
}

// The status a reply-to line names: a boost's original's parent, else the status's own.
export function replyOf(status: Status): string | null {
	return (status.reblog ?? status).in_reply_to_id
}

// The longest link a page holds for a status (a stub's, a parent's), as JSON: a url of at most STATUS_URI_LIMIT UTF-8
// bytes (a remote status's url or uri; a local one's derives from an actor id of at most 2,048 bytes and a username)
// and an acct of a username (its JSON at most USERNAME_LIMIT bytes) and a domain of DOMAIN_BYTES, each byte escaped to
// at most six (a control character's \u00XX).
const LONGEST_URL = '\u0001'.repeat(Math.max(STATUS_URI_LIMIT, STATUS_URL_LIMIT))
const LONGEST_ACCT = `${'x'.repeat(USERNAME_LIMIT)}@${'\u0001'.repeat(DOMAIN_BYTES)}`

export const LONGEST_STATUS_STUB: StatusStub = {
	id: '9'.repeat(19),
	url: LONGEST_URL,
	acct: LONGEST_ACCT,
	created_at: '0000-00-00T00:00:00.000Z',
}

// What one entry of a page's `parents` (by the parent's id) takes at most, with its separator: reserved for each
// admitted reply and given back for what the entries use (parents.ts).
export const PARENT_ENTRY_BYTES = jsonBytes({ ['9'.repeat(19)]: { url: LONGEST_URL, acct: LONGEST_ACCT } }) - 2 + 1

// A status's share of a page list: its JSON and separator, and its parent link's entry when it is a reply.
export function statusItemBytes(status: Status): number {
	return itemBytes(status) + (replyOf(status) === null ? 0 : PARENT_ENTRY_BYTES)
}

// A page list of statuses: its first item by admitHead, the rest by admitStrict. After a stub the list ends, cut, so
// its continuation moves past the stubbed item and every page makes progress.
export function statusList(budget: PageBudget): { admission: StatusAdmission; stub: () => StatusStub | null } {
	let stub: StatusStub | null = null
	const admission: StatusAdmission = (entries) => {
		const iterator = entries[Symbol.iterator]()
		let consumed = 0
		for (let next = iterator.next(); next.done !== true; next = iterator.next()) {
			consumed++
			const first = next.value
			if (first === undefined) {
				continue
			}
			const head = admitHead(budget, first, statusStub, statusItemBytes)
			if ('stub' in head) {
				stub = head.stub
				return { items: [], bytes: 0, consumed, cut: true }
			}
			const rest = admitStrict(budget, { [Symbol.iterator]: () => iterator }, statusItemBytes)
			return {
				items: [first, ...rest.items],
				bytes: head.bytes + rest.bytes,
				consumed: consumed + rest.consumed,
				cut: rest.cut,
			}
		}
		return { items: [], bytes: 0, consumed, cut: false }
	}
	return { admission, stub: () => stub }
}
