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
import { mastodonError, moderatingError } from './errors'
import type { Params } from './params'
import { reportResponse } from './reports'
import type { PageQuery } from '../domain/accounts'
import {
	type AccountActionResult,
	ADMIN_ACCOUNTS_LIMIT,
	type AdminAccountAction,
	type AdminAccountFilter,
	type AdminAccountResult,
	type AdminAccountStatus,
	MAX_ADMIN_ACCOUNTS_LIMIT,
} from '../domain/admin-accounts'
import { OWNER_ROLE } from '../domain/auth'
import { ADMIN_REPORTS_LIMIT, MAX_ADMIN_REPORTS_LIMIT, type ReportAction } from '../domain/reports'

// The Mastodon admin API (/api/v1/admin/*, /api/v2/admin/*). Every route is Mastodon's authorize_if_got_token!: the
// token is optional, a token sent must be valid and cover the route's admin scope, and an app token is let through.
// Mastodon's Pundit policy then refuses any role without the route's permission bit, so anonymous callers, app tokens
// and users who are not staff are answered 403 "This action is not allowed".
//
// Reports and accounts (below) are served as admin operations (adminReadOperation, domain/auth.ts), granting only
// ADMIN_PERMISSIONS to the OAuth admin. The other handlers are routes Kopje does not serve (yet): they answer as
// Mastodon does a role without the route's permission, the same to every caller, so they check only the token (no
// admin check or further Store read). A route that finds its record before authorizing (a before_action with find)
// answers 404 for a kind Kopje stores none of; one that authorizes first, or whose records Kopje stores (accounts,
// reports, tags), answers 403.

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

// ---- Reports (Api::V1::Admin::ReportsController, app/controllers/api/v1/admin/reports_controller.rb;
// domain/reports.ts). Mastodon's set_report precedes manage_reports policy (404/403 leaks existence). Kopje authorizes
// the OAuth admin first (R37, VIS-29): others always get 403; an authorized lookup of a missing report returns 404.

const CURSOR = /^\d{1,19}$/

// limit_param(LIMIT) (app/controllers/api/base_controller.rb:33-37): the absolute value, at most twice the default.
// Mastodon's own answer to 0 (or a limit that is not a number) is a server error, as it reads the cursor of an empty
// page; Kopje reads it as 1.
function adminPage(p: Params, fallback = ADMIN_REPORTS_LIMIT, max = MAX_ADMIN_REPORTS_LIMIT): PageQuery {
	const sent = p.get('limit')
	const limit = sent === undefined ? fallback : Math.abs(Number.parseInt(sent, 10) || 0)
	const cursor = (name: string) => {
		const value = p.get(name)
		return value !== undefined && CURSOR.test(value) ? value : undefined
	}
	return {
		maxId: cursor('max_id'),
		sinceId: cursor('since_id'),
		minId: cursor('min_id'),
		limit: Math.min(Math.max(limit, 1), max),
	}
}

// The parameters the index's Link URLs carry (PAGINATION_PARAMS, reports_controller.rb:17-23, 108-110), with the
// cursor, in the sorted order Rails' URL helpers write them.
const REPORT_PAGINATION_PARAMS = ['limit', 'resolved', 'account_id', 'target_account_id']

// The array parameters a Link URL carries (v2's role_ids[]).
const ARRAY_PARAMS = new Set(['role_ids'])

// An array parameter as Mastodon permits it in both forms (`name` and `name[]`) and reads it (Array(value)): every
// value of `name[]` (an explicitly empty list is one blank value, still sent) and a `name` sent not blank; undefined
// when neither was sent.
function arrayParam(p: Params, name: string): string[] | undefined {
	const scalar = p.get(name)
	const values = [...(scalar !== undefined && scalar.trim() !== '' ? [scalar] : []), ...(p.list(name) ?? [])]
	return values.length === 0 ? undefined : values
}

// A list's Link URL: `names` as the request sent them (an array parameter's values each as `name[]`) and the cursor.
function listUrl(c: ApiContext, path: string, names: readonly string[], p: Params, cursor: Record<string, string>) {
	const url = new URL(path, c.req.url)
	const entries: [string, string][] = [
		...names.flatMap((name): [string, string][] => {
			if (ARRAY_PARAMS.has(name)) {
				return (arrayParam(p, name) ?? []).map((value) => [`${name}[]`, value])
			}
			const value = p.get(name)
			return value === undefined ? [] : [[name, value]]
		}),
		...Object.entries(cursor),
	]
	for (const [name, value] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		url.searchParams.append(name, value)
	}
	return url.toString()
}

// The Link header of a list page: next (max_id) when there is more, prev (min_id) whenever the page has items
// (next_path and prev_path).
function listLinks(
	c: ApiContext,
	url: (cursor: Record<string, string>) => string,
	result: { more: boolean; newest: string | null; oldest: string | null }
): void {
	const links: string[] = []
	if (result.more && result.oldest !== null) {
		links.push(`<${url({ max_id: result.oldest })}>; rel="next"`)
	}
	if (result.newest !== null) {
		links.push(`<${url({ min_id: result.newest })}>; rel="prev"`)
	}
	if (links.length > 0) {
		c.header('Link', links.join(', '))
	}
}

function reportsUrl(c: ApiContext, p: Params, cursor: Record<string, string>): string {
	return listUrl(c, '/api/v1/admin/reports', REPORT_PAGINATION_PARAMS, p, cursor)
}

// GET /api/v1/admin/reports (reports_controller.rb:92-98 next_path/prev_path); paging: listLinks and listAdminReports.
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
	listLinks(c, (cursor) => reportsUrl(c, p, cursor), result)
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

// ---- Accounts (Api::V{1,2}::Admin::AccountsController; domain/admin-accounts.ts): set_account precedes the policy.
// Kopje requires the OAuth admin's manage_users before lookup; see the Reports note above for the disclosure rule.

// Each version's FILTER_PARAMS (accounts_controller.rb:18-33; v2 3-14), which with limit are its PAGINATION_PARAMS.
const V1_ACCOUNT_PARAMS = [
	'local',
	'remote',
	'by_domain',
	'active',
	'pending',
	'disabled',
	'sensitized',
	'silenced',
	'suspended',
	'username',
	'display_name',
	'email',
	'ip',
	'staff',
]
const V2_ACCOUNT_PARAMS = [
	'origin',
	'status',
	'permissions',
	'username',
	'by_domain',
	'display_name',
	'email',
	'ip',
	'invited_by',
	'role_ids',
]
// The v1 states, in the order whose last one sent wins (translated_filter_params).
const V1_STATUSES = ['active', 'pending', 'disabled', 'silenced', 'suspended'] as const
const STATUSES: readonly string[] = [...V1_STATUSES, 'sensitized'] satisfies AdminAccountStatus[]

const TOO_BROAD = 'search term too broad; add a filter or a longer prefix'

export type ParsedAccountFilter = { filter: AdminAccountFilter; names: readonly string[] } | { error: string }

// The request's filter as AccountFilter reads it after each controller's translated_filter_params, with the names the
// Link URLs carry. A parameter sent blank is not sent (`value.present?`). v1 lists local accounts that are active
// unless told otherwise: remote selects remote accounts (whatever local says), the last of the states sent wins, and
// staff selects the staff. v2 has no defaults, and reads origin, status, permissions=staff and role_ids[].
//
// Fedilab sends v1's names to v2 (MastodonAdminService#getAccounts; its "all" sends local, remote and all five
// states), which Mastodon's v2 ignores, listing every account. When no v2 filter name (origin, status, permissions,
// role_ids) is sent, v2 reads them as v1 would, except that it keeps no default: exactly one of local and remote gives
// the origin, exactly one of the five states gives the status (several give none, as Fedilab's "all" means), and staff
// gives the staff. A deliberate difference from Mastodon, for the one client that sends these names to v2.
export function accountFilter(version: 1 | 2, p: Params): ParsedAccountFilter {
	const sent = (name: string) => {
		const value = p.get(name)
		return value !== undefined && value.trim() !== '' ? value : undefined
	}
	const text = (name: string, read: (value: string) => string = (value) => value.trim()) => {
		const value = sent(name)
		const kept = value === undefined ? '' : read(value)
		return kept === '' ? null : kept
	}
	const searches = {
		username: text('username', (value) => value.trim().replace(/^@/, '')),
		byDomain: text('by_domain', (value) => value.trim().toLowerCase()),
		displayName: text('display_name'),
		email: text('email'),
		ip: text('ip'),
	}
	let origin: string | null
	let status: string | null
	let roleIds: readonly string[] | null
	let names: readonly string[]
	if (version === 1) {
		origin = sent('remote') !== undefined ? 'remote' : 'local'
		status = V1_STATUSES.findLast((name) => sent(name) !== undefined) ?? 'active'
		roleIds = sent('staff') !== undefined ? [OWNER_ROLE.id] : null
		names = V1_ACCOUNT_PARAMS
	} else {
		const roles = arrayParam(p, 'role_ids')
		const v2 = [sent('origin'), sent('status'), sent('permissions'), roles].some((value) => value !== undefined)
		if (v2) {
			origin = sent('origin') ?? null
			status = sent('status') ?? null
			roleIds = sent('permissions') === 'staff' ? [OWNER_ROLE.id] : (roles ?? null)
			names = V2_ACCOUNT_PARAMS
		} else {
			const one = (candidates: readonly string[]) => {
				const present = candidates.filter((name) => sent(name) !== undefined)
				return present.length === 1 ? present[0]! : null
			}
			origin = one(['local', 'remote'])
			status = one(V1_STATUSES)
			roleIds = sent('staff') !== undefined ? [OWNER_ROLE.id] : null
			names = [...new Set([...V2_ACCOUNT_PARAMS, ...V1_ACCOUNT_PARAMS])]
		}
	}
	// AccountFilter checks origin before status (KEYS order); Mastodon::InvalidParameterError is 400. by_domain is
	// applied after origin and replaces its condition on the domain (scope.merge!), so with by_domain a valid origin
	// selects nothing more: v1's default local origin included.
	if (origin !== null && origin !== 'local' && origin !== 'remote') {
		return { error: `Unknown origin: ${origin}` }
	}
	if (searches.byDomain !== null) {
		origin = null
	}
	if (status !== null && !STATUSES.includes(status)) {
		return { error: `Unknown status: ${status}` }
	}
	return {
		filter: {
			origin,
			status: status as AdminAccountStatus | null,
			roleIds,
			...searches,
			invitedBy: version === 2 ? text('invited_by') : null,
		},
		names,
	}
}

// GET /api/v1/admin/accounts and /api/v2/admin/accounts. An unknown origin or status is answered 400 after the token
// is checked and before the policy (set_accounts runs before index's authorize), so to every caller.
export function adminAccounts(version: 1 | 2): ApiHandler {
	return async (c, deps) => {
		const p = await requestParams(c, deps)
		if (p instanceof Response) {
			return p
		}
		const parsed = accountFilter(version, p)
		if ('error' in parsed) {
			await checkOptionalToken(c, deps)
			return mastodonError(400, parsed.error)
		}
		const input = {
			credential: optionalCredential(c, deps),
			filter: parsed.filter,
			page: adminPage(p, ADMIN_ACCOUNTS_LIMIT, MAX_ADMIN_ACCOUNTS_LIMIT),
			present: present(c),
		}
		const result = authorized(await storeCall(c, deps, (s, b) => s.adminAccounts(b, input)))
		if (result.status === 'too_broad') {
			return mastodonError(422, TOO_BROAD)
		}
		if (result.status === 'moderating') {
			return moderatingError()
		}
		const path = `/api/v${version}/admin/accounts`
		listLinks(c, (cursor) => listUrl(c, path, ['limit', ...parsed.names], p, cursor), result)
		return c.json(result.items)
	}
}

type AccountAnswer = { status: 'ok'; account: object } | Exclude<AdminAccountResult, { status: 'ok' }>

function accountResponse(result: AccountAnswer, c: ApiContext): Response {
	switch (result.status) {
		case 'ok':
			return c.json(result.account)
		case 'not_found':
			return mastodonError(404, 'Record not found')
		case 'not_allowed':
			return mastodonError(403, NOT_ALLOWED)
	}
}

// GET /api/v1/admin/accounts/:id.
export const adminAccount: ApiHandler = async (c, deps) => {
	const input = { credential: optionalCredential(c, deps), id: c.req.param('id') ?? '', present: present(c) }
	return accountResponse(authorized(await storeCall(c, deps, (s, b) => s.adminAccount(b, input))), c)
}

// POST /api/v1/admin/accounts/:id/{enable,unsilence,unsensitive,approve,reject}.
export function actOnAccount(action: AdminAccountAction): ApiHandler {
	return async (c, deps) => {
		const input = {
			credential: optionalCredential(c, deps),
			id: c.req.param('id') ?? '',
			action,
			present: present(c),
		}
		return accountResponse(authorized(await storeCall(c, deps, (s, b) => s.actOnAdminAccount(b, input))), c)
	}
}

// POST /api/v1/admin/accounts/:account_id/action (Api::V1::Admin::AccountActionsController#create): type, report_id,
// warning_preset_id, text and send_email_notification, as form fields (Fedilab) or JSON. A type or report_id sent blank
// is not sent (`present?`). Answers an empty object (render_empty) once the action is done.
export const accountAction: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const sent = (name: string) => {
		const value = p.get(name)
		return value === undefined || value.trim() === '' ? null : value
	}
	const input = {
		credential: optionalCredential(c, deps),
		id: c.req.param('account_id') ?? '',
		type: sent('type'),
		reportId: sent('report_id'),
	}
	const result: AccountActionResult = authorized(await storeCall(c, deps, (s, b) => s.adminAccountAction(b, input)))
	switch (result.status) {
		case 'ok':
			return c.json({})
		case 'invalid':
			return mastodonError(422, result.error)
		default:
			return accountResponse(result, c)
	}
}

// POST /api/v1/admin/accounts/:id/unsuspend.
export const unsuspendAccount: ApiHandler = async (c, deps) => {
	const input = { credential: optionalCredential(c, deps), id: c.req.param('id') ?? '', present: present(c) }
	return accountResponse(authorized(await storeCall(c, deps, (s, b) => s.unsuspendAdminAccount(b, input))), c)
}
