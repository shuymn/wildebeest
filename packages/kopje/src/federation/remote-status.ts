import type { DocumentLoader } from '@fedify/fedify'

import { asArray, isObject, typeIs } from './json-shapes'
import { isTransientLoadError } from './loader'
import { emojiCandidates } from './remote-emoji'
import { isPublicCollection } from '../domain/audience'
import { isConversationId } from '../domain/conversation-rows'
import { languageOf } from '../domain/language'
import { MAX_REMOTE_OPTION_LENGTH, MAX_REMOTE_OPTIONS, type RemotePollInput } from '../domain/polls'
import {
	MAX_SPOILER_LENGTH,
	MAX_STATUS_AUDIENCE,
	MAX_STATUS_MEDIA,
	MAX_STATUS_MENTION_TAGS,
	MAX_STATUS_TAGS,
	MAX_TAG_LENGTH,
	type RemoteMediaInput,
	type RemoteQuoteInput,
	type RemoteQuotePolicyInput,
	type RemoteStatusInput,
} from '../domain/remote-statuses'
import { MAX_URL_LENGTH } from '../domain/status-text'
import { hashtagObjectName } from '../domain/tag-name'
import { httpUrl } from '../platform/http-url'
import { STATUS_URI_LIMIT, withinIdentityBound } from '../platform/identity-bounds'
import { withinJsonBounds } from '../platform/json-bounds'
import { storedMediaDescription, storedMediaLink, storedText } from '../platform/stored-bounds'
import { cutCodeUnits, cutJsonString, remoteHtmlText, sanitizeRemoteContent, SPOILER_BYTES } from '../security/html'

// Remote statuses as Mastodon 4.5.11 reads them (ActivityPub::Parser::StatusParser and MediaAttachmentParser):
// compacted JSON with the ActivityStreams context, values as strings, objects with an id, or arrays of either. Note and
// Question are statuses; Article, Page, Image, Audio, Video and Event are converted as Mastodon converts them (the name
// as a heading, the summary, and a link to the url, with no content warning). Everything is bounded (RES-2, RES-4) and
// sanitized (HTML-1); URLs are http(s) only (HTML-3). Quotes are read from quote, _misskey_quote, quoteUrl and quoteUri
// (quoteOf); Misskey's other extensions (_misskey_content, _misskey_summary) and everything else not read here stay in
// raw.

type Json = Record<string, unknown>

export const STATUS_TYPES = ['Note', 'Question']
export const CONVERTED_TYPES = ['Image', 'Audio', 'Video', 'Article', 'Page', 'Event']
export const ACTOR_TYPES = ['Application', 'Group', 'Organization', 'Person', 'Service']

export function idOf(value: unknown): string | null {
	if (typeof value === 'string') {
		return value
	}
	return isObject(value) && typeof value.id === 'string' ? value.id : null
}

function text(value: unknown): string | null {
	return typeof value === 'string' && value !== '' ? value : null
}

// A natural-language value: the plain property, or the first entry of its language map.
function languageString(object: Json, key: string): string | null {
	const plain = text(object[key])
	if (plain !== null) {
		return plain
	}
	const map = object[`${key}Map`]
	return isObject(map) ? text(Object.values(map)[0]) : null
}

function httpString(value: string | null): string | null {
	return value === null || value.length > MAX_URL_LENGTH ? null : (httpUrl(value)?.href ?? null)
}

// JsonLdHelper#url_to_href: a string, a Link (its href), or an array of them, preferring the given media type.
function urlOf(value: unknown, mediaType?: string): string | null {
	const links = asArray(value)
	const preferred =
		mediaType === undefined
			? undefined
			: links.find((link) => isObject(link) && link.mediaType === mediaType && typeof link.href === 'string')
	const link = preferred ?? links[0]
	const href = typeof link === 'string' ? link : isObject(link) && typeof link.href === 'string' ? link.href : null
	return httpString(href)
}

function timeOf(value: unknown): string | null {
	return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

// Mastodon's addressing (StatusParser#audience_to/cc): the object's, else the activity's. Public is always kept, so
// cutting a long list never changes the visibility.
function audience(object: Json, key: 'to' | 'cc', activity: Json | null): string[] {
	const listed = asArray(object[key] ?? activity?.[key]).flatMap((value) => idOf(value) ?? [])
	const unique = [...new Set(listed)]
	return [...unique.filter(isPublicCollection), ...unique.filter((uri) => !isPublicCollection(uri))].slice(
		0,
		MAX_STATUS_AUDIENCE
	)
}

// Tag names Mastodon would accept (Tag::HASHTAG_NAME_RE): letters, marks, digits, _ and the separators it allows,
// with at least one non-digit.
const TAG_NAME = /^[\p{L}\p{M}\p{Nd}_·・‌]+$/u

function hashtag(name: unknown): string | null {
	if (typeof name !== 'string') {
		return null
	}
	const normalized = hashtagObjectName(name)
	return normalized.length <= MAX_TAG_LENGTH && TAG_NAME.test(normalized) && !/^[\p{Nd}_]+$/u.test(normalized)
		? normalized
		: null
}

function mediaType(type: unknown, mime: unknown): RemoteMediaInput['type'] {
	const essence = typeof mime === 'string' ? (mime.split(';')[0] ?? '').trim().toLowerCase() : ''
	const top = essence.split('/')[0]
	if (top === 'image') {
		return 'image'
	}
	if (top === 'video') {
		return 'video'
	}
	if (top === 'audio') {
		return 'audio'
	}
	if (essence === '') {
		if (typeIs(type, ['Image'])) {
			return 'image'
		}
		if (typeIs(type, ['Video'])) {
			return 'video'
		}
		if (typeIs(type, ['Audio'])) {
			return 'audio'
		}
	}
	return 'unknown'
}

function dimension(value: unknown): number | null {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 100_000 ? value : null
}

function focusOf(value: unknown): { x: number; y: number } | null {
	if (!Array.isArray(value) || value.length !== 2) {
		return null
	}
	const [x, y] = value as unknown[]
	const valid = (n: unknown): n is number => typeof n === 'number' && n >= -1 && n <= 1
	return valid(x) && valid(y) ? { x, y } : null
}

// Create#process_attachments: links (an href) are preview cards, not media; at most MAX_STATUS_MEDIA with a usable url.
function mediaOf(object: Json): RemoteMediaInput[] {
	const media: RemoteMediaInput[] = []
	for (const attachment of asArray(object.attachment)) {
		if (media.length >= MAX_STATUS_MEDIA) {
			break
		}
		if (!isObject(attachment) || attachment.href !== undefined) {
			continue
		}
		const url = storedMediaLink(urlOf(attachment.url))
		if (url === null) {
			continue
		}
		const icon = attachment.icon
		const description = (languageString(attachment, 'summary') ?? languageString(attachment, 'name') ?? '').trim()
		media.push({
			type: mediaType(attachment.type, attachment.mediaType),
			url,
			previewUrl: storedMediaLink(
				httpString(typeof icon === 'string' ? icon : isObject(icon) ? (text(icon.url) ?? null) : null)
			),
			description: storedMediaDescription(description),
			focus: focusOf(attachment.focalPoint),
			width: dimension(attachment.width),
			height: dimension(attachment.height),
		})
	}
	return media
}

function tagsOf(object: Json): { mentions: string[]; tags: string[] } {
	const mentions = new Set<string>()
	const tags = new Set<string>()
	for (const tag of asArray(object.tag)) {
		if (!isObject(tag)) {
			continue
		}
		if (typeIs(tag.type, ['Hashtag']) && tags.size < MAX_STATUS_TAGS) {
			const name = hashtag(tag.name)
			if (name !== null) {
				tags.add(name)
			}
		} else if (typeIs(tag.type, ['Mention']) && mentions.size < MAX_STATUS_MENTION_TAGS) {
			const href = typeof tag.href === 'string' ? tag.href : null
			if (href !== null && href.length <= MAX_URL_LENGTH) {
				mentions.add(href)
			}
		}
	}
	return { mentions: [...mentions], tags: [...tags] }
}

function count(value: unknown): number | null {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function isoOf(value: unknown): string | null {
	const parsed = typeof value === 'string' ? Date.parse(value) : NaN
	return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
}

// ActivityPub::Parser::PollParser: the poll of a Question, from its anyOf (multiple) or oneOf items, each a choice by
// its name (or content) with its votes in replies.totalItems; it ends when closed says (a time, or now for any other
// true value), else at endTime. Choices without a name are left out with their votes. At most MAX_REMOTE_OPTIONS
// choices, each well-formed (a lone surrogate becomes U+FFFD) and cut to MAX_REMOTE_OPTION_LENGTH code units without
// splitting a surrogate pair (RES-4); a choice so changed is marked cut, as a vote could not name it. null: not a poll.
function pollOf(object: Json): RemotePollInput | null {
	const items = Array.isArray(object.anyOf) ? object.anyOf : Array.isArray(object.oneOf) ? object.oneOf : null
	if (!typeIs(object.type, ['Question']) || items === null) {
		return null
	}
	const options: string[] = []
	const tallies: number[] = []
	const cut: number[] = []
	for (const item of items) {
		if (options.length >= MAX_REMOTE_OPTIONS) {
			break
		}
		const title = isObject(item) ? (text(item.name) ?? text(item.content)) : null
		if (title === null || !isObject(item)) {
			continue
		}
		const kept = cutCodeUnits(title.toWellFormed(), MAX_REMOTE_OPTION_LENGTH)
		if (kept !== title) {
			cut.push(options.length)
		}
		options.push(kept)
		tallies.push((isObject(item.replies) ? count(item.replies.totalItems) : null) ?? 0)
	}
	if (options.length === 0) {
		return null
	}
	const closed = object.closed
	const closedNow = closed !== undefined && closed !== null && closed !== false && typeof closed !== 'string'
	return {
		options,
		tallies,
		multiple: Array.isArray(object.anyOf),
		expiresAt: typeof closed === 'string' ? isoOf(closed) : closedNow ? null : isoOf(object.endTime),
		closedNow,
		votersCount: count(object.votersCount),
		cut,
	}
}

// The properties that name a quoted status, in the order Mastodon reads them (StatusParser#quote_uri).
const QUOTE_PROPERTIES = ['quote', '_misskey_quote', 'quoteUrl', 'quoteUri'] as const

function firstOf(object: Json, key: string): unknown {
	return asArray(object[key])[0]
}

// StatusParser#quote_uri, #legacy_quote?, #deleted_quote? and #quote_approval_uri: the first http(s) URI the quote
// properties name, in Mastodon's order; legacy when the Note has no `quote` (Misskey's and Fedibird's properties
// only); a `quote` that is a Tombstone is a deleted quote whether or not it has an id (Mastodon's has none), its uri
// its id or the first the other properties name. The stamp is the first quoteAuthorization, http(s) only (the Store
// drops one of its own origin). An object in `quote` is also kept as the embedded quoted Note, parsed one level deep
// (its own quote is never embedded further), for the Store to take only when it is the quoting author's own. null: the
// Note quotes nothing.
function quoteOf(object: Json, embed: boolean): RemoteQuoteInput | null {
	const quote = firstOf(object, 'quote')
	const uriOf = (value: unknown) => httpString(idOf(value))
	if (isObject(quote) && typeIs(quote.type, ['Tombstone'])) {
		const uri = [quote, ...QUOTE_PROPERTIES.slice(1).map((key) => firstOf(object, key))]
			.map(uriOf)
			.find((value) => value !== null)
		return { uri: uri ?? null, legacy: false, tombstone: true, approvalUri: null }
	}
	const uri = QUOTE_PROPERTIES.map((key) => uriOf(firstOf(object, key))).find((value) => value !== null)
	if (uri === undefined) {
		return null
	}
	const embedded = embed && isObject(quote) ? parseRemoteStatus(quote, null, false) : null
	return {
		uri,
		legacy: quote === undefined || quote === null,
		tombstone: false,
		approvalUri: uriOf(firstOf(object, 'quoteAuthorization')),
		embedded: embedded !== null && embedded.uri === uri ? embedded : null,
	}
}

// Entries of each half of a canQuote policy read at most (RES-1). A policy names a few collections; a longer one only
// adds unsupported_policy, which an entry past the bound would add anyway unless it named a collection twice.
const MAX_QUOTE_POLICY_ENTRIES = 32

// StatusParser#quote_policy's input: interactionPolicy.canQuote's automaticApproval and manualApproval, as the actor
// URIs (or collections) they list; an entry that is not a URI string is kept as '' (it can only be unsupported). The
// Store turns them into Mastodon's flags with the author's collections (remote-statuses.ts remoteQuotePolicy). null:
// the Note states no policy.
function quotePolicyOf(object: Json): RemoteQuotePolicyInput | null {
	const policy = isObject(object.interactionPolicy) ? object.interactionPolicy.canQuote : undefined
	if (!isObject(policy)) {
		return null
	}
	const half = (value: unknown) =>
		asArray(value)
			.slice(0, MAX_QUOTE_POLICY_ENTRIES)
			.map((entry) => (typeof entry === 'string' && entry.length <= MAX_URL_LENGTH ? entry : ''))
	return { automatic: half(policy.automaticApproval), manual: half(policy.manualApproval) }
}

// The status an object describes, or null if it is not one Kopje stores. `activity` supplies to and cc when the
// object has none (StatusParser falls back to the activity's addressing). embedQuote: keep a Note embedded as the
// quoted status (false for an embedded one itself).
export function parseRemoteStatus(
	object: unknown,
	activity: Json | null = null,
	embedQuote = true
): RemoteStatusInput | null {
	if (!isObject(object)) {
		return null
	}
	const converted = typeIs(object.type, CONVERTED_TYPES)
	if (!typeIs(object.type, STATUS_TYPES) && !converted) {
		return null
	}
	// The id is stored as written, so its bound is measured as the projection measures it (identity-bounds.ts).
	const uri =
		typeof object.id === 'string' && withinIdentityBound(object.id, STATUS_URI_LIMIT) && httpString(object.id) !== null
			? object.id
			: null
	if (uri === null) {
		return null
	}
	const href = urlOf(object.url, 'text/html')
	const url = href !== null && withinIdentityBound(href, STATUS_URI_LIMIT) ? href : null
	const summary = languageString(object, 'summary')
	let html: string
	if (converted) {
		// StatusParser#processed_text: the title as a heading, the summary, and a link to the object.
		const title = languageString(object, 'name')
		const link = escapeHtml(url ?? uri)
		html = [title === null ? null : `<h2>${title}</h2>`, summary, `<a href="${link}">${link}</a>`]
			.filter((part) => part !== null)
			.join('\n\n')
	} else {
		html = languageString(object, 'content') ?? ''
	}
	const content = sanitizeRemoteContent(storedText(html))
	const { mentions, tags } = tagsOf(object)
	const inReplyTo = idOf(object.inReplyTo)
	// Mastodon's `conversation` (ActivityPub::Activity::Create reads it, and not `context`): any identifier, a tag: URI
	// included, of a bounded length (isConversationId, which the backfill of migration 0009 applies to stored objects).
	const conversation = isConversationId(object.conversation) ? object.conversation : null
	return {
		uri,
		url,
		attributedTo: idOf(asArray(object.attributedTo)[0]),
		content,
		text: remoteHtmlText(content),
		spoilerText: converted
			? ''
			: cutJsonString(cutCodeUnits(storedText(summary ?? ''), MAX_SPOILER_LENGTH), SPOILER_BYTES),
		sensitive: object.sensitive === true,
		language: languageOf(object),
		published: timeOf(object.published),
		updated: timeOf(object.updated),
		inReplyTo: inReplyTo === null || inReplyTo.length > MAX_URL_LENGTH ? null : inReplyTo,
		conversation,
		to: audience(object, 'to', activity),
		cc: audience(object, 'cc', activity),
		mentions,
		tags,
		emojiTags: emojiCandidates(object.tag),
		media: mediaOf(object),
		// A Note's name: in reply to a local poll, a vote (ActivityPub::Activity::Create#poll_vote?).
		name: converted ? null : text(object.name),
		poll: converted ? null : pollOf(object),
		quote: quoteOf(object, embedQuote),
		quotePolicy: quotePolicyOf(object),
		raw: JSON.stringify(object),
	}
}

export type FetchedStatus = { kind: 'ok'; status: RemoteStatusInput } | { kind: 'transient' } | { kind: 'unusable' }

// A status fetched by its id through `loader` (the request's signed, budgeted loader: NET-1, NET-4). The loader has
// checked the document's id against its origin (ID-2); the parsed id must be that same id.
export async function fetchRemoteStatus(
	uri: string,
	loader: DocumentLoader,
	activity: Json | null = null
): Promise<FetchedStatus> {
	let document: unknown
	try {
		document = (await loader(uri)).document
	} catch (error) {
		return { kind: isTransientLoadError(error) ? 'transient' : 'unusable' }
	}
	if (!withinJsonBounds(document)) {
		return { kind: 'unusable' }
	}
	const status = parseRemoteStatus(document, activity)
	return status === null || new URL(status.uri).origin !== new URL(uri).origin
		? { kind: 'unusable' }
		: { kind: 'ok', status }
}
