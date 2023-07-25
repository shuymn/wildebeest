// https://docs.joinmastodon.org/methods/media/#update

import {
	getApUrl,
	getObjectByMastodonId,
	mastodonIdSymbol,
	updateObjectProperty,
} from 'wildebeest/backend/src/activitypub/objects'
import type { Image } from 'wildebeest/backend/src/activitypub/objects/image'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { mediaNotFound, unprocessableEntity } from 'wildebeest/backend/src/errors'
import type { MastodonId } from 'wildebeest/backend/src/types'
import type { ContextData } from 'wildebeest/backend/src/types'
import type { Env } from 'wildebeest/backend/src/types'
import type { MediaAttachment } from 'wildebeest/backend/src/types/media'
import { cors, readBody } from 'wildebeest/backend/src/utils'
import { z } from 'zod'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

const schema = z.object({
	description: z.string().nonempty().optional(),
})

type Parameters = z.infer<typeof schema>

export const onRequestPut: PagesFunction<Env, 'id', ContextData> = async ({ params: { id }, env, request }) => {
	if (typeof id !== 'string') {
		return mediaNotFound(String(id))
	}
	const result = await readBody(request, schema)
	if (result.success) {
		return handleRequestPut(await getDatabase(env), id, result.data)
	}
	const [issue] = result.error.issues
	return unprocessableEntity(`${issue?.path.join('.')}: ${issue?.message}`)
}

export async function handleRequestPut(db: Database, id: MastodonId, params: Parameters): Promise<Response> {
	// Update the image properties
	{
		const image = (await getObjectByMastodonId(db, id)) as Image
		if (image === null) {
			return mediaNotFound(id)
		}

		if (params.description) {
			await updateObjectProperty(db, image, 'description', params.description)
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

	return new Response(JSON.stringify(res), { headers })
}
