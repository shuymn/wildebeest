import { type DocumentLoader, preloadedContexts } from '@fedify/fedify'

import type { TestActor } from './inbox-helpers'
import { mastodonNote, type Note } from './inbox-status-helpers'

// Fixtures shared by the quote tests (test/quotes.test.ts, test/quote-requests.test.ts).

// JSON-LD contexts as Kopje's own loader serves them: the preloaded ones, nothing fetched. Independent of the signer
// under test (federation/ld-sign.ts has its own), so a verification never shares its code.
export const contexts: DocumentLoader = (url) => {
	const document = (preloadedContexts as Record<string, unknown>)[url]
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
