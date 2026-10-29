import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { MAX_RETRACTIONS_PER_ACTOR, PURGE_BATCH, purgeBatch } from "../src/domain/inbox";
import { SWEEP_BATCH } from "../src/domain/remote-actors";
import {
  BudgetExceededError,
  createSafeLoader,
  DOCUMENT_BODY_LIMIT,
  isTransientLoadError,
  REQUEST_MAX_BYTES,
  REQUEST_MAX_FETCHES,
} from "../src/federation/loader";
import { handleQueue, runScheduledJobs } from "../src/jobs/queue";
import { sha256Hex } from "../src/platform/sha256";
import type { StoreStub } from "../src/platform/store-client";
import { bearer, json, sql } from "./api-helpers";
import { harness, inboxDeps, NOW } from "./app-helpers";
import { fixtureKeyGen, LEGACY_EMPTY_KEK, seedLocalAccount } from "./federation-helpers";
import { BUILD, completeSetup, migratedStore } from "./helpers";
import {
  LOCAL,
  MASTODON,
  mastodonActor,
  RemoteWeb,
  type SignOptions,
  signedInit,
  type TestActor,
} from "./inbox-helpers";
import { announce, mastodonNote, OTHER, type Setup as StatusSetup, statuses } from "./inbox-status-helpers";
import { staleAuthorWorld } from "./stale-author-helpers";
import { community } from "./status-helpers";

// Regressions in inbound actor and relationship handling: durable purges, key rotation and key ownership (ID-1),
// Follow generations, Block against a replayed Follow, Move progress and replays (ID-4, ID-7), transient JSON-LD
// contexts, the per-request fetch budget (RES-6), and deletion independent of the retraction cap (ID-7, RES-4).

const AS = "https://www.w3.org/ns/activitystreams";
const ALICE = "111111111111111111";
const ALICE_URI = `${LOCAL}/ap/users/alice`;
const DAVE_URI = `${LOCAL}/ap/users/dave`;
const DAY = 24 * 60 * 60 * 1000;

async function setup(options: { queue?: "failing" } = {}) {
  const store = await migratedStore();
  await completeSetup(store);
  await seedLocalAccount(store, "kopje.test", { id: ALICE, username: "alice", key: LEGACY_EMPTY_KEK });
  await seedLocalAccount(store, "kopje.test", { id: "222222222222222222", username: "dave", key: LEGACY_EMPTY_KEK });
  const web = new RemoteWeb();
  const overrides =
    options.queue === "failing" ? { QUEUE: { send: () => Promise.reject(new Error("queue down")) } } : {};
  const h = harness(store, overrides, BUILD, { keygen: fixtureKeyGen, loader: web.loader });
  const post = async (actor: TestActor, activity: unknown, sign: SignOptions = {}) =>
    (await h.request("/inbox", await signedInit(actor, "/inbox", activity, sign))).status;
  const deps = inboxDeps(() => store, web.loader);
  return { store, web, post, deps, ...h };
}

let sequence = 0;
const nextId = (actor: TestActor) => `${new URL(actor.uri).origin}/activities/r${++sequence}`;
const follow = (actor: TestActor, id = nextId(actor), object = ALICE_URI) => ({
  "@context": AS,
  id,
  type: "Follow",
  actor: actor.uri,
  object,
});
const embedded = (activity: Record<string, unknown>) => ({ ...activity, "@context": undefined });

const edges = (store: StoreStub) =>
  sql<{ account_id: string; target_account_id: string; state: string; uri: string | null }>(
    store,
    "SELECT account_id, target_account_id, state, uri FROM follows ORDER BY id",
  );
const count = async (store: StoreStub, query: string, ...params: SqlStorageValue[]) =>
  (await sql<{ n: number }>(store, `SELECT count(*) AS n FROM (${query})`, ...params))[0]!.n;
const accountId = async (store: StoreStub, uri: string) =>
  (await sql<{ id: string }>(store, "SELECT id FROM accounts WHERE uri = ?", uri))[0]?.id;

async function seedStatuses(store: StoreStub, accountUri: string, n: number): Promise<void> {
  await sql(
    store,
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
		INSERT INTO statuses (id, uri, account_id, visibility, published_at)
		SELECT printf('3%017d', i), ? || '/statuses/' || i, (SELECT id FROM accounts WHERE uri = ?), 'public',
			'2026-10-01T00:00:00.000Z' FROM n`,
    n,
    accountUri,
    accountUri,
  );
}

const deleteSelf = (actor: TestActor) => ({
  "@context": AS,
  id: `${actor.uri}#delete`,
  type: "Delete",
  actor: actor.uri,
  object: actor.uri,
});

describe("durable purge of a deleted actor (OPS-1, RES-6)", () => {
  async function deleted(options: { queue?: "failing" } = {}) {
    const t = await setup(options);
    const bob = await mastodonActor(t.web, "bob");
    await t.post(bob, follow(bob));
    await seedStatuses(t.store, bob.uri, PURGE_BATCH * 2 + 1);
    t.web.fail(bob.uri, 410);
    expect(await t.post(bob, deleteSelf(bob))).toBe(202);
    const left = await count(t.store, "SELECT 1 FROM statuses");
    expect(left).toBeGreaterThan(PURGE_BATCH);
    expect(left).toBeLessThan(PURGE_BATCH * 2 + 1);
    return { ...t, bob, left };
  }
  const env = (t: { env: Env }, mode = "off") => ({ ...t.env, MAINTENANCE: mode }) as Env;

  it("finishes from cron when the Queue send failed", async () => {
    const t = await deleted({ queue: "failing" });
    await runScheduledJobs(env(t), t.deps);
    expect(await count(t.store, "SELECT 1 FROM statuses")).toBe(0);
    expect(await accountId(t.store, t.bob.uri)).toBeUndefined();
  });

  it("spends no retry in maintenance and finishes afterwards", async () => {
    const t = await deleted();
    await t.queue.deliver((batch) => handleQueue(batch, env(t, "readonly"), t.deps));
    await runScheduledJobs(env(t, "readonly"), t.deps);
    expect(t.queue.retries).toBe(0);
    expect(await count(t.store, "SELECT 1 FROM statuses")).toBe(t.left);

    await runScheduledJobs(env(t), t.deps);
    expect(await count(t.store, "SELECT 1 FROM statuses")).toBe(0);
  });

  it("purges an actor stored again after its tombstone expired, when it deletes itself again", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await t.post(bob, follow(bob));
    t.web.fail(bob.uri, 410);
    expect(await t.post(bob, deleteSelf(bob))).toBe(202);
    expect(await accountId(t.store, bob.uri)).toBeUndefined();

    // The tombstone has expired but its row is not swept yet: older expired jobs fill the sweeps of the next requests.
    await sql(t.store, "UPDATE inbound_jobs SET expires_at = ? WHERE kind = 'purge' AND key = ?", NOW - 1, bob.uri);
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO inbound_jobs (kind, key, actor_uri, done_at, expires_at, created_at)
			SELECT 'purge', 'https://gone.example/u/' || i, 'https://gone.example/u/' || i, 0, ?2, 0 FROM n`,
      SWEEP_BATCH * 3,
      NOW - 2,
    );
    t.web.serve(bob.uri, bob.document);
    expect(await t.post(bob, follow(bob))).toBe(202);
    expect(await accountId(t.store, bob.uri)).toBeDefined();
    await seedStatuses(t.store, bob.uri, PURGE_BATCH + 1);

    t.web.fail(bob.uri, 410);
    expect(await t.post(bob, { ...deleteSelf(bob), id: `${bob.uri}#delete-again` })).toBe(202);
    await runScheduledJobs(env(t), t.deps);
    expect(await accountId(t.store, bob.uri)).toBeUndefined();
    expect(await count(t.store, "SELECT 1 FROM statuses")).toBe(0);
    // The tombstone is renewed: the actor is not stored again by its next activity.
    expect(
      await sql(t.store, "SELECT done_at, expires_at FROM inbound_jobs WHERE kind = 'purge' AND key = ?", bob.uri),
    ).toEqual([{ done_at: NOW, expires_at: NOW + 30 * DAY }]);
    t.web.serve(bob.uri, bob.document);
    expect(await t.post(bob, follow(bob))).toBe(202);
    expect(await accountId(t.store, bob.uri)).toBeUndefined();
  });

  it("renews the expired tombstone of an actor that deletes itself again without being stored", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await t.post(bob, follow(bob));
    t.web.fail(bob.uri, 410);
    expect(await t.post(bob, deleteSelf(bob))).toBe(202);
    await sql(t.store, "UPDATE inbound_jobs SET expires_at = ? WHERE kind = 'purge' AND key = ?", NOW - 1, bob.uri);
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO inbound_jobs (kind, key, actor_uri, done_at, expires_at, created_at)
			SELECT 'purge', 'https://gone.example/u/' || i, 'https://gone.example/u/' || i, 0, ?2, 0 FROM n`,
      SWEEP_BATCH * 2,
      NOW - 2,
    );
    t.web.serve(bob.uri, bob.document);
    expect(await t.post(bob, { ...deleteSelf(bob), id: `${bob.uri}#delete-again` })).toBe(202);
    expect(
      await sql(t.store, "SELECT done_at, expires_at FROM inbound_jobs WHERE kind = 'purge' AND key = ?", bob.uri),
    ).toEqual([{ done_at: NOW, expires_at: NOW + 30 * DAY }]);
    expect(await t.post(bob, follow(bob))).toBe(202);
    expect(await accountId(t.store, bob.uri)).toBeUndefined();
  });

  it("handles a duplicate Queue message, and ignores the actor’s live activity meanwhile", async () => {
    const t = await deleted();
    t.queue.pending.push({ ...t.queue.pending[0]!, id: "duplicate" });
    t.web.serve(t.bob.uri, t.bob.document);
    expect(await t.post(t.bob, follow(t.bob))).toBe(202);
    await t.queue.deliver((batch) => handleQueue(batch, env(t), t.deps));
    await t.queue.deliver((batch) => handleQueue(batch, env(t), t.deps));
    expect(t.queue.retries).toBe(0);
    expect(t.queue.pending.filter((m) => (m.body as { kind: string }).kind === "inbound-jobs")).toEqual([]);
    expect(await count(t.store, "SELECT 1 FROM statuses")).toBe(0);
    expect(await edges(t.store)).toEqual([]);
    expect(await t.post(t.bob, follow(t.bob))).toBe(202);
    expect(await edges(t.store)).toEqual([]);
  });
});

describe("ID-1: stored keys, rotation and ownership", () => {
  it("verifies a key on a separate path without a fragment, and a later Delete with it", async () => {
    const t = await setup();
    const uri = `${MASTODON}/users/gts`;
    const keyId = `${uri}/main-key`;
    const gts = await mastodonActor(t.web, "gts", { extra: {} });
    const document = { ...gts.document, publicKey: { id: keyId, owner: uri, publicKeyPem: gts.pem } };
    t.web.serve(uri, document);
    t.web.serve(keyId, document);
    expect(await t.post(gts, follow(gts), { keyId })).toBe(202);
    expect((await edges(t.store)).length).toBe(1);

    t.web.fail(uri, 410);
    t.web.fail(keyId, 410);
    // Any cached copy of the documents has expired by the time the actor is deleted.
    await sql(t.store, "DELETE FROM fedify_kv");
    expect(await t.post(gts, deleteSelf(gts), { keyId })).toBe(202);
    expect(await accountId(t.store, uri)).toBeUndefined();
    expect(await edges(t.store)).toEqual([]);
  });

  it("refuses a key the actor lists but that names another owner, cold and warm", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const carol = await mastodonActor(t.web, "carol", { key: 2 });
    const second = `${bob.uri}#second`;
    t.web.serve(bob.uri, {
      ...bob.document,
      publicKey: [bob.document.publicKey, { id: second, owner: carol.uri, publicKeyPem: carol.pem }],
    });
    expect(await t.post(bob, follow(bob), { keyId: second, privateKey: carol.privateKey })).toBe(401);
    expect(await t.post(bob, follow(bob, nextId(bob), DAVE_URI))).toBe(202);
    expect(await sql(t.store, "SELECT key_id FROM remote_keys")).toEqual([{ key_id: bob.keyId }]);
    expect(await t.post(bob, follow(bob), { keyId: second, privateKey: carol.privateKey })).toBe(401);
  });

  it("accepts any of several keys the actor owns", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const spare = await mastodonActor(t.web, "spare", { key: 3 });
    const second = `${bob.uri}#second`;
    t.web.serve(bob.uri, {
      ...bob.document,
      publicKey: [bob.document.publicKey, { id: second, owner: bob.uri, publicKeyPem: spare.pem }],
    });
    expect(await t.post(bob, follow(bob), { keyId: second, privateKey: spare.privateKey })).toBe(202);
    expect(await t.post(bob, follow(bob, nextId(bob), DAVE_URI))).toBe(202);
    expect((await edges(t.store)).length).toBe(2);
  });

  it("trusts a stored key for 24 hours and fetches the actor again at the boundary", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await t.post(bob, follow(bob, nextId(bob), DAVE_URI));
    const fetches = () => t.web.fetched.filter((url) => url === bob.uri).length;
    await sql(t.store, "UPDATE remote_keys SET fetched_at = ?", NOW - DAY + 1);
    const before = fetches();
    expect(await t.post(bob, follow(bob))).toBe(202);
    expect(fetches()).toBe(before);
    await sql(t.store, "UPDATE remote_keys SET fetched_at = ?", NOW - DAY);
    expect(await t.post(bob, follow(bob))).toBe(202);
    expect(fetches()).toBeGreaterThan(before);
  });

  it("refuses the old key material after a rotation under the same id, and takes the new one", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const next = await mastodonActor(t.web, "next", { key: 3 });
    await t.post(bob, follow(bob, nextId(bob), DAVE_URI));
    const rotated = { ...bob.document, publicKey: { id: bob.keyId, owner: bob.uri, publicKeyPem: next.pem } };
    t.web.serve(bob.uri, rotated);

    // Within 24 hours the new key verifies after Fedify refetches it, and replaces the stored one.
    expect(await t.post(bob, follow(bob), { privateKey: next.privateKey })).toBe(202);
    expect(await sql(t.store, "SELECT pem FROM remote_keys")).toEqual([{ pem: next.pem }]);

    // The old key is refused once its document is stale, even though its id is still listed.
    await sql(t.store, "UPDATE remote_keys SET pem = ?, fetched_at = ?", bob.pem, NOW - DAY - 1);
    expect(await t.post(bob, follow(bob, nextId(bob), DAVE_URI + "x"))).toBe(401);
  });

  it("refuses a stale stored key whose actor document now lists other material, even if cached", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await t.post(bob, follow(bob, nextId(bob), DAVE_URI));
    const next = await mastodonActor(t.web, "next", { key: 3 });
    t.web.serve(bob.uri, { ...bob.document, publicKey: { id: bob.keyId, owner: bob.uri, publicKeyPem: next.pem } });
    await sql(t.store, "UPDATE remote_keys SET fetched_at = ?", NOW - DAY - 1);
    expect(await t.post(bob, follow(bob))).toBe(401);
    expect((await edges(t.store)).filter((e) => e.target_account_id === ALICE)).toEqual([]);
  });
});

describe("Follow generations (ID-6, ID-7)", () => {
  it("keeps the current generation when an Undo of the superseded Follow arrives late", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const f1 = follow(bob);
    const f2 = follow(bob);
    await t.post(bob, f1);
    await t.post(bob, f2);
    const undo = { "@context": AS, id: nextId(bob), type: "Undo", actor: bob.uri, object: embedded(f1) };
    expect(await t.post(bob, undo)).toBe(202);
    expect((await edges(t.store)).map((e) => e.uri)).toEqual([f2.id]);
    expect(await count(t.store, "SELECT 1 FROM notifications")).toBe(1);
  });

  it("answers two generations with two Accepts", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const f1 = follow(bob);
    const f2 = follow(bob);
    await t.post(bob, f1);
    // The first Accept is claimed (exposed), so the second Follow leaves it (cancelFollowAnswers).
    expect((await t.store.claimDeliveries(BUILD, { now: NOW, leaseToken: "first" })).deliveries).toHaveLength(1);
    await t.post(bob, f2);
    const ids = (
      await sql<{ id: string }>(t.store, "SELECT json_extract(body, '$.activity.id') AS id FROM outbound_activities")
    ).map((r) => r.id);
    expect(ids).toEqual([
      `${ALICE_URI}#accepts/follows/${sha256Hex(f1.id)}`,
      `${ALICE_URI}#accepts/follows/${sha256Hex(f2.id)}`,
    ]);
  });

  it("accepts or rejects our follow only for its current id; a string Accept names it", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await t.post(bob, follow(bob, nextId(bob), DAVE_URI));
    const bobId = (await accountId(t.store, bob.uri))!;
    const f1 = `${LOCAL}/follows/1`;
    const f2 = `${LOCAL}/follows/2`;
    await sql(
      t.store,
      "INSERT INTO follows (account_id, target_account_id, state, uri) VALUES (?, ?, 'pending', ?)",
      ALICE,
      bobId,
      f2,
    );
    const ours = async () => (await edges(t.store)).find((e) => e.account_id === ALICE);
    const answer = (type: string, object: unknown) => ({
      "@context": AS,
      id: nextId(bob),
      type,
      actor: bob.uri,
      object,
    });

    expect(await t.post(bob, answer("Accept", { id: f1, type: "Follow", actor: ALICE_URI, object: bob.uri }))).toBe(
      202,
    );
    expect(await t.post(bob, answer("Reject", { id: f1, type: "Follow", actor: ALICE_URI, object: bob.uri }))).toBe(
      202,
    );
    expect((await ours())?.state).toBe("pending");
    expect(await t.post(bob, answer("Accept", f2))).toBe(202);
    expect((await ours())?.state).toBe("accepted");
  });

  it("keeps Misskey’s pair-shaped Undo working", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await t.post(bob, follow(bob));
    const pair = { id: `${MASTODON}/follows/9abc/9def`, type: "Follow", actor: bob.uri, object: ALICE_URI };
    expect(await t.post(bob, { "@context": AS, id: nextId(bob), type: "Undo", actor: bob.uri, object: pair })).toBe(
      202,
    );
    expect(await edges(t.store)).toEqual([]);
  });
});

describe("Block against a replayed Follow (ID-7)", () => {
  it("does not restore the follow, notify, or accept again", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const f = follow(bob);
    await t.post(bob, f);
    await t.post(bob, { "@context": AS, id: `${bob.uri}#blocks/1`, type: "Block", actor: bob.uri, object: ALICE_URI });
    await sql(t.store, "DELETE FROM notifications");
    expect(await t.post(bob, f)).toBe(202);
    expect(await t.post(bob, follow(bob))).toBe(202);
    expect(await edges(t.store)).toEqual([]);
    expect(await count(t.store, "SELECT 1 FROM notifications")).toBe(0);
    expect(await count(t.store, "SELECT 1 FROM outbound_activities")).toBe(1);
  });
});

describe("Move progress and replays (ID-4, ID-7, RES-6)", () => {
  async function moving(followers: number) {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const bob2 = await mastodonActor(t.web, "bob2", { origin: "https://new.example", key: 2 });
    t.web.serve(bob2.uri, { ...bob2.document, alsoKnownAs: [bob.uri] });
    await t.post(bob, follow(bob, nextId(bob), DAVE_URI));
    const bobId = (await accountId(t.store, bob.uri))!;
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO accounts (id, uri, username, domain) SELECT printf('5%017d', i), ? || i, 'u' || i, NULL FROM n`,
      followers,
      `${LOCAL}/ap/users/u`,
    );
    await sql(
      t.store,
      `INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
			SELECT id, username || '@mail.example', x'00', x'00', 'k' FROM accounts WHERE id GLOB '5*'`,
    );
    await sql(
      t.store,
      "INSERT INTO follows (account_id, target_account_id, state) SELECT id, ?, 'accepted' FROM accounts WHERE id GLOB '5*' ORDER BY id",
      bobId,
    );
    const move = {
      "@context": AS,
      id: `${bob.uri}#moves/1`,
      type: "Move",
      actor: bob.uri,
      object: bob.uri,
      target: bob2.uri,
    };
    const moved = async () =>
      count(t.store, "SELECT 1 FROM follows f JOIN accounts a ON a.id = f.target_account_id WHERE a.uri = ?", bob2.uri);
    return { ...t, bob, bob2, bobId, move, moved };
  }

  it("moves 100 followers in one batch", async () => {
    const t = await moving(100);
    expect(await t.post(t.bob, t.move)).toBe(202);
    expect(await t.moved()).toBe(100);
    expect(await count(t.store, "SELECT 1 FROM inbound_jobs WHERE done_at IS NULL")).toBe(0);
  });

  it("moves the 101st from the stored progress, and a replay moves nothing more", async () => {
    const t = await moving(101);
    expect(await t.post(t.bob, t.move)).toBe(202);
    expect(await t.moved()).toBe(100);
    await t.queue.deliver((batch) => handleQueue(batch, { ...t.env, MAINTENANCE: "off" } as Env, t.deps));
    expect(await t.moved()).toBe(101);
    expect(await t.post(t.bob, t.move)).toBe(202);
    expect(await t.moved()).toBe(101);
  });

  it("does not move a follow made after the Move when the Move is delivered again", async () => {
    const t = await moving(1);
    expect(await t.post(t.bob, t.move)).toBe(202);
    await sql(
      t.store,
      "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
      ALICE,
      t.bobId,
    );
    expect(await t.post(t.bob, t.move)).toBe(202);
    expect((await edges(t.store)).filter((e) => e.account_id === ALICE)).toEqual([
      { account_id: ALICE, target_account_id: t.bobId, state: "accepted", uri: null },
    ]);
  });

  it("never stores a deleted actor again as a Move target (ID-7)", async () => {
    const t = await moving(1);
    await t.post(t.bob2, follow(t.bob2));
    t.web.fail(t.bob2.uri, 410);
    expect(await t.post(t.bob2, deleteSelf(t.bob2))).toBe(202);
    t.web.serve(t.bob2.uri, { ...t.bob2.document, alsoKnownAs: [t.bob.uri] });
    expect(await t.post(t.bob, t.move)).toBe(202);
    expect(await accountId(t.store, t.bob2.uri)).toBeUndefined();
  });

  it("continues an unfinished Move without moving a follow made after it, and survives a repeated delivery", async () => {
    const t = await moving(101);
    expect(await t.post(t.bob, t.move)).toBe(202);
    await sql(
      t.store,
      "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
      ALICE,
      t.bobId,
    );
    // The response to the first delivery was lost: the Move comes again while its job is unfinished.
    expect(await t.post(t.bob, t.move)).toBe(202);
    await t.queue.deliver((batch) => handleQueue(batch, { ...t.env, MAINTENANCE: "off" } as Env, t.deps));
    expect(await t.moved()).toBe(101);
    expect((await edges(t.store)).filter((e) => e.account_id === ALICE)).toEqual([
      { account_id: ALICE, target_account_id: t.bobId, state: "accepted", uri: null },
    ]);
  });

  it("ends a Move whose target deleted itself before the next batch (ID-7)", async () => {
    const t = await moving(101);
    await t.post(t.bob2, follow(t.bob2, nextId(t.bob2), DAVE_URI));
    await seedStatuses(t.store, t.bob2.uri, PURGE_BATCH + 1);
    expect(await t.post(t.bob, t.move)).toBe(202);
    t.web.fail(t.bob2.uri, 410);
    expect(await t.post(t.bob2, deleteSelf(t.bob2))).toBe(202);
    const env = { ...t.env, MAINTENANCE: "off" } as Env;
    for (let round = 0; round < 3; round++) {
      await t.queue.deliver((batch) => handleQueue(batch, env, t.deps));
      await runScheduledJobs(env, t.deps);
    }
    expect(await t.moved()).toBe(0);
    expect(await accountId(t.store, t.bob2.uri)).toBeUndefined();
    // The follower the Move had not reached still follows the source.
    expect(await count(t.store, "SELECT 1 FROM follows WHERE target_account_id = ?", t.bobId)).toBe(1);
  });

  it("gives the same result when the Queue and cron run the Move at once", async () => {
    const t = await moving(250);
    expect(await t.post(t.bob, t.move)).toBe(202);
    const env = { ...t.env, MAINTENANCE: "off" } as Env;
    for (let round = 0; round < 3; round++) {
      await Promise.all([t.queue.deliver((batch) => handleQueue(batch, env, t.deps)), runScheduledJobs(env, t.deps)]);
    }
    expect(await t.moved()).toBe(250);
    expect(await count(t.store, "SELECT 1 FROM follows WHERE target_account_id = ?", t.bobId)).toBe(0);
  });
});

describe("the retraction cap does not stop a deletion (ID-7, RES-4)", () => {
  it("records the 10,000th retraction of a known actor, not the 10,001st, and still deletes the actor", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await t.post(bob, follow(bob));
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO inbound_retractions (actor_uri, target_uri, expires_at) SELECT ?, ? || '/seeded/' || i, ? FROM n`,
      MAX_RETRACTIONS_PER_ACTOR - 1,
      bob.uri,
      bob.uri,
      NOW + DAY,
    );
    const deletion = (n: number) => ({
      "@context": AS,
      id: nextId(bob),
      type: "Delete",
      actor: bob.uri,
      object: `${bob.uri}/statuses/${n}`,
    });
    await t.post(bob, deletion(1));
    expect(await count(t.store, "SELECT 1 FROM inbound_retractions WHERE actor_uri = ?", bob.uri)).toBe(
      MAX_RETRACTIONS_PER_ACTOR,
    );
    await t.post(bob, deletion(2));
    expect(await count(t.store, "SELECT 1 FROM inbound_retractions WHERE actor_uri = ?", bob.uri)).toBe(
      MAX_RETRACTIONS_PER_ACTOR,
    );

    await seedStatuses(t.store, bob.uri, PURGE_BATCH + 1);
    t.web.fail(bob.uri, 410);
    expect(await t.post(bob, deleteSelf(bob))).toBe(202);
    await runScheduledJobs({ ...t.env, MAINTENANCE: "off" } as Env, t.deps);
    expect(await accountId(t.store, bob.uri)).toBeUndefined();
    expect(await count(t.store, "SELECT 1 FROM statuses")).toBe(0);

    t.web.serve(bob.uri, bob.document);
    expect(await t.post(bob, follow(bob))).toBe(202);
    expect(await edges(t.store)).toEqual([]);
  });
});

describe("remote fetches: transient contexts and the request budget (RES-6)", () => {
  it("answers 503 while a JSON-LD context of the actor fails transiently, then applies the Update", async () => {
    const t = await setup();
    const context = "https://ctx.example/ns";
    const bob = await mastodonActor(t.web, "bob");
    await t.post(bob, follow(bob));
    // The key is verified from the Store; only the actor's fresh document needs the context.
    const updated = {
      ...bob.document,
      name: "Bob 2",
      "@context": [...(bob.document["@context"] as unknown[]), context],
    };
    t.web.serve(bob.uri, updated);
    t.web.fail(context, 503);
    const update = { "@context": AS, id: nextId(bob), type: "Update", actor: bob.uri, object: updated };
    expect(await t.post(bob, update)).toBe(503);
    t.web.serve(context, { "@context": { extra: "https://ctx.example/ns#extra" } }, "application/ld+json");
    expect(await t.post(bob, update)).toBe(202);
    expect(await sql(t.store, "SELECT display_name FROM accounts WHERE uri = ?", bob.uri)).toEqual([
      { display_name: "Bob 2" },
    ]);
  });

  it("answers 503 when the shared fetch budget runs out, contexts included, and changes nothing", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const contexts = Array.from({ length: 20 }, (_, i) => `https://ctx.example/c${i}`);
    for (const url of contexts) {
      t.web.serve(url, { "@context": { [`x${url.at(-1)}`]: `${url}#x` } }, "application/ld+json");
    }
    t.web.serve(bob.uri, { ...bob.document, "@context": [...(bob.document["@context"] as unknown[]), ...contexts] });
    expect(await t.post(bob, follow(bob))).toBe(503);
    expect(t.web.fetched.length).toBeLessThanOrEqual(8);
    expect(await edges(t.store)).toEqual([]);
  });

  // erin's original boosted by bob (followed by alice), with erin stored by a first boost and aged a day: her refetch
  // is optional, so whatever exhausts its share of the budget falls back to the stored row.
  describe("the optional refetch of a stale author (VIS-6, NET-4)", () => {
    // The refetched document renames the actor, so a refresh that was stored shows.
    const withContexts = (actor: TestActor, contexts: string[]) => ({
      ...actor.document,
      name: "Renamed",
      "@context": [...(actor.document["@context"] as unknown[]), ...contexts],
    });
    const stamp = async (t: StatusSetup, uri: string) =>
      (
        await sql<{ fetched_at: string; display_name: string }>(
          t.store,
          "SELECT fetched_at, display_name FROM accounts WHERE uri = ?",
          uri,
        )
      )[0];

    type Exhaustion = [string, (t: StatusSetup, erin: TestActor) => string[]];
    const exhaustions: Exhaustion[] = [
      [
        "the fetch count, on 20 uncached contexts",
        (t, erin) => {
          const contexts = Array.from({ length: 20 }, (_, i) => `https://ctx.example/s${i}`);
          for (const url of contexts) {
            t.web.serve(url, { "@context": { [`s${url.at(-1)}`]: `${url}#s` } }, "application/ld+json");
          }
          t.web.serve(erin.uri, withContexts(erin, contexts));
          return contexts;
        },
      ],
      [
        "a context that answers 503",
        (t, erin) => {
          const context = "https://ctx.example/flaky";
          t.web.fail(context, 503);
          t.web.serve(erin.uri, withContexts(erin, [context]));
          return [context];
        },
      ],
      [
        "the bytes, on contexts each under the document cap and together over the request’s",
        (t, erin) => {
          const each = Math.floor(DOCUMENT_BODY_LIMIT * 0.8);
          const contexts = Array.from({ length: 3 }, (_, i) => `https://ctx.example/b${i}`);
          for (const url of contexts) {
            t.web.serve(
              url,
              { "@context": { [`b${url.at(-1)}`]: `${url}#b` }, pad: "x".repeat(each) },
              "application/ld+json",
            );
          }
          expect(contexts.length * each).toBeGreaterThan(REQUEST_MAX_BYTES);
          t.web.serve(erin.uri, withContexts(erin, contexts));
          return contexts;
        },
      ],
    ];

    it.each(exhaustions)("falls back to the stored author when the refetch runs out of %s", async (_name, exhaust) => {
      const { t, bob, erin } = await staleAuthorWorld();
      const contexts = exhaust(t, erin);
      const note = mastodonNote(erin);
      t.web.serve(note.id, { "@context": AS, ...note });
      expect(await t.post(bob, announce(bob, note.id))).toBe(202);
      expect(t.web.fetched.length).toBeLessThanOrEqual(REQUEST_MAX_FETCHES);
      expect(t.web.fetched.slice(0, 3)).toEqual([note.id, erin.uri, contexts[0]]);
      expect((await statuses(t.store)).map((s) => s.uri)).toContain(note.id);
      const row = await stamp(t, erin.uri);
      expect(row?.fetched_at).toBe(new Date(NOW).toISOString());
      expect(row?.display_name).not.toBe("Renamed");
    });

    it("the bytes case runs out of bytes, not fetches", async () => {
      const { t, bob, erin } = await staleAuthorWorld();
      const contexts = exhaustions[2]![1](t, erin);
      const note = mastodonNote(erin);
      t.web.serve(note.id, { "@context": AS, ...note });
      expect(await t.post(bob, announce(bob, note.id))).toBe(202);
      // Every context was requested, the last one past the request's bytes, within the fetch count.
      expect(t.web.fetched).toEqual([note.id, erin.uri, ...contexts]);
      expect(t.web.fetched.length).toBeLessThan(REQUEST_MAX_FETCHES);
    });

    it("an unknown author that runs out of the budget still answers 503 and stores nothing", async () => {
      const { t, bob } = await staleAuthorWorld();
      const frank = await mastodonActor(t.web, "frank", { origin: OTHER, key: 4 });
      exhaustions[0]![1](t, frank);
      const before = await statuses(t.store);
      const note = mastodonNote(frank);
      t.web.serve(note.id, { "@context": AS, ...note });
      expect(await t.post(bob, announce(bob, note.id))).toBe(503);
      expect(t.web.fetched.length).toBeLessThanOrEqual(REQUEST_MAX_FETCHES);
      expect(await statuses(t.store)).toEqual(before);
      expect(await sql(t.store, "SELECT 1 AS x FROM accounts WHERE uri = ?", frank.uri)).toEqual([]);
    });
  });

  it("answers 503 to a Move whose target exceeds the budget: no job, and the spooled copy is retried", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const bob2 = await mastodonActor(t.web, "bob2", { origin: "https://new.example", key: 2 });
    const contexts = Array.from({ length: 10 }, (_, i) => `https://ctx.example/m${i}`);
    for (const url of contexts) {
      t.web.serve(url, { "@context": { [`m${url.at(-1)}`]: `${url}#m` } }, "application/ld+json");
    }
    t.web.serve(bob2.uri, {
      ...bob2.document,
      alsoKnownAs: [bob.uri],
      "@context": [...(bob2.document["@context"] as unknown[]), ...contexts],
    });
    await t.post(bob, follow(bob));
    const move = {
      "@context": AS,
      id: `${bob.uri}#moves/b`,
      type: "Move",
      actor: bob.uri,
      object: bob.uri,
      target: bob2.uri,
    };
    expect(await t.post(bob, move)).toBe(503);
    expect(await count(t.store, "SELECT 1 FROM inbound_jobs")).toBe(0);

    // Contexts cached by the first attempt cost nothing; the replay starts as cold as the first try.
    await sql(t.store, "DELETE FROM fedify_kv");
    const spool = harness(t.store, { MAINTENANCE: "readonly" }, BUILD, { keygen: fixtureKeyGen, loader: t.web.loader });
    expect((await spool.request("/inbox", await signedInit(bob, "/inbox", move))).status).toBe(202);
    await spool.queue.deliver((batch) => handleQueue(batch, { ...t.env, MAINTENANCE: "off" } as Env, t.deps));
    expect(spool.queue.retries).toBe(1);
    expect(spool.queue.pending).toHaveLength(1);
  });

  it("counts every redirect hop, adds up bytes across documents, and treats running out as retryable", async () => {
    const web = new RemoteWeb();
    const bob = await mastodonActor(web, "bob");
    const deps = { ...web.loader, userAgent: "test" };
    const later = () => Date.now() + 10_000;

    web.redirect(`${MASTODON}/a`, `${MASTODON}/b`);
    web.redirect(`${MASTODON}/b`, bob.uri);
    const hops = createSafeLoader({ ...deps, budget: { fetches: 2, bytes: 1024 * 1024, deadline: later() } });
    const redirected = await hops(`${MASTODON}/a`).catch((error: unknown) => error);
    expect(redirected).toBeInstanceOf(BudgetExceededError);
    expect(isTransientLoadError(redirected)).toBe(true);

    const size = JSON.stringify(bob.document).length;
    const bytes = { fetches: 5, bytes: Math.floor(size * 1.5), deadline: later() };
    const twice = createSafeLoader({ ...deps, budget: bytes });
    await twice(bob.uri);
    const second = await twice(bob.uri).catch((error: unknown) => error);
    expect(second).toBeInstanceOf(BudgetExceededError);

    // The deadline is reached while a fetch is under way.
    web.delay(bob.uri, 200);
    const slow = createSafeLoader({ ...deps, budget: { fetches: 5, bytes: 1024 * 1024, deadline: Date.now() + 50 } });
    const timedOut = await slow(bob.uri).catch((error: unknown) => error);
    expect(isTransientLoadError(timedOut)).toBe(true);

    // A document over the per-document cap stays a permanent refusal.
    const capped = createSafeLoader({ ...deps, budget: { fetches: 5, bytes: 4 * 1024 * 1024, deadline: later() } });
    web.serve(`${MASTODON}/huge`, { id: `${MASTODON}/huge`, pad: "x".repeat(1024 * 1024) });
    expect(isTransientLoadError(await capped(`${MASTODON}/huge`).catch((error: unknown) => error))).toBe(false);
  });

  it("fetches an actor document once per request, whatever the fragment", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    expect(await t.post(bob, follow(bob))).toBe(202);
    expect(t.web.fetched.filter((url) => url === bob.uri)).toHaveLength(1);
  });
});

describe("second review: deletion, keys and generations", () => {
  const ageKeys = (t: { store: StoreStub }) => sql(t.store, "UPDATE remote_keys SET fetched_at = ?", NOW - DAY - 1);

  it("refuses a self-Delete signed with a stale key while the actor is alive with another key (ID-1)", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const next = await mastodonActor(t.web, "next", { key: 3 });
    await t.post(bob, follow(bob));
    t.web.serve(bob.uri, { ...bob.document, publicKey: { id: bob.keyId, owner: bob.uri, publicKeyPem: next.pem } });
    await ageKeys(t);
    expect(await t.post(bob, deleteSelf(bob))).toBe(401);
    expect(await accountId(t.store, bob.uri)).toBeDefined();
    expect((await edges(t.store)).length).toBe(1);
    expect(await count(t.store, "SELECT 1 FROM inbound_jobs")).toBe(0);
  });

  it("accepts a stale stored key for the Delete only when the actor document is gone", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await t.post(bob, follow(bob));
    await ageKeys(t);
    t.web.fail(bob.uri, 410);
    expect(await t.post(bob, deleteSelf(bob))).toBe(202);
    expect(await accountId(t.store, bob.uri)).toBeUndefined();
  });

  it("answers 503 when the key is gone but the actor document fails transiently, and 401 when it is alive", async () => {
    const t = await setup();
    const uri = `${MASTODON}/users/gts`;
    const keyId = `${uri}/main-key`;
    const gts = await mastodonActor(t.web, "gts");
    const document = { ...gts.document, publicKey: { id: keyId, owner: uri, publicKeyPem: gts.pem } };
    t.web.serve(uri, document);
    t.web.serve(keyId, document);
    await t.post(gts, follow(gts), { keyId });
    await ageKeys(t);
    t.web.fail(keyId, 410);
    t.web.fail(uri, 502);
    expect(await t.post(gts, deleteSelf(gts), { keyId })).toBe(503);
    t.web.serve(uri, document);
    expect(await t.post(gts, deleteSelf(gts), { keyId })).toBe(401);
    expect(await accountId(t.store, uri)).toBeDefined();
  });

  it("records a tombstone for a verified Delete of an actor never stored (ID-7)", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    expect(await t.post(bob, deleteSelf(bob))).toBe(202);
    expect(await count(t.store, "SELECT 1 FROM inbound_jobs WHERE kind = 'purge' AND key = ?", bob.uri)).toBe(1);
    expect(await t.post(bob, follow(bob))).toBe(202);
    expect(await accountId(t.store, bob.uri)).toBeUndefined();
    expect(await edges(t.store)).toEqual([]);
  });

  it("undoes a second generation with the same Misskey pair id", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const pair = { id: `${MASTODON}/follows/9abc/9def`, type: "Follow", actor: bob.uri, object: ALICE_URI };
    const undo = () => ({ "@context": AS, id: nextId(bob), type: "Undo", actor: bob.uri, object: pair });
    await t.post(bob, follow(bob));
    await t.post(bob, undo());
    await t.post(bob, follow(bob));
    expect((await edges(t.store)).length).toBe(1);
    await t.post(bob, undo());
    expect(await edges(t.store)).toEqual([]);
    expect(await count(t.store, "SELECT 1 FROM notifications")).toBe(0);
  });

  it("stores and accepts a key the actor lists by reference", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const keyUrl = `${MASTODON}/keys/bob`;
    t.web.serve(bob.uri, { ...bob.document, publicKey: keyUrl });
    t.web.serve(keyUrl, {
      "@context": ["https://www.w3.org/ns/activitystreams", "https://w3id.org/security/v1", { Key: "sec:Key" }],
      id: keyUrl,
      type: "Key",
      owner: bob.uri,
      publicKeyPem: bob.pem,
    });
    expect(await t.post(bob, follow(bob), { keyId: keyUrl })).toBe(202);
    expect(await sql(t.store, "SELECT key_id FROM remote_keys")).toEqual([{ key_id: keyUrl }]);
  });

  it("changes no Follow generation it cannot record at the retraction cap (ID-7)", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const f1 = follow(bob);
    await t.post(bob, f1);
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO inbound_retractions (actor_uri, target_uri, expires_at) SELECT ?, ? || '/seeded/' || i, ? FROM n`,
      MAX_RETRACTIONS_PER_ACTOR,
      bob.uri,
      bob.uri,
      NOW + DAY,
    );
    await t.post(bob, { "@context": AS, id: nextId(bob), type: "Undo", actor: bob.uri, object: embedded(f1) });
    await t.post(bob, f1);
    await t.post(bob, follow(bob));
    await t.post(bob, f1);
    expect((await edges(t.store)).map((e) => e.uri)).toEqual([f1.id]);
    expect(await count(t.store, "SELECT 1 FROM notifications")).toBe(1);
    expect(await count(t.store, "SELECT 1 FROM outbound_activities")).toBe(1);
  });

  it("purges the endorsements of the account and the notes and dismissals on it in bounded batches too (RES-6)", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await t.post(bob, follow(bob));
    const bobId = (await accountId(t.store, bob.uri))!;
    // More local accounts than a batch, each following and endorsing bob, with a note on him, and each dismissing him
    // from its suggestions.
    const locals = PURGE_BATCH + 1;
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO accounts (id, uri, username) SELECT printf('5%017d', i), ? || '/ap/users/l' || i, 'l' || i FROM n`,
      locals,
      LOCAL,
    );
    await sql(
      t.store,
      `INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
			SELECT id, username || '@example.com', X'00', X'00', 'k' FROM accounts WHERE id GLOB '5*'`,
    );
    for (const query of [
      "INSERT INTO follows (account_id, target_account_id, state) SELECT id, ?, 'accepted' FROM accounts WHERE id GLOB '5*'",
      "INSERT INTO account_pins (account_id, target_account_id) SELECT id, ? FROM accounts WHERE id GLOB '5*'",
      "INSERT INTO account_notes (account_id, target_account_id, comment) SELECT id, ?, 'bob' FROM accounts WHERE id GLOB '5*'",
      "INSERT INTO follow_recommendation_mutes (account_id, target_account_id) SELECT id, ? FROM accounts WHERE id GLOB '5*'",
    ]) {
      await sql(t.store, query, bobId);
    }
    const left = async () => [
      await count(t.store, "SELECT 1 FROM account_pins"),
      await count(t.store, "SELECT 1 FROM account_notes"),
      await count(t.store, "SELECT 1 FROM follow_recommendation_mutes"),
      await count(t.store, "SELECT 1 FROM follows"),
    ];
    // Its cached profile images' slots go first, two rows each (the slot and the usage row: no object yet).
    const slots = await count(t.store, "SELECT 1 FROM remote_media");
    t.web.fail(bob.uri, 410);
    expect(await t.post(bob, deleteSelf(bob))).toBe(202);
    // One batch writes at most PURGE_BATCH rows: the slots and the endorsements go first, before any follow is read.
    const [pins, notes, dismissals, edges] = await left();
    expect(pins).toBe(locals - PURGE_BATCH + 2 * slots);
    expect([notes, dismissals, edges]).toEqual([locals, locals, locals + 1]);
    // Each cron run takes a bounded number of batches; two finish this purge.
    await runScheduledJobs({ ...t.env, MAINTENANCE: "off" } as Env, t.deps);
    await runScheduledJobs({ ...t.env, MAINTENANCE: "off" } as Env, t.deps);
    expect(await left()).toEqual([0, 0, 0, 0]);
    expect(await accountId(t.store, bob.uri)).toBeUndefined();
  });

  it("deletes the pins of a remote status with it, by Delete and by purge, never by cascade alone", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await t.post(bob, follow(bob));
    await seedStatuses(t.store, bob.uri, 2);
    // Only an author pins through the API; a row naming a remote status still goes with it.
    await sql(t.store, "INSERT INTO status_pins (account_id, status_id) SELECT ?, id FROM statuses", ALICE);
    const pinned = () => count(t.store, "SELECT 1 FROM status_pins");
    const deletion = {
      "@context": AS,
      id: nextId(bob),
      type: "Delete",
      actor: bob.uri,
      object: `${bob.uri}/statuses/1`,
    };
    expect(await t.post(bob, deletion)).toBe(202);
    expect(await count(t.store, "SELECT 1 FROM statuses")).toBe(1);
    expect(await pinned()).toBe(1);
    t.web.fail(bob.uri, 410);
    expect(await t.post(bob, deleteSelf(bob))).toBe(202);
    await runScheduledJobs({ ...t.env, MAINTENANCE: "off" } as Env, t.deps);
    expect([await pinned(), await count(t.store, "SELECT 1 FROM statuses")]).toEqual([0, 0]);
    expect(await accountId(t.store, bob.uri)).toBeUndefined();
  });

  it("purges relationships and notifications in bounded batches too (RES-6)", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await t.post(bob, follow(bob));
    const bobId = (await accountId(t.store, bob.uri))!;
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO statuses (id, uri, account_id, visibility, published_at)
			SELECT printf('4%017d', i), ? || '/s/' || i, ?, 'public', '2026-10-01T00:00:00.000Z' FROM n`,
      PURGE_BATCH + 1,
      ALICE_URI,
      ALICE,
    );
    await sql(
      t.store,
      "INSERT INTO notifications (account_id, type, from_account_id, status_id) SELECT ?, 'favourite', ?, id FROM statuses WHERE id GLOB '4*'",
      ALICE,
      bobId,
    );
    t.web.fail(bob.uri, 410);
    expect(await t.post(bob, deleteSelf(bob))).toBe(202);
    // One batch writes at most PURGE_BATCH rows: some of the 502 notifications are left.
    expect(await count(t.store, "SELECT 1 FROM notifications")).toBeGreaterThan(0);
    await runScheduledJobs({ ...t.env, MAINTENANCE: "off" } as Env, t.deps);
    expect(await count(t.store, "SELECT 1 FROM notifications")).toBe(0);
    expect(await accountId(t.store, bob.uri)).toBeUndefined();
  });
});

describe("with outbound delivery", () => {
  // A signed-in local user (the API) and remote servers (the inbox) over one Store.
  async function together(options: { locked?: boolean } = {}) {
    const h = await community(["alice"]);
    const alice = h.users.alice;
    if (options.locked === true) {
      await sql(h.store, "UPDATE accounts SET locked = 1 WHERE id = ?", alice.id);
    }
    const aliceUri = (await sql<{ uri: string }>(h.store, "SELECT uri FROM accounts WHERE id = ?", alice.id))[0]!.uri;
    const web = new RemoteWeb();
    const inbox = harness(h.store, {}, BUILD, { keygen: fixtureKeyGen, loader: web.loader });
    const post = async (actor: TestActor, activity: unknown) =>
      (await inbox.request("/inbox", await signedInit(actor, "/inbox", activity))).status;
    const deliveries = () =>
      sql<{ type: string; id: string; inbox_url: string }>(
        h.store,
        `SELECT json_extract(o.body, '$.activity.type') AS type, json_extract(o.body, '$.activity.id') AS id, d.inbox_url
				FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id ORDER BY d.id`,
      );
    return { h, alice, aliceUri, web, inbox, post, deliveries };
  }

  it("accepts our outbound Follow by its uri, and rings the doorbell for its own Accept", async () => {
    const t = await together();
    const bob = await mastodonActor(t.web, "bob");
    const bobFollow = { "@context": AS, id: nextId(bob), type: "Follow", actor: bob.uri, object: t.aliceUri };
    expect(await t.post(bob, bobFollow)).toBe(202);
    // Recording the Accept rang the delivery doorbell.
    expect(t.inbox.queue.pending.map((m) => m.body)).toContainEqual({ kind: "deliver" });
    const bobId = (await accountId(t.h.store, bob.uri))!;

    const followed = await t.h.request(`/api/v1/accounts/${bobId}/follow`, bearer(t.alice.token, { method: "POST" }));
    expect(followed.status).toBe(200);
    const [ours] = await sql<{ uri: string; state: string }>(
      t.h.store,
      "SELECT uri, state FROM follows WHERE account_id = ? AND target_account_id = ?",
      t.alice.id,
      bobId,
    );
    expect(ours).toEqual({ uri: expect.stringMatching(`^${t.aliceUri}#follows/`), state: "pending" });

    // Mastodon names the Follow it accepts by its id only.
    expect(
      await t.post(bob, { "@context": AS, id: nextId(bob), type: "Accept", actor: bob.uri, object: ours!.uri }),
    ).toBe(202);
    expect(
      await sql(
        t.h.store,
        "SELECT state FROM follows WHERE account_id = ? AND target_account_id = ?",
        t.alice.id,
        bobId,
      ),
    ).toEqual([{ state: "accepted" }]);
  });

  it("delivers an Accept to the requester’s shared inbox once a local follow request is authorized", async () => {
    const t = await together({ locked: true });
    const bob = await mastodonActor(t.web, "bob");
    const bobFollow = { "@context": AS, id: nextId(bob), type: "Follow", actor: bob.uri, object: t.aliceUri };
    expect(await t.post(bob, bobFollow)).toBe(202);
    const bobId = (await accountId(t.h.store, bob.uri))!;
    expect(await t.deliveries()).toEqual([]);

    const list = await t.h.request("/api/v1/follow_requests", bearer(t.alice.token));
    expect((await list.json<{ id: string }[]>()).map((a) => a.id)).toEqual([bobId]);
    const authorized = await t.h.request(
      `/api/v1/follow_requests/${bobId}/authorize`,
      bearer(t.alice.token, { method: "POST" }),
    );
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toMatchObject({ id: bobId, followed_by: true });
    expect(await t.deliveries()).toEqual([
      {
        type: "Accept",
        id: `${t.aliceUri}#accepts/follows/${sha256Hex(bobFollow.id)}`,
        inbox_url: "https://mastodon.example/inbox",
      },
    ]);
    expect(t.h.doorbell).toHaveBeenCalled();
    expect(await count(t.h.store, "SELECT 1 FROM notifications WHERE type = 'follow_request'")).toBe(0);
  });

  it("rejects a follow request with a Reject to the requester", async () => {
    const t = await together({ locked: true });
    const bob = await mastodonActor(t.web, "bob");
    const bobFollow = { "@context": AS, id: nextId(bob), type: "Follow", actor: bob.uri, object: t.aliceUri };
    await t.post(bob, bobFollow);
    const bobId = (await accountId(t.h.store, bob.uri))!;
    const rejected = await t.h.request(
      `/api/v1/follow_requests/${bobId}/reject`,
      bearer(t.alice.token, { method: "POST" }),
    );
    expect(await rejected.json()).toMatchObject({ id: bobId, followed_by: false, requested: false });
    expect((await t.deliveries()).map((d) => d.type)).toEqual(["Reject"]);
    expect(await edges(t.h.store)).toEqual([]);
  });

  it("undoes the local follow a Block ends, and federates the follows a Move creates", async () => {
    const t = await together();
    const bob = await mastodonActor(t.web, "bob");
    const bob2 = await mastodonActor(t.web, "bob2", { origin: "https://new.example", key: 2 });
    t.web.serve(bob2.uri, { ...bob2.document, alsoKnownAs: [bob.uri] });
    await t.post(bob, { "@context": AS, id: nextId(bob), type: "Follow", actor: bob.uri, object: t.aliceUri });
    const bobId = (await accountId(t.h.store, bob.uri))!;
    await t.h.request(`/api/v1/accounts/${bobId}/follow`, bearer(t.alice.token, { method: "POST" }));
    await sql(t.h.store, "UPDATE follows SET state = 'accepted' WHERE account_id = ?", t.alice.id);
    await sql(t.h.store, "DELETE FROM deliveries");

    const move = {
      "@context": AS,
      id: `${bob.uri}#moves/1`,
      type: "Move",
      actor: bob.uri,
      object: bob.uri,
      target: bob2.uri,
    };
    expect(await t.post(bob, move)).toBe(202);
    expect((await t.deliveries()).map((d) => [d.type, d.inbox_url])).toEqual([
      ["Undo", "https://mastodon.example/inbox"],
      ["Follow", "https://new.example/inbox"],
    ]);

    await sql(t.h.store, "DELETE FROM deliveries");
    const bob2Id = (await accountId(t.h.store, bob2.uri))!;
    await sql(t.h.store, "UPDATE follows SET state = 'accepted' WHERE target_account_id = ?", bob2Id);
    expect(
      await t.post(bob2, {
        "@context": AS,
        id: `${bob2.uri}#blocks/1`,
        type: "Block",
        actor: bob2.uri,
        object: t.aliceUri,
      }),
    ).toBe(202);
    expect((await t.deliveries()).map((d) => [d.type, d.inbox_url])).toEqual([["Undo", "https://new.example/inbox"]]);
    expect(await count(t.h.store, "SELECT 1 FROM follows WHERE account_id = ?", t.alice.id)).toBe(0);
  });
});

describe("an actor whose deletion has started (R1)", () => {
  it("shows nothing of the actor from the Delete on, while its purge still removes what it has", async () => {
    const h = await community(["alice", "carol"]);
    const { alice, carol } = h.users;
    const web = new RemoteWeb();
    const inbox = harness(h.store, {}, BUILD, { keygen: fixtureKeyGen, loader: web.loader });
    const post = async (actor: TestActor, activity: unknown) =>
      (await inbox.request("/inbox", await signedInit(actor, "/inbox", activity))).status;
    const bob = await mastodonActor(web, "bob");
    expect(await post(bob, follow(bob))).toBe(202);
    const bobId = (await accountId(h.store, bob.uri))!;
    await seedStatuses(h.store, bob.uri, PURGE_BATCH * 2 + 1);
    // Carol mutes bob (his notifications still shown); alice has bob's follow notification.
    await h.request(`/api/v1/accounts/${bobId}/mute`, bearer(carol.token, json({ notifications: false })));
    const read = async (token: string | null, path: string) => {
      const response = await h.request(path, token === null ? {} : bearer(token));
      return { status: response.status, body: await response.json<unknown>() };
    };
    const bobStatuses = async (token: string | null) =>
      ((await read(token, "/api/v1/timelines/public?limit=40")).body as { account: { id: string } }[]).filter(
        (s) => s.account.id === bobId,
      ).length;
    const fromBob = async () =>
      ((await read(alice.token, "/api/v1/notifications")).body as { account: { id: string } }[]).filter(
        (n) => n.account.id === bobId,
      ).length;
    expect(await bobStatuses(null)).toBe(40);
    expect(await bobStatuses(carol.token)).toBe(0);
    expect(await fromBob()).toBe(1);
    expect((await read(alice.token, `/api/v1/accounts/${bobId}`)).body).toMatchObject({
      display_name: "bob <b>display</b>",
    });

    web.fail(bob.uri, 410);
    expect(await post(bob, deleteSelf(bob))).toBe(202);
    // The first batch removed bob's follow; most of his statuses are left, and carol's mute until they are gone.
    expect(await count(h.store, "SELECT 1 FROM mutes")).toBe(1);
    expect(await count(h.store, "SELECT 1 FROM statuses WHERE account_id = ?", bobId)).toBeGreaterThan(PURGE_BATCH);
    expect(await bobStatuses(null)).toBe(0);
    expect(await bobStatuses(carol.token)).toBe(0);
    expect(await bobStatuses(alice.token)).toBe(0);
    expect(await fromBob()).toBe(0);
    const [left] = await sql<{ id: string }>(h.store, "SELECT id FROM statuses WHERE account_id = ? LIMIT 1", bobId);
    expect((await read(alice.token, `/api/v1/statuses/${left!.id}`)).status).toBe(404);
    expect((await read(alice.token, `/api/v1/accounts/${bobId}`)).body).toMatchObject({
      display_name: "",
      suspended: true,
    });
    expect((await h.request(`/api/v1/accounts/${bobId}/follow`, bearer(alice.token, { method: "POST" }))).status).toBe(
      404,
    );
    expect(await count(h.store, "SELECT 1 FROM follows WHERE target_account_id = ?", bobId)).toBe(0);

    // The actor's own activity and a fetch of its document while the purge runs do not bring it back.
    web.serve(bob.uri, bob.document);
    expect(await post(bob, follow(bob))).toBe(202);
    expect(await count(h.store, "SELECT 1 FROM follows WHERE account_id = ?", bobId)).toBe(0);
    expect(await sql(h.store, "SELECT deleted_at FROM accounts WHERE id = ?", bobId)).toEqual([
      { deleted_at: new Date(NOW).toISOString() },
    ]);

    await runScheduledJobs(
      { ...inbox.env, MAINTENANCE: "off" } as Env,
      inboxDeps(() => h.store, web.loader),
    );
    expect(await accountId(h.store, bob.uri)).toBeUndefined();
  });
  it("keeps filtering a post that mentions the actor, by its blocks, until no mention of it is left", async () => {
    const h = await community(["alice", "carol"]);
    const { alice, carol } = h.users;
    const web = new RemoteWeb();
    const inbox = harness(h.store, {}, BUILD, { keygen: fixtureKeyGen, loader: web.loader });
    const post = async (actor: TestActor, activity: unknown) =>
      (await inbox.request("/inbox", await signedInit(actor, "/inbox", activity))).status;
    const bob = await mastodonActor(web, "bob");
    expect(await post(bob, follow(bob))).toBe(202);
    const bobId = (await accountId(h.store, bob.uri))!;
    await h.request(`/api/v1/accounts/${carol.id}/follow`, bearer(alice.token, { method: "POST" }));
    // carol mentions alice and bob; alice is notified, and would be pushed.
    const posted = await h.request("/api/v1/statuses", bearer(carol.token, json({ status: "@alice hello" })));
    const status = (await posted.json<{ id: string }>()).id;
    await sql(h.store, "INSERT INTO status_mentions (status_id, account_id, silent) VALUES (?, ?, 0)", status, bobId);
    await sql(
      h.store,
      `INSERT INTO push_subscriptions (token_hash, endpoint, key_p256dh, key_auth, alerts)
			VALUES (?, 'https://push.example/alice', 'p256dh', 'auth', '{"mention":true}')`,
      sha256Hex(alice.token),
    );
    // More notifications from bob than two purge batches remove, so his mention rows outlive two batches.
    await sql(
      h.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?3)
			INSERT INTO notifications (account_id, type, from_account_id) SELECT ?1, 'filler-' || i, ?2 FROM n`,
      carol.id,
      bobId,
      PURGE_BATCH * 2 + 100,
    );
    const shown = async () => {
      const home = await (await h.request("/api/v1/timelines/home", bearer(alice.token))).json<{ id: string }[]>();
      const listed = await (
        await h.request("/api/v1/notifications?types[]=mention", bearer(alice.token))
      ).json<
        {
          status?: { id: string };
        }[]
      >();
      await sql(h.store, "DELETE FROM push_deliveries");
      await sql(
        h.store,
        `INSERT INTO push_deliveries (subscription_id, notification_id, next_attempt_at, updated_at)
				SELECT (SELECT id FROM push_subscriptions), id, 0, 0 FROM notifications WHERE account_id = ? AND type = 'mention'`,
        alice.id,
      );
      const pushed = (await h.store.claimPushes(BUILD, { now: NOW, leaseToken: crypto.randomUUID() })).pushes;
      return {
        home: home.some((s) => s.id === status),
        notification: listed.some((n) => n.status?.id === status),
        push: pushed.length > 0,
      };
    };
    const everywhere = { home: true, notification: true, push: true };
    const nowhere = { home: false, notification: false, push: false };
    expect(await shown()).toEqual(everywhere);
    await h.request(`/api/v1/accounts/${bobId}/block`, bearer(alice.token, { method: "POST" }));
    expect(await shown()).toEqual(nowhere);

    web.fail(bob.uri, 410);
    expect(await post(bob, deleteSelf(bob))).toBe(202);
    const mentioned = async () =>
      (await count(h.store, "SELECT 1 FROM status_mentions WHERE status_id = ? AND account_id = ?", status, bobId)) > 0;
    // After each batch: while carol's post still mentions bob, alice's block of him stays and filters it.
    let mentioning = 0;
    for (;;) {
      if (await mentioned()) {
        mentioning++;
        expect(await count(h.store, "SELECT 1 FROM blocks")).toBe(1);
        expect(await shown()).toEqual(nowhere);
      }
      const more = await runInDurableObject(h.store, (_instance, state) =>
        purgeBatch(new Db(state.storage.sql), bob.uri, NOW),
      );
      if (!more) {
        break;
      }
    }
    // Once bob is gone, carol's post mentions only alice.
    expect(mentioning).toBeGreaterThanOrEqual(2);
    expect(await accountId(h.store, bob.uri)).toBeUndefined();
    expect(await count(h.store, "SELECT 1 FROM blocks")).toBe(0);
    expect(await shown()).toEqual(everywhere);
  });
});
