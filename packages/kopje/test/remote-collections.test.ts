import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { FEATURED_COUNT_WINDOW, MAX_FEATURED_TAGS } from "../src/domain/featured-tags";
import {
  ALL_PARTS,
  type CollectionCounts,
  MAX_REMOTE_PINS,
  MAX_SYNC_ATTEMPTS,
  PART_NETWORK,
  SYNC_LEASE_MS,
  SYNC_RETRY_MS,
} from "../src/domain/remote-collections";
import { suspendRemote } from "../src/domain/remote-suspension";
import {
  COLLECTION_SYNCS_PER_ROUND,
  MAX_FEATURED_TAG_PAGES,
  NETWORK_CAPS,
  PART_DOCUMENTS,
  syncCollections,
} from "../src/federation/collections";
import { DOCUMENT_BODY_LIMIT, MAX_REDIRECTS, REQUEST_MAX_BYTES, REQUEST_MAX_FETCHES } from "../src/federation/loader";
import { MAX_ACCOUNT_COUNT } from "../src/platform/stored-bounds";
import { sql } from "./api-helpers";
import { countingStore, harness, inboxDeps, NOW } from "./app-helpers";
import { blockDomain } from "./domain-block-helpers";
import { fixtureKeyGen } from "./federation-helpers";
import { BUILD, runStoreJobs } from "./helpers";
import { LOCAL, MASTODON, mastodonActor, signedInit, type TestActor } from "./inbox-helpers";
import {
  ALICE,
  ALICE_URI,
  AS,
  create,
  DAVE,
  followed,
  mastodonNote,
  nextId,
  OTHER,
  PUBLIC,
  remove,
  type Setup,
  setup,
  update,
} from "./inbox-status-helpers";

// A remote account's pinned statuses, featured hashtags and hide_collections (Mastodon 4.5's ActivityPub::Activity::Add
// and Remove, FetchFeaturedCollectionService, FetchFeaturedTagsCollectionService and
// ProcessAccountService#set_fetchable_attributes!): learned from Add and Remove and from its collections, and shown by
// the profile endpoints through the same rules as a local account's.

type Status = { id: string; uri: string };
type FeaturedTag = { name: string; statuses_count: string; last_status_at: string | null };
type Account = { id: string; hide_collections: boolean | null };

function featuredOf(actor: TestActor): string {
  return `${actor.uri}/collections/featured`;
}

function addOrRemove(type: "Add" | "Remove", actor: TestActor, object: unknown, target = featuredOf(actor)) {
  return {
    "@context": AS,
    id: `${actor.uri}#${type.toLowerCase()}-${nextId()}`,
    type,
    actor: actor.uri,
    target,
    object,
  };
}

function hashtag(name: string) {
  return { type: "Hashtag", href: `${MASTODON}/tags/${name.toLowerCase()}`, name: `#${name}` };
}

async function pinned(t: Setup, accountId: string, as: "alice" | "dave" | null): Promise<string[]> {
  const response = await t.api<Status[]>(`/api/v1/accounts/${accountId}/statuses?pinned=true`, as);
  expect(response.status).toBe(200);
  return response.body.map((status) => status.uri);
}

async function featuredTags(t: Setup, accountId: string): Promise<FeaturedTag[]> {
  const response = await t.api<FeaturedTag[]>(`/api/v1/accounts/${accountId}/featured_tags`, null);
  expect(response.status).toBe(200);
  return response.body;
}

const rows = (t: Setup, table: string) => sql<{ n: number }>(t.store, `SELECT count(*) AS n FROM ${table}`);

// A round of jobs' syncs, as the Queue's and cron's rounds run them, until none waits.
function deps(t: Setup, loader: Parameters<typeof inboxDeps>[1] = t.web.loader) {
  return inboxDeps(() => t.store, loader);
}

async function sync(t: Setup, loader: Parameters<typeof inboxDeps>[1] = t.web.loader, now = NOW): Promise<void> {
  const at = { ...deps(t, loader), now: () => now };
  for (let round = 0; round < 5 && (await syncCollections(t.env, at)); round++) {
    // Another sync waits.
  }
  expect(await rows(t, "collection_syncs")).toEqual([{ n: 0 }]);
}

// The Store, with `after` run once a call of `method` has returned (a point between two steps of a round).
function storeWithHook(t: Setup, method: string, after: () => Promise<void>) {
  const stub = t.store as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  return new Proxy(t.store, {
    get(_target, key: string) {
      if (key === method) {
        return async (...args: unknown[]) => {
          const result = await stub[key]!(...args);
          await after();
          return result;
        };
      }
      return (...args: unknown[]) => stub[key]!(...args);
    },
  });
}

describe("learning a remote account’s collections from Add and Remove", () => {
  it("pins and unpins its statuses and features its hashtags, shown with the audience rules", async () => {
    const clock = { now: NOW };
    const t = await setup(clock);
    const bob = await mastodonActor(t.web, "bob");
    const bobId = await followed(t, bob);
    const open = mastodonNote(bob, { tag: [hashtag("Cats")] });
    const followersOnly = mastodonNote(bob, { to: [`${bob.uri}/followers`], cc: [] });
    expect(await t.post(bob, create(bob, open))).toBe(202);
    expect(await t.post(bob, create(bob, followersOnly))).toBe(202);

    expect(await t.post(bob, addOrRemove("Add", bob, open.id))).toBe(202);
    clock.now += 1000;
    expect(await t.post(bob, addOrRemove("Add", bob, followersOnly.id))).toBe(202);
    expect(await t.post(bob, addOrRemove("Add", bob, hashtag("Cats")))).toBe(202);
    // Mastodon sends a featured hashtag's Add to the featured collection; Kopje also takes it to featuredTags.
    expect(await t.post(bob, addOrRemove("Add", bob, hashtag("Dogs"), `${bob.uri}/collections/tags`))).toBe(202);

    // Newest pin first. The followers-only pin is shown to alice, who follows bob, and to nobody else.
    expect(await pinned(t, bobId, "alice")).toEqual([followersOnly.id, open.id]);
    expect(await pinned(t, bobId, "dave")).toEqual([open.id]);
    expect(await pinned(t, bobId, null)).toEqual([open.id]);
    // Counted from the statuses Kopje has, as FeaturedTag#reset_data counts them.
    expect(await featuredTags(t, bobId)).toEqual([
      expect.objectContaining({ name: "Cats", statuses_count: "1", last_status_at: "2026-10-11" }),
      expect.objectContaining({ name: "Dogs", statuses_count: "0", last_status_at: null }),
    ]);

    // A later status with a featured hashtag counts, and its deletion uncounts it (RemoveStatusService).
    const later = mastodonNote(bob, { tag: [hashtag("cats")], published: "2026-10-11T13:00:00Z" });
    expect(await t.post(bob, create(bob, later))).toBe(202);
    expect((await featuredTags(t, bobId))[0]).toMatchObject({ statuses_count: "2" });
    expect(await t.post(bob, remove(bob, later.id))).toBe(202);
    expect((await featuredTags(t, bobId))[0]).toMatchObject({ statuses_count: "1", last_status_at: "2026-10-11" });

    expect(await t.post(bob, addOrRemove("Remove", bob, open.id))).toBe(202);
    expect(await t.post(bob, addOrRemove("Remove", bob, hashtag("cats")))).toBe(202);
    expect(await pinned(t, bobId, "alice")).toEqual([followersOnly.id]);
    expect((await featuredTags(t, bobId)).map((tag) => tag.name)).toEqual(["Dogs"]);
  });

  it("fetches an Add’s status as the instance actor, not the inbox’s recipient, when no follower may sign", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const bobId = await followed(t, bob);
    // Alice, bob's one local follower, is suspended; the Add arrives at dave's personal inbox.
    await sql(
      t.store,
      "UPDATE local_accounts SET suspended_at = '2026-01-01T00:00:00.000Z' WHERE account_id = ?",
      ALICE,
    );
    const note = mastodonNote(bob);
    t.web.serve(note.id, { "@context": AS, ...note });
    expect(await t.post(bob, addOrRemove("Add", bob, note.id), { path: "/ap/users/dave/inbox" })).toBe(202);
    expect(t.web.signers[t.web.fetched.indexOf(note.id)]).toBe("https://kopje.test/actor#main-key");
    expect(await pinned(t, bobId, null)).toEqual([note.id]);
  });

  it("checks the follower again when it loads its key: one no longer eligible does not sign", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const note = mastodonNote(bob);
    t.web.serve(note.id, { "@context": AS, ...note });
    const featured = featuredOf(bob);
    t.web.serve(featured, { "@context": AS, id: featured, type: "OrderedCollection", orderedItems: [note.id] });
    await followed(t, bob);
    // Alice unfollows bob after the round claimed the sync (naming her), before her key is loaded.
    const store = storeWithHook(t, "claimCollectionSync", async () => {
      await sql(t.store, "DELETE FROM follows WHERE account_id = ?", ALICE);
    });
    const unfollowing = { ...deps(t), store: () => store };
    for (let round = 0; round < 5 && (await syncCollections(t.env, unfollowing)); round++) {
      // Until no sync is due.
    }
    const signed = t.web.fetched.flatMap((url, i) => (url === featured || url === note.id ? [t.web.signers[i]] : []));
    expect(signed.length).toBeGreaterThan(0);
    expect(signed.every((signer) => signer === "https://kopje.test/actor#main-key")).toBe(true);
  });

  it("links a featured hashtag to the remote account, never to a local one of the same username", async () => {
    const t = await setup();
    // A remote alice, and the local alice, each featuring #cats.
    const remoteAlice = await mastodonActor(t.web, "alice");
    const remoteId = await followed(t, remoteAlice, DAVE);
    expect(await t.post(remoteAlice, addOrRemove("Add", remoteAlice, hashtag("cats")))).toBe(202);
    const local = await t.request("/api/v1/featured_tags", {
      method: "POST",
      headers: { authorization: `Bearer ${t.tokens.alice}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "cats" }),
    });
    expect(local.status).toBe(200);
    const [remoteUrl] = (await featuredTags(t, remoteId)).map((tag) => (tag as FeaturedTag & { url: string }).url);
    const [localUrl] = (await featuredTags(t, ALICE)).map((tag) => (tag as FeaturedTag & { url: string }).url);
    expect(remoteUrl).toBe("https://kopje.test/@alice@mastodon.example/tagged/cats");
    expect(localUrl).toBe("https://kopje.test/@alice/tagged/cats");
    // The remote one leads to the remote profile; the local one is the local page.
    const remote = await t.request(new URL(remoteUrl!).pathname);
    expect([remote.status, remote.headers.get("location")]).toEqual([302, `${MASTODON}/@alice`]);
    expect((await t.request(new URL(localUrl!).pathname)).status).toBe(200);
    expect((await t.request("/@nobody@mastodon.example/tagged/cats")).status).toBe(404);
  });

  it("fetches a status it does not have yet as a local follower, for an Add at the shared inbox", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const bobId = await followed(t, bob);
    // Followers-only, served only to a fetch signed by alice, who follows bob.
    const note = mastodonNote(bob, { to: [`${bob.uri}/followers`], cc: [] });
    t.web.serve(note.id, { "@context": AS, ...note });
    t.web.signedOnly.set(note.id, `${ALICE_URI}#main-key`);
    expect(await t.post(bob, addOrRemove("Add", bob, note.id), { path: "/inbox" })).toBe(202);
    expect(t.web.fetched).toContain(note.id);
    expect(await pinned(t, bobId, "alice")).toEqual([note.id]);
    expect(await pinned(t, bobId, "dave")).toEqual([]);
  });

  // The Add's need designates a follower's key or the instance's (DATA-7), and carries that signer chosen in the
  // round that asked (domain/inbox.ts fetchPreparation): no signer read follows, whichever signs.
  it.each([
    ["a local follower", true, `${ALICE_URI}#main-key`],
    ["the instance actor, its one follower suspended, at dave’s inbox", false, "https://kopje.test/actor#main-key"],
  ])("signs an Add’s status as %s with the signer its need carried", async (_name, eligible, signer) => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    if (!eligible) {
      await sql(
        t.store,
        "UPDATE local_accounts SET suspended_at = '2026-01-01T00:00:00.000Z' WHERE account_id = ?",
        ALICE,
      );
    }
    const note = mastodonNote(bob);
    t.web.serve(note.id, { "@context": AS, ...note });
    const { stub, calls, records } = countingStore(t.store);
    const h = harness(stub, {}, BUILD, { keygen: fixtureKeyGen, loader: t.web.loader });
    const path = eligible ? "/inbox" : "/ap/users/dave/inbox";
    const add = addOrRemove("Add", bob, note.id);
    expect((await h.request(path, await signedInit(bob, path, add))).status).toBe(202);
    expect(calls).toEqual(["inboxGate", "receiveActivity", "receiveActivity"]);
    const need = records[1]?.answer as {
      need?: { signer: unknown; prefetch: { signer: { username: string | null } } };
    };
    expect(need.need?.prefetch.signer.username).toBe(eligible ? "alice" : null);
    expect(t.web.signers[t.web.fetched.indexOf(note.id)]).toBe(signer);
  });

  it("ignores a forged Add: another actor’s, to a collection on another host, of another account’s status", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const mallory = await mastodonActor(t.web, "mallory", { key: 2 });
    const bobId = await followed(t, bob);
    const malloryId = await followed(t, mallory);
    const bobs = mastodonNote(bob);
    const mallorys = mastodonNote(mallory);
    expect(await t.post(bob, create(bob, bobs))).toBe(202);
    expect(await t.post(mallory, create(mallory, mallorys))).toBe(202);

    // Mallory adds bob's status to bob's collection, or to her own.
    expect(await t.post(mallory, addOrRemove("Add", mallory, bobs.id, featuredOf(bob)))).toBe(202);
    expect(await t.post(mallory, addOrRemove("Add", mallory, bobs.id))).toBe(202);
    expect(await t.post(mallory, addOrRemove("Add", mallory, hashtag("Cats"), featuredOf(bob)))).toBe(202);
    // Bob adds to a collection on another host, or one his document does not name.
    expect(await t.post(bob, addOrRemove("Add", bob, bobs.id, `${OTHER}/users/bob/collections/featured`))).toBe(202);
    expect(await t.post(bob, addOrRemove("Add", bob, bobs.id, `${bob.uri}/collections/other`))).toBe(202);
    expect(await t.post(bob, addOrRemove("Add", bob, hashtag("Cats"), `${OTHER}/tags`))).toBe(202);
    // Bob adds mallory's status (on his own host) to his own collection, and a hashtag that is not a valid name.
    expect(await t.post(bob, addOrRemove("Add", bob, mallorys.id))).toBe(202);
    expect(await t.post(bob, addOrRemove("Add", bob, { type: "Hashtag", name: "#not a tag" }))).toBe(202);

    expect(await rows(t, "status_pins")).toEqual([{ n: 0 }]);
    expect(await rows(t, "featured_tags")).toEqual([{ n: 0 }]);
    expect(await pinned(t, bobId, "alice")).toEqual([]);
    expect(await pinned(t, malloryId, "alice")).toEqual([]);

    // Mallory removes bob's pin: it stays.
    expect(await t.post(bob, addOrRemove("Add", bob, bobs.id))).toBe(202);
    expect(await t.post(mallory, addOrRemove("Remove", mallory, bobs.id, featuredOf(bob)))).toBe(202);
    expect(await t.post(mallory, addOrRemove("Remove", mallory, bobs.id))).toBe(202);
    expect(await pinned(t, bobId, "alice")).toEqual([bobs.id]);
  });

  it("counts a remote featured hashtag over its newest stored statuses, whatever happened to them", async () => {
    const clock = { now: NOW };
    const t = await setup(clock);
    const bob = await mastodonActor(t.web, "bob");
    const bobId = await followed(t, bob);
    // The count computed apart: bob's newest FEATURED_COUNT_WINDOW statuses that are public or unlisted originals with
    // #cats, and the date of the newest of them.
    const expected = async () => {
      const rows = await sql<{ id: string; visibility: string; reblog: number; at: string; cats: number }>(
        t.store,
        `SELECT id, visibility, reblog_of_id IS NOT NULL AS reblog, published_at AS at,
					EXISTS (SELECT 1 FROM status_tags WHERE status_id = statuses.id AND name = 'cats') AS cats
				FROM statuses WHERE account_id = ?`,
        bobId,
      );
      const window = rows.sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1)).slice(0, FEATURED_COUNT_WINDOW);
      const counted = window.filter(
        (r) => r.cats === 1 && r.reblog === 0 && (r.visibility === "public" || r.visibility === "unlisted"),
      );
      return {
        name: "cats",
        statuses_count: String(counted.length),
        last_status_at: counted[0]?.at.slice(0, 10) ?? null,
      };
    };
    const shown = async () => {
      const [tag] = await featuredTags(t, bobId);
      return { name: tag?.name, statuses_count: tag?.statuses_count, last_status_at: tag?.last_status_at };
    };
    const notes = [
      mastodonNote(bob, { tag: [hashtag("cats")], published: "2026-10-01T00:00:00Z" }),
      mastodonNote(bob, { published: "2026-10-02T00:00:00Z" }),
      mastodonNote(bob, { tag: [hashtag("cats")], published: "2026-10-03T00:00:00Z" }),
      mastodonNote(bob, {
        tag: [hashtag("cats")],
        to: [`${bob.uri}/followers`],
        cc: [],
        published: "2026-10-04T00:00:00Z",
      }),
    ];
    for (const note of notes) {
      expect(await t.post(bob, create(bob, note))).toBe(202);
    }
    expect(await t.post(bob, addOrRemove("Add", bob, hashtag("cats")))).toBe(202);
    expect(await shown()).toEqual({ ...(await expected()), statuses_count: "2", last_status_at: "2026-10-03" });
    // The newest counted status deleted.
    expect(await t.post(bob, remove(bob, notes[2]!.id))).toBe(202);
    expect(await shown()).toEqual(await expected());
    // An edit takes #cats off the oldest, another gives it to the second.
    clock.now += 60_000;
    expect(await t.post(bob, update(bob, { ...notes[0]!, tag: [] }, "2026-10-11T00:01:00Z"))).toBe(202);
    expect(await t.post(bob, update(bob, { ...notes[1]!, tag: [hashtag("cats")] }, "2026-10-11T00:02:00Z"))).toBe(202);
    expect(await shown()).toEqual({ ...(await expected()), statuses_count: "1", last_status_at: "2026-10-02" });
    // FEATURED_COUNT_WINDOW newer statuses without it push the tagged one out of the window.
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO statuses (id, uri, account_id, visibility, published_at)
			SELECT CAST(990000000000000000 + i AS TEXT), ?2 || '/statuses/w' || i, ?3, 'public', '2026-10-05T00:00:00.000Z' FROM n`,
      FEATURED_COUNT_WINDOW,
      bob.uri,
      bobId,
    );
    expect(await shown()).toEqual({ ...(await expected()), statuses_count: "0", last_status_at: null });
    // Learned again, it reads the same.
    expect(await t.post(bob, addOrRemove("Remove", bob, hashtag("cats")))).toBe(202);
    expect(await t.post(bob, addOrRemove("Add", bob, hashtag("cats")))).toBe(202);
    expect(await shown()).toEqual(await expected());
    // Nothing is kept in the row: the read counts.
    expect(await sql(t.store, "SELECT statuses_count, last_status_at FROM featured_tags")).toEqual([
      { statuses_count: 0, last_status_at: null },
    ]);
  });

  it("keeps at most MAX_REMOTE_PINS pins and MAX_FEATURED_TAGS hashtags", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const bobId = await followed(t, bob);
    const notes = Array.from({ length: MAX_REMOTE_PINS + 2 }, () => mastodonNote(bob));
    for (const note of notes) {
      expect(await t.post(bob, create(bob, note))).toBe(202);
      expect(await t.post(bob, addOrRemove("Add", bob, note.id))).toBe(202);
    }
    for (let i = 0; i < MAX_FEATURED_TAGS + 2; i++) {
      expect(await t.post(bob, addOrRemove("Add", bob, hashtag(`tag${i}`)))).toBe(202);
    }
    expect(await rows(t, "status_pins")).toEqual([{ n: MAX_REMOTE_PINS }]);
    expect((await featuredTags(t, bobId)).length).toBe(MAX_FEATURED_TAGS);
  });
});

describe("a remote account’s purge", () => {
  it("removes its pins, featured hashtags and waiting sync with it", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const bobId = await followed(t, bob);
    const note = mastodonNote(bob);
    expect(await t.post(bob, create(bob, note))).toBe(202);
    expect(await t.post(bob, addOrRemove("Add", bob, note.id))).toBe(202);
    expect(await t.post(bob, addOrRemove("Add", bob, hashtag("Cats")))).toBe(202);
    expect(await rows(t, "collection_syncs")).toEqual([{ n: 1 }]);
    const deleted = { "@context": AS, id: `${bob.uri}#delete`, type: "Delete", actor: bob.uri, object: bob.uri };
    expect(await t.post(bob, deleted)).toBe(202);
    const deps = inboxDeps(() => t.store, t.web.loader);
    for (let round = 0; round < 5; round++) {
      await runStoreJobs(t.store, BUILD, { now: NOW });
    }
    expect(await sql(t.store, "SELECT id FROM accounts WHERE id = ?", bobId)).toEqual([]);
    for (const table of ["status_pins", "featured_tags", "collection_syncs"]) {
      expect([table, await rows(t, table)]).toEqual([table, [{ n: 0 }]]);
    }
    // Nothing is left for a round to read.
    expect(await syncCollections(t.env, deps)).toBe(false);
  });
});

describe("reading a remote account’s collections", () => {
  // Bob's featured and featuredTags collections as Mastodon 4.5 serves them.
  function servedCollections(t: Setup, bob: TestActor, items: unknown[], tags: unknown[]) {
    t.web.serve(featuredOf(bob), {
      "@context": AS,
      id: featuredOf(bob),
      type: "OrderedCollection",
      totalItems: items.length,
      orderedItems: items,
    });
    t.web.serve(`${bob.uri}/collections/tags`, {
      "@context": AS,
      id: `${bob.uri}/collections/tags`,
      type: "Collection",
      totalItems: tags.length,
      items: tags,
    });
  }

  it("learns pins, featured hashtags and hide_collections when it stores the account, and applies them", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const mallory = await mastodonActor(t.web, "mallory", { key: 2 });
    const stored = mastodonNote(bob);
    const fetched = mastodonNote(bob, { to: [`${bob.uri}/followers`], cc: [] });
    const mallorys = mastodonNote(mallory);
    t.web.serve(fetched.id, { "@context": AS, ...fetched });
    t.web.serve(mallorys.id, { "@context": AS, ...mallorys });
    servedCollections(
      t,
      bob,
      [stored.id, fetched, mallorys.id, `${OTHER}/users/bob/statuses/1`, { type: "Hashtag", name: "#x" }],
      [hashtag("Cats"), hashtag("Dogs"), { type: "Note", name: "#Birds" }, hashtag("not valid!")],
    );
    t.web.serve(`${bob.uri}/followers`, counted(bob, "followers", 1, false));
    t.web.serve(`${bob.uri}/following`, counted(bob, "following", 1, true));

    // Storing bob's document (his Follow of dave) asks for a sync, and the inbox asks the Queue for a round.
    const bobId = await followed(t, bob);
    expect(await rows(t, "collection_syncs")).toEqual([{ n: 1 }]);
    expect(t.queue.pending.map((m) => m.body)).toContainEqual({ kind: "inbound-jobs" });
    expect(await t.post(bob, create(bob, stored))).toBe(202);
    await sync(t);

    // The collection's order is the profile's; mallory's status and one on another host are not bob's pins.
    expect(await pinned(t, bobId, "alice")).toEqual([stored.id, fetched.id]);
    expect(await pinned(t, bobId, "dave")).toEqual([stored.id]);
    expect((await featuredTags(t, bobId)).map((tag) => tag.name)).toEqual(["Cats", "Dogs"]);
    // Fetched as alice, bob's local follower (FetchFeaturedCollectionService#local_follower).
    expect(t.web.signers[t.web.fetched.indexOf(fetched.id)]).toBe(`${ALICE_URI}#main-key`);

    // His followers collection shows no items: he hides his network, from everyone but himself.
    const account = await t.api<Account>(`/api/v1/accounts/${bobId}`, "dave");
    expect(account.body.hide_collections).toBe(true);
    expect((await t.api<Account[]>(`/api/v1/accounts/${bobId}/following`, "dave")).body).toEqual([]);
    expect((await t.api<Account[]>(`/api/v1/accounts/${bobId}/followers`, "dave")).body).toEqual([]);
    expect((await t.api<Account[]>(`/api/v1/accounts/${bobId}/followers`, null)).body).toEqual([]);

    // He shows it again, unpins, and features other hashtags: the next sync follows.
    t.web.serve(`${bob.uri}/followers`, counted(bob, "followers", 1, true));
    servedCollections(t, bob, [fetched.id], [hashtag("dogs"), hashtag("Birds")]);
    const updated = { "@context": AS, id: `${bob.uri}#updates/${nextId()}`, type: "Update", actor: bob.uri };
    expect(await t.post(bob, { ...updated, object: bob.document })).toBe(202);
    await sync(t);
    expect(await pinned(t, bobId, "alice")).toEqual([fetched.id]);
    expect((await featuredTags(t, bobId)).map((tag) => tag.name)).toEqual(["dogs", "Birds"]);
    expect((await t.api<Account>(`/api/v1/accounts/${bobId}`, "dave")).body.hide_collections).toBe(false);
    expect((await t.api<Account[]>(`/api/v1/accounts/${bobId}/followers`, "dave")).body.map((a) => a.id)).toEqual([
      ALICE,
    ]);
    expect((await t.api<Account[]>(`/api/v1/accounts/${bobId}/following`, null)).body.map((a) => a.id)).toEqual([DAVE]);
  });

  it("reads the collections again when the actor names others while a round reads the old ones", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const old = mastodonNote(bob);
    const fresh = mastodonNote(bob);
    servedCollections(t, bob, [old.id], [hashtag("Old")]);
    const featured2 = `${bob.uri}/collections/featured2`;
    t.web.serve(featured2, { "@context": AS, id: featured2, type: "OrderedCollection", orderedItems: [fresh.id] });
    const bobId = await followed(t, bob);
    expect(await t.post(bob, create(bob, old))).toBe(202);
    expect(await t.post(bob, create(bob, fresh))).toBe(202);
    // When the round asks for the old featured collection, bob's Update naming featured2 arrives first.
    let updated = false;
    const intercepted = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new Request(input, init).url;
      if (url === featuredOf(bob) && !updated) {
        updated = true;
        t.web.serve(bob.uri, { ...bob.document, featured: featured2 });
        const update = { "@context": AS, id: `${bob.uri}#updates/${nextId()}`, type: "Update", actor: bob.uri };
        expect(await t.post(bob, { ...update, object: { ...bob.document, featured: featured2 } })).toBe(202);
      }
      return t.web.fetch(input, init);
    }) as typeof fetch;
    await sync(t, { ...t.web.loader, fetch: intercepted });
    expect(updated).toBe(true);
    expect(await pinned(t, bobId, null)).toEqual([fresh.id]);
  });

  it("continues a sync the fetch budget cut short in later rounds, until every pin is fetched", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    // Four collections, then more pinned statuses Kopje does not have than the budgets of one call's rounds fetch.
    const notes = Array.from({ length: MAX_REMOTE_PINS }, () => mastodonNote(bob));
    expect(notes.length).toBeGreaterThan(COLLECTION_SYNCS_PER_ROUND * (REQUEST_MAX_FETCHES - 4));
    for (const note of notes) {
      t.web.serve(note.id, { "@context": AS, ...note });
    }
    servedCollections(
      t,
      bob,
      notes.map((note) => note.id),
      [hashtag("Cats")],
    );
    t.web.serve(`${bob.uri}/followers`, counted(bob, "followers", 1, true));
    t.web.serve(`${bob.uri}/following`, counted(bob, "following", 1, true));
    const bobId = await followed(t, bob);
    // A call's rounds fetch what their budgets allow and say another is due.
    expect(await syncCollections(t.env, deps(t))).toBe(true);
    expect((await pinned(t, bobId, null)).length).toBeLessThan(notes.length);
    await sync(t);
    expect(await pinned(t, bobId, null)).toEqual(notes.map((note) => note.id));
  });

  it("shows the collection’s order across pins it had, pins it stores, and pins it fetches later", async () => {
    const clock = { now: NOW };
    const t = await setup(clock);
    const bob = await mastodonActor(t.web, "bob");
    const bobId = await followed(t, bob);
    const [old, unknown, stored] = [mastodonNote(bob), mastodonNote(bob), mastodonNote(bob)];
    expect(await t.post(bob, create(bob, old))).toBe(202);
    expect(await t.post(bob, create(bob, stored))).toBe(202);
    expect(await t.post(bob, addOrRemove("Add", bob, old.id))).toBe(202);
    t.web.serve(unknown.id, { "@context": AS, ...unknown });
    // An hour later the collection lists the old pin first, then one Kopje fetches later, then a stored one.
    clock.now += 3_600_000;
    servedCollections(t, bob, [old.id, unknown.id, stored.id], []);
    await sql(t.store, "INSERT INTO collection_syncs (account_id, due_at) VALUES (?, 0) ON CONFLICT DO NOTHING", bobId);
    await sync(t, t.web.loader, clock.now);
    expect(await pinned(t, bobId, null)).toEqual([old.id, unknown.id, stored.id]);
  });

  it("counts pending pins toward MAX_REMOTE_PINS, and an Add of a pending status takes its slot", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const bobId = await followed(t, bob);
    const stored = Array.from({ length: MAX_REMOTE_PINS - 2 }, () => mastodonNote(bob));
    const [extra, unknown, added] = [mastodonNote(bob), mastodonNote(bob), mastodonNote(bob)];
    for (const note of [...stored, extra]) {
      expect(await t.post(bob, create(bob, note))).toBe(202);
    }
    t.web.serve(unknown.id, { "@context": AS, ...unknown });
    t.web.serve(added.id, { "@context": AS, ...added });
    // 18 stored and 2 pending: every slot is taken once the read ends.
    servedCollections(t, bob, [...stored.map((note) => note.id), unknown.id, added.id], []);
    const store = storeWithHook(t, "completeCollectionRead", async () => {
      expect(await rows(t, "collection_pins_pending")).toEqual([{ n: 2 }]);
      // Another stored status finds no slot; the Add of a pending one converts its slot (and is fetched for it).
      expect(await t.post(bob, addOrRemove("Add", bob, extra.id))).toBe(202);
      expect(await t.post(bob, addOrRemove("Add", bob, added.id))).toBe(202);
      expect(await rows(t, "collection_pins_pending")).toEqual([{ n: 1 }]);
    });
    const hooked = { ...deps(t), store: () => store };
    for (let round = 0; round < 5 && (await syncCollections(t.env, hooked)); round++) {
      // Until no sync is due.
    }
    const shown = await pinned(t, bobId, null);
    expect(shown).toHaveLength(MAX_REMOTE_PINS);
    expect(shown).toContain(unknown.id);
    expect(shown).toContain(added.id);
    expect(shown).not.toContain(extra.id);
  });

  it("pins no pending status the actor removed before it was fetched, or while it was", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const [before, during] = [mastodonNote(bob), mastodonNote(bob)];
    servedCollections(t, bob, [before.id, during.id], []);
    const bobId = await followed(t, bob);
    // Bob removes `before` once the read left both pending, and `during` while its fetch is answered.
    t.web.serve(before.id, { "@context": AS, ...before });
    t.web.serve(during.id, { "@context": AS, ...during });
    const removing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new Request(input, init).url === during.id) {
        expect(await t.post(bob, addOrRemove("Remove", bob, during.id))).toBe(202);
      }
      return t.web.fetch(input, init);
    }) as typeof fetch;
    const store = storeWithHook(t, "completeCollectionRead", async () => {
      expect(await rows(t, "collection_pins_pending")).toEqual([{ n: 2 }]);
      expect(await t.post(bob, addOrRemove("Remove", bob, before.id))).toBe(202);
    });
    const hooked = { ...deps(t, { ...t.web.loader, fetch: removing }), store: () => store };
    for (let round = 0; round < 5 && (await syncCollections(t.env, hooked)); round++) {
      // Until no sync is due.
    }
    expect(t.web.fetched).toContain(during.id);
    expect(await pinned(t, bobId, null)).toEqual([]);
    expect(await rows(t, "collection_pins_pending")).toEqual([{ n: 0 }]);
  });

  it("drops pending statuses that cannot be used, and reaches those after them", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    // More statuses that answer 404 than a round's budget, then ones that can be fetched.
    const gone = Array.from({ length: REQUEST_MAX_FETCHES }, (_, i) => `${bob.uri}/statuses/gone${i}`);
    const notes = Array.from({ length: 3 }, () => mastodonNote(bob));
    for (const note of notes) {
      t.web.serve(note.id, { "@context": AS, ...note });
    }
    servedCollections(t, bob, [...gone, ...notes.map((note) => note.id)], []);
    const bobId = await followed(t, bob);
    await sync(t);
    expect(await pinned(t, bobId, null)).toEqual(notes.map((note) => note.id));
    expect(await rows(t, "collection_pins_pending")).toEqual([{ n: 0 }]);
    // Each one that answered 404 was asked for once.
    expect(gone.map((uri) => t.web.fetched.filter((u) => u === uri).length)).toEqual(gone.map(() => 1));
  });

  // The largest read: public network collections, a featured root with a first page, and a featuredTags root with
  // MAX_FEATURED_TAG_PAGES pages, each naming a next one; and one pinned status Kopje does not have. The documents
  // `redirected` names answer with a same-origin redirect to where they are served.
  function largestRead(t: Setup, bob: TestActor, redirected: (url: string) => boolean) {
    const serve = (url: string, body: Record<string, unknown>) => {
      if (redirected(url)) {
        t.web.redirect(url, `${url}#moved`.replace("#moved", url.includes("?") ? "&moved" : "?moved"));
        t.web.serve(url.includes("?") ? `${url}&moved` : `${url}?moved`, body);
      } else {
        t.web.serve(url, body);
      }
    };
    const note = mastodonNote(bob);
    t.web.serve(note.id, { "@context": AS, ...note });
    const featured = featuredOf(bob);
    serve(featured, { "@context": AS, id: featured, type: "OrderedCollection", first: `${featured}?page=1` });
    serve(`${featured}?page=1`, {
      "@context": AS,
      id: `${featured}?page=1`,
      type: "OrderedCollectionPage",
      orderedItems: [note.id],
    });
    const tags = `${bob.uri}/collections/tags`;
    const pageUrl = (n: number) => `${tags}?page=${n}`;
    serve(tags, { "@context": AS, id: tags, type: "OrderedCollection", first: pageUrl(1) });
    for (let n = 1; n <= MAX_FEATURED_TAG_PAGES + 1; n++) {
      serve(pageUrl(n), {
        "@context": AS,
        id: pageUrl(n),
        type: "OrderedCollectionPage",
        next: pageUrl(n + 1),
        orderedItems: [hashtag(`page${n}`)],
      });
    }
    serve(`${bob.uri}/followers`, counted(bob, "followers", 1, true));
    serve(`${bob.uri}/following`, counted(bob, "following", 1, true));
    return { note, tags };
  }

  it("reads the largest healthy collections through, a part at a time, and reaches the pinned statuses after", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    // One redirect makes the whole read cost more than a round's budget (2 + 2 + 1 + the pages, and the hop).
    const { note } = largestRead(t, bob, (url) => url === `${bob.uri}/collections/tags`);
    expect(2 + 2 + 1 + MAX_FEATURED_TAG_PAGES + 1).toBeGreaterThan(REQUEST_MAX_FETCHES);
    const bobId = await followed(t, bob);
    await sync(t);
    expect(await pinned(t, bobId, null)).toEqual([note.id]);
    expect((await featuredTags(t, bobId)).length).toBe(MAX_FEATURED_TAG_PAGES);
    expect((await t.api<Account>(`/api/v1/accounts/${bobId}`, null)).body.hide_collections).toBe(false);
    // A part read through is not read again: the featured and network collections were asked for once (the
    // featuredTags collection, cut short by the budget in the first round, again in the next).
    for (const url of [featuredOf(bob), `${bob.uri}/followers`, `${bob.uri}/following`]) {
      expect([url, t.web.fetched.filter((fetched) => fetched === url).length]).toEqual([url, 1]);
    }
  });

  it("fetches the pending statuses even when a part of the read never completes", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const note = mastodonNote(bob);
    t.web.serve(note.id, { "@context": AS, ...note });
    servedCollections(t, bob, [note.id], []);
    t.web.fail(`${bob.uri}/collections/tags`, 503);
    const bobId = await followed(t, bob);
    for (let round = 0; round <= MAX_SYNC_ATTEMPTS + 1; round++) {
      await sql(t.store, "UPDATE collection_syncs SET due_at = ?", NOW);
      await syncCollections(t.env, deps(t));
    }
    expect(await pinned(t, bobId, null)).toEqual([note.id]);
    expect(await rows(t, "collection_syncs")).toEqual([{ n: 0 }]);
  });

  it("starts a round with another unread part after one without progress, so a failing part starves none", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    // The network collections redirect once each, and the following one then fails (four fetches each round, read
    // never); the featuredTags collection is the largest, each document redirected once (the whole budget).
    largestRead(
      t,
      bob,
      (url) =>
        url.startsWith(`${bob.uri}/collections/tags`) || url.endsWith("/followers") || url.endsWith("/following"),
    );
    t.web.fail(`${bob.uri}/following?moved`, 503);
    const bobId = await followed(t, bob);
    for (let round = 0; round <= MAX_SYNC_ATTEMPTS + 1; round++) {
      await sql(t.store, "UPDATE collection_syncs SET due_at = ?", NOW);
      await syncCollections(t.env, deps(t));
    }
    expect((await featuredTags(t, bobId)).length).toBe(MAX_FEATURED_TAG_PAGES);
  });

  it("reads each part through even with a redirect on every one of its documents", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    expect(Math.max(...Object.values(PART_DOCUMENTS)) * 2).toBeLessThanOrEqual(REQUEST_MAX_FETCHES);
    const { note } = largestRead(t, bob, (url) => url.startsWith(bob.uri) && !url.includes("/statuses/"));
    const bobId = await followed(t, bob);
    await sync(t);
    expect(await pinned(t, bobId, null)).toEqual([note.id]);
    expect((await featuredTags(t, bobId)).length).toBe(MAX_FEATURED_TAG_PAGES);
    expect((await t.api<Account>(`/api/v1/accounts/${bobId}`, null)).body.hide_collections).toBe(false);
  });

  it("keeps the first MAX_REMOTE_PINS items and MAX_FEATURED_TAGS hashtags of an oversized collection", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const notes = Array.from({ length: MAX_REMOTE_PINS + 10 }, () => mastodonNote(bob, { to: [PUBLIC] }));
    servedCollections(
      t,
      bob,
      notes.map((note) => note.id),
      Array.from({ length: MAX_FEATURED_TAGS + 10 }, (_, i) => hashtag(`tag${i}`)),
    );
    const bobId = await followed(t, bob);
    for (const note of notes) {
      expect(await t.post(bob, create(bob, note))).toBe(202);
    }
    await sync(t);
    expect(await pinned(t, bobId, null)).toEqual(notes.slice(0, MAX_REMOTE_PINS).map((note) => note.id));
    expect((await featuredTags(t, bobId)).map((tag) => tag.name)).toEqual(
      Array.from({ length: MAX_FEATURED_TAGS }, (_, i) => `tag${i}`),
    );
  });

  it("skips a featured hashtag past the list bound, from the collection and from an Add, and never respells to one", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const names = async () => (await featuredTags(t, bobId)).map((tag) => tag.name);
    const plain = "b".repeat(200);
    servedCollections(t, bob, [], [hashtag("Cats"), hashtag("a".repeat(257)), hashtag(plain)]);
    const bobId = await followed(t, bob);
    await sync(t);
    expect(await names()).toEqual(["Cats", plain]);
    // An Add past the bound is skipped (no error: ingestion answers 202 and features nothing).
    expect(await t.post(bob, addOrRemove("Add", bob, hashtag("c".repeat(257))))).toBe(202);
    expect(await names()).toEqual(["Cats", plain]);
    // The collection respells the 200-letter one with a combining mark on each letter: its name is the same, but its
    // spelling of 400 code points is past the bound, so it is not listed, and the row goes rather than take it.
    servedCollections(t, bob, [], [hashtag("Cats"), hashtag("b\u0301".repeat(200))]);
    const updated = { "@context": AS, id: `${bob.uri}#updates/${nextId()}`, type: "Update", actor: bob.uri };
    expect(await t.post(bob, { ...updated, object: bob.document })).toBe(202);
    await sync(t);
    expect(await names()).toEqual(["Cats"]);
    expect(await sql(t.store, "SELECT display_name FROM featured_tags")).toEqual([{ display_name: "Cats" }]);
  });

  it("looks at the first MAX_REMOTE_PINS items of the featured collection only, whatever they are", async () => {
    const t = await setup();
    // No featuredTags collection: the featured collection's Hashtags are its featured hashtags.
    const bob = await mastodonActor(t.web, "bob", { extra: { featuredTags: null } });
    const own = mastodonNote(bob);
    const late = mastodonNote(bob);
    t.web.serve(late.id, { "@context": AS, ...late });
    const foreign = Array.from({ length: MAX_REMOTE_PINS - 2 }, (_, i) => `${OTHER}/users/bob/statuses/${i}`);
    servedCollections(t, bob, [hashtag("Early"), ...foreign, own.id, late.id, hashtag("Late")], []);
    const bobId = await followed(t, bob);
    expect(await t.post(bob, create(bob, own))).toBe(202);
    await sync(t);
    // The 20th item is pinned; the 21st is not, nor fetched, and the hashtag after it is not featured.
    expect(await pinned(t, bobId, null)).toEqual([own.id]);
    expect(t.web.fetched).not.toContain(late.id);
    expect((await featuredTags(t, bobId)).map((tag) => tag.name)).toEqual(["Early"]);
  });

  it("reads at most MAX_FEATURED_TAG_PAGES pages of the featuredTags collection, and never asks for the next", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    servedCollections(t, bob, [], []);
    const tags = `${bob.uri}/collections/tags`;
    const pageUrl = (n: number) => `${tags}?page=${n}`;
    t.web.serve(tags, { "@context": AS, id: tags, type: "OrderedCollection", first: pageUrl(1) });
    for (let n = 1; n <= MAX_FEATURED_TAG_PAGES + 1; n++) {
      t.web.serve(pageUrl(n), {
        "@context": AS,
        id: pageUrl(n),
        type: "OrderedCollectionPage",
        next: pageUrl(n + 1),
        orderedItems: [hashtag(`page${n}`)],
      });
    }
    const bobId = await followed(t, bob);
    await sync(t);
    expect(t.web.fetched).not.toContain(pageUrl(MAX_FEATURED_TAG_PAGES + 1));
    expect((await featuredTags(t, bobId)).map((tag) => tag.name)).toEqual(
      Array.from({ length: MAX_FEATURED_TAG_PAGES }, (_, i) => `page${i + 1}`),
    );
  });

  it("leaves what it learned as it was when a collection cannot be read for now, unless the other one hides", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const note = mastodonNote(bob);
    servedCollections(t, bob, [note.id], [hashtag("Cats")]);
    t.web.serve(`${bob.uri}/followers`, counted(bob, "followers", 1, true));
    t.web.serve(`${bob.uri}/following`, counted(bob, "following", 1, true));
    const bobId = await followed(t, bob);
    expect(await t.post(bob, create(bob, note))).toBe(202);
    await sync(t);
    expect(await pinned(t, bobId, null)).toEqual([note.id]);

    t.web.fail(featuredOf(bob), 503);
    t.web.fail(`${bob.uri}/collections/tags`, 503);
    t.web.fail(`${bob.uri}/following`, 503);
    await sql(t.store, "INSERT INTO collection_syncs (account_id, due_at) VALUES (?, 0)", bobId);
    expect(await syncCollections(t.env, deps(t))).toBe(false);
    expect(await pinned(t, bobId, null)).toEqual([note.id]);
    expect((await featuredTags(t, bobId)).map((tag) => tag.name)).toEqual(["Cats"]);
    expect((await t.api<Account>(`/api/v1/accounts/${bobId}`, null)).body.hide_collections).toBe(false);
    // The sync waits to be tried again later; a round that did nothing counts toward MAX_SYNC_ATTEMPTS.
    expect(await sql(t.store, "SELECT due_at, attempts FROM collection_syncs")).toEqual([
      { due_at: NOW + SYNC_RETRY_MS, attempts: 1 },
    ]);

    // The following collection still times out, but the followers collection now hides its items: hidden.
    t.web.serve(`${bob.uri}/followers`, counted(bob, "followers", 1, false));
    await sql(t.store, "UPDATE collection_syncs SET due_at = 0");
    await syncCollections(t.env, deps(t));
    expect((await t.api<Account>(`/api/v1/accounts/${bobId}`, null)).body.hide_collections).toBe(true);
    expect((await t.api<Account[]>(`/api/v1/accounts/${bobId}/followers`, null)).body).toEqual([]);
  });
});

describe("a round’s claim of a sync", () => {
  const read = (tags: string[]) => ({
    parts: ALL_PARTS,
    pins: null,
    tags,
    hideCollections: null,
    counts: { statuses: null, following: null, followers: null },
  });
  const claim = async (t: Setup, now: number) => {
    const sync = await t.store.claimCollectionSync(BUILD, { now });
    if (sync === null || sync === "more") {
      throw new Error("no sync claimed");
    }
    return sync;
  };
  const complete = (t: Setup, sync: Awaited<ReturnType<typeof claim>>, now: number, tags: string[]) =>
    t.store.completeCollectionRead(BUILD, {
      now,
      origin: LOCAL,
      accountUri: sync.accountUri,
      generation: sync.generation,
      token: sync.token,
      ...read(tags),
    });

  it("goes on past syncs it drops, so one round still reaches a due sync behind them", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const tags = `${bob.uri}/collections/tags`;
    t.web.serve(tags, { "@context": AS, id: tags, type: "Collection", items: [hashtag("Cats")] });
    const bobId = await followed(t, bob);
    // MAX_SYNC_ATTEMPTS + 1 syncs out of attempts, due before bob's.
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT CAST(980000000000000000 + i AS TEXT), 'https://far.example/users/x' || i, 'x' || i, 'far.example' FROM n`,
      MAX_SYNC_ATTEMPTS + 1,
    );
    await sql(
      t.store,
      `INSERT INTO collection_syncs (account_id, due_at, attempts)
			SELECT id, 0, ? FROM accounts WHERE username GLOB 'x*'`,
      MAX_SYNC_ATTEMPTS,
    );
    await syncCollections(t.env, deps(t));
    expect((await featuredTags(t, bobId)).map((tag) => tag.name)).toEqual(["Cats"]);
    expect(await rows(t, "collection_syncs")).toEqual([{ n: 0 }]);
  });

  it("gives a new request its own attempts, so rounds that failed for the older one do not drop it", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    t.web.fail(featuredOf(bob), 503);
    const bobId = await followed(t, bob);
    // MAX_SYNC_ATTEMPTS rounds fail for now; the sync waits, out of attempts, for its retry.
    // (The first round reads the other parts through and leaves the sync due; the same call's second round, and
    // every round after, makes no progress.)
    for (let round = 0; round < MAX_SYNC_ATTEMPTS; round++) {
      await sql(t.store, "UPDATE collection_syncs SET due_at = ?", NOW);
      await syncCollections(t.env, deps(t));
    }
    expect(await sql(t.store, "SELECT attempts, due_at > ? AS later FROM collection_syncs", NOW)).toEqual([
      { attempts: MAX_SYNC_ATTEMPTS, later: 1 },
    ]);
    // Bob's Update names a featured collection that answers: read at once.
    const featured2 = `${bob.uri}/collections/featured2`;
    const note = mastodonNote(bob);
    t.web.serve(featured2, { "@context": AS, id: featured2, type: "OrderedCollection", orderedItems: [note.id] });
    t.web.serve(bob.uri, { ...bob.document, featured: featured2 });
    expect(await t.post(bob, create(bob, note))).toBe(202);
    const update = { "@context": AS, id: `${bob.uri}#updates/${nextId()}`, type: "Update", actor: bob.uri };
    expect(await t.post(bob, { ...update, object: { ...bob.document, featured: featured2 } })).toBe(202);
    await sync(t);
    expect(await pinned(t, bobId, null)).toEqual([note.id]);
  });

  it("lets only the current claim end it: a round whose lease ended, or whose sync was asked for anew, changes nothing", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const bobId = await followed(t, bob);
    // Round A's lease ends before it finishes; round B takes the sync over and ends it first.
    const a = await claim(t, NOW);
    const b = await claim(t, NOW + SYNC_LEASE_MS);
    expect(b.token).not.toBe(a.token);
    await complete(t, b, NOW + SYNC_LEASE_MS, ["Newer"]);
    await complete(t, a, NOW + SYNC_LEASE_MS, ["Older"]);
    expect((await featuredTags(t, bobId)).map((tag) => tag.name)).toEqual(["Newer"]);
    expect(await rows(t, "collection_syncs")).toEqual([{ n: 0 }]);

    // Round C's sync is deleted and asked for anew (the same generation): C's end changes nothing, and the new
    // request still waits.
    await sql(t.store, "INSERT INTO collection_syncs (account_id, due_at) VALUES (?, ?)", bobId, NOW);
    const c = await claim(t, NOW);
    await sql(t.store, "DELETE FROM collection_syncs");
    await sql(t.store, "INSERT INTO collection_syncs (account_id, due_at) VALUES (?, ?)", bobId, NOW);
    await complete(t, c, NOW, ["Stale"]);
    expect((await featuredTags(t, bobId)).map((tag) => tag.name)).toEqual(["Newer"]);
    expect(await sql(t.store, "SELECT generation, read_through FROM collection_syncs")).toEqual([
      { generation: 1, read_through: 0 },
    ]);
  });
});

// A remote account's counts (ProcessAccountService#set_fetchable_attributes!): the totalItems of its outbox, following
// and followers collections, read by the network part of a sync (federation/collections.ts readNetwork) and stored by
// completeCollectionRead.
type Counts = { statuses_count: number; following_count: number; followers_count: number };
type CountedAccount = Counts & Account;

// A Mastodon-shaped collection of `actor` with `totalItems` (left out when undefined) and, when shown, a first page.
function counted(actor: TestActor, kind: "outbox" | "following" | "followers", totalItems: unknown, shown = true) {
  const id = `${actor.uri}/${kind}`;
  return {
    "@context": AS,
    id,
    type: "OrderedCollection",
    ...(totalItems === undefined ? {} : { totalItems }),
    ...(shown ? { first: `${id}?page=1` } : {}),
  };
}

// The three collections, each with its totalItems; following and followers show their items.
function serveCounts(t: Setup, actor: TestActor, outbox: unknown, following: unknown, followers: unknown) {
  t.web.serve(`${actor.uri}/outbox`, counted(actor, "outbox", outbox));
  t.web.serve(`${actor.uri}/following`, counted(actor, "following", following));
  t.web.serve(`${actor.uri}/followers`, counted(actor, "followers", followers));
}

// The account's counts as presented: [statuses, following, followers].
async function presentedCounts(t: Setup, accountId: string): Promise<number[]> {
  const { body } = await t.api<CountedAccount>(`/api/v1/accounts/${accountId}`, null);
  return [body.statuses_count, body.following_count, body.followers_count];
}

async function hidden(t: Setup, accountId: string): Promise<boolean | null> {
  return (await t.api<CountedAccount>(`/api/v1/accounts/${accountId}`, null)).body.hide_collections;
}

// The account's counts as stored: [statuses, following, followers].
async function storedCounts(t: Setup, accountId: string): Promise<unknown[]> {
  const [row] = await sql<{ s: number; g: number; f: number }>(
    t.store,
    "SELECT statuses_count AS s, following_count AS g, followers_count AS f FROM accounts WHERE id = ?",
    accountId,
  );
  return [row?.s, row?.g, row?.f];
}

// The actor's Update of its own document, which stores it again and asks for a sync (a new generation).
async function updated(t: Setup, actor: TestActor, document: Record<string, unknown> = actor.document) {
  t.web.serve(actor.uri, document);
  const update = { "@context": AS, id: `${actor.uri}#updates/${nextId()}`, type: "Update", actor: actor.uri };
  expect(await t.post(actor, { ...update, object: document })).toBe(202);
}

const syncRows = (t: Setup) =>
  sql<{ parts_read: number; generation: number; read_through: number }>(
    t.store,
    "SELECT parts_read, generation, read_through FROM collection_syncs",
  );

describe("learning a remote account’s counts from its collections", () => {
  it("takes the outbox, following and followers totalItems, reading the followers even when the following hides", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    t.web.serve(`${bob.uri}/outbox`, counted(bob, "outbox", 42));
    t.web.serve(`${bob.uri}/following`, counted(bob, "following", 7));
    t.web.serve(`${bob.uri}/followers`, counted(bob, "followers", 1_234, false));
    const bobId = await followed(t, bob);
    // Never learned: 0, as an account_stats row Mastodon has not filled.
    expect(await presentedCounts(t, bobId)).toEqual([0, 0, 0]);
    await sync(t);
    expect(await presentedCounts(t, bobId)).toEqual([42, 7, 1_234]);
    // hide_collections does not zero them (REST::AccountSerializer shows both).
    expect(await hidden(t, bobId)).toBe(true);

    // The following hides its items now: the followers collection is still fetched, for its count.
    t.web.serve(`${bob.uri}/outbox`, counted(bob, "outbox", 43));
    t.web.serve(`${bob.uri}/following`, counted(bob, "following", 8, false));
    t.web.serve(`${bob.uri}/followers`, counted(bob, "followers", 1_235));
    const before = t.web.fetched.length;
    await updated(t, bob);
    await sync(t);
    expect(t.web.fetched.slice(before)).toContain(`${bob.uri}/followers`);
    expect(await presentedCounts(t, bobId)).toEqual([43, 8, 1_235]);
    expect(await hidden(t, bobId)).toBe(true);

    // A collection without totalItems, and an outbox that is gone, keep their counts; the followers' changes.
    t.web.serve(`${bob.uri}/following`, counted(bob, "following", undefined));
    t.web.serve(`${bob.uri}/followers`, counted(bob, "followers", 99));
    t.web.fail(`${bob.uri}/outbox`, 404);
    await updated(t, bob);
    await sync(t);
    expect(await presentedCounts(t, bobId)).toEqual([43, 8, 99]);
    expect(await hidden(t, bobId)).toBe(false);
  });

  it("reads a count only from a collection on the actor’s own origin, fetched by its id", async () => {
    const t = await setup();
    const elsewhere = `${OTHER}/users/bob/outbox`;
    // The outbox on another origin; the following given as an object, which names its id (fetched, not taken).
    const bob = await mastodonActor(t.web, "bob", {
      extra: { outbox: elsewhere, following: { id: `${MASTODON}/users/bob/following`, totalItems: 1_000 } },
    });
    t.web.serve(elsewhere, { "@context": AS, id: elsewhere, type: "OrderedCollection", totalItems: 5 });
    t.web.serve(`${bob.uri}/following`, counted(bob, "following", 7));
    t.web.serve(`${bob.uri}/followers`, counted(bob, "followers", 9));
    const bobId = await followed(t, bob);
    await sync(t);
    expect(await presentedCounts(t, bobId)).toEqual([0, 7, 9]);
    expect(t.web.fetched).not.toContain(elsewhere);
    expect(t.web.fetched).toContain(`${bob.uri}/following`);
  });

  it("takes a JSON number’s integer part, a negative as 0, and keeps the count past MAX_ACCOUNT_COUNT or for a non-number", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const learn = async (outbox: unknown, following: unknown, followers: unknown) => {
      serveCounts(t, bob, outbox, following, followers);
      await updated(t, bob);
      await sync(t);
      return presentedCounts(t, bobId);
    };
    serveCounts(t, bob, 11, 22, 33);
    const bobId = await followed(t, bob);
    await sync(t);
    expect(await presentedCounts(t, bobId)).toEqual([11, 22, 33]);
    // A fraction is cut, MAX_ACCOUNT_COUNT is stored, a negative is 0 (and 0 replaces a count).
    expect(MAX_ACCOUNT_COUNT).toBe(2 ** 53 - 1);
    expect(await learn(1.9, MAX_ACCOUNT_COUNT, -3)).toEqual([1, MAX_ACCOUNT_COUNT, 0]);
    expect(await learn(11, 22, 33)).toEqual([11, 22, 33]);
    // Past MAX_ACCOUNT_COUNT, not finite (1e400 parses as Infinity), a string: each keeps its count.
    serveCounts(t, bob, 2 ** 53, 0, "5");
    const following = JSON.stringify(counted(bob, "following", 0)).replace('"totalItems":0', '"totalItems":1e400');
    t.web.serveRaw(`${bob.uri}/following`, following);
    await updated(t, bob);
    await sync(t);
    expect(await presentedCounts(t, bobId)).toEqual([11, 22, 33]);
    expect(await learn(true, null, 0)).toEqual([11, 22, 0]);
    expect(await storedCounts(t, bobId)).toEqual([11, 22, 0]);
  });

  it("applies what the network part learned while the outbox may be read later, and reads it again", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    t.web.serve(`${bob.uri}/following`, counted(bob, "following", 7));
    t.web.serve(`${bob.uri}/followers`, counted(bob, "followers", 9));
    t.web.fail(`${bob.uri}/outbox`, 503);
    const bobId = await followed(t, bob);
    // Both rounds of the call (COLLECTION_SYNCS_PER_ROUND) claim bob's sync, and both find the outbox failing.
    expect(COLLECTION_SYNCS_PER_ROUND).toBe(2);
    await syncCollections(t.env, deps(t));
    expect(await presentedCounts(t, bobId)).toEqual([0, 7, 9]);
    expect(await hidden(t, bobId)).toBe(false);
    const [row] = await syncRows(t);
    expect(row!.parts_read & PART_NETWORK).toBe(0);
    // It answers later: the part is read again and the statuses count learned.
    t.web.serve(`${bob.uri}/outbox`, counted(bob, "outbox", 42));
    await sql(t.store, "UPDATE collection_syncs SET due_at = ?", NOW);
    await sync(t);
    expect(await presentedCounts(t, bobId)).toEqual([42, 7, 9]);
  });

  it("reads the healthy parts and the pending pins beside an outbox that never answers", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const note = mastodonNote(bob);
    t.web.serve(note.id, { "@context": AS, ...note });
    const featured = featuredOf(bob);
    t.web.serve(featured, { "@context": AS, id: featured, type: "OrderedCollection", orderedItems: [note.id] });
    const tags = `${bob.uri}/collections/tags`;
    t.web.serve(tags, { "@context": AS, id: tags, type: "Collection", items: [hashtag("Cats")] });
    t.web.serve(`${bob.uri}/following`, counted(bob, "following", 7));
    t.web.serve(`${bob.uri}/followers`, counted(bob, "followers", 9));
    t.web.fail(`${bob.uri}/outbox`, 503);
    const bobId = await followed(t, bob);
    // The read runs out of attempts with the pin pending, and gives way to it.
    for (let round = 0; round <= MAX_SYNC_ATTEMPTS + 1; round++) {
      await sql(t.store, "UPDATE collection_syncs SET due_at = ?", NOW);
      await syncCollections(t.env, deps(t));
    }
    expect(await pinned(t, bobId, null)).toEqual([note.id]);
    expect((await featuredTags(t, bobId)).map((tag) => tag.name)).toEqual(["Cats"]);
    expect(await presentedCounts(t, bobId)).toEqual([0, 7, 9]);
    expect(await rows(t, "collection_syncs")).toEqual([{ n: 0 }]);
  });

  it("shows a learned count wherever the account is presented, and keeps it as Kopje stores its statuses and follows", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    serveCounts(t, bob, 42, 7, 1_234);
    const bobId = await followed(t, bob);
    await sync(t);
    const learned = { statuses_count: 42, following_count: 7, followers_count: 1_234 };
    // Kopje's own recounts are local accounts' only: a stored status, a new local follower and bob's own Follow of
    // alice leave his counts as his server gave them.
    const note = mastodonNote(bob);
    expect(await t.post(bob, create(bob, note))).toBe(202);
    const follow = await t.request(`/api/v1/accounts/${bobId}/follow`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.tokens.dave}` },
    });
    expect(follow.status).toBe(200);
    const followOfAlice = { "@context": AS, id: `${bob.uri}#follows/${nextId()}`, type: "Follow", actor: bob.uri };
    expect(await t.post(bob, { ...followOfAlice, object: ALICE_URI })).toBe(202);
    expect(await storedCounts(t, bobId)).toEqual([42, 7, 1_234]);

    // As a status's author, and as the author of the status a boost shows.
    const [status] = await sql<{ id: string }>(t.store, "SELECT id FROM statuses WHERE uri = ?", note.id);
    const shown = await t.api<{ account: Counts }>(`/api/v1/statuses/${status!.id}`, "alice");
    expect(shown.body.account).toMatchObject(learned);
    const boost = await t.request(`/api/v1/statuses/${status!.id}/reblog`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.tokens.alice}` },
    });
    expect(boost.status).toBe(200);
    expect(((await boost.json()) as { reblog: { account: Counts } }).reblog.account).toMatchObject(learned);
    // In a notification, and in an account list.
    const notifications = await t.api<{ type: string; account: Counts }[]>("/api/v1/notifications", "alice");
    expect(notifications.body.find((n) => n.type === "follow")?.account).toMatchObject(learned);
    const following = await t.api<CountedAccount[]>(`/api/v1/accounts/${ALICE}/following`, "alice");
    expect(following.body.find((account) => account.id === bobId)).toMatchObject(learned);
    // As the account another moved to (Account#moved).
    await sql(
      t.store,
      `INSERT INTO accounts (id, uri, username, domain, moved_to_account_id)
			VALUES ('933000000000000001', 'https://moved.example/users/carol', 'carol', 'moved.example', ?)`,
      bobId,
    );
    const carol = await t.api<{ moved: Counts }>("/api/v1/accounts/933000000000000001", null);
    expect(carol.body.moved).toMatchObject(learned);
  });

  // A cutover-converted remote account has the counts the conversion leaves it (0: it recounts local ones only),
  // and learns its own the next time its document is stored.
  it("learns the counts of a converted remote account when its document is stored again", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await sql(
      t.store,
      `INSERT INTO accounts (id, uri, username, domain, raw) VALUES ('933000000000000002', ?, 'bob', ?, NULL)`,
      bob.uri,
      new URL(MASTODON).host,
    );
    serveCounts(t, bob, 42, 7, 9);
    await updated(t, bob);
    await sync(t);
    expect(await presentedCounts(t, "933000000000000002")).toEqual([42, 7, 9]);
  });
});

describe("a round’s end with counts (completeCollectionRead)", () => {
  const none = { statuses: null, following: null, followers: null };
  // A claimed round of bob's sync, ended as `accountUri`'s with these counts.
  async function ended(t: Setup, bobId: string, accountUri: string, counts: CollectionCounts) {
    await sql(t.store, "DELETE FROM collection_syncs");
    await sql(t.store, "INSERT INTO collection_syncs (account_id, due_at) VALUES (?, ?)", bobId, NOW);
    const sync = await t.store.claimCollectionSync(BUILD, { now: NOW });
    if (sync === null || sync === "more") {
      throw new Error("no sync claimed");
    }
    const { generation, token } = sync;
    const read = { parts: ALL_PARTS, pins: null, tags: null, hideCollections: null };
    await t.store.completeCollectionRead(BUILD, {
      now: NOW,
      origin: LOCAL,
      accountUri,
      generation,
      token,
      ...read,
      counts,
    });
  }

  it("stores only counts storedCount keeps, and only on the remote account the round claimed", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const bobId = await followed(t, bob);
    await sql(
      t.store,
      "UPDATE accounts SET statuses_count = 11, following_count = 22, followers_count = 33 WHERE id = ?",
      bobId,
    );
    for (const refused of [-1, 1.5, 2 ** 60, Number.NaN, Number.POSITIVE_INFINITY, "7", null]) {
      const counts = { statuses: refused, following: refused, followers: refused } as unknown as CollectionCounts;
      await ended(t, bobId, bob.uri, counts);
      expect([refused, await storedCounts(t, bobId)]).toEqual([refused, [11, 22, 33]]);
    }
    await ended(t, bobId, bob.uri, { ...none, followers: 5 });
    expect(await storedCounts(t, bobId)).toEqual([11, 22, 5]);
    await ended(t, bobId, bob.uri, { statuses: 0, following: MAX_ACCOUNT_COUNT, followers: 6 });
    expect(await storedCounts(t, bobId)).toEqual([0, MAX_ACCOUNT_COUNT, 6]);
    // A round naming a local account (alice's uri with bob's claim) ends nothing and writes no count.
    const alice = await storedCounts(t, ALICE);
    await ended(t, bobId, ALICE_URI, { statuses: 5, following: 6, followers: 7 });
    expect(await storedCounts(t, ALICE)).toEqual(alice);
    expect(await storedCounts(t, bobId)).toEqual([0, MAX_ACCOUNT_COUNT, 6]);
  });
});

// A round held at its outbox fetch (RemoteWeb.hold) while something commits, then released: what its end writes.
describe("learned counts and what commits while a round fetches", () => {
  async function heldRound(t: Setup, bob: TestActor, now = NOW) {
    const fetch = t.web.hold(`${bob.uri}/outbox`);
    // The counts as stored right after each completion of the call (the first is the held round's).
    const ends: unknown[][] = [];
    const bobId = (await sql<{ id: string }>(t.store, "SELECT id FROM accounts WHERE uri = ?", bob.uri))[0]!.id;
    const store = storeWithHook(t, "completeCollectionRead", async () => {
      ends.push(await storedCounts(t, bobId));
    });
    const round = syncCollections(t.env, { ...deps(t), now: () => now, store: () => store });
    await fetch.reached;
    return { release: fetch.release, round, ends, bobId };
  }

  it("changes neither counts nor hide_collections from a stale round’s end, and the new generation writes its own", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    // The document the held round reads hides the network (its following shows no items).
    t.web.serve(`${bob.uri}/outbox`, counted(bob, "outbox", 1));
    t.web.serve(`${bob.uri}/following`, counted(bob, "following", 7, false));
    t.web.serve(`${bob.uri}/followers`, counted(bob, "followers", 9));
    const bobId = await followed(t, bob);
    const fetch = t.web.hold(`${bob.uri}/outbox`);
    const ends: unknown[] = [];
    const store = storeWithHook(t, "completeCollectionRead", async () => {
      const [row] = await sql<{ hidden: number | null }>(
        t.store,
        "SELECT hide_collections AS hidden FROM accounts WHERE id = ?",
        bobId,
      );
      ends.push([...(await storedCounts(t, bobId)), row?.hidden]);
    });
    const round = syncCollections(t.env, { ...deps(t), store: () => store });
    await fetch.reached;
    // Bob's Update while the round fetches: a new generation, which shows the network.
    serveCounts(t, bob, 2, 8, 10);
    await updated(t, bob);
    fetch.release();
    await round;
    // The held round's end wrote neither; the call's next round read the new generation and wrote both.
    expect(ends).toEqual([
      [0, 0, 0, null],
      [2, 8, 10, 0],
    ]);
    expect(await hidden(t, bobId)).toBe(false);
    expect(await rows(t, "collection_syncs")).toEqual([{ n: 0 }]);
  });

  it("writes no count from a round whose lease ended and which another round took over, nor from its late end", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    serveCounts(t, bob, 1, 7, 9);
    const bobId = await followed(t, bob);
    const held = await heldRound(t, bob);
    // Past the lease, another round claims the sync and ends it with the counts it reads.
    serveCounts(t, bob, 2, 8, 10);
    await syncCollections(t.env, { ...deps(t), now: () => NOW + SYNC_LEASE_MS });
    expect(await storedCounts(t, bobId)).toEqual([2, 8, 10]);
    expect(await rows(t, "collection_syncs")).toEqual([{ n: 0 }]);
    // The first round's end comes after: its claim is gone, and it writes nothing.
    serveCounts(t, bob, 3, 11, 12);
    held.release();
    await held.round;
    expect(held.ends).toEqual([[2, 8, 10]]);
    expect(await storedCounts(t, bobId)).toEqual([2, 8, 10]);
  });

  it("writes no count once the account is suspended, or its domain blocked, while the round fetches", async () => {
    for (const commit of ["suspension", "domain block"] as const) {
      const t = await setup();
      const bob = await mastodonActor(t.web, "bob");
      serveCounts(t, bob, 1, 7, 9);
      const bobId = await followed(t, bob);
      const held = await heldRound(t, bob);
      if (commit === "suspension") {
        await runInDurableObject(t.store, (_instance, state) =>
          state.storage.transactionSync(() => suspendRemote(new Db(state.storage.sql), bobId, null, NOW)),
        );
      } else {
        await blockDomain(t.store, new URL(MASTODON).host);
      }
      held.release();
      await held.round;
      expect([commit, held.ends]).toEqual([commit, [[0, 0, 0]]]);
      expect([commit, await rows(t, "collection_syncs")]).toEqual([commit, [{ n: 0 }]]);
    }
  });
});

// The network part's documents under NETWORK_CAPS (RES-6): its three fit one round's fetches and bytes together.
describe("the network part within one round", () => {
  // The collections padded to `bytes` of JSON each, with their counts.
  function padded(actor: TestActor, kind: "outbox" | "following" | "followers", total: number, bytes: number) {
    const body = counted(actor, kind, total);
    const length = new TextEncoder().encode(JSON.stringify({ ...body, pad: "" })).length;
    return { ...body, pad: "x".repeat(bytes - length) };
  }

  // Whether the first round of a call read every part through (the sync is gone, or holds no pending part).
  async function firstRound(t: Setup) {
    const after: unknown[] = [];
    const store = storeWithHook(t, "completeCollectionRead", async () => {
      after.push(await syncRows(t));
    });
    await syncCollections(t.env, { ...deps(t), store: () => store });
    return after[0];
  }

  it("settles three documents past their cap in one round as unreadable, though the loader’s own cap admits each", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const bytes = 700 * 1024;
    expect(bytes).toBeGreaterThan(NETWORK_CAPS.documentBytes);
    expect(bytes).toBeLessThanOrEqual(DOCUMENT_BODY_LIMIT);
    // At the loader's own cap, the three would take more than the round's bytes: the outbox would starve.
    expect(3 * bytes).toBeGreaterThan(REQUEST_MAX_BYTES);
    t.web.serve(`${bob.uri}/outbox`, padded(bob, "outbox", 42, bytes));
    t.web.serve(`${bob.uri}/following`, padded(bob, "following", 7, bytes));
    t.web.serve(`${bob.uri}/followers`, padded(bob, "followers", 9, bytes));
    const bobId = await followed(t, bob);
    expect(await firstRound(t)).toEqual([]);
    expect(await presentedCounts(t, bobId)).toEqual([0, 0, 0]);
    // Unreadable, as a permanent failure is: the network is hidden.
    expect(await hidden(t, bobId)).toBe(true);
  });

  it("learns from documents just within the cap, and settles an outbox past it with no count", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    t.web.serve(`${bob.uri}/outbox`, padded(bob, "outbox", 42, NETWORK_CAPS.documentBytes + 1));
    t.web.serve(`${bob.uri}/following`, padded(bob, "following", 7, NETWORK_CAPS.documentBytes));
    t.web.serve(`${bob.uri}/followers`, padded(bob, "followers", 9, NETWORK_CAPS.documentBytes));
    const bobId = await followed(t, bob);
    expect(await firstRound(t)).toEqual([]);
    expect(await presentedCounts(t, bobId)).toEqual([0, 7, 9]);
    expect(await hidden(t, bobId)).toBe(false);
  });

  // RemoteLoaders capped: its memo is its own, so a document the round's ordinary loader read within its 1 MiB is
  // fetched again under NETWORK_CAPS, with the same signer and from the same round.
  it("fetches a document the featured part read again for the network part, and refuses it under the cap", async () => {
    const t = await setup();
    const shared = `${MASTODON}/users/bob/outbox`;
    const bob = await mastodonActor(t.web, "bob", { extra: { featured: shared } });
    const body = { "@context": AS, id: shared, type: "OrderedCollection", totalItems: 42, orderedItems: [] };
    const length = new TextEncoder().encode(JSON.stringify({ ...body, pad: "" })).length;
    t.web.serve(shared, { ...body, pad: "x".repeat(700 * 1024 - length) });
    t.web.serve(`${bob.uri}/following`, counted(bob, "following", 7));
    t.web.serve(`${bob.uri}/followers`, counted(bob, "followers", 9));
    const bobId = await followed(t, bob);
    const before = t.web.fetched.length;
    expect(await firstRound(t)).toEqual([]);
    const fetches = t.web.fetched
      .slice(before)
      .flatMap((url, i) => (url === shared ? [t.web.signers[before + i]] : []));
    // Read twice in the one round, signed alike: once for the featured part, once (refused) for the outbox's count.
    expect(fetches).toHaveLength(2);
    expect(fetches[1]).toBe(fetches[0]);
    expect(await presentedCounts(t, bobId)).toEqual([0, 7, 9]);
    expect(await pinned(t, bobId, null)).toEqual([]);
  });

  it("draws the network part’s fetches from the round’s one budget, after the featured part’s", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    // The featured collection redirects MAX_REDIRECTS times (six fetches), so the network part has two left.
    const featured = featuredOf(bob);
    for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
      t.web.redirect(hop === 0 ? featured : `${featured}?hop=${hop}`, `${featured}?hop=${hop + 1}`);
    }
    const last = `${featured}?hop=${MAX_REDIRECTS}`;
    t.web.serve(last, { "@context": AS, id: last, type: "OrderedCollection", orderedItems: [] });
    serveCounts(t, bob, 42, 7, 9);
    const bobId = await followed(t, bob);
    const after: unknown[] = [];
    const store = storeWithHook(t, "completeCollectionRead", async () => {
      after.push(await syncRows(t));
    });
    await syncCollections(t.env, { ...deps(t), store: () => store });
    // The first round's outbox fetch found the budget spent: the part waits, its two counts applied.
    const [first] = after[0] as { parts_read: number }[];
    expect(MAX_REDIRECTS + 1 + 2).toBe(REQUEST_MAX_FETCHES);
    expect(first!.parts_read & PART_NETWORK).toBe(0);
    await sql(t.store, "UPDATE collection_syncs SET due_at = ?", NOW);
    await sync(t);
    expect(await presentedCounts(t, bobId)).toEqual([42, 7, 9]);
  });

  it("hides the network for oversized following and followers, as unreadable, and reaches the pins in the generation", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    serveCounts(t, bob, 1, 7, 9);
    const bobId = await followed(t, bob);
    await sync(t);
    expect(await hidden(t, bobId)).toBe(false);
    // Both now past the cap, read as an ordinary refusal is (hidden); a pin Kopje does not have.
    const note = mastodonNote(bob);
    t.web.serve(note.id, { "@context": AS, ...note });
    const featured = featuredOf(bob);
    t.web.serve(featured, { "@context": AS, id: featured, type: "OrderedCollection", orderedItems: [note.id] });
    t.web.serve(`${bob.uri}/outbox`, counted(bob, "outbox", 42));
    t.web.serve(`${bob.uri}/following`, padded(bob, "following", 8, NETWORK_CAPS.documentBytes + 1));
    t.web.serve(`${bob.uri}/followers`, padded(bob, "followers", 10, NETWORK_CAPS.documentBytes + 1));
    await updated(t, bob);
    const before = t.web.fetched.length;
    // One call: its first round reads every part through, its second fetches the pin.
    const after: unknown[] = [];
    const store = storeWithHook(t, "completeCollectionRead", async () => {
      after.push(await syncRows(t));
    });
    expect(await syncCollections(t.env, { ...deps(t), store: () => store })).toBe(false);
    expect(after).toEqual([[{ parts_read: 0, generation: 1, read_through: 1 }]]);
    expect(await rows(t, "collection_syncs")).toEqual([{ n: 0 }]);
    expect(await pinned(t, bobId, null)).toEqual([note.id]);
    expect(await presentedCounts(t, bobId)).toEqual([42, 7, 9]);
    expect(await hidden(t, bobId)).toBe(true);
    const fetched = t.web.fetched.slice(before);
    for (const url of [`${bob.uri}/outbox`, `${bob.uri}/following`, `${bob.uri}/followers`, note.id]) {
      expect([url, fetched.filter((u) => u === url).length]).toEqual([url, 1]);
    }
  });

  it("follows one redirect per document: two each settle in one round as unreadable, one each are learned", async () => {
    for (const hops of [2, 1]) {
      const t = await setup();
      const bob = await mastodonActor(t.web, "bob");
      for (const [kind, total] of [
        ["outbox", 42],
        ["following", 7],
        ["followers", 9],
      ] as const) {
        const url = `${bob.uri}/${kind}`;
        for (let hop = 0; hop < hops; hop++) {
          t.web.redirect(hop === 0 ? url : `${url}?hop=${hop}`, `${url}?hop=${hop + 1}`);
        }
        t.web.serve(`${url}?hop=${hops}`, counted(bob, kind, total));
      }
      const bobId = await followed(t, bob);
      const before = t.web.fetched.length;
      expect([hops, await firstRound(t)]).toEqual([hops, []]);
      // Each document cost two requests at most: three of them fit the round's REQUEST_MAX_FETCHES.
      const network = t.web.fetched.slice(before).filter((url) => /\/(outbox|following|followers)/.test(url));
      expect([hops, network.length]).toEqual([hops, 3 * 2]);
      expect([hops, await presentedCounts(t, bobId)]).toEqual([hops, hops === 1 ? [42, 7, 9] : [0, 0, 0]]);
      expect([hops, await hidden(t, bobId)]).toEqual([hops, hops === 2]);
    }
  });
});

// RES-6: the most HTTP requests one generation of a sync makes, computed from the constants. Every read claim reads
// every unread part with each document redirected as far as its loader allows, cut by the round's REQUEST_MAX_FETCHES;
// a part is read through at the last of its MAX_SYNC_ATTEMPTS claims; then MAX_REMOTE_PINS pending statuses are
// fetched one per MAX_SYNC_ATTEMPTS claims, each round its whole budget. A call (COLLECTION_SYNCS_PER_ROUND claims)
// may run two rounds of one generation.
describe("the requests of one generation", () => {
  function worstCase(network: { documents: number; redirects: number }) {
    const parts = [
      PART_DOCUMENTS.featured * (1 + MAX_REDIRECTS),
      network.documents * (1 + network.redirects),
      PART_DOCUMENTS.tags * (1 + MAX_REDIRECTS),
    ];
    const readClaims = parts.length * MAX_SYNC_ATTEMPTS;
    const readRound = Math.min(
      REQUEST_MAX_FETCHES,
      parts.reduce((sum, n) => sum + n, 0),
    );
    const pinClaims = MAX_REMOTE_PINS * MAX_SYNC_ATTEMPTS;
    return {
      networkPerRound: Math.min(REQUEST_MAX_FETCHES, parts[1]!),
      networkPerGeneration: readClaims * Math.min(REQUEST_MAX_FETCHES, parts[1]!),
      networkHealthy: network.documents,
      perCall: COLLECTION_SYNCS_PER_ROUND * REQUEST_MAX_FETCHES,
      perGeneration: readClaims * readRound + pinClaims * REQUEST_MAX_FETCHES,
    };
  }

  it("bounds them before and after the network part reads the outbox", () => {
    const before = worstCase({ documents: 2, redirects: MAX_REDIRECTS });
    const after = worstCase({ documents: PART_DOCUMENTS.network, redirects: NETWORK_CAPS.maxRedirects });
    console.info(`Requests of one generation: before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`);
    expect({ before, after }).toEqual({
      before: { networkPerRound: 8, networkPerGeneration: 72, networkHealthy: 2, perCall: 16, perGeneration: 552 },
      after: { networkPerRound: 6, networkPerGeneration: 54, networkHealthy: 3, perCall: 16, perGeneration: 552 },
    });
  });
});
