import { type DocumentLoader, preloadedContexts } from '@fedify/fedify'
import { vi } from 'vitest'

import { BUILD } from './helpers'
import type { RemoteWeb, TestActor } from './inbox-helpers'
import { AS, mastodonNote, nextId, type Note } from './inbox-status-helpers'
import type { deliveryRound } from '../src/jobs/deliver'
import type { StoreStub } from '../src/platform/store-client'

// Fixtures shared by the quote tests (test/quotes.test.ts, test/quote-requests.test.ts, test/quote-authoring.test.ts,
// test/quote-interop.test.ts).

// JSON-LD contexts as Kopje's own loader serves them: the preloaded ones, nothing fetched. Independent of the signer
// under test (federation/ld-sign.ts has its own), so a verification never shares its code.
export const contexts: DocumentLoader = (url) => {
	const document = preloadedContexts[url]
	return document === undefined
		? Promise.reject(new Error(`no context ${url}`))
		: Promise.resolve({ document, documentUrl: url, contextUrl: null })
}

// A Note quoting `target` as Mastodon 4.5 writes it (quote, _misskey_quote, quoteUri, quoteAuthorization).
export function quoting(
	actor: TestActor,
	target: string,
	stamp: string | null,
	extra: Record<string, unknown> = {}
): Note {
	return mastodonNote(actor, {
		quote: target,
		_misskey_quote: target,
		quoteUri: target,
		...(stamp === null ? {} : { quoteAuthorization: stamp }),
		...extra,
	})
}

// The context of a stamp as Mastodon's QuoteAuthorizationSerializer writes it.
export const QUOTE_CONTEXT = [
	AS,
	{
		QuoteAuthorization: 'https://w3id.org/fep/044f#QuoteAuthorization',
		gts: 'https://gotosocial.org/ns#',
		interactingObject: { '@id': 'gts:interactingObject', '@type': '@id' },
		interactionTarget: { '@id': 'gts:interactionTarget', '@type': '@id' },
	},
]

// A stamp as Mastodon's QuoteAuthorizationSerializer renders it, served on the web.
export function serveStamp(
	web: RemoteWeb,
	uri: string,
	quoted: TestActor,
	quoting: string,
	target: string,
	extra = {}
): void {
	web.serve(uri, {
		'@context': QUOTE_CONTEXT,
		type: 'QuoteAuthorization',
		id: uri,
		attributedTo: quoted.uri,
		interactingObject: quoting,
		interactionTarget: target,
		...extra,
	})
}

const FEP_QUOTE_REQUEST = 'https://w3id.org/fep/044f#QuoteRequest'

// The quoted author's Accept of our QuoteRequest for the quoting status `quoting` (named by id), with its stamp.
export function quoteAccept(
	actor: TestActor,
	quoting: string,
	result: string | null,
	extra: Record<string, unknown> = {}
) {
	return {
		'@context': [AS, { QuoteRequest: FEP_QUOTE_REQUEST }],
		id: `${actor.uri}#accepts/quote_requests/${nextId()}`,
		type: 'Accept',
		actor: actor.uri,
		object: `${quoting}#quote-request`,
		...(result === null ? {} : { result }),
		...extra,
	}
}

// The quoted author's Reject of our QuoteRequest for the quoting status `quoting` (named by id).
export function quoteReject(actor: TestActor, quoting: string, extra: Record<string, unknown> = {}) {
	return {
		'@context': [AS, { QuoteRequest: FEP_QUOTE_REQUEST }],
		id: `${actor.uri}#rejects/quote_requests/${nextId()}`,
		type: 'Reject',
		actor: actor.uri,
		object: `${quoting}#quote-request`,
		...extra,
	}
}

// A promise and the function that resolves it: a gate, or the point a gated call reports reaching.
export function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void
	const promise = new Promise<void>((r) => {
		resolve = r
	})
	return { promise, resolve }
}

// A host check that holds every delivery of the round (after the claim, before confirmation) until released.
export function gatedHost() {
	const reached = deferred()
	const release = deferred()
	const checkHost = async () => {
		reached.resolve()
		await release.promise
	}
	return { checkHost, reached: reached.promise, release: release.resolve }
}

// A fetch that answers every POST 202 and records its URL, in order.
export function recordingFetch() {
	const sent: string[] = []
	const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
		sent.push(new Request(input, init).url)
		return Promise.resolve(new Response(null, { status: 202 }))
	})
	return { fetch: fetch as unknown as typeof globalThis.fetch, sent }
}

export type RoundDeps = Parameters<typeof deliveryRound>[1]

// What a delivery round needs, over `store`: the caller's fetch and clock, any host allowed, and lease tokens of its
// own (`prefix`-1, -2, ...).
export function deliveryDeps(
	store: () => StoreStub,
	fetch: typeof globalThis.fetch,
	now: () => number,
	prefix = 'lease'
): RoundDeps {
	let n = 0
	return {
		build: () => BUILD,
		store,
		now,
		fetch,
		checkHost: () => Promise.resolve(),
		leaseToken: () => `${prefix}-${++n}`,
	}
}
