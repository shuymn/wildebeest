import { cardEligibleSql } from './audience'
import { NEW_GENERATION } from './ids'
import { hostCovered } from './instance-domain-blocks'
import { writeOperation } from './operation'
import { parseStatusText } from './status-text'
import { ACCOUNTS_ID_INDEX } from '../db/indexes'
import type { Db } from '../db/sql'
import {
	CARD_CLAIMED_INDEX,
	CARD_DUE_INDEX,
	CARD_EXPIRY_INDEX,
	CARD_FRESH_INDEX,
	CARD_MAX_ATTEMPTS,
	CARD_TEXTS,
	CARD_URL_LIMIT,
	cardLanguagePastSql,
	cardTextPastSql,
	cardUrlPastSql,
	isoTimeSql,
	profileUrlSql,
	SAFE_INTEGER_MAX,
	storedText,
} from '../platform/stored-bounds'
import { cutJsonString } from '../security/html'

// Status cards (Mastodon's FetchLinkCardService and LinkCrawlWorker, app/services/fetch_link_card_service.rb, v4.5.11):
// the Store's part, the only module that writes status_cards (migration 0067_status_cards). The Worker's part, a cron
// round that fetches the links through the web-page sink, is federation/link-cards.ts. A row holds one status's card,
// a copy (Mastodon shares one PreviewCard per URL; docs/mastodon-deviations.md, "Link previews"):
//
// - Eligible (audience.ts cardEligibleSql, R43, judged at enqueue, at claim and at record): an original, public or
//   unlisted (AM8: Mastodon fetches every visibility), by an available author (R1), with no shown attachment and no
//   quote row (Mastodon's with_media? and quote.present?).
// - A write picks the link and enqueues it in its own transaction (enqueueCard): a local post's or a text edit's first
//   http(s) link that is not the instance's (localCardLink); a remote status's first captured anchor that is not a
//   mention's or the instance's (remoteCardLink), on its creation and on a significant update. A pick that the stored
//   URL rule refuses (http, too long, a refused character) is no card; nothing later is taken. The round refuses what
//   else the sink does (web-page.ts webPageUrlRefusal: a port, an IP literal) before any network step.
// - A claim (claimCards, one per cron round) first expires at most CARD_EXPIRE_BATCH pending rows enqueued more than
//   CARD_EXPIRE_MS ago (never one whose hold is open: AM19), then walks at most CARD_CLAIM_WALK due rows by
//   (due_at, status_id), in order, until CARD_ROUND_CLAIMS are claimed; the rows after that point are untouched. Each
//   row walked makes progress: it is deleted (expired, ineligible, CARD_MAX_ATTEMPTS claims never finished, or a token
//   past SAFE_INTEGER_MAX), attached from another status's fresh copy of the same URL (fetched within CARD_FRESH_MS,
//   Mastodon's 14-day reuse, keeping its fetched_at), deferred to the end of another row's open hold on the same URL
//   (Mastodon's fetch:<url> lock, across rounds), or claimed for CARD_HOLD_MS (a new claim token, one more attempt).
// - The fence: recordCard applies only while the claim token, the generation, an open claim (attempts > 0) and a
//   pending row are the claim's, and the status is eligible now (AM4). A card is attached, a failure deletes the row
//   (no card, no retry: Mastodon's LinkCrawlWorker has retry 0), and an unattempted claim (budget, deadline, a policy
//   RPC error) is released with its attempt given back. A claim never recorded is claimed again after its hold.
// - Accepted (AM4): a suspension and restoration within one round can attach the card a claim fetched to the status,
//   available again; nothing suspended is presented, and the fetch had happened.
// - Each hop of the round's fetches is admitted by cardHopRefused, a write (refused in any maintenance, read-only
//   included, and during a dump or import), before and after its DNS check (NET-3).
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
			SELECT ?1, ?2, ?3, ?3, ${NEW_GENERATION} WHERE ${cardEligibleSql('?1')} AND NOT (${cardUrlPastSql('?2', false)})
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

// ---- The round's operations

export const CARD_HOLD_MS = 5 * 60 * 1000
export const CARD_EXPIRE_MS = 24 * 60 * 60 * 1000
export const CARD_FRESH_MS = 14 * 24 * 60 * 60 * 1000
export const CARD_EXPIRE_BATCH = 500
export const CARD_CLAIM_WALK = 64
export const CARD_ROUND_CLAIMS = 6

const DOMAIN = /^[a-z0-9.-]{1,253}$/

export type CardClaim = { statusId: string; token: number; generation: number; url: string }

export type CardClaims = {
	// The instance's domain, for the round's User-Agent; null: nothing is claimed.
	domain: string | null
	claims: CardClaim[]
	expired: number
	attached: number
	deferred: number
	givenUp: number
}

// A counter or time column as read: an integer within 0..`max`, else NULL (AM5).
function cardCountSql(column: string, max = SAFE_INTEGER_MAX): string {
	return `CASE WHEN typeof(${column}) = 'integer' AND ${column} BETWEEN 0 AND ${max} THEN ${column} END`
}

// A status id as read: 18 decimal digits as TEXT, else NULL.
const STATUS_ID_SQL = `CASE WHEN typeof(status_id) = 'text' AND length(CAST(status_id AS BLOB)) = 18
	AND status_id NOT GLOB '*[^0-9]*' THEN status_id END`

type Walked = {
	id: string | null
	url: string | null
	attempts: number | null
	claim: number | null
	generation: number | null
	enqueued: number | null
}

// The walk's projections: each NULL past its stored bound.
const WALKED = `${STATUS_ID_SQL} AS id,
	CASE WHEN NOT (${cardUrlPastSql('url', false)}) THEN url END AS url,
	${cardCountSql('attempts', CARD_MAX_ATTEMPTS)} AS attempts, ${cardCountSql('claim')} AS claim,
	${cardCountSql('generation')} AS generation, ${cardCountSql('enqueued_at')} AS enqueued`

const CARD_FIELDS = [
	'title',
	'description',
	'author_name',
	'author_url',
	'provider_name',
	'provider_url',
	'language',
	'published_at',
	'fetched_at',
]

// See the module's head. `now` is the round's; at most CARD_EXPIRE_BATCH + CARD_CLAIM_WALK rows are written.
export const claimCards = writeOperation<{ now: number }, CardClaims>((db, { now }) => {
	const out: CardClaims = { domain: null, claims: [], expired: 0, attached: 0, deferred: 0, givenUp: 0 }
	const domain = db.first<{ value: SqlStorageValue }>(
		"SELECT value FROM instance_settings WHERE name = 'domain'"
	)?.value
	if (typeof domain !== 'string' || !DOMAIN.test(domain) || !Number.isSafeInteger(now) || now < 0) {
		return out
	}
	out.domain = domain
	const cutoff = now - CARD_EXPIRE_MS
	// The first CARD_EXPIRE_BATCH pending rows past the cutoff by the expiry index, those with an open hold kept.
	out.expired = db.run(
		`DELETE FROM status_cards WHERE status_id IN (SELECT status_id FROM status_cards INDEXED BY ${CARD_EXPIRY_INDEX}
				WHERE due_at IS NOT NULL AND enqueued_at < ?1 ORDER BY enqueued_at LIMIT ${CARD_EXPIRE_BATCH})
			AND NOT (attempts > 0 AND due_at > ?2)`,
		cutoff,
		now
	)
	const walk = db.all<Walked>(
		`SELECT ${WALKED} FROM status_cards INDEXED BY ${CARD_DUE_INDEX} WHERE due_at <= ?1
		ORDER BY due_at, status_id LIMIT ${CARD_CLAIM_WALK}`,
		now
	)
	// A row whose projection fails (never, under the triggers) is deleted in SQL among the same walk, by its own key.
	if (walk.some((row) => Object.values(row).includes(null))) {
		db.run(
			`DELETE FROM status_cards WHERE status_id IN (SELECT status_id FROM status_cards INDEXED BY ${CARD_DUE_INDEX}
				WHERE due_at <= ?1 ORDER BY due_at, status_id LIMIT ${CARD_CLAIM_WALK})
			AND (${STATUS_ID_SQL} IS NULL OR ${cardUrlPastSql('url', false)} OR ${cardCountSql('attempts', CARD_MAX_ATTEMPTS)} IS NULL
				OR ${cardCountSql('claim')} IS NULL OR ${cardCountSql('generation')} IS NULL OR ${cardCountSql('enqueued_at')} IS NULL)`,
			now
		)
	}
	for (const row of walk) {
		const { id, url, attempts, claim, generation, enqueued } = row
		if (
			id === null ||
			url === null ||
			attempts === null ||
			claim === null ||
			generation === null ||
			enqueued === null
		) {
			continue
		}
		if (attempts >= CARD_MAX_ATTEMPTS) {
			out.givenUp++
			deleteCard(db, id)
			continue
		}
		if (
			enqueued < cutoff ||
			claim + 1 > SAFE_INTEGER_MAX ||
			db.first(`SELECT ${cardEligibleSql('?1')} AS e`, id)?.e !== 1
		) {
			deleteCard(db, id)
			continue
		}
		// AM17: an existence-gated copy of the target's own row from one donor; no donor writes nothing.
		const copied = db.run(
			`UPDATE status_cards SET ${CARD_FIELDS.map((f) => `${f} = d.${f}`).join(', ')}, due_at = NULL, attempts = 0
			FROM (SELECT ${CARD_FIELDS.map((f) => `f.${f}`).join(', ')}
				FROM status_cards t CROSS JOIN status_cards f INDEXED BY ${CARD_FRESH_INDEX} ON f.url = t.url
				WHERE t.status_id = ?1 AND CAST(f.url AS BLOB) = CAST(t.url AS BLOB) AND f.fetched_at > ?2
				ORDER BY f.fetched_at DESC LIMIT 1) d
			WHERE status_cards.status_id = ?1`,
			id,
			now - CARD_FRESH_MS
		)
		if (copied > 0) {
			out.attached++
			continue
		}
		// AM18: another row's open hold on the URL, by the claimed index's exact predicate and a seek on due_at.
		const held = db.first<{ until: number }>(
			`SELECT h.due_at AS until FROM status_cards t
				CROSS JOIN status_cards h INDEXED BY ${CARD_CLAIMED_INDEX} ON h.url = t.url AND h.attempts > 0 AND h.due_at > ?2
			WHERE t.status_id = ?1 AND CAST(h.url AS BLOB) = CAST(t.url AS BLOB) AND h.status_id <> t.status_id
			LIMIT 1`,
			id,
			now
		)
		if (held !== undefined) {
			db.run('UPDATE status_cards SET due_at = ?2 WHERE status_id = ?1', id, held.until)
			out.deferred++
			continue
		}
		const token = db.first<{ token: number }>(
			`UPDATE status_cards SET claim = claim + 1, attempts = attempts + 1, due_at = ?2 WHERE status_id = ?1
			RETURNING claim AS token`,
			id,
			now + CARD_HOLD_MS
		)!.token
		out.claims.push({ statusId: id, token, generation, url })
		if (out.claims.length >= CARD_ROUND_CLAIMS) {
			break
		}
	}
	return out
})

// The card's fields a round extracted (federation/link-details.ts LinkDetails).
export type CardFields = {
	title: string
	description: string
	authorName: string
	authorUrl: string
	providerName: string
	providerUrl: string
	language: string | null
	publishedAt: string | null
}

export type CardOutcome = { kind: 'card'; fields: CardFields } | { kind: 'none' } | { kind: 'unattempted' }

export type CardFence = { statusId: string; token: number; generation: number }

// Whether the claim `fence` names is still open on a pending row of an eligible status (see the module's head).
const FENCE = `status_id = ?1 AND claim = ?2 AND generation = ?3 AND attempts > 0 AND fetched_at IS NULL
	AND ${cardEligibleSql('?1')}`

// A text as stored: storedText's output cut to its JSON bound (security/html.ts cutJsonString), never refused; '' for
// a value that is not a string.
export function storedCardText(value: unknown, jsonBytes: number): string {
	return typeof value === 'string' ? cutJsonString(storedText(value), jsonBytes) : ''
}

// A string within `limit` code units, else '' (the SQL rule then judges it).
function boundedString(value: unknown, limit: number): string {
	return typeof value === 'string' && value.length <= limit ? value : ''
}

// The outcome of one claim, under its fence. A card's texts are stored by storedCardText; an optional URL, the
// language and the publication time the triggers would refuse are dropped by the triggers' own rules
// (cardUrlPastSql, cardLanguagePastSql, isoTimeSql), and a title they refuse or that is empty means no card.
export const recordCard = writeOperation<CardFence & { outcome: CardOutcome; now: number }, { held: boolean }>(
	(db, input) => {
		const { statusId, token, generation, now } = input
		const outcome: CardOutcome =
			typeof input.outcome === 'object' && input.outcome !== null ? input.outcome : { kind: 'none' }
		if (
			typeof statusId !== 'string' ||
			![token, generation, now].every((n) => Number.isSafeInteger(n) && n >= 0) ||
			db.first(`SELECT 1 AS x FROM status_cards WHERE ${FENCE}`, statusId, token, generation) === undefined
		) {
			return { held: false }
		}
		if (outcome.kind === 'unattempted') {
			db.run('UPDATE status_cards SET due_at = ?2, attempts = attempts - 1 WHERE status_id = ?1', statusId, now)
			return { held: true }
		}
		const fields = outcome.kind === 'card' && typeof outcome.fields === 'object' ? outcome.fields : null
		const texts = {
			title: storedCardText(fields?.title, CARD_TEXTS.title),
			description: storedCardText(fields?.description, CARD_TEXTS.description),
			author_name: storedCardText(fields?.authorName, CARD_TEXTS.author_name),
			provider_name: storedCardText(fields?.providerName, CARD_TEXTS.provider_name),
		}
		const attached =
			fields !== null &&
			db.run(
				`UPDATE status_cards SET title = ?4, description = ?5, author_name = ?6, provider_name = ?7,
					author_url = CASE WHEN ${cardUrlPastSql('?8', true)} THEN '' ELSE ?8 END,
					provider_url = CASE WHEN ${cardUrlPastSql('?9', true)} THEN '' ELSE ?9 END,
					language = CASE WHEN ${cardLanguagePastSql('?10')} THEN NULL ELSE ?10 END,
					published_at = ${isoTimeSql('?11')}, fetched_at = ?12, due_at = NULL, attempts = 0
				WHERE ${FENCE} AND ?4 <> '' AND NOT (${cardTextPastSql('?4', CARD_TEXTS.title)})
					AND NOT (${cardTextPastSql('?5', CARD_TEXTS.description)})
					AND NOT (${cardTextPastSql('?6', CARD_TEXTS.author_name)})
					AND NOT (${cardTextPastSql('?7', CARD_TEXTS.provider_name)})`,
				statusId,
				token,
				generation,
				texts.title,
				texts.description,
				texts.author_name,
				texts.provider_name,
				boundedString(fields.authorUrl, CARD_URL_LIMIT),
				boundedString(fields.providerUrl, CARD_URL_LIMIT),
				typeof fields.language === 'string' && fields.language.length <= 16 ? fields.language : null,
				typeof fields.publishedAt === 'string' && fields.publishedAt.length <= 32 ? fields.publishedAt : null,
				now
			) > 0
		if (!attached) {
			deleteCard(db, statusId)
		}
		return { held: true }
	}
)

// The domain policy for one hop of the round's fetches (instance-domain-blocks.ts hostCovered), as a write so the
// Store refuses it in any maintenance, read-only included, and during a dump or import (AM4).
export const cardHopRefused = writeOperation<{ host: string }, boolean>((db, { host }) =>
	typeof host === 'string' && host.length <= CARD_HOST_LIMIT ? hostCovered(db, host) : true
)
