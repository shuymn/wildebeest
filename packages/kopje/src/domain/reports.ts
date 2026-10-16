import { type Account, type Present, presentAccountsById, resolveAccountId } from './accounts'
import { flagActivity, instanceActorUri, recordOutbound } from './activities'
import { availableSql, reportForwardees } from './audience'
import { userWriteOperation } from './auth'
import { parseRules } from './instance'
import { accountStatusIds } from './timelines'
import type { Db } from '../db/sql'
import { blockedDomain } from '../platform/domain-name'

// Reports (Mastodon 4.5's POST /api/v1/reports: Api::V1::ReportsController, ReportService, Report; migration
// 0022_reports). A local account reports an account, optionally naming statuses of it and instance rules, and may ask
// that the report be forwarded to the servers concerned. The report is its reporter's (R34): it is stored for the
// instance's moderation, answered once to its reporter, and read by nothing else; Kopje has no admin view of it yet.
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
//   - Not done: Mastodon notifies its staff (notify_staff!, report_service.rb:44-51); Kopje has no admin notification
//     type, so no one is notified.
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
	if (accountStatusIds(db, viewer, target, statusIds).length !== statusIds.length) {
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
	const createdAt = new Date(input.now).toISOString()
	const uri = `${instanceActorUri(domain)}#reports/${crypto.randomUUID()}`
	const row = db.first<{ id: string }>(
		`INSERT INTO reports (account_id, target_account_id, status_ids, comment, category, rule_ids, forwarded, uri,
			created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING CAST(id AS TEXT) AS id`,
		viewer.accountId,
		target,
		JSON.stringify(statusIds),
		comment,
		category,
		ruleIds.length === 0 ? null : JSON.stringify(ruleIds),
		forwarded ? 1 : 0,
		uri,
		createdAt
	)!
	if (forward) {
		const recipients = reportForwardees(db, target, statusIds, domains)
		if (recipients.length > 0) {
			const statusUris = db
				.all<{ uri: string }>(
					'SELECT uri FROM statuses WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id',
					JSON.stringify(statusIds)
				)
				.map((status) => status.uri)
			recordOutbound(
				db,
				viewer.accountId,
				flagActivity({
					id: uri,
					actorUri: instanceActorUri(domain),
					targetUri: account.uri,
					statusUris,
					comment,
					recipients,
				}),
				input.now
			)
		}
	}
	const targetAccount = presentAccountsById(db, [target], input.present).get(target)!
	return {
		status: 'ok',
		report: {
			id: row.id,
			action_taken: false,
			action_taken_at: null,
			category,
			comment,
			forwarded,
			created_at: createdAt,
			status_ids: statusIds,
			rule_ids: ruleIds.length === 0 ? null : ruleIds,
			target_account: targetAccount,
		},
	}
})

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
