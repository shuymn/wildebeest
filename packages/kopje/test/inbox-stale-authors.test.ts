import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { ACCOUNT_STALE_MS } from "../src/domain/inbox";
import { suspendRemote } from "../src/domain/remote-suspension";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { blockDomain } from "./domain-block-helpers";
import { mastodonActor, type TestActor } from "./inbox-helpers";
import { announce, AS, create, localStatus, mastodonNote, OTHER, type Setup, statuses } from "./inbox-status-helpers";
import { quoting } from "./quote-helpers";
import { ageAccount, staleAuthorWorld } from "./stale-author-helpers";

// The author of a boosted original Kopje fetches (VIS-6, NET-4), refetched first when its stored document is a day
// old (ACCOUNT_STALE_MS, Mastodon's possibly_stale?): what each outcome of that refetch stores, and the outcomes that
// commit after another request's. Authors are aged through accounts.fetched_at, so the clock and the sender's key stay
// fresh and t.web.fetched holds only the fetches under test.

const iso = (at: number) => new Date(at).toISOString();
const avatar = (actor: TestActor, n: number) => `${OTHER}/system/avatars/${actor.uri.split("/").at(-1)}-${n}.png`;

type AuthorRow = { avatar_url: string | null; fetched_at: string | null; domain: string; username: string };
const author = async (t: Setup, uri: string) =>
  (
    await sql<AuthorRow>(t.store, "SELECT avatar_url, fetched_at, domain, username FROM accounts WHERE uri = ?", uri)
  )[0]!;
const keys = (t: Setup, uri: string) =>
  sql<{ pem: string; fetched_at: number }>(
    t.store,
    "SELECT k.pem, k.fetched_at FROM remote_keys k JOIN accounts a ON a.id = k.account_id WHERE a.uri = ?",
    uri,
  );

// erin's document served again with avatar `n` (and the given key).
function reserve(t: Setup, erin: TestActor, n: number, options: { key?: number } = {}) {
  return mastodonActor(t.web, "erin", {
    origin: OTHER,
    key: options.key ?? 3,
    extra: { icon: { type: "Image", mediaType: "image/png", url: avatar(erin, n) } },
  });
}

function served(t: Setup, actor: TestActor, extra: Record<string, unknown> = {}) {
  const note = mastodonNote(actor, extra);
  t.web.serve(note.id, { "@context": AS, ...note });
  return note;
}

// Whether the original `uri` is stored and wrapped by a boost row (reblog_of_id naming it).
const boosted = async (t: Setup, uri: string) =>
  (
    await sql<{ n: number }>(
      t.store,
      `SELECT count(*) AS n FROM statuses b JOIN statuses o ON o.id = b.reblog_of_id
			WHERE o.uri = ? AND o.reblog_of_id IS NULL`,
      uri,
    )
  )[0]!.n === 1;
// Whether a status of `uri` is stored at all.
const stored = async (t: Setup, uri: string) => (await statuses(t.store)).some((s) => s.uri === uri);

describe("a stale author of a fetched original (VIS-6, NET-4; Mastodon possibly_stale?)", () => {
  it("refetches a stored author whose document is a day old before storing a boosted original", async () => {
    const { t, bob, erin } = await staleAuthorWorld();
    await reserve(t, erin, 2);
    const note2 = served(t, erin);
    expect(await t.post(bob, announce(bob, note2.id))).toBe(202);
    expect(t.web.fetched).toEqual([note2.id, erin.uri]);
    expect(await author(t, erin.uri)).toMatchObject({ avatar_url: avatar(erin, 2), fetched_at: iso(NOW) });
    const home =
      await t.api<{ reblog: { uri: string; account: { avatar: string } } | null }[]>("/api/v1/timelines/home");
    expect(home.body.find((s) => s.reblog?.uri === note2.id)?.reblog?.account.avatar).toBe(avatar(erin, 2));
  });

  it("uses an author fetched less than a day ago as it is", async () => {
    const { t, bob, erin } = await staleAuthorWorld();
    await ageAccount(t, erin.uri, iso(NOW - ACCOUNT_STALE_MS + 1));
    await reserve(t, erin, 2);
    const note2 = served(t, erin);
    expect(await t.post(bob, announce(bob, note2.id))).toBe(202);
    expect(t.web.fetched).toEqual([note2.id]);
    expect(await boosted(t, note2.id)).toBe(true);
    expect((await author(t, erin.uri)).avatar_url).not.toBe(avatar(erin, 2));
  });

  it.each([
    ["no fetched_at", null],
    ["an unreadable fetched_at", "now"],
  ])("an author with %s is stale", async (_name, fetchedAt) => {
    const { t, bob, erin } = await staleAuthorWorld();
    await ageAccount(t, erin.uri, fetchedAt);
    await reserve(t, erin, 2);
    const note2 = served(t, erin);
    expect(await t.post(bob, announce(bob, note2.id))).toBe(202);
    expect(t.web.fetched).toEqual([note2.id, erin.uri]);
    expect(await author(t, erin.uri)).toMatchObject({ avatar_url: avatar(erin, 2), fetched_at: iso(NOW) });
  });

  it.each([404, 410])(
    "a refresh answering %i stores neither the original nor the boost, and leaves fetched_at unchanged",
    async (status) => {
      const { t, bob, erin } = await staleAuthorWorld();
      const before = await statuses(t.store);
      t.web.fail(erin.uri, status);
      const note2 = served(t, erin);
      expect(await t.post(bob, announce(bob, note2.id))).toBe(202);
      expect(t.web.fetched).toEqual([note2.id, erin.uri]);
      expect(await statuses(t.store)).toEqual(before);
      expect((await author(t, erin.uri)).fetched_at).toBe(iso(NOW - ACCOUNT_STALE_MS));
      // Nothing marks the failure: a later boost refetches her.
      await reserve(t, erin, 2);
      const note3 = served(t, erin);
      expect(await t.post(bob, announce(bob, note3.id))).toBe(202);
      expect(t.web.fetched.slice(2)).toEqual([note3.id, erin.uri]);
      expect(await boosted(t, note3.id)).toBe(true);
    },
  );

  it.each([
    ["unusable", (t: Setup, erin: TestActor) => t.web.serve(erin.uri, { ...erin.document, id: `${erin.uri}/other` })],
    ["a 500", (t: Setup, erin: TestActor) => t.web.fail(erin.uri, 500)],
    ["a 429", (t: Setup, erin: TestActor) => t.web.fail(erin.uri, 429)],
    ["a network failure", (t: Setup, erin: TestActor) => t.web.fail(erin.uri, 0)],
  ])(
    "a refresh that is %s stores the boost under the stored profile, stamps fetched_at only, and waits a day",
    async (_name, failure) => {
      const { t, bob, erin } = await staleAuthorWorld();
      const profile = await author(t, erin.uri);
      await sql(t.store, "UPDATE remote_keys SET fetched_at = ?", NOW - 1000);
      const stored = await keys(t, erin.uri);
      failure(t, erin);
      const note2 = served(t, erin);
      expect(await t.post(bob, announce(bob, note2.id))).toBe(202);
      expect(t.web.fetched).toEqual([note2.id, erin.uri]);
      expect(await boosted(t, note2.id)).toBe(true);
      expect(await author(t, erin.uri)).toEqual({ ...profile, fetched_at: iso(NOW) });
      // Key trust is not extended by the stamp (ID-1).
      expect(await keys(t, erin.uri)).toEqual(stored);
      // Not tried again for a day.
      const note3 = served(t, erin);
      expect(await t.post(bob, announce(bob, note3.id))).toBe(202);
      expect(t.web.fetched.slice(2)).toEqual([note3.id]);
      expect(await boosted(t, note3.id)).toBe(true);
    },
  );

  it("an unknown author whose fetch is transient still answers 503", async () => {
    const { t, bob } = await staleAuthorWorld();
    const frank = await mastodonActor(t.web, "frank", { origin: OTHER, key: 4 });
    t.web.fail(frank.uri, 500);
    const before = await statuses(t.store);
    const note = served(t, frank);
    expect(await t.post(bob, announce(bob, note.id))).toBe(503);
    expect(await statuses(t.store)).toEqual(before);
    expect(await sql(t.store, "SELECT 1 AS x FROM accounts WHERE uri = ?", frank.uri)).toEqual([]);
  });

  it("never refetches a suspended stale author (R38)", async () => {
    const { t, bob, erin } = await staleAuthorWorld();
    await suspend(t, erin.uri);
    const before = await statuses(t.store);
    const note2 = served(t, erin);
    expect(await t.post(bob, announce(bob, note2.id))).toBe(202);
    expect(t.web.fetched).toEqual([note2.id]);
    expect(await statuses(t.store)).toEqual(before);
  });

  type Change = [string, (t: Setup, erin: TestActor) => Promise<unknown>];
  const changes: Change[] = [
    ["a suspension", (t, erin) => suspend(t, erin.uri)],
    ["a domain block", (t) => blockDomain(t.store, new URL(OTHER).host)],
    [
      "the author's deletion",
      async (t, erin) => {
        t.web.fail(erin.uri, 410);
        const deletion = {
          "@context": AS,
          id: `${erin.uri}#delete`,
          type: "Delete",
          actor: erin.uri,
          object: erin.uri,
        };
        expect(await t.post(erin, deletion)).toBe(202);
      },
    ],
  ];
  describe.each(changes)("%s committed during the refresh", (_name, change) => {
    it.each([
      ["ok", (t: Setup, erin: TestActor) => reserve(t, erin, 2)],
      ["500", (t: Setup, erin: TestActor) => Promise.resolve(t.web.fail(erin.uri, 500))],
    ])("stores no status and stamps nothing for an outcome %s", async (_outcome, outcome) => {
      const { t, bob, erin } = await staleAuthorWorld();
      const profile = await author(t, erin.uri);
      const before = await statuses(t.store);
      await outcome(t, erin);
      const refresh = t.web.hold(erin.uri, { snapshot: true });
      const note2 = served(t, erin);
      const response = t.post(bob, announce(bob, note2.id));
      await refresh.reached;
      await change(t, erin);
      refresh.release();
      expect(await response).toBe(202);
      // Nothing is added (a deletion also starts removing erin's statuses and row).
      const after = await statuses(t.store);
      expect(after.filter((s) => !before.some((b) => b.uri === s.uri))).toEqual([]);
      const row = await sql<AuthorRow>(
        t.store,
        "SELECT avatar_url, fetched_at, domain, username FROM accounts WHERE uri = ?",
        erin.uri,
      );
      expect(row.length === 0 ? profile : row[0]).toEqual(profile);
    });
  });

  it("a self-boost of a fetched private status by a sender with a stale row reads the refreshed followers URI", async () => {
    const { t, bob } = await staleAuthorWorld();
    const followers = `${bob.uri}/followers2`;
    await ageAccount(t, bob.uri, iso(NOW - ACCOUNT_STALE_MS));
    await mastodonActor(t.web, "bob", { extra: { followers } });
    const own = served(t, bob, { to: [followers], cc: [] });
    t.web.fetched.length = 0;
    expect(await t.post(bob, announce(bob, own.id, { to: [followers], cc: [] }))).toBe(202);
    expect(t.web.fetched).toEqual([own.id, bob.uri]);
    const rows = await statuses(t.store);
    expect(rows.find((s) => s.uri === own.id)?.visibility).toBe("private");
  });

  it("a refresh keeps the confirmed domain while the username is unchanged and falls back to the host when it changes", async () => {
    const { t, bob, erin } = await staleAuthorWorld();
    await sql(
      t.store,
      "UPDATE accounts SET domain = 'erin.example', confirmed_username = 'erin' WHERE uri = ?",
      erin.uri,
    );
    const note2 = served(t, erin);
    expect(await t.post(bob, announce(bob, note2.id))).toBe(202);
    expect(await author(t, erin.uri)).toMatchObject({ domain: "erin.example", username: "erin", fetched_at: iso(NOW) });
    await ageAccount(t, erin.uri, iso(NOW - ACCOUNT_STALE_MS));
    await mastodonActor(t.web, "erin", { origin: OTHER, key: 3, extra: { preferredUsername: "erin2" } });
    const note3 = served(t, erin);
    expect(await t.post(bob, announce(bob, note3.id))).toBe(202);
    expect(await author(t, erin.uri)).toMatchObject({ domain: "other.example", username: "erin2" });
  });

  it("VIS-6: a private original by a stale author stores no status or boost; the author is refreshed", async () => {
    const { t, bob, erin } = await staleAuthorWorld();
    const before = await statuses(t.store);
    await reserve(t, erin, 2);
    const note2 = served(t, erin, { to: [`${erin.uri}/followers`], cc: [] });
    expect(await t.post(bob, announce(bob, note2.id))).toBe(202);
    expect(t.web.fetched).toEqual([note2.id, erin.uri]);
    expect(await statuses(t.store)).toEqual(before);
    expect(await author(t, erin.uri)).toMatchObject({ avatar_url: avatar(erin, 2), fetched_at: iso(NOW) });
  });
});

async function suspend(t: Setup, uri: string): Promise<void> {
  const id = (await sql<{ id: string }>(t.store, "SELECT id FROM accounts WHERE uri = ?", uri))[0]!.id;
  await runInDurableObject(t.store, (_instance, state) =>
    state.storage.transactionSync(() => suspendRemote(new Db(state.storage.sql), id, null, NOW)),
  );
}

describe("refreshes of one stale author by two requests (hold)", () => {
  // A's boost reaches its refetch of erin and is held there; B's boost of another note by erin runs meanwhile, at a
  // later clock; A is answered after B committed, at a later clock still.
  async function race(
    between: (t: Setup, erin: TestActor) => Promise<unknown>,
    options: { snapshot?: boolean; beforeB?: (t: Setup, erin: TestActor) => unknown } = {},
  ) {
    const { t, bob, erin, clock } = await staleAuthorWorld();
    const noteA = served(t, erin);
    const noteB = served(t, erin);
    const held = t.web.hold(erin.uri, { snapshot: options.snapshot === true });
    const a = t.post(bob, announce(bob, noteA.id));
    await held.reached;
    await options.beforeB?.(t, erin);
    clock.now = NOW + 1;
    expect(await t.post(bob, announce(bob, noteB.id))).toBe(202);
    await between(t, erin);
    clock.now = NOW + 2;
    held.release();
    expect(await a).toBe(202);
    return { t, erin, noteA, noteB };
  }

  it("a delayed old document never replaces a refresh another request committed", async () => {
    let erin2: TestActor | undefined;
    const { t, erin, noteA, noteB } = await race(() => Promise.resolve(), {
      snapshot: true,
      beforeB: async (t, erin) => {
        erin2 = await reserve(t, erin, 2, { key: 4 });
      },
    });
    expect(await author(t, erin.uri)).toMatchObject({ avatar_url: avatar(erin, 2), fetched_at: iso(NOW + 1) });
    expect((await keys(t, erin.uri)).map((k) => k.pem)).toEqual([erin2!.pem]);
    expect(await boosted(t, noteA.id)).toBe(true);
    expect(await boosted(t, noteB.id)).toBe(true);
  });

  it.each([
    ["a failure", 500, "stamps nothing"],
    ["a 404", 404, "refuses nothing: the status is stored under the refreshed row"],
  ])("%s that commits after a successful refresh %s", async (_name, status) => {
    const { t, erin, noteA } = await race((t, erin) => Promise.resolve(t.web.fail(erin.uri, status)), {
      beforeB: (t, erin) => reserve(t, erin, 2),
    });
    expect(await author(t, erin.uri)).toMatchObject({ avatar_url: avatar(erin, 2), fetched_at: iso(NOW + 1) });
    expect(await boosted(t, noteA.id)).toBe(true);
  });

  // A's outcome after B's failure stamp: discarded, both statuses stored under the stored row. For a 404 this is a
  // documented limitation (docs/mastodon-deviations.md, Accounts): it finds the row stamped and is not applied.
  it.each([
    [
      "a 404 that commits after a failure stamp is not applied",
      (t: Setup, erin: TestActor) => t.web.fail(erin.uri, 404),
    ],
    ["a success that commits after a failure stamp is discarded", (t: Setup, erin: TestActor) => reserve(t, erin, 2)],
  ])("%s: both statuses under the stored row", async (_name, outcomeA) => {
    let profile: AuthorRow | undefined;
    const { t, erin, noteA, noteB } = await race((t, erin) => Promise.resolve(outcomeA(t, erin)), {
      beforeB: async (t, erin) => {
        profile = await author(t, erin.uri);
        t.web.fail(erin.uri, 500);
      },
    });
    expect(await author(t, erin.uri)).toEqual({ ...profile!, fetched_at: iso(NOW + 1) });
    expect(await boosted(t, noteA.id)).toBe(true);
    expect(await boosted(t, noteB.id)).toBe(true);
  });

  // After B's 404, which writes nothing and refuses B's status, A's outcome still applies.
  it("a success that commits after a 404 applies: only the later status is stored, under the refreshed row", async () => {
    const { t, erin, noteA, noteB } = await race((t, erin) => reserve(t, erin, 2), {
      beforeB: (t, erin) => t.web.fail(erin.uri, 404),
    });
    expect(await author(t, erin.uri)).toMatchObject({ avatar_url: avatar(erin, 2), fetched_at: iso(NOW + 2) });
    expect(await boosted(t, noteA.id)).toBe(true);
    expect(await boosted(t, noteB.id)).toBe(false);
    expect(await stored(t, noteB.id)).toBe(false);
  });

  it("a failure that commits after a 404 stamps: only the later status is stored, under the stored row", async () => {
    let profile: AuthorRow | undefined;
    const { t, erin, noteA, noteB } = await race((t, erin) => Promise.resolve(t.web.fail(erin.uri, 500)), {
      beforeB: async (t, erin) => {
        profile = await author(t, erin.uri);
        t.web.fail(erin.uri, 404);
      },
    });
    expect(await author(t, erin.uri)).toEqual({ ...profile!, fetched_at: iso(NOW + 2) });
    expect(await boosted(t, noteA.id)).toBe(true);
    expect(await boosted(t, noteB.id)).toBe(false);
    expect(await stored(t, noteB.id)).toBe(false);
  });

  it("two 404s store neither status and stamp nothing", async () => {
    let profile: AuthorRow | undefined;
    const { t, erin, noteA, noteB } = await race(() => Promise.resolve(), {
      beforeB: async (t, erin) => {
        profile = await author(t, erin.uri);
        t.web.fail(erin.uri, 404);
      },
    });
    expect(await author(t, erin.uri)).toEqual(profile);
    expect(await boosted(t, noteA.id)).toBe(false);
    expect(await boosted(t, noteB.id)).toBe(false);
    expect(await stored(t, noteA.id)).toBe(false);
    expect(await stored(t, noteB.id)).toBe(false);
  });
});

describe("statuses stored under their sender (Create, Add, QuoteRequest: no change)", () => {
  it("a Create, an Add pin and a QuoteRequest instrument of a sender with a stale row and a fresh key fetch no actor", async () => {
    const { t, bob } = await staleAuthorWorld();
    await ageAccount(t, bob.uri, iso(NOW - ACCOUNT_STALE_MS));
    const note = mastodonNote(bob);
    expect(await t.post(bob, create(bob, note))).toBe(202);
    const pinned = served(t, bob);
    const add = {
      "@context": AS,
      id: `${bob.uri}#add-${pinned.id.split("/").at(-1)}`,
      type: "Add",
      actor: bob.uri,
      target: `${bob.uri}/collections/featured`,
      object: pinned.id,
    };
    expect(await t.post(bob, add)).toBe(202);
    const mine = await localStatus(t, { status: "quote me", visibility: "public" });
    const quote = quoting(bob, mine.uri, null);
    t.web.serve(quote.id, { "@context": AS, ...quote });
    const request = {
      "@context": [AS, { QuoteRequest: "https://w3id.org/fep/044f#QuoteRequest" }],
      id: `${bob.uri}/quote_requests/${quote.id.split("/").at(-1)}`,
      type: "QuoteRequest",
      actor: bob.uri,
      object: mine.uri,
      instrument: quote.id,
    };
    expect(await t.post(bob, request)).toBe(202);
    expect(t.web.fetched).toEqual([pinned.id, quote.id]);
    const uris = (await statuses(t.store)).map((s) => s.uri);
    expect(uris).toEqual(expect.arrayContaining([note.id, pinned.id, quote.id]));
    expect((await author(t, bob.uri)).fetched_at).toBe(iso(NOW - ACCOUNT_STALE_MS));
  });
});
