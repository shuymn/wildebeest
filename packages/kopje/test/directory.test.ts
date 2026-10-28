import { describe, expect, it } from "vitest";

import { DIRECTORY_WINDOW, MAX_DIRECTORY_OFFSET } from "../src/domain/directory";
import { bearer, json, sql } from "./api-helpers";
import { harness, NOW } from "./app-helpers";
import { fixtureKeyGen, LEGACY_EMPTY_KEK, seedLocalAccount } from "./federation-helpers";
import { BUILD, completeSetup, migratedStore } from "./helpers";
import { mastodonActor, RemoteWeb, signedInit } from "./inbox-helpers";
import { scopedToken } from "./read-helpers";
import { act, block, community, domainBlock, getJson, mute, remoteAccount, seedStatus } from "./status-helpers";

// GET /api/v1/directory (Mastodon 4.5's Api::V1::DirectoriesController): the discoverable accounts, by order, local or
// all, paged by offset and limit, less what R12 hides from the viewer (docs/visibility.md).

type Listed = { id: string; acct: string; last_status_at: string | null };

const discoverable = (store: Parameters<typeof sql>[0], ...ids: string[]) =>
  sql(store, `UPDATE accounts SET discoverable = 1 WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids));

async function listed(h: Parameters<typeof getJson>[0], query = "", token?: string): Promise<string[]> {
  const { status, body } = await getJson<Listed[]>(h, `/api/v1/directory${query}`, token);
  expect(status).toBe(200);
  return body.map((account) => account.acct);
}

// alice, bob and carol are local; dan and erin remote. Statuses, oldest first: erin, carol, dan; bob posts only a
// direct status; alice none. Every account is discoverable.
async function directoryWorld() {
  const h = await community(["alice", "bob", "carol"]);
  const { alice, bob, carol } = h.users;
  const dan = await remoteAccount(h.store, "dan", "one.example");
  const erin = await remoteAccount(h.store, "erin", "two.example");
  await discoverable(h.store, alice.id, bob.id, carol.id, dan, erin);
  const day = 86_400_000;
  await seedStatus(h.store, { accountId: erin, visibility: "public", published: NOW - 3 * day });
  await seedStatus(h.store, { accountId: carol.id, visibility: "private", published: NOW - 2 * day });
  const danStatus = await seedStatus(h.store, { accountId: dan, visibility: "unlisted", published: NOW - day });
  await seedStatus(h.store, { accountId: bob.id, visibility: "direct", published: NOW });
  return { h, dan, erin, danStatus };
}

describe("the profile directory", () => {
  it("lists the most recently active first, accounts without a status last, and by order=new the newest", async () => {
    const { h } = await directoryWorld();
    const active = ["dan@one.example", "carol", "erin@two.example", "bob", "alice"];
    expect(await listed(h)).toEqual(active);
    expect(await listed(h, "?order=active")).toEqual(active);
    // Accounts in the order they were stored, newest first; an unknown order reads as active.
    expect(await listed(h, "?order=new")).toEqual(["erin@two.example", "dan@one.example", "carol", "bob", "alice"]);
    expect(await listed(h, "?order=popular")).toEqual(active);
    const { body } = await getJson<Listed[]>(h, "/api/v1/directory");
    expect(body.map((account) => account.last_status_at)).toEqual([
      "2026-10-11",
      "2026-10-10",
      "2026-10-09",
      null,
      null,
    ]);
  });

  it("moves an account back when its newest status goes, and forward when it posts", async () => {
    const { h, danStatus } = await directoryWorld();
    const { alice } = h.users;
    await sql(h.store, "DELETE FROM statuses WHERE id = ?", danStatus);
    // Without a status, dan joins the accounts without one, by id.
    expect(await listed(h)).toEqual(["carol", "erin@two.example", "dan@one.example", "bob", "alice"]);
    const posted = await act(h, alice, "/api/v1/statuses", { status: "hello" });
    expect(posted.status).toBe(200);
    expect((await listed(h))[0]).toBe("alice");
    // A status hidden on its way to deletion (made direct first) no longer counts.
    await sql(h.store, "UPDATE statuses SET visibility = 'direct' WHERE account_id = ?", alice.id);
    expect(await listed(h)).toEqual(["carol", "erin@two.example", "dan@one.example", "bob", "alice"]);
  });

  it("lists only local accounts with local=true", async () => {
    const { h } = await directoryWorld();
    expect(await listed(h, "?local=true")).toEqual(["carol", "bob", "alice"]);
    expect(await listed(h, "?local=true&order=new")).toEqual(["carol", "bob", "alice"]);
    expect(await listed(h, "?local=false&order=new")).toHaveLength(5);
  });

  it("pages by offset and limit: 40 by default, at most 80, none past the offset bound", async () => {
    const { h } = await directoryWorld();
    expect(await listed(h, "?limit=2")).toEqual(["dan@one.example", "carol"]);
    expect(await listed(h, "?limit=2&offset=2")).toEqual(["erin@two.example", "bob"]);
    expect(await listed(h, "?limit=2&offset=4")).toEqual(["alice"]);
    expect(await listed(h, "?limit=-2&offset=1")).toEqual(["carol", "erin@two.example"]);
    expect(await listed(h, "?limit=0")).toEqual([]);
    expect(await listed(h, "?offset=-3")).toHaveLength(5);
    // Many more discoverable accounts, without statuses, so newer than the world's.
    await sql(
      h.store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO accounts (id, uri, username, domain, discoverable)
			SELECT CAST(900000000000000000 + i AS TEXT), 'https://many.example/users/u' || i, 'u' || i, 'many.example', 1
			FROM n`,
      MAX_DIRECTORY_OFFSET + 10,
    );
    expect(await listed(h)).toHaveLength(40);
    expect(await listed(h, "?limit=500")).toHaveLength(80);
    expect(await listed(h, `?order=new&offset=${MAX_DIRECTORY_OFFSET}&limit=2`)).toEqual([
      "u9@many.example",
      "u8@many.example",
    ]);
    // Past the bound, nothing, though accounts remain there.
    expect(await listed(h, `?order=new&offset=${MAX_DIRECTORY_OFFSET + 1}`)).toEqual([]);
  });

  it("leaves out the accounts the viewer blocks, mutes or is blocked by, and those on domains it blocks", async () => {
    const { h, dan } = await directoryWorld();
    const { alice, bob, carol } = h.users;
    await block(h.store, alice.id, carol.id);
    await mute(h.store, alice.id, dan);
    await block(h.store, bob.id, alice.id);
    await domainBlock(h.store, alice.id, "two.example");
    expect(await listed(h, "", alice.token)).toEqual(["alice"]);
    expect(await listed(h, "?local=true", alice.token)).toEqual(["alice"]);
    // The anonymous viewer sees every account, and carol every one but alice, who blocks her.
    expect(await listed(h, "")).toHaveLength(5);
    expect(await listed(h, "", carol.token)).toEqual(["dan@one.example", "carol", "erin@two.example", "bob"]);
    // An expired mute no longer hides.
    await sql(h.store, "UPDATE mutes SET expires_at = '2026-01-01T00:00:00.000Z' WHERE target_account_id = ?", dan);
    expect(await listed(h, "", alice.token)).toEqual(["dan@one.example", "alice"]);
    await sql(h.store, "DELETE FROM domain_blocks");
    expect(await listed(h, "", alice.token)).toEqual(["dan@one.example", "erin@two.example", "alice"]);
  });

  it("leaves out suspended accounts, accounts being deleted and accounts that are not discoverable", async () => {
    const { h, dan, erin } = await directoryWorld();
    const { bob, carol } = h.users;
    await sql(
      h.store,
      "UPDATE local_accounts SET suspended_at = '2026-10-01T00:00:00.000Z' WHERE account_id = ?",
      bob.id,
    );
    await sql(h.store, "UPDATE accounts SET deleted_at = '2026-10-01T00:00:00.000Z' WHERE id = ?", dan);
    await sql(h.store, "UPDATE accounts SET discoverable = 0 WHERE id = ?", carol.id);
    await sql(h.store, "UPDATE accounts SET discoverable = NULL WHERE id = ?", erin);
    expect(await listed(h)).toEqual(["alice"]);
    expect(await listed(h, "?order=new")).toEqual(["alice"]);
  });

  it("follows a local account's setting through update_credentials", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    expect(await listed(h)).toEqual([]);
    const update = (discoverable: boolean) =>
      h.request(
        "/api/v1/accounts/update_credentials",
        bearer(alice.token, json({ discoverable }, { method: "PATCH" })),
      );
    expect((await update(true)).status).toBe(200);
    expect(await listed(h)).toEqual(["alice"]);
    expect((await update(false)).status).toBe(200);
    expect(await listed(h)).toEqual([]);
  });

  it("comes back short when more than half of its window is hidden from the viewer", async () => {
    const { h } = await directoryWorld();
    const { alice } = h.users;
    // Six newer accounts alice blocks: a page of 2 reads a window of 4 entries, all blocked; a page of 4 reads 8.
    for (let i = 0; i < 6; i++) {
      const id = await remoteAccount(h.store, `spam${i}`, "spam.example");
      await discoverable(h.store, id);
      await block(h.store, alice.id, id);
    }
    expect(DIRECTORY_WINDOW).toBe(2);
    expect(await listed(h, "?order=new&limit=2", alice.token)).toEqual([]);
    expect(await listed(h, "?order=new&limit=4", alice.token)).toEqual(["erin@two.example", "dan@one.example"]);
    expect(await listed(h, "?order=new&limit=40", alice.token)).toEqual([
      "erin@two.example",
      "dan@one.example",
      "carol",
      "bob",
      "alice",
    ]);
  });

  it("needs no token, caches only an anonymous answer, and refuses a bad token", async () => {
    const { h } = await directoryWorld();
    const anonymous = await h.request("/api/v1/directory");
    expect(anonymous.status).toBe(200);
    expect(anonymous.headers.get("cache-control")).toBe(
      "public, max-age=15, stale-while-revalidate=30, stale-if-error=86400",
    );
    expect(anonymous.headers.get("vary")).toContain("Authorization");
    const signed = await h.request("/api/v1/directory", bearer(h.users.alice.token));
    expect(signed.status).toBe(200);
    expect(signed.headers.get("cache-control")).toBeNull();
    expect((await h.request("/api/v1/directory", bearer("nope"))).status).toBe(401);
    // Any scope will do (Mastodon declares none).
    expect((await h.request("/api/v1/directory", bearer(await scopedToken(h, "write:statuses")))).status).toBe(200);
  });
});

describe("a remote account's discoverable", () => {
  it("is what its actor published, refreshed by an Update", async () => {
    const store = await migratedStore();
    await completeSetup(store);
    await seedLocalAccount(store, "kopje.test", { id: "111111111111111111", username: "alice", key: LEGACY_EMPTY_KEK });
    const web = new RemoteWeb();
    const h = harness(store, {}, BUILD, { keygen: fixtureKeyGen, loader: web.loader });
    const send = async (actor: Awaited<ReturnType<typeof mastodonActor>>, activity: unknown) =>
      (await h.request("/inbox", await signedInit(actor, "/inbox", activity))).status;
    const AS = "https://www.w3.org/ns/activitystreams";
    // The remote accounts listed (alice, local, is discoverable too).
    const shown = async () =>
      (await (await h.request("/api/v1/directory")).json<Listed[]>())
        .map((account) => account.acct)
        .filter((acct) => acct.includes("@"));

    const bob = await mastodonActor(web, "bob");
    const carol = await mastodonActor(web, "carol", { extra: { discoverable: false } });
    const dave = await mastodonActor(web, "dave", { extra: { discoverable: undefined } });
    for (const [actor, n] of [
      [bob, 1],
      [carol, 2],
      [dave, 3],
    ] as const) {
      const follow = {
        "@context": AS,
        id: `${actor.uri}#follows/${n}`,
        type: "Follow",
        actor: actor.uri,
        object: "https://kopje.test/ap/users/alice",
      };
      expect(await send(actor, follow)).toBe(202);
    }
    expect(await shown()).toEqual(["bob@mastodon.example"]);

    const hidden = { ...bob.document, discoverable: false };
    web.serve(bob.uri, hidden);
    expect(
      await send(bob, { "@context": AS, id: `${bob.uri}#updates/1`, type: "Update", actor: bob.uri, object: hidden }),
    ).toBe(202);
    expect(await shown()).toEqual([]);
    const found = { ...carol.document, discoverable: true };
    web.serve(carol.uri, found);
    expect(
      await send(carol, {
        "@context": AS,
        id: `${carol.uri}#updates/1`,
        type: "Update",
        actor: carol.uri,
        object: found,
      }),
    ).toBe(202);
    expect(await shown()).toEqual(["carol@mastodon.example"]);
  });
});
