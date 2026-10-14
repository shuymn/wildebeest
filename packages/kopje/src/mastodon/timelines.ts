import {
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
import { parseBoolean } from './params'

// Timelines (B4a): home, public, hashtag, an account's statuses, bookmarks and favourites. Status lists default to
// 20 and allow up to 40, as Mastodon's.

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
