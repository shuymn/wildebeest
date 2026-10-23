import { dnsCheckHost } from './loader'
import { type BodyPrefix, readBodyPrefix } from '../platform/body'
import { hostDomain } from '../platform/domain-name'
import { type CharsetSource, chooseCharset } from '../platform/html-charset'
import { type PageScan, type ScanLimits, type Scanner, scanHtml } from '../platform/html-scan'
import { type PublicShapeViolation, publicShapeViolation } from '../platform/http-url'
import { withinJsonBounds } from '../platform/json-bounds'
import { parseMediaType } from '../platform/media-type'

// The web-page sink (NET-3 in docs/threat-model.md): an unsigned GET of a public https HTML page, read as a bounded
// prefix and scanned (platform/html-scan.ts), its JSON mode (a GET of a whole bounded JSON document, for a card's
// oEmbed endpoint), its image mode (a GET of a whole bounded body, for a card's image), and a HEAD probe that reads
// one redirect's Location without following it, for Mastodon's link verification and link cards. NET-3 states the hop order (URL rules, domain policy, DNS check,
// request), the gates, the budgets and the failure redaction. The DNS check does not pin the address: production
// deps.fetch must be the Worker's global fetch, never a service binding (NET-1 makes it strictly public).

export const WEB_PAGE_BODY_LIMIT = 1024 * 1024
// The JSON mode's whole body, in bytes after workerd's Content-Encoding decoding: a longer one is refused unparsed.
export const WEB_JSON_BODY_LIMIT = 64 * 1024
export const WEB_PAGE_TIMEOUT_MS = 10_000
export const REDIRECT_PROBE_TIMEOUT_MS = 5000
export const WEB_PAGE_MAX_REDIRECTS = 3
export const WEB_PAGE_URL_LIMIT = 2048
// Fedify's validatePublicUrl looks a name up with dns.lookup({ all: true }), which workerd serves with two DNS over
// HTTPS subrequests (A and AAAA).
export const DNS_CHECK_SUBREQUESTS = 2
export const HOP_SUBREQUESTS = DNS_CHECK_SUBREQUESTS + 1
export const WEB_PAGE_MAX_SUBREQUESTS = HOP_SUBREQUESTS * (WEB_PAGE_MAX_REDIRECTS + 1)
export const WEB_PAGE_MAX_STORE_CALLS = WEB_PAGE_MAX_REDIRECTS + 1
export const REDIRECT_PROBE_MAX_SUBREQUESTS = HOP_SUBREQUESTS
export const REDIRECT_PROBE_MAX_STORE_CALLS = 1
// A GET and its HEAD probe together, for a caller's load-time budget check (as federation/collections.ts NETWORK_CAPS).
export const WEB_PAGE_PAIR_MAX_SUBREQUESTS = WEB_PAGE_MAX_SUBREQUESTS + REDIRECT_PROBE_MAX_SUBREQUESTS
export const WEB_PAGE_PAIR_MAX_STORE_CALLS = WEB_PAGE_MAX_STORE_CALLS + REDIRECT_PROBE_MAX_STORE_CALLS

// An Accept-Language value: up to 8 language ranges with optional weights, at most 128 characters.
const ACCEPT_LANGUAGE = /^[A-Za-z0-9*-]{1,16}(;q=[01](\.\d{1,3})?)?(, ?[A-Za-z0-9*-]{1,16}(;q=[01](\.\d{1,3})?)?){0,7}$/
const ACCEPT_LANGUAGE_LIMIT = 128
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml'])
// The Content-Encoding values workerd decodes (exactly "gzip" or "br"; any other value it passes through undecoded,
// test/web-page-encoding.test.ts), and identity.
const ACCEPTED_ENCODINGS = new Set(['identity', 'gzip', 'br'])

export type WebPageDeps = {
	// Production: the Worker's global fetch, never a service binding (see above).
	fetch: typeof fetch
	checkHost?: (url: URL) => Promise<void>
	// The instance's domain policy (instance-domain-blocks.ts fetchRefused): true refuses the normalized host.
	refusesHost: (host: string) => Promise<boolean>
	userAgent: string
	now: () => number
}

// Shared by the calls of one caller's round, and spent by each synchronously, so concurrent calls cannot overspend.
export type WebPageBudget = { subrequests: number; storeCalls: number; deadline: number }

export type WebPageOptions = {
	// Each only tightens the sink's own limit.
	maxBytes?: number
	maxRedirects?: number
	timeoutMs?: number
	deadline?: number
	budget?: WebPageBudget
	signal?: AbortSignal
	acceptLanguage?: string
	scan?: Partial<ScanLimits>
}

export type RedirectProbeOptions = Pick<WebPageOptions, 'timeoutMs' | 'deadline' | 'budget' | 'signal'>

export type WebPageCost = { subrequests: number; storeCalls: number; hops: number; bytes: number }

export type WebPageRefusal =
	| 'invalid-url'
	| PublicShapeViolation
	| 'port'
	| 'trailing-dot'
	| 'url-too-long'
	| 'host-check'
	| 'bad-location'
	| 'unexpected-redirect'

export type WebPageFailureKind =
	| 'refused'
	| 'blocked'
	| 'redirects'
	| 'status'
	| 'not-html'
	| 'encoding'
	| 'unparsable'
	| 'timeout'
	| 'network'
	| 'policy'
	| 'budget'
	| 'aborted'
	| 'too-large'

// A failure names a closed kind, its reason and the hostname only: never a URL, a header or an error's message.
export type WebPageFailure = {
	ok: false
	kind: WebPageFailureKind
	reason?: WebPageRefusal | 'unsupported-encoding' | 'ambiguity' | 'memory' | 'parser' | 'json' | 'json-bounds'
	status?: number
	host: string | null
	// Whether trying again later may succeed: a timeout, a network error, a domain policy that could not be read
	// (policy), a spent budget, a failed DNS check, or an HTTP 408, 429 or 5xx.
	transient: boolean
	cost: WebPageCost
}

export type WebPage = {
	ok: true
	finalUrl: string
	redirects: number
	status: 200
	contentType: 'text/html' | 'application/xhtml+xml'
	charset: { label: string; source: CharsetSource }
	// Whether the body was longer than the prefix read; captures cut by its end are dropped by the scan.
	limitReached: boolean
	scan: PageScan
	cost: WebPageCost
}

// A JSON mode answer: the parsed document, within MAX_JSON_NODES values and MAX_JSON_DEPTH levels (json-bounds.ts).
export type WebJson = { ok: true; finalUrl: string; redirects: number; status: 200; value: unknown; cost: WebPageCost }

export type WebJsonOptions = Pick<WebPageOptions, 'maxRedirects' | 'timeoutMs' | 'deadline' | 'budget' | 'signal'>

// A HEAD answer: its status, and its Location header raw (at most WEB_PAGE_URL_LIMIT characters, else null) whatever
// the status.
export type RedirectProbe = { ok: true; status: number; location: string | null; cost: WebPageCost }

// Each hop's domain policy for a cron round's calls (link cards, profile link verification): `admit` (the Store's
// webHopRefused, a write the Store refuses in any maintenance and during a dump or import), read before the DNS
// check by the sink (refusesHost) and again after it (checkHost), so no redirect, DNS check or request starts once
// maintenance is entered. `failed` tells whether a policy RPC failed at either point (AM20), which the call's failure
// alone cannot tell: a host the policy refuses is a failure, an RPC error is one to try again. One per call, or per
// calls whose outcomes are judged together (a GET and its HEAD probe).
export function admittedHops(
	admit: (host: string) => Promise<boolean>,
	dns: (url: URL) => Promise<void> = dnsCheckHost
): { web: Pick<WebPageDeps, 'refusesHost' | 'checkHost'>; failed: () => boolean } {
	let failed = false
	const admitted = async (host: string): Promise<boolean> => {
		try {
			return await admit(host)
		} catch (error) {
			failed = true
			throw error
		}
	}
	return {
		web: {
			refusesHost: admitted,
			checkHost: async (url) => {
				await dns(url)
				if (await admitted(hostDomain(url.href))) {
					throw new Error('refused by the domain policy')
				}
			},
		},
		failed: () => failed,
	}
}

// The URL a hop requests, its fragment removed, or the rule it breaks.
function hopUrl(input: string | URL): URL | WebPageRefusal {
	let url: URL
	try {
		url = new URL(input)
	} catch {
		return 'invalid-url'
	}
	url.hash = ''
	const violation = publicShapeViolation(url)
	if (violation !== null) {
		return violation
	}
	if (url.port !== '') {
		return 'port'
	}
	if (url.hostname.endsWith('.')) {
		return 'trailing-dot'
	}
	return url.href.length > WEB_PAGE_URL_LIMIT ? 'url-too-long' : url
}

// The rule a web page URL breaks before any lookup, or null.
export function webPageUrlRefusal(input: string | URL): WebPageRefusal | null {
	const url = hopUrl(input)
	return url instanceof URL ? null : url
}

function isTransient(kind: WebPageFailureKind, reason?: string, status?: number): boolean {
	if (kind === 'timeout' || kind === 'network' || kind === 'policy' || kind === 'budget') {
		return true
	}
	if (kind === 'refused') {
		return reason === 'host-check'
	}
	return kind === 'status' && status !== undefined && (status === 408 || status === 429 || status >= 500)
}

// Thrown inside a call to end it with `failure`.
class Stop extends Error {
	constructor(readonly failure: WebPageFailure) {
		super(failure.kind)
	}
}

const TIMED_OUT = Symbol('timed out')
const ABORTED = Symbol('aborted')

type Ceiling = { subrequests: number; storeCalls: number }

// One call's state: its deadline and abort, its terminal failure, and what it spent.
class Call {
	readonly controller = new AbortController()
	readonly cost: WebPageCost = { subrequests: 0, storeCalls: 0, hops: 0, bytes: 0 }
	host: string | null = null
	private terminal: WebPageFailure | null = null
	private readonly stopped: Promise<never>
	private timer: ReturnType<typeof setTimeout> | undefined
	private readonly onAbort = () => this.controller.abort(ABORTED)

	constructor(
		private readonly now: () => number,
		private readonly deadline: number,
		private readonly ceiling: Ceiling,
		private readonly budget: WebPageBudget | undefined,
		private readonly signal: AbortSignal | undefined
	) {
		this.stopped = new Promise<never>((_, reject) => {
			this.controller.signal.addEventListener('abort', () => reject(this.stopFor()), { once: true })
		})
		this.stopped.catch(() => {})
		if (signal?.aborted) {
			this.controller.abort(ABORTED)
		} else {
			signal?.addEventListener('abort', this.onAbort, { once: true })
			this.timer = setTimeout(() => this.controller.abort(TIMED_OUT), Math.max(0, deadline - now()))
		}
	}

	failure(kind: WebPageFailureKind, extra: Pick<WebPageFailure, 'reason' | 'status'> = {}): WebPageFailure {
		return {
			ok: false,
			kind,
			...extra,
			host: this.host,
			transient: isTransient(kind, extra.reason, extra.status),
			cost: this.cost,
		}
	}

	// Ends the call with `failure`, unless it has ended already.
	stop(kind: WebPageFailureKind, extra?: Pick<WebPageFailure, 'reason' | 'status'>): never {
		this.terminal ??= this.failure(kind, extra)
		this.controller.abort(this.terminal)
		throw new Stop(this.terminal)
	}

	private stopFor(): Stop {
		const reason: unknown = this.controller.signal.reason
		if (this.terminal === null) {
			this.terminal = this.failure(reason === ABORTED ? 'aborted' : 'timeout')
		}
		return new Stop(this.terminal)
	}

	// Throws unless the call may go on: not ended, not aborted, before its deadline.
	gate(): void {
		if (this.terminal !== null) {
			throw new Stop(this.terminal)
		}
		if (this.controller.signal.aborted) {
			throw this.stopFor()
		}
		if (this.now() >= this.deadline) {
			this.stop('timeout')
		}
	}

	// Takes `n` from the call's ceiling and the shared budget, both or neither, before the step it pays for.
	charge(category: 'subrequests' | 'storeCalls', n: number): void {
		this.gate()
		if (this.cost[category] + n > this.ceiling[category] || (this.budget !== undefined && this.budget[category] < n)) {
			this.stop('budget')
		}
		if (this.budget !== undefined) {
			this.budget[category] -= n
		}
		this.cost[category] += n
	}

	// Awaits `work`, given up when the call ends; then gates again.
	async guarded<T>(work: Promise<T>): Promise<T> {
		work.catch(() => {})
		let result: T
		try {
			result = await Promise.race([work, this.stopped])
		} catch (error) {
			// Work that rejects because the call ended (an aborted fetch or scan) ends it as the call's own failure.
			if (!(error instanceof Stop) && this.controller.signal.aborted) {
				throw this.stopFor()
			}
			throw error
		}
		this.gate()
		return result
	}

	close(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer)
		}
		this.signal?.removeEventListener('abort', this.onAbort)
		if (!this.controller.signal.aborted) {
			this.controller.abort(ABORTED)
		}
	}
}

function clampLimit(given: number | undefined, limit: number): number {
	return given === undefined || !Number.isFinite(given) ? limit : Math.max(0, Math.min(limit, Math.floor(given)))
}

function startCall(deps: WebPageDeps, options: WebPageOptions, timeoutMs: number, ceiling: Ceiling): Call {
	const now = deps.now()
	const deadline = Math.min(
		now + clampLimit(options.timeoutMs, timeoutMs),
		options.deadline ?? Infinity,
		options.budget?.deadline ?? Infinity
	)
	return new Call(deps.now, deadline, ceiling, options.budget, options.signal)
}

function cancel(response: Response): void {
	response.body?.cancel().catch(() => {})
}

// Steps 1 to 4 of a hop; the response is the call's to read or cancel.
async function hop(
	call: Call,
	deps: WebPageDeps,
	target: string | URL,
	method: 'GET' | 'HEAD',
	headers: Headers
): Promise<{ url: URL; response: Response }> {
	const url = hopUrl(target)
	if (!(url instanceof URL)) {
		call.stop('refused', { reason: url })
	}
	call.host = url.hostname
	call.charge('storeCalls', 1)
	let blocked: boolean
	try {
		blocked = await call.guarded(deps.refusesHost(hostDomain(url.href)))
	} catch (error) {
		if (error instanceof Stop) {
			throw error
		}
		// The policy could not be read (a Store error): its message is not passed on.
		call.gate()
		call.stop('policy')
	}
	if (blocked) {
		call.stop('blocked')
	}
	call.charge('subrequests', DNS_CHECK_SUBREQUESTS)
	try {
		await call.guarded((deps.checkHost ?? dnsCheckHost)(url))
	} catch (error) {
		if (error instanceof Stop) {
			throw error
		}
		call.stop('refused', { reason: 'host-check' })
	}
	call.charge('subrequests', 1)
	call.cost.hops++
	const fetching = deps.fetch(new Request(url, { method, headers, redirect: 'manual', signal: call.controller.signal }))
	let response: Response
	try {
		response = await call.guarded(fetching)
	} catch (error) {
		if (error instanceof Stop) {
			// The call ended while the response was awaited, or as it arrived (the gate after it): it is not read.
			fetching.then(cancel, () => {})
			throw error
		}
		call.gate()
		call.stop('network')
	}
	if (response.url !== '' && response.url !== url.href) {
		cancel(response)
		call.stop('refused', { reason: 'unexpected-redirect' })
	}
	return { url, response }
}

function requestHeaders(deps: WebPageDeps, acceptLanguage: string | undefined): Headers {
	const headers = new Headers({ accept: 'text/html', 'user-agent': deps.userAgent })
	if (acceptLanguage !== undefined) {
		if (acceptLanguage.length > ACCEPT_LANGUAGE_LIMIT || !ACCEPT_LANGUAGE.test(acceptLanguage)) {
			throw new TypeError('acceptLanguage is not a bounded Accept-Language value')
		}
		headers.set('accept-language', acceptLanguage)
	}
	return headers
}

async function settle<T>(call: Call, work: () => Promise<T>): Promise<T | WebPageFailure> {
	try {
		return await work()
	} catch (error) {
		if (error instanceof Stop) {
			return error.failure
		}
		throw error
	} finally {
		call.close()
	}
}

// The sink's entry points over a scanner. Production uses fetchWebPage and probeRedirect below (scanHtml); a test
// may pass a scanner that holds a scan mid-way (createScanner). No caller passes one.
export function createWebPageSink(testHooks: { scan: Scanner }) {
	return {
		fetchWebPage: (input: string | URL, deps: WebPageDeps, options?: WebPageOptions) =>
			getPage(input, deps, options ?? {}, testHooks.scan),
		probeRedirect,
	}
}

// GETs a public https HTML page, following at most WEB_PAGE_MAX_REDIRECTS redirects (to any origin, each a hop as
// above), and scans the first WEB_PAGE_BODY_LIMIT bytes (after workerd's Content-Encoding decoding) of a 200
// text/html or application/xhtml+xml answer. Within WEB_PAGE_TIMEOUT_MS, WEB_PAGE_MAX_SUBREQUESTS and
// WEB_PAGE_MAX_STORE_CALLS, or the caller's tighter options. A failure returns nothing partial.
export function fetchWebPage(
	input: string | URL,
	deps: WebPageDeps,
	options: WebPageOptions = {}
): Promise<WebPage | WebPageFailure> {
	return getPage(input, deps, options, scanHtml)
}

// The GET hops of one call from `input`: each redirect (to any origin) followed as a hop, at most `maxRedirects`, until
// an answer that is not a redirect, which is the caller's to read or cancel.
async function follow(
	call: Call,
	deps: WebPageDeps,
	input: string | URL,
	headers: Headers,
	maxRedirects: number
): Promise<{ url: URL; response: Response; redirects: number }> {
	call.gate()
	let target: string | URL = input
	for (let redirects = 0; ; redirects++) {
		const { url, response } = await hop(call, deps, target, 'GET', headers)
		const { status } = response
		if (!REDIRECT_STATUSES.has(status) || !response.headers.has('location')) {
			return { url, response, redirects }
		}
		cancel(response)
		if (redirects >= maxRedirects) {
			call.stop('redirects', { status })
		}
		const location = response.headers.get('location') ?? ''
		let next: URL
		try {
			next = new URL(location, url)
		} catch {
			call.stop('refused', { reason: 'bad-location' })
		}
		if (location.length > WEB_PAGE_URL_LIMIT) {
			call.stop('refused', { reason: 'bad-location' })
		}
		target = next
	}
}

// Refuses a Content-Encoding the runtime would not decode, before the body is read.
function acceptEncoding(call: Call, response: Response): void {
	const encoding = response.headers.get('content-encoding')
	if (encoding !== null && !ACCEPTED_ENCODINGS.has(encoding)) {
		cancel(response)
		call.stop('encoding', { reason: 'unsupported-encoding' })
	}
}

// The body's first `maxBytes` bytes, read under the call's deadline and abort.
async function readPrefix(call: Call, response: Response, maxBytes: number, copy = true): Promise<BodyPrefix> {
	let prefix: BodyPrefix
	try {
		prefix = await readBodyPrefix(response.body, maxBytes, (read) => call.guarded(read), { copy })
	} catch (error) {
		if (error instanceof Stop) {
			throw error
		}
		// A read error that is not the call's end: a reset connection, or a corrupt gzip or br stream.
		call.gate()
		call.stop('network')
	}
	call.cost.bytes += prefix.observed
	return prefix
}

async function getPage(
	input: string | URL,
	deps: WebPageDeps,
	options: WebPageOptions,
	scanner: Scanner
): Promise<WebPage | WebPageFailure> {
	const headers = requestHeaders(deps, options.acceptLanguage)
	const maxBytes = clampLimit(options.maxBytes, WEB_PAGE_BODY_LIMIT)
	const maxRedirects = clampLimit(options.maxRedirects, WEB_PAGE_MAX_REDIRECTS)
	// Typed, so that call.stop (never) narrows.
	const call: Call = startCall(deps, options, WEB_PAGE_TIMEOUT_MS, {
		subrequests: WEB_PAGE_MAX_SUBREQUESTS,
		storeCalls: WEB_PAGE_MAX_STORE_CALLS,
	})
	return settle(call, async () => {
		const { url, response, redirects } = await follow(call, deps, input, headers, maxRedirects)
		const { status } = response
		if (status !== 200) {
			cancel(response)
			call.stop('status', { status })
		}
		const media = parseMediaType(response.headers.get('content-type') ?? '')
		if (media === null || !HTML_TYPES.has(media.essence)) {
			cancel(response)
			call.stop('not-html')
		}
		acceptEncoding(call, response)
		const prefix = await readPrefix(call, response, maxBytes)
		const charset = chooseCharset(prefix.bytes, media.parameters.get('charset') ?? null)
		const scan = await call.guarded(scanner(prefix.bytes, charset, options.scan, call.controller.signal))
		if ('failed' in scan) {
			call.stop('unparsable', { reason: scan.failed })
		}
		return {
			ok: true as const,
			finalUrl: url.href,
			redirects,
			status: 200 as const,
			contentType: media.essence as WebPage['contentType'],
			charset: { label: charset.label, source: charset.source },
			limitReached: prefix.limitReached,
			scan,
			cost: call.cost,
		}
	})
}

// The JSON mode: GETs a public https URL as fetchWebPage does (the same hops, redirects, deadline and ceilings, or the
// caller's tighter options), sending only its User-Agent (no Accept, as Mastodon's FetchOEmbedService), and parses a
// 200 answer of any content type: its whole body within WEB_JSON_BODY_LIMIT bytes after workerd's Content-Encoding
// decoding (a longer one is too-large, never parsed), decoded as UTF-8 (fatal), by JSON.parse, within
// withinJsonBounds. A body that is empty or fails any of these is unparsable (reason json or json-bounds). Peak
// memory: the body buffer and its copy (readBodyPrefix), the decoded text and the parsed value.
export async function fetchWebJson(
	input: string | URL,
	deps: WebPageDeps,
	options: WebJsonOptions = {}
): Promise<WebJson | WebPageFailure> {
	const headers = new Headers({ 'user-agent': deps.userAgent })
	const maxRedirects = clampLimit(options.maxRedirects, WEB_PAGE_MAX_REDIRECTS)
	const call: Call = startCall(deps, options, WEB_PAGE_TIMEOUT_MS, {
		subrequests: WEB_PAGE_MAX_SUBREQUESTS,
		storeCalls: WEB_PAGE_MAX_STORE_CALLS,
	})
	return settle(call, async () => {
		const { url, response, redirects } = await follow(call, deps, input, headers, maxRedirects)
		const { status } = response
		if (status !== 200) {
			cancel(response)
			call.stop('status', { status })
		}
		acceptEncoding(call, response)
		const prefix = await readPrefix(call, response, WEB_JSON_BODY_LIMIT)
		if (prefix.limitReached) {
			call.stop('too-large')
		}
		let value: unknown
		try {
			value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(prefix.bytes))
		} catch {
			call.stop('unparsable', { reason: 'json' })
		}
		if (!withinJsonBounds(value)) {
			call.stop('unparsable', { reason: 'json-bounds' })
		}
		return { ok: true as const, finalUrl: url.href, redirects, status: 200 as const, value, cost: call.cost }
	})
}

// A remote image answer (fetchWebImage): the bytes, a view over the read buffer of limit + 1 bytes (not copied).
export type WebImage = {
	ok: true
	finalUrl: string
	redirects: number
	status: 200
	bytes: Uint8Array
	cost: WebPageCost
}

export type WebImageOptions = WebJsonOptions & { maxBytes: number }

// The image mode, for a card's image (federation/card-images.ts): GETs a public https URL as fetchWebPage does (the
// same hops, redirects, deadline and ceilings, or the caller's tighter options), sending only its User-Agent, and
// reads a 200 answer of any content type (the caller judges the bytes by their signature): its body within `maxBytes`
// bytes after workerd's Content-Encoding decoding, a longer one too-large, cancelled at the first byte past it. The
// bytes are not copied (readBodyPrefix copy: false). Peak memory: the buffer of maxBytes + 1 bytes and, on the copying
// path, one incoming chunk.
export async function fetchWebImage(
	input: string | URL,
	deps: WebPageDeps,
	options: WebImageOptions
): Promise<WebImage | WebPageFailure> {
	const headers = new Headers({ 'user-agent': deps.userAgent })
	const maxRedirects = clampLimit(options.maxRedirects, WEB_PAGE_MAX_REDIRECTS)
	const call: Call = startCall(deps, options, WEB_PAGE_TIMEOUT_MS, {
		subrequests: WEB_PAGE_MAX_SUBREQUESTS,
		storeCalls: WEB_PAGE_MAX_STORE_CALLS,
	})
	return settle(call, async () => {
		const { url, response, redirects } = await follow(call, deps, input, headers, maxRedirects)
		const { status } = response
		if (status !== 200) {
			cancel(response)
			call.stop('status', { status })
		}
		acceptEncoding(call, response)
		const prefix = await readPrefix(call, response, Math.max(0, Math.floor(options.maxBytes)), false)
		if (prefix.limitReached) {
			call.stop('too-large')
		}
		return {
			ok: true as const,
			finalUrl: url.href,
			redirects,
			status: 200 as const,
			bytes: prefix.bytes,
			cost: call.cost,
		}
	})
}

// HEADs a public https URL as one hop and returns its status and raw Location without following it, within
// REDIRECT_PROBE_TIMEOUT_MS, REDIRECT_PROBE_MAX_SUBREQUESTS and REDIRECT_PROBE_MAX_STORE_CALLS.
export async function probeRedirect(
	input: string | URL,
	deps: WebPageDeps,
	options: RedirectProbeOptions = {}
): Promise<RedirectProbe | WebPageFailure> {
	const headers = requestHeaders(deps, undefined)
	const call: Call = startCall(deps, options, REDIRECT_PROBE_TIMEOUT_MS, {
		subrequests: REDIRECT_PROBE_MAX_SUBREQUESTS,
		storeCalls: REDIRECT_PROBE_MAX_STORE_CALLS,
	})
	return settle(call, async () => {
		call.gate()
		const { response } = await hop(call, deps, input, 'HEAD', headers)
		cancel(response)
		const location = response.headers.get('location')
		return {
			ok: true as const,
			status: response.status,
			location: location !== null && location.length <= WEB_PAGE_URL_LIMIT ? location : null,
			cost: call.cost,
		}
	})
}
