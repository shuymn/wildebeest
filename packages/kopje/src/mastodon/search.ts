import {
	type ApiHandler,
	authorized,
	present,
	refuseAfterAuth,
	requestParams,
	storeCall,
	userCredential,
} from './context'
import { mastodonError } from './errors'
import { pageQuery } from './pagination'
import { type Params, parseBoolean } from './params'
import type { SearchType } from '../domain/search'

// GET /api/v2/search (B4b): accounts, statuses and hashtags from local data (domain/search.ts).
//
// resolve=true is accepted and answered from local data only: resolving a remote account or status URL needs the
// signed fetch of B1b-2 (TODO(B1b-2): resolve acct: and URL queries through the instance actor).

// The raw bound of q before it is normalized and split (RES-1). Terms beyond the eighth are ignored (search-text.ts).
export const MAX_QUERY_LENGTH = 500
// Offsets past this are answered with an empty page (RES-3, RES-7).
export const MAX_SEARCH_OFFSET = 10_000

const TYPES: readonly SearchType[] = ['accounts', 'statuses', 'hashtags']

export type SearchParams = { query: string; offset: number } | { error: Response }

// q and offset, shared with /api/v1/accounts/search.
export function searchParams(p: Params): SearchParams {
	const query = p.get('q')
	if (query === undefined) {
		return { error: mastodonError(400, 'Missing parameter q') }
	}
	if (query.length > MAX_QUERY_LENGTH) {
		return { error: mastodonError(400, `Search query is too long (maximum is ${MAX_QUERY_LENGTH} characters)`) }
	}
	const offset = Math.max(Number.parseInt(p.get('offset') ?? '0', 10) || 0, 0)
	return { query, offset }
}

export const search: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	// Rails' params.require refuses a blank q here (the account search answers it with an empty list).
	const parsed = p.get('q')?.trim() === '' ? { error: mastodonError(400, 'Missing parameter q') } : searchParams(p)
	if ('error' in parsed) {
		return refuseAfterAuth(c, deps, parsed.error)
	}
	// Mastodon: 20 by default, at most 40, per type. An unknown type finds nothing.
	const { limit, maxId, minId } = pageQuery(p, 20, 40)
	const type = p.get('type')
	const types = type === undefined || type === '' ? TYPES : TYPES.filter((t) => t === type)
	const credential = userCredential(c, deps)
	const offset = parsed.offset > MAX_SEARCH_OFFSET ? null : parsed.offset
	if (offset === null || types.length === 0) {
		authorized(await storeCall(c, deps, (s, b) => s.checkCredential(b, credential)))
		return c.json({ accounts: [], statuses: [], hashtags: [] })
	}
	const accountId = p.get('account_id')
	const results = await storeCall(c, deps, (s, b) =>
		s.search(b, {
			credential,
			query: parsed.query,
			types,
			limit,
			offset,
			following: parseBoolean(p.get('following')) ?? false,
			accountId: accountId === undefined || accountId === '' ? undefined : accountId,
			maxId,
			minId,
			localDomain: new URL(c.req.url).host,
			present: present(c),
		})
	)
	return c.json(authorized(results))
}
