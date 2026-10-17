import { runInDurableObject } from 'cloudflare:test'

import { expect, inject, it } from 'vitest'

import { MIGRATIONS } from '../../src/db/migrations'
import { freshStore, testKernel } from '../helpers'

// The migration cost benchmark (design: "Migrations", acceptance criterion): one migration file applied to a large,
// representative Store, in the SQLite the Store runs on (workerd's local Durable Object runtime), timed. A file must
// finish in at most MIGRATION_BUDGET_MS, a sixth of the 30 seconds a migration transaction may take, before its PR
// merges; the time goes in the file's header comment and in the PR description. The owner's instance is not
// representative and does not count.
//
//   pnpm --filter kopje bench:migration                            the newest migration
//   KOPJE_BENCH_MIGRATION=0029_admin_reports pnpm --filter kopje bench:migration
//   KOPJE_BENCH_SCALE=0.01 pnpm --filter kopje bench:migration     a quick check of the script itself (not a measure)
//
// The Store is migrated up to the file before the one measured, then seeded with SQL of the current schema, in this
// file's shape (scaled by KOPJE_BENCH_SCALE):
//   - 1,000,000 accounts: 20 local accounts (with their local_accounts rows), the rest remote over 1,000 domains;
//   - 3,000,000 accepted follows, three per account, among all accounts;
//   - 2,000,000 statuses, two per remote account in turn, each with a mention of another account and a hashtag (one
//     of 1,000 names);
//   - 2,000,000 notifications of the local accounts in turn, a mention by each status's author;
//   - 10,000 reports by the local accounts of remote accounts, naming one status each;
//   - 200,000 quotes (from migration 0033_quotes on), one by every tenth status, each of the status after it, in each
//     stored state in turn (a quarter accepted).
// It grows every table a phase A migration reads (accounts, follows, statuses with their mentions and tags,
// notifications, reports, quotes); a migration that reads another table must add it here before it is measured. The
// measured time is the file's transaction as the kernel applies it, from before the first statement to after the commit: Date.now() in
// workerd moves only between I/O events, so the clock is read across an await on each side.

export const MIGRATION_BUDGET_MS = 5_000

declare module 'vitest' {
	interface ProvidedContext {
		benchMigration: string
		benchScale: string
	}
}

const SHAPE = {
	accounts: 1_000_000,
	local: 20,
	domains: 1_000,
	follows: 3,
	statuses: 2_000_000,
	notifications: 2_000_000,
	reports: 10_000,
	quotes: 200_000,
}

it('applies the migration to the benchmark store within the budget', async () => {
	const name = inject('benchMigration') || MIGRATIONS.at(-1)!.name
	const scale = Number(inject('benchScale') || '1')
	const at = MIGRATIONS.findIndex((migration) => migration.name === name)
	expect(at, `no migration named ${name}`).toBeGreaterThan(0)
	const accounts = Math.round(SHAPE.accounts * scale)
	const statuses = Math.round(SHAPE.statuses * scale)
	const notifications = Math.min(Math.round(SHAPE.notifications * scale), statuses)
	const reports = Math.round(SHAPE.reports * scale)
	const quotes = Math.min(Math.round(SHAPE.quotes * scale), Math.floor(statuses / 10))

	const store = freshStore()
	// One call: between calls, the Store's own alarm would apply every migration.
	const { seeded, measured } = await runInDurableObject(store, async (_instance, state) => {
		await state.storage.deleteAlarm()
		expect(await testKernel(state, MIGRATIONS.slice(0, at)).upgrade()).toMatchObject({ ok: true })
		const sql = state.storage.sql
		// Numbers are bound as REAL by workerd, which SQLite's % keeps REAL: every number is cast to an integer first.
		const run = (query: string, ...params: SqlStorageValue[]) =>
			state.storage.transactionSync(() =>
				sql
					.exec(
						query.replace(/\?(\d)/g, (_, n: string) =>
							typeof params[Number(n) - 1] === 'number' ? `CAST(?${n} AS INTEGER)` : `?${n}`
						),
						...params
					)
					.toArray()
			)
		const now = '2026-10-01T00:00:00.000Z'
		// Account i has the id 100000000000000000 + i; the first SHAPE.local are local.
		run(
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO accounts (id, uri, username, domain, display_name, inbox_url, shared_inbox_url, created_at)
			SELECT CAST(100000000000000000 + i AS TEXT),
				CASE WHEN i < ?2 THEN 'https://kopje.bench/ap/users/l' || i ELSE 'https://d' || (i % ?3) || '.bench/users/u' || i END,
				CASE WHEN i < ?2 THEN 'l' || i ELSE 'u' || i END,
				CASE WHEN i < ?2 THEN NULL ELSE 'd' || (i % ?3) || '.bench' END,
				'Account ' || i,
				CASE WHEN i < ?2 THEN NULL ELSE 'https://d' || (i % ?3) || '.bench/users/u' || i || '/inbox' END,
				CASE WHEN i < ?2 THEN NULL ELSE 'https://d' || (i % ?3) || '.bench/inbox' END,
				?4
			FROM n`,
			accounts,
			SHAPE.local,
			SHAPE.domains,
			now
		)
		run(
			`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
			SELECT id, username || '@kopje.bench', X'00', X'00', 'k' FROM accounts WHERE domain IS NULL`
		)
		// Follows: account i follows i + 1, i + 2 and i + 3 (mod the accounts), each pair once.
		for (let k = 1; k <= SHAPE.follows; k++) {
			run(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO follows (account_id, target_account_id, state, created_at)
				SELECT CAST(100000000000000000 + i AS TEXT), CAST(100000000000000000 + (i + ?2) % ?1 AS TEXT), 'accepted', ?3
				FROM n`,
				accounts,
				k,
				now
			)
		}
		// Statuses of the remote accounts in turn, in batches (each a transaction), with a mention and a hashtag.
		const remote = accounts - SHAPE.local
		const batch = 250_000
		for (let start = 0; start < statuses; start += batch) {
			run(
				`WITH RECURSIVE n(i) AS (SELECT ?1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2 - 1)
				INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, created_at)
				SELECT CAST(500000000000000000 + i AS TEXT), 'https://bench.example/s/' || i,
					CAST(100000000000000000 + ?3 + i % ?4 AS TEXT), 'public', '<p>status ' || i || '</p>', ?5, ?5
				FROM n`,
				start,
				Math.min(start + batch, statuses),
				SHAPE.local,
				remote,
				now
			)
			run(
				`WITH RECURSIVE n(i) AS (SELECT ?1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2 - 1)
				INSERT INTO status_mentions (status_id, account_id, silent, requires_mention, author_id)
				SELECT CAST(500000000000000000 + i AS TEXT), CAST(100000000000000000 + (?3 + i % ?4 + 1) % ?5 AS TEXT), 0, 0,
					CAST(100000000000000000 + ?3 + i % ?4 AS TEXT)
				FROM n`,
				start,
				Math.min(start + batch, statuses),
				SHAPE.local,
				remote,
				accounts
			)
			run(
				`WITH RECURSIVE n(i) AS (SELECT ?1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2 - 1)
				INSERT INTO status_tags (status_id, name, public)
				SELECT CAST(500000000000000000 + i AS TEXT), 'tag' || (i % 1000), 1 FROM n`,
				start,
				Math.min(start + batch, statuses)
			)
		}
		// Notifications: status i mentions local account i % SHAPE.local, by its author, in batches.
		for (let start = 0; start < notifications; start += batch) {
			run(
				`WITH RECURSIVE n(i) AS (SELECT ?1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2 - 1)
				INSERT INTO notifications (account_id, type, from_account_id, status_id, created_at)
				SELECT CAST(100000000000000000 + i % ?3 AS TEXT), 'mention', CAST(100000000000000000 + ?3 + i % ?4 AS TEXT),
					CAST(500000000000000000 + i AS TEXT), ?5
				FROM n`,
				start,
				Math.min(start + batch, notifications),
				SHAPE.local,
				remote,
				now
			)
		}
		run(
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO reports (account_id, target_account_id, status_ids, uri, created_at)
			SELECT CAST(100000000000000000 + i % ?2 AS TEXT), CAST(100000000000000000 + ?2 + i % ?3 AS TEXT),
				json_array(CAST(500000000000000000 + i % ?4 AS TEXT)), 'https://kopje.bench/actor#reports/' || i, ?5
			FROM n`,
			reports,
			SHAPE.local,
			remote,
			statuses,
			now
		)
		// Quotes: status 10i quotes status 10i + 1, in the states pending, accepted, rejected and revoked in turn.
		const hasQuotes =
			sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'quotes'").toArray().length > 0
		if (hasQuotes) {
			run(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, updated_at)
				SELECT CAST(500000000000000000 + 10 * i AS TEXT), 'https://bench.example/s/' || (10 * i + 1),
					CAST(500000000000000000 + 10 * i + 1 AS TEXT), CAST(100000000000000000 + ?2 + (10 * i + 1) % ?3 AS TEXT),
					CASE i % 4 WHEN 0 THEN 'pending' WHEN 1 THEN 'accepted' WHEN 2 THEN 'rejected' ELSE 'revoked' END, ?4
				FROM n`,
				quotes,
				SHAPE.local,
				remote,
				now
			)
		}
		const count = (table: string) => sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).one().n
		const seeded = {
			accounts: count('accounts'),
			local: count('local_accounts'),
			follows: count('follows'),
			statuses: count('statuses'),
			mentions: count('status_mentions'),
			tags: count('status_tags'),
			notifications: count('notifications'),
			reports: count('reports'),
			quotes: hasQuotes ? count('quotes') : 0,
		}
		expect(sql.exec('SELECT count(*) AS n FROM kopje_migrations').one().n).toBe(at)

		// The file alone, through the kernel, as an upgrade applies it: the bookmark, the file's transaction and the
		// verification of the schema.
		await scheduler.wait(1)
		const started = Date.now()
		const result = await testKernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()
		await scheduler.wait(1)
		return { seeded, measured: { result, ms: Date.now() - started - 1 } }
	})
	expect(seeded).toMatchObject({ accounts, local: SHAPE.local, statuses, notifications, reports })
	expect(measured.result).toMatchObject({ ok: true, applied: [name] })
	console.log(JSON.stringify({ migration: name, scale, seeded, ms: measured.ms, budgetMs: MIGRATION_BUDGET_MS }))
	if (scale >= 1) {
		expect(measured.ms).toBeLessThanOrEqual(MIGRATION_BUDGET_MS)
	}
}, 3_600_000)
