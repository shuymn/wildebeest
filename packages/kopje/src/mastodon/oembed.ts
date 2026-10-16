import { type ApiHandler, present, storeCall } from './context'
import { mastodonError } from './errors'
import { escapeHtml } from '../domain/plain-text'
import type { Status } from '../domain/status-presenter'

// oEmbed (Mastodon 4.5's Api::OEmbedController and OEmbedSerializer): a status of this instance as a `rich` embed, an
// iframe of its embed page (/@username/:id/embed, app/web.tsx) that /assets/embed.js puts in place of the quote. The
// Store finds the status and applies the status page's rule (domain/web-pages.ts, VIS-4); no token is read.

// OEmbedSerializer::DEFAULT_WIDTH
const DEFAULT_WIDTH = 400

// OEmbedSerializer#cache_age: a day.
const CACHE_AGE = 86_400

// OEmbedSerializer::INLINE_STYLES, squished.
const STYLES = {
	blockquote:
		'background: #FCF8FF; border-radius: 8px; border: 1px solid #C9C4DA; margin: 0; max-width: 540px; min-width: 270px; overflow: hidden; padding: 0;',
	statusLink:
		"align-items: center; color: #1C1A25; display: flex; flex-direction: column; font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Oxygen, Ubuntu, Cantarell, 'Fira Sans', 'Droid Sans', 'Helvetica Neue', Roboto, sans-serif; font-size: 14px; justify-content: center; letter-spacing: 0.25px; line-height: 20px; padding: 24px; text-decoration: none;",
	divAccount: 'color: #787588; margin-top: 16px;',
	divView: 'font-weight: 500;',
}

// GET /api/oembed: `url` names the status; `maxwidth` and `maxheight` become `width` and `height`.
export const oembed: ApiHandler = async (c, deps) => {
	const url = c.req.query('url') ?? ''
	const found = await storeCall(c, deps, (s, b) => s.embeddedStatus(b, { url, present: present(c), now: deps.now() }))
	// Api::OEmbedController#require_public_status!, and StatusFinder's RecordNotFound.
	if (found.status !== 'ok') {
		return mastodonError(404, 'Record not found')
	}
	const status = found.value as Status
	const { domain } = found
	const maxheight = c.req.query('maxheight')
	return c.json({
		type: 'rich',
		version: '1.0',
		author_name: status.account.display_name === '' ? status.account.username : status.account.display_name,
		author_url: status.account.url,
		provider_name: domain,
		provider_url: `https://${domain}/`,
		cache_age: CACHE_AGE,
		html: embedHtml(status, domain),
		// OEmbedSerializer#width and #height: Ruby's to_i of the parameter; an empty maxheight is no height.
		width: rubyToI(c.req.query('maxwidth') ?? String(DEFAULT_WIDTH)),
		height: maxheight === undefined || maxheight.trim() === '' ? null : rubyToI(maxheight),
	})
}

// OEmbedSerializer#html, with every value escaped. The quote links to the status and names the embed page, which
// embed.js loads in an iframe; `data-allowed-prefixes` keeps the script to this instance's pages.
export function embedHtml(status: Status, domain: string): string {
	const root = `https://${domain}/`
	const path = `@${status.account.username}/${status.id}`
	return [
		`<blockquote class="mastodon-embed" data-embed-url="${escapeHtml(`${root}${path}/embed`)}" style="${STYLES.blockquote}">`,
		`<a href="${escapeHtml(`${root}${path}`)}" target="_blank" style="${STYLES.statusLink}">`,
		`<div style="${STYLES.divAccount}">Post by @${escapeHtml(status.account.username)}@${escapeHtml(domain)}</div>`,
		`<div style="${STYLES.divView}">View on Kopje</div>`,
		'</a>',
		'</blockquote>',
		`<script data-allowed-prefixes="${escapeHtml(root)}" async src="${escapeHtml(`${root}assets/embed.js`)}"></script>`,
	].join(' ')
}

// Ruby's String#to_i: the leading integer (after whitespace, with a sign and underscores between digits), else 0.
function rubyToI(text: string): number {
	const match = /^\s*([+-]?\d+(?:_\d+)*)/.exec(text)
	return match === null ? 0 : Number.parseInt((match[1] ?? '0').replaceAll('_', ''), 10)
}
