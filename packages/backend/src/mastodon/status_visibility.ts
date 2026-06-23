import { PUBLIC_GROUP } from '@wildebeest/backend/activitypub/activities'
import type { Actor } from '@wildebeest/backend/activitypub/actors'
import { getAndCacheActor } from '@wildebeest/backend/activitypub/actors'
import { getApId, originalActorIdSymbol } from '@wildebeest/backend/activitypub/objects'
import type { Note } from '@wildebeest/backend/activitypub/objects/note'
import type { Database } from '@wildebeest/backend/database'
import { hasBlockBetween } from '@wildebeest/backend/mastodon/block'
import { isFollowing } from '@wildebeest/backend/mastodon/follow'
import type { Visibility } from '@wildebeest/backend/types'
import { toArray } from '@wildebeest/backend/utils'

type VisibilityAddressing = Pick<Note, 'to' | 'cc'> & Pick<Actor, 'followers'>

type ViewableNote = {
	[originalActorIdSymbol]?: string
	to?: Note['to']
	cc?: Note['cc']
}

export function detectVisibility({ to, cc, followers }: VisibilityAddressing): Visibility {
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

export async function isVisible(
	db: Database,
	author: Actor,
	viewer: Actor | undefined,
	note: { to?: Note['to']; cc?: Note['cc'] }
): Promise<boolean> {
	const visibility = detectVisibility({ to: note.to ?? [], cc: note.cc ?? [], followers: author.followers })
	if (visibility === 'public' || visibility === 'unlisted') {
		return true
	}
	if (!viewer) {
		return false
	}
	if (viewer.id.toString() === author.id.toString()) {
		return true
	}
	if (visibility === 'private') {
		return isFollowing(db, viewer, author)
	}
	const viewerId = getApId(viewer.id).toString()
	return toArray(note.to ?? []).some((target) => getApId(target).toString() === viewerId)
}

export async function canViewStatus(db: Database, note: ViewableNote, viewer: Actor | undefined): Promise<boolean> {
	const actorId = note[originalActorIdSymbol]
	if (!actorId) {
		return false
	}
	const author = await getAndCacheActor(new URL(actorId), db).catch((err) => {
		console.warn('failed to load status author: ' + err)
		return null
	})
	if (author === null) {
		return false
	}
	if (viewer && (await hasBlockBetween(db, viewer, author))) {
		return false
	}
	return isVisible(db, author, viewer, note)
}
