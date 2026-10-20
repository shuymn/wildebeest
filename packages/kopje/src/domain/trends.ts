import { acctOf, type Present } from './accounts'
import { accessAdminRefusal } from './admin-authority'
import { ARRAY_ANSWER_BYTES } from './answer-budget'
import { availableSql, statusReads, trendableStatusSql, visibleSql } from './audience'
import { optionalUserReadOperation } from './auth'
import { logAction } from './moderation-log'
import { readOperation, writeOperation } from './operation'
import { htmlToPlainText } from './plain-text'
import { usernameSql } from './profile-bounds'
import { MAX_STATUS_TAGS, tagNameSql } from './status-bounds'
import { presentation, presentStatusesWithin, type Status } from './status-presenter'
import { presentTags, type Tag, type TagHistory, tagId, tagName } from './tags'
import { type Db, ROW_OBJECT_BYTES, RowMeter, VALUE_BYTES } from '../db/sql'
import type { ImportAuthority } from '../platform/store-admin'
import {
	cutSql,
	isoTimeSql,
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
import { cutCodeUnits } from '../security/html'

// Trends (migration 0057_trends), as Mastodon 4.5 works them out (app/models/trends/{tags,statuses}.rb): the hashtags
// and statuses that trend, scored every 5 minutes by the cron's round (jobs/scheduled.ts trendsRound) from what the
// Store holds, listed by GET /api/v1/trends/tags and /statuses (mastodon/trends.ts), and reviewed by the Access admin
// (app/admin.ts /admin/trends, `kopje-admin trends`). The only module that reads or writes trend_tags, trend_statuses,
// tag_trend_reviews, status_trend_reviews and account_trend_reviews (test-node/policy-boundary.test.ts).
//
// R41 (docs/visibility.md): a listed status passes trendableStatusSql (audience.ts) and, for a signed-in viewer, the
// list rule (R8); hashtags count public originals of available accounts only (VIS-12). Deviations: MD-5
// (docs/mastodon-deviations.md).

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
// The round's windows (RES-7, MD-5): the newest TREND_WINDOW public originals with ids from yesterday 00:00 UTC; at most
// MAX_STATUS_TAGS hashtag rows of each and TREND_TAG_ROWS in all, cut raw before any rule; the TREND_TAG_CANDIDATES
// hashtags with the most accounts today; the TREND_STATUS_CANDIDATES statuses with the most boosts and favourites,
// counted up to TREND_OBSERVED_MAX. A trending hashtag's history counts at most its newest TREND_HISTORY_ROWS public
// statuses of the 7 days.
export const TREND_WINDOW = 4000
export const TREND_TAG_ROWS = 8000
export const TREND_TAG_CANDIDATES = 400
export const TREND_STATUS_CANDIDATES = 400
export const TREND_HISTORY_ROWS = 200
export const TREND_OBSERVED_MAX = 10_000_000

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

// The bytes of a hex key, and whether they are well-formed UTF-8: a name that is not never trends (it could not be
// named back by its text), and a stored row of one is dropped.
const STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function wellFormed(hex: string): boolean {
	const bytes = new Uint8Array(hex.length / 2)
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16)
	}
	try {
		STRICT.decode(bytes)
		return true
	} catch {
		return false
	}
}

// The row heap (db/sql.ts rowHeapBytes: 64 bytes a row, 32 a value, two a code unit of text) the round's reads take
// at most, from each column's maximum: the candidate hashtags (a hex key of 2 × TREND_TAG_NAME_BYTES, three numbers),
// the stored ones (a key, two numbers and a time), the stored status ids, and the status candidates (two ids, three
// numbers and a time). test/trends-bounds.test.ts builds those rows and measures them.
const ROW = (values: number, units: number) => ROW_OBJECT_BYTES + VALUE_BYTES * values + 2 * units
const ROUND_ROWS_HEAP =
	TREND_TAG_CANDIDATES * ROW(4, 2 * TREND_TAG_NAME_BYTES) +
	MAX_TREND_TAGS * ROW(4, 2 * TREND_TAG_NAME_BYTES + 24) +
	MAX_TREND_STATUSES * ROW(1, 18) +
	(TREND_STATUS_CANDIDATES + MAX_TREND_STATUSES) * ROW(6, 18 + 18 + 24)
// The RowMeter cap of the round's reads; tests lower it to see the backstop act.
export const TREND_ROW_CAPS = { round: ROUND_ROWS_HEAP }

type TagCandidate = { key: string; today: number; yesterday: number; review: number | null }
type StoredTag = { key: string; max_score: number; max_score_at: string; review: number | null }
type ScoredTag = { key: string; score: number; max: number; at: string; review: number | null; stored: boolean }

// The hashtags of the window with today's and yesterday's accounts (distinct authors per publication day, R1), the
// TREND_TAG_CANDIDATES with the most today of those with TAG_THRESHOLD or more (ties by key). Both CTEs are
// materialized, so the window and the raw rows are cut before any rule is applied: a status's first MAX_STATUS_TAGS
// rows by name, TREND_TAG_ROWS in all, whatever they hold. Then: public rows, names within the bound and the name rule,
// published today or yesterday and by `now`, by available authors. The membership read of `x.name` presents nothing.
function tagCandidates(db: Db, now: number): TagCandidate[] {
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
		FROM g WHERE today >= ${TAG_THRESHOLD} ORDER BY today DESC, key LIMIT ${TREND_TAG_CANDIDATES}`,
		idOf(now - (now % DAY_MS) - DAY_MS),
		today,
		yesterday,
		iso(now)
	)
}

// Trends::Tags#calculate_scores (app/models/trends/tags.rb:96-127), with the elapsed time clamped at 0 (an imported
// future peak decays from now), so the decayed score never passes the peak.
function scoreTag(observed: number, yesterday: number, peak: { max: number; at: number } | null, now: number) {
	const expected = Math.max(yesterday, 1)
	const score =
		observed < TAG_THRESHOLD || expected > observed
			? 0
			: Math.min((observed - expected) ** 2 / expected, TREND_SCORE_MAX)
	let max = peak === null || peak.at < now - TAG_COOLDOWN_MS ? 0 : peak.max
	let at = peak === null ? now : Math.min(peak.at, now)
	if (score > max) {
		max = score
		at = now
	}
	const decayed = max * 0.5 ** (Math.max(now - at, 0) / TAG_HALFLIFE_MS)
	return { score: Math.min(decayed, max), max, at }
}

function roundTags(db: Db, now: number, byDefault: boolean): number {
	const candidates = new Map(tagCandidates(db, now).map((c) => [c.key, c]))
	const stored = db.all<StoredTag>(
		`SELECT hex(t.name) AS key, t.max_score, t.max_score_at,
			(SELECT r.trendable FROM tag_trend_reviews r WHERE r.name = t.name) AS review
		FROM trend_tags t`
	)
	const scored: ScoredTag[] = []
	const seen = new Set<string>()
	for (const row of stored) {
		seen.add(row.key)
		if (!wellFormed(row.key)) {
			continue
		}
		const candidate = candidates.get(row.key)
		const peak = { max: row.max_score, at: Date.parse(row.max_score_at) }
		const { score, max, at } = scoreTag(candidate?.today ?? 0, candidate?.yesterday ?? 0, peak, now)
		scored.push({ key: row.key, score, max, at: iso(at), review: row.review, stored: true })
	}
	for (const candidate of candidates.values()) {
		if (seen.has(candidate.key) || !wellFormed(candidate.key)) {
			continue
		}
		const { score, max, at } = scoreTag(candidate.today, candidate.yesterday, null, now)
		scored.push({ key: candidate.key, score, max, at: iso(at), review: candidate.review, stored: false })
	}
	// A row stays while it is listed (decayed to TAG_DECAY_THRESHOLD or more) or its peak is within the cooldown.
	const survivors = scored.filter(
		(t) => t.score >= TAG_DECAY_THRESHOLD || (t.max > 0 && Date.parse(t.at) >= now - TAG_COOLDOWN_MS)
	)
	const allowed = (t: ScoredTag) => (t.review ?? (byDefault ? 1 : 0)) === 1
	const byKey = (a: ScoredTag, b: ScoredTag) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
	// Allowed: listed rows by score, then the others by their peak's time. Review: unreviewed before rejected, each by
	// score. Rows not allowed never take an allowed row's place (RES-4).
	const allowedPool = survivors
		.filter(allowed)
		.sort((a, b) => {
			const listed = Number(b.score >= TAG_DECAY_THRESHOLD) - Number(a.score >= TAG_DECAY_THRESHOLD)
			if (listed !== 0) {
				return listed
			}
			return a.score >= TAG_DECAY_THRESHOLD
				? b.score - a.score || byKey(a, b)
				: Date.parse(b.at) - Date.parse(a.at) || byKey(a, b)
		})
		.slice(0, TREND_ALLOWED_ROWS)
	const reviewPool = survivors
		.filter((t) => !allowed(t))
		.sort((a, b) => Number(a.review !== null) - Number(b.review !== null) || b.score - a.score || byKey(a, b))
		.slice(0, TREND_REVIEW_POOL)
	const kept = [...allowedPool, ...reviewPool]
	// Deletes, then updates of stored keys, then inserts of new keys, so no cap trigger fires (0057_trends).
	db.run(
		'DELETE FROM trend_tags WHERE hex(name) NOT IN (SELECT value FROM json_each(?1))',
		JSON.stringify(kept.map((t) => t.key))
	)
	for (const t of kept.filter((t) => t.stored)) {
		db.run(
			'UPDATE trend_tags SET score = ?1, max_score = ?2, max_score_at = ?3 WHERE name = CAST(unhex(?4) AS TEXT)',
			t.score,
			t.max,
			t.at,
			t.key
		)
	}
	const fresh = kept.filter((t) => !t.stored)
	if (fresh.length > 0) {
		db.run(
			`INSERT INTO trend_tags (name, score, max_score, max_score_at)
			SELECT CAST(unhex(json_extract(value, '$.k')) AS TEXT), json_extract(value, '$.s'), json_extract(value, '$.m'),
				json_extract(value, '$.a')
			FROM json_each(?1)`,
			JSON.stringify(fresh.map((t) => ({ k: t.key, s: t.score, m: t.max, a: t.at })))
		)
	}
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
			allowed: (c.status_review ?? c.account_review ?? (byDefault ? 1 : 0)) === 1,
		}))
		.filter((c) => c.score >= STATUS_DECAY_THRESHOLD)
		.sort((a, b) => b.score - a.score || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
	// Each author's maximum (StatusTrend.allowed lists the author's top-scoring rows that are allowed): the rows tied at
	// it are its top group, which the walk meets first. A lower row is kept only while one of its author's top group
	// is, so the stored maximum is always the author's real one; TREND_STATUSES_PER_AUTHOR rows at most.
	const top = new Map<string, number>()
	for (const c of scored) {
		if (!top.has(c.account_id)) {
			top.set(c.account_id, c.score)
		}
	}
	const counts = new Map<string, { kept: number; top: boolean }>()
	const pools = { allowed: 0, review: 0 }
	const kept: typeof scored = []
	for (const c of scored) {
		const author = counts.get(c.account_id) ?? { kept: 0, top: false }
		counts.set(c.account_id, author)
		const inTop = c.score === top.get(c.account_id)
		if (author.kept >= TREND_STATUSES_PER_AUTHOR || (!inTop && !author.top)) {
			continue
		}
		const pool = c.allowed ? 'allowed' : 'review'
		if (pools[pool] >= (c.allowed ? TREND_ALLOWED_ROWS : TREND_REVIEW_POOL)) {
			continue
		}
		pools[pool]++
		author.kept++
		author.top ||= inTop
		kept.push(c)
	}
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

// One round at `now`: with trends off, both trend tables emptied; otherwise the hashtags, then the statuses, scored
// again from the stored statuses and kept within their pools. The reads are metered against TREND_ROW_CAPS.round.
export const trendsRound = writeOperation<{ now: number }, { tags: number; statuses: number }>((db, { now }) => {
	const settings = trendSettings(db)
	if (!settings.trends) {
		db.run('DELETE FROM trend_tags')
		db.run('DELETE FROM trend_statuses')
		return { tags: 0, statuses: 0 }
	}
	const metered = db.metered(new RowMeter(TREND_ROW_CAPS.round))
	return {
		tags: roundTags(metered, now, settings.trendable_by_default),
		statuses: roundStatuses(metered, now, settings.trendable_by_default),
	}
})

// ---- The lists (GET /api/v1/trends/tags and /statuses, mastodon/trends.ts)

const HISTORY_DAYS = 7

// A hashtag's history as Mastodon's TagSerializer gives it (tags.ts tagHistory), for the trends lists: the newest
// TREND_HISTORY_ROWS entries of its public range of the seven days (status_tags_public; `public = 1` is the index's
// own condition, so the entries are raw), then the rule (public originals anyone may see, VIS-12), then the days.
export function trendTagHistory(db: Db, name: string, now: number): TagHistory[] {
	const today = now - (now % DAY_MS)
	const since = today - (HISTORY_DAYS - 1) * DAY_MS
	const rows = db.all<{ day: string; uses: number; accounts: number }>(
		`SELECT substr(s.published_at, 1, 10) AS day, count(*) AS uses, count(DISTINCT s.account_id) AS accounts
		FROM (SELECT t.status_id FROM status_tags t INDEXED BY status_tags_public
			WHERE t.name = ?1 AND t.public = 1 AND t.status_id >= ?2 ORDER BY t.status_id DESC LIMIT ${TREND_HISTORY_ROWS}) c
		CROSS JOIN statuses s ON s.id = c.status_id
		WHERE s.visibility = 'public' AND s.reblog_of_id IS NULL AND ${visibleSql('s', 'NULL')}
		GROUP BY day`,
		name,
		idOf(since)
	)
	const byDay = new Map(rows.map((row) => [row.day, row]))
	return Array.from({ length: HISTORY_DAYS }, (_, index) => {
		const start = today - index * DAY_MS
		const row = byDay.get(day(start))
		return { day: String(start / 1000), uses: String(row?.uses ?? 0), accounts: String(row?.accounts ?? 0) }
	})
}

// The text of a stored name, or null when its bytes are not well-formed UTF-8 (an imported row the next round drops).
function nameOf(hex: string): string | null {
	if (!wellFormed(hex)) {
		return null
	}
	const bytes = new Uint8Array(hex.length / 2)
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16)
	}
	return STRICT.decode(bytes)
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
	const tags = presentTags(db, names, viewer.accountId, present, null).map((tag) => ({
		...tag,
		history: trendTagHistory(db, tag.name, now),
	}))
	return { items: tags, read: rows.length }
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

// ---- The Access admin (app/admin.ts /admin/trends, `kopje-admin trends`): every read and write checks the admin in
// its transaction (AUTH-5); each review is logged (moderation-log.ts, Tag, Status and Account targets).

export const ADMIN_TREND_TAGS_LIMIT = 20
export const ADMIN_TREND_STATUSES_LIMIT = 40
// An admin status's excerpt: the plain text of its content's first EXCERPT_SOURCE code points, cut at EXCERPT_UNITS
// code units; a domain shown at most DOMAIN_POINTS code points (a DNS name is at most 253 bytes).
const EXCERPT_SOURCE = 4000
export const EXCERPT_UNITS = 200
export const DOMAIN_POINTS = 253

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
	code: 'wrong-authority' | 'invalid-tag' | 'trend-status-not-found' | 'review-limit'
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
		history: trendTagHistory(db, name, now),
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
// supported language, the username's and the domain's bounds, the content's first EXCERPT_SOURCE code points.
const ADMIN_STATUS_COLUMNS = `t.status_id AS id, ${statusUrlSql('s.url')} AS url, s.account_id,
	${usernameSql('a.username')} AS username, ${cutSql('a.domain', DOMAIN_POINTS)} AS domain,
	${isoTimeSql('s.published_at')} AS published_at,
	CASE WHEN s.language IN (SELECT value FROM json_each(?1)) THEN s.language END AS language, t.score,
	(SELECT v.trendable FROM status_trend_reviews v WHERE v.status_id = t.status_id) AS status_review,
	(SELECT v.trendable FROM account_trend_reviews v WHERE v.account_id = t.account_id) AS account_review,
	${cutSql('s.content', EXCERPT_SOURCE)} AS content`

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
		excerpt: cutCodeUnits(htmlToPlainText(row.content), EXCERPT_UNITS),
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
