import {
	type ApiContext,
	type ApiHandler,
	authorized,
	optionalCredential,
	present,
	refuseAfterAuth,
	requestParams,
	storeCall,
	userCredential,
} from './context'
import { mastodonError } from './errors'
import { descriptionProblem, parseFocus, sweepSoon } from './media'
import { linkHeader, pageQuery } from './pagination'
import { type Params, parseBoolean } from './params'
import { API_VISIBILITIES, type ApiVisibility } from '../domain/audience'
import { checkPoll, isPollInput, type PollInput } from '../domain/polls'
import { exceedsRawLength, statusLength } from '../domain/status-text'
import { type Acted, type MediaAttributes, TOO_MANY_FILES, type Viewed } from '../domain/statuses'
import { sha256Hex } from '../security/tokens'

// /api/v1/statuses (B4a): posting, editing, deleting, the per-status reads, and favourite, reblog and bookmark.
// Requests are checked here as Mastodon's controllers and validators do; the Store authorizes and decides.

const NOT_FOUND = () => mastodonError(404, 'Record not found')
const FORBIDDEN = () => mastodonError(403, 'This action is not allowed')
const REPLY_NOT_FOUND = () => mastodonError(404, 'The post you are trying to reply to does not appear to exist.')

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
// the media first (PostStatusService#validate_media!, which also refuses media with a poll), then the text, then the
// poll.
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
	const composed = composition(p)
	const visibility = emptyToUndefined(p.get('visibility'))
	const scheduledRaw = emptyToUndefined(p.get('scheduled_at'))
	const scheduledAt = scheduledRaw === undefined ? undefined : parseScheduledAt(scheduledRaw)
	const problem =
		typeof composed === 'string'
			? composed
			: scheduledAt === null
				? 'Record invalid'
				: visibility !== undefined && !API_VISIBILITIES.includes(visibility as ApiVisibility)
					? 'Validation failed: Visibility is not included in the list'
					: undefined
	if (typeof composed === 'string' || scheduledAt === null || problem !== undefined) {
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
		inReplyToId: emptyToUndefined(p.get('in_reply_to_id')),
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
		case 'invalid':
			return mastodonError(422, result.error)
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
	for (const a of p.objects('media_attributes')) {
		const focus = parseFocus(a.focus)
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
	const problem =
		typeof composed === 'string'
			? composed
			: mediaAttributes.map((a) => descriptionProblem(a.description)).find((found) => found !== undefined)
	if (typeof composed === 'string' || problem !== undefined) {
		return refuseAfterAuth(c, deps, mastodonError(422, problem ?? 'Validation failed'))
	}
	const credential = userCredential(c, deps)
	const result = await storeCall(c, deps, (s, b) =>
		s.editStatus(b, { credential, id: statusId(c), ...composed, mediaAttributes, now: deps.now(), present: present(c) })
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
	// delete_media doomed the status's media in the Store; its R2 objects are deleted after the response.
	if (deleteMedia && result.status === 'ok') {
		sweepSoon(c, deps)
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

type Action = 'favourite' | 'unfavourite' | 'bookmark' | 'unbookmark' | 'unreblog'

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
export const unreblog = action('unreblog')

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
		const link = linkHeader(c.req.url, { ...result.value, count: result.value.items.length }, page.limit)
		if (link !== undefined) {
			c.header('Link', link)
		}
		return c.json(result.value.items)
	}
}

export const favouritedBy = interactors('favourited_by')
export const rebloggedBy = interactors('reblogged_by')
