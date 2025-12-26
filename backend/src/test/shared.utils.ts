/**
 * This file contains test utils that are also shared with the frontend code, these could not
 * be in the utils.ts file since it containing nodejs imports would cause the frontend to failing
 * building.
 */

import { Document } from '@wildebeest/backend/activitypub/objects'
import { Image } from '@wildebeest/backend/activitypub/objects/image'
import { newMention } from '@wildebeest/backend/activitypub/objects/mention'
import { type Database } from '@wildebeest/backend/database'
import { enrichStatus } from '@wildebeest/backend/mastodon/microformats'
import { getMentions } from '@wildebeest/backend/mastodon/status'

import { type Actor, type Person } from '../activitypub/actors'
import { addObjectInOutbox } from '../activitypub/actors/outbox'
import {
	createDirectNote,
	createPrivateNote,
	createPublicNote,
	createUnlistedNote,
	type Note,
} from '../activitypub/objects/note'
import { insertReply } from '../mastodon/reply'

/**
 * Creates a reply and inserts it in the reply author's outbox
 *
 * @param domain the domain to use
 * @param db Database
 * @param author Author of the reply
 * @param originalNote The original note
 * @param rawContent content of the reply
 */
export async function createReply(
	domain: string,
	db: Database,
	author: Actor,
	originalNote: Note,
	rawContent: string,
	sensitive: boolean = false
) {
	const extraProperties: Record<string, any> = {
		inReplyTo: originalNote.id.toString(),
		sensitive,
		source: { content: rawContent, mediaType: 'text/plain' },
	}

	const mentions = await getMentions(rawContent, domain, db)
	if (mentions.size === 0) {
		throw new Error('replied actor not found')
	}
	extraProperties.tag = [...mentions].map((actor) => newMention(actor, domain))

	const replyNote = await createPublicNote(
		domain,
		db,
		enrichStatus(rawContent, mentions),
		author,
		mentions,
		[],
		extraProperties as any
	)
	await addObjectInOutbox(db, author, replyNote)
	await insertReply(db, author, replyNote, originalNote)
}

/**
 * Creates a status object in the given actor's outbox.
 *
 * @param domain the domain to use
 * @param db Database
 * @param author Author of the reply
 * @param content content of the reply
 * @param attachments optional attachments for the status
 * @param extraProperties optional extra properties for the status
 * @returns the created Note for the status
 */
export async function createPublicStatus(
	domain: string,
	db: Database,
	author: Person,
	rawContent: string,
	attachments?: (Document | Image)[],
	extraProperties: Record<string, any> = {},
	skipEnrich: boolean = false
) {
	const mentions = await getMentions(rawContent, domain, db)
	if (mentions.size > 0) {
		extraProperties.tag = [...mentions].map((actor) => newMention(actor, domain))
	}
	const note = await createPublicNote(
		domain,
		db,
		skipEnrich ? rawContent : enrichStatus(rawContent, mentions),
		author,
		mentions,
		attachments,
		{
			sensitive: false,
			source: { content: rawContent, mediaType: 'text/plain' },
			...extraProperties,
		}
	)
	if (extraProperties?.published) {
		await addObjectInOutbox(db, author, note, note.to, note.cc, extraProperties.published)
	} else {
		await addObjectInOutbox(db, author, note)
	}
	return note
}

export async function createUnlistedStatus(
	domain: string,
	db: Database,
	author: Person,
	rawContent: string,
	attachments?: (Document | Image)[],
	extraProperties: Record<string, any> = {}
) {
	const mentions = await getMentions(rawContent, domain, db)
	if (mentions.size > 0) {
		extraProperties.tag = [...mentions].map((actor) => newMention(actor, domain))
	}
	const note = await createUnlistedNote(
		domain,
		db,
		enrichStatus(rawContent, mentions),
		author,
		new Set(),
		attachments,
		{
			sensitive: false,
			source: { content: rawContent, mediaType: 'text/plain' },
			...extraProperties,
		}
	)
	await addObjectInOutbox(db, author, note)
	return note
}

export async function createPrivateStatus(
	domain: string,
	db: Database,
	author: Person,
	rawContent: string,
	attachments?: (Document | Image)[],
	extraProperties: Record<string, any> = {}
) {
	const mentions = await getMentions(rawContent, domain, db)
	if (mentions.size > 0) {
		extraProperties.tag = [...mentions].map((actor) => newMention(actor, domain))
	}
	const note = await createPrivateNote(domain, db, enrichStatus(rawContent, mentions), author, new Set(), attachments, {
		sensitive: false,
		source: { content: rawContent, mediaType: 'text/plain' },
		...extraProperties,
	})
	await addObjectInOutbox(db, author, note)
	return note
}

export async function createDirectStatus(
	domain: string,
	db: Database,
	author: Person,
	rawContent: string,
	attachments?: (Document | Image)[],
	extraProperties: Record<string, any> = {}
) {
	const mentions = await getMentions(rawContent, domain, db)
	if (mentions.size > 0) {
		extraProperties.tag = [...mentions].map((actor) => newMention(actor, domain))
	}
	const to = extraProperties?.to ?? [author]
	const note = await createDirectNote(
		domain,
		db,
		enrichStatus(rawContent, mentions),
		author,
		new Set([...to]),
		attachments,
		{ sensitive: false, source: { content: rawContent, mediaType: 'text/plain' }, ...extraProperties }
	)
	await addObjectInOutbox(db, author, note)
	return note
}
