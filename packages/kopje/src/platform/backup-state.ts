import type { MigrationRecord } from './dump-format'
import type { DumpCursor } from './store-dump'

// The scheduled backup's progress (jobs/backup.ts), kept in kopje_state under 'backup'. It holds no secret: object
// keys, upload ids, digests and sizes only (DATA-9). Like the other operator state it is not part of a dump.
//
// Writes are compare-and-set on `rev`, so of two cron invocations only the one holding the runner lease can save; the
// other's next save fails and it stops.

export type Failure = { id: string | null; at: number; stage: string | null; reason: string }

// A dump being written: enough to release its freeze (the Store dump, found again by opId or cursor) and to abort its
// multipart upload after a crash. The age stream cannot be resumed, so neither can the object: it is restarted.
export type DumpProgress = {
	opId: string
	cursor: DumpCursor | null
	key: string
	uploadId: string | null
	parts: number
	bytes: number
}

export type Digest = { size: number; sha256: string }

export type DumpResult = Digest & {
	key: string
	plaintext: Digest
	createdAt: string
	source: { build: string; version: string }
	migrations: MigrationRecord[]
}

export type MediaCopy = Digest & { source: string; key: string; plaintext: Digest }

export type BackupRun = {
	// The UTC date the run started; it names the run's objects.
	id: string
	startedAt: number
	// Invocations that died while holding this run, since its last recorded failure.
	attempts: number
	stage: 'dump' | 'media' | 'manifest'
	dump: DumpProgress | null
	result: DumpResult | null
	// R2 originals: copied after `from` (the last successful backup's `through`) up to `after`.
	media: { from: string | null; after: string | null; objects: MediaCopy[] }
	manifestAt: number | null
}

export type BackupState = {
	runner: { id: string; until: number } | null
	run: BackupRun | null
	lastSuccess: {
		id: string
		at: number
		manifest: string
		// SHA-256 of the encrypted manifest as uploaded.
		manifestSha256: string
		dumpBytes: number
		media: number
	} | null
	lastFailure: Failure | null
	// After a failure, nothing starts again before this time.
	retryAt: number | null
	// The last R2 original a successful backup covers.
	mediaAfter: string | null
	retentionFailure: { at: number; reason: string } | null
}

export type BackupRecord = { rev: number; state: BackupState }

export const EMPTY_BACKUP_STATE: BackupState = {
	runner: null,
	run: null,
	lastSuccess: null,
	lastFailure: null,
	retryAt: null,
	mediaAfter: null,
	retentionFailure: null,
}

const NAME = 'backup'
// A run lists at most MAX_MEDIA_PER_RUN media copies, so the record stays far below this.
const MAX_RECORD_BYTES = 1024 * 1024

export function readBackupRecord(sql: SqlStorage): BackupRecord {
	const row = sql.exec<{ value: string }>('SELECT value FROM kopje_state WHERE name = ?', NAME).toArray()[0]
	return row === undefined ? { rev: 0, state: EMPTY_BACKUP_STATE } : (JSON.parse(row.value) as BackupRecord)
}

export type SaveResult = { ok: true; rev: number } | { ok: false; code: 'conflict' | 'too-large' | 'invalid' }

// Call inside a transaction.
export function writeBackupRecord(sql: SqlStorage, rev: number, state: unknown): SaveResult {
	if (!Number.isSafeInteger(rev) || typeof state !== 'object' || state === null || Array.isArray(state)) {
		return { ok: false, code: 'invalid' }
	}
	if (readBackupRecord(sql).rev !== rev) {
		return { ok: false, code: 'conflict' }
	}
	const value = JSON.stringify({ rev: rev + 1, state })
	if (value.length > MAX_RECORD_BYTES) {
		return { ok: false, code: 'too-large' }
	}
	sql.exec('INSERT OR REPLACE INTO kopje_state (name, value) VALUES (?, ?)', NAME, value)
	return { ok: true, rev: rev + 1 }
}
