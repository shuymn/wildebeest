import { resolveApiId } from './accounts'
import { pollUpdateActivity, recordOutbound, statusFacts, voteActivity } from './activities'
import { mayVoteSql, viewableStatusId } from './audience'
import { optionalUserReadOperation, userWriteOperation } from './auth'
import { notify } from './notifications'
import { writeOperation } from './operation'
import type { Db } from '../db/sql'

// Polls (Mastodon 4.5's Poll, PollVote, VoteService, Api::V1::PollsController and Polls::VotesController,
// REST::PollSerializer and PollExpirationNotifyWorker). A poll belongs to its status, local or remote, and its API id is
// its status's. Its counts are kept as votes are cast (or as a remote server reports them) and never recounted on
// read. Who votes is decided by the policy module (R27, mayVoteSql: whoever may see the status by itself and does not
// block its author); this module alone reads poll_votes, and shows only counts and a viewer's own votes, never who
// voted. The cron ends polls (the 'poll' notification to a local author and to local voters, once) and sends the
// Update of a local poll's counts, debounced, in bounded rounds.

// PollOptionsValidator and PollExpirationValidator: the limits of a local poll, as the instance entity advertises them.
export const MAX_OPTIONS = 4
export const MAX_OPTION_CHARS = 50
export const MIN_EXPIRATION_S = 5 * 60
// Rails' 1.month.
export const MAX_EXPIRATION_S = 2_629_746

// A remote poll keeps at most this many choices, each cut to this many code units (RES-4; Mastodon's PollParser
// keeps 500 choices, whole).
export const MAX_REMOTE_OPTIONS = 100
export const MAX_REMOTE_OPTION_LENGTH = 200

// VoteService#distribute_poll!: the Update of a local poll's counts waits this long after a vote, and one Update
// carries every vote cast meanwhile.
export const UPDATE_DELAY_MS = 3 * 60 * 1000

// At most this many polls are ended, and this many Updates of counts recorded, per cron run (RES-6).
export const POLL_ROUND = 25

export type PollRequest = { options: string[]; expiresIn?: string; multiple?: boolean; hideTotals?: boolean }

// A local poll as it is checked and written: its choices, its duration in seconds and its options.
export type PollInput = { options: string[]; expiresIn: number; multiple: boolean; hideTotals: boolean }

// The Poll entity (REST::PollSerializer). voted and own_votes are shown to a signed-in viewer only.
export type Poll = {
	id: string
	expires_at: string | null
	expired: boolean
	multiple: boolean
	votes_count: number
	voters_count: number | null
	options: { title: string; votes_count: number | null }[]
	emojis: []
	voted?: boolean
	own_votes?: number[]
}

// Ruby's String#strip (ASCII whitespace and NUL) and Object#blank? (Unicode whitespace only).
function strip(value: string): string {
	return value.replace(/^[\0\t\n\v\f\r ]+|[\0\t\n\v\f\r ]+$/g, '')
}

function isBlank(value: string | undefined): boolean {
	return value === undefined || /^\s*$/u.test(value)
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

// Whether `value` has more than `max` grapheme clusters, counting no further than that.
function longerThan(value: string, max: number): boolean {
	if (value.length <= max) {
		return false
	}
	let count = 0
	for (const _ of graphemes.segment(value)) {
		if (++count > max) {
			return true
		}
	}
	return false
}

// Ruby's String#to_i: optional leading whitespace and sign, then digits (underscores between them); anything else
// reads 0. A value past what a duration can be reads as that far.
function rubyInteger(value: string): number {
	const match = /^\s*([+-]?)(\d+(?:_\d+)*)/.exec(value)
	if (match === null) {
		return 0
	}
	const digits = (match[2] ?? '0').replaceAll('_', '')
	const magnitude = digits.replace(/^0+(?=\d)/, '').length > 15 ? Number.MAX_SAFE_INTEGER : Number(digits)
	return match[1] === '-' ? -magnitude : magnitude
}

// The poll of a post as Mastodon's Poll validates it, with its messages in its order (Choices and Deadline are its
// names for options and expires_at): the choices stripped and the blank ones dropped, then present, more than one, at
// most MAX_OPTIONS, each at most MAX_OPTION_CHARS grapheme clusters, no two alike; the duration present (expires_in,
// read as Ruby's to_i) and between MIN_EXPIRATION_S and MAX_EXPIRATION_S.
export function checkPoll(request: PollRequest): PollInput | { error: string } {
	const options = request.options.map(strip).filter((option) => !isBlank(option))
	const errors: string[] = []
	if (options.length === 0) {
		errors.push("Choices can't be blank")
	}
	const expiresIn = isBlank(request.expiresIn) ? null : rubyInteger(request.expiresIn ?? '')
	if (expiresIn === null) {
		errors.push("Deadline can't be blank")
	}
	if (options.length <= 1) {
		errors.push('Choices must have more than one item')
	}
	if (options.length > MAX_OPTIONS) {
		errors.push(`Choices can't contain more than ${MAX_OPTIONS} items`)
	}
	if (options.some((option) => longerThan(option, MAX_OPTION_CHARS))) {
		errors.push(`Choices cannot be longer than ${MAX_OPTION_CHARS} characters each`)
	}
	if (new Set(options).size !== options.length) {
		errors.push('Choices contain duplicate items')
	}
	if (expiresIn !== null && expiresIn > MAX_EXPIRATION_S) {
		errors.push('Deadline is too far into the future')
	}
	if (expiresIn !== null && expiresIn < MIN_EXPIRATION_S) {
		errors.push('Deadline is too soon')
	}
	if (errors.length > 0 || expiresIn === null) {
		return { error: `Validation failed: ${errors.join(', ')}` }
	}
	return { options, expiresIn, multiple: request.multiple ?? false, hideTotals: request.hideTotals ?? false }
}

export function isPollInput(value: PollInput | { error: string }): value is PollInput {
	return !('error' in value)
}

function iso(ms: number): string {
	return new Date(ms).toISOString()
}

// ---- Writing a local poll (statuses.ts).

// The poll of a new local status, ending `expiresIn` seconds after `now`.
export function writePoll(db: Db, statusId: string, poll: PollInput, now: number): void {
	db.run(
		`INSERT INTO polls (status_id, options, tallies, multiple, hide_totals, expires_at, votes_count, voters_count,
			created_at)
		VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`,
		statusId,
		JSON.stringify(poll.options),
		JSON.stringify(poll.options.map(() => 0)),
		poll.multiple ? 1 : 0,
		poll.hideTotals ? 1 : 0,
		iso(now + poll.expiresIn * 1000),
		iso(now)
	)
}

// UpdateStatusService#update_poll! for an edit of a local status: a poll sent replaces the status's (its end moves to
// `expiresIn` from now, and changed choices or a changed multiple drop the votes cast); none removes it. Whether the
// poll changed, which makes the edit significant.
export function editPoll(db: Db, statusId: string, poll: PollInput | null, now: number): boolean {
	const previous = db.first<{ options: string; multiple: number; expires_at: string | null }>(
		'SELECT options, multiple, expires_at FROM polls WHERE status_id = ?',
		statusId
	)
	if (poll === null) {
		return previous !== undefined && db.run('DELETE FROM polls WHERE status_id = ?', statusId) > 0
	}
	if (previous === undefined) {
		writePoll(db, statusId, poll, now)
		return true
	}
	const expiresAt = iso(now + poll.expiresIn * 1000)
	const reset = previous.options !== JSON.stringify(poll.options) || previous.multiple !== (poll.multiple ? 1 : 0)
	if (reset) {
		db.run('DELETE FROM poll_votes WHERE poll_id = ?', statusId)
	}
	// A poll that ends later again is ended again by the cron (PollExpirationNotifyWorker, queued anew).
	db.run(
		`UPDATE polls SET options = ?2, multiple = ?3, hide_totals = ?4, expires_at = ?5,
			ended = CASE WHEN ?5 > ?6 THEN 0 ELSE ended END,
			tallies = CASE WHEN ?7 THEN ?8 ELSE tallies END,
			votes_count = CASE WHEN ?7 THEN 0 ELSE votes_count END,
			voters_count = CASE WHEN ?7 THEN 0 ELSE voters_count END
		WHERE status_id = ?1`,
		statusId,
		JSON.stringify(poll.options),
		poll.multiple ? 1 : 0,
		poll.hideTotals ? 1 : 0,
		expiresAt,
		iso(now),
		reset ? 1 : 0,
		JSON.stringify(poll.options.map(() => 0))
	)
	return reset || previous.expires_at !== expiresAt
}

// The choices of a status's poll, for its edit history (StatusEdit's poll_options): a JSON array, or null.
export function pollOptionsJson(db: Db, statusId: string): string | null {
	return db.first<{ options: string }>('SELECT options FROM polls WHERE status_id = ?', statusId)?.options ?? null
}

// ---- Presenting.

type PollRow = {
	status_id: string
	account_id: string
	options: string
	tallies: string
	multiple: number
	hide_totals: number
	expires_at: string | null
	votes_count: number
	voters_count: number | null
}

const POLL_COLUMNS = `p.status_id, s.account_id, p.options, p.tallies, p.multiple, p.hide_totals, p.expires_at,
	p.votes_count, p.voters_count`

function presentPoll(row: PollRow, viewer: { id: string | null; votes: number[] }, now: string): Poll {
	const expired = row.expires_at !== null && row.expires_at < now
	// Poll#show_totals_now?: for everyone, the author included.
	const shown = expired || row.hide_totals === 0
	const tallies = JSON.parse(row.tallies) as number[]
	return {
		id: row.status_id,
		expires_at: row.expires_at,
		expired,
		multiple: row.multiple === 1,
		votes_count: row.votes_count,
		voters_count: row.voters_count,
		options: (JSON.parse(row.options) as string[]).map((title, i) => ({
			title,
			votes_count: shown ? (tallies[i] ?? 0) : null,
		})),
		emojis: [],
		...(viewer.id === null
			? {}
			: { voted: row.account_id === viewer.id || viewer.votes.length > 0, own_votes: viewer.votes }),
	}
}

// The polls of `statusIds` (statuses the caller may show the viewer), by status id, as the viewer sees them at `now`
// (an ISO time): one read of the polls and one of the viewer's own votes in them, so a page reads its polls' rows and
// nothing per vote.
export function presentPolls(
	db: Db,
	statusIds: readonly string[],
	viewerId: string | null,
	now: string
): Map<string, Poll> {
	if (statusIds.length === 0) {
		return new Map()
	}
	const ids = JSON.stringify(statusIds)
	const rows = db.all<PollRow>(
		`SELECT ${POLL_COLUMNS} FROM json_each(?1) j CROSS JOIN polls p ON p.status_id = j.value JOIN statuses s ON s.id = p.status_id`,
		ids
	)
	if (rows.length === 0) {
		return new Map()
	}
	const votes = new Map<string, number[]>()
	if (viewerId !== null) {
		for (const vote of db.all<{ poll_id: string; choice: number }>(
			`SELECT v.poll_id, v.choice FROM json_each(?2) j CROSS JOIN poll_votes v ON v.poll_id = j.value AND v.account_id = ?1
			ORDER BY v.id`,
			viewerId,
			JSON.stringify(rows.map((row) => row.status_id))
		)) {
			votes.set(vote.poll_id, [...(votes.get(vote.poll_id) ?? []), vote.choice])
		}
	}
	return new Map(
		rows.map((row) => [row.status_id, presentPoll(row, { id: viewerId, votes: votes.get(row.status_id) ?? [] }, now)])
	)
}

// The poll `id` the viewer may see (R3, viewableStatusId): its status's id, or null.
function viewablePoll(db: Db, viewerId: string | null, id: string): string | null {
	const statusId = resolveApiId(db, 'statuses', id)
	const visible = statusId === null ? null : viewableStatusId(db, viewerId, statusId)
	return visible === null || db.first('SELECT 1 AS x FROM polls WHERE status_id = ?', visible) === undefined
		? null
		: visible
}

// GET /api/v1/polls/:id: the poll, if the viewer may see its status (Api::V1::PollsController authorizes
// StatusPolicy#show?); otherwise not found.
export const getPoll = optionalUserReadOperation<{ id: string }, Poll | null>((db, { id }, { accountId, now }) => {
	const pollId = viewablePoll(db, accountId, id)
	return pollId === null ? null : (presentPolls(db, [pollId], accountId, now).get(pollId) ?? null)
})

// ---- Voting.

export type VoteResult =
	| { status: 'ok'; value: Poll }
	| { status: 'not_found' }
	| { status: 'forbidden' }
	| { status: 'missing' }
	| { status: 'invalid'; error: string }

type VotedPoll = {
	status_id: string
	status_uri: string
	author_id: string
	author_uri: string
	local: number
	options: string
	multiple: number
	hide_totals: number
	expires_at: string | null
}

// A choice as Ruby's Integer() reads a decimal one; anything else is no choice of the poll.
function choiceOf(value: string): number {
	return /^[+-]?\d{1,9}$/.test(value.trim()) ? Number(value.trim()) : -1
}

// VoteValidator's errors for one more vote in `choice`, given the voter's votes so far: the poll ended, a choice it does
// not have, the author's own poll, or a vote again (any in a single-choice poll, the same choice in a multiple one).
function voteErrors(poll: VotedPoll, voterId: string, choice: number, votes: number[], now: string): string[] {
	const errors: string[] = []
	if (poll.expires_at !== null && poll.expires_at < now) {
		errors.push('The poll has already ended')
	}
	if (choice < 0 || choice >= (JSON.parse(poll.options) as string[]).length) {
		errors.push('The chosen vote option does not exist')
	}
	if (voterId === poll.author_id) {
		errors.push('You cannot vote in your own polls')
	}
	if (poll.multiple === 1 ? votes.includes(choice) : votes.length > 0) {
		errors.push('You have already voted on this poll')
	}
	return errors
}

// Counts `choices` (each a choice index) of `voterId` in the poll: the votes, each choice's tally, the votes and,
// for a first vote, the voters (when the poll counts them).
function countVotes(
	db: Db,
	pollId: string,
	voterId: string,
	choices: readonly number[],
	first: boolean,
	uri: string | null,
	now: number
) {
	const ids: string[] = []
	for (const choice of choices) {
		const row = db.first<{ id: string }>(
			`INSERT INTO poll_votes (poll_id, account_id, choice, uri, created_at) VALUES (?, ?, ?, ?, ?)
			RETURNING CAST(id AS TEXT) AS id`,
			pollId,
			voterId,
			choice,
			uri,
			iso(now)
		)
		if (row === undefined) {
			throw new Error('the vote was not written')
		}
		ids.push(row.id)
		db.run(
			`UPDATE polls SET tallies = json_set(tallies, ?2, json_extract(tallies, ?2) + 1), votes_count = votes_count + 1
			WHERE status_id = ?1`,
			pollId,
			`$[${String(Math.trunc(choice))}]`
		)
	}
	if (first) {
		db.run('UPDATE polls SET voters_count = voters_count + 1 WHERE status_id = ? AND voters_count IS NOT NULL', pollId)
	}
	return ids
}

// DistributePollUpdateWorker.perform_in(3.minutes): the Update of a local poll's counts, unless it hides them, falls due
// a while after the first vote since the last one sent, and carries every vote cast until then.
function updateSoon(db: Db, poll: VotedPoll, now: number): void {
	if (poll.local === 1 && poll.hide_totals === 0) {
		db.run(
			'UPDATE polls SET update_due_at = COALESCE(update_due_at, ?) WHERE status_id = ?',
			iso(now + UPDATE_DELAY_MS),
			poll.status_id
		)
	}
}

function votedPoll(db: Db, pollId: string): VotedPoll | undefined {
	return db.first<VotedPoll>(
		`SELECT p.status_id, s.uri AS status_uri, s.account_id AS author_id, a.uri AS author_uri, a.domain IS NULL AS local,
			p.options, p.multiple, p.hide_totals, p.expires_at
		FROM polls p JOIN statuses s ON s.id = p.status_id JOIN accounts a ON a.id = s.account_id WHERE p.status_id = ?`,
		pollId
	)
}

function mayVote(db: Db, voterId: string, statusId: string): boolean {
	return (
		db.first(`SELECT 1 AS x FROM statuses s WHERE s.id = ?2 AND ${mayVoteSql('s', '?1')}`, voterId, statusId) !==
		undefined
	)
}

// POST /api/v1/polls/:id/votes (VoteService): a poll on a status the viewer may not see is not found; one whose
// author either blocks the other refuses the vote (PollPolicy#vote?, R27). The choices are validated one after the
// other, as VoteService creates them in one transaction: the first that fails refuses them all with its errors. A vote
// in a local poll is counted and its Update falls due; one in a remote poll is counted here too and delivered to the
// poll's author, a Create of a Note per choice.
export const vote = userWriteOperation<{ id: string; choices: string[]; now: number }, VoteResult>(
	(db, input, { accountId }) => {
		const pollId = viewablePoll(db, accountId, input.id)
		const poll = pollId === null ? undefined : votedPoll(db, pollId)
		if (pollId === null || poll === undefined) {
			return { status: 'not_found' }
		}
		// The poll is found before choices are required (Polls::VotesController's set_poll, then params.require), and
		// the vote authorized after (VoteService).
		if (input.choices.length === 0) {
			return { status: 'missing' }
		}
		if (!mayVote(db, accountId, pollId)) {
			return { status: 'forbidden' }
		}
		const now = iso(input.now)
		const before = db
			.all<{ choice: number }>('SELECT choice FROM poll_votes WHERE poll_id = ? AND account_id = ?', pollId, accountId)
			.map((row) => row.choice)
		const votes = [...before]
		const choices: number[] = []
		for (const raw of input.choices) {
			const choice = choiceOf(raw)
			const errors = voteErrors(poll, accountId, choice, votes, now)
			if (errors.length > 0) {
				return { status: 'invalid', error: `Validation failed: ${errors.join(', ')}` }
			}
			votes.push(choice)
			choices.push(choice)
		}
		const ids = countVotes(db, pollId, accountId, choices, before.length === 0, null, input.now)
		if (poll.local === 1) {
			updateSoon(db, poll, input.now)
		} else {
			const actorUri = db.first<{ uri: string }>('SELECT uri FROM accounts WHERE id = ?', accountId)?.uri ?? ''
			const options = JSON.parse(poll.options) as string[]
			choices.forEach((choice, i) => {
				recordOutbound(
					db,
					accountId,
					voteActivity({
						voteUri: `${actorUri}#votes/${ids[i] ?? ''}`,
						actorUri,
						name: options[choice] ?? '',
						statusUri: poll.status_uri,
						authorUri: poll.author_uri,
						authorId: poll.author_id,
					}),
					input.now
				)
			})
		}
		const value = presentPolls(db, [pollId], accountId, now).get(pollId)
		return value === undefined ? { status: 'not_found' } : { status: 'ok', value }
	}
)

export type RemoteVote = { voterId: string; statusId: string; name: string; uri: string; now: number }

// ActivityPub::Activity::Create#poll_vote!: a remote account's vote, a Note naming a choice in reply to a local poll. It
// counts when the poll is open and has the choice, the voter may vote (R27: Mastodon does not check), and has not voted
// yet (in a multiple poll, not for that choice). Whether it was counted; a vote never becomes a status either way.
export function receiveVote(db: Db, input: RemoteVote): boolean {
	const poll = votedPoll(db, input.statusId)
	if (poll === undefined || poll.local !== 1) {
		return false
	}
	const choice = (JSON.parse(poll.options) as string[]).indexOf(input.name)
	if (choice < 0 || !mayVote(db, input.voterId, poll.status_id)) {
		return false
	}
	const votes = db
		.all<{ choice: number }>(
			'SELECT choice FROM poll_votes WHERE poll_id = ? AND account_id = ?',
			poll.status_id,
			input.voterId
		)
		.map((row) => row.choice)
	if (voteErrors(poll, input.voterId, choice, votes, iso(input.now)).length > 0) {
		return false
	}
	countVotes(db, poll.status_id, input.voterId, [choice], votes.length === 0, input.uri, input.now)
	updateSoon(db, poll, input.now)
	return true
}

// Whether the status `statusId` has a poll and is local: a Note naming a choice in reply to it is a vote.
export function isLocalPoll(db: Db, statusId: string): boolean {
	return votedPoll(db, statusId)?.local === 1
}

// ---- A remote poll (remote-statuses.ts), as ActivityPub::Parser::PollParser reads a Question.

export type RemotePollInput = {
	options: string[]
	tallies: number[]
	multiple: boolean
	expiresAt: string | null
	votersCount: number | null
}

// Writes or refreshes the poll of a remote status: a new one, or, when `significant` changes are allowed, new choices
// or a new multiple (which drop the votes cast: Poll#reset_votes!); otherwise only the counts, the end and the voters
// (an implicit update: ProcessStatusUpdateService#update_poll! without significant changes). An end that has passed is
// never ended again. Whether the poll changed.
export function storeRemotePoll(
	db: Db,
	statusId: string,
	poll: RemotePollInput | null,
	significant: boolean,
	now: number
): boolean {
	const previous = db.first<{ options: string; multiple: number }>(
		'SELECT options, multiple FROM polls WHERE status_id = ?',
		statusId
	)
	if (poll === null) {
		return significant && previous !== undefined && db.run('DELETE FROM polls WHERE status_id = ?', statusId) > 0
	}
	const options = JSON.stringify(poll.options)
	const tallies = JSON.stringify(poll.tallies)
	const votes = poll.tallies.reduce((sum, n) => sum + n, 0)
	if (previous === undefined) {
		db.run(
			`INSERT INTO polls (status_id, options, tallies, multiple, expires_at, votes_count, voters_count, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			statusId,
			options,
			tallies,
			poll.multiple ? 1 : 0,
			poll.expiresAt,
			votes,
			poll.votersCount,
			iso(now)
		)
		return true
	}
	const changed = previous.options !== options || previous.multiple !== (poll.multiple ? 1 : 0)
	if (changed && !significant) {
		return false
	}
	if (changed) {
		db.run('DELETE FROM poll_votes WHERE poll_id = ?', statusId)
	}
	db.run(
		`UPDATE polls SET options = ?2, multiple = ?3, tallies = ?4, votes_count = ?5, voters_count = ?6, expires_at = ?7
		WHERE status_id = ?1`,
		statusId,
		options,
		poll.multiple ? 1 : 0,
		tallies,
		votes,
		poll.votersCount,
		poll.expiresAt
	)
	return changed
}

// ---- Purges (inbox.ts): votes go in bounded batches, so a status or account with many never deletes them at once.

// Deletes at most `limit` votes of the poll of `statusId`; how many.
export function deletePollVotes(db: Db, statusId: string, limit: number): number {
	return limit <= 0
		? 0
		: db.run(
				'DELETE FROM poll_votes WHERE id IN (SELECT id FROM poll_votes WHERE poll_id = ? LIMIT ?)',
				statusId,
				limit
			)
}

// Deletes at most `limit` votes of the account `accountId` (counts stay, as Mastodon keeps a poll's cached tallies).
export function deleteAccountVotes(db: Db, accountId: string, limit: number): number {
	return limit <= 0
		? 0
		: db.run(
				'DELETE FROM poll_votes WHERE id IN (SELECT id FROM poll_votes WHERE account_id = ? LIMIT ?)',
				accountId,
				limit
			)
}

export function hasPollVotes(db: Db, by: { statusId?: string; accountId?: string }): boolean {
	return (
		db.first(
			'SELECT 1 AS x FROM poll_votes WHERE (?1 IS NOT NULL AND poll_id = ?1) OR (?2 IS NOT NULL AND account_id = ?2) LIMIT 1',
			by.statusId ?? null,
			by.accountId ?? null
		) !== undefined
	)
}

// ---- The cron's rounds (jobs/scheduled.ts).

// The remote accounts that voted in a local poll, whom its Update reaches too.
function remoteVoters(db: Db, pollId: string): string[] {
	return db
		.all<{ id: string }>(
			`SELECT DISTINCT v.account_id AS id FROM poll_votes v JOIN accounts a ON a.id = v.account_id
			WHERE v.poll_id = ? AND a.domain IS NOT NULL`,
			pollId
		)
		.map((row) => row.id)
}

function recordPollUpdate(db: Db, statusId: string, authorId: string, now: number): void {
	const facts = statusFacts(db, statusId)
	if (facts !== null) {
		recordOutbound(db, authorId, pollUpdateActivity(facts, now, remoteVoters(db, statusId)), now)
	}
}

export type PollRound = { ended: number; updated: number }

// One round of the cron (RES-6), at most POLL_ROUND polls of each kind, each through its partial index:
//   - polls that have ended (PollExpirationNotifyWorker): the author of a local one and the local voters of any are
//     notified ('poll', from the poll's author; the notification rule applies), and a local one's Update carries its
//     end and final counts. Each is marked ended in the same transaction, so it is notified once.
//   - local polls whose Update of counts is due (DistributePollUpdateWorker): one Update each, to the status's audience
//     and the remote voters; an Update supersedes the earlier ones still waiting (deliveries.ts).
export const pollRound = writeOperation<{ now: number }, PollRound>((db, { now }) => {
	const at = iso(now)
	const ending = db.all<{ status_id: string; author_id: string; local: number }>(
		`SELECT p.status_id, s.account_id AS author_id, a.domain IS NULL AS local
		FROM (SELECT status_id FROM polls WHERE ended = 0 AND expires_at IS NOT NULL AND expires_at <= ?1
			ORDER BY expires_at LIMIT ?2) e
		JOIN polls p ON p.status_id = e.status_id JOIN statuses s ON s.id = p.status_id JOIN accounts a ON a.id = s.account_id`,
		at,
		POLL_ROUND
	)
	for (const poll of ending) {
		db.run('UPDATE polls SET ended = 1, update_due_at = NULL WHERE status_id = ?', poll.status_id)
		if (poll.local === 1) {
			notify(db, { recipientId: poll.author_id, type: 'poll', fromId: poll.author_id, statusId: poll.status_id, now })
			recordPollUpdate(db, poll.status_id, poll.author_id, now)
		}
		const voters = db.all<{ account_id: string }>(
			`SELECT DISTINCT v.account_id FROM poll_votes v JOIN local_accounts l ON l.account_id = v.account_id
			WHERE v.poll_id = ?`,
			poll.status_id
		)
		for (const voter of voters) {
			notify(db, { recipientId: voter.account_id, type: 'poll', fromId: poll.author_id, statusId: poll.status_id, now })
		}
	}
	const due = db.all<{ status_id: string; author_id: string }>(
		`SELECT p.status_id, s.account_id AS author_id
		FROM (SELECT status_id FROM polls WHERE update_due_at IS NOT NULL AND update_due_at <= ?1
			ORDER BY update_due_at LIMIT ?2) d
		JOIN polls p ON p.status_id = d.status_id JOIN statuses s ON s.id = p.status_id`,
		at,
		POLL_ROUND
	)
	for (const poll of due) {
		db.run('UPDATE polls SET update_due_at = NULL WHERE status_id = ?', poll.status_id)
		recordPollUpdate(db, poll.status_id, poll.author_id, now)
	}
	return { ended: ending.length, updated: due.length }
})
