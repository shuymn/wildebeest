import { MastodonError } from 'wildebeest/backend/src/errors'

export type JsonResponse<T> = Response & {
	_T: T
}

export type MastodonApiResponse<T> = JsonResponse<T> | JsonResponse<MastodonError>

export function makeJsonResponse<T>(
	data: T,
	init: ResponseInit = {
		headers: {
			'content-type': 'application/json; charset=utf-8',
		},
	}
): JsonResponse<T> {
	return new Response(JSON.stringify(data), init) as JsonResponse<T>
}
