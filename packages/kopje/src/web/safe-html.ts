import type { EmojiField } from './view/emoji'
import { remoteHtmlText, sanitizeRemoteHtml, sanitizeRemoteHtmlFiltered } from '../security/html'

// HTML-1 at the sink: the only HTML the web pages emit unescaped is a SafeHtml, and the only way to make one is to pass
// the stored HTML (bios, status content, field values) through the sanitizer again here. Everything else in a page is
// text that hono/jsx escapes.

declare const SAFE: unique symbol

export type SafeHtml = { readonly [SAFE]: true; readonly html: string }

export function sanitized(html: string): SafeHtml {
	return { html: sanitizeRemoteHtml(html) } as SafeHtml
}

// Stored HTML sanitized in one pass that also turns the field's emoji references into images (design §12): the
// sanitizer hands each run of text, escaped, to the field, which adds only its own escaped image markup (emoji.ts).
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
	const text = remoteHtmlText(sanitizeRemoteHtml(html)).replace(/\s+/g, ' ').trim()
	return [...text].length > max ? `${[...text].slice(0, max - 1).join('')}…` : text
}
