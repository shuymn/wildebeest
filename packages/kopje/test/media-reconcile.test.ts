import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { DETACHED_GRACE_MS, ORPHAN_GRACE_MS, TRANSFORMS_PER_UPLOAD } from "../src/domain/media";
import { reconcileMedia, sweepMedia } from "../src/mastodon/media";
import type { StoreStub } from "../src/platform/store-client";
import { sha256Hex } from "../src/security/tokens";
import { bearer, json, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { PNG_PLAIN } from "./fixtures/images";
import { BUILD } from "./helpers";
import { added } from "./local-emoji-helpers";
import { bytes, mediaForm, TestCodec, upload, uploaded } from "./media-helpers";
import { ACCESS, setAccess } from "./ops-helpers";
import { community, getJson, post } from "./status-helpers";

// Media reconciliation: R2 objects with no row are reconciled away; a reservation is revalidated, and its
// transformations charged, right before Images runs; completion is fenced in the Store; field caps cover the query.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

async function users(options: { codec?: TestCodec; wrapStore?: (store: StoreStub) => StoreStub } = {}) {
  const codec = options.codec ?? new TestCodec();
  const h = await community(["alice", "bob"], "read write follow", {
    images: () => codec,
    wrapStore: options.wrapStore,
  });
  return { ...h, codec };
}

const png = () => mediaForm(bytes(PNG_PLAIN), {}, "a.png", "image/png");

// A Store stub whose `method` runs `after` once it answered.
function after(method: "reserveMedia" | "startTransforms", then: () => void | Promise<void>) {
  return (store: StoreStub) =>
    new Proxy(store, {
      get(target, property) {
        if (property !== method) {
          return Reflect.get(target, property) as unknown;
        }
        return async (...args: Parameters<StoreStub[typeof method]>) => {
          // Called on the stub itself: an RPC method detached from its stub does not reach the Store.
          const result: unknown = await (target[method] as (...a: unknown[]) => Promise<unknown>)(...args);
          await then();
          return result;
        };
      },
    });
}

// A harness whose clock moves to `at()` once the reservation is answered (as a slow body read would).
async function afterReserve(at: () => number) {
  const clock = { move: () => {} };
  const h = await users({ wrapStore: after("reserveMedia", () => clock.move()) });
  clock.move = () => {
    h.now.mockReturnValue(at());
  };
  return h;
}

describe("reconciliation deletes only recorded tombstones", () => {
  const deps = (h: { store: StoreStub }, at: number) => ({
    build: () => env.CF_VERSION_METADATA.id,
    store: () => h.store,
    now: () => at,
  });
  const later = NOW + 30 * 24 * HOUR;

  async function present(keys: string[]): Promise<string[]> {
    const found: string[] = [];
    for (const key of keys) {
      if ((await env.MEDIA.head(key)) !== null) {
        found.push(key);
      }
    }
    return found;
  }

  it("deletes nothing from R2 for a Store that knows nothing of it (wiped, reset or restored)", async () => {
    const h = await users();
    const keys = [`files/${"W".repeat(43)}/full`, `files/${"W".repeat(43)}/small`, "originals/100000000000000901"];
    for (const key of keys) {
      await env.MEDIA.put(key, "restored media");
    }
    await sweepMedia(env, deps(h, later));
    await reconcileMedia(env, deps(h, later));
    expect(await present(keys)).toEqual(keys);
  });

  it("deletes nothing during maintenance, an import, or before setup, even for a due tombstone", async () => {
    const h = await users();
    const token = "T".repeat(43);
    const keys = [`files/${token}/full`, "originals/100000000000000902"];
    const tombstone = async () => {
      await sql(
        h.store,
        "INSERT OR REPLACE INTO media_orphans (file_token, media_id, delete_after) VALUES (?, ?, ?)",
        token,
        "100000000000000902",
        new Date(NOW).toISOString(),
      );
      for (const key of keys) {
        await env.MEDIA.put(key, "x");
      }
    };
    await tombstone();
    await sql(
      h.store,
      "INSERT INTO kopje_state (name, value) VALUES ('maintenance', ?)",
      JSON.stringify({ mode: "readonly", at: NOW }),
    );
    expect(await reconcileMedia(env, deps(h, later))).toBe(0);
    expect(await present(keys)).toEqual(keys);
    await sql(h.store, "DELETE FROM kopje_state WHERE name = 'maintenance'");
    await sql(
      h.store,
      "INSERT INTO kopje_state (name, value) VALUES ('import', ?)",
      JSON.stringify({ id: "i", state: "receiving" }),
    );
    expect(await reconcileMedia(env, deps(h, later))).toBe(0);
    expect(await present(keys)).toEqual(keys);
    await sql(h.store, "DELETE FROM kopje_state WHERE name = 'import'");
    await sql(h.store, "DELETE FROM instance_settings WHERE name = 'domain'");
    expect(await reconcileMedia(env, deps(h, later))).toBe(0);
    expect(await present(keys)).toEqual(keys);
  });

  it("deletes a late write of a failed upload once its tombstone falls due", async () => {
    const h = await users();
    h.codec.failEncode = 9523;
    expect((await upload(h, h.users.alice, png())).status).toBe(500);
    const [row] = await sql<{ id: string; file_token: string; created_at: string }>(
      h.store,
      "SELECT id, file_token, created_at FROM media_attachments",
    );
    const token = row?.file_token ?? "";
    expect(await sweepMedia(env, deps(h, NOW))).toBe(1);
    expect(await sql(h.store, "SELECT file_token FROM media_orphans")).toEqual([{ file_token: token }]);
    // A put that was still in flight lands after the sweep.
    await env.MEDIA.put(`files/${token}/full`, "late");
    const due = Date.parse(row?.created_at ?? "") + 15 * MINUTE + 24 * HOUR;
    expect(await reconcileMedia(env, deps(h, due - 1))).toBe(0);
    expect(await env.MEDIA.head(`files/${token}/full`)).not.toBeNull();
    expect(await reconcileMedia(env, deps(h, due))).toBe(1);
    expect(await env.MEDIA.head(`files/${token}/full`)).toBeNull();
    expect(await sql(h.store, "SELECT file_token FROM media_orphans")).toEqual([]);
  });
  it("schedules the tombstone from the time taken after the R2 delete", async () => {
    const h = await users();
    h.codec.failEncode = 9523;
    expect((await upload(h, h.users.alice, png())).status).toBe(500);
    const [row] = await sql<{ file_token: string }>(h.store, "SELECT file_token FROM media_attachments");
    // Past the writer deadline, so the tombstone is scheduled from the sweep's time; the R2 delete takes 2 hours.
    let at = NOW + HOUR;
    const bucket = {
      delete: async (keys: string | string[]) => {
        await env.MEDIA.delete(keys);
        at += 2 * HOUR;
      },
    } as unknown as R2Bucket;
    const swept = await sweepMedia({ ...env, MEDIA: bucket }, { ...deps(h, 0), now: () => at });
    expect(swept).toBe(1);
    expect(await sql(h.store, "SELECT file_token, delete_after FROM media_orphans")).toEqual([
      { file_token: row?.file_token, delete_after: new Date(NOW + 3 * HOUR + ORPHAN_GRACE_MS).toISOString() },
    ]);
  });
});

describe("the reservation is revalidated before Images runs (RES-6)", () => {
  it("spends no transformation on a reservation that expired while its body was read", async () => {
    const h = await afterReserve(() => NOW + 16 * MINUTE);
    const response = await upload(h, h.users.alice, png());
    expect(response.status).toBe(422);
    expect(h.codec.calls).toBe(0);
  });

  it("charges the budgets of the month the transformations run in", async () => {
    const november = Date.parse("2026-11-01T00:00:00.000Z");
    const h = await afterReserve(() => november + 1000);
    h.now.mockReturnValue(november - 1000);
    expect((await upload(h, h.users.alice, png())).status).toBe(200);
    const counters = await sql<{ name: string; value: string }>(
      h.store,
      "SELECT name, value FROM kopje_state WHERE name LIKE 'images\\_%' ESCAPE '\\' ORDER BY name",
    );
    expect(counters).toEqual([
      { name: `images_account_transforms:2026-11:${h.users.alice.id}`, value: "3" },
      { name: "images_transforms:2026-11", value: "3" },
    ]);
  });

  // An upload asks Images for three outputs (TRANSFORMS_PER_UPLOAD), so two left refuse it, at the reservation and at
  // the start of its transformations.
  const month = new Date(NOW).toISOString().slice(0, 7);
  const counters = (h: { users: { alice: { id: string } } }) => ({
    account: { name: `images_account_transforms:${month}:${h.users.alice.id}`, limit: 400 },
    instance: { name: `images_transforms:${month}`, limit: 4000 },
  });
  const REFUSALS = {
    account: "Your media processing budget for the month is used up",
    instance: "This server's media processing budget for the month is used up",
  };

  it.each(["account", "instance"] as const)("refuses the reservation with two left of the %s budget", async (scope) => {
    expect(TRANSFORMS_PER_UPLOAD).toBe(3);
    const starts = { count: 0 };
    const h = await users({
      wrapStore: after("startTransforms", () => {
        starts.count++;
      }),
    });
    const { name, limit } = counters(h)[scope];
    await sql(h.store, "INSERT INTO kopje_state (name, value) VALUES (?, ?)", name, String(limit - 2));
    // The form as a stream that records whether anything read it (no pull before a read: highWaterMark 0).
    const form = new Response(png());
    const payload = new Uint8Array(await form.arrayBuffer());
    const body = { pulled: false };
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          body.pulled = true;
          controller.enqueue(payload);
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const refused = await h.request(
      "/api/v2/media",
      bearer(h.users.alice.token, {
        method: "POST",
        body: stream,
        headers: { "content-type": form.headers.get("content-type") ?? "" },
        duplex: "half",
      } as RequestInit),
    );
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: REFUSALS[scope] });
    // Refused by the reservation: no body read, no row, no attempt counted, no start, no transformation.
    expect(body.pulled).toBe(false);
    expect(await sql(h.store, "SELECT id FROM media_attachments")).toEqual([]);
    expect(await sql(h.store, "SELECT name FROM kopje_state WHERE name LIKE 'media\\_attempts:%' ESCAPE '\\'")).toEqual(
      [],
    );
    expect(starts.count).toBe(0);
    expect(h.codec.calls).toBe(0);
    expect(await sql(h.store, "SELECT value FROM kopje_state WHERE name = ?", name)).toEqual([
      { value: String(limit - 2) },
    ]);
    // One more left admits it, through the start.
    await sql(h.store, "UPDATE kopje_state SET value = ? WHERE name = ?", String(limit - 3), name);
    expect((await upload(h, h.users.alice, png())).status).toBe(200);
    expect(starts.count).toBe(1);
  });

  it.each(["account", "instance"] as const)(
    "refuses the transformations when the %s budget fell to two left after the reservation",
    async (scope) => {
      const target = { name: "", limit: 0 };
      const h = await users({
        wrapStore: after("reserveMedia", async () => {
          await sql(
            h.store,
            "INSERT INTO kopje_state (name, value) VALUES (?, ?)",
            target.name,
            String(target.limit - 2),
          );
        }),
      });
      Object.assign(target, counters(h)[scope]);
      const refused = await upload(h, h.users.alice, png());
      expect(refused.status).toBe(429);
      expect(await refused.json()).toEqual({ error: REFUSALS[scope] });
      expect(h.codec.calls).toBe(0);
      // The reservation was made (the attempt counted) and the start refused.
      expect(await sql(h.store, "SELECT processed FROM media_attachments")).toEqual([{ processed: 1 }]);
    },
  );

  it("refuses the transformations when the month it runs in is used up", async () => {
    const november = Date.parse("2026-11-01T00:00:00.000Z");
    const h = await afterReserve(() => november + 1000);
    await sql(h.store, "INSERT INTO kopje_state (name, value) VALUES ('images_transforms:2026-11', '4000')");
    h.now.mockReturnValue(november - 1000);
    expect((await upload(h, h.users.alice, png())).status).toBe(429);
    expect(h.codec.calls).toBe(0);
  });
});

describe("completion fence", () => {
  it("refuses completion at the writer deadline, judged in the Store with the time taken right before the call", async () => {
    const clock = { at: (_ms: number) => {} };
    // The Worker's own check before writing passes; the writes take until the deadline.
    const bucket = {
      put: async (key: string, value: Uint8Array, options?: R2PutOptions) => {
        const result = await env.MEDIA.put(key, value, options);
        clock.at(NOW + 15 * MINUTE);
        return result;
      },
      delete: (keys: string | string[]) => env.MEDIA.delete(keys),
      get: (key: string) => env.MEDIA.get(key),
      head: (key: string) => env.MEDIA.head(key),
      list: (options?: R2ListOptions) => env.MEDIA.list(options),
    } as unknown as R2Bucket;
    const codec = new TestCodec();
    const h = await community(["alice"], "read write follow", { images: () => codec }, { MEDIA: bucket });
    clock.at = (ms) => h.now.mockReturnValue(ms);
    const response = await upload(h, h.users.alice, png());
    expect(response.status).toBe(422);
    expect(await sql(h.store, "SELECT processed, url FROM media_attachments")).toEqual([{ processed: 1, url: "" }]);
    // A put of the refused upload that lands after the sweep is cleaned up by its tombstone.
    const [row] = await sql<{ file_token: string }>(h.store, "SELECT file_token FROM media_attachments");
    const deps = (at: number) => ({ build: () => env.CF_VERSION_METADATA.id, store: () => h.store, now: () => at });
    await sweepMedia(env, deps(NOW + 15 * MINUTE));
    await env.MEDIA.put(`files/${row?.file_token}/small`, "late");
    await reconcileMedia(env, deps(NOW + 15 * MINUTE + 24 * HOUR));
    expect(await env.MEDIA.head(`files/${row?.file_token}/small`)).toBeNull();
  });

  it("keeps committed files when both completion answers are lost", async () => {
    const lose = (store: StoreStub) =>
      new Proxy(store, {
        get(target, property) {
          if (property === "completeMedia") {
            return async (...args: Parameters<StoreStub["completeMedia"]>) => {
              await target.completeMedia(...args);
              throw new Error("response lost");
            };
          }
          return Reflect.get(target, property) as unknown;
        },
      });
    const h = await users({ wrapStore: lose });
    expect((await upload(h, h.users.alice, png())).status).toBe(500);
    const [row] = await sql<{ id: string; file_token: string; processed: number; url: string; gc_at: string }>(
      h.store,
      "SELECT id, file_token, processed, url, gc_at FROM media_attachments",
    );
    expect(row?.processed).toBe(1);
    expect(row?.url).not.toBe("");
    // Kept as an ordinary unattached upload: its grace period runs from the completion, and a sweep before it ends
    // leaves the row and its files.
    expect(row?.gc_at).toBe(new Date(NOW + DETACHED_GRACE_MS).toISOString());
    const deps = { build: () => env.CF_VERSION_METADATA.id, store: () => h.store, now: () => NOW + HOUR };
    expect(await sweepMedia(env, deps)).toBe(0);
    expect(await env.MEDIA.head(`files/${row?.file_token}/full`)).not.toBeNull();
    expect(await env.MEDIA.head(`originals/${row?.id}`)).not.toBeNull();
  });
});

describe("field bounds cover the query string (RES-1)", () => {
  it("refuses an over-long field sent in the query", async () => {
    const h = await users();
    const response = await h.request(
      `/api/v2/media?focus=${"0".repeat(7000)}`,
      bearer(h.users.alice.token, { method: "POST", body: png() }),
    );
    expect(response.status).toBe(422);
    expect(h.codec.calls).toBe(0);
  });

  it("allows 16 fields of 6,000 characters and refuses a 17th field or a 6,001st character", async () => {
    const h = await users();
    const fields = (count: number, length: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`f${i}`, "x".repeat(length)]));
    const send = (extra: Record<string, string>) =>
      upload(h, h.users.alice, mediaForm(bytes(PNG_PLAIN), extra, "a.png", "image/png"));
    expect((await send(fields(16, 6000))).status).toBe(200);
    expect((await send(fields(17, 1))).status).toBe(422);
    expect((await send({ f: "x".repeat(6001) })).status).toBe(422);
  });
});

describe("duplicate media attributes", () => {
  it("uses the last value per attachment, so an edit that ends unchanged records nothing", async () => {
    const h = await users();
    const { alice } = h.users;
    const media = await uploaded(h, alice, png());
    const status = await post(h, alice, { status: "x", media_ids: [media.id] });
    const response = await h.request(
      `/api/v1/statuses/${status.id}`,
      bearer(
        alice.token,
        json(
          {
            status: "x",
            media_ids: [media.id],
            media_attributes: [
              { id: media.id, focus: "1,1" },
              { id: media.id, focus: "0,0" },
            ],
          },
          { method: "PUT" },
        ),
      ),
    );
    expect(response.status).toBe(200);
    expect((await getJson<unknown[]>(h, `/api/v1/statuses/${status.id}/history`, alice.token)).body).toHaveLength(1);
  });
});

// MEDIA-5: a custom emoji's image is never deleted, disabled or not, and never reached through the media API, whatever
// the sweep and reconciliation do to the uploads around it (the positive controls, which they must still clean up).
describe("custom emoji images after every grace period", () => {
  const DAY = 24 * HOUR;

  it("keeps both emoji and their files while an expired upload and a due tombstone are cleaned up", async () => {
    const h = await users();
    const admin = h.users.alice;
    // alice is the OAuth admin (admin_email), so the emoji images are hers.
    await setAccess(h.store, { admin_email: "alice@example.com" });
    const authority = { ...ACCESS, email: "alice@example.com" };
    const enabled = await added(h.store, "kept", { authority });
    const disabled = await added(h.store, "gone", { authority });
    await h.store.updateEmoji(BUILD, { authority, id: disabled.id, changes: { disabled: true } });
    const emojiRows = [enabled, disabled].map((emoji) => ({
      id: emoji.id,
      token: new URL(emoji.url).pathname.split("/")[2]!,
    }));
    // Positive controls: an ordinary completed, unattached upload, and a failed one whose tombstone falls due.
    const ordinary = await uploaded(h, admin, png());
    const [control] = await sql<{ file_token: string }>(
      h.store,
      "SELECT file_token FROM media_attachments WHERE id = ?",
      ordinary.id,
    );
    h.codec.failEncode = 9523;
    expect((await upload(h, admin, png())).status).toBe(500);
    h.codec.failEncode = null;
    const [failed] = await sql<{ id: string; file_token: string }>(
      h.store,
      "SELECT id, file_token FROM media_attachments WHERE url = ''",
    );
    const later = Math.max(NOW, Date.now()) + 3 * DAY + HOUR;
    const deps = { build: () => env.CF_VERSION_METADATA.id, store: () => h.store, now: () => later };
    while ((await sweepMedia(env, deps)) > 0) {
      // One bounded batch per run.
    }
    // A late write of the failed upload, which reconciliation deletes once its tombstone is due.
    await env.MEDIA.put(`files/${failed!.file_token}/full`, "late");
    // The tombstone falls due ORPHAN_GRACE_MS after the sweep that left it.
    expect(await reconcileMedia(env, { ...deps, now: () => later + DAY })).toBe(1);
    expect(await env.MEDIA.head(`files/${failed!.file_token}/full`)).toBeNull();
    expect(await sql(h.store, "SELECT id FROM media_attachments WHERE id IN (?, ?)", ordinary.id, failed!.id)).toEqual(
      [],
    );
    for (const key of [
      `originals/${ordinary.id}`,
      `files/${control!.file_token}/full`,
      `files/${control!.file_token}/small`,
    ]) {
      expect(await env.MEDIA.head(key)).toBeNull();
    }
    // Both emoji are kept: their rows with no gc_at, and every object, served.
    for (const { id, token } of emojiRows) {
      expect(await sql(h.store, "SELECT gc_at, processed FROM media_attachments WHERE id = ?", id)).toEqual([
        { gc_at: null, processed: 1 },
      ]);
      for (const key of [`originals/${id}`, `files/${token}/full`, `files/${token}/small`]) {
        expect(await env.MEDIA.head(key)).not.toBeNull();
      }
      expect((await h.request(`/media/${token}/full.png`)).status).toBe(200);
    }
    // The OAuth admin cannot reach them through the media API, a post, a scheduled post or a profile image.
    for (const { id } of emojiRows) {
      expect((await h.request(`/api/v1/media/${id}`, bearer(admin.token))).status).toBe(404);
      expect(
        (await h.request(`/api/v1/media/${id}`, bearer(admin.token, json({ description: "x" }, { method: "PUT" }))))
          .status,
      ).toBe(404);
      expect((await h.request(`/api/v1/media/${id}`, bearer(admin.token, { method: "DELETE" }))).status).toBe(404);
      const refused = { error: `Media ${id} not found or already attached to another post` };
      const posted = await h.request("/api/v1/statuses", bearer(admin.token, json({ status: "x", media_ids: [id] })));
      expect([posted.status, await posted.json()]).toEqual([422, refused]);
      const scheduled = await h.request(
        "/api/v1/statuses",
        bearer(admin.token, json({ status: "x", media_ids: [id], scheduled_at: new Date(NOW + DAY).toISOString() })),
      );
      expect([scheduled.status, await scheduled.json()]).toEqual([422, refused]);
      expect(await sql(h.store, "SELECT scheduled_status_id FROM media_attachments WHERE id = ?", id)).toEqual([
        { scheduled_status_id: null },
      ]);
      const credential = { tokenHash: await sha256Hex(admin.token), scope: "write", now: NOW } as const;
      expect(
        await h.store.updateCredentials(BUILD, {
          credential,
          changes: {},
          images: { avatar: id },
          present: { origin: "https://kopje.test" },
          now: NOW,
        }),
      ).toMatchObject({
        status: "ok",
        value: { status: "upload_gone" },
      });
    }
    // A raw delete of an emoji's image fails on the foreign key.
    await expect(sql(h.store, "DELETE FROM media_attachments WHERE id = ?", enabled.id)).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    );
  }, 60_000);

  it("keeps an emoji whose image an imported avatar_url names when the avatar is replaced", async () => {
    const h = await users();
    await setAccess(h.store, { admin_email: "alice@example.com" });
    const authority = { ...ACCESS, email: "alice@example.com" };
    const emoji = await added(h.store, "face", { authority });
    await sql(h.store, "UPDATE accounts SET avatar_url = ? WHERE id = ?", emoji.url, h.users.alice.id);
    const replacement = await uploaded(h, h.users.alice, png());
    const credential = { tokenHash: await sha256Hex(h.users.alice.token), scope: "write", now: NOW } as const;
    expect(
      await h.store.updateCredentials(BUILD, {
        credential,
        changes: {},
        images: { avatar: replacement.id },
        present: { origin: "https://kopje.test" },
        now: NOW,
      }),
    ).toMatchObject({
      status: "ok",
      value: { status: "ok" },
    });
    expect(await sql(h.store, "SELECT gc_at FROM media_attachments WHERE id = ?", emoji.id)).toEqual([{ gc_at: null }]);
  });
});
