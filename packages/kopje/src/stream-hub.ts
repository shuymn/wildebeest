import {
	CONVERSATIONS_PER_TURN,
	JOURNAL_SPAN,
	keyList,
	listKey,
	mayCarry,
	maySubscribe,
	SERVED_STREAMS,
	type ServedStream,
	STREAM_NAMES,
	STREAM_OPERATIONS,
	streamAccept,
	streamAdvance,
	streamCaughtUp,
	streamConversations,
	streamDeleteUnits,
	streamEnterConversation,
	type StreamEvent,
	type StreamGrant,
	streamEvents,
	type StreamKeys,
	streamListOwned,
	type StreamPosition,
	streamPrune,
	type StreamSubject,
	type StreamUnitAfter,
	streamReconcile,
	streamRegister,
	streamTokens,
	streamUnit,
} from './domain/streaming'
import { errorFields } from './platform/error-message'
import { toStoreUnavailable } from './platform/store-errors'
import type { StoreKernel, StoreOperation } from './platform/store-kernel'

// The streaming API's sockets, in the Store, with WebSocket Hibernation (Mastodon 4.5's streaming server, design
// "Kopje streaming API"). The Worker (mastodon/streaming.ts) authenticates nothing itself: it forwards the upgrade with
// the token's sha256 only, and the Store accepts the socket once the token is a user's (domain/streaming.ts). Each
// socket carries its state in its attachment (Attachment), which survives hibernation; the Store's SQLite holds the
// registry of subscribed stream keys, the journal of events and the fan-out's position (migration 0026_streaming).
//
// Fan-out runs in turns, one at a time. Every turn is an incoming request to the Store's own stub, which restores the
// CPU allowance (an incoming request resets it; nothing else is documented to): requested after a write commits while
// sockets are open, by the cron every 5 minutes, and by a turn that ran out of budget. A turn re-checks every open
// socket's token (a revoked or expired token, or a suspended account's, closes with 1008), then sends units in the
// journal's order until its budget cannot cover a unit's worst case. Each unit is made in its own transaction, the
// position past it persisted before its messages are sent (at most once); a send that fails closes the sockets left
// without the unit (1011), and their clients read REST again.

// The caps (RES-6, RES-7). socketsPerInstance can be lowered in tests (STREAM_LIMITS is the seam).
export const STREAM_LIMITS = {
	socketsPerAccount: 16,
	socketsPerInstance: 256,
	subscriptionsPerSocket: 16,
	keysPerAccount: 16,
	// A text message read at most this many UTF-8 bytes; a larger one closes the socket (1008).
	messageBytes: 4096,
	// Messages a socket may send per minute; one more closes it (1008).
	messagesPerMinute: 120,
	attachmentBytes: 12 * 1024,
	// A presented subject larger than this is skipped and logged.
	payloadBytes: 512 * 1024,
}

// Tests only: when set, a turn that leaves work requests no continuation and calls it instead, as a continuation whose
// request failed (the cron's turn picks the work up).
export const STREAM_FAULTS: { dropContinuation: (() => void) | null } = { dropContinuation: null }

type Charge = { checks: number; presentations: number; bytes: number; sends: number }

// What one turn may do, and what one unit may do at most: 16 token checks and the reference reads of an edit (home, the
// mention, and up to 16 lists: an account has at most 16 keys, all of them lists at most, and an edit reads home and
// the mention whatever it subscribes to), one presentation, and a send to each of 16 subscriptions on each of 16
// sockets.
export const TURN_BUDGET: Charge = { checks: 512, presentations: 64, bytes: 4 * 1024 * 1024, sends: 4096 }
const UNIT_WORST: Charge = { checks: 34, presentations: 1, bytes: STREAM_LIMITS.payloadBytes, sends: 256 }

// Journal events read per scan of a turn.
const SCAN = 64

const TURN_URL = 'https://store.internal/stream/turn'
const TURN_HEADER = 'x-kopje-turn'

// A socket's state (design §4.5). since: the journal head when it opened (it receives later events only); convSeq: the
// highest conversation change sent or skipped on `direct` (raised, and written, before a conversation is sent); rate:
// the minute its message count started; subs: its subscriptions' keys (a stream's name, or `list:<id>`), in order.
type Attachment = {
	v: 1
	tokenHash: string
	accountId: string
	grant: StreamGrant
	since: number
	convSeq: number
	rate: { window: number; count: number }
	subs: string[]
}

type Socket = { ws: WebSocket; at: Attachment }

// One subject of an event for one viewer, with the viewer's sockets that may carry it and the list ids it may go on.
type Unit = { subject: StreamSubject; viewer: string; sockets: Socket[]; lists: string[] }

// A scan's walk: the position as this turn moved it, and an event passed over whose position write is pending.
type Walk = { from: StreamPosition; skipTo: StreamPosition | null; ceiling: number }

// A delete's units are read this many viewers at a time (at most 41 units each).
const DELETE_PAGE = 8

class Budget {
	readonly #left: Charge

	constructor(limit: Charge) {
		this.#left = { ...limit }
	}

	covers(need: Charge): boolean {
		return (Object.keys(need) as (keyof Charge)[]).every((k) => this.#left[k] >= need[k])
	}

	charge(spent: Partial<Charge>): void {
		for (const [k, n] of Object.entries(spent) as [keyof Charge, number][]) {
			this.#left[k] -= n
		}
	}
}

export class StreamHub {
	readonly #ctx: DurableObjectState
	readonly #kernel: StoreKernel
	readonly #turnRequest: (headers: HeadersInit) => Promise<Response>
	// One turn at a time: a turn running, a request for one issued and not started yet (by its number), and whether
	// another was asked for meanwhile.
	#running = false
	#pending: number | null = null
	#requests = 0
	#again = false
	#failed = false
	#turns = 0
	// The registry is rebuilt from the open sockets by the first turn of this instance.
	#reconciled = false
	#idle: (() => void)[] = []

	constructor(ctx: DurableObjectState, kernel: StoreKernel, turnRequest: (headers: HeadersInit) => Promise<Response>) {
		this.#ctx = ctx
		this.#kernel = kernel
		this.#turnRequest = turnRequest
	}

	// The Store's fetch: the upgrade the Worker forwards, and the turns the Store asks of itself.
	fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		if (request.method === 'POST' && url.pathname === '/stream/turn') {
			return this.#turn(request)
		}
		if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
			return this.#upgrade(request, url)
		}
		return Promise.resolve(new Response(null, { status: 404 }))
	}

	// After a write commits: a turn, if a socket is open and the write was not the hub's own.
	written(operation: StoreOperation<never, unknown>): void {
		if (!STREAM_OPERATIONS.has(operation) && this.#ctx.getWebSockets().length > 0) {
			this.#request()
		}
	}

	// The cron's turn: closes the sockets of tokens that expired, and prunes the journal.
	tick(): void {
		this.#request()
	}

	// Resolves once no turn runs or is requested and the position is at the journal's head (the streaming tests' drain
	// barrier), with the number of turns this instance ran. Never polls: it waits for turns to end.
	async drained(): Promise<{ turns: number }> {
		for (;;) {
			if (!this.#running && this.#pending === null) {
				if (this.#failed) {
					throw new Error('the last stream turn failed')
				}
				if (await this.#run(streamCaughtUp, undefined)) {
					return { turns: this.#turns }
				}
				this.#request()
			}
			await new Promise<void>((resolve) => this.#idle.push(resolve))
		}
	}

	// Closes every socket, for a Store that can no longer serve them (an import begins, maintenance refuses a turn).
	closeAll(code: number, reason: string): void {
		for (const ws of this.#ctx.getWebSockets()) {
			close(ws, code, reason)
		}
		this.#reconciled = false
	}

	async message(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const at = this.#restore(ws)
		if (at === null) {
			return
		}
		if (typeof message !== 'string') {
			return this.#drop(ws, at, 1003, 'binary messages are not supported')
		}
		if (exceeds(message, STREAM_LIMITS.messageBytes)) {
			return this.#drop(ws, at, 1008, 'message too large')
		}
		const now = Date.now()
		at.rate = now - at.rate.window >= 60_000 ? { window: now, count: 1 } : { ...at.rate, count: at.rate.count + 1 }
		if (at.rate.count > STREAM_LIMITS.messagesPerMinute) {
			return this.#drop(ws, at, 1008, 'too many messages')
		}
		ws.serializeAttachment(at)
		const json = parseObject(message)
		if (json?.type === 'subscribe') {
			await this.#subscribe(ws, at, json)
		} else if (json?.type === 'unsubscribe') {
			await this.#unsubscribe(ws, at, json)
		}
	}

	async closed(ws: WebSocket, code: number): Promise<void> {
		close(ws, code === 1005 || code === 1006 ? 1000 : code, '')
		const at = peek(ws)
		if (at !== null) {
			await this.#sync(at.accountId, ws)
		}
	}

	async #upgrade(request: Request, url: URL): Promise<Response> {
		const build = request.headers.get('x-kopje-build') ?? ''
		const tokenHash = request.headers.get('x-kopje-token-hash') ?? ''
		const now = Number(request.headers.get('x-kopje-now'))
		if (!TOKEN_HASH.test(tokenHash) || !Number.isFinite(now)) {
			return refusal(400, 'Bad request')
		}
		let accepted
		try {
			accepted = await this.#kernel.execute(build, streamAccept, { tokenHash, now })
		} catch (error) {
			if (toStoreUnavailable(error) !== undefined) {
				return refusal(503, 'Service Unavailable')
			}
			throw error
		}
		if (accepted.status !== 'ok') {
			return refusal(401, 'Invalid access token')
		}
		const { accountId } = accepted
		if (this.#open(accountTag(accountId)).length >= STREAM_LIMITS.socketsPerAccount) {
			return refusal(429, 'Too many connections')
		}
		if (this.#open().length >= STREAM_LIMITS.socketsPerInstance) {
			return refusal(503, 'Too many connections')
		}
		const { 0: client, 1: server } = new WebSocketPair()
		this.#ctx.acceptWebSocket(server, [accountTag(accountId), `t:${tokenHash}`])
		const at: Attachment = {
			v: 1,
			tokenHash,
			accountId,
			grant: accepted.grant,
			since: accepted.since,
			convSeq: 0,
			rate: { window: Date.now(), count: 0 },
			subs: [],
		}
		server.serializeAttachment(at)
		// ?stream= (with tag and list) subscribes on connect, as a first message would, uncounted.
		const stream = url.searchParams.get('stream')
		if (stream !== null) {
			await this.#subscribe(server, at, {
				stream,
				tag: url.searchParams.get('tag'),
				list: url.searchParams.get('list'),
			})
		}
		return new Response(null, { status: 101, webSocket: client })
	}

	// Mastodon's order (subscribeWebsocketToChannel): the scope first, then the stream and its parameter (a list must be
	// the account's), and a stream already subscribed is ignored. There is no acknowledgement; a refusal is an error
	// message.
	async #subscribe(ws: WebSocket, at: Attachment, json: Record<string, unknown>): Promise<void> {
		const name = firstParam(json.stream)
		if (!maySubscribe(at.grant, name)) {
			return send(ws, { error: 'Access token does not have the required scopes', status: 401 })
		}
		const stream = SERVED_STREAMS.find((served) => served === name)
		if (stream === undefined) {
			return send(ws, { error: 'Unknown stream type', status: 400 })
		}
		let key: string = stream
		if (stream === 'list') {
			if (json.list === undefined || json.list === null || json.list === '') {
				return send(ws, { error: 'Missing list name parameter', status: 400 })
			}
			if (typeof json.list !== 'string' || !LIST_ID.test(json.list)) {
				return send(ws, { error: 'Invalid parameter', status: 400 })
			}
			key = listKey(json.list)
		}
		if (at.subs.includes(key)) {
			return
		}
		const next: Attachment = { ...at, subs: [...at.subs, key] }
		// The account's keys with this socket's as they would be.
		const keys = this.#keys(at.accountId, ws)
		for (const sub of next.subs) {
			keys.set(sub, (keys.get(sub) ?? 0) + 1)
		}
		if (
			next.subs.length > STREAM_LIMITS.subscriptionsPerSocket ||
			keys.size > STREAM_LIMITS.keysPerAccount ||
			exceeds(JSON.stringify(next), STREAM_LIMITS.attachmentBytes)
		) {
			return send(ws, { error: 'Too many subscriptions', status: 429 })
		}
		// The registry first: a subscription it does not hold would journal nothing for the account. A refused write (a
		// dump's freeze, maintenance) leaves the socket unsubscribed and says so, as Mastodon answers an unexpected
		// failure, so the client subscribes again.
		let registered
		try {
			const list = keyList(key)
			if (list !== null && !(await this.#run(streamListOwned, { accountId: at.accountId, listId: list }))) {
				return send(ws, { error: 'Not authorized to stream this list', status: 401 })
			}
			registered = await this.#run(streamRegister, { accountId: at.accountId, keys: keysOf(keys) })
		} catch (error) {
			console.warn({ event: 'kopje.stream.register-failed', ...errorFields(error) })
			return send(ws, { error: 'An unexpected error occurred', status: 500 })
		}
		// On the attachment as it is now (a turn may have raised its convSeq meanwhile); `direct` starts at the mark.
		this.#update(ws, (current) => ({
			...current,
			subs: current.subs.includes(key) ? current.subs : [...current.subs, key],
			convSeq: key === 'direct' ? (registered.convSeq ?? 0) : current.convSeq,
		}))
	}

	// Mastodon's unsubscribeWebsocketFromChannel: a stream it cannot resolve answers its one unsubscribe error.
	async #unsubscribe(ws: WebSocket, at: Attachment, json: Record<string, unknown>): Promise<void> {
		const name = firstParam(json.stream)
		const missing = (name === 'list' && !json.list) || ((name === 'hashtag' || name === 'hashtag:local') && !json.tag)
		if (!STREAM_NAMES.includes(name) || missing) {
			return send(ws, { error: 'Error unsubscribing from channel' })
		}
		const key = name === 'list' ? listKey(String(json.list)) : name
		if (!at.subs.includes(key)) {
			return
		}
		this.#update(ws, (current) => ({ ...current, subs: current.subs.filter((sub) => sub !== key) }))
		await this.#sync(at.accountId)
	}

	// Rewrites a socket's attachment from its current one (an await may have let another handler or a turn write it).
	#update(ws: WebSocket, change: (at: Attachment) => Attachment): void {
		const current = peek(ws)
		if (current !== null) {
			ws.serializeAttachment(change(current))
		}
	}

	async #drop(ws: WebSocket, at: Attachment, code: number, reason: string): Promise<void> {
		close(ws, code, reason)
		await this.#sync(at.accountId, ws)
	}

	// The stream keys of an account's open sockets and how many sockets subscribe to each, but `except`.
	#keys(accountId: string, except?: WebSocket): Map<string, number> {
		const keys = new Map<string, number>()
		for (const { ws, at } of this.#open(accountTag(accountId))) {
			if (ws !== except) {
				for (const sub of at.subs) {
					keys.set(sub, (keys.get(sub) ?? 0) + 1)
				}
			}
		}
		return keys
	}

	// Records an account's stream keys from its open sockets (but `closing`). A refusal (maintenance) is logged: the
	// first turn after the Store restarts rebuilds the registry.
	async #sync(accountId: string, closing?: WebSocket): Promise<void> {
		try {
			await this.#run(streamRegister, { accountId, keys: keysOf(this.#keys(accountId, closing)) })
		} catch (error) {
			console.warn({ event: 'kopje.stream.register-failed', ...errorFields(error) })
		}
	}

	// The open sockets (of a tag) with valid attachments; an invalid one is closed (1011).
	#open(tag?: string): Socket[] {
		return this.#ctx.getWebSockets(tag).flatMap((ws) => {
			if (ws.readyState !== WebSocket.OPEN) {
				return []
			}
			const at = this.#restore(ws)
			return at === null ? [] : [{ ws, at }]
		})
	}

	// A socket's attachment, or null after closing it (1011) for one that does not validate: its account is unknown, so
	// the next turn rebuilds the registry.
	#restore(ws: WebSocket): Attachment | null {
		const at = peek(ws)
		if (at === null) {
			close(ws, 1011, 'invalid state')
			this.#reconciled = false
		}
		return at
	}

	#run<I, O>(operation: StoreOperation<I, O>, input: I): Promise<O> {
		return this.#kernel.execute(this.#kernel.build, operation, input)
	}

	#request(): void {
		if (this.#running) {
			this.#again = true
			return
		}
		if (this.#pending !== null) {
			return
		}
		const seq = ++this.#requests
		this.#pending = seq
		this.#ctx.waitUntil(
			this.#turnRequest({ [TURN_HEADER]: String(seq) })
				.then((response) => response.body?.cancel())
				.catch((error: unknown) => {
					console.warn({ event: 'kopje.stream.turn-request-failed', ...errorFields(error) })
				})
				.finally(() => {
					if (this.#pending === seq) {
						this.#pending = null
					}
					this.#notify()
				})
		)
	}

	#notify(): void {
		for (const resolve of this.#idle.splice(0)) {
			resolve()
		}
	}

	async #turn(request: Request): Promise<Response> {
		if (this.#pending === Number(request.headers.get(TURN_HEADER))) {
			this.#pending = null
		}
		if (this.#running) {
			this.#again = true
			return new Response(null, { status: 202 })
		}
		this.#running = true
		this.#again = false
		this.#turns++
		let more = false
		try {
			more = await this.#fanOut(new Budget(TURN_BUDGET))
			this.#failed = false
		} catch (error) {
			this.#failed = true
			if (toStoreUnavailable(error) !== undefined) {
				// The Store refuses its own operations (an import, a schema not current): the sockets cannot be served.
				this.closeAll(1012, 'service restart')
			}
			console.error({ event: 'kopje.stream.turn-failed', ...errorFields(error) })
		} finally {
			this.#running = false
		}
		if (more || this.#again) {
			if (STREAM_FAULTS.dropContinuation === null) {
				this.#request()
			} else {
				STREAM_FAULTS.dropContinuation()
			}
		}
		this.#notify()
		return new Response(null, { status: 204 })
	}

	// One turn. Returns whether work is left for the next.
	async #fanOut(budget: Budget): Promise<boolean> {
		if (!this.#reconciled) {
			await this.#reconcile()
		}
		await this.#sweep(budget)
		let full = false
		for (;;) {
			if (!budget.covers(UNIT_WORST)) {
				return true
			}
			const scan = await this.#run(streamEvents, { limit: SCAN })
			budget.charge({ checks: 1 })
			if (!full && scan.head - scan.tail >= JOURNAL_SPAN - 1) {
				full = true
				console.warn({ event: 'kopje.stream.journal-full', head: scan.head, tail: scan.tail })
			}
			const state: Walk = { from: scan.position, skipTo: null, ceiling: scan.ceiling }
			for (const event of scan.events) {
				const outcome = await this.#event(event, state, budget)
				if (outcome !== 'next') {
					return outcome === 'budget'
				}
			}
			if (!(await this.#flush(state))) {
				return false
			}
			if (scan.events.length < SCAN) {
				const { from } = state
				const finished = from.account === null ? from.event : from.event - 1
				// What is left to prune takes further turns, a bounded batch each.
				return (await this.#run(streamPrune, { upTo: finished })).more
			}
		}
	}

	// The units of one event, sent in order from the position. A delete's are read a page of viewers at a time, each
	// page charged to the turn, so neither the work nor the memory of a turn grows with the capture. What was read and
	// had nothing to send (an event, or a page of a delete's viewers, whose viewers have no socket that takes it) is
	// passed over by a pending position (`skipTo`), written before the next unit, at the end of the scan, and before the
	// turn stops for its budget, so every turn that read something moves the position. Returns whether the walk goes on
	// to the next event, stops for the budget, or lost the position to another turn.
	async #event(event: StreamEvent, state: Walk, budget: Budget): Promise<'next' | 'budget' | 'lost'> {
		const stop = async () => ((await this.#flush(state)) ? 'budget' : 'lost')
		let after: StreamUnitAfter =
			state.from.event === event.id && state.from.account !== null
				? { account: state.from.account, subject: state.from.subject }
				: null
		for (let more = true; more;) {
			let units: Unit[]
			if (event.kind === 'delete') {
				if (!budget.covers(UNIT_WORST)) {
					return stop()
				}
				const page = await this.#run(streamDeleteUnits, {
					eventId: event.id,
					statusId: event.subject,
					after,
					rows: DELETE_PAGE,
				})
				budget.charge({ checks: 1 })
				units = this.#units(event, page.units)
				after = page.next
				more = page.next !== null
			} else if (event.kind === 'conversation') {
				if (!budget.covers(UNIT_WORST)) {
					return stop()
				}
				const sockets = this.#directSockets(event.subject)
				units = []
				if (sockets.length > 0) {
					if (after === null) {
						// Entering the event fixes its ceiling; a change after it goes to the owner's next row.
						if (!(await this.#flush(state))) {
							return 'lost'
						}
						const ceiling = await this.#run(streamEnterConversation, {
							from: state.from,
							eventId: event.id,
							owner: event.subject,
						})
						if (ceiling === null) {
							return 'lost'
						}
						state.from = { event: event.id, subject: 0, account: event.subject }
						state.ceiling = ceiling
						after = { account: event.subject, subject: 0 }
					}
					units = await this.#conversationUnits(event.subject, sockets, after.subject, state.ceiling)
					budget.charge({ checks: 1 })
				}
				after = null
				more = false
			} else {
				units = this.#units(
					event,
					event.viewers.map((viewer) => ({ viewer, subject: { index: 0, id: event.subject } }))
				)
				// The event's viewers after the position were all read: none is left to pass over.
				after = null
				more = false
			}
			for (const [i, unit] of units.entries()) {
				if (!budget.covers(UNIT_WORST)) {
					return stop()
				}
				if (!(await this.#flush(state))) {
					return 'lost'
				}
				// The event's last unit moves the position past the event directly.
				const last = !more && i === units.length - 1
				const to = {
					event: event.id,
					subject: last ? 0 : unit.subject.index,
					account: last ? null : unit.viewer,
				}
				if (!(await this.#unit(event, unit, state.from, to, budget))) {
					return 'lost'
				}
				state.from = to
			}
			// The page's viewers are done: the next page starts after its last, sent to or not.
			if (after !== null) {
				state.skipTo = { event: event.id, subject: after.subject, account: after.account }
			}
		}
		if (state.from.event !== event.id || state.from.account !== null) {
			state.skipTo = { event: event.id, subject: 0, account: null }
		}
		return 'next'
	}

	// Writes the pending position, if any. False when another turn moved the position first.
	async #flush(state: Walk): Promise<boolean> {
		if (state.skipTo === null) {
			return true
		}
		if (!(await this.#run(streamAdvance, { from: state.from, to: state.skipTo }))) {
			return false
		}
		state.from = state.skipTo
		state.skipTo = null
		return true
	}

	// The units an event's candidates make, in order: each viewer with an open socket that opened before the event and
	// has a subscription that may carry it, with the lists those sockets subscribe to (of a delete's, those its capture
	// allowed).
	#units(
		event: StreamEvent,
		candidates: readonly { viewer: string; subject: StreamSubject; lists?: readonly string[] }[]
	): Unit[] {
		// A viewer's sockets are selected once for all its subjects (a delete has up to 41 each).
		const selected = new Map<string, { sockets: Socket[]; lists: Set<string> }>()
		return candidates.flatMap(({ viewer, subject, lists }) => {
			let found = selected.get(viewer)
			if (found === undefined) {
				const sockets = this.#open(accountTag(viewer)).filter(
					({ at }) => at.since < event.id && at.subs.some((sub) => mayCarry(event.kind, at.grant, sub))
				)
				const subscribed = sockets.flatMap(({ at }) => at.subs.flatMap((sub) => keyList(sub) ?? []))
				found = { sockets, lists: new Set(subscribed) }
				selected.set(viewer, found)
			}
			const { sockets, lists: subscribed } = found
			const unitLists = lists === undefined ? [...subscribed] : lists.filter((list) => subscribed.has(list))
			return sockets.length === 0 ? [] : [{ subject, viewer, sockets, lists: unitLists.sort() }]
		})
	}

	// A conversation event's units (its subject is the owner): the owner's newest changes (CONVERSATIONS_PER_TURN, older
	// ones skipped) above the lowest convSeq of its `direct` sockets and above the position within the event, and at most
	// the event's ceiling (fixed when the fan-out entered it, so a turn that resumes the event never reads a change
	// written since: that one has the owner's next row), oldest of them first, each one conversation, its subject index
	// the change's sequence. A unit goes to the sockets whose convSeq is below its change. A socket's `since` does not
	// apply: its convSeq, set from the owner's mark when it subscribed, says what it has been sent, and a change written
	// after it opened may join a row journaled before.
	async #conversationUnits(owner: string, sockets: Socket[], position: number, ceiling: number): Promise<Unit[]> {
		const lowest = Math.min(...sockets.map(({ at }) => at.convSeq))
		const changes = await this.#run(streamConversations, {
			accountId: owner,
			after: Math.max(lowest, position),
			upTo: ceiling,
			limit: CONVERSATIONS_PER_TURN,
		})
		return changes
			.map(({ id, seq }) => ({
				subject: { index: seq, id },
				viewer: owner,
				sockets: sockets.filter(({ at }) => at.convSeq < seq),
				lists: [],
			}))
			.filter((unit) => unit.sockets.length > 0)
	}

	// The owner's open sockets subscribed to `direct`.
	#directSockets(owner: string): Socket[] {
		return this.#open(accountTag(owner)).filter(
			({ at }) => mayCarry('conversation', at.grant, 'direct') && at.subs.includes('direct')
		)
	}

	// One unit: made in its own transaction (tokens checked, the reference reads, the presentation), the position moved
	// past it (and, for a conversation, the convSeq of the sockets it goes to raised to its change), then sent. Returns
	// false when another turn moved the position first.
	async #unit(
		event: StreamEvent,
		unit: Unit,
		from: StreamPosition,
		to: StreamPosition,
		budget: Budget
	): Promise<boolean> {
		const { kind } = event
		const tokenHashes = [...new Set(unit.sockets.map(({ at }) => at.tokenHash))]
		const made = await this.#run(streamUnit, {
			kind,
			subject: unit.subject.id,
			accountId: unit.viewer,
			tokenHashes,
			lists: unit.lists,
			now: Date.now(),
		})
		budget.charge({ checks: tokenHashes.length + made.checks })
		let payload: string | null = null
		if (made.streams.length > 0) {
			payload = JSON.stringify(typeof made.payload === 'string' ? made.payload : JSON.stringify(made.payload))
			if (typeof made.payload !== 'string') {
				budget.charge({ presentations: 1, bytes: payload.length })
			}
			if (exceeds(payload, STREAM_LIMITS.payloadBytes)) {
				console.warn({ event: 'kopje.stream.payload-skipped', kind })
				payload = null
			}
		}
		const revoked: Socket[] = []
		const messages: { ws: WebSocket; text: string }[] = []
		// One envelope per stream: every socket of the unit is sent the same presentation.
		const envelopes = new Map<string, string>()
		for (const socket of unit.sockets) {
			const grant = made.grants[socket.at.tokenHash]
			if (grant === undefined) {
				revoked.push(socket)
				continue
			}
			if (payload !== null) {
				for (const sub of socket.at.subs) {
					const target = made.streams.find(({ stream }) => stream === sub)
					if (target !== undefined && grants(grant, target.needs)) {
						let text = envelopes.get(sub)
						if (text === undefined) {
							text = envelope(sub, made.event, payload)
							envelopes.set(sub, text)
						}
						messages.push({ ws: socket.ws, text })
					}
				}
			}
		}
		if (!(await this.#run(streamAdvance, { from, to }))) {
			return false
		}
		if (kind === 'conversation') {
			for (const { ws } of unit.sockets) {
				this.#update(ws, (at) => ({ ...at, convSeq: Math.max(at.convSeq, unit.subject.index) }))
			}
		}
		let sent = 0
		try {
			for (; sent < messages.length; sent++) {
				messages[sent]!.ws.send(messages[sent]!.text)
				budget.charge({ sends: 1 })
			}
		} catch (error) {
			console.warn({ event: 'kopje.stream.send-failed', ...errorFields(error) })
			for (const { ws } of messages.slice(sent)) {
				close(ws, 1011, 'send failed')
			}
		}
		await this.#revoke(revoked)
		return true
	}

	// Closes the sockets whose tokens are no longer valid (1008), then records their accounts' keys.
	async #revoke(sockets: Socket[]): Promise<void> {
		for (const { ws } of sockets) {
			close(ws, 1008, 'token revoked')
		}
		for (const accountId of new Set(sockets.map(({ at }) => at.accountId))) {
			await this.#sync(accountId)
		}
	}

	// Every open socket's token, checked at the start of each turn (VIS-26).
	async #sweep(budget: Budget): Promise<void> {
		const open = this.#open()
		const pairs = new Map(open.map(({ at }) => [at.tokenHash, at.accountId]))
		if (pairs.size === 0) {
			return
		}
		const valid = new Set(
			await this.#run(streamTokens, {
				sockets: [...pairs].map(([tokenHash, accountId]) => ({ tokenHash, accountId })),
				now: Date.now(),
			})
		)
		budget.charge({ checks: pairs.size })
		await this.#revoke(open.filter(({ at }) => !valid.has(at.tokenHash)))
	}

	async #reconcile(): Promise<void> {
		const accounts = new Map<string, Map<string, number>>()
		for (const { at } of this.#open()) {
			const keys = accounts.get(at.accountId) ?? new Map<string, number>()
			for (const sub of at.subs) {
				keys.set(sub, (keys.get(sub) ?? 0) + 1)
			}
			accounts.set(at.accountId, keys)
		}
		await this.#run(streamReconcile, {
			accounts: [...accounts].map(([accountId, keys]) => ({ accountId, keys: keysOf(keys) })),
		})
		this.#reconciled = true
	}
}

const TOKEN_HASH = /^[0-9a-f]{64}$/

// Whether a token's grant has every scope `needs` names.
function grants(grant: StreamGrant, needs: StreamGrant): boolean {
	return (!needs.statuses || grant.statuses) && (!needs.notifications || grant.notifications)
}

function accountTag(accountId: string): string {
	return `a:${accountId}`
}

function keysOf(keys: Map<string, number>): StreamKeys {
	return [...keys].map(([key, sockets]) => ({ key, sockets }))
}

// The attachment of a socket, validated: version, field types and sizes. Null for anything else.
function peek(ws: WebSocket): Attachment | null {
	let value: unknown
	try {
		value = ws.deserializeAttachment()
	} catch {
		return null
	}
	if (typeof value !== 'object' || value === null) {
		return null
	}
	const at = value as Partial<Record<keyof Attachment, unknown>>
	const grant = at.grant as Partial<Record<keyof StreamGrant, unknown>> | null | undefined
	const rate = at.rate as Partial<Record<'window' | 'count', unknown>> | null | undefined
	const subs = at.subs
	const valid =
		at.v === 1 &&
		typeof at.tokenHash === 'string' &&
		TOKEN_HASH.test(at.tokenHash) &&
		typeof at.accountId === 'string' &&
		/^\d{1,19}$/.test(at.accountId) &&
		typeof grant === 'object' &&
		grant !== null &&
		typeof grant.statuses === 'boolean' &&
		typeof grant.notifications === 'boolean' &&
		Number.isSafeInteger(at.since) &&
		Number.isSafeInteger(at.convSeq) &&
		typeof rate === 'object' &&
		rate !== null &&
		Number.isFinite(rate.window) &&
		Number.isSafeInteger(rate.count) &&
		Array.isArray(subs) &&
		subs.length <= STREAM_LIMITS.subscriptionsPerSocket &&
		new Set(subs).size === subs.length &&
		subs.every((sub) => typeof sub === 'string' && validKey(sub))
	return valid ? (value as Attachment) : null
}

// A list id as a `list` parameter may name one (Kopje's are 18 digits; Mastodon's at most 19).
const LIST_ID = /^\d{1,19}$/

// Whether `key` is a subscription key Kopje serves: a served stream's name, or `list:<id>`.
function validKey(key: string): boolean {
	const list = keyList(key)
	return list === null ? SERVED_STREAMS.includes(key as ServedStream) && key !== 'list' : LIST_ID.test(list)
}

// A message's `stream`: its first element if it is an array (streaming/utils.js firstParam), as a string.
function firstParam(value: unknown): string {
	const first: unknown = Array.isArray(value) ? value[0] : value
	return typeof first === 'string' ? first : ''
}

// A client message: a JSON object, or null (Mastodon ignores what it cannot parse).
function parseObject(text: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(text)
		return typeof value === 'object' && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null
	} catch {
		return null
	}
}

// An outgoing message (streaming/index.js streamToWs): the stream as the client named it (a list's as `["list", id]`,
// the id as the client sent it), the event, and the payload, a JSON string already encoded once for all envelopes.
function envelope(key: string, event: string, encodedPayload: string): string {
	const list = keyList(key)
	const stream = list === null ? [key] : ['list', list]
	return `{"stream":${JSON.stringify(stream)},"event":${JSON.stringify(event)},"payload":${encodedPayload}}`
}

function send(ws: WebSocket, message: Record<string, unknown>): void {
	try {
		ws.send(JSON.stringify(message))
	} catch (error) {
		console.warn({ event: 'kopje.stream.send-failed', ...errorFields(error) })
	}
}

function close(ws: WebSocket, code: number, reason: string): void {
	try {
		ws.close(code, reason)
	} catch {
		// Already closed.
	}
}

// Whether `text` is longer than `limit` bytes of UTF-8. Each UTF-16 unit is one to three bytes, so a text too long or
// short enough by its length is never encoded.
function exceeds(text: string, limit: number): boolean {
	return text.length > limit || (text.length * 3 > limit && new TextEncoder().encode(text).byteLength > limit)
}

// Mastodon's answer to a refused upgrade: the status, no body, and the message in X-Error-Message.
function refusal(status: number, message: string): Response {
	return new Response(null, { status, headers: { 'x-error-message': message } })
}
