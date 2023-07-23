import type { ApObject } from 'wildebeest/backend/src/activitypub/objects'

export interface Collection<T> extends ApObject {
	totalItems: number
	current?: string
	first: URL
	last: URL
	items: Array<T>
}

export type OrderedCollection<T> = Collection<T>

export interface OrderedCollectionPage<T> extends ApObject {
	next?: string
	orderedItems: Array<T>
}

const headers = {
	accept: 'application/activity+json',
}

export async function getMetadata<T>(url: URL): Promise<OrderedCollection<T>> {
	const res = await fetch(url, { headers })
	if (!res.ok) {
		throw new Error(`${url} returned ${res.status}`)
	}

	return res.json<OrderedCollection<T>>()
}

export async function loadItems<T>(collection: OrderedCollection<T>, max?: number): Promise<Array<T>> {
	const items = []
	let pageUrl = collection.first

	while (true) {
		const page = await loadPage<T>(pageUrl)
		if (page === null) {
			return items
		}
		items.push(...page.orderedItems)
		if (max && items.length >= max) {
			return items.slice(0, max)
		}
		if (page.next) {
			pageUrl = new URL(page.next)
		} else {
			return items
		}
	}
}

export async function loadPage<T>(url: URL): Promise<null | OrderedCollectionPage<T>> {
	const res = await fetch(url, { headers })
	if (!res.ok) {
		console.warn(`${url} return ${res.status}`)
		return null
	}

	return res.json<OrderedCollectionPage<T>>()
}
