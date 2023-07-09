import type { Actor } from 'wildebeest/backend/src/activitypub/actors'
import { Handle, parseHandle } from 'wildebeest/backend/src/utils/parse'
import { NonNullableProps } from 'wildebeest/backend/src/utils/type'

// Naive way of transforming an Actor ObjectID into a handle like WebFinger uses
export function urlToAcct(input: URL): string {
	const { pathname, host } = input
	const parts = pathname.split('/')
	if (parts.length === 0) {
		throw new Error('malformed URL')
	}
	const localPart = parts[parts.length - 1]
	return `${localPart}@${host}`
}

export function actorToAcct(actor: Actor): string {
	if (actor.preferredUsername !== undefined) {
		return `${actor.preferredUsername}@${actor.id.host}`
	}
	return urlToAcct(actor.id)
}

export function actorToHandle(actor: Actor): Handle {
	return parseHandle(actorToAcct(actor))
}

export function handleToAcct(handle: NonNullableProps<Handle, 'domain'>): string {
	return `${handle.localPart}@${handle.domain}`
}
