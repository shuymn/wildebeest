import type { EmojiField } from './view/emoji'
import { remoteHtmlText, sanitizeDocumentHtml, sanitizeRemoteHtml, sanitizeRemoteHtmlFiltered } from '../security/html'

// HTML-1 at the sink: the only HTML the web pages emit unescaped is a SafeHtml, and the only way to make one is to pass
// the stored HTML (bios, status content, field values) through the sanitizer again here. Everything else in a page is
// text that hono/jsx escapes.

declare const SAFE: unique symbol

export type SafeHtml = { readonly [SAFE]: true; readonly html: string }

// An operator's document, sanitized at its sink with its headings kept (sanitizeDocumentHtml).
export function sanitizedDocument(html: string): SafeHtml {
	return { html: sanitizeDocumentHtml(html) } as SafeHtml
}

// Stored HTML sanitized in one pass that also turns the field's emoji references into images: the sanitizer hands each
// run of text, escaped, to the field, which adds only its own escaped image markup (emoji.ts).
export function sanitizedWithEmoji(html: string, emoji: EmojiField): SafeHtml {
	return { html: sanitizeRemoteHtmlFiltered(html, (text) => emoji.html(text)) } as SafeHtml
}

// A profile field's value as Mastodon renders it on the profile, with its emoji: its links carry rel="me", so a site
// that links back can verify the profile. The sanitizer writes every link's rel as exactly rel="nofollow noopener";
// the same characters anywhere else are text, and stay text after the replacement (it adds no markup), as does an
// emoji image, which has no rel.
export function sanitizedField(html: string, emoji: EmojiField): SafeHtml {
	return {
		html: sanitizedWithEmoji(html, emoji).html.replaceAll('rel="nofollow noopener"', 'rel="me nofollow noopener"'),
	} as SafeHtml
}

// Plain text of stored HTML, for meta descriptions (which hono/jsx escapes): the sanitizer drops the tags and keeps
// paragraph and line breaks as spaces (remoteHtmlText). Bounded for a description.
export function plainText(html: string, max = 200): string {
	return shortText(remoteHtmlText(sanitizeRemoteHtml(html)), max)
}

// A status in a line of text (a page's description, the handoff's preview): its warning when it has one, as the
// content it stands for, else its content's text, at most `max` code points.
export function statusSummary(status: { spoiler_text: string; content?: string | null }, max = 200): string {
	return status.spoiler_text !== '' ? shortText(status.spoiler_text, max) : plainText(status.content ?? '', max)
}

// Plain text (a content warning) as a description: its whitespace runs as single spaces, at most `max` code points.
export function shortText(text: string, max = 200): string {
	const flat = text.replace(/\s+/g, ' ').trim()
	return [...flat].length > max ? `${[...flat].slice(0, max - 1).join('')}…` : flat
}
