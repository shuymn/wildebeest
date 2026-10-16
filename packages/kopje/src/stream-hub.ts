import {
	JOURNAL_SPAN,
	mayCarry,
	maySubscribe,
	SERVED_STREAMS,
	type ServedStream,
	STREAM_NAMES,
	STREAM_OPERATIONS,
	streamAccept,
	streamAdvance,
	streamCaughtUp,
	type StreamEvent,
	type StreamGrant,
	streamEvents,
	type StreamKeys,
	type StreamPosition,
	streamPrune,
	type StreamSubject,
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

type Charge = { checks: number; presentations: number; bytes: number; sends: number }

// What one turn may do, and what one unit may do at most: 16 token checks and the reference reads of 16 keys and a
// mention (design §4.4; this release reads at most two: home and the mention), one presentation, and a send to each
// of 16 subscriptions on each of 16 sockets.
export const TURN_BUDGET: Charge = { checks: 512, presentations: 64, bytes: 4 * 1024 * 1024, sends: 4096 }
const UNIT_WORST: Charge = { checks: 33, presentations: 1, bytes: STREAM_LIMITS.payloadBytes, sends: 256 }

// Journal events read per scan of a turn.
const SCAN = 64

const TURN_URL = 'https://store.internal/stream/turn'
const TURN_HEADER = 'x-kopje-turn'

// A socket's state (design §4.5). since: the journal head when it opened (it receives later events only); rate: the
// minute its message count started; subs: its subscriptions, in order.
type Attachment = {
	v: 1
	tokenHash: string
	accountId: string
	grant: StreamGrant
	since: number
	rate: { window: number; count: number }
	subs: ServedStream[]
}

type Socket = { ws: WebSocket; at: Attachment }

// One subject of an event for one viewer, with the viewer's sockets that may carry it.
type Unit = { subject: StreamSubject; viewer: string; sockets: Socket[] }

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

	// Mastodon's order (subscribeWebsocketToChannel): the scope first, then the stream, and a stream already subscribed
	// is ignored. There is no acknowledgement; a refusal is an error message.
	async #subscribe(ws: WebSocket, at: Attachment, json: Record<string, unknown>): Promise<void> {
		const name = firstParam(json.stream)
		if (!maySubscribe(at.grant, name)) {
			return send(ws, { error: 'Access token does not have the required scopes', status: 401 })
		}
		const stream = SERVED_STREAMS.find((served) => served === name)
		if (stream === undefined) {
			return send(ws, { error: 'Unknown stream type', status: 400 })
		}
		if (at.subs.includes(stream)) {
			return
		}
		const next: Attachment = { ...at, subs: [...at.subs, stream] }
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
		try {
			await this.#run(streamRegister, { accountId: at.accountId, keys: keysOf(keys) })
		} catch (error) {
			console.warn({ event: 'kopje.stream.register-failed', ...errorFields(error) })
			return send(ws, { error: 'An unexpected error occurred', status: 500 })
		}
		ws.serializeAttachment(next)
	}

	// Mastodon's unsubscribeWebsocketFromChannel: a stream it cannot resolve answers its one unsubscribe error.
	async #unsubscribe(ws: WebSocket, at: Attachment, json: Record<string, unknown>): Promise<void> {
		const name = firstParam(json.stream)
		const missing = (name === 'list' && !json.list) || ((name === 'hashtag' || name === 'hashtag:local') && !json.tag)
		if (!STREAM_NAMES.includes(name) || missing) {
			return send(ws, { error: 'Error unsubscribing from channel' })
		}
		if (!at.subs.some((sub) => sub === name)) {
			return
		}
		ws.serializeAttachment({ ...at, subs: at.subs.filter((sub) => sub !== name) })
		await this.#sync(at.accountId)
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
			this.#request()
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
			let from = scan.position
			// Events no open socket takes are passed over with one position write, before the next unit or at the end.
			let skipTo: StreamPosition | null = null
			for (const event of scan.events) {
				const units = this.#units(event)
				if (units.length === 0) {
					skipTo = { event: event.id, subject: 0, account: null }
					continue
				}
				if (skipTo !== null) {
					if (!(await this.#run(streamAdvance, { from, to: skipTo }))) {
						return false
					}
					from = skipTo
					skipTo = null
				}
				for (const [i, unit] of units.entries()) {
					if (!budget.covers(UNIT_WORST)) {
						return true
					}
					const to = {
						event: event.id,
						subject: unit.subject.index,
						account: i === units.length - 1 ? null : unit.viewer,
					}
					if (!(await this.#unit(event, unit, from, to, budget))) {
						return false
					}
					from = to
				}
			}
			if (skipTo !== null) {
				if (!(await this.#run(streamAdvance, { from, to: skipTo }))) {
					return false
				}
				from = skipTo
			}
			if (scan.events.length < SCAN) {
				const finished = from.account === null ? from.event : from.event - 1
				await this.#run(streamPrune, { upTo: finished })
				return false
			}
		}
	}

	// The units of an event in order: for each subject, each viewer the journal names with an open socket that opened
	// before the event and has a subscription that may carry it.
	#units(event: StreamEvent): Unit[] {
		return event.subjects.flatMap((subject) =>
			subject.viewers.flatMap((viewer) => {
				const sockets = this.#open(accountTag(viewer)).filter(
					({ at }) => at.since < event.id && at.subs.some((sub) => mayCarry(event.kind, at.grant, sub))
				)
				return sockets.length === 0 ? [] : [{ subject, viewer, sockets }]
			})
		)
	}

	// One unit: made in its own transaction (tokens checked, the reference reads, the presentation), the position moved
	// past it, then sent. Returns false when another turn moved the position first.
	async #unit(
		event: StreamEvent,
		unit: Unit,
		from: StreamPosition,
		to: StreamPosition,
		budget: Budget
	): Promise<boolean> {
		const tokenHashes = [...new Set(unit.sockets.map(({ at }) => at.tokenHash))]
		const made = await this.#run(streamUnit, {
			kind: event.kind,
			subject: unit.subject.id,
			accountId: unit.viewer,
			tokenHashes,
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
				console.warn({ event: 'kopje.stream.payload-skipped', kind: event.kind })
				payload = null
			}
		}
		const revoked: Socket[] = []
		const messages: { ws: WebSocket; text: string }[] = []
		// One envelope per stream: every socket of the unit is sent the same presentation.
		const envelopes = new Map<ServedStream, string>()
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
		typeof rate === 'object' &&
		rate !== null &&
		Number.isFinite(rate.window) &&
		Number.isSafeInteger(rate.count) &&
		Array.isArray(subs) &&
		subs.length <= STREAM_LIMITS.subscriptionsPerSocket &&
		new Set(subs).size === subs.length &&
		subs.every((sub) => SERVED_STREAMS.includes(sub as ServedStream))
	return valid ? (value as Attachment) : null
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

// An outgoing message (streaming/index.js streamToWs): the stream as the client named it, the event, and the payload,
// a JSON string already encoded once for all envelopes.
function envelope(stream: ServedStream, event: string, encodedPayload: string): string {
	return `{"stream":${JSON.stringify([stream])},"event":${JSON.stringify(event)},"payload":${encodedPayload}}`
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
