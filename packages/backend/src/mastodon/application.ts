// https://docs.joinmastodon.org/entities/Application/
export type Application = {
	name: string
	website?: string | URL | null
	vapid_key: string
	client_id?: string
	client_secret?: string
}
