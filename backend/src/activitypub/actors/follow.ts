import type { Actor } from 'wildebeest/backend/src/activitypub/actors'
import * as actors from 'wildebeest/backend/src/activitypub/actors'
import type { OrderedCollection } from 'wildebeest/backend/src/activitypub/objects/collection'
import { getMetadata, loadItems } from 'wildebeest/backend/src/activitypub/objects/collection'
import { type Database } from 'wildebeest/backend/src/database'

export async function countFollowing(actor: Actor): Promise<number> {
	const collection = await getMetadata(actor.following)
	return collection.totalItems
}

export async function countFollowers(actor: Actor): Promise<number> {
	const collection = await getMetadata(actor.followers)
	return collection.totalItems
}

export async function getFollowers(actor: Actor, limit: number): Promise<OrderedCollection<string>> {
	const collection: OrderedCollection<string> = await getMetadata(actor.followers)
	collection.items = await loadItems(collection, limit)
	return collection
}

export async function getFollowing(actor: Actor, limit: number): Promise<OrderedCollection<string>> {
	const collection: OrderedCollection<string> = await getMetadata(actor.following)
	collection.items = await loadItems(collection, limit)
	return collection
}

export async function loadActors(db: Database, collection: OrderedCollection<string>): Promise<Actor[]> {
	const promises = collection.items.map((item) => {
		const actorId = new URL(item)
		return actors.getAndCache(actorId, db).catch((err: unknown) => {
			if (err instanceof Error) {
				console.warn(`${err.message}. but skipped`)
				return null
			}
			throw err
		})
	})

	return (await Promise.all(promises)).filter((v): v is Actor => v !== null)
}
