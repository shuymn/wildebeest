import type { DumpHeader, DumpTrailer, TableResult } from './dump-format'
import type { ScanPosition } from './store-dump'
import { storeMaintenanceError } from './store-errors'
import type { VerifyReport } from './store-import'
import type { OperationKind } from './store-kernel'

// Operator state kept in kopje_state. None of it is part of a dump (dump-catalog.ts), and all of it rewinds with a
// PITR restore, which is why PITR is done under the env MAINTENANCE=full instead.
//
//   maintenance : set by the admin; readonly (reads and sessions pass, other writes are refused)
//   dump        : a dump in progress; while its lease is valid only reads pass (sessions and alarm work too wait)
//   import      : an import in progress; nothing passes until it is verified

export type MaintenanceFlag = { mode: 'readonly'; at: number }

export type DumpRecord = {
	id: string
	startedAt: number
	leaseMs: number
	leaseUntil: number
	header: DumpHeader
	// Results of the tables finished so far, in header order; the trailer is built from these.
	results: TableResult[]
}

export type VerifyProgress = { position: ScanPosition; results: TableResult[] }

export type ImportState = 'receiving' | 'finished' | 'failed'

export type ImportRecord = {
	id: string
	// How the import was authorized. A 'token' import keeps accepting IMPORT_TOKEN until it is verified.
	mode: 'token' | 'access'
	state: ImportState
	header: DumpHeader
	headerSha256: string
	lastSeq: number
	// digest_n = hex(sha256(digest_{n-1} || chunk_n)), digest_0 = ''
	digest: string
	statements: number
	bytes: number
	bodyHash: string // saved Sha256 state over all chunk bytes
	trailer: DumpTrailer | null
	verify: VerifyProgress | null
	// Set when verification failed; the import then needs a reset (deleteAll) and a new import.
	report: VerifyReport | null
	startedAt: number
	updatedAt: number
}

export type OperatorFlags = {
	maintenance: MaintenanceFlag | null
	dump: DumpRecord | null
	import: ImportRecord | null
}

export const FLAG_NAMES = ['maintenance', 'dump', 'import'] as const
type FlagName = (typeof FLAG_NAMES)[number]

export function readFlags(sql: SqlStorage): OperatorFlags {
	const flags: OperatorFlags = { maintenance: null, dump: null, import: null }
	for (const row of sql
		.exec<{
			name: FlagName
			value: string
		}>("SELECT name, value FROM kopje_state WHERE name IN ('maintenance', 'dump', 'import')")
		.toArray()) {
		flags[row.name] = JSON.parse(row.value) as never
	}
	return flags
}

export function writeFlag<N extends FlagName>(sql: SqlStorage, name: N, value: OperatorFlags[N]): void {
	if (value === null) {
		sql.exec('DELETE FROM kopje_state WHERE name = ?', name)
	} else {
		sql.exec('INSERT OR REPLACE INTO kopje_state (name, value) VALUES (?, ?)', name, JSON.stringify(value))
	}
}

// A dump freezes the Store only while its lease is valid, so a crashed dump cannot freeze it forever.
export function activeDump(flags: OperatorFlags, now: number): DumpRecord | null {
	return flags.dump !== null && now < flags.dump.leaseUntil ? flags.dump : null
}

// The operator part of the maintenance table for one operation kind.
export function admitFlags(flags: OperatorFlags, kind: OperationKind, now: number): void {
	if (flags.import !== null) {
		throw storeMaintenanceError('import-in-progress')
	}
	if (kind !== 'read' && activeDump(flags, now) !== null) {
		throw storeMaintenanceError('dump-in-progress')
	}
	if (kind === 'write' && flags.maintenance !== null) {
		throw storeMaintenanceError('maintenance')
	}
}
