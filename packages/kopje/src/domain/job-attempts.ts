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
export const RETRY_JOBS_LIMIT = 100

// The SET clause that makes a row fresh, for the writes that finish a job or start it again.
export const FRESH_ATTEMPTS_SQL = 'attempts = 0, due_at = NULL'

// The rows an item's retry state writes after its batch (runJobItem): its attempt when the batch fails, or its reset
// when a due retry runs through. A family whose rounds have a row budget reserves it before granting the batch any.
export const JOB_BOOKKEEPING_ROWS = 1

// A table of jobs with the retry columns. `key`: the columns a row is named by, bound in this order; `fresh`: the
// columns of its fresh index; `order`: the order its fresh rows run in, which that index serves (its own columns, or
// a rowid table's rowid after an index on attempts); `pending`: the predicate of a row with work left (both
// partial indexes carry it), absent where every row has work left (a finished job's row is deleted); `rowid`: a rowid
// table, whose rows the retry walk finds by rowid (a lookup whatever the statistics say); `integerKey`: its key is
// one INTEGER column, read as TEXT and bound back with CAST, never through a JavaScript number (an imported id may
// pass 2^53, DATA-6).
export type JobTable = {
	table: string
	family: string
	key: readonly string[]
	fresh: string
	order: string
	pending?: string
	rowid?: true
	integerKey?: true
}

export const INBOUND_JOBS: JobTable = {
	table: 'inbound_jobs',
	family: 'inbound',
	key: ['kind', 'key'],
	fresh: 'created_at, kind, key',
	order: 'created_at, kind, key',
	pending: 'done_at IS NULL',
}

// The tables of the other families (migration 0084_family_job_attempts). Each round's job reads by its key. The
// fresh index of a rowid table run in rowid order holds attempts alone, its entries in rowid order; the domain
// block cleanups run by their time, their fresh index on it.
export const QUOTE_REVOCATIONS: JobTable = {
	table: 'quote_revocations',
	family: 'revocations',
	key: ['authorization', 'actor_uri'],
	fresh: 'revoked_at',
	order: 'revoked_at',
	pending: 'pending = 1',
}

export const DOMAIN_BLOCK_CLEANUPS: JobTable = {
	table: 'domain_block_cleanups',
	family: 'domain_block_cleanups',
	key: ['domain_block_id'],
	fresh: 'created_at, domain_block_id',
	order: 'created_at, domain_block_id',
	rowid: true,
	integerKey: true,
}

export const NOTIFICATION_REQUEST_JOBS: JobTable = {
	table: 'notification_request_jobs',
	family: 'notification_requests',
	key: ['id'],
	fresh: 'attempts',
	order: 'id',
	rowid: true,
	integerKey: true,
}

export const NOTIFICATION_CLEARS: JobTable = {
	table: 'notification_clears',
	family: 'notification_clears',
	key: ['account_id'],
	fresh: 'attempts',
	order: 'rowid',
	rowid: true,
}

export const NOTIFICATION_DISMISSALS: JobTable = {
	table: 'notification_dismissals',
	family: 'notification_dismissals',
	key: ['account_id', 'group_key'],
	fresh: 'attempts',
	order: 'rowid',
	rowid: true,
}

export const MODERATION_JOBS: JobTable = {
	table: 'moderation_jobs',
	family: 'local_moderation',
	key: ['id'],
	fresh: 'attempts',
	order: 'id',
	rowid: true,
	integerKey: true,
}

export const REMOTE_MODERATION_JOBS: JobTable = {
	table: 'remote_moderation_jobs',
	family: 'remote_moderation',
	key: ['id'],
	fresh: 'attempts',
	order: 'id',
	rowid: true,
	integerKey: true,
}

// The tables retryParkedJobs walks, in this order: a jobs round's (src/jobs/queue.ts STORE_JOB_FAMILIES).
export const JOB_TABLES: readonly JobTable[] = [
	INBOUND_JOBS,
	QUOTE_REVOCATIONS,
	DOMAIN_BLOCK_CLEANUPS,
	NOTIFICATION_REQUEST_JOBS,
	NOTIFICATION_CLEARS,
	NOTIFICATION_DISMISSALS,
	MODERATION_JOBS,
	REMOTE_MODERATION_JOBS,
]

// The predicate `condition` of the table's rows with work left.
function pendingAnd(t: JobTable, condition: string): string {
	return t.pending === undefined ? condition : `${t.pending} AND ${condition}`
}

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
	return `CREATE INDEX ${t.table}_fresh ON ${t.table} (${t.fresh}) WHERE ${pendingAnd(t, 'attempts = 0')};
CREATE INDEX ${t.table}_failing ON ${t.table} (due_at) WHERE ${pendingAnd(t, 'attempts > 0')};
`
}

// Whether the row may run at ?1 (now): fresh, or backing off and due. A parked row's NULL due_at never is.
export function jobDueSql(alias = ''): string {
	const a = alias === '' ? '' : `${alias}.`
	return `(${a}attempts = 0 OR ${a}due_at <= ?1)`
}

function keyMatch(t: JobTable, from: number): string {
	return t.key
		.map((column, i) =>
			t.integerKey === true ? `${column} = CAST(?${from + i} AS INTEGER)` : `${column} = ?${from + i}`
		)
		.join(' AND ')
}

// The key columns as nextJob reads them: an INTEGER key as TEXT.
function keyColumns(t: JobTable): string {
	return t.integerKey === true
		? t.key.map((column) => `CAST(${column} AS TEXT) AS ${column}`).join(', ')
		: t.key.join(', ')
}

type JobKey = Record<string, SqlStorageValue>

// What nextJob reads of a row: its key columns, or `columns` (which read an INTEGER key as TEXT); and, for a table
// ordered by its INTEGER key, `after` (that key as TEXT): the fresh seek takes the first row past it, else the first
// (a call's jobs take turns).
type NextJobOptions = { columns?: string; after?: string }

// The next job to run at `now`: the first backing-off row that is due, else the oldest fresh one (past `after`, else
// the oldest); each one seek of its partial index. Undefined when neither has a row: the family has no runnable work
// (backing-off and parked rows may remain). `attempts`: the row's, for runJobItem.
export function nextJob<K extends JobKey>(
	db: Db,
	t: JobTable,
	now: number,
	options: NextJobOptions = {}
): (K & { attempts: number }) | undefined {
	const columns = options.columns ?? keyColumns(t)
	// The order's columns named by their table: a key read as TEXT has their name as its alias, which ORDER BY would
	// take first (a sort by text, through a temporary B-tree).
	const order = t.order
		.split(', ')
		.map((column) => `${t.table}.${column}`)
		.join(', ')
	const fresh = (after: string | undefined) =>
		db.first<K & { attempts: number }>(
			`SELECT ${columns}, attempts FROM ${t.table} INDEXED BY ${t.table}_fresh
			WHERE ${pendingAnd(t, 'attempts = 0')}${after === undefined ? '' : ` AND ${order} > CAST(?1 AS INTEGER)`}
			ORDER BY ${order} LIMIT 1`,
			...(after === undefined ? [] : [after])
		)
	return (
		db.first<K & { attempts: number }>(
			`SELECT ${columns}, attempts FROM ${t.table} INDEXED BY ${t.table}_failing
			WHERE ${pendingAnd(t, 'attempts > 0 AND due_at <= ?1')} ORDER BY due_at LIMIT 1`,
			now
		) ??
		(options.after === undefined ? undefined : fresh(options.after)) ??
		fresh(undefined)
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
	WHERE ${keyMatch(t, 2)} AND ${pendingAnd(t, `attempts < ${MAX_JOB_ATTEMPTS}`)}
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
	db.run(`UPDATE ${t.table} SET ${FRESH_ATTEMPTS_SQL} WHERE ${keyMatch(t, 1)} AND attempts > 0`, ...key)
}

// Runs one item of a family's round, `fn`, in its own savepoint (isolated) and records its outcome on its row: a
// failure is an attempt (recordJobAttempt), a success of a row that had failed makes it fresh. For the families whose
// every item that runs moves its durable state (a cursor, a phase, a deleted row) or finishes, so that only a failure
// counts (RES-5); `attempts`: the row's as selected.
export function runJobItem<T>(
	db: Db,
	t: JobTable,
	key: readonly SqlStorageValue[],
	attempts: number,
	now: number,
	fn: () => T
): Isolated<T> {
	const result = isolated(db, fn)
	if (!result.ok) {
		recordJobAttempt(db, t, key, now, { outcome: 'error', error: result.error })
	} else if (attempts > 0) {
		resetJobAttempts(db, t, key)
	}
	return result
}

// The walk of a table without rowid: one update of the rows its failing index names first, each by its primary key.
// Counted by RETURNING: rowsWritten counts the index rows the update rewrites too.
function retryKeys(db: Db, t: JobTable, limit: number): number {
	const columns = t.key.join(', ')
	return db.all(
		`UPDATE ${t.table} SET ${FRESH_ATTEMPTS_SQL} WHERE (${columns}) IN (SELECT ${columns}
			FROM ${t.table} INDEXED BY ${t.table}_failing WHERE ${pendingAnd(t, 'attempts > 0')} ORDER BY due_at LIMIT ?1)
		RETURNING 1 AS x`,
		limit
	).length
}

// The walk of a rowid table: the rowids its failing index names first, then an update of each by rowid. One update
// of them all (rowid IN …) is planned as a scan of the table when its statistics predate its growth (RES-7).
// Each rowid is read as TEXT and bound back with CAST: an imported one may pass 2^53 (DATA-6).
function retryRowids(db: Db, t: JobTable, limit: number): number {
	const rows = db.all<{ r: string }>(
		`SELECT CAST(rowid AS TEXT) AS r FROM ${t.table} INDEXED BY ${t.table}_failing
		WHERE ${pendingAnd(t, 'attempts > 0')} ORDER BY due_at LIMIT ?1`,
		limit
	)
	for (const { r } of rows) {
		db.run(`UPDATE ${t.table} SET ${FRESH_ATTEMPTS_SQL} WHERE rowid = CAST(? AS INTEGER)`, r)
	}
	return rows.length
}

// POST /admin/jobs/retry (RES-5): at most `limit` failing rows (backing off or parked) made fresh, walked through
// each table's failing index in JOB_TABLES order; nothing else of a row changes (its cursor, bound and tombstone
// stay). A reset row leaves the index, so the next call continues without a cursor. `more`: a failing row remains.
export const retryParkedJobs = writeOperation<{ limit?: number }, { reset: number; more: boolean }>((db, input) => {
	let left = Math.min(Math.max(Math.trunc(input.limit ?? RETRY_JOBS_LIMIT), 1), RETRY_JOBS_LIMIT)
	let reset = 0
	for (const t of JOB_TABLES) {
		if (left === 0) {
			break
		}
		const n = t.rowid === true ? retryRowids(db, t, left) : retryKeys(db, t, left)
		reset += n
		left -= n
	}
	const more = JOB_TABLES.some(
		(t) =>
			db.first(
				`SELECT 1 AS x FROM ${t.table} INDEXED BY ${t.table}_failing WHERE ${pendingAnd(t, 'attempts > 0')} LIMIT 1`
			) !== undefined
	)
	return { reset, more }
})
