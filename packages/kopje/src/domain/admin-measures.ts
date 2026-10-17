import { ADMIN_PERMISSION, adminReadOperation } from './auth'

// The measure instance_follows (Mastodon's Admin::Metrics::Measure::InstanceFollowsMeasure,
// app/lib/admin/metrics/measure/instance_follows_measure.rb), the one measure Kopje serves, for Fediblockhole's default
// check before a block stricter than silence (fediblockhole/__init__.py:529-598). To the OAuth admin with
// view_dashboard.
//
// - total: the accepted follows whose target's domain is `domain`, or with `includeSubdomains` also a subdomain of it
//   (instance_follows_measure.rb:20-24). Every stored follow has a local side, so the follows of remote targets are
//   local accounts' follows, as Mastodon counts them. A pending request is not a follow (Mastodon stores requests
//   apart), so it never holds a block back.
// - data: per UTC day of follows.created_at from `range.start` to `range.end`, both dates included, at most
//   MEASURE_DAYS days. A follow that began as a request keeps the request's time (inbox.ts, accounts.ts authorize),
//   so the series is dated by request, not acceptance; Fediblockhole reads only the total.
// - the walk: every local account's accepted follows through follows_accepted, each target read by primary key, at
//   most MEASURE_FOLLOWS rows. Beyond that the answer is `too_many` (422), never an undercount.
//
// The total falls as the domain job severs a blocked domain's follows (R38), each round in its own transaction, and a
// follow made between Fediblockhole's measure and its block is not seen: Mastodon has the same gap.

export const MEASURE_FOLLOWS = 20_000
export const MEASURE_DAYS = 366

const DAY_MS = 86_400_000

export type MeasureRange = { start: string; end: string }

export type InstanceFollows = { total: number; data: { date: string; value: number }[] }

export type InstanceFollowsResult =
	{ status: 'ok'; measure: InstanceFollows } | { status: 'too_many' } | { status: 'too_long' }

// The days from `start` to `end` (YYYY-MM-DD, both included); none when `end` is before `start`, as Mastodon's
// generate_series gives none (query_helper.rb:18-24).
function days(range: MeasureRange): string[] {
	const from = Date.parse(`${range.start}T00:00:00Z`)
	const to = Date.parse(`${range.end}T00:00:00Z`)
	const out: string[] = []
	for (let at = from; at <= to && out.length <= MEASURE_DAYS; at += DAY_MS) {
		out.push(new Date(at).toISOString().slice(0, 10))
	}
	return out
}

// `domain` is normalized, or null for one that is no domain name, which no account's domain equals.
export const instanceFollowsMeasure = adminReadOperation<
	{ domain: string | null; includeSubdomains: boolean; range: MeasureRange | null },
	InstanceFollowsResult
>(ADMIN_PERMISSION.viewDashboard, (db, { domain, includeSubdomains, range }) => {
	const series = range === null ? [] : days(range)
	if (series.length > MEASURE_DAYS) {
		return { status: 'too_long' }
	}
	// A local target's domain is NULL, which matches nothing. Buckets: 'other' (not on the domain), a day of the
	// series, or 'total' (on the domain, outside the series), so at most MEASURE_DAYS + 2 rows leave SQLite.
	const matches = `?1 IS NOT NULL AND (w.domain = ?1 OR (?2 AND substr(w.domain, -length(?1) - 1) = '.' || ?1))`
	const rows = db.all<{ bucket: string; n: number }>(
		`WITH w AS (
			SELECT f.created_at, a.domain FROM local_accounts l
			JOIN follows f INDEXED BY follows_accepted ON f.account_id = l.account_id AND f.state = 'accepted'
			JOIN accounts a ON a.id = f.target_account_id
			LIMIT ${MEASURE_FOLLOWS + 1}
		)
		SELECT CASE WHEN NOT coalesce(${matches}, 0) THEN 'other'
			WHEN substr(w.created_at, 1, 10) BETWEEN ?3 AND ?4 THEN substr(w.created_at, 1, 10) ELSE 'total' END AS bucket,
			count(*) AS n
		FROM w GROUP BY bucket`,
		domain,
		includeSubdomains ? 1 : 0,
		series[0] ?? null,
		series.at(-1) ?? null
	)
	if (rows.reduce((sum, row) => sum + row.n, 0) > MEASURE_FOLLOWS) {
		return { status: 'too_many' }
	}
	const counts = new Map(rows.map((row) => [row.bucket, row.n]))
	const total = rows.filter((row) => row.bucket !== 'other').reduce((sum, row) => sum + row.n, 0)
	return {
		status: 'ok',
		measure: { total, data: series.map((date) => ({ date, value: counts.get(date) ?? 0 })) },
	}
})
