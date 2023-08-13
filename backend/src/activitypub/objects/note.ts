// https://www.w3.org/TR/activitystreams-vocabulary/#object-types

import { PUBLIC_GROUP } from 'wildebeest/backend/src/activitypub/activities'
import type { Actor } from 'wildebeest/backend/src/activitypub/actors'
import { ApObject, ApObjectId, ApObjectOrId, createObject, Document } from 'wildebeest/backend/src/activitypub/objects'
import { Image } from 'wildebeest/backend/src/activitypub/objects/image'
import type { Link } from 'wildebeest/backend/src/activitypub/objects/link'
import { type Database } from 'wildebeest/backend/src/database'
import { PartialProps, RequiredProps } from 'wildebeest/backend/src/utils/type'

const NOTE = 'Note'

// FIXME: there is room to improve the implementation to better conform to specifications
// https://www.w3.org/TR/activitystreams-vocabulary/#dfn-note
export type Note = RequiredProps<ApObject, 'cc' | 'to'> & {
	type: typeof NOTE
	content: string
	attributedTo: ApObjectId
	attachment: (Document | Image)[]
	source?: {
		content: string
		mediaType: string
	}
	inReplyTo?: string | null
	tag?: Array<Link>
	spoiler_text?: string
	sensitive: boolean
	replies?: ApObjectOrId
	updated?: string
}

export function isNote(obj: Record<string, unknown>): obj is Note {
	if (obj.type !== NOTE) {
		return false
	}

	if (typeof obj.content !== 'string') {
		return false
	}

	if (!(typeof obj.attributedTo === 'string' || obj.attributedTo instanceof URL)) {
		return false
	}

	if (!Array.isArray(obj.attachment)) {
		return false
	}

	return true
}

type ExtraProperties = PartialProps<
	Pick<Note, 'source' | 'sensitive' | 'inReplyTo' | 'tag' | 'spoiler_text'>,
	'inReplyTo' | 'tag' | 'spoiler_text'
>

export async function createPublicNote(
	domain: string,
	db: Database,
	content: string,
	actor: Actor,
	ccActors: Set<Actor>,
	attachment: (Document | Image)[] = [],
	extraProperties: ExtraProperties
) {
	const cc =
		ccActors.size > 0
			? [actor.followers.toString(), ...[...ccActors].map((a) => a.id.toString())]
			: [actor.followers.toString()]

	return await createNote(domain, db, content, actor, [PUBLIC_GROUP], cc, attachment, extraProperties)
}

export async function createUnlistedNote(
	domain: string,
	db: Database,
	content: string,
	actor: Actor,
	ccActors: Set<Actor>,
	attachment: (Document | Image)[] = [],
	extraProperties: ExtraProperties
) {
	const cc = ccActors.size > 0 ? [PUBLIC_GROUP, ...Array.from(ccActors).map((a) => a.id.toString())] : [PUBLIC_GROUP]

	return await createNote(domain, db, content, actor, [actor.followers.toString()], cc, attachment, extraProperties)
}

export async function createPrivateNote(
	domain: string,
	db: Database,
	content: string,
	actor: Actor,
	ccActors: Set<Actor>,
	attachment: (Document | Image)[] = [],
	extraProperties: ExtraProperties
) {
	const cc = ccActors.size > 0 ? Array.from(ccActors).map((a) => a.id.toString()) : []

	return await createNote(domain, db, content, actor, [actor.followers.toString()], cc, attachment, extraProperties)
}

export async function createDirectNote(
	domain: string,
	db: Database,
	content: string,
	actor: Actor,
	toActors: Set<Actor>,
	attachment: (Document | Image)[] = [],
	extraProperties: ExtraProperties
) {
	if (toActors.size === 0) {
		throw new Error('toActors must not be empty')
	}

	return await createNote(
		domain,
		db,
		content,
		actor,
		Array.from(toActors).map((a) => a.id.toString()),
		[],
		attachment,
		extraProperties
	)
}

async function createNote(
	domain: string,
	db: Database,
	content: string,
	actor: Actor,
	to: string[],
	cc: string[],
	attachment: (Document | Image)[] = [],
	extraProperties: ExtraProperties
) {
	const actorId = new URL(actor.id)
	return await createObject<Note>(
		domain,
		db,
		NOTE,
		{
			attributedTo: actorId,
			content,
			to,
			cc,

			tag: extraProperties.tag ?? [],
			attachment,
			inReplyTo: extraProperties.inReplyTo ?? null,
			...extraProperties,
		},
		actorId
	)
}
