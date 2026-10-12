import type { DocumentLoader } from '@fedify/fedify'

import { isTransientLoadError } from './loader'
import { isPublicCollection } from '../domain/audience'
import {
	MAX_MEDIA_DESCRIPTION_LENGTH,
	MAX_SPOILER_LENGTH,
	MAX_STATUS_AUDIENCE,
	MAX_STATUS_MEDIA,
	MAX_STATUS_MENTION_TAGS,
	MAX_STATUS_TAGS,
	MAX_TAG_LENGTH,
	type RemoteMediaInput,
	type RemoteStatusInput,
} from '../domain/remote-statuses'
import { MAX_URL_LENGTH, normalizeTag } from '../domain/status-text'
import { httpUrl } from '../platform/http-url'
import { withinJsonBounds } from '../platform/json-bounds'
import { remoteHtmlText, sanitizeRemoteHtml } from '../security/html'

// Remote statuses as Mastodon 4.7.3 reads them (ActivityPub::Parser::StatusParser and MediaAttachmentParser): compacted
// JSON with the ActivityStreams context, values as strings, objects with an id, or arrays of either. Note and Question
// are statuses; Article, Page, Image, Audio, Video and Event are converted as Mastodon converts them (the name as a
// heading, the summary, and a link to the url, with no content warning). Everything is bounded (RES-2, RES-4) and
// sanitized (HTML-1); URLs are http(s) only (HTML-3). Misskey's extensions (_misskey_content, _misskey_quote,
// quoteUrl, _misskey_summary) and everything else not read here stay in raw.

type Json = Record<string, unknown>

export const STATUS_TYPES = ['Note', 'Question']
export const CONVERTED_TYPES = ['Image', 'Audio', 'Video', 'Article', 'Page', 'Event']
export const ACTOR_TYPES = ['Application', 'Group', 'Organization', 'Person', 'Service']

function isObject(value: unknown): value is Json {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asArray(value: unknown): unknown[] {
	return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]
}

export function idOf(value: unknown): string | null {
	if (typeof value === 'string') {
		return value
	}
	return isObject(value) && typeof value.id === 'string' ? value.id : null
}

// JsonLdHelper#equals_or_includes_any?
export function typeIs(value: unknown, types: readonly string[]): boolean {
	return asArray(value).some((type) => typeof type === 'string' && types.includes(type))
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

function languageOf(object: Json): string | null {
	for (const key of ['contentMap', 'nameMap', 'summaryMap']) {
		const map = object[key]
		const tag = isObject(map) ? Object.keys(map)[0] : undefined
		if (tag !== undefined) {
			// The primary subtag, as stored for local statuses (ISO 639).
			const primary = tag.split(/[-_]/)[0]?.toLowerCase() ?? ''
			return /^[a-z]{2,3}$/.test(primary) ? primary : null
		}
	}
	return null
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
	const normalized = normalizeTag(name.replace(/^#/, ''))
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
		const url = urlOf(attachment.url)
		if (url === null) {
			continue
		}
		const icon = attachment.icon
		const description = (languageString(attachment, 'summary') ?? languageString(attachment, 'name') ?? '').trim()
		media.push({
			type: mediaType(attachment.type, attachment.mediaType),
			url,
			previewUrl: httpString(typeof icon === 'string' ? icon : isObject(icon) ? (text(icon.url) ?? null) : null),
			description: description.slice(0, MAX_MEDIA_DESCRIPTION_LENGTH),
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

// The status an object describes, or null if it is not one Kopje stores. `activity` supplies to and cc when the
// object has none (StatusParser falls back to the activity's addressing).
export function parseRemoteStatus(object: unknown, activity: Json | null = null): RemoteStatusInput | null {
	if (!isObject(object)) {
		return null
	}
	const converted = typeIs(object.type, CONVERTED_TYPES)
	if (!typeIs(object.type, STATUS_TYPES) && !converted) {
		return null
	}
	const uri = typeof object.id === 'string' && httpString(object.id) !== null ? object.id : null
	if (uri === null) {
		return null
	}
	const url = urlOf(object.url, 'text/html')
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
	const content = sanitizeRemoteHtml(html)
	const { mentions, tags } = tagsOf(object)
	const inReplyTo = idOf(object.inReplyTo)
	return {
		uri,
		url,
		attributedTo: idOf(asArray(object.attributedTo)[0]),
		content,
		text: remoteHtmlText(content),
		spoilerText: converted ? '' : (summary ?? '').slice(0, MAX_SPOILER_LENGTH),
		sensitive: object.sensitive === true,
		language: languageOf(object),
		published: timeOf(object.published),
		updated: timeOf(object.updated),
		inReplyTo: inReplyTo === null || inReplyTo.length > MAX_URL_LENGTH ? null : inReplyTo,
		to: audience(object, 'to', activity),
		cc: audience(object, 'cc', activity),
		mentions,
		tags,
		media: mediaOf(object),
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
