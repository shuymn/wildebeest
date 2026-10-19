import { runInDurableObject } from 'cloudflare:test'

import { expect, inject, it } from 'vitest'

import { MIGRATIONS } from '../../src/db/migrations'
import { freshStore, testKernel } from '../helpers'

// The migration cost benchmark (design: "Migrations", acceptance criterion): one migration file applied to a large,
// representative Store in workerd's local Durable Object SQLite, timed. A file must finish in at most
// MIGRATION_BUDGET_MS, a third of the 30 seconds a migration transaction may take, before its PR merges; the time
// goes in the file's header comment and in the PR description. The owner's instance is not representative. On this
// store, upgrading one file in isolation costs about 6 s before the file's own work (the kernel's bookmark,
// transaction and schema verification, which an upgrade runs once after all pending files): 0042_report_action_fence,
// which does little else, measured 5,981 and 5,893 ms.
//
//   pnpm --filter kopje bench:migration                            the newest migration
//   KOPJE_BENCH_MIGRATION=0029_admin_reports pnpm --filter kopje bench:migration
//   KOPJE_BENCH_SCALE=0.01 pnpm --filter kopje bench:migration     a quick check of the script itself (not a measure)
//   KOPJE_BENCH_FROM=0040_report_notifications pnpm --filter kopje bench:migration
//                                                                  a release: every file from 0040 to the newest (or
//                                                                  to KOPJE_BENCH_MIGRATION) in one upgrade, within
//                                                                  RELEASE_BUDGET_MS. Run it before tagging, from the
//                                                                  first file the previous release did not carry.
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
//     stored state in turn (a quarter accepted);
//   - 2,000,000 favourites, one of each status in a scattered order, by remote accounts in turn, each with its Like id
//     (what 0052_favourite_likes moves: every remote favourite holding one is its worst case);
//   - 200,000 boosts on top of the statuses, public and unlisted in turn, each of a different status by another
//     remote account;
//   - 500,000 outbound activities of the local accounts in turn, each about one status, one in ten superseded (what
//     waits for delivery, and what given-up rows keep for retries);
//   - 500,000 media attachments, one of every fourth status, with a URL, a description and a meta of 75 bytes;
//   - 100,000 earlier versions (status_edits), one of every twentieth status;
//   - before 0048_stored_bounds, values past their stored bounds (RES-2), which are not scaled: 100 statuses with
//     140,000 bytes of content, 10 of them with a content warning of 400,000 U+0001; 1,000 remote accounts with a
//     display name of 3,000 characters and a 2,210-byte profile URL; 1,000 media rows with a 2,210-byte URL and a
//     description of 12,000 characters.
// It grows every table a phase A migration reads (accounts, follows, statuses with their mentions and tags,
// notifications, reports, quotes), what 0043_read_window_indexes indexes (favourites, boosts), what
// 0045_remote_suspension indexes (accounts, outbound activities), what 0048_stored_bounds rewrites (accounts,
// statuses, media attachments, earlier versions) and what 0052_favourite_likes moves (the favourites' Like ids); a
// migration that reads another table must add it here before it is measured. The measured time is the file's
// transaction as the kernel applies it, from before the first statement to after the commit: Date.now() in workerd
// moves only between I/O events, so the clock is read across an await on each side.

export const MIGRATION_BUDGET_MS = 10_000
// A release's pending files applied in one upgrade, as an instance applies them after a deploy: two thirds of the
// 30 seconds, since the verification is paid once for the whole set.
export const RELEASE_BUDGET_MS = 20_000

declare module 'vitest' {
	interface ProvidedContext {
		benchMigration: string
		benchFrom: string
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
	favourites: 2_000_000,
	boosts: 200_000,
	outbound: 500_000,
	media: 500_000,
	edits: 100_000,
	// Rows past their stored bounds (not scaled).
	longContent: 100,
	longSpoilers: 10,
	longAccounts: 1_000,
	longMedia: 1_000,
}

it('applies the migration to the benchmark store within the budget', async () => {
	const name = inject('benchMigration') || MIGRATIONS.at(-1)!.name
	const scale = Number(inject('benchScale') || '1')
	const last = MIGRATIONS.findIndex((migration) => migration.name === name)
	expect(last, `no migration named ${name}`).toBeGreaterThan(0)
	const from = inject('benchFrom') || name
	// The first file measured: the Store is migrated to the one before it, then seeded.
	const at = MIGRATIONS.findIndex((migration) => migration.name === from)
	expect(at, `no migration named ${from}`).toBeGreaterThan(0)
	expect(at, `${from} comes after ${name}`).toBeLessThanOrEqual(last)
	const applied = MIGRATIONS.slice(at, last + 1).map((migration) => migration.name)
	const budgetMs = applied.length === 1 ? MIGRATION_BUDGET_MS : RELEASE_BUDGET_MS
	const accounts = Math.round(SHAPE.accounts * scale)
	const statuses = Math.round(SHAPE.statuses * scale)
	const notifications = Math.min(Math.round(SHAPE.notifications * scale), statuses)
	const reports = Math.round(SHAPE.reports * scale)
	const quotes = Math.min(Math.round(SHAPE.quotes * scale), Math.floor(statuses / 10))
	const favourites = Math.min(Math.round(SHAPE.favourites * scale), statuses)
	const boosts = Math.min(Math.round(SHAPE.boosts * scale), Math.floor(statuses / 10))
	const outbound = Math.round(SHAPE.outbound * scale)
	const media = Math.min(Math.round(SHAPE.media * scale), Math.floor(statuses / 4))
	const edits = Math.min(Math.round(SHAPE.edits * scale), Math.floor(statuses / 20))

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
		// Favourites: favourite i is of status (7919 i) mod the statuses (7919 is prime to their number at full scale, so
		// each status once), by remote account i, in batches.
		for (let start = 0; start < favourites; start += batch) {
			run(
				`WITH RECURSIVE n(i) AS (SELECT ?1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2 - 1)
				INSERT OR IGNORE INTO favourites (account_id, status_id, uri, created_at)
				SELECT CAST(100000000000000000 + ?3 + i % ?4 AS TEXT), CAST(500000000000000000 + (7919 * i) % ?5 AS TEXT),
					'https://d' || ((?3 + i % ?4) % ?7) || '.bench/likes/' || i, ?6
				FROM n`,
				start,
				Math.min(start + batch, favourites),
				SHAPE.local,
				remote,
				statuses,
				now,
				SHAPE.domains
			)
		}
		// Boosts: boost i (ids after the statuses) is of status 10i + 3, by the remote account after its author, public
		// and unlisted in turn.
		run(
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, created_at, reblog_of_id)
			SELECT CAST(600000000000000000 + i AS TEXT), 'https://bench.example/b/' || i,
				CAST(100000000000000000 + ?2 + (10 * i + 4) % ?3 AS TEXT), CASE i % 2 WHEN 0 THEN 'public' ELSE 'unlisted' END,
				'', ?4, ?4, CAST(500000000000000000 + 10 * i + 3 AS TEXT)
			FROM n`,
			boosts,
			SHAPE.local,
			remote,
			now
		)
		// Outbound activities: activity i by local account i mod the local ones, about status i, superseded when i is a
		// multiple of ten, in batches.
		for (let start = 0; start < outbound; start += batch) {
			run(
				`WITH RECURSIVE n(i) AS (SELECT ?1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2 - 1)
				INSERT INTO outbound_activities (account_id, body, object_uri, retracts, superseded, created_at)
				SELECT CAST(100000000000000000 + i % ?3 AS TEXT), '{"activity":{"type":"Create"}}',
					'https://bench.example/s/' || i, 0, i % 10 = 0, ?4
				FROM n`,
				start,
				Math.min(start + batch, outbound),
				SHAPE.local,
				Date.parse(now)
			)
		}
		// Media: attachment i (ids after the boosts) is of status 4i, by its author.
		run(
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO media_attachments (id, account_id, status_id, type, url, description, meta)
			SELECT CAST(700000000000000000 + i AS TEXT), CAST(100000000000000000 + ?2 + (4 * i) % ?3 AS TEXT),
				CAST(500000000000000000 + 4 * i AS TEXT), 'image', 'https://files.bench.example/m/' || i || '.png',
				'Media ' || i, '{"original":{"width":1200,"height":800},"small":{"width":640,"height":427}}'
			FROM n WHERE ?1 > 0`,
			media,
			SHAPE.local,
			remote
		)
		// Earlier versions: edit i is of status 20i.
		run(
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO status_edits (status_id, content, created_at)
			SELECT CAST(500000000000000000 + 20 * i AS TEXT), '<p>status ' || (20 * i) || ', before</p>', ?2
			FROM n WHERE ?1 > 0`,
			edits,
			now
		)
		// Values past their stored bounds, on the first statuses, remote accounts and media rows: only before
		// 0048_stored_bounds, whose triggers refuse them (a store past it holds none).
		const bounded =
			sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'statuses_bounds_update'").toArray()
				.length > 0
		const filler = (n: number, char: string) => `replace(hex(zeroblob(${n / 2})), '0', ${char})`
		const pastBounds = (query: string, ...params: SqlStorageValue[]) => (bounded ? [] : run(query, ...params))
		pastBounds(
			`UPDATE statuses SET content = ${filler(140_000, "'x'")}, spoiler_text = CASE WHEN id < CAST(500000000000000000 + ?2 AS TEXT)
				THEN ${filler(400_000, 'char(1)')} ELSE '' END
			WHERE id < CAST(500000000000000000 + ?1 AS TEXT) AND id >= '500000000000000000'`,
			SHAPE.longContent,
			SHAPE.longSpoilers
		)
		pastBounds(
			`UPDATE accounts SET display_name = ${filler(3000, "'n'")},
				url = 'https://d.bench/u/' || ${filler(2192, "'x'")}
			WHERE id >= CAST(100000000000000000 + ?1 AS TEXT) AND id < CAST(100000000000000000 + ?1 + ?2 AS TEXT)`,
			SHAPE.local,
			SHAPE.longAccounts
		)
		pastBounds(
			`UPDATE media_attachments SET url = 'https://f.bench/m/' || ${filler(2192, "'x'")},
				description = ${filler(12_000, "'d'")}
			WHERE id < CAST(700000000000000000 + ?1 AS TEXT)`,
			SHAPE.longMedia
		)
		const count = (table: string) => sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).one().n
		const seeded = {
			accounts: count('accounts'),
			local: count('local_accounts'),
			follows: count('follows'),
			statuses: count('statuses WHERE reblog_of_id IS NULL'),
			boosts: count('statuses WHERE reblog_of_id IS NOT NULL'),
			favourites: count('favourites'),
			mentions: count('status_mentions'),
			tags: count('status_tags'),
			notifications: count('notifications'),
			reports: count('reports'),
			quotes: hasQuotes ? count('quotes') : 0,
			outbound: count('outbound_activities'),
			media: count('media_attachments'),
			edits: count('status_edits'),
		}
		expect(sql.exec('SELECT count(*) AS n FROM kopje_migrations').one().n).toBe(at)

		// The files, through the kernel, as an upgrade applies them: the bookmark, each file's transaction and the
		// verification of the schema.
		await scheduler.wait(1)
		const started = Date.now()
		const result = await testKernel(state, MIGRATIONS.slice(0, last + 1)).upgrade()
		await scheduler.wait(1)
		return { seeded, measured: { result, ms: Date.now() - started - 1 } }
	})
	expect(seeded).toMatchObject({ accounts, local: SHAPE.local, statuses, notifications, reports })
	expect(measured.result).toMatchObject({ ok: true, applied })
	console.log(JSON.stringify({ migrations: applied, scale, seeded, ms: measured.ms, budgetMs }))
	if (scale >= 1) {
		expect(measured.ms).toBeLessThanOrEqual(budgetMs)
	}
}, 3_600_000)
