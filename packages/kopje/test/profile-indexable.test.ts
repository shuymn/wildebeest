import { Person } from "@fedify/vocab";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { upsertRemoteActor } from "../src/domain/remote-actors";
import { suspendLocal } from "../src/domain/suspension";
import { remoteActorInput } from "../src/federation/remote-actor";
import { bearer, json, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { aliceWithFollower } from "./profile-fixtures";
import { getJson, outbound } from "./status-helpers";
import { ORIGIN } from "./web-helpers";

// Account#indexable (migration 0058): set by update_credentials, presented in the Account and the CredentialAccount's
// source (with source.discoverable), federated as toot:indexable, and read from remote actors. False while suspended.

type Credential = {
  indexable: boolean;
  discoverable: boolean | null;
  source: { indexable: boolean; discoverable: boolean | null };
};

const setup = () => aliceWithFollower();

describe("indexable", () => {
  it("round-trips through update_credentials, with source.discoverable null until set", async () => {
    const h = await setup();
    const { alice } = h.users;
    const patch = async (body: unknown) =>
      (
        await h.request("/api/v1/accounts/update_credentials", bearer(alice.token, { ...json(body), method: "PATCH" }))
      ).json<Credential>();
    const first = (await getJson<Credential>(h, "/api/v1/accounts/verify_credentials", alice.token)).body;
    expect([first.indexable, first.source.indexable, first.discoverable, first.source.discoverable]).toEqual([
      false,
      false,
      null,
      null,
    ]);
    const set = await patch({ indexable: true, discoverable: false });
    expect([set.indexable, set.source.indexable, set.discoverable, set.source.discoverable]).toEqual([
      true,
      true,
      false,
      false,
    ]);
    // Absent keeps it; a form value reads as Rails casts it.
    expect((await patch({ note: "n" })).indexable).toBe(true);
    expect((await patch({ indexable: "0" })).source.indexable).toBe(false);
    expect(await sql(h.store, "SELECT indexable FROM accounts WHERE id = ?", alice.id)).toEqual([{ indexable: 0 }]);
    const shown = (await getJson<{ indexable: boolean }>(h, `/api/v1/accounts/${alice.id}`)).body;
    expect(shown.indexable).toBe(false);
  });

  it("is published by the actor and its Update, false while suspended", async () => {
    const h = await setup();
    const { alice } = h.users;
    await h.request(
      "/api/v1/accounts/update_credentials",
      bearer(alice.token, { ...json({ indexable: true }), method: "PATCH" }),
    );
    const actor = async () =>
      (await h.request("/ap/users/alice", { headers: { accept: "application/activity+json" } })).json<{
        indexable?: boolean;
      }>();
    expect((await actor()).indexable).toBe(true);
    const updates = async () =>
      (await outbound(h.store)).filter((o) => o.activity.type === "Update").map((o) => o.activity.object);
    expect((await updates()).at(-1)).toMatchObject({ indexable: true });
    await runInDurableObject(h.store, (_instance, state) =>
      state.storage.transactionSync(() => suspendLocal(new Db(state.storage.sql), alice.id, null, NOW)),
    );
    expect((await actor()).indexable).toBe(false);
    expect((await updates()).at(-1)).toMatchObject({ indexable: false, suspended: true });
    expect((await getJson<{ indexable: boolean }>(h, `/api/v1/accounts/${alice.id}`)).body.indexable).toBe(false);
    expect(await sql(h.store, "SELECT indexable FROM accounts WHERE id = ?", alice.id)).toEqual([{ indexable: 1 }]);
  });

  it("reads a remote actor as true only when it says so, and false when unavailable", async () => {
    const h = await setup();
    const { store } = h;
    const actors = [
      ["yes", { indexable: true }],
      ["no", {}],
      ["gone", { indexable: true }],
    ] as const;
    for (const [name, extra] of actors) {
      const actor = await Person.fromJsonLd({
        "@context": [
          "https://www.w3.org/ns/activitystreams",
          { toot: "http://joinmastodon.org/ns#", indexable: "toot:indexable" },
        ],
        id: `https://remote.example/users/${name}`,
        type: "Person",
        preferredUsername: name,
        inbox: `https://remote.example/users/${name}/inbox`,
        ...extra,
      });
      const input = await remoteActorInput(actor, {});
      expect(input?.indexable).toBe("indexable" in extra);
      await runInDurableObject(store, (_instance, state) =>
        state.storage.transactionSync(() => upsertRemoteActor(new Db(state.storage.sql), input!, ORIGIN, NOW)),
      );
    }
    const rows = await sql<{ id: string; username: string; indexable: number }>(
      store,
      "SELECT id, username, indexable FROM accounts WHERE domain = 'remote.example' ORDER BY username",
    );
    expect(rows.map((row) => [row.username, row.indexable])).toEqual([
      ["gone", 1],
      ["no", 0],
      ["yes", 1],
    ]);
    await sql(store, "UPDATE accounts SET deleted_at = ? WHERE username = 'gone'", new Date(NOW).toISOString());
    const presented = [];
    for (const row of rows) {
      presented.push((await getJson<{ indexable: boolean }>(h, `/api/v1/accounts/${row.id}`)).body.indexable);
    }
    expect(presented).toEqual([false, false, true]);
  });
});
