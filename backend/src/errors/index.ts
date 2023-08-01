import { cors, makeJsonResponse } from 'wildebeest/backend/src/utils'

export type MastodonError = {
	error: string
	error_description?: string
}

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
} as const

function makeErrorResponse(error: string, status: number, errorDescription?: string) {
	const res: MastodonError = {
		error: `${error}. If the problem persists please contact your instance administrator.`,
		...(errorDescription ? { error_description: errorDescription } : {}),
	}
	return makeJsonResponse(res, { headers, status })
}

export function notAuthorized(error: string, descr?: string) {
	return makeErrorResponse(`An error occurred (${error})`, 401, descr)
}

export function domainNotAuthorized() {
	return makeErrorResponse(`Domain is not authorizated`, 403)
}

export function userConflict() {
	return makeErrorResponse(`User already exists or conflicts`, 403)
}

export function clientUnknown(error: string, descr?: string) {
	return makeErrorResponse(error, 400, descr)
}

export function methodNotAllowed() {
	return makeErrorResponse(`Method not allowed`, 405)
}

export function unprocessableEntity(detail: string) {
	return makeErrorResponse(`Unprocessable entity`, 422, detail)
}

export function internalServerError() {
	return makeErrorResponse('Internal Server Error', 500)
}

export function statusNotFound(id: string) {
	return resourceNotFound('status', id)
}

export function mediaNotFound(id: string) {
	return resourceNotFound('media', id)
}

export function tagNotFound(tag: string) {
	return resourceNotFound('tag', tag)
}

export function exceededLimit(detail: string) {
	return makeErrorResponse('Limit exceeded', 400, detail)
}

export function resourceNotFound(name: string, id: string) {
	return makeErrorResponse('Resource not found', 404, `${name} "${id}" not found`)
}

export function recordNotFound(detail?: string) {
	return makeErrorResponse('Record not found', 404, detail)
}

export function validationError(detail: string) {
	return makeErrorResponse('Validation failed', 422, detail)
}
