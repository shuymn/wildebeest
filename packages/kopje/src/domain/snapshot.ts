import { writeOperation } from './operation'
import { isSnapshotKey, isStorableSnapshot, type Snapshot, SNAPSHOT_STATE_PREFIX } from '../platform/store-kernel'

// Keeps the last good response of an always-served GET (actor document, WebFinger, NodeInfo) for the rescue path,
// which the Store serves through readSnapshot while it refuses domain operations. Writes only when the body changed,
// so a steady document costs a read and no row write. A malformed key or an oversized body is not stored (false); an
// oversized body also drops the kept snapshot of its key, so the rescue path answers 503 instead of an outdated
// document.
export const saveSnapshot = writeOperation<{ key: string } & Snapshot, boolean>((db, { key, contentType, body }) => {
	if (!isSnapshotKey(key)) {
		return false
	}
	if (!isStorableSnapshot(key, body)) {
		db.run('DELETE FROM kopje_state WHERE name = ?', `${SNAPSHOT_STATE_PREFIX}${key}`)
		return false
	}
	db.run(
		`INSERT INTO kopje_state (name, value) VALUES (?, ?)
		ON CONFLICT (name) DO UPDATE SET value = excluded.value WHERE value <> excluded.value`,
		`${SNAPSHOT_STATE_PREFIX}${key}`,
		JSON.stringify({ contentType, body } satisfies Snapshot)
	)
	return true
})
