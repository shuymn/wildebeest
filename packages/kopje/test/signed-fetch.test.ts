import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { FetchSigner } from "../src/domain/actors";
import {
  createKopjeFederation,
  createRemoteLoaders,
  type FederationState,
  instanceActorKey,
} from "../src/federation/federation";
import { DoKvStore } from "../src/federation/kv-store";
import { RefusedFetchError, requestBudget, TransientFetchError } from "../src/federation/loader";
import type { StoreStub } from "../src/platform/store-client";
import { countingStore, NOW } from "./app-helpers";
import {
  fixtureKeyGen,
  LEGACY,
  LEGACY_EMPTY_KEK,
  seedFollow,
  seedLocalAccount,
  seedRemoteAccount,
  setDomain,
  verifyCavage,
} from "./federation-helpers";
import { BUILD, migratedStore } from "./helpers";
import { RemoteWeb } from "./inbox-helpers";

const DOMAIN = "social.example";
const NOTE = "https://remote.example/notes/1";

async function setup(contentType = "application/activity+json") {
  const store = await migratedStore();
  await setDomain(store, DOMAIN);
  await seedLocalAccount(store, DOMAIN, { id: "111111111111111111", username: "Alice" });
  const requests: Request[] = [];
  const fetch = ((input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(input);
    requests.push(request);
    return Promise.resolve(Response.json({ id: NOTE, type: "Note" }, { headers: { "content-type": contentType } }));
  }) as typeof globalThis.fetch;
  const state: FederationState = { resolvedUsername: null, source: null, storeError: null, ticket: null };
  const federation = createKopjeFederation(
    {
      domain: DOMAIN,
      build: BUILD,
      store: () => store,
      kek: LEGACY.kek,
      now: () => NOW,
      keygen: fixtureKeyGen,
      loader: { fetch, checkHost: () => Promise.resolve() },
    },
    state,
  );
  const ctx = federation.createContext(new URL(`https://${DOMAIN}`), state);
  return { store, requests, ctx };
}

describe("signed fetches", () => {
  it("signs fetches without a specific recipient as the instance actor", async () => {
    const { requests, ctx } = await setup();
    await ctx.documentLoader(NOTE);

    const signature = requests[0]?.headers.get("signature") ?? "";
    expect(signature).toContain('keyId="https://social.example/actor#main-key"');
    expect(await verifyCavage(requests[0] as Request, LEGACY_EMPTY_KEK.pubkey)).toBe(true);
  });

  it("signs a recipient's fetches with the recipient's key", async () => {
    const { requests, ctx } = await setup();
    const loader = await ctx.getDocumentLoader({ identifier: "Alice" });
    await loader(NOTE);

    expect(requests[0]?.headers.get("signature")).toContain('keyId="https://social.example/ap/users/Alice#main-key"');
    expect(await verifyCavage(requests[0] as Request, LEGACY.pubkey)).toBe(true);
  });

  it("caches signed documents per signing key, apart from each other and from unsigned ones", async () => {
    const { store, requests, ctx } = await setup();
    const alice = await ctx.getDocumentLoader({ identifier: "Alice" });
    await alice(NOTE);
    await alice(NOTE);
    expect(requests).toHaveLength(1);
    await ctx.documentLoader(NOTE);
    expect(requests).toHaveLength(2);

    const keys = await runInDurableObject(store, (_instance, state) =>
      state.storage.sql
        .exec<{ key: string }>('SELECT key FROM fedify_kv WHERE key LIKE \'["_fedify","signedRemoteDocument"%\'')
        .toArray()
        .map((row) => JSON.parse(row.key) as string[]),
    );
    expect(keys).toEqual(
      expect.arrayContaining([
        ["_fedify", "signedRemoteDocument", "v2", "https://social.example/actor#main-key", NOTE],
        ["_fedify", "signedRemoteDocument", "v2", "https://social.example/ap/users/Alice#main-key", NOTE],
      ]),
    );
  });

  it("has key pairs for local actors and the instance actor only", async () => {
    const { ctx } = await setup();
    expect((await ctx.getActorKeyPairs("Alice")).map((pair) => pair.keyId.href)).toEqual([
      "https://social.example/ap/users/Alice#main-key",
    ]);
    expect((await ctx.getActorKeyPairs("kopje:instance")).map((pair) => pair.keyId.href)).toEqual([
      "https://social.example/actor#main-key",
    ]);
    expect(await ctx.getActorKeyPairs("nobody")).toEqual([]);
  });

  it("has no key pairs for a spelling other than the stored username", async () => {
    const { ctx } = await setup();
    expect(await ctx.getActorKeyPairs("alice")).toEqual([]);
    expect(await ctx.getActorKeyPairs("ALICE")).toEqual([]);
  });

  // Plain JSON-LD is a context, never an object (GHSA-jhrq-qvrm-qr36): only the context loader takes it.
  it("takes plain JSON-LD on the context loader only", async () => {
    const { ctx } = await setup("application/ld+json");
    await expect(ctx.documentLoader(NOTE)).rejects.toThrow(/Not an ActivityPub document/);
    const alice = await ctx.getDocumentLoader({ identifier: "Alice" });
    await expect(alice(NOTE)).rejects.toThrow(/Not an ActivityPub document/);
    expect((await ctx.contextLoader(NOTE)).document).toMatchObject({ id: NOTE });
  });

  // A cache entry admitted under an older, looser acceptance policy is never served after the policy is tightened.
  it("ignores signed documents cached under the unversioned namespace", async () => {
    const { store, requests, ctx } = await setup();
    const stale = { contextUrl: null, documentUrl: NOTE, document: { id: NOTE, type: "Note", content: "stale" } };
    const kv = new DoKvStore(
      () => store,
      BUILD,
      () => NOW,
    );
    await kv.set(["_fedify", "signedRemoteDocument", "https://social.example/actor#main-key", NOTE], stale);

    expect((await ctx.documentLoader(NOTE)).document).toEqual({ id: NOTE, type: "Note" });
    expect(requests).toHaveLength(1);
  });
});

const ALICE = "111111111111111111";
const ALICE_KEY = "https://social.example/ap/users/Alice#main-key";
const INSTANCE_KEY = "https://social.example/actor#main-key";
const REMOTE = "https://remote.example";
const note = (n: number, origin = REMOTE) => `${origin}/notes/${n}`;

const storeInstanceKey = (store: StoreStub) =>
  instanceActorKey((call) => call(store), BUILD, LEGACY.kek, fixtureKeyGen);

// DATA-7's rule in its one place (domain/actors.ts fetchSignerOf), through the Store's read: the designated local key
// while it may sign, else the instance key, null before the instance key's first use. Keys stay wrapped (DATA-1).
describe("the signer of a fetch (DATA-7)", () => {
  async function store(options: { instanceKey?: boolean } = {}) {
    const s = await migratedStore();
    await setDomain(s, DOMAIN);
    await seedLocalAccount(s, DOMAIN, { id: ALICE, username: "Alice" });
    await seedRemoteAccount(s, "333333333333333333", `${REMOTE}/users/bob`, "remote.example");
    const instance = options.instanceKey === false ? null : await storeInstanceKey(s);
    return { s, instance };
  }
  const alice = { username: "Alice", key: { privkey: LEGACY.privkey, salt: LEGACY.salt, pubkey: LEGACY.pubkey } };
  const follower = { follower: ALICE, of: "333333333333333333" };

  it("chooses an available recipient by its exact username, else the instance actor", async () => {
    const { s, instance } = await store();
    expect(await s.fetchSigner(BUILD, { by: "Alice" })).toEqual(alice);
    expect(await s.fetchSigner(BUILD, { by: "alice" })).toEqual({ username: null, key: instance });
    expect(await s.fetchSigner(BUILD, { by: null })).toEqual({ username: null, key: instance });
    await runInDurableObject(s, (_instance, state) => {
      state.storage.sql.exec("UPDATE local_accounts SET suspended_at = '2026-10-01T00:00:00.000Z'");
    });
    expect(await s.fetchSigner(BUILD, { by: "Alice" })).toEqual({ username: null, key: instance });
  });

  it("chooses a follower while it follows, else the instance actor", async () => {
    const { s, instance } = await store();
    expect(await s.fetchSigner(BUILD, { by: follower })).toEqual({ username: null, key: instance });
    await seedFollow(s, ALICE, "333333333333333333");
    expect(await s.fetchSigner(BUILD, { by: follower })).toEqual(alice);
  });

  it("hands over no instance key before its first use", async () => {
    const { s } = await store({ instanceKey: false });
    expect(await s.fetchSigner(BUILD, { by: null })).toEqual({ username: null, key: null });
    expect(await s.fetchSigner(BUILD, { by: "Alice" })).toEqual(alice);
  });
});

// The loaders' side of a fetch preparation (federation.ts): a ticket answers the next policy check alone, and only for
// its host (VIS-30); a prepared or offered signer saves the signer read, and is unwrapped on the first fetch (DATA-1).
describe("fetch preparations in the loaders", () => {
  async function loaders(options: { instanceKey?: boolean } = {}) {
    const store = await migratedStore();
    await setDomain(store, DOMAIN);
    await seedLocalAccount(store, DOMAIN, { id: ALICE, username: "Alice" });
    if (options.instanceKey !== false) {
      await storeInstanceKey(store);
    }
    const web = new RemoteWeb();
    for (const url of [note(1), note(2), note(3), note(1, "https://other.example")]) {
      web.serve(url, { id: url, type: "Note" });
    }
    const { stub, calls, records } = countingStore(store);
    const state: FederationState = { resolvedUsername: null, source: null, storeError: null, ticket: null };
    const deps = {
      domain: DOMAIN,
      build: BUILD,
      store: () => stub,
      kek: LEGACY.kek,
      now: () => NOW,
      keygen: fixtureKeyGen,
      loader: web.loader,
    };
    const create = (by: string | null = null, prepared: FetchSigner | null = null, timeoutMs?: number) =>
      createRemoteLoaders(
        timeoutMs === undefined ? deps : { ...deps, loader: { ...deps.loader, timeoutMs } },
        state,
        by,
        requestBudget(Date.now()),
        prepared,
      );
    const signerOf = (url: string) => web.signers[web.fetched.indexOf(url)];
    const asked = () =>
      records.filter((r) => r.name === "fetchRefused").map((r) => (r.args[1] as { host: string }).host);
    return { store, web, calls, state, create, signerOf, asked };
  }

  it("answers the next request to its host with the ticket, once", async () => {
    const { store, calls, state, create } = await loaders();
    const l = create(null, await store.fetchSigner(BUILD, { by: null }));
    state.ticket = { host: "remote.example", refused: false };
    await l.document(note(1));
    expect(calls).toEqual([]);
    expect(state.ticket).toBeNull();
    await l.document(note(2));
    expect(calls).toEqual(["fetchRefused"]);
  });

  it("refuses with a refused ticket, asking the Store nothing and requesting nothing", async () => {
    const { store, web, calls, state, create } = await loaders();
    const l = create(null, await store.fetchSigner(BUILD, { by: null }));
    state.ticket = { host: "remote.example", refused: true };
    await expect(l.document(note(1))).rejects.toBeInstanceOf(RefusedFetchError);
    expect(calls).toEqual([]);
    expect(web.fetched).toEqual([]);
  });

  it("spends the ticket on the next check whatever its host, so both requests then ask the Store", async () => {
    const { store, state, create, asked } = await loaders();
    const l = create(null, await store.fetchSigner(BUILD, { by: null }));
    state.ticket = { host: "remote.example", refused: false };
    await l.document(note(1, "https://other.example"));
    expect(state.ticket).toBeNull();
    await l.document(note(1));
    expect(asked()).toEqual(["other.example", "remote.example"]);
  });

  it("lets one of two concurrent requests to its host take the ticket; the other asks the Store", async () => {
    const { store, web, state, create, asked } = await loaders();
    const l = create(null, await store.fetchSigner(BUILD, { by: null }));
    state.ticket = { host: "remote.example", refused: false };
    // Both start before either reaches the remote, where each waits once past its policy check.
    const held = [web.hold(note(1)), web.hold(note(2))];
    const loads = [l.document(note(1)), l.document(note(2))];
    await Promise.all(held.map((h) => h.reached));
    expect(asked()).toEqual(["remote.example"]);
    expect(state.ticket).toBeNull();
    held.forEach((h) => h.release());
    await Promise.all(loads);
    expect(asked()).toEqual(["remote.example"]);
  });

  // The held fetch never answers, so the first loaders' timeout is what ends the first load; it leaves that load room
  // to reach the remote on a loaded runner. The later load, on loaders sharing the state, keeps the default timeout so
  // that only the held load can time out.
  it("leaves nothing for a later request when the load that took the ticket times out", async () => {
    const { store, web, state, create, asked } = await loaders();
    const signer = await store.fetchSigner(BUILD, { by: null });
    state.ticket = { host: "remote.example", refused: false };
    const held = web.hold(note(1));
    await expect(create(null, signer, 1000).document(note(1))).rejects.toBeInstanceOf(TransientFetchError);
    await held.reached;
    expect(asked()).toEqual([]);
    await create(null, signer).document(note(2));
    expect(asked()).toEqual(["remote.example"]);
    held.release();
  });

  it("signs with a prepared signer, reading none", async () => {
    const { store, calls, create, signerOf } = await loaders();
    const l = create("Alice", await store.fetchSigner(BUILD, { by: "Alice" }));
    await l.document(note(1));
    expect(calls).toEqual(["fetchRefused"]);
    expect(signerOf(note(1))).toBe(ALICE_KEY);
  });

  it("reads the signer once, on the first fetch, when none was prepared", async () => {
    const { calls, create, signerOf } = await loaders();
    const l = create("Alice");
    expect(calls).toEqual([]);
    await l.document(note(1));
    await l.document(note(2));
    expect(calls).toEqual(["fetchSigner", "fetchRefused", "fetchRefused"]);
    expect([signerOf(note(1)), signerOf(note(2))]).toEqual([ALICE_KEY, ALICE_KEY]);
  });

  // Offered signers here name another account than the loaders' designation only to tell them apart: a need offers
  // the signer the Store chose for the same designation.
  it("takes a signer offered while none is resolved, and keeps the resolved one after", async () => {
    const { store, calls, create, signerOf } = await loaders();
    const l = create(null);
    l.offerSigner(await store.fetchSigner(BUILD, { by: "Alice" }));
    await l.document(note(1));
    l.offerSigner(await store.fetchSigner(BUILD, { by: null }));
    await l.document(note(2));
    expect(calls.filter((name) => name === "fetchSigner")).toEqual([]);
    expect([signerOf(note(1)), signerOf(note(2))]).toEqual([ALICE_KEY, ALICE_KEY]);
  });

  it("creates the instance key on its first use when the chosen signer has none", async () => {
    const { calls, create, signerOf } = await loaders({ instanceKey: false });
    await create(null).document(note(1));
    expect(calls).toEqual(["fetchSigner", "ensureInstanceActorKey", "fetchRefused"]);
    expect(signerOf(note(1))).toBe(INSTANCE_KEY);
  });
});
