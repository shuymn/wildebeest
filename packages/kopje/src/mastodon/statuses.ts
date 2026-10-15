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
import { exceedsRawLength, statusLength } from '../domain/status-text'
import type { Acted, MediaAttributes, Viewed } from '../domain/statuses'
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
}

// What POST and PUT share: text, spoiler, sensitive, language and media, with Mastodon's request validation.
function composition(p: Params): Composition | string {
	if (p.has('poll[options]') || p.get('poll[expires_in]') !== undefined) {
		return 'Polls are not supported'
	}
	const text = p.get('status') ?? ''
	const spoilerText = p.get('spoiler_text') ?? ''
	const mediaIds = p.getAll('media_ids').filter((id) => id !== '')
	if (mediaIds.length > MAX_MEDIA_ATTACHMENTS) {
		return `Cannot attach more than ${MAX_MEDIA_ATTACHMENTS} files`
	}
	// The raw bound comes first, so over-long input is refused before it is parsed.
	if (exceedsRawLength(text, spoilerText) || statusLength(text, spoilerText) > MAX_CHARACTERS) {
		return TOO_LONG
	}
	const language = p.get('language')
	return {
		text,
		spoilerText,
		sensitive: parseBoolean(p.get('sensitive')),
		language: language !== undefined && LANGUAGE.test(language) ? language : undefined,
		mediaIds,
	}
}

// scheduled_at as PostStatusService reads it (String#to_datetime): an ISO 8601 date, or date and time, with an
// optional offset (none is UTC). The ISO 8601 UTC time with milliseconds the Store keeps, or null when it is not one
// (Mastodon answers ActiveRecord::RecordInvalid's "Record invalid").
const SCHEDULED_AT =
	/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i

export function parseScheduledAt(raw: string): string | null {
	// The raw bound comes first (RES-1).
	const match = raw.length > 64 ? null : SCHEDULED_AT.exec(raw.trim())
	if (match === null) {
		return null
	}
	const [, date = '', time, seconds = '00', fraction = '', zone] = match
	const offset =
		zone === undefined || zone.toUpperCase() === 'Z'
			? 'Z'
			: `${zone.slice(0, 3)}:${zone.slice(3).replace(':', '') || '00'}`
	const ms = fraction.padEnd(3, '0').slice(0, 3)
	const at = Date.parse(`${date}T${time ?? '00:00'}:${seconds}.${ms}${offset}`)
	if (Number.isNaN(at)) {
		return null
	}
	const iso = new Date(at).toISOString()
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
	// With scheduled_at the answer is a ScheduledStatus, or a Status when the time is not in the future
	// (domain/scheduled-statuses.ts).
	const result = authorized(
		await storeCall(c, deps, (s, b) =>
			scheduledAt === undefined ? s.createStatus(b, input) : s.scheduleStatus(b, { ...input, scheduledAt })
		)
	)
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
