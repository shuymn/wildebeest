import { localActorOf, nodeInfoUsageOf, readInstanceKey } from './actors'
import { writeOperation } from './operation'
import type { Db } from '../db/sql'
import {
	isSnapshotKey,
	isStorableSnapshot,
	type StoredSnapshot,
	type Snapshot,
	SNAPSHOT_STATE_PREFIX,
} from '../platform/store-kernel'

// What a snapshot body was rendered from, as the Worker read it from the Store: the local actor (actor documents and
// WebFinger), the instance actor's public key, the NodeInfo usage at a given time, or nothing but the fixed domain.
export type SnapshotSource =
	| { kind: 'actor'; username: string; rendered: string }
	| { kind: 'instance-actor'; rendered: string }
	| { kind: 'nodeinfo'; now: number; rendered: string }
	| { kind: 'static' }

// The source as the Store holds it now, in the form the Worker renders it from (JSON of the same read).
function currentSource(db: Db, source: SnapshotSource): string | null {
	switch (source.kind) {
		case 'actor':
			return JSON.stringify(localActorOf(db, source.username))
		case 'instance-actor':
			return readInstanceKey(db)?.pubkey ?? null
		case 'nodeinfo':
			return JSON.stringify(nodeInfoUsageOf(db, source.now))
		case 'static':
			return null
	}
}

// Keeps the last good response of an always-served GET (actor document, WebFinger, NodeInfo) for the rescue path,
// which the Store serves through readSnapshot while it refuses domain operations. Writes only when the body changed,
// so a steady document costs a read and no row write.
//
// A body is kept only if its source still matches the Store in this transaction. Saves run in the background and may
// arrive late, from any isolate; a document rendered before a key rotation or a profile edit is thereby refused
// instead of replacing the newer one (false).
//
// A matching source is not enough where the answer also depends on time: a NodeInfo rendered earlier can recompute
// the same from its own `now` after a post has aged out of the active window. So each key also keeps the render time
// of what it holds (renderedAt, the Worker's clock when it rendered), and an older render is refused. This applies to
// every key, which keeps the rule uniform.
//
// A malformed key or an oversized body is not stored (false); an oversized body of a current source also replaces the
// kept snapshot of its key with an empty one, so the rescue path answers 503 instead of an outdated document while
// the render time stays.
export const saveSnapshot = writeOperation<
	{ key: string; source: SnapshotSource; renderedAt: number } & Snapshot,
	boolean
>((db, { key, contentType, body, source, renderedAt }) => {
	if (!isSnapshotKey(key)) {
		return false
	}
	if (source.kind !== 'static' && currentSource(db, source) !== source.rendered) {
		return false
	}
	const name = `${SNAPSHOT_STATE_PREFIX}${key}`
	const kept = db.first<{ value: string }>('SELECT value FROM kopje_state WHERE name = ?', name)
	if (kept !== undefined && ((JSON.parse(kept.value) as Partial<StoredSnapshot>).renderedAt ?? 0) > renderedAt) {
		return false
	}
	const stored: StoredSnapshot = isStorableSnapshot(key, body) ? { contentType, body, renderedAt } : { renderedAt }
	db.run(
		`INSERT INTO kopje_state (name, value) VALUES (?, ?)
			ON CONFLICT (name) DO UPDATE SET value = excluded.value WHERE value <> excluded.value`,
		name,
		JSON.stringify(stored)
	)
	return 'body' in stored
})
