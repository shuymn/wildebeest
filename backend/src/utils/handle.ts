import type { Actor } from 'wildebeest/backend/src/activitypub/actors'

// Naive way of transforming an Actor ObjectID into a handle like WebFinger uses
export function urlToHandle(input: URL): string {
	const { pathname, host } = input
	const parts = pathname.split('/')
	if (parts.length === 0) {
		throw new Error('malformed URL')
	}
	const localPart = parts[parts.length - 1]
	return `${localPart}@${host}`
}

export function actorToHandle(actor: Actor): string {
	if (actor.preferredUsername !== undefined) {
		return `${actor.preferredUsername}@${actor.id.host}`
	}
	return urlToHandle(actor.id)
}
