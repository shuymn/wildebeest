import { runInDurableObject } from 'cloudflare:test'

import { expect, inject, it } from 'vitest'

import { MIGRATIONS } from '../../src/db/migrations'
import { freshStore, testKernel } from '../helpers'

// The migration cost benchmark (design: "Migrations", acceptance criterion): pending migration files applied to a
// large, representative Store in workerd's local Durable Object SQLite, as an upgrade applies them, timed. The whole
// upgrade (the kernel's bookmark, each file's transaction and the schema verification, which runs once after all
// pending files) must finish in at most UPGRADE_BUDGET_MS, two thirds of the default 30 seconds of CPU an invocation
// may use (an alarm's upgrade included; committing each file does not start a new invocation). Local elapsed time
// stands in for that CPU time.
// Measure each file before its PR merges and the complete pending range before the release branch
// merges (RELEASING.md). Record file measurements in migration headers and PR descriptions.
// Upgrade overhead grows with the representative Store and varies with competing machine load;
// the owner's instance is not representative.
//
//   pnpm --filter kopje bench:migration                            the newest migration
//   KOPJE_BENCH_MIGRATION=0029_admin_reports pnpm --filter kopje bench:migration
//   KOPJE_BENCH_SCALE=0.01 pnpm --filter kopje bench:migration     a quick check of the script itself (not a measure)
//   KOPJE_BENCH_FROM=0040_report_notifications pnpm --filter kopje bench:migration
//                                                                  a release: every file from 0040 to the newest (or
//                                                                  to KOPJE_BENCH_MIGRATION) in one upgrade. Run it
//                                                                  before tagging, from the first file the previous
//                                                                  release did not carry.
//
// The Store is migrated up to the file before the one measured, then seeded with SQL of the current schema, in this
// file's shape (scaled by KOPJE_BENCH_SCALE):
//   - 1,000,000 accounts: 20 local accounts (with their local_accounts rows), the rest remote over 1,000 domains;
//   - 3,000,000 accepted follows, three per account, among all accounts;
//   - 2,000,000 statuses, two per remote account in turn, each with a mention of another account and a hashtag (one
//     of 1,000 names);
//   - 2,000,000 notifications of the local accounts in turn, a mention by each status's author;
//   - 10,000 reports by the local accounts of remote accounts, naming one status each, and (from migration
//     0040_report_notifications on) an admin.report of each to the first local account; 1,000 pushes (MAX_PUSH_BACKLOG)
//     of those notifications, to one subscription;
//   - 10,000 moderation log rows (MODERATION_LOG_KEEP), half of them naming reports (some above the newest report),
//     the rest accounts; and the moderation jobs that name a report bound: 180 local ones (the tokens, suspension and
//     reach jobs of each local account over three generations) and (from 0045_remote_suspension on) 1,000 remote
//     account jobs with a bound, and a domain job with its fan-out of 10,000 account jobs without one;
//   - 200,000 quotes (from migration 0033_quotes on), one by every tenth status, each of the status after it, in each
//     stored state in turn (a quarter accepted);
//   - 2,000,000 favourites, one of each status in a scattered order, by remote accounts in turn, each with its Like id;
//   - 200,000 boosts on top of the statuses, public and unlisted in turn, each of a different status by another
//     remote account;
//   - 500,000 outbound activities of the local accounts in turn, each about one status, one in ten superseded (what
//     waits for delivery, and what given-up rows keep for retries);
//   - 50,000 follow answers of the local accounts in turn (Accept and Reject alternately, as followAnswerActivity
//     builds them), each of a remote account's Follow;
//   - a delivery row of every outbound activity, the retained history: the first 10,000 (the backlog cap) active,
//     the rest given up;
//   - 500,000 media attachments, one of every fourth status, with a URL, a description and a meta of 75 bytes;
//   - 100,000 earlier versions (status_edits), one of every twentieth status;
//   - 100,000 instance domain blocks (from migration 0046_instance_domain_blocks on), one in ten a suspend;
//   - values past their stored bounds, which are not scaled, each set only while the migration that bounds it is
//     still to apply (its triggers refuse them after): for 0048_stored_bounds (RES-2) 100 statuses with 140,000 bytes
//     of content, 10 of them with a content warning of 400,000 U+0001, 1,000 remote accounts with a display name of
//     3,000 characters and a 2,210-byte profile URL, and 1,000 media rows with a 2,210-byte URL and a description of
//     12,000 characters; for 0049_instance_bounds one row past its bound of each covered instance setting (a 2,000
//     code point title and description, a 300-byte contact address, 70,000 bytes of rules, three 60,000-byte
//     documents, a malformed date, switch and two stamps).
// It grows every table a phase A migration reads (accounts, follows, statuses with their mentions and tags,
// notifications, reports, quotes), what 0043_read_window_indexes indexes (favourites, boosts), what
// 0045_remote_suspension indexes (accounts, outbound activities), what 0048_stored_bounds rewrites (accounts,
// statuses, media attachments, earlier versions), what 0049_instance_bounds rewrites and indexes (instance
// settings, instance domain blocks), what 0051_follow_answer_pairs reads and rewrites (outbound activities,
// accounts, deliveries), what 0052_favourite_likes indexes (the favourites' Like ids), what 0053_custom_emoji_snapshots
// alters (accounts, statuses, earlier versions) and what 0054_remote_reports reads and rewrites (reports, their
// notifications and pushes, the moderation log and both job tables); 0055_local_custom_emojis reads no row (it adds an
// empty table); a migration that reads another table must add it here before it is measured.
// The measured time is the whole upgrade, from before the bookmark to after the verification: Date.now() in workerd
// moves only between I/O events, so the clock is read across an await on each side.

export const UPGRADE_BUDGET_MS = 20_000

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
	pushes: 1_000,
	moderationLog: 10_000,
	remoteJobs: 1_000,
	domainFanOut: 10_000,
	quotes: 200_000,
	favourites: 2_000_000,
	boosts: 200_000,
	outbound: 500_000,
	followAnswers: 50_000,
	active: 10_000,
	media: 500_000,
	edits: 100_000,
	instanceBlocks: 100_000,
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
	const budgetMs = UPGRADE_BUDGET_MS
	const accounts = Math.round(SHAPE.accounts * scale)
	const statuses = Math.round(SHAPE.statuses * scale)
	const notifications = Math.min(Math.round(SHAPE.notifications * scale), statuses)
	const reports = Math.round(SHAPE.reports * scale)
	const quotes = Math.min(Math.round(SHAPE.quotes * scale), Math.floor(statuses / 10))
	const favourites = Math.min(Math.round(SHAPE.favourites * scale), statuses)
	const boosts = Math.min(Math.round(SHAPE.boosts * scale), Math.floor(statuses / 10))
	const outbound = Math.round(SHAPE.outbound * scale)
	const followAnswers = Math.round(SHAPE.followAnswers * scale)
	const media = Math.min(Math.round(SHAPE.media * scale), Math.floor(statuses / 4))
	const edits = Math.min(Math.round(SHAPE.edits * scale), Math.floor(statuses / 20))
	const instanceBlocks = Math.round(SHAPE.instanceBlocks * scale)

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
		// The reports' admin.report notifications, to the first local account, with MAX_PUSH_BACKLOG pushes of them.
		const has = (table: string, column?: string) =>
			sql
				.exec(
					column === undefined
						? "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
						: 'SELECT 1 FROM pragma_table_info(?) WHERE name = ?',
					...(column === undefined ? [table] : [table, column])
				)
				.toArray().length > 0
		const hasReportNotifications = has('notifications', 'report_id')
		if (hasReportNotifications) {
			run(
				`INSERT INTO notifications (account_id, type, from_account_id, report_id, created_at)
				SELECT '100000000000000000', 'admin.report', account_id, id, ?1 FROM reports`,
				now
			)
			run(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris) VALUES ('bench', 's', 'bench', 'urn:ietf:wg:oauth:2.0:oob')"
			)
			run(
				`INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes)
				VALUES ('bench', 'access', 'bench', '100000000000000000', 'push')`
			)
			run(
				`INSERT INTO push_subscriptions (token_hash, endpoint, key_p256dh, key_auth)
				VALUES ('bench', 'https://push.bench/1', 'p', 'a')`
			)
			run(
				`INSERT INTO push_deliveries (subscription_id, notification_id, next_attempt_at, updated_at)
				SELECT (SELECT id FROM push_subscriptions), id, 0, 0 FROM notifications WHERE report_id IS NOT NULL
				ORDER BY id LIMIT ?1`,
				Math.round(SHAPE.pushes * scale)
			)
		}
		// The moderation log: row i names report i (past the newest report for the last tenth) when i is even, else an
		// account.
		const moderationLog = has('admin_actions') ? Math.round(SHAPE.moderationLog * scale) : 0
		if (moderationLog > 0) {
			run(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO admin_actions (actor, action, target_type, target_id, created_at)
			SELECT 'access', CASE i % 2 WHEN 0 THEN 'resolve' ELSE 'suspend' END,
				CASE i % 2 WHEN 0 THEN 'Report' ELSE 'Account' END,
				CASE i % 2 WHEN 0 THEN CAST(CASE WHEN i > ?1 * 9 / 10 THEN ?2 + i ELSE i % ?2 + 1 END AS TEXT)
					ELSE CAST(100000000000000000 + i AS TEXT) END, ?3
			FROM n`,
				moderationLog,
				reports,
				now
			)
		}
		// Local jobs: each local account's tokens, suspension and reach jobs in three generations, with a report bound.
		const hasLocalJobs = has('moderation_jobs')
		if (hasLocalJobs) {
			run(
				`INSERT INTO moderation_jobs (kind, account_id, generation, report_bound, phase)
			SELECT k.value, l.account_id, g.value, ?1, 'reports'
			FROM local_accounts l CROSS JOIN json_each('["tokens","suspension","reach"]') k
				CROSS JOIN json_each('[1,2,3]') g`,
				reports
			)
		}
		const hasRemoteJobs = has('remote_moderation_jobs')
		const remoteJobs = Math.min(Math.round(SHAPE.remoteJobs * scale), accounts - SHAPE.local)
		const domainFanOut = Math.min(Math.round(SHAPE.domainFanOut * scale), accounts - SHAPE.local - remoteJobs)
		if (hasRemoteJobs) {
			// Remote jobs: account jobs of the first remote accounts with a bound, then the domain job's fan-out (mode
			// domain, no bound) over the next ones.
			run(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 + ?2 - 1)
				INSERT INTO remote_moderation_jobs (kind, subject, mode, follow_bound, report_bound, phase)
				SELECT 'account', CAST(100000000000000000 + ?3 + i AS TEXT), CASE WHEN i < ?1 THEN 'account' ELSE 'domain' END,
					0, CASE WHEN i < ?1 THEN ?4 END, 'out'
				FROM n WHERE ?1 + ?2 > 0`,
				remoteJobs,
				domainFanOut,
				SHAPE.local,
				reports
			)
			run(
				`INSERT OR IGNORE INTO remote_moderation_jobs (kind, subject, mode, follow_bound, phase)
				VALUES ('domain', '', 'domain', 0, 'clear')`
			)
		}
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
		// Follow answers: answer i by local account i mod the local ones, of remote account i's Follow, Accept and
		// Reject in turn.
		run(
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1),
			a(i, local, follower, follow) AS (SELECT i, 'https://kopje.bench/ap/users/l' || (i % ?2),
				'https://d' || ((?2 + i) % ?3) || '.bench/users/u' || (?2 + i),
				'https://d' || ((?2 + i) % ?3) || '.bench/users/u' || (?2 + i) || '#follows/' || i FROM n)
			INSERT INTO outbound_activities (account_id, body, object_uri, retracts, superseded, created_at)
			SELECT CAST(100000000000000000 + i % ?2 AS TEXT),
				json_object('activity', json_object('@context', 'https://www.w3.org/ns/activitystreams',
					'id', local || CASE i % 2 WHEN 0 THEN '#accepts' ELSE '#rejects' END || '/follows/' || hex(randomblob(32)),
					'type', CASE i % 2 WHEN 0 THEN 'Accept' ELSE 'Reject' END, 'actor', local,
					'object', json_object('id', follow, 'type', 'Follow', 'actor', follower, 'object', local)),
					'audience', json_object('followers', json('false'), 'accounts',
						json_array(CAST(100000000000000000 + ?2 + i AS TEXT)))),
				follow, i % 2, 0, ?4
			FROM a`,
			followAnswers,
			SHAPE.local,
			SHAPE.domains,
			Date.parse(now)
		)
		// Deliveries: a row of each outbound activity, to one of the 1,000 servers; the first SHAPE.active waiting, the
		// rest given up.
		for (let start = 0; start < outbound + followAnswers; start += batch) {
			run(
				`INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, attempts, next_attempt_at,
					last_status, last_error, updated_at)
				SELECT id, account_id, 'https://d' || (id % ?3) || '.bench/inbox', 'https://d' || (id % ?3) || '.bench',
					CASE WHEN id <= ?4 THEN 'queued' ELSE 'gave_up' END, CASE WHEN id <= ?4 THEN 0 ELSE 15 END, ?5,
					CASE WHEN id <= ?4 THEN NULL ELSE 503 END, CASE WHEN id <= ?4 THEN NULL ELSE 'HTTP 503' END, ?5
				FROM outbound_activities WHERE id > ?1 AND id <= ?2`,
				start,
				start + batch,
				SHAPE.domains,
				SHAPE.active,
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
		// Instance domain blocks: block i of b<i>.bench, a suspend when i is a multiple of ten.
		const hasInstanceBlocks =
			sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'instance_domain_blocks'").toArray()
				.length > 0
		if (hasInstanceBlocks) {
			run(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO instance_domain_blocks (domain, severity, public_comment, created_at, updated_at)
				SELECT 'b' || i || '.bench', CASE WHEN i % 10 = 0 THEN 'suspend' ELSE 'noop' END, 'Block ' || i, ?2, ?2
				FROM n WHERE ?1 > 0`,
				instanceBlocks,
				now
			)
		}
		// Values past their stored bounds, set while the migration that bounds them is still to apply.
		const pending = (migration: string) => at <= MIGRATIONS.findIndex((m) => m.name === migration)
		const filler = (n: number, char: string) => `replace(hex(zeroblob(${n / 2})), '0', ${char})`
		if (pending('0049_instance_bounds')) {
			run(
				`INSERT OR REPLACE INTO instance_settings (name, value) VALUES
					('title', ${filler(2000, "'t'")}), ('description', ${filler(2000, "'d'")}),
					('contact_email', ${filler(300, "'e'")} || '@example.com'), ('rules', '[' || ${filler(70_000, "' '")} || ']'),
					('extended_description', ${filler(60_000, "'x'")}), ('privacy_policy', ${filler(60_000, "'p'")}),
					('terms_of_service', ${filler(60_000, "'s'")}), ('terms_of_service_effective_date', '2026-02-30'),
					('show_domain_blocks', 'everyone'), ('privacy_policy_updated_at', 'yesterday')`
			)
			run("INSERT OR REPLACE INTO instance_settings (name, value) VALUES ('extended_description_updated_at', ' ')")
		}
		if (pending('0048_stored_bounds')) {
			run(
				`UPDATE statuses SET content = ${filler(140_000, "'x'")}, spoiler_text = CASE WHEN id < CAST(500000000000000000 + ?2 AS TEXT)
					THEN ${filler(400_000, 'char(1)')} ELSE '' END
				WHERE id < CAST(500000000000000000 + ?1 AS TEXT) AND id >= '500000000000000000'`,
				SHAPE.longContent,
				SHAPE.longSpoilers
			)
			run(
				`UPDATE accounts SET display_name = ${filler(3000, "'n'")},
					url = 'https://d.bench/u/' || ${filler(2192, "'x'")}
				WHERE id >= CAST(100000000000000000 + ?1 AS TEXT) AND id < CAST(100000000000000000 + ?1 + ?2 AS TEXT)`,
				SHAPE.local,
				SHAPE.longAccounts
			)
			run(
				`UPDATE media_attachments SET url = 'https://f.bench/m/' || ${filler(2192, "'x'")},
					description = ${filler(12_000, "'d'")}
				WHERE id < CAST(700000000000000000 + ?1 AS TEXT)`,
				SHAPE.longMedia
			)
		}
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
			notifications: count("notifications WHERE type <> 'admin.report'"),
			reports: count('reports'),
			reportNotifications: hasReportNotifications ? count('notifications WHERE report_id IS NOT NULL') : 0,
			pushes: count('push_deliveries'),
			moderationLog: moderationLog > 0 ? count('admin_actions') : 0,
			localJobs: hasLocalJobs ? count('moderation_jobs') : 0,
			remoteJobs: hasRemoteJobs ? count('remote_moderation_jobs') : 0,
			quotes: hasQuotes ? count('quotes') : 0,
			outbound: count('outbound_activities'),
			deliveries: count('deliveries'),
			media: count('media_attachments'),
			edits: count('status_edits'),
			instanceBlocks: hasInstanceBlocks ? count('instance_domain_blocks') : 0,
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
