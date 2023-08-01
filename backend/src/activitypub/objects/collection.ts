import type { ApObject } from 'wildebeest/backend/src/activitypub/objects'
import { UA } from 'wildebeest/config/ua'

export interface Collection<T> extends ApObject {
	totalItems: number
	current?: string
	first: string | URL | OrderedCollectionPage<T>
	last: string | URL | OrderedCollectionPage<T>
	items: Array<T>
}

export type OrderedCollection<T> = Collection<T>

export interface OrderedCollectionPage<T> extends ApObject {
	next?: string
	orderedItems: Array<T>
}

const headers = {
	accept: 'application/activity+json',
	'User-Agent': UA,
}

export async function getMetadata<T>(url: URL): Promise<OrderedCollection<T>> {
	const res = await fetch(url, { headers })
	if (!res.ok) {
		throw new Error(`${url} returned ${res.status}`)
	}

	return res.json<OrderedCollection<T>>()
}

export async function loadItems<T>(collection: OrderedCollection<T>, limit: number): Promise<Array<T>> {
	const totalItems = collection.totalItems
	const items = []

	let pageUrl: string
	if (typeof collection.first === 'object') {
		if (collection.first instanceof URL) {
			pageUrl = collection.first.toString()
		} else {
			pageUrl = collection.first.id.toString()
		}
	} else {
		pageUrl = collection.first
	}

	while (true) {
		const page = await loadPage<T>(pageUrl)
		if (page === null) {
			return items
		}
		items.push(...page.orderedItems)
		if (items.length >= limit || items.length >= totalItems) {
			return items.slice(0, limit)
		}
		if (page.next) {
			pageUrl = page.next
		} else {
			return items
		}
	}
}

export async function loadPage<T>(url: string | URL): Promise<null | OrderedCollectionPage<T>> {
	const res = await fetch(url, { headers })
	if (!res.ok) {
		console.warn(`${url} return ${res.status}`)
		return null
	}

	return res.json<OrderedCollectionPage<T>>()
}
