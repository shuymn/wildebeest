// https://www.w3.org/TR/activitystreams-vocabulary/#object-types

import { PUBLIC_GROUP } from 'wildebeest/backend/src/activitypub/activities'
import type { Actor } from 'wildebeest/backend/src/activitypub/actors'
import type { Link } from 'wildebeest/backend/src/activitypub/objects/link'
import { type Database } from 'wildebeest/backend/src/database'
import { RequiredProps } from 'wildebeest/backend/src/utils/type'

import * as objects from '.'

const NOTE = 'Note'

// FIXME: there is room to improve the implementation to better conform to specifications
// https://www.w3.org/TR/activitystreams-vocabulary/#dfn-note
export type Note = RequiredProps<objects.ApObject, 'cc' | 'to'> & {
	type: typeof NOTE
	content: string
	attributedTo?: string
	replies?: string
	attachment: Array<objects.ApObject>
	tag: Array<Link>
	spoiler_text?: string
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
	attachments: Array<objects.ApObject> = [],
	extraProperties: any = {}
): Promise<Note> {
	const actorId = new URL(actor.id)

	const properties = {
		attributedTo: actorId,
		content,
		to: [PUBLIC_GROUP],
		cc: [actor.followers.toString()],

		// FIXME: stub values
		replies: null,
		sensitive: false,
		summary: null,
		tag: [],

		attachment: attachments,
		inReplyTo: null,
		...extraProperties,
	}

	return await objects.createObject(domain, db, NOTE, properties, actorId, true)
}

export async function createDirectNote(
	domain: string,
	db: Database,
	content: string,
	actor: Actor,
	targetActors: Array<Actor>,
	attachment: Array<objects.ApObject> = [],
	extraProperties: any = {}
): Promise<Note> {
	const actorId = new URL(actor.id)

	const properties = {
		attributedTo: actorId,
		content,
		to: targetActors.map((a) => a.id.toString()),
		cc: [],

		// FIXME: stub values
		inReplyTo: null,
		replies: null,
		sensitive: false,
		summary: null,
		tag: [],
		attachment,

		...extraProperties,
	}

	return await objects.createObject(domain, db, NOTE, properties, actorId, true)
}
