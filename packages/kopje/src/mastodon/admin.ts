import { type ApiContext, type ApiHandler, checkOptionalToken } from './context'
import { mastodonError } from './errors'

// The Mastodon admin API (/api/v1/admin/*, /api/v2/admin/*). Every route is Mastodon's authorize_if_got_token!: the
// token is optional, a token sent must be valid and cover the route's admin scope, and an app token is let through.
// Mastodon's Pundit policy then refuses any role without the route's permission bit, so anonymous callers, app tokens
// and users who are not staff are answered 403 "This action is not allowed".
//
// The handlers here are the routes Kopje does not serve (yet): they answer as Mastodon does for a role without the
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
