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
import { isUrlQuery } from '../domain/remote-statuses'
import type { SearchType } from '../domain/search'
import { parseAddress } from '../platform/domain-name'
import { StoreUnavailableError } from '../platform/store-errors'

// GET /api/v2/search (B4b): accounts, statuses and hashtags from local data (domain/search.ts). Hashtags are recent
// autocomplete over the viewer's library and the newest public statuses, not a catalogue of every tag.
//
// resolve=true (B1b-2, Mastodon's SearchService): after the token is verified, a URL or user@domain query is fetched
// (federation/resolve.ts, signed by the instance actor) and stored by the Store with inbound validation. A URL query
// answers with what it resolved to alone, if the viewer may see it; an address query answers the account search with
// the resolved account first. Unauthenticated requests are refused before anything is fetched (401, the route's
// scope).

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
	const query = parsed.query.trim()
	const resolving = (parseBoolean(p.get('resolve')) ?? false) && offset === 0
	let resolved: Found | null = null
	if (resolving && (isUrlQuery(query) || parseAddress(query) !== null)) {
		resolved = await resolve(c, deps, query)
		if (isUrlQuery(query)) {
			return c.json({
				accounts: types.includes('accounts') ? resolved.accounts : [],
				statuses: types.includes('statuses') ? resolved.statuses : [],
				hashtags: [],
			})
		}
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
	const found = authorized(results)
	const first = resolved?.accounts.filter(() => types.includes('accounts')) ?? []
	return c.json({
		...found,
		accounts: [...first, ...found.accounts.filter((a) => !first.some((r) => r.id === a.id))].slice(0, limit),
	})
}

// What resolve=true found, as the Store presented it.
type Found = { accounts: { id: string }[]; statuses: unknown[] }

// Fetches and stores the query's target. Nothing is fetched until the token has passed. A Store in maintenance cannot
// store it: the search then answers from local data as it is.
async function resolve(c: Parameters<ApiHandler>[0], deps: Parameters<ApiHandler>[1], query: string): Promise<Found> {
	authorized(await storeCall(c, deps, (s, b) => s.checkCredential(b, userCredential(c, deps))))
	const none: Found = { accounts: [], statuses: [] }
	if (deps.resolve === undefined) {
		return none
	}
	const resolved = await deps.resolve(c.env, query)
	try {
		const found = authorized(
			await storeCall(c, deps, (s, b) =>
				s.resolveSearch(b, {
					credential: userCredential(c, deps),
					query,
					resolved,
					now: deps.now(),
					origin: new URL(c.req.url).origin,
					present: present(c),
				})
			)
		)
		// The resolved status's quote is verified by the job rounds (federation/quotes.ts).
		if (found.quotesDue) {
			await deps.requestJobs?.(c.env)
		}
		return found
	} catch (error) {
		if (error instanceof StoreUnavailableError) {
			return none
		}
		throw error
	}
}
