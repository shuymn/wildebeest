import type { Actor } from 'wildebeest/backend/src/activitypub/actors'
import type { Link } from 'wildebeest/backend/src/activitypub/objects/link'
import { actorToAcct } from 'wildebeest/backend/src/utils/handle'

// https://www.w3.org/TR/activitystreams-vocabulary/#dfn-mention
export type Mention = Link

export function newMention(actor: Actor): Mention {
	return {
		type: 'Mention',
		href: actor.id,
		name: actorToAcct(actor),
	}
}
