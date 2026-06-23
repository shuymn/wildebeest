import type { Actor } from '@wildebeest/backend/activitypub/actors'
import { getObjectById, getObjectByMastodonId, type RemoteObject } from '@wildebeest/backend/activitypub/objects'
import type { Note } from '@wildebeest/backend/activitypub/objects/note'
import type { Database } from '@wildebeest/backend/database'
import { setMastodonStatusViewerState, toMastodonStatusFromObject } from '@wildebeest/backend/mastodon/status'
import { canViewStatus } from '@wildebeest/backend/mastodon/status_visibility'
import type { MastodonId, MastodonStatus } from '@wildebeest/backend/types'

export async function loadVisibleStatusObject(
	db: Database,
	domain: string,
	id: MastodonId,
	viewer: Actor | undefined
): Promise<RemoteObject<Note> | null> {
	const obj = await getObjectByMastodonId<Note>(domain, db, id)
	if (obj === null) {
		return null
	}
	return (await canViewStatus(db, obj, viewer)) ? obj : null
}

export async function toViewerStatusResponse(
	db: Database,
	domain: string,
	obj: RemoteObject<Note>,
	viewer: Actor | undefined
): Promise<MastodonStatus | null> {
	const status = await toMastodonStatusFromObject(db, obj, domain)
	if (status === null) {
		return null
	}
	return viewer ? setMastodonStatusViewerState(db, status, obj, viewer) : status
}

export async function loadViewerStatusesByObjectIds(
	db: Database,
	domain: string,
	objectIds: string[],
	viewer: Actor
): Promise<MastodonStatus[]> {
	const statuses = await Promise.all(
		objectIds.map(async (objectId) => {
			const obj = await getObjectById<Note>(domain, db, objectId)
			if (!obj) {
				return null
			}
			return toViewerStatusResponse(db, domain, obj, viewer)
		})
	)
	return statuses.filter((status): status is MastodonStatus => status !== null)
}
