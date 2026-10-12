import { writeOperation } from './operation'
import { isStorableSnapshot, type Snapshot, SNAPSHOT_STATE_PREFIX } from '../platform/store-kernel'

// Keeps the last good response of an always-served GET (actor document, WebFinger, NodeInfo) for the rescue path,
// which the Store serves through readSnapshot while it refuses domain operations. Writes only when the body changed,
// so a steady document costs a read and no row write. A malformed key or an oversized body is not stored (false).
export const saveSnapshot = writeOperation<{ key: string } & Snapshot, boolean>((db, { key, contentType, body }) => {
	if (!isStorableSnapshot(key, body)) {
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
