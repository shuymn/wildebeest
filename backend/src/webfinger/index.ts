import { type Database } from 'wildebeest/backend/src/database'
import { handleToAcct, RemoteHandle } from 'wildebeest/backend/src/utils/handle'
import { UA } from 'wildebeest/config/ua'

import type { Actor } from '../activitypub/actors'
import * as actors from '../activitypub/actors'

export type WebFingerResponse = {
	subject: string
	aliases: Array<string>
	links: Array<any>
}

const headers = {
	accept: 'application/jrd+json',
	'user-agent': UA,
}

export async function queryAcct(handle: RemoteHandle, db: Database): Promise<Actor | null> {
	const url = await queryAcctLink(handle)
	if (url === null) {
		return null
	}
	return actors.getAndCache(url, db)
}

export async function queryAcctLink(handle: RemoteHandle): Promise<URL | null> {
	const params = new URLSearchParams({ resource: `acct:${handleToAcct(handle)}` })
	let data: WebFingerResponse
	try {
		const url = new URL('/.well-known/webfinger?' + params, 'https://' + handle.domain)
		console.log('query', url.href)
		const res = await fetch(url, { headers })
		if (!res.ok) {
			throw new Error(`WebFinger API returned: ${res.status}`)
		}

		data = await res.json<WebFingerResponse>()
	} catch (err) {
		console.warn('failed to query WebFinger:', err)
		return null
	}

	for (let i = 0, len = data.links.length; i < len; i++) {
		const link = data.links[i]
		if (link.rel === 'self' && link.type === 'application/activity+json') {
			return new URL(link.href)
		}
	}

	return null
}
