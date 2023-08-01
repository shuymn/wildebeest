/**
 * This file contains test utils that are also shared with the frontend code, these could not
 * be in the utils.ts file since it containing nodejs imports would cause the frontend to failing
 * building.
 */

import { ApObject } from 'wildebeest/backend/src/activitypub/objects'
import { type Database } from 'wildebeest/backend/src/database'

import { type Actor, getActorById, type Person } from '../src/activitypub/actors'
import { addObjectInOutbox } from '../src/activitypub/actors/outbox'
import {
	createDirectNote,
	createPrivateNote,
	createPublicNote,
	createUnlistedNote,
	type Note,
} from '../src/activitypub/objects/note'
import { insertReply } from '../src/mastodon/reply'

/**
 * Creates a reply and inserts it in the reply author's outbox
 *
 * @param domain the domain to use
 * @param db Database
 * @param actor Author of the reply
 * @param originalNote The original note
 * @param replyContent content of the reply
 */
export async function createReply(
	domain: string,
	db: Database,
	actor: Actor,
	originalNote: Note,
	replyContent: string,
	sensitive: boolean = false
) {
	const inReplyTo = originalNote.id.toString()
	const repliedActor = await getActorById(db, originalNote.attributedTo.toString())
	if (!repliedActor) {
		throw new Error('replied actor not found')
	}
	const replyNote = await createPublicNote(domain, db, replyContent, actor, new Set([repliedActor]), [], {
		inReplyTo,
		sensitive,
		source: { content: replyContent, mediaType: 'text/plain' },
	})
	await addObjectInOutbox(db, actor, replyNote)
	await insertReply(db, actor, replyNote, originalNote)
}

/**
 * Creates a status object in the given actor's outbox.
 *
 * @param domain the domain to use
 * @param db Database
 * @param actor Author of the reply
 * @param content content of the reply
 * @param attachments optional attachments for the status
 * @param extraProperties optional extra properties for the status
 * @returns the created Note for the status
 */
export async function createPublicStatus(
	domain: string,
	db: Database,
	actor: Person,
	content: string,
	attachments?: ApObject[],
	extraProperties?: Record<string, any>
) {
	const note = await createPublicNote(
		domain,
		db,
		content,
		actor,
		new Set(),
		attachments,
		(extraProperties as any) ?? { sensitive: false, source: { content, mediaType: 'text/plain' } }
	)
	if (extraProperties?.published) {
		await addObjectInOutbox(db, actor, note, note.to, note.cc, extraProperties.published)
	} else {
		await addObjectInOutbox(db, actor, note)
	}
	return note
}

export async function createUnlistedStatus(
	domain: string,
	db: Database,
	actor: Person,
	content: string,
	attachments?: ApObject[],
	extraProperties?: Record<string, any>
) {
	const note = await createUnlistedNote(
		domain,
		db,
		content,
		actor,
		new Set(),
		attachments,
		(extraProperties as any) ?? { sensitive: false, source: { content, mediaType: 'text/plain' } }
	)
	await addObjectInOutbox(db, actor, note)
	return note
}

export async function createPrivateStatus(
	domain: string,
	db: Database,
	actor: Person,
	content: string,
	attachments?: ApObject[],
	extraProperties?: Record<string, any>
) {
	const note = await createPrivateNote(
		domain,
		db,
		content,
		actor,
		new Set(),
		attachments,
		(extraProperties as any) ?? { sensitive: false, source: { content, mediaType: 'text/plain' } }
	)
	await addObjectInOutbox(db, actor, note)
	return note
}

export async function createDirectStatus(
	domain: string,
	db: Database,
	actor: Person,
	content: string,
	attachments?: ApObject[],
	extraProperties?: Record<string, any>
) {
	const to = extraProperties?.to ?? [actor]
	const note = await createDirectNote(
		domain,
		db,
		content,
		actor,
		new Set([...to]),
		attachments,
		(extraProperties as any) ?? { sensitive: false, source: { content, mediaType: 'text/plain' } }
	)
	await addObjectInOutbox(db, actor, note)
	return note
}
