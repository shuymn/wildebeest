// https://docs.joinmastodon.org/methods/domain_blocks/

import { Hono } from 'hono'
import { z } from 'zod'

import { getDatabase } from '@wildebeest/backend/database'
import { notAuthorized, unprocessableEntity } from '@wildebeest/backend/errors'
import {
	deleteDomainBlock,
	getDomainBlocks,
	insertDomainBlock,
	normalizeDomain,
	type DomainBlock,
} from '@wildebeest/backend/mastodon/domain_block'
import type { HonoEnv } from '@wildebeest/backend/types'
import { cors, makeJsonResponse, readBody, readParams } from '@wildebeest/backend/utils'

const app = new Hono<HonoEnv>()

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

const listSchema = z.object({
	limit: z.coerce.number().int().positive().max(200).default(100),
	max_id: z.string().optional(),
	since_id: z.string().optional(),
	min_id: z.string().optional(),
})

const modifySchema = z.object({
	domain: z.string().optional(),
})

const domainLabelPattern = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const domainPattern = new RegExp(`^(?=.{1,253}$)(?:${domainLabelPattern}\\.)*${domainLabelPattern}$`)

app.get(async ({ req, env }) => {
	if (!env.data.connectedActor) {
		return notAuthorized('not authorized')
	}
	const params = await readParams(req.raw, listSchema)
	if (!params.success) {
		return new Response('', { status: 400 })
	}
	const blocks = await getDomainBlocks(getDatabase(env), env.data.connectedActor, {
		limit: params.data.limit,
		maxId: params.data.max_id,
		sinceId: params.data.since_id,
		minId: params.data.min_id,
	})
	const domains = blocks.map((block) => block.domain)
	return makeJsonResponse(domains, { headers: makeListHeaders(req.raw, blocks) })
})

app.post(async ({ req, env }) => {
	if (!env.data.connectedActor) {
		return notAuthorized('not authorized')
	}
	const result = await readDomain(req.raw)
	if ('error' in result) {
		return result.error
	}
	await insertDomainBlock(getDatabase(env), env.data.connectedActor, result.domain)
	return makeJsonResponse({}, { headers })
})

app.delete(async ({ req, env }) => {
	if (!env.data.connectedActor) {
		return notAuthorized('not authorized')
	}
	const result = await readDomain(req.raw)
	if ('error' in result) {
		return result.error
	}
	await deleteDomainBlock(getDatabase(env), env.data.connectedActor, result.domain)
	return makeJsonResponse({}, { headers })
})

// `domain` can arrive as a JSON/form body field or as a query parameter
// depending on the client, so accept any of them and normalize the result.
async function readDomain(request: Request): Promise<{ domain: string } | { error: Response }> {
	const queryDomain = new URL(request.url).searchParams.get('domain')
	const result = await readBody(request, modifySchema)
	if (!result.success && queryDomain === null && request.headers.get('content-type')?.startsWith('application/json')) {
		const [issue] = result.error.issues
		return { error: unprocessableEntity(`${issue?.path.join('.')}: ${issue?.message}`) }
	}

	const raw = (result.success ? result.data.domain : undefined) ?? queryDomain
	const normalized = raw === null ? '' : normalizeDomain(raw)
	if (normalized === '' || !domainPattern.test(normalized)) {
		return { error: unprocessableEntity('domain: required') }
	}
	return { domain: normalized }
}

function makeListHeaders(request: Request, blocks: DomainBlock[]) {
	const link = makePaginationLink(request, blocks)
	return link ? { ...headers, Link: link } : headers
}

function makePaginationLink(request: Request, blocks: DomainBlock[]): string | undefined {
	if (blocks.length === 0) {
		return undefined
	}
	const first = blocks[0]
	const last = blocks[blocks.length - 1]
	return [
		`<${makePaginationUrl(request, 'max_id', last.id)}>; rel="next"`,
		`<${makePaginationUrl(request, 'min_id', first.id)}>; rel="prev"`,
	].join(', ')
}

function makePaginationUrl(request: Request, key: 'max_id' | 'min_id', value: string): string {
	const url = new URL(request.url)
	url.searchParams.delete('max_id')
	url.searchParams.delete('since_id')
	url.searchParams.delete('min_id')
	url.searchParams.set(key, value)
	return url.toString()
}

export default app
