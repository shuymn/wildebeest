import { acctOf, type Present } from './accounts'
import { accessAdminRefusal } from './admin-authority'
import { ARRAY_ANSWER_BYTES } from './answer-budget'
import { availableSql, statusReads, trendableStatusSql } from './audience'
import { optionalUserReadOperation } from './auth'
import { logAction } from './moderation-log'
import { readOperation, writeOperation } from './operation'
import { USERNAME_LIMIT, usernameSql } from './profile-bounds'
import { MAX_STATUS_TAGS, tagNameSql } from './status-bounds'
import {
	type CardRow,
	presentation,
	presentCard,
	presentStatusesWithin,
	type PreviewCard,
	type Status,
} from './status-presenter'
import { CARD_COLUMN_MAP } from './status-rows'
import {
	historyDays,
	idOfBytes,
	presentTags,
	type Tag,
	type TagHistory,
	tagHistory,
	tagId,
	tagKey,
	tagName,
	TREND_HISTORY_ROWS,
} from './tags'
import { type ColumnMap, selectSql } from '../db/columns'
import { STATUSES_ID_INDEX } from '../db/indexes'
import { type Db, ROW_OBJECT_BYTES, RowMeter, VALUE_BYTES } from '../db/sql'
import { blockedDomain, normalizeDomain } from '../platform/domain-name'
import { fromHex } from '../platform/dump-literals'
import { DOMAIN_BYTES } from '../platform/identity-bounds'
import { railsBlankSql } from '../platform/rails-blank'
import type { ImportAuthority } from '../platform/store-admin'
import {
	byteBoundSql,
	byteCut,
	CARD_LANGUAGE_BYTES,
	CARD_PUBLIC_LINK_INDEX,
	CARD_TEXTS,
	CARD_TYPES,
	CARD_URL_LIMIT,
	cardUrlPastSql,
	isoTimeSql,
	LINK_DOMAIN_BYTES,
	LINK_TYPES,
	MAX_TREND_LINKS,
	presentedCardText,
	PUBLIC_BOOSTS_INDEX,
	storedLinkDomain,
	TREND_LINKS_LISTED_INDEX,
	MAX_TREND_REVIEWS,
	MAX_TREND_TAGS,
	MAX_TREND_STATUSES,
	TREND_ALLOWED_ROWS,
	TREND_REVIEW_POOL,
	TREND_SCORE_MAX,
	TREND_STATUSES_PER_AUTHOR,
	statusUrlSql,
	TREND_TAG_NAME_BYTES,
	TREND_TAG_NAME_LENGTH,
	trendTagNameCheckSql,
} from '../platform/stored-bounds'
import { cutCodeUnits, remotePlainText } from '../security/html'

// Trends (migrations 0057_trends and 0071_link_trends), as Mastodon 4.5 works them out (app/models/trends/
// {tags,statuses,links}.rb): the hashtags, statuses and links that trend, scored every 5 minutes by the cron's round
// (jobs/scheduled.ts trendsRound) from what the Store holds, listed by GET /api/v1/trends/tags, /statuses and /links
// (mastodon/trends.ts), and reviewed by the Access admin (app/admin.ts /admin/trends, `kopje-admin trends`). The only
// module that reads or writes trend_tags, trend_statuses, trend_links, tag_trend_reviews, status_trend_reviews,
// account_trend_reviews, link_trend_reviews and link_provider_reviews, and a reader of status_cards that writes none
// (test-node/policy-boundary.test.ts).
//
// R41 (docs/visibility.md): a listed status passes trendableStatusSql (audience.ts) and, for a signed-in viewer, the
// list rule (R8); hashtags count public originals of available accounts only, links public plain originals and their
// public boosts by available accounts (VIS-12); a listed link shows its qualifying public copy's card. Deviations:
// MD-5 (docs/mastodon-deviations.md).

// SUPPORTED_LOCALES of Mastodon's LanguagesHelper (app/helpers/languages_helper.rb:4-226): ISO_639_1 (184 keys),
// ISO_639_1_REGIONAL (4) and ISO_639_3 (22), the languages a status may trend in (valid_locale?). Not the list of
// GET /api/v1/instance/languages, nor the Accept-Language preference.
export const TREND_LANGUAGES: ReadonlySet<string> = new Set([
	...'aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo'.split(
		' '
	),
	...'es et eu fa ff fi fj fo fr fy ga gd gl gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki'.split(
		' '
	),
	...'kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mn-Mong mr ms ms-Arab mt my na nb'.split(
		' '
	),
	...'nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sn so sq sr ss st'.split(
		' '
	),
	...'su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu'.split(' '),
	...'zh-CN zh-HK zh-TW zh-YUE'.split(' '),
	...'ast chr ckb cnr csb gsw jbo kab ldn lfn moh nds pdc sco sma smj szl tok vai xal zba zgh'.split(' '),
])

// The parameter value trendableStatusSql's `langs` takes.
export const TREND_LANGUAGES_JSON = JSON.stringify([...TREND_LANGUAGES])

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

// Paging (Api::V1::Trends::TagsController DEFAULT_TAGS_LIMIT, Api::BaseController DEFAULT_STATUSES_LIMIT; at most twice
// each, limit_param).
export const TREND_TAGS_LIMIT = 10
export const TREND_TAGS_MAX_LIMIT = 20
export const TREND_STATUSES_LIMIT = 20
export const TREND_STATUSES_MAX_LIMIT = 40
// Trends::Tags and Trends::Statuses default_options (app/models/trends/tags.rb:8-14, statuses.rb:8-13).
export const TAG_THRESHOLD = 5
export const TAG_COOLDOWN_MS = 2 * DAY_MS
export const TAG_HALFLIFE_MS = 4 * HOUR_MS
export const TAG_DECAY_THRESHOLD = 1
export const STATUS_THRESHOLD = 5
export const STATUS_HALFLIFE_MS = HOUR_MS
export const STATUS_DECAY_THRESHOLD = 0.3
// The round's windows (RES-7, MD-5): the newest TREND_WINDOW public originals with ids from yesterday 00:00 UTC; at
// most MAX_STATUS_TAGS hashtag rows of each and TREND_TAG_ROWS in all, cut raw before any rule; the
// TREND_TAG_CANDIDATES hashtags with the most accounts today; the TREND_STATUS_CANDIDATES statuses with the most boosts
// and favourites, counted up to TREND_OBSERVED_MAX. A trending hashtag's history counts at most its newest
// TREND_HISTORY_ROWS public statuses of the 7 days.
export const TREND_WINDOW = 4000
export const TREND_TAG_ROWS = 8000
export const TREND_TAG_CANDIDATES = 400
export const TREND_TAG_GROUPS = TREND_TAG_ROWS / TAG_THRESHOLD
export const TREND_STATUS_CANDIDATES = 400
export const TREND_OBSERVED_MAX = 10_000_000

// Trends::Links default_options (links.rb:8-14); review_threshold is unused (no e-mail, MD-5).
export const LINK_THRESHOLD = 5
export const LINK_COOLDOWN_MS = 2 * DAY_MS
export const LINK_HALFLIFE_MS = 8 * HOUR_MS
export const LINK_DECAY_THRESHOLD = 1
// The round's link windows (RES-7, MD-5): the public boosts read (TREND_LINK_BOOSTS, TREND_LINK_BOOSTS_PER_STATUS of
// each original), the TREND_LINK_CANDIDATES links with the most accounts today, and the TREND_LINK_COPIES newest
// public copies of a link its qualifying copy is chosen among. At most TREND_WINDOW + TREND_LINK_BOOSTS contributions
// make at most TREND_LINK_GROUPS groups of LINK_THRESHOLD accounts today.
export const TREND_LINK_BOOSTS = 4000
export const TREND_LINK_BOOSTS_PER_STATUS = 100
export const TREND_LINK_CANDIDATES = 400
export const TREND_LINK_COPIES = 8
export const TREND_LINK_GROUPS = (TREND_WINDOW + TREND_LINK_BOOSTS) / LINK_THRESHOLD
// A link's history (D6, MD-5): its newest LINK_HISTORY_ORIGINALS public copies of the 7 days, at most
// LINK_HISTORY_BOOSTS_PER_STATUS public boosts of each, LINK_HISTORY_BOOSTS of them in all.
export const LINK_HISTORY_ORIGINALS = 200
export const LINK_HISTORY_BOOSTS_PER_STATUS = 20
export const LINK_HISTORY_BOOSTS = 200
// Paging (Api::V1::Trends::LinksController DEFAULT_LINKS_LIMIT, at most twice it).
export const TREND_LINKS_LIMIT = 10
export const TREND_LINKS_MAX_LIMIT = 20

// The id of a time (domain/ids.ts: the milliseconds in the high bits), as TEXT; never a JavaScript number.
function idOf(ms: number): string {
	return (BigInt(ms) << 16n).toString()
}

function iso(ms: number): string {
	return new Date(ms).toISOString()
}

function day(ms: number): string {
	return iso(ms).slice(0, 10)
}

// ---- Settings (Mastodon's `trends` and `trendable_by_default`, config/settings.yml:23-24): on, and off by default.

export type TrendSettings = { trends: boolean; trendable_by_default: boolean }

export function trendSettings(db: Db): TrendSettings {
	const rows = db.all<{ name: string; value: string | null }>(
		`SELECT name, CASE WHEN value IN ('true', 'false') THEN value END AS value FROM instance_settings
		WHERE name IN ('trends', 'trendable_by_default')`
	)
	const of = (name: string) => rows.find((row) => row.name === name)?.value ?? null
	return { trends: of('trends') !== 'false', trendable_by_default: of('trendable_by_default') === 'true' }
}

// ---- Allowance (Tag#trendable?, Status#trendable?, Account#trendable?): judged in the round and on every read.

// Tag.reviewed (Reviewable: reviewed_at set): whether the hashtag named by `name` (an SQL expression of a stored name)
// has a review, approved or rejected. One primary-key probe; names are compared as stored, in SQL.
export function tagReviewedSql(name: string): string {
	return `EXISTS (SELECT 1 FROM tag_trend_reviews r WHERE r.name = ${name})`
}

// Whether the trend_tags row `t` is allowed: its review, else `byDefault` (an expression, 0 or 1).
export function trendAllowedTagSql(t: string, byDefault: string): string {
	return `coalesce((SELECT r.trendable FROM tag_trend_reviews r WHERE r.name = ${t}.name), ${byDefault}) = 1`
}

// Whether the trend_statuses row `t` is allowed: the status's review, else its author's, else `byDefault`.
export function trendAllowedStatusSql(t: string, byDefault: string): string {
	return `coalesce((SELECT r.trendable FROM status_trend_reviews r WHERE r.status_id = ${t}.status_id),
		(SELECT r.trendable FROM account_trend_reviews r WHERE r.account_id = ${t}.account_id), ${byDefault}) = 1`
}

// ---- The round (jobs/scheduled.ts, every 5 minutes), in one transaction (RES-6: at most MAX_TREND_TAGS +
// MAX_TREND_STATUSES rows deleted and as many written).

// Strict UTF-8: a stored name whose bytes are not well-formed never trends (it could not be named back by its text).
const STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// The row heap (db/sql.ts rowHeapBytes: 64 bytes a row, 32 a value, two a code unit of text) the round's reads take
// at most, from each column's maximum: the hashtag groups (TREND_TAG_GROUPS, a hex key of 2 × TREND_TAG_NAME_BYTES and
// three numbers each), the stored ones (a key, two numbers and a time), the stored status ids, the status candidates
// (two ids, three numbers and a time), the link candidates (a URL of CARD_URL_LIMIT ASCII bytes, two counts and a
// language of CARD_LANGUAGE_BYTES), their reviews (two integers) and the stored links (a URL, a domain of
// LINK_DOMAIN_BYTES, two numbers, a time and a language). test/trends-bounds.test.ts builds those rows and measures
// them.
const ROW = (values: number, units: number) => ROW_OBJECT_BYTES + VALUE_BYTES * values + 2 * units
const ROUND_ROWS_HEAP =
	TREND_TAG_GROUPS * ROW(4, 2 * TREND_TAG_NAME_BYTES) +
	MAX_TREND_TAGS * ROW(4, 2 * TREND_TAG_NAME_BYTES + 24) +
	MAX_TREND_STATUSES * ROW(1, 18) +
	(TREND_STATUS_CANDIDATES + MAX_TREND_STATUSES) * ROW(6, 18 + 18 + 24) +
	TREND_LINK_CANDIDATES * ROW(4, CARD_URL_LIMIT + CARD_LANGUAGE_BYTES) +
	TREND_LINK_CANDIDATES * ROW(2, 0) +
	MAX_TREND_LINKS * ROW(6, CARD_URL_LIMIT + LINK_DOMAIN_BYTES + 24 + CARD_LANGUAGE_BYTES)
// The RowMeter cap of the round's reads; tests lower it to see the backstop act.
export const TREND_ROW_CAPS = { round: ROUND_ROWS_HEAP }

type TagCandidate = { key: string; today: number; yesterday: number; review: number | null }
type StoredTag = { key: string; max_score: number; max_score_at: string; review: number | null }

// The hashtags of the window with today's and yesterday's accounts (distinct authors per publication day, R1), every
// one with TAG_THRESHOLD or more today, the most first (ties by key): at most TREND_TAG_GROUPS, since each takes that
// many of the TREND_TAG_ROWS raw rows (the LIMIT states the bound). candidateTags keeps the first TREND_TAG_CANDIDATES
// whose names are representable. Both CTEs are materialized, so the window and the raw rows are cut before any rule is
// applied: a status's first MAX_STATUS_TAGS rows by name, TREND_TAG_ROWS in all, whatever they hold. Then: public rows,
// names within the bound and the name rule, published today or yesterday and by `now`, by available authors. The
// membership read of `x.name` presents nothing.
function tagGroups(db: Db, now: number): TagCandidate[] {
	const today = day(now)
	const yesterday = day(now - DAY_MS)
	return db.all<TagCandidate>(
		`WITH w AS MATERIALIZED (
			SELECT s.id, s.account_id, ${isoTimeSql('s.published_at')} AS published_at
			FROM statuses s INDEXED BY statuses_public
			WHERE s.visibility = 'public' AND s.reblog_of_id IS NULL AND s.id >= ?1 ORDER BY s.id DESC LIMIT ${TREND_WINDOW}),
		r AS MATERIALIZED (
			SELECT CAST(${tagNameSql('t.name')} AS BLOB) AS key, t.public, w.account_id, w.published_at
			FROM w CROSS JOIN status_tags t ON t.status_id = w.id
				AND t.name IN (SELECT x.name FROM status_tags x WHERE x.status_id = w.id ORDER BY x.name LIMIT ${MAX_STATUS_TAGS})
			LIMIT ${TREND_TAG_ROWS}),
		ok AS (SELECT a.account_id FROM (SELECT DISTINCT account_id FROM r) a WHERE ${availableSql('a.account_id')}),
		g AS (
			SELECT key, count(DISTINCT CASE WHEN substr(published_at, 1, 10) = ?2 THEN account_id END) AS today,
				count(DISTINCT CASE WHEN substr(published_at, 1, 10) = ?3 THEN account_id END) AS yesterday
			FROM r
			WHERE public = 1 AND key IS NOT NULL AND published_at <= ?4 AND substr(published_at, 1, 10) IN (?2, ?3)
				AND ${trendTagNameCheckSql('CAST(key AS TEXT)')} AND account_id IN (SELECT account_id FROM ok)
			GROUP BY key)
		SELECT hex(key) AS key, today, yesterday,
			(SELECT v.trendable FROM tag_trend_reviews v WHERE v.name = CAST(g.key AS TEXT)) AS review
		FROM g WHERE today >= ${TAG_THRESHOLD} ORDER BY today DESC, key LIMIT ${TREND_TAG_GROUPS}`,
		idOf(now - (now % DAY_MS) - DAY_MS),
		today,
		yesterday,
		iso(now)
	)
}

// A decaying trend's options (Trends::Tags and Trends::Links default_options): the accounts today it needs, the time a
// peak is kept, its half-life, and the decayed score it is listed from.
type Decay = { threshold: number; cooldownMs: number; halfLifeMs: number; decayThreshold: number }
const TAG_DECAY: Decay = {
	threshold: TAG_THRESHOLD,
	cooldownMs: TAG_COOLDOWN_MS,
	halfLifeMs: TAG_HALFLIFE_MS,
	decayThreshold: TAG_DECAY_THRESHOLD,
}

// Trends::Tags#calculate_scores and Trends::Links#calculate_scores (app/models/trends/tags.rb:96-127,
// links.rb:104-140): (observed - expected)² / expected from `threshold` accounts today, a new peak kept for
// `cooldownMs`, halved every `halfLifeMs` from its time; the elapsed time clamped at 0 (an imported future peak decays
// from now), so the decayed score never passes the peak. `supported` false (a link's language outside
// TREND_LANGUAGES, links.rb:126) makes the decayed score 0 while the peak is still kept.
export function scoreDecaying(
	observed: number,
	yesterday: number,
	peak: { max: number; at: number } | null,
	now: number,
	decay: Decay,
	supported = true
) {
	const expected = Math.max(yesterday, 1)
	const score =
		observed < decay.threshold || expected > observed
			? 0
			: Math.min((observed - expected) ** 2 / expected, TREND_SCORE_MAX)
	let max = peak === null || peak.at < now - decay.cooldownMs ? 0 : peak.max
	let at = peak === null ? now : Math.min(peak.at, now)
	if (score > max) {
		max = score
		at = now
	}
	const decayed = supported ? max * 0.5 ** (Math.max(now - at, 0) / decay.halfLifeMs) : 0
	return { score: Math.min(decayed, max), max, at }
}

// A scored row of a decaying trend (hashtags, links): its key as the table compares it, its score, peak and the
// peak's time, its review (1 allowed, 0 rejected, null none) and whether the table holds it.
type ScoredRow = { key: string; score: number; max: number; at: string; review: number | null; stored: boolean }

// The rows kept of `scored` (RES-4): those listed (decayed to the decay threshold or more) or with a peak within the
// cooldown; of them TREND_ALLOWED_ROWS allowed ones (listed rows by score, then the others by their peak's time) and
// TREND_REVIEW_POOL others (unreviewed before rejected, each by score). Rows not allowed never take an allowed row's
// place.
export function keepPools<T extends ScoredRow>(
	scored: readonly T[],
	now: number,
	decay: Decay,
	allowed: (row: T) => boolean
): T[] {
	const listed = (t: T) => t.score >= decay.decayThreshold
	const survivors = scored.filter((t) => listed(t) || (t.max > 0 && Date.parse(t.at) >= now - decay.cooldownMs))
	const byKey = (a: T, b: T) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
	const allowedPool = survivors
		.filter(allowed)
		.sort((a, b) => {
			const first = Number(listed(b)) - Number(listed(a))
			if (first !== 0) {
				return first
			}
			return listed(a) ? b.score - a.score || byKey(a, b) : Date.parse(b.at) - Date.parse(a.at) || byKey(a, b)
		})
		.slice(0, TREND_ALLOWED_ROWS)
	const reviewPool = survivors
		.filter((t) => !allowed(t))
		.sort((a, b) => Number(a.review !== null) - Number(b.review !== null) || b.score - a.score || byKey(a, b))
		.slice(0, TREND_REVIEW_POOL)
	return [...allowedPool, ...reviewPool]
}

// A decaying trend's table: its key column, the SQL of a row's key as kept rows spell it (`keyOf`) and of the stored
// key from that spelling (`stored`), and the other columns written with each row.
type TrendTable<T> = {
	name: 'trend_tags' | 'trend_links'
	keyColumn: string
	keyOf: string
	stored: (spelled: string) => string
	columns: readonly string[]
	values: (row: T) => SqlStorageValue[]
}

// The kept rows written: deletes of the others, then updates of stored keys, then inserts of new keys, so no cap
// trigger fires (0057_trends, 0071_link_trends); at most MAX_TREND_TAGS (MAX_TREND_LINKS) rows each (RES-6).
function writeTrendRows<T extends ScoredRow>(db: Db, table: TrendTable<T>, kept: readonly T[]): void {
	db.run(
		`DELETE FROM ${table.name} WHERE ${table.keyOf} NOT IN (SELECT value FROM json_each(?1))`,
		JSON.stringify(kept.map((t) => t.key))
	)
	const extra = table.columns.map((column, i) => `, ${column} = ?${i + 5}`).join('')
	for (const t of kept.filter((t) => t.stored)) {
		db.run(
			`UPDATE ${table.name} SET score = ?1, max_score = ?2, max_score_at = ?3${extra}
			WHERE ${table.keyColumn} = ${table.stored('?4')}`,
			t.score,
			t.max,
			t.at,
			t.key,
			...table.values(t)
		)
	}
	const fresh = kept.filter((t) => !t.stored)
	if (fresh.length > 0) {
		const columns = table.columns.map((column) => `, ${column}`).join('')
		const values = table.columns.map((_column, i) => `, json_extract(value, '$.x[${i}]')`).join('')
		db.run(
			`INSERT INTO ${table.name} (${table.keyColumn}, score, max_score, max_score_at${columns})
			SELECT ${table.stored("json_extract(value, '$.k')")}, json_extract(value, '$.s'), json_extract(value, '$.m'),
				json_extract(value, '$.a')${values}
			FROM json_each(?1)`,
			JSON.stringify(fresh.map((t) => ({ k: t.key, s: t.score, m: t.max, a: t.at, x: table.values(t) })))
		)
	}
}

const TAG_TABLE: TrendTable<ScoredRow> = {
	name: 'trend_tags',
	keyColumn: 'name',
	keyOf: 'hex(name)',
	stored: (spelled) => `CAST(unhex(${spelled}) AS TEXT)`,
	columns: [],
	values: () => [],
}

// The TREND_TAG_CANDIDATES groups with the most accounts today whose names are representable (nameOf), so a key that
// is not well-formed UTF-8 or not in its own normalized form never takes a candidate's place.
export function candidateTags(db: Db, now: number): TagCandidate[] {
	return tagGroups(db, now)
		.filter((c) => nameOf(c.key) !== null)
		.slice(0, TREND_TAG_CANDIDATES)
}

function roundTags(db: Db, now: number, byDefault: boolean): number {
	const candidates = new Map(candidateTags(db, now).map((c) => [c.key, c]))
	const stored = db.all<StoredTag>(
		`SELECT hex(t.name) AS key, t.max_score, t.max_score_at,
			(SELECT r.trendable FROM tag_trend_reviews r WHERE r.name = t.name) AS review
		FROM trend_tags t`
	)
	const scored: ScoredRow[] = []
	const seen = new Set<string>()
	for (const row of stored) {
		seen.add(row.key)
		if (nameOf(row.key) === null) {
			continue
		}
		const candidate = candidates.get(row.key)
		const peak = { max: row.max_score, at: Date.parse(row.max_score_at) }
		const { score, max, at } = scoreDecaying(candidate?.today ?? 0, candidate?.yesterday ?? 0, peak, now, TAG_DECAY)
		scored.push({ key: row.key, score, max, at: iso(at), review: row.review, stored: true })
	}
	for (const candidate of candidates.values()) {
		if (seen.has(candidate.key)) {
			continue
		}
		const { score, max, at } = scoreDecaying(candidate.today, candidate.yesterday, null, now, TAG_DECAY)
		scored.push({ key: candidate.key, score, max, at: iso(at), review: candidate.review, stored: false })
	}
	const kept = keepPools(scored, now, TAG_DECAY, (t) => (t.review ?? (byDefault ? 1 : 0)) === 1)
	writeTrendRows(db, TAG_TABLE, kept)
	return kept.length
}

type StatusCandidate = {
	id: string
	account_id: string
	observed: number
	published_at: string
	status_review: number | null
	account_review: number | null
}

// What the round reads of a trend status, with its reviews.
const STATUS_COLUMNS = `s.id, s.account_id, min(s.reblogs_count + s.favourites_count, ${TREND_OBSERVED_MAX}) AS observed,
	${isoTimeSql('s.published_at')} AS published_at,
	(SELECT v.trendable FROM status_trend_reviews v WHERE v.status_id = s.id) AS status_review,
	(SELECT v.trendable FROM account_trend_reviews v WHERE v.account_id = s.account_id) AS account_review`

// The window's TREND_STATUS_CANDIDATES statuses with the most boosts and favourites (TREND_OBSERVED_MAX at most, ties
// by id), of those with STATUS_THRESHOLD or more, then those trendableStatusSql passes; and the stored rows, scored
// again, while it passes them.
function statusCandidates(db: Db, now: number): StatusCandidate[] {
	const window = db.all<StatusCandidate>(
		`SELECT ${STATUS_COLUMNS} FROM (
			SELECT s.id FROM (SELECT id FROM statuses INDEXED BY statuses_public
					WHERE visibility = 'public' AND reblog_of_id IS NULL AND id >= ?1 ORDER BY id DESC LIMIT ${TREND_WINDOW}) w
				CROSS JOIN statuses s ON s.id = w.id
			WHERE s.reblogs_count + s.favourites_count >= ${STATUS_THRESHOLD}
			ORDER BY min(s.reblogs_count + s.favourites_count, ${TREND_OBSERVED_MAX}) DESC, s.id DESC
			LIMIT ${TREND_STATUS_CANDIDATES}) c
		CROSS JOIN statuses s ON s.id = c.id WHERE ${trendableStatusSql('s', '?2', '?3')}`,
		idOf(now - (now % DAY_MS) - DAY_MS),
		iso(now),
		TREND_LANGUAGES_JSON
	)
	const stored = db.all<StatusCandidate>(
		`SELECT ${STATUS_COLUMNS} FROM trend_statuses t CROSS JOIN statuses s ON s.id = t.status_id
		WHERE ${trendableStatusSql('s', '?1', '?2')}`,
		iso(now),
		TREND_LANGUAGES_JSON
	)
	const ids = new Set(window.map((c) => c.id))
	return [...window, ...stored.filter((c) => !ids.has(c.id))]
}

// Trends::Statuses#calculate_scores (app/models/trends/statuses.rb:117-142): (observed - 1)² halved every hour of age,
// the age clamped at 0.
function scoreStatus(observed: number, publishedAt: string, now: number): number {
	if (observed < STATUS_THRESHOLD) {
		return 0
	}
	const age = Math.max(now - Date.parse(publishedAt), 0)
	return Math.min((observed - 1) ** 2 * 0.5 ** (age / STATUS_HALFLIFE_MS), TREND_SCORE_MAX)
}

function roundStatuses(db: Db, now: number, byDefault: boolean): number {
	const storedIds = new Set(db.all<{ id: string }>('SELECT status_id AS id FROM trend_statuses').map((r) => r.id))
	const scored = statusCandidates(db, now)
		.map((c) => ({
			...c,
			score: scoreStatus(c.observed, c.published_at, now),
			reviewed: c.status_review !== null || c.account_review !== null,
			allowed: (c.status_review ?? c.account_review ?? (byDefault ? 1 : 0)) === 1,
		}))
		.filter((c) => c.score >= STATUS_DECAY_THRESHOLD)
		.sort((a, b) => b.score - a.score || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
	type Scored = (typeof scored)[number]
	// Each author's maximum (StatusTrend.allowed lists the author's top-scoring rows that are allowed): the rows tied at
	// it are its top group, met first. Its witness is the first allowed row of the group, else its first unreviewed row,
	// else its first row. Witnesses fill the pools first, then the other rows of authors whose witness was kept, so the
	// stored maximum is always the author's real one and an approved maximum is never pushed out by its unreviewed ties;
	// TREND_STATUSES_PER_AUTHOR rows at most. Each pool takes allowed rows by score; the review pool takes unreviewed
	// rows before rejected ones, each by score, as the hashtags' does.
	const byAuthor = new Map<string, Scored[]>()
	for (const c of scored) {
		byAuthor.set(c.account_id, [...(byAuthor.get(c.account_id) ?? []), c])
	}
	const witnesses = new Set<Scored>()
	for (const rows of byAuthor.values()) {
		const top = rows.filter((c) => c.score === rows[0]!.score)
		witnesses.add(top.find((c) => c.allowed) ?? top.find((c) => !c.reviewed) ?? top[0]!)
	}
	const order = (a: Scored, b: Scored) =>
		Number(a.reviewed) - Number(b.reviewed) || b.score - a.score || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
	const pools = { allowed: 0, review: 0 }
	const perAuthor = new Map<string, number>()
	const kept: Scored[] = []
	const fill = (rows: Scored[]) => {
		const allowed = rows.filter((c) => c.allowed)
		const review = rows.filter((c) => !c.allowed).sort(order)
		for (const [pool, list, cap] of [
			['allowed', allowed, TREND_ALLOWED_ROWS],
			['review', review, TREND_REVIEW_POOL],
		] as const) {
			for (const c of list) {
				const count = perAuthor.get(c.account_id) ?? 0
				if (pools[pool] >= cap || count >= TREND_STATUSES_PER_AUTHOR) {
					continue
				}
				pools[pool]++
				perAuthor.set(c.account_id, count + 1)
				kept.push(c)
			}
		}
	}
	fill(scored.filter((c) => witnesses.has(c)))
	fill(scored.filter((c) => !witnesses.has(c) && perAuthor.has(c.account_id)))
	db.run(
		'DELETE FROM trend_statuses WHERE status_id NOT IN (SELECT value FROM json_each(?1))',
		JSON.stringify(kept.map((c) => c.id))
	)
	for (const c of kept.filter((c) => storedIds.has(c.id))) {
		db.run('UPDATE trend_statuses SET score = ?1 WHERE status_id = ?2', c.score, c.id)
	}
	const fresh = kept.filter((c) => !storedIds.has(c.id))
	if (fresh.length > 0) {
		db.run(
			`INSERT INTO trend_statuses (status_id, account_id, score)
			SELECT json_extract(value, '$.i'), json_extract(value, '$.a'), json_extract(value, '$.s') FROM json_each(?1)`,
			JSON.stringify(fresh.map((c) => ({ i: c.id, a: c.account_id, s: c.score })))
		)
	}
	return kept.length
}

// ---- Links (Trends::Links, app/models/trends/links.rb; migration 0071_link_trends)
//
// A link is a card's final URL (status_cards.final_url, D2). It is counted from the public originals of the round's
// window (TREND_WINDOW) whose public copy (status_cards_public_link: public, attached, with a final URL; the triggers
// hold that membership, D4) names it, with at most TREND_LINK_BOOSTS_PER_STATUS of the public boosts of each since
// yesterday 00:00 UTC (statuses_public_boosts), TREND_LINK_BOOSTS in all, each cut raw before any rule. A post
// counts its author, a boost its booster, on its publication day, when the original is plain (no content warning,
// not sensitive) and both accounts are available (VIS-12). A link is eligible while it has a qualifying copy
// (trendCopySql, D7); every counted post of an eligible link counts, whatever its own copy looks like.

const LINK_DECAY: Decay = {
	threshold: LINK_THRESHOLD,
	cooldownMs: LINK_COOLDOWN_MS,
	halfLifeMs: LINK_HALFLIFE_MS,
	decayThreshold: LINK_DECAY_THRESHOLD,
}

// A content warning as the trends read it (trendableStatusSql's): blank by ASCII white space.
const plainSpoilerSql = (column: string) => `trim(${column}, ' ' || char(9, 10, 11, 12, 13)) = ''`

// The public copies of the link `u` (an SQL expression of a final URL) by the public link index: the membership the
// triggers hold, so every id read is a public status's.
const publicCopiesSql = (c: string, u: string) => `${c}.final_url = ${u} AND ${c}.public = 1
	AND ${c}.fetched_at IS NOT NULL AND ${c}.final_url <> ''`

// D7: the qualifying copy of the link `u`, its status id or NULL: the first, newest status first, of the link's first
// TREND_LINK_COPIES public copies (raw, by the public link index) that is a link card (Mastodon's
// appropriate_for_trends?: a link, an article, non-blank title, description and provider name, an image) with a
// stored image, in a language of `langs` (TREND_LANGUAGES_JSON), whose status is a public original of an available
// author (the live checks: an import's reblog_of_id is linked after its rows, D4).
export function trendCopySql(u: string, langs: string): string {
	return `(SELECT c3.status_id FROM status_cards c3
		WHERE c3.status_id IN (SELECT c2.status_id FROM status_cards c2 INDEXED BY ${CARD_PUBLIC_LINK_INDEX}
				WHERE ${publicCopiesSql('c2', u)} ORDER BY c2.status_id DESC LIMIT ${TREND_LINK_COPIES})
			AND c3.card_type = ${CARD_TYPES.link} AND c3.link_type = ${LINK_TYPES.article}
			AND NOT ${railsBlankSql('c3.title')} AND NOT ${railsBlankSql('c3.description')}
			AND NOT ${railsBlankSql('c3.provider_name')}
			AND c3.language IN (SELECT value FROM json_each(${langs}))
			AND EXISTS (SELECT 1 FROM card_images ci WHERE ci.id = c3.image_id AND ci.stored_at IS NOT NULL)
			AND EXISTS (SELECT 1 FROM statuses s3 INDEXED BY ${STATUSES_ID_INDEX} WHERE s3.id = c3.status_id
				AND s3.visibility = 'public' AND s3.reblog_of_id IS NULL AND ${availableSql('s3.account_id')})
		ORDER BY c3.status_id DESC LIMIT 1)`
}

// The review that decides a publisher's domain `d` (PreviewCardProvider.matching_domain): the review of the longest
// suffix of `d` of at least two labels that has one, its `columns` (of `pr`). The walk stops at the first suffix
// reviewed, so it seeks at most two keys per label (a hostname has at most 127).
function publisherWalk(d: string, columns: string): string {
	return `WITH RECURSIVE ps(d, dots) AS (SELECT ${d}, length(${d}) - length(replace(${d}, '.', ''))
			UNION ALL SELECT substr(d, instr(d, '.') + 1), dots - 1 FROM ps
			WHERE dots > 1 AND NOT EXISTS (SELECT 1 FROM link_provider_reviews pn WHERE pn.domain = ps.d))
		SELECT ${columns} FROM ps CROSS JOIN link_provider_reviews pr ON pr.domain = ps.d ORDER BY length(ps.d) DESC LIMIT 1`
}

// PreviewCard#trendable? (preview_card.rb:95-108): the link `url`'s own review, else its publisher's (`domain`), else
// NULL (no trendable_by_default fallback, D1). 1 allowed, 0 rejected.
function linkReviewSql(url: string, domain: string): string {
	return `coalesce((SELECT r.trendable FROM link_trend_reviews r WHERE r.url = ${url}), (${publisherWalk(domain, 'pr.trendable')}))`
}

// Whether the trend_links row `t` is allowed now (judged on every read, as the hashtags' and statuses' are).
export function trendAllowedLinkSql(t: string): string {
	return `coalesce(${linkReviewSql(`${t}.url`, `${t}.domain`)}, 0) = 1`
}

// The domain a link is published under (its URL's hostname as normalizeDomain takes it, within the stored rule), or
// null: such a link never trends.
export function linkDomain(url: string): string | null {
	try {
		return storedLinkDomain(normalizeDomain(new URL(url).hostname))
	} catch {
		return null
	}
}

type LinkCandidate = { url: string; today: number; yesterday: number; language: string | null }
type StoredLink = {
	url: string
	domain: string
	max_score: number
	max_score_at: string
	language: string | null
	review: number | null
}
type ScoredLink = ScoredRow & { domain: string; language: string | null }

// The window's links with today's and yesterday's accounts, every one with LINK_THRESHOLD or more today and a
// qualifying copy, the most first (ties by URL), TREND_LINK_CANDIDATES at most, with the copy's language. Each copy's
// link is grouped by its representative `rep`, the link's oldest public copy from yesterday on (one seek of the public
// link index), so no stage joins on a URL and the sorters hold ids. Only ids and trigger-bounded URLs are
// materialized; times are projected (isoTimeSql) at the row read.
export function linkCandidates(db: Db, now: number): LinkCandidate[] {
	const since = idOf(now - (now % DAY_MS) - DAY_MS)
	const boosts = (outer: string) => `x.reblog_of_id IS NOT NULL AND x.visibility = 'public' AND x.id >= ?1
		AND x.id IN (SELECT y.id FROM statuses y INDEXED BY ${PUBLIC_BOOSTS_INDEX}
			WHERE y.reblog_of_id = ${outer} AND y.reblog_of_id IS NOT NULL AND y.visibility = 'public' AND y.id >= ?1
			ORDER BY y.id DESC LIMIT ${TREND_LINK_BOOSTS_PER_STATUS})`
	const original = (s: string) =>
		`${s}.sensitive = 0 AND ${plainSpoilerSql(`${s}.spoiler_text`)} AND ${availableSql(`${s}.account_id`)}`
	return db.all<LinkCandidate>(
		`WITH w AS MATERIALIZED (
			SELECT s.id FROM statuses s INDEXED BY statuses_public
			WHERE s.visibility = 'public' AND s.reblog_of_id IS NULL AND s.id >= ?1 ORDER BY s.id DESC LIMIT ${TREND_WINDOW}),
		o AS MATERIALIZED (
			SELECT c.status_id AS id, c.final_url AS u,
				(SELECT c4.status_id FROM status_cards c4 INDEXED BY ${CARD_PUBLIC_LINK_INDEX}
					WHERE ${publicCopiesSql('c4', 'c.final_url')} AND c4.status_id >= ?1 ORDER BY c4.status_id LIMIT 1) AS rep
			FROM w CROSS JOIN status_cards c ON c.status_id = w.id
			WHERE c.public = 1 AND c.fetched_at IS NOT NULL AND c.final_url <> ''),
		ob AS MATERIALIZED (
			SELECT o.id AS parent, o.rep AS rep, x.id AS id
			FROM o CROSS JOIN statuses x INDEXED BY ${PUBLIC_BOOSTS_INDEX} ON x.reblog_of_id = o.id
			WHERE ${boosts('o.id')}
			LIMIT ${TREND_LINK_BOOSTS}),
		r AS (
			SELECT o.rep AS rep, s.account_id AS a, ${isoTimeSql('s.published_at')} AS at
			FROM o CROSS JOIN statuses s INDEXED BY ${STATUSES_ID_INDEX} ON s.id = o.id
			WHERE ${original('s')}
			UNION ALL
			SELECT ob.rep, x.account_id, ${isoTimeSql('x.published_at')}
			FROM ob CROSS JOIN statuses x INDEXED BY ${STATUSES_ID_INDEX} ON x.id = ob.id
				CROSS JOIN statuses s INDEXED BY ${STATUSES_ID_INDEX} ON s.id = ob.parent
			WHERE x.visibility = 'public' AND ${availableSql('x.account_id')} AND ${original('s')}),
		g AS (
			SELECT rep, count(DISTINCT CASE WHEN substr(at, 1, 10) = ?2 THEN a END) AS today,
				count(DISTINCT CASE WHEN substr(at, 1, 10) = ?3 THEN a END) AS yesterday
			FROM r WHERE at <= ?4 AND substr(at, 1, 10) IN (?2, ?3) GROUP BY rep HAVING today >= ${LINK_THRESHOLD}),
		q AS MATERIALIZED (
			SELECT k.final_url AS u, g.today, g.yesterday, ${trendCopySql('k.final_url', '?5')} AS copy
			FROM g CROSS JOIN status_cards k ON k.status_id = g.rep)
		SELECT q.u AS url, q.today, q.yesterday,
			(SELECT cl.language FROM status_cards cl WHERE cl.status_id = q.copy) AS language
		FROM q WHERE q.copy IS NOT NULL ORDER BY q.today DESC, q.u LIMIT ${TREND_LINK_CANDIDATES}`,
		since,
		day(now),
		day(now - DAY_MS),
		iso(now),
		TREND_LANGUAGES_JSON
	)
}

const LINK_TABLE: TrendTable<ScoredLink> = {
	name: 'trend_links',
	keyColumn: 'url',
	keyOf: 'url',
	stored: (spelled) => spelled,
	columns: ['domain', 'language'],
	values: (t) => [t.domain, t.language],
}

// The links scored again (Trends::Links#refresh): the candidates with their reviews (one statement), and the stored
// rows that still have a qualifying copy (a stored link without one is excluded before the pools fill, and the write
// deletes it); a stored link that is not a candidate scores with nothing observed. Allowed: the link's review, else
// its publisher's, else not (D1).
function roundLinks(db: Db, now: number): number {
	const candidates = new Map<string, LinkCandidate & { domain: string; review: number | null }>()
	for (const c of linkCandidates(db, now)) {
		const domain = linkDomain(c.url)
		if (domain !== null) {
			candidates.set(c.url, { ...c, domain, review: null })
		}
	}
	const listed = [...candidates.values()]
	if (listed.length > 0) {
		const reviews = db.all<{ i: number; review: number | null }>(
			`SELECT CAST(json_extract(j.value, '$[0]') AS INTEGER) AS i,
				${linkReviewSql("json_extract(j.value, '$[1]')", "json_extract(j.value, '$[2]')")} AS review
			FROM json_each(?1) j`,
			JSON.stringify(listed.map((c, i) => [i, c.url, c.domain]))
		)
		for (const { i, review } of reviews) {
			listed[i]!.review = review
		}
	}
	const stored = db.all<StoredLink>(
		`SELECT t.url, t.domain, t.max_score, t.max_score_at, t.language, ${linkReviewSql('t.url', 't.domain')} AS review
		FROM trend_links t WHERE ${trendCopySql('t.url', '?1')} IS NOT NULL`,
		TREND_LANGUAGES_JSON
	)
	const supported = (language: string | null) => language !== null && TREND_LANGUAGES.has(language)
	const scored: ScoredLink[] = []
	for (const row of stored) {
		const candidate = candidates.get(row.url)
		const language = candidate?.language ?? row.language
		const peak = { max: row.max_score, at: Date.parse(row.max_score_at) }
		const observed = [candidate?.today ?? 0, candidate?.yesterday ?? 0] as const
		const { score, max, at } = scoreDecaying(...observed, peak, now, LINK_DECAY, supported(language))
		const review = candidate?.review ?? row.review
		scored.push({ key: row.url, score, max, at: iso(at), review, stored: true, domain: row.domain, language })
		candidates.delete(row.url)
	}
	for (const c of candidates.values()) {
		const { score, max, at } = scoreDecaying(c.today, c.yesterday, null, now, LINK_DECAY, supported(c.language))
		scored.push({
			key: c.url,
			score,
			max,
			at: iso(at),
			review: c.review,
			stored: false,
			domain: c.domain,
			language: c.language,
		})
	}
	const kept = keepPools(scored, now, LINK_DECAY, (t) => t.review === 1)
	writeTrendRows(db, LINK_TABLE, kept)
	return kept.length
}

// One round at `now`: with trends off, the three trend tables emptied; otherwise the hashtags, then the statuses,
// scored again from the stored statuses, then the links, each kept within its pools, in one transaction. The reads
// are metered against TREND_ROW_CAPS.round.
export const trendsRound = writeOperation<{ now: number }, { tags: number; statuses: number; links: number }>(
	(db, { now }) => {
		const settings = trendSettings(db)
		if (!settings.trends) {
			db.run('DELETE FROM trend_tags')
			db.run('DELETE FROM trend_statuses')
			db.run('DELETE FROM trend_links')
			return { tags: 0, statuses: 0, links: 0 }
		}
		const metered = db.metered(new RowMeter(TREND_ROW_CAPS.round))
		return {
			tags: roundTags(metered, now, settings.trendable_by_default),
			statuses: roundStatuses(metered, now, settings.trendable_by_default),
			links: roundLinks(metered, now),
		}
	}
)

// ---- The lists (GET /api/v1/trends/tags and /statuses, mastodon/trends.ts)

// The text of a stored name, or null when it is not representable: its bytes are not well-formed UTF-8, or it is not
// its own normalized form within the name rule (reviewName), so a review or a history by the presented name would name
// another key. The round never admits such a name and drops a stored row of one (an import's).
function nameOf(hex: string): string | null {
	let name: string
	try {
		name = STRICT.decode(fromHex(hex))
	} catch {
		return null
	}
	return reviewName(name) === name ? name : null
}

// The listed hashtags (score of TAG_DECAY_THRESHOLD or more) that are allowed now, the top TREND_ALLOWED_ROWS by score
// (ties by name) before the page is cut from them, so the list ends at the same place for every page.
const LISTED_TAGS = `SELECT t.name, t.score FROM trend_tags t INDEXED BY trend_tags_listed
	WHERE t.score >= ${TAG_DECAY_THRESHOLD} AND ${trendAllowedTagSql('t', '?1')}
	ORDER BY t.score DESC, t.name LIMIT ${TREND_ALLOWED_ROWS}`

export type TrendPage<T> = { items: T[]; read: number }

// GET /api/v1/trends/tags (Api::V1::Trends::TagsController): the allowed trending hashtags, the same for everyone,
// each with its trends history; `read` is the rows the page read toward its limit.
export const trendingTags = optionalUserReadOperation<
	{ offset: number; limit: number; now: number; present: Present },
	TrendPage<Tag>
>((db, { offset, limit, present, now }, viewer) => {
	const settings = trendSettings(db)
	if (!settings.trends || limit === 0 || offset >= TREND_ALLOWED_ROWS) {
		return { items: [], read: 0 }
	}
	const rows = db.all<{ key: string }>(
		`SELECT hex(name) AS key FROM (${LISTED_TAGS}) ORDER BY score DESC, name LIMIT ?2 OFFSET ?3`,
		settings.trendable_by_default ? 1 : 0,
		limit,
		offset
	)
	const names = rows.flatMap((row) => nameOf(row.key) ?? [])
	return { items: presentTags(db, names, viewer.accountId, present, now, TREND_HISTORY_ROWS), read: rows.length }
})

// The allowed trending statuses: each author's top-scoring rows (StatusTrend.allowed, the maximum taken before
// allowance), allowed and trendable now, the top TREND_ALLOWED_ROWS by score (ties by id, newest first).
const LISTED_STATUSES = `SELECT t.status_id, t.score FROM trend_statuses t CROSS JOIN statuses e ON e.id = t.status_id
	WHERE t.score = (SELECT max(x.score) FROM trend_statuses x INDEXED BY trend_statuses_account
			WHERE x.account_id = t.account_id)
		AND ${trendAllowedStatusSql('t', '?4')} AND ${trendableStatusSql('e', '?2', '?5')}
	ORDER BY t.score DESC, t.status_id DESC LIMIT ${TREND_ALLOWED_ROWS}`

export type TrendStatusPage = { items: Status[]; read: number; consumed: number; cut: boolean }

// GET /api/v1/trends/statuses (Api::V1::Trends::StatusesController): of the allowed trending statuses, those the list
// rule passes for the viewer (R8; R2 with no viewer), `language` first, then by score; within ARRAY_ANSWER_BYTES, the
// first status always admitted (RES-3). `consumed` is how many of the ids read the answer took, so a page cut by its
// bytes continues after its last status.
export const trendingStatuses = optionalUserReadOperation<
	{ offset: number; limit: number; language: string; now: number; present: Present },
	TrendStatusPage
>((db, { offset, limit, language, present, now }, viewer) => {
	const settings = trendSettings(db)
	if (!settings.trends || limit === 0 || offset >= TREND_ALLOWED_ROWS) {
		return { items: [], read: 0, consumed: 0, cut: false }
	}
	const ids = statusReads(viewer, { viewer: '?1', now: '?2' })
		.select(
			db,
			'listable',
			{
				from: `(${LISTED_STATUSES}) t JOIN`,
				join: 'ON s.id = t.status_id',
				tail: 'ORDER BY (s.language IS ?3) DESC, t.score DESC, t.status_id DESC LIMIT ?6 OFFSET ?7',
			},
			viewer.accountId,
			viewer.now,
			language,
			settings.trendable_by_default ? 1 : 0,
			TREND_LANGUAGES_JSON,
			limit,
			offset
		)
		.map((row) => row.id)
	const admitted = presentStatusesWithin(
		db,
		presentation(db, ids, { ...present, viewer }),
		ids,
		ARRAY_ANSWER_BYTES,
		true
	)
	return { items: admitted.items, read: ids.length, consumed: admitted.consumed, cut: admitted.cut }
})

// The listed links (score of LINK_DECAY_THRESHOLD or more) allowed now, the top TREND_ALLOWED_ROWS by score (ties by
// URL) before the page is cut from them.
const LISTED_LINKS = `SELECT t.url, t.score, t.language FROM trend_links t INDEXED BY ${TREND_LINKS_LISTED_INDEX}
	WHERE t.score >= ${LINK_DECAY_THRESHOLD} AND ${trendAllowedLinkSql('t')}
	ORDER BY t.score DESC, t.url LIMIT ${TREND_ALLOWED_ROWS}`

// A qualifying copy as the presenter reads a card (status-rows.ts CARD_COLUMN_MAP, each column within its bound), its
// url the final URL (the link's identity, D2): the status's own posted link is not the link that trends.
const TREND_CARD_COLUMNS = {
	...CARD_COLUMN_MAP,
	status_id: 'c.status_id',
	url: `CASE WHEN typeof(c.final_url) = 'text' THEN ${byteBoundSql('c.final_url', CARD_URL_LIMIT)} END`,
} as const satisfies ColumnMap

// A link as listed (REST::Trends::LinkSerializer): its qualifying copy's card, then its history.
export type TrendLink = PreviewCard & { history: TagHistory[] }

// The link `url` as listed, or null without a qualifying copy now: one statement (the copy and its stored image) and
// its history.
function presentTrendLink(db: Db, url: string, origin: string, now: number): TrendLink | null {
	const card = db.first<CardRow>(
		`SELECT ${selectSql(TREND_CARD_COLUMNS)} FROM status_cards c
			LEFT JOIN card_images i ON i.id = c.image_id AND i.stored_at IS NOT NULL
		WHERE c.status_id = ${trendCopySql('?1', '?2')}`,
		url,
		TREND_LANGUAGES_JSON
	)
	const presented = card === undefined ? null : presentCard({ visibility: 'public' }, card, origin)
	return presented === null ? null : { ...presented, history: linkHistory(db, url, now) }
}

// D6: seven days of a link's uses and distinct accounts, today (UTC) first, as Mastodon's Trends::History (VIS-12):
// its newest LINK_HISTORY_ORIGINALS public copies of the 7 days (raw, by the public link index), at most
// LINK_HISTORY_BOOSTS_PER_STATUS public boosts of each (raw, by the public boost index) and the newest
// LINK_HISTORY_BOOSTS of those, then the rule: a plain public original of an available author, a boost by an
// available booster; days from published_at (isoTimeSql). At most 400 contributions; LT2: at most 600 status seeks.
export function linkHistory(db: Db, url: string, now: number): TagHistory[] {
	const today = now - (now % DAY_MS)
	const since = idOf(today - 6 * DAY_MS)
	const original = (s: string) => `${s}.visibility = 'public' AND ${s}.reblog_of_id IS NULL AND ${s}.sensitive = 0
		AND ${plainSpoilerSql(`${s}.spoiler_text`)} AND ${availableSql(`${s}.account_id`)}`
	const days = db.all<{ day: string; uses: number; accounts: number }>(
		`WITH o AS MATERIALIZED (
			SELECT c.status_id AS id FROM status_cards c INDEXED BY ${CARD_PUBLIC_LINK_INDEX}
			WHERE ${publicCopiesSql('c', '?1')} AND c.status_id >= ?2
			ORDER BY c.status_id DESC LIMIT ${LINK_HISTORY_ORIGINALS}),
		b AS MATERIALIZED (
			SELECT o.id AS parent, x.id AS id
			FROM o CROSS JOIN statuses x INDEXED BY ${PUBLIC_BOOSTS_INDEX} ON x.reblog_of_id = o.id
			WHERE x.reblog_of_id IS NOT NULL AND x.visibility = 'public' AND x.id >= ?2
				AND x.id IN (SELECT y.id FROM statuses y INDEXED BY ${PUBLIC_BOOSTS_INDEX}
					WHERE y.reblog_of_id = o.id AND y.reblog_of_id IS NOT NULL AND y.visibility = 'public' AND y.id >= ?2
					ORDER BY y.id DESC LIMIT ${LINK_HISTORY_BOOSTS_PER_STATUS})),
		m AS MATERIALIZED (SELECT parent, id FROM b ORDER BY id DESC LIMIT ${LINK_HISTORY_BOOSTS}),
		e AS (
			SELECT s.account_id AS a, substr(${isoTimeSql('s.published_at')}, 1, 10) AS day
			FROM o CROSS JOIN statuses s INDEXED BY ${STATUSES_ID_INDEX} ON s.id = o.id
			WHERE ${original('s')}
			UNION ALL
			SELECT x.account_id, substr(${isoTimeSql('x.published_at')}, 1, 10)
			FROM m CROSS JOIN statuses x INDEXED BY ${STATUSES_ID_INDEX} ON x.id = m.id
				CROSS JOIN statuses s INDEXED BY ${STATUSES_ID_INDEX} ON s.id = m.parent
			WHERE x.visibility = 'public' AND ${availableSql('x.account_id')} AND ${original('s')})
		SELECT day, count(*) AS uses, count(DISTINCT a) AS accounts FROM e WHERE day IS NOT NULL GROUP BY day`,
		url,
		since
	)
	return historyDays(days, today)
}

// GET /api/v1/trends/links (Api::V1::Trends::LinksController): the allowed trending links, `language` first, then by
// score, the same for everyone, each its qualifying copy's card (R41) with its history; `read` is the rows the page
// read toward its limit, a row without a qualifying copy now among them (skipped).
export const trendingLinks = optionalUserReadOperation<
	{ offset: number; limit: number; language: string; now: number; present: Present },
	TrendPage<TrendLink>
>((db, { offset, limit, language, present, now }) => {
	const settings = trendSettings(db)
	if (!settings.trends || limit === 0 || offset >= TREND_ALLOWED_ROWS) {
		return { items: [], read: 0 }
	}
	const rows = db.all<{ url: string }>(
		`SELECT url FROM (${LISTED_LINKS}) ORDER BY (language IS ?1) DESC, score DESC, url LIMIT ?2 OFFSET ?3`,
		language,
		limit,
		offset
	)
	const items = rows.flatMap((row) => presentTrendLink(db, row.url, present.origin, now) ?? [])
	return { items, read: rows.length }
})

// ---- The Access admin (app/admin.ts /admin/trends, `kopje-admin trends`): every read and write checks the admin in
// its transaction (AUTH-5); each review is logged (moderation-log.ts, Tag, Status and Account targets).

export const ADMIN_TREND_TAGS_LIMIT = 20
export const ADMIN_TREND_STATUSES_LIMIT = 40
// An admin status's excerpt: the plain text of its content's first EXCERPT_SOURCE bytes, cut at EXCERPT_UNITS code
// units; a domain shown at most DOMAIN_BYTES bytes (a DNS name is at most 253) and a username USERNAME_LIMIT bytes,
// each cut on bytes (byteCut).
const EXCERPT_SOURCE = 4000
export const EXCERPT_UNITS = 200

export type AdminTrendTag = {
	name: string
	url: string
	score: number
	trendable: boolean
	requires_review: boolean
	reviewed_at: string | null
	history: TagHistory[]
}

export type AdminTrendStatus = {
	id: string
	url: string | null
	account: { id: string; acct: string }
	published_at: string | null
	language: string | null
	score: number
	trendable: boolean
	requires_review: boolean
	excerpt: string
}

export type TrendRefusal = {
	ok: false
	code:
		| 'wrong-authority'
		| 'invalid-tag'
		| 'trend-status-not-found'
		| 'review-limit'
		| 'invalid-link'
		| 'link-not-found'
		| 'invalid-domain'
	message: string
}

const ACCESS_ONLY = 'only an Access admin reviews trends'

function authorityRefusal(db: Db, authority: ImportAuthority): TrendRefusal | null {
	const refused = accessAdminRefusal(db, authority, ACCESS_ONLY)
	return refused === null && authority.kind === 'access'
		? null
		: { ok: false, code: 'wrong-authority', message: refused ?? ACCESS_ONLY }
}

type TagReviewRow = { key: string; score: number | null; trendable: number | null; reviewed_at: string | null }

function adminTag(db: Db, row: TagReviewRow, name: string, settings: TrendSettings, origin: string, now: number) {
	return {
		name,
		url: `${origin}/tags/${encodeURIComponent(name)}`,
		score: row.score ?? 0,
		trendable: (row.trendable ?? (settings.trendable_by_default ? 1 : 0)) === 1,
		requires_review: row.trendable === null,
		reviewed_at: row.reviewed_at,
		history: tagHistory(db, tagKey(name), now, TREND_HISTORY_ROWS),
	} satisfies AdminTrendTag
}

const TAG_REVIEW_COLUMNS = `(SELECT r.trendable FROM tag_trend_reviews r WHERE r.name = t.name) AS trendable,
	(SELECT r.reviewed_at FROM tag_trend_reviews r WHERE r.name = t.name) AS reviewed_at`

// GET /admin/trends/tags: every listed stored hashtag (score of TAG_DECAY_THRESHOLD or more), allowed or not, by score.
export const adminTrendTags = readOperation<
	{ authority: ImportAuthority; offset: number; limit: number; now: number; origin: string },
	{ ok: true; tags: AdminTrendTag[]; settings: TrendSettings } | TrendRefusal
>((db, { authority, offset, limit, now, origin }) => {
	const refused = authorityRefusal(db, authority)
	if (refused !== null) {
		return refused
	}
	const settings = trendSettings(db)
	const rows = db.all<TagReviewRow>(
		`SELECT hex(t.name) AS key, t.score, ${TAG_REVIEW_COLUMNS} FROM trend_tags t INDEXED BY trend_tags_listed
		WHERE t.score >= ${TAG_DECAY_THRESHOLD} ORDER BY t.score DESC, t.name LIMIT ?1 OFFSET ?2`,
		Math.min(Math.max(limit, 0), ADMIN_TREND_TAGS_LIMIT),
		Math.max(offset, 0)
	)
	const tags = rows.flatMap((row) => {
		const name = nameOf(row.key)
		return name === null ? [] : [adminTag(db, row, name, settings, origin, now)]
	})
	return { ok: true, tags, settings }
})

type StatusReviewRow = {
	id: string
	url: string | null
	account_id: string
	username: string
	domain: string | null
	published_at: string | null
	language: string | null
	score: number
	status_review: number | null
	account_review: number | null
	content: string
}

// Every variable field through its bounded projection (RES-3): the stored URL bound, the 24-byte ISO time, a
// supported language, the username's and the domain's bounds, the content's first EXCERPT_SOURCE bytes.
const ADMIN_STATUS_COLUMNS = `t.status_id AS id, ${statusUrlSql('s.url')} AS url, s.account_id,
	${byteCut(usernameSql('a.username'), USERNAME_LIMIT)} AS username, ${byteCut('a.domain', DOMAIN_BYTES)} AS domain,
	${isoTimeSql('s.published_at')} AS published_at,
	CASE WHEN s.language IN (SELECT value FROM json_each(?1)) THEN s.language END AS language, t.score,
	(SELECT v.trendable FROM status_trend_reviews v WHERE v.status_id = t.status_id) AS status_review,
	(SELECT v.trendable FROM account_trend_reviews v WHERE v.account_id = t.account_id) AS account_review,
	${byteCut('s.content', EXCERPT_SOURCE)} AS content`

function adminStatus(row: StatusReviewRow, settings: TrendSettings): AdminTrendStatus {
	const review = row.status_review ?? row.account_review
	return {
		id: row.id,
		url: row.url,
		account: { id: row.account_id, acct: acctOf(row) },
		published_at: row.published_at,
		language: row.language,
		score: row.score,
		trendable: (review ?? (settings.trendable_by_default ? 1 : 0)) === 1,
		requires_review: review === null,
		excerpt: cutCodeUnits(remotePlainText(row.content), EXCERPT_UNITS),
	}
}

function adminStatusRows(db: Db, where: string, tail: string, ...params: SqlStorageValue[]): StatusReviewRow[] {
	return db.all<StatusReviewRow>(
		`SELECT ${ADMIN_STATUS_COLUMNS} FROM trend_statuses t CROSS JOIN statuses s ON s.id = t.status_id
			CROSS JOIN accounts a ON a.id = t.account_id
		WHERE ${where} ${tail}`,
		TREND_LANGUAGES_JSON,
		...params
	)
}

// GET /admin/trends/statuses: every stored status, allowed or not, by score.
export const adminTrendStatuses = readOperation<
	{ authority: ImportAuthority; offset: number; limit: number },
	{ ok: true; statuses: AdminTrendStatus[]; settings: TrendSettings } | TrendRefusal
>((db, { authority, offset, limit }) => {
	const refused = authorityRefusal(db, authority)
	if (refused !== null) {
		return refused
	}
	const settings = trendSettings(db)
	const rows = adminStatusRows(
		db,
		'1',
		'ORDER BY t.score DESC, t.status_id DESC LIMIT ?2 OFFSET ?3',
		Math.min(Math.max(limit, 0), ADMIN_TREND_STATUSES_LIMIT),
		Math.max(offset, 0)
	)
	return { ok: true, statuses: rows.map((row) => adminStatus(row, settings)), settings }
})

// The name of a hashtag review: a hashtag name (Tag::HASHTAG_NAME_RE), normalized, within the stored name rule.
function reviewName(raw: string): string | null {
	const name = tagName(raw)
	if (name === null || [...name].length > TREND_TAG_NAME_LENGTH) {
		return null
	}
	const bytes = new TextEncoder().encode(name).length
	const ascii = [...name].every((c) => c.charCodeAt(0) >= 0x80 || /[0-9_a-z]/.test(c))
	return bytes <= TREND_TAG_NAME_BYTES && ascii ? name : null
}

// POST /admin/trends/tags/:action {name} (Admin::Trends::TagsController#approve, #reject): the hashtag's decision,
// which takes effect at once; a new one is refused at MAX_TREND_REVIEWS.
export const reviewTrendTag = writeOperation<
	{ authority: ImportAuthority; name: string; trendable: boolean; now: number; origin: string },
	{ ok: true; tag: AdminTrendTag } | TrendRefusal
>((db, { authority, name: raw, trendable, now, origin }) => {
	const refused = authorityRefusal(db, authority)
	if (refused !== null) {
		return refused
	}
	const name = reviewName(raw)
	if (name === null) {
		return { ok: false, code: 'invalid-tag', message: `${JSON.stringify(raw)} is not a hashtag name` }
	}
	const stored = db.first('SELECT 1 AS x FROM tag_trend_reviews WHERE name = ?', name) !== undefined
	if (
		!stored &&
		(db.first<{ n: number }>('SELECT count(*) AS n FROM tag_trend_reviews')?.n ?? 0) >= MAX_TREND_REVIEWS
	) {
		return { ok: false, code: 'review-limit', message: `at most ${MAX_TREND_REVIEWS} hashtag reviews are kept` }
	}
	db.run(
		`INSERT INTO tag_trend_reviews (name, trendable, reviewed_at) VALUES (?1, ?2, ?3)
		ON CONFLICT (name) DO UPDATE SET trendable = excluded.trendable, reviewed_at = excluded.reviewed_at`,
		name,
		trendable ? 1 : 0,
		iso(now)
	)
	const actor = authority as Extract<ImportAuthority, { kind: 'access' }>
	logAction(db, actor, trendable ? 'approve' : 'reject', { type: 'Tag', id: tagId(name) }, { name }, now)
	const row = db.first<TagReviewRow>(
		`SELECT hex(t.name) AS key, (SELECT score FROM trend_tags WHERE name = t.name) AS score, ${TAG_REVIEW_COLUMNS}
		FROM tag_trend_reviews t WHERE t.name = ?1`,
		name
	)!
	return { ok: true, tag: adminTag(db, row, name, trendSettings(db), origin, now) }
})

// POST /admin/trends/statuses/:id/:action {author?} (Admin::Trends::StatusesController#approve, #reject): the status's
// decision, or with `author` its author's (Account#trendable, for every status of theirs without one of its own).
export const reviewTrendStatus = writeOperation<
	{ authority: ImportAuthority; id: string; trendable: boolean; author: boolean; now: number },
	{ ok: true; id: string; trendable: boolean; status: AdminTrendStatus | null } | TrendRefusal
>((db, { authority, id, trendable, author, now }) => {
	const refused = authorityRefusal(db, authority)
	if (refused !== null) {
		return refused
	}
	const status = db.first<{ account_id: string }>('SELECT account_id FROM statuses WHERE id = ?', id)
	if (status === undefined) {
		return { ok: false, code: 'trend-status-not-found', message: `no status has id ${id}` }
	}
	const [table, column, key, type] = author
		? (['account_trend_reviews', 'account_id', status.account_id, 'Account'] as const)
		: (['status_trend_reviews', 'status_id', id, 'Status'] as const)
	const stored = db.first(`SELECT 1 AS x FROM ${table} WHERE ${column} = ?`, key) !== undefined
	if (!stored && (db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n ?? 0) >= MAX_TREND_REVIEWS) {
		return { ok: false, code: 'review-limit', message: `at most ${MAX_TREND_REVIEWS} reviews of each kind are kept` }
	}
	db.run(
		`INSERT INTO ${table} (${column}, trendable, reviewed_at) VALUES (?1, ?2, ?3)
		ON CONFLICT (${column}) DO UPDATE SET trendable = excluded.trendable, reviewed_at = excluded.reviewed_at`,
		key,
		trendable ? 1 : 0,
		iso(now)
	)
	const actor = authority as Extract<ImportAuthority, { kind: 'access' }>
	logAction(db, actor, trendable ? 'approve' : 'reject', { type, id: key }, author ? { status: id } : {}, now)
	const [row] = adminStatusRows(db, 't.status_id = ?2', '', id)
	return { ok: true, id, trendable, status: row === undefined ? null : adminStatus(row, trendSettings(db)) }
})

export const ADMIN_TREND_LINKS_LIMIT = 20
export const ADMIN_TREND_PUBLISHERS_LIMIT = 100

// A publisher's review (PreviewCardProvider): a domain, its decision and its time.
export type AdminTrendPublisher = { domain: string; trendable: boolean; reviewed_at: string }

export type AdminTrendLink = {
	url: string
	title: string
	provider_name: string
	domain: string | null
	language: string | null
	score: number
	trendable: boolean
	requires_review: boolean
	reviewed_at: string | null
	publisher: AdminTrendPublisher | null
	history: TagHistory[]
}

type PublisherRow = { domain: string; trendable: number; reviewed_at: string }

const publisherOf = (row: PublisherRow | undefined): AdminTrendPublisher | null =>
	row === undefined ? null : { domain: row.domain, trendable: row.trendable === 1, reviewed_at: row.reviewed_at }

// The link `url` as the Access admin sees it: its stored score (0 when it is not stored), domain and language, its
// qualifying copy's title and provider name ('' without one), its own review and the publisher review that decides its
// domain. Each value bounded as stored (0071_link_trends' triggers; the card texts by presentedCardText).
function adminLink(
	db: Db,
	row: { url: string; domain: string | null; language: string | null; score: number },
	now: number
): AdminTrendLink {
	const copy = db.first<{ title: string | null; provider_name: string | null; language: string | null }>(
		`SELECT ${CARD_COLUMN_MAP.title} AS title, ${CARD_COLUMN_MAP.provider_name} AS provider_name,
			${CARD_COLUMN_MAP.language} AS language
		FROM status_cards c WHERE c.status_id = ${trendCopySql('?1', '?2')}`,
		row.url,
		TREND_LANGUAGES_JSON
	)
	const own = db.first<{ trendable: number; reviewed_at: string }>(
		'SELECT trendable, reviewed_at FROM link_trend_reviews WHERE url = ?',
		row.url
	)
	const publisher = publisherOf(
		row.domain === null
			? undefined
			: db.first<PublisherRow>(publisherWalk('?1', 'pr.domain, pr.trendable, pr.reviewed_at'), row.domain)
	)
	const review = own?.trendable ?? (publisher === null ? null : Number(publisher.trendable))
	return {
		url: row.url,
		title: presentedCardText(copy?.title, CARD_TEXTS.title),
		provider_name: presentedCardText(copy?.provider_name, CARD_TEXTS.provider_name),
		domain: row.domain,
		language: row.language ?? copy?.language ?? null,
		score: row.score,
		trendable: review === 1,
		requires_review: review === null,
		reviewed_at: own?.reviewed_at ?? null,
		publisher,
		history: linkHistory(db, row.url, now),
	}
}

// GET /admin/trends/links: every listed stored link (score of LINK_DECAY_THRESHOLD or more), allowed or not, by score.
export const adminTrendLinks = readOperation<
	{ authority: ImportAuthority; offset: number; limit: number; now: number },
	{ ok: true; links: AdminTrendLink[]; settings: TrendSettings } | TrendRefusal
>((db, { authority, offset, limit, now }) => {
	const refused = authorityRefusal(db, authority)
	if (refused !== null) {
		return refused
	}
	const rows = db.all<{ url: string; domain: string; language: string | null; score: number }>(
		`SELECT t.url, t.domain, t.language, t.score FROM trend_links t INDEXED BY ${TREND_LINKS_LISTED_INDEX}
		WHERE t.score >= ${LINK_DECAY_THRESHOLD} ORDER BY t.score DESC, t.url LIMIT ?1 OFFSET ?2`,
		Math.min(Math.max(limit, 0), ADMIN_TREND_LINKS_LIMIT),
		Math.max(offset, 0)
	)
	return { ok: true, links: rows.map((row) => adminLink(db, row, now)), settings: trendSettings(db) }
})

// GET /admin/trends/publishers: every publisher review, by domain.
export const adminTrendPublishers = readOperation<
	{ authority: ImportAuthority; offset: number; limit: number },
	{ ok: true; publishers: AdminTrendPublisher[] } | TrendRefusal
>((db, { authority, offset, limit }) => {
	const refused = authorityRefusal(db, authority)
	if (refused !== null) {
		return refused
	}
	const rows = db.all<PublisherRow>(
		'SELECT domain, trendable, reviewed_at FROM link_provider_reviews ORDER BY domain LIMIT ?1 OFFSET ?2',
		Math.min(Math.max(limit, 0), ADMIN_TREND_PUBLISHERS_LIMIT),
		Math.max(offset, 0)
	)
	return { ok: true, publishers: rows.map((row) => publisherOf(row)!) }
})

// A review written: upserted, a new key refused at MAX_TREND_REVIEWS, at once (no e-mail, MD-5).
function writeReview(
	db: Db,
	table: 'link_trend_reviews' | 'link_provider_reviews',
	key: string,
	trendable: boolean,
	now: number
): TrendRefusal | null {
	const column = table === 'link_trend_reviews' ? 'url' : 'domain'
	const stored = db.first(`SELECT 1 AS x FROM ${table} WHERE ${column} = ?`, key) !== undefined
	if (!stored && (db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n ?? 0) >= MAX_TREND_REVIEWS) {
		return { ok: false, code: 'review-limit', message: `at most ${MAX_TREND_REVIEWS} reviews of each kind are kept` }
	}
	db.run(
		`INSERT INTO ${table} (${column}, trendable, reviewed_at) VALUES (?1, ?2, ?3)
		ON CONFLICT (${column}) DO UPDATE SET trendable = excluded.trendable, reviewed_at = excluded.reviewed_at`,
		key,
		trendable ? 1 : 0,
		iso(now)
	)
	return null
}

const ENCODER = new TextEncoder()

// POST /admin/trends/links/:action {url, publisher?} (Admin::Trends::LinksController#approve, #reject; with
// `publisher`, Trends::PreviewCardBatch's provider actions): the link's decision, or the decision of its publisher
// (the review that decides its domain now, else one for its domain), which also deletes the link's own review
// (preview_card_batch.rb:28-59). A URL past the card URL rule is invalid-link, one with no public attached copy
// link-not-found (one seek of the public link index).
export const reviewTrendLink = writeOperation<
	{ authority: ImportAuthority; url: string; trendable: boolean; publisher: boolean; now: number },
	{ ok: true; link: AdminTrendLink } | TrendRefusal
>((db, { authority, url, trendable, publisher, now }) => {
	const refused = authorityRefusal(db, authority)
	if (refused !== null) {
		return refused
	}
	const invalid: TrendRefusal = { ok: false, code: 'invalid-link', message: `${JSON.stringify(url)} is not a link` }
	if (
		typeof url !== 'string' ||
		url.length > CARD_URL_LIMIT ||
		db.first<{ past: number }>(`SELECT ${cardUrlPastSql('?1', false)} AS past`, url)?.past !== 0
	) {
		return invalid
	}
	const copy = db.first(
		`SELECT 1 AS x FROM status_cards c INDEXED BY ${CARD_PUBLIC_LINK_INDEX} WHERE ${publicCopiesSql('c', '?1')} LIMIT 1`,
		url
	)
	if (copy === undefined) {
		return { ok: false, code: 'link-not-found', message: `no public post shows ${url}` }
	}
	const domain = linkDomain(url)
	const actor = authority as Extract<ImportAuthority, { kind: 'access' }>
	const action = trendable ? 'approve' : 'reject'
	if (publisher) {
		if (domain === null) {
			return { ...invalid, message: `${JSON.stringify(url)} has no publisher domain` }
		}
		const matched = db.first<{ domain: string }>(publisherWalk('?1', 'pr.domain'), domain)?.domain ?? domain
		const limited = writeReview(db, 'link_provider_reviews', matched, trendable, now)
		if (limited !== null) {
			return limited
		}
		db.run('DELETE FROM link_trend_reviews WHERE url = ?', url)
		logAction(db, actor, action, { type: 'PreviewCardProvider', id: matched }, { domain: matched, url }, now)
	} else {
		const limited = writeReview(db, 'link_trend_reviews', url, trendable, now)
		if (limited !== null) {
			return limited
		}
		logAction(db, actor, action, { type: 'PreviewCard', id: idOfBytes(ENCODER.encode(url)) }, { url }, now)
	}
	const stored = db.first<{ domain: string; language: string | null; score: number }>(
		'SELECT domain, language, score FROM trend_links WHERE url = ?',
		url
	)
	return { ok: true, link: adminLink(db, { url, domain, language: null, score: 0, ...stored }, now) }
})

// POST /admin/trends/publishers/:action {domain} (Admin::Trends::Links::PreviewCardProvidersController#approve,
// #reject): the publisher's decision, for the domain and its subdomains without a nearer one. The domain as
// blockedDomain normalizes it, within the stored rule, else invalid-domain.
export const reviewTrendPublisher = writeOperation<
	{ authority: ImportAuthority; domain: string; trendable: boolean; now: number },
	{ ok: true; publisher: AdminTrendPublisher } | TrendRefusal
>((db, { authority, domain: raw, trendable, now }) => {
	const refused = authorityRefusal(db, authority)
	if (refused !== null) {
		return refused
	}
	const domain =
		typeof raw === 'string' && raw.length <= 2 * LINK_DOMAIN_BYTES ? storedLinkDomain(blockedDomain(raw)) : null
	if (domain === null) {
		return { ok: false, code: 'invalid-domain', message: `${JSON.stringify(raw)} is not a domain name` }
	}
	const limited = writeReview(db, 'link_provider_reviews', domain, trendable, now)
	if (limited !== null) {
		return limited
	}
	const actor = authority as Extract<ImportAuthority, { kind: 'access' }>
	logAction(db, actor, trendable ? 'approve' : 'reject', { type: 'PreviewCardProvider', id: domain }, { domain }, now)
	return { ok: true, publisher: { domain, trendable, reviewed_at: iso(now) } }
})
