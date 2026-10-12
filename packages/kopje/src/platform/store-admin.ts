import {
	type AccessSettings,
	accessConfigured,
	BOOTSTRAP,
	readAccessSettings,
	readBootstrapRows,
	restoreBootstrapRows,
	settingsFromRows,
} from './access-settings'
import { CatalogError, readCatalog } from './dump-catalog'
import {
	type DumpHeader,
	DumpParseError,
	type DumpTrailer,
	headerLine,
	type MigrationRecord,
	parseStatements,
	type TableSpec,
	trailerLines,
} from './dump-format'
import { errorMessage } from './error-message'
import { readOnlyProblem } from './readonly-sql'
import { Sha256, sha256Hex } from './sha256'
import {
	buildHeader,
	checksumStep,
	type DumpCursor,
	dumpStep,
	initialCursor,
	MAX_DUMP_CHUNK_BYTES,
	MIN_DUMP_CHUNK_BYTES,
	parseCursor,
	trailerOf,
} from './store-dump'
import { storeMaintenanceError } from './store-errors'
import { activeDump, type ImportRecord, readFlags, writeFlag } from './store-flags'
import {
	applyStatements,
	catalogDifference,
	compareResults,
	ImportError,
	isEmpty,
	migrationDifference,
	parseHeader,
	parseTrailer,
	type VerifyReport,
} from './store-import'
import type { StoreKernel, UpgradeResult } from './store-kernel'

// Expected refusals are results, not exceptions: an RPC error keeps only its message.
export type Refusal = { ok: false; code: string; message: string }
export type Result<T> = ({ ok: true } & T) | Refusal

// Fault-injection points for tests. Throwing at a point simulates a failure there; the sql handle lets a test leave
// a durable write behind as a misbehaving storage layer could.
export type AdminFaultPoint = 'import-chunk-in-transaction' | 'import-chunk-after-commit'

export type AdminOptions = {
	source: { build: string; version: string }
	now?: () => number
	transaction?: <T>(fn: () => T) => T
	inject?: (point: AdminFaultPoint, sql: SqlStorage) => void
	log?: (entry: Record<string, unknown>) => void
	randomId?: () => string
}

export type ImportProgress = {
	id: string
	mode: ImportRecord['mode']
	state: ImportRecord['state']
	lastSeq: number
	digest: string
	statements: number
	bytes: number
	report: VerifyReport | null
}

export type QueryResult = {
	columns: string[]
	rows: unknown[][]
	truncated: boolean
}

export const DEFAULT_LEASE_MS = 10 * 60 * 1000
const MIN_LEASE_MS = 30 * 1000
const MAX_LEASE_MS = 60 * 60 * 1000
export const MAX_IMPORT_CHUNK_BYTES = 16 * 1024 * 1024
const VERIFY_STEP_BYTES = 32 * 1024 * 1024
const MAX_QUERY_ROWS = 1000
const MAX_QUERY_BYTES = 4 * 1024 * 1024
const PITR_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

// Thrown to roll back the read-only SQL transaction.
class Rollback extends Error {}
const ROLLBACK = new Rollback('rollback')

function refuse(code: string, message: string): Refusal {
	return { ok: false, code, message }
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
	return value === undefined || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(min, Math.floor(value)))
}

// The Store's operations tooling: inspection, maintenance, read-only SQL, PITR bookmarks, dump and import. It works
// beside the kernel (which owns schema state and the gate) over the same SQLite.
export class StoreAdmin {
	readonly #ctx: DurableObjectState
	readonly #sql: SqlStorage
	readonly #kernel: StoreKernel
	readonly #source: AdminOptions['source']
	readonly #now: () => number
	readonly #transaction: <T>(fn: () => T) => T
	readonly #inject: NonNullable<AdminOptions['inject']>
	readonly #log: NonNullable<AdminOptions['log']>
	readonly #randomId: () => string

	constructor(ctx: DurableObjectState, kernel: StoreKernel, options: AdminOptions) {
		this.#ctx = ctx
		this.#sql = ctx.storage.sql
		this.#kernel = kernel
		this.#source = options.source
		this.#now = options.now ?? Date.now
		this.#transaction = options.transaction ?? ((fn) => ctx.storage.transactionSync(fn))
		this.#inject = options.inject ?? (() => {})
		this.#log = options.log ?? ((entry) => console.log(entry))
		this.#randomId = options.randomId ?? (() => crypto.randomUUID())
	}

	// ---- inspection (read-only, any caller build)

	async capacity(): Promise<{ databaseSize: number; tables: { name: string; rows: number }[] }> {
		await this.#kernel.state()
		const names = this.#sql
			.exec<{
				name: string
			}>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND (name NOT LIKE 'sqlite\\_%' ESCAPE '\\' OR name = 'sqlite_sequence') ORDER BY name"
			)
			.toArray()
		const tables = names.map(({ name }) => ({
			name,
			rows: this.#sql.exec<{ n: number }>(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).one().n,
		}))
		return { databaseSize: this.#sql.databaseSize, tables }
	}

	async spool(): Promise<{ parts: number; sets: number; completeSets: number; oldestSpooledAt: number | null }> {
		await this.#kernel.state()
		try {
			const totals = this.#sql
				.exec<{
					parts: number
					sets: number
					oldest: number | null
				}>('SELECT count(*) AS parts, count(DISTINCT spool_id) AS sets, min(spooled_at) AS oldest FROM inbound_spool')
				.one()
			const complete = this.#sql
				.exec<{
					n: number
				}>(
					'SELECT count(*) AS n FROM (SELECT spool_id FROM inbound_spool GROUP BY spool_id HAVING count(*) = max(part_count))'
				)
				.one()
			return { parts: totals.parts, sets: totals.sets, completeSets: complete.n, oldestSpooledAt: totals.oldest }
		} catch {
			return { parts: 0, sets: 0, completeSets: 0, oldestSpooledAt: null }
		}
	}

	// What /admin authentication needs from the Store. IMPORT_TOKEN is usable while the Store is empty and has no
	// Access settings, and for the rest of an import that was begun with it (the imported rows bring Access settings).
	// During an import the Access settings are the Store's own ones set aside at begin, not imported rows.
	async gate(): Promise<{ access: AccessSettings; tokenImport: boolean }> {
		await this.#kernel.state()
		const { import: running } = readFlags(this.#sql)
		const access = running === null ? readAccessSettings(this.#sql) : settingsFromRows(running.bootstrap ?? [])
		let empty: boolean
		try {
			empty = isEmpty(this.#sql, readCatalog(this.#sql), BOOTSTRAP)
		} catch {
			empty = false
		}
		const tokenImport = running?.mode === 'token' || (running === null && !accessConfigured(access) && empty)
		return { access, tokenImport }
	}

	// ---- maintenance

	async setMaintenance(callerBuild: string, on: boolean): Promise<{ maintenance: boolean }> {
		this.#requireBuild(callerBuild)
		await this.#kernel.state()
		this.#transaction(() => writeFlag(this.#sql, 'maintenance', on ? { mode: 'readonly', at: this.#now() } : null))
		this.#log({ event: 'kopje.store.maintenance', on })
		return { maintenance: on }
	}

	// ---- read-only SQL
	//
	// Guarantee, in layers: (1) readOnlyProblem accepts only one SELECT/WITH statement with no write keyword outside
	// literals and comments; (2) the statement runs inside transactionSync and the transaction is always rolled back
	// by throwing, so even a write that slipped through cannot persist; (3) a statement that reports rowsWritten > 0
	// is refused; (4) the platform's authorizer refuses ATTACH and transaction control.
	async query(text: string, limit = 100): Promise<Result<QueryResult>> {
		const problem = readOnlyProblem(text)
		if (problem !== null) {
			return refuse('not-read-only', problem)
		}
		await this.#kernel.state()
		const max = clamp(limit, 1, MAX_QUERY_ROWS, 100)
		let result: QueryResult | undefined
		let written = 0
		try {
			this.#transaction(() => {
				const cursor = this.#sql.exec(text)
				const rows: unknown[][] = []
				let bytes = 0
				let truncated = false
				for (const raw of cursor.raw()) {
					if (rows.length >= max || bytes > MAX_QUERY_BYTES) {
						truncated = true
						break
					}
					const row = raw.map(encodeValue)
					bytes += JSON.stringify(row).length
					rows.push(row)
				}
				written = cursor.rowsWritten
				result = { columns: cursor.columnNames, rows, truncated }
				throw ROLLBACK
			})
		} catch (error) {
			if (error !== ROLLBACK) {
				return refuse('query-failed', errorMessage(error))
			}
		}
		if (written > 0 || result === undefined) {
			return refuse('not-read-only', 'the statement wrote rows; it was rolled back')
		}
		return { ok: true, ...result }
	}

	// ---- PITR (bookmarks are read-only; the restore itself is the kernel's restoreBookmark)

	async bookmark(at?: number): Promise<Result<{ bookmark: string; at: number | null }>> {
		const now = this.#now()
		if (at !== undefined && (!Number.isFinite(at) || at > now || at < now - PITR_WINDOW_MS)) {
			return refuse('out-of-range', 'the time must be within the last 30 days')
		}
		try {
			const bookmark =
				at === undefined ? await this.#ctx.storage.getCurrentBookmark() : await this.#ctx.storage.getBookmarkForTime(at)
			return { ok: true, bookmark, at: at ?? null }
		} catch (error) {
			const message = errorMessage(error)
			// A database younger than about a minute has no history to look up yet.
			if (/no history/i.test(message)) {
				return refuse('no-history', message)
			}
			return refuse('pitr-unavailable', message)
		}
	}

	// ---- dump

	async dumpStart(
		leaseSeconds?: number
	): Promise<Result<{ header: DumpHeader; headerLine: string; cursor: DumpCursor }>> {
		await this.#kernel.state()
		const leaseMs = clamp(
			leaseSeconds === undefined ? undefined : leaseSeconds * 1000,
			MIN_LEASE_MS,
			MAX_LEASE_MS,
			DEFAULT_LEASE_MS
		)
		try {
			return this.#transaction(() => {
				const now = this.#now()
				const flags = readFlags(this.#sql)
				if (flags.import !== null) {
					return refuse('import-in-progress', 'an import is in progress')
				}
				const running = activeDump(flags, now)
				if (running !== null) {
					return refuse(
						'dump-in-progress',
						`dump ${running.id} holds the lease until ${new Date(running.leaseUntil).toISOString()}`
					)
				}
				const header = buildHeader(this.#sql, this.#kernel.appliedMigrations(), this.#source, now)
				const id = this.#randomId()
				writeFlag(this.#sql, 'dump', { id, startedAt: now, leaseMs, leaseUntil: now + leaseMs, header, results: [] })
				this.#log({ event: 'kopje.store.dump.start', id, tables: header.tables.length })
				return { ok: true as const, header, headerLine: headerLine(header), cursor: initialCursor(id) }
			})
		} catch (error) {
			if (error instanceof CatalogError) {
				return refuse('catalog-invalid', error.message)
			}
			throw error
		}
	}

	async dumpNext(
		cursorValue: unknown,
		maxBytes?: number
	): Promise<Result<{ chunk: Uint8Array; cursor: DumpCursor; done: boolean; leaseUntil: number }>> {
		let start: DumpCursor
		try {
			start = parseCursor(cursorValue)
		} catch (error) {
			return refuse('invalid-cursor', errorMessage(error))
		}
		await this.#kernel.state()
		const limit = clamp(maxBytes, MIN_DUMP_CHUNK_BYTES, MAX_DUMP_CHUNK_BYTES, MAX_DUMP_CHUNK_BYTES)
		try {
			return this.#transaction(() => {
				const now = this.#now()
				const record = readFlags(this.#sql).dump
				if (record === null || record.id !== start.dump) {
					return refuse('dump-not-found', 'no such dump; start a new one')
				}
				if (record.completed !== undefined) {
					return refuse('dump-finished', 'the dump is finished; ask dump/finish for its trailer')
				}
				if (now >= record.leaseUntil) {
					// Writes may have happened since the lease ended, so the rows read so far are no longer one snapshot.
					return refuse('dump-lease-expired', 'the dump lease expired; start a new dump')
				}
				const difference = catalogDifference(record.header.tables, readCatalog(this.#sql))
				if (difference !== null) {
					return refuse('schema-changed', difference)
				}
				const step = dumpStep(this.#sql, record.header.tables, start, limit)
				const results = mergeResults(record.header.tables, record.results, step.finished)
				const leaseUntil = now + record.leaseMs
				writeFlag(this.#sql, 'dump', { ...record, leaseUntil, results })
				return {
					ok: true as const,
					chunk: step.chunk,
					cursor: step.cursor,
					done: step.cursor.phase === 'done',
					leaseUntil,
				}
			})
		} catch (error) {
			if (error instanceof CatalogError) {
				return refuse('invalid-cursor', error.message)
			}
			throw error
		}
	}

	async dumpFinish(
		cursorValue: unknown,
		abort = false
	): Promise<Result<{ aborted: boolean; trailer: DumpTrailer | null; trailerText: string | null }>> {
		let cursor: DumpCursor
		try {
			cursor = parseCursor(cursorValue)
		} catch (error) {
			return refuse('invalid-cursor', errorMessage(error))
		}
		await this.#kernel.state()
		const outcome = this.#transaction(
			(): Result<{ aborted: boolean; trailer: DumpTrailer | null; trailerText: string | null }> => {
				const record = readFlags(this.#sql).dump
				if (record === null || record.id !== cursor.dump) {
					return refuse('dump-not-found', 'no such dump')
				}
				if (record.completed !== undefined) {
					// A repeated finish (the first response was lost) gets the same answer.
					return abort
						? refuse('dump-finished', 'the dump is already finished')
						: { ok: true, aborted: false, ...record.completed }
				}
				if (abort) {
					writeFlag(this.#sql, 'dump', null)
					return { ok: true, aborted: true, trailer: null, trailerText: null }
				}
				const names = record.header.tables.map((t) => t.name).join(',')
				if (cursor.phase !== 'done' || record.results.map((r) => r.name).join(',') !== names) {
					return refuse('dump-incomplete', 'the dump has not read every table yet')
				}
				// Each step checked the lease before reading, so every chunk was read under one continuous freeze.
				const trailer = trailerOf(record.results, cursor)
				const completed = { trailer, trailerText: trailerLines(trailer) }
				// The lease ends now; the record stays as a receipt.
				writeFlag(this.#sql, 'dump', { ...record, leaseUntil: 0, completed })
				return { ok: true, aborted: false, ...completed }
			}
		)
		if (outcome.ok) {
			this.#log({ event: 'kopje.store.dump.finish', id: cursor.dump, aborted: outcome.aborted })
			await this.#resumeDeferredUpgrade()
		}
		return outcome
	}

	// ---- import

	// What a dump for this Store must declare: its applied migrations and its table catalog.
	async catalog(): Promise<{ migrations: MigrationRecord[]; tables: TableSpec[] }> {
		await this.#kernel.state()
		return { migrations: this.#kernel.appliedMigrations(), tables: readCatalog(this.#sql) }
	}

	async importBegin(
		callerBuild: string,
		headerValue: unknown,
		mode: ImportRecord['mode']
	): Promise<Result<{ progress: ImportProgress; resumed: boolean }>> {
		this.#requireBuild(callerBuild)
		const state = await this.#kernel.state()
		if (state.schema.status !== 'current' || state.held || state.upgrading) {
			return refuse('store-not-ready', 'the Store schema is not current; check health and retry the upgrade')
		}
		try {
			const header = parseHeader(headerValue)
			const headerSha256 = sha256Hex(JSON.stringify(header))
			return this.#transaction(() => {
				const now = this.#now()
				const flags = readFlags(this.#sql)
				if (activeDump(flags, now) !== null) {
					throw new ImportError('dump-in-progress', 'a dump is in progress')
				}
				if (flags.import !== null) {
					// The same dump resumes in whatever phase it reached (receiving, finished, or failed with its report).
					if (flags.import.headerSha256 === headerSha256) {
						return { ok: true as const, progress: progressOf(flags.import), resumed: true }
					}
					throw new ImportError(
						'import-exists',
						`import ${flags.import.id} (${flags.import.state}) exists; reset it first`
					)
				}
				const migrations = migrationDifference(header.migrations, this.#kernel.appliedMigrations())
				if (migrations !== null) {
					throw new ImportError('migrations-differ', migrations)
				}
				const catalog = readCatalog(this.#sql)
				const tables = catalogDifference(header.tables, catalog)
				if (tables !== null) {
					throw new ImportError('catalog-differs', tables)
				}
				if (!isEmpty(this.#sql, catalog, BOOTSTRAP)) {
					throw new ImportError('not-empty', 'the Store already has data; import only into an empty Store')
				}
				// Move the Store's Access rows aside: the imported instance_settings must land in an empty table, and the
				// admin keeps authenticating with these until the import is verified.
				const bootstrap = readBootstrapRows(this.#sql)
				for (const row of bootstrap) {
					this.#sql.exec('DELETE FROM instance_settings WHERE name = ?', row.name)
				}
				const record: ImportRecord = {
					id: this.#randomId(),
					mode,
					state: 'receiving',
					header,
					headerSha256,
					lastSeq: 0,
					digest: '',
					statements: 0,
					bytes: 0,
					bodyHash: new Sha256().save(),
					trailer: null,
					verify: null,
					report: null,
					bootstrap,
					startedAt: now,
					updatedAt: now,
				}
				writeFlag(this.#sql, 'import', record)
				this.#log({ event: 'kopje.store.import.begin', id: record.id, mode })
				return { ok: true as const, progress: progressOf(record), resumed: false }
			})
		} catch (error) {
			return asRefusal(error)
		}
	}

	// Applies chunk `seq` in one transaction, together with the progress record. After any error the progress is read
	// again and reported: an error does not prove the transaction rolled back.
	async importChunk(
		callerBuild: string,
		id: string,
		seq: number,
		bytes: Uint8Array
	): Promise<
		| Result<{ progress: ImportProgress; duplicate: boolean }>
		| (Refusal & { progress: ImportProgress | null; applied: boolean })
	> {
		this.#requireBuild(callerBuild)
		await this.#kernel.state()
		const record = readFlags(this.#sql).import
		if (record === null || record.id !== id) {
			return refuse('import-not-found', 'no such import')
		}
		if (record.state !== 'receiving') {
			return refuse('import-not-receiving', `the import is ${record.state}`)
		}
		if (!Number.isSafeInteger(seq) || seq < 1) {
			return refuse('out-of-order', 'chunk numbers start at 1')
		}
		if (seq <= record.lastSeq) {
			// Already applied (a lost response). The caller compares the digest with its own.
			return { ok: true, progress: progressOf(record), duplicate: true }
		}
		if (seq !== record.lastSeq + 1) {
			return refuse('out-of-order', `expected chunk ${record.lastSeq + 1}, got ${seq}`)
		}
		if (bytes.byteLength > MAX_IMPORT_CHUNK_BYTES) {
			return refuse('chunk-too-large', `a chunk may hold at most ${MAX_IMPORT_CHUNK_BYTES} bytes`)
		}
		let statements
		try {
			statements = parseStatements(
				new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
				record.header.tables
			)
		} catch (error) {
			return refuse('invalid-chunk', error instanceof DumpParseError ? error.message : 'chunk is not valid UTF-8')
		}
		const digest = new Sha256().update(record.digest).update(bytes).hex()
		const bodyHash = Sha256.restore(record.bodyHash).update(bytes).save()
		try {
			this.#transaction(() => {
				const current = readFlags(this.#sql).import
				if (current === null || current.id !== id || current.lastSeq !== seq - 1 || current.state !== 'receiving') {
					throw new ImportError('out-of-order', 'the import changed while this chunk was prepared')
				}
				const migrations = migrationDifference(current.header.migrations, this.#kernel.appliedMigrations())
				if (migrations !== null) {
					throw new ImportError('migrations-differ', migrations)
				}
				applyStatements(this.#sql, statements)
				writeFlag(this.#sql, 'import', {
					...current,
					lastSeq: seq,
					digest,
					statements: current.statements + statements.length,
					bytes: current.bytes + bytes.byteLength,
					bodyHash,
					updatedAt: this.#now(),
				})
				this.#inject('import-chunk-in-transaction', this.#sql)
			})
			this.#inject('import-chunk-after-commit', this.#sql)
		} catch (error) {
			const progress = this.#progressAfterError()
			const applied =
				progress !== null && progress.lastSeq >= seq && (progress.lastSeq > seq || progress.digest === digest)
			const code = error instanceof ImportError ? error.code : 'chunk-failed'
			this.#log({ event: 'kopje.store.import.chunk-failed', id, seq, applied, error: errorMessage(error) })
			return { ok: false, code, message: errorMessage(error), progress, applied }
		}
		const progress = this.#progressAfterError()
		return progress === null
			? refuse('import-not-found', 'the import record disappeared')
			: { ok: true, progress, duplicate: false }
	}

	async importFinish(
		callerBuild: string,
		id: string,
		trailerValue: unknown
	): Promise<Result<{ progress: ImportProgress }>> {
		this.#requireBuild(callerBuild)
		await this.#kernel.state()
		try {
			const trailer = parseTrailer(trailerValue)
			return this.#transaction(() => {
				const record = this.#importRecord(id)
				if (record.state !== 'receiving') {
					if (record.state === 'finished' && JSON.stringify(record.trailer) === JSON.stringify(trailer)) {
						return { ok: true as const, progress: progressOf(record) }
					}
					throw new ImportError('import-not-receiving', `the import is ${record.state}`)
				}
				const names = (list: { name: string }[]) => list.map((t) => t.name).join(',')
				if (names(trailer.tables) !== names(record.header.tables)) {
					throw new ImportError('trailer-mismatch', 'the trailer does not list the header tables')
				}
				const sha256 = Sha256.restore(record.bodyHash).hex()
				if (
					trailer.body.statements !== record.statements ||
					trailer.body.bytes !== record.bytes ||
					trailer.body.sha256 !== sha256
				) {
					throw new ImportError(
						'body-mismatch',
						`received ${record.statements} statements in ${record.bytes} bytes; the trailer declares ${trailer.body.statements} in ${trailer.body.bytes}`
					)
				}
				const finished: ImportRecord = {
					...record,
					state: 'finished',
					trailer,
					verify: { position: { phase: 'rows', table: 0, after: null, rows: 0, hash: null }, results: [] },
					updatedAt: this.#now(),
				}
				writeFlag(this.#sql, 'import', finished)
				return { ok: true as const, progress: progressOf(finished) }
			})
		} catch (error) {
			return asRefusal(error)
		}
	}

	// Recomputes row counts and ordered checksums inside the Store, a bounded amount per call, then runs
	// foreign_key_check. On success the import record is removed and the Store serves again; on failure it stays
	// refused and needs a reset.
	async importVerify(
		callerBuild: string,
		id: string,
		maxBytes = VERIFY_STEP_BYTES
	): Promise<Result<{ done: boolean; report: VerifyReport | null; progress: ImportProgress | null }>> {
		this.#requireBuild(callerBuild)
		await this.#kernel.state()
		const budget = clamp(maxBytes, 1024, VERIFY_STEP_BYTES, VERIFY_STEP_BYTES)
		try {
			return this.#transaction(() => {
				const record = this.#importRecord(id)
				if (record.state === 'failed') {
					return { ok: true as const, done: true, report: record.report, progress: progressOf(record) }
				}
				if (record.state !== 'finished' || record.trailer === null || record.verify === null) {
					throw new ImportError('import-not-finished', 'finish the import before verifying it')
				}
				const step = checksumStep(this.#sql, record.header.tables, record.verify.position, budget)
				const results = [...record.verify.results, ...step.finished]
				if (step.position.phase !== 'done') {
					const next: ImportRecord = { ...record, verify: { position: step.position, results }, updatedAt: this.#now() }
					writeFlag(this.#sql, 'import', next)
					return { ok: true as const, done: false, report: null, progress: progressOf(next) }
				}
				const violations = this.#sql.exec('PRAGMA foreign_key_check').toArray().length
				const report = compareResults(results, record.trailer, violations)
				const migrations = migrationDifference(record.header.migrations, this.#kernel.appliedMigrations())
				if (migrations !== null) {
					report.ok = false
					report.problems.push(migrations)
				}
				if (report.ok) {
					writeFlag(this.#sql, 'import', null)
					restoreBootstrapRows(this.#sql, record.bootstrap ?? [])
					this.#log({ event: 'kopje.store.import.verified', id })
					return { ok: true as const, done: true, report, progress: null }
				}
				const failed: ImportRecord = { ...record, state: 'failed', report, updatedAt: this.#now() }
				writeFlag(this.#sql, 'import', failed)
				this.#log({ event: 'kopje.store.import.verify-failed', id, problems: report.problems })
				return { ok: true as const, done: true, report, progress: progressOf(failed) }
			})
		} catch (error) {
			return asRefusal(error)
		}
	}

	async importProgress(): Promise<ImportProgress | null> {
		await this.#kernel.state()
		const record = readFlags(this.#sql).import
		return record === null ? null : progressOf(record)
	}

	// Starts over from nothing: deleteAll() (which also drops the schema) and the migration runner. Only for a Store
	// that is under import or holds no data, so it cannot wipe a serving instance.
	async importReset(callerBuild: string): Promise<Result<{ upgrade: UpgradeResult }>> {
		this.#requireBuild(callerBuild)
		await this.#kernel.state()
		const flags = readFlags(this.#sql)
		if (activeDump(flags, this.#now()) !== null) {
			return refuse('dump-in-progress', 'a dump is in progress')
		}
		let empty: boolean
		try {
			empty = isEmpty(this.#sql, readCatalog(this.#sql), BOOTSTRAP)
		} catch {
			empty = false
		}
		if (flags.import === null && !empty) {
			return refuse('reset-refused', 'reset is only for a Store under import or without data')
		}
		// deleteAll() takes the Access rows too; they are written back into the recreated schema.
		const bootstrap = flags.import?.bootstrap ?? readBootstrapRows(this.#sql)
		this.#log({ event: 'kopje.store.import.reset', id: flags.import?.id ?? null })
		await this.#ctx.storage.deleteAll()
		this.#kernel.forget()
		const upgrade = await this.#kernel.upgrade()
		if (!upgrade.ok) {
			// Nothing can hold the Access rows now; report them so the operator can set them again.
			return {
				...refuse('upgrade-failed', `schema recreation failed: ${upgrade.detail}`),
				bootstrap,
			} as Refusal
		}
		this.#transaction(() => restoreBootstrapRows(this.#sql, bootstrap))
		return { ok: true, upgrade }
	}

	#importRecord(id: string): ImportRecord {
		const record = readFlags(this.#sql).import
		if (record === null || record.id !== id) {
			throw new ImportError('import-not-found', 'no such import')
		}
		return record
	}

	#progressAfterError(): ImportProgress | null {
		try {
			const record = readFlags(this.#sql).import
			return record === null ? null : progressOf(record)
		} catch {
			return null
		}
	}

	async #resumeDeferredUpgrade(): Promise<void> {
		const state = await this.#kernel.state()
		if (state.schema.status !== 'current' || state.upgrading) {
			await this.#ctx.storage.setAlarm(this.#now())
		}
	}

	#requireBuild(callerBuild: string): void {
		if (callerBuild !== this.#kernel.build) {
			throw storeMaintenanceError('version-mismatch')
		}
	}
}

function progressOf(record: ImportRecord): ImportProgress {
	return {
		id: record.id,
		mode: record.mode,
		state: record.state,
		lastSeq: record.lastSeq,
		digest: record.digest,
		statements: record.statements,
		bytes: record.bytes,
		report: record.report,
	}
}

function mergeResults(
	tables: readonly TableSpec[],
	results: readonly { name: string; rows: number; checksum: string }[],
	finished: readonly { name: string; rows: number; checksum: string }[]
) {
	const byName = new Map([...results, ...finished].map((r) => [r.name, r]))
	return tables.flatMap((t) => {
		const result = byName.get(t.name)
		return result === undefined ? [] : [result]
	})
}

function asRefusal(error: unknown): Refusal {
	if (error instanceof ImportError) {
		return refuse(error.code, error.message)
	}
	if (error instanceof CatalogError) {
		return refuse('catalog-invalid', error.message)
	}
	throw error
}

function encodeValue(value: unknown): unknown {
	if (value instanceof ArrayBuffer) {
		return { blob: Array.from(new Uint8Array(value), (b) => b.toString(16).padStart(2, '0')).join('') }
	}
	return value
}
