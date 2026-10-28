import { writeEach } from "../db/by-ids";
import { type ColumnMap, fixedColumns, selectSql } from "../db/columns";
import { ACCOUNTS_ID_INDEX, POLL_VOTES_KEY_INDEX, POLLS_STATUS_INDEX, STATUSES_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { emojiCacheSql, STATUS_EMOJIS_BYTES, yieldsMoreThan } from "../platform/stored-bounds";
import { type Present, resolveApiId } from "./accounts";
import { pollUpdateActivity, recordOutbound, statusFacts, voteActivity } from "./activities";
import { mayVoteSql, viewableStatusId } from "./audience";
import { optionalUserReadOperation, userWriteOperation } from "./auth";
import { type CustomEmoji, emojiCacheOf, pollEmojis, presentEmojis } from "./custom-emojis";
import { notify } from "./notifications";
import { writeOperation } from "./operation";
import { MAX_REMOTE_OPTION_LENGTH, MAX_REMOTE_OPTIONS, pollOptionsSql } from "./status-bounds";

// Polls (Mastodon 4.5's Poll, PollVote, VoteService, Api::V1::PollsController and Polls::VotesController,
// REST::PollSerializer and PollExpirationNotifyWorker). A poll belongs to its status, local or remote, and its API id is
// its status's. Its counts are kept as votes are cast (or as a remote server reports them) and never recounted on
// read. Who votes is decided by the policy module (R27, mayVoteSql: whoever may see the status by itself and does not
// block its author); this module alone reads poll_votes, and shows only counts and a viewer's own votes, never who
// voted. The cron ends polls (the 'poll' notification to a local author and to local voters, once) and sends the
// Update of a local poll's counts, debounced, in bounded rounds.

// PollOptionsValidator and PollExpirationValidator: the limits of a local poll, as the instance entity advertises them.
export const MAX_OPTIONS = 4;
export const MAX_OPTION_CHARS = 50;
export const MIN_EXPIRATION_S = 5 * 60;
// Rails' 1.month.
export const MAX_EXPIRATION_S = 2_629_746;

// A remote poll keeps at most this many choices, each cut to this many code units (RES-4; Mastodon's PollParser
// keeps 500 choices, whole). The length holds Mastodon's 50 grapheme clusters at 20 code units each (an emoji tag
// sequence takes 14) and Misskey's 50 code units, so a choice either server allows is kept whole.
export { MAX_REMOTE_OPTION_LENGTH, MAX_REMOTE_OPTIONS };

// VoteService#distribute_poll!: the Update of a local poll's counts waits this long after a vote, and one Update
// carries every vote cast meanwhile.
export const UPDATE_DELAY_MS = 3 * 60 * 1000;

// At most this many polls are ended, and this many Updates of counts recorded, per cron run (RES-6).
export const POLL_ROUND = 25;

export type PollRequest = { options: string[]; expiresIn?: string; multiple?: boolean; hideTotals?: boolean };

// A local poll as it is checked and written: its choices, its duration in seconds and its options.
export type PollInput = { options: string[]; expiresIn: number; multiple: boolean; hideTotals: boolean };

// The Poll entity (REST::PollSerializer). voted and own_votes are shown to a signed-in viewer only.
export type Poll = {
  id: string;
  expires_at: string | null;
  expired: boolean;
  multiple: boolean;
  votes_count: number;
  voters_count: number | null;
  options: { title: string; votes_count: number | null }[];
  // The status's emojis its choices reference: set by the status presenter, which has read the status, and by
  // presentPoll for a poll shown alone.
  emojis: CustomEmoji[];
  voted?: boolean;
  own_votes?: number[];
};

// Ruby's String#strip (ASCII whitespace and NUL) and Object#blank? (Unicode whitespace only).
function strip(value: string): string {
  return value.replace(/^[\0\t\n\v\f\r ]+|[\0\t\n\v\f\r ]+$/g, "");
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || /^\s*$/u.test(value);
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Whether `value` has more than `max` grapheme clusters, counting no further than that.
function longerThan(value: string, max: number): boolean {
  if (value.length <= max) {
    return false;
  }
  return yieldsMoreThan(graphemes.segment(value), max);
}

// Ruby's String#to_i: optional leading whitespace and sign, then digits (underscores between them); anything else
// reads 0. A value past what a duration can be reads as that far.
function rubyInteger(value: string): number {
  const match = /^\s*([+-]?)(\d+(?:_\d+)*)/.exec(value);
  if (match === null) {
    return 0;
  }
  const digits = (match[2] ?? "0").replaceAll("_", "");
  const magnitude = digits.replace(/^0+(?=\d)/, "").length > 15 ? Number.MAX_SAFE_INTEGER : Number(digits);
  return match[1] === "-" ? -magnitude : magnitude;
}

// The poll of a post as Mastodon's Poll validates it, with its messages in its order (Choices and Deadline are its
// names for options and expires_at): the choices stripped and the blank ones dropped, then present, more than one, at
// most MAX_OPTIONS, each at most MAX_OPTION_CHARS grapheme clusters, no two alike; the duration present (expires_in,
// read as Ruby's to_i) and between MIN_EXPIRATION_S and MAX_EXPIRATION_S.
export function checkPoll(request: PollRequest): PollInput | { error: string } {
  const options = request.options.map(strip).filter((option) => !isBlank(option));
  const errors: string[] = [];
  if (options.length === 0) {
    errors.push("Choices can't be blank");
  }
  const expiresIn = isBlank(request.expiresIn) ? null : rubyInteger(request.expiresIn ?? "");
  if (expiresIn === null) {
    errors.push("Deadline can't be blank");
  }
  if (options.length <= 1) {
    errors.push("Choices must have more than one item");
  }
  if (options.length > MAX_OPTIONS) {
    errors.push(`Choices can't contain more than ${MAX_OPTIONS} items`);
  }
  if (options.some((option) => longerThan(option, MAX_OPTION_CHARS))) {
    errors.push(`Choices cannot be longer than ${MAX_OPTION_CHARS} characters each`);
  }
  if (new Set(options).size !== options.length) {
    errors.push("Choices contain duplicate items");
  }
  if (expiresIn !== null && expiresIn > MAX_EXPIRATION_S) {
    errors.push("Deadline is too far into the future");
  }
  if (expiresIn !== null && expiresIn < MIN_EXPIRATION_S) {
    errors.push("Deadline is too soon");
  }
  if (errors.length > 0 || expiresIn === null) {
    return { error: `Validation failed: ${errors.join(", ")}` };
  }
  return { options, expiresIn, multiple: request.multiple ?? false, hideTotals: request.hideTotals ?? false };
}

export function isPollInput(value: PollInput | { error: string }): value is PollInput {
  return !("error" in value);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
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
    iso(now),
  );
}

// Poll#reset_votes!, bounded: the poll moves to its next generation, so the votes cast so far no longer count or show,
// and its counts start again; the older votes are swept in bounded batches (sweepStaleVotes, deleteStatusWithin). With
// `removed`, the poll is also no poll any more for every read until an edit adds one again.
function resetPoll(db: Db, statusId: string, removed: boolean): void {
  // The 'poll' notifications of the poll it replaces go with it (Mastodon destroys a poll's notifications with the
  // poll), so the next poll's end notifies again; at most one per local account.
  db.run("DELETE FROM notifications WHERE status_id = ? AND type = 'poll'", statusId);
  db.run(
    `UPDATE polls SET generation = generation + 1, stale = 1, removed = ?2, votes_count = 0,
			voters_count = CASE WHEN voters_count IS NULL THEN NULL ELSE 0 END,
			tallies = (SELECT json_group_array(0) FROM json_each(polls.tallies)), update_due_at = NULL,
			ended = CASE WHEN ?2 THEN 1 ELSE 0 END
		WHERE status_id = ?1`,
    statusId,
    removed ? 1 : 0,
  );
}

// The live poll of a status (not removed), with what a change of it compares.
function livePoll(db: Db, statusId: string) {
  return db.first<{ options: string; multiple: number; removed: number }>(
    "SELECT options, multiple, removed FROM polls WHERE status_id = ?",
    statusId,
  );
}

// UpdateStatusService#update_poll! for an edit of a local status: a poll sent replaces the status's (its end moves to
// `expiresIn` from now, and changed choices or a changed multiple drop the votes cast); none removes it.
export function editPoll(db: Db, statusId: string, poll: PollInput | null, now: number): void {
  const row = livePoll(db, statusId);
  const previous = row?.removed === 0 ? row : undefined;
  if (poll === null) {
    if (previous !== undefined) {
      resetPoll(db, statusId, true);
    }
    return;
  }
  if (row === undefined) {
    writePoll(db, statusId, poll, now);
    return;
  }
  const expiresAt = iso(now + poll.expiresIn * 1000);
  // A poll added again where one was removed starts from the removal's reset.
  const reset =
    previous !== undefined &&
    (previous.options !== JSON.stringify(poll.options) || previous.multiple !== (poll.multiple ? 1 : 0));
  if (reset) {
    resetPoll(db, statusId, false);
  }
  // A poll that ends later again is ended again by the cron (PollExpirationNotifyWorker, queued anew).
  db.run(
    `UPDATE polls SET options = ?2, multiple = ?3, hide_totals = ?4, expires_at = ?5, removed = 0,
			ended = CASE WHEN ?5 > ?6 OR removed = 1 THEN 0 ELSE ended END,
			tallies = CASE WHEN json_array_length(tallies) = ?7 THEN tallies ELSE ?8 END
		WHERE status_id = ?1`,
    statusId,
    JSON.stringify(poll.options),
    poll.multiple ? 1 : 0,
    poll.hideTotals ? 1 : 0,
    expiresAt,
    iso(now),
    poll.options.length,
    JSON.stringify(poll.options.map(() => 0)),
  );
}

// Deletes at most `limit` votes of past generations, of polls marked stale, through the stale polls' index and each
// poll's (poll, generation) index; a poll with none left is no longer stale. How many votes it deleted.
export function sweepStaleVotes(db: Db, limit: number): number {
  let left = limit;
  const polls = db.all<{ status_id: string; generation: number }>(
    "SELECT status_id, generation FROM polls WHERE stale = 1 ORDER BY status_id LIMIT ?",
    POLL_ROUND,
  );
  for (const poll of polls) {
    if (left <= 0) {
      break;
    }
    left -= writeEach(
      db,
      {
        ids: `SELECT CAST(id AS TEXT) AS id FROM poll_votes INDEXED BY ${POLL_VOTES_KEY_INDEX}
					WHERE poll_id = ?1 AND generation < ?2 LIMIT ?3`,
        each: "DELETE FROM poll_votes WHERE id = CAST(?1 AS INTEGER)",
      },
      poll.status_id,
      poll.generation,
      left,
    );
    if (
      db.first(
        `SELECT 1 AS x FROM poll_votes INDEXED BY ${POLL_VOTES_KEY_INDEX} WHERE poll_id = ? AND generation < ? LIMIT 1`,
        poll.status_id,
        poll.generation,
      ) === undefined
    ) {
      db.run("UPDATE polls SET stale = 0 WHERE status_id = ?", poll.status_id);
    }
  }
  return limit - left;
}

// The choices of a status's poll as reads present them (pollOptionsSql): a JSON array, or null when it has none.
export function pollOptionsJson(db: Db, statusId: string): string | null {
  return (
    db.first<{ options: string }>(
      `SELECT ${pollOptionsSql("options")} AS options FROM polls WHERE status_id = ? AND removed = 0`,
      statusId,
    )?.options ?? null
  );
}

// ---- Presenting.

type PollRow = {
  status_id: string;
  account_id: string;
  options: string;
  tallies: string;
  multiple: number;
  hide_totals: number;
  expires_at: string | null;
  votes_count: number;
  voters_count: number | null;
};

export const POLL_COLUMN_MAP = {
  status_id: "p.status_id",
  account_id: "s.account_id",
  options: pollOptionsSql("p.options"),
  tallies: "p.tallies",
  multiple: "p.multiple",
  hide_totals: "p.hide_totals",
  expires_at: "p.expires_at",
  votes_count: "p.votes_count",
  voters_count: "p.voters_count",
} as const satisfies ColumnMap;

export const POLL_FROM = `polls p INDEXED BY ${POLLS_STATUS_INDEX}
	CROSS JOIN statuses s INDEXED BY ${STATUSES_ID_INDEX} ON s.id = p.status_id`;

export const OWN_VOTE_COLUMNS = fixedColumns({ poll_id: "v.poll_id", choice: "v.choice" }, { poll_id: 18, choice: 0 });

// How many votes `viewer` cast in the current generation of the poll of `status`, which presentPolls reads as their
// own: for the bound of the rows a presentation reads (statusRowBoundSql in status-rows.ts).
export function ownVoteCountSql(status: string, viewer: string): string {
  return `(SELECT count(*) FROM polls p INDEXED BY ${POLLS_STATUS_INDEX} CROSS JOIN poll_votes v INDEXED BY ${POLL_VOTES_KEY_INDEX}
		ON v.poll_id = p.status_id AND v.generation = p.generation AND v.account_id = ${viewer} WHERE p.status_id = ${status})`;
}

function presentPollRow(row: PollRow, viewer: { id: string | null; votes: number[] }, now: string): Poll {
  const expired = hasEnded(row.expires_at, now);
  // Poll#show_totals_now?: for everyone, the author included.
  const shown = expired || row.hide_totals === 0;
  const tallies = JSON.parse(row.tallies) as number[];
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
  };
}

// The polls of `statusIds` (statuses the caller may show the viewer), by status id, as the viewer sees them at `now`
// (an ISO time): one read of the polls and one of the viewer's own votes in them, so a page reads its polls' rows and
// nothing per vote.
export function presentPolls(
  db: Db,
  statusIds: readonly string[],
  viewerId: string | null,
  now: string,
): Map<string, Poll> {
  if (statusIds.length === 0) {
    return new Map();
  }
  const ids = JSON.stringify(statusIds);
  const rows = db.all<PollRow>(
    `SELECT ${selectSql(POLL_COLUMN_MAP)} FROM json_each(?1) j
			CROSS JOIN polls p INDEXED BY ${POLLS_STATUS_INDEX} ON p.status_id = j.value
			CROSS JOIN statuses s INDEXED BY ${STATUSES_ID_INDEX} ON s.id = p.status_id
		WHERE p.removed = 0`,
    ids,
  );
  if (rows.length === 0) {
    return new Map();
  }
  const votes = new Map<string, number[]>();
  if (viewerId !== null) {
    // The viewer's votes of each poll's current generation only, in the order they were cast. The sort holds ids
    // and choices only, no payload.
    for (const vote of db.all<{ poll_id: string; choice: number }>(
      `SELECT ${selectSql(OWN_VOTE_COLUMNS.columns)} FROM json_each(?2) j
				CROSS JOIN polls p INDEXED BY ${POLLS_STATUS_INDEX} ON p.status_id = j.value
				CROSS JOIN poll_votes v INDEXED BY ${POLL_VOTES_KEY_INDEX} ON v.poll_id = p.status_id AND v.generation = p.generation AND v.account_id = ?1
			ORDER BY v.id`,
      viewerId,
      JSON.stringify(rows.map((row) => row.status_id)),
    )) {
      votes.set(vote.poll_id, [...(votes.get(vote.poll_id) ?? []), vote.choice]);
    }
  }
  return new Map(
    rows.map((row) => [
      row.status_id,
      presentPollRow(row, { id: viewerId, votes: votes.get(row.status_id) ?? [] }, now),
    ]),
  );
}

// The poll of `statusId` as shown alone (GET /api/v1/polls/:id, a vote's answer), with its status's emojis, their
// cached copies on `origin` as the status shows them.
function presentPoll(db: Db, statusId: string, viewerId: string | null, now: string, origin: string): Poll | null {
  const poll = presentPolls(db, [statusId], viewerId, now).get(statusId);
  if (poll === undefined) {
    return null;
  }
  const stored = db.first<{ emojis: string | null; emoji_cache: string | null }>(
    `SELECT CASE WHEN s.reblog_of_id IS NULL THEN s.emojis END AS emojis,
			CASE WHEN s.reblog_of_id IS NULL THEN ${emojiCacheSql("s.emojis", "au.domain")} END AS emoji_cache
		FROM statuses s INDEXED BY ${STATUSES_ID_INDEX} CROSS JOIN accounts au INDEXED BY ${ACCOUNTS_ID_INDEX}
			ON au.id = s.account_id
		WHERE s.id = ?1`,
    statusId,
  );
  const cache = emojiCacheOf(stored?.emoji_cache ?? null, origin);
  return withStatusEmojis(poll, presentEmojis(stored?.emojis ?? null, STATUS_EMOJIS_BYTES, cache));
}

// `poll` with the emojis of its status (`emojis`) its choices reference (custom-emojis.ts pollEmojis).
export function withStatusEmojis(poll: Poll, emojis: readonly CustomEmoji[]): Poll {
  return {
    ...poll,
    emojis: pollEmojis(
      emojis,
      poll.options.map((option) => option.title),
    ),
  };
}

// The status of the poll `id` if the viewer may see it (R3, viewableStatusId), or null; whether it has a live poll is
// for the caller's read of it (presentPolls, votedPoll) to say.
function viewablePoll(db: Db, viewerId: string | null, id: string): string | null {
  const statusId = resolveApiId(db, "statuses", id);
  return statusId === null ? null : viewableStatusId(db, viewerId, statusId);
}

// GET /api/v1/polls/:id: the poll, if the viewer may see its status (Api::V1::PollsController authorizes
// StatusPolicy#show?); otherwise not found.
export const getPoll = optionalUserReadOperation<{ id: string; present: Present }, Poll | null>(
  (db, { id, present }, { accountId, now }) => {
    const pollId = viewablePoll(db, accountId, id);
    return pollId === null ? null : presentPoll(db, pollId, accountId, now, present.origin);
  },
);

// ---- Voting.

export type VoteResult =
  | { status: "ok"; value: Poll }
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "missing" }
  | { status: "invalid"; error: string };

type VotedPoll = {
  status_id: string;
  status_uri: string;
  author_id: string;
  author_uri: string;
  local: number;
  options: string[];
  multiple: number;
  hide_totals: number;
  expires_at: string | null;
  ended: number;
  generation: number;
  cut_options: number[];
};

// Expireable#expired?: a poll has ended once its end has passed (expires_at < now), the boundary every read, vote and
// round uses.
function hasEnded(expiresAt: string | null, now: string): boolean {
  return expiresAt !== null && expiresAt < now;
}

// A choice as Ruby's Integer() reads a decimal one; anything else is no choice of the poll.
function choiceOf(value: string): number {
  return /^[+-]?\d{1,9}$/.test(value.trim()) ? Number(value.trim()) : -1;
}

// VoteValidator's errors for one more vote in `choice`, given the voter's votes so far: the poll ended, a choice it does
// not have, the author's own poll, or a vote again (any in a single-choice poll, the same choice in a multiple one).
function voteErrors(poll: VotedPoll, voterId: string, choice: number, votes: number[], now: string): string[] {
  const errors: string[] = [];
  // A poll the cron has ended stays ended, whatever end a later Update names.
  if (poll.ended === 1 || hasEnded(poll.expires_at, now)) {
    errors.push("The poll has already ended");
  }
  // A remote choice cut to MAX_REMOTE_OPTION_LENGTH: its name would match nothing on its server.
  if (choice < 0 || choice >= poll.options.length || poll.cut_options.includes(choice)) {
    errors.push("The chosen vote option does not exist");
  }
  if (voterId === poll.author_id) {
    errors.push("You cannot vote in your own polls");
  }
  if (poll.multiple === 1 ? votes.includes(choice) : votes.length > 0) {
    errors.push("You have already voted on this poll");
  }
  return errors;
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
  now: number,
) {
  const ids: string[] = [];
  for (const choice of choices) {
    const row = db.first<{ id: string }>(
      `INSERT INTO poll_votes (poll_id, generation, account_id, choice, uri, created_at)
			VALUES (?1, (SELECT generation FROM polls WHERE status_id = ?1), ?2, ?3, ?4, ?5)
			RETURNING CAST(id AS TEXT) AS id`,
      pollId,
      voterId,
      choice,
      uri,
      iso(now),
    );
    if (row === undefined) {
      throw new Error("the vote was not written");
    }
    ids.push(row.id);
    db.run(
      `UPDATE polls SET tallies = json_set(tallies, ?2, json_extract(tallies, ?2) + 1), votes_count = votes_count + 1
			WHERE status_id = ?1`,
      pollId,
      `$[${String(Math.trunc(choice))}]`,
    );
  }
  if (first) {
    db.run("UPDATE polls SET voters_count = voters_count + 1 WHERE status_id = ? AND voters_count IS NOT NULL", pollId);
  }
  return ids;
}

// DistributePollUpdateWorker.perform_in(3.minutes): the Update of a local poll's counts, unless it hides them, falls due
// a while after the first vote since the last one sent, and carries every vote cast until then.
function updateSoon(db: Db, poll: VotedPoll, now: number): void {
  if (poll.local === 1 && poll.hide_totals === 0) {
    db.run(
      "UPDATE polls SET update_due_at = COALESCE(update_due_at, ?) WHERE status_id = ?",
      iso(now + UPDATE_DELAY_MS),
      poll.status_id,
    );
  }
}

// The live poll `pollId` with its choices and cut choices read once.
function votedPoll(db: Db, pollId: string): VotedPoll | undefined {
  const row = db.first<Omit<VotedPoll, "options" | "cut_options"> & { options: string; cut_options: string }>(
    `SELECT p.status_id, s.uri AS status_uri, s.account_id AS author_id, a.uri AS author_uri, a.domain IS NULL AS local,
			p.options, p.multiple, p.hide_totals, p.expires_at, p.ended, p.generation, p.cut_options
		FROM polls p JOIN statuses s ON s.id = p.status_id JOIN accounts a ON a.id = s.account_id
		WHERE p.status_id = ? AND p.removed = 0`,
    pollId,
  );
  return row === undefined
    ? undefined
    : { ...row, options: JSON.parse(row.options) as string[], cut_options: JSON.parse(row.cut_options) as number[] };
}

function mayVote(db: Db, voterId: string, statusId: string): boolean {
  return (
    db.first(`SELECT 1 AS x FROM statuses s WHERE s.id = ?2 AND ${mayVoteSql("s", "?1")}`, voterId, statusId) !==
    undefined
  );
}

// POST /api/v1/polls/:id/votes (VoteService): a poll on a status the viewer may not see is not found; one whose
// author either blocks the other refuses the vote (PollPolicy#vote?, R27). The choices are validated one after the
// other, as VoteService creates them in one transaction: the first that fails refuses them all with its errors. A vote
// in a local poll is counted and its Update falls due; one in a remote poll is counted here too and delivered to the
// poll's author, a Create of a Note per choice.
export const vote = userWriteOperation<{ id: string; choices: string[]; now: number; present: Present }, VoteResult>(
  (db, input, { accountId }) => {
    const pollId = viewablePoll(db, accountId, input.id);
    const poll = pollId === null ? undefined : votedPoll(db, pollId);
    if (pollId === null || poll === undefined) {
      return { status: "not_found" };
    }
    // The poll is found before choices are required (Polls::VotesController's set_poll, then params.require), and
    // the vote authorized after (VoteService).
    if (input.choices.length === 0) {
      return { status: "missing" };
    }
    if (!mayVote(db, accountId, pollId)) {
      return { status: "forbidden" };
    }
    const now = iso(input.now);
    const before = db
      .all<{ choice: number }>(
        "SELECT choice FROM poll_votes WHERE poll_id = ? AND generation = ? AND account_id = ?",
        pollId,
        poll.generation,
        accountId,
      )
      .map((row) => row.choice);
    const votes = [...before];
    const choices: number[] = [];
    for (const raw of input.choices) {
      const choice = choiceOf(raw);
      const errors = voteErrors(poll, accountId, choice, votes, now);
      if (errors.length > 0) {
        return { status: "invalid", error: `Validation failed: ${errors.join(", ")}` };
      }
      votes.push(choice);
      choices.push(choice);
    }
    const ids = countVotes(db, pollId, accountId, choices, before.length === 0, null, input.now);
    if (poll.local === 1) {
      updateSoon(db, poll, input.now);
    } else {
      const actorUri = db.first<{ uri: string }>("SELECT uri FROM accounts WHERE id = ?", accountId)?.uri ?? "";
      choices.forEach((choice, i) => {
        recordOutbound(
          db,
          accountId,
          voteActivity({
            voteUri: `${actorUri}#votes/${ids[i] ?? ""}`,
            actorUri,
            name: poll.options[choice] ?? "",
            statusUri: poll.status_uri,
            authorUri: poll.author_uri,
            authorId: poll.author_id,
          }),
          input.now,
        );
      });
    }
    const value = presentPoll(db, pollId, accountId, now, input.present.origin);
    return value === null ? { status: "not_found" } : { status: "ok", value };
  },
);

export type RemoteVote = { voterId: string; statusId: string; name: string; uri: string; now: number };

// ActivityPub::Activity::Create#poll_vote!: a remote account's vote, a Note naming a choice in reply to a local poll. It
// counts when the poll is open and has the choice, the voter may vote (R27: Mastodon does not check), and has not voted
// yet (in a multiple poll, not for that choice). Whether it was counted; a vote never becomes a status either way.
export function receiveVote(db: Db, input: RemoteVote): boolean {
  const poll = votedPoll(db, input.statusId);
  if (poll === undefined || poll.local !== 1) {
    return false;
  }
  const choice = poll.options.indexOf(input.name);
  if (choice < 0 || !mayVote(db, input.voterId, poll.status_id)) {
    return false;
  }
  const votes = db
    .all<{ choice: number }>(
      "SELECT choice FROM poll_votes WHERE poll_id = ? AND generation = ? AND account_id = ?",
      poll.status_id,
      poll.generation,
      input.voterId,
    )
    .map((row) => row.choice);
  if (voteErrors(poll, input.voterId, choice, votes, iso(input.now)).length > 0) {
    return false;
  }
  countVotes(db, poll.status_id, input.voterId, [choice], votes.length === 0, input.uri, input.now);
  updateSoon(db, poll, input.now);
  return true;
}

// Whether the status `statusId` is local and has, or had, a poll: a Note naming a choice in reply to it is a vote,
// never a status. A poll an edit removed keeps its row (removed), so a vote that arrives late is still one
// (receiveVote, which counts in live polls only, then drops it).
export function isLocalPoll(db: Db, statusId: string): boolean {
  return (
    db.first(
      `SELECT 1 AS x FROM polls p JOIN statuses s ON s.id = p.status_id JOIN accounts a ON a.id = s.account_id
			WHERE p.status_id = ? AND a.domain IS NULL`,
      statusId,
    ) !== undefined
  );
}

// ---- A remote poll (remote-statuses.ts), as ActivityPub::Parser::PollParser reads a Question.

export type RemotePollInput = {
  options: string[];
  tallies: number[];
  multiple: boolean;
  // The end the Question names (closed, else endTime); closedNow: closed without a time, which ends it when received.
  expiresAt: string | null;
  closedNow: boolean;
  votersCount: number | null;
  // The indexes of the choices cut to MAX_REMOTE_OPTION_LENGTH.
  cut: number[];
};

// Whether `poll` changes the choices or the multiple of the stored poll of `statusId`, or adds or removes one
// (PollParser#significantly_changes?): such a change is an edit of the status, and drops the votes cast.
export function remotePollChanges(db: Db, statusId: string, poll: RemotePollInput | null): boolean {
  const previous = db.first<{ options: string; multiple: number; cut_options: string }>(
    "SELECT options, multiple, cut_options FROM polls WHERE status_id = ? AND removed = 0",
    statusId,
  );
  if (previous === undefined || poll === null) {
    return (previous === undefined) !== (poll === null);
  }
  // Which choices were cut is part of the choices: a choice lengthened past the cut keeps its stored title, but is
  // another choice on its server.
  return (
    previous.options !== JSON.stringify(poll.options) ||
    previous.multiple !== (poll.multiple ? 1 : 0) ||
    previous.cut_options !== JSON.stringify(poll.cut)
  );
}

// Writes or refreshes the poll of a remote status as ProcessStatusUpdateService#update_poll! does. With `significant`
// (a new status, or an Update newer than the stored version), anything: a new poll, new choices or a new multiple
// (which drop the votes cast, Poll#reset_votes!), or no poll any more. Otherwise (an implicit update, such as the
// Update of counts Mastodon's DistributePollUpdateWorker sends) only the counts, the end and the voters of a poll whose
// choices stay. Whether anything was written. A poll whose end has been handled is never ended again.
export function storeRemotePoll(
  db: Db,
  statusId: string,
  poll: RemotePollInput | null,
  significant: boolean,
  now: number,
): boolean {
  const row = db.first<{ removed: number }>("SELECT removed FROM polls WHERE status_id = ?", statusId);
  const exists = row !== undefined;
  const live = row?.removed === 0;
  const changes = remotePollChanges(db, statusId, poll);
  if (changes && !significant) {
    return false;
  }
  if (poll === null) {
    if (live) {
      resetPoll(db, statusId, true);
    }
    return live;
  }
  const options = JSON.stringify(poll.options);
  const tallies = JSON.stringify(poll.tallies);
  const votes = poll.tallies.reduce((sum, n) => sum + n, 0);
  const expiresAt = poll.closedNow ? iso(now) : poll.expiresAt;
  if (!exists) {
    db.run(
      `INSERT INTO polls (status_id, options, tallies, multiple, expires_at, votes_count, voters_count, created_at,
				cut_options)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      statusId,
      options,
      tallies,
      poll.multiple ? 1 : 0,
      expiresAt,
      votes,
      poll.votersCount,
      iso(now),
      JSON.stringify(poll.cut),
    );
    return true;
  }
  if (changes && live) {
    resetPoll(db, statusId, false);
  }
  return (
    db.run(
      `UPDATE polls SET options = ?2, multiple = ?3, tallies = ?4, votes_count = ?5, voters_count = ?6, expires_at = ?7,
				removed = 0, ended = CASE WHEN removed = 1 THEN 0 ELSE ended END, cut_options = ?8
			WHERE status_id = ?1 AND (removed = 1 OR options IS NOT ?2 OR multiple IS NOT ?3 OR tallies IS NOT ?4
				OR voters_count IS NOT ?6 OR expires_at IS NOT ?7 OR cut_options IS NOT ?8)`,
      statusId,
      options,
      poll.multiple ? 1 : 0,
      tallies,
      votes,
      poll.votersCount,
      expiresAt,
      JSON.stringify(poll.cut),
    ) > 0
  );
}

// ---- Purges (inbox.ts): votes go in bounded batches, so a status or account with many never deletes them at once.

// Deletes at most `limit` votes of the poll of `statusId`; how many.
export function deletePollVotes(db: Db, statusId: string, limit: number): number {
  return limit <= 0
    ? 0
    : writeEach(
        db,
        {
          ids: `SELECT CAST(id AS TEXT) AS id FROM poll_votes INDEXED BY ${POLL_VOTES_KEY_INDEX} WHERE poll_id = ?1 LIMIT ?2`,
          each: "DELETE FROM poll_votes WHERE id = CAST(?1 AS INTEGER)",
        },
        statusId,
        limit,
      );
}

// Deletes at most `limit` votes of the account `accountId` (counts stay, as Mastodon keeps a poll's cached tallies).
export function deleteAccountVotes(db: Db, accountId: string, limit: number): number {
  return limit <= 0
    ? 0
    : writeEach(
        db,
        {
          ids: "SELECT CAST(id AS TEXT) AS id FROM poll_votes INDEXED BY poll_votes_account WHERE account_id = ?1 LIMIT ?2",
          each: "DELETE FROM poll_votes WHERE id = CAST(?1 AS INTEGER)",
        },
        accountId,
        limit,
      );
}

export function hasPollVotes(db: Db, by: { statusId?: string; accountId?: string }): boolean {
  return (
    db.first(
      `SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM poll_votes INDEXED BY ${POLL_VOTES_KEY_INDEX} WHERE poll_id = ?1)
				OR EXISTS (SELECT 1 FROM poll_votes INDEXED BY poll_votes_account WHERE account_id = ?2)`,
      by.statusId ?? null,
      by.accountId ?? null,
    ) !== undefined
  );
}

// ---- The cron's rounds (jobs/scheduled.ts).

function recordPollUpdate(db: Db, statusId: string, authorId: string, now: number): void {
  const facts = statusFacts(db, statusId);
  if (facts !== null) {
    recordOutbound(db, authorId, pollUpdateActivity(facts, now), now);
  }
}

export type PollRound = { ended: number; updated: number; swept: number };

// At most this many votes of past generations are deleted per cron run (RES-6).
export const STALE_SWEEP = 500;

// One round of the cron (RES-6), at most POLL_ROUND polls of each kind, each through its partial index:
//   - polls that have ended (PollExpirationNotifyWorker): the author of a local one and the local voters of any are
//     notified ('poll', from the poll's author; the notification rule applies), and a local one's Update carries its
//     end and final counts. Each is marked ended in the same transaction, so it is notified once.
//   - local polls whose Update of counts is due (DistributePollUpdateWorker): one Update each, to the status's audience
//     and the remote voters; an Update supersedes the earlier ones still waiting (deliveries.ts).
//   - votes of past generations (a reset or a removal by an edit): at most STALE_SWEEP (sweepStaleVotes).
// A poll of a withdrawn status (its Delete recorded, statuses.withdrawn) only leaves its index: nobody is notified of
// it and no Update of it is recorded, which its Delete would have to follow.
export const pollRound = writeOperation<{ now: number }, PollRound>((db, { now }) => {
  const at = iso(now);
  const ending = db.all<{ status_id: string; author_id: string; local: number; withdrawn: number }>(
    `SELECT p.status_id, s.account_id AS author_id, a.domain IS NULL AS local, s.withdrawn
		FROM (SELECT status_id FROM polls WHERE ended = 0 AND expires_at IS NOT NULL AND expires_at < ?1
			ORDER BY expires_at LIMIT ?2) e
		JOIN polls p ON p.status_id = e.status_id JOIN statuses s ON s.id = p.status_id JOIN accounts a ON a.id = s.account_id`,
    at,
    POLL_ROUND,
  );
  for (const poll of ending) {
    db.run("UPDATE polls SET ended = 1, update_due_at = NULL WHERE status_id = ?", poll.status_id);
    if (poll.withdrawn === 1) {
      continue;
    }
    if (poll.local === 1) {
      notify(db, { recipientId: poll.author_id, type: "poll", fromId: poll.author_id, statusId: poll.status_id, now });
      recordPollUpdate(db, poll.status_id, poll.author_id, now);
    }
    const voters = db.all<{ account_id: string }>(
      `SELECT DISTINCT v.account_id FROM polls p
				JOIN poll_votes v ON v.poll_id = p.status_id AND v.generation = p.generation
				JOIN local_accounts l ON l.account_id = v.account_id
			WHERE p.status_id = ?`,
      poll.status_id,
    );
    for (const voter of voters) {
      notify(db, {
        recipientId: voter.account_id,
        type: "poll",
        fromId: poll.author_id,
        statusId: poll.status_id,
        now,
      });
    }
  }
  const due = db.all<{ status_id: string; author_id: string; withdrawn: number }>(
    `SELECT p.status_id, s.account_id AS author_id, s.withdrawn
		FROM (SELECT status_id FROM polls WHERE update_due_at IS NOT NULL AND update_due_at <= ?1
			ORDER BY update_due_at LIMIT ?2) d
		JOIN polls p ON p.status_id = d.status_id JOIN statuses s ON s.id = p.status_id`,
    at,
    POLL_ROUND,
  );
  for (const poll of due) {
    db.run("UPDATE polls SET update_due_at = NULL WHERE status_id = ?", poll.status_id);
    if (poll.withdrawn === 0) {
      recordPollUpdate(db, poll.status_id, poll.author_id, now);
    }
  }
  return { ended: ending.length, updated: due.length, swept: sweepStaleVotes(db, STALE_SWEEP) };
});
