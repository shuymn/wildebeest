import { isLocalAccount } from 'wildebeest/backend/src/accounts'
import type { Actor } from 'wildebeest/backend/src/activitypub/actors'
import { getApId } from 'wildebeest/backend/src/activitypub/objects'

export type RemoteHandle = {
	localPart: string
	domain: string
}

export type LocalHandle = {
	localPart: string
	domain: null
}

export type Handle = LocalHandle | RemoteHandle

export function isLocalHandle(handle: Handle): handle is LocalHandle {
	return handle.domain === null
}

// Parse a "handle" in the form: `[@] <local-part> '@' <domain>`
export function parseHandle(query: string): Handle {
	// In case the handle has been URL encoded
	query = decodeURIComponent(query)

	// Remove the leading @, if there's one.
	if (query.startsWith('@')) {
		query = query.substring(1)
	}

	const parts = query.split('@')
	const localPart = parts[0]

	if (!/^[\w\-.]+$/.test(localPart)) {
		throw new Error('invalid handle: localPart: ' + localPart)
	}

	if (parts.length > 1) {
		return { localPart, domain: parts[1] } as RemoteHandle
	} else {
		return { localPart, domain: null } as LocalHandle
	}
}

export function toRemoteHandle(handle: Handle, domain: string): RemoteHandle {
	if (isLocalHandle(handle)) {
		return { localPart: handle.localPart, domain } as RemoteHandle
	}
	return handle
}

// Naive way of transforming an Actor ObjectID into a handle like WebFinger uses
function urlToHandle({ pathname, host }: URL): RemoteHandle {
	const parts = pathname.split('/')
	if (parts.length === 0) {
		throw new Error('malformed URL')
	}
	const localPart = parts[parts.length - 1]
	return { localPart, domain: host } as RemoteHandle
}

export function actorToAcct(actor: Pick<Actor, 'preferredUsername' | 'id'>, domain?: string): string {
	const actorId = getApId(actor.id)
	if (actor.preferredUsername !== undefined) {
		if (domain && actorId.host === domain) {
			return actor.preferredUsername
		}
		return `${actor.preferredUsername}@${actorId.host}`
	}
	return handleToAcct(urlToHandle(actorId), domain)
}

export function actorToHandle(actor: Actor): RemoteHandle {
	const actorId = getApId(actor)
	if (actor.preferredUsername !== undefined) {
		return { localPart: actor.preferredUsername, domain: actorId.host } as RemoteHandle
	}
	return urlToHandle(actorId)
}

export function handleToAcct(handle: Handle, domain?: string): string {
	if (isLocalHandle(handle) || (domain && isLocalAccount(domain, handle))) {
		return handle.localPart
	}
	return `${handle.localPart}@${handle.domain}`
}
