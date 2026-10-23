import { cardImageSource } from './link-details'
import { webPageUrlRefusal } from './web-page'
import { type CardFields, storedCardText } from '../domain/link-cards'
import type { PageLink } from '../platform/html-scan'
import { railsBlank } from '../platform/rails-blank'
import {
	CARD_OPTIONAL_URL_LIMIT,
	CARD_TEXTS,
	cardDimension,
	iframeDimension,
	isOembedTemplate,
	OEMBED_PLACEHOLDER,
	OEMBED_TEMPLATE_BYTES,
	presentedEmbedSrc,
} from '../platform/stored-bounds'
import { oembedIframe } from '../security/html'

// A link card's oEmbed endpoint, as Mastodon's FetchOEmbedService and FetchLinkCardService#attempt_oembed read it
// (app/services/fetch_oembed_service.rb, fetch_link_card_service.rb:108-150, v4.5.11). Pure: the round
// (link-cards.ts) fetches through the sink's JSON mode (web-page.ts fetchWebJson) and the Store keeps the endpoint
// cache (domain/link-cards.ts). Rule ids: docs/mastodon-deviations.md, "Link previews"; the transition and conversion
// tables of the card round (link-cards.ts).
//   - discovery: the first <link> of the scan (its first CARD_SCAN.links) whose type is exactly application/json+oembed
//     or text/json+oembed (no XML), its decoded href resolved against the page's final URL, http upgraded to https (the
//     page is https); another scheme or a URL the sink refuses means no endpoint (declared: Mastodon tries it);
//   - the cache's template: the endpoint's href with each =http(s)://... value up to the next & replaced by ={url}
//     (URL_REGEX, :5, 74), kept only when it passes the stored rule (stored-bounds.ts isOembedTemplate) and the URL
//     checks here; expanded by RFC 6570 simple expansion (Addressable::Template#expand), bounded before it is built;
//   - the document: version '1.0' (or the number 1, which JSON.parse cannot tell from 1.0), a type, then the mapping
//     of :118-150; a blank title falls back to OpenGraph (declared: Mastodon saves it), a video without one accepted
//     iframe is a link (declared).

const DISCOVERED_TYPES = new Set(['application/json+oembed', 'text/json+oembed'])
// Mastodon's URL_REGEX (fetch_oembed_service.rb:5), case-insensitive.
const URL_REGEX = /=https?(?:%3A|:)(?:\/\/|%2F%2F)[^&]*/gi
const PLACEHOLDER = OEMBED_PLACEHOLDER.slice(1)

// The endpoint a page declares (above), or null.
export function discoverOembed(links: readonly PageLink[], finalUrl: string): string | null {
	const link = links.find((l) => l.type !== null && DISCOVERED_TYPES.has(l.type))
	if (link?.href === null || link?.href === undefined || railsBlank(link.href)) {
		return null
	}
	let url: URL
	try {
		url = new URL(link.href, finalUrl)
	} catch {
		return null
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return null
	}
	url.protocol = 'https:'
	return webPageUrlRefusal(url) === null ? url.href : null
}

// A template as the cache keeps and reads it: the stored rule, then the text with each {url} replaced by x as an
// https URL the sink accepts. Else null.
export function acceptedTemplate(value: unknown): string | null {
	if (!isOembedTemplate(value)) {
		return null
	}
	try {
		const url = new URL(value.replaceAll(PLACEHOLDER, 'x'))
		return url.protocol === 'https:' && webPageUrlRefusal(url) === null ? value : null
	} catch {
		return null
	}
}

// The template of a discovered endpoint, or null when URL_REGEX does not match it or the result is not accepted.
export function oembedTemplate(endpoint: string): string | null {
	URL_REGEX.lastIndex = 0
	if (!URL_REGEX.test(endpoint)) {
		return null
	}
	return acceptedTemplate(endpoint.replace(URL_REGEX, OEMBED_PLACEHOLDER))
}

// RFC 6570's unreserved characters, which simple expansion keeps; every other UTF-8 byte is percent-encoded (uppercase,
// as Addressable writes it).
const UNRESERVED = /^[A-Za-z0-9\-._~]$/

function encodedLength(url: string): number {
	let length = 0
	for (const byte of new TextEncoder().encode(url)) {
		length += UNRESERVED.test(String.fromCharCode(byte)) ? 1 : 3
	}
	return length
}

function encoded(url: string): string {
	let out = ''
	for (const byte of new TextEncoder().encode(url)) {
		const char = String.fromCharCode(byte)
		out += UNRESERVED.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
	}
	return out
}

// The cached endpoint for the claim URL `url`: `template` expanded, its length computed first (len(t) + k × (enc(url)
// − 5) for k placeholders) so nothing past OEMBED_TEMPLATE_BYTES is built, then the sink's URL rule
// (webPageUrlRefusal) before any policy or DNS step. Null: a cache miss.
export function expandTemplate(template: string, url: string): string | null {
	const accepted = acceptedTemplate(template)
	if (accepted === null) {
		return null
	}
	const k = accepted.split(PLACEHOLDER).length - 1
	if (accepted.length + k * (encodedLength(url) - PLACEHOLDER.length) > OEMBED_TEMPLATE_BYTES) {
		return null
	}
	const expanded = accepted.replaceAll(PLACEHOLDER, encoded(url))
	return webPageUrlRefusal(expanded) === null ? expanded : null
}

// A card image's source from an oEmbed field (fetch_link_card_service.rb:131, 135-136, 143): a non-blank string
// resolved against the endpoint URL as requested, then cardImageSource; else ''.
function imageOf(value: unknown, endpoint: string): string {
	if (typeof value !== 'string' || railsBlank(value)) {
		return ''
	}
	try {
		return cardImageSource(new URL(value, endpoint).href)
	} catch {
		return ''
	}
}

// What an endpoint's document makes: a card, a fallback to the page's OpenGraph fields, or no card.
// The card's finalUrl is the round's (federation/link-cards.ts): the page's URL after redirects, or the claim URL.
export type OembedOutcome =
	{ kind: 'card'; fields: Omit<CardFields, 'finalUrl'> } | { kind: 'fallback' } | { kind: 'none' }

type Json = Record<string, unknown>

// Rails' blank? over a parsed JSON value: null, false, a blank string, an empty array or object.
function blank(value: unknown): boolean {
	if (value === undefined || value === null || value === false) {
		return true
	}
	if (typeof value === 'string') {
		return railsBlank(value)
	}
	if (Array.isArray(value)) {
		return value.length === 0
	}
	return typeof value === 'object' && Object.keys(value).length === 0
}

// A text field (embed[:x] || ''): a string as is (the Store cuts it, storedCardText), anything else ''.
const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

// author_url and provider_url (:123, 125): a present string joined to the endpoint URL as requested, http(s) only,
// within CARD_OPTIONAL_URL_LIMIT; else ''.
function joinedUrl(value: unknown, endpoint: string): string {
	if (typeof value !== 'string' || railsBlank(value)) {
		return ''
	}
	try {
		const url = new URL(value, endpoint)
		return (url.protocol === 'http:' || url.protocol === 'https:') && url.href.length <= CARD_OPTIONAL_URL_LIMIT
			? url.href
			: ''
	} catch {
		return ''
	}
}

// The video's iframe: its src (stored-bounds.ts presentedEmbedSrc) and dimensions (iframeDimension), or null.
function videoEmbed(html: unknown): Pick<CardFields, 'embedSrc' | 'iframeWidth' | 'iframeHeight'> | null {
	const iframe = typeof html === 'string' ? oembedIframe(html) : null
	const src = iframe === null ? null : presentedEmbedSrc(iframe.src)
	if (iframe === null || src === null) {
		return null
	}
	return { embedSrc: src, iframeWidth: iframeDimension(iframe.width), iframeHeight: iframeDimension(iframe.height) }
}

// The outcome of an endpoint's parsed document `value`, fetched from `endpoint` (the URL as requested, before
// redirects): null falls back; another root that is not an object is no card (Mastodon's job fails); an invalid
// version or a blank type falls back; an unknown or non-string type is no card; rich, a photo whose url is not a
// non-blank string and a blank title fall back. The image is a link's or a video's thumbnail_url, a photo's url
// (imageOf); a refused one leaves the card without an image.
export function oembedCard(value: unknown, endpoint: string): OembedOutcome {
	if (value === null) {
		return { kind: 'fallback' }
	}
	if (typeof value !== 'object' || Array.isArray(value)) {
		return { kind: 'none' }
	}
	const embed = value as Json
	if (!(embed.version === '1.0' || embed.version === 1) || blank(embed.type)) {
		return { kind: 'fallback' }
	}
	const { type } = embed
	if (type !== 'link' && type !== 'photo' && type !== 'video' && type !== 'rich') {
		return { kind: 'none' }
	}
	if (type === 'rich' || (type === 'photo' && (typeof embed.url !== 'string' || railsBlank(embed.url)))) {
		return { kind: 'fallback' }
	}
	const title = textOf(embed.title)
	if (railsBlank(storedCardText(title, CARD_TEXTS.title))) {
		return { kind: 'fallback' }
	}
	const sized = type !== 'link'
	const video = type === 'video' ? videoEmbed(embed.html) : null
	return {
		kind: 'card',
		fields: {
			title,
			description: '',
			authorName: textOf(embed.author_name),
			authorUrl: joinedUrl(embed.author_url, endpoint),
			providerName: textOf(embed.provider_name),
			providerUrl: joinedUrl(embed.provider_url, endpoint),
			language: null,
			publishedAt: null,
			type: video !== null ? 'video' : type === 'photo' ? 'photo' : 'link',
			width: sized ? cardDimension(embed.width) : 0,
			height: sized ? cardDimension(embed.height) : 0,
			embedSrc: video?.embedSrc ?? '',
			iframeWidth: video?.iframeWidth ?? null,
			iframeHeight: video?.iframeHeight ?? null,
			imageUrl: imageOf(type === 'photo' ? embed.url : embed.thumbnail_url, endpoint),
			imageDescription: '',
			linkType: 'unknown',
		},
	}
}
