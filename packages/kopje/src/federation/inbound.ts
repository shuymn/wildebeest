import { type KeyCache, verifyRequestDetailed } from '@fedify/fedify'
import { CryptographicKey } from '@fedify/vocab'
import { Temporal } from 'temporal-polyfill'

import { createRemoteLoaders, type FederationDeps, type FederationState, type RemoteLoaders } from './federation'
import { isTransientLoadError } from './loader'
import { fetchActor } from './remote-actor'
import type { ActivityRef, InboundActivity, RemoteActorInput } from '../domain/inbox'
import { isActivityPubMediaType, parseMediaType } from '../platform/media-type'
import { callStore } from '../platform/store-client'
import { importPublicKeyPem } from '../security/key-wrap'

// Inbound activities (B1b-1): verification, identity, and the shape of each activity, in the Worker; the effects in
// one Store operation (domain/inbox.ts). The same path serves a live POST and the replay of a spooled one.
//
//   1. The Content-Type is an ActivityStreams type (ID-8).
//   2. The HTTP signature verifies with Fedify, against the time the request was received (OPS-1: a spooled request
//      is judged by its spool time). Unsigned or unverifiable: 401, nothing changes (ID-1).
//   3. The body is a JSON object with the ActivityStreams context, a type, an id and an actor (a string or array root
//      is refused, ID-8).
//   4. ID-1: the actor is not local, and it owns the verifying key: its document (fetched, or the stored one while
//      fresh) lists the key id, and the key names no other owner. The activity id has the actor's origin.
//   5. Per type, what the Store cannot fetch itself: a fresh actor document for Update, the Move target (ID-4).
//
// Effects are idempotent by natural keys and retractions (ID-7); a refused activity reserves and records nothing.

export type InboundRequest = {
	url: string
	method: string
	headers: [string, string][]
	body: Uint8Array
	// When the request reached the inbox (the spool time on replay).
	receivedAt: number
}

// 202: done or deliberately ignored (a format or authorization problem, as Mastodon answers); 401: the signature or
// the signer's identity failed; 415: not an ActivityStreams body; 503: a remote fetch failed in a way that may pass.
export type InboxOutcome = { status: 202 | 401 | 415 | 503; reason: string; purge?: string }

export type InboundDeps = Omit<FederationDeps, 'domain'> & { domain: string; recipient: string | null }

const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams'
// Fedify's default for the Date header, also applied to (created), which it would otherwise allow one minute.
const TIME_WINDOW = { hours: 1 }

type Json = Record<string, unknown>

type Parsed =
	| { ok: true; actor: string; activity: InboundActivity; target: string | null }
	| { ok: false; reason: string; deleteOfSelf?: boolean }

function isObject(value: unknown): value is Json {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function idOf(value: unknown): string | null {
	if (typeof value === 'string') {
		return value
	}
	return isObject(value) && typeof value.id === 'string' ? value.id : null
}

function refOf(value: unknown): ActivityRef {
	if (!isObject(value)) {
		return { id: idOf(value), type: null, actor: null, object: null }
	}
	return {
		id: idOf(value),
		type: typeof value.type === 'string' ? value.type : null,
		actor: idOf(value.actor),
		object: idOf(value.object),
	}
}

export function originOf(uri: string | null): string | null {
	if (uri === null) {
		return null
	}
	try {
		const url = new URL(uri)
		return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null
	} catch {
		return null
	}
}

function hasActivityStreamsContext(context: unknown): boolean {
	return context === AS_CONTEXT || (Array.isArray(context) && context.includes(AS_CONTEXT))
}

// The activity as Mastodon reads it: compacted JSON with the ActivityStreams context, ids as strings or objects with
// an id. Types handled elsewhere (Create, Like, Announce, ... in B1b-2) are 'unsupported'.
export function parseActivity(body: Uint8Array): Parsed {
	let json: unknown
	try {
		json = JSON.parse(new TextDecoder().decode(body))
	} catch {
		return { ok: false, reason: 'invalid-json' }
	}
	if (!isObject(json)) {
		return { ok: false, reason: 'not-an-object' }
	}
	const actor = idOf(json.actor)
	const id = typeof json.id === 'string' ? json.id : null
	const type = typeof json.type === 'string' ? json.type : null
	const object = idOf(json.object)
	const deleteOfSelf = type === 'Delete' && actor !== null && object === actor
	if (!hasActivityStreamsContext(json['@context'])) {
		return { ok: false, reason: 'no-context', deleteOfSelf }
	}
	if (actor === null || originOf(actor) === null || id === null || type === null) {
		return { ok: false, reason: 'incomplete', deleteOfSelf }
	}
	const activity = activityOf(type, id, actor, json, object)
	if (activity === null) {
		return { ok: false, reason: 'unsupported', deleteOfSelf }
	}
	return { ok: true, actor, activity, target: type === 'Move' ? idOf(json.target) : null }
}

function activityOf(
	type: string,
	id: string,
	actor: string,
	json: Json,
	object: string | null
): InboundActivity | null {
	switch (type) {
		case 'Follow':
		case 'Block':
			return object === null ? null : { type, id, object }
		case 'Accept':
		case 'Reject':
		case 'Undo':
			return { type, id, object: refOf(json.object) }
		case 'Move':
			// The object of a Move is the actor itself (Mastodon ignores any other).
			return object === actor ? { type, id, target: { local: '' } } : null
		case 'Update':
			// Updates of statuses are B1b-2; an actor may update only itself (ID-6).
			return object === actor ? { type: 'UpdateActor', id } : null
		case 'Delete':
			if (object === null) {
				return null
			}
			return object === actor ? { type: 'DeleteActor', id } : { type: 'Delete', id, object }
		default:
			return null
	}
}

type ServedKey = { key: CryptographicKey; owner: string; fresh: boolean }

// A KeyCache over the Store: the key a stored, origin-checked actor document lists. Fedify verifies with it first and
// refetches the key if the signature fails (a rotated key). Fetched keys are not written back: the actor document is
// stored with its keys when the activity is applied.
function storedKeys(deps: InboundDeps, served: Map<string, ServedKey>): KeyCache {
	return {
		async get(keyId) {
			const stored = await callStore(() => deps.store().remoteKey(deps.build, { keyId: keyId.href, now: deps.now() }))
			if (stored === null) {
				return undefined
			}
			try {
				const key = new CryptographicKey({
					id: keyId,
					owner: new URL(stored.owner),
					publicKey: await importPublicKeyPem(stored.pem),
				})
				served.set(keyId.href, { key, owner: stored.owner, fresh: stored.fresh })
				return key
			} catch {
				return undefined
			}
		},
		async set() {},
	}
}

// A Store refusal inside a loader reaches Fedify as a failed fetch; it is maintenance, so it is rethrown for the caller
// to spool or requeue the request.
function rethrowStoreError(state: FederationState): void {
	if (state.storeError !== null) {
		throw state.storeError
	}
}

function isTransientKeyFailure(result: { status: number } | { error: Error }): boolean {
	if ('status' in result) {
		return result.status === 408 || result.status === 429 || result.status >= 500
	}
	return isTransientLoadError(result.error)
}

export async function receiveInbound(deps: InboundDeps, request: InboundRequest): Promise<InboxOutcome> {
	const headers = new Headers(request.headers)
	const media = parseMediaType(headers.get('content-type') ?? '')
	if (media === null || !isActivityPubMediaType(media)) {
		return { status: 415, reason: 'not-activitystreams' }
	}
	const origin = `https://${deps.domain}`
	const state: FederationState = { resolvedUsername: null, source: null, storeError: null }
	const loaders = createRemoteLoaders(deps, state, deps.recipient)
	const parsed = parseActivity(request.body)

	const served = new Map<string, ServedKey>()
	const signed = new Request(request.url, { method: request.method, headers, body: request.body })
	const verified = await verifyRequestDetailed(signed, {
		documentLoader: loaders.document,
		contextLoader: loaders.context,
		keyCache: storedKeys(deps, served),
		currentTime: Temporal.Instant.fromEpochMilliseconds(request.receivedAt),
		timeWindow: TIME_WINDOW,
	})
	rethrowStoreError(state)
	if (!verified.verified) {
		const reason = verified.reason
		if (reason.type !== 'keyFetchError') {
			return { status: 401, reason: reason.type }
		}
		if (isTransientKeyFailure(reason.result)) {
			return { status: 503, reason: 'key-unavailable' }
		}
		// A deleted actor's key is gone with it. Mastodon answers its Delete with 202 rather than have every server
		// retry it; there is nothing stored to verify it against.
		const deleteOfSelf = parsed.ok ? parsed.activity.type === 'DeleteActor' : parsed.deleteOfSelf === true
		return deleteOfSelf ? { status: 202, reason: 'unknown-actor-deleted' } : { status: 401, reason: 'key-gone' }
	}
	if (!parsed.ok) {
		return { status: 202, reason: parsed.reason }
	}
	const { actor: actorUri, activity } = parsed

	// ID-1: the actor is remote and owns the key.
	const key = verified.key
	if (originOf(actorUri) === origin) {
		return { status: 401, reason: 'local-actor' }
	}
	if (key.id === null || (key.ownerId !== null && key.ownerId.href !== actorUri)) {
		return { status: 401, reason: 'not-key-owner' }
	}
	if (originOf(activity.id) !== originOf(actorUri)) {
		return { status: 202, reason: 'foreign-id' }
	}
	const fromStore = served.get(key.id.href)
	const storedOwner = fromStore !== undefined && fromStore.key === key && fromStore.owner === actorUri
	let actor: RemoteActorInput | null = null
	if (!storedOwner || !fromStore.fresh || activity.type === 'UpdateActor') {
		const fetched = await fetchActor(
			actorUri,
			activity.type === 'UpdateActor' ? loaders.fresh : loaders.document,
			loaders.context
		)
		rethrowStoreError(state)
		if (fetched.kind === 'transient') {
			return { status: 503, reason: 'actor-unavailable' }
		}
		if (fetched.kind === 'unusable') {
			// A gone actor can still delete itself with the key we stored.
			if (!(storedOwner && activity.type === 'DeleteActor')) {
				return { status: 401, reason: 'actor-unusable' }
			}
		} else {
			if (!fetched.actor.publicKeyIds.some((id) => id.href === key.id?.href)) {
				return { status: 401, reason: 'not-key-owner' }
			}
			if (fetched.input === null) {
				return { status: 202, reason: 'invalid-actor' }
			}
			actor = fetched.input
		}
	}

	const prepared = await prepare(activity, parsed.target, actorUri, origin, loaders)
	rethrowStoreError(state)
	if (!('type' in prepared)) {
		return prepared
	}
	const result = await callStore(() =>
		deps.store().receiveActivity(deps.build, { now: deps.now(), origin, actorUri, actor, activity: prepared })
	)
	return {
		status: 202,
		reason: result.reason,
		...(result.purgeRemaining ? { purge: actorUri } : {}),
	}
}

// What a type needs beyond the activity itself.
async function prepare(
	activity: InboundActivity,
	target: string | null,
	actorUri: string,
	origin: string,
	loaders: RemoteLoaders
): Promise<InboundActivity | InboxOutcome> {
	if (activity.type !== 'Move') {
		return activity
	}
	if (target === null || target === actorUri) {
		return { status: 202, reason: 'no-target' }
	}
	if (originOf(target) === origin) {
		return { ...activity, target: { local: target } }
	}
	// ID-4: the target is fetched anew and must list the actor among its aliases.
	const fetched = await fetchActor(target, loaders.fresh, loaders.context)
	if (fetched.kind === 'transient') {
		return { status: 503, reason: 'target-unavailable' }
	}
	if (fetched.kind === 'unusable' || fetched.input === null) {
		return { status: 202, reason: 'unknown-target' }
	}
	if (!fetched.actor.aliasIds.some((alias) => alias.href === actorUri)) {
		return { status: 202, reason: 'not-alias' }
	}
	return { ...activity, target: fetched.input }
}
