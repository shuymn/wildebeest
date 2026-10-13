// Mastodon's error entity: { "error": "..." }.
export function mastodonError(status: number, error: string): Response {
	return Response.json({ error }, { status })
}

// How long a client or peer should wait before asking again during maintenance. A cutover keeps an instance in
// maintenance for well under half an hour (docs/cutover-runbook.md); peers retry deliveries on their own schedule.
export const MAINTENANCE_RETRY_AFTER_SECONDS = 600

export function maintenanceError(): Response {
	const response = mastodonError(503, 'This server is under maintenance. Try again later.')
	response.headers.set('retry-after', String(MAINTENANCE_RETRY_AFTER_SECONDS))
	return response
}
