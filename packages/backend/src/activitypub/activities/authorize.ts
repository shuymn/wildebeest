// Authorization of inbound activities, applied before any state change.
//
// The HTTP signature only proves *who* sent an activity (see
// `fetchKeyOwner`). It says nothing about what that actor is allowed to do, so
// every inbound activity is checked against the table below: an actor may only
// act on its own objects, and inbound activities may never touch local actors
// or local objects.

import type { Activity } from '@wildebeest/backend/activitypub/activities'
import { isActorType } from '@wildebeest/backend/activitypub/actors'
import { type ApObject, type ApObjectOrId, getApId, isLocalObject } from '@wildebeest/backend/activitypub/objects'

export type Authorization = { authorized: true } | { authorized: false; reason: string }

const AUTHORIZED: Authorization = { authorized: true }

function deny(reason: string): Authorization {
	return { authorized: false, reason }
}

function isObject(value: ApObjectOrId): value is ApObject {
	return typeof value === 'object' && !(value instanceof URL)
}

function tryGetApId(value: ApObjectOrId | undefined): URL | null {
	if (value === undefined) {
		return null
	}
	try {
		return getApId(value)
	} catch {
		return null
	}
}

function sameId(a: URL, b: URL): boolean {
	return a.toString() === b.toString()
}

// An object belongs to an actor when it is explicitly attributed to it, or,
// absent an attribution, when it comes from the same origin.
function belongsToActor(object: ApObjectOrId, objectId: URL, actorId: URL): Authorization {
	if (isObject(object)) {
		const attributedTo = tryGetApId((object as { attributedTo?: ApObjectOrId }).attributedTo)
		if (attributedTo !== null) {
			return sameId(attributedTo, actorId)
				? AUTHORIZED
				: deny(`object is attributed to ${attributedTo.toString()}, not to the signer`)
		}
	}
	return objectId.hostname === actorId.hostname
		? AUTHORIZED
		: deny(`object ${objectId.toString()} is not from the signer's origin`)
}

// Create/Update/Delete of an object owned by the actor.
function authorizeObjectChange(domain: string, activity: Activity, actorId: URL): Authorization {
	const objectId = tryGetApId(activity.object)
	if (objectId === null) {
		return deny('activity has no object id')
	}
	if (isLocalObject(domain, objectId)) {
		return deny('inbound activities may not change local objects')
	}

	// Updating or deleting an actor is only allowed for the actor itself.
	if (isObject(activity.object) && isActorType(activity.object.type)) {
		return sameId(objectId, actorId) ? AUTHORIZED : deny('actor may only change its own actor document')
	}
	if (sameId(objectId, actorId)) {
		return AUTHORIZED
	}

	return belongsToActor(activity.object, objectId, actorId)
}

// Accept/Reject of a Follow: the Follow must have been sent by a local actor
// and must target the actor that now answers it.
function authorizeFollowResponse(domain: string, activity: Activity, actorId: URL): Authorization {
	const object = activity.object
	if (!isObject(object)) {
		return deny('Accept/Reject object must be an embedded Follow activity')
	}
	if (object.type !== 'Follow') {
		return deny(`unsupported Accept/Reject object: ${object.type}`)
	}
	const follow = object as unknown as Activity
	const followee = tryGetApId(follow.object)
	const follower = tryGetApId(follow.actor)
	if (followee === null || follower === null) {
		return deny('referenced Follow is incomplete')
	}
	if (!sameId(followee, actorId)) {
		return deny('referenced Follow does not target the signer')
	}
	if (!isLocalObject(domain, follower)) {
		return deny('referenced Follow does not originate from a local actor')
	}
	return AUTHORIZED
}

// Undo of one of the actor's own activities.
function authorizeUndo(_domain: string, activity: Activity, actorId: URL): Authorization {
	const object = activity.object
	if (isObject(object)) {
		const undoneActor = tryGetApId((object as unknown as Partial<Activity>).actor)
		if (undoneActor === null) {
			return deny('undone activity has no actor')
		}
		return sameId(undoneActor, actorId) ? AUTHORIZED : deny('undone activity belongs to another actor')
	}
	const objectId = tryGetApId(object)
	if (objectId === null) {
		return deny('activity has no object id')
	}
	return objectId.hostname === actorId.hostname ? AUTHORIZED : deny('undone activity is not from the signer`s origin')
}

// Move of the actor itself.
function authorizeMove(_domain: string, activity: Activity, actorId: URL): Authorization {
	const objectId = tryGetApId(activity.object)
	if (objectId === null) {
		return deny('activity has no object id')
	}
	return sameId(objectId, actorId) ? AUTHORIZED : deny('actor may only Move itself')
}

// Activity types not listed here keep their existing behavior.
const authorizers: Record<string, (domain: string, activity: Activity, actorId: URL) => Authorization> = {
	Create: authorizeObjectChange,
	Update: authorizeObjectChange,
	Delete: authorizeObjectChange,
	Accept: authorizeFollowResponse,
	Reject: authorizeFollowResponse,
	Undo: authorizeUndo,
	Move: authorizeMove,
}

export function authorizeInboundActivity(domain: string, activity: Activity): Authorization {
	const authorize = authorizers[activity.type]
	if (authorize === undefined) {
		return AUTHORIZED
	}

	const actorId = tryGetApId(activity.actor)
	if (actorId === null) {
		return deny('activity has no actor id')
	}

	return authorize(domain, activity, actorId)
}
