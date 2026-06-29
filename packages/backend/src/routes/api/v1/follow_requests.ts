// https://docs.joinmastodon.org/methods/follow_requests/

import { Hono } from 'hono'
import { z } from 'zod'

import { getAccountByMastodonId } from '@wildebeest/backend/accounts'
import { getDatabase } from '@wildebeest/backend/database'
import { notAuthorized } from '@wildebeest/backend/errors'
import { getFollowRequestedActors, type FollowRequestRow } from '@wildebeest/backend/mastodon/follow'
import type { HonoEnv } from '@wildebeest/backend/types'
import type { MastodonAccount } from '@wildebeest/backend/types/account'
import { cors, makeJsonResponse, readParams } from '@wildebeest/backend/utils'

const app = new Hono<HonoEnv>()

const listSchema = z.object({
	limit: z.coerce.number().int().positive().max(80).default(40),
	max_id: z.string().optional(),
	since_id: z.string().optional(),
	min_id: z.string().optional(),
})

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

app.get(async ({ req, env }) => {
	if (!env.data.connectedActor) {
		return notAuthorized('not authorized')
	}
	const params = await readParams(req.raw, listSchema)
	if (!params.success) {
		return new Response('', { status: 400 })
	}
	const domain = new URL(req.url).hostname
	const db = getDatabase(env)
	const rows = await getFollowRequestedActors(db, env.data.connectedActor, {
		limit: params.data.limit,
		maxId: params.data.max_id,
		sinceId: params.data.since_id,
		minId: params.data.min_id,
	})
	const accounts = (await Promise.all(rows.map((row) => getAccountByMastodonId(domain, db, row.mastodon_id)))).filter(
		(account): account is MastodonAccount => account !== null
	)
	return makeJsonResponse(accounts, { headers: makeListHeaders(req.raw, rows) })
})

function makeListHeaders(request: Request, rows: FollowRequestRow[]) {
	const link = makePaginationLink(request, rows)
	return link ? { ...headers, Link: link } : headers
}

function makePaginationLink(request: Request, rows: FollowRequestRow[]): string | undefined {
	if (rows.length === 0) {
		return undefined
	}
	const first = rows[0]
	const last = rows[rows.length - 1]
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
