import {
	type ApiContext,
	type ApiHandler,
	authorized,
	optionalCredential,
	present,
	refuseAfterAuth,
	requestJobsSoon,
	requestParams,
	storeCall,
	userCredential,
} from './context'
import { mastodonError } from './errors'
import { descriptionProblem, parseFocus, sweepSoon, THUMBNAIL_MUST_BE_BLANK, thumbnailSent } from './media'
import { pageQuery, pageResponse } from './pagination'
import { type Params, parseBoolean } from './params'
import { API_VISIBILITIES, type ApiVisibility, QUOTE_POLICY_NAMES, type QuotePolicyName } from '../domain/audience'
import { checkPoll, isPollInput, type PollInput } from '../domain/polls'
import { exceedsRawLength, statusLength } from '../domain/status-text'
import {
	type Acted,
	MAX_STATUSES_BY_ID,
	type MediaAttributes,
	TOO_MANY_FILES,
	UNEXPECTED_MENTIONS,
	type Viewed,
} from '../domain/statuses'
import { sha256Hex } from '../security/tokens'

// /api/v1/statuses: posting, editing, deleting, the per-status reads, favourite, reblog and bookmark, pins and
// conversation mutes.
// Requests are checked here as Mastodon's controllers and validators do; the Store authorizes and decides.

const NOT_FOUND = () => mastodonError(404, 'Record not found')
const FORBIDDEN = () => mastodonError(403, 'This action is not allowed')
const REPLY_NOT_FOUND = () => mastodonError(404, 'The post you are trying to reply to does not appear to exist.')
// StatusesController#set_quoted_status: any failure, a status R36 refuses included.
const QUOTE_NOT_FOUND = () => mastodonError(404, 'The post you are trying to quote does not appear to exist.')

export const MAX_CHARACTERS = 500
export const MAX_MEDIA_ATTACHMENTS = 4
const TOO_LONG = `Validation failed: Text character limit of ${MAX_CHARACTERS} exceeded`

// ISO 639 codes, optionally with a region or script (zh-TW, zh-Hant). Anything else is ignored, as Mastodon does.
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/

function emptyToUndefined(value: string | undefined): string | undefined {
	return value === '' ? undefined : value
}

function statusId(c: ApiContext): string {
	return c.req.param('id') ?? ''
}

function viewedResponse<T>(c: ApiContext, result: Viewed<T> | Acted<T>): Response {
	switch (result.status) {
		case 'ok':
			return c.json(result.value as object)
		case 'not_found':
			return NOT_FOUND()
		case 'forbidden':
			return FORBIDDEN()
		case 'invalid':
			return mastodonError(422, result.error)
	}
}

// quote_approval_policy as Api::InteractionPoliciesConcern reads it: public, followers or nobody; absent or blank is
// none (the author's default on posting, the status's own policy on an edit); anything else is null, which Mastodon
// answers with ActiveRecord::RecordInvalid's "Record invalid".
function quotePolicyOf(p: Params): QuotePolicyName | null | undefined {
	const raw = emptyToUndefined(p.get('quote_approval_policy'))
	return raw === undefined
		? undefined
		: QUOTE_POLICY_NAMES.includes(raw as QuotePolicyName)
			? (raw as QuotePolicyName)
			: null
}

type Composition = {
	text: string
	spoilerText: string
	sensitive?: boolean
	language?: string
	mediaIds: string[]
	poll?: PollInput
}

// At most this many choices are read from a request (RES-1); more than MAX_OPTIONS is refused either way.
const MAX_POLL_OPTIONS_READ = 100

// The poll of a request (poll[options][], poll[expires_in], poll[multiple], poll[hide_totals]), as Mastodon's status
// params permit it: present when any of its fields was sent (an empty object is none), checked as Poll validates it.
function pollOf(p: Params): PollInput | string | undefined {
	if (!p.hasObject('poll')) {
		return undefined
	}
	const checked = checkPoll({
		options: p.getAll('poll[options]').slice(0, MAX_POLL_OPTIONS_READ + 1),
		expiresIn: p.get('poll[expires_in]'),
		multiple: parseBoolean(p.get('poll[multiple]')),
		hideTotals: parseBoolean(p.get('poll[hide_totals]')),
	})
	return isPollInput(checked) ? checked : checked.error
}

// What POST and PUT share: text, spoiler, sensitive, language, media and a poll, with Mastodon's request validation:
// the number of media first (PostStatusService#validate_media!'s too_many, which also refuses media with a poll), then
// the text, then the poll. Which ids are usable is the Store's (statuses.ts mediaToAttach), checked after these. An
// empty entry is no id, so JSON `media_ids: []` (which the parser reads as one empty entry) removes an edit's media.
function composition(p: Params): Composition | string {
	const text = p.get('status') ?? ''
	const spoilerText = p.get('spoiler_text') ?? ''
	const mediaIds = p.getAll('media_ids').filter((id) => id !== '')
	const sendsPoll = p.hasObject('poll')
	if (mediaIds.length > MAX_MEDIA_ATTACHMENTS || (mediaIds.length > 0 && sendsPoll)) {
		return TOO_MANY_FILES
	}
	// The raw bound comes first, so over-long input is refused before it is parsed.
	if (exceedsRawLength(text, spoilerText) || statusLength(text, spoilerText) > MAX_CHARACTERS) {
		return TOO_LONG
	}
	const poll = pollOf(p)
	if (typeof poll === 'string') {
		return poll
	}
	const language = p.get('language')
	return {
		text,
		spoilerText,
		sensitive: parseBoolean(p.get('sensitive')),
		language: language !== undefined && LANGUAGE.test(language) ? language : undefined,
		mediaIds,
		...(poll === undefined ? {} : { poll }),
	}
}

// scheduled_at as PostStatusService reads it (String#to_datetime): an ISO 8601 date, or date and time, with an
// optional offset (none is UTC). The ISO 8601 UTC time with milliseconds the Store keeps, or null when it is not one
// (Mastodon answers ActiveRecord::RecordInvalid's "Record invalid").
const SCHEDULED_AT =
	/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i

function daysIn(year: number, month: number): number {
	return month === 2
		? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
			? 29
			: 28
		: [4, 6, 9, 11].includes(month)
			? 30
			: 31
}

export function parseScheduledAt(raw: string): string | null {
	// The raw bound comes first (RES-1).
	const match = raw.length > 64 ? null : SCHEDULED_AT.exec(raw.trim())
	if (match === null) {
		return null
	}
	const [, date = '', time = '00:00', seconds = '00', fraction = '', zone] = match
	const [year = 0, month = 0, day = 0] = date.split('-').map(Number)
	const [hour = 0, minute = 0] = time.split(':').map(Number)
	// As Ruby's DateTime.parse: the calendar date must exist, 24:00:00 is the next day's midnight, second 60 reads as
	// 59, and anything else out of range is invalid. Checked before the offset applies, so no invalid date rolls over.
	const midnight = hour === 24 && minute === 0 && Number(seconds) === 0 && Number(fraction || '0') === 0
	if (
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > daysIn(year, month) ||
		(hour > 23 && !midnight) ||
		minute > 59 ||
		Number(seconds) > 60
	) {
		return null
	}
	const offset =
		zone === undefined || zone.toUpperCase() === 'Z'
			? 'Z'
			: `${zone.slice(0, 3)}:${zone.slice(3).replace(':', '') || '00'}`
	const ms = fraction.padEnd(3, '0').slice(0, 3)
	const clock = midnight ? '00:00:00' : `${time}:${seconds === '60' ? '59' : seconds}`
	const at = Date.parse(`${date}T${clock}.${ms}${offset}`)
	if (Number.isNaN(at)) {
		return null
	}
	const iso = new Date(at + (midnight ? 24 * 60 * 60 * 1000 : 0)).toISOString()
	return /^\d{4}-/.test(iso) ? iso : null
}

export const createStatus: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	// Mastodon's 404 precedence over 422, including R36 refusals and scheduled quotes: domain/statuses.ts postTargets.
	const inReplyToId = emptyToUndefined(p.get('in_reply_to_id'))
	const quotedStatusId = emptyToUndefined(p.get('quoted_status_id'))
	if (quotedStatusId !== undefined) {
		const credential = userCredential(c, deps)
		const found = authorized(
			await storeCall(c, deps, (s, b) => s.postTargets(b, { credential, inReplyToId, quotedStatusId }))
		)
		if (found !== 'ok') {
			return found === 'reply_not_found' ? REPLY_NOT_FOUND() : QUOTE_NOT_FOUND()
		}
	}
	const composed = composition(p)
	const visibility = emptyToUndefined(p.get('visibility'))
	const scheduledRaw = emptyToUndefined(p.get('scheduled_at'))
	const scheduledAt = scheduledRaw === undefined ? undefined : parseScheduledAt(scheduledRaw)
	// The controller resolves the quote policy before PostStatusService validates anything else.
	const quotePolicy = quotePolicyOf(p)
	const problem =
		quotePolicy === null
			? 'Record invalid'
			: typeof composed === 'string'
				? composed
				: scheduledAt === null
					? 'Record invalid'
					: visibility !== undefined && !API_VISIBILITIES.includes(visibility as ApiVisibility)
						? 'Validation failed: Visibility is not included in the list'
						: undefined
	if (typeof composed === 'string' || scheduledAt === null || quotePolicy === null || problem !== undefined) {
		return refuseAfterAuth(c, deps, mastodonError(422, problem ?? 'Validation failed'))
	}
	// The key is stored as the sha256 of all of it, so keys of any length stay distinct (never truncated). It is
	// unique per account (statuses_client_key), and among the account's scheduled statuses.
	const key = emptyToUndefined(c.req.header('idempotency-key')?.trim())
	const idempotencyKey = key === undefined ? undefined : await sha256Hex(key)
	const credential = userCredential(c, deps)
	const input = {
		credential,
		...composed,
		visibility: visibility as ApiVisibility | undefined,
		inReplyToId,
		quotedStatusId,
		quotePolicy,
		// Strong params permit allowed_mentions as an array only: a scalar is dropped (Params#list).
		allowedMentions: p.list('allowed_mentions'),
		idempotencyKey,
		objectId: crypto.randomUUID(),
		now: deps.now(),
		present: present(c),
	}
	// The key is resolved against statuses and scheduled statuses alike; with scheduled_at the answer is a
	// ScheduledStatus, or a Status when the time is not in the future (domain/scheduled-statuses.ts).
	const result = authorized(await storeCall(c, deps, (s, b) => s.postStatus(b, { ...input, scheduledAt })))
	switch (result.status) {
		case 'ok':
		case 'scheduled':
			return c.json(result.value)
		case 'reply_not_found':
			return REPLY_NOT_FOUND()
		case 'quote_not_found':
			return QUOTE_NOT_FOUND()
		case 'invalid':
			return mastodonError(422, result.error)
		case 'unexpected_mentions':
			// StatusesController#create rescues UnexpectedMentionsError with the accounts (REST::AccountSerializer).
			return c.json({ error: UNEXPECTED_MENTIONS, unexpected_accounts: result.accounts }, 422)
	}
}

export const editStatus: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const composed = composition(p)
	// UpdateStatusService applies description and focus of each entry; an entry with neither changes nothing. Entries
	// for the same attachment collapse to one, the later value of each field winning, before anything is compared.
	const merged = new Map<string, MediaAttributes>()
	// A thumbnail on an entry with an id is refused, as MediaAttachment refuses it on an image (media.ts thumbnailSent).
	let thumbnail = false
	for (const a of p.objects('media_attributes', { files: ['thumbnail'] })) {
		const focus = parseFocus(a.focus)
		thumbnail ||= a.id !== undefined && thumbnailSent(a.thumbnail)
		if (a.id === undefined || (a.description === undefined && focus === undefined)) {
			continue
		}
		const previous = merged.get(a.id)
		merged.set(a.id, {
			id: a.id,
			description: a.description ?? previous?.description,
			focus: focus ?? previous?.focus,
		})
	}
	const mediaAttributes = [...merged.values()]
	// Mastodon 4.5.5 (#37436) takes quote_approval_policy on an edit only when it is sent.
	const quotePolicy = quotePolicyOf(p)
	const problem =
		quotePolicy === null
			? 'Record invalid'
			: typeof composed === 'string'
				? composed
				: (mediaAttributes.map((a) => descriptionProblem(a.description)).find((found) => found !== undefined) ??
					(thumbnail ? THUMBNAIL_MUST_BE_BLANK : undefined))
	if (typeof composed === 'string' || quotePolicy === null || problem !== undefined) {
		return refuseAfterAuth(c, deps, mastodonError(422, problem ?? 'Validation failed'))
	}
	const credential = userCredential(c, deps)
	const result = await storeCall(c, deps, (s, b) =>
		s.editStatus(b, {
			credential,
			id: statusId(c),
			...composed,
			mediaAttributes,
			quotePolicy,
			now: deps.now(),
			present: present(c),
		})
	)
	return viewedResponse(c, authorized(result))
}

// PUT and PATCH /api/v1/statuses/:id/interaction_policy (Statuses::InteractionPoliciesController#update). The policy
// is checked in the Store, after the status is found (404) and found the viewer's own (403), as Mastodon checks it.
export const updateInteractionPolicy: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const quotePolicy = quotePolicyOf(p)
	const credential = userCredential(c, deps)
	const result = await storeCall(c, deps, (s, b) =>
		s.updateInteractionPolicy(b, {
			credential,
			id: statusId(c),
			quotePolicy: quotePolicy === null ? 'invalid' : quotePolicy,
			present: present(c),
		})
	)
	return viewedResponse(c, authorized(result))
}

export const deleteStatus: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const credential = userCredential(c, deps)
	const deleteMedia = parseBoolean(p.get('delete_media')) ?? false
	const result = authorized(
		await storeCall(c, deps, (s, b) =>
			s.deleteStatus(b, { credential, id: statusId(c), deleteMedia, now: deps.now(), present: present(c) })
		)
	)
	// delete_media doomed the status's media in the Store; its R2 objects are deleted after the response. The rest of
	// an original's removal is its job's, whose round is asked for (the cron runs one regardless).
	if (deleteMedia && result.status === 'ok') {
		sweepSoon(c, deps)
	}
	if (result.status === 'ok' && result.jobsPending) {
		requestJobsSoon(c, deps)
	}
	return viewedResponse(c, result)
}

export const getStatus: ApiHandler = async (c, deps) => {
	const credential = optionalCredential(c, deps)
	const result = await storeCall(c, deps, (s, b) =>
		s.getStatus(b, { credential, id: statusId(c), now: deps.now(), present: present(c) })
	)
	return viewedResponse(c, authorized(result))
}

// GET /api/v1/statuses?id[]= (StatusesController#index): the statuses getStatus would show, in one read. More than
// MAX_STATUSES_BY_ID distinct ids raise Mastodon::ValidationError, which answers 422 with the class's name.
export const getStatuses: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const ids = [...new Set(p.getAll('id'))]
	if (ids.length > MAX_STATUSES_BY_ID) {
		return refuseAfterAuth(c, deps, mastodonError(422, 'Mastodon::ValidationError'))
	}
	const credential = optionalCredential(c, deps)
	const result = await storeCall(c, deps, (s, b) =>
		s.getStatuses(b, { credential, ids, now: deps.now(), present: present(c) })
	)
	return c.json(authorized(result))
}

export const statusContext: ApiHandler = async (c, deps) => {
	const credential = optionalCredential(c, deps)
	const result = await storeCall(c, deps, (s, b) =>
		s.statusContext(b, { credential, id: statusId(c), now: deps.now(), present: present(c) })
	)
	return viewedResponse(c, authorized(result))
}

export const statusHistory: ApiHandler = async (c, deps) => {
	const credential = optionalCredential(c, deps)
	const result = await storeCall(c, deps, (s, b) =>
		s.statusHistory(b, { credential, id: statusId(c), now: deps.now(), present: present(c) })
	)
	return viewedResponse(c, authorized(result))
}

export const statusSource: ApiHandler = async (c, deps) => {
	const credential = userCredential(c, deps)
	const result = await storeCall(c, deps, (s, b) => s.statusSource(b, { credential, id: statusId(c) }))
	return viewedResponse(c, authorized(result))
}

type Action =
	'favourite' | 'unfavourite' | 'bookmark' | 'unbookmark' | 'pin' | 'unpin' | 'muteConversation' | 'unmuteConversation'

function action(name: Action): ApiHandler {
	return async (c, deps) => {
		const input = { credential: userCredential(c, deps), id: statusId(c), now: deps.now(), present: present(c) }
		const result = await storeCall(c, deps, (s, b) => s[name](b, input))
		return viewedResponse(c, authorized(result))
	}
}

export const favourite = action('favourite')
export const unfavourite = action('unfavourite')
export const bookmark = action('bookmark')
export const unbookmark = action('unbookmark')
// An unboost's Undo and the boost's removal are its job's, whose round is asked for (the cron runs one regardless).
export const unreblog: ApiHandler = async (c, deps) => {
	const input = { credential: userCredential(c, deps), id: statusId(c), now: deps.now(), present: present(c) }
	const result = authorized(await storeCall(c, deps, (s, b) => s.unreblog(b, input)))
	if (result.status === 'ok' && result.jobsPending) {
		requestJobsSoon(c, deps)
	}
	return viewedResponse(c, result)
}
// Pins (Statuses::PinsController) and conversation mutes (Statuses::MutesController).
export const pin = action('pin')
export const unpin = action('unpin')
export const muteConversation = action('muteConversation')
export const unmuteConversation = action('unmuteConversation')

export const reblog: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const requested = p.get('visibility')
	const visibility = API_VISIBILITIES.includes(requested as ApiVisibility) ? (requested as ApiVisibility) : undefined
	const credential = userCredential(c, deps)
	const result = await storeCall(c, deps, (s, b) =>
		s.reblog(b, {
			credential,
			id: statusId(c),
			visibility,
			objectId: crypto.randomUUID(),
			now: deps.now(),
			present: present(c),
		})
	)
	return viewedResponse(c, authorized(result))
}

function interactors(kind: 'favourited_by' | 'reblogged_by'): ApiHandler {
	return async (c, deps) => {
		const p = await requestParams(c, deps)
		if (p instanceof Response) {
			return p
		}
		const page = pageQuery(p)
		const credential = optionalCredential(c, deps)
		const result = authorized(
			await storeCall(c, deps, (s, b) =>
				s.interactors(b, { credential, id: statusId(c), kind, page, now: deps.now(), present: present(c) })
			)
		)
		if (result.status !== 'ok') {
			return NOT_FOUND()
		}
		return pageResponse(c, result.value, page.limit)
	}
}

// GET /api/v1/statuses/:id/quotes (Statuses::QuotesController#index): a token with read:statuses, an app token read as
// anonymous (Mastodon requires no user here); limit 20 by default, at most 40. The Link
// header's bounds are the page's window (statusQuotes), so next is offered whenever the window was full, also for a
// page the rule emptied.
export const statusQuotes: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const page = pageQuery(p, 20, 40)
	const credential = optionalCredential(c, deps)
	const result = authorized(
		await storeCall(c, deps, (s, b) =>
			s.statusQuotes(b, { credential, id: statusId(c), page, now: deps.now(), present: present(c) })
		)
	)
	if (result.status !== 'ok') {
		return viewedResponse(c, result)
	}
	return pageResponse(c, result.value, page.limit, result.value.candidates)
}

// Prepare-and-record rounds one revoke takes at most: another round only when the quote was accepted again between
// its preparation and its recording (a QuoteRequest answered meanwhile), which a client cannot cause in a loop.
const REVOKE_ROUNDS = 3

// POST /api/v1/statuses/:id/quotes/:quoting_status_id/revoke (QuotesController#revoke). The stamp Delete is LD-signed
// here, once, with the author's key, before the Store records it with the revoke in one transaction, which first
// checks the quote still holds the authorization signed for (statuses.ts revokeQuote).
export const revokeQuote: ApiHandler = async (c, deps) => {
	const credential = userCredential(c, deps)
	const target = { id: statusId(c), quotingId: c.req.param('quoting_status_id') ?? '' }
	for (let round = 0; round < REVOKE_ROUNDS; round++) {
		const prepared = authorized(await storeCall(c, deps, (s, b) => s.prepareRevoke(b, { credential, ...target })))
		if (prepared.status !== 'ok') {
			return viewedResponse(c, prepared)
		}
		const { authorization, sign } = prepared.value
		if (sign !== null && deps.signAsAuthor === undefined) {
			return mastodonError(503, 'Revocations cannot be signed here')
		}
		const signed = sign === null ? null : await deps.signAsAuthor!(c.env, sign)
		const result = authorized(
			await storeCall(c, deps, (s, b) =>
				s.revokeQuote(b, {
					credential,
					...target,
					expected: authorization,
					signed,
					now: deps.now(),
					present: present(c),
				})
			)
		)
		if (result.status !== 'stale') {
			return viewedResponse(c, result)
		}
	}
	return mastodonError(503, 'The quote changed while it was being revoked; try again')
}

export const favouritedBy = interactors('favourited_by')
export const rebloggedBy = interactors('reblogged_by')
