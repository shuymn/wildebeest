import { selectSql } from "../db/columns";
import { ACCOUNTS_ID_INDEX, POLL_VOTES_KEY_INDEX, POLLS_STATUS_INDEX, STATUSES_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { emojiCacheSql, STATUS_EMOJIS_BYTES } from "../platform/stored-bounds";
import { type CustomEmoji, emojiCacheOf, pollEmojis, presentEmojis } from "./custom-emojis";
import { OWN_VOTE_COLUMNS, POLL_COLUMN_MAP } from "./status-rows";

// Polls as status-presenter.ts and polls.ts present them: only counts and the viewer's own votes (R27), never who
// voted.

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
export function presentPoll(
  db: Db,
  statusId: string,
  viewerId: string | null,
  now: string,
  origin: string,
): Poll | null {
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

// Expireable#expired?: a poll has ended once its end has passed (expires_at < now), the boundary every read, vote and
// round uses.
export function hasEnded(expiresAt: string | null, now: string): boolean {
  return expiresAt !== null && expiresAt < now;
}
