import { type MaintenanceReason, storeMaintenanceError } from './store-errors'

export type Migration = { readonly name: string; readonly sql: string }

export type OperationKind = 'read' | 'write'

// One domain operation = one RPC = one transactionSync. It runs synchronously over the Store's SQLite and must not
// do external I/O. Timestamps and IDs come from the caller (Date.now() does not advance inside one DO request).
export type StoreOperation<I, O> = { readonly kind: OperationKind; run(sql: SqlStorage, input: I): O }

export type SchemaState =
	| { status: 'current' }
	| { status: 'pending'; pending: string[] }
	| { status: 'diverged'; detail: string }

// A persisted readonly flag. Cleared when a different build of the code starts (fix-forward deploy).
export type Hold = { reason: MaintenanceReason; build: string; detail: string; at: number }

export type UpgradeResult =
	| { ok: true; bookmark: string | null; applied: string[] }
	| { ok: false; bookmark: string | null; reason: MaintenanceReason; detail: string }

export type StoreHealth = {
	build: string
	callerBuild: string
	versionMatch: boolean
	schema: SchemaState & { applied: string[]; expected: string[] }
	readonly: boolean
	hold: MaintenanceReason | null
	lastBookmark: string | null
	databaseSize: number
}

export type KernelOptions = {
	build: string
	migrations: readonly Migration[]
	now?: () => number
	// Seam for fault injection in tests. Defaults to ctx.storage.transactionSync.
	transaction?: <T>(fn: () => T) => T
	log?: (entry: Record<string, unknown>) => void
}

type ExpectedMigration = Migration & { checksum: string }
type AppliedMigration = { name: string; checksum: string }

const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+$/

// Everything the Store does that depends on Durable Object features: schema bookkeeping, the readonly flag,
// upgrades in the alarm, PITR bookmarks, and gating of domain operations. The constructor does no I/O.
export class StoreKernel {
	readonly build: string
	readonly #ctx: DurableObjectState
	readonly #sql: SqlStorage
	readonly #migrations: readonly Migration[]
	readonly #now: () => number
	readonly #transaction: <T>(fn: () => T) => T
	readonly #log: (entry: Record<string, unknown>) => void
	#expected: Promise<ExpectedMigration[]> | undefined
	#state: { schema: SchemaState; hold: Hold | null } | undefined

	constructor(ctx: DurableObjectState, options: KernelOptions) {
		this.build = options.build
		this.#ctx = ctx
		this.#sql = ctx.storage.sql
		this.#migrations = options.migrations
		this.#now = options.now ?? Date.now
		this.#transaction = options.transaction ?? ((fn) => ctx.storage.transactionSync(fn))
		this.#log = options.log ?? ((entry) => console.log(entry))
	}

	// Runs a domain operation if this Store can serve it: same build as the caller, schema current, and no
	// readonly hold for writes. Otherwise throws a maintenance error that the Worker maps to spool or 503.
	async execute<I, O>(callerBuild: string, operation: StoreOperation<I, O>, input: I): Promise<O> {
		if (callerBuild !== this.build) {
			throw storeMaintenanceError('version-mismatch')
		}
		const { schema, hold } = await this.#currentState()
		if (schema.status !== 'current') {
			throw storeMaintenanceError(schema.status === 'pending' ? 'schema-pending' : 'schema-diverged')
		}
		if (operation.kind === 'write' && hold !== null) {
			throw storeMaintenanceError(hold.reason)
		}
		return this.#transaction(() => operation.run(this.#sql, input))
	}

	// Rescue RPC: available in every state and for any caller build.
	async health(callerBuild: string): Promise<StoreHealth> {
		const expected = await this.#expectedMigrations()
		const { schema, hold } = await this.#currentState()
		return {
			build: this.build,
			callerBuild,
			versionMatch: callerBuild === this.build,
			schema: { ...schema, applied: this.#readApplied().map((m) => m.name), expected: expected.map((m) => m.name) },
			readonly: schema.status !== 'current' || hold !== null,
			hold: hold?.reason ?? null,
			lastBookmark: this.#readState('upgrade_bookmark'),
			databaseSize: this.#sql.databaseSize,
		}
	}

	// Rescue RPC: the code's build and the newest expected and applied schema files.
	async version(): Promise<{ build: string; expected: string | null; applied: string | null }> {
		const expected = await this.#expectedMigrations()
		this.#ensureBookkeeping()
		return {
			build: this.build,
			expected: expected.at(-1)?.name ?? null,
			applied: this.#readApplied().at(-1)?.name ?? null,
		}
	}

	// Rescue RPC: restores the database to a bookmark on the next start and restarts the object now, so the
	// caller sees this call fail once the restart happens. Keep MAINTENANCE=full set while doing this.
	async restoreBookmark(bookmark: string): Promise<void> {
		this.#log({ event: 'kopje.store.pitr', bookmark })
		await this.#ctx.storage.onNextSessionRestoreBookmark(bookmark)
		this.#ctx.abort('restoring PITR bookmark')
	}

	// Brings the schema up to date. Called from the alarm; never from the constructor.
	async upgrade(): Promise<UpgradeResult> {
		const expected = await this.#expectedMigrations()
		const { schema, hold } = await this.#currentState()
		if (hold !== null) {
			// A failed upgrade of this build stays readonly until a fixed build is deployed or the DB is restored.
			return { ok: false, bookmark: null, reason: hold.reason, detail: 'held' }
		}
		if (schema.status === 'diverged') {
			return { ok: false, bookmark: null, reason: 'schema-diverged', detail: schema.detail }
		}
		if (schema.status === 'current') {
			return { ok: true, bookmark: null, applied: [] }
		}

		let bookmark: string
		try {
			bookmark = await this.#ctx.storage.getCurrentBookmark()
		} catch (error) {
			return this.#fail(expected, null, 'bookmark-failed', errorMessage(error))
		}
		this.#writeState('upgrade_bookmark', bookmark)
		this.#log({ event: 'kopje.store.upgrade.start', bookmark, pending: schema.pending })

		const applied: string[] = []
		for (const migration of expected.filter((m) => schema.pending.includes(m.name))) {
			try {
				this.#transaction(() => {
					this.#sql.exec(migration.sql)
					this.#sql.exec(
						'INSERT INTO kopje_migrations (name, checksum, applied_at) VALUES (?, ?, ?)',
						migration.name,
						migration.checksum,
						this.#now()
					)
				})
			} catch (error) {
				// An error does not prove a rollback: a timed-out transaction can still be durable. Re-read the
				// bookkeeping table and report what is actually there; stay readonly either way.
				const recorded = this.#readApplied().some((m) => m.name === migration.name)
				const detail = `${migration.name} (recorded: ${recorded}): ${errorMessage(error)}`
				return this.#fail(expected, bookmark, 'upgrade-failed', detail)
			}
			applied.push(migration.name)
		}

		const problem = this.#verify(expected)
		if (problem !== null) {
			return this.#fail(expected, bookmark, 'verify-failed', problem)
		}
		this.#state = { schema: { status: 'current' }, hold: null }
		this.#log({ event: 'kopje.store.upgrade.done', bookmark, applied })
		return { ok: true, bookmark, applied }
	}

	#fail(
		expected: ExpectedMigration[],
		bookmark: string | null,
		reason: MaintenanceReason,
		detail: string
	): UpgradeResult {
		const hold: Hold = { reason, build: this.build, detail, at: this.#now() }
		this.#log({ event: 'kopje.store.upgrade.failed', bookmark, reason, detail })
		try {
			this.#writeState('hold', JSON.stringify(hold))
		} catch (error) {
			// Storage may be unusable; the in-memory hold still keeps this instance readonly.
			this.#log({ event: 'kopje.store.hold.persist-failed', error: errorMessage(error) })
		}
		this.#state = { schema: this.#compare(expected, this.#readAppliedSafe()), hold }
		return { ok: false, bookmark, reason, detail }
	}

	#verify(expected: ExpectedMigration[]): string | null {
		const violations = this.#sql.exec('PRAGMA foreign_key_check').toArray()
		if (violations.length > 0) {
			return `foreign_key_check reported ${violations.length} violation(s)`
		}
		const schema = this.#compare(expected, this.#readApplied())
		return schema.status === 'current' ? null : `bookkeeping is ${schema.status} after upgrade`
	}

	async #currentState(): Promise<{ schema: SchemaState; hold: Hold | null }> {
		if (this.#state !== undefined) {
			return this.#state
		}
		const expected = await this.#expectedMigrations()
		this.#ensureBookkeeping()
		let hold = this.#readHold()
		if (hold !== null && hold.build !== this.build) {
			// A different build failed earlier; this build gets its own attempt.
			this.#writeState('hold', null)
			hold = null
		}
		const schema = this.#compare(expected, this.#readApplied())
		if (schema.status === 'pending' && hold === null && (await this.#ctx.storage.getAlarm()) === null) {
			await this.#ctx.storage.setAlarm(this.#now())
		}
		this.#state = { schema, hold }
		return this.#state
	}

	#compare(expected: ExpectedMigration[], applied: AppliedMigration[]): SchemaState {
		for (const [i, row] of applied.entries()) {
			const want = expected[i]
			if (want === undefined) {
				return { status: 'diverged', detail: `${row.name} is applied but unknown to this build` }
			}
			if (want.name !== row.name || want.checksum !== row.checksum) {
				return { status: 'diverged', detail: `${row.name} does not match ${want.name} of this build` }
			}
		}
		const pending = expected.slice(applied.length).map((m) => m.name)
		return pending.length === 0 ? { status: 'current' } : { status: 'pending', pending }
	}

	#expectedMigrations(): Promise<ExpectedMigration[]> {
		this.#expected ??= Promise.all(
			this.#migrations.map(async (m, i) => {
				const previous = this.#migrations[i - 1]
				if (!MIGRATION_NAME.test(m.name) || (previous !== undefined && previous.name >= m.name)) {
					throw new Error(`invalid migration list at ${m.name}`)
				}
				return { ...m, checksum: await sha256(m.sql) }
			})
		)
		return this.#expected
	}

	#ensureBookkeeping(): void {
		this.#sql.exec(
			'CREATE TABLE IF NOT EXISTS kopje_migrations (name TEXT NOT NULL PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL) WITHOUT ROWID;' +
				'CREATE TABLE IF NOT EXISTS kopje_state (name TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID'
		)
	}

	#readApplied(): AppliedMigration[] {
		return this.#sql.exec<AppliedMigration>('SELECT name, checksum FROM kopje_migrations ORDER BY name').toArray()
	}

	#readAppliedSafe(): AppliedMigration[] {
		try {
			return this.#readApplied()
		} catch {
			return []
		}
	}

	#readHold(): Hold | null {
		const value = this.#readState('hold')
		return value === null ? null : (JSON.parse(value) as Hold)
	}

	#readState(name: string): string | null {
		const row = this.#sql.exec<{ value: string }>('SELECT value FROM kopje_state WHERE name = ?', name).toArray()[0]
		return row?.value ?? null
	}

	#writeState(name: string, value: string | null): void {
		if (value === null) {
			this.#sql.exec('DELETE FROM kopje_state WHERE name = ?', name)
		} else {
			this.#sql.exec('INSERT OR REPLACE INTO kopje_state (name, value) VALUES (?, ?)', name, value)
		}
	}
}

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
