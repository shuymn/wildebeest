import { moderationUpdate } from './actor-update'
import { type ReachedAccount, reachFollowers, reachFollowing, reachMentioned } from './audience'
import { beginStagedUpdate, endStaging, isDeliverableInbox, stageTargets } from './deliveries'
import { writeOperation } from './operation'
import { reportBound, resolveSuspensionReports } from './reports'
import { forgetActorSnapshots } from './snapshot'
import type { Db } from '../db/sql'

// Local suspension (Mastodon's Admin::AccountAction with type suspend, SuspendAccountService and Admin::
// SuspensionWorker; UnsuspendAccountService for the unsuspension), migration 0032_admin_suspension. The OAuth admin
// suspends and unsuspends through the Mastodon admin API (admin-accounts.ts), the Access admin unsuspends through
// /admin; both call suspendLocal and unsuspendLocal here.
//
// A suspension commits in one bounded transaction (RES-6): the account's suspended_at and token fence
// (tokens_valid_after) at its time S, the frozen bounds (the newest report and follow), two jobs, the Update of its
// actor with no targets yet, and the removal of its actor's snapshots. Everything that grows with the account runs
// afterwards in rounds of the jobs (runModerationJobs, with the inbound jobs, store.ts):
//
//   - tokens: deletes the fenced tokens child-first (TOKEN_CHILDREN), so no delete cascades, at most
//     TOKEN_ROUND_ROWS rows written per round. The fence already refuses them (auth.ts unfencedSql): API calls, web
//     sessions, code exchange, streaming and pushes. Never cancelled; the fence outlives an unsuspension, so the user
//     signs in again.
//   - suspension, bound to S: resolves the reports frozen at S (reports.ts resolveSuspensionReports), then stages the
//     Update's audience, then writes it. A round that finds the account no longer suspended at S ends the job.
//   - reach (an unsuspension's), bound to the fence of the suspension it lifts: stages the restoration Update's
//     audience the same way, and ends once the account is suspended again.
//
// The audience is AccountReachFinder's (app/lib/account_reach_finder.rb), read from indexed ranges at most REACH_ROUND
// rows per round into moderation_reach, so each inbox appears once: the accepted followers up to the frozen bound
// (follows_target), the accounts mentioned by its newest STATUS_LIMIT statuses since the cutoff (statuses_account,
// then status_mentions by key, at most RECENT_LIMIT inboxes), and the accounts it followed or requested to follow
// since the cutoff (follows_pair over its whole following, a round at a time, at most RECENT_LIMIT inboxes of each
// state). A capped source counts only the inboxes it stages first, as Mastodon caps each source's distinct inboxes. The
// cutoff is two days before S, as Mastodon's for a locally suspended account; the restoration uses the same one. Kopje
// has no relays, and its reporters are local, so neither adds inboxes. Then the inboxes are written as the Update's
// targets in inbox order (deliveries.ts stageTargets), and their staging rows deleted, a round at a time.
//
// A suspended sender's queued content is dropped when claimed (deliveries.ts refusedSender), so only the Update and
// retractions leave its lanes.

// Rows a tokens round writes at most (push deliveries, subscriptions and tokens, cascades included, and its job).
export const TOKEN_ROUND_ROWS = 200
// Reports a suspension round reads at most.
export const REPORT_ROUND = 100
// Rows a staging round reads at most, and staged inboxes a writing round reads (and deletes) at most.
export const REACH_ROUND = 500
// AccountReachFinder's limits.
export const STATUS_LIMIT = 200
export const RECENT_LIMIT = 2_000
export const RECENT_MS = 2 * 24 * 60 * 60 * 1000
// Rows any round writes at most: REACH_ROUND staged inboxes (or their deletion), the chunks they make, and the job's own
// rows (its update or delete, and its Update's release).
export const MODERATION_ROUND_ROWS = 600
// Rounds one runModerationJobs call runs at most.
export const MODERATION_ROUNDS = 4

// The tables below oauth_tokens, child first: the order the tokens job deletes them in, before the token itself, so no
// delete cascades. The cascade guard (test/cascade-guard.test.ts) requires every table that cascades from oauth_tokens
// to be here.
export const TOKEN_CHILDREN = ['push_deliveries', 'push_subscriptions'] as const

type JobKind = 'tokens' | 'suspension' | 'reach'
type Phase = 'tokens' | 'reports' | 'followers' | 'mentions' | 'following' | 'write' | 'end'

type Job = {
	id: number
	kind: JobKind
	account_id: string
	generation: string
	actor_account_id: string | null
	intent_id: string | null
	report_bound: number | null
	follow_bound: number | null
	cutoff: string | null
	phase: Phase
	state: string
}

// A job's persisted cursor and counts: the last report, follow, status or mention read, the oldest status the
// mentions walk reads, and what each capped source has given.
type JobState = {
	cursor?: string | number
	mention?: string | null
	low?: string | null
	statuses?: number
	taken?: number
	accepted?: number
	pending?: number
}

const iso = (ms: number) => new Date(ms).toISOString()

// The newest follow, which bounds the followers and follows a job reads.
function followBound(db: Db): number {
	return db.first<{ id: number | null }>('SELECT max(id) AS id FROM follows')?.id ?? 0
}

function insertJob(db: Db, job: Omit<Job, 'id' | 'state'>, now: number): void {
	db.run(
		`INSERT INTO moderation_jobs (kind, account_id, generation, actor_account_id, intent_id, report_bound, follow_bound,
			cutoff, phase, created_at)
		VALUES (?, ?, ?, ?, CAST(? AS INTEGER), ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
		job.kind,
		job.account_id,
		job.generation,
		job.actor_account_id,
		job.intent_id,
		job.report_bound,
		job.follow_bound,
		job.cutoff,
		job.phase,
		now
	)
}

// The time of a new generation: now, or just after the account's last suspension or fence when the clock has not
// passed them, so each generation differs from the one before.
function generationAt(now: number, ...earlier: (string | null)[]): string {
	const after = earlier.filter((at) => at !== null).map((at) => Date.parse(at) + 1)
	return iso(Math.max(now, ...after))
}

type LocalState = { suspended_at: string | null; tokens_valid_after: string | null }

function localState(db: Db, accountId: string): LocalState | undefined {
	return db.first<LocalState>(
		'SELECT suspended_at, tokens_valid_after FROM local_accounts WHERE account_id = ?',
		accountId
	)
}

// Suspends a local account in one bounded transaction (above): a new generation S, also when it is suspended already
// (Mastodon's suspend! sets suspended_at again and runs the suspension anew), which ends the jobs of the generation
// before. `by` is the admin who suspends, whom the resolved reports name. Returns S, or null for an account that is not
// local.
export function suspendLocal(db: Db, accountId: string, by: string | null, now: number): string | null {
	const state = localState(db, accountId)
	if (state === undefined) {
		return null
	}
	const at = generationAt(now, state.suspended_at, state.tokens_valid_after)
	// The fence is S, or the newest credential of the account when a caller's clock stamped one later: every token, code
	// and web session committed before this transaction is at or below it, whatever the clocks that stamped them. Push
	// subscriptions are refused through their token. This reads the account's credentials (its own history), and
	// writes nothing for them.
	const newest = db.first<{ at: string | null }>(
		'SELECT max(created_at) AS at FROM oauth_tokens INDEXED BY oauth_tokens_account WHERE account_id = ?',
		accountId
	)?.at
	const fence = newest != null && newest > at ? newest : at
	db.run(
		'UPDATE local_accounts SET suspended_at = ?, tokens_valid_after = ? WHERE account_id = ?',
		at,
		fence,
		accountId
	)
	insertJob(
		db,
		{
			kind: 'tokens',
			account_id: accountId,
			generation: fence,
			actor_account_id: null,
			intent_id: null,
			report_bound: null,
			follow_bound: null,
			cutoff: null,
			phase: 'tokens',
		},
		now
	)
	const update = moderationUpdate(db, accountId, now)!
	insertJob(
		db,
		{
			kind: 'suspension',
			account_id: accountId,
			generation: at,
			actor_account_id: by,
			intent_id: beginStagedUpdate(db, accountId, update, now),
			report_bound: reportBound(db),
			follow_bound: followBound(db),
			cutoff: iso(Date.parse(at) - RECENT_MS),
			phase: 'reports',
		},
		now
	)
	forgetActorSnapshots(db, accountId)
	return at
}

// Unsuspends a local account: clears suspended_at, which ends the suspension job at its next round, and records the
// restoration Update with its reach job, bound to the fence of the suspension it lifts. The fence stays. Returns false
// for an account that is not local or not suspended.
export function unsuspendLocal(db: Db, accountId: string, now: number): boolean {
	const state = localState(db, accountId)
	if (state?.suspended_at == null) {
		return false
	}
	// A suspension from before the fence existed gets one at its time, so the reach job has a generation to hold to.
	const fence = state.tokens_valid_after ?? state.suspended_at
	db.run('UPDATE local_accounts SET suspended_at = NULL, tokens_valid_after = ? WHERE account_id = ?', fence, accountId)
	const update = moderationUpdate(db, accountId, now)!
	insertJob(
		db,
		{
			kind: 'reach',
			account_id: accountId,
			generation: fence,
			actor_account_id: null,
			intent_id: beginStagedUpdate(db, accountId, update, now),
			report_bound: null,
			follow_bound: followBound(db),
			cutoff: iso(Date.parse(state.suspended_at) - RECENT_MS),
			phase: 'followers',
		},
		now
	)
	forgetActorSnapshots(db, accountId)
	return true
}

// Suspends a local account with no admin to name (suspendLocal), unlogged: the owner console calls it in a later
// stage. Token validation and authorize refuse the account from then on, and the token fence its tokens and codes.
export const suspendAccount = writeOperation<{ accountId: string; now: number }, { suspended: boolean }>(
	(db, { accountId, now }) => ({ suspended: suspendLocal(db, accountId, null, now) !== null })
)

// ---- Rounds

function totalChanges(db: Db): number {
	return db.first<{ n: number }>('SELECT total_changes() AS n')?.n ?? 0
}

function save(db: Db, job: Job, phase: Phase, state: JobState): void {
	db.run('UPDATE moderation_jobs SET phase = ?, state = ? WHERE id = ?', phase, JSON.stringify(state), job.id)
}

function finish(db: Db, job: Job): void {
	db.run('DELETE FROM moderation_jobs WHERE id = ?', job.id)
}

// One round of the tokens job: the account's tokens after the cursor, in token order (oauth_tokens_account), each
// fenced one deleted child-first; one created after the fence is passed over. The round stops before writing more than
// TOKEN_ROUND_ROWS rows, and the job ends once the walk reaches the last token.
function tokensRound(db: Db, job: Job, state: JobState): void {
	const start = totalChanges(db)
	// What the round may still write, keeping one row for the job's own update or delete.
	const room = () => TOKEN_ROUND_ROWS - 1 - (totalChanges(db) - start)
	const tokens = db.all<{ token_hash: string; created_at: string }>(
		`SELECT token_hash, created_at FROM oauth_tokens INDEXED BY oauth_tokens_account
		WHERE account_id = ? AND token_hash > ? ORDER BY token_hash LIMIT ?`,
		job.account_id,
		String(state.cursor ?? ''),
		TOKEN_ROUND_ROWS
	)
	let cursor = String(state.cursor ?? '')
	let stopped = false
	for (const token of tokens) {
		if (token.created_at <= job.generation) {
			const subscription = db.first<{ id: number }>(
				'SELECT id FROM push_subscriptions WHERE token_hash = ?',
				token.token_hash
			)
			if (subscription !== undefined) {
				// Room for the subscription and the token after the deliveries.
				const deliveries = room() - 2
				if (deliveries > 0) {
					db.run(
						`DELETE FROM push_deliveries WHERE id IN
							(SELECT id FROM push_deliveries WHERE subscription_id = ? LIMIT ?)`,
						subscription.id,
						deliveries
					)
				}
				if (
					room() < 2 ||
					db.first('SELECT 1 AS x FROM push_deliveries WHERE subscription_id = ? LIMIT 1', subscription.id) !==
						undefined
				) {
					stopped = true
					break
				}
				db.run('DELETE FROM push_subscriptions WHERE id = ?', subscription.id)
			} else if (room() < 1) {
				stopped = true
				break
			}
			db.run('DELETE FROM oauth_tokens WHERE token_hash = ?', token.token_hash)
		}
		cursor = token.token_hash
	}
	if (!stopped && tokens.length < TOKEN_ROUND_ROWS) {
		finish(db, job)
	} else {
		save(db, job, 'tokens', { cursor })
	}
}

// Whether the generation a job was made for still holds: the account still suspended at S (suspension), or still
// unsuspended from the suspension whose fence the job carries (reach).
function current(db: Db, job: Job): boolean {
	const state = localState(db, job.account_id)
	if (state === undefined) {
		return false
	}
	return job.kind === 'suspension'
		? state.suspended_at === job.generation
		: state.suspended_at === null && state.tokens_valid_after === job.generation
}

// Stages the inboxes of remote accounts; returns how many were not staged yet. A capped source counts only these, as
// Mastodon's reach finder caps each source's distinct inboxes (an inbox another source staged first counts for none).
function stage(db: Db, job: Job, rows: readonly ReachedAccount[]): number {
	let staged = 0
	for (const inbox of new Set(rows.filter((row) => row.domain !== null).map((row) => row.inbox))) {
		if (isDeliverableInbox(inbox)) {
			staged +=
				db.run('INSERT OR IGNORE INTO moderation_reach (job_id, inbox) VALUES (?, ?)', job.id, inbox) > 0 ? 1 : 0
		}
	}
	return staged
}

const NEXT: Record<'followers' | 'mentions' | 'following', Phase> = {
	followers: 'mentions',
	mentions: 'following',
	following: 'write',
}

// One round of a suspension or reach job. Returns whether it wrote targets to the Update. The round checks its
// generation first: a job whose generation ended writes nothing but the deletion of its own staging rows.
function reachRound(db: Db, job: Job, state: JobState, now: number): boolean {
	const phase = job.phase !== 'end' && !current(db, job) ? 'end' : job.phase
	switch (phase) {
		case 'reports': {
			const round = resolveSuspensionReports(
				db,
				job.account_id,
				job.report_bound ?? 0,
				job.generation,
				job.actor_account_id,
				Number(state.cursor ?? 0),
				REPORT_ROUND,
				iso(now)
			)
			if (round.read < REPORT_ROUND) {
				save(db, job, 'followers', {})
			} else {
				save(db, job, 'reports', { cursor: round.last ?? 0 })
			}
			return false
		}
		case 'followers': {
			// The accepted followers up to the frozen bound, in id order (follows_target's range for the account and state).
			const rows = reachFollowers(db, job.account_id, Number(state.cursor ?? 0), job.follow_bound ?? 0, REACH_ROUND)
			stage(db, job, rows)
			next(db, job, 'followers', rows.length < REACH_ROUND, { cursor: rows.at(-1)?.id ?? state.cursor ?? 0 })
			return false
		}
		case 'mentions':
			mentionsRound(db, job, state)
			return false
		case 'following': {
			// The account's own follows and requests, in target order (follows_pair), of which those since the cutoff and
			// up to the frozen bound count, each state up to RECENT_LIMIT.
			const rows = reachFollowing(db, job.account_id, String(state.cursor ?? ''), REACH_ROUND)
			let accepted = state.accepted ?? 0
			let pending = state.pending ?? 0
			for (const row of rows) {
				if (row.id > (job.follow_bound ?? 0) || row.created_at < (job.cutoff ?? '')) {
					continue
				}
				if (row.state === 'accepted' && accepted < RECENT_LIMIT) {
					accepted += stage(db, job, [row])
				} else if (row.state !== 'accepted' && pending < RECENT_LIMIT) {
					pending += stage(db, job, [row])
				}
			}
			const full = accepted >= RECENT_LIMIT && pending >= RECENT_LIMIT
			next(db, job, 'following', rows.length < REACH_ROUND || full, {
				cursor: rows.at(-1)?.target ?? state.cursor ?? '',
				accepted,
				pending,
			})
			return false
		}
		case 'write': {
			// The staged inboxes in inbox order, written as the Update's targets and deleted.
			const rows = db.all<{ inbox: string }>(
				'SELECT inbox FROM moderation_reach WHERE job_id = ? ORDER BY inbox LIMIT ?',
				job.id,
				REACH_ROUND
			)
			const wrote =
				job.intent_id === null
					? 0
					: stageTargets(
							db,
							job.intent_id,
							rows.map((row) => row.inbox)
						)
			dropStaged(db, job, rows)
			if (rows.length < REACH_ROUND) {
				endJob(db, job)
			}
			return wrote > 0
		}
		case 'end': {
			// The generation ended: the job's own staged inboxes are deleted without being written, and it ends without
			// touching its Update. The newer generation's Update superseded that one, and may since have been given
			// the same id (outbound_activities ids are reused once the newest row is deleted), so releasing it here
			// could drop the newer Update.
			const rows = db.all<{ inbox: string }>(
				'SELECT inbox FROM moderation_reach WHERE job_id = ? ORDER BY inbox LIMIT ?',
				job.id,
				REACH_ROUND
			)
			dropStaged(db, job, rows)
			if (rows.length < REACH_ROUND) {
				finish(db, job)
			} else if (job.phase !== 'end') {
				save(db, job, 'end', {})
			}
			return false
		}
		default:
			finish(db, job)
			return false
	}
}

function next(db: Db, job: Job, phase: keyof typeof NEXT, done: boolean, state: JobState): void {
	if (done) {
		save(db, job, NEXT[phase], {})
	} else {
		save(db, job, phase, state)
	}
}

function dropStaged(db: Db, job: Job, rows: readonly { inbox: string }[]): void {
	const last = rows.at(-1)
	if (last !== undefined) {
		db.run('DELETE FROM moderation_reach WHERE job_id = ? AND inbox <= ?', job.id, last.inbox)
	}
}

function endJob(db: Db, job: Job): void {
	if (job.intent_id !== null) {
		endStaging(db, job.intent_id)
	}
	finish(db, job)
}

// One round of the mentions walk: from the oldest of the newest STATUS_LIMIT statuses since the cutoff (`low`, found
// once through statuses_account), each status's mentioned accounts in key order (status_mentions), at most REACH_ROUND
// rows read per round and RECENT_LIMIT mentions in all. The cursor is the status being read and its last mention read
// (null once the status is done).
function mentionsRound(db: Db, job: Job, state: JobState): void {
	let low = state.low
	if (low === undefined) {
		const since = (BigInt(Date.parse(job.cutoff ?? '')) << 16n).toString()
		low =
			db.first<{ low: string | null }>(
				`SELECT min(id) AS low FROM (SELECT id FROM statuses INDEXED BY statuses_account
				WHERE account_id = ? AND id >= ? ORDER BY id DESC LIMIT ?)`,
				job.account_id,
				since,
				STATUS_LIMIT
			)?.low ?? null
	}
	if (low === null) {
		save(db, job, 'following', {})
		return
	}
	// The status being read, and its last mention read: '' when none is read yet, null when the status is done.
	let status = state.cursor === undefined ? null : String(state.cursor)
	let mention = state.mention ?? null
	let statuses = state.statuses ?? 0
	let taken = state.taken ?? 0
	let budget = REACH_ROUND
	let done = false
	while (budget > 0 && taken < RECENT_LIMIT) {
		if (status === null || mention === null) {
			if (statuses >= STATUS_LIMIT) {
				done = true
				break
			}
			const found = db.first<{ id: string }>(
				`SELECT id FROM statuses INDEXED BY statuses_account WHERE account_id = ?1 AND id >= ?2 AND id > ?3
				ORDER BY id LIMIT 1`,
				job.account_id,
				low,
				status ?? ''
			)
			budget--
			if (found === undefined) {
				done = true
				break
			}
			status = found.id
			mention = ''
			statuses++
			if (budget === 0) {
				break
			}
		}
		const rows = reachMentioned(db, status, mention ?? '', budget)
		budget -= rows.length
		for (const row of rows) {
			if (taken < RECENT_LIMIT) {
				taken += stage(db, job, [row])
			}
		}
		mention = rows.length === 0 || budget > 0 ? null : rows.at(-1)!.account_id
	}
	if (done || taken >= RECENT_LIMIT) {
		save(db, job, 'following', {})
	} else {
		save(db, job, 'mentions', { cursor: status ?? undefined, mention, low, statuses, taken })
	}
}

const JOB_COLUMNS = `id, kind, account_id, generation, actor_account_id, CAST(intent_id AS TEXT) AS intent_id, report_bound,
	follow_bound, cutoff, phase, state`

// One round of the next job after `after` (a job id), or of the oldest job when none comes after it, so the jobs of
// a call take turns and a long one (a large token history) does not hold back another's Update. Returns null when there
// is no job, else the job's id and whether the round wrote targets to an Update.
export function moderationRound(db: Db, now: number, after = 0): { id: number; delivers: boolean } | null {
	const job =
		db.first<Job>(`SELECT ${JOB_COLUMNS} FROM moderation_jobs WHERE id > ? ORDER BY id LIMIT 1`, after) ??
		db.first<Job>(`SELECT ${JOB_COLUMNS} FROM moderation_jobs ORDER BY id LIMIT 1`)
	if (job === undefined) {
		return null
	}
	const state = JSON.parse(job.state) as JobState
	if (job.kind === 'tokens') {
		tokensRound(db, job, state)
		return { id: job.id, delivers: false }
	}
	return { id: job.id, delivers: reachRound(db, job, state, now) }
}

// The moderation jobs' next rounds, at most MODERATION_ROUNDS, the jobs taking turns oldest first (the Queue and the
// cron run it with the inbound jobs, store.ts). pending: a job has rounds left; delivers: targets were written.
export const runModerationJobs = writeOperation<{ now: number }, { pending: boolean; delivers: boolean }>(
	(db, { now }) => {
		let delivers = false
		let after = 0
		for (let round = 0; round < MODERATION_ROUNDS; round++) {
			const ran = moderationRound(db, now, after)
			if (ran === null) {
				break
			}
			after = ran.id
			delivers = ran.delivers || delivers
		}
		return { pending: db.first('SELECT 1 AS x FROM moderation_jobs LIMIT 1') !== undefined, delivers }
	}
)
