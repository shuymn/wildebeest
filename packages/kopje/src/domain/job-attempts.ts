import { writeOperation } from './operation'
import type { Db } from '../db/sql'
import { errorFields } from '../platform/error-message'

export type Isolated<T> = { ok: true; value: T } | { ok: false; error: unknown }

// Runs one step in its own savepoint of the operation's transaction (Db.savepoint): when fn throws, its writes are
// rolled back and its error (any thrown value) is returned, and the operation goes on with the writes before and
// around it. An error that is not fn's own propagates: the savepoint is unavailable, or its rollback failed. This is
// no transaction-health check: after an error SQLite cannot recover from, workerd may skip the rollback and rethrow
// fn's error, and then the enclosing operation fails at its commit and nothing commits. A row budget for the step is
// created inside fn: the rollback does not reduce total_changes().
export function isolated<T>(db: Db, fn: () => T): Isolated<T> {
	const thrown: { error?: unknown; by: boolean } = { by: false }
	try {
		const value = db.savepoint(() => {
			try {
				return fn()
			} catch (error) {
				thrown.by = true
				thrown.error = error
				throw error
			}
		})
		return { ok: true, value }
	} catch (error) {
		if (thrown.by && Object.is(error, thrown.error)) {
			return { ok: false, error }
		}
		throw error
	}
}

// ---- Retry state of a job row (RES-5)

// The delays after a job's 1st…5th consecutive failed or stalled batch; the 6th parks it (MAX_JOB_ATTEMPTS).
export const JOB_RETRY_DELAYS_MS: readonly number[] = [5, 10, 20, 40, 80].map((minutes) => minutes * 60_000)
export const MAX_JOB_ATTEMPTS = JOB_RETRY_DELAYS_MS.length + 1
// due_at's bound: a time in ms that a JavaScript number holds exactly (2^53 − 1).
export const SAFE_MS = Number.MAX_SAFE_INTEGER
// Rows retryParkedJobs resets per call.
export const RETRY_JOBS_LIMIT = 100

// A table of jobs with the retry columns. `key`: the columns a row is named by, bound in this order; `order`: the
// order its fresh rows run in; `pending`: the predicate of a row with work left (both partial indexes carry it).
export type JobTable = {
	table: string
	family: string
	key: readonly string[]
	order: string
	pending: string
}

export const INBOUND_JOBS: JobTable = {
	table: 'inbound_jobs',
	family: 'inbound',
	key: ['kind', 'key'],
	order: 'created_at, kind, key',
	pending: 'done_at IS NULL',
}

// The tables retryParkedJobs walks, in this order.
export const JOB_TABLES: readonly JobTable[] = [INBOUND_JOBS]

// The two retry columns of a job table, whose CHECKs make every accepted row exactly one state, imported rows
// included: fresh (attempts 0, due_at NULL), backing off (attempts 1…MAX − 1, due_at an integer time in 0…SAFE_MS)
// or parked (attempts MAX, due_at NULL). A migration holds this output (test/migrations.test.ts).
export function jobAttemptColumnsSql(table: string): string {
	const last = MAX_JOB_ATTEMPTS
	return `ALTER TABLE ${table} ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(attempts) = 'integer' AND attempts BETWEEN 0 AND ${last});
ALTER TABLE ${table} ADD COLUMN due_at INTEGER CHECK (
  (attempts = 0 AND due_at IS NULL)
  OR (attempts BETWEEN 1 AND ${last - 1} AND typeof(due_at) = 'integer' AND due_at BETWEEN 0 AND ${SAFE_MS})
  OR (attempts = ${last} AND due_at IS NULL));
`
}

// The two partial indexes the selection seeks: the fresh rows in their order, and the failing rows (backing off,
// then parked with due_at NULL first) by due_at.
export function jobAttemptIndexesSql(t: JobTable): string {
	return `CREATE INDEX ${t.table}_fresh ON ${t.table} (${t.order}) WHERE ${t.pending} AND attempts = 0;
CREATE INDEX ${t.table}_failing ON ${t.table} (due_at) WHERE ${t.pending} AND attempts > 0;
`
}

// Whether the row may run at ?1 (now): fresh, or backing off and due. A parked row's NULL due_at never is.
export function jobDueSql(alias = ''): string {
	const a = alias === '' ? '' : `${alias}.`
	return `(${a}attempts = 0 OR ${a}due_at <= ?1)`
}

function keyMatch(t: JobTable, from: number): string {
	return t.key.map((column, i) => `${column} = ?${from + i}`).join(' AND ')
}

type JobKey = Record<string, SqlStorageValue>

// The next job to run at `now`: the first backing-off row that is due, else the oldest fresh one; each one seek of its
// partial index. Undefined when neither has a row, which is also when the family has no pending work.
export function nextJob<K extends JobKey>(db: Db, t: JobTable, now: number): K | undefined {
	const columns = t.key.join(', ')
	return (
		db.first<K>(
			`SELECT ${columns} FROM ${t.table} INDEXED BY ${t.table}_failing
			WHERE ${t.pending} AND attempts > 0 AND due_at <= ?1 ORDER BY due_at LIMIT 1`,
			now
		) ??
		db.first<K>(
			`SELECT ${columns} FROM ${t.table} INDEXED BY ${t.table}_fresh
			WHERE ${t.pending} AND attempts = 0 ORDER BY ${t.order} LIMIT 1`
		)
	)
}

// The transition of a pending row whose batch failed or did not advance: one more attempt, and the delay of that
// attempt (clamped to SAFE_MS) or, at MAX_JOB_ATTEMPTS, parked. A parked row is never selected, so a selected one
// has attempts < MAX and the transition is total. RETURNING the new count.
function attemptSql(t: JobTable): string {
	const delays = JOB_RETRY_DELAYS_MS.map((ms, i) => `WHEN ${i + 1} THEN ${ms}`).join(' ')
	return `UPDATE ${t.table} SET attempts = attempts + 1,
		due_at = CASE attempts + 1 WHEN ${MAX_JOB_ATTEMPTS} THEN NULL
			ELSE min(CAST(max(?1, 0) AS INTEGER) + CASE attempts + 1 ${delays} END, ${SAFE_MS}) END
	WHERE ${keyMatch(t, 2)} AND ${t.pending} AND attempts < ${MAX_JOB_ATTEMPTS}
	RETURNING attempts`
}

export type JobFailure = { outcome: 'error'; error: unknown } | { outcome: 'stall' }

// Records a failed or stalled batch on its row (attemptSql) and logs it: kopje.jobs.item.failed at error, and
// kopje.jobs.item.parked when this attempt parked it. The logs name the family, never the row (DATA-5). Written in
// the enclosing operation's transaction, after the batch's savepoint rolled back, so it commits with that operation.
export function recordJobAttempt(
	db: Db,
	t: JobTable,
	key: readonly SqlStorageValue[],
	now: number,
	failure: JobFailure
): void {
	const attempts = db.first<{ attempts: number }>(attemptSql(t), now, ...key)?.attempts
	if (attempts === undefined) {
		return
	}
	const parked = attempts >= MAX_JOB_ATTEMPTS
	console.error({
		event: 'kopje.jobs.item.failed',
		family: t.family,
		outcome: failure.outcome,
		attempts,
		parked,
		...(failure.outcome === 'error' ? errorFields(failure.error) : {}),
	})
	if (parked) {
		console.warn({ event: 'kopje.jobs.item.parked', family: t.family })
	}
}

// A batch that advanced its row after failed or stalled ones: the row is fresh again.
export function resetJobAttempts(db: Db, t: JobTable, key: readonly SqlStorageValue[]): void {
	db.run(`UPDATE ${t.table} SET attempts = 0, due_at = NULL WHERE ${keyMatch(t, 1)} AND attempts > 0`, ...key)
}

// The SET clause that makes a row fresh, for the writes that finish a job or start it again.
export const FRESH_ATTEMPTS_SQL = 'attempts = 0, due_at = NULL'

// POST /admin/jobs/retry (D8, RES-5): at most `limit` failing rows (backing off or parked) made fresh, walked through
// each table's failing index in JOB_TABLES order; nothing else of a row changes (its cursor, bound and tombstone
// stay). A reset row leaves the index, so the next call continues without a cursor. `more`: a failing row remains.
export const retryParkedJobs = writeOperation<{ limit?: number }, { reset: number; more: boolean }>((db, input) => {
	let left = Math.min(Math.max(Math.trunc(input.limit ?? RETRY_JOBS_LIMIT), 1), RETRY_JOBS_LIMIT)
	let reset = 0
	for (const t of JOB_TABLES) {
		if (left === 0) {
			break
		}
		const columns = t.key.join(', ')
		const n = db.run(
			`UPDATE ${t.table} SET ${FRESH_ATTEMPTS_SQL} WHERE (${columns}) IN (SELECT ${columns}
				FROM ${t.table} INDEXED BY ${t.table}_failing WHERE ${t.pending} AND attempts > 0 ORDER BY due_at LIMIT ?1)`,
			left
		)
		reset += n
		left -= n
	}
	const more = JOB_TABLES.some(
		(t) =>
			db.first(
				`SELECT 1 AS x FROM ${t.table} INDEXED BY ${t.table}_failing WHERE ${t.pending} AND attempts > 0 LIMIT 1`
			) !== undefined
	)
	return { reset, more }
})
