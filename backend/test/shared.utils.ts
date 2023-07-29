/**
 * This file contains test utils that are also shared with the frontend code, these could not
 * be in the utils.ts file since it containing nodejs imports would cause the frontend to failing
 * building.
 */

import { ApObject } from 'wildebeest/backend/src/activitypub/objects'
import { type Database } from 'wildebeest/backend/src/database'

import type { Actor, Person } from '../src/activitypub/actors'
import { addObjectInOutbox } from '../src/activitypub/actors/outbox'
import { createPublicNote, type Note } from '../src/activitypub/objects/note'
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
	replyContent: string
) {
	const inReplyTo = originalNote.id
	const replyNote = await createPublicNote(domain, db, replyContent, actor, undefined, [], [], { inReplyTo } as any)
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
export async function createStatus(
	domain: string,
	db: Database,
	actor: Person,
	content: string,
	attachments?: ApObject[],
	extraProperties?: any
) {
	const note = await createPublicNote(domain, db, content, actor, undefined, [], attachments, extraProperties)
	await addObjectInOutbox(db, actor, note)
	return note
}
