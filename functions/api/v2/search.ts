// https://docs.joinmastodon.org/methods/search/#v2
import { actorFromRow, ActorRow, PERSON, Person, setMastodonId } from 'wildebeest/backend/src/activitypub/actors'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { loadExternalMastodonAccount } from 'wildebeest/backend/src/mastodon/account'
import { MastodonAccount } from 'wildebeest/backend/src/types/account'
import type { Env } from 'wildebeest/backend/src/types/env'
import { cors } from 'wildebeest/backend/src/utils/cors'
import type { Handle } from 'wildebeest/backend/src/utils/handle'
import { isLocalHandle, parseHandle } from 'wildebeest/backend/src/utils/handle'
import { queryAcct } from 'wildebeest/backend/src/webfinger'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

type SearchResult = {
	accounts: Array<MastodonAccount>
	statuses: Array<any>
	hashtags: Array<any>
}

export const onRequest: PagesFunction<Env, any> = async ({ request, env }) => {
	return handleRequest(await getDatabase(env), request)
}

export async function handleRequest(db: Database, request: Request): Promise<Response> {
	const url = new URL(request.url)

	if (!url.searchParams.has('q')) {
		return new Response('', { status: 400 })
	}

	const useWebFinger = url.searchParams.get('resolve') === 'true'

	const out: SearchResult = {
		accounts: [],
		statuses: [],
		hashtags: [],
	}

	let query: Handle

	try {
		query = parseHandle(url.searchParams.get('q') || '')
	} catch (err: any) {
		return new Response('', { status: 400 })
	}

	if (useWebFinger && !isLocalHandle(query)) {
		const res = await queryAcct(query, db)
		if (res !== null) {
			out.accounts.push(await loadExternalMastodonAccount(db, res, query))
		}
	}

	if (isLocalHandle(query)) {
		const sql = `
SELECT actors.* FROM actors
WHERE rowid IN (SELECT rowid FROM search_fts WHERE (preferredUsername MATCH ?1 OR name MATCH ?1) AND type=?2 ORDER BY rank LIMIT 10)
        `

		try {
			const { results, success, error } = await db
				.prepare(sql)
				.bind(query.localPart + '*', PERSON)
				.all<{
					id: string
					type: typeof PERSON
					pubkey: string | null
					cdate: string
					properties: string
					is_admin: 1 | null
					mastodon_id: string | null
				}>()
			if (!success) {
				throw new Error('SQL error: ' + error)
			}

			if (results !== undefined) {
				for (let i = 0, len = results.length; i < len; i++) {
					const row: ActorRow<Person> = {
						...results[i],
						mastodon_id: results[i].mastodon_id ?? (await setMastodonId(db, results[i].id, results[i].cdate)),
					}
					const actor = actorFromRow(row)
					out.accounts.push(await loadExternalMastodonAccount(db, actor))
				}
			}
		} catch (err: any) {
			console.warn(`failed to search: ${err.stack}`)
		}
	}

	return new Response(JSON.stringify(out), { headers })
}
