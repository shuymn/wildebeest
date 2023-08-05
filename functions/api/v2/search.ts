// https://docs.joinmastodon.org/methods/search/#v2
import { isLocalAccount } from 'wildebeest/backend/src/accounts'
import {
	actorFromRow,
	ActorRow,
	ensureActorMastodonId,
	getActorByRemoteHandle,
	PERSON,
	Person,
} from 'wildebeest/backend/src/activitypub/actors'
import { mastodonIdSymbol } from 'wildebeest/backend/src/activitypub/objects'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { loadExternalMastodonAccount, loadMastodonAccount } from 'wildebeest/backend/src/mastodon/account'
import type { Env } from 'wildebeest/backend/src/types'
import { MastodonAccount } from 'wildebeest/backend/src/types/account'
import { cors } from 'wildebeest/backend/src/utils/cors'
import type { Handle } from 'wildebeest/backend/src/utils/handle'
import { actorToHandle, isLocalHandle, parseHandle } from 'wildebeest/backend/src/utils/handle'
import { queryAcct } from 'wildebeest/backend/src/webfinger'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

type SearchResult = {
	accounts: Array<MastodonAccount>
	statuses: Array<unknown>
	hashtags: Array<unknown>
}

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
	return handleRequest(await getDatabase(env), request)
}

export async function handleRequest(db: Database, request: Request): Promise<Response> {
	const url = new URL(request.url)
	const domain = url.hostname

	if (!url.searchParams.has('q')) {
		return new Response('', { status: 400 })
	}

	const useWebFinger = url.searchParams.get('resolve') === 'true'

	let query: Handle
	try {
		query = parseHandle(url.searchParams.get('q') || '')
	} catch {
		return new Response('', { status: 400 })
	}

	const accounts = new Map<string, MastodonAccount>()

	if (useWebFinger && !isLocalAccount(domain, query)) {
		const res = await queryAcct(query, db)
		if (res !== null) {
			const account = await loadExternalMastodonAccount(db, res, query)
			accounts.set(account.id, account)
		}
	}

	if (isLocalHandle(query)) {
		const sql = `
SELECT
  actors.id,
  actors.mastodon_id,
  actors.type,
  actors.properties,
  actors.cdate
FROM actors
WHERE rowid IN (SELECT rowid FROM search_fts WHERE (preferredUsername MATCH ?1 OR name MATCH ?1) AND type=?2 ORDER BY rank LIMIT 10)
        `

		try {
			const { results, success, error } = await db
				.prepare(sql)
				.bind(query.localPart + '*', PERSON)
				.all<{
					id: string
					mastodon_id: string
					type: typeof PERSON
					properties: string
					cdate: string
				}>()
			if (!success) {
				throw new Error('SQL error: ' + error)
			}

			if (results !== undefined) {
				for (const result of results) {
					const row: ActorRow<Person> = {
						...result,
						mastodon_id: await ensureActorMastodonId(db, result.mastodon_id, result.cdate),
					}
					const actor = actorFromRow(row)
					if (accounts.has(actor[mastodonIdSymbol])) {
						continue
					}
					const account = await loadMastodonAccount(db, domain, actor, actorToHandle(actor))
					accounts.set(account.id, account)
				}
			}
		} catch (err: any) {
			console.warn(`failed to search: ${err.stack}`)
		}
	} else {
		const actor = await getActorByRemoteHandle(db, query)
		if (actor !== null && !accounts.has(actor[mastodonIdSymbol])) {
			const account = await loadMastodonAccount(db, domain, actor, actorToHandle(actor))
			accounts.set(account.id, account)
		}
	}

	return new Response(
		JSON.stringify({
			accounts: [...accounts.values()],
			statuses: [],
			hashtags: [],
		} satisfies SearchResult),
		{ headers }
	)
}
