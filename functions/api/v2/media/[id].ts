// https://docs.joinmastodon.org/methods/media/#update

import { getApUrl, getObjectByMastodonId } from 'wildebeest/backend/src/activitypub/objects'
import { mastodonIdSymbol } from 'wildebeest/backend/src/activitypub/objects'
import { updateObjectProperty } from 'wildebeest/backend/src/activitypub/objects'
import type { Image } from 'wildebeest/backend/src/activitypub/objects/image'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import * as errors from 'wildebeest/backend/src/errors'
import type { MastodonId } from 'wildebeest/backend/src/types'
import type { ContextData } from 'wildebeest/backend/src/types/context'
import type { Env } from 'wildebeest/backend/src/types/env'
import type { MediaAttachment } from 'wildebeest/backend/src/types/media'
import { readBody } from 'wildebeest/backend/src/utils/body'
import { cors } from 'wildebeest/backend/src/utils/cors'

export const onRequestPut: PagesFunction<Env, 'id', ContextData> = async ({ params: { id }, env, request }) => {
	if (typeof id !== 'string') {
		return errors.mediaNotFound(String(id))
	}
	return handleRequestPut(await getDatabase(env), id, request)
}

type UpdateMedia = {
	description?: string
}

export async function handleRequestPut(db: Database, id: MastodonId, request: Request): Promise<Response> {
	// Update the image properties
	{
		const image = (await getObjectByMastodonId(db, id)) as Image
		if (image === null) {
			return errors.mediaNotFound(id)
		}

		const body = await readBody<UpdateMedia>(request)

		if (body.description !== undefined) {
			await updateObjectProperty(db, image, 'description', body.description)
		}
	}

	// reload the image for fresh state
	const image = (await getObjectByMastodonId(db, id)) as Image
	const imageUrl = getApUrl(image)

	const res: MediaAttachment = {
		id: image[mastodonIdSymbol]!,
		url: imageUrl,
		preview_url: imageUrl,
		type: 'image',
		meta: {
			original: {
				width: 640,
				height: 480,
				size: '640x480',
				aspect: 1.3333333333333333,
			},
			small: {
				width: 461,
				height: 346,
				size: '461x346',
				aspect: 1.3323699421965318,
			},
			focus: {
				x: -0.27,
				y: 0.51,
			},
		},
		description: image.description || '',
		blurhash: 'UFBWY:8_0Jxv4mx]t8t64.%M-:IUWGWAt6M}',
	}

	const headers = {
		...cors(),
		'content-type': 'application/json; charset=utf-8',
	}
	return new Response(JSON.stringify(res), { headers })
}
