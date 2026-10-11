// Mastodon's error entity: { "error": "..." }.
export function mastodonError(status: number, error: string): Response {
	return Response.json({ error }, { status })
}

export function maintenanceError(): Response {
	return mastodonError(503, 'This server is under maintenance. Try again later.')
}
