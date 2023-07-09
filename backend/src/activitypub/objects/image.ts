import type { Actor } from 'wildebeest/backend/src/activitypub/actors'
import { APObject, createObject } from 'wildebeest/backend/src/activitypub/objects'
import { type Database } from 'wildebeest/backend/src/database'
import { RequiredProps } from 'wildebeest/backend/src/utils/type'

export const IMAGE = 'Image'

// https://www.w3.org/TR/activitystreams-vocabulary/#dfn-image
export type Image = RequiredProps<APObject, 'url'> & { type: typeof IMAGE; description?: string }

export function isImage(object: APObject): object is Image {
	return object.type === IMAGE
}

export async function createImage(domain: string, db: Database, actor: Actor, properties: any): Promise<Image> {
	const actorId = new URL(actor.id)
	return await createObject(domain, db, IMAGE, properties, actorId, true)
}
