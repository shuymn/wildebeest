// https://www.w3.org/TR/activitystreams-vocabulary/#object-types

import { PUBLIC_GROUP } from 'wildebeest/backend/src/activitypub/activities'
import type { Actor } from 'wildebeest/backend/src/activitypub/actors'
import type { Link } from 'wildebeest/backend/src/activitypub/objects/link'
import { type Database } from 'wildebeest/backend/src/database'
import { PartialProps, RequiredProps } from 'wildebeest/backend/src/utils/type'

import * as objects from '.'

const NOTE = 'Note'

// FIXME: there is room to improve the implementation to better conform to specifications
// https://www.w3.org/TR/activitystreams-vocabulary/#dfn-note
export type Note = RequiredProps<objects.ApObject, 'cc' | 'to'> & {
	type: typeof NOTE
	content: string
	source: {
		content: string
		mediaType: string
	}
	attributedTo: objects.ApObjectId
	attachment: Array<objects.ApObject>
	tag: Array<Link>
	spoiler_text?: string
	sensitive: boolean
	replies?: objects.ApObjectOrId
	updated?: string
}

export function isNote(obj: objects.ApObject): obj is Note {
	// FIXME: terrible implementation just to fool the type checker
	return obj.type === NOTE
}

export async function createPublicNote(
	domain: string,
	db: Database,
	content: string,
	actor: Actor,
	toActor: Actor | undefined,
	ccActors: Actor[],
	attachment: objects.ApObject[] = [],
	extraProperties: PartialProps<Pick<Note, 'source' | 'sensitive' | 'inReplyTo' | 'tag'>, 'inReplyTo' | 'tag'>
) {
	const actorId = new URL(actor.id)

	const properties: Omit<Note, 'id'> = {
		type: NOTE,
		attributedTo: actorId,
		content,
		to: toActor ? [PUBLIC_GROUP, toActor.id.toString()] : [PUBLIC_GROUP],
		cc:
			ccActors.length > 0
				? [actor.followers.toString(), ...ccActors.map((a) => a.id.toString())]
				: [actor.followers.toString()],

		sensitive: extraProperties.sensitive,
		tag: extraProperties.tag ?? [],
		attachment,
		inReplyTo: extraProperties.inReplyTo ?? null,
		source: extraProperties.source,
	}

	return await objects.createObject(domain, db, NOTE, properties, actorId, true)
}

export async function createUnlistedNote(
	domain: string,
	db: Database,
	content: string,
	actor: Actor,
	toActor: Actor | undefined,
	ccActors: Actor[],
	attachment: objects.ApObject[] = [],
	extraProperties: PartialProps<Pick<Note, 'source' | 'sensitive' | 'inReplyTo' | 'tag'>, 'inReplyTo' | 'tag'>
) {
	const actorId = new URL(actor.id)

	const properties: Omit<Note, 'id'> = {
		type: NOTE,
		attributedTo: actorId,
		content,
		to: toActor ? [actor.followers.toString(), toActor.id.toString()] : [actor.followers.toString()],
		cc: ccActors.length > 0 ? [PUBLIC_GROUP, ...ccActors.map((a) => a.id.toString())] : [PUBLIC_GROUP],

		sensitive: extraProperties.sensitive,
		tag: extraProperties.tag ?? [],
		attachment,
		inReplyTo: extraProperties.inReplyTo ?? null,
		source: extraProperties.source,
	}

	return await objects.createObject(domain, db, NOTE, properties, actorId, true)
}

export async function createPrivateNote(
	domain: string,
	db: Database,
	content: string,
	actor: Actor,
	toActor: Actor | undefined,
	ccActors: Actor[],
	attachment: objects.ApObject[] = [],
	extraProperties: PartialProps<Pick<Note, 'source' | 'sensitive' | 'inReplyTo' | 'tag'>, 'inReplyTo' | 'tag'>
) {
	const actorId = new URL(actor.id)

	const properties: Omit<Note, 'id'> = {
		type: NOTE,
		attributedTo: actorId,
		content,
		to: toActor ? [actor.followers.toString(), toActor.id.toString()] : [actor.followers.toString()],
		cc: ccActors.length > 0 ? [...ccActors.map((a) => a.id.toString())] : [],

		sensitive: extraProperties.sensitive,
		tag: extraProperties.tag ?? [],
		attachment,
		inReplyTo: extraProperties.inReplyTo ?? null,
		source: extraProperties.source,
	}

	return await objects.createObject(domain, db, NOTE, properties, actorId, true)
}

export async function createDirectNote(
	domain: string,
	db: Database,
	content: string,
	actor: Actor,
	toActor: Actor | undefined,
	ccActors: Actor[],
	attachment: objects.ApObject[] = [],
	extraProperties: PartialProps<Pick<Note, 'source' | 'sensitive' | 'inReplyTo' | 'tag'>, 'inReplyTo' | 'tag'>
) {
	const actorId = new URL(actor.id)

	const properties: Omit<Note, 'id'> = {
		type: NOTE,
		attributedTo: actorId,
		content,
		to: toActor ? [toActor.id.toString()] : [],
		cc: ccActors.length > 0 ? [...ccActors.map((a) => a.id.toString())] : [],

		sensitive: extraProperties.sensitive,
		tag: extraProperties.tag ?? [],
		attachment,
		inReplyTo: extraProperties.inReplyTo ?? null,
		source: extraProperties.source,
	}

	return await objects.createObject(domain, db, NOTE, properties, actorId, true)
}
