import {
	type Account,
	accountUrl,
	edgeRangeSql,
	type Page,
	type PageQuery,
	type Present,
	presentAccountsById,
	resolveAccountId,
} from './accounts'
import { flagActivity, instanceActorUri, recordOutbound } from './activities'
import { type AdminAccount, presentAdminAccounts } from './admin-accounts'
import { accessAdminRefusal, adminAccountIdOnce } from './admin-authority'
import { availableSql, reportForwardees } from './audience'
import {
	ADMIN_PERMISSION,
	type Admin,
	adminReadOperation,
	adminWriteOperation,
	userWriteOperation,
	viewerOf,
} from './auth'
import { type InstanceRule, parseRules } from './instance'
import { logAction } from './moderation-log'
import { notify } from './notifications'
import { readOperation } from './operation'
import { presentStatuses, type Status } from './status-presenter'
import { accountStatusIds } from './timelines'
import type { Db } from '../db/sql'
import { blockedDomain } from '../platform/domain-name'
import type { ImportAuthority } from '../platform/store-admin'

// Reports (Mastodon 4.5's POST /api/v1/reports: Api::V1::ReportsController, ReportService, Report; migration
// 0022_reports). A local account reports an account, optionally naming statuses of it and instance rules, and may ask
// that the report be forwarded to the servers concerned. The report is its reporter's (R34): it is stored for the
// instance's moderation, answered once to its reporter, and read otherwise only by the OAuth admin through the
// Mastodon admin API (R37, below).
//
//   - The reported account must be available (ReportService#call raises RecordNotFound when it is unavailable,
//     app/services/report_service.rb:16): anything else is not found.
//   - Each reported status must be one of the account's that the reporter may see by AccountStatusesFilter (R11,
//     report_service.rb:82, `.find` of all of them): one that is not, or that is not the account's, makes the whole
//     report not found. Kopje keeps no deleted status, so with_discarded finds no more than the rule does.
//   - rule_ids make the category `violation` (report_service.rb:11); a blank category is `other`. Report's validations
//     (app/models/report.rb:53-56, 168-170) then hold: a comment of at most 1,000 characters, and a violation names
//     rules that all exist, each once; their messages are Rails'.
//   - Forwarding (report_service.rb:21-24, 53-79): only for a remote account and `forward` true. The Flag goes to the
//     account's server when its domain is in forward_to_domains (by default the account's own; `forwarded` records
//     it), and to the servers of the accounts the reported statuses reply to on the listed domains, less the reported
//     account's inboxes (reportForwardees, R23). It is signed by the instance actor (report_service.rb:98-100), so the
//     reporter is not named, and delivered by the outbound path as any other activity without to (deliveries.ts): by
//     each server's shared inbox when the account has one, where Mastodon posts to the reported account's own inbox.
//   - The OAuth admin is notified (notify_staff!, report_service.rb:44-51) by notifyStaff below.
//
// Bounds (RES-7): Mastodon sets none on status_ids or forward_to_domains; Kopje takes at most MAX_REPORT_STATUSES and
// MAX_FORWARD_DOMAINS (more answer 422 before any status is read). The statuses are read by key, and the replied-to
// accounts through them.

export const MAX_REPORT_STATUSES = 100
export const MAX_FORWARD_DOMAINS = 100
// Report::COMMENT_SIZE_LIMIT (app/models/report.rb:30).
export const MAX_REPORT_COMMENT = 1_000

// Report's category enum (app/models/report.rb:62-67).
const CATEGORIES = new Set(['other', 'spam', 'legal', 'violation'])

// REST::ReportSerializer (app/serializers/rest/report_serializer.rb:3-20).
export type Report = {
	id: string
	action_taken: boolean
	action_taken_at: string | null
	category: string
	comment: string
	forwarded: boolean
	created_at: string
	status_ids: string[]
	rule_ids: string[] | null
	target_account: Account
}

export type ReportInput = {
	account: string
	statusIds: string[]
	comment: string | undefined
	category: string | undefined
	ruleIds: string[]
	forward: boolean
	// The domains sent as forward_to_domains, or null when the parameter was not sent.
	forwardToDomains: string[] | null
	present: Present
	now: number
}

export type ReportResult =
	{ status: 'ok'; report: Report } | { status: 'not_found' } | { status: 'invalid'; errors: string[] }

// Ruby's String#blank?, which `presence` reads.
const blank = (value: string | undefined): boolean => value === undefined || /^\s*$/u.test(value)

export const createReport = userWriteOperation<ReportInput, ReportResult>((db, input, _viewer, viewer) => {
	const target = resolveAccountId(db, input.account)
	if (target === null) {
		return { status: 'not_found' }
	}
	const account = db.first<{ domain: string | null; uri: string }>(
		`SELECT domain, uri FROM accounts WHERE id = ?1 AND ${availableSql('?1')}`,
		target
	)
	if (account === undefined) {
		return { status: 'not_found' }
	}
	// A JSON empty array reads as one blank value (params.ts); Mastodon's JSON body sends none.
	const statusIds = [...new Set(input.statusIds.filter((id) => id !== ''))]
	const ruleIds = input.ruleIds.filter((id) => id !== '')
	const bounds = [
		...(statusIds.length > MAX_REPORT_STATUSES
			? [`Status ids is too long (maximum is ${MAX_REPORT_STATUSES} statuses)`]
			: []),
		...((input.forwardToDomains?.length ?? 0) > MAX_FORWARD_DOMAINS
			? [`Forward to domains is too long (maximum is ${MAX_FORWARD_DOMAINS} domains)`]
			: []),
	]
	if (bounds.length > 0) {
		return { status: 'invalid', errors: bounds }
	}
	const statuses = accountStatusIds(db, viewer, target, statusIds)
	if (statuses.length !== statusIds.length) {
		return { status: 'not_found' }
	}
	const category = ruleIds.length > 0 ? 'violation' : blank(input.category) ? 'other' : (input.category as string)
	const comment = blank(input.comment) ? '' : (input.comment as string)
	const errors = validate(db, { category, comment, ruleIds })
	if (errors.length > 0) {
		return { status: 'invalid', errors }
	}

	const forward = input.forward && account.domain !== null
	const domains = [
		...new Set((input.forwardToDomains ?? [account.domain ?? '']).flatMap((domain) => blockedDomain(domain) ?? [])),
	]
	const forwarded = forward && account.domain !== null && domains.includes(account.domain)
	const domain = instanceDomain(db, input.present)
	const uri = `${instanceActorUri(domain)}#reports/${crypto.randomUUID()}`
	const row = db.first<ReportRow>(
		`INSERT INTO reports (account_id, target_account_id, status_ids, comment, category, rule_ids, forwarded, uri,
			created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${REPORT_COLUMNS}`,
		viewer.accountId,
		target,
		JSON.stringify(statusIds),
		comment,
		category,
		ruleIds.length === 0 ? null : JSON.stringify(ruleIds),
		forwarded ? 1 : 0,
		uri,
		new Date(input.now).toISOString()
	)!
	notifyStaff(db, row, input.now)
	if (forward) {
		const recipients = reportForwardees(db, target, statusIds, domains)
		if (recipients.length > 0) {
			recordOutbound(
				db,
				viewer.accountId,
				flagActivity({
					id: uri,
					actorUri: instanceActorUri(domain),
					targetUri: account.uri,
					statusUris: statuses.map((status) => status.uri),
					comment,
					recipients,
				}),
				input.now
			)
		}
	}
	return { status: 'ok', report: userReport(row, presentAccountsById(db, [target], input.present).get(target)!) }
})

// ReportService#notify_staff! (report_service.rb:44-51) for a report just written, in its transaction: the OAuth admin
// (R37) is notified (admin.report) unless another report of the same account is unresolved
// (Report#unresolved_siblings?, app/models/report.rb:128-130), so only the first unresolved report of an account
// notifies. One seek in reports_target_state finds a sibling, however many reports the account has. Mastodon notifies
// every user who can manage reports; Kopje's one is the OAuth admin, none when there is none. The rule then refuses the
// admin's own report (NotifyService's from_self?), a reporter the admin blocks, mutes with notifications or
// domain-blocks, and an unavailable reporter (shownSql). Kopje stores no remote report (an inbound Flag is
// unsupported), so only a local reporter notifies, where Mastodon's ActivityPub::Activity::Flag goes through
// ReportService and notifies too.
function notifyStaff(db: Db, report: ReportRow, now: number): void {
	const sibling = db.first(
		`SELECT 1 AS x FROM reports INDEXED BY reports_target_state
		WHERE target_account_id = ?1 AND (action_taken_at IS NULL) = 1 AND id <> CAST(?2 AS INTEGER) LIMIT 1`,
		report.target_account_id,
		report.id
	)
	const admin = sibling === undefined ? adminAccountIdOnce(db) : null
	if (admin === null) {
		return
	}
	notify(db, {
		recipientId: admin,
		type: 'admin.report',
		fromId: report.account_id,
		statusId: null,
		reportId: report.id,
		now,
	})
}

// The reporter's Report entities of the reports `ids` (REST::ReportSerializer), by id, with their reported accounts
// read in one query: an admin.report notification shows its report so (REST::NotificationSerializer#report). An id
// that names no report is left out.
export function presentReportsById(db: Db, ids: readonly string[], present: Present): Map<string, Report> {
	if (ids.length === 0) {
		return new Map()
	}
	const rows = db.all<ReportRow>(
		`SELECT ${REPORT_COLUMNS} FROM reports WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`,
		JSON.stringify([...new Set(ids)])
	)
	const accounts = presentAccountsById(
		db,
		rows.map((row) => row.target_account_id),
		present
	)
	return new Map(
		rows.flatMap((row) => {
			const target = accounts.get(row.target_account_id)
			return target === undefined ? [] : [[row.id, userReport(row, target)] as const]
		})
	)
}

export type ReportRow = {
	id: string
	account_id: string
	target_account_id: string
	status_ids: string
	comment: string
	category: string
	rule_ids: string | null
	forwarded: number
	created_at: string
	action_taken_at: string | null
	action_taken_by_account_id: string | null
	assigned_account_id: string | null
	updated_at: string | null
}

export const REPORT_COLUMNS = `CAST(id AS TEXT) AS id, account_id, target_account_id, status_ids, comment, category, rule_ids,
	forwarded, created_at, action_taken_at, action_taken_by_account_id, assigned_account_id, updated_at`

// The reporter's Report entity (REST::ReportSerializer): action_taken once the OAuth admin resolved it.
export function userReport(row: ReportRow, targetAccount: Account): Report {
	return {
		id: row.id,
		action_taken: row.action_taken_at !== null,
		action_taken_at: row.action_taken_at,
		category: row.category,
		comment: row.comment,
		forwarded: row.forwarded === 1,
		created_at: row.created_at,
		status_ids: JSON.parse(row.status_ids) as string[],
		rule_ids: row.rule_ids === null ? null : (JSON.parse(row.rule_ids) as string[]),
		target_account: targetAccount,
	}
}

// Report's validations, in Rails' order and words: the comment's length, then the rules of a violation (which must
// name rules that all exist, each once: `rules.size == rule_ids&.size`). The category is one of the enum's; Mastodon
// raises on any other (an ArgumentError, answered 500), Kopje refuses it as a validation would.
function validate(db: Db, report: { category: string; comment: string; ruleIds: string[] }): string[] {
	const errors: string[] = []
	if (!CATEGORIES.has(report.category)) {
		errors.push('Category is not included in the list')
	}
	if ([...report.comment].length > MAX_REPORT_COMMENT) {
		errors.push(`Comment is too long (maximum is ${MAX_REPORT_COMMENT} characters)`)
	}
	if (report.category === 'violation') {
		const rules = new Set(
			parseRules(db.first<{ value: string }>("SELECT value FROM instance_settings WHERE name = 'rules'")?.value).map(
				(rule) => rule.id
			)
		)
		const named = new Set(report.ruleIds)
		if (
			report.ruleIds.length === 0 ||
			named.size !== report.ruleIds.length ||
			report.ruleIds.some((id) => !rules.has(id))
		) {
			errors.push('Rule ids does not reference valid rules')
		}
	}
	return errors
}

// The domain fixed at /setup, which names the instance actor.
function instanceDomain(db: Db, present: Present): string {
	return (
		db.first<{ value: string }>("SELECT value FROM instance_settings WHERE name = 'domain'")?.value ??
		new URL(present.origin).host
	)
}

// ---- The Mastodon admin API's reports (Api::V1::Admin::ReportsController, app/controllers/api/v1/admin/
// reports_controller.rb; R37, VIS-29): every report, to the OAuth admin only (adminReadOperation, adminWriteOperation:
// anyone else is refused before a report is read, so a report's existence is not disclosed either).

// REST::Admin::ReportSerializer (app/serializers/rest/admin/report_serializer.rb:3-21), in its order.
export type AdminReport = {
	id: string
	action_taken: boolean
	action_taken_at: string | null
	category: string
	comment: string
	forwarded: boolean
	created_at: string
	updated_at: string
	account: AdminAccount
	target_account: AdminAccount
	assigned_account: AdminAccount | null
	action_taken_by_account: AdminAccount | null
	statuses: Status[]
	rules: InstanceRule[]
}

// The index's page (reports_controller.rb:7, Api::BaseController#limit_param: 100 by default, at most twice that).
export const ADMIN_REPORTS_LIMIT = 100
export const MAX_ADMIN_REPORTS_LIMIT = 200
// The statuses one page of the index presents at most: a page stops before a report that would pass this, after at
// least one, and offers the next page. One report's worth (MAX_REPORT_STATUSES), so a page of remote statuses at their
// size limits (content and poll options) stays well inside the Store's RPC response limit.
export const ADMIN_REPORT_STATUS_BUDGET = MAX_REPORT_STATUSES

// The rules of the instance, read once per response.
function instanceRules(db: Db): InstanceRule[] {
	return parseRules(db.first<{ value: string }>("SELECT value FROM instance_settings WHERE name = 'rules'")?.value)
}

// The admin entities of `rows`, in their order. The accounts are read in one query. A report's statuses are shown only
// while its reporter may still see them by the account statuses rule (R11, accountStatusIds, with the reporter as the
// viewer at the admin's request time), and presented with the admin as the viewer: Mastodon shows them regardless,
// discarded ones included (Report#statuses, app/models/report.rb:78-80); Kopje keeps the rule the report was made
// under (R37). The rules are the instance's that the report names, in the instance's order; Mastodon keeps discarded
// rules (Rule.with_discarded), which Kopje does not store.
function presentAdminReports(db: Db, rows: readonly ReportRow[], admin: Admin, present: Present): AdminReport[] {
	const accounts = presentAdminAccounts(
		db,
		rows.flatMap((row) => [
			row.account_id,
			row.target_account_id,
			...(row.assigned_account_id === null ? [] : [row.assigned_account_id]),
			...(row.action_taken_by_account_id === null ? [] : [row.action_taken_by_account_id]),
		]),
		admin.accountId,
		present
	)
	const rules = rows.some((row) => row.rule_ids !== null) ? instanceRules(db) : []
	return rows.map((row) => {
		const named = JSON.parse(row.status_ids) as string[]
		const shown = accountStatusIds(db, viewerOf(admin, row.account_id), row.target_account_id, named)
		const ruleIds = new Set(row.rule_ids === null ? [] : (JSON.parse(row.rule_ids) as string[]))
		const account = (id: string | null) => (id === null ? null : (accounts.get(id) ?? null))
		return {
			id: row.id,
			action_taken: row.action_taken_at !== null,
			action_taken_at: row.action_taken_at,
			category: row.category,
			comment: row.comment,
			forwarded: row.forwarded === 1,
			created_at: row.created_at,
			updated_at: row.updated_at ?? row.created_at,
			account: accounts.get(row.account_id)!,
			target_account: accounts.get(row.target_account_id)!,
			assigned_account: account(row.assigned_account_id),
			action_taken_by_account: account(row.action_taken_by_account_id),
			statuses: presentStatuses(
				db,
				shown.map((status) => status.id),
				{ ...present, viewer: admin.context }
			),
			rules: rules.filter((rule) => ruleIds.has(rule.id)),
		}
	})
}

// ReportFilter (app/models/report_filter.rb:18-25) over the parameters the controller permits (reports_controller.rb:
// 17-21, 88-90): unresolved reports by default, and resolved ones when `resolved` is sent with any value, even
// "false" (scope_for adds Report.resolved for the key, whatever its value); account_id (the reporter) and
// target_account_id. by_target_domain and target_origin are not permitted, so they are ignored.
export type AdminReportFilter = { resolved: boolean; accountId: string | null; targetAccountId: string | null }

export type AdminReportPage = Page<AdminReport> & { more: boolean }

// GET /api/v1/admin/reports: newest first by id, paged by max_id, since_id and min_id (Paginable#to_a_paginated_by_id).
// Each filter reads one index whose range is already in id order for the state: reports_state alone,
// reports_account_state for a reporter, reports_target_state for a reported account, with the reporter as a residual
// when both are given (its skip is the other reporters' reports of that account, which only local users write). A
// page holds `limit` reports, or fewer when the status budget stops it after at least one report; `more` offers the
// next page then too, so a short page with `more` false is the end (Mastodon offers it when the page is full).
export const listAdminReports = adminReadOperation<
	{ filter: AdminReportFilter; page: PageQuery; present: Present },
	AdminReportPage
>(ADMIN_PERMISSION.manageReports, (db, { filter, page, present }, admin) => {
	const ascending = page.minId !== undefined
	// The index, and the equality on its leading columns (and the residual reporter): ?4 on, after the cursor's. The
	// range and the order name reports.id, not the text id the columns answer.
	const [index, keys, ...values] =
		filter.targetAccountId !== null
			? filter.accountId !== null
				? ([
						'reports_target_state',
						'target_account_id = ?4 AND account_id = ?5',
						filter.targetAccountId,
						filter.accountId,
					] as const)
				: (['reports_target_state', 'target_account_id = ?4', filter.targetAccountId] as const)
			: filter.accountId !== null
				? (['reports_account_state', 'account_id = ?4', filter.accountId] as const)
				: (['reports_state', '1'] as const)
	const rows = db.all<ReportRow>(
		`SELECT ${REPORT_COLUMNS} FROM reports INDEXED BY ${index}
		WHERE ${keys} AND (action_taken_at IS NULL) = ${filter.resolved ? 0 : 1} AND ${edgeRangeSql('reports.id', '?1', '?2')}
		ORDER BY reports.id ${ascending ? 'ASC' : 'DESC'} LIMIT ?3`,
		page.maxId ?? null,
		page.minId ?? page.sinceId ?? null,
		page.limit,
		...values
	)
	// The reports up to the status budget, in the order read: always the first.
	const kept: ReportRow[] = []
	let statuses = 0
	for (const row of rows) {
		const count = (JSON.parse(row.status_ids) as string[]).length
		if (kept.length > 0 && statuses + count > ADMIN_REPORT_STATUS_BUDGET) {
			break
		}
		kept.push(row)
		statuses += count
	}
	if (ascending) {
		kept.reverse()
	}
	return {
		items: presentAdminReports(db, kept, admin, present),
		newest: kept[0]?.id ?? null,
		oldest: kept.at(-1)?.id ?? null,
		more: rows.length === page.limit || kept.length < rows.length,
	}
})

export type AdminReportResult =
	{ status: 'ok'; report: AdminReport } | { status: 'not_found' } | { status: 'invalid'; errors: string[] }

// A report by its API id (Report.find, which reads digits as the integer they spell): anything else is not found.
function reportRow(db: Db, id: string): ReportRow | undefined {
	return /^\d{1,18}$/.test(id)
		? db.first<ReportRow>(`SELECT ${REPORT_COLUMNS} FROM reports WHERE reports.id = CAST(? AS INTEGER)`, id)
		: undefined
}

function presented(db: Db, row: ReportRow, admin: Admin, present: Present): AdminReportResult {
	return { status: 'ok', report: presentAdminReports(db, [row], admin, present)[0]! }
}

// GET /api/v1/admin/reports/:id.
export const getAdminReport = adminReadOperation<{ id: string; present: Present }, AdminReportResult>(
	ADMIN_PERMISSION.manageReports,
	(db, { id, present }, admin) => {
		const row = reportRow(db, id)
		return row === undefined ? { status: 'not_found' } : presented(db, row, admin, present)
	}
)

// The moderation actions on a report (reports_controller.rb:42-68, Report#resolve! and #unresolve!,
// app/models/report.rb:102-116), each logged as Mastodon logs it (log_action) in the same transaction. The columns
// change only when their values do, and updated_at with them, as Rails saves only a changed record; the log is written
// either way, as Mastodon writes it.
export type ReportAction = 'assign_to_self' | 'unassign' | 'resolve' | 'reopen'

const ACTIONS: Record<ReportAction, { log: string; set: (admin: Admin, now: string) => Partial<ReportRow> }> = {
	assign_to_self: { log: 'assigned_to_self', set: (admin) => ({ assigned_account_id: admin.accountId }) },
	unassign: { log: 'unassigned', set: () => ({ assigned_account_id: null }) },
	resolve: {
		log: 'resolve',
		set: (admin, now) => ({ action_taken_at: now, action_taken_by_account_id: admin.accountId }),
	},
	reopen: { log: 'reopen', set: () => ({ action_taken_at: null, action_taken_by_account_id: null }) },
}

// See ReportAction for Rails' save semantics.
function updateReport(db: Db, row: ReportRow, changes: Partial<ReportRow>, now: string): ReportRow {
	const changed = Object.entries(changes).filter(([column, value]) => row[column as keyof ReportRow] !== value)
	if (changed.length === 0) {
		return row
	}
	const next = { ...row, ...Object.fromEntries(changed), updated_at: now } as ReportRow
	db.run(
		`UPDATE reports SET ${changed.map(([column]) => `${column} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
		...changed.map(([, value]) => value as string | null),
		now,
		row.id
	)
	return next
}

// Logs an admin write to the report `id` (moderation-log.ts) and stamps the report with the log row's id, the
// report's side of the report fence (resolveSuspensionReports).
function logReportAction(db: Db, admin: Admin, action: string, id: string, detail: Record<string, unknown>): void {
	const logged = logAction(db, admin, action, { type: 'Report', id }, detail, admin.now)
	db.run('UPDATE reports SET last_action_id = ? WHERE id = ?', logged, id)
}

// POST /api/v1/admin/reports/:id/assign_to_self, unassign, resolve and reopen.
export const actOnReport = adminWriteOperation<
	{ id: string; action: ReportAction; present: Present },
	AdminReportResult
>(ADMIN_PERMISSION.manageReports, (db, { id, action, present }, admin) => {
	const row = reportRow(db, id)
	if (row === undefined) {
		return { status: 'not_found' }
	}
	const now = new Date(admin.now).toISOString()
	const updated = updateReport(db, row, ACTIONS[action].set(admin, now), now)
	logReportAction(db, admin, ACTIONS[action].log, row.id, {})
	return presented(db, updated, admin, present)
})

// PUT and PATCH /api/v1/admin/reports/:id: category and rule_ids (report_params, reports_controller.rb:84-86), each
// changed only when sent. Report's validations run when either changes (app/models/report.rb:53-56, 168-170), in
// Rails' order and words: a category that is not a violation names no rules (`absence`, so an empty list passes),
// and a violation names rules that all exist, each once (`rules.size == rule_ids&.size`, so an empty list passes and
// none does not). A category outside the enum, or blank, answers 422 as a validation would, where Mastodon raises
// (ArgumentError, or the NOT NULL constraint) and answers 500. The update is logged either way.
export const updateAdminReport = adminWriteOperation<
	{ id: string; category: string | undefined; ruleIds: string[] | undefined; present: Present },
	AdminReportResult
>(ADMIN_PERMISSION.manageReports, (db, { id, category, ruleIds, present }, admin) => {
	const row = reportRow(db, id)
	if (row === undefined) {
		return { status: 'not_found' }
	}
	const stored = row.rule_ids === null ? null : (JSON.parse(row.rule_ids) as string[])
	const nextCategory = category ?? row.category
	const nextRules = ruleIds ?? stored
	if (!CATEGORIES.has(nextCategory)) {
		return { status: 'invalid', errors: ['Category is not included in the list'] }
	}
	const changed = nextCategory !== row.category || JSON.stringify(nextRules) !== JSON.stringify(stored)
	const errors: string[] = []
	if (changed && nextCategory !== 'violation' && (nextRules?.length ?? 0) > 0) {
		errors.push('Rule ids must be blank')
	}
	if (changed && nextCategory === 'violation') {
		const rules = new Set(instanceRules(db).map((rule) => rule.id))
		if (nextRules === null || new Set(nextRules).size !== nextRules.length || nextRules.some((id) => !rules.has(id))) {
			errors.push('Rule ids does not reference valid rules')
		}
	}
	if (errors.length > 0) {
		return { status: 'invalid', errors }
	}
	const now = new Date(admin.now).toISOString()
	const updated = updateReport(
		db,
		row,
		{ category: nextCategory, rule_ids: nextRules === null ? null : JSON.stringify(nextRules) },
		now
	)
	logReportAction(db, admin, 'update', row.id, { category: updated.category, rule_ids: nextRules })
	return presented(db, updated, admin, present)
})

// The newest report, which bounds the reports a local suspension resolves (domain/suspension.ts).
export function reportBound(db: Db): number {
	return db.first<{ id: number | null }>('SELECT max(id) AS id FROM reports')?.id ?? 0
}

// The newest moderation log row, which a suspension freezes in its transaction: the action bound of the report fence
// (resolveSuspensionReports).
export function actionBound(db: Db): number {
	return db.first<{ id: number | null }>('SELECT max(id) AS id FROM admin_actions')?.id ?? 0
}

// A suspension-job round (domain/suspension.ts) resolving the target's reports, as Admin::AccountAction
// #process_reports! resolves every unresolved one. Read at most `limit` reports after report id `cursor`, through
// reports_target_state in id order. Resolve only reports frozen at suspension (the report fence, R37, VIS-29): filed
// up to `bound`, still unresolved, and last written at or below the suspension's `actionBound`. An unknown bound
// (null) resolves none. Every write to a report stamps last_action_id with the moderation log id of the admin action
// that caused it (none counts as 0): an admin's write its own row (logReportAction), this round the suspension's row,
// `actionBound`, with no row per report (the log is capped; Mastodon logs the account action alone). Log ids are given
// in commit order, so a report an admin reopened or changed after the suspension stays untouched, whatever either
// request's clock said. `by` names the suspending admin (null: none). Returns the last report read (null if none) and
// the resolved count; fewer than `limit` read means the range is done.
export function resolveSuspensionReports(
	db: Db,
	target: string,
	bound: number,
	actionBound: number | null,
	by: string | null,
	cursor: number,
	limit: number,
	now: string
): { last: number | null; read: number; resolved: number } {
	const rows = db.all<{ id: number; action: number }>(
		`SELECT id, coalesce(last_action_id, 0) AS action
		FROM reports INDEXED BY reports_target_state
		WHERE target_account_id = ?1 AND (action_taken_at IS NULL) = 1 AND id > ?2 AND id <= ?3
		ORDER BY id LIMIT ?4`,
		target,
		cursor,
		bound,
		limit
	)
	const frozen = actionBound === null ? [] : rows.filter((row) => row.action <= actionBound).map((row) => row.id)
	if (frozen.length > 0) {
		db.run(
			`UPDATE reports SET action_taken_at = ?1, action_taken_by_account_id = ?2, updated_at = ?1, last_action_id = ?4
			WHERE id IN (SELECT value FROM json_each(?3))`,
			now,
			by,
			JSON.stringify(frozen),
			actionBound
		)
	}
	return { last: rows.at(-1)?.id ?? null, read: rows.length, resolved: frozen.length }
}

export type ReportTargetPage =
	{ ok: true; page: string } | { ok: false; code: 'wrong-authority' | 'report-not-found'; message: string }

// GET /admin/reports/:id (the Access admin's, app/admin.ts): the web page of the account report `id` is about (its
// Account entity's url). The Access admin is checked against the saved configuration in this transaction, before the
// report is read (accessAdminRefusal), so a change of the settings while the request was being authenticated refuses
// it; an id that is no report's is not found (Report.find).
export const reportTargetPage = readOperation<
	{ authority: ImportAuthority; id: string; origin: string },
	ReportTargetPage
>((db, { authority, id, origin }) => {
	const refused = accessAdminRefusal(db, authority, 'only an Access admin opens a report')
	if (refused !== null) {
		return { ok: false, code: 'wrong-authority', message: refused }
	}
	const row = /^\d{1,18}$/.test(id)
		? db.first<{ url: string | null; uri: string; username: string; domain: string | null }>(
				`SELECT a.url, a.uri, a.username, a.domain FROM reports r JOIN accounts a ON a.id = r.target_account_id
				WHERE r.id = CAST(? AS INTEGER)`,
				id
			)
		: undefined
	return row === undefined
		? { ok: false, code: 'report-not-found', message: 'report not found' }
		: { ok: true, page: accountUrl(row, origin) }
})

// Whether `id` is a report's (Admin::AccountAction#report: Report.find, RecordNotFound otherwise).
export function reportExists(db: Db, id: string): boolean {
	return reportRow(db, id) !== undefined
}

// Admin::AccountAction with type none and a report_id (process_reports!): resolves that report, logged as Mastodon logs
// it. false when `id` is no report's.
export function resolveReport(db: Db, id: string, admin: Admin): boolean {
	const row = reportRow(db, id)
	if (row === undefined) {
		return false
	}
	const now = new Date(admin.now).toISOString()
	updateReport(db, row, ACTIONS.resolve.set(admin, now), now)
	logReportAction(db, admin, ACTIONS.resolve.log, row.id, {})
	return true
}
