import type { ApiContext } from './context'
import type { Params } from './params'
import type { Page, PageQuery } from '../domain/accounts'

// Keyset pagination for every list: max_id, since_id and min_id cursors, and a Link header with next (older) and
// prev (newer) pages, as Mastodon sends them.

const CURSOR = /^\d{1,19}$/

export function pageQuery(params: Params, defaultLimit = 40, maxLimit = 80): PageQuery {
	const limit = Number.parseInt(params.get('limit') ?? '', 10)
	return {
		maxId: cursor(params.get('max_id')),
		sinceId: cursor(params.get('since_id')),
		minId: cursor(params.get('min_id')),
		limit: Number.isNaN(limit) ? defaultLimit : Math.min(Math.max(limit, 1), maxLimit),
	}
}

function cursor(value: string | undefined): string | undefined {
	return value !== undefined && CURSOR.test(value) ? value : undefined
}

// next is offered when the page is full; prev whenever the page has items.
export function linkHeader(
	requestUrl: string,
	page: { newest: string | null; oldest: string | null; count: number },
	limit: number
): string | undefined {
	if (page.newest === null || page.oldest === null) {
		return undefined
	}
	const links: string[] = []
	if (page.count >= limit) {
		links.push(`<${pageUrl(requestUrl, 'max_id', page.oldest)}>; rel="next"`)
	}
	links.push(`<${pageUrl(requestUrl, 'min_id', page.newest)}>; rel="prev"`)
	return links.join(', ')
}

function pageUrl(requestUrl: string, name: 'max_id' | 'min_id', value: string): string {
	const url = new URL(requestUrl)
	for (const key of ['max_id', 'min_id', 'since_id']) {
		url.searchParams.delete(key)
	}
	url.searchParams.set(name, value)
	return url.toString()
}

// A page as a list response: its items, and the Link header to the pages around it.
export function pageResponse<T>(c: ApiContext, page: Page<T>, limit: number): Response {
	const link = linkHeader(c.req.url, { ...page, count: page.items.length }, limit)
	if (link !== undefined) {
		c.header('Link', link)
	}
	return c.json(page.items as object)
}
