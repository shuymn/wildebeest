import { addPeer } from 'wildebeest/backend/src/activitypub/peers'
import { type Database } from 'wildebeest/backend/src/database'
import type { MastodonId } from 'wildebeest/backend/src/types'
import { isUUID } from 'wildebeest/backend/src/utils'
import { generateMastodonId } from 'wildebeest/backend/src/utils/id'
import { AwaitedOnce, Intersect, RequiredProps, SingleOrArray } from 'wildebeest/backend/src/utils/type'
import { UA } from 'wildebeest/config/ua'

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
	inReplyTo?: string | null
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

export type ApObjectId = ApObject['id']
export type ApObjectUrl = NonNullable<ApObject['url']>
export type ApObjectOrId = ApObject | ApObjectId
export type ApObjectOrUrl = ApObject | ApObjectUrl

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
}

export function isDocument(object: ApObject): object is Document {
	return object.type === 'Document'
}

export function uri(domain: string, id: string): URL {
	return new URL('/ap/o/' + id, 'https://' + domain)
}

export async function createObject<T extends ApObject>(
	domain: string,
	db: Database,
	type: T['type'],
	properties: Omit<T, 'id' | 'type'>,
	originalActorId: URL,
	local: boolean
) {
	const now = new Date()
	const mastodonId = await generateMastodonId(db, 'objects', now)
	const apId = uri(domain, crypto.randomUUID())

	const parts = originalActorId.pathname.split('/')
	if (parts.length === 0) {
		throw new Error('malformed URL')
	}
	const username = parts[parts.length - 1]

	properties = await sanitizeObjectProperties({
		id: apId,
		url: local ? new URL(`/@${username}/${mastodonId}`, 'https://' + domain) : undefined,
		type,
		...properties,
	})

	const { success, error } = await db
		.prepare(
			`INSERT INTO objects(id, type, properties, original_actor_id, local, mastodon_id, cdate, reply_to_object_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			apId.toString(),
			type,
			JSON.stringify(properties),
			originalActorId.toString(),
			local ? 1 : 0,
			mastodonId,
			now.toISOString(),
			properties.inReplyTo ? properties.inReplyTo.toString() : null
		)
		.run()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}

	return {
		...properties,
		type,
		id: apId,
		published: now.toISOString(),

		[mastodonIdSymbol]: mastodonId,
		[originalActorIdSymbol]: originalActorId.toString(),
	}
}

export async function get<T>(url: URL): Promise<T> {
	const headers = {
		accept: 'application/activity+json',
		'User-Agent': UA,
	}
	const res = await fetch(url, { headers })
	if (!res.ok) {
		throw new Error(`${url} returned: ${res.status}`)
	}

	return res.json<T>()
}

type CacheObjectResult<T extends ApObject> = {
	created: boolean
	object: Exclude<AwaitedOnce<ReturnType<typeof getObjectBy<T>>>, null>
}

export async function cacheObject<T extends ApObject>(
	domain: string,
	db: Database,
	properties: T,
	originalActorId: URL,
	originalObjectId: URL,
	local: boolean
): Promise<CacheObjectResult<T>> {
	const sanitizedProperties = await sanitizeObjectProperties(properties)

	const cachedObject = await getObjectBy<T>(db, ObjectByKey.originalObjectId, originalObjectId.toString())
	if (cachedObject !== null) {
		return {
			created: false,
			object: cachedObject,
		}
	}

	const now = new Date()
	const mastodonId = await generateMastodonId(db, 'objects', now)
	const apId = uri(domain, crypto.randomUUID()).toString()

	const row = await db
		.prepare(
			'INSERT INTO objects(id, type, properties, original_actor_id, original_object_id, local, mastodon_id, cdate) VALUES(?, ?, ?, ?, ?, ?, ?, ?) RETURNING *'
		)
		.bind(
			apId,
			sanitizedProperties.type,
			JSON.stringify(sanitizedProperties),
			originalActorId.toString(),
			originalObjectId.toString(),
			local ? 1 : 0,
			mastodonId,
			now.toISOString()
		)
		.first<{
			properties: string | object
			cdate: string
			type: string
			id: string
			mastodon_id: string
			original_actor_id: string
			original_object_id: string
		}>()
	if (!row) {
		throw new Error('failed to insert object')
	}

	// Add peer
	{
		const domain = originalObjectId.host
		await addPeer(db, domain)
	}

	{
		let properties
		if (typeof row.properties === 'object') {
			// neon uses JSONB for properties which is returned as a deserialized
			// object.
			properties = row.properties
		} else {
			// D1 uses a string for JSON properties
			properties = JSON.parse(row.properties)
		}
		return {
			created: true,
			object: {
				...properties,
				published: new Date(row.cdate).toISOString(),

				type: row.type,
				id: new URL(row.id),

				[mastodonIdSymbol]: row.mastodon_id,
				[originalActorIdSymbol]: row.original_actor_id,
				[originalObjectIdSymbol]: row.original_object_id,
			},
		}
	}
}

export async function updateObject<T>(db: Database, properties: T, id: URL): Promise<boolean> {
	// eslint-disable-next-line unused-imports/no-unused-vars
	const res: any = await db
		.prepare('UPDATE objects SET properties = ? WHERE id = ?')
		.bind(JSON.stringify(properties), id.toString())
		.run()

	// TODO: D1 doesn't return changes at the moment
	// return res.changes === 1
	return true
}

export async function updateObjectProperty(db: Database, obj: ApObject, key: string, value: string) {
	const { success, error } = await db
		.prepare(`UPDATE objects SET properties=${db.qb.jsonSet('properties', key, '?1')} WHERE id=?2`)
		.bind(value, obj.id.toString())
		.run()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}
}

export async function ensureObjectMastodonId(db: Database, mastodonId: MastodonId, cdate: string): Promise<MastodonId> {
	if (!isUUID(mastodonId)) {
		return mastodonId
	}
	const newMastodonId = await generateMastodonId(db, 'objects', new Date(cdate))
	const { success, error } = await db
		.prepare(`UPDATE objects SET mastodon_id=?1 WHERE mastodon_id=?2`)
		.bind(newMastodonId, mastodonId)
		.run()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}
	return newMastodonId
}

export async function getObjectById<T extends ApObject>(db: Database, id: string | URL) {
	return getObjectBy<T>(db, ObjectByKey.id, id.toString())
}

export async function getObjectByOriginalId<T extends ApObject>(db: Database, id: string | URL) {
	return getObjectBy<T>(db, ObjectByKey.originalObjectId, id.toString())
}

export async function getObjectByMastodonId<T extends ApObject>(db: Database, id: MastodonId) {
	return getObjectBy<T>(db, ObjectByKey.mastodonId, id)
}

export enum ObjectByKey {
	id = 'id',
	originalObjectId = 'original_object_id',
	mastodonId = 'mastodon_id',
}

const allowedObjectByKeysSet = new Set(Object.values(ObjectByKey))

export async function getObjectBy<T extends ApObject>(
	db: Database,
	key: ObjectByKey,
	value: string
): Promise<(T & { published: string; [mastodonIdSymbol]: string; [originalActorIdSymbol]: string }) | null> {
	if (!allowedObjectByKeysSet.has(key)) {
		throw new Error('getObjectBy run with invalid key: ' + key)
	}
	const query = `
		SELECT *
		FROM objects
		WHERE objects.${key}=?
	`
	const { results, success, error } = await db.prepare(query).bind(value).all<{
		id: string
		mastodon_id: string
		type: string
		cdate: string
		original_actor_id: string
		original_object_id: string | null
		reply_to_object_id: string | null
		properties: string | object
		local: 1 | 0
	}>()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}
	if (!results || results.length === 0) {
		return null
	}

	const [result] = results
	let properties
	if (typeof result.properties === 'object') {
		// neon uses JSONB for properties which is returned as a deserialized
		// object.
		properties = result.properties as T
	} else {
		// D1 uses a string for JSON properties
		properties = JSON.parse(result.properties) as T
	}

	return {
		...properties,
		published: new Date(result.cdate).toISOString(),

		type: result.type,
		id: new URL(result.id),

		[mastodonIdSymbol]: await ensureObjectMastodonId(db, result.mastodon_id, result.cdate),
		[originalActorIdSymbol]: result.original_actor_id,
		[originalObjectIdSymbol]: result.original_object_id ?? undefined,
	}
}

/** Is the given `value` an ActivityPub Object? */
export function isApObject(value: unknown): value is ApObject {
	return value !== null && typeof value === 'object'
}

/** Sanitizes the ActivityPub Object `properties` prior to being stored in the DB. */
export async function sanitizeObjectProperties<T extends ApObject>(properties: T): Promise<T> {
	if (!isApObject(properties)) {
		throw new Error('Invalid object properties. Expected an object but got ' + JSON.stringify(properties))
	}
	const sanitized: T = {
		...properties,
	}
	if ('content' in properties) {
		sanitized.content = await sanitizeContent(properties.content as string)
	}
	if ('name' in properties) {
		sanitized.name = await getTextContent(properties.name as string)
	}
	return sanitized
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
		db.prepare('DELETE FROM objects WHERE id=?').bind(nodeId),
	]

	const res = await db.batch(batch)

	for (let i = 0, len = res.length; i < len; i++) {
		if (!res[i].success) {
			throw new Error('SQL error: ' + res[i].error)
		}
	}
}

export function isLocalObject(domain: string, id: string | URL): boolean {
	const apId = getApId(id)
	return apId.hostname === domain
}
