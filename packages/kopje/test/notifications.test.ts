import { describe, expect, it } from "vitest";

import { bearer, form, seedAccount, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { act, community, follow, getJson, ids, post, type Status } from "./status-helpers";

type Notification = { id: string; type: string; created_at: string; account: { id: string }; status?: Status };

describe("notifications", () => {
  it("notifies mentions, favourites, reblogs and follows in the Mastodon 4.5 shape", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    await follow(h, bob, alice.id);
    const status = await post(h, alice, { status: "hello" });
    await act(h, bob, `/api/v1/statuses/${status.id}/favourite`);
    await act(h, bob, `/api/v1/statuses/${status.id}/reblog`);
    await post(h, bob, { status: "@alice hi" });
    // Mentioning oneself notifies no one.
    await post(h, alice, { status: "@alice me" });
    const { body } = await getJson<Notification[]>(h, "/api/v1/notifications", alice.token);
    expect(body.map((n) => [n.type, n.account.id, n.status?.id === status.id])).toEqual([
      ["mention", bob.id, false],
      ["reblog", bob.id, true],
      ["favourite", bob.id, true],
      ["follow", bob.id, false],
    ]);
    expect(body[3]).toEqual({
      id: expect.stringMatching(/^\d+$/),
      type: "follow",
      created_at: new Date(NOW).toISOString(),
      group_key: `follow-${Math.floor(NOW / 3_600_000)}`,
      account: expect.objectContaining({ id: bob.id, acct: "bob" }),
    });
    expect(body[0]?.status).toMatchObject({ account: { id: bob.id }, favourited: false });
  });

  it("notifies a locked account of a follow request", async () => {
    const h = await community(["alice", "bob"]);
    await sql(h.store, "UPDATE accounts SET locked = 1 WHERE id = ?", h.users.alice.id);
    await follow(h, h.users.bob, h.users.alice.id);
    expect(
      (await getJson<Notification[]>(h, "/api/v1/notifications", h.users.alice.token)).body.map((n) => n.type),
    ).toEqual(["follow_request"]);
    await act(h, h.users.bob, `/api/v1/accounts/${h.users.alice.id}/unfollow`);
    expect((await getJson<Notification[]>(h, "/api/v1/notifications", h.users.alice.token)).body).toEqual([]);
  });

  it("filters by types[], exclude_types[] and account_id", async () => {
    const h = await community(["alice", "bob", "carol"]);
    const { alice, bob, carol } = h.users;
    const status = await post(h, alice, { status: "x" });
    await act(h, bob, `/api/v1/statuses/${status.id}/favourite`);
    await post(h, carol, { status: "@alice hi" });
    await follow(h, carol, alice.id);
    const types = async (query: string) =>
      (await getJson<Notification[]>(h, `/api/v1/notifications${query}`, alice.token)).body.map((n) => n.type);
    expect(await types("")).toEqual(["follow", "mention", "favourite"]);
    expect(await types("?types[]=mention&types[]=follow")).toEqual(["follow", "mention"]);
    expect(await types("?exclude_types[]=follow&exclude_types[]=mention")).toEqual(["favourite"]);
    expect(await types(`?account_id=${bob.id}`)).toEqual(["favourite"]);
    // As Mastodon's `params.permit(types: [])` and Notification.select_types: an empty value matches no type, a
    // scalar is dropped, and an empty excluded type excludes nothing.
    expect(await types("?types[]=")).toEqual([]);
    expect(await types("?types[]=&types[]=mention")).toEqual(["mention"]);
    expect(await types("?types=mention")).toEqual(["follow", "mention", "favourite"]);
    expect(await types("?exclude_types=mention")).toEqual(["follow", "mention", "favourite"]);
    expect(await types("?exclude_types[]=")).toEqual(["follow", "mention", "favourite"]);
    expect(await types("?types[]=bogus")).toEqual([]);
  });

  it("pages with a Link header", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    for (let i = 0; i < 3; i++) {
      await post(h, bob, { status: `@alice ${i}` });
    }
    const all = await ids(h, "/api/v1/notifications", alice.token);
    expect(all).toHaveLength(3);
    const response = await h.request("/api/v1/notifications?limit=2", bearer(alice.token));
    expect(response.headers.get("link")).toContain(`max_id=${all[1]}>; rel="next"`);
    expect(await ids(h, `/api/v1/notifications?max_id=${all[1]}`, alice.token)).toEqual([all[2]]);
    expect(await ids(h, `/api/v1/notifications?min_id=${all[2]}&limit=1`, alice.token)).toEqual([all[1]]);
  });

  it("gets, dismisses and clears only the viewer’s own notifications", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    await post(h, bob, { status: "@alice one" });
    await post(h, bob, { status: "@alice two" });
    const [newest, oldest] = await ids(h, "/api/v1/notifications", alice.token);
    expect((await getJson(h, `/api/v1/notifications/${newest}`, alice.token)).body).toMatchObject({ id: newest });
    expect((await getJson(h, `/api/v1/notifications/${newest}`, bob.token)).status).toBe(404);
    expect((await getJson(h, "/api/v1/notifications/nope", alice.token)).status).toBe(404);
    expect((await h.request(`/api/v1/notifications/${newest}/dismiss`, bearer(bob.token, form({})))).status).toBe(404);
    const dismissed = await h.request(`/api/v1/notifications/${newest}/dismiss`, bearer(alice.token, form({})));
    expect({ status: dismissed.status, body: await dismissed.json() }).toEqual({ status: 200, body: {} });
    expect(await ids(h, "/api/v1/notifications", alice.token)).toEqual([oldest]);
    const cleared = await h.request("/api/v1/notifications/clear", bearer(alice.token, form({})));
    expect(await cleared.json()).toEqual({});
    expect(await ids(h, "/api/v1/notifications", alice.token)).toEqual([]);
  });

  it("needs the notification scopes", async () => {
    const h = await community(["alice"], "read:statuses write:statuses");
    expect((await h.request("/api/v1/notifications", bearer(h.users.alice.token))).status).toBe(403);
    expect((await h.request("/api/v1/notifications/clear", bearer(h.users.alice.token, form({})))).status).toBe(403);
  });

  it("does not notify a remote account or a suspended sender", async () => {
    const h = await community(["alice", "bob"]);
    const remote = await seedAccount(h.store, { username: "rem", domain: "remote.example" });
    await post(h, h.users.alice, { status: "@rem@remote.example hi" });
    expect(await sql(h.store, "SELECT id FROM notifications WHERE account_id = ?", remote)).toEqual([]);
    await post(h, h.users.bob, { status: "@alice hi" });
    await sql(
      h.store,
      "UPDATE local_accounts SET suspended_at = '2026-01-01T00:00:00.000Z' WHERE account_id = ?",
      h.users.bob.id,
    );
    expect(await ids(h, "/api/v1/notifications", h.users.alice.token)).toEqual([]);
  });
});
