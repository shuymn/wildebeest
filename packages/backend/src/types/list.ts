export type RepliesPolicy = 'list' | 'followed' | 'none'

export type MastodonList = {
	id: string
	title: string
	replies_policy: RepliesPolicy
	exclusive: boolean
}
