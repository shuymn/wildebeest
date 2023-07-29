import { isLocalAccount } from 'wildebeest/backend/src/accounts/getAccount'
import { PUBLIC_GROUP } from 'wildebeest/backend/src/activitypub/activities'
import {
	type Actor,
	actorFromRow,
	actorURL,
	getActorById,
	getActorByRemoteHandle,
	getAndCache,
} from 'wildebeest/backend/src/activitypub/actors'
import {
	ensureObjectMastodonId,
	getApId,
	getObjectByMastodonId,
	mastodonIdSymbol,
	originalActorIdSymbol,
} from 'wildebeest/backend/src/activitypub/objects'
import { type Note } from 'wildebeest/backend/src/activitypub/objects/note'
import { type Database } from 'wildebeest/backend/src/database'
import { loadMastodonAccount } from 'wildebeest/backend/src/mastodon/account'
import * as media from 'wildebeest/backend/src/media/'
import type { MastodonId, MastodonStatus, Visibility } from 'wildebeest/backend/src/types'
import type { MediaAttachment } from 'wildebeest/backend/src/types/media'
import { actorToAcct, actorToHandle, handleToAcct, parseHandle } from 'wildebeest/backend/src/utils/handle'
import { queryAcct } from 'wildebeest/backend/src/webfinger'

export async function getMentions(input: string, instanceDomain: string, db: Database): Promise<Set<Actor>> {
	const actors = new Set<Actor>()
	const mentions = new Set<string>()

	for (let i = 0, len = input.length; i < len; i++) {
		if (input[i] === '@') {
			i++
			let buffer = ''
			while (i < len && /[^\s<]/.test(input[i])) {
				buffer += input[i]
				i++
			}

			// prevent multiple mentions to the same person
			if (mentions.has(buffer)) {
				continue
			}
			const handle = parseHandle(buffer)
			const targetActor = isLocalAccount(instanceDomain, handle)
				? await getActorById(db, actorURL(instanceDomain, handle))
				: (await getActorByRemoteHandle(db, handle)) ?? (await queryAcct(handle, db))
			if (targetActor === null) {
				console.warn(`actor ${buffer} not found`)
				mentions.add(buffer)
				continue
			}
			mentions.add(buffer)
			actors.add(targetActor)
		}
	}
	return actors
}

function actorToMention(domain: string, actor: Actor): MastodonStatus['mentions'][number] {
	return {
		id: actor[mastodonIdSymbol],
		username: actor.preferredUsername ?? actor.name ?? '',
		url: actor.url?.toString() ?? '',
		acct: actorToAcct(actor, domain),
	}
}

export async function toMastodonStatusFromObject(
	db: Database,
	obj: Note,
	domain: string,
	targetActors?: Set<Actor>
): Promise<MastodonStatus | null> {
	if (obj[originalActorIdSymbol] === undefined) {
		console.warn('missing `obj.originalActorId`')
		return null
	}

	const actorId = new URL(obj[originalActorIdSymbol])
	const actor = await getAndCache(actorId, db)
	const handle = actorToHandle(actor)

	// FIXME: temporarily disable favourites and reblogs counts
	const favourites = []
	const reblogs = []
	// const favourites = await getLikes(db, obj)
	// const reblogs = await getReblogs(db, obj)

	let mediaAttachments: Array<MediaAttachment> = []

	if (Array.isArray(obj.attachment)) {
		mediaAttachments = obj.attachment.map(media.fromObject)
	}

	const mentions = []
	if (targetActors) {
		for (const actor of targetActors) {
			mentions.push(actorToMention(domain, actor))
		}
	} else {
		for (const link of obj.tag) {
			if (link.type === 'Mention') {
				const actor = await getActorById(db, link.href)
				if (actor) {
					mentions.push(actorToMention(domain, actor))
				}
			}
		}
	}

	return {
		// Default values
		emojis: [],
		tags: [],
		mentions,
		spoiler_text: obj.spoiler_text ?? '',

		visibility: detectVisibility(obj),

		media_attachments: mediaAttachments,
		content: obj.content || '',
		id: obj[mastodonIdSymbol] || '',
		uri: getApId(obj.id),
		url: new URL(`/@${handleToAcct(handle, domain)}/${obj[mastodonIdSymbol]}`, 'https://' + domain),
		created_at: obj.published || '',
		account: await loadMastodonAccount(db, domain, actor, handle),

		favourites_count: favourites.length,
		reblogs_count: reblogs.length,
	}
}

type MastodonStatusRow = {
	actor_id: string
	actor_type: Actor['type']
	actor_pubkey: string | null
	actor_cdate: string
	actor_properties: string
	actor_is_admin: 1 | null
	actor_mastodon_id: string

	mastodon_id: string
	id: string
	cdate: string
	properties: string | object
	reblogged?: 1 | 0
	favourited?: 1 | 0

	publisher_actor_id?: string
	favourites_count?: number
	reblogs_count?: number
	replies_count?: number
}

export async function toMastodonStatusesFromRowsWithActor(
	domain: string,
	db: Database,
	actor: Actor,
	rows: Omit<
		MastodonStatusRow,
		| 'actor_id'
		| 'actor_type'
		| 'actor_pubkey'
		| 'actor_cdate'
		| 'actor_properties'
		| 'actor_is_admin'
		| 'actor_mastodon_id'
	>[]
): Promise<MastodonStatus[]> {
	const actorPool = new Map<string, Actor>()
	const account = await loadMastodonAccount(db, domain, actor, actorToHandle(actor))
	const acct = actorToAcct(actor, domain)

	const statuses: MastodonStatus[] = []
	for (const row of rows) {
		row.mastodon_id = await ensureObjectMastodonId(db, row.mastodon_id, row.cdate)

		if (row.publisher_actor_id === undefined) {
			console.warn('missing `row.publisher_actor_id`')
			continue
		}
		if (row.favourites_count === undefined || row.reblogs_count === undefined || row.replies_count === undefined) {
			throw new Error('logic error; missing fields.')
		}

		let properties
		if (typeof row.properties === 'object') {
			// neon uses JSONB for properties which is returned as a deserialized
			// object.
			properties = row.properties as Partial<Note>
		} else {
			// D1 uses a string for JSON properties
			properties = JSON.parse(row.properties) as Partial<Note>
		}

		const mediaAttachments: MediaAttachment[] = []
		if (Array.isArray(properties.attachment)) {
			for (const document of properties.attachment) {
				mediaAttachments.push(media.fromObject(document))
			}
		}

		const mentions = []
		for (const link of properties.tag ?? []) {
			if (link.type === 'Mention') {
				const actorId = link.href.toString()
				let actor = actorPool.get(actorId) ?? null
				if (actor === undefined) {
					actor = await getActorById(db, link.href)
					if (actor === null) {
						continue
					}
					actorPool.set(actorId, actor)
				}
				if (actor) {
					mentions.push({
						id: actor[mastodonIdSymbol],
						username: actor.preferredUsername ?? actor.name ?? '',
						url: actor.url?.toString() ?? '',
						acct: actorToAcct(actor, domain),
					})
				}
			}
		}

		const status: MastodonStatus = {
			id: row.mastodon_id,
			url: new URL(`/@${acct}/${row.mastodon_id}`, 'https://' + domain),
			uri: new URL(row.id),
			created_at: new Date(row.cdate).toISOString(),
			media_attachments: mediaAttachments,
			mentions: mentions,
			account,
			spoiler_text: properties.spoiler_text ?? '',
			visibility: detectVisibility({
				to: properties.to ?? [PUBLIC_GROUP],
				cc: properties.cc ?? [],
				attributedTo: properties.attributedTo ?? '',
			}),
			content: properties.content ?? '',
			favourites_count: row.favourites_count,
			reblogs_count: row.reblogs_count,
			replies_count: row.replies_count,
			reblogged: row.reblogged === 1,
			favourited: row.favourited === 1,

			// FIXME: stub values
			emojis: [],
			tags: [],
		}

		if (properties.updated) {
			status.edited_at = new Date(properties.updated).toISOString()
		}
		if (properties.attributedTo && properties.attributedTo !== row.publisher_actor_id) {
			const actorId = new URL(properties.attributedTo)
			const author = await getAndCache(actorId, db)

			status.reblog = {
				...status,
				account: await loadMastodonAccount(db, domain, author, actorToHandle(author)),
			}
		}
		statuses.push(status)
	}
	return statuses
}

// toMastodonStatusFromRow makes assumption about what field are available on
// the `row` object. This function is only used for timelines, which is optimized
// SQL. Otherwise don't use this function.
export async function toMastodonStatusFromRow(
	domain: string,
	db: Database,
	row: MastodonStatusRow
): Promise<MastodonStatus | null> {
	if (row.publisher_actor_id === undefined) {
		console.warn('missing `row.publisher_actor_id`')
		return null
	}
	let properties
	if (typeof row.properties === 'object') {
		// neon uses JSONB for properties which is returned as a deserialized
		// object.
		properties = row.properties as Partial<Note>
	} else {
		// D1 uses a string for JSON properties
		properties = JSON.parse(row.properties) as Partial<Note>
	}
	const author = actorFromRow({
		id: row.actor_id,
		type: row.actor_type,
		pubkey: row.actor_pubkey,
		cdate: row.actor_cdate,
		properties: row.actor_properties,
		is_admin: row.actor_is_admin,
		mastodon_id: row.actor_mastodon_id,
	})

	if (row.favourites_count === undefined || row.reblogs_count === undefined || row.replies_count === undefined) {
		throw new Error('logic error; missing fields.')
	}

	const mediaAttachments: Array<MediaAttachment> = []

	if (Array.isArray(properties.attachment)) {
		for (let i = 0, len = properties.attachment.length; i < len; i++) {
			const document = properties.attachment[i]
			mediaAttachments.push(media.fromObject(document))
		}
	}

	const handle = actorToHandle(author)
	const status: MastodonStatus = {
		id: row.mastodon_id,
		url: new URL(`/@${handleToAcct(handle, domain)}/${row.mastodon_id}`, 'https://' + domain),
		uri: new URL(row.id),
		created_at: new Date(row.cdate).toISOString(),
		emojis: [],
		media_attachments: mediaAttachments,
		tags: [],
		mentions: [],
		account: await loadMastodonAccount(db, domain, author, handle),
		spoiler_text: properties.spoiler_text ?? '',

		visibility: detectVisibility({
			to: properties.to ?? [PUBLIC_GROUP],
			cc: properties.cc ?? [],
			attributedTo: properties.attributedTo ?? '',
		}),

		content: properties.content ?? '',
		favourites_count: row.favourites_count,
		reblogs_count: row.reblogs_count,
		replies_count: row.replies_count,
		reblogged: row.reblogged === 1,
		favourited: row.favourited === 1,
	}

	if (properties.updated) {
		status.edited_at = new Date(properties.updated).toISOString()
	}

	// FIXME: add unit tests for reblog
	if (properties.attributedTo && properties.attributedTo !== row.publisher_actor_id) {
		// The actor that introduced the Object in the instance isn't the same
		// as the object has been attributed to. Likely means it's a reblog.

		const actorId = new URL(properties.attributedTo)
		const author = await getAndCache(actorId, db)

		// Restore reblogged status
		status.reblog = {
			...status,
			account: await loadMastodonAccount(db, domain, author, actorToHandle(author)),
		}
	}

	return status
}

export async function getMastodonStatusById(
	db: Database,
	id: MastodonId,
	domain: string
): Promise<MastodonStatus | null> {
	const obj = await getObjectByMastodonId<Note>(db, id)
	if (obj === null) {
		return null
	}
	return toMastodonStatusFromObject(db, obj, domain)
}

function detectVisibility({ to, cc, attributedTo }: Pick<Note, 'to' | 'cc' | 'attributedTo'>): Visibility {
	to = Array.isArray(to) ? to : [to]
	cc = Array.isArray(cc) ? cc : [cc]

	if (to.includes(PUBLIC_GROUP)) {
		return 'public'
	}
	if (to.includes(attributedTo.toString() + '/followers')) {
		if (cc.includes(PUBLIC_GROUP)) {
			return 'unlisted'
		}
		return 'private'
	}
	return 'direct'
}
