import type { Admin } from './auth'
import { readOperation } from './operation'
import type { Db } from '../db/sql'
import type { ImportAuthority } from '../platform/store-admin'

// The moderation log (migration 0029_admin_reports, VIS-29): one row per admin write, written in the write's
// transaction, so a write is never without its row. The OAuth admin's writes through the Mastodon admin API name its
// account and the client it acted through, as Mastodon's Admin::ActionLog names the account (AccountableConcern
// #log_action); the Access admin's recovery operations name the Access identity. Targets are named by type and id,
// without foreign keys, so a row outlives what it names.
//
// The log keeps the newest MODERATION_LOG_KEEP rows: each insert deletes at most MODERATION_LOG_PRUNE of the rows below
// that window, oldest first, so an insert's work is bounded and the log never grows past the window by more than what
// earlier inserts left (none: each insert adds one row and may remove ten). It is read only through the Access-gated
// GET /admin/moderation-log (`kopje-admin moderation-log`), newest first.

export const MODERATION_LOG_KEEP = 10_000
export const MODERATION_LOG_PRUNE = 10

// Who wrote: the OAuth admin through an admin route, or the Access admin through /admin (checked by the operation,
// accessAdminRefusal).
export type ModerationActor = Admin | Extract<ImportAuthority, { kind: 'access' }>

export type ModerationTarget = {
	type:
		| 'Report'
		| 'Account'
		| 'AccountInvitation'
		| 'AccountWarning'
		| 'DomainBlock'
		| 'Setting'
		| 'CustomEmoji'
		| 'Announcement'
		| 'Tag'
		| 'Status'
		| 'PreviewCard'
		| 'PreviewCardProvider'
	id: string
}

// Logs one admin write; returns its row's id, which is never given twice (0029_admin_reports), so it orders the
// writes (the report fence, reports.ts resolveSuspensionReports).
export function logAction(
	db: Db,
	actor: ModerationActor,
	action: string,
	target: ModerationTarget,
	detail: Record<string, unknown>,
	now: number
): number {
	const oauth = 'accountId' in actor
	const id = db.first<{ id: number }>(
		`INSERT INTO admin_actions (actor, account_id, client_id, action, target_type, target_id, detail, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
		oauth ? 'oauth' : 'access',
		oauth ? actor.accountId : null,
		oauth ? actor.clientId : null,
		action,
		target.type,
		target.id,
		JSON.stringify(oauth ? detail : { ...detail, identity: actor.email ?? actor.commonName }),
		new Date(now).toISOString()
	)!.id
	db.run(
		`DELETE FROM admin_actions WHERE id IN
			(SELECT id FROM admin_actions WHERE id <= ? ORDER BY id LIMIT ${MODERATION_LOG_PRUNE})`,
		id - MODERATION_LOG_KEEP
	)
	return id
}

export type ModerationLogEntry = {
	id: string
	actor: 'oauth' | 'access'
	account_id: string | null
	client_id: string | null
	action: string
	target_type: string
	target_id: string
	detail: object
	created_at: string
}

export const MODERATION_LOG_PAGE = 50
export const MAX_MODERATION_LOG_PAGE = 200

// A page of the log, newest first, below `before` (a row id) when given; `next` continues it.
export const moderationLog = readOperation<
	{ before?: string; limit?: number },
	{ entries: ModerationLogEntry[]; next: string | null }
>((db, { before, limit }) => {
	const size = Math.min(Math.max(limit ?? MODERATION_LOG_PAGE, 1), MAX_MODERATION_LOG_PAGE)
	const rows = db.all<Omit<ModerationLogEntry, 'detail'> & { detail: string }>(
		`SELECT CAST(id AS TEXT) AS id, actor, account_id, client_id, action, target_type, target_id, detail, created_at
		FROM admin_actions WHERE id < coalesce(CAST(?1 AS INTEGER), 1e19) ORDER BY id DESC LIMIT ?2`,
		before ?? null,
		size
	)
	return {
		entries: rows.map((row) => ({ ...row, detail: JSON.parse(row.detail) as object })),
		next: rows.length === size ? (rows.at(-1)?.id ?? null) : null,
	}
})
