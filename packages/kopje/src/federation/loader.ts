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

// The document loader every remote fetch goes through, unsigned or signed. Fedify's default allows http, 16 MiB
// bodies and 10 s per call, so it is replaced (design §4 連合, §7). The rules, each from a legacy security fix:
//   - https only; localhost, single-label and literal-IP hosts are refused, and checkHost refuses names that resolve to
//     private addresses (Fedify's DNS check by default)
//   - the body is read bounded at 1 MiB
//   - the whole load, redirects and body included, ends after 5 s
//   - the origin is judged from the final response.url; a redirect to another origin is refused
//   - the document's id must have the origin of the URL it was fetched from
export const DOCUMENT_BODY_LIMIT = 1024 * 1024
export const DOCUMENT_TIMEOUT_MS = 5000
const MAX_REDIRECTS = 5

const ACCEPT = 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"'
const JSON_TYPES = /^application\/(activity\+json|ld\+json|json|jrd\+json)\s*(;|$)/i

export type LoaderDeps = {
	fetch: typeof fetch
	checkHost?: (url: URL) => Promise<void>
	userAgent: string
	timeoutMs?: number
}

export type RequestSigner = (request: Request) => Promise<Request>

export const dnsCheckHost = (url: URL): Promise<void> => validatePublicUrl(url.href)

export function createSafeLoader(deps: LoaderDeps, sign?: RequestSigner): DocumentLoader {
	const timeoutMs = deps.timeoutMs ?? DOCUMENT_TIMEOUT_MS
	return async (url, options) => {
		// A signal aborted before the call never fires 'abort' again, so it is checked up front.
		options?.signal?.throwIfAborted()
		if (url in preloadedContexts) {
			return { contextUrl: null, document: preloadedContexts[url], documentUrl: url }
		}
		const target = new URL(url)
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(new FetchError(url, `Timed out after ${timeoutMs} ms`)), timeoutMs)
		const onAbort = () => controller.abort(options?.signal?.reason)
		options?.signal?.addEventListener('abort', onAbort, { once: true })
		const aborted = new Promise<never>((_, reject) => {
			controller.signal.addEventListener('abort', () => reject(controller.signal.reason as Error), { once: true })
		})
		const loading = load(deps, sign, target, controller.signal)
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

async function load(deps: LoaderDeps, sign: RequestSigner | undefined, target: URL, signal: AbortSignal) {
	let current = target
	for (let redirects = 0; ; redirects++) {
		await assertFetchable(current, deps.checkHost ?? dnsCheckHost)
		const unsigned = new Request(current, {
			headers: { accept: ACCEPT, 'user-agent': deps.userAgent },
			redirect: 'manual',
			signal,
		})
		const response = await deps.fetch(sign === undefined ? unsigned : await sign(unsigned))
		if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
			await response.body?.cancel()
			const next = new URL(response.headers.get('location') ?? '', current)
			if (next.origin !== target.origin) {
				throw new FetchError(current, `Refused cross-origin redirect to ${next.origin}`)
			}
			if (redirects >= MAX_REDIRECTS) {
				throw new FetchError(current, `Too many redirects (${redirects + 1})`)
			}
			current = next
			continue
		}
		return readDocument(response, response.url === '' ? current : new URL(response.url), target)
	}
}

async function readDocument(response: Response, final: URL, target: URL): Promise<RemoteDocument> {
	if (final.origin !== target.origin) {
		await response.body?.cancel()
		throw new FetchError(final, `Refused document redirected to ${final.origin}`)
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
	if (!JSON_TYPES.test(response.headers.get('content-type') ?? '')) {
		await response.body?.cancel()
		throw new FetchError(final, `Not a JSON document: ${response.headers.get('content-type')}`)
	}
	const body = await readBoundedBody(response, DOCUMENT_BODY_LIMIT)
	if (body === 'too-large') {
		throw new FetchError(final, `Document exceeds ${DOCUMENT_BODY_LIMIT} bytes`)
	}
	// Fedify parses the bounded bytes, so a JSON-LD context given in a Link header is applied as Fedify applies it.
	// Alternate-document links are not followed: only JSON types reach this point.
	let remote: RemoteDocument
	try {
		remote = await getRemoteDocument(final.href, new Response(body, { headers: response.headers }), () =>
			Promise.reject(new FetchError(final, 'Refused alternate document link'))
		)
	} catch (error) {
		throw error instanceof FetchError ? error : new FetchError(final, 'Document is not valid JSON')
	}
	const id = documentId(remote.document)
	if (id !== undefined && originOf(id) !== final.origin) {
		throw new FetchError(final, `Document id ${id} is not on ${final.origin}`)
	}
	return { ...remote, documentUrl: final.href }
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
	if (url.protocol !== 'https:') {
		throw new FetchError(url, `Refused non-https URL: ${url.protocol}`)
	}
	if (url.username !== '' || url.password !== '') {
		throw new FetchError(url, 'Refused URL with credentials')
	}
	const host = url.hostname
	if (host.startsWith('[') || IPV4_LITERAL.test(host)) {
		throw new FetchError(url, `Refused literal IP host: ${host}`)
	}
	if (host === 'localhost' || host.endsWith('.localhost') || !host.includes('.')) {
		throw new FetchError(url, `Refused local host: ${host}`)
	}
	try {
		await checkHost(url)
	} catch (error) {
		throw new FetchError(url, `Refused host ${host}: ${errorMessage(error)}`)
	}
}
