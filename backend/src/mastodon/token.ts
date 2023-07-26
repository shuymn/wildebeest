// https://docs.joinmastodon.org/entities/Token/
export type Token = {
	access_token: string
	token_type: 'Bearer'
	scope: string
	created_at: number
}
