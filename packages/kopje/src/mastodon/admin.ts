import {
	type ApiContext,
	type ApiHandler,
	authorized,
	checkOptionalToken,
	optionalCredential,
	present,
	requestParams,
	storeCall,
} from './context'
import { mastodonError } from './errors'
import type { Params } from './params'
import { reportResponse } from './reports'
import type { PageQuery } from '../domain/accounts'
import { ADMIN_REPORTS_LIMIT, MAX_ADMIN_REPORTS_LIMIT, type ReportAction } from '../domain/reports'

// The Mastodon admin API (/api/v1/admin/*, /api/v2/admin/*). Every route is Mastodon's authorize_if_got_token!: the
// token is optional, a token sent must be valid and cover the route's admin scope, and an app token is let through.
// Mastodon's Pundit policy then refuses any role without the route's permission bit, so anonymous callers, app tokens
// and users who are not staff are answered 403 "This action is not allowed".
//
// The reports routes (below) are served. The other handlers here are the routes Kopje does not serve (yet): they answer as Mastodon does for a role without the
// route's permission, which is the same to every caller, so they check the token only (no admin check, no Store read
// beyond it). A route that finds its record before authorizing (a before_action with find) answers 404 for an id of a
// kind Kopje stores none of; one that authorizes first, or whose records Kopje does store (accounts, reports, tags),
// answers 403. The routes Kopje serves are admin operations (adminReadOperation, domain/auth.ts), which grant only the
// bits in ADMIN_PERMISSIONS to the OAuth admin.

const NOT_ALLOWED = 'This action is not allowed'

const afterToken =
	(answer: (c: ApiContext) => Response): ApiHandler =>
	async (c, deps) => {
		await checkOptionalToken(c, deps)
		return answer(c)
	}

// Mastodon's policy refusal for a role without the route's permission (ApplicationPolicy, Api::ErrorHandling's
// Mastodon::NotPermittedError rescue). Measures, dimensions and retention are refused before their body is read, where
// Mastodon would first answer 400 to a body without its required keys (params.require); the refusal is the same either
// way for a role without view_dashboard.
export const notAllowed = afterToken(() => mastodonError(403, NOT_ALLOWED))

// A route whose before_action finds the record by id before the policy runs (set_domain_block, set_domain_allow,
// set_ip_block, set_email_domain_block, set_canonical_email_block): RecordNotFound, since Kopje stores no instance
// domain blocks, domain allows, IP blocks, email domain blocks or canonical email blocks.
export const recordNotFound = afterToken(() => mastodonError(404, 'Record not found'))

// GET /api/v1/admin/trends/{tags,links,statuses}: without manage_taxonomies, Mastodon answers the public trends
// (`super`), which are empty in Kopje (placeholders.emptyList).
export const trends = afterToken((c) => c.json([]))

// ---- Reports (Api::V1::Admin::ReportsController, app/controllers/api/v1/admin/reports_controller.rb; the Store does
// the work in domain/reports.ts). Mastodon finds the report (set_report) before its policy runs, so a role without
// manage_reports learns from 404 or 403 whether a report id exists; Kopje refuses everyone but the OAuth admin before
// reading the report, so the answer is 403 either way and the number of reports is not disclosed. The admin is answered
// 404 for an id that is not a report.

const CURSOR = /^\d{1,19}$/

// limit_param(LIMIT) (app/controllers/api/base_controller.rb:33-37): the absolute value, at most twice the default.
// Mastodon's own answer to 0 (or a limit that is not a number) is a server error, as it reads the cursor of an empty
// page; Kopje reads it as 1.
function adminPage(p: Params): PageQuery {
	const sent = p.get('limit')
	const limit = sent === undefined ? ADMIN_REPORTS_LIMIT : Math.abs(Number.parseInt(sent, 10) || 0)
	const cursor = (name: string) => {
		const value = p.get(name)
		return value !== undefined && CURSOR.test(value) ? value : undefined
	}
	return {
		maxId: cursor('max_id'),
		sinceId: cursor('since_id'),
		minId: cursor('min_id'),
		limit: Math.min(Math.max(limit, 1), MAX_ADMIN_REPORTS_LIMIT),
	}
}

// The parameters the index's Link URLs carry (PAGINATION_PARAMS, reports_controller.rb:17-23, 108-110), with the
// cursor, in the sorted order Rails' URL helpers write them.
const REPORT_PAGINATION_PARAMS = ['limit', 'resolved', 'account_id', 'target_account_id']

function reportsUrl(c: ApiContext, p: Params, cursor: Record<string, string>): string {
	const url = new URL('/api/v1/admin/reports', c.req.url)
	const entries: [string, string][] = [
		...REPORT_PAGINATION_PARAMS.flatMap((name): [string, string][] => {
			const value = p.get(name)
			return value === undefined ? [] : [[name, value]]
		}),
		...Object.entries(cursor),
	]
	for (const [name, value] of entries.sort(([a], [b]) => (a < b ? -1 : 1))) {
		url.searchParams.set(name, value)
	}
	return url.toString()
}

// GET /api/v1/admin/reports: ReportFilter's parameters, newest first; next is offered when the page is full or the
// status budget stopped it, prev whenever it has reports (next_path and prev_path, reports_controller.rb:92-98).
export const reports: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const page = adminPage(p)
	const input = {
		credential: optionalCredential(c, deps),
		filter: {
			resolved: p.has('resolved'),
			accountId: p.get('account_id') ?? null,
			targetAccountId: p.get('target_account_id') ?? null,
		},
		page,
		present: present(c),
	}
	const result = authorized(await storeCall(c, deps, (s, b) => s.adminReports(b, input)))
	const links: string[] = []
	if (result.more && result.oldest !== null) {
		links.push(`<${reportsUrl(c, p, { max_id: result.oldest })}>; rel="next"`)
	}
	if (result.newest !== null) {
		links.push(`<${reportsUrl(c, p, { min_id: result.newest })}>; rel="prev"`)
	}
	if (links.length > 0) {
		c.header('Link', links.join(', '))
	}
	return c.json(result.items)
}

// GET /api/v1/admin/reports/:id.
export const report: ApiHandler = async (c, deps) => {
	const input = { credential: optionalCredential(c, deps), id: c.req.param('id') ?? '', present: present(c) }
	return reportResponse(authorized(await storeCall(c, deps, (s, b) => s.adminReport(b, input))), c)
}

// PUT and PATCH /api/v1/admin/reports/:id: category and rule_ids[].
export const updateReport: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const input = {
		id: c.req.param('id') ?? '',
		category: p.get('category'),
		// A JSON empty array reads as one blank value (params.ts): no rules.
		ruleIds: p.has('rule_ids') ? p.getAll('rule_ids').filter((id) => id !== '') : undefined,
		present: present(c),
		credential: optionalCredential(c, deps),
	}
	return reportResponse(authorized(await storeCall(c, deps, (s, b) => s.updateAdminReport(b, input))), c)
}

// POST /api/v1/admin/reports/:id/assign_to_self, unassign, resolve and reopen.
export function actOnReport(action: ReportAction): ApiHandler {
	return async (c, deps) => {
		const input = {
			credential: optionalCredential(c, deps),
			id: c.req.param('id') ?? '',
			action,
			present: present(c),
		}
		return reportResponse(authorized(await storeCall(c, deps, (s, b) => s.actOnReport(b, input))), c)
	}
}
