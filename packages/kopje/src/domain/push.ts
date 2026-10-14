import { presentAccountsById } from './accounts'
import { availableLocalSql, shownSql } from './audience'
import { userReadOperation, userSessionOperation, userWriteOperation } from './auth'
import { CLAIM_LIMIT, type DeliveryOutcome, LEASE_MS, MAX_ATTEMPTS, retryDelay } from './deliveries'
import { pushWantedSql } from './notifications'
import { writeOperation } from './operation'
import type { Db } from '../db/sql'
import { remoteHtmlText } from '../security/html'

// Web Push (Mastodon 4.5's /api/v1/push/subscription and Web::PushNotificationWorker).
//
//   - Subscriptions (PUSH-1): one per access token, read and written only through the request's own token (the
//     viewer's tokenHash), never by an id. A token's revocation, or its account's suspension, deletes the token and
//     its subscription with it (ON DELETE CASCADE), and with that its pending pushes.
//   - Pushes are written with their notification (domain/notifications.ts, VIS-10), one per subscription that wants
//     it, and sent by the Worker (jobs/push.ts) with the deliveries' discipline: a claim leases due rows for LEASE_MS
//     and counts an attempt, a completion settles a row only with its lease token, a failure is retried after
//     retryDelay, and a row is given up after MAX_ATTEMPTS. A push that is sent or given up is deleted; a 4xx other
//     than 408 and 429 deletes its subscription, as Mastodon 4.5 does.
//   - PUSH-3: the claim, and again confirmPush right before the POST, check that the notification is still shown to
//     its recipient (the notification rule, shownSql), that the subscription still wants it and its token is still
//     valid, and that it is younger than PUSH_TTL_MS; otherwise the push is dropped unsent. What is sent is read at
//     that last check. A deleted or replaced notification, or subscription, takes its pushes along.
//   - The payload is Mastodon's (Web::NotificationSerializer): the Store composes the title, body and icon; the Worker
//     adds the access token, which the Store holds only sealed (AUTH-7, security/web-push.ts).

// Mastodon's Notification::TYPES as of 4.5, the alerts a subscription may set. Kopje emits only some of them.
export const ALERT_TYPES = [
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
	'severed_relationships',
	'moderation_warning',
	'annual_report',
	'quote',
	'quoted_update',
] as const

export const POLICIES = ['all', 'followed', 'follower', 'none'] as const

export type PushPolicy = (typeof POLICIES)[number]

export type PushData = { alerts: Record<string, boolean>; policy: PushPolicy }

// The WebPushSubscription entity without server_key, which the Worker adds from VAPID_JWK. id is a JSON number, as
// Mastodon's REST::WebPushSubscriptionSerializer emits it (subscription ids are small integers, so it is exact).
export type StoredSubscription = {
	id: number
	endpoint: string
	standard: boolean
	alerts: Record<string, boolean>
	policy: PushPolicy
}

type SubscriptionRow = { id: number; endpoint: string; standard: number; alerts: string; policy: PushPolicy }

const SUBSCRIPTION_COLUMNS = 'id, endpoint, standard, alerts, policy'

function presentSubscription(row: SubscriptionRow): StoredSubscription {
	return {
		id: row.id,
		endpoint: row.endpoint,
		standard: row.standard === 1,
		alerts: JSON.parse(row.alerts) as Record<string, boolean>,
		policy: row.policy,
	}
}

function subscriptionOf(db: Db, tokenHash: string): StoredSubscription | null {
	const row = db.first<SubscriptionRow>(
		`SELECT ${SUBSCRIPTION_COLUMNS} FROM push_subscriptions WHERE token_hash = ?`,
		tokenHash
	)
	return row === undefined ? null : presentSubscription(row)
}

export type SubscribeInput = PushData & {
	endpoint: string
	p256dh: string
	auth: string
	standard: boolean
	tokenSealed: string
}

// Replaces the token's subscription, as Mastodon's create does (its pending pushes go with the old one).
export const createPushSubscription = userSessionOperation<SubscribeInput, StoredSubscription>(
	(db, input, { tokenHash }) => {
		db.run('DELETE FROM push_subscriptions WHERE token_hash = ?', tokenHash)
		const row = db.first<SubscriptionRow>(
			`INSERT INTO push_subscriptions (token_hash, endpoint, key_p256dh, key_auth, alerts, policy, standard, token_sealed)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${SUBSCRIPTION_COLUMNS}`,
			tokenHash,
			input.endpoint,
			input.p256dh,
			input.auth,
			JSON.stringify(input.alerts),
			input.policy,
			input.standard ? 1 : 0,
			input.tokenSealed
		)
		if (row === undefined) {
			throw new Error('push subscription not written')
		}
		return presentSubscription(row)
	}
)

export const getPushSubscription = userReadOperation<object, StoredSubscription | null>((db, _input, { tokenHash }) =>
	subscriptionOf(db, tokenHash)
)

// Replaces the alerts and the policy (Mastodon's update sets data as a whole); null when the token has none.
export const updatePushSubscription = userSessionOperation<PushData, StoredSubscription | null>(
	(db, input, { tokenHash }) => {
		db.run(
			'UPDATE push_subscriptions SET alerts = ?, policy = ? WHERE token_hash = ?',
			JSON.stringify(input.alerts),
			input.policy,
			tokenHash
		)
		return subscriptionOf(db, tokenHash)
	}
)

export const deletePushSubscription = userWriteOperation<object, null>((db, _input, { tokenHash }) => {
	db.run('DELETE FROM push_subscriptions WHERE token_hash = ?', tokenHash)
	return null
})

// ---------------------------------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------------------------------

// Mastodon's Web::PushNotificationWorker TTL: a push is not sent for a notification older than this, and push
// services keep it no longer.
export const PUSH_TTL_MS = 48 * 60 * 60 * 1000

// Mastodon truncates the body to 140 characters, the omission included.
const BODY_LENGTH = 140

// Mastodon's notification_mailer subjects (en), by type; %{name} is the sender's display name or username.
const TITLES: Record<string, (name: string) => string> = {
	mention: (name) => `You were mentioned by ${name}`,
	status: (name) => `${name} just posted`,
	reblog: (name) => `${name} boosted your post`,
	favourite: (name) => `${name} favorited your post`,
	follow: (name) => `${name} is now following you`,
	follow_request: (name) => `Pending follower: ${name}`,
	update: (name) => `${name} edited a post`,
}

// Rails' truncate: at most `length` characters, the last three replaced by '...' when cut.
export function truncateText(text: string, length: number): string {
	const chars = Array.from(text)
	return chars.length <= length ? text : `${chars.slice(0, length - 3).join('')}...`
}

// The payload fields the Store composes; the Worker adds access_token. notification_id is a JSON number, as
// Mastodon's Web::NotificationSerializer emits it (notification ids are small integers, so it is exact).
export type PushContent = {
	notification_id: number
	notification_type: string
	preferred_locale: string
	icon: string
	title: string
	body: string
}

// A claimed push: its row and the endpoint the Worker checks the host of before anything else.
export type ClaimedPush = { id: string; endpoint: string }

export type PushClaim = {
	leaseToken: string
	leaseUntil: number
	// The instance's origin, the VAPID subject; null before /setup.
	origin: string | null
	pushes: ClaimedPush[]
	nextDueAt: number | null
}

// What is sent, read at the last moment before the POST (confirmPush).
export type ConfirmedPush = {
	endpoint: string
	p256dh: string
	auth: string
	standard: boolean
	tokenHash: string
	tokenSealed: string
	content: PushContent
}

type DueRow = { id: string; attempts: number }

type TargetRow = {
	endpoint: string
	key_p256dh: string
	key_auth: string
	standard: number
	token_hash: string
	token_sealed: string
	notification_id: number
	type: string
	from_account_id: string
	spoiler_text: string | null
	content: string | null
}

// The push of row `id` if it may still be sent at `now` (PUSH-3).
function target(db: Db, id: string, now: number): TargetRow | undefined {
	return db.first<TargetRow>(
		`SELECT p.endpoint, p.key_p256dh, p.key_auth, p.standard, p.token_hash, p.token_sealed,
			n.id AS notification_id, n.type, n.from_account_id, s.spoiler_text, s.content
		FROM push_deliveries d
			JOIN push_subscriptions p ON p.id = d.subscription_id
			JOIN oauth_tokens t ON t.token_hash = p.token_hash
			JOIN notifications n ON n.id = d.notification_id
			JOIN local_accounts l ON l.account_id = n.account_id
			LEFT JOIN statuses s ON s.id = n.status_id
		WHERE d.id = CAST(?1 AS INTEGER) AND ${availableLocalSql('l')} AND n.created_at > ?3
			AND ${pushWantedSql('p', 't', 'n', '?2')}
			AND ${shownSql('n.account_id', 'n.type', 'n.from_account_id', 'n.status_id', '?2')}`,
		id,
		new Date(now).toISOString(),
		new Date(now - PUSH_TTL_MS).toISOString()
	)
}

function contentOf(db: Db, row: TargetRow, origin: string): PushContent {
	const from = presentAccountsById(db, [row.from_account_id], { origin }).get(row.from_account_id)
	const name = from === undefined ? '' : from.display_name === '' ? from.username : from.display_name
	// The status's content warning, else its text; without a status, the sender's note. Stored HTML is sanitized.
	const spoiler = row.spoiler_text ?? ''
	const text = spoiler !== '' ? spoiler : remoteHtmlText(row.content ?? from?.note ?? '')
	return {
		notification_id: row.notification_id,
		notification_type: row.type,
		preferred_locale: 'en',
		icon: from?.avatar_static ?? '',
		title: TITLES[row.type]?.(name) ?? name,
		body: truncateText(text.trim(), BODY_LENGTH),
	}
}

function instanceOrigin(db: Db): string | null {
	const domain = db.first<{ value: string }>("SELECT value FROM instance_settings WHERE name = 'domain'")?.value
	return domain === undefined ? null : `https://${domain}`
}

function dropPush(db: Db, id: string): void {
	db.run('DELETE FROM push_deliveries WHERE id = CAST(? AS INTEGER)', id)
}

function nextPushDueAt(db: Db, ownLease: string | null = null): number | null {
	return (
		db.first<{ at: number | null }>(
			'SELECT min(next_attempt_at) AS at FROM push_deliveries WHERE ?1 IS NULL OR lease_token IS NOT ?1',
			ownLease
		)?.at ?? null
	)
}

// Moves whenever a push is recorded (AUTOINCREMENT, so a row deleted since still counts): an inbound activity that
// recorded one rings the doorbell (domain/inbox.ts).
export function pushSequence(db: Db): number {
	return db.first<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'push_deliveries'")?.seq ?? 0
}

// Leases up to `limit` due pushes (an expired lease is due again), dropping those that may no longer be sent or have
// used up their attempts.
export const claimPushes = writeOperation<{ now: number; leaseToken: string; limit?: number }, PushClaim>(
	(db, { now, leaseToken, limit }) => {
		const max = Math.max(1, Math.min(limit ?? CLAIM_LIMIT, CLAIM_LIMIT))
		const leaseUntil = now + LEASE_MS
		const origin = instanceOrigin(db)
		const due = db.all<DueRow>(
			`SELECT CAST(id AS TEXT) AS id, attempts FROM push_deliveries WHERE next_attempt_at <= ?
			ORDER BY next_attempt_at, id LIMIT ?`,
			now,
			max
		)
		const pushes: ClaimedPush[] = []
		for (const row of due) {
			const push = origin === null || row.attempts >= MAX_ATTEMPTS ? undefined : target(db, row.id, now)
			if (push === undefined) {
				dropPush(db, row.id)
				continue
			}
			db.run(
				`UPDATE push_deliveries SET state = 'leased', lease_token = ?, attempts = attempts + 1, next_attempt_at = ?,
					updated_at = ? WHERE id = CAST(? AS INTEGER)`,
				leaseToken,
				leaseUntil,
				now,
				row.id
			)
			pushes.push({ id: row.id, endpoint: push.endpoint })
		}
		return { leaseToken, leaseUntil, origin, pushes, nextDueAt: nextPushDueAt(db) }
	}
)

// PUSH-3 at the moment of sending: called after the host check, right before the POST, with the claim's lease. The
// push is sent only if its row is still under this lease (so its subscription was neither deleted nor replaced) and
// it may still be sent now; what is sent is read here, never from the claim. Otherwise the row is dropped and null
// returned.
export const confirmPush = writeOperation<{ id: string; leaseToken: string; now: number }, ConfirmedPush | null>(
	(db, { id, leaseToken, now }) => {
		const leased = db.first(
			"SELECT 1 AS yes FROM push_deliveries WHERE id = CAST(? AS INTEGER) AND state = 'leased' AND lease_token = ?",
			id,
			leaseToken
		)
		if (leased === undefined) {
			return null
		}
		const origin = instanceOrigin(db)
		const push = origin === null ? undefined : target(db, id, now)
		if (push === undefined || origin === null) {
			dropPush(db, id)
			return null
		}
		return {
			endpoint: push.endpoint,
			p256dh: push.key_p256dh,
			auth: push.key_auth,
			standard: push.standard === 1,
			tokenHash: push.token_hash,
			tokenSealed: push.token_sealed,
			content: contentOf(db, push, origin),
		}
	}
)

export type PushCompletion = (
	| { status: 'delivered' }
	| { status: 'retry'; retryAt: number }
	| { status: 'gave_up' }
	// The push service refused the subscription for good: it is deleted, with its pending pushes.
	| { status: 'unsubscribed' }
	// The lease is no longer this one's: the row was claimed again, settled, or deleted.
	| { status: 'stale' }
) & { nextDueAt: number | null }

// Mastodon 4.5's Web::PushNotificationWorker: any 4xx but a timeout (408) or rate limit (429) means the subscription
// is invalid or expired. So does an endpoint the sink refuses outright (it no longer passes the host rules).
function unsubscribes(outcome: DeliveryOutcome): boolean {
	if (outcome.kind !== 'failed') {
		return false
	}
	if (outcome.status === null) {
		return outcome.permanent
	}
	return outcome.status >= 400 && outcome.status < 500 && outcome.status !== 408 && outcome.status !== 429
}

// Settles a push: sent, it is deleted; a refusal of the subscription deletes the subscription; anything else (5xx,
// 408, 429, a redirect, a network error) is retried with the deliveries' backoff until MAX_ATTEMPTS.
export const completePush = writeOperation<
	{ id: string; leaseToken: string; now: number; outcome: DeliveryOutcome },
	PushCompletion
>((db, { id, leaseToken, now, outcome }) => {
	const row = db.first<{ subscription_id: number; attempts: number }>(
		`SELECT subscription_id, attempts FROM push_deliveries
		WHERE id = CAST(? AS INTEGER) AND state = 'leased' AND lease_token = ?`,
		id,
		leaseToken
	)
	if (row === undefined) {
		return { status: 'stale', nextDueAt: nextPushDueAt(db, leaseToken) }
	}
	if (outcome.kind === 'delivered') {
		dropPush(db, id)
		return { status: 'delivered', nextDueAt: nextPushDueAt(db, leaseToken) }
	}
	if (unsubscribes(outcome)) {
		db.run('DELETE FROM push_subscriptions WHERE id = ?', row.subscription_id)
		return { status: 'unsubscribed', nextDueAt: nextPushDueAt(db, leaseToken) }
	}
	if (row.attempts >= MAX_ATTEMPTS) {
		dropPush(db, id)
		return { status: 'gave_up', nextDueAt: nextPushDueAt(db, leaseToken) }
	}
	const retryAt = now + retryDelay(row.attempts)
	db.run(
		`UPDATE push_deliveries SET state = 'pending', lease_token = NULL, next_attempt_at = ?, last_status = ?,
			updated_at = ? WHERE id = CAST(? AS INTEGER)`,
		retryAt,
		outcome.status,
		now,
		id
	)
	return { status: 'retry', retryAt, nextDueAt: nextPushDueAt(db, leaseToken) }
})
