import type { Account } from './accounts'
import type { Admin } from './auth'
import { logAction } from './moderation-log'
import type { Db } from '../db/sql'
import { storedWarningStatusIds } from '../platform/stored-bounds'

// Account warnings (Mastodon's AccountWarning, the strike Admin::AccountAction#process_strike! writes; migration
// 0062_account_warnings). This module alone reads or writes account_warnings, beside the rule (shownSql in audience.ts,
// which checks that a moderation_warning names a warning of its recipient; test-node/policy-boundary.test.ts).
//
// R42 (VIS-31): a warning is its target's alone. It is read only through the target's own moderation_warning
// notification (notifications.account_warning_id, read by its recipient), and presented only when the warning's
// target and the notification's sender are that recipient, so a restored notification linked to another account's
// warning, or sent by another account, shows nothing. No other read exposes warnings, as Mastodon serves strikes in
// its web pages alone. status_ids are ids only, copied from the report the admin named (which may name statuses the
// target cannot see, as in Mastodon); the text is plain text and never rendered as HTML.
//
// Kopje keeps a warning only where Mastodon notifies it (account_action.rb process_notification!, warnable?): type
// none, a local target, send_email_notification set. A strike Mastodon keeps without any API showing it (suspend,
// whose notification is always dropped; a remote target; no notification) is not kept.

// REST::AccountWarningSerializer. appeal is always null: Kopje has no disputes, through which Mastodon files appeals.
export type AccountWarning = {
	id: string
	action: string
	text: string
	status_ids: string[] | null
	created_at: string
	target_account: Account
	appeal: null
}

// Stores a warning of local account `targetId` and logs it (`create AccountWarning`, as account_action.rb:110 logs
// one with text; Kopje logs every admin write, so every warning). `reportStatusIds` is the named report's stored
// status_ids, or null without a report: copied when the warning's bound accepts them (storedWarningStatusIds), else
// dropped to null (a restored report's elements are not bound). `text` is within WARNING_TEXT_BYTES already
// (storedWarningText). Returns the warning's id.
export function writeAccountWarning(
	db: Db,
	admin: Admin,
	targetId: string,
	text: string,
	reportStatusIds: string | null
): string {
	const { id } = db.first<{ id: string }>(
		`INSERT INTO account_warnings (target_account_id, action, text, status_ids, created_at)
		VALUES (?, 'none', ?, ?, ?) RETURNING CAST(id AS TEXT) AS id`,
		targetId,
		text,
		storedWarningStatusIds(reportStatusIds),
		new Date(admin.now).toISOString()
	)!
	logAction(db, admin, 'create', { type: 'AccountWarning', id }, { account_id: targetId }, admin.now)
	return id
}

type WarningRow = { id: string; action: string; text: string; status_ids: string | null; created_at: string }

// Warning `id` of `recipient` (an account presented as the notification's sender), by its key; undefined when it is
// missing or is another account's. status_ids that the bound would refuse (which the triggers keep from being stored)
// are shown as null rather than thrown on.
export function presentAccountWarning(db: Db, id: string, recipient: Account): AccountWarning | undefined {
	const row = db.first<WarningRow>(
		`SELECT CAST(id AS TEXT) AS id, action, text, status_ids, created_at FROM account_warnings
		WHERE id = CAST(?1 AS INTEGER) AND target_account_id = ?2`,
		id,
		recipient.id
	)
	if (row === undefined) {
		return undefined
	}
	const statusIds = storedWarningStatusIds(row.status_ids)
	return {
		id: row.id,
		action: row.action,
		text: row.text,
		status_ids: statusIds === null ? null : (JSON.parse(statusIds) as string[]),
		created_at: row.created_at,
		target_account: recipient,
		appeal: null,
	}
}
