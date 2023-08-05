import { getUserId, isLocalAccount } from 'wildebeest/backend/src/accounts'
import { PUBLIC_GROUP } from 'wildebeest/backend/src/activitypub/activities'
import {
	type Actor,
	actorFromRow,
	getActorById,
	getActorByRemoteHandle,
	getAndCache,
} from 'wildebeest/backend/src/activitypub/actors'
import {
	ensureObjectMastodonId,
	getApId,
	getObjectById,
	getObjectByMastodonId,
	getObjectByOriginalId,
	isLocalObject,
	mastodonIdSymbol,
	originalActorIdSymbol,
} from 'wildebeest/backend/src/activitypub/objects'
import { type Note } from 'wildebeest/backend/src/activitypub/objects/note'
import { type Database } from 'wildebeest/backend/src/database'
import { loadMastodonAccount } from 'wildebeest/backend/src/mastodon/account'
import { ensureReblogMastodonId } from 'wildebeest/backend/src/mastodon/reblog'
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
				? await getActorById(db, getUserId(instanceDomain, handle))
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

export function actorToMention(domain: string, actor: Actor): MastodonStatus['mentions'][number] {
	return {
		id: actor[mastodonIdSymbol],
		username: actor.preferredUsername ?? actor.name ?? '',
		url: actor.url?.toString() ?? '',
		acct: actorToAcct(actor, domain),
	}
}

export async function toMastodonStatusFromObject(
	db: Database,
	obj: Note & { published: string; [mastodonIdSymbol]: string },
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

	const mediaAttachments: Array<MediaAttachment> = obj.attachment.map((doc) => media.fromObject(doc))

	const mentions = []
	if (targetActors) {
		for (const target of targetActors) {
			mentions.push(actorToMention(domain, target))
		}
	} else {
		for (const link of obj.tag ?? []) {
			if (link.type === 'Mention') {
				const target = actor.id.toString() === link.href.toString() ? actor : await getActorById(db, link.href)
				if (target) {
					mentions.push(actorToMention(domain, target))
				}
			}
		}
	}
	let inReplyToId: string | null = null
	let inReplyToAccountId: string | null = null
	if (obj.inReplyTo) {
		const replied = isLocalObject(domain, obj.inReplyTo)
			? await getObjectById(db, obj.inReplyTo)
			: await getObjectByOriginalId(db, obj.inReplyTo)
		if (replied) {
			inReplyToId = replied[mastodonIdSymbol]
			try {
				const author = await getAndCache(new URL(replied[originalActorIdSymbol]), db)
				inReplyToAccountId = author[mastodonIdSymbol]
			} catch (err) {
				console.warn('failed to get author of reply', err)
				inReplyToId = null
			}
		}
	}

	return {
		id: await ensureObjectMastodonId(db, obj[mastodonIdSymbol], obj.published ?? new Date().toISOString()),
		uri: getApId(obj.id),
		created_at: new Date(obj.published).toISOString(),
		account: await loadMastodonAccount(db, domain, actor, handle),
		content: obj.content ?? '',
		visibility: detectVisibility({ to: obj.to, cc: obj.cc, followers: actor.followers }),
		sensitive: obj.sensitive,
		spoiler_text: obj.spoiler_text ?? '',
		media_attachments: mediaAttachments,
		mentions,
		url: obj.url
			? new URL(obj.url)
			: isLocalAccount(domain, handle)
			? new URL(`/@${handleToAcct(handle, domain)}/${obj[mastodonIdSymbol]}`, 'https://' + domain)
			: new URL(obj.id),
		reblog: null,
		edited_at: obj.updated ? new Date(obj.updated).toISOString() : null,

		// FIXME: stub values
		emojis: [],
		tags: [],
		in_reply_to_id: inReplyToId,
		in_reply_to_account_id: inReplyToAccountId,
		reblogs_count: reblogs.length,
		favourites_count: favourites.length,
		replies_count: 0,
		favourited: false,
		reblogged: false,
		poll: null,
		card: null,
		language: null,
		text: null,
		muted: false,
		bookmarked: false,
		pinned: false,
		// filtered
	}
}

type ReblogRow = {
	reblog_id: string
	reblog_mastodon_id: string
	publisher_actor_id: string
	publisher_published: string
}

type MastodonStatusRow = {
	actor_id: string
	actor_mastodon_id: string
	actor_type: Actor['type']
	actor_properties: string
	actor_cdate: string

	mastodon_id: string
	id: string
	cdate: string
	properties: string | object
	reblogged?: 1 | 0
	favourited?: 1 | 0

	publisher_actor_id?: string
	publisher_published?: string
	publisher_to: string
	publisher_cc: string

	favourites_count?: number
	reblogs_count?: number
	replies_count?: number
} & (ReblogRow | { reblog_id: null })

type MastodonStatusRowWithoutActor = Omit<
	MastodonStatusRow,
	| 'actor_id'
	| 'actor_type'
	| 'actor_pubkey'
	| 'actor_cdate'
	| 'actor_properties'
	| 'actor_is_admin'
	| 'actor_mastodon_id'
>

function isReblogRow(row: MastodonStatusRowWithoutActor): row is MastodonStatusRowWithoutActor & ReblogRow {
	return row.reblog_id !== null
}

export async function toMastodonStatusesFromRowsWithActor(
	domain: string,
	db: Database,
	actor: Actor,
	rows: MastodonStatusRowWithoutActor[]
): Promise<MastodonStatus[]> {
	const actorPool = new Map<string, Actor>()
	const handle = actorToHandle(actor)
	const account = await loadMastodonAccount(db, domain, actor, handle)

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
			properties = row.properties as Note
		} else {
			// D1 uses a string for JSON properties
			properties = JSON.parse(row.properties) as Note
		}

		const mediaAttachments = Array.isArray(properties.attachment)
			? properties.attachment.map((doc) => media.fromObject(doc))
			: []

		const mentions = []
		for (const link of properties.tag ?? []) {
			if (link.type === 'Mention') {
				const targetId = link.href.toString()
				let target = actorPool.get(targetId) ?? null
				if (target === null) {
					try {
						target = await getAndCache(link.href, db)
						actorPool.set(targetId, target)
					} catch (err) {
						console.warn('failed to get actor', err)
					}
				}
				if (target) {
					mentions.push(actorToMention(domain, target))
				}
			}
		}
		let inReplyToId: string | null = null
		let inReplyToAccountId: string | null = null
		if (properties.inReplyTo) {
			const replied = isLocalObject(domain, properties.inReplyTo)
				? await getObjectById(db, properties.inReplyTo)
				: await getObjectByOriginalId(db, properties.inReplyTo)
			if (replied) {
				inReplyToId = replied[mastodonIdSymbol]
				let author = actorPool.get(replied[originalActorIdSymbol]) ?? null
				if (author === null) {
					try {
						author = await getAndCache(new URL(replied[originalActorIdSymbol]), db)
						actorPool.set(replied[originalActorIdSymbol], author)
					} catch (err) {
						console.warn('failed to get author of reply', err)
						inReplyToId = null
					}
				}
				if (author) {
					inReplyToAccountId = author[mastodonIdSymbol]
				}
			}
		}

		let status: MastodonStatus
		if (isReblogRow(row)) {
			const actorId = properties.attributedTo.toString()
			let statusAuthor = actorPool.get(actorId) ?? null
			if (statusAuthor === null) {
				statusAuthor = await getAndCache(new URL(actorId), db)
				if (statusAuthor === null) {
					continue
				}
				actorPool.set(actorId, statusAuthor)
			}
			const statusAuthorHandle = actorToHandle(statusAuthor)

			const reblogVisibility = detectVisibility({
				to: JSON.parse(row.publisher_to) as string[],
				cc: JSON.parse(row.publisher_cc) as string[],
				followers: actor.followers,
			})

			status = {
				id: await ensureReblogMastodonId(db, row.reblog_mastodon_id, row.publisher_published),
				uri: new URL(row.reblog_id),
				created_at: new Date(row.publisher_published).toISOString(),
				account,
				content: '',
				visibility: reblogVisibility,
				sensitive: false,
				spoiler_text: '',
				media_attachments: [],
				mentions: [],
				tags: [],
				emojis: [],
				reblogs_count: 0,
				favourites_count: 0,
				replies_count: 0,
				url: null,
				in_reply_to_id: null,
				in_reply_to_account_id: null,
				reblog: {
					id: row.mastodon_id,
					uri: new URL(properties.id),
					created_at: new Date(properties.published ?? row.cdate).toISOString(),
					account: await loadMastodonAccount(db, domain, statusAuthor, actorToHandle(statusAuthor)),
					content: properties.content ?? '',
					visibility: detectVisibility({ to: properties.to, cc: properties.cc, followers: statusAuthor.followers }),
					sensitive: properties.sensitive,
					spoiler_text: properties.spoiler_text ?? '',
					media_attachments: mediaAttachments,
					mentions,
					reblogs_count: row.reblogs_count,
					favourites_count: row.favourites_count,
					replies_count: row.replies_count,
					url: properties.url
						? new URL(properties.url)
						: isLocalAccount(domain, statusAuthorHandle)
						? new URL(`/@${handleToAcct(statusAuthorHandle, domain)}/${row.mastodon_id}`, 'https://' + domain)
						: new URL(row.id),
					reblog: null,
					edited_at: properties.updated ? new Date(properties.updated).toISOString() : null,
					favourited: row.favourited === 1,
					reblogged: row.reblogged === 1,
					in_reply_to_id: inReplyToId,
					in_reply_to_account_id: inReplyToAccountId,

					// FIXME: stub values
					tags: [],
					emojis: [],
					poll: null,
					card: null,
					language: null,
					text: null,
					muted: false,
					bookmarked: false,
					pinned: false,
					// filtered
				},
				poll: null,
				card: null,
				language: null,
				text: null,
				edited_at: null,
			}
		} else {
			status = {
				id: await ensureObjectMastodonId(db, row.mastodon_id, row.cdate),
				uri: new URL(row.id),
				created_at: new Date(properties.published ?? row.cdate).toISOString(),
				account,
				content: properties.content ?? '',
				visibility: detectVisibility({ to: properties.to, cc: properties.cc, followers: actor.followers }),
				sensitive: properties.sensitive,
				spoiler_text: properties.spoiler_text ?? '',
				media_attachments: mediaAttachments,
				mentions,
				reblogs_count: row.reblogs_count,
				favourites_count: row.favourites_count,
				replies_count: row.replies_count,
				url: properties.url
					? new URL(properties.url)
					: isLocalAccount(domain, handle)
					? new URL(`/@${handleToAcct(handle, domain)}/${row.mastodon_id}`, 'https://' + domain)
					: new URL(row.id),
				reblog: null,
				edited_at: properties.updated ? new Date(properties.updated).toISOString() : null,
				favourited: row.favourited === 1,
				reblogged: row.reblogged === 1,
				in_reply_to_id: inReplyToId,
				in_reply_to_account_id: inReplyToAccountId,

				// FIXME: stub values
				emojis: [],
				tags: [],
				poll: null,
				card: null,
				language: null,
				text: null,
				muted: false,
				bookmarked: false,
				pinned: false,
				// filtered
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
	if (row.favourites_count === undefined || row.reblogs_count === undefined || row.replies_count === undefined) {
		throw new Error('logic error; missing fields.')
	}

	let properties
	if (typeof row.properties === 'object') {
		// neon uses JSONB for properties which is returned as a deserialized
		// object.
		properties = row.properties as Note
	} else {
		// D1 uses a string for JSON properties
		properties = JSON.parse(row.properties) as Note
	}

	const mediaAttachments = Array.isArray(properties.attachment)
		? properties.attachment.map((doc) => media.fromObject(doc))
		: []

	const author = actorFromRow({
		id: row.actor_id,
		type: row.actor_type,
		cdate: row.actor_cdate,
		properties: row.actor_properties,
		mastodon_id: row.actor_mastodon_id,
	})

	const handle = actorToHandle(author)
	const account = await loadMastodonAccount(db, domain, author, handle)

	const mentions = []
	for (const link of properties.tag ?? []) {
		if (link.type === 'Mention') {
			const target = author.id.toString() === link.href.toString() ? author : await getActorById(db, link.href)
			if (target) {
				mentions.push(actorToMention(domain, target))
			}
		}
	}

	let inReplyToId: string | null = null
	let inReplyToAccountId: string | null = null
	if (properties.inReplyTo) {
		const replied = isLocalObject(domain, properties.inReplyTo)
			? await getObjectById(db, properties.inReplyTo)
			: await getObjectByOriginalId(db, properties.inReplyTo)
		if (replied) {
			inReplyToId = replied[mastodonIdSymbol]
			try {
				const author = await getAndCache(new URL(replied[originalActorIdSymbol]), db)
				inReplyToAccountId = author[mastodonIdSymbol]
			} catch (err) {
				console.warn('failed to get author of reply', err)
				inReplyToId = null
			}
		}
	}

	row.mastodon_id = await ensureObjectMastodonId(db, row.mastodon_id, row.cdate)

	let status: MastodonStatus
	if (isReblogRow(row)) {
		const actorId = new URL(properties.attributedTo.toString())
		const statusAuthor = await getAndCache(actorId, db)
		const statusAuthorHandle = actorToHandle(statusAuthor)

		const reblogVisibility = detectVisibility({
			to: JSON.parse(row.publisher_to) as string[],
			cc: JSON.parse(row.publisher_cc) as string[],
			followers: author.followers,
		})

		status = {
			id: await ensureReblogMastodonId(db, row.reblog_mastodon_id, row.publisher_published),
			uri: new URL(row.reblog_id),
			created_at: new Date(row.publisher_published).toISOString(),
			account,
			content: '',
			visibility: reblogVisibility,
			sensitive: false,
			spoiler_text: '',
			media_attachments: [],
			mentions: [],
			tags: [],
			emojis: [],
			reblogs_count: 0,
			favourites_count: 0,
			replies_count: 0,
			url: null,
			in_reply_to_id: null,
			in_reply_to_account_id: null,
			reblog: {
				id: row.mastodon_id,
				uri: new URL(properties.id),
				created_at: new Date(properties.published ?? row.cdate).toISOString(),
				account: await loadMastodonAccount(db, domain, statusAuthor, actorToHandle(statusAuthor)),
				content: properties.content ?? '',
				visibility: detectVisibility({ to: properties.to, cc: properties.cc, followers: statusAuthor.followers }),
				sensitive: properties.sensitive,
				spoiler_text: properties.spoiler_text ?? '',
				media_attachments: mediaAttachments,
				mentions,
				reblogs_count: row.reblogs_count,
				favourites_count: row.favourites_count,
				replies_count: row.replies_count,
				url: properties.url
					? new URL(properties.url)
					: isLocalAccount(domain, statusAuthorHandle)
					? new URL(`/@${handleToAcct(statusAuthorHandle, domain)}/${row.mastodon_id}`, 'https://' + domain)
					: new URL(row.id),
				reblog: null,
				edited_at: properties.updated ? new Date(properties.updated).toISOString() : null,
				favourited: row.favourited === 1,
				reblogged: row.reblogged === 1,
				in_reply_to_id: inReplyToId,
				in_reply_to_account_id: inReplyToAccountId,

				// FIXME: stub values
				tags: [],
				emojis: [],
				poll: null,
				card: null,
				language: null,
				text: null,
				muted: false,
				bookmarked: false,
				pinned: false,
				// filtered
			},
			poll: null,
			card: null,
			language: null,
			text: null,
			edited_at: null,
		}
	} else {
		status = {
			id: row.mastodon_id,
			uri: new URL(row.id),
			created_at: new Date(properties.published ?? row.cdate).toISOString(),
			account,
			content: properties.content ?? '',
			visibility: detectVisibility({ to: properties.to, cc: properties.cc, followers: author.followers }),
			sensitive: properties.sensitive,
			spoiler_text: properties.spoiler_text ?? '',
			media_attachments: mediaAttachments,
			mentions,
			reblogs_count: row.reblogs_count,
			favourites_count: row.favourites_count,
			replies_count: row.replies_count,
			url: properties.url
				? new URL(properties.url)
				: isLocalAccount(domain, handle)
				? new URL(`/@${handleToAcct(handle, domain)}/${row.mastodon_id}`, 'https://' + domain)
				: new URL(row.id),
			reblog: null,
			edited_at: properties.updated ? new Date(properties.updated).toISOString() : null,
			favourited: row.favourited === 1,
			reblogged: row.reblogged === 1,
			in_reply_to_id: inReplyToId,
			in_reply_to_account_id: inReplyToAccountId,

			// FIXME: stub values
			emojis: [],
			tags: [],
			poll: null,
			card: null,
			language: null,
			text: null,
			muted: false,
			bookmarked: false,
			pinned: false,
			// filtered
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

export function detectVisibility({
	to,
	cc,
	followers,
}: Pick<Note, 'to' | 'cc'> & Pick<Actor, 'followers'>): Visibility {
	to = Array.isArray(to) ? to : [to]
	cc = Array.isArray(cc) ? cc : [cc]

	if (to.includes(PUBLIC_GROUP)) {
		return 'public'
	}
	if (to.includes(followers.toString())) {
		if (cc.includes(PUBLIC_GROUP)) {
			return 'unlisted'
		}
		return 'private'
	}
	return 'direct'
}
