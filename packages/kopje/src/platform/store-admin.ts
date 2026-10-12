import {
	type AccessSettings,
	type AccessBinding,
	accessRefusal,
	type AdminIdentity,
	adminUsable,
	BOOTSTRAP,
	CONFIG_KEYS,
	readAccessSettings,
	readBootstrapRows,
	readConfigRows,
	replaceBootstrapRows,
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
	quoteIdentifier,
	type TableSpec,
	trailerLines,
} from './dump-format'
import { fromHex } from './dump-literals'
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
import {
	activeDump,
	type ImportReceipt,
	type ImportRecord,
	type OperatorFlags,
	readFlags,
	writeFlag,
} from './store-flags'
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
import type { StoreKernel } from './store-kernel'

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
	// Rows deleted per reset transaction (tests make it small).
	resetBatchRows?: number
}

// Who asks for an import or configuration change (see the import section of StoreAdmin).
// access carries the identity the Worker verified; the Store checks it again where it writes.
export type ImportAuthority =
	| ({ kind: 'access' } & AdminIdentity & AccessBinding)
	| { kind: 'import-token' }
	| { kind: 'import-session'; secret: string }

export type ImportProgress = {
	id: string
	mode: ImportRecord['mode']
	// What the dump is: sha256 of the header and trailer JSON (as received), so a client can check its file.
	headerSha256: string
	trailerSha256: string | null
	updatedAt: number
	// 'verified' comes from the receipt of a completed import.
	state: ImportRecord['state'] | 'verified'
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
// A token import whose session made no successful step for this long may be abandoned with IMPORT_TOKEN.
export const STALE_IMPORT_MS = 15 * 60 * 1000
const RESET_BATCH_ROWS = 2000
const RESET_STEPS = 20

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
	readonly #resetBatchRows: number

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
		this.#resetBatchRows = options.resetBatchRows ?? RESET_BATCH_ROWS
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

	// What /admin authentication needs from the Store: the Access settings to verify a JWT with (during an import, the
	// Store's own ones set aside at begin, not imported rows), and whether the Store is in bootstrap, where IMPORT_TOKEN
	// may read it and configure it. Mutations check their authority again in the transaction that writes.
	async gate(): Promise<{ access: AccessSettings; bootstrap: boolean }> {
		await this.#kernel.state()
		const { import: running } = readFlags(this.#sql)
		const access = this.#targetSettings(running)
		return { access, bootstrap: running === null && !adminUsable(access) }
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

	// opId is the client's id for this start: asking again with the same opId returns the same dump while it runs, so
	// a client that lost the response (or crashed before saving the cursor) can continue or abort it.
	async dumpStart(
		leaseSeconds?: number,
		opId?: string
	): Promise<Result<{ header: DumpHeader; headerLine: string; cursor: DumpCursor }>> {
		if (opId !== undefined && !/^[A-Za-z0-9-]{8,64}$/.test(opId)) {
			return refuse('invalid-op-id', 'opId must be 8-64 letters, digits or dashes')
		}
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
				if (opId !== undefined && flags.dump?.opId === opId) {
					if (flags.dump.completed !== undefined) {
						return refuse('dump-finished', 'that dump is finished; ask dump/finish for its trailer')
					}
					if (running !== null) {
						const { header } = running
						return { ok: true as const, header, headerLine: headerLine(header), cursor: initialCursor(running.id) }
					}
				}
				if (running !== null) {
					return refuse(
						'dump-in-progress',
						`dump ${running.id} holds the lease until ${new Date(running.leaseUntil).toISOString()}`
					)
				}
				const header = buildHeader(this.#sql, this.#kernel.appliedMigrations(), this.#source, now)
				const id = this.#randomId()
				writeFlag(this.#sql, 'dump', {
					id,
					opId,
					startedAt: now,
					leaseMs,
					leaseUntil: now + leaseMs,
					header,
					results: [],
				})
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

	// Aborts the running dump that was started with this opId, if any: a client that may have lost the start's
	// response (and so has no cursor) can still release the freeze. Never starts a dump, never touches another one.
	async dumpAbort(opId: string): Promise<Result<{ aborted: boolean }>> {
		if (!/^[A-Za-z0-9-]{8,64}$/.test(opId)) {
			return refuse('invalid-op-id', 'opId must be 8-64 letters, digits or dashes')
		}
		await this.#kernel.state()
		const id = this.#transaction(() => {
			const record = readFlags(this.#sql).dump
			if (record === null || record.opId !== opId || record.completed !== undefined) {
				return null
			}
			writeFlag(this.#sql, 'dump', null)
			return record.id
		})
		if (id !== null) {
			this.#log({ event: 'kopje.store.dump.finish', id, aborted: true })
			await this.#resumeDeferredUpgrade()
		}
		return { ok: true, aborted: id !== null }
	}

	// ---- import
	//
	// Every import mutation names its authority, and the Store checks it inside the transaction that writes:
	//   access          an Access admin (verified by the Worker); continues only imports begun that way
	//   import-token    IMPORT_TOKEN (verified by the Worker); only begins an import, and only while the Store is in
	//                   bootstrap (admin access not usable) and holds no data
	//   import-session  the credential begin returned for a token import; continues only that import
	// So a request authorized for one import or mode cannot act on another, however late it arrives.

	// What a dump for this Store must declare: its applied migrations and its table catalog.
	async catalog(): Promise<{ migrations: MigrationRecord[]; tables: TableSpec[] }> {
		await this.#kernel.state()
		return { migrations: this.#kernel.appliedMigrations(), tables: readCatalog(this.#sql) }
	}

	async importBegin(
		callerBuild: string,
		authority: ImportAuthority,
		headerValue: unknown
	): Promise<Result<{ progress: ImportProgress; resumed: boolean; session?: string }>> {
		this.#requireBuild(callerBuild)
		if (authority.kind === 'import-session') {
			return refuse('wrong-authority', 'begin an import with Access or IMPORT_TOKEN')
		}
		const state = await this.#kernel.state()
		if (state.schema.status !== 'current' || state.held || state.upgrading) {
			return refuse('store-not-ready', 'the Store schema is not current; check health and retry the upgrade')
		}
		try {
			const header = parseHeader(headerValue)
			const headerSha256 = sha256Hex(JSON.stringify(header))
			const session = authority.kind === 'import-token' ? randomSecret() : null
			return this.#transaction(() => {
				const now = this.#now()
				const flags = readFlags(this.#sql)
				if (authority.kind === 'import-token' && !this.#inBootstrap(flags)) {
					throw new ImportError(
						'not-bootstrap',
						'IMPORT_TOKEN only begins an import into an empty Store without admin access'
					)
				}
				if (authority.kind === 'access') {
					this.#assertAdmin(authority, this.#targetSettings(flags.import))
				}
				if (activeDump(flags, now) !== null) {
					throw new ImportError('dump-in-progress', 'a dump is in progress')
				}
				if (flags.import !== null) {
					// An Access admin resumes the same dump in whatever phase it reached. A token import is continued with
					// its session credential, not by beginning again.
					if (
						authority.kind === 'access' &&
						flags.import.mode === 'access' &&
						flags.import.state !== 'resetting' &&
						flags.import.headerSha256 === headerSha256
					) {
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
				// Move the Store's configuration aside: the imported instance_settings must land in an empty table, and the
				// admin keeps authenticating with these until the import is verified.
				const bootstrap = readBootstrapRows(this.#sql)
				replaceBootstrapRows(this.#sql, [])
				const record: ImportRecord = {
					id: this.#randomId(),
					mode: authority.kind === 'access' ? 'access' : 'token',
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
					sessionHash: session === null ? null : sha256Hex(session),
					startedAt: now,
					updatedAt: now,
				}
				writeFlag(this.#sql, 'import', record)
				writeFlag(this.#sql, 'import_receipt', null)
				this.#log({ event: 'kopje.store.import.begin', id: record.id, mode: record.mode })
				const begun = { ok: true as const, progress: progressOf(record), resumed: false }
				return session === null ? begun : { ...begun, session }
			})
		} catch (error) {
			return asRefusal(error)
		}
	}

	// Applies chunk `seq` in one transaction, together with the progress record. After any error the progress is read
	// again and reported: an error does not prove the transaction rolled back.
	async importChunk(
		callerBuild: string,
		authority: ImportAuthority,
		id: string,
		seq: number,
		bytes: Uint8Array
	): Promise<
		| Result<{ progress: ImportProgress; duplicate: boolean }>
		| (Refusal & { progress: ImportProgress | null; applied: boolean })
	> {
		this.#requireBuild(callerBuild)
		await this.#kernel.state()
		let record: ImportRecord
		try {
			// Checked here to avoid parsing for nothing, and again in the transaction that writes.
			record = this.#authorizedRecord(authority, id)
		} catch (error) {
			return asRefusal(error)
		}
		if (record.state !== 'receiving') {
			return refuse('import-not-receiving', `the import is ${record.state}`)
		}
		if (!Number.isSafeInteger(seq) || seq < 1) {
			return refuse('out-of-order', 'chunk numbers start at 1')
		}
		if (seq <= record.lastSeq) {
			// Already applied (a lost response). The caller compares the digest with its own; the retry counts as
			// activity of the session.
			try {
				const touched = this.#transaction(() => this.#touch(this.#authorizedRecord(authority, id)))
				return { ok: true, progress: progressOf(touched), duplicate: true }
			} catch (error) {
				return asRefusal(error)
			}
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
				const current = this.#authorizedRecord(authority, id)
				if (current.lastSeq !== seq - 1 || current.state !== 'receiving') {
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
			const progress = this.#currentProgress()
			const applied =
				progress !== null && progress.lastSeq >= seq && (progress.lastSeq > seq || progress.digest === digest)
			const code = error instanceof ImportError ? error.code : 'chunk-failed'
			this.#log({ event: 'kopje.store.import.chunk-failed', id, seq, applied, error: errorMessage(error) })
			return { ok: false, code, message: errorMessage(error), progress, applied }
		}
		const progress = this.#currentProgress()
		return progress === null
			? refuse('import-not-found', 'the import record disappeared')
			: { ok: true, progress, duplicate: false }
	}

	async importFinish(
		callerBuild: string,
		authority: ImportAuthority,
		id: string,
		trailerValue: unknown
	): Promise<Result<{ progress: ImportProgress }>> {
		this.#requireBuild(callerBuild)
		await this.#kernel.state()
		try {
			const trailer = parseTrailer(trailerValue)
			return this.#transaction(() => {
				const record = this.#authorizedRecord(authority, id)
				if (record.state !== 'receiving') {
					if (record.state === 'finished' && JSON.stringify(record.trailer) === JSON.stringify(trailer)) {
						return { ok: true as const, progress: progressOf(this.#touch(record)) }
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
	// foreign_key_check. On success the import record gives way to a receipt and the Store serves again; on failure it
	// stays refused and needs a reset.
	async importVerify(
		callerBuild: string,
		authority: ImportAuthority,
		id: string,
		maxBytes = VERIFY_STEP_BYTES
	): Promise<Result<{ done: boolean; report: VerifyReport | null; progress: ImportProgress | null }>> {
		this.#requireBuild(callerBuild)
		await this.#kernel.state()
		const budget = clamp(maxBytes, 1024, VERIFY_STEP_BYTES, VERIFY_STEP_BYTES)
		let outcome: Result<{ done: boolean; report: VerifyReport | null; progress: ImportProgress | null }>
		try {
			outcome = this.#transaction(() => {
				const receipt = readFlags(this.#sql).import_receipt
				if (receipt !== null && receipt.id === id && readFlags(this.#sql).import === null) {
					// Verified already (the response was lost): the same answer again.
					this.#authorizeReceipt(authority, receipt)
					return { ok: true as const, done: true, report: receipt.report, progress: receiptProgress(receipt) }
				}
				const record = this.#authorizedRecord(authority, id)
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
					// An import never changes configuration (domain, who administers this Store): its own rows come back exactly.
					replaceBootstrapRows(this.#sql, record.bootstrap ?? [])
					const completed: ImportReceipt = {
						id: record.id,
						mode: record.mode,
						headerSha256: record.headerSha256,
						trailerSha256: trailerSha256(record.trailer),
						sessionHash: record.sessionHash ?? null,
						lastSeq: record.lastSeq,
						digest: record.digest,
						statements: record.statements,
						bytes: record.bytes,
						report,
						completedAt: this.#now(),
					}
					writeFlag(this.#sql, 'import', null)
					writeFlag(this.#sql, 'import_receipt', completed)
					this.#log({ event: 'kopje.store.import.verified', id })
					return { ok: true as const, done: true, report, progress: receiptProgress(completed) }
				}
				const failed: ImportRecord = { ...record, state: 'failed', report, updatedAt: this.#now() }
				writeFlag(this.#sql, 'import', failed)
				this.#log({ event: 'kopje.store.import.verify-failed', id, problems: report.problems })
				return { ok: true as const, done: true, report, progress: progressOf(failed) }
			})
		} catch (error) {
			return asRefusal(error)
		}
		if (outcome.ok && outcome.progress?.state === 'verified') {
			await this.#resumeDeferredUpgrade()
		}
		return outcome
	}

	// The running import, or the receipt of the last verified one, as far as the authority may see it.
	async importProgress(authority: ImportAuthority, id?: string): Promise<{ progress: ImportProgress | null }> {
		await this.#kernel.state()
		const flags = readFlags(this.#sql)
		const matches = (candidate: string) => id === undefined || candidate === id
		const sees = (mode: ImportRecord['mode'], sessionHash: string | null) =>
			authority.kind === 'access' ||
			(authority.kind === 'import-token' && mode === 'token') ||
			(authority.kind === 'import-session' && mode === 'token' && sessionMatches(authority.secret, sessionHash))
		if (flags.import !== null) {
			const record = flags.import
			return {
				progress: matches(record.id) && sees(record.mode, record.sessionHash ?? null) ? progressOf(record) : null,
			}
		}
		const receipt = flags.import_receipt
		if (receipt !== null && matches(receipt.id) && sees(receipt.mode, receipt.sessionHash)) {
			return { progress: receiptProgress(receipt) }
		}
		return { progress: null }
	}

	// Takes the Store back to before the import, without deleteAll(): the import record becomes 'resetting' and the
	// imported rows are deleted in bounded transactions, children before parents, a few per call; the caller repeats the
	// call until done. The configuration is never touched: it waits in the import record (written at begin), and the
	// last transaction writes it back exactly, removes the record and leaves a reset receipt. So an interrupted reset
	// loses nothing and continues with the next call, and a retried request for the same import gets its receipt.
	//
	// abandonStale: IMPORT_TOKEN's way back from a token import whose session credential was lost. It may start such a
	// reset once the import is not verified, its session has had no successful step for STALE_IMPORT_MS, and admin
	// access is still not usable, and may continue it. This gives the token no new power: on an empty Store in bootstrap
	// it could begin an import anyway.
	async importReset(
		callerBuild: string,
		authority: ImportAuthority,
		id?: string,
		abandonStale = false,
		maxSteps = RESET_STEPS
	): Promise<Result<{ done: boolean; progress: ImportProgress | null }>> {
		this.#requireBuild(callerBuild)
		if (id === undefined) {
			return refuse('import-id-required', 'name the import to reset')
		}
		await this.#kernel.state()
		try {
			const started = this.#transaction(() => {
				const flags = readFlags(this.#sql)
				if (flags.import === null && flags.import_reset?.id === id) {
					return null
				}
				if (activeDump(flags, this.#now()) !== null) {
					throw new ImportError('dump-in-progress', 'a dump is in progress')
				}
				const record = flags.import
				if (record === null || record.id !== id) {
					throw new ImportError('import-not-found', 'no such import')
				}
				if (authority.kind === 'import-token' && abandonStale) {
					const refusal = this.#staleRefusal(record)
					if (refusal !== null) {
						throw new RefusalError(refusal)
					}
				} else {
					this.#authorizedRecord(authority, id)
				}
				if (record.state !== 'resetting') {
					this.#log({ event: 'kopje.store.import.reset', id })
				}
				return this.#touch({ ...record, state: 'resetting' })
			})
			if (started === null) {
				// Answered from the receipt: the wake-up of a deferred upgrade may have been lost with the first answer.
				await this.#resumeDeferredUpgrade()
				return { ok: true, done: true, progress: null }
			}
			for (let step = 0; step < maxSteps; step++) {
				const finished = this.#transaction(() => this.#resetStep(id))
				if (finished) {
					await this.#resumeDeferredUpgrade()
					return { ok: true, done: true, progress: null }
				}
			}
			return { ok: true, done: false, progress: this.#currentProgress() }
		} catch (error) {
			if (error instanceof RefusalError) {
				return error.refusal
			}
			return asRefusal(error)
		}
	}

	// One transaction of a reset: deletes up to resetBatchRows rows of the last table (in catalog order) that still has
	// rows; when none is left, writes the configuration back, removes the record and leaves the receipt. Returns
	// whether the reset is complete.
	#resetStep(id: string): boolean {
		const record = readFlags(this.#sql).import
		if (record === null || record.id !== id || record.state !== 'resetting') {
			throw new ImportError('import-not-found', 'the reset was taken over')
		}
		// First the references inside a table (statuses: reblog_of_id, in_reply_to_id, and any deferred column), set to
		// NULL in bounded batches: deleting a row they point at would cascade or update without bound. Then rows,
		// children before parents, so no delete reaches another row.
		for (const spec of record.header.tables) {
			if (unlinkRows(this.#sql, spec, this.#resetBatchRows) > 0) {
				this.#touch(record)
				return false
			}
		}
		for (const spec of [...record.header.tables].reverse()) {
			if (deleteRows(this.#sql, spec, this.#resetBatchRows) > 0) {
				this.#touch(record)
				return false
			}
		}
		replaceBootstrapRows(this.#sql, record.bootstrap ?? [])
		writeFlag(this.#sql, 'import', null)
		writeFlag(this.#sql, 'import_reset', { id, completedAt: this.#now() })
		this.#log({ event: 'kopje.store.import.reset-done', id })
		return true
	}

	// Writes the record with a fresh updatedAt: a successful step of the import (the idle clock of abandonStale).
	#touch(record: ImportRecord): ImportRecord {
		const touched = { ...record, updatedAt: this.#now() }
		writeFlag(this.#sql, 'import', touched)
		return touched
	}

	// The admin policy against the given configuration, inside the caller's transaction.
	#assertAdmin(authority: { kind: 'access' } & AdminIdentity & AccessBinding, settings: AccessSettings): void {
		const refused = accessRefusal(settings, authority)
		if (refused !== null) {
			throw new ImportError('wrong-authority', refused)
		}
	}

	// ---- configuration
	//
	// The instance values and the Access authority are set only here, explicitly, never as a side effect of an import:
	// by an Access admin, or with IMPORT_TOKEN while the Store is in bootstrap (admin access not usable yet). The check
	// runs in the transaction that writes.

	// During an import the target's configuration is the copy in the import record, not rows of the dump.
	async config(): Promise<{ values: Record<string, string> }> {
		await this.#kernel.state()
		const running = readFlags(this.#sql).import
		if (running !== null) {
			return { values: Object.fromEntries((running.bootstrap ?? []).map((row) => [row.name, row.value])) }
		}
		return { values: readConfigRows(this.#sql) }
	}

	async setConfig(
		callerBuild: string,
		authority: ImportAuthority,
		values: unknown
	): Promise<Result<{ values: Record<string, string> }>> {
		this.#requireBuild(callerBuild)
		const changes = parseConfigValues(values)
		if (typeof changes === 'string') {
			return refuse('invalid-config', changes)
		}
		await this.#kernel.state()
		try {
			return this.#transaction(() => {
				const flags = readFlags(this.#sql)
				if (authority.kind === 'import-session') {
					throw new ImportError('wrong-authority', 'an import session cannot change the configuration')
				}
				if (flags.import !== null) {
					throw new ImportError('import-in-progress', 'the configuration is set aside while an import runs')
				}
				if (activeDump(flags, this.#now()) !== null) {
					throw new ImportError('dump-in-progress', 'a dump is in progress')
				}
				if (authority.kind === 'import-token' && !this.#inBootstrap(flags, false)) {
					throw new ImportError('not-bootstrap', 'IMPORT_TOKEN only configures a Store without admin access')
				}
				if (authority.kind === 'access') {
					this.#assertAdmin(authority, readAccessSettings(this.#sql))
				}
				for (const [name, value] of Object.entries(changes)) {
					if (value === null) {
						this.#sql.exec('DELETE FROM instance_settings WHERE name = ?', name)
					} else {
						this.#sql.exec('INSERT OR REPLACE INTO instance_settings (name, value) VALUES (?, ?)', name, value)
					}
				}
				this.#log({ event: 'kopje.store.config', names: Object.keys(changes), authority: authority.kind })
				return { ok: true as const, values: readConfigRows(this.#sql) }
			})
		} catch (error) {
			return asRefusal(error)
		}
	}

	// Why a token import may not be abandoned (yet), or null when it may.
	// A reset already under way continues without waiting again.
	#staleRefusal(record: ImportRecord): (Refusal & { resetAfter?: string }) | null {
		if (record.mode !== 'token') {
			return refuse('wrong-authority', 'IMPORT_TOKEN only abandons a token import')
		}
		if (adminUsable(this.#targetSettings(record))) {
			return refuse('not-bootstrap', 'IMPORT_TOKEN only abandons an import into a Store without admin access')
		}
		const resetAfter = record.updatedAt + STALE_IMPORT_MS
		if (record.state !== 'resetting' && this.#now() < resetAfter) {
			const at = new Date(resetAfter).toISOString()
			return {
				...refuse('import-not-idle', `the import's session was active recently; abandoning it is possible after ${at}`),
				resetAfter: at,
			}
		}
		return null
	}

	// Bootstrap: no import running, admin access not usable, and (for an import) no data.
	#inBootstrap(flags: OperatorFlags, requireEmpty = true): boolean {
		return (
			flags.import === null && !adminUsable(readAccessSettings(this.#sql)) && (!requireEmpty || this.#emptyOfData())
		)
	}

	#emptyOfData(): boolean {
		try {
			return isEmpty(this.#sql, readCatalog(this.#sql), BOOTSTRAP)
		} catch {
			return false
		}
	}

	// The running import with this id, if the authority may act on it; throws a refusal otherwise.
	#authorizedRecord(authority: ImportAuthority, id: string): ImportRecord {
		const record = readFlags(this.#sql).import
		if (record === null || record.id !== id) {
			throw new ImportError('import-not-found', 'no such import')
		}
		const allowed =
			(authority.kind === 'access' && record.mode === 'access') ||
			(authority.kind === 'import-session' &&
				record.mode === 'token' &&
				sessionMatches(authority.secret, record.sessionHash ?? null))
		if (!allowed) {
			throw new ImportError('wrong-authority', 'this credential does not authorize that import')
		}
		if (authority.kind === 'access') {
			this.#assertAdmin(authority, this.#targetSettings(record))
		}
		return record
	}

	#authorizeReceipt(authority: ImportAuthority, receipt: ImportReceipt): void {
		const allowed =
			(authority.kind === 'access' && accessRefusal(readAccessSettings(this.#sql), authority) === null) ||
			(authority.kind === 'import-session' &&
				receipt.mode === 'token' &&
				sessionMatches(authority.secret, receipt.sessionHash))
		if (!allowed) {
			throw new ImportError('wrong-authority', 'this credential does not authorize that import')
		}
	}

	// The Store's own Access settings: the live rows, or during an import the copy its record holds (the table then
	// holds the dump's rows).
	#targetSettings(running: ImportRecord | null): AccessSettings {
		return running === null ? readAccessSettings(this.#sql) : settingsFromRows(running.bootstrap ?? [])
	}

	#currentProgress(): ImportProgress | null {
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

// 32 random bytes as base64url: the session credential of a token import.
function randomSecret(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32))
	return btoa(String.fromCharCode(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '')
}

// Compares the SHA-256 digest of the presented secret with the stored one: fixed-size values, compared with the
// runtime's timingSafeEqual (as security/tokens.ts constantTimeEqual does).
function sessionMatches(secret: string, sessionHash: string | null): boolean {
	if (sessionHash === null || !/^[0-9a-f]{64}$/.test(sessionHash)) {
		return false
	}
	return crypto.subtle.timingSafeEqual(fromHex(sha256Hex(secret)), fromHex(sessionHash))
}

function trailerSha256(trailer: DumpTrailer | null): string | null {
	return trailer === null ? null : sha256Hex(JSON.stringify(trailer))
}

// Carries a refusal with extra fields (resetAfter) out of a transaction.
class RefusalError extends Error {
	constructor(readonly refusal: Refusal) {
		super(refusal.message)
	}
}

// How a reset step names rows of a table: the rowid, or the primary key of a WITHOUT ROWID table.
function rowKey(spec: TableSpec): { key: string; columns: string } {
	if (spec.order.by === 'rowid') {
		return { key: 'rowid', columns: 'rowid' }
	}
	const columns = spec.key.map(quoteIdentifier).join(',')
	return { key: `(${columns})`, columns }
}

// Sets the deferred (self- or cyclic) references of up to `limit` rows to NULL. Returns how many rows changed.
function unlinkRows(sql: SqlStorage, spec: TableSpec, limit: number): number {
	if (spec.deferred.length === 0) {
		return 0
	}
	const table = quoteIdentifier(spec.name)
	const set = spec.deferred.map((c) => `${quoteIdentifier(c)} = NULL`).join(', ')
	const linked = spec.deferred.map((c) => `${quoteIdentifier(c)} IS NOT NULL`).join(' OR ')
	const { key, columns } = rowKey(spec)
	return sql
		.exec<{
			n: number
		}>(
			`UPDATE ${table} SET ${set} WHERE ${key} IN (SELECT ${columns} FROM ${table} WHERE ${linked} LIMIT ?) RETURNING 1 AS n`,
			limit
		)
		.toArray().length
}

// Deletes up to `limit` rows of a dumped table (kopje_state: only its dumped rows). Returns how many were deleted.
function deleteRows(sql: SqlStorage, spec: TableSpec, limit: number): number {
	const table = quoteIdentifier(spec.name)
	const only =
		spec.only === undefined
			? ''
			: ` WHERE ${quoteIdentifier(spec.only.column)} IN (${spec.only.values.map(() => '?').join(',')})`
	const params = spec.only === undefined ? [] : [...spec.only.values]
	const { key, columns } = rowKey(spec)
	return sql.exec(
		`DELETE FROM ${table} WHERE ${key} IN (SELECT ${columns} FROM ${table}${only} LIMIT ?)`,
		...params,
		limit
	).rowsWritten
}

function receiptProgress(receipt: ImportReceipt): ImportProgress {
	return {
		id: receipt.id,
		mode: receipt.mode,
		headerSha256: receipt.headerSha256,
		trailerSha256: receipt.trailerSha256 ?? null,
		updatedAt: receipt.completedAt,
		state: 'verified',
		lastSeq: receipt.lastSeq,
		digest: receipt.digest,
		statements: receipt.statements,
		bytes: receipt.bytes,
		report: receipt.report,
	}
}

const MAX_CONFIG_VALUE = 1024

// { name: value | null } over CONFIG_KEYS; null removes the row. Returns why it is invalid otherwise.
function parseConfigValues(value: unknown): Record<string, string | null> | string {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return 'values must be an object'
	}
	const entries = Object.entries(value)
	if (entries.length === 0) {
		return 'no values given'
	}
	const changes: Record<string, string | null> = {}
	for (const [name, raw] of entries) {
		if (!CONFIG_KEYS.includes(name)) {
			return `${name} is not configurable; allowed: ${CONFIG_KEYS.join(', ')}`
		}
		if (raw === null) {
			changes[name] = null
			continue
		}
		const text = typeof raw === 'string' ? raw.trim() : ''
		if (text === '' || text.length > MAX_CONFIG_VALUE) {
			return `${name} must be a non-empty string of at most ${MAX_CONFIG_VALUE} characters, or null`
		}
		changes[name] = text
	}
	return changes
}

function progressOf(record: ImportRecord): ImportProgress {
	return {
		id: record.id,
		mode: record.mode,
		headerSha256: record.headerSha256,
		trailerSha256: trailerSha256(record.trailer),
		updatedAt: record.updatedAt,
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
