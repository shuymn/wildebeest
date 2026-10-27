import { runInDurableObject } from 'cloudflare:test'

import { expect, inject, it } from 'vitest'

import { MIGRATIONS } from '../../src/db/migrations'
import { MAX_FEATURED_TAGS } from '../../src/domain/featured-tags'
import { JOURNAL_SPAN } from '../../src/domain/streaming'
import { BUILD, freshStore, testKernel } from '../helpers'

// The migration cost benchmark (design: "Migrations", acceptance criterion): pending migration files applied to a
// large, representative Store in workerd's local Durable Object SQLite, as an upgrade applies them, timed. The whole
// upgrade (the kernel's bookmark, each file's transaction and the schema verification, which runs once after all
// pending files) must finish in at most UPGRADE_BUDGET_MS, two thirds of the default 30 seconds of CPU an invocation
// may use (an alarm's upgrade included; committing each file does not start a new invocation). Local elapsed time
// stands in for that CPU time.
// The verification checks every reference in the Store unless each file is declared foreignKeys: 'unchanged'
// (src/db/migrations.ts); the output's foreignKeyCheck says which ('store' or 'skipped'). A marker-bearing retry of
// the same files always checks the whole Store. retryEstimateMs estimates it: for a skipped check, the upgrade plus
// a timed marker-bearing retry run after it (which verifies only, the files being applied); otherwise the upgrade
// itself. It is reported, not judged: a real retry applies only the files left, so the estimate overstates it. An
// estimate past the budget is not fixed by dropping a declaration, which adds the same check to the upgrade.
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
//     of 1,000 names), every other one a reply to the one before it;
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
//   - 200,000 attached status cards (from migration 0067_status_cards on), one of every tenth status, and 10,000
//     pending ones of the statuses after the first 10,000 of those;
//   - 100,000 featured hashtags (from migration 0025_remote_collections on), MAX_FEATURED_TAGS of each of the first
//     10,000 accounts;
//   - 10,000 inbound jobs, status deletions of the first statuses, every other one finished;
//   - the other job families' rows: 10,000 stamp revocations (from 0033_quotes on), every other one done, by the
//     remote accounts in turn; 1,000 domain blocks of the local accounts in turn, each with its cleanup; 1,000
//     notification request jobs of the local accounts in turn, each from another remote account; a clear of each
//     local account's notifications; 1,000 dismissed groups of the local accounts in turn; and the values earlier builds
//     stored through JavaScript numbers (from 0083_family_job_attempts, which normalizes them): half the request jobs'
//     cursors a REAL, the local reach jobs at a numeric followers cursor, the suspension jobs' REAL bounds, and the
//     domain fan-out's account jobs severing from 'accepted N';
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
// empty table); 0056_announcements copies the streaming journal, so from it on the journal is full: 4,097 rows, the
// largest span its triggers leave (JOURNAL_SPAN, domain/streaming.ts); 0057_trends reads no row (it adds five empty
// tables and two triggers); 0062_account_warnings and 0063_account_warning_notifications_key each index the
// notifications (the table 0062 adds is empty); 0067_status_cards and 0068_remote_field_verification read no row (each
// adds an empty table); 0069_card_embeds adds columns to status_cards and recreates its triggers (no row read, the
// rows seeded so that a rewrite would show) and adds an empty table; 0070_card_images does the same, its attached
// cards seeded with 0069's columns, and indexes status_cards' image link (card_images starts empty); 0071_link_trends
// adds columns to status_cards and recreates its triggers (no row read), indexes the public cards (status_cards) and
// the public boosts (statuses, its 200,000 boosts among them) and adds three empty tables; 0076_field_link_checks
// reads no row (it adds a column of local_accounts and two triggers); 0078_featured_tags_order indexes featured_tags;
// 0079_filter_text_units reads no row (a column of statuses and three triggers); 0080_inbound_job_attempts adds two
// checked columns to inbound_jobs and indexes it; 0082_public_replies indexes the statuses' public and unlisted
// replies (1,000,000 of them); 0083_family_job_attempts adds the same columns to the other job tables and indexes them.
// A migration that reads another table must add it here before it is measured.
// The measured time is the whole upgrade, from before the bookmark to after the verification: Date.now() in workerd
// moves only between I/O events, so the clock is read across an await on each side.

export const UPGRADE_BUDGET_MS = 20_000

declare module 'vitest' {
	interface ProvidedContext {
		benchMigration: string
		benchFrom: string
		benchScale: string
		benchReportOnly: boolean
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
	cards: 200_000,
	pendingCards: 10_000,
	featuredTags: 100_000,
	inboundJobs: 10_000,
	revocations: 10_000,
	familyJobs: 1_000,
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
	const cards = Math.min(Math.round(SHAPE.cards * scale), Math.floor(statuses / 10))
	const pendingCards = Math.min(Math.round(SHAPE.pendingCards * scale), cards)
	const featuredTags = Math.min(Math.round(SHAPE.featuredTags * scale), accounts * MAX_FEATURED_TAGS)
	const inboundJobs = Math.min(Math.round(SHAPE.inboundJobs * scale), statuses)
	const revocations = Math.round(SHAPE.revocations * scale)
	const familyJobs = Math.min(Math.round(SHAPE.familyJobs * scale), accounts - SHAPE.local)

	const store = freshStore()
	// One call: between calls, the Store's own alarm would apply every migration.
	const { seeded, measured } = await runInDurableObject(store, async (_instance, state) => {
		await state.storage.deleteAlarm()
		expect(await testKernel(state, MIGRATIONS.slice(0, at)).upgrade()).toMatchObject({ ok: true })
		// A kernel that finds work unfinished sets an alarm for now unless one is set, and the Store's own alarm then runs
		// in any yield of this call: it would apply the files, or verify the retry's marker, untimed. One an hour off
		// keeps it from running here.
		await state.storage.setAlarm(Date.now() + 3_600_000)
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
				INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, created_at, in_reply_to_uri,
					in_reply_to_id)
				SELECT CAST(500000000000000000 + i AS TEXT), 'https://bench.example/s/' || i,
					CAST(100000000000000000 + ?3 + i % ?4 AS TEXT), 'public', '<p>status ' || i || '</p>', ?5, ?5,
					CASE WHEN i % 2 = 1 THEN 'https://bench.example/s/' || (i - 1) END,
					CASE WHEN i % 2 = 1 THEN CAST(500000000000000000 + i - 1 AS TEXT) END
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
		// Status cards: attached card i on status 10i, pending card i on status 10i + 5.
		const hasCards =
			sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'status_cards'").toArray().length > 0
		if (hasCards) {
			run(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO status_cards (status_id, url, enqueued_at, generation, title, description, provider_name, fetched_at)
				SELECT CAST(500000000000000000 + 10 * i AS TEXT), 'https://c' || (i % 1000) || '.bench/p/' || i, 1, 1,
					'Card ' || i, 'About card ' || i, 'Site ' || (i % 1000), 1
				FROM n WHERE ?1 > 0`,
				cards
			)
			run(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO status_cards (status_id, url, due_at, enqueued_at, generation)
				SELECT CAST(500000000000000000 + 10 * i + 5 AS TEXT), 'https://c' || (i % 1000) || '.bench/q/' || i, 1, 1, 1
				FROM n WHERE ?1 > 0`,
				pendingCards
			)
			// From 0069_card_embeds on, the attached cards hold its columns: every tenth a video with its iframe, the
			// others links of 640 by 360.
			const hasEmbeds =
				sql.exec("SELECT 1 FROM pragma_table_info('status_cards') WHERE name = 'card_type'").toArray().length > 0
			if (hasEmbeds) {
				run(
					`UPDATE status_cards SET width = 640, height = 360,
						card_type = CASE WHEN substr(status_id, -2, 1) = '0' THEN 2 ELSE 0 END,
						embed_src = CASE WHEN substr(status_id, -2, 1) = '0' THEN 'https://v.bench/e/' || status_id ELSE '' END,
						iframe_width = CASE WHEN substr(status_id, -2, 1) = '0' THEN 560 END,
						iframe_height = CASE WHEN substr(status_id, -2, 1) = '0' THEN 315 END
					WHERE fetched_at IS NOT NULL`
				)
			}
		}
		// Featured hashtags (from 0025_remote_collections on, when featured_tags names any account): MAX_FEATURED_TAGS of
		// each account in turn from the first, local and remote, each named in its own order.
		const hasFeatured = at > MIGRATIONS.findIndex((m) => m.name === '0025_remote_collections')
		if (hasFeatured) {
			run(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO featured_tags (id, account_id, name, display_name, statuses_count, last_status_at)
				SELECT CAST(800000000000000000 + i AS TEXT), CAST(100000000000000000 + i / ?2 AS TEXT), 't' || (i % ?2),
					'T' || (i % ?2), i % 100, '2026-01-01T00:00:00.000Z'
				FROM n WHERE ?1 > 0`,
				featuredTags,
				MAX_FEATURED_TAGS
			)
		}
		// Inbound jobs: the deletion of status i, by its author, every other one done (kept JOB_RETENTION_MS).
		run(
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO inbound_jobs (kind, key, actor_uri, done_at, expires_at, created_at)
			SELECT 'delete', CAST(500000000000000000 + i AS TEXT), 'https://d' || (i % ?2) || '.bench/u/' || i,
				CASE WHEN i % 2 = 1 THEN ?3 END, CASE WHEN i % 2 = 1 THEN ?3 + 2592000000 END, ?3
			FROM n WHERE ?1 > 0`,
			inboundJobs,
			SHAPE.domains,
			Date.parse(now)
		)
		// The other job families (0083_family_job_attempts): stamp revocations, every other one done; local accounts'
		// domain blocks with their cleanups, notification request jobs from remote accounts, clears and dismissals.
		if (has('quote_revocations')) {
			run(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO quote_revocations (authorization, actor_uri, revoked_at, pending)
				SELECT 'https://d' || (i % ?2) || '.bench/stamps/' || i, 'https://d' || (i % ?2) || '.bench/users/u' || i,
					?3 + i, 1 - i % 2
				FROM n WHERE ?1 > 0`,
				revocations,
				SHAPE.domains,
				Date.parse(now)
			)
		}
		if (has('notification_dismissals')) {
			run(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO domain_blocks (account_id, domain, created_at)
				SELECT CAST(100000000000000000 + i % ?2 AS TEXT), 'b' || i || '.bench', ?3 FROM n WHERE ?1 > 0`,
				familyJobs,
				SHAPE.local,
				now
			)
			run(
				`INSERT INTO domain_block_cleanups (domain_block_id, bound, created_at)
				SELECT id, ?1, ?2 FROM domain_blocks WHERE domain GLOB 'b*.bench'`,
				accounts,
				Date.parse(now)
			)
			run(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO notification_request_jobs (account_id, from_account_id, kind, cursor)
				SELECT CAST(100000000000000000 + i % ?2 AS TEXT), CAST(100000000000000000 + ?2 + i AS TEXT),
					CASE i % 2 WHEN 0 THEN 'accept' ELSE 'dismiss' END, ?3
				FROM n WHERE ?1 > 0`,
				familyJobs,
				SHAPE.local,
				notifications
			)
			run(
				'INSERT INTO notification_clears (account_id, max_id) SELECT account_id, ?1 FROM local_accounts',
				notifications
			)
			run(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO notification_dismissals (account_id, group_key, max_id)
				SELECT CAST(100000000000000000 + i % ?2 AS TEXT), 'g' || i, ?3 FROM n WHERE ?1 > 0`,
				familyJobs,
				SHAPE.local,
				notifications
			)
			// The values earlier builds wrote through JavaScript numbers, which 0083_family_job_attempts normalizes: every
			// other request job's cursor a REAL past INT64_MAX, the local reach jobs in their followers phase at a numeric
			// cursor, the suspension jobs' bound a REAL, and the domain fan-out's account jobs severing from 'accepted N'.
			run("UPDATE notification_request_jobs SET cursor = CAST('9223372036854775807' AS INTEGER) + 1 WHERE id % 2 = 0")
		}
		if (hasLocalJobs) {
			run(
				`UPDATE moderation_jobs SET phase = 'followers', state = '{"cursor":4611686018427389000}' WHERE kind = 'reach'`
			)
			run(
				"UPDATE moderation_jobs SET follow_bound = CAST('9223372036854775807' AS INTEGER) + 1 WHERE kind = 'suspension'"
			)
		}
		if (hasRemoteJobs) {
			run(
				"UPDATE remote_moderation_jobs SET phase = 'in', cursor = 'accepted 4611686018427389000' WHERE kind = 'account' AND mode = 'domain'"
			)
		}
		// A full streaming journal (ids 1 to 4,097, a span of JOURNAL_SPAN), for a range that copies it.
		const fullJournal = last >= MIGRATIONS.findIndex((m) => m.name === '0056_announcements')
		if (fullJournal) {
			run(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO stream_events (id, kind, subject, created_at)
				SELECT i, 'status', CAST(500000000000000000 + i AS TEXT), ?2 FROM n`,
				JOURNAL_SPAN + 1,
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
			cards: hasCards ? count('status_cards WHERE fetched_at IS NOT NULL') : 0,
			pendingCards: hasCards ? count('status_cards WHERE fetched_at IS NULL') : 0,
			featuredTags: hasFeatured ? count('featured_tags') : 0,
			inboundJobs: count('inbound_jobs'),
			revocations: has('quote_revocations') ? count('quote_revocations') : 0,
			familyJobs: [
				count('domain_block_cleanups'),
				count('notification_request_jobs'),
				count('notification_clears'),
				count('notification_dismissals'),
			],
			journal: fullJournal ? count('stream_events') : 0,
		}
		expect(sql.exec('SELECT count(*) AS n FROM kopje_migrations').one().n).toBe(at)

		// The files, through the kernel, as an upgrade applies them: the bookmark, each file's transaction and the
		// verification of the schema.
		// Date.now() moves only between I/O events: the clock is read across an await on each side (header).
		const timed = async <T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> => {
			await scheduler.wait(1)
			const started = Date.now()
			const value = await run()
			await scheduler.wait(1)
			return { value, ms: Date.now() - started - 1 }
		}
		const migrations = MIGRATIONS.slice(0, last + 1)
		const logs: Record<string, unknown>[] = []
		const { value: result, ms } = await timed(() =>
			testKernel(state, migrations, { log: (entry) => logs.push(entry) }).upgrade()
		)
		const foreignKeyCheck = logs.find((entry) => entry.event === 'kopje.store.upgrade.start')?.foreignKeyCheck
		if (foreignKeyCheck !== 'skipped') {
			return { seeded, measured: { result, ms, foreignKeyCheck, retryEstimateMs: ms } }
		}
		// A marker-bearing upgrade after the files: the marker written as the kernel writes it before its first file, then
		// the retry on a fresh kernel, which finds nothing pending and verifies the whole Store.
		sql.exec(
			"INSERT INTO kopje_state (name, value) VALUES ('upgrade', ?)",
			JSON.stringify({ build: BUILD, bookmark: result.bookmark, at: 0 })
		)
		const retryLogs: Record<string, unknown>[] = []
		const { value: resumed, ms: resumedMs } = await timed(() =>
			testKernel(state, migrations, { log: (entry) => retryLogs.push(entry) }).retryUpgrade(BUILD)
		)
		// It took the marker's path: the whole-Store check, and the bookmark the marker kept.
		expect(resumed).toEqual({ ok: true, bookmark: result.bookmark, applied: [] })
		expect(retryLogs).toContainEqual(
			expect.objectContaining({ event: 'kopje.store.upgrade.start', foreignKeyCheck: 'store' })
		)
		await state.storage.deleteAlarm()
		return { seeded, measured: { result, ms, foreignKeyCheck, retryEstimateMs: ms + resumedMs } }
	})
	expect(seeded).toMatchObject({ accounts, local: SHAPE.local, statuses, notifications, reports, inboundJobs })
	if (at > MIGRATIONS.findIndex((migration) => migration.name === '0067_status_cards')) {
		expect(seeded).toMatchObject({ cards, pendingCards })
	}
	if (at > MIGRATIONS.findIndex((migration) => migration.name === '0025_remote_collections')) {
		expect(seeded).toMatchObject({ featuredTags })
	}
	if (at > MIGRATIONS.findIndex((migration) => migration.name === '0033_quotes')) {
		expect(seeded).toMatchObject({ revocations })
	}
	if (at > MIGRATIONS.findIndex((migration) => migration.name === '0023_notification_clears')) {
		expect(seeded).toMatchObject({ familyJobs: [familyJobs, familyJobs, SHAPE.local, familyJobs] })
	}
	expect(measured.result).toMatchObject({ ok: true, applied })
	const { ms, foreignKeyCheck, retryEstimateMs } = measured
	console.log(JSON.stringify({ migrations: applied, scale, seeded, ms, budgetMs, foreignKeyCheck, retryEstimateMs }))
	if (scale >= 1 && foreignKeyCheck === 'skipped') {
		// The retry's whole-Store check reads every reference of the full store: a retry no slower than the upgrade
		// did not run it.
		expect(retryEstimateMs).toBeGreaterThan(ms)
	}
	// KOPJE_BENCH_REPORT_ONLY: CI judges the median of several runs against the budget (scripts/kopje-bench-range.sh).
	if (scale >= 1 && !inject('benchReportOnly')) {
		expect(ms).toBeLessThanOrEqual(budgetMs)
	}
}, 3_600_000)
