import { availableSql } from './audience'
import { NEW_GENERATION } from './ids'
import { shownMediaSql } from './status-rows'
import { parseStatusText } from './status-text'
import { ACCOUNTS_ID_INDEX, QUOTES_STATUS_INDEX, STATUSES_ID_INDEX } from '../db/indexes'
import type { Db } from '../db/sql'
import { CARD_URL_LIMIT, cardUrlPastSql, profileUrlSql } from '../platform/stored-bounds'

// Status cards (Mastodon's FetchLinkCardService and LinkCrawlWorker, app/services/fetch_link_card_service.rb, v4.5.11):
// the Store's part, the only module that writes status_cards (migration 0067_status_cards). The Worker's part, a cron
// round that fetches the links through the web-page sink, is federation/link-cards.ts. A row holds one status's card,
// a copy (Mastodon shares one PreviewCard per URL; docs/mastodon-deviations.md, "Link previews"):
//
// - Eligible (eligibleSql, judged at enqueue, at claim and at record): an original, public or unlisted (AM8: Mastodon
//   fetches every visibility), by an available author (R1), with no shown attachment and no quote row (Mastodon's
//   with_media? and quote.present?).
// - A write picks the link and enqueues it in its own transaction (enqueueCard): a local post's or a text edit's first
//   http(s) link that is not the instance's (localCardLink); a remote status's first captured anchor that is not a
//   mention's or the instance's (remoteCardLink), on its creation and on a significant update. A pick that the stored
//   URL rule refuses (http, too long, a refused character) is no card; nothing later is taken. The round refuses what
//   else the sink does (web-page.ts webPageUrlRefusal: a port, an IP literal) before any network step.
// - The hide step of a remote status's delete (inbox.ts deleteStatusBatch), the one place a stored status's visibility
//   becomes ineligible, deletes its row in the same step (deleteCard).

// Anchors a remote status's capture keeps (federation/remote-status.ts), and the raw href's bound, in UTF-16 code
// units: past it the anchor is over-long (no card if it is the pick).
export const CARD_CANDIDATES = 16
export const CARD_RAW_HREF_LIMIT = CARD_URL_LIMIT
// URL.host at most: a DNS name of 253 bytes and a port.
const CARD_HOST_LIMIT = 253 + ':65535'.length

// One captured anchor, as Mastodon's parse_urls and bad_url? read it (:79-95): `raw`, the href as written (null past
// CARD_RAW_HREF_LIMIT), compared with the mentioned accounts' URLs by bytes; `url`, how bad_url? judges it: 'invalid'
// (unparsable: Mastodon's InvalidURIError, no card), 'skip' (no host, or not http(s)), else its WHATWG href (null past
// CARD_URL_LIMIT) and authority (URL.host, which omits a default port).
export type CardCandidate = {
	raw: string | null
	url: 'invalid' | 'skip' | { href: string | null; host: string }
}

// The status ?1 may hold a card now (see above).
export function eligibleSql(id: string): string {
	return `EXISTS (SELECT 1 FROM statuses es INDEXED BY ${STATUSES_ID_INDEX} WHERE es.id = ${id}
		AND es.reblog_of_id IS NULL AND es.visibility IN ('public', 'unlisted') AND ${availableSql('es.account_id')}
		AND NOT EXISTS (${shownMediaSql('es.id')})
		AND NOT EXISTS (SELECT 1 FROM quotes eq INDEXED BY ${QUOTES_STATUS_INDEX} WHERE eq.status_id = es.id))`
}

// A captured anchor as an input names it, bounded and type-checked again (the Worker's capture is not trusted to have
// done so), else none.
function boundedCandidate(value: unknown): CardCandidate | null {
	if (typeof value !== 'object' || value === null) {
		return null
	}
	const { raw, url } = value as Record<string, unknown>
	if (raw !== null && (typeof raw !== 'string' || raw.length > CARD_RAW_HREF_LIMIT)) {
		return null
	}
	if (url === 'invalid' || url === 'skip') {
		return { raw, url }
	}
	if (typeof url !== 'object' || url === null) {
		return null
	}
	const { href, host } = url as Record<string, unknown>
	if (href !== null && (typeof href !== 'string' || href.length > CARD_URL_LIMIT)) {
		return null
	}
	return typeof host === 'string' && host.length <= CARD_HOST_LIMIT ? { raw, url: { href, host } } : null
}

// Whether `raw` equals, by bytes, the URL of an account the status ?1 mentions, silent mentions included (Mastodon's
// mention_link?, :97-101, url_for: a remote account's url, a local one's https://<domain>/@<username>).
function mentionLink(db: Db, statusId: string, raw: string, domain: string): boolean {
	return (
		db.first(
			`SELECT 1 AS x FROM status_mentions m CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = m.account_id
			WHERE m.status_id = ?1 AND CAST(CASE WHEN a.domain IS NULL THEN 'https://' || ?3 || '/@' || a.username
				ELSE ${profileUrlSql('a.url')} END AS BLOB) = CAST(?2 AS BLOB)
			LIMIT 1`,
			statusId,
			raw,
			domain
		) !== undefined
	)
}

// The link of a remote status's card (parse_urls, :79-90): the first candidate that is not a mention's, has a host
// and an http(s) scheme, and is not the instance's (`domain`, its authority: TagManager#local_url?). It is final:
// an unparsable or over-long one means no card (null), and nothing later is taken.
export function remoteCardLink(db: Db, statusId: string, candidates: unknown, domain: string): string | null {
	const list = Array.isArray(candidates) ? candidates.slice(0, CARD_CANDIDATES) : []
	for (const value of list) {
		const candidate = boundedCandidate(value)
		if (candidate === null) {
			return null
		}
		if (candidate.raw !== null && mentionLink(db, statusId, candidate.raw, domain)) {
			continue
		}
		if (candidate.url === 'skip') {
			continue
		}
		if (candidate.url === 'invalid') {
			return null
		}
		if (candidate.url.host === domain) {
			continue
		}
		return candidate.raw === null ? null : candidate.url.href
	}
	return null
}

// The link of a local status's card (URL_PATTERN over its text, :80-81): the first http(s) link of the source text
// (status-text.ts, linkify-it) whose authority is not the instance's.
export function localCardLink(source: string, domain: string): string | null {
	for (const segment of parseStatusText(source).segments) {
		if (segment.kind !== 'url') {
			continue
		}
		let url: URL
		try {
			url = new URL(segment.url)
		} catch {
			return null
		}
		if (url.hostname === '' || url.host === domain) {
			continue
		}
		return url.href.length > CARD_URL_LIMIT ? null : url.href
	}
	return null
}

// In a write's transaction: the status's row reset to pending for `link` (a new generation, attempts 0, the fields
// cleared, the claim token kept) when the status is eligible and the stored URL rule (cardUrlPastSql, the triggers')
// accepts the link; otherwise its row deleted. Mastodon's reset_preview_card! then LinkCrawlWorker.
export function enqueueCard(db: Db, statusId: string, link: string | null, now: number): void {
	const queued =
		link !== null &&
		db.run(
			`INSERT INTO status_cards (status_id, url, due_at, enqueued_at, generation)
			SELECT ?1, ?2, ?3, ?3, ${NEW_GENERATION} WHERE ${eligibleSql('?1')} AND NOT (${cardUrlPastSql('?2', false)})
			ON CONFLICT (status_id) DO UPDATE SET url = excluded.url, due_at = excluded.due_at,
				enqueued_at = excluded.enqueued_at, attempts = 0, generation = excluded.generation, title = '',
				description = '', author_name = '', author_url = '', provider_name = '', provider_url = '', language = NULL,
				published_at = NULL, fetched_at = NULL`,
			statusId,
			link,
			now
		) > 0
	if (!queued) {
		deleteCard(db, statusId)
	}
}

// The status's row deleted: one row at most.
export function deleteCard(db: Db, statusId: string): void {
	db.run('DELETE FROM status_cards WHERE status_id = ?', statusId)
}
