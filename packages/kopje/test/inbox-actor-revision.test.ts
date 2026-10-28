import { signJsonLd } from "@fedify/fedify";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import {
  ACCOUNT_STALE_MS,
  actorRevision,
  type DocumentRevision,
  KEY_REFRESH_MS,
  type RemoteActorInput,
  upsertRemoteActor,
} from "../src/domain/inbox";
import { suspendRemote } from "../src/domain/remote-suspension";
import { processInbox } from "../src/federation/inbox";
import { DOCUMENT_REVISION_MAX } from "../src/platform/stored-bounds";
import { sql } from "./api-helpers";
import { inboxDeps, NOW } from "./app-helpers";
import { migratedStore } from "./helpers";
import { actorDefaults, MASTODON, mastodonActor, signedInit, type TestActor } from "./inbox-helpers";
import {
  accountId,
  ALICE,
  ALICE_URI,
  announce,
  AS,
  DAVE,
  followed,
  mastodonNote,
  nextId,
  OTHER,
  type Setup,
  setup,
} from "./inbox-status-helpers";
import { contexts } from "./quote-helpers";
import { type PlannedStatement, plannedSql, remoteAccounts, scansOf, staleStatistics } from "./read-helpers";
import { staleAuthorWorld } from "./stale-author-helpers";

// ID-1's revision fence (domain/inbox.ts DocumentRevision): a remote actor's document is stored only while the revision
// read before it was fetched still holds, so a snapshot fetched before another store committed never replaces it,
// whether it is replayed in a later Store round or delayed before the first. Each race holds one request at a fetch
// (RemoteWeb.hold) while the other commits through the real inbox and Store.

const iso = (at: number) => new Date(at).toISOString();

// The fetches a test holds and the requests it leaves running, released and settled after each test, also when an
// assertion failed before the test released them (docs/engineering.md, "Tests").
const holds: { release: () => void }[] = [];
const outstanding: Promise<unknown>[] = [];
afterEach(async () => {
  for (const held of holds.splice(0)) {
    held.release();
  }
  await Promise.allSettled(outstanding.splice(0));
});
function hold(t: Setup, url: string, options: { snapshot?: boolean } = {}) {
  const held = t.web.hold(url, options);
  holds.push(held);
  return held;
}
function track<T>(request: Promise<T>): Promise<T> {
  outstanding.push(request);
  return request;
}
const avatar = (n: number) => `${MASTODON}/system/avatars/bob-${n}.png`;
const RELAY = "https://relay.example";

type Row = {
  avatar_url: string | null;
  fetched_at: string | null;
  inbox_url: string | null;
  moved_to_account_id: string | null;
  document_revision: number;
};
const row = async (t: Setup, uri: string) =>
  (
    await sql<Row>(
      t.store,
      `SELECT avatar_url, fetched_at, inbox_url, moved_to_account_id, document_revision FROM accounts WHERE uri = ?`,
      uri,
    )
  )[0]!;
const keys = (t: Setup, uri: string) =>
  sql<{ key_id: string; pem: string; fetched_at: number }>(
    t.store,
    `SELECT k.key_id, k.pem, k.fetched_at FROM remote_keys k JOIN accounts a ON a.id = k.account_id
		WHERE a.uri = ? ORDER BY k.key_id`,
    uri,
  );
// The stored key `keyId` (all of the actor's, when none is named) listed a day ago: its next use fetches the document.
const expire = (t: Setup, uri: string, keyId?: string) =>
  sql(
    t.store,
    `UPDATE remote_keys SET fetched_at = ?1
		WHERE account_id = (SELECT id FROM accounts WHERE uri = ?2) AND (?3 IS NULL OR key_id = ?3)`,
    NOW - KEY_REFRESH_MS,
    uri,
    keyId ?? null,
  );

// A minimal remote actor document of `uri`, as the Store receives one.
const documentOf = (uri: string): RemoteActorInput => ({
  ...actorDefaults(),
  uri,
  username: uri.split("/").at(-1)!,
  domain: new URL(uri).host,
  displayName: "d",
  inboxUrl: `${uri}/inbox`,
  movedTo: null,
});

// carol's document on another server served with avatar `n`; extra replaces any other property.
function carolAt(t: Setup, n: number, extra: Record<string, unknown> = {}) {
  return mastodonActor(t.web, "carol", {
    origin: OTHER,
    key: 2,
    extra: { icon: { type: "Image", mediaType: "image/png", url: `${OTHER}/avatars/carol-${n}.png` }, ...extra },
  });
}

// bob's document served with avatar `n` and key `key`; extra replaces any other property.
function bobAt(t: Setup, n: number, key = 0, extra: Record<string, unknown> = {}) {
  return mastodonActor(t.web, "bob", {
    key,
    extra: { icon: { type: "Image", mediaType: "image/png", url: avatar(n) }, ...extra },
  });
}

const updateOf = (actor: TestActor) => ({
  "@context": AS,
  id: `${actor.uri}#updates/${nextId()}`,
  type: "Update",
  actor: actor.uri,
  object: actor.document,
});
const followOf = (actor: TestActor) => ({
  "@context": AS,
  id: `${actor.uri}#follows/${nextId()}`,
  type: "Follow",
  actor: actor.uri,
  object: ALICE_URI,
});

const boosted = async (t: Setup, uri: string) =>
  (
    await sql<{ n: number }>(
      t.store,
      `SELECT count(*) AS n FROM statuses b JOIN statuses o ON o.id = b.reblog_of_id
			WHERE o.uri = ? AND o.reblog_of_id IS NULL`,
      uri,
    )
  )[0]!.n === 1;

// bob's key listed by reference: the key's own document, at its own URL.
function referencedKey(t: Setup, bob: TestActor, url: string): TestActor {
  t.web.serve(bob.uri, { ...bob.document, publicKey: url });
  t.web.serve(url, {
    "@context": [AS, "https://w3id.org/security/v1", { Key: "sec:Key" }],
    id: url,
    type: "Key",
    owner: bob.uri,
    publicKeyPem: bob.pem,
  });
  return { ...bob, keyId: url };
}

describe("a document replayed in a later Store round (ID-1)", () => {
  it.each(["embedded", "listed by reference"] as const)(
    "stores none of an older snapshot over a key rotation committed between rounds (key %s)",
    async (form) => {
      const clock = { now: NOW };
      const t = await setup(clock);
      const keyUrl = `${MASTODON}/keys/bob`;
      const served = (actor: TestActor) => (form === "embedded" ? actor : referencedKey(t, actor, keyUrl));
      const bob = served(await bobAt(t, 1));
      await followed(t, bob);
      // The stored key a day old, so the boost fetches bob's document (input.actor is not null).
      await expire(t, bob.uri);
      const erin = await mastodonActor(t.web, "erin", { origin: OTHER, key: 3 });
      const note = mastodonNote(erin);
      t.web.serve(note.id, { "@context": AS, ...note });
      const original = hold(t, note.id);
      t.web.fetched.length = 0;
      const a = track(t.post(bob, announce(bob, note.id)));
      await original.reached;
      // Round 0 stored the document it fetched, and answered that it needs the original.
      expect(t.web.fetched).toContain(bob.uri);
      expect(await keys(t, bob.uri)).toEqual([{ key_id: bob.keyId, pem: bob.pem, fetched_at: NOW }]);
      // bob rotates his key under the same id, and his Update commits between A's rounds.
      const rotated = served(await bobAt(t, 2, 4));
      clock.now = NOW + 1;
      expect(await t.post(rotated, updateOf(rotated))).toBe(202);
      clock.now = NOW + 2;
      original.release();
      expect(await a).toBe(202);
      expect(await boosted(t, note.id)).toBe(true);
      expect(await row(t, bob.uri)).toMatchObject({ avatar_url: avatar(2), fetched_at: iso(NOW + 1) });
      expect(await keys(t, bob.uri)).toEqual([{ key_id: bob.keyId, pem: rotated.pem, fetched_at: NOW + 1 }]);
      // The rotated-out key is not trusted again.
      expect(await t.post(bob, followOf(bob))).toBe(401);
    },
  );
});

describe("a document fetched before another store committed (ID-1)", () => {
  it("stores none of a Move sender’s document fetched before a rotation, during the target’s fetch", async () => {
    const t = await setup();
    const bob = await bobAt(t, 1);
    await followed(t, bob);
    await expire(t, bob.uri);
    const carol = await carolAt(t, 1, { alsoKnownAs: [bob.uri] });
    const target = hold(t, carol.uri);
    const move = {
      "@context": AS,
      id: `${bob.uri}#moves/${nextId()}`,
      type: "Move",
      actor: bob.uri,
      object: bob.uri,
      target: carol.uri,
    };
    const a = track(t.post(bob, move));
    // A fetched bob's document (v1) before the Move target, and nothing is stored yet.
    await target.reached;
    const rotated = await bobAt(t, 2, 4);
    expect(await t.post(rotated, updateOf(rotated))).toBe(202);
    target.release();
    expect(await a).toBe(202);
    expect(await row(t, bob.uri)).toMatchObject({
      avatar_url: avatar(2),
      moved_to_account_id: await accountId(t.store, carol.uri),
    });
    expect((await keys(t, bob.uri)).map((k) => k.pem)).toEqual([rotated.pem]);
  });

  it.each([
    ["a stored revision", null],
    ["the largest revision imported", DOCUMENT_REVISION_MAX],
  ])(
    "answers 503 for an Update(Person) whose fetch raced another store from %s, and applies it on retry",
    async (_name, imported) => {
      const t = await setup();
      const bob = await bobAt(t, 1);
      await followed(t, bob);
      if (imported !== null) {
        await sql(t.store, "UPDATE accounts SET document_revision = ? WHERE uri = ?", imported, bob.uri);
      }
      const before = (await row(t, bob.uri)).document_revision;
      // A's Update fetches v2 and is held; B's Update, which read the same revision, fetches v3 and is held too.
      await bobAt(t, 2);
      const first = hold(t, bob.uri, { snapshot: true });
      const a = track(t.post(bob, updateOf(bob)));
      await first.reached;
      await bobAt(t, 3);
      const second = hold(t, bob.uri, { snapshot: true });
      const b = track(t.post(bob, updateOf(bob)));
      await second.reached;
      first.release();
      expect(await a).toBe(202);
      const stored = await row(t, bob.uri);
      expect(stored.avatar_url).toBe(avatar(2));
      expect(stored.document_revision).not.toBe(before);
      second.release();
      expect(await b).toBe(503);
      expect(await row(t, bob.uri)).toEqual(stored);
      // The retry fetches the current document and stores it.
      expect(await t.post(bob, updateOf(bob))).toBe(202);
      expect((await row(t, bob.uri)).avatar_url).toBe(avatar(3));
    },
  );

  it("keeps a Move’s movedTo over a document fetched before it, though the Move stored no document", async () => {
    const t = await setup();
    const second = await mastodonActor(t.web, "bob-second-key", { key: 5 });
    const bob = await bobAt(t, 1, 0);
    const listed = {
      ...bob.document,
      publicKey: [
        { id: bob.keyId, owner: bob.uri, publicKeyPem: bob.pem },
        { id: `${bob.uri}#second-key`, owner: bob.uri, publicKeyPem: second.pem },
      ],
    };
    t.web.serve(bob.uri, listed);
    const bobSecond: TestActor = { ...bob, keyId: `${bob.uri}#second-key`, privateKey: second.privateKey };
    await followed(t, bob);
    expect((await keys(t, bob.uri)).length).toBe(2);
    // A signs with the second key, a day old: it fetches bob's document (without movedTo) and is held there.
    await expire(t, bob.uri, bobSecond.keyId);
    const fetch = hold(t, bob.uri, { snapshot: true });
    const a = track(t.post(bobSecond, followOf(bobSecond)));
    await fetch.reached;
    // B, a Move signed with the fresh main key, stores no document of bob (input.actor is null).
    const carol = await carolAt(t, 1, { alsoKnownAs: [bob.uri] });
    const move = {
      "@context": AS,
      id: `${bob.uri}#moves/${nextId()}`,
      type: "Move",
      actor: bob.uri,
      object: bob.uri,
      target: carol.uri,
    };
    const revision = (await row(t, bob.uri)).document_revision;
    expect(await t.post(bob, move)).toBe(202);
    const moved = await row(t, bob.uri);
    expect(moved.moved_to_account_id).toBe(await accountId(t.store, carol.uri));
    expect(moved.document_revision).not.toBe(revision);
    fetch.release();
    expect(await a).toBe(202);
    // A applied with the stored row: its follow is recorded, and the move stands.
    expect(
      await sql(
        t.store,
        "SELECT count(*) AS n FROM follows WHERE account_id = ?",
        (await accountId(t.store, bob.uri))!,
      ),
    ).toEqual([{ n: 2 }]);
    expect(await row(t, bob.uri)).toEqual(moved);
  });

  it("keeps a suspended actor’s routing over a routing document fetched before another (R38)", async () => {
    const t = await setup();
    const bob = await bobAt(t, 1);
    await followed(t, bob);
    const id = (await accountId(t.store, bob.uri))!;
    await runInDurableObject(t.store, (_instance, state) =>
      state.storage.transactionSync(() => suspendRemote(new Db(state.storage.sql), id, null, NOW)),
    );
    await bobAt(t, 1, 0, { inbox: `${bob.uri}/inbox-2` });
    const old = hold(t, bob.uri, { snapshot: true });
    const a = track(t.post(bob, updateOf(bob)));
    await old.reached;
    await bobAt(t, 1, 0, { inbox: `${bob.uri}/inbox-3` });
    expect(await t.post(bob, updateOf(bob))).toBe(202);
    const refreshed = await row(t, bob.uri);
    expect(refreshed.inbox_url).toBe(`${bob.uri}/inbox-3`);
    old.release();
    expect(await a).toBe(202);
    expect(await row(t, bob.uri)).toEqual(refreshed);
  });

  it("stores none of a document a spooled request fetched on replay before another store committed", async () => {
    const t = await setup();
    const bob = await bobAt(t, 1);
    await followed(t, bob);
    await bobAt(t, 2);
    const init = await signedInit(bob, "/inbox", updateOf(bob));
    const request = {
      url: "https://kopje.test/inbox",
      method: "POST",
      headers: [...new Headers(init.headers)],
      body: new TextEncoder().encode(init.body as string),
      receivedAt: NOW,
    };
    const fetch = hold(t, bob.uri, { snapshot: true });
    const replay = track(
      processInbox(
        t.env,
        inboxDeps(() => t.store, t.web.loader),
        request,
        "replay",
      ),
    );
    await fetch.reached;
    await bobAt(t, 3);
    expect(await t.post(bob, updateOf(bob))).toBe(202);
    fetch.release();
    expect(await replay).toMatchObject({ status: 503, reason: "actor-changed" });
    expect((await row(t, bob.uri)).avatar_url).toBe(avatar(3));
  });

  it("fences a relayed Delete’s actor document by the actor’s revision, not the relaying signer’s", async () => {
    const t = await setup();
    const carol = await carolAt(t, 1);
    const dan = await mastodonActor(t.web, "dan", { origin: RELAY, key: 6 });
    await followed(t, carol);
    await followed(t, dan);
    await sql(t.store, "UPDATE accounts SET document_revision = 1 WHERE uri = ?", carol.uri);
    await sql(t.store, "UPDATE accounts SET document_revision = 2 WHERE uri = ?", dan.uri);
    const deletion = async () =>
      signJsonLd(
        {
          "@context": [AS, "https://w3id.org/security/v1"],
          id: `${carol.uri}#delete-${nextId()}`,
          type: "Delete",
          actor: carol.uri,
          object: `${carol.uri}/stamps/${nextId()}`,
        },
        carol.privateKey,
        new URL(carol.keyId),
        { contextLoader: contexts },
      );
    // Under the actor's revision, carol's document fetched for her proof is stored.
    await carolAt(t, 2);
    expect(await t.post(dan, await deletion())).toBe(202);
    expect((await row(t, carol.uri)).avatar_url).toBe(`${OTHER}/avatars/carol-2.png`);
    // One fetched before her own Update committed is not.
    await carolAt(t, 3);
    const fetch = hold(t, carol.uri, { snapshot: true });
    const relayed = track(t.post(dan, await deletion()));
    await fetch.reached;
    await carolAt(t, 4);
    expect(await t.post(carol, updateOf(carol))).toBe(202);
    fetch.release();
    expect(await relayed).toBe(202);
    expect((await row(t, carol.uri)).avatar_url).toBe(`${OTHER}/avatars/carol-4.png`);
  });
});

describe("the Move target and search resolution (ID-1, ID-4)", () => {
  it("answers 503 for a Move whose target was stored after its revision was read, and moves on retry", async () => {
    const t = await setup();
    const bob = await bobAt(t, 1);
    await followed(t, bob);
    const aliased = (n: number) => carolAt(t, n, { alsoKnownAs: [bob.uri] });
    const carol = await aliased(1);
    await followed(t, carol);
    const move = {
      "@context": AS,
      id: `${bob.uri}#moves/${nextId()}`,
      type: "Move",
      actor: bob.uri,
      object: bob.uri,
      target: carol.uri,
    };
    const target = hold(t, carol.uri, { snapshot: true });
    const a = track(t.post(bob, move));
    await target.reached;
    await aliased(2);
    expect(await t.post(carol, updateOf(carol))).toBe(202);
    const updated = await row(t, carol.uri);
    target.release();
    expect(await a).toBe(503);
    expect(await row(t, carol.uri)).toEqual(updated);
    expect(await row(t, bob.uri)).toMatchObject({ moved_to_account_id: null });
    expect(await t.post(bob, move)).toBe(202);
    expect((await row(t, bob.uri)).moved_to_account_id).toBe(await accountId(t.store, carol.uri));
    expect((await row(t, carol.uri)).avatar_url).toBe(`${OTHER}/avatars/carol-2.png`);
  });

  it("answers the stored account when a resolved document was superseded during its WebFinger", async () => {
    const t = await setup();
    const carol = await carolAt(t, 1);
    await followed(t, carol);
    await carolAt(t, 2);
    const webfinger = hold(
      t,
      `${OTHER}/.well-known/webfinger?resource=${encodeURIComponent(`acct:carol@${new URL(OTHER).host}`)}`,
    );
    const search = track(
      t.api<{ accounts: { id: string; avatar: string }[] }>(
        `/api/v2/search?resolve=true&type=accounts&q=${encodeURIComponent(carol.uri)}`,
      ),
    );
    await webfinger.reached;
    await carolAt(t, 3);
    expect(await t.post(carol, updateOf(carol))).toBe(202);
    const updated = await row(t, carol.uri);
    webfinger.release();
    const found = await search;
    expect(found.status).toBe(200);
    expect(found.body.accounts.map((a) => a.id)).toEqual([await accountId(t.store, carol.uri)]);
    expect(await row(t, carol.uri)).toEqual(updated);
    expect(updated.avatar_url).toBe(`${OTHER}/avatars/carol-3.png`);
  });

  it("stores none of a URL probe’s actor document fetched before a key rotation committed", async () => {
    const t = await setup();
    const bob = await bobAt(t, 1);
    await followed(t, bob);
    // The search's first fetch of bob's URL (the probe) answers the document before the rotation, and is held.
    const probe = hold(t, bob.uri, { snapshot: true });
    const search = track(
      t.api<{ accounts: { id: string }[] }>(
        `/api/v2/search?resolve=true&type=accounts&q=${encodeURIComponent(bob.uri)}`,
      ),
    );
    await probe.reached;
    const rotated = await bobAt(t, 2, 4);
    expect(await t.post(rotated, updateOf(rotated))).toBe(202);
    const updated = await row(t, bob.uri);
    t.web.fetched.length = 0;
    probe.release();
    const found = await search;
    expect(found.status).toBe(200);
    expect(found.body.accounts.map((a) => a.id)).toEqual([await accountId(t.store, bob.uri)]);
    // The actor document was fetched again after the revision was read.
    expect(t.web.fetched.filter((url) => url === bob.uri)).toHaveLength(2);
    expect(updated.avatar_url).toBe(avatar(2));
    expect((await row(t, bob.uri)).avatar_url).toBe(avatar(2));
    expect((await keys(t, bob.uri)).map((k) => k.pem)).toEqual([rotated.pem]);
    expect(await t.post(bob, followOf(bob))).toBe(401);
  });

  it("stores a resolved status under the stored author when its author document was superseded", async () => {
    const t = await setup();
    const bob = await bobAt(t, 1);
    await followed(t, bob);
    const note = mastodonNote(bob);
    t.web.serve(note.id, { "@context": AS, ...note });
    const author = hold(t, bob.uri, { snapshot: true });
    const search = track(
      t.api<{ statuses: { uri: string }[] }>(`/api/v2/search?resolve=true&q=${encodeURIComponent(note.id)}`),
    );
    await author.reached;
    const rotated = await bobAt(t, 2, 4);
    expect(await t.post(rotated, updateOf(rotated))).toBe(202);
    const updated = await row(t, bob.uri);
    author.release();
    const found = await search;
    expect(found.status).toBe(200);
    expect(found.body.statuses.map((s) => s.uri)).toEqual([note.id]);
    expect(await row(t, bob.uri)).toEqual(updated);
    expect((await keys(t, bob.uri)).map((k) => k.pem)).toEqual([rotated.pem]);
    expect(await t.post(bob, followOf(bob))).toBe(401);
  });
});

describe("the stale-author refresh (ID-1, ID-4)", () => {
  it("keeps a Move committed while a boosted original’s stale author was refetched", async () => {
    const { t, bob, erin } = await staleAuthorWorld();
    // erin's refetch answers her document as it was before the Move (no movedTo), and is held.
    const refresh = hold(t, erin.uri, { snapshot: true });
    const note = mastodonNote(erin);
    t.web.serve(note.id, { "@context": AS, ...note });
    const boost = track(t.post(bob, announce(bob, note.id)));
    await refresh.reached;
    // Her Move, signed with her fresh stored key, stores no document of her and leaves fetched_at as it was.
    const frank = await mastodonActor(t.web, "frank", { origin: OTHER, key: 8, extra: { alsoKnownAs: [erin.uri] } });
    const move = {
      "@context": AS,
      id: `${erin.uri}#moves/${nextId()}`,
      type: "Move",
      actor: erin.uri,
      object: erin.uri,
      target: frank.uri,
    };
    expect(await t.post(erin, move)).toBe(202);
    const moved = await row(t, erin.uri);
    expect(moved.moved_to_account_id).toBe(await accountId(t.store, frank.uri));
    expect(moved.fetched_at).toBe(iso(NOW - ACCOUNT_STALE_MS));
    refresh.release();
    expect(await boost).toBe(202);
    expect(await boosted(t, note.id)).toBe(true);
    expect(await row(t, erin.uri)).toEqual(moved);
  });
});

describe("a refresh need after the request fetched the document (ID-1, ID-4)", () => {
  it("refetches a self-boosting sender’s document for its stale-author refresh, keeping a Move committed meanwhile", async () => {
    const t = await setup();
    const second = await mastodonActor(t.web, "bob-second-key", { key: 5 });
    const bob = await bobAt(t, 1);
    const keyed = (document: Record<string, unknown>) => ({
      ...document,
      publicKey: [
        { id: bob.keyId, owner: bob.uri, publicKeyPem: bob.pem },
        { id: `${bob.uri}#second-key`, owner: bob.uri, publicKeyPem: second.pem },
      ],
    });
    t.web.serve(bob.uri, keyed(bob.document));
    const bobSecond: TestActor = { ...bob, keyId: `${bob.uri}#second-key`, privateKey: second.privateKey };
    await followed(t, bob);
    // A stale profile, a fresh main key and a secondary key a day old.
    await sql(t.store, "UPDATE accounts SET fetched_at = ? WHERE uri = ?", iso(NOW - ACCOUNT_STALE_MS), bob.uri);
    await expire(t, bob.uri, bobSecond.keyId);
    // frank, the Move's target, whom alice blocks: the Move keeps her follow of bob, so his boost still concerns her.
    const frank = await mastodonActor(t.web, "frank", { origin: OTHER, key: 8, extra: { alsoKnownAs: [bob.uri] } });
    await followed(t, frank, DAVE);
    await sql(
      t.store,
      "INSERT INTO blocks (account_id, target_account_id, created_at) VALUES (?, ?, ?)",
      ALICE,
      (await accountId(t.store, frank.uri))!,
      iso(NOW),
    );
    // A: bob's boost of his own status Kopje does not have, signed with the secondary key. Verifying it fetches his
    // document (without movedTo) into the request's memo, and that fetch is held.
    const note = mastodonNote(bob);
    t.web.serve(note.id, { "@context": AS, ...note });
    const verification = hold(t, bob.uri, { snapshot: true });
    const a = track(t.post(bobSecond, announce(bobSecond, note.id)));
    await verification.reached;
    // B: his Move, signed with the fresh main key, stores no document and leaves fetched_at stale.
    const move = {
      "@context": AS,
      id: `${bob.uri}#moves/${nextId()}`,
      type: "Move",
      actor: bob.uri,
      object: bob.uri,
      target: frank.uri,
    };
    expect(await t.post(bob, move)).toBe(202);
    const frankId = await accountId(t.store, frank.uri);
    expect(await row(t, bob.uri)).toMatchObject({
      moved_to_account_id: frankId,
      fetched_at: iso(NOW - ACCOUNT_STALE_MS),
    });
    // From now on he serves his document as it is after the Move.
    t.web.serve(bob.uri, keyed({ ...bob.document, movedTo: frank.uri }));
    t.web.fetched.length = 0;
    verification.release();
    expect(await a).toBe(202);
    // The sender's own store was superseded; the refresh need refetched his document after reading the revision
    // instead of taking the one the request fetched before the Move.
    expect(t.web.fetched.filter((url) => url === bob.uri).length).toBeGreaterThanOrEqual(2);
    expect(await boosted(t, note.id)).toBe(true);
    expect(await row(t, bob.uri)).toMatchObject({ moved_to_account_id: frankId, fetched_at: iso(NOW) });
  });
});

describe("the revision reads’ plans (RES-7)", () => {
  it("seek one row by the uri index, for a stored actor and a missing one, after growth under stale statistics", async () => {
    const t = await setup();
    const bob = await bobAt(t, 1);
    await followed(t, bob);
    const missing = `${MASTODON}/users/nobody`;
    const capture = () =>
      runInDurableObject(t.store, (_instance, state) => {
        const plans: PlannedStatement[] = [];
        const db = new Db(plannedSql(state.storage.sql, /document_revision END AS revision/, plans));
        const read = [actorRevision(db, bob.uri), actorRevision(db, missing)];
        // The comparison in a writing transaction, for both rows: superseded, so nothing is written.
        state.storage.transactionSync(() => {
          const stale = { ...documentOf(bob.uri), displayName: "stale" };
          expect(upsertRemoteActor(db, stale, "https://kopje.test", NOW, (read[0] ?? 0) + 1)).toBe("superseded");
          expect(upsertRemoteActor(db, documentOf(missing), "https://kopje.test", NOW, 0)).toBe("superseded");
        });
        return { read, plans };
      });
    const { after } = await staleStatistics(t, { capture, grow: () => remoteAccounts(t, 100, 200) });
    expect(after.read).toEqual([expect.any(Number), null]);
    expect(after.plans).toHaveLength(4);
    for (const { query, plan, rows } of after.plans) {
      expect(scansOf(plan, ["accounts"]), `${query}\n${plan.join("\n")}`).toEqual([]);
      expect(plan, query).toEqual([
        expect.stringMatching(/^SEARCH accounts USING INDEX sqlite_autoindex_accounts_2 \(uri=\?\)$/),
      ]);
      expect(rows).toBeLessThanOrEqual(1);
    }
  });
});

describe("upsertRemoteActor’s comparison (DocumentRevision)", () => {
  const URI = "https://remote.example/users/r";
  const document = (n: number): RemoteActorInput => ({
    ...documentOf(URI),
    displayName: `r ${n}`,
    keys: [{ id: `${URI}#key`, pem: `pem ${n}` }],
  });
  type Stored = { display_name: string; document_revision: number; pem: string | null } | undefined;
  const stored = (db: Db): Stored =>
    db.first(
      `SELECT a.display_name, a.document_revision, k.pem FROM accounts a
			LEFT JOIN remote_keys k ON k.account_id = a.id WHERE a.uri = ?`,
      URI,
    );
  const inStore = async <T>(step: (db: Db) => T) =>
    runInDurableObject(await migratedStore(), (_instance, state) =>
      state.storage.transactionSync(() => step(new Db(state.storage.sql))),
    );
  // No expectation: the unfenced writer; null or a number: the fenced one.
  const put = (db: Db, n: number, expected?: DocumentRevision) =>
    expected === undefined
      ? upsertRemoteActor(db, document(n), "https://kopje.test", NOW)
      : upsertRemoteActor(db, document(n), "https://kopje.test", NOW, expected);

  it("stores a new row under null, and supersedes null once a row is stored, one of revision 0 included", async () => {
    await inStore((db) => {
      expect(actorRevision(db, URI)).toBeNull();
      expect(put(db, 1, null)).toMatchObject({ uri: URI, frozen: false });
      const first = stored(db)!;
      expect(first).toMatchObject({ display_name: "r 1", pem: "pem 1" });
      expect(put(db, 2, null)).toBe("superseded");
      expect(stored(db)).toEqual(first);
      db.run("UPDATE accounts SET document_revision = 0 WHERE uri = ?", URI);
      expect(put(db, 3, null)).toBe("superseded");
      expect(stored(db)).toEqual({ ...first, document_revision: 0 });
    });
  });

  it("supersedes a number when no row is stored", async () => {
    await inStore((db) => {
      expect(put(db, 1, 0)).toBe("superseded");
      expect(stored(db)).toBeUndefined();
    });
  });

  it("stores under the current revision and issues another; supersedes an older one", async () => {
    await inStore((db) => {
      put(db, 1, null);
      const read = actorRevision(db, URI)!;
      expect(put(db, 2, read)).toMatchObject({ uri: URI });
      const second = stored(db)!;
      expect(second).toMatchObject({ display_name: "r 2", pem: "pem 2" });
      expect(second.document_revision).not.toBe(read);
      expect(put(db, 3, read)).toBe("superseded");
      expect(stored(db)).toEqual(second);
    });
  });

  it("stores unfenced, and an unfenced store supersedes an expectation read before it", async () => {
    await inStore((db) => {
      put(db, 1);
      const read = actorRevision(db, URI)!;
      expect(put(db, 2)).toMatchObject({ uri: URI });
      expect(actorRevision(db, URI)).not.toBe(read);
      expect(put(db, 3, read)).toBe("superseded");
      expect(stored(db)).toMatchObject({ display_name: "r 2" });
    });
  });

  it("issues a new revision from the largest one imported, within the bound", async () => {
    await inStore((db) => {
      put(db, 1);
      db.run("UPDATE accounts SET document_revision = ? WHERE uri = ?", DOCUMENT_REVISION_MAX, URI);
      expect(put(db, 2, DOCUMENT_REVISION_MAX)).toMatchObject({ uri: URI });
      const next = actorRevision(db, URI)!;
      expect(next).not.toBe(DOCUMENT_REVISION_MAX);
      expect(Number.isSafeInteger(next) && next >= 0).toBe(true);
      expect(put(db, 3, DOCUMENT_REVISION_MAX)).toBe("superseded");
    });
  });

  it("refreshes a frozen row’s routing only under the current revision", async () => {
    await inStore((db) => {
      put(db, 1);
      const id = db.first<{ id: string }>("SELECT id FROM accounts WHERE uri = ?", URI)!.id;
      suspendRemote(db, id, null, NOW);
      const read = actorRevision(db, URI)!;
      const moved = { ...document(2), inboxUrl: `${URI}/inbox-2` };
      expect(upsertRemoteActor(db, moved, "https://kopje.test", NOW, read + 1)).toBe("superseded");
      expect(db.first("SELECT inbox_url FROM accounts WHERE id = ?", id)).toEqual({ inbox_url: `${URI}/inbox` });
      expect(upsertRemoteActor(db, moved, "https://kopje.test", NOW, read)).toMatchObject({ frozen: true });
      expect(db.first("SELECT inbox_url FROM accounts WHERE id = ?", id)).toEqual({ inbox_url: `${URI}/inbox-2` });
      expect(actorRevision(db, URI)).not.toBe(read);
    });
  });
});
