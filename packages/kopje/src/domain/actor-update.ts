import { fieldSources } from './accounts'
import { featuredUri, followersUri, recordOutbound } from './activities'
import { PUBLIC_COLLECTION } from './audience'
import { allocateLocalId } from './ids'
import { renderFieldValue } from './status-text'
import type { Db } from '../db/sql'
import { parseProfileUpdates, PROFILE_UPDATES } from '../platform/dump-catalog'
import { httpUrl } from '../platform/http-url'

// Profile changes reach other servers as Update(Person), as Mastodon's ActivityPub::UpdateDistributionWorker sends
// them: to Public, delivered to the followers' inboxes through B2 (domain/deliveries.ts). An Update supersedes earlier
// Updates of the same actor, so several quick edits deliver only the latest document. The object is the actor document
// with the fields Mastodon's ProcessAccountService reads from an Update; it matches what the actor endpoint publishes
// (federation.ts, which renders it through Fedify).

const CONTEXT = [
	'https://www.w3.org/ns/activitystreams',
	'https://w3id.org/security/v1',
	{
		manuallyApprovesFollowers: 'as:manuallyApprovesFollowers',
		toot: 'http://joinmastodon.org/ns#',
		discoverable: 'toot:discoverable',
		featured: { '@id': 'toot:featured', '@type': '@id' },
		schema: 'http://schema.org#',
		PropertyValue: 'schema:PropertyValue',
		value: 'schema:value',
		alsoKnownAs: { '@id': 'as:alsoKnownAs', '@type': '@id' },
	},
]

type ActorRow = {
	uri: string
	username: string
	actor_type: string
	display_name: string
	note: string
	avatar_url: string | null
	header_url: string | null
	locked: number
	discoverable: number | null
	also_known_as: string
	fields: string
	pubkey: string
	created_at: string
	suspended_at: string | null
}

function image(stored: string | null): { type: 'Image'; url: string } | undefined {
	const url = httpUrl(stored)
	return url === null ? undefined : { type: 'Image', url: url.href }
}

// The local actor document of an account, or null for none (or a suspended one, which sends no Update).
export function actorDocument(db: Db, accountId: string): Record<string, unknown> | null {
	const row = db.first<ActorRow>(
		`SELECT a.uri, a.username, a.actor_type, a.display_name, a.note, a.avatar_url, a.header_url, a.locked,
			a.discoverable, l.also_known_as, l.fields, l.pubkey, a.created_at, l.suspended_at
		FROM accounts a JOIN local_accounts l ON l.account_id = a.id WHERE a.id = ?`,
		accountId
	)
	if (row === undefined || row.suspended_at !== null) {
		return null
	}
	const origin = new URL(row.uri).origin
	return {
		id: row.uri,
		type: row.actor_type,
		preferredUsername: row.username,
		name: row.display_name,
		summary: row.note,
		url: `${origin}/@${row.username}`,
		inbox: `${row.uri}/inbox`,
		outbox: `${row.uri}/outbox`,
		followers: followersUri(row.uri),
		following: `${row.uri}/following`,
		featured: featuredUri(row.uri),
		endpoints: { sharedInbox: `${origin}/inbox` },
		publicKey: { id: `${row.uri}#main-key`, owner: row.uri, publicKeyPem: row.pubkey },
		manuallyApprovesFollowers: row.locked === 1,
		discoverable: row.discoverable === null ? undefined : row.discoverable === 1,
		published: row.created_at,
		icon: image(row.avatar_url),
		image: image(row.header_url),
		alsoKnownAs: (JSON.parse(row.also_known_as) as string[]).flatMap((uri) => httpUrl(uri)?.href ?? []),
		attachment: fieldSources(row.fields).map((field) => ({
			type: 'PropertyValue',
			name: field.name,
			value: renderFieldValue(field.value),
		})),
	}
}

// Records an Update of the account's actor if its document changed since `before` (actorDocument's earlier value,
// serialized; null records it in any case). Called in the transaction that changed the profile. Returns whether it
// recorded one.
export function recordActorUpdate(db: Db, accountId: string, before: string | null, now: number): boolean {
	const document = actorDocument(db, accountId)
	if (document === null || JSON.stringify(document) === before) {
		return false
	}
	const actor = String(document.id)
	recordOutbound(
		db,
		accountId,
		{
			activity: {
				'@context': CONTEXT,
				id: `${actor}#updates/${allocateLocalId(db, now)}`,
				type: 'Update',
				actor,
				to: [PUBLIC_COLLECTION],
				object: document,
			},
			audience: { followers: true, accounts: [] },
		},
		now
	)
	return true
}

// At publication, in its transaction: the local accounts whose avatar or header a cutover conversion changed
// (PROFILE_UPDATES) get the Update a profile edit sends, since other servers keep the old image URLs in their copy of
// the actor until they fetch it again. The list is deleted with it, so publishing again records nothing more. Returns
// how many Updates it recorded (none for a suspended or missing account), or null for a malformed list, which the
// caller refuses before anything is kept.
export function announceConvertedProfiles(db: Db, now: number): number | null {
	const row = db.first<{ value: string }>('SELECT value FROM kopje_state WHERE name = ?', PROFILE_UPDATES)
	if (row === undefined) {
		return 0
	}
	const accountIds = parseProfileUpdates(row.value)
	if (accountIds === null) {
		return null
	}
	db.run('DELETE FROM kopje_state WHERE name = ?', PROFILE_UPDATES)
	let recorded = 0
	for (const accountId of accountIds) {
		if (recordActorUpdate(db, accountId, null, now)) {
			recorded++
		}
	}
	return recorded
}

// The serialized document before a change, for recordActorUpdate.
export function actorSnapshot(db: Db, accountId: string): string {
	return JSON.stringify(actorDocument(db, accountId))
}
