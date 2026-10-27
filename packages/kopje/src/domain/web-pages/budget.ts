import { ACTOR_URI_LIMIT, STATUS_URI_LIMIT } from '../../platform/identity-bounds'
import { STATUS_URL_LIMIT } from '../../platform/stored-bounds'
import { admit, type Admitted, ANSWER_BYTES, itemBytes, jsonBytes } from '../answer-budget'
import { USERNAME_LIMIT } from '../profile-bounds'
import type { Status } from '../status-presenter'
import type { StatusAdmission } from '../timelines'

// The composite budget of a page read (design §2, RES-3, amendment A11): one answer within WEB_PAGE_BYTES of JSON, its
// containers included, shared in a fixed priority. A page's frame is its answer shape with empty lists, cursors at
// their longest, every flag set and one stub reserved; then the mandatory head (the focal account or status with its
// parent link), then a list's first item (admitHead: the item, or its stub when it does not fit beside the head),
// then the rest of the list strictly (admitStrict: what fits, never more), each item with its parent link reserved;
// later parts take what is left. The head is admitted whatever the page budget leaves (a status at its caps is the
// status page), held only to the answer's ceiling, ANSWER_BYTES; everything else stays within the page budget, so
// the answer is within WEB_PAGE_BYTES or, when its head alone passes that, the head and at most one stub.

// A page's answer budget (amendment A11): the page renders all of it, and a page's HTML is at most five times its JSON
// plus the emoji allowance and 512 KiB (A10), so 1 MiB keeps a page and its rendering well within the isolate's
// memory, where the API's 8 MiB would not (an 8 MiB feed rendered 18.8 MB of HTML).
export const WEB_PAGE_BYTES = 1024 * 1024

// `remaining`: what the page budget leaves (negative once a head passed it); `ceiling`: what ANSWER_BYTES leaves.
export type PageBudget = { remaining: number; ceiling: number }

// The budget of an answer whose frame is `frame` (the answer with nothing admitted), within `pageBytes`.
export function pageBudget(frame: object, pageBytes = WEB_PAGE_BYTES): PageBudget {
	const bytes = jsonBytes(frame)
	return { remaining: pageBytes - bytes, ceiling: ANSWER_BYTES - bytes }
}

// Charges `bytes` to both the page budget and the ceiling (a negative amount refunds them).
export function charge(budget: PageBudget, bytes: number): void {
	budget.remaining -= bytes
	budget.ceiling -= bytes
}

// The head of a page, which every answer holds whatever the page budget leaves: within its unit maximum, far below
// what the frame leaves of ANSWER_BYTES ("Maxima of presented units" in docs/threat-model.md).
export function admitMandatory(budget: PageBudget, value: unknown): void {
	charge(budget, jsonBytes(value))
	if (budget.ceiling < 0) {
		throw new Error('a page head passed its answer budget')
	}
}

// The items of `entries` in traversal order while each fits what remains; the first that does not ends them (cut).
export function admitStrict<T>(
	budget: PageBudget,
	entries: Iterable<T | undefined>,
	size: (item: T) => number = itemBytes
): Admitted<T> {
	const admitted = admit(entries, Math.max(0, budget.remaining), false, size)
	charge(budget, admitted.bytes)
	return admitted
}

// A list's first item if it fits what remains, or else its stub. The frame reserved `reserved` bytes for the stub;
// the stub is measured, and what it takes past them is charged too, so the answer stays within its budget even if
// the reservation were short (a stub that cannot be charged within the ceiling is refused).
export function admitHead<T, S>(
	budget: PageBudget,
	entry: T,
	stub: { of: (entry: T) => S; reserved: number },
	size: (item: T) => number = itemBytes
): { item: T; bytes: number } | { stub: S } {
	const bytes = size(entry)
	if (bytes <= budget.remaining) {
		charge(budget, bytes)
		return { item: entry, bytes }
	}
	const value = stub.of(entry)
	const over = Math.max(0, jsonBytes(value) - stub.reserved)
	if (over > budget.ceiling) {
		throw new Error('a stub passed its answer budget')
	}
	charge(budget, over)
	return { stub: value }
}

// The fields of a link a page holds for a status it does not show (a stub's, a parent's), each within a shared bound
// whatever the row holds (an imported value has none of its own): a url of at most LINK_URL_JSON_BYTES and an acct of
// at most LINK_ACCT_JSON_BYTES, as JSON, and a time re-serialized from the date it parses as. A field past its bound,
// or a time that does not parse, is left out (null), and the link shows without it.
//
// The bounds: a status's url or uri is at most STATUS_URI_LIMIT UTF-8 bytes (STATUS_URL_LIMIT for a url) and a local
// one's derives from an actor id of at most ACTOR_URI_LIMIT; an acct is a username of USERNAME_LIMIT and a domain no
// longer than an actor id holds (ACTOR_URI_LIMIT less `https://`); each byte escapes to at most six in JSON (a control
// character's \u00XX). A time re-serialized by Date is at most 27 characters (+275760-09-13T00:00:00.000Z).
const ESCAPING = '\u0001'
const LONGEST_URL = ESCAPING.repeat(Math.max(STATUS_URI_LIMIT, STATUS_URL_LIMIT, ACTOR_URI_LIMIT))
const LONGEST_ACCT = ESCAPING.repeat(USERNAME_LIMIT + 1 + ACTOR_URI_LIMIT - 'https://'.length)
const LONGEST_TIME = '+275760-09-13T00:00:00.000Z'
export const LINK_URL_JSON_BYTES = jsonBytes(LONGEST_URL)
export const LINK_ACCT_JSON_BYTES = jsonBytes(LONGEST_ACCT)
// What a time string may hold before it is parsed (an ISO time is 24 to 27 characters; a longer one is not read).
const TIME_INPUT_LIMIT = 64

export function linkUrl(url: string | null | undefined): string | null {
	return url === null || url === undefined || jsonBytes(url) > LINK_URL_JSON_BYTES ? null : url
}

export function linkAcct(acct: string): string | null {
	return jsonBytes(acct) > LINK_ACCT_JSON_BYTES ? null : acct
}

export function linkTime(value: string): string | null {
	if (value.length > TIME_INPUT_LIMIT) {
		return null
	}
	const time = Date.parse(value)
	return Number.isNaN(time) ? null : new Date(time).toISOString()
}

// A list item that did not fit beside the head (design §2): enough to link it, its fields bounded as above. For a
// boost, the original's link and author (amendment A2), which the presenter shows only when the anonymous viewer may
// see it; the id stays the boost's, the list's cursor.
export type StatusStub = { id: string; url: string | null; acct: string | null; created_at: string | null }

export function statusStub(status: Status): StatusStub {
	const target = status.reblog ?? status
	return {
		id: status.id,
		url: linkUrl(target.url ?? target.uri),
		acct: linkAcct(target.account.acct),
		created_at: linkTime(target.created_at),
	}
}

// The status a reply-to line names: a boost's original's parent, else the status's own.
export function replyOf(status: Status): string | null {
	return (status.reblog ?? status).in_reply_to_id
}

// The largest stub, with a status id of 19 digits (a page's cursor): what a page's frame reserves for one.
export const LONGEST_STATUS_STUB: StatusStub = {
	id: '9'.repeat(19),
	url: LONGEST_URL,
	acct: LONGEST_ACCT,
	created_at: LONGEST_TIME,
}

// What one entry of a page's `parents` (by the parent's id, a status id of 19 digits) takes at most, with its
// separator: reserved for each admitted reply (parents.ts).
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
			const head = admitHead(
				budget,
				first,
				{ of: statusStub, reserved: jsonBytes(LONGEST_STATUS_STUB) },
				statusItemBytes
			)
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
