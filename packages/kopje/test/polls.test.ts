import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { Db } from "../src/db/sql";
import { EXPANSION_STEP } from "../src/domain/deliveries";
import { deleteStatusBatch, PURGE_BATCH, purgeBatch } from "../src/domain/inbox";
import {
  pollRound,
  STALE_SWEEP,
  MAX_EXPIRATION_S,
  MAX_OPTION_CHARS,
  MAX_OPTIONS,
  MIN_EXPIRATION_S,
  type Poll,
  POLL_ROUND,
  UPDATE_DELAY_MS,
} from "../src/domain/polls";
import { endPolls } from "../src/jobs/scheduled";
import { type ApiHarness, bearer, json, settle, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { BUILD } from "./helpers";
import { remoteAccounts } from "./read-helpers";
import {
  block,
  community,
  follow,
  getJson,
  outbound,
  post,
  remoteAccount,
  remoteFollows,
  seedStatus,
  type Status,
  type User,
} from "./status-helpers";

// Polls (domain/polls.ts, mastodon/polls.ts), as Mastodon 4.5 has them: a poll posted with its status, the Poll entity
// on every status that has one, GET /api/v1/polls/:id and POST /api/v1/polls/:id/votes, editing a status's poll, a
// scheduled status's poll, and the cron's round that ends polls (the 'poll' notification) and sends the debounced
// Update of a local poll's counts.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type PolledStatus = Status & { poll: Poll | null };

const at = (ms: number) => new Date(ms).toISOString();

function send(h: ApiHarness, user: User, path: string, body: Record<string, unknown>, method = "POST") {
  return h.request(path, bearer(user.token, json(body, { method })));
}

async function refusal(response: Response): Promise<{ status: number; body: unknown }> {
  return { status: response.status, body: await response.json() };
}

async function polled(h: ApiHarness, user: User, poll: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return (await post(h, user, { status: "which?", poll, ...extra })) as PolledStatus;
}

async function voteOn(h: ApiHarness, user: User, pollId: string, choices: unknown[]) {
  return send(h, user, `/api/v1/polls/${pollId}/votes`, { choices });
}

function round(h: ApiHarness, now: number, doorbell = vi.fn(() => Promise.resolve())) {
  return endPolls(h.env, { build: () => BUILD, now: () => now, store: () => h.store, doorbell });
}

async function pollNotifications(h: ApiHarness, user: User) {
  const { body } = await getJson<{ type: string; account: { id: string }; status?: { id: string } }[]>(
    h,
    "/api/v1/notifications",
    user.token,
  );
  return body.filter((n) => n.type === "poll").map((n) => ({ from: n.account.id, status: n.status?.id }));
}

describe("posting a poll", () => {
  it("answers the status with its Poll entity, as REST::PollSerializer shows it", async () => {
    const h = await community(["alice"]);
    const status = await polled(h, h.users.alice, { options: [" yes ", "no", ""], expires_in: 3600, multiple: true });
    expect(status.poll).toEqual({
      id: status.id,
      expires_at: at(NOW + HOUR),
      expired: false,
      multiple: true,
      votes_count: 0,
      voters_count: 0,
      options: [
        { title: "yes", votes_count: 0 },
        { title: "no", votes_count: 0 },
      ],
      emojis: [],
      // The author has voted in their own poll as Poll#voted? says, with no votes of their own.
      voted: true,
      own_votes: [],
    });
    // A form sends the same.
    const body = new URLSearchParams([
      ["status", "form"],
      ["poll[options][]", "a"],
      ["poll[options][]", "b"],
      ["poll[expires_in]", "300"],
      ["poll[hide_totals]", "true"],
    ]);
    const response = await h.request(
      "/api/v1/statuses",
      bearer(h.users.alice.token, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
    );
    expect(((await response.json()) as PolledStatus).poll).toMatchObject({
      multiple: false,
      options: [
        { title: "a", votes_count: null },
        { title: "b", votes_count: null },
      ],
    });
  });

  it("refuses a poll Mastodon's Poll refuses, with its messages in its order", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const cases: [Record<string, unknown>, string][] = [
      [{ options: ["a"], expires_in: 300 }, "Choices must have more than one item"],
      [{ options: ["", " "], expires_in: 300 }, "Choices can't be blank, Choices must have more than one item"],
      [{ options: ["a", "b"] }, "Deadline can't be blank"],
      [{ options: ["a", "b", "c", "d", "e"], expires_in: 300 }, `Choices can't contain more than ${MAX_OPTIONS} items`],
      [
        { options: ["a", "x".repeat(MAX_OPTION_CHARS + 1)], expires_in: 300 },
        `Choices cannot be longer than ${MAX_OPTION_CHARS} characters each`,
      ],
      [{ options: ["a", " a"], expires_in: 300 }, "Choices contain duplicate items"],
      [{ options: ["a", "b"], expires_in: MIN_EXPIRATION_S - 1 }, "Deadline is too soon"],
      [{ options: ["a", "b"], expires_in: "soon" }, "Deadline is too soon"],
      [{ options: ["a", "b"], expires_in: MAX_EXPIRATION_S + 1 }, "Deadline is too far into the future"],
    ];
    for (const [poll, message] of cases) {
      const response = await send(h, alice, "/api/v1/statuses", { status: "q", poll });
      expect(await refusal(response), JSON.stringify(poll)).toEqual({
        status: 422,
        body: { error: `Validation failed: ${message}` },
      });
    }
    // A choice of 50 grapheme clusters passes, however many code units they take; the limits pass at their bounds.
    const family = "👨‍👩‍👧".repeat(MAX_OPTION_CHARS);
    await polled(h, alice, { options: ["a", family], expires_in: MIN_EXPIRATION_S });
    await polled(h, alice, { options: ["a", "b", "c", "d"], expires_in: MAX_EXPIRATION_S });
    expect(await sql(h.store, "SELECT count(*) AS n FROM statuses")).toEqual([{ n: 2 }]);
  });

  it("refuses media with a poll as Mastodon does, before anything else", async () => {
    const h = await community(["alice"]);
    const response = await send(h, h.users.alice, "/api/v1/statuses", {
      status: "x".repeat(600),
      media_ids: ["1"],
      poll: { options: ["a"] },
    });
    expect(await refusal(response)).toEqual({ status: 422, body: { error: "Cannot attach more than 4 files" } });
    // An empty poll object is no poll.
    expect((await post(h, h.users.alice, { status: "plain", poll: {} })).poll).toBeNull();
  });
});

describe("the Poll entity", () => {
  it("hides the counts of a poll with hide_totals from everyone, its author included, until it ends", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const status = await polled(h, alice, { options: ["a", "b"], expires_in: 600, hide_totals: true });
    expect((await voteOn(h, bob, status.id, ["1"])).status).toBe(200);
    const seen = async (user: User | null) => (await getJson<Poll>(h, `/api/v1/polls/${status.id}`, user?.token)).body;
    for (const user of [alice, bob, null]) {
      expect((await seen(user)).options).toEqual([
        { title: "a", votes_count: null },
        { title: "b", votes_count: null },
      ]);
      expect(await seen(user)).toMatchObject({ votes_count: 1, voters_count: 1, expired: false });
    }
    h.now.mockReturnValue(NOW + 601_000);
    expect((await seen(bob)).options).toEqual([
      { title: "a", votes_count: 0 },
      { title: "b", votes_count: 1 },
    ]);
    expect(await seen(bob)).toMatchObject({ expired: true, voted: true, own_votes: [1] });
    // Anonymous viewers are not told whether they voted.
    expect(await seen(null)).not.toHaveProperty("voted");
    expect(await seen(null)).not.toHaveProperty("own_votes");
  });

  it("shows the poll on every read of its status: the status, timelines and a boost", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    await follow(h, bob, alice.id);
    const status = await polled(h, alice, { options: ["a", "b"], expires_in: 600 });
    await voteOn(h, bob, status.id, [0]);
    const boost = (await (await send(h, bob, `/api/v1/statuses/${status.id}/reblog`, {})).json()) as PolledStatus;
    expect(boost.poll).toBeNull();
    expect((boost.reblog as PolledStatus).poll).toMatchObject({ own_votes: [0], votes_count: 1 });
    const home = (await getJson<PolledStatus[]>(h, "/api/v1/timelines/home", bob.token)).body;
    expect(home.map((s) => (s.reblog === null ? s.poll : (s.reblog as PolledStatus).poll)?.own_votes)).toEqual([
      [0],
      [0],
    ]);
    const shown = (await getJson<PolledStatus>(h, `/api/v1/statuses/${status.id}`, alice.token)).body;
    expect(shown.poll).toMatchObject({ voted: true, own_votes: [], options: [{ votes_count: 1 }, { votes_count: 0 }] });
  });
});

describe("GET /api/v1/polls/:id", () => {
  it("shows a poll only to whoever may see its status, and is not found otherwise", async () => {
    const h = await community(["alice", "bob", "carol"]);
    const { alice, bob, carol } = h.users;
    await follow(h, bob, alice.id);
    const status = await polled(h, alice, { options: ["a", "b"], expires_in: 600 }, { visibility: "private" });
    expect((await getJson(h, `/api/v1/polls/${status.id}`, bob.token)).status).toBe(200);
    for (const token of [carol.token, undefined]) {
      expect(await getJson(h, `/api/v1/polls/${status.id}`, token)).toEqual({
        status: 404,
        body: { error: "Record not found" },
      });
      expect((await voteOn(h, carol, status.id, [0])).status).toBe(404);
    }
    // A status without a poll, or an unknown id, has none.
    const plain = await post(h, alice, { status: "plain" });
    expect((await getJson(h, `/api/v1/polls/${plain.id}`, alice.token)).status).toBe(404);
    expect((await getJson(h, "/api/v1/polls/123", alice.token)).status).toBe(404);
  });
});

describe("POST /api/v1/polls/:id/votes", () => {
  it("counts a vote, and answers the poll as the voter sees it", async () => {
    const h = await community(["alice", "bob", "carol"]);
    const { alice, bob, carol } = h.users;
    const status = await polled(h, alice, { options: ["a", "b", "c"], expires_in: 600, multiple: true });
    const response = await voteOn(h, bob, status.id, ["0", "2"]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      votes_count: 2,
      voters_count: 1,
      voted: true,
      own_votes: [0, 2],
      options: [{ votes_count: 1 }, { votes_count: 0 }, { votes_count: 1 }],
    });
    // Another choice later in a multiple poll adds a vote, not a voter.
    expect(await (await voteOn(h, bob, status.id, [1])).json()).toMatchObject({ votes_count: 3, voters_count: 1 });
    expect(await (await voteOn(h, carol, status.id, [1])).json()).toMatchObject({ votes_count: 4, voters_count: 2 });
    // Counts are kept, never recounted: they stand however the rows change.
    expect(await sql(h.store, "SELECT tallies, votes_count, voters_count FROM polls")).toEqual([
      { tallies: "[1,2,1]", votes_count: 4, voters_count: 2 },
    ]);
  });

  it("refuses a vote as Mastodon's VoteValidator does, counting nothing", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const single = await polled(h, alice, { options: ["a", "b"], expires_in: 600 });
    const multiple = await polled(h, alice, { options: ["a", "b"], expires_in: 600, multiple: true });
    const invalid = (message: string) => ({ status: 422, body: { error: `Validation failed: ${message}` } });
    expect(await refusal(await voteOn(h, bob, single.id, [0, 1]))).toEqual(
      invalid("You have already voted on this poll"),
    );
    expect(await refusal(await voteOn(h, bob, single.id, [2]))).toEqual(
      invalid("The chosen vote option does not exist"),
    );
    expect(await refusal(await voteOn(h, bob, single.id, ["x"]))).toEqual(
      invalid("The chosen vote option does not exist"),
    );
    expect(await refusal(await voteOn(h, bob, multiple.id, [1, 1]))).toEqual(
      invalid("You have already voted on this poll"),
    );
    expect(await refusal(await voteOn(h, alice, single.id, [0]))).toEqual(invalid("You cannot vote in your own polls"));
    expect(await sql(h.store, "SELECT count(*) AS n FROM poll_votes")).toEqual([{ n: 0 }]);
    expect((await voteOn(h, bob, single.id, [0])).status).toBe(200);
    expect(await refusal(await voteOn(h, bob, single.id, [1]))).toEqual(invalid("You have already voted on this poll"));
    h.now.mockReturnValue(NOW + 601_000);
    expect(await refusal(await voteOn(h, bob, multiple.id, [3]))).toEqual(
      invalid("The poll has already ended, The chosen vote option does not exist"),
    );
    // No choices is a missing parameter, once the poll is found.
    expect(await refusal(await voteOn(h, bob, multiple.id, []))).toEqual({
      status: 400,
      body: { error: "param is missing or the value is empty or invalid: choices" },
    });
    expect((await voteOn(h, bob, "1", [])).status).toBe(404);
    expect(await sql(h.store, "SELECT tallies, votes_count FROM polls ORDER BY status_id")).toEqual([
      { tallies: "[1,0]", votes_count: 1 },
      { tallies: "[0,0]", votes_count: 0 },
    ]);
  });

  it("refuses a voter who blocks the author (R27), and hides the poll from one the author blocks", async () => {
    const h = await community(["alice", "bob", "carol"]);
    const { alice, bob, carol } = h.users;
    const status = await polled(h, alice, { options: ["a", "b"], expires_in: 600 });
    await block(h.store, bob.id, alice.id);
    expect(await refusal(await voteOn(h, bob, status.id, [0]))).toEqual({
      status: 403,
      body: { error: "This action is not allowed" },
    });
    await block(h.store, alice.id, carol.id);
    expect((await voteOn(h, carol, status.id, [0])).status).toBe(404);
    expect((await getJson(h, `/api/v1/polls/${status.id}`, carol.token)).status).toBe(404);
  });

  it("needs a user token with write:statuses", async () => {
    const h = await community(["alice", "bob"], "read");
    const status = await polled(h, h.users.alice, { options: ["a", "b"], expires_in: 600 }).catch(() => null);
    expect(status).toBeNull();
    expect((await voteOn(h, h.users.bob, "1", [0])).status).toBe(403);
  });
});

describe("the end of a poll", () => {
  it("is the same boundary for a vote, the entity and the round: a poll is open at its end and ended after it", async () => {
    const h = await community(["alice", "bob", "carol", "dave"]);
    const { alice, bob, carol, dave } = h.users;
    const status = await polled(h, alice, { options: ["a", "b"], expires_in: 600 });
    const end = NOW + 600_000;
    h.now.mockReturnValue(end - 1);
    expect((await voteOn(h, bob, status.id, [0])).status).toBe(200);
    h.now.mockReturnValue(end);
    const atEnd = await voteOn(h, carol, status.id, [0]);
    expect(atEnd.status).toBe(200);
    expect(await atEnd.json()).toMatchObject({ expired: false });
    await round(h, end);
    expect(await sql(h.store, "SELECT ended FROM polls")).toEqual([{ ended: 0 }]);
    h.now.mockReturnValue(end + 1);
    expect(await refusal(await voteOn(h, dave, status.id, [0]))).toEqual({
      status: 422,
      body: { error: "Validation failed: The poll has already ended" },
    });
    await round(h, end + 1);
    expect(await sql(h.store, "SELECT ended FROM polls")).toEqual([{ ended: 1 }]);
  });

  it("refuses a vote in a poll the cron has ended, whatever its end says now", async () => {
    const h = await community(["alice", "bob"]);
    const status = await polled(h, h.users.alice, { options: ["a", "b"], expires_in: 600 });
    await sql(h.store, "UPDATE polls SET ended = 1");
    expect(await refusal(await voteOn(h, h.users.bob, status.id, [0]))).toEqual({
      status: 422,
      body: { error: "Validation failed: The poll has already ended" },
    });
  });
});

describe("ending a poll", () => {
  it("notifies its author and its local voters once, and the voter's notification names the author", async () => {
    const h = await community(["alice", "bob", "carol"]);
    const { alice, bob, carol } = h.users;
    const status = await polled(h, alice, { options: ["a", "b"], expires_in: 600 });
    await voteOn(h, bob, status.id, [0]);
    await round(h, NOW + 599_000);
    expect(await pollNotifications(h, alice)).toEqual([]);
    const doorbell = vi.fn(() => Promise.resolve());
    await round(h, NOW + 600_001, doorbell);
    await round(h, NOW + 700_000);
    expect(await pollNotifications(h, alice)).toEqual([{ from: alice.id, status: status.id }]);
    expect(await pollNotifications(h, bob)).toEqual([{ from: alice.id, status: status.id }]);
    expect(await pollNotifications(h, carol)).toEqual([]);
    expect(doorbell).toHaveBeenCalledTimes(1);
    expect(await sql(h.store, "SELECT ended, update_due_at FROM polls")).toEqual([{ ended: 1, update_due_at: null }]);
  });

  it("notifies again when a poll that replaced an ended one ends, its own voters only", async () => {
    const h = await community(["alice", "bob", "carol"]);
    const { alice, bob, carol } = h.users;
    const status = await polled(h, alice, { options: ["a", "b"], expires_in: 600 });
    await voteOn(h, bob, status.id, [0]);
    await round(h, NOW + 600_001);
    expect(await pollNotifications(h, bob)).toHaveLength(1);
    h.now.mockReturnValue(NOW + HOUR);
    const edit = (body: Record<string, unknown>) =>
      send(h, alice, `/api/v1/statuses/${status.id}`, { status: "which?", ...body }, "PUT");
    // New choices: the old poll's notifications go with it.
    expect((await edit({ poll: { options: ["c", "d"], expires_in: 600 } })).status).toBe(200);
    expect(await pollNotifications(h, alice)).toEqual([]);
    expect(await pollNotifications(h, bob)).toEqual([]);
    await voteOn(h, carol, status.id, [1]);
    await round(h, NOW + HOUR + 600_001);
    expect(await pollNotifications(h, alice)).toEqual([{ from: alice.id, status: status.id }]);
    expect(await pollNotifications(h, carol)).toEqual([{ from: alice.id, status: status.id }]);
    expect(await pollNotifications(h, bob)).toEqual([]);
    // Removed, then added again: the same once more.
    h.now.mockReturnValue(NOW + 2 * HOUR);
    expect((await edit({})).status).toBe(200);
    expect(await pollNotifications(h, alice)).toEqual([]);
    expect((await edit({ poll: { options: ["e", "f"], expires_in: 600 } })).status).toBe(200);
    await round(h, NOW + 2 * HOUR + 600_001);
    expect(await pollNotifications(h, alice)).toEqual([{ from: alice.id, status: status.id }]);
  });

  it("applies the notification rule: a voter who mutes the author with notifications hears nothing", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const status = await polled(h, alice, { options: ["a", "b"], expires_in: 600 });
    await voteOn(h, bob, status.id, [0]);
    await send(h, bob, `/api/v1/accounts/${alice.id}/mute`, { notifications: true });
    await round(h, NOW + 600_001);
    expect(await pollNotifications(h, bob)).toEqual([]);
    expect(await pollNotifications(h, alice)).toEqual([{ from: alice.id, status: status.id }]);
  });

  it(`ends at most ${POLL_ROUND} polls a run, the earliest first`, async () => {
    const h = await community(["alice"]);
    for (let i = 0; i < POLL_ROUND + 2; i++) {
      await polled(h, h.users.alice, { options: ["a", "b"], expires_in: 600 + i });
    }
    await round(h, NOW + DAY);
    expect(await sql(h.store, "SELECT sum(ended) AS n FROM polls")).toEqual([{ n: POLL_ROUND }]);
    await round(h, NOW + DAY);
    expect(await sql(h.store, "SELECT sum(ended) AS n FROM polls")).toEqual([{ n: POLL_ROUND + 2 }]);
    expect(await pollNotifications(h, h.users.alice)).toHaveLength(POLL_ROUND + 2);
  });
});

describe("the Update of a local poll", () => {
  it("falls due a while after the first vote, carries every vote until then, and is one per round", async () => {
    const h = await community(["alice", "bob", "carol"]);
    const { alice, bob, carol } = h.users;
    await remoteFollows(h.store, await remoteAccount(h.store, "dave"), alice.id);
    const status = await polled(h, alice, { options: ["a", "b"], expires_in: 3600 });
    await voteOn(h, bob, status.id, [0]);
    h.now.mockReturnValue(NOW + MINUTE);
    await voteOn(h, carol, status.id, [1]);
    expect(await sql(h.store, "SELECT update_due_at FROM polls")).toEqual([
      { update_due_at: at(NOW + UPDATE_DELAY_MS) },
    ]);
    const sent = async () => JSON.stringify(await outbound(h.store));
    const before = await sent();
    await round(h, NOW + UPDATE_DELAY_MS - 1);
    expect(await sent()).toBe(before);
    await round(h, NOW + UPDATE_DELAY_MS);
    const after = await sent();
    expect(after).not.toBe(before);
    await round(h, NOW + UPDATE_DELAY_MS + MINUTE);
    expect(await sent()).toBe(after);
    // The Update of a status a server has not received yet goes as a Create of its current version, which replaces
    // the one still waiting (deliveries.ts): either carries the counts.
    const last = (await outbound(h.store)).at(-1);
    expect(last?.activity.object).toMatchObject({
      type: "Question",
      oneOf: [
        { type: "Note", name: "a", replies: { type: "Collection", totalItems: 1 } },
        { type: "Note", name: "b", replies: { type: "Collection", totalItems: 1 } },
      ],
      endTime: at(NOW + HOUR),
      votersCount: 2,
    });
  });

  it("is not sent for a poll that hides its totals until it ends", async () => {
    const h = await community(["alice", "bob"]);
    const status = await polled(h, h.users.alice, { options: ["a", "b"], expires_in: 600, hide_totals: true });
    await voteOn(h, h.users.bob, status.id, [0]);
    expect(await sql(h.store, "SELECT update_due_at FROM polls")).toEqual([{ update_due_at: null }]);
  });
});

describe("editing a status with a poll", () => {
  it("keeps the votes when the choices stay, drops them when they change, and removes a poll not sent", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const status = await polled(h, alice, { options: ["a", "b"], expires_in: 600 });
    await voteOn(h, bob, status.id, [0]);
    const edit = async (body: Record<string, unknown>) => {
      const response = await send(h, alice, `/api/v1/statuses/${status.id}`, { status: "which?", ...body }, "PUT");
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()) as PolledStatus;
    };
    h.now.mockReturnValue(NOW + MINUTE);
    // The same choices: the votes stay, and the end moves to expires_in from the edit.
    const same = await edit({ poll: { options: ["a", "b"], expires_in: 600, hide_totals: true } });
    expect(same.poll).toMatchObject({ votes_count: 1, expires_at: at(NOW + MINUTE + 600_000) });
    expect(same.edited_at).toBe(at(NOW + MINUTE));
    // New choices drop the votes.
    const changed = await edit({ poll: { options: ["a", "c"], expires_in: 600 } });
    expect(changed.poll).toMatchObject({ votes_count: 0, voters_count: 0 });
    expect((await getJson<Poll>(h, `/api/v1/polls/${status.id}`, bob.token)).body).toMatchObject({
      voted: false,
      own_votes: [],
    });
    // No poll removes it; media and a poll together are refused.
    expect((await edit({})).poll).toBeNull();
    const refused = await send(
      h,
      alice,
      `/api/v1/statuses/${status.id}`,
      { status: "x", media_ids: ["1"], poll: { options: ["a", "b"], expires_in: 600 } },
      "PUT",
    );
    expect(await refusal(refused)).toEqual({ status: 422, body: { error: "Cannot attach more than 4 files" } });
    // The history shows each version's choices.
    const history = (await getJson<{ poll: unknown }[]>(h, `/api/v1/statuses/${status.id}/history`, bob.token)).body;
    expect(history.map((entry) => entry.poll)).toEqual([
      { options: [{ title: "a" }, { title: "b" }] },
      { options: [{ title: "a" }, { title: "b" }] },
      { options: [{ title: "a" }, { title: "c" }] },
      null,
    ]);
  });
});

describe("a scheduled status with a poll", () => {
  it("keeps the poll in its params and creates it on publication, ending its duration after", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const response = await send(h, alice, "/api/v1/statuses", {
      status: "later",
      scheduled_at: at(NOW + HOUR),
      poll: { options: ["a", "b"], expires_in: 600, multiple: true },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { params: unknown }).params).toMatchObject({
      poll: { options: ["a", "b"], expires_in: "600", multiple: true, hide_totals: false },
    });
    const { publishScheduled } = await import("../src/jobs/scheduled");
    await publishScheduled(h.env, {
      build: () => BUILD,
      now: () => NOW + HOUR,
      store: () => h.store,
      doorbell: () => Promise.resolve(),
    });
    const statuses = (await getJson<PolledStatus[]>(h, `/api/v1/accounts/${alice.id}/statuses`, alice.token)).body;
    expect(statuses.map((s) => s.poll)).toMatchObject([{ multiple: true, expires_at: at(NOW + HOUR + 600_000) }]);
  });
});

describe("deleting a status with a poll", () => {
  it("deletes the poll and its votes with it", async () => {
    const h = await community(["alice", "bob"]);
    const status = await polled(h, h.users.alice, { options: ["a", "b"], expires_in: 600 });
    await voteOn(h, h.users.bob, status.id, [0]);
    const response = await send(h, h.users.alice, `/api/v1/statuses/${status.id}`, {}, "DELETE");
    expect(((await response.json()) as PolledStatus).poll).toMatchObject({ votes_count: 1 });
    // Ended at once, so no round notifies or updates it; its job deletes it and its votes.
    expect(await sql(h.store, "SELECT ended, update_due_at FROM polls")).toEqual([{ ended: 1, update_due_at: null }]);
    await settle(h.store);
    expect(await sql(h.store, "SELECT (SELECT count(*) FROM polls) + (SELECT count(*) FROM poll_votes) AS n")).toEqual([
      { n: 0 },
    ]);
  });
});

describe("RES-6: votes go in bounded batches with their status and with their account", () => {
  async function batches(h: ApiHarness, run: (db: Db) => boolean): Promise<number[]> {
    const written: number[] = [];
    for (let batch = 0; batch < 20; batch++) {
      const result = await runInDurableObject(h.store, (_instance, state) => {
        const db = new Db(state.storage.sql);
        const changes = () => db.first<{ n: number }>("SELECT total_changes() AS n")!.n;
        const before = changes();
        const pending = state.storage.transactionSync(() => run(db));
        return { pending, changes: changes() - before };
      });
      written.push(result.changes);
      if (!result.pending) {
        return written;
      }
    }
    throw new Error("never finished");
  }

  it("deletes a remote status whose poll has more votes than a batch over several batches, each within the cap", async () => {
    const h = await community(["alice"]);
    const bob = await remoteAccount(h.store, "bob");
    const status = await seedStatus(h.store, { accountId: bob, visibility: "public" });
    await sql(
      h.store,
      `INSERT INTO polls (status_id, options, tallies, votes_count, voters_count) VALUES (?, '["a","b"]', '[700,0]', 700, 700)`,
      status,
    );
    await remoteAccounts(h, 7, 100);
    await sql(
      h.store,
      "INSERT INTO poll_votes (poll_id, account_id, choice) SELECT ?, id, 0 FROM accounts WHERE domain LIKE 'd%.example'",
      status,
    );
    const written = await batches(h, (db) => deleteStatusBatch(db, status, NOW));
    expect(written.length).toBeGreaterThan(1);
    expect(Math.max(...written)).toBeLessThanOrEqual(PURGE_BATCH);
    expect(await sql(h.store, "SELECT (SELECT count(*) FROM polls) + (SELECT count(*) FROM poll_votes) AS n")).toEqual([
      { n: 0 },
    ]);
  });

  it("purges a remote account with more votes than a batch over several batches, keeping the counts", async () => {
    const h = await community(["alice"]);
    const voter = await remoteAccount(h.store, "voter");
    await sql(
      h.store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 699)
			INSERT INTO statuses (id, uri, account_id, visibility, published_at)
			SELECT CAST(600000000000000000 + i AS TEXT), 'https://kopje.test/ap/o/p' || i, ?, 'public', '2026-10-11T00:00:00.000Z' FROM n`,
      h.users.alice.id,
    );
    await sql(
      h.store,
      `INSERT INTO polls (status_id, options, tallies, votes_count, voters_count)
			SELECT id, '["a","b"]', '[1,0]', 1, 1 FROM statuses WHERE account_id = ?`,
      h.users.alice.id,
    );
    await sql(h.store, "INSERT INTO poll_votes (poll_id, account_id, choice) SELECT status_id, ?, 0 FROM polls", voter);
    const uri = (await sql<{ uri: string }>(h.store, "SELECT uri FROM accounts WHERE id = ?", voter))[0]!.uri;
    const written = await batches(h, (db) => purgeBatch(db, uri, NOW));
    expect(written.length).toBeGreaterThan(1);
    expect(Math.max(...written)).toBeLessThanOrEqual(PURGE_BATCH);
    expect(await sql(h.store, "SELECT count(*) AS n FROM poll_votes")).toEqual([{ n: 0 }]);
    expect(await sql(h.store, "SELECT sum(votes_count) AS n FROM polls")).toEqual([{ n: 700 }]);
  });
});

describe("RES-6: an edit that drops the votes of a poll deletes none at once", () => {
  async function withVotes(h: ApiHarness, status: string, count: number) {
    await remoteAccounts(h, 7, Math.ceil(count / 7));
    await sql(
      h.store,
      "INSERT INTO poll_votes (poll_id, account_id, choice) SELECT ?, id, 0 FROM accounts WHERE domain LIKE 'd%.example' LIMIT ?",
      status,
      count,
    );
    await sql(
      h.store,
      "UPDATE polls SET tallies = json_array(?, 0), votes_count = ?, voters_count = ?",
      count,
      count,
      count,
    );
  }

  // Runs the cron's rounds until no vote of a past generation is left, and returns the rows each wrote.
  async function sweep(h: ApiHarness): Promise<number[]> {
    const written: number[] = [];
    for (let i = 0; i < 20; i++) {
      const result = await runInDurableObject(h.store, (_instance, state) => {
        const db = new Db(state.storage.sql);
        const changes = () => db.first<{ n: number }>("SELECT total_changes() AS n")!.n;
        const before = changes();
        const round = state.storage.transactionSync(() => pollRound.run(state.storage.sql, { now: NOW }));
        return { swept: round.swept, changes: changes() - before };
      });
      written.push(result.changes);
      if (result.swept === 0) {
        return written;
      }
    }
    throw new Error("never swept");
  }

  for (const kind of ["changes its choices", "removes it"] as const) {
    it(`${kind}: the votes leave the poll at once and their rows go in bounded rounds`, async () => {
      const h = await community(["alice", "bob"]);
      const { alice, bob } = h.users;
      const status = await polled(h, alice, { options: ["a", "b"], expires_in: 600 });
      await voteOn(h, bob, status.id, [0]);
      await withVotes(h, status.id, 700);
      const body = kind === "removes it" ? {} : { poll: { options: ["a", "c"], expires_in: 600 } };
      const edited = await send(h, alice, `/api/v1/statuses/${status.id}`, { status: "which?", ...body }, "PUT");
      expect(edited.status).toBe(200);
      // Nothing deleted by the edit itself.
      expect(await sql(h.store, "SELECT count(*) AS n FROM poll_votes")).toEqual([{ n: 701 }]);
      const poll = (await getJson<PolledStatus>(h, `/api/v1/statuses/${status.id}`, bob.token)).body.poll;
      if (kind === "removes it") {
        expect(poll).toBeNull();
        expect((await getJson(h, `/api/v1/polls/${status.id}`, bob.token)).status).toBe(404);
      } else {
        expect(poll).toMatchObject({ votes_count: 0, voters_count: 0, voted: false, own_votes: [] });
        // A voter of the dropped generation votes again.
        expect(await (await voteOn(h, bob, status.id, [0])).json()).toMatchObject({ own_votes: [0], votes_count: 1 });
      }
      const written = await sweep(h);
      expect(written.length).toBeGreaterThan(1);
      expect(Math.max(...written)).toBeLessThanOrEqual(STALE_SWEEP + 10);
      expect(await sql(h.store, "SELECT count(*) AS n FROM poll_votes")).toEqual([
        { n: kind === "removes it" ? 0 : 1 },
      ]);
      expect(await sql(h.store, "SELECT stale FROM polls")).toEqual([{ stale: 0 }]);
    });
  }
});

describe("RES-6: the Update of a poll with many remote voters", () => {
  it("names the voters as a part of its audience, and reaches each voter’s inbox in bounded steps", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const status = await polled(h, alice, { options: ["a", "b"], expires_in: 3600 });
    const voters = 700;
    await sql(
      h.store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO accounts (id, uri, username, domain, inbox_url, shared_inbox_url)
			SELECT CAST(600000000000000000 + i AS TEXT), 'https://v' || i || '.example/users/v', 'v', 'v' || i || '.example',
				'https://v' || i || '.example/users/v/inbox', 'https://v' || i || '.example/inbox' FROM n`,
      voters,
    );
    await sql(
      h.store,
      "INSERT INTO poll_votes (poll_id, account_id, choice) SELECT ?, id, 0 FROM accounts WHERE domain LIKE 'v%.example'",
      status.id,
    );
    await sql(h.store, "UPDATE polls SET update_due_at = ?", at(NOW));
    const before = await sql<{ n: number }>(h.store, "SELECT count(*) AS n FROM deliveries");
    const written = await runInDurableObject(h.store, (_instance, state) => {
      const db = new Db(state.storage.sql);
      const changes = () => db.first<{ n: number }>("SELECT total_changes() AS n")!.n;
      const start = changes();
      state.storage.transactionSync(() => pollRound.run(state.storage.sql, { now: NOW }));
      return changes() - start;
    });
    // The intent, its chunks of targets, one expansion step of deliveries and the poll's own row.
    expect(written).toBeLessThanOrEqual(EXPANSION_STEP + Math.ceil(voters / EXPANSION_STEP) + 10);
    // No voter's server has the status yet, so it goes as a Create of the current version (deliveries.ts), to the
    // same audience.
    const sent = (await outbound(h.store)).filter((o) => o.activity.type !== "Create" || o.audience.followers);
    expect(sent.map((o) => o.audience)).toContainEqual({ followers: true, accounts: [], pollVoters: status.id });
    const targets = await sql<{ inbox: string }>(
      h.store,
      `SELECT json_extract(t.value, '$.inbox') AS inbox FROM outbound_targets c, json_each(c.targets) t
			UNION SELECT inbox_url FROM deliveries`,
    );
    const inboxes = new Set(targets.map((t) => t.inbox));
    expect([...Array(voters).keys()].filter((i) => !inboxes.has(`https://v${i}.example/inbox`))).toEqual([]);
    expect((before[0]?.n ?? 0) + EXPANSION_STEP).toBeGreaterThanOrEqual(
      (await sql<{ n: number }>(h.store, "SELECT count(*) AS n FROM deliveries"))[0]?.n ?? 0,
    );
  });

  it("reaches no voter of a followers-only poll as a voter (R23)", async () => {
    const h = await community(["alice"]);
    const status = await polled(h, h.users.alice, { options: ["a", "b"], expires_in: 3600 }, { visibility: "private" });
    const voter = await remoteAccount(h.store, "voter", "voter.example");
    await sql(h.store, "INSERT INTO poll_votes (poll_id, account_id, choice) VALUES (?, ?, 0)", status.id, voter);
    await sql(h.store, "UPDATE polls SET update_due_at = ?", at(NOW));
    await round(h, NOW);
    expect(
      await sql(h.store, "SELECT count(*) AS n FROM deliveries WHERE inbox_url LIKE 'https://voter.example/%'"),
    ).toEqual([{ n: 0 }]);
  });
});
