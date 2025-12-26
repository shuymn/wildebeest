import { Actor, getAndCacheActor } from '@wildebeest/backend/activitypub/actors'
import { isNote, Note } from '@wildebeest/backend/activitypub/objects/note'
import { addPeer } from '@wildebeest/backend/activitypub/peers'
import { UA } from '@wildebeest/backend/config/ua'
import { type Database } from '@wildebeest/backend/database'
import * as query from '@wildebeest/backend/database/d1/querier'
import { insertReply } from '@wildebeest/backend/mastodon/reply'
import type { MastodonId } from '@wildebeest/backend/types'
import { HTTPS, isGone, isNotFound, isUUID } from '@wildebeest/backend/utils'
import { generateMastodonId } from '@wildebeest/backend/utils/id'
import { Intersect, RequiredProps, SingleOrArray } from '@wildebeest/backend/utils/type'

export const originalActorIdSymbol = Symbol()
export const originalObjectIdSymbol = Symbol()
export const mastodonIdSymbol = Symbol()

export type Remote<T extends ApObject> = Omit<ApObject, symbol> &
	Partial<Intersect<Omit<ApObject, symbol>, Omit<T, symbol>>>

// https://www.w3.org/TR/activitystreams-vocabulary/#object-types
export interface ApObject {
	'@context'?: SingleOrArray<string | Record<string, unknown>> | string[] | Record<string, unknown>[]
	// TODO: support string[]
	type: string
	// ObjectId, URL used for federation. Called `uri` in Mastodon APIs.
	// https://www.w3.org/TR/activitypub/#obj-id
	id: string | URL
	// Link to the HTML representation of the object
	url?: string | URL
	published?: string
	icon?: ApObject
	image?: ApObject
	summary?: string
	name?: string
	mediaType?: string
	content?: string
	cc?: SingleOrArray<ApObjectOrId>
	to?: SingleOrArray<ApObjectOrId>

	// Extension
	preferredUsername?: string
	sensitive?: boolean

	// Internal
	[originalActorIdSymbol]?: string
	[originalObjectIdSymbol]?: string
	[mastodonIdSymbol]?: MastodonId
}

export type ApObjectId<T extends ApObject = ApObject> = T['id']
export type ApObjectUrl<T extends ApObject = ApObject> = NonNullable<T['url']>
export type ApObjectOrId<T extends ApObject = ApObject> = T | ApObjectId<T>
export type ApObjectOrUrl<T extends ApObject = ApObject> = T | ApObjectUrl<T>

function parseUrl(value: string): URL {
	try {
		return new URL(value)
	} catch (err: unknown) {
		console.warn('invalid URL: ' + value)
		throw err
	}
}

export function getApId(value: ApObjectOrId): URL {
	if (typeof value === 'object') {
		if (value instanceof URL) {
			return value
		}
		if (value.id !== undefined) {
			return getApId(value.id)
		}
		throw new Error('unknown value: ' + JSON.stringify(value))
	}
	return parseUrl(value)
}

export function getApUrl(value: ApObjectOrUrl): URL {
	if (typeof value === 'object') {
		if (value instanceof URL) {
			return value
		}
		if (value.url !== undefined) {
			return getApUrl(value.url)
		}
		throw new Error('unknown value: ' + JSON.stringify(value))
	}
	return parseUrl(value)
}

export function getApType(obj: ApObject): string {
	if (typeof obj.type === 'string') {
		return obj.type
	}
	// TODO: support string[]
	// if (Array.isArray(obj.type) && obj.type.length > 0 && typeof obj.type[0] === 'string') {
	// 	return obj.type[0]
	// }
	throw new Error('`type` must be of type string or string[]')
}

// https://www.w3.org/TR/activitystreams-vocabulary/#dfn-document
export type Document = RequiredProps<ApObject, 'url'> & {
	type: 'Document'
	description?: string
	blurhash?: string
	width?: number
	height?: number
}

export function isDocument(object: ApObject): object is Document {
	return object.type === 'Document'
}

export function getObjectUrl(domain: string, id: string): URL {
	return new URL('/ap/o/' + id, HTTPS + domain)
}

export async function createObject<T extends ApObject>(
	domain: string,
	db: Database,
	type: T['type'],
	raw: Omit<T, 'id' | 'type'>,
	actorId: URL
): Promise<LocalObject<T>> {
	const now = new Date()
	const mastodonId = await generateMastodonId(db, 'objects', now)
	const apId = getObjectUrl(domain, crypto.randomUUID())

	const parts = actorId.pathname.split('/')
	if (parts.length === 0) {
		throw new Error('malformed URL')
	}
	const username = parts[parts.length - 1]

	const sanitized = await sanitizeObjectProperties({
		...raw,
		id: apId,
		type,
		url: raw.url ?? new URL(`/@${username}/${mastodonId}`, HTTPS + domain),
	})

	let replyToObjectId: string | null = null
	if (isNote(sanitized) && sanitized.inReplyTo) {
		const id = await cacheReply(domain, db, sanitized.inReplyTo, sanitized.attributedTo.toString(), 1)
		if (id) {
			replyToObjectId = id
		}
	}

	await query.insertLocalObject(db, {
		id: sanitized.id.toString(),
		mastodonId,
		type,
		cdate: now.toISOString(),
		originalActorId: actorId.toString(),
		replyToObjectId,
		properties: JSON.stringify(sanitized),
	})

	return {
		...sanitized,
		published: now.toISOString(),

		[mastodonIdSymbol]: mastodonId,
		[originalActorIdSymbol]: actorId.toString(),
		[originalObjectIdSymbol]: sanitized.id.toString(),
	} as LocalObject<T>
}

async function fetchObject<T extends ApObject>(url: URL): Promise<Remote<T> | null> {
	const res = await fetch(url, {
		headers: {
			accept: 'application/activity+json',
			'User-Agent': UA,
		},
	})
	if (!res.ok) {
		if (isNotFound(res) || isGone(res)) {
			return null
		}
		throw new Error(`${url} returned: ${res.status}`)
	}

	return res.json<T>()
}

export type LocalObject<T extends ApObject> = T & {
	published: string
	[mastodonIdSymbol]: string
	[originalActorIdSymbol]: string
	[originalObjectIdSymbol]: string
}

export type RemoteObject<T extends ApObject> = Remote<T> & {
	published: string
	[mastodonIdSymbol]: string
	[originalActorIdSymbol]: string
	[originalObjectIdSymbol]: string
}

type CacheResult<T extends ApObject> =
	| { created: true; object: RemoteObject<T> }
	| { created: false; object: RemoteObject<T> | null }

export async function getAndCacheObject<T extends ApObject>(
	domain: string,
	db: Database,
	obj: Remote<T> | string | URL,
	actor: Actor | string | URL,
	depth = 2
): Promise<CacheResult<T>> {
	{
		const cached = await getObjectByOriginalId<T>(domain, db, getApId(obj))
		if (cached) {
			return { created: false, object: cached }
		}
	}
	{
		const cached = await cacheObject<T>(domain, db, obj, actor, depth)
		if (cached) {
			return { created: true, object: cached }
		}
		return { created: false, object: null }
	}
}

async function cacheReply(
	domain: string,
	db: Database,
	objectId: string,
	actorId: string,
	depth: number
): Promise<string | null> {
	const row = await query.selectObjectByOriginalObjectId(db, { originalObjectId: objectId })
	if (row) {
		return row.id
	}

	const note = await cacheObject<Note>(domain, db, new URL(objectId), new URL(actorId), depth)
	return note?.id.toString() ?? null
}

async function cacheObject<T extends ApObject>(
	domain: string,
	db: Database,
	obj: Remote<T> | string | URL,
	actor: Actor | string | URL,
	depth: number
): Promise<RemoteObject<T> | null> {
	if (depth < 1) {
		return null
	}

	let actorId: URL
	if (isApObject(actor)) {
		actorId = getApId(actor)
	} else {
		let actorUrl: URL
		if (typeof actor !== 'string') {
			actorUrl = actor
		} else {
			actorUrl = new URL(actor)
		}

		const actr = await getAndCacheActor(actorUrl, db)
		if (!actr) {
			console.warn('actor not found: ' + actorUrl.toString())
			return null
		}

		actorId = actorUrl
	}

	let remoteObject: Remote<T>
	if (isApObject(obj)) {
		remoteObject = obj
	} else {
		let remoteObjectUrl: URL
		if (typeof obj !== 'string') {
			remoteObjectUrl = obj
		} else {
			remoteObjectUrl = new URL(obj)
		}
		const remoteObj = await fetchObject<T>(remoteObjectUrl)
		if (!remoteObj) {
			console.warn('object not found: ' + remoteObjectUrl)
			return null
		}
		remoteObject = remoteObj
	}

	const properties = await sanitizeObjectProperties(remoteObject)
	const originalObjectId = getApId(properties)

	const { inReplyTo, attributedTo } =
		isNote(properties) && properties.inReplyTo ? properties : { inReplyTo: null, attributedTo: null }

	const now = new Date()
	const mastodonId = await generateMastodonId(db, 'objects', now)

	const apId = getObjectUrl(domain, crypto.randomUUID())

	await query.insertRemoteObject(db, {
		id: apId.toString(),
		mastodonId: mastodonId,
		type: properties.type,
		cdate: now.toISOString(),
		originalActorId: actorId.toString(),
		originalObjectId: originalObjectId.toString(),
		replyToObjectId: inReplyTo ?? null,
		properties: JSON.stringify(properties),
	})

	// add reply
	if (inReplyTo && attributedTo) {
		const localObjectId = await cacheReply(domain, db, inReplyTo, attributedTo.toString(), depth - 1).catch((err) => {
			console.warn('failed to cache reply: ' + err)
			return null
		})
		if (localObjectId) {
			await insertReply(db, { id: actorId }, { id: apId }, { id: localObjectId }).catch((err) => {
				console.warn('failed to insert reply: ' + err)
			})
		}
	}

	// add peer
	await addPeer(db, originalObjectId.hostname).catch((err) => {
		console.warn('failed to add peer: ' + err)
	})

	return {
		...properties,
		id: apId,
		published: now.toISOString(),

		[mastodonIdSymbol]: mastodonId,
		[originalActorIdSymbol]: actorId.toString(),
		[originalObjectIdSymbol]: originalObjectId.toString(),
	}
}

export async function updateObjectProperty(db: Database, obj: ApObject, key: string, value: string) {
	await db
		.prepare(`UPDATE objects SET properties=${db.qb.jsonSet('properties', key, '?1')} WHERE id=?2`)
		.bind(value, obj.id.toString())
		.run()
}

export async function ensureObjectMastodonId(db: Database, mastodonId: MastodonId, cdate: string): Promise<MastodonId> {
	if (!isUUID(mastodonId)) {
		return mastodonId
	}
	const newMastodonId = await generateMastodonId(db, 'objects', new Date(cdate))
	await query.updateObjectMastodonIdByMastodonId(db, {
		next: newMastodonId,
		current: mastodonId,
	})
	return newMastodonId
}

export async function getObjectById<T extends ApObject>(
	domain: string,
	db: Database,
	id: string | URL
): Promise<RemoteObject<T> | null> {
	const row = await query.selectObject(db, { id: id.toString() })
	return getObjectBy<T>(domain, db, ObjectByKey.id, row)
}

export async function getObjectByOriginalId<T extends ApObject>(
	domain: string,
	db: Database,
	id: string | URL
): Promise<RemoteObject<T> | null> {
	const row = await query.selectObjectByOriginalObjectId(db, { originalObjectId: id.toString() })
	return getObjectBy<T>(domain, db, ObjectByKey.originalObjectId, row)
}

export async function getObjectByMastodonId<T extends ApObject>(
	domain: string,
	db: Database,
	id: MastodonId
): Promise<RemoteObject<T> | null> {
	const row = await query.selectObjectByMastodonId(db, { mastodonId: id })
	return getObjectBy<T>(domain, db, ObjectByKey.mastodonId, row)
}

export enum ObjectByKey {
	id = 'id',
	originalObjectId = 'original_object_id',
	mastodonId = 'mastodon_id',
}

const allowedObjectByKeysSet = new Set(Object.values(ObjectByKey))

async function getObjectBy<T extends ApObject>(
	domain: string,
	db: Database,
	key: ObjectByKey,
	row: query.SelectObjectRow | null
): Promise<RemoteObject<T> | null> {
	if (!allowedObjectByKeysSet.has(key)) {
		throw new Error('getObjectBy run with invalid key: ' + key)
	}
	if (!row || !row.originalActorId || !row.originalObjectId) {
		return null
	}

	const properties = JSON.parse(row.properties) as Remote<T>

	if (isNote(properties) && properties.inReplyTo) {
		await cacheReply(domain, db, properties.inReplyTo, properties.attributedTo.toString(), 1)
	}

	return {
		...properties,
		id: new URL(row.id),
		published: new Date(row.cdate).toISOString(),

		[mastodonIdSymbol]: await ensureObjectMastodonId(db, row.mastodonId, row.cdate),
		[originalActorIdSymbol]: row.originalActorId,
		[originalObjectIdSymbol]: row.originalObjectId,
	}
}

/** Is the given `value` an ActivityPub Object? */
export function isApObject(value: unknown): value is Remote<ApObject> {
	return value !== null && typeof value === 'object' && 'id' in value && 'type' in value
}

/** Sanitizes the ActivityPub Object `properties` prior to being stored in the DB. */
export async function sanitizeObjectProperties<T extends ApObject>(properties: T): Promise<T> {
	if (!isApObject(properties)) {
		throw new Error('Invalid object properties. Expected an object but got ' + JSON.stringify(properties))
	}
	if (properties.content) {
		properties.content = await sanitizeContent(properties.content)
	}
	if (properties.name) {
		properties.name = await getTextContent(properties.name)
	}
	return properties
}

/**
 * Sanitizes the given string as ActivityPub Object content.
 *
 * This sanitization follows that of Mastodon
 *  - convert all elements to `<p>` unless they are recognized as one of `<p>`, `<span>`, `<br>` or `<a>`.
 *  - remove all CSS classes that are not micro-formats or semantic.
 *
 * See https://docs.joinmastodon.org/spec/activitypub/#sanitization
 */
export async function sanitizeContent(unsafeContent: string): Promise<string> {
	if (unsafeContent === '') {
		return ''
	}
	return await getContentRewriter().transform(new Response(unsafeContent)).text()
}

/**
 * This method removes all HTML elements from the string leaving only the text content.
 */
export async function getTextContent(unsafeName: string): Promise<string> {
	if (unsafeName === '') {
		return ''
	}
	const rawContent = getTextContentRewriter().transform(new Response(unsafeName))
	const text = await rawContent.text()
	return text.trim()
}

function getContentRewriter() {
	const contentRewriter = new HTMLRewriter()
	contentRewriter.on('*', {
		element(el) {
			if (!['p', 'span', 'br', 'a'].includes(el.tagName)) {
				const element = el as { tagName: string }
				element.tagName = 'p'
			}

			if (el.hasAttribute('class')) {
				const classes = el.getAttribute('class')!.split(/\s+/)
				const sanitizedClasses = classes.filter((c) =>
					/^(h|p|u|dt|e)-|^mention$|^hashtag$|^ellipsis$|^invisible$/.test(c)
				)
				el.setAttribute('class', sanitizedClasses.join(' '))
			}
		},
	})
	return contentRewriter
}

function getTextContentRewriter() {
	const textContentRewriter = new HTMLRewriter()
	textContentRewriter.on('*', {
		element(el) {
			el.removeAndKeepContent()
			if (['p', 'br'].includes(el.tagName)) {
				el.after(' ')
			}
		},
	})
	return textContentRewriter
}

// TODO: eventually use SQLite's `ON DELETE CASCADE` but requires writing the DB
// schema directly into D1, which D1 disallows at the moment.
// Some context at: https://stackoverflow.com/questions/13150075/add-on-delete-cascade-behavior-to-an-sqlite3-table-after-it-has-been-created
export async function deleteObject<T extends ApObject>(db: Database, note: T) {
	const nodeId = note.id.toString()
	const batch = [
		db.prepare('DELETE FROM outbox_objects WHERE object_id=?').bind(nodeId),
		db.prepare('DELETE FROM inbox_objects WHERE object_id=?').bind(nodeId),
		db.prepare('DELETE FROM actor_notifications WHERE object_id=?').bind(nodeId),
		db.prepare('DELETE FROM actor_favourites WHERE object_id=?').bind(nodeId),
		db.prepare('DELETE FROM actor_reblogs WHERE object_id=?').bind(nodeId),
		db.prepare('DELETE FROM actor_replies WHERE object_id=?1 OR in_reply_to_object_id=?1').bind(nodeId),
		db.prepare('DELETE FROM idempotency_keys WHERE object_id=?').bind(nodeId),
		db.prepare('DELETE FROM note_hashtags WHERE object_id=?').bind(nodeId),
		db.prepare('DELETE FROM object_revisions WHERE object_id=?').bind(nodeId),
		db.prepare('DELETE FROM objects WHERE id=?').bind(nodeId),
	]

	const res = await db.batch(batch)

	for (let i = 0, len = res.length; i < len; i++) {
		if (!res[i].success) {
			throw new Error('SQL error: ' + res[i].error)
		}
	}
}

export function isLocalObject(domain: string, id: URL): boolean {
	return id.hostname === domain
}
