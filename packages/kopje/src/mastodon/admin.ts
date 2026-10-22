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
import { type Params, parseBoolean } from './params'
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
import {
	type BlockRequest,
	DOMAIN_BLOCKS_LIMIT,
	type DomainBlockResult,
	MAX_DOMAIN_BLOCKS_LIMIT,
} from '../domain/admin-domain-blocks'
import {
	dayNumber,
	IN_RANGE_MEASURES,
	MEASURE_DAYS,
	MEASURE_DOMAINS,
	MEASURE_ROWS,
	measurableTime,
	measurePeriod,
	type MeasureRows,
	type MeasureTime,
	type MeasureValue,
	SERVED_MEASURES,
	type ServedMeasure,
} from '../domain/admin-measures'
import { OWNER_ROLE } from '../domain/auth'
import { type InstanceDomainBlock, MAX_DOMAIN_INPUT } from '../domain/instance-domain-blocks'
import { ADMIN_REPORTS_LIMIT, MAX_ADMIN_REPORTS_LIMIT, type ReportAction } from '../domain/reports'
import { blockedDomain } from '../platform/domain-name'
import { sha256Hex } from '../security/tokens'

// The Mastodon admin API (/api/v1/admin/*, /api/v2/admin/*). Every route is Mastodon's authorize_if_got_token!: the
// token is optional, a token sent must be valid and cover the route's admin scope, and an app token is let through.
// Mastodon's Pundit policy then refuses any role without the route's permission bit, so anonymous callers, app tokens
// and users who are not staff are answered 403 "This action is not allowed".
//
// Reports, accounts, domain blocks and allows, and the metrics (below) are served as admin operations
// (adminReadOperation, domain/auth.ts), granting only ADMIN_PERMISSIONS to the OAuth admin. The other handlers are
// routes Kopje does not serve: they answer as Mastodon does a role without the route's permission, the same to every
// caller, so they check only the token (no admin check or further Store read). A route that finds its record before
// authorizing (a before_action with find) answers 404 for a kind Kopje stores none of; one that authorizes first, or
// whose records Kopje stores (accounts, reports, domain blocks, tags), answers 403.

const NOT_ALLOWED = 'This action is not allowed'

const afterToken =
	(answer: (c: ApiContext) => Response): ApiHandler =>
	async (c, deps) => {
		await checkOptionalToken(c, deps)
		return answer(c)
	}

// Mastodon's policy refusal for a role without the route's permission (ApplicationPolicy, Api::ErrorHandling's
// Mastodon::NotPermittedError rescue).
export const notAllowed = afterToken(() => mastodonError(403, NOT_ALLOWED))

// A route whose before_action finds the record by id before the policy runs (set_domain_allow,
// set_ip_block, set_email_domain_block, set_canonical_email_block): RecordNotFound, since Kopje stores no domain
// allows, IP blocks, email domain blocks or canonical email blocks.
export const recordNotFound = afterToken(() => mastodonError(404, 'Record not found'))

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

// send_email_notification as Admin::AccountAction's boolean attribute casts it (default true): absent is true, blank
// (JSON null reads as blank) is nil, which is false, and ActiveModel::Type::Boolean::FALSE_VALUES are false, each in
// its own case only (parseBoolean folds case, so 'False' would be false there; Rails casts it to true).
const ACTION_NOTIFICATION_OFF: readonly string[] = ['', '0', 'f', 'F', 'false', 'FALSE', 'off', 'OFF']

// POST /api/v1/admin/accounts/:account_id/action (Api::V1::Admin::AccountActionsController#create): type, report_id,
// warning_preset_id, text and send_email_notification, as form fields (Fedilab) or JSON. A type, report_id or
// warning_preset_id sent blank is not sent (`present?`); text is as sent, empty when absent (text_for_warning's
// compact.join). No email is sent: send_email_notification decides whether a local target is warned
// (domain/admin-accounts.ts). Answers an empty object (render_empty) once the action is done.
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
		warningPresetId: sent('warning_preset_id'),
		text: p.get('text') ?? '',
		notify: !ACTION_NOTIFICATION_OFF.includes(p.get('send_email_notification') ?? 'true'),
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

// ---- Domain blocks (Api::V1::Admin::DomainBlocksController, domain_blocks_controller.rb;
// domain/admin-domain-blocks.ts).
// set_domain_block precedes the policy in Mastodon; Kopje authorizes the OAuth admin first, as for reports.

// REST::Admin::DomainBlockSerializer (app/serializers/rest/admin/domain_block_serializer.rb), in its attribute order;
// digest is the SHA-256 of the domain (DomainBlock#domain_digest, domain_block.rb:104-106).
async function domainBlockEntity(block: InstanceDomainBlock): Promise<object> {
	return {
		id: String(block.id),
		domain: block.domain,
		digest: await sha256Hex(block.domain),
		created_at: block.created_at,
		severity: block.severity,
		reject_media: block.reject_media,
		reject_reports: block.reject_reports,
		private_comment: block.private_comment,
		public_comment: block.public_comment,
		obfuscate: block.obfuscate,
	}
}

async function domainBlockResponse(result: DomainBlockResult, c: ApiContext, body?: object): Promise<Response> {
	switch (result.status) {
		case 'ok':
			return c.json(body ?? (await domainBlockEntity(result.block)))
		case 'not_found':
			return mastodonError(404, 'Record not found')
		case 'invalid':
			return mastodonError(422, result.error)
		case 'exists':
			// REST::Admin::ExistingDomainBlockErrorSerializer with the en locale's admin.domain_blocks.existing_domain_block.
			return c.json(
				{
					error: `You have already imposed stricter limits on ${result.existing.domain}.`,
					existing_domain_block: await domainBlockEntity(result.existing),
				},
				422
			)
	}
}

// The fields a create or update sends (resource_params, domain_block_params), booleans cast as Rails casts them.
function blockRequest(p: Params): BlockRequest {
	return {
		severity: p.get('severity'),
		rejectMedia: parseBoolean(p.get('reject_media')),
		rejectReports: parseBoolean(p.get('reject_reports')),
		obfuscate: parseBoolean(p.get('obfuscate')),
		privateComment: p.get('private_comment'),
		publicComment: p.get('public_comment'),
	}
}

// GET /api/v1/admin/domain_blocks: newest first, limit 100 by default and at most 500 (LIMIT, MAX_LIMIT); Link next
// while a page is full (records_continue?) and prev whenever it has items, carrying only limit (PAGINATION_PARAMS).
export const domainBlocks: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const page = adminPage(p, DOMAIN_BLOCKS_LIMIT, MAX_DOMAIN_BLOCKS_LIMIT)
	const input = { credential: optionalCredential(c, deps), page }
	const blocks = authorized(await storeCall(c, deps, (s, b) => s.adminDomainBlocks(b, input)))
	const ids = blocks.map((block) => String(block.id))
	listLinks(c, (cursor) => listUrl(c, '/api/v1/admin/domain_blocks', ['limit'], p, cursor), {
		more: blocks.length === page.limit,
		newest: ids[0] ?? null,
		oldest: ids.at(-1) ?? null,
	})
	return c.json(await Promise.all(blocks.map(domainBlockEntity)))
}

// GET /api/v1/admin/domain_blocks/:id.
export const domainBlock: ApiHandler = async (c, deps) => {
	const input = { credential: optionalCredential(c, deps), id: c.req.param('id') ?? '' }
	return domainBlockResponse(authorized(await storeCall(c, deps, (s, b) => s.adminDomainBlock(b, input))), c)
}

// POST /api/v1/admin/domain_blocks: as a form (Fedilab) or JSON (Fediblockhole's add_block, __init__.py:627-649).
export const createDomainBlock: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const input = { credential: optionalCredential(c, deps), domain: p.get('domain'), ...blockRequest(p) }
	return domainBlockResponse(authorized(await storeCall(c, deps, (s, b) => s.createAdminDomainBlock(b, input))), c)
}

// PUT and PATCH /api/v1/admin/domain_blocks/:id. Fediblockhole's update_known_block sends the whole block, its domain
// included (__init__.py:606-624), which, as in Mastodon, does not change.
export const updateDomainBlock: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const input = { credential: optionalCredential(c, deps), id: c.req.param('id') ?? '', ...blockRequest(p) }
	return domainBlockResponse(authorized(await storeCall(c, deps, (s, b) => s.updateAdminDomainBlock(b, input))), c)
}

// DELETE /api/v1/admin/domain_blocks/:id: an empty object (render_empty).
export const deleteDomainBlock: ApiHandler = async (c, deps) => {
	const input = { credential: optionalCredential(c, deps), id: c.req.param('id') ?? '' }
	const result = authorized(await storeCall(c, deps, (s, b) => s.deleteAdminDomainBlock(b, input)))
	return domainBlockResponse(result, c, {})
}

// GET /api/v1/admin/domain_allows: no allow exists without limited federation mode, so the OAuth admin's list is
// empty (design §1). Its :id answers 404 and its create 403, to everyone (recordNotFound, notAllowed).
export const domainAllows: ApiHandler = async (c, deps) => {
	const input = { credential: optionalCredential(c, deps) }
	authorized(await storeCall(c, deps, (s, b) => s.adminFederationGranted(b, input)))
	return c.json([])
}

// ---- Metrics (Api::V1::Admin::{Measures,Dimensions,Retention}Controller; domain/admin-measures.ts), view_dashboard.

// POST /api/v1/admin/dimensions and /retention: no dimension key is served and no sign-in is recorded, so the OAuth
// admin gets `[]`, as Dimension.retrieve answers keys it does not know (dimension.rb:15-21).
export const emptyMetric: ApiHandler = async (c, deps) => {
	const input = { credential: optionalCredential(c, deps) }
	authorized(await storeCall(c, deps, (s, b) => s.adminDashboardGranted(b, input)))
	return c.json([])
}

// An ISO 8601 date, or date and time with an optional fraction and zone (none is UTC, as Ruby's DateTime.parse reads
// it), as a whole value.
const ISO_TIME =
	/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:(Z)|([+-])(\d{2}):?(\d{2}))?)?$/i

// A start_at or end_at as BaseMeasure reads it (`to_datetime`, base_measure.rb:14-16): blank is none; otherwise the
// calendar day written and the instant named (MeasureTime), the fraction kept to the nanosecond. Kopje reads ISO 8601
// values only, where Ruby's DateTime.parse reads more, and only within the days measurableTime accepts.
function measureTime(value: string | undefined): { at: MeasureTime | null } | 'invalid' {
	if (value === undefined || value.trim() === '') {
		return { at: null }
	}
	const match = ISO_TIME.exec(value.trim())
	if (match === null) {
		return 'invalid'
	}
	const [, year, month, day, hour = '0', minute = '0', second = '0', fraction = '', , sign, zh = '0', zm = '0'] = match
	const fields = [Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)] as const
	const check = new Date(0)
	check.setUTCFullYear(fields[0], fields[1], fields[2])
	check.setUTCHours(fields[3], fields[4], fields[5], 0)
	if (
		check.getUTCFullYear() !== fields[0] ||
		check.getUTCMonth() !== fields[1] ||
		check.getUTCDate() !== fields[2] ||
		check.getUTCHours() !== fields[3] ||
		check.getUTCMinutes() !== fields[4] ||
		check.getUTCSeconds() !== fields[5] ||
		Number(zh) > 23 ||
		Number(zm) > 59
	) {
		return 'invalid'
	}
	const offset = (sign === '-' ? -1 : 1) * (Number(zh) * 60 + Number(zm)) * 60_000
	const ns = BigInt(check.getTime() - offset) * 1_000_000n + BigInt(fraction.padEnd(9, '0'))
	const at = { date: dayNumber(`${year}-${month}-${day}`), ns }
	return measurableTime(at) ? { at } : 'invalid'
}

// Mastodon's measure keys (Admin::Metrics::Measure::MEASURES, measure.rb:4-19), each true when its class reads its
// own object (with_params?, so params.require(key) answers 400 without it).
const MEASURE_KEYS = new Map<string, boolean>([
	['active_users', false],
	['new_users', false],
	['interactions', false],
	['opened_reports', false],
	['resolved_reports', false],
	['tag_accounts', true],
	['tag_uses', true],
	['tag_servers', true],
	['instance_accounts', true],
	['instance_media_attachments', true],
	['instance_reports', true],
	['instance_statuses', true],
	['instance_follows', true],
	['instance_followers', true],
])

const SERVED: ReadonlySet<string> = new Set(SERVED_MEASURES)

// Measures one answer may hold, repeats included: each repeats the whole series (at most MEASURE_DAYS points), so
// the answer is at most MAX_MEASURE_KEYS times one measure. Keys left out (unknown) do not count. Mastodon has 14
// measure keys.
export const MAX_MEASURE_KEYS = 16

const TOO_MANY: Record<MeasureRows, string> = {
	accounts: `too many accounts to count (more than ${MEASURE_ROWS}); the total is not known`,
	reports: `too many reports to count (more than ${MEASURE_ROWS}); the total is not known`,
	follows: `too many follows to count (more than ${MEASURE_ROWS}); the total is not known`,
	domains: `too many domains to search (more than ${MEASURE_DOMAINS}); the total is not known`,
}

// A measure as REST::Admin::MeasureSerializer writes it (measure_serializer.rb:4-20): key, unit, total, human_value
// (instance_media_attachments only: number_to_human_size of its total, always 0), previous_total (in-range measures
// only) and data, numbers as strings. A data point's date is the axis' SQL date, which Rails writes as YYYY-MM-DD
// (query_helper.rb:6-8).
function presentMeasure(key: ServedMeasure, measure: MeasureValue) {
	const media = key === 'instance_media_attachments'
	return {
		key,
		unit: media ? 'bytes' : null,
		total: String(measure.total),
		...(media ? { human_value: '0 Bytes' } : {}),
		...(measure.previousTotal === null ? {} : { previous_total: String(measure.previousTotal) }),
		data: measure.data.map((point) => ({ date: point.date, value: String(point.value) })),
	}
}

// POST /api/v1/admin/measures (measures_controller.rb, Admin::Metrics::Measure.retrieve, measure.rb:21-26): one
// measure per known key in `keys`, in order, repeats included; unknown keys are left out (filter_map). As in Mastodon
// the body is read before the policy (set_measures), so to every caller after the optional token's check: in
// retrieve's order, a key that reads its object without one answers 400 (params.require) and, at the first known key,
// a date that is none 422 (Date::Error, error_handling.rb:15-17). Then, to the OAuth admin only:
// - a key Kopje does not serve (MD-2) answers 422, the whole request;
// - more than MAX_MEASURE_KEYS known keys answer 422;
// - an in-range key without both dates answers 422 (Mastodon's is a server error);
// - an axis past MEASURE_DAYS days answers 422;
// - each distinct key is computed once, in its own read (adminMeasure), and a walk past its cap or an unreadable
//   stored time answers 422.
// Fediblockhole sends instance_follows with no dates (fetch_instance_follows, __init__.py:529-567), so its data is
// empty, as generate_series of NULLs is.
export const measures: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const keys = p.getAll('keys').filter((key) => MEASURE_KEYS.has(key))
	const credential = optionalCredential(c, deps)
	const granted = async () => authorized(await storeCall(c, deps, (s, b) => s.adminDashboardGranted(b, { credential })))
	if (keys.length === 0) {
		await granted()
		return c.json([])
	}
	const start = measureTime(p.get('start_at'))
	const end = measureTime(p.get('end_at'))
	// retrieve's order: the first key's object, then the dates, then each later key's object.
	const missing = keys.findIndex((key) => MEASURE_KEYS.get(key) === true && !p.hasObject(key))
	if (missing === 0 || (missing > 0 && start !== 'invalid' && end !== 'invalid')) {
		await checkOptionalToken(c, deps)
		return mastodonError(400, `param is missing or the value is empty or invalid: ${keys[missing]}`)
	}
	if (start === 'invalid' || end === 'invalid') {
		await checkOptionalToken(c, deps)
		return mastodonError(422, 'Invalid date supplied')
	}
	await granted()
	const refused = keys.find((key) => !SERVED.has(key))
	if (refused !== undefined) {
		return mastodonError(422, `measure ${refused} is not served`)
	}
	if (keys.length > MAX_MEASURE_KEYS) {
		return mastodonError(422, `too many measure keys (at most ${MAX_MEASURE_KEYS})`)
	}
	const served = keys as ServedMeasure[]
	const undated = served.find((key) => IN_RANGE_MEASURES.has(key) && (start.at === null || end.at === null))
	if (undated !== undefined) {
		return mastodonError(422, `measure ${undated} needs start_at and end_at`)
	}
	const period = start.at === null || end.at === null ? null : measurePeriod(start.at, end.at)
	if (period === 'too_long') {
		return mastodonError(422, `date range too long (at most ${MEASURE_DAYS} days)`)
	}
	const values = new Map<ServedMeasure, MeasureValue>()
	for (const key of new Set(served)) {
		// A domain longer than any domain an account has (MAX_DOMAIN_INPUT) is not normalized: no account matches it.
		const domain = (p.get(`${key}[domain]`) ?? '').trim()
		const input = {
			credential,
			key,
			domain: domain === '' || domain.length > MAX_DOMAIN_INPUT ? null : blockedDomain(domain),
			includeSubdomains: parseBoolean(p.get(`${key}[include_subdomains]`)) ?? false,
			period,
		}
		const result = authorized(await storeCall(c, deps, (s, b) => s.adminMeasure(b, input)))
		switch (result.status) {
			case 'too_many':
				return mastodonError(422, TOO_MANY[result.rows])
			case 'unreadable':
				return mastodonError(422, `measure ${key}: stored times not readable; the total is not known`)
		}
		values.set(key, result.measure)
	}
	return c.json(served.map((key) => presentMeasure(key, values.get(key)!)))
}
