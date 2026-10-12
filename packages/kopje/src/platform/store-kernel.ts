import { errorMessage } from './error-message'
import { type MaintenanceReason, storeMaintenanceError } from './store-errors'

export type Migration = { readonly name: string; readonly sql: string }

// What an operation does, so the Store can apply the maintenance table (design §4) itself:
//   read    : reads only
//   session : login and Web Push registration writes, which readonly still lets through
//   write   : any other write
export type OperationKind = 'read' | 'session' | 'write'

// The Store's own maintenance state is at most readonly (full is set only through the env). Readonly admits reads and
// sessions and refuses writes.
const READONLY_ADMITS: Record<OperationKind, boolean> = { read: true, session: true, write: false }

// One domain operation = one RPC = one transactionSync. It runs synchronously over the Store's SQLite and must not
// do external I/O. Timestamps and IDs come from the caller (Date.now() does not advance inside one DO request).
export type StoreOperation<I, O> = { readonly kind: OperationKind; run(sql: SqlStorage, input: I): O }

export type SchemaState =
	| { status: 'current' }
	| { status: 'pending'; pending: string[] }
	| { status: 'diverged'; detail: string }

// A persisted readonly flag. Cleared when a different build of the code starts (a new deployment).
export type Hold = { reason: MaintenanceReason; build: string; detail: string; at: number }

// Persisted before the first file is applied and cleared only in the transaction of a successful verification. Any
// isolate that finds it stays readonly and re-runs the upgrade, which resumes and verifies.
type UpgradeMarker = { build: string; bookmark: string; at: number }

type KernelState = { schema: SchemaState; hold: Hold | null; upgrading: UpgradeMarker | null }

// Upgrade phases, in order. A failure in each is reported with its own reason.
export type UpgradePhase = 'bookmark' | 'apply' | 'verify'

const PHASE_REASON: Record<UpgradePhase, MaintenanceReason> = {
	bookmark: 'bookmark-failed',
	apply: 'upgrade-failed',
	verify: 'verify-failed',
}

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
	upgrading: boolean
	lastBookmark: string | null
	databaseSize: number
}

export type KernelOptions = {
	build: string
	migrations: readonly Migration[]
	now?: () => number
	// Seams for fault injection in tests. transaction defaults to ctx.storage.transactionSync. inject is called inside
	// each upgrade phase, and as 'hold' before a hold is recorded; throwing there simulates a failure of that step.
	transaction?: <T>(fn: () => T) => T
	inject?: (phase: UpgradePhase | 'hold') => void
	log?: (entry: Record<string, unknown>) => void
}

// A response body kept for the rescue path: the last good actor document, WebFinger or NodeInfo payload. Stored in
// kopje_state under SNAPSHOT_STATE_PREFIX + key.
export type Snapshot = { contentType: string; body: string }

export const SNAPSHOT_STATE_PREFIX = 'snapshot:'

// The row: the snapshot and the time it was rendered, or only the time once an oversized replacement emptied it.
export type StoredSnapshot = (Snapshot & { renderedAt: number }) | { renderedAt: number }

// Caps that keep the snapshots bounded whatever a request asks for: keys have one of two shapes and a bounded length,
// and a body over the size cap is never stored (the rescue path then answers 503, as without a snapshot).
export const SNAPSHOT_MAX_KEY_LENGTH = 512
export const SNAPSHOT_MAX_BODY_BYTES = 64 * 1024

export function isSnapshotKey(key: string): boolean {
	return key.length <= SNAPSHOT_MAX_KEY_LENGTH && /^(path|webfinger):\S+$/.test(key)
}

export function isStorableSnapshot(key: string, body: string): boolean {
	return isSnapshotKey(key) && new TextEncoder().encode(body).byteLength <= SNAPSHOT_MAX_BODY_BYTES
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
	readonly #inject: (phase: UpgradePhase | 'hold') => void
	readonly #log: (entry: Record<string, unknown>) => void
	#expected: Promise<ExpectedMigration[]> | undefined
	#state: KernelState | undefined

	constructor(ctx: DurableObjectState, options: KernelOptions) {
		this.build = options.build
		this.#ctx = ctx
		this.#sql = ctx.storage.sql
		this.#migrations = options.migrations
		this.#now = options.now ?? Date.now
		this.#transaction = options.transaction ?? ((fn) => ctx.storage.transactionSync(fn))
		this.#inject = options.inject ?? (() => {})
		this.#log = options.log ?? ((entry) => console.log(entry))
	}

	// Runs a domain operation if this Store can serve its kind: same build as the caller, schema current, and the
	// readonly table for a held or upgrading Store. Otherwise throws a maintenance error that the Worker maps to spool
	// or 503. The state is checked inside the same transaction that runs the operation.
	async execute<I, O>(callerBuild: string, operation: StoreOperation<I, O>, input: I): Promise<O> {
		if (callerBuild !== this.build) {
			throw storeMaintenanceError('version-mismatch')
		}
		const loaded = await this.#currentState()
		return this.#transaction(() => {
			admit(this.#state ?? loaded, operation.kind)
			return operation.run(this.#sql, input)
		})
	}

	// Rescue RPC: available in every state and for any caller build.
	async health(callerBuild: string): Promise<StoreHealth> {
		const expected = await this.#expectedMigrations()
		const { schema, hold, upgrading } = await this.#currentState()
		return {
			build: this.build,
			callerBuild,
			versionMatch: callerBuild === this.build,
			schema: { ...schema, applied: this.#readApplied().map((m) => m.name), expected: expected.map((m) => m.name) },
			readonly: schema.status !== 'current' || hold !== null || upgrading !== null,
			hold: hold?.reason ?? null,
			upgrading: upgrading !== null,
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

	// Rescue RPC: the last good document saved under this key (domain/snapshot.ts), or null. It reads kopje_state
	// directly, which exists whatever the schema state, so it works for any caller build and while the Store refuses
	// domain operations.
	readSnapshot(key: string): Snapshot | null {
		if (!isSnapshotKey(key)) {
			return null
		}
		try {
			const value = this.#readState(`${SNAPSHOT_STATE_PREFIX}${key}`)
			const stored = value === null ? null : (JSON.parse(value) as Partial<Snapshot>)
			return stored?.contentType === undefined || stored.body === undefined
				? null
				: { contentType: stored.contentType, body: stored.body }
		} catch (error) {
			this.#log({ event: 'kopje.store.snapshot.unreadable', key, error: errorMessage(error) })
			return null
		}
	}

	// Rescue RPC: restores the database to a bookmark on the next start and restarts the object now, so the
	// caller sees this call fail once the restart happens. Keep MAINTENANCE=full set while doing this. It mutates, so
	// unlike the other rescue RPCs it requires the caller's build to match.
	async restoreBookmark(callerBuild: string, bookmark: string): Promise<void> {
		if (callerBuild !== this.build) {
			throw storeMaintenanceError('version-mismatch')
		}
		this.#log({ event: 'kopje.store.pitr', bookmark })
		await this.#ctx.storage.onNextSessionRestoreBookmark(bookmark)
		this.#ctx.abort('restoring PITR bookmark')
	}

	// Brings the schema up to date and verifies it. Called from the alarm; never from the constructor. Once the
	// starting state is loaded, a failure in any phase (bookmark, apply, verify) becomes a result and leaves the
	// Store readonly; nothing throws past here.
	async upgrade(): Promise<UpgradeResult> {
		const expected = await this.#expectedMigrations()
		const state = await this.#currentState()
		const { schema, hold } = state
		if (hold !== null) {
			// A failed upgrade of this build stays readonly until a new deployment or the DB is restored.
			return { ok: false, bookmark: null, reason: hold.reason, detail: 'held' }
		}
		if (schema.status === 'diverged') {
			return { ok: false, bookmark: null, reason: 'schema-diverged', detail: schema.detail }
		}
		if (schema.status === 'current' && state.upgrading === null) {
			return { ok: true, bookmark: null, applied: [] }
		}

		let phase: UpgradePhase = 'bookmark'
		let marker = state.upgrading
		let current: string | null = null
		const applied: string[] = []
		try {
			if (marker === null) {
				// A resumed upgrade keeps the bookmark taken before its first file.
				this.#inject('bookmark')
				const bookmark = await this.#ctx.storage.getCurrentBookmark()
				const started: UpgradeMarker = { build: this.build, bookmark, at: this.#now() }
				this.#transaction(() => {
					this.#writeState('upgrade_bookmark', bookmark)
					this.#writeState('upgrade', JSON.stringify(started))
				})
				marker = started
				this.#state = { ...state, upgrading: started }
			}
			this.#log({ event: 'kopje.store.upgrade.start', bookmark: marker.bookmark, pending: pendingOf(schema) })

			phase = 'apply'
			for (const migration of expected.filter((m) => pendingOf(schema).includes(m.name))) {
				current = migration.name
				this.#transaction(() => {
					this.#sql.exec(migration.sql)
					this.#sql.exec(
						'INSERT INTO kopje_migrations (name, checksum, applied_at) VALUES (?, ?, ?)',
						migration.name,
						migration.checksum,
						this.#now()
					)
					this.#inject('apply')
				})
				applied.push(migration.name)
			}
			current = null

			phase = 'verify'
			const problem = this.#transaction(() => {
				this.#inject('verify')
				const found = this.#verify(expected)
				if (found === null) {
					this.#writeState('upgrade', null)
				}
				return found
			})
			if (problem !== null) {
				return this.#fail(expected, marker.bookmark, 'verify-failed', problem)
			}
		} catch (error) {
			// An error does not prove a rollback: a timed-out transaction can still be durable. Report what is
			// actually recorded; #fail re-reads the durable state and the Store stays readonly either way.
			const failed = current
			const detail =
				failed === null
					? errorMessage(error)
					: `${failed} (recorded: ${this.#readAppliedSafe().some((m) => m.name === failed)}): ${errorMessage(error)}`
			return this.#fail(expected, marker?.bookmark ?? null, PHASE_REASON[phase], detail)
		}
		this.#state = { schema: { status: 'current' }, hold: null, upgrading: null }
		this.#log({ event: 'kopje.store.upgrade.done', bookmark: marker.bookmark, applied })
		return { ok: true, bookmark: marker.bookmark, applied }
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
			this.#inject('hold')
			this.#writeState('hold', JSON.stringify(hold))
		} catch (error) {
			// Storage may be unusable. The in-memory hold keeps this isolate readonly, and the durable upgrade marker
			// keeps a fresh isolate readonly.
			this.#log({ event: 'kopje.store.hold.persist-failed', error: errorMessage(error) })
		}
		let durable: KernelState
		try {
			durable = this.#readDurableState(expected)
		} catch {
			durable = { schema: { status: 'pending', pending: expected.map((m) => m.name) }, hold, upgrading: null }
		}
		this.#state = { ...durable, hold }
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

	async #currentState(): Promise<KernelState> {
		if (this.#state !== undefined) {
			return this.#state
		}
		const expected = await this.#expectedMigrations()
		this.#ensureBookkeeping()
		let state = this.#readDurableState(expected)
		if (state.hold !== null && state.hold.build !== this.build) {
			// A different build failed earlier; this build gets its own attempt.
			this.#writeState('hold', null)
			state = { ...state, hold: null }
		}
		const unfinished = state.schema.status === 'pending' || state.upgrading !== null
		if (unfinished && state.hold === null && (await this.#ctx.storage.getAlarm()) === null) {
			await this.#ctx.storage.setAlarm(this.#now())
		}
		this.#state ??= state
		return this.#state
	}

	#readDurableState(expected: ExpectedMigration[]): KernelState {
		const hold = this.#readState('hold')
		const upgrading = this.#readState('upgrade')
		return {
			schema: this.#compare(expected, this.#readApplied()),
			hold: hold === null ? null : (JSON.parse(hold) as Hold),
			upgrading: upgrading === null ? null : (JSON.parse(upgrading) as UpgradeMarker),
		}
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

	// kopje_state holds the hold, the upgrade marker and bookmark, last_local_id (domain/ids.ts), and the rescue
	// snapshots (domain/snapshot.ts).
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

// The maintenance table for one operation kind. A schema that is not current serves nothing; a held or upgrading
// Store is readonly.
function admit({ schema, hold, upgrading }: KernelState, kind: OperationKind): void {
	if (schema.status !== 'current') {
		throw storeMaintenanceError(schema.status === 'pending' ? 'schema-pending' : 'schema-diverged')
	}
	if ((hold !== null || upgrading !== null) && !READONLY_ADMITS[kind]) {
		throw storeMaintenanceError(hold?.reason ?? 'upgrade-in-progress')
	}
}

function pendingOf(schema: SchemaState): string[] {
	return schema.status === 'pending' ? schema.pending : []
}

export async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}
