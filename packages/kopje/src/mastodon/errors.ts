// Mastodon's error entity: { "error": "..." }.
export function mastodonError(status: number, error: string): Response {
	return Response.json({ error }, { status })
}

export const INVALID_TOKEN = 'The access token is invalid'

// A missing, unknown or expired bearer token, answered as Mastodon's Doorkeeper answers it: 401 with an RFC 6750 §3
// Bearer challenge naming the error.
export function invalidTokenError(): Response {
	const response = mastodonError(401, INVALID_TOKEN)
	response.headers.set('www-authenticate', bearerChallenge(INVALID_TOKEN))
	return response
}

// Doorkeeper's RFC 6750 §3 challenge (OAuth::ErrorResponse#authenticate_info) for `error` with `description`.
export function bearerChallenge(description: string, error = 'invalid_token'): string {
	return `Bearer realm="Doorkeeper", error="${error}", error_description="${description}"`
}

// How long a client or peer should wait before asking again during maintenance. A cutover keeps an instance in
// maintenance for well under half an hour (docs/cutover-runbook.md); peers retry deliveries on their own schedule.
export const MAINTENANCE_RETRY_AFTER_SECONDS = 600

export function maintenanceError(): Response {
	const response = mastodonError(503, 'This server is under maintenance. Try again later.')
	response.headers.set('retry-after', String(MAINTENANCE_RETRY_AFTER_SECONDS))
	return response
}

// How long the admin should wait before listing active or suspended accounts again while the domain job reconciles
// the domain marks (R38, domain/remote-suspension.ts): its rounds run back to back through the Queue.
export const MODERATION_RETRY_AFTER_SECONDS = 30

export function moderatingError(): Response {
	const response = mastodonError(503, 'moderation in progress, try again')
	response.headers.set('retry-after', String(MODERATION_RETRY_AFTER_SECONDS))
	return response
}
