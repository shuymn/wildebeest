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

// next is offered when the page is full and has an oldest end; prev whenever it has a newest end. Each stands on its
// own: an empty page cut at its window may have only the end it moves on from (a grouped walk's).
export function linkHeader(
	requestUrl: string,
	page: { newest: string | null; oldest: string | null; count: number },
	limit: number
): string | undefined {
	const links: string[] = []
	if (page.oldest !== null && page.count >= limit) {
		links.push(`<${pageUrl(requestUrl, 'max_id', page.oldest)}>; rel="next"`)
	}
	if (page.newest !== null) {
		links.push(`<${pageUrl(requestUrl, 'min_id', page.newest)}>; rel="prev"`)
	}
	return links.length === 0 ? undefined : links.join(', ')
}

function pageUrl(requestUrl: string, name: 'max_id' | 'min_id', value: string): string {
	const url = new URL(requestUrl)
	for (const key of ['max_id', 'min_id', 'since_id']) {
		url.searchParams.delete(key)
	}
	url.searchParams.set(name, value)
	return url.toString()
}

// A page as a list response: its items, and the Link header to the pages around it. `count` is what the page read
// toward its limit: its items, the candidates of a window the rule filtered (the quotes list), or the limit when the
// read stopped at its window (Page.cut).
export function pageResponse<T>(
	c: ApiContext,
	page: Page<T>,
	limit: number,
	count = page.cut === true ? limit : page.items.length
): Response {
	const link = linkHeader(c.req.url, { ...page, count }, limit)
	if (link !== undefined) {
		c.header('Link', link)
	}
	return c.json(page.items as object)
}
