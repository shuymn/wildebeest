import { describe, expect, it } from "vitest";

import { bearer, json, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { LEGACY } from "./federation-helpers";
import { PNG_PLAIN } from "./fixtures/images";
import { bytes, mediaForm, TestCodec } from "./media-helpers";
import { byText } from "./sort";
import { community, outbound, remoteAccount, remoteFollows } from "./status-helpers";
import { csrfOf, ORIGIN, signIn } from "./web-helpers";

// Profile changes reach other servers as Update(Person) through outbound delivery (VIS-3's "changes reach only the
// original audience" for an actor: its followers), and a later Update supersedes an earlier one.

async function setup() {
  const codec = new TestCodec();
  const h = await community(["alice"], "read write follow", { images: () => codec });
  await sql(h.store, "UPDATE local_accounts SET pubkey = ?", LEGACY.pubkey);
  const fan = await remoteAccount(h.store, "fan", "fans.example");
  await remoteFollows(h.store, fan, h.users.alice.id);
  return h;
}

function patch(h: Awaited<ReturnType<typeof setup>>, body: unknown) {
  return h.request(
    "/api/v1/accounts/update_credentials",
    bearer(h.users.alice.token, { ...json(body), method: "PATCH" }),
  );
}

async function updates(h: Awaited<ReturnType<typeof setup>>) {
  const rows = await sql<{ superseded: number; body: string }>(
    h.store,
    "SELECT superseded, body FROM outbound_activities WHERE json_extract(body, '$.activity.type') = 'Update' ORDER BY id",
  );
  return rows.map((row) => ({
    superseded: row.superseded === 1,
    activity: (JSON.parse(row.body) as { activity: Record<string, unknown> & { object: Record<string, unknown> } })
      .activity,
  }));
}

describe("Update(Person)", () => {
  it("sends the changed profile to the followers, the latest edit only", async () => {
    const h = await setup();
    expect((await patch(h, { display_name: "First" })).status).toBe(200);
    expect(
      (
        await patch(h, {
          display_name: "Second",
          note: "bio",
          fields_attributes: [{ name: "Site", value: "https://alice.example/" }],
        })
      ).status,
    ).toBe(200);
    const sent = await updates(h);
    // The first edit's Update was still waiting: the second replaced it, and nothing of it remains.
    expect(sent.map((u) => u.superseded)).toEqual([false]);
    const latest = sent[0]?.activity;
    expect(latest).toMatchObject({
      type: "Update",
      actor: `${ORIGIN}/ap/users/alice`,
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      object: {
        id: `${ORIGIN}/ap/users/alice`,
        type: "Person",
        name: "Second",
        summary: "<p>bio</p>",
        attachment: [{ type: "PropertyValue", name: "Site" }],
        publicKey: { id: `${ORIGIN}/ap/users/alice#main-key`, publicKeyPem: LEGACY.pubkey },
      },
    });
    // Only the latest is delivered, as an Update (never turned into a Create), to the follower's server.
    const deliveries = await sql<{ type: string; name: string; inbox_url: string }>(
      h.store,
      `SELECT json_extract(o.body, '$.activity.type') AS type, json_extract(o.body, '$.activity.object.name') AS name,
				d.inbox_url FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id`,
    );
    expect(deliveries).toEqual([{ type: "Update", name: "Second", inbox_url: "https://fans.example/inbox" }]);
    // The same document the actor endpoint publishes.
    const actor = await (
      await h.request("/ap/users/alice", { headers: { accept: "application/activity+json" } })
    ).json<Record<string, unknown>>();
    for (const key of ["id", "type", "preferredUsername", "name", "summary", "url", "inbox", "followers"]) {
      expect(latest?.object[key], key).toEqual(actor[key]);
    }
  });

  it("sends nothing when the published profile does not change", async () => {
    const h = await setup();
    await patch(h, { source: { privacy: "unlisted" } });
    await patch(h, { display_name: "" });
    expect(await updates(h)).toEqual([]);
    expect(await outbound(h.store)).toEqual([]);
  });

  it("sends one Update when the account hides or shows its network, and none when the setting stays", async () => {
    for (const [stored, asked] of [
      [0, true],
      [1, false],
    ] as const) {
      const h = await setup();
      await sql(h.store, "UPDATE local_accounts SET hide_collections = ?", stored);
      // The same value as stored: nothing changes.
      expect((await patch(h, { hide_collections: !asked })).status).toBe(200);
      expect(await updates(h)).toEqual([]);
      expect((await patch(h, { hide_collections: asked })).status).toBe(200);
      const sent = await updates(h);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.activity).toMatchObject({ type: "Update", object: { id: `${ORIGIN}/ap/users/alice` } });
      // Asked again, it records nothing more.
      expect((await patch(h, { hide_collections: asked })).status).toBe(200);
      expect(await updates(h)).toEqual(sent);
    }
  });

  it("sends attributionDomains when the account sets them, and an Update without them when it clears them", async () => {
    const h = await setup();
    expect((await patch(h, { attribution_domains: ["writer.example"] })).status).toBe(200);
    let sent = await updates(h);
    expect(sent.at(-1)?.activity.object.attributionDomains).toEqual(["writer.example"]);
    expect(JSON.stringify(sent.at(-1)?.activity["@context"])).toContain("toot:attributionDomains");
    expect((await patch(h, { attribution_domains: [] })).status).toBe(200);
    sent = await updates(h);
    expect(sent.at(-1)?.activity.object).not.toHaveProperty("attributionDomains");
    expect(sent.at(-1)?.activity.object).toMatchObject({ type: "Person", preferredUsername: "alice" });
    // The same list again changes nothing published.
    expect((await patch(h, { attribution_domains: [] })).status).toBe(200);
    expect(await updates(h)).toHaveLength(sent.length);
  });

  it("sends the new avatar from the settings page", async () => {
    const h = await setup();
    const browser = await signIn(h);
    const form = mediaForm(bytes(PNG_PLAIN), { csrf: await csrfOf(h, browser) }, "p.png", "image/png");
    const response = await h.request("/settings/avatar", {
      method: "POST",
      headers: { cookie: browser.cookie, origin: ORIGIN },
      body: form,
    });
    expect(response.status).toBe(303);
    const [avatar] = await sql<{ avatar_url: string }>(
      h.store,
      "SELECT avatar_url FROM accounts WHERE username = 'alice'",
    );
    const sent = await updates(h);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.activity.object).toMatchObject({ icon: { type: "Image", url: avatar?.avatar_url } });
  });

  it("keeps unrelated and leased deliveries and lane order, with partly expanded targets", async () => {
    const h = await setup();
    const { alice } = h.users;
    // 150 more followers, each on its own server: one activity's targets take more than one expansion step.
    for (let i = 0; i < 150; i++) {
      await remoteFollows(h.store, await remoteAccount(h.store, `f${i}`, `f${i}.example`), alice.id);
    }
    expect((await patch(h, { display_name: "One" })).status).toBe(200);
    const [first] = await updates(h);
    const firstId = await activityId(h, "One");
    // Some of the first Update's deliveries are leased (possibly already POSTed); its other targets wait.
    await h.store.claimDeliveries(h.env.CF_VERSION_METADATA.id, { now: NOW, leaseToken: "round-1" });
    const leased = await sql<{ id: number; lane: string }>(
      h.store,
      "SELECT id, lane FROM deliveries WHERE state = 'leased' AND activity_id = ?",
      firstId,
    );
    expect(leased.length).toBeGreaterThan(0);
    expect(first?.activity.object).toMatchObject({ name: "One" });
    // A status in between, then the second edit.
    const status = await h.request("/api/v1/statuses", bearer(alice.token, json({ status: "hello" })));
    expect(status.status).toBe(200);
    expect((await patch(h, { display_name: "Two" })).status).toBe(200);
    const secondId = await activityId(h, "Two");
    const createId = (
      await sql<{ id: number }>(
        h.store,
        "SELECT id FROM outbound_activities WHERE json_extract(body, '$.activity.type') = 'Create'",
      )
    )[0]?.id;

    // The first Update keeps exactly its leased deliveries and no waiting targets.
    const firstLeft = await sql<{ id: number; state: string }>(
      h.store,
      "SELECT id, state FROM deliveries WHERE activity_id = ?",
      firstId,
    );
    expect(firstLeft.map((d) => d.id).sort(byText)).toEqual(leased.map((d) => d.id).sort(byText));
    expect(await targetsOf(h, firstId)).toBe(firstLeft.length);
    // The status and the second Update reach every follower's server (151 each, expanded or still waiting).
    expect(await targetsOf(h, createId ?? 0)).toBe(151);
    expect(await targetsOf(h, secondId)).toBe(151);
    // Lane order holds where the leased first Update is still in its lane: it, then the status, then the second.
    for (const { lane } of leased) {
      const order = await sql<{ activity_id: number }>(
        h.store,
        "SELECT activity_id FROM deliveries WHERE lane = ? ORDER BY id",
        lane,
      );
      const ids = order.map((d) => d.activity_id);
      expect(ids[0], lane).toBe(firstId);
      expect(ids.filter((id) => id !== firstId)).toEqual(ids.filter((id) => id !== firstId).sort((x, y) => x - y));
    }
  }, 30_000);
});

async function activityId(h: Awaited<ReturnType<typeof setup>>, name: string): Promise<number> {
  const [row] = await sql<{ id: number }>(
    h.store,
    "SELECT id FROM outbound_activities WHERE json_extract(body, '$.activity.object.name') = ?",
    name,
  );
  return row?.id ?? 0;
}

// Deliveries written for an activity plus targets still waiting in its chunks.
async function targetsOf(h: Awaited<ReturnType<typeof setup>>, activityId: number): Promise<number> {
  const [row] = await sql<{ n: number }>(
    h.store,
    `SELECT (SELECT COUNT(*) FROM deliveries WHERE activity_id = ?1)
			+ (SELECT IFNULL(SUM(json_array_length(targets) - next), 0) FROM outbound_targets WHERE activity_id = ?1) AS n`,
    activityId,
  );
  return row?.n ?? 0;
}
