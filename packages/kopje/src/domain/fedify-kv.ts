import { isEqual } from 'es-toolkit'

import { readOperation, writeOperation } from './operation'
import type { Db } from '../db/sql'

// Fedify's KvStore over the fedify_kv table. Keys are JSON arrays of strings and values are JSON text, both encoded by
// the caller (federation/kv-store.ts). A row whose expires_at is not after `now` reads as absent; expired rows are
// deleted by a later sweep. The clock comes from the caller.

export type KvEntry = { key: string; value: string }

type Row = KvEntry & { expires_at: number | null }

function live(db: Db, key: string, now: number): string | undefined {
	return db.first<Row>(
		'SELECT key, value, expires_at FROM fedify_kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)',
		key,
		now
	)?.value
}

function put(db: Db, key: string, value: string, expiresAt: number | null): void {
	db.run('INSERT OR REPLACE INTO fedify_kv (key, value, expires_at) VALUES (?, ?, ?)', key, value, expiresAt)
}

export const kvGet = readOperation<{ key: string; now: number }, string | null>(
	(db, { key, now }) => live(db, key, now) ?? null
)

export const kvSet = writeOperation<{ key: string; value: string; expiresAt: number | null }, void>(
	(db, { key, value, expiresAt }) => put(db, key, value, expiresAt)
)

export const kvDelete = writeOperation<{ key: string }, void>((db, { key }) => {
	db.run('DELETE FROM fedify_kv WHERE key = ?', key)
})

// Compare-and-swap. expected and value are JSON text, or null for "absent"; a null value deletes the key.
export const kvCas = writeOperation<
	{ key: string; expected: string | null; value: string | null; expiresAt: number | null; now: number },
	boolean
>((db, { key, expected, value, expiresAt, now }) => {
	// Values compare as Fedify's MemoryKvStore compares them (es-toolkit isEqual), so property order does not matter.
	const current = live(db, key, now)
	const equal =
		current === undefined || expected === null
			? current === undefined && expected === null
			: isEqual(JSON.parse(current), JSON.parse(expected))
	if (!equal) {
		return false
	}
	if (value === null) {
		db.run('DELETE FROM fedify_kv WHERE key = ?', key)
	} else {
		put(db, key, value, expiresAt)
	}
	return true
})

// Entries whose key equals the prefix or extends it. A prefix is matched as a key range, not with LIKE (keys hold URLs
// longer than LIKE's 50-byte pattern limit): the children of '["a","b"]' are exactly the keys in ['["a","b",',
// '["a","b"-'), since ',' + 1 is '-' and keys compare as bytes. A null prefix lists everything.
export const kvList = readOperation<{ prefix: string | null; now: number }, KvEntry[]>((db, { prefix, now }) => {
	const select = 'SELECT key, value FROM fedify_kv WHERE (expires_at IS NULL OR expires_at > ?)'
	if (prefix === null) {
		return db.all<KvEntry>(`${select} ORDER BY key`, now)
	}
	const open = prefix.slice(0, -1)
	return db.all<KvEntry>(
		`${select} AND (key = ? OR (key >= ? AND key < ?)) ORDER BY key`,
		now,
		prefix,
		`${open},`,
		`${open}-`
	)
})
