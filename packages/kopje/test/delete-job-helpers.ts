import { expect } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { writtenBy } from './inbox-store-helpers'
import { deleteStatusBatch, PURGE_BATCH } from '../src/domain/inbox'
import type { StoreStub } from '../src/platform/store-client'

// The status-delete job of a local status or boost (inbox.ts deleteStatusBatch), driven a batch at a time, and what
// its retraction reaches: shared by test/local-delete.test.ts and test/unboost.test.ts.

// One batch of the job of `statusId` in its own transaction, with the rows it wrote.
export async function batch(store: StoreStub, statusId: string): Promise<{ wrote: number; more: boolean }> {
	const { result, rows } = await writtenBy(store, (db) => deleteStatusBatch(db, statusId, NOW))
	return { wrote: rows, more: result }
}

// Every batch of the job, each within PURGE_BATCH; how many it took. `between` runs after each batch that left more.
export async function batches(
	store: StoreStub,
	statusId: string,
	between?: (n: number) => Promise<void>
): Promise<number> {
	for (let n = 1; n <= 1000; n++) {
		const { wrote, more } = await batch(store, statusId)
		expect(wrote, `batch ${n}`).toBeLessThanOrEqual(PURGE_BATCH)
		if (!more) {
			return n
		}
		await between?.(n)
	}
	throw new Error('the job did not end')
}

// `n` remote accounts on hosts `<prefix><i>.example`, ids `<digit>` and 17 digits, each with a personal inbox and a
// shared one.
export async function remoteAccountsAt(store: StoreStub, digit: string, prefix: string, n: number): Promise<string[]> {
	await sql(
		store,
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO accounts (id, uri, username, domain, inbox_url, shared_inbox_url)
		SELECT ?2 || printf('%017d', i), 'https://' || ?3 || i || '.example/users/u', 'u', ?3 || i || '.example',
			'https://' || ?3 || i || '.example/users/u/inbox', 'https://' || ?3 || i || '.example/inbox' FROM n`,
		n,
		digit,
		prefix
	)
	return Array.from({ length: n }, (_, i) => `${digit}${String(i + 1).padStart(17, '0')}`)
}

// The inboxes the activities of `type` (a `Delete`, an `Undo`) about `uri` go to: their rows and their targets not
// expanded yet.
export async function retractionInboxes(store: StoreStub, uri: string, type: 'Delete' | 'Undo'): Promise<Set<string>> {
	const rows = await sql<{ inbox: string }>(
		store,
		`SELECT d.inbox_url AS inbox FROM outbound_activities o JOIN deliveries d ON d.activity_id = o.id
		WHERE o.object_uri = ?1 AND json_extract(o.body, '$.activity.type') = ?2
		UNION SELECT json_extract(t.value, '$.inbox') FROM outbound_activities o
			JOIN outbound_targets c ON c.activity_id = o.id, json_each(c.targets) t
		WHERE o.object_uri = ?1 AND json_extract(o.body, '$.activity.type') = ?2 AND t.key >= c.next`,
		uri,
		type
	)
	return new Set(rows.map((row) => row.inbox))
}

// `count` retractions of `object` by `signer` still staging, each with its staging (retraction_stagings) and no row, as
// only an import holds them: superseding one writes three rows (outbound_activities_staging_ended).
export async function seedStagingRetractions(
	store: StoreStub,
	count: number,
	signer: string,
	object: string,
	type: 'Delete' | 'Undo'
): Promise<void> {
	await sql(
		store,
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO outbound_activities (account_id, body, object_uri, retracts, staged, created_at)
		SELECT ?2, json_object('activity', json_object('type', ?4, 'id', 'x' || i), 'audience',
			json_object('followers', json('true'), 'accounts', json('[]'))), ?3, 1, '', 0 FROM n`,
		count,
		signer,
		object,
		type
	)
	await sql(
		store,
		`INSERT INTO retraction_stagings (activity_id, follow_bound, phase)
		SELECT id, 0, 'followers' FROM outbound_activities WHERE object_uri = ? AND retracts = 1 AND staged = ''`,
		object
	)
	await sql(
		store,
		`UPDATE outbound_activities SET staged = (SELECT CAST(h.id AS TEXT) FROM retraction_stagings h
			WHERE h.activity_id = outbound_activities.id) WHERE object_uri = ? AND retracts = 1 AND staged = ''`,
		object
	)
}
