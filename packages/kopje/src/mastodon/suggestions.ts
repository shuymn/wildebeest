import { type ApiHandler, authorized, present, requestParams, storeCall, userCredential } from './context'
import { limitParam, offsetParam } from './params'
import { SUGGESTIONS_DEFAULT_LIMIT, SUGGESTIONS_MAX_LIMIT } from '../domain/suggestions'

// Follow suggestions (domain/suggestions.ts): Api::V1::SuggestionsController and Api::V2::SuggestionsController.

// GET /api/v1/suggestions (Accounts) and /api/v2/suggestions (REST::SuggestionSerializer). Parameters as the
// directory reads them: `limit` as limit_param (40 when absent, else the absolute value, at most 80; 0 or an
// unreadable one answers none) and `offset` (a negative or unreadable one is 0). An offset past the end answers [],
// where Mastodon's slice of nil answers 500. No Deprecation header on v1, as on Kopje's other deprecated routes.
function suggestionsHandler(version: 1 | 2): ApiHandler {
	return async (c, deps) => {
		const p = await requestParams(c, deps)
		if (p instanceof Response) {
			return p
		}
		const input = {
			credential: userCredential(c, deps),
			version,
			offset: offsetParam(p),
			limit: limitParam(p, SUGGESTIONS_DEFAULT_LIMIT, SUGGESTIONS_MAX_LIMIT),
			present: present(c),
		}
		return c.json(authorized(await storeCall(c, deps, (s, b) => s.suggestions(b, input))))
	}
}

export const suggestionsV1 = suggestionsHandler(1)
export const suggestionsV2 = suggestionsHandler(2)

// DELETE /api/v1/suggestions/:id (SuggestionsController#destroy): {} whatever the id.
export const dismissSuggestion: ApiHandler = async (c, deps) => {
	const input = { credential: userCredential(c, deps), target: c.req.param('id') ?? '', now: deps.now() }
	return c.json(authorized(await storeCall(c, deps, (s, b) => s.dismissSuggestion(b, input))))
}
