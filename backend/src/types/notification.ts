import type { MastodonAccount } from 'wildebeest/backend/src/types/account'
import type { MastodonStatus } from 'wildebeest/backend/src/types/status'

export type NotificationType =
	| 'mention'
	| 'status'
	| 'reblog'
	| 'follow'
	| 'follow_request'
	| 'favourite'
	| 'poll'
	| 'update'
	| 'admin.sign_up'
	| 'admin.report'

export type Notification = {
	id: string
	type: NotificationType
	created_at: string
	account: MastodonAccount
	status?: MastodonStatus
}

type ObjectRow = {
	id: string
	type: string
	properties: string
	mastodon_id: string
	cdate: string
	original_actor_id: string
}

export type NotificationsQueryResult = {
	notif_actor_id: string
	notif_type: NotificationType
	notif_from_actor_id: string
	notif_cdate: string
	notif_id: string
} & (ObjectRow | { id: null })
