import { isDistributable, type Visibility } from './audience'
import { readOperation, sessionOperation, writeOperation } from './operation'
import type { Db } from '../db/sql'
import { toStoreUnavailable } from '../platform/store-errors'
import type { StoreKernel } from '../platform/store-kernel'
import {
	ACTIVITY_KINDS,
	ACTIVITY_VALUE_MAX,
	isActivityAccountId,
	settingProjectionSql,
	utcDay,
} from '../platform/stored-bounds'

// GET /api/v1/instance/activity (Mastodon's Api::V1::Instances::ActivityController and ActivityTracker), from the
// tables of migration 0072_activity_tracking. This module is their only writer (test-node/policy-boundary.test.ts):
//   - statuses: each local public or unlisted status or boost, counted in the transaction that creates it
//     (Status#update_statistics); a deletion takes nothing back.
//   - registrations: each local account the setup creates (User#prepare_new_user!); imports and restores count none.
//   - logins: the local accounts with a login on a UTC day: the setup's account (prepare_new_user! records its login
//     too) and an account's authenticated request (auth.ts noteActivity, at most one Store call per token and day).
// Days are UTC dates YYYY-MM-DD. Mastodon's sum reads the 6 days D-7i to D-7i+5 for week i (week_edge_days' exclusive
// range), so week 0 holds today only and the day before each week's start is never counted.

export const ACTIVITY_WEEKS = 12
export const ACTIVITY_WINDOW_DAYS = 6

// RES-4: the rows kept are those of today and the ACTIVITY_RETENTION_DAYS before it (Mastodon's 6-month expiry),
// and tomorrow's (a clock ahead of the Store's); the cron deletes the others, at most ACTIVITY_PRUNE_ROWS a table a
// run.
export const ACTIVITY_RETENTION_DAYS = 184
export const ACTIVITY_PRUNE_ROWS = 500

// RES-7: the login rows a window reads (raw candidates, before COUNT(DISTINCT)): 6 days of 100 accounts. A window with
// more counts the distinct accounts of its first ACTIVITY_LOGIN_ROWS rows by (day, account_id).
export const ACTIVITY_LOGIN_ROWS = 600

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

type Kind = (typeof ACTIVITY_KINDS)[number]

// Adds one to the day's count of `kind`, saturating at ACTIVITY_VALUE_MAX. A time outside the CHECK's days counts
// nothing, so the write never fails on it.
function count(db: Db, kind: Kind, now: number): void {
	const day = utcDay(now)
	if (day === null) {
		return
	}
	db.run(
		`INSERT INTO activity_counts (kind, day, value) VALUES (?1, ?2, 1)
		ON CONFLICT (kind, day) DO UPDATE SET value = MIN(value + 1, ?3)`,
		kind,
		day,
		ACTIVITY_VALUE_MAX
	)
}

// A local status or boost created with `visibility` (Status#distributable?: public or unlisted).
export function countStatus(db: Db, visibility: Visibility, now: number): void {
	if (isDistributable(visibility)) {
		count(db, 'statuses', now)
	}
}

// A local account created by the setup.
export function countRegistration(db: Db, now: number): void {
	count(db, 'registrations', now)
}

// A login of the local account `accountId` on the UTC day of `now`, once per account and day. An id outside the
// CHECK's form (a converted account's) is not recorded, so the write never fails on it.
export function recordLogin(db: Db, accountId: string, now: number): void {
	const day = utcDay(now)
	if (day === null || !isActivityAccountId(accountId)) {
		return
	}
	db.run('INSERT INTO activity_logins (day, account_id) VALUES (?, ?) ON CONFLICT DO NOTHING', day, accountId)
}

// activity_api_enabled read through its bound: off only when stored 'false'; no row is on (Mastodon's default).
function enabled(db: Db): boolean {
	const row = db.first<{ value: string | null }>(
		`SELECT ${settingProjectionSql('activity_api_enabled', 'value')} AS value FROM instance_settings
		WHERE name = 'activity_api_enabled'`
	)
	return row?.value !== 'false'
}

// One window's three values. Each sum reads at most 6 rows of activity_counts by its key; the logins read at most
// ACTIVITY_LOGIN_ROWS rows of activity_logins by its key, then count the distinct accounts among them.
export const ACTIVITY_WINDOW_SQL = `SELECT
	(SELECT SUM(value) FROM activity_counts WHERE kind = 'statuses' AND day >= ?1 AND day < ?2) AS statuses,
	(SELECT COUNT(DISTINCT account_id) FROM (SELECT account_id FROM activity_logins
		WHERE day >= ?1 AND day < ?2 ORDER BY day, account_id LIMIT ?3)) AS logins,
	(SELECT SUM(value) FROM activity_counts WHERE kind = 'registrations' AND day >= ?1 AND day < ?2) AS registrations`

export type ActivityWeek = { week: string; statuses: string; logins: string; registrations: string }

// The 12 weeks at `now`, as ActivityController#activity: `week` the start's Unix seconds (i.weeks.ago.to_i), and
// the counts as strings. A window ends after today at the latest: Mastodon's week 0 also names the 5 days after today,
// which hold no key there; here an imported or restored later day is never read.
export function activityWeeks(db: Db, now: number): ActivityWeek[] {
	return Array.from({ length: ACTIVITY_WEEKS }, (_, i) => {
		const start = now - i * WEEK_MS
		const first = utcDay(start)
		const end = utcDay(Math.min(start + ACTIVITY_WINDOW_DAYS * DAY_MS, now + DAY_MS))
		const row =
			first === null || end === null
				? undefined
				: db.first<{ statuses: number | null; logins: number; registrations: number | null }>(
						ACTIVITY_WINDOW_SQL,
						first,
						end,
						ACTIVITY_LOGIN_ROWS
					)
		return {
			week: String(Math.floor(start / 1000)),
			statuses: String(row?.statuses ?? 0),
			logins: String(row?.logins ?? 0),
			registrations: String(row?.registrations ?? 0),
		}
	})
}

// ---- The answer, kept for its UTC day (Mastodon's render_with_cache keeps it a day)

// The kopje_state row holding the answer: never dumped (dump-catalog.ts DUMPED_STATE), written only here.
const ANSWER = 'activity_answer'

// What a kept answer is valid for: the UTC day it was made, and the publication state (store-flags.ts `published` and
// `unpublished`), so the answer of an empty Store is not served once an import into it is verified or published.
type AnswerKey = { day: string | null; flags: string }

function answerKey(db: Db, now: number): AnswerKey {
	const flags = db.all<{ name: string; value: string }>(
		"SELECT name, CAST(value AS TEXT) AS value FROM kopje_state WHERE name IN ('published', 'unpublished') ORDER BY name"
	)
	return { day: utcDay(now), flags: JSON.stringify(flags) }
}

// The kept answer that serves a request of `key`: one of the same publication state made on the request's day or a
// later one. A request whose time is behind the kept answer's (one delayed in the Worker) is served the newer answer
// and never replaces it, so a day has one answer. null when there is none, it is of an earlier day or another state,
// or the row is not one this module writes.
function keptAnswer(db: Db, key: AnswerKey): string | null {
	const row = db.first<{ value: SqlStorageValue }>('SELECT value FROM kopje_state WHERE name = ?', ANSWER)
	if (typeof row?.value !== 'string' || key.day === null) {
		return null
	}
	try {
		const kept = JSON.parse(row.value) as { day?: unknown; flags?: unknown; body?: unknown }
		return typeof kept.day === 'string' &&
			kept.day >= key.day &&
			kept.flags === key.flags &&
			typeof kept.body === 'string'
			? kept.body
			: null
	} catch {
		return null
	}
}

// Forgets the kept answer: the setting changed (domain/instance.ts setInstanceSettings).
export function forgetActivityAnswer(db: Db): void {
	db.run('DELETE FROM kopje_state WHERE name = ?', ANSWER)
}

type ActivityLookup = { status: 'disabled' } | { status: 'kept'; body: string } | { status: 'stale' }

// The first step of a request (answerInstanceActivity): off answers 404 without reading the answer or the counts.
export const instanceActivity = readOperation<{ now: number }, ActivityLookup>((db, { now }) => {
	if (!enabled(db)) {
		return { status: 'disabled' }
	}
	const body = keptAnswer(db, answerKey(db, now))
	return body === null ? { status: 'stale' } : { status: 'kept', body }
})

// The answer made and kept for the day: the first request of a UTC day, or after the setting or the publication
// state changed. A session operation, so it is kept while the Store is readonly; a request that finds an answer kept
// meanwhile, or a newer one, gets it. null when the setting is off.
export const keepInstanceActivity = sessionOperation<{ now: number }, string | null>((db, { now }) => {
	if (!enabled(db)) {
		return null
	}
	const key = answerKey(db, now)
	const kept = keptAnswer(db, key)
	if (kept !== null) {
		return kept
	}
	const body = JSON.stringify(activityWeeks(db, now))
	if (key.day !== null) {
		db.run(
			'INSERT OR REPLACE INTO kopje_state (name, value) VALUES (?, ?)',
			ANSWER,
			JSON.stringify({ day: key.day, flags: key.flags, body })
		)
	}
	return body
})

// The answer when the Store refuses keepInstanceActivity (a dump's freeze): the kept one if it serves, else made
// without keeping it. null when off.
export const madeInstanceActivity = readOperation<{ now: number }, string | null>((db, { now }) => {
	if (!enabled(db)) {
		return null
	}
	return keptAnswer(db, answerKey(db, now)) ?? JSON.stringify(activityWeeks(db, now))
})

// The Store's operations this answer runs (store.ts passes its kernel).
type ActivityKernel = Pick<StoreKernel, 'execute' | 'executeProbing'>

// GET /api/v1/instance/activity in the Store: the JSON body, or null when the API is off. The day's kept answer is
// read first; otherwise the answer is made and kept, or, while the Store refuses keeping it (a dump's freeze, probed
// with the read or met by the keep when a dump began between them), made without keeping it. Other refusals stand.
export async function answerInstanceActivity(
	kernel: ActivityKernel,
	callerBuild: string,
	input: { now: number }
): Promise<string | null> {
	const { output, refused } = await kernel.executeProbing(callerBuild, instanceActivity, input, 'session')
	if (output.status !== 'stale') {
		return output.status === 'kept' ? output.body : null
	}
	if (refused === null) {
		try {
			return await kernel.execute(callerBuild, keepInstanceActivity, input)
		} catch (error) {
			if (toStoreUnavailable(error)?.reason !== 'dump-in-progress') {
				throw error
			}
		}
	}
	return kernel.execute(callerBuild, madeInstanceActivity, input)
}

// ---- Retention (the 5-minute cron, jobs/scheduled.ts)

type ActivityPruned = { counts: number; logins: number }

// RES-4: deletes up to ACTIVITY_PRUNE_ROWS rows of each table outside the kept days (before today -
// ACTIVITY_RETENTION_DAYS, or after tomorrow: an imported or restored day), oldest first, each by its key's range. The
// deleted rows are the cursor: a run that finds such rows deletes at least one.
export const pruneActivity = writeOperation<{ now: number }, ActivityPruned>((db, { now }) => {
	const oldest = utcDay(now - ACTIVITY_RETENTION_DAYS * DAY_MS)
	const latest = utcDay(now + DAY_MS)
	if (oldest === null || latest === null) {
		return { counts: 0, logins: 0 }
	}
	let counts = 0
	for (const kind of ACTIVITY_KINDS) {
		for (const range of ['day < ?2', 'day > ?3']) {
			counts += db.all(
				`DELETE FROM activity_counts WHERE kind = ?1 AND day IN
					(SELECT day FROM activity_counts WHERE kind = ?1 AND ${range} ORDER BY day LIMIT ?4)
				RETURNING day`,
				kind,
				oldest,
				latest,
				ACTIVITY_PRUNE_ROWS - counts
			).length
		}
	}
	let logins = 0
	for (const range of ['day < ?1', 'day > ?2']) {
		logins += db.all(
			`DELETE FROM activity_logins WHERE (day, account_id) IN
				(SELECT day, account_id FROM activity_logins WHERE ${range} ORDER BY day, account_id LIMIT ?3)
			RETURNING day`,
			oldest,
			latest,
			ACTIVITY_PRUNE_ROWS - logins
		).length
	}
	return { counts, logins }
})
