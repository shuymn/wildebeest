import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { accountLists, listsHolding, MAX_LISTS } from "../src/domain/lists";
import { readOperation } from "../src/domain/operation";
import { type ApiHarness, bearer, json, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { rowsRead } from "./read-helpers";
import {
  act,
  community,
  follow,
  getJson,
  ids,
  mute,
  post,
  remoteAccount,
  seedStatus,
  type User,
} from "./status-helpers";

// Lists through the API (domain/lists.ts, mastodon/lists.ts), as Mastodon 4.5 has them: the endpoints, their errors,
// who may be a member, the list timeline and its replies policy, exclusive lists leaving home, and members leaving
// with the follow (migration 0007_list_members).

type List = { id: string; title: string; replies_policy: string; exclusive: boolean };

async function createList(h: ApiHarness, user: User, body: Record<string, unknown>): Promise<List> {
  const response = await act(h, user, "/api/v1/lists", body);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}

function send(h: ApiHarness, user: User, method: string, path: string, body: Record<string, unknown> = {}) {
  return h.request(path, bearer(user.token, json(body, { method })));
}

async function add(h: ApiHarness, user: User, list: string, accounts: string[]): Promise<Response> {
  return act(h, user, `/api/v1/lists/${list}/accounts`, { account_ids: accounts });
}

async function members(h: ApiHarness, user: User, list: string): Promise<string[]> {
  return ids(h, `/api/v1/lists/${list}/accounts?limit=0`, user.token);
}

async function rows(h: ApiHarness): Promise<{ list_id: string; account_id: string }[]> {
  return sql(h.store, "SELECT list_id, account_id FROM list_accounts ORDER BY list_id, account_id");
}

describe("lists", () => {
  it("creates, shows, updates and deletes a list, as REST::ListSerializer shows it", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const created = await createList(h, alice, { title: "友人" });
    expect(created).toEqual({
      id: expect.stringMatching(/^\d{18}$/),
      title: "友人",
      replies_policy: "list",
      exclusive: false,
    });
    expect(await getJson(h, `/api/v1/lists/${created.id}`, alice.token)).toEqual({ status: 200, body: created });

    const put = await send(h, alice, "PUT", `/api/v1/lists/${created.id}`, {
      replies_policy: "followed",
      exclusive: true,
    });
    expect(await put.json()).toEqual({ ...created, replies_policy: "followed", exclusive: true });
    const patch = await send(h, alice, "PATCH", `/api/v1/lists/${created.id}`, {
      title: "friends",
      exclusive: "false",
    });
    expect(await patch.json()).toEqual({ ...created, title: "friends", replies_policy: "followed" });
    const second = await createList(h, alice, { title: "b", replies_policy: "none", exclusive: "1" });
    expect(second).toMatchObject({ replies_policy: "none", exclusive: true });
    expect((await getJson<List[]>(h, "/api/v1/lists", alice.token)).body.map((l) => l.id)).toEqual([
      created.id,
      second.id,
    ]);

    const deleted = await send(h, alice, "DELETE", `/api/v1/lists/${created.id}`);
    expect([deleted.status, await deleted.json()]).toEqual([200, {}]);
    expect((await getJson<List[]>(h, "/api/v1/lists", alice.token)).body.map((l) => l.id)).toEqual([second.id]);
    expect((await getJson(h, `/api/v1/lists/${created.id}`, alice.token)).status).toBe(404);
  });

  it("answers 422 with Mastodon's validation messages, and 404 for another account's list", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const refused = async (method: string, path: string, body: Record<string, unknown>) => {
      const response = await send(h, alice, method, path, body);
      return { status: response.status, body: await response.json() };
    };
    expect(await refused("POST", "/api/v1/lists", {})).toEqual({
      status: 422,
      body: { error: "Validation failed: Title can't be blank" },
    });
    expect(await refused("POST", "/api/v1/lists", { title: " ", replies_policy: "all" })).toEqual({
      status: 422,
      body: { error: "Validation failed: Replies policy is not included in the list, Title can't be blank" },
    });
    // 256 characters are allowed, counted as Ruby counts them (code points).
    await createList(h, alice, { title: "𝒜".repeat(256) });
    expect(await refused("POST", "/api/v1/lists", { title: "a".repeat(257) })).toEqual({
      status: 422,
      body: { error: "Validation failed: Title is too long (maximum is 256 characters)" },
    });
    const list = await createList(h, alice, { title: "a" });
    expect(await refused("PUT", `/api/v1/lists/${list.id}`, { title: "" })).toEqual({
      status: 422,
      body: { error: "Validation failed: Title can't be blank" },
    });
    expect((await getJson(h, `/api/v1/lists/${list.id}`, alice.token)).body).toEqual(list);

    // Another account's list does not exist for bob, whatever he does.
    for (const [method, path] of [
      ["GET", `/api/v1/lists/${list.id}`],
      ["PUT", `/api/v1/lists/${list.id}`],
      ["DELETE", `/api/v1/lists/${list.id}`],
      ["GET", `/api/v1/lists/${list.id}/accounts`],
      ["POST", `/api/v1/lists/${list.id}/accounts`],
      ["DELETE", `/api/v1/lists/${list.id}/accounts`],
      ["GET", `/api/v1/timelines/list/${list.id}`],
    ] as const) {
      const response = await h.request(
        path,
        bearer(bob.token, method === "GET" ? {} : json({ title: "x", account_ids: [bob.id] }, { method })),
      );
      expect([method, path, response.status, await response.json()]).toEqual([
        method,
        path,
        404,
        { error: "Record not found" },
      ]);
    }
    expect((await getJson<List[]>(h, "/api/v1/lists", bob.token)).body).toEqual([]);
    expect((await getJson(h, `/api/v1/lists/${list.id}`, alice.token)).body).toEqual(list);
  });

  it(`holds at most ${MAX_LISTS} lists per account`, async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    await sql(
      h.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
			INSERT INTO lists (id, account_id, title) SELECT printf('8%017d', i), ?1, 'l' FROM n`,
      alice.id,
      MAX_LISTS - 1,
    );
    await createList(h, alice, { title: "last" });
    const response = await act(h, alice, "/api/v1/lists", { title: "one more" });
    expect([response.status, await response.json()]).toEqual([
      422,
      { error: "Validation failed: You have reached the maximum number of lists" },
    ]);
  });
});

describe("list members", () => {
  it("takes the owner and accounts the owner follows or has asked to follow, and refuses anyone else", async () => {
    const h = await community(["alice", "bob", "carol", "dave"]);
    const { alice, bob, carol, dave } = h.users;
    await sql(h.store, "UPDATE accounts SET locked = 1 WHERE id = ?", carol.id);
    await follow(h, alice, bob.id);
    await follow(h, alice, carol.id);
    const list = await createList(h, alice, { title: "l" });

    const refused = await add(h, alice, list.id, [bob.id, dave.id]);
    expect([refused.status, await refused.json()]).toEqual([
      422,
      { error: "Validation failed: Account must be a followed account" },
    ]);
    // Nothing of a refused request is kept.
    expect(await rows(h)).toEqual([]);
    const unknown = await add(h, alice, list.id, [bob.id, "999999999999999999"]);
    expect([unknown.status, await unknown.json()]).toEqual([404, { error: "Record not found" }]);

    const added = await add(h, alice, list.id, [bob.id, carol.id, alice.id, bob.id]);
    expect([added.status, await added.json()]).toEqual([200, {}]);
    expect((await members(h, alice, list.id)).toSorted()).toEqual([alice.id, bob.id, carol.id].toSorted());
    const again = await add(h, alice, list.id, [carol.id]);
    expect([again.status, await again.json()]).toEqual([
      422,
      { error: "Validation failed: Account has already been taken" },
    ]);
    expect((await add(h, alice, list.id, [])).status).toBe(200);

    expect(await ids(h, `/api/v1/accounts/${carol.id}/lists`, alice.token)).toEqual([list.id]);
    expect(await ids(h, `/api/v1/accounts/${dave.id}/lists`, alice.token)).toEqual([]);
    expect(await ids(h, `/api/v1/accounts/${carol.id}/lists`, bob.token)).toEqual([]);
    expect((await getJson(h, "/api/v1/accounts/999999999999999999/lists", alice.token)).status).toBe(404);

    const removed = await send(h, alice, "DELETE", `/api/v1/lists/${list.id}/accounts`, {
      account_ids: [carol.id, dave.id, "999999999999999999"],
    });
    expect([removed.status, await removed.json()]).toEqual([200, {}]);
    expect((await members(h, alice, list.id)).toSorted()).toEqual([alice.id, bob.id].toSorted());

    // Deleting the list deletes its members.
    await send(h, alice, "DELETE", `/api/v1/lists/${list.id}`);
    expect(await rows(h)).toEqual([]);
  });

  it("pages the members by account id with Link headers, 40 by default, every one with limit=0", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const list = await createList(h, alice, { title: "l" });
    const accounts: string[] = [];
    for (let i = 0; i < 45; i++) {
      const id = await remoteAccount(h.store, `r${i}`);
      await sql(
        h.store,
        "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
        alice.id,
        id,
      );
      accounts.push(id);
    }
    expect((await add(h, alice, list.id, accounts)).status).toBe(200);
    const newest = accounts.toSorted().toReversed();

    const first = await h.request(`/api/v1/lists/${list.id}/accounts`, bearer(alice.token));
    expect((await first.json<{ id: string }[]>()).map((a) => a.id)).toEqual(newest.slice(0, 40));
    expect(first.headers.get("link")).toBe(
      `<https://kopje.test/api/v1/lists/${list.id}/accounts?max_id=${newest[39]}>; rel="next", ` +
        `<https://kopje.test/api/v1/lists/${list.id}/accounts?min_id=${newest[0]}>; rel="prev"`,
    );
    expect(await ids(h, `/api/v1/lists/${list.id}/accounts?max_id=${newest[39]}`, alice.token)).toEqual(
      newest.slice(40),
    );
    expect(await ids(h, `/api/v1/lists/${list.id}/accounts?limit=2&min_id=${newest[3]}`, alice.token)).toEqual(
      newest.slice(1, 3),
    );
    const all = await h.request(`/api/v1/lists/${list.id}/accounts?limit=0`, bearer(alice.token));
    expect((await all.json<{ id: string }[]>()).map((a) => a.id)).toEqual(newest);
    expect(all.headers.get("link")).toBeNull();

    // An unavailable member is not shown (Account.without_suspended), nor are the lists that hold it.
    await sql(h.store, "UPDATE accounts SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", newest[0]!);
    expect(await members(h, alice, list.id)).toEqual(newest.slice(1));
    expect(await ids(h, `/api/v1/accounts/${newest[0]}/lists`, alice.token)).toEqual([]);
  });

  it("answers at most 1,000 members with limit=0, the newest", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const list = await createList(h, alice, { title: "l" });
    await sql(
      h.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT CAST(500000000000000000 + i AS TEXT), 'https://remote.example/users/m' || i, 'm' || i, 'remote.example'
			FROM n`,
      1001,
    );
    await sql(
      h.store,
      `INSERT INTO follows (account_id, target_account_id, state)
			SELECT ?1, id, 'accepted' FROM accounts WHERE domain = 'remote.example'`,
      alice.id,
    );
    await sql(
      h.store,
      "INSERT INTO list_accounts (list_id, account_id) SELECT ?, id FROM accounts WHERE domain = 'remote.example'",
      list.id,
    );
    const all = await members(h, alice, list.id);
    // Each answer presents whole accounts, remote bios included: a bound the isolate's memory holds.
    expect(all).toHaveLength(1000);
    expect(all[0]).toBe("500000000000001001");
  });

  it("asks for read:lists or write:lists", async () => {
    const h = await community(["alice"], "read:statuses write:statuses");
    const { alice } = h.users;
    expect((await getJson(h, "/api/v1/lists", alice.token)).status).toBe(403);
    expect((await act(h, alice, "/api/v1/lists", { title: "a" })).status).toBe(403);
    const lists = await community(["bob"], "read:lists write:lists");
    expect((await act(lists, lists.users.bob, "/api/v1/lists", { title: "a" })).status).toBe(200);
    expect((await getJson(lists, "/api/v1/lists", lists.users.bob.token)).status).toBe(200);
  });
});

describe("the list timeline", () => {
  it("shows its active members' statuses and boosts, the owner's when a member, and a pending member's once accepted", async () => {
    const h = await community(["alice", "bob", "carol", "dave"]);
    const { alice, bob, carol, dave } = h.users;
    await sql(h.store, "UPDATE accounts SET locked = 1 WHERE id = ?", carol.id);
    await follow(h, alice, bob.id);
    await follow(h, alice, carol.id);
    await follow(h, alice, dave.id);
    const list = await createList(h, alice, { title: "l" });
    expect((await add(h, alice, list.id, [alice.id, bob.id, carol.id])).status).toBe(200);

    const bobs = await post(h, bob, { status: "bob" });
    const carols = await post(h, carol, { status: "carol" });
    const daves = await post(h, dave, { status: "dave" });
    const alices = await post(h, alice, { status: "alice" });
    const direct = await post(h, alice, { status: "direct", visibility: "direct" });
    const boost = await (await act(h, bob, `/api/v1/statuses/${daves.id}/reblog`)).json<{ id: string }>();
    const timeline = () => ids(h, `/api/v1/timelines/list/${list.id}`, alice.token);
    expect(await timeline()).toEqual([boost.id, alices.id, bobs.id]);
    expect(await ids(h, "/api/v1/timelines/home", alice.token)).toContain(daves.id);
    expect(await ids(h, "/api/v1/timelines/home", alice.token)).toContain(direct.id);

    // carol accepts: her statuses reach the list, earlier ones included.
    expect((await act(h, carol, `/api/v1/follow_requests/${alice.id}/authorize`)).status).toBe(200);
    expect(await timeline()).toEqual([boost.id, alices.id, carols.id, bobs.id]);

    // A boost leaves with the follow's show_reblogs; home's filters apply (a mute of bob).
    await act(h, alice, `/api/v1/accounts/${bob.id}/follow`, { reblogs: false });
    expect(await timeline()).toEqual([alices.id, carols.id, bobs.id]);
    await mute(h.store, alice.id, bob.id);
    expect(await timeline()).toEqual([alices.id, carols.id]);

    const paged = await h.request(`/api/v1/timelines/list/${list.id}?limit=1`, bearer(alice.token));
    expect(paged.headers.get("link")).toContain(`max_id=${alices.id}`);
  });

  it("lets replies to others through as its replies_policy says", async () => {
    const h = await community(["alice", "bob", "carol", "dave", "erin"]);
    const { alice, bob, carol, dave, erin } = h.users;
    await sql(h.store, "UPDATE accounts SET locked = 1 WHERE id = ?", erin.id);
    for (const user of [bob, carol, dave, erin]) {
      await follow(h, alice, user.id);
    }
    const lists = {
      followed: await createList(h, alice, { title: "f", replies_policy: "followed" }),
      list: await createList(h, alice, { title: "l", replies_policy: "list" }),
      none: await createList(h, alice, { title: "n", replies_policy: "none" }),
    };
    for (const list of Object.values(lists)) {
      // carol is in every list; erin's request is pending.
      expect((await add(h, alice, list.id, [alice.id, bob.id, carol.id, erin.id])).status).toBe(200);
    }
    const davePost = await post(h, dave, { status: "dave" });
    const carolPost = await post(h, carol, { status: "carol" });
    const erinPost = await seedStatus(h.store, { accountId: erin.id, visibility: "public" });
    const alicePost = await post(h, alice, { status: "alice" });
    const toDave = await post(h, bob, { status: "to dave", in_reply_to_id: davePost.id });
    const toCarol = await post(h, bob, { status: "to carol", in_reply_to_id: carolPost.id });
    const toErin = await post(h, bob, { status: "to erin", in_reply_to_id: erinPost });
    const toAlice = await post(h, bob, { status: "to alice", in_reply_to_id: alicePost.id });
    const own = await post(h, bob, { status: "own", in_reply_to_id: toAlice.id });
    const aliceToDave = await post(h, alice, { status: "alice to dave", in_reply_to_id: davePost.id });
    const aliceToCarol = await post(h, alice, { status: "alice to carol", in_reply_to_id: carolPost.id });
    const timeline = (list: List) => ids(h, `/api/v1/timelines/list/${list.id}`, alice.token);
    const common = [own.id, toAlice.id, alicePost.id, carolPost.id];
    const newest = (statuses: string[]) => statuses.toSorted().toReversed();
    // followed: replies to anyone alice follows, and all of her own.
    expect(await timeline(lists.followed)).toEqual(
      newest([...common, toDave.id, toCarol.id, aliceToDave.id, aliceToCarol.id]),
    );
    // list: replies to members, a pending one included.
    expect(await timeline(lists.list)).toEqual(newest([...common, toCarol.id, toErin.id, aliceToCarol.id]));
    // none: replies to the owner and in the author's own conversation only.
    expect(await timeline(lists.none)).toEqual(newest(common));
  });
});

describe("exclusive lists", () => {
  it("leave the members' statuses and boosts out of home, but not the post notification", async () => {
    const h = await community(["alice", "bob", "carol"]);
    const { alice, bob, carol } = h.users;
    await act(h, alice, `/api/v1/accounts/${bob.id}/follow`, { notify: true });
    await follow(h, alice, carol.id);
    const list = await createList(h, alice, { title: "l", exclusive: true });
    expect((await add(h, alice, list.id, [alice.id, bob.id])).status).toBe(200);

    const carols = await post(h, carol, { status: "carol" });
    const bobs = await post(h, bob, { status: "bob" });
    const boost = await (await act(h, bob, `/api/v1/statuses/${carols.id}/reblog`)).json<{ id: string }>();
    const mention = await post(h, bob, { status: "@alice hi", visibility: "direct" });
    const alices = await post(h, alice, { status: "alice" });
    expect(await ids(h, "/api/v1/timelines/home", alice.token)).toEqual([alices.id, carols.id]);
    expect(await ids(h, `/api/v1/timelines/list/${list.id}`, alice.token)).toEqual([alices.id, boost.id, bobs.id]);
    // FeedInsertWorker#notify? lets :skip_home through: bob's post notifies alice all the same.
    expect(
      await sql(h.store, "SELECT status_id FROM notifications WHERE account_id = ? AND type = 'status'", alice.id),
    ).toContainEqual({ status_id: bobs.id });
    expect(
      await sql(h.store, "SELECT status_id FROM notifications WHERE account_id = ? AND type = 'mention'", alice.id),
    ).toEqual([{ status_id: mention.id }]);

    // Off again, home has them back.
    await send(h, alice, "PUT", `/api/v1/lists/${list.id}`, { exclusive: false });
    expect(await ids(h, "/api/v1/timelines/home", alice.token)).toEqual([
      alices.id,
      mention.id,
      boost.id,
      bobs.id,
      carols.id,
    ]);
  });
});

describe("membership ends with the follow", () => {
  it("on an unfollow, a block either way, and a rejected request", async () => {
    const h = await community(["alice", "bob", "carol", "dave", "erin"]);
    const { alice, bob, carol, dave, erin } = h.users;
    await sql(h.store, "UPDATE accounts SET locked = 1 WHERE id = ?", erin.id);
    for (const user of [bob, carol, dave, erin]) {
      await follow(h, alice, user.id);
    }
    await follow(h, bob, alice.id);
    const first = await createList(h, alice, { title: "a" });
    const second = await createList(h, alice, { title: "b" });
    // bob's own list holds alice: alice's follows do not touch it.
    const bobs = await createList(h, bob, { title: "c" });
    expect((await add(h, bob, bobs.id, [alice.id])).status).toBe(200);
    for (const list of [first, second]) {
      expect((await add(h, alice, list.id, [alice.id, bob.id, carol.id, dave.id, erin.id])).status).toBe(200);
    }
    const membersOf = async () => ({
      first: (await members(h, alice, first.id)).toSorted(),
      second: (await members(h, alice, second.id)).toSorted(),
      bobs: await members(h, bob, bobs.id),
    });

    await act(h, alice, `/api/v1/accounts/${bob.id}/unfollow`);
    await act(h, alice, `/api/v1/accounts/${carol.id}/block`);
    await act(h, dave, `/api/v1/accounts/${alice.id}/block`);
    await act(h, erin, `/api/v1/follow_requests/${alice.id}/reject`);
    expect(await membersOf()).toEqual({ first: [alice.id], second: [alice.id], bobs: [alice.id] });

    // Following again does not bring a member back.
    await follow(h, alice, bob.id);
    expect(await membersOf()).toEqual({ first: [alice.id], second: [alice.id], bobs: [alice.id] });
  });

  it("on a domain block's cleanup", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const remote = await remoteAccount(h.store, "r", "blocked.example");
    const other = await remoteAccount(h.store, "s", "open.example");
    for (const id of [remote, other]) {
      await sql(
        h.store,
        "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
        alice.id,
        id,
      );
    }
    const list = await createList(h, alice, { title: "l" });
    expect((await add(h, alice, list.id, [remote, other])).status).toBe(200);
    expect((await act(h, alice, "/api/v1/domain_blocks", { domain: "blocked.example" })).status).toBe(200);
    expect(await members(h, alice, list.id)).toEqual([other]);
  });
});

// RES-7: an owner's lists that hold an account are found from the owner's lists (at most 50), each checked through the
// (list_id, account_id) key, so the reads do not grow with the lists of other owners that hold the same account.
describe("finding an owner's lists that hold an account", () => {
  const OWNER = "100000000000000001";
  const MEMBER = "100000000000000002";
  const TOKEN = "lists-rows-read";

  async function storeWith(others: number) {
    const h = await community([]);
    await sql(
      h.store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO accounts (id, uri, username)
			SELECT printf('%018d', 100000000000000001 + i), 'https://kopje.test/ap/users/u' || i, 'u' || i FROM n`,
      others + 1,
    );
    await sql(
      h.store,
      `INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
			SELECT id, username || '@example.com', X'00', X'00', 'k' FROM accounts WHERE id <> ?`,
      MEMBER,
    );
    await sql(h.store, "UPDATE accounts SET domain = 'remote.example' WHERE id = ?", MEMBER);
    // Every local account follows the member and has a list holding it; the owner has two, and a third without it.
    await sql(
      h.store,
      "INSERT INTO follows (account_id, target_account_id, state) SELECT account_id, ?, 'accepted' FROM local_accounts",
      MEMBER,
    );
    await sql(
      h.store,
      `INSERT INTO lists (id, account_id, title)
			SELECT CAST(700000000000000000 + rowid AS TEXT), account_id, 'l' FROM local_accounts`,
    );
    await sql(
      h.store,
      "INSERT INTO lists (id, account_id, title) VALUES ('800000000000000001', ?1, 'b'), ('800000000000000002', ?1, 'c')",
      OWNER,
    );
    await sql(
      h.store,
      "INSERT INTO list_accounts (list_id, account_id) SELECT id, ? FROM lists WHERE id <> '800000000000000002'",
      MEMBER,
    );
    await sql(
      h.store,
      "INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', (SELECT id FROM oauth_clients LIMIT 1), ?, 'read')",
      TOKEN,
      OWNER,
    );
    return h;
  }

  it("reads the same rows however many other owners list the account", async () => {
    const input = { credential: { tokenHash: TOKEN, scope: "read:lists", now: NOW } as const, account: MEMBER };
    const few = await storeWith(10);
    const many = await storeWith(1000);
    const lists = await runInDurableObject(many.store, (_instance, state) =>
      accountLists.run(state.storage.sql, input),
    );
    expect(lists).toMatchObject({ status: "ok", value: [{ id: expect.any(String) }, { id: "800000000000000001" }] });
    const read = async (h: ApiHarness) => rowsRead(h, accountLists, input);
    expect(await read(many)).toBeLessThanOrEqual((await read(few)) + 10);
    // The lists a Move carries the membership in (moveBatch) are found the same way.
    const holding = readOperation<null, string[]>((db) => listsHolding(db, OWNER, MEMBER));
    const moved = async (h: ApiHarness) => rowsRead(h, holding, null);
    expect(await moved(many)).toBeLessThanOrEqual((await moved(few)) + 10);
  });
});
