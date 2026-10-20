import { type Exception, type Exceptions, open } from './mastodon-conformance.js'

// The request parameters Mastodon reads and Kopje does not, by route (test/mastodon-params.test.ts). Each is a real
// gap: tracked by an issue (open) or a decided deviation of docs/mastodon-deviations.md (accepted). A harness
// limitation is fixed in the test's recipes or world, never written here.

const accepted = (deviation: `MD-${number}`, ...names: string[]): Record<string, Exception> =>
	Object.fromEntries(names.map((name) => [name, { status: 'accepted', deviation }]))

const PAGE = ['limit', 'max_id', 'min_id', 'since_id']

// Admin features Kopje does not serve (MD-2) and features not built yet (MD-3).
const NOT_SERVED = (...names: string[]) => accepted('MD-2', ...names)
const PLACEHOLDER = (...names: string[]) => accepted('MD-3', ...names)

export const PARAM_EXCEPTIONS: Exceptions = {
	'PATCH /api/v1/accounts/update_credentials': {
		...open('multipart files are dropped by params.ts; uploads work on the settings page only', 'avatar', 'header'),
		...open('not read or stored', 'indexable'),
	},
	'GET /api/v1/accounts/relationships': open('suspended accounts are always included', 'with_suspended'),
	'GET /api/v1/accounts/search': open('unknown remote accounts are not resolved', 'resolve'),
	'POST /api/v1/accounts': accepted(
		'MD-1',
		'agreement',
		'date_of_birth',
		'email',
		'invite_code',
		'locale',
		'password',
		'reason',
		'time_zone',
		'username'
	),
	'POST /api/v1/emails/confirmations': accepted('MD-1', 'email'),
	'POST /api/v1/statuses': open('ignored (Mastodon answers 422 with unexpected_accounts)', 'allowed_mentions[]'),
	'PUT /api/v1/statuses/:id': open('the thumbnail file is dropped', 'media_attributes[][thumbnail]'),
	'PATCH /api/v1/statuses/:id': open('the thumbnail file is dropped', 'media_attributes[][thumbnail]'),
	'POST /api/v1/media': open('the thumbnail file is dropped', 'thumbnail'),
	'POST /api/v2/media': open('the thumbnail file is dropped', 'thumbnail'),
	'PUT /api/v1/media/:id': open('the thumbnail file is dropped', 'thumbnail'),
	'PATCH /api/v1/media/:id': open('the thumbnail file is dropped', 'thumbnail'),
	'GET /api/v2/search': open('ignored', 'exclude_unreviewed'),
	'POST /api/v1/admin/accounts/:account_id/action': open(
		'no warning or notification reaches a local target',
		'send_email_notification',
		'text',
		'warning_preset_id'
	),
	'POST /api/v1/admin/measures': open(
		'only instance_follows is answered; the period is not read',
		'end_at',
		'start_at'
	),

	// Features not built yet: answered as Mastodon with the feature off.
	'GET /api/v1/admin/domain_allows': PLACEHOLDER(...PAGE),

	// Link trends and the link timeline are not implemented (MD-5).
	'GET /api/v1/trends/links': accepted('MD-5', 'limit', 'offset'),
	'GET /api/v1/timelines/link': accepted('MD-5', ...PAGE, 'local', 'remote', 'url'),
	'GET /api/v1/admin/trends/links': accepted('MD-5', 'limit', 'offset'),

	// Admin features not served.
	'POST /api/v1/admin/dimensions': NOT_SERVED('end_at', 'keys[]', 'limit', 'start_at'),
	'POST /api/v1/admin/retention': NOT_SERVED('end_at', 'frequency', 'start_at'),
	'POST /api/v1/admin/domain_allows': NOT_SERVED('domain'),
	'GET /api/v1/admin/ip_blocks': NOT_SERVED(...PAGE),
	'POST /api/v1/admin/ip_blocks': NOT_SERVED('comment', 'expires_in', 'ip', 'severity'),
	'PUT /api/v1/admin/ip_blocks/:id': NOT_SERVED('comment', 'expires_in', 'ip', 'severity'),
	'PATCH /api/v1/admin/ip_blocks/:id': NOT_SERVED('comment', 'expires_in', 'ip', 'severity'),
	'GET /api/v1/admin/email_domain_blocks': NOT_SERVED(...PAGE),
	'POST /api/v1/admin/email_domain_blocks': NOT_SERVED('allow_with_approval', 'domain'),
	'GET /api/v1/admin/canonical_email_blocks': NOT_SERVED(...PAGE),
	'POST /api/v1/admin/canonical_email_blocks': NOT_SERVED('canonical_email_hash', 'email'),
	'POST /api/v1/admin/canonical_email_blocks/test': NOT_SERVED('email'),
	'GET /api/v1/admin/trends/links/publishers': NOT_SERVED(...PAGE),
	'GET /api/v1/admin/tags': NOT_SERVED(...PAGE),
	'PUT /api/v1/admin/tags/:id': NOT_SERVED('display_name', 'listable', 'trendable', 'usable'),
	'PATCH /api/v1/admin/tags/:id': NOT_SERVED('display_name', 'listable', 'trendable', 'usable'),
}

// Routes whose fixture entry has unresolved extraction, with exactly the reasons acknowledged and why the names read
// suffice.
export const UNRESOLVED_PARAMS: Record<string, { reasons: string[]; why: string }> = {
	// Admin::Metrics::Measure / Dimension read per-key options (e.g. instance_accounts[domain]) from the params they are
	// handed; the keys Kopje answers read no option.
	'POST /api/v1/admin/measures': {
		reasons: ['app/controllers/api/v1/admin/measures_controller.rb set_measures: params used whole `params`'],
		why: 'per-key options of Admin::Metrics::Measure',
	},
	'POST /api/v1/admin/dimensions': {
		reasons: ['app/controllers/api/v1/admin/dimensions_controller.rb set_dimensions: params used whole `params`'],
		why: 'per-key options of Admin::Metrics::Dimension',
	},
}
