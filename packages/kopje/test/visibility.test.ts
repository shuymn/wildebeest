import { describe, expect, it } from "vitest";

import { sql } from "./api-helpers";
import {
  act,
  block,
  community,
  domainBlock,
  follow,
  getJson,
  ids,
  mute,
  post,
  remoteAccount,
  remoteFollows,
  seedStatus,
  type Status,
} from "./status-helpers";

// Negative tests for every read path: a private, direct or limited status never reaches a viewer who may not see it
// (Mastodon's StatusPolicy#show?), and statuses of accounts the viewer blocks or mutes stay out of lists
// (StatusFilter, FeedManager#filter_from_home). The cast:
//   alice  posts public, private and direct (to dave) statuses, all tagged #secret
//   bob    follows alice and rem; addressed by nothing
//   carol  a stranger to alice; follows rem; a silent recipient of rem's limited status
//   dave   follows alice and rem; mentioned by alice's direct status and addressed by rem's limited status
//   rem    a remote account whose limited status (Misskey specified) addresses dave and, silently, carol
async function world() {
  const h = await community(["alice", "bob", "carol", "dave"]);
  const { alice, bob, carol, dave } = h.users;
  const rem = await remoteAccount(h.store, "rem", "remote.example");
  await follow(h, bob, alice.id);
  await follow(h, dave, alice.id);
  for (const follower of [bob, carol, dave]) {
    await remoteFollows(h.store, follower.id, rem);
  }
  const pub = await post(h, alice, { status: "public #secret" });
  const priv = await post(h, alice, { status: "private #secret", visibility: "private" });
  const dm = await post(h, alice, { status: "@dave direct #secret", visibility: "direct" });
  const limited = await seedStatus(h.store, {
    accountId: rem,
    visibility: "limited",
    mentions: [{ accountId: dave.id }, { accountId: carol.id, silent: true }],
    tags: ["secret"],
  });
  return { h, alice, bob, carol, dave, rem, pub: pub.id, priv: priv.id, dm: dm.id, limited };
}

describe("visibility on every read path", () => {
  it("home: followers get private, only the addressed (silent included) get direct and limited", async () => {
    const w = await world();
    // bob follows rem but is not addressed by the limited status: a follower who was not addressed never sees it.
    expect(await ids(w.h, "/api/v1/timelines/home", w.bob.token)).toEqual([w.priv, w.pub]);
    expect(await ids(w.h, "/api/v1/timelines/home", w.carol.token)).toEqual([w.limited]);
    expect(await ids(w.h, "/api/v1/timelines/home", w.dave.token)).toEqual(
      [w.limited, w.dm, w.priv, w.pub].sort().reverse(),
    );
    expect(await ids(w.h, "/api/v1/timelines/home", w.alice.token)).toEqual([w.dm, w.priv, w.pub]);
  });

  it("public and tag timelines: public only, for everyone", async () => {
    const w = await world();
    for (const token of [undefined, w.alice.token, w.bob.token, w.dave.token]) {
      expect(await ids(w.h, "/api/v1/timelines/public", token)).toEqual([w.pub]);
      expect(await ids(w.h, "/api/v1/timelines/tag/secret", token)).toEqual([w.pub]);
      expect(await ids(w.h, "/api/v1/timelines/public?remote=true", token)).toEqual([]);
    }
  });

  it("account statuses: permitted_for the viewer", async () => {
    const w = await world();
    const alice = `/api/v1/accounts/${w.alice.id}/statuses`;
    expect(await ids(w.h, alice)).toEqual([w.pub]);
    expect(await ids(w.h, alice, w.carol.token)).toEqual([w.pub]);
    expect(await ids(w.h, alice, w.bob.token)).toEqual([w.priv, w.pub]);
    expect(await ids(w.h, alice, w.dave.token)).toEqual([w.dm, w.priv, w.pub]);
    const rem = `/api/v1/accounts/${w.rem}/statuses`;
    expect(await ids(w.h, rem, w.bob.token)).toEqual([]);
    expect(await ids(w.h, rem, w.dave.token)).toEqual([w.limited]);
    expect(await ids(w.h, rem, w.carol.token)).toEqual([w.limited]);
  });

  it("GET /statuses/:id, /context, /history, /source and /favourited_by: 404 to whoever may not see it", async () => {
    const w = await world();
    const hidden: [string, (string | undefined)[]][] = [
      [w.priv, [undefined, w.carol.token]],
      [w.dm, [undefined, w.bob.token, w.carol.token]],
      [w.limited, [undefined, w.bob.token, w.alice.token]],
    ];
    for (const [id, tokens] of hidden) {
      for (const token of tokens) {
        for (const path of ["", "/context", "/history", "/favourited_by", "/reblogged_by"]) {
          expect({ path, id, status: (await getJson(w.h, `/api/v1/statuses/${id}${path}`, token)).status }).toEqual({
            path,
            id,
            status: 404,
          });
        }
        if (token !== undefined) {
          expect((await getJson(w.h, `/api/v1/statuses/${id}/source`, token)).status).toBe(404);
        }
      }
    }
    // The silent recipient sees the limited status, but is not listed among its mentions.
    const silent = await getJson<Status>(w.h, `/api/v1/statuses/${w.limited}`, w.carol.token);
    expect(silent.status).toBe(200);
    expect(silent.body).toMatchObject({ visibility: "private", mentions: [{ id: w.dave.id }] });
  });

  it("context: replies the viewer may not see are left out, the thread goes on past them", async () => {
    const w = await world();
    const { h, alice, bob, carol, dave } = w;
    const privateReply = await post(h, alice, { status: "members only", in_reply_to_id: w.pub, visibility: "private" });
    const publicUnderPrivate = await post(h, bob, { status: "public", in_reply_to_id: privateReply.id });
    const directReply = await post(h, alice, { status: "@dave hi", in_reply_to_id: w.pub, visibility: "direct" });
    const context = async (token?: string) =>
      (await getJson<{ descendants: Status[] }>(h, `/api/v1/statuses/${w.pub}/context`, token)).body.descendants.map(
        (s) => s.id,
      );
    expect(await context(carol.token)).toEqual([publicUnderPrivate.id]);
    expect(await context()).toEqual([publicUnderPrivate.id]);
    expect(await context(bob.token)).toEqual([privateReply.id, publicUnderPrivate.id]);
    expect(await context(dave.token)).toEqual([privateReply.id, publicUnderPrivate.id, directReply.id]);
    const ancestors = await getJson<{ ancestors: Status[] }>(
      h,
      `/api/v1/statuses/${publicUnderPrivate.id}/context`,
      carol.token,
    );
    expect(ancestors.body.ancestors.map((s) => s.id)).toEqual([w.pub]);
  });

  it("notifications: none for what the recipient may not see, and none for a silent recipient", async () => {
    const w = await world();
    const { h, alice, bob, carol } = w;
    // A boost of a private status is refused, so it cannot notify; a mention in a direct status reaches dave only.
    expect((await act(h, bob, `/api/v1/statuses/${w.priv}/reblog`)).status).toBe(403);
    expect((await getJson<unknown[]>(h, "/api/v1/notifications", carol.token)).body).toEqual([]);
    expect(
      (await getJson<{ type: string }[]>(h, "/api/v1/notifications", w.dave.token)).body.map((n) => n.type),
    ).toEqual(["mention"]);
    // carol is mentioned in a private status, then the author blocks her: the notification goes away.
    await post(h, alice, { status: "@carol psst", visibility: "private" });
    expect((await getJson<unknown[]>(h, "/api/v1/notifications", carol.token)).body).toHaveLength(1);
    await block(h.store, alice.id, carol.id);
    expect((await getJson<unknown[]>(h, "/api/v1/notifications", carol.token)).body).toEqual([]);
  });

  it("bookmarks and favourites: a status that is no longer visible is not listed", async () => {
    const w = await world();
    const { h, alice, bob } = w;
    await act(h, bob, `/api/v1/statuses/${w.priv}/bookmark`);
    await act(h, bob, `/api/v1/statuses/${w.priv}/favourite`);
    expect(await ids(h, "/api/v1/bookmarks", bob.token)).toEqual([w.priv]);
    expect(await ids(h, "/api/v1/favourites", bob.token)).toEqual([w.priv]);
    await act(h, bob, `/api/v1/accounts/${alice.id}/unfollow`);
    expect(await ids(h, "/api/v1/bookmarks", bob.token)).toEqual([]);
    expect(await ids(h, "/api/v1/favourites", bob.token)).toEqual([]);
    // Nor can it be bookmarked or favourited now.
    expect((await act(h, bob, `/api/v1/statuses/${w.priv}/bookmark`)).status).toBe(404);
    expect((await act(h, bob, `/api/v1/statuses/${w.dm}/favourite`)).status).toBe(404);
  });

  it("an author who blocks the viewer hides even public statuses everywhere", async () => {
    const w = await world();
    const { h, alice, carol } = w;
    await block(h.store, alice.id, carol.id);
    expect((await getJson(h, `/api/v1/statuses/${w.pub}`, carol.token)).status).toBe(404);
    expect(await ids(h, "/api/v1/timelines/public", carol.token)).toEqual([]);
    expect(await ids(h, "/api/v1/timelines/tag/secret", carol.token)).toEqual([]);
    expect(await ids(h, `/api/v1/accounts/${alice.id}/statuses`, carol.token)).toEqual([]);
    expect((await act(h, carol, `/api/v1/statuses/${w.pub}/favourite`)).status).toBe(404);
  });
});

describe("nothing leaks through what a status points to", () => {
  it("a boost of an original the viewer may not see is hidden with it", async () => {
    const h = await community(["viewer"]);
    const author = await remoteAccount(h.store, "author", "one.example");
    const booster = await remoteAccount(h.store, "booster", "two.example");
    await remoteFollows(h.store, h.users.viewer.id, booster);
    const original = await seedStatus(h.store, { accountId: author, visibility: "private" });
    const boost = await seedStatus(h.store, { accountId: booster, visibility: "public", reblogOfId: original });
    for (const token of [undefined, h.users.viewer.token]) {
      expect((await getJson(h, `/api/v1/statuses/${boost}`, token)).status).toBe(404);
      expect((await getJson(h, `/api/v1/statuses/${boost}/favourited_by`, token)).status).toBe(404);
      expect(await ids(h, `/api/v1/accounts/${booster}/statuses`, token)).toEqual([]);
    }
    expect(await ids(h, "/api/v1/timelines/home", h.users.viewer.token)).toEqual([]);
  });

  it("favourited_by and reblogged_by leave out accounts the viewer blocks, is blocked by, mutes or domain-blocks", async () => {
    const h = await community(["viewer", "author", "muted", "blocker"]);
    const { viewer, author, muted, blocker } = h.users;
    const far = await remoteAccount(h.store, "far", "far.example");
    const status = await post(h, author, { status: "x" });
    for (const fan of [muted, blocker]) {
      await act(h, fan, `/api/v1/statuses/${status.id}/favourite`);
      await act(h, fan, `/api/v1/statuses/${status.id}/reblog`);
    }
    await sql(h.store, "INSERT INTO favourites (account_id, status_id) VALUES (?, ?)", far, status.id);
    await seedStatus(h.store, { accountId: far, visibility: "public", reblogOfId: status.id });
    await mute(h.store, viewer.id, muted.id);
    await block(h.store, blocker.id, viewer.id);
    await domainBlock(h.store, viewer.id, "far.example");
    for (const path of ["favourited_by", "reblogged_by"]) {
      expect(await ids(h, `/api/v1/statuses/${status.id}/${path}`, viewer.token)).toEqual([]);
      expect(await ids(h, `/api/v1/statuses/${status.id}/${path}`)).toHaveLength(3);
    }
  });
});

describe("blocked and muted accounts stay out of lists", () => {
  async function setup() {
    const h = await community(["viewer", "friend", "muted", "blocked"]);
    const { viewer, friend, muted, blocked } = h.users;
    for (const id of [friend.id, muted.id, blocked.id]) {
      await follow(h, viewer, id);
    }
    const fromMuted = await post(h, muted, { status: "muted #t" });
    const fromBlocked = await post(h, blocked, { status: "blocked #t" });
    const fromFriend = await post(h, friend, { status: "friend #t" });
    // friend boosts both; the boosts must be filtered too.
    await act(h, friend, `/api/v1/statuses/${fromMuted.id}/reblog`);
    await act(h, friend, `/api/v1/statuses/${fromBlocked.id}/reblog`);
    await act(h, viewer, `/api/v1/statuses/${fromMuted.id}/bookmark`);
    await act(h, viewer, `/api/v1/statuses/${fromBlocked.id}/bookmark`);
    await act(h, muted, `/api/v1/statuses/${fromFriend.id}/favourite`);
    await act(h, blocked, `/api/v1/statuses/${fromFriend.id}/favourite`);
    await act(h, friend, `/api/v1/statuses/${fromFriend.id}/favourite`);
    const mutedReply = await post(h, muted, { status: "reply", in_reply_to_id: fromFriend.id });
    const blockedReply = await post(h, blocked, { status: "reply", in_reply_to_id: fromFriend.id });
    await post(h, muted, { status: "@viewer hi" });
    await post(h, blocked, { status: "@viewer hi" });
    await mute(h.store, viewer.id, muted.id);
    await block(h.store, viewer.id, blocked.id);
    return { h, ...h.users, fromMuted, fromBlocked, fromFriend, mutedReply, blockedReply };
  }

  it("home, public, tag and the boosting account’s statuses", async () => {
    const s = await setup();
    const token = s.viewer.token;
    for (const path of ["/api/v1/timelines/home", "/api/v1/timelines/public", "/api/v1/timelines/tag/t"]) {
      expect({ path, ids: await ids(s.h, path, token) }).toEqual({ path, ids: [s.fromFriend.id] });
    }
    expect(await ids(s.h, `/api/v1/accounts/${s.friend.id}/statuses`, token)).toEqual([s.fromFriend.id]);
  });

  it("context, favourited_by, notifications and bookmarks", async () => {
    const s = await setup();
    const token = s.viewer.token;
    const context = await getJson<{ descendants: Status[] }>(s.h, `/api/v1/statuses/${s.fromFriend.id}/context`, token);
    expect(context.body.descendants).toEqual([]);
    expect(await ids(s.h, `/api/v1/statuses/${s.fromFriend.id}/favourited_by`, token)).toEqual([s.friend.id]);
    expect(await ids(s.h, "/api/v1/notifications", token)).toEqual([]);
    expect(await ids(s.h, "/api/v1/bookmarks", token)).toEqual([]);
    // Anonymous readers have no filters.
    expect(await ids(s.h, `/api/v1/statuses/${s.fromFriend.id}/favourited_by`)).toHaveLength(3);
  });

  it("a mute that keeps notifications still shows them; a domain block hides a remote account", async () => {
    const h = await community(["viewer", "quiet"]);
    const { viewer, quiet } = h.users;
    await post(h, quiet, { status: "@viewer hi" });
    await mute(h.store, viewer.id, quiet.id, false);
    expect(await ids(h, "/api/v1/notifications", viewer.token)).toHaveLength(1);
    const remote = await remoteAccount(h.store, "far", "blocked.example");
    const status = await seedStatus(h.store, { accountId: remote, visibility: "public" });
    await sql(h.store, "UPDATE statuses SET content = '<p>far</p>' WHERE id = ?", status);
    expect(await ids(h, "/api/v1/timelines/public", viewer.token)).toContain(status);
    await domainBlock(h.store, viewer.id, "blocked.example");
    expect(await ids(h, "/api/v1/timelines/public", viewer.token)).not.toContain(status);
    expect((await getJson(h, `/api/v1/statuses/${status}`, viewer.token)).status).toBe(200);
  });
});
