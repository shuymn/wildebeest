import type { MastodonAccount } from '@wildebeest/backend/types/account'
import type { MastodonStatus } from '@wildebeest/backend/types/status'

const notificationTypes = [
	'mention',
	'status',
	'reblog',
	'follow',
	'follow_request',
	'favourite',
	'poll',
	'update',
	'admin.sign_up',
	'admin.report',
] as const

export type NotificationType = (typeof notificationTypes)[number]

export function isNotificationType(type: string): type is NotificationType {
	return notificationTypes.includes(type as NotificationType)
}

export type Notification = {
	id: string
	type: NotificationType
	created_at: string
	account: MastodonAccount
	status?: MastodonStatus
}
