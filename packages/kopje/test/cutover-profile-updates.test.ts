import { describe, expect, inject, it } from "vitest";

import { apiHarness, sql } from "./api-helpers";
import { BUILD } from "./helpers";
import { ADMIN_AUD, ADMIN_EMAIL, importViaRpc, setAccess } from "./ops-helpers";

// Publication announces the local profiles whose avatar or header `convert --images` changed (docs/cutover.md,
// "Publication"): one Update(Person) each, as a profile edit sends, recorded in the publishing transaction, so a
// repeated publication records none. The dumps come from test-node/cutover-global-setup.ts, where both local accounts'
// images move (alice's avatar and header, Bob's avatar; Bob's upstream default header becomes Kopje's default).

declare module "vitest" {
  export interface ProvidedContext {
    cutover: { dump: string; expected: Record<string, Record<string, string>> };
    cutoverImages: { dump: string; originals: Record<string, string> };
  }
}

async function imported(dump: string) {
  const h = await apiHarness();
  await setAccess(h.store, { access_team_domain: h.team.teamDomain });
  const authority = {
    kind: "access",
    email: ADMIN_EMAIL,
    commonName: null,
    teamDomain: h.team.teamDomain,
    aud: ADMIN_AUD,
  } as const;
  const { report } = await importViaRpc(h.store, dump, 16 * 1024, authority);
  expect(report).toMatchObject({ ok: true });
  return { h, publish: () => h.store.publish(BUILD, authority) };
}

type Image = { type: string; url: string } | undefined;

async function updates(store: Awaited<ReturnType<typeof apiHarness>>["store"]) {
  const rows = await sql<{ body: string }>(
    store,
    "SELECT body FROM outbound_activities WHERE json_extract(body, '$.activity.type') = 'Update' ORDER BY id",
  );
  return rows.map((row) => {
    const { activity } = JSON.parse(row.body) as {
      activity: { actor: string; object: { id: string; type: string; icon?: Image; image?: Image } };
    };
    return {
      actor: activity.actor,
      type: activity.object.type,
      icon: activity.object.icon,
      image: activity.object.image,
    };
  });
}

describe("publication after a conversion with --images", () => {
  it("records one Update(Person) per changed local profile, with its new images, and none when repeated", async () => {
    const { h, publish } = await imported(inject("cutoverImages").dump);
    expect(await updates(h.store)).toEqual([]);
    const locals = await sql<{ uri: string; avatar_url: string | null; header_url: string | null }>(
      h.store,
      "SELECT uri, avatar_url, header_url FROM accounts WHERE domain IS NULL ORDER BY uri",
    );
    expect(locals).toHaveLength(2);

    expect(await publish()).toMatchObject({ ok: true, profileUpdates: 2 });
    const image = (url: string | null) => (url === null ? undefined : { type: "Image", url });
    const sent = await updates(h.store);
    expect(sent.sort((a, b) => (a.actor < b.actor ? -1 : 1))).toEqual(
      locals.map((a) => ({ actor: a.uri, type: "Person", icon: image(a.avatar_url), image: image(a.header_url) })),
    );
    // The new images are Kopje media, and a dropped default header is sent as none.
    expect(locals.every((a) => a.avatar_url?.includes("/media/") === true)).toBe(true);
    expect(locals.map((a) => a.header_url === null)).toEqual([true, false]);
    expect(await sql(h.store, "SELECT name FROM kopje_state WHERE name = 'profile_updates'")).toEqual([]);

    expect(await publish()).toMatchObject({ ok: true, profileUpdates: 0 });
    expect(await updates(h.store)).toHaveLength(2);
  });

  it("is refused, keeping the Store unpublished and the list, when the stored list is malformed", async () => {
    const { h, publish } = await imported(inject("cutoverImages").dump);
    // A list written by an earlier build that a stricter parser rejects (here: a repeated id).
    await sql(h.store, "UPDATE kopje_state SET value = '[\"1\",\"1\"]' WHERE name = 'profile_updates'");

    expect(await publish()).toMatchObject({ ok: false, code: "state-invalid" });
    expect(await updates(h.store)).toEqual([]);
    expect(await sql(h.store, "SELECT value FROM kopje_state WHERE name = 'profile_updates'")).toEqual([
      { value: '["1","1"]' },
    ]);
    expect(await sql(h.store, "SELECT name FROM kopje_state WHERE name IN ('unpublished', 'published')")).toEqual([
      { name: "unpublished" },
    ]);
  });
});

describe("publication during a dump", () => {
  it("is refused while the dump holds its freeze, so the dump is of the unpublished Store throughout", async () => {
    const { h, publish } = await imported(inject("cutoverImages").dump);
    const started = await h.store.dumpStart(BUILD);
    if (!started.ok) {
      throw new Error(started.message);
    }
    const first = await h.store.dumpNext(BUILD, started.cursor, 4096);
    if (!first.ok || first.done) {
      throw new Error("expected a dump of several chunks");
    }
    let text = started.headerLine + new TextDecoder().decode(first.chunk);
    expect(await publish()).toMatchObject({ ok: false, code: "dump-in-progress" });
    expect(await updates(h.store)).toEqual([]);
    let cursor = first.cursor;
    for (;;) {
      const step = await h.store.dumpNext(BUILD, cursor, 4096);
      if (!step.ok) {
        throw new Error(step.message);
      }
      text += new TextDecoder().decode(step.chunk);
      cursor = step.cursor;
      if (step.done) {
        break;
      }
    }
    const finished = await h.store.dumpFinish(BUILD, cursor);
    expect(finished).toMatchObject({ ok: true });
    // The dump still lists the profiles to announce, and the Store has recorded no Update.
    expect(text).toMatch(/^INSERT INTO "kopje_state" \("name","value"\) VALUES \('profile_updates',/m);

    expect(await publish()).toMatchObject({ ok: true, profileUpdates: 2 });
  });
});

describe("publication after a conversion without --images", () => {
  it("records no Update", async () => {
    const { h, publish } = await imported(inject("cutover").dump);
    expect(await publish()).toMatchObject({ ok: true, profileUpdates: 0 });
    expect(await updates(h.store)).toEqual([]);
  });
});
