import {
	type DocumentLoader,
	FetchError,
	getRemoteDocument,
	preloadedContexts,
	type RemoteDocument,
	validatePublicUrl,
} from '@fedify/fedify'

import { readBoundedBody } from '../platform/body'
import { errorMessage } from '../platform/error-message'
import { isActivityPubMediaType, type MediaType, parseMediaType } from '../platform/media-type'

// The document loader every remote fetch goes through, unsigned or signed. Fedify's default allows http, 16 MiB
// bodies and 10 s per call, so it is replaced (design §4 連合, §7). The rules, each from a legacy security fix:
//   - https only; localhost, single-label and literal-IP hosts are refused, and checkHost refuses names that resolve to
//     private addresses (Fedify's DNS check by default)
//   - the body is read bounded at 1 MiB
//   - the whole load, redirects and body included, ends after 5 s
//   - the origin is judged from the final response.url; a redirect to another origin is refused
//   - the document's id must have the origin of the URL it was fetched from
//   - a document is taken only as application/activity+json or ActivityStreams-profiled application/ld+json
//     (isActivityPubMediaType, GHSA-jhrq-qvrm-qr36); the context loader alone takes plain JSON-LD or JSON, since JSON-LD
//     contexts are served that way and a context is never trusted as an object
export const DOCUMENT_BODY_LIMIT = 1024 * 1024
export const DOCUMENT_TIMEOUT_MS = 5000
const MAX_REDIRECTS = 5

type Kind = {
	accept: string
	// Whether the parsed Content-Type is acceptable, and the message when it is not.
	accepts: (media: MediaType) => boolean
	refusal: string
	// Whether the document must be a JSON object (see requireObjectRoot).
	objectRoot: boolean
}

const DOCUMENT: Kind = {
	accept: 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
	accepts: isActivityPubMediaType,
	refusal: 'Not an ActivityPub document',
	objectRoot: true,
}

const CONTEXT_TYPES = new Set(['application/ld+json', 'application/json', 'application/activity+json'])
const CONTEXT: Kind = {
	accept: 'application/ld+json, application/json',
	accepts: (media) => CONTEXT_TYPES.has(media.essence),
	refusal: 'Not a JSON-LD context',
	objectRoot: false,
}

// A document refused by policy (scheme, host, redirect, type, size, id, root) or unusable as served. Fetching
// it again would not help.
export class RefusedFetchError extends FetchError {}

// A timeout or a network failure: fetching again may succeed.
export class TransientFetchError extends FetchError {}

// The request's fetch budget ran out (count, bytes or deadline). Not a verdict on the document: the same request may
// fit another time (cached contexts cost nothing), so it is transient and the request is answered 503 and retried.
export class BudgetExceededError extends TransientFetchError {}

// Whether a failed load may succeed if tried again: a timeout, a network error, or an HTTP 408, 429 or 5xx. Refusals and
// other HTTP errors (404, 410, ...) are permanent. An error that is not a FetchError (a Store refusal inside a signer,
// for one) is treated as transient.
export function isTransientLoadError(error: unknown): boolean {
	if (error instanceof RefusedFetchError) {
		return false
	}
	if (error instanceof FetchError) {
		const status = error.response?.status
		return status === undefined
			? error instanceof TransientFetchError
			: status === 408 || status === 429 || status >= 500
	}
	return true
}

// The load failure behind an error that wraps it (JSON-LD reports a failed context fetch as its own error, with the
// loader's error as its cause), or undefined if there is none.
export function loadFailureOf(error: unknown, depth = 0): FetchError | undefined {
	if (error instanceof FetchError || depth > 8 || typeof error !== 'object' || error === null) {
		return error instanceof FetchError ? error : undefined
	}
	const { cause, details } = error as { cause?: unknown; details?: { cause?: unknown } }
	return loadFailureOf(cause, depth + 1) ?? loadFailureOf(details?.cause, depth + 1)
}

// What one inbound request may fetch in all (RES-6): documents, JSON-LD contexts and redirect hops share one count,
// one byte allowance and one deadline. Cache hits and preloaded contexts cost nothing.
export type FetchBudget = { fetches: number; bytes: number; deadline: number }

export const REQUEST_MAX_FETCHES = 8
export const REQUEST_MAX_BYTES = 2 * 1024 * 1024
export const REQUEST_DEADLINE_MS = 15_000

export function requestBudget(now: number): FetchBudget {
	return { fetches: REQUEST_MAX_FETCHES, bytes: REQUEST_MAX_BYTES, deadline: now + REQUEST_DEADLINE_MS }
}

export type LoaderDeps = {
	fetch: typeof fetch
	checkHost?: (url: URL) => Promise<void>
	userAgent: string
	timeoutMs?: number
	// Shared by every loader of one request; none means only the per-load limits apply.
	budget?: FetchBudget
}

export type RequestSigner = (request: Request) => Promise<Request>

export const dnsCheckHost = (url: URL): Promise<void> => validatePublicUrl(url.href)

// The loader of documents trusted as ActivityPub objects or keys (Fedify's document loaders).
export function createSafeLoader(deps: LoaderDeps, sign?: RequestSigner): DocumentLoader {
	return createLoader(deps, DOCUMENT, sign)
}

// ID-8: an ActivityPub document must be a JSON object. JSON-LD reads a string root as the URL of the real document and
// fetches it with the context loader, which takes plain JSON, so an uploaded file could become an object or a key.
// Applied in the loader and again around caches, whose hits do not pass through the loader.
export function requireObjectRoot(loader: DocumentLoader): DocumentLoader {
	return async (url, options) => assertObjectRoot(await loader(url, options))
}

function assertObjectRoot(remote: RemoteDocument): RemoteDocument {
	const { document } = remote
	if (typeof document !== 'object' || document === null || Array.isArray(document)) {
		throw new RefusedFetchError(remote.documentUrl, 'Document root is not a JSON object')
	}
	return remote
}

// The loader of JSON-LD contexts (Fedify's context loader), which are never trusted as objects.
export function createContextLoader(deps: LoaderDeps): DocumentLoader {
	return createLoader(deps, CONTEXT)
}

function createLoader(deps: LoaderDeps, kind: Kind, sign?: RequestSigner): DocumentLoader {
	const timeoutMs = deps.timeoutMs ?? DOCUMENT_TIMEOUT_MS
	return async (url, options) => {
		// A signal aborted before the call never fires 'abort' again, so it is checked up front.
		options?.signal?.throwIfAborted()
		if (url in preloadedContexts) {
			return { contextUrl: null, document: preloadedContexts[url], documentUrl: url }
		}
		const target = new URL(url)
		const left = deps.budget === undefined ? timeoutMs : deps.budget.deadline - Date.now()
		if (left <= 0) {
			throw new BudgetExceededError(target, 'Request fetch deadline exhausted')
		}
		const limit = Math.min(timeoutMs, left)
		const controller = new AbortController()
		const timer = setTimeout(
			() => controller.abort(new TransientFetchError(target, `Timed out after ${limit} ms`)),
			limit
		)
		const onAbort = () => controller.abort(options?.signal?.reason)
		options?.signal?.addEventListener('abort', onAbort, { once: true })
		const aborted = new Promise<never>((_, reject) => {
			controller.signal.addEventListener('abort', () => reject(controller.signal.reason as Error), { once: true })
		})
		const loading = load(deps, kind, sign, target, controller.signal)
		// After a timeout the abandoned load may still reject; that rejection is not this call's result.
		loading.catch(() => {})
		try {
			// The race makes the deadline hold even if a fetch or a body read ignores the signal.
			return await Promise.race([loading, aborted])
		} finally {
			clearTimeout(timer)
			options?.signal?.removeEventListener('abort', onAbort)
		}
	}
}

async function load(deps: LoaderDeps, kind: Kind, sign: RequestSigner | undefined, target: URL, signal: AbortSignal) {
	let current = target
	for (let redirects = 0; ; redirects++) {
		await assertFetchable(current, deps.checkHost ?? dnsCheckHost)
		if (deps.budget !== undefined) {
			if (deps.budget.fetches <= 0) {
				throw new BudgetExceededError(current, 'Request fetch budget exhausted')
			}
			deps.budget.fetches--
		}
		const unsigned = new Request(current, {
			headers: { accept: kind.accept, 'user-agent': deps.userAgent },
			redirect: 'manual',
			signal,
		})
		const request = sign === undefined ? unsigned : await sign(unsigned)
		let response: Response
		try {
			response = await deps.fetch(request)
		} catch (error) {
			throw signal.aborted ? (signal.reason as Error) : new TransientFetchError(current, 'Network error')
		}
		if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
			await response.body?.cancel()
			const next = new URL(response.headers.get('location') ?? '', current)
			if (next.origin !== target.origin) {
				throw new RefusedFetchError(current, `Refused cross-origin redirect to ${next.origin}`)
			}
			if (redirects >= MAX_REDIRECTS) {
				throw new RefusedFetchError(current, `Too many redirects (${redirects + 1})`)
			}
			current = next
			continue
		}
		return readDocument(response, kind, response.url === '' ? current : new URL(response.url), target, deps.budget)
	}
}

async function readDocument(
	response: Response,
	kind: Kind,
	final: URL,
	target: URL,
	budget: FetchBudget | undefined
): Promise<RemoteDocument> {
	if (final.origin !== target.origin) {
		await response.body?.cancel()
		throw new RefusedFetchError(final, `Refused document redirected to ${final.origin}`)
	}
	if (!response.ok) {
		await response.body?.cancel()
		// Keep the status for Fedify (it treats 404 and 410 differently from transient failures), not the body.
		throw new FetchError(
			final,
			`HTTP ${response.status}: ${final.href}`,
			new Response(null, {
				status: response.status,
				headers: response.headers,
			})
		)
	}
	const media = parseMediaType(response.headers.get('content-type') ?? '')
	if (media === null || !kind.accepts(media)) {
		await response.body?.cancel()
		throw new RefusedFetchError(final, `${kind.refusal}: ${response.headers.get('content-type')}`)
	}
	const limit = Math.min(DOCUMENT_BODY_LIMIT, budget?.bytes ?? DOCUMENT_BODY_LIMIT)
	const body = await readBoundedBody(response, limit)
	if (body === 'too-large') {
		throw limit < DOCUMENT_BODY_LIMIT
			? new BudgetExceededError(final, `Request byte budget exhausted (${limit} bytes left)`)
			: new RefusedFetchError(final, `Document exceeds ${limit} bytes`)
	}
	if (budget !== undefined) {
		budget.bytes -= body.byteLength
	}
	// Fedify parses the bounded bytes, so a JSON-LD context given in a Link header is applied as Fedify applies it.
	// Alternate-document links are not followed: only JSON types reach this point. Fedify compares the Content-Type
	// case-sensitively, so it is given the parsed essence.
	const headers = new Headers(response.headers)
	headers.set('content-type', media.essence)
	let remote: RemoteDocument
	try {
		remote = await getRemoteDocument(final.href, new Response(body, { headers }), () =>
			Promise.reject(new RefusedFetchError(final, 'Refused alternate document link'))
		)
	} catch (error) {
		throw error instanceof FetchError ? error : new RefusedFetchError(final, 'Document is not valid JSON')
	}
	// A cheap pre-filter only: it sees the literal id and @id, not a JSON-LD alias of @id. The identity that counts is
	// the parsed object's id, which Fedify's consumers compare with this documentUrl (fetchKey for signature keys,
	// lookupObject's crossOrigin check for objects; test/remote-identity.test.ts). Code that parses fetched documents
	// itself must make the same check.
	const id = documentId(remote.document)
	if (id !== undefined && originOf(id) !== final.origin) {
		throw new RefusedFetchError(final, `Document id ${id} is not on ${final.origin}`)
	}
	const loaded = { ...remote, documentUrl: final.href }
	return kind.objectRoot ? assertObjectRoot(loaded) : loaded
}

function originOf(url: string): string | null {
	try {
		return new URL(url).origin
	} catch {
		return null
	}
}

function documentId(document: unknown): string | undefined {
	if (typeof document !== 'object' || document === null || Array.isArray(document)) {
		return undefined
	}
	const record = document as Record<string, unknown>
	const id = record.id ?? record['@id']
	return typeof id === 'string' ? id : undefined
}

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/

// URL parsing has already normalized IPv4 forms like 0x7f.1 or 2130706433 to dotted quads.
async function assertFetchable(url: URL, checkHost: (url: URL) => Promise<void>): Promise<void> {
	assertPublicShape(url)
	try {
		await checkHost(url)
	} catch (error) {
		throw new RefusedFetchError(url, `Refused host ${url.hostname}: ${errorMessage(error)}`)
	}
}

// NET-1's rules that need no lookup: https, no credentials, no literal IP, no local or single-label name. Shared by
// every outbound sink (NET-3); the DNS check (checkHost) runs after it.
export function assertPublicShape(url: URL): void {
	if (url.protocol !== 'https:') {
		throw new RefusedFetchError(url, `Refused non-https URL: ${url.protocol}`)
	}
	if (url.username !== '' || url.password !== '') {
		throw new RefusedFetchError(url, 'Refused URL with credentials')
	}
	const host = url.hostname
	if (host.startsWith('[') || IPV4_LITERAL.test(host)) {
		throw new RefusedFetchError(url, `Refused literal IP host: ${host}`)
	}
	if (host === 'localhost' || host.endsWith('.localhost') || !host.includes('.')) {
		throw new RefusedFetchError(url, `Refused local host: ${host}`)
	}
}
