import { type AfterResponse, afterResponse, type ApiDeps, storeCall } from './context'
import { errorFields } from '../platform/error-message'
import { StoreUnavailableError } from '../platform/store-errors'

// RES-6: the Worker's side of activity recording (domain/auth.ts noteActivity). After the response of an authenticated
// API request (mastodon/access.ts) or of GET /settings (app/web.tsx), a Store call is sent unless the memo shows one
// sent for the token that UTC day. The memo only suppresses repeats, best effort: it is cleared when the UTC day
// changes or when it holds ACTIVITY_MEMO_LIMIT tokens (about 100 KB of digests), forgets a failed call, and an isolate
// restart forgets it all, so a token may send again. What bounds the writes is the Store's conditional UPDATE, one row
// write per account and UTC day.
export const ACTIVITY_MEMO_LIMIT = 1024

// Per isolate (app/app.ts creates one per app, worker.ts one app per isolate), keyed by token digest. An entry is a
// fresh marker set before the call: kept on success, removed on failure only while it is still that marker, so a late
// failure never removes a newer entry and a late success never adds one back after a clear.
export class ActivityMemo {
	#day = ''
	readonly #entries = new Map<string, object>()

	// `send`'s promise, or null when this isolate already sent one for the token today.
	note(tokenHash: string, now: number, send: () => Promise<unknown>): Promise<unknown> | null {
		const day = new Date(now).toISOString().slice(0, 10)
		if (day !== this.#day) {
			this.#entries.clear()
			this.#day = day
		}
		if (this.#entries.has(tokenHash)) {
			return null
		}
		if (this.#entries.size >= ACTIVITY_MEMO_LIMIT) {
			this.#entries.clear()
		}
		const marker = {}
		this.#entries.set(tokenHash, marker)
		return send().catch((error: unknown) => {
			if (this.#entries.get(tokenHash) === marker) {
				this.#entries.delete(tokenHash)
			}
			throw error
		})
	}

	get size(): number {
		return this.#entries.size
	}

	has(tokenHash: string): boolean {
		return this.#entries.has(tokenHash)
	}
}

// Records the token's activity after the response. A Store refusal (maintenance, a dump's lease) is dropped silently:
// the day is not marked, so a later request of the day records it.
export function noteActivitySoon(
	c: AfterResponse,
	deps: Pick<ApiDeps, 'build' | 'store' | 'now' | 'activity'>,
	tokenHash: string
): void {
	const now = deps.now()
	const sent = deps.activity?.note(tokenHash, now, () =>
		storeCall(c, deps, (s, b) => s.noteActivity(b, { tokenHash, now }))
	)
	if (sent === undefined || sent === null) {
		return
	}
	afterResponse(
		c,
		sent.catch((error: unknown) => {
			if (!(error instanceof StoreUnavailableError)) {
				console.error({ event: 'kopje.activity.failed', ...errorFields(error) })
			}
		})
	)
}
