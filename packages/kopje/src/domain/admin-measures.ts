import { deletingSql } from './audience'
import { ADMIN_PERMISSION, adminReadOperation } from './auth'
import { ACCOUNTS_ID_INDEX } from '../db/indexes'
import type { Db } from '../db/sql'
import { isoTimeSql } from '../platform/stored-bounds'

// The measures Kopje serves of Mastodon's Admin::Metrics::Measure (app/lib/admin/metrics/measure/*.rb, v4.5.11), to
// the OAuth admin with view_dashboard (VIS-29). Each is computed exactly or refused: a walk reads at most
// MEASURE_ROWS + 1 raw candidates, and one more than MEASURE_ROWS answers `too_many` (422), never an undercount.
//
// - new_users: the local accounts by local_accounts.created_at (new_users_measure.rb).
// - opened_reports: the reports, local and inbound, by created_at (opened_reports_measure.rb).
// - resolved_reports: the resolved reports by action_taken_at (resolved_reports_measure.rb); an unresolved report's
//   NULL is no time, not an unreadable one, and a reopened report is unresolved again.
// - instance_accounts: the domain's accounts that are not being deleted (deleted_at NULL), by created_at.
// - instance_follows: local accounts' accepted follows of the domain's accounts, by follows.created_at.
// - instance_followers: the domain's accounts' accepted follows of local accounts, by follows.created_at. Every stored
//   follow has a local side, so both follow measures count what Mastodon's Follow rows of a local account count. A
//   follow that began as a request keeps the request's time (inbox.ts, accounts.ts authorize), so both series date
//   it by the request, where Mastodon creates the Follow at acceptance (follow_request.rb:34); the totals count the
//   stored accepted edges.
// - instance_reports: the reports whose target is on the domain, by reports.created_at.
// - instance_media_attachments: always 0 bytes: Kopje stores no file of a remote attachment, only its URL.
//
// Ranges (base_measure.rb:88-98): an in-range measure (IN_RANGE_MEASURES) totals its rows from the start date's 00:00
// UTC to the end date's 00:00 UTC, both included, the dates as the caller wrote them (DateTime#to_date keeps the
// offset); previous_total the same window moved back by the period's length L = end_at − start_at, each date floored
// (Date − Rational). The series is QueryHelper's axis (measurePeriod), each day with its rows (date_trunc('day', t)).
// The instance_* totals count all time, with include_subdomains the subdomains' rows too; their series count the
// domain itself only, as 4.5.11's account_domain_sql compares with a LIKE that has no wildcard (query_helper.rb:26-32).
//
// Stored times are read through isoTimeSql (the 24-byte form Kopje writes): a candidate whose needed time is anything
// else (an import's 'now', a NUL, an oversized value) makes the measure `unreadable` (422) rather than drop it.
//
// The walks (RES-7) take raw candidates by one index in an inner query capped at MEASURE_ROWS + 1, and judge them
// (state, deletion, domain, resolution, time) outside it, so no residual predicate lets a walk read past its cap.
// CROSS JOIN fixes the loop order and INDEXED BY the index, whatever the statistics say.
// - new_users: local_accounts. opened_reports, resolved_reports: reports. instance_reports: reports, each target read
//   by key.
// - instance_accounts: the domain's range of accounts_domain_username. With include_subdomains, the distinct domains
//   by a skip-scan of that index (instancePeers' seek), each domain visited counted, matching or not, up to
//   MEASURE_DOMAINS (one more answers `too_many`), then each matching domain's range, all under the one cap.
// - instance_follows: each local account's edges by follows_pair (account_id first), each target read by key;
//   instance_followers: by follows_target (target_account_id first), each follower read by key. Pending requests and
//   follows between local accounts are candidates too. Neither index is partial and the inner query has no term on
//   follows but the join, so SQLite builds no Bloom filter on follows (a loop over every follow before the cap). Each
//   local account costs one probe, empty or not.
//
// The totals fall as the domain job severs a blocked domain's follows (R38), each round in its own transaction. Kopje
// has no 5-minute cache (base_measure.rb:59-66): each request reads the Store.

export const MEASURE_ROWS = 20_000
export const MEASURE_DOMAINS = 10_000
export const MEASURE_DAYS = 366

export const SERVED_MEASURES = [
	'new_users',
	'opened_reports',
	'resolved_reports',
	'instance_accounts',
	'instance_media_attachments',
	'instance_reports',
	'instance_follows',
	'instance_followers',
] as const

export type ServedMeasure = (typeof SERVED_MEASURES)[number]

// The measures whose total is in the time range (total_in_time_range? true): they need both dates and give
// previous_total.
export const IN_RANGE_MEASURES: ReadonlySet<ServedMeasure> = new Set([
	'new_users',
	'opened_reports',
	'resolved_reports',
])

const DAY_MS = 86_400_000
const DAY_US = 86_400_000_000n
const DAY_NS = 86_400_000_000_000n

// A YYYY-MM-DD date as days since 1970-01-01 (years below 100 included, which Date.UTC would move).
export function dayNumber(date: string): number {
	const at = new Date(0)
	at.setUTCFullYear(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))
	return at.getTime() / DAY_MS
}

// A day as YYYY-MM-DD, its year in four digits (the days a stored ISO time can name, below).
function dayString(day: number): string {
	const at = new Date(day * DAY_MS)
	const two = (n: number) => String(n).padStart(2, '0')
	return `${String(at.getUTCFullYear()).padStart(4, '0')}-${two(at.getUTCMonth() + 1)}-${two(at.getUTCDate())}`
}

// The days a stored ISO time can name (isoTimeSql: a four-digit year).
const FIRST_DAY = dayNumber('0000-01-01')
const LAST_DAY = dayNumber('9999-12-31')

// The days a start_at or end_at may name, both as written and as a UTC instant: after the Gregorian reform, where
// Ruby's Date (Julian before 1582-10-15) and JavaScript's proleptic Gregorian calendar agree, and a year short of
// 9999, so the axis, the windows and the buckets keep four-digit years. Outside them a date is invalid (422).
export const MEASURE_FIRST_DAY = dayNumber('1583-01-01')
export const MEASURE_LAST_DAY = dayNumber('9998-12-31')

function floorDiv(a: bigint, b: bigint): bigint {
	const q = a / b
	return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q
}

// True when a parsed time lies within MEASURE_FIRST_DAY and MEASURE_LAST_DAY, as written and as an instant.
export function measurableTime(time: MeasureTime): boolean {
	const instant = Number(floorDiv(time.ns, DAY_NS))
	return [time.date, instant].every((day) => day >= MEASURE_FIRST_DAY && day <= MEASURE_LAST_DAY)
}

// A start_at or end_at as Mastodon reads it (to_datetime): `date` the calendar day the caller wrote (DateTime#to_date
// keeps the offset), as days since 1970-01-01, and `ns` the instant in nanoseconds since the epoch.
export type MeasureTime = { date: number; ns: bigint }

// Calendar days, both included, as days since 1970-01-01; none when first > last.
export type DayWindow = { first: number; last: number }

// A request's dates: the series' axis (UTC dates), the total's window and the previous one.
export type MeasurePeriod = { axis: string[]; current: DayWindow; previous: DayWindow }

export type MeasureRows = 'accounts' | 'reports' | 'follows' | 'domains'

export type MeasureValue = { total: number; previousTotal: number | null; data: { date: string; value: number }[] }

export type MeasureResult =
	{ status: 'ok'; measure: MeasureValue } | { status: 'too_many'; rows: MeasureRows } | { status: 'unreadable' }

// `domain` is normalized, or null for none or one that is no domain name, which no account's domain equals: its
// instance_* total is 0 (Mastodon counts the local accounts for an absent domain). `period` is null without both
// dates, and never for an in-range measure (the handler refuses it).
export type MeasureInput = {
	key: ServedMeasure
	domain: string | null
	includeSubdomains: boolean
	period: MeasurePeriod | null
}

// The period of start_at and end_at, or `too_long` past MEASURE_DAYS days. The axis is QueryHelper's
// (query_helper.rb:18-24): generate_series(start_at::timestamp, end_at::timestamp, '1 day')::date of each instant as
// Rails quotes it (UTC, microseconds truncated), none when end_at < start_at; at most MEASURE_DAYS + 1 steps are
// generated, one past the cap to detect it. The windows are BaseMeasure's time_period and previous_time_period.
export function measurePeriod(start: MeasureTime, end: MeasureTime): MeasurePeriod | 'too_long' {
	const axis: string[] = []
	const last = floorDiv(end.ns, 1000n)
	for (let at = floorDiv(start.ns, 1000n); at <= last && axis.length <= MEASURE_DAYS; at += DAY_US) {
		axis.push(dayString(Number(floorDiv(at, DAY_US))))
	}
	if (axis.length > MEASURE_DAYS) {
		return 'too_long'
	}
	const length = end.ns - start.ns
	const shifted = (day: number) => Number(floorDiv(BigInt(day) * DAY_NS - length, DAY_NS))
	return {
		axis,
		current: { first: start.date, last: end.date },
		previous: { first: shifted(start.date), last: shifted(end.date) },
	}
}

// True when an account's domain `column` is the request's domain (?1), or with ?2 a subdomain of it, by bytes.
const matchSql = (column: string) =>
	`coalesce(${column} = ?1 OR (?2 AND substr(CAST(${column} AS BLOB), -length(CAST(?1 AS BLOB)) - 1)
		= CAST('.' || ?1 AS BLOB)), 0)`

// A walk: its candidates (`from`, before the cap) and, per candidate, whether it counts (`kept`), whether it needs
// its time (`dated`: for a window or the series; ?5 is 1 when the request has dates) and the time (`time`).
type Walk = {
	rows: Exclude<MeasureRows, 'domains'>
	with?: string
	from: string
	kept: string
	dated: string
	time: string
}

const PEERS = `WITH RECURSIVE peers(domain) AS (
		SELECT (SELECT min(domain) FROM accounts INDEXED BY accounts_domain_username WHERE domain IS NOT NULL)
		UNION ALL
		SELECT (SELECT min(domain) FROM accounts INDEXED BY accounts_domain_username WHERE domain > peers.domain)
		FROM peers WHERE peers.domain IS NOT NULL
		LIMIT ${MEASURE_DOMAINS + 1}
	), matched(domain) AS (SELECT domain FROM peers WHERE ${matchSql('domain')})`

// An instance_* candidate dates the series when it is on the domain itself.
const ON_DOMAIN = '?5 AND a.domain = ?1'

export type WalkedMeasure = Exclude<ServedMeasure, 'instance_media_attachments'>

export function walkOf(key: WalkedMeasure, includeSubdomains: boolean): Walk {
	switch (key) {
		case 'new_users':
			return { rows: 'accounts', from: 'local_accounts l', kept: '1', dated: '?5', time: isoTimeSql('l.created_at') }
		case 'opened_reports':
			return { rows: 'reports', from: 'reports r', kept: '1', dated: '?5', time: isoTimeSql('r.created_at') }
		case 'resolved_reports':
			return {
				rows: 'reports',
				from: 'reports r',
				kept: 'r.action_taken_at IS NOT NULL',
				dated: '?5',
				time: isoTimeSql('r.action_taken_at'),
			}
		case 'instance_reports':
			return {
				rows: 'reports',
				from: `reports r CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = r.target_account_id`,
				kept: matchSql('a.domain'),
				dated: ON_DOMAIN,
				time: isoTimeSql('r.created_at'),
			}
		case 'instance_accounts':
			return {
				rows: 'accounts',
				...(includeSubdomains
					? {
							with: PEERS,
							from: 'matched k CROSS JOIN accounts a INDEXED BY accounts_domain_username ON a.domain = k.domain',
						}
					: { from: 'accounts a INDEXED BY accounts_domain_username WHERE a.domain = ?1' }),
				kept: `NOT ${deletingSql('a')}`,
				dated: ON_DOMAIN,
				time: isoTimeSql('a.created_at'),
			}
		case 'instance_follows':
		case 'instance_followers':
			return {
				rows: 'follows',
				from:
					key === 'instance_follows'
						? `local_accounts l CROSS JOIN follows f INDEXED BY follows_pair ON f.account_id = l.account_id
			CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = f.target_account_id`
						: `local_accounts l CROSS JOIN follows f INDEXED BY follows_target ON f.target_account_id = l.account_id
			CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = f.account_id`,
				kept: `f.state = 'accepted' AND ${matchSql('a.domain')}`,
				dated: ON_DOMAIN,
				time: isoTimeSql('f.created_at'),
			}
	}
}

// A walk's statement: one row per bucket: each day from ?3 to ?4 that has candidates, 'skip' (not counted), 'undated'
// (counted, no time needed), 'bad' (a needed time unreadable) and 'out' (a time outside those days), and for a walk
// with peers 'domains' (the domains the skip-scan visited). `n` counts a bucket's candidates, `m` those at 00:00:00.000
// UTC exactly. Each bucket is at most 10 bytes and two integers.
export function walkSql(walk: Walk): string {
	const domains =
		walk.with === undefined ? '' : `\n\tUNION ALL SELECT 'domains', count(*), 0 FROM peers WHERE domain IS NOT NULL`
	return `${walk.with ?? ''}
	SELECT CASE WHEN NOT w.kept THEN 'skip' WHEN NOT w.dated THEN 'undated' WHEN w.t IS NULL THEN 'bad'
		WHEN substr(w.t, 1, 10) BETWEEN ?3 AND ?4 THEN substr(w.t, 1, 10) ELSE 'out' END AS bucket,
		count(*) AS n, count(CASE WHEN substr(w.t, 11) = 'T00:00:00.000Z' THEN 1 END) AS m
	FROM (SELECT ${walk.kept} AS kept, ${walk.dated} AS dated, ${walk.time} AS t FROM ${walk.from}
		LIMIT ${MEASURE_ROWS + 1}) w
	GROUP BY bucket${domains}`
}

type Bucket = { bucket: string; n: number; m: number }

// A window's rows: those of the days from its first, included, to its last, excluded, and the last day's at 00:00.
function windowCount(days: ReadonlyMap<number, Bucket>, window: DayWindow): number {
	if (window.first > window.last) {
		return 0
	}
	let count = days.get(window.last)?.m ?? 0
	for (const [day, bucket] of days) {
		if (day >= window.first && day < window.last) {
			count += bucket.n
		}
	}
	return count
}

// The days the buckets keep apart: the axis and, for an in-range measure, each window that holds a day, within the
// days a stored time can name; null when there are none.
function bucketDays(period: MeasurePeriod | null, inRange: boolean): { lo: string; hi: string } | null {
	if (period === null) {
		return null
	}
	const ends = period.axis.length === 0 ? [] : [dayNumber(period.axis[0]!), dayNumber(period.axis.at(-1)!)]
	if (inRange) {
		for (const window of [period.current, period.previous]) {
			if (window.first <= window.last) {
				ends.push(window.first, window.last)
			}
		}
	}
	if (ends.length === 0) {
		return null
	}
	const lo = Math.max(FIRST_DAY, Math.min(...ends))
	const hi = Math.min(LAST_DAY, Math.max(...ends))
	return lo > hi ? null : { lo: dayString(lo), hi: dayString(hi) }
}

function measureOf(db: Db, { key, domain, includeSubdomains, period }: MeasureInput): MeasureResult {
	const series = (value: (date: string) => number) => (period?.axis ?? []).map((date) => ({ date, value: value(date) }))
	const inRange = IN_RANGE_MEASURES.has(key)
	if (key === 'instance_media_attachments' || (!inRange && domain === null)) {
		return { status: 'ok', measure: { total: 0, previousTotal: null, data: series(() => 0) } }
	}
	const walk = walkOf(key, includeSubdomains)
	const days = bucketDays(period, inRange)
	const buckets = db.all<Bucket>(
		walkSql(walk),
		domain,
		includeSubdomains ? 1 : 0,
		days?.lo ?? null,
		days?.hi ?? null,
		period === null ? 0 : 1
	)
	let candidates = 0
	let counted = 0
	let unreadable = 0
	let domains = 0
	const byDay = new Map<number, Bucket>()
	for (const bucket of buckets) {
		if (bucket.bucket === 'domains') {
			domains = bucket.n
			continue
		}
		candidates += bucket.n
		if (bucket.bucket === 'bad') {
			unreadable += bucket.n
		} else if (bucket.bucket !== 'skip') {
			counted += bucket.n
			if (bucket.bucket !== 'undated' && bucket.bucket !== 'out') {
				byDay.set(dayNumber(bucket.bucket), bucket)
			}
		}
	}
	if (domains > MEASURE_DOMAINS) {
		return { status: 'too_many', rows: 'domains' }
	}
	if (candidates > MEASURE_ROWS) {
		return { status: 'too_many', rows: walk.rows }
	}
	if (unreadable > 0) {
		return { status: 'unreadable' }
	}
	const data = series((date) => byDay.get(dayNumber(date))?.n ?? 0)
	if (inRange && period !== null) {
		const current = windowCount(byDay, period.current)
		return { status: 'ok', measure: { total: current, previousTotal: windowCount(byDay, period.previous), data } }
	}
	return { status: 'ok', measure: { total: counted, previousTotal: null, data } }
}

// One measure, in its own read transaction.
export const adminMeasure = adminReadOperation<MeasureInput, MeasureResult>(
	ADMIN_PERMISSION.viewDashboard,
	(db, input) => measureOf(db, input)
)
