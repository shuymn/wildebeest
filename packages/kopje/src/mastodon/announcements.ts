import { type ApiHandler, authorized, credential, present, storeCall, userCredential } from './context'
import { mastodonError } from './errors'

// Announcements (domain/announcements.ts): Api::V1::AnnouncementsController and
// Api::V1::Announcements::ReactionsController. Each answers 404 "Record not found" for an announcement that is not
// published (Announcement.published.find), an id that is not one included.

const RECORD_NOT_FOUND = () => mastodonError(404, 'Record not found')

// GET /api/v1/announcements: any user token, whatever its scopes (require_user! with no scope); an app token answers
// 422. No parameter is read (with_dismissed is ignored, as Mastodon 4.5 ignores it).
export const listAnnouncements: ApiHandler = async (c, deps) => {
	const input = { credential: credential(c, deps), origin: present(c).origin }
	return c.json(authorized(await storeCall(c, deps, (s, b) => s.listAnnouncements(b, input))))
}

// POST /api/v1/announcements/:id/dismiss: {} once dismissed, again or not.
export const dismissAnnouncement: ApiHandler = async (c, deps) => {
	const input = { credential: userCredential(c, deps), id: c.req.param('id') ?? '' }
	const result = authorized(await storeCall(c, deps, (s, b) => s.dismissAnnouncement(b, input)))
	return result === 'ok' ? c.json({}) : RECORD_NOT_FOUND()
}

// PUT and PATCH /api/v1/announcements/:announcement_id/reactions/:id: the reaction named by the path's last segment,
// as decoded (Rails' params[:id]). A refused name answers 422 with Mastodon's messages, joined as full_messages are.
export const reactToAnnouncement: ApiHandler = async (c, deps) => {
	const input = {
		credential: userCredential(c, deps),
		id: c.req.param('announcement_id') ?? '',
		name: c.req.param('id') ?? '',
	}
	const result = authorized(await storeCall(c, deps, (s, b) => s.reactToAnnouncement(b, input)))
	if (result === 'ok') {
		return c.json({})
	}
	if (result === 'not-found') {
		return RECORD_NOT_FOUND()
	}
	return mastodonError(
		422,
		result === 'duplicate' ? 'Duplicate record' : `Validation failed: ${result.errors.join(', ')}`
	)
}

// DELETE /api/v1/announcements/:announcement_id/reactions/:id: 404 unless the account reacted with that name.
export const unreactToAnnouncement: ApiHandler = async (c, deps) => {
	const input = {
		credential: userCredential(c, deps),
		id: c.req.param('announcement_id') ?? '',
		name: c.req.param('id') ?? '',
	}
	const result = authorized(await storeCall(c, deps, (s, b) => s.unreactToAnnouncement(b, input)))
	return result === 'ok' ? c.json({}) : RECORD_NOT_FOUND()
}
