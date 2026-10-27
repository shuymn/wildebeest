import {
	type ApiContext,
	type ApiHandler,
	authorized,
	optionalCredential,
	present,
	requestParams,
	storeCall,
	userCredential,
} from './context'
import { mastodonError } from './errors'
import { pageQuery, pageResponse } from './pagination'
import { limitParam, type Params, parseBoolean } from './params'
import type { Page } from '../domain/accounts'

// Timelines: home, a list's, public, hashtag, link, an account's statuses, bookmarks and favourites. Status
// lists default to 20 and allow up to 40, as Mastodon's.

const STATUS_LIMIT = 20
const MAX_STATUS_LIMIT = 40
// Mastodon reads at most 4 extra tags each for any[], all[] and none[].
const MAX_EXTRA_TAGS = 4

export const home: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const page = pageQuery(p, STATUS_LIMIT, MAX_STATUS_LIMIT)
	const credential = userCredential(c, deps)
	const result = await storeCall(c, deps, (s, b) => s.homeTimeline(b, { credential, page, present: present(c) }))
	return pageResponse(c, authorized(result), page.limit)
}

// A list that is not the viewer's is not found (Timelines::ListController#set_list).
export const listTimeline: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const page = pageQuery(p, STATUS_LIMIT, MAX_STATUS_LIMIT)
	const input = { credential: userCredential(c, deps), id: c.req.param('id') ?? '', page, present: present(c) }
	const result = authorized(await storeCall(c, deps, (s, b) => s.listTimeline(b, input)))
	if (result === null) {
		return mastodonError(404, 'Record not found')
	}
	return pageResponse(c, result, page.limit)
}

export const publicTimeline: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const page = pageQuery(p, STATUS_LIMIT, MAX_STATUS_LIMIT)
	const credential = optionalCredential(c, deps)
	const result = await storeCall(c, deps, (s, b) =>
		s.publicTimeline(b, {
			credential,
			now: deps.now(),
			page,
			local: parseBoolean(p.get('local')) ?? false,
			remote: parseBoolean(p.get('remote')) ?? false,
			onlyMedia: parseBoolean(p.get('only_media')) ?? false,
			present: present(c),
		})
	)
	return pageResponse(c, authorized(result), page.limit)
}

export const tagTimeline: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const page = pageQuery(p, STATUS_LIMIT, MAX_STATUS_LIMIT)
	const tags = (name: string) =>
		p
			.getAll(name)
			.filter((tag) => tag !== '')
			.slice(0, MAX_EXTRA_TAGS)
	const credential = optionalCredential(c, deps)
	const result = await storeCall(c, deps, (s, b) =>
		s.tagTimeline(b, {
			credential,
			now: deps.now(),
			page,
			tag: c.req.param('hashtag') ?? '',
			any: tags('any'),
			all: tags('all'),
			none: tags('none'),
			local: parseBoolean(p.get('local')) ?? false,
			remote: parseBoolean(p.get('remote')) ?? false,
			onlyMedia: parseBoolean(p.get('only_media')) ?? false,
			present: present(c),
		})
	)
	return pageResponse(c, authorized(result), page.limit)
}

// GET /api/v1/timelines/link (Api::V1::Timelines::LinkController): a link that has no timeline now, or trends off, is
// not found (MD-5). `limit` as limit_param reads it, so 0 answers no statuses and no Link header. Without a token the
// answer may be cached by anyone for 15 seconds (cache_if_unauthenticated!), varying by Authorization.
export const linkTimeline: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const page = { ...pageQuery(p, STATUS_LIMIT, MAX_STATUS_LIMIT), limit: limitParam(p, STATUS_LIMIT, MAX_STATUS_LIMIT) }
	const credential = optionalCredential(c, deps)
	const url = p.get('url') ?? null
	const result = authorized(
		await storeCall(c, deps, (s, b) =>
			s.linkTimeline(b, { credential, now: deps.now(), url, page, present: present(c) })
		)
	)
	if (result === null) {
		return mastodonError(404, 'Record not found')
	}
	linkTimelineLinks(c, p, result)
	return credential === null
		? c.json(result.items, 200, {
				'cache-control': 'public, max-age=15, stale-while-revalidate=30, stale-if-error=86400',
				vary: 'Authorization',
			})
		: c.json(result.items)
}

// The Link header of a link timeline page (Api::V1::Timelines::BaseController#insert_pagination_headers): next at
// max_id its oldest status and prev at min_id its newest, on every page that shows a status, keeping only `url` and
// `limit` as sent (PERMITTED_PARAMS). A page cut at its window or its bytes links on from where it stopped, whatever
// it shows (Page.cut); an empty page that was not cut has neither end.
function linkTimelineLinks(c: ApiContext, p: Params, page: Page<unknown>): void {
	const at = (name: 'max_id' | 'min_id', id: string) => {
		const target = new URL('/api/v1/timelines/link', c.req.url)
		for (const key of ['url', 'limit']) {
			const value = p.get(key)
			if (value !== undefined) {
				target.searchParams.set(key, value)
			}
		}
		target.searchParams.set(name, id)
		return target.toString()
	}
	const links = [
		...(page.oldest === null ? [] : [`<${at('max_id', page.oldest)}>; rel="next"`]),
		...(page.newest === null ? [] : [`<${at('min_id', page.newest)}>; rel="prev"`]),
	]
	if (links.length > 0) {
		c.header('Link', links.join(', '))
	}
}

export const accountStatuses: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const page = pageQuery(p, STATUS_LIMIT, MAX_STATUS_LIMIT)
	const tagged = p.get('tagged')
	const credential = optionalCredential(c, deps)
	const result = authorized(
		await storeCall(c, deps, (s, b) =>
			s.accountStatuses(b, {
				credential,
				now: deps.now(),
				account: c.req.param('id') ?? '',
				page,
				onlyMedia: parseBoolean(p.get('only_media')) ?? false,
				excludeReplies: parseBoolean(p.get('exclude_replies')) ?? false,
				excludeReblogs: parseBoolean(p.get('exclude_reblogs')) ?? false,
				pinned: parseBoolean(p.get('pinned')) ?? false,
				tagged: tagged === undefined || tagged === '' ? null : tagged,
				present: present(c),
			})
		)
	)
	if (result === null) {
		return mastodonError(404, 'Record not found')
	}
	return pageResponse(c, result, page.limit)
}

function edgeList(rpc: 'bookmarksList' | 'favouritesList'): ApiHandler {
	return async (c, deps) => {
		const p = await requestParams(c, deps)
		if (p instanceof Response) {
			return p
		}
		const page = pageQuery(p, STATUS_LIMIT, MAX_STATUS_LIMIT)
		const credential = userCredential(c, deps)
		const result = await storeCall(c, deps, (s, b) => s[rpc](b, { credential, page, present: present(c) }))
		return pageResponse(c, authorized(result), page.limit)
	}
}

export const bookmarks = edgeList('bookmarksList')
export const favourites = edgeList('favouritesList')
