import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  getAccounts,
  MAX_ACCOUNTS_BY_ID,
  MAX_NOTE_COMMENT,
  MAX_RELATIONSHIP_IDS,
  relationships as relationshipsOperation,
} from "../src/domain/accounts";
import { MAX_BLOCK_LABELS } from "../src/domain/audience";
import { MAX_ENDORSEMENTS_ANSWERED, NOT_FOLLOWING } from "../src/domain/endorsements";
import { sha256Hex } from "../src/security/tokens";
import { type ApiHarness, bearer, form, json, registerApp, seedAccount, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { blockDomainIn } from "./domain-block-helpers";
import { appToken, plannedRun, remoteAccounts, scansOf, scopedToken, staleStatistics } from "./read-helpers";
import {
  act,
  community,
  follow,
  getJson,
  ids,
  outbound,
  remoteAccount,
  remoteFollows,
  type User,
} from "./status-helpers";

// The account endpoints of Mastodon 4.5 that complete /api/v1/accounts: private notes, endorsements, removing a
// follower, accounts by id, identity proofs and registration (closed), through the API.

const NOW_ISO = new Date(NOW).toISOString();

type Relationship = Record<string, unknown> & { id: string; endorsed: boolean; note: string; followed_by: boolean };

async function relationship(h: ApiHarness, user: User, path: string, body: Record<string, unknown> = {}) {
  const response = await act(h, user, path, body);
  return { status: response.status, body: await response.json<Relationship & { error?: string }>() };
}

async function relationshipsOf(h: ApiHarness, user: User, id: string): Promise<Relationship> {
  const { body } = await getJson<Relationship[]>(h, `/api/v1/accounts/relationships?id[]=${id}`, user.token);
  return body[0]!;
}

// An app token (no user) with the write scope.
async function writeAppToken(h: ApiHarness): Promise<string> {
  const app = await registerApp(h, { scopes: "read write" });
  const response = await h.request(
    "/oauth/token",
    form({
      grant_type: "client_credentials",
      client_id: app.client_id,
      client_secret: app.client_secret,
      scope: "write",
    }),
  );
  return (await response.json<{ access_token: string }>()).access_token;
}

const pins = (h: ApiHarness) =>
  sql<{ account_id: string; target_account_id: string }>(
    h.store,
    "SELECT account_id, target_account_id FROM account_pins ORDER BY account_id, target_account_id",
  );

describe("private notes", () => {
  it("keeps the viewer's note, shows it in the viewer's relationships only, and deletes it when blank", async () => {
    const h = await community(["alice", "bob", "carol"]);
    const { alice, bob, carol } = h.users;
    const set = await relationship(h, alice, `/api/v1/accounts/${bob.id}/note`, { comment: " met at the park\n" });
    expect(set).toMatchObject({ status: 200, body: { id: bob.id, note: " met at the park\n", endorsed: false } });
    expect((await relationshipsOf(h, alice, bob.id)).note).toBe(" met at the park\n");
    // Nobody else is shown it.
    expect((await relationshipsOf(h, carol, bob.id)).note).toBe("");
    expect((await relationshipsOf(h, bob, alice.id)).note).toBe("");
    // The follow answer, any Relationship, carries it.
    expect((await relationship(h, alice, `/api/v1/accounts/${bob.id}/follow`)).body.note).toBe(" met at the park\n");

    // The same note is not written again; a new one replaces it.
    const stamp = () =>
      sql<{ updated_at: string }>(h.store, "SELECT updated_at FROM account_notes WHERE target_account_id = ?", bob.id);
    await sql(h.store, "UPDATE account_notes SET updated_at = '2000-01-01T00:00:00.000Z'");
    await relationship(h, alice, `/api/v1/accounts/${bob.id}/note`, { comment: " met at the park\n" });
    expect(await stamp()).toEqual([{ updated_at: "2000-01-01T00:00:00.000Z" }]);
    await relationship(h, alice, `/api/v1/accounts/${bob.id}/note`, { comment: "neighbour" });
    expect((await relationshipsOf(h, alice, bob.id)).note).toBe("neighbour");

    // A blank comment, or none, deletes it.
    for (const body of [{ comment: " \n\t" }, {}, { comment: "" }]) {
      await relationship(h, alice, `/api/v1/accounts/${bob.id}/note`, { comment: "again" });
      expect((await relationship(h, alice, `/api/v1/accounts/${bob.id}/note`, body)).body.note).toBe("");
      expect(await sql(h.store, "SELECT * FROM account_notes")).toEqual([]);
    }
    // A note on oneself is a note like any other, as Mastodon keeps it.
    expect((await relationship(h, alice, `/api/v1/accounts/${alice.id}/note`, { comment: "me" })).body.note).toBe("me");
  });

  it(`holds ${MAX_NOTE_COMMENT} characters as Ruby counts them, and answers 422 and 404 as Mastodon does`, async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const longest = "𝒜".repeat(MAX_NOTE_COMMENT);
    expect((await relationship(h, alice, `/api/v1/accounts/${bob.id}/note`, { comment: longest })).body.note).toBe(
      longest,
    );
    expect(await relationship(h, alice, `/api/v1/accounts/${bob.id}/note`, { comment: `${longest}a` })).toEqual({
      status: 422,
      body: { error: `Validation failed: Comment is too long (maximum is ${MAX_NOTE_COMMENT} characters)` },
    });
    expect((await relationshipsOf(h, alice, bob.id)).note).toBe(longest);
    // An unknown account is not found before the comment is judged.
    expect(
      await relationship(h, alice, "/api/v1/accounts/999999999999999999/note", { comment: `${longest}a` }),
    ).toEqual({ status: 404, body: { error: "Record not found" } });
    // A token without write:accounts, or without a user, is refused.
    const read = await h.request(`/api/v1/accounts/${bob.id}/note`, bearer(await scopedToken(h, "read"), json({})));
    expect(read.status).toBe(403);
    const app = await h.request(`/api/v1/accounts/${bob.id}/note`, bearer(await writeAppToken(h), json({})));
    expect(app.status).toBe(422);
  });
});

describe("endorsements", () => {
  it("endorses an account the viewer follows, and refuses one it does not follow with AccountPin’s message", async () => {
    const h = await community(["alice", "bob", "carol"]);
    const { alice, bob, carol } = h.users;
    const refused = { status: 422, body: { error: `Validation failed: ${NOT_FOLLOWING}` } };
    expect(await relationship(h, alice, `/api/v1/accounts/${bob.id}/endorse`)).toEqual(refused);
    expect(await relationship(h, alice, `/api/v1/accounts/${alice.id}/endorse`)).toEqual(refused);
    // A pending request is not a follow.
    await sql(h.store, "UPDATE accounts SET locked = 1 WHERE id = ?", carol.id);
    await follow(h, alice, carol.id);
    expect(await relationship(h, alice, `/api/v1/accounts/${carol.id}/pin`)).toEqual(refused);

    await follow(h, alice, bob.id);
    expect(await relationship(h, alice, `/api/v1/accounts/${bob.id}/endorse`)).toMatchObject({
      status: 200,
      body: { id: bob.id, following: true, endorsed: true },
    });
    // Again, or by the other name, changes nothing.
    expect((await relationship(h, alice, `/api/v1/accounts/${bob.id}/pin`)).body.endorsed).toBe(true);
    expect(await pins(h)).toEqual([{ account_id: alice.id, target_account_id: bob.id }]);
    expect((await relationshipsOf(h, alice, bob.id)).endorsed).toBe(true);
    expect((await relationshipsOf(h, bob, alice.id)).endorsed).toBe(false);
    // Endorsements are not federated (Mastodon 4.5's actor has no endorsements collection).
    expect((await outbound(h.store)).map((o) => o.activity.type)).toEqual([]);

    expect((await relationship(h, alice, `/api/v1/accounts/${bob.id}/unendorse`)).body.endorsed).toBe(false);
    expect(await pins(h)).toEqual([]);
    await relationship(h, alice, `/api/v1/accounts/${bob.id}/endorse`);
    expect((await relationship(h, alice, `/api/v1/accounts/${bob.id}/unpin`)).body.endorsed).toBe(false);
    // Unendorsing an account not endorsed answers its relationship.
    expect((await relationship(h, alice, `/api/v1/accounts/${carol.id}/unpin`)).status).toBe(200);
    for (const path of ["endorse", "unendorse", "pin", "unpin"]) {
      expect(await relationship(h, alice, `/api/v1/accounts/999999999999999999/${path}`)).toEqual({
        status: 404,
        body: { error: "Record not found" },
      });
    }
  });

  it("lists an account's endorsements to anyone, by account id with Link headers, leaving out unavailable ones", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const others: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await seedAccount(h.store, { username: `u${i}` });
      await follow(h, alice, id);
      await relationship(h, alice, `/api/v1/accounts/${id}/endorse`);
      others.push(id);
    }
    const remote = await remoteAccount(h.store, "far");
    await sql(
      h.store,
      "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
      alice.id,
      remote,
    );
    await relationship(h, alice, `/api/v1/accounts/${remote}/endorse`);
    const newestFirst = [remote, ...others].toSorted().toReversed();
    expect(await ids(h, `/api/v1/accounts/${alice.id}/endorsements`)).toEqual(newestFirst);

    // Pages of 2, by the endorsed account's id; the Link header continues them.
    const first = await h.request(`/api/v1/accounts/${alice.id}/endorsements?limit=2`);
    expect((await first.json<{ id: string }[]>()).map((a) => a.id)).toEqual(newestFirst.slice(0, 2));
    const link = first.headers.get("link") ?? "";
    expect(link).toContain(`max_id=${newestFirst[1]}`);
    expect(link).toContain(`min_id=${newestFirst[0]}`);
    expect(await ids(h, `/api/v1/accounts/${alice.id}/endorsements?limit=2&max_id=${newestFirst[1]}`)).toEqual(
      newestFirst.slice(2, 4),
    );
    expect(await ids(h, `/api/v1/accounts/${alice.id}/endorsements?limit=2&min_id=${newestFirst[2]}`)).toEqual(
      newestFirst.slice(0, 2),
    );
    expect(await ids(h, `/api/v1/accounts/${alice.id}/endorsements?since_id=${newestFirst[2]}`)).toEqual(
      newestFirst.slice(0, 2),
    );

    // A suspended account, and a remote one being deleted, are left out (without_suspended).
    await sql(
      h.store,
      "UPDATE local_accounts SET suspended_at = '2026-01-01T00:00:00.000Z' WHERE account_id = ?",
      others[0]!,
    );
    await sql(h.store, "UPDATE accounts SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", remote);
    const shown = newestFirst.filter((id) => id !== others[0] && id !== remote);
    expect(await ids(h, `/api/v1/accounts/${alice.id}/endorsements`)).toEqual(shown);
    // The same to a user, an app token (anonymous) and the owner's own list.
    const bob = await seedAccount(h.store, { username: "bob" });
    expect(await ids(h, `/api/v1/accounts/${alice.id}/endorsements`, await appToken(h))).toEqual(shown);
    expect(await ids(h, "/api/v1/endorsements", alice.token)).toEqual(shown);
    // An account that endorses nothing lists nothing; an unknown one is not found.
    expect(await ids(h, `/api/v1/accounts/${bob}/endorsements`)).toEqual([]);
    expect((await getJson(h, "/api/v1/accounts/999999999999999999/endorsements")).status).toBe(404);
    // A stale token is refused, as an optional token that is sent must be valid.
    expect((await getJson(h, `/api/v1/accounts/${alice.id}/endorsements`, "stale")).status).toBe(401);
    // An unavailable account's endorsements are not listed, even to itself.
    await sql(
      h.store,
      "UPDATE local_accounts SET suspended_at = '2026-01-01T00:00:00.000Z' WHERE account_id = ?",
      alice.id,
    );
    expect(await ids(h, `/api/v1/accounts/${alice.id}/endorsements`)).toEqual([]);
  });

  it(`lists the viewer's own with limit=0 all at once, up to ${MAX_ENDORSEMENTS_ANSWERED}, without Link headers`, async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const others: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await seedAccount(h.store, { username: `u${i}` });
      await follow(h, alice, id);
      await relationship(h, alice, `/api/v1/accounts/${id}/endorse`);
      others.push(id);
    }
    const all = await h.request("/api/v1/endorsements?limit=0", bearer(alice.token));
    expect(all.headers.get("link")).toBeNull();
    expect((await all.json<{ id: string }[]>()).map((a) => a.id)).toEqual(others.toReversed());
    const page = await h.request("/api/v1/endorsements?limit=1", bearer(alice.token));
    expect(page.headers.get("link")).toContain(`max_id=${others[2]}`);
    // read:accounts, with a user.
    expect((await h.request("/api/v1/endorsements")).status).toBe(401);
    expect((await h.request("/api/v1/endorsements", bearer(await scopedToken(h, "write")))).status).toBe(403);
    expect((await h.request("/api/v1/endorsements", bearer(await appToken(h)))).status).toBe(422);
    expect((await h.request("/api/v1/endorsements", bearer(await scopedToken(h, "read:accounts")))).status).toBe(200);
  });

  it("goes with the follow, whatever ends it, and does not come back with a new follow", async () => {
    const h = await community(["alice", "bob", "carol", "dave", "erin"]);
    const { alice, bob, carol, dave, erin } = h.users;
    const far = await remoteAccount(h.store, "far", "far.example");
    for (const target of [bob.id, carol.id, dave.id, erin.id]) {
      await follow(h, alice, target);
    }
    await sql(
      h.store,
      "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
      alice.id,
      far,
    );
    for (const target of [bob.id, carol.id, dave.id, erin.id, far]) {
      expect((await relationship(h, alice, `/api/v1/accounts/${target}/endorse`)).body.endorsed).toBe(true);
    }
    await follow(h, bob, alice.id);
    await relationship(h, bob, `/api/v1/accounts/${alice.id}/endorse`);

    // An unfollow, the viewer's block, the other side's block, a removal from the other side's followers, a domain
    // block's cleanup.
    await relationship(h, alice, `/api/v1/accounts/${bob.id}/unfollow`);
    await relationship(h, alice, `/api/v1/accounts/${carol.id}/block`);
    await relationship(h, dave, `/api/v1/accounts/${alice.id}/block`);
    await relationship(h, erin, `/api/v1/accounts/${alice.id}/remove_from_followers`);
    await act(h, alice, "/api/v1/domain_blocks", { domain: "far.example" });
    expect(await pins(h)).toEqual([{ account_id: bob.id, target_account_id: alice.id }]);

    await follow(h, alice, bob.id);
    expect((await relationshipsOf(h, alice, bob.id)).endorsed).toBe(false);
    // Bob's endorsement of alice goes when alice removes him from her followers.
    await relationship(h, alice, `/api/v1/accounts/${bob.id}/remove_from_followers`);
    expect(await pins(h)).toEqual([]);
  });
});

describe("removing a follower", () => {
  it("ends a local follower's follow, and leaves a pending request alone", async () => {
    const h = await community(["alice", "bob", "carol"]);
    const { alice, bob, carol } = h.users;
    await follow(h, bob, alice.id);
    const removed = await relationship(h, alice, `/api/v1/accounts/${bob.id}/remove_from_followers`);
    expect(removed).toMatchObject({ status: 200, body: { id: bob.id, followed_by: false, requested_by: false } });
    expect(await sql(h.store, "SELECT * FROM follows")).toEqual([]);
    expect(await sql(h.store, "SELECT * FROM notifications WHERE type = 'follow'")).toEqual([]);
    expect(
      await sql(
        h.store,
        "SELECT id, followers_count, following_count FROM accounts WHERE id IN (?, ?) ORDER BY id",
        alice.id,
        bob.id,
      ),
    ).toEqual([
      { id: alice.id, followers_count: 0, following_count: 0 },
      { id: bob.id, followers_count: 0, following_count: 0 },
    ]);
    expect(await outbound(h.store)).toEqual([]);

    await sql(h.store, "UPDATE accounts SET locked = 1 WHERE id = ?", alice.id);
    await follow(h, carol, alice.id);
    const pending = await relationship(h, alice, `/api/v1/accounts/${carol.id}/remove_from_followers`);
    expect(pending.body).toMatchObject({ followed_by: false, requested_by: true });
    // Nobody else's follow, and nothing for oneself or an account that does not follow.
    await follow(h, carol, bob.id);
    expect((await relationship(h, alice, `/api/v1/accounts/${alice.id}/remove_from_followers`)).status).toBe(200);
    expect((await relationship(h, bob, `/api/v1/accounts/${alice.id}/remove_from_followers`)).status).toBe(200);
    expect(await sql(h.store, "SELECT account_id, target_account_id, state FROM follows ORDER BY id")).toEqual([
      { account_id: carol.id, target_account_id: alice.id, state: "pending" },
      { account_id: carol.id, target_account_id: bob.id, state: "accepted" },
    ]);
    expect(await relationship(h, alice, "/api/v1/accounts/999999999999999999/remove_from_followers")).toEqual({
      status: 404,
      body: { error: "Record not found" },
    });
    // write:follows.
    const read = await h.request(
      `/api/v1/accounts/${carol.id}/remove_from_followers`,
      bearer(await scopedToken(h, "read write:accounts"), json({})),
    );
    expect(read.status).toBe(403);
  });

  it("sends a remote follower the Reject that withdraws its accepted follow", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const far = await remoteAccount(h.store, "far", "far.example");
    await remoteFollows(h.store, far, alice.id);
    await sql(h.store, "UPDATE follows SET uri = 'https://far.example/follows/1'");
    await sql(h.store, "UPDATE accounts SET followers_count = 1 WHERE id = ?", alice.id);
    const removed = await relationship(h, alice, `/api/v1/accounts/${far}/remove_from_followers`);
    expect(removed.body.followed_by).toBe(false);
    expect(await sql(h.store, "SELECT * FROM follows")).toEqual([]);
    const sent = await outbound(h.store);
    expect(sent.map((o) => [o.signer, o.activity.type, o.activity.object, o.audience])).toEqual([
      [
        alice.id,
        "Reject",
        {
          id: "https://far.example/follows/1",
          type: "Follow",
          actor: "https://far.example/users/far",
          object: "https://kopje.test/ap/users/alice",
        },
        { followers: false, accounts: [far] },
      ],
    ]);
    // The Reject withdraws the follow: it is a retraction, which also reaches what was delivered about it.
    expect(await sql(h.store, "SELECT retracts FROM outbound_activities")).toEqual([{ retracts: 1 }]);
    expect(await sql(h.store, "SELECT followers_count FROM accounts WHERE id = ?", alice.id)).toEqual([
      { followers_count: 0 },
    ]);
    // The follow's id is retracted, so a redelivery of it does not follow again (ID-7).
    expect(await sql(h.store, "SELECT target_uri FROM inbound_retractions")).toEqual([
      { target_uri: "https://far.example/follows/1" },
    ]);
  });
});

describe("accounts by id", () => {
  it("shows what /api/v1/accounts/:id shows, in the order asked, each once, to anyone", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const far = await remoteAccount(h.store, "far");
    await sql(
      h.store,
      "UPDATE local_accounts SET suspended_at = '2026-01-01T00:00:00.000Z' WHERE account_id = ?",
      bob.id,
    );
    const query = [far, alice.id, "999999999999999999", far, bob.id, "x"].map((id) => `id[]=${id}`).join("&");
    const { status, body } = await getJson<Record<string, unknown>[]>(h, `/api/v1/accounts?${query}`);
    expect(status).toBe(200);
    const one = async (id: string) => (await getJson(h, `/api/v1/accounts/${id}`)).body;
    expect(body).toEqual([await one(far), await one(alice.id), await one(bob.id)]);
    expect(body[2]).toMatchObject({ id: bob.id, suspended: true });
    // A stale token is not read, as for one account.
    expect((await getJson(h, `/api/v1/accounts?id[]=${far}`, "stale")).body).toEqual([await one(far)]);
    expect(await getJson(h, "/api/v1/accounts")).toEqual({ status: 200, body: [] });
  });

  it(`answers 422 for more than ${MAX_ACCOUNTS_BY_ID} distinct ids, as Mastodon::ValidationError does`, async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const many = (n: number) => Array.from({ length: n }, (_, i) => `id[]=${String(100000000000000000n + BigInt(i))}`);
    expect(await getJson(h, `/api/v1/accounts?${many(MAX_ACCOUNTS_BY_ID).join("&")}&id[]=${alice.id}`)).toEqual({
      status: 422,
      body: { error: "Mastodon::ValidationError" },
    });
    const repeated = [...many(MAX_ACCOUNTS_BY_ID - 1), `id[]=${alice.id}`, `id[]=${alice.id}`].join("&");
    expect(await ids(h, `/api/v1/accounts?${repeated}`)).toEqual([alice.id]);
  });
});

describe("identity proofs and registration", () => {
  it("answers [] for the identity proofs of an account that exists, to a user token", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    expect(await getJson(h, `/api/v1/accounts/${alice.id}/identity_proofs`, alice.token)).toEqual({
      status: 200,
      body: [],
    });
    expect(await getJson(h, "/api/v1/accounts/999999999999999999/identity_proofs", alice.token)).toEqual({
      status: 404,
      body: { error: "Record not found" },
    });
    expect((await getJson(h, `/api/v1/accounts/${alice.id}/identity_proofs`)).status).toBe(401);
    expect(await getJson(h, `/api/v1/accounts/${alice.id}/identity_proofs`, await appToken(h))).toEqual({
      status: 422,
      body: { error: "This method requires an authenticated user" },
    });
  });

  it("refuses registration as Mastodon does with registrations closed", async () => {
    const h = await community(["alice"]);
    const register = async (token?: string) => {
      const response = await h.request(
        "/api/v1/accounts",
        json({ username: "new", email: "new@example.com", agreement: true }, token === undefined ? {} : bearer(token)),
      );
      return { status: response.status, body: await response.json() };
    };
    expect((await register()).status).toBe(401);
    // doorkeeper_authorize! :write, :'write:accounts' first, then require_client_credentials!, then
    // check_enabled_registrations.
    expect(await register(await scopedToken(h, "read"))).toEqual({
      status: 403,
      body: { error: "This action is outside the authorized scopes" },
    });
    expect(await register(h.users.alice.token)).toEqual({
      status: 403,
      body: { error: "This method requires an client credentials authentication" },
    });
    expect(await register(await appToken(h))).toEqual({
      status: 403,
      body: { error: "This action is outside the authorized scopes" },
    });
    expect(await register(await writeAppToken(h))).toEqual({ status: 403, body: { error: "Forbidden" } });
    expect(await sql(h.store, "SELECT id FROM accounts WHERE username = 'new'")).toEqual([]);
  });
});

describe("account batches with stale statistics (RES-7)", () => {
  it("seeks each requested account by id, the accounts grown after ANALYZE", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const carol = await remoteAccount(h.store, "carol");
    await follow(h, alice, bob.id);
    await act(h, alice, `/api/v1/accounts/${carol}/note`, { comment: "known" });
    const tokenHash = await sha256Hex(alice.token);
    const requested = [bob.id, carol, alice.id, "999999999999999999"];
    const run = async () => ({
      relationships: await plannedRun(h, /FROM json_each\(\?2\) j/, relationshipsOperation, {
        credential: { tokenHash, scope: "read:follows", now: NOW },
        ids: requested,
        withSuspended: true,
      }),
      accounts: await plannedRun(h, /^SELECT .* FROM accounts a/s, getAccounts, {
        ids: requested,
        present: { origin: "https://kopje.test" },
      }),
    });
    const { before, after } = await staleStatistics(h, {
      capture: () => run(),
      grow: async () => {
        await remoteAccounts(h, 100, 200);
      },
    });
    expect(after.relationships.result).toEqual(before.relationships.result);
    expect(after.accounts.result).toEqual(before.accounts.result);
    expect((after.accounts.result as unknown[]).length).toBe(3);
    for (const [name, { plans }] of Object.entries(after)) {
      expect(plans, name).toHaveLength(1);
      const { plan, rows } = plans[0]!;
      expect(
        plan.filter((detail) =>
          /^SEARCH a USING (COVERING )?INDEX sqlite_autoindex_accounts_1 \(id=\?\)$/.test(detail),
        ),
        name,
      ).toHaveLength(1);
      expect(scansOf(plan, ["a"]), name).toEqual([]);
      expect(rows, name).toBe(before[name as keyof typeof before].plans[0]!.rows);
    }
  }, 60_000);

  it(`judges ${MAX_RELATIONSHIP_IDS} requested accounts' availability by key seeks, under 100 suspend blocks`, async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const tokenHash = await sha256Hex(alice.token);
    const LOCALS = 10;
    const REMOTES = MAX_RELATIONSHIP_IDS - LOCALS;
    // Eight labels (MAX_BLOCK_LABELS), the deepest a block's walk seeks; the actor id on another such host.
    const deep = (i: number, name: string) => `l1.l2.l3.l4.l5.l6.${name}${i}.example`;
    const remote = (i: number) => String(400000000000000000n + BigInt(i));
    const requested: string[] = [];
    // Left out: domain-covered by either key (0-2, 3), instance-suspended (10-12), being deleted (13-15), and
    // suspended local accounts (the first three).
    const unavailable = new Set<string>();
    const settle = async () => {
      for (let i = 0; i < LOCALS; i++) {
        const id = await seedAccount(h.store, { username: `local${i}` });
        requested.push(id);
        if (i < 3) {
          await sql(
            h.store,
            "UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?",
            new Date(NOW).toISOString(),
            id,
          );
          unavailable.add(id);
        }
      }
      await runInDurableObject(h.store, (_instance, state) => {
        const db = state.storage.sql;
        for (let i = 0; i < REMOTES; i++) {
          db.exec(
            "INSERT INTO accounts (id, uri, username, domain, suspended_at, suspension_source, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            remote(i),
            `https://${deep(i, "h")}/users/u${i}`,
            `u${i}`,
            deep(i, "r"),
            i >= 10 && i < 13 ? NOW_ISO : null,
            i >= 10 && i < 13 ? "account" : null,
            i >= 13 && i < 16 ? NOW_ISO : null,
          );
          db.exec(
            "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
            alice.id,
            remote(i),
          );
          requested.push(remote(i));
        }
        for (const i of [0, 1, 2]) {
          blockDomainIn(db, `r${i}.example`);
        }
        blockDomainIn(db, "h3.example");
        for (let k = 0; k < 96; k++) {
          blockDomainIn(db, `elsewhere${k}.example`);
        }
      });
      for (let i = 0; i < 16; i++) {
        if (i <= 3 || i >= 10) {
          unavailable.add(remote(i));
        }
      }
    };
    const run = () =>
      plannedRun(h, /FROM json_each\(\?2\) j/, relationshipsOperation, {
        credential: { tokenHash, scope: "read:follows", now: NOW },
        ids: requested,
        withSuspended: false,
      });
    const { before, after } = await staleStatistics(h, {
      settle,
      capture: () => run(),
      grow: async () => {
        await remoteAccounts(h, 100, 200);
        await sql(
          h.store,
          `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 1999)
					INSERT INTO accounts (id, uri, username) SELECT CAST(600000000000000000 + i AS TEXT),
						'https://kopje.test/ap/users/g' || i, 'g' || i FROM n`,
        );
        await sql(
          h.store,
          `INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
					SELECT id, username || '@example.com', X'00', X'00', 'test' FROM accounts WHERE id GLOB '6*'`,
        );
      },
    });
    const shown = (after.result as { value: { id: string }[] }).value.map((entry) => entry.id);
    expect(shown).toEqual(requested.filter((id) => !unavailable.has(id)));
    expect(shown).toHaveLength(MAX_RELATIONSHIP_IDS - unavailable.size);
    expect(after.result).toEqual(before.result);
    expect(after.plans).toHaveLength(1);
    const { plan, rows } = after.plans[0]!;
    expect(
      plan.filter((detail) => /^SEARCH a USING (COVERING )?INDEX sqlite_autoindex_accounts_1 \(id=\?\)$/.test(detail)),
    ).toHaveLength(1);
    expect(plan).toContainEqual(
      expect.stringMatching(
        /^SEARCH l USING (COVERING )?INDEX sqlite_autoindex_local_accounts_1 \(account_id=\?\)( LEFT-JOIN)?$/,
      ),
    );
    expect(scansOf(plan, ["a", "l", "pn", "pr", "fo", "fb", "p", "n", "m"])).toEqual([]);
    const matches = plan.filter((detail) => /^(SEARCH|SCAN) pr\b/.test(detail));
    expect(matches.length).toBeGreaterThan(0);
    for (const detail of matches) {
      expect(detail).toMatch(/^SEARCH pr USING .*\(domain=\?\)$/);
    }
    expect(rows).toBe(before.plans[0]!.rows);
    // Per requested account, each probe reading at most one row: its accounts row and its local_accounts row (2);
    // domain coverage, for each of its two keys, the walk's and the match's seek of each suffix of 2 to 8 labels
    // (2 x 7 x 2 = 28); and the relationship's edges: fo, fb, p, n, m, both blocks and the account row and two
    // domain_blocks seeks of domain_blocking (10). Then the statement's one seek of the suspend blocks' index.
    expect(rows).toBeLessThanOrEqual(MAX_RELATIONSHIP_IDS * (2 + 2 * (MAX_BLOCK_LABELS - 1) * 2 + 10) + 1);
  }, 120_000);
});
