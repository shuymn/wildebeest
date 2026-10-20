import {
	type ApiContext,
	type ApiDeps,
	type ApiHandler,
	authorized,
	checkOptionalToken,
	credential,
	present,
	storeCall,
} from './context'
import { mastodonError } from './errors'
import { grantsAny } from '../security/scopes'

// Features Kopje has no data for (trends, annual reports, link timelines, translation, e-mail confirmation, async
// refreshes), answered as Mastodon answers when the feature has nothing to show or is not configured, because clients
// call them and a missing route can stop a client. Each is replaced when its feature arrives with its own tables. The
// writes act on records that never exist, so they change nothing.

const RECORD_NOT_FOUND = () => mastodonError(404, 'Record not found')
// Mastodon's not_found (ApplicationController#not_found, Api::BaseController#respond_with_error), as opposed to the
// "Record not found" of an ActiveRecord::RecordNotFound.
const NOT_FOUND = () => mastodonError(404, 'Not Found')

// The signed-in user's token, checked (validity, the route's scope if any, suspension) and bound to a user, as
// Mastodon's require_user! asks: a route without a scope accepts any user token.
async function signedIn(c: ApiContext, deps: ApiDeps): Promise<void> {
	const value = credential(c, deps)
	const viewer = authorized(await storeCall(c, deps, (s, b) => s.checkCredential(b, value)))
	if (viewer.accountId === null) {
		authorized({ status: 'user_required' })
	}
}

// The answer of a route that requires the signed-in user, given once the token passes.
const forUser =
	(answer: (c: ApiContext) => Response): ApiHandler =>
	async (c, deps) => {
		await signedIn(c, deps)
		return answer(c)
	}

// GET /api/v1/annual_reports: Api::V1::AnnualReportsController#index with no pending report
// (REST::AnnualReportsSerializer). Kopje makes no annual reports; neither does a stock Mastodon 4.5.11 unless its admin
// generates them by hand: AnnualReport#generate has no automatic trigger (GenerateAnnualReportWorker is enqueued by
// nothing but its spec), so these answers are a stock instance's.
export const annualReports = forUser((c) => c.json({ annual_reports: [], accounts: [], statuses: [] }))

// GET /api/v1/annual_reports/:id and POST /api/v1/annual_reports/:id/read: AnnualReportsController#set_annual_report
// raises RecordNotFound (find_by!) for a year without a report.
export const annualReport = forUser(RECORD_NOT_FOUND)

// GET /api/v1/timelines/link: Api::V1::Timelines::LinkController#set_preview_card raises RecordNotFound (find_by!) for
// a URL that is not a trending link, after authorize_if_got_token! (a token sent must be valid and cover
// read:statuses; an app token is let through). Kopje has no link trends. require_user! applies only when a topic feed
// is not public, which is Mastodon's default and Kopje's only setting.
export const linkTimeline: ApiHandler = async (c, deps) => {
	await checkOptionalToken(c, deps)
	return RECORD_NOT_FOUND()
}

// POST /api/v1/statuses/:id/translate: Api::V1::Statuses::TranslationsController rescues
// TranslationService::NotConfiguredError with not_found. Kopje has no translation service; a status the viewer cannot
// see is answered the same (Api::V1::Statuses::BaseController#set_status), so the status is not looked up.
export const translateStatus = forUser(NOT_FOUND)

// GET /api/v1_alpha/async_refreshes/:id: Api::V1Alpha::AsyncRefreshesController#show answers not_found when
// AsyncRefresh.find finds no refresh. Kopje starts none.
export const asyncRefresh = forUser(NOT_FOUND)

// POST /api/v1/emails/confirmations: Api::V1::Emails::ConfirmationsController#require_user_owned_by_application!
// refuses a token without a user, or one whose user did not sign up through the token's application. No Kopje user
// signed up through an application (registrations are closed), so every token with write:accounts is refused. Any
// token at the route: write:accounts is checked here, since the route takes app tokens.
export const resendConfirmation: ApiHandler = async (c, deps) => {
	const value = credential(c, deps)
	const viewer = authorized(await storeCall(c, deps, (s, b) => s.checkCredential(b, value)))
	if (!grantsAny(viewer.scopes, 'write:accounts')) {
		authorized({ status: 'insufficient_scope' })
	}
	return mastodonError(403, 'This method is only available to the application the user originally signed-up with')
}

// GET /api/v1/emails/check_confirmation: ConfirmationsController#check renders current_user.confirmed?. Kopje's users
// have no unconfirmed e-mail.
export const checkConfirmation = forUser((c) => c.json(true))

// A public list.
export const emptyList: ApiHandler = (c) => Promise.resolve(c.json([]))

// An empty list, for an account that exists.
const emptyAccountList: ApiHandler = async (c, deps) => {
	const id = c.req.param('id') ?? ''
	const account = await storeCall(c, deps, (s, b) => s.getAccount(b, { id, present: present(c) }))
	return account === null ? mastodonError(404, 'Record not found') : c.json([])
}

// GET /api/v1/accounts/:id/identity_proofs: [] for an account that exists, as Mastodon's deprecated
// Accounts::IdentityProofsController answers, to a user token (require_user!, no scope).
export const identityProofs: ApiHandler = async (c, deps) => {
	await signedIn(c, deps)
	return emptyAccountList(c, deps)
}
