import { describe, expect, it } from "vitest";

import { MAX_LAST_READ_ID } from "../src/domain/markers";
import { type ApiHarness, bearer, form, json, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { appToken, scopedToken } from "./read-helpers";
import { act, community, getJson, type User } from "./status-helpers";

// Timeline markers through the API (domain/markers.ts, mastodon/markers.ts), as Mastodon 4.5 has them: what an update
// changes and counts, what it refuses, and what a read shows.

const AT = new Date(NOW).toISOString();

async function save(h: ApiHarness, user: User, body: Record<string, unknown>) {
  const response = await act(h, user, "/api/v1/markers", body);
  return { status: response.status, body: await response.json() };
}

async function read(h: ApiHarness, user: User, query: string) {
  return getJson(h, `/api/v1/markers${query}`, user.token);
}

describe("markers", () => {
  it('saves a timeline sent as an empty JSON object, at "0" for a new marker', async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    expect(await save(h, alice, { home: {} })).toEqual({
      status: 200,
      body: { home: { last_read_id: "0", version: 0, updated_at: AT } },
    });
    // An existing marker is left as it is.
    await save(h, alice, { notifications: { last_read_id: "5" } });
    expect((await save(h, alice, { notifications: {} })).body).toEqual({
      notifications: { last_read_id: "5", version: 1, updated_at: AT },
    });
  });

  it("creates a marker at version 1, counts each change, and shows the timelines asked for", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    expect(await save(h, alice, { home: { last_read_id: "103206805498034432" } })).toEqual({
      status: 200,
      body: { home: { last_read_id: "103206805498034432", version: 1, updated_at: AT } },
    });

    h.now.mockReturnValue(NOW + 60_000);
    const later = new Date(NOW + 60_000).toISOString();
    // A form update of both timelines answers both, home first.
    const response = await h.request(
      "/api/v1/markers",
      bearer(alice.token, form({ "notifications[last_read_id]": "42", "home[last_read_id]": "103206805498034433" })),
    );
    expect([response.status, JSON.stringify(await response.json())]).toEqual([
      200,
      JSON.stringify({
        home: { last_read_id: "103206805498034433", version: 2, updated_at: later },
        notifications: { last_read_id: "42", version: 1, updated_at: later },
      }),
    ]);

    const both = {
      home: { last_read_id: "103206805498034433", version: 2, updated_at: later },
      notifications: { last_read_id: "42", version: 1, updated_at: later },
    };
    expect(await read(h, alice, "?timeline[]=home&timeline[]=notifications")).toEqual({ status: 200, body: both });
    // Unknown names are ignored, a single timeline works without [], and nothing asked shows nothing.
    expect(await read(h, alice, "?timeline[]=public&timeline[]=notifications&timeline[]=notifications")).toEqual({
      status: 200,
      body: { notifications: both.notifications },
    });
    expect(await read(h, alice, "?timeline=home")).toEqual({ status: 200, body: { home: both.home } });
    expect(await read(h, alice, "")).toEqual({ status: 200, body: {} });
  });

  it("changes nothing for the same value or for a timeline sent without last_read_id", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    await save(h, alice, { home: { last_read_id: "7" } });
    h.now.mockReturnValue(NOW + 60_000);
    const home = { last_read_id: "7", version: 1, updated_at: AT };
    expect(await save(h, alice, { home: { last_read_id: "7" } })).toEqual({ status: 200, body: { home } });
    // A timeline named without last_read_id gets its marker, a new one at "0", version 0; other fields are ignored.
    expect(await save(h, alice, { home: { other: "9" }, notifications: { other: "9" } })).toEqual({
      status: 200,
      body: {
        home,
        notifications: { last_read_id: "0", version: 0, updated_at: new Date(NOW + 60_000).toISOString() },
      },
    });
    // Sent as anything but an object, or not a marker timeline, it is not named at all.
    expect(await save(h, alice, { home: "8", notifications: ["8"], public: { last_read_id: "8" } })).toEqual({
      status: 200,
      body: {},
    });
    expect(await sql(h.store, "SELECT timeline, last_read_id, version FROM markers ORDER BY timeline")).toEqual([
      { timeline: "home", last_read_id: "7", version: 1 },
      { timeline: "notifications", last_read_id: "0", version: 0 },
    ]);
  });

  it("keeps last_read_id as sent, whether or not it names anything", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    for (const value of ["999999999999999999", "not-an-id", " 12", 123]) {
      const { body } = await save(h, alice, { notifications: { last_read_id: value } });
      expect(body).toMatchObject({ notifications: { last_read_id: String(value) } });
    }
    expect((await read(h, alice, "?timeline[]=notifications")).body).toMatchObject({
      notifications: { last_read_id: "123", version: 4 },
    });
  });

  it("answers 422 with Mastodon's validation message, and saves nothing of the request", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    await save(h, alice, { home: { last_read_id: "5" } });
    const blank = { status: 422, body: { error: "Validation failed: Last read can't be blank" } };
    expect(await save(h, alice, { home: { last_read_id: "" } })).toEqual(blank);
    expect(await save(h, alice, { home: { last_read_id: null } })).toEqual(blank);
    expect(await save(h, alice, { home: { last_read_id: "6" }, notifications: { last_read_id: " " } })).toEqual(blank);
    // Kopje's bound, counted in characters.
    expect(await save(h, alice, { notifications: { last_read_id: "𝒜".repeat(MAX_LAST_READ_ID) } })).toMatchObject({
      status: 200,
    });
    expect(await save(h, alice, { home: { last_read_id: "a".repeat(MAX_LAST_READ_ID + 1) } })).toEqual({
      status: 422,
      body: { error: `Validation failed: Last read is too long (maximum is ${MAX_LAST_READ_ID} characters)` },
    });
    expect((await read(h, alice, "?timeline[]=home")).body).toEqual({
      home: { last_read_id: "5", version: 1, updated_at: AT },
    });
  });

  it("applies concurrent updates one after the other, each counted, with no conflict", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const responses = await Promise.all(
      ["1", "2", "3", "4"].map((id) => act(h, alice, "/api/v1/markers", { home: { last_read_id: id } })),
    );
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const versions = await Promise.all(
      responses.map(async (r) => (await r.json<{ home: { version: number } }>()).home.version),
    );
    expect(versions.toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect((await read(h, alice, "?timeline[]=home")).body).toMatchObject({ home: { version: 4 } });
  });

  it("keeps each account's markers to itself, and asks read:statuses and write:statuses of a user", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    await save(h, alice, { home: { last_read_id: "1" } });
    expect(await read(h, bob, "?timeline[]=home")).toEqual({ status: 200, body: {} });
    await save(h, bob, { home: { last_read_id: "2" } });
    expect((await read(h, alice, "?timeline[]=home")).body).toMatchObject({ home: { last_read_id: "1" } });

    const reader = await scopedToken(h, "read:statuses");
    expect((await h.request("/api/v1/markers?timeline[]=home", bearer(reader))).status).toBe(200);
    expect((await h.request("/api/v1/markers", bearer(reader, json({ home: { last_read_id: "3" } })))).status).toBe(
      403,
    );
    const writer = await scopedToken(h, "write:statuses");
    expect((await h.request("/api/v1/markers?timeline[]=home", bearer(writer))).status).toBe(403);
    expect((await h.request("/api/v1/markers", bearer(writer, json({ home: { last_read_id: "3" } })))).status).toBe(
      200,
    );
    const app = await appToken(h);
    expect((await h.request("/api/v1/markers?timeline[]=home", bearer(app))).status).toBe(422);
    expect((await h.request("/api/v1/markers?timeline[]=home")).status).toBe(401);
  });
});
