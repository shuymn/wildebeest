import { PUBLIC_GROUP } from '@wildebeest/backend/activitypub/activities'
import type { Actor } from '@wildebeest/backend/activitypub/actors'
import { ApObject, createObject } from '@wildebeest/backend/activitypub/objects'
import { type Database } from '@wildebeest/backend/database'
import { RequiredProps } from '@wildebeest/backend/utils/type'

export const IMAGE = 'Image'

// https://www.w3.org/TR/activitystreams-vocabulary/#dfn-image
export type Image = RequiredProps<ApObject, 'url'> & {
	type: typeof IMAGE
	description?: string
	blurhash?: string
	width?: number
	height?: number
}

export function isImage(object: ApObject): object is Image {
	return object.type === IMAGE
}

/**
 * Is the image attached to a local status addressed to the public (public or unlisted visibility)?
 * Images carry no addressing of their own, so they inherit the visibility of the status they are
 * attached to.
 */
export async function isAttachedToPublicLocalObject(db: Database, imageId: string | URL): Promise<boolean> {
	const row = await db
		.prepare(
			`
SELECT 1 AS found
FROM objects
WHERE objects.local = 1
  AND objects.type = 'Note'
  AND EXISTS (
    SELECT 1 FROM json_each(objects.properties, '$.attachment')
    WHERE ${db.qb.jsonExtract('json_each.value', 'id')} = ?1
  )
  AND (EXISTS (SELECT 1 FROM json_each(objects.properties, '$.to') WHERE json_each.value = ?2)
    OR EXISTS (SELECT 1 FROM json_each(objects.properties, '$.cc') WHERE json_each.value = ?2))
LIMIT 1
`
		)
		.bind(imageId.toString(), PUBLIC_GROUP)
		.first<{ found: number }>()
	return row !== null
}

export async function createImage(
	domain: string,
	db: Database,
	actor: Actor,
	properties: Omit<Image, 'id' | 'type'>
): Promise<Image> {
	const actorId = new URL(actor.id)
	return await createObject<Image>(domain, db, IMAGE, properties, actorId)
}
