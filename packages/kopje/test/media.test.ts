import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { TRANSFORMS_PER_UPLOAD, UPLOAD_BUDGET } from "../src/domain/media";
import { handleScheduled } from "../src/jobs/scheduled";
import { sweepMedia, UPLOAD_SAVE_RESERVE_MS } from "../src/mastodon/media";
import { accountMonthlyTransforms, readConfig } from "../src/platform/config";
import { retainedMetadata } from "../src/platform/image-bytes";
import { RGBA_CALL_MS, RGBA_MIN_CALL_MS } from "../src/platform/images";
import { sha256Hex } from "../src/security/tokens";
import { bearer, json, login, settle, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import {
  GIF,
  JPEG_WITH_GPS,
  PNG_PLAIN,
  PNG_WITH_GPS,
  WEBP_ICC,
  WEBP_SERIAL,
  WEBP_XMP,
  WIDE_PNG,
} from "./fixtures/images";
import { BUILD } from "./helpers";
import {
  type Attachment,
  bytes,
  mediaForm,
  pathOf,
  pngWithChunk,
  r2Keys,
  TestCodec,
  upload,
  uploaded,
} from "./media-helpers";
import {
  community,
  getJson,
  mediaNotFound,
  outbound,
  post,
  posting,
  remoteAccount,
  remoteFollows,
  type Status,
} from "./status-helpers";

const HOUR = 60 * 60 * 1000;

async function users(names: readonly string[] = ["alice", "bob"], codec = new TestCodec()) {
  const h = await community(names as ["alice", "bob"], "read write follow", { images: () => codec });
  return { ...h, codec };
}

function sweep(h: { store: Parameters<typeof sql>[0] }, at: number) {
  return sweepMedia(env, { build: () => env.CF_VERSION_METADATA.id, now: () => at, store: () => h.store });
}

async function row(h: { store: Parameters<typeof sql>[0] }, id: string) {
  const [found] = await sql<{ file_token: string; status_id: string | null; gc_at: string | null; processed: number }>(
    h.store,
    "SELECT file_token, status_id, gc_at, processed FROM media_attachments WHERE id = ?",
    id,
  );
  return found;
}

async function keysOf(h: { store: Parameters<typeof sql>[0] }, id: string): Promise<string[]> {
  const found = await row(h, id);
  if (found === undefined) {
    throw new Error(`no media row ${id}`);
  }
  return [`files/${found.file_token}/full`, `files/${found.file_token}/small`, `originals/${id}`];
}

async function stored(keys: string[]): Promise<string[]> {
  const present: string[] = [];
  for (const key of keys) {
    if ((await env.MEDIA.head(key)) !== null) {
      present.push(key);
    }
  }
  return present;
}

describe("POST /api/v2/media", () => {
  it("reads the last of repeated file parts, as Rails assigns them", async () => {
    const h = await users();
    const stringThenFile = new FormData();
    stringThenFile.append("file", "x");
    stringThenFile.append("file", new File([bytes(PNG_PLAIN)], "p.png", { type: "image/png" }));
    expect((await upload(h, h.users.alice, stringThenFile)).status).toBe(200);
    const fileThenString = mediaForm(bytes(PNG_PLAIN), { file: "x" }, "p.png", "image/png");
    const refused = await upload(h, h.users.alice, fileThenString);
    expect([refused.status, await refused.json()]).toEqual([422, { error: "Validation failed: File can't be blank" }]);
  });

  it("re-encodes an image without its location, keeps the original private, and serves only the re-encoding (MEDIA-3)", async () => {
    const h = await users();
    const media = await uploaded(h, h.users.alice, mediaForm(bytes(JPEG_WITH_GPS), { description: "a red square" }));
    expect(media).toMatchObject({
      type: "image",
      description: "a red square",
      meta: {
        original: { width: 80, height: 60, size: "80x60", aspect: 80 / 60 },
        small: { width: 80, height: 60 },
        focus: { x: 0, y: 0 },
      },
    });
    expect(media.url).toMatch(/^https:\/\/kopje\.test\/media\/[A-Za-z0-9_-]{32,64}\/full\.webp$/);
    expect(media.preview_url).toMatch(/^https:\/\/kopje\.test\/media\/[A-Za-z0-9_-]{32,64}\/small\.webp$/);
    const served = await h.request(pathOf(media.url));
    expect(served.status).toBe(200);
    // JPEG becomes WebP, for which Images discards all metadata.
    expect(served.headers.get("content-type")).toBe("image/webp");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    const body = new Uint8Array(await served.arrayBuffer());
    expect(retainedMetadata(body, "image/webp")).toBeNull();
    expect(body).not.toEqual(bytes(JPEG_WITH_GPS));
    // The original is stored as uploaded, under its id, and no URL reaches it.
    const original = await env.MEDIA.get(`originals/${media.id}`);
    expect(new Uint8Array(await (original as R2ObjectBody).arrayBuffer())).toEqual(bytes(JPEG_WITH_GPS));
    expect(await row(h, media.id)).toMatchObject({ processed: 1, status_id: null });
  });

  it("caps the long edge and makes a preview; PNG stays PNG, GIF becomes WebP", async () => {
    const h = await users();
    const wide = await uploaded(h, h.users.alice, mediaForm(bytes(WIDE_PNG), {}, "wide.png", "image/png"));
    expect(wide.meta).toMatchObject({ original: { width: 3840, height: 960 }, small: { width: 640, height: 160 } });
    expect(wide.url).toMatch(/\/full\.png$/);
    expect(h.codec.encodeCalls).toEqual([
      { width: 3840, height: 960, format: "image/png" },
      { width: 640, height: 160, format: "image/png", still: true },
      { width: 640, height: 160, format: "rgba", limit: 4 * 640 * 160, guard: expect.any(Function) },
    ]);
    const gif = await uploaded(h, h.users.alice, mediaForm(bytes(GIF), {}, "a.gif", "image/gif"));
    expect(gif.url).toMatch(/\/full\.webp$/);
    expect((await h.request(pathOf(gif.preview_url))).headers.get("content-type")).toBe("image/webp");
  });

  it("accepts v1 too, with description and focus", async () => {
    const h = await users();
    const response = await upload(
      h,
      h.users.alice,
      mediaForm(bytes(PNG_WITH_GPS), { description: "alt", focus: "0.5,-2" }, "p.png", "image/png"),
      "v1",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ description: "alt", meta: { focus: { x: 0.5, y: -1 } } });
  });

  it("refuses a failed transformation and serves nothing (MEDIA-3)", async () => {
    const h = await users();
    h.codec.failEncode = 9523;
    const response = await upload(h, h.users.alice, mediaForm(bytes(JPEG_WITH_GPS)));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Error processing uploaded media" });
    const [doomed] = await sql<{ id: string }>(h.store, "SELECT id FROM media_attachments");
    expect(doomed).toBeDefined();
    const id = (doomed as { id: string }).id;
    // Neither the original nor a file reached R2, the row cannot be read or attached, and the sweep removes it.
    expect(await stored(await keysOf(h, id))).toEqual([]);
    expect((await getJson(h, `/api/v1/media/${id}`, h.users.alice.token)).status).toBe(404);
    const attach = await h.request("/api/v1/statuses", bearer(h.users.alice.token, json({ media_ids: [id] })));
    expect(attach.status).toBe(422);
    expect(await sweep(h, NOW)).toBe(1);
    expect(await row(h, id)).toBeUndefined();
  });

  // The codec stands in for an Images output that kept metadata; each is refused and nothing stays in R2.
  const KEPT: [string, string, Uint8Array][] = [
    ["a WebP EXIF chunk with a serial number and no GPS", "jpeg", bytes(WEBP_SERIAL)],
    ["WebP XMP", "jpeg", bytes(WEBP_XMP)],
    ["PNG eXIf with GPS", "png", bytes(PNG_WITH_GPS)],
    ["PNG tEXt", "png", pngWithChunk(bytes(PNG_PLAIN), "tEXt", "Author\0alice")],
    ["PNG iTXt", "png", pngWithChunk(bytes(PNG_PLAIN), "iTXt", "XML:com.adobe.xmp\0\0\0\0\0<x/>")],
  ];
  for (const [name, input, output] of KEPT) {
    it(`refuses an output that keeps ${name}, and deletes what it wrote (MEDIA-3, retained EXIF)`, async () => {
      const h = await users();
      h.codec.encodeResult = output;
      const file =
        input === "jpeg" ? mediaForm(bytes(JPEG_WITH_GPS)) : mediaForm(bytes(WIDE_PNG), {}, "a.png", "image/png");
      const response = await upload(h, h.users.alice, file);
      expect(response.status).toBe(500);
      const [media] = await sql<{ id: string }>(h.store, "SELECT id FROM media_attachments");
      expect(await stored(await keysOf(h, (media as { id: string }).id))).toEqual([]);
    });
  }

  it("accepts an output that keeps only a colour profile", async () => {
    const h = await users();
    h.codec.encodeResult = bytes(WEBP_ICC);
    expect((await upload(h, h.users.alice, mediaForm(bytes(JPEG_WITH_GPS)))).status).toBe(200);
  });

  it("answers 503 when the transformation allowance is used up, and 422 for what Images cannot read", async () => {
    const h = await users();
    h.codec.failInfo = 9422;
    expect((await upload(h, h.users.alice, mediaForm(bytes(JPEG_WITH_GPS)))).status).toBe(503);
    h.codec.failInfo = 9412;
    expect((await upload(h, h.users.alice, mediaForm(bytes(JPEG_WITH_GPS)))).status).toBe(422);
  });

  it("refuses active and unsupported types by their bytes, before Images is called (MEDIA-4)", async () => {
    const h = await users();
    const refused = [
      ["<!doctype html><script>alert(1)</script>", "x.jpg", "image/jpeg"],
      ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "x.svg", "image/svg+xml"],
      [
        new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]),
        "v.mp4",
        "video/mp4",
      ],
      ["ID3\u0004\u0000", "a.mp3", "audio/mpeg"],
    ] as const;
    for (const [file, name, type] of refused) {
      const response = await upload(h, h.users.alice, mediaForm(file, {}, name, type));
      expect(response.status, name).toBe(422);
      expect(await response.json()).toEqual({ error: "Validation failed: File content type is invalid" });
    }
    expect(h.codec.calls).toBe(0);
  });

  it("refuses an image the service reads as another type, and one over the pixel limit (MEDIA-4, RES-1)", async () => {
    const h = await users();
    h.codec.infoResult = { format: "image/svg+xml" };
    expect((await upload(h, h.users.alice, mediaForm(bytes(JPEG_WITH_GPS)))).status).toBe(422);
    const big = await users();
    big.codec.infoResult = { format: "image/jpeg", width: 5000, height: 4000 };
    const response = await upload(big, big.users.alice, mediaForm(bytes(JPEG_WITH_GPS)));
    expect(response.status).toBe(422);
    expect(big.codec.encodeCalls).toEqual([]);
  });

  it("refuses a file over 16 MB without transforming it (RES-1)", async () => {
    const h = await users();
    const huge = new Uint8Array(16 * 1024 * 1024 + 1);
    huge.set(bytes(JPEG_WITH_GPS));
    const response = await upload(h, h.users.alice, mediaForm(huge));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "Validation failed: File file size must be less than 16 MB" });
    expect(h.codec.calls).toBe(0);
  });

  it("refuses an over-long description", async () => {
    const h = await users();
    const response = await upload(h, h.users.alice, mediaForm(bytes(JPEG_WITH_GPS), { description: "x".repeat(1501) }));
    expect(response.status).toBe(422);
    expect(h.codec.calls).toBe(0);
  });

  it("needs a token with write:media before anything is read or transformed", async () => {
    const h = await users();
    const anonymous = await h.request("/api/v2/media", { method: "POST", body: mediaForm(bytes(JPEG_WITH_GPS)) });
    expect(anonymous.status).toBe(401);
    const { token } = await login(h, { scope: "read", email: "alice@example.com" });
    const reader = await h.request(
      "/api/v2/media",
      bearer(token, { method: "POST", body: mediaForm(bytes(JPEG_WITH_GPS)) }),
    );
    expect(reader.status).toBe(403);
    expect(h.codec.calls).toBe(0);
    expect(await sql(h.store, "SELECT id FROM media_attachments")).toEqual([]);
  });

  it(`counts upload attempts, so upload and delete cannot loop past ${UPLOAD_BUDGET.count} in 30 minutes (RES-6)`, async () => {
    const h = await users();
    const { alice, bob } = h.users;
    for (let i = 0; i < UPLOAD_BUDGET.count; i++) {
      const media = await uploaded(h, alice, mediaForm(bytes(PNG_PLAIN), {}, "a.png", "image/png"));
      const status = await post(h, alice, { status: `${i}`, media_ids: [media.id] });
      await h.request(`/api/v1/statuses/${status.id}?delete_media=true`, bearer(alice.token, { method: "DELETE" }));
    }
    expect(await sql(h.store, "SELECT id FROM media_attachments")).toEqual([]);
    const calls = h.codec.calls;
    const response = await upload(h, alice, mediaForm(bytes(PNG_PLAIN), {}, "a.png", "image/png"));
    expect(response.status).toBe(429);
    expect(h.codec.calls).toBe(calls);
    // Another account has its own budget, and the window moves on.
    expect((await upload(h, bob, mediaForm(bytes(PNG_PLAIN), {}, "a.png", "image/png"))).status).toBe(200);
    h.now.mockReturnValue(NOW + 31 * 60 * 1000);
    expect((await upload(h, alice, mediaForm(bytes(PNG_PLAIN), {}, "a.png", "image/png"))).status).toBe(200);
  }, 30_000);

  it("counts failed uploads too (RES-6)", async () => {
    const h = await users();
    h.codec.failEncode = 9523;
    for (let i = 0; i < UPLOAD_BUDGET.count; i++) {
      expect((await upload(h, h.users.alice, mediaForm(bytes(PNG_PLAIN), {}, "a.png", "image/png"))).status).toBe(500);
      await sweep(h, NOW);
    }
    const calls = h.codec.calls;
    expect((await upload(h, h.users.alice, mediaForm(bytes(PNG_PLAIN), {}, "a.png", "image/png"))).status).toBe(429);
    expect(h.codec.calls).toBe(calls);
  }, 30_000);

  it("stops one account at its monthly share without locking out the others (RES-6, R4)", async () => {
    const base = readConfig(env);
    expect(base.ok && accountMonthlyTransforms(base.config)).toBe(400);
    const custom = readConfig({ ...env, IMAGES_ACCOUNT_MONTHLY_TRANSFORMS: "6" });
    expect(custom.ok && accountMonthlyTransforms(custom.config)).toBe(6);
    const h = await users();
    const month = new Date(NOW).toISOString().slice(0, 7);
    await sql(
      h.store,
      "INSERT INTO kopje_state (name, value) VALUES (?, ?)",
      `images_account_transforms:${month}:${h.users.alice.id}`,
      String(400 - TRANSFORMS_PER_UPLOAD),
    );
    expect((await upload(h, h.users.alice, mediaForm(bytes(PNG_PLAIN), {}, "a.png", "image/png"))).status).toBe(200);
    const calls = h.codec.calls;
    const refused = await upload(h, h.users.alice, mediaForm(bytes(PNG_PLAIN), {}, "a.png", "image/png"));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "Your media processing budget for the month is used up" });
    expect(h.codec.calls).toBe(calls);
    expect((await upload(h, h.users.bob, mediaForm(bytes(PNG_PLAIN), {}, "a.png", "image/png"))).status).toBe(200);
  });

  it("stops all uploads once the monthly Images budget is reserved, before any transformation (RES-6)", async () => {
    const base = readConfig(env);
    expect(base.ok && base.config.IMAGES_MONTHLY_TRANSFORMS).toBe(4000);
    const custom = readConfig({ ...env, IMAGES_MONTHLY_TRANSFORMS: "10" });
    expect(custom.ok && custom.config.IMAGES_MONTHLY_TRANSFORMS).toBe(10);
    const h = await users();
    const month = `images_transforms:${new Date(NOW).toISOString().slice(0, 7)}`;
    await sql(
      h.store,
      "INSERT INTO kopje_state (name, value) VALUES (?, ?)",
      month,
      String(4000 - TRANSFORMS_PER_UPLOAD),
    );
    expect((await upload(h, h.users.alice, mediaForm(bytes(PNG_PLAIN), {}, "a.png", "image/png"))).status).toBe(200);
    const calls = h.codec.calls;
    const refused = await upload(h, h.users.bob, mediaForm(bytes(PNG_PLAIN), {}, "a.png", "image/png"));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "This server's media processing budget for the month is used up" });
    expect(h.codec.calls).toBe(calls);
    // A new month starts a new budget.
    h.now.mockReturnValue(Date.parse("2026-11-01T00:00:00.000Z"));
    expect((await upload(h, h.users.bob, mediaForm(bytes(PNG_PLAIN), {}, "a.png", "image/png"))).status).toBe(200);
  });
});

describe("GET and PUT /api/v1/media/:id", () => {
  it("shows and updates own unattached media only (MEDIA-1, foreign attachment)", async () => {
    const h = await users();
    const { alice, bob } = h.users;
    const media = await uploaded(h, alice, mediaForm(bytes(JPEG_WITH_GPS)));
    expect((await getJson<Attachment>(h, `/api/v1/media/${media.id}`, alice.token)).body).toMatchObject({
      id: media.id,
    });
    expect((await getJson(h, `/api/v1/media/${media.id}`, bob.token)).status).toBe(404);
    const put = (token: string, body: Record<string, unknown>) =>
      h.request(`/api/v1/media/${media.id}`, bearer(token, json(body, { method: "PUT" })));
    expect((await put(bob.token, { description: "mine now" })).status).toBe(404);
    const updated = await put(alice.token, { description: "described", focus: "-0.25,0.75" });
    expect(await updated.json()).toMatchObject({ description: "described", meta: { focus: { x: -0.25, y: 0.75 } } });
    expect((await put(alice.token, { description: "x".repeat(1501) })).status).toBe(422);

    // bob cannot attach it; alice can, after which it is no longer read or updated through /media.
    expect(await posting(h, bob.token, { status: "x", media_ids: [media.id] })).toEqual(mediaNotFound(media.id));
    expect(await sql(h.store, "SELECT id FROM statuses")).toEqual([]);
    const status = await post(h, alice, { status: "with media", media_ids: [media.id] });
    expect(status.media_attachments).toMatchObject([{ id: media.id, description: "described" }]);
    expect((await getJson(h, `/api/v1/media/${media.id}`, alice.token)).status).toBe(404);
    expect((await put(alice.token, { description: "later" })).status).toBe(404);
    // Attached media cannot be moved to another status either.
    expect(await posting(h, alice.token, { status: "other", media_ids: [media.id] })).toEqual(mediaNotFound(media.id));
    expect(await sql(h.store, "SELECT id FROM statuses")).toEqual([{ id: status.id }]);
  });
});

describe("PATCH and DELETE /api/v1/media/:id", () => {
  it("updates through PATCH as through PUT", async () => {
    const h = await users();
    const { alice, bob } = h.users;
    const media = await uploaded(h, alice, mediaForm(bytes(JPEG_WITH_GPS)));
    const patch = (token: string, body: Record<string, unknown>) =>
      h.request(`/api/v1/media/${media.id}`, bearer(token, json(body, { method: "PATCH" })));
    expect((await patch(bob.token, { description: "mine now" })).status).toBe(404);
    const updated = await patch(alice.token, { description: "patched", focus: "0.5,-0.5" });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ description: "patched", meta: { focus: { x: 0.5, y: -0.5 } } });
    expect((await patch(alice.token, { description: "x".repeat(1501) })).status).toBe(422);
  });

  it("deletes own unattached media with its R2 objects, and nobody else’s (MEDIA-1)", async () => {
    const h = await users();
    const { alice, bob } = h.users;
    const media = await uploaded(h, alice, mediaForm(bytes(JPEG_WITH_GPS)));
    const keys = await keysOf(h, media.id);
    const destroy = (token: string, id = media.id) =>
      h.request(`/api/v1/media/${id}`, bearer(token, { method: "DELETE" }));
    const foreign = await destroy(bob.token);
    expect([foreign.status, await foreign.json()]).toEqual([404, { error: "Record not found" }]);
    expect((await destroy(alice.token, "999999999999999999")).status).toBe(404);
    expect(await stored(keys)).toEqual(keys);

    const deleted = await destroy(alice.token);
    expect([deleted.status, await deleted.json()]).toEqual([200, {}]);
    expect(await stored(keys)).toEqual([]);
    expect(await row(h, media.id)).toBeUndefined();
    expect((await h.request(pathOf(media.url))).status).toBe(404);
    expect((await destroy(alice.token)).status).toBe(404);
    expect(await posting(h, alice.token, { status: "x", media_ids: [media.id] })).toEqual(mediaNotFound(media.id));
  });

  it("refuses media a status uses, and deletes it once a status deletion detached it", async () => {
    const h = await users();
    const { alice } = h.users;
    const media = await uploaded(h, alice, mediaForm(bytes(JPEG_WITH_GPS)));
    const keys = await keysOf(h, media.id);
    const status = await post(h, alice, { status: "x", media_ids: [media.id] });
    const destroy = () => h.request(`/api/v1/media/${media.id}`, bearer(alice.token, { method: "DELETE" }));
    const refused = await destroy();
    expect([refused.status, await refused.json()]).toEqual([
      422,
      { error: "Media attachment is currently used by a status" },
    ]);
    expect(await stored(keys)).toEqual(keys);
    expect(await row(h, media.id)).toMatchObject({ status_id: status.id });

    // Deleting the status keeps the media for a redraft; deleting the media then removes it at once.
    await h.request(`/api/v1/statuses/${status.id}`, bearer(alice.token, { method: "DELETE" }));
    expect((await destroy()).status).toBe(200);
    expect(await stored(keys)).toEqual([]);
    expect(await row(h, media.id)).toBeUndefined();
  });
});

describe("media an edit drops", () => {
  async function dropped(h: Awaited<ReturnType<typeof users>>) {
    const { alice } = h.users;
    await remoteFollows(h.store, await remoteAccount(h.store, "fan"), alice.id);
    const [kept, drop] = [
      await uploaded(h, alice, mediaForm(bytes(JPEG_WITH_GPS), { description: "kept" })),
      await uploaded(h, alice, mediaForm(bytes(JPEG_WITH_GPS), { description: "dropped" })),
    ];
    const status = await post(h, alice, { status: "two", media_ids: [kept.id, drop.id] });
    const edit = await h.request(
      `/api/v1/statuses/${status.id}`,
      bearer(alice.token, json({ status: "one", media_ids: [kept.id] }, { method: "PUT" })),
    );
    expect(edit.status).toBe(200);
    expect(((await edit.json()) as Status).media_attachments).toMatchObject([{ id: kept.id }]);
    return { status, kept, drop, keys: await keysOf(h, drop.id) };
  }

  it("stays with its status for the history, however long after the grace period", async () => {
    const h = await users();
    const { alice, bob } = h.users;
    const { status, kept, drop, keys } = await dropped(h);

    expect(await sweep(h, NOW + 30 * 24 * HOUR)).toBe(0);
    expect(await stored(keys)).toEqual(keys);
    expect(await row(h, drop.id)).toMatchObject({ status_id: status.id, gc_at: null });
    const history = await getJson<{ media_attachments: { id: string; url: string }[] }[]>(
      h,
      `/api/v1/statuses/${status.id}/history`,
      bob.token,
    );
    expect(history.body.map((version) => version.media_attachments.map((m) => m.id))).toEqual([
      [kept.id, drop.id],
      [kept.id],
    ]);
    expect(history.body[0]?.media_attachments[1]?.url).toBe(drop.url);
    expect((await h.request(pathOf(drop.url))).status).toBe(200);
    // The status shows only what it shows now, in the API and in the Update.
    expect((await getJson<Status>(h, `/api/v1/statuses/${status.id}`, bob.token)).body.media_attachments).toMatchObject(
      [{ id: kept.id }],
    );
    // The activity the edit recorded (an Update, or the Create of the current version still pending) carries it.
    const latest = (await outbound(h.store)).at(-1)?.activity.object as { attachment: { url: string }[] };
    expect(latest.attachment.map((a) => a.url)).toEqual([kept.url]);
    // It is the status's: neither shown, updated nor deleted as an upload.
    expect((await h.request(`/api/v1/media/${drop.id}`, bearer(alice.token))).status).toBe(404);
    const destroy = await h.request(`/api/v1/media/${drop.id}`, bearer(alice.token, { method: "DELETE" }));
    expect([destroy.status, await destroy.json()]).toEqual([
      422,
      { error: "Media attachment is currently used by a status" },
    ]);
  });

  it("may be shown again by a later edit of the same status, and by nothing else", async () => {
    const h = await users();
    const { alice } = h.users;
    const { status, kept, drop } = await dropped(h);

    expect(await posting(h, alice.token, { status: "other", media_ids: [drop.id] })).toEqual(mediaNotFound(drop.id));
    const scheduled = await posting(h, alice.token, {
      status: "later",
      media_ids: [drop.id],
      scheduled_at: new Date(NOW + HOUR).toISOString(),
    });
    expect(scheduled).toEqual(mediaNotFound(drop.id));
    expect(await sql(h.store, "SELECT id FROM scheduled_statuses")).toEqual([]);
    // An edit of another status cannot take it: the edit target is a status made without it.
    const other = await post(h, alice, { status: "other" });
    const otherEdit = await h.request(
      `/api/v1/statuses/${other.id}`,
      bearer(alice.token, json({ status: "other", media_ids: [drop.id] }, { method: "PUT" })),
    );
    expect({ status: otherEdit.status, body: await otherEdit.json() }).toEqual(mediaNotFound(drop.id));
    expect(await row(h, drop.id)).toMatchObject({ status_id: status.id });

    const again = await h.request(
      `/api/v1/statuses/${status.id}`,
      bearer(alice.token, json({ status: "both", media_ids: [drop.id, kept.id] }, { method: "PUT" })),
    );
    expect(again.status).toBe(200);
    expect(((await again.json()) as Status).media_attachments).toMatchObject([{ id: drop.id }, { id: kept.id }]);
  });

  it("goes with its status, after the grace period or at once with delete_media", async () => {
    for (const deleteMedia of [false, true]) {
      const h = await users();
      const { alice } = h.users;
      const { status, kept, drop, keys } = await dropped(h);
      const deleted = await h.request(
        `/api/v1/statuses/${status.id}${deleteMedia ? "?delete_media=true" : ""}`,
        bearer(alice.token, { method: "DELETE" }),
      );
      expect(deleted.status).toBe(200);
      expect(((await deleted.json()) as Status).media_attachments).toMatchObject([{ id: kept.id }]);
      // The answer's media is detached at once, the media the edit dropped by the status's job, with the same
      // deadline (MEDIA-1).
      expect(await sql(h.store, "SELECT id FROM media_attachments WHERE status_id IS NOT NULL")).toEqual([
        { id: drop.id },
      ]);
      await settle(h.store);
      expect(await sql(h.store, "SELECT id FROM media_attachments WHERE status_id IS NOT NULL")).toEqual([]);
      expect(new Set((await sql(h.store, "SELECT gc_at FROM media_attachments")).map((m) => m.gc_at)).size).toBe(1);
      if (!deleteMedia) {
        expect(await sweep(h, NOW + 23 * HOUR)).toBe(0);
        expect(await stored(keys)).toEqual(keys);
      }
      // With delete_media the sweep after the answer took the media it doomed; the media its job doomed goes with the
      // next sweep.
      expect(await sweep(h, NOW + 25 * HOUR)).toBe(deleteMedia ? 1 : 2);
      expect(await stored(keys)).toEqual([]);
      expect(await row(h, drop.id)).toBeUndefined();
      expect(await row(h, kept.id)).toBeUndefined();
    }
  });
});

describe("media the cutover kept", () => {
  it("refuses to delete an image the cutover kept unattached, and keeps its files", async () => {
    const h = await users();
    const { alice } = h.users;
    const status = await post(h, alice, { status: "edited" });
    // A row migration 0015_media_shown did not link to a status: unattached and processed, of the author, with a
    // file token and no gc_at. The earlier version naming it is written after the Store was migrated.
    const id = "100000000000000088";
    const token = "E".repeat(43);
    const url = `https://kopje.test/media/${token}/full.png`;
    await sql(
      h.store,
      `INSERT INTO media_attachments (id, account_id, status_id, position, type, url, preview_url, description, meta,
				file_token, content_type, processed, legacy_ap_o, created_at)
			VALUES (?, ?, NULL, 0, 'image', ?, ?, '', NULL, ?, 'image/png', 1, NULL, ?)`,
      id,
      alice.id,
      url,
      `https://kopje.test/media/${token}/small.png`,
      token,
      new Date(NOW).toISOString(),
    );
    await sql(
      h.store,
      "INSERT INTO status_edits (status_id, content, media_json, created_at) VALUES (?, ?, ?, ?)",
      status.id,
      "<p>before</p>",
      JSON.stringify([{ id, type: "image", url }]),
      new Date(NOW).toISOString(),
    );
    const keys = [`files/${token}/full`, `files/${token}/small`, `originals/${id}`];
    for (const key of keys) {
      await env.MEDIA.put(key, bytes(PNG_PLAIN));
    }

    const refused = await h.request(`/api/v1/media/${id}`, bearer(alice.token, { method: "DELETE" }));
    expect([refused.status, await refused.json()]).toEqual([
      422,
      { error: "Media attachment is currently used by a status" },
    ]);
    expect(await row(h, id)).toMatchObject({ status_id: null, gc_at: null });
    expect(await sweep(h, NOW + 30 * 24 * HOUR)).toBe(0);
    expect(await stored(keys)).toEqual(keys);
  });
});

describe("explicit deletion", () => {
  it("is final for a post or schedule that started before it", async () => {
    const h = await users();
    const { alice } = h.users;
    const [deleted, held, viaStatus] = [
      await uploaded(h, alice, mediaForm(bytes(JPEG_WITH_GPS))),
      await uploaded(h, alice, mediaForm(bytes(JPEG_WITH_GPS))),
      await uploaded(h, alice, mediaForm(bytes(JPEG_WITH_GPS))),
    ];
    const status = await post(h, alice, { status: "x", media_ids: [viaStatus.id] });
    // The Store commits the deletions at a later time than the requests below carry (the harness clock stays at
    // NOW). They are called directly, so no sweep removes the rows before those requests run.
    const later = NOW + 60_000;
    const credential = { tokenHash: await sha256Hex(alice.token), scope: "write", now: later } as const;
    for (const id of [deleted.id, held.id]) {
      expect(await h.store.deleteMedia(BUILD, { credential, id, now: later })).toEqual({
        status: "ok",
        value: "deleted",
      });
    }
    const removed = await h.store.deleteStatus(BUILD, {
      credential,
      id: status.id,
      deleteMedia: true,
      now: later,
      present: { origin: "https://kopje.test" },
    });
    expect(removed.status).toBe("ok");

    expect(await posting(h, alice.token, { status: "late", media_ids: [deleted.id, viaStatus.id] })).toEqual(
      mediaNotFound(deleted.id, viaStatus.id),
    );
    const scheduled = await posting(h, alice.token, {
      status: "later",
      media_ids: [held.id],
      scheduled_at: new Date(NOW + HOUR).toISOString(),
    });
    expect(scheduled).toEqual(mediaNotFound(held.id));
    expect(await sql(h.store, "SELECT id FROM statuses WHERE id <> ?", status.id)).toEqual([]);
    expect(
      await sql(
        h.store,
        "SELECT id FROM media_attachments WHERE status_id IS NOT NULL OR scheduled_status_id IS NOT NULL",
      ),
    ).toEqual([]);
    // The sweep then deletes all three.
    expect(await sweep(h, NOW)).toBe(3);
  });
});

describe("GET /media/:token/:file", () => {
  it("serves only well-formed paths of served files (MEDIA-2, unsafe R2 key)", async () => {
    const h = await users();
    const media = await uploaded(h, h.users.alice, mediaForm(bytes(JPEG_WITH_GPS)));
    const token = (/\/media\/([^/]+)\//.exec(media.url ?? "") ?? [])[1] ?? "";
    for (const path of [
      `/media/${token}/original.jpg`,
      `/media/${token}/full.html`,
      `/media/${token}/full`,
      `/media/${token}%2F..%2F..%2Foriginals%2F${media.id}/full.jpg`,
      `/media/..%2Foriginals%2F${media.id}/full.jpg`,
      `/media/originals/${media.id}`,
      `/media/${token}/../../originals/${media.id}`,
      `/media/${"A".repeat(43)}/full.jpg`,
    ]) {
      const response = await h.request(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("content-type"), path).not.toMatch(/^image\//);
    }
  });

  it("never serves a stored object of another type, whatever its metadata says (MEDIA-4)", async () => {
    const h = await users();
    const token = "B".repeat(43);
    await env.MEDIA.put(`files/${token}/full`, "<script>alert(1)</script>", {
      httpMetadata: { contentType: "text/html" },
    });
    await env.MEDIA.put(`files/${token}/small`, "<svg/>", { httpMetadata: { contentType: "image/svg+xml" } });
    expect((await h.request(`/media/${token}/full.jpg`)).status).toBe(404);
    expect((await h.request(`/media/${token}/small.webp`)).status).toBe(404);
    // A served type under the wrong extension is refused too.
    await env.MEDIA.put(`files/${token}/full`, bytes(WIDE_PNG), { httpMetadata: { contentType: "image/png" } });
    expect((await h.request(`/media/${token}/full.jpg`)).status).toBe(404);
    const png = await h.request(`/media/${token}/full.png`);
    expect(png.status).toBe(200);
    expect(png.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  });
});

describe("media lifecycle", () => {
  it("deletes the R2 objects of a status deleted with delete_media, and federates the Delete", async () => {
    const h = await users();
    const { alice } = h.users;
    await remoteFollows(h.store, await remoteAccount(h.store, "fan"), alice.id);
    const media = await uploaded(h, alice, mediaForm(bytes(JPEG_WITH_GPS)));
    const keys = await keysOf(h, media.id);
    const status = await post(h, alice, { status: "x", media_ids: [media.id] });
    const deleted = await h.request(
      `/api/v1/statuses/${status.id}?delete_media=true`,
      bearer(alice.token, { method: "DELETE" }),
    );
    expect(deleted.status).toBe(200);
    expect(await stored(keys)).toEqual([]);
    expect(await row(h, media.id)).toBeUndefined();
    expect((await h.request(pathOf(media.url))).status).toBe(404);
    const activities = (await outbound(h.store)).map((o) => o.activity);
    expect(activities.map((a) => a.type)).toEqual(["Create", "Delete"]);
    expect(activities[1]?.object).toMatchObject({ id: status.uri });
  });

  it("keeps detached media for a redraft, then sweeps it after the grace period", async () => {
    const h = await users();
    const { alice } = h.users;
    const media = await uploaded(h, alice, mediaForm(bytes(JPEG_WITH_GPS)));
    const keys = await keysOf(h, media.id);
    const status = await post(h, alice, { status: "x", media_ids: [media.id] });
    await h.request(`/api/v1/statuses/${status.id}`, bearer(alice.token, { method: "DELETE" }));
    expect(await sweep(h, NOW + 23 * HOUR)).toBe(0);
    expect(await stored(keys)).toEqual(keys);
    const redraft = await post(h, alice, { status: "again", media_ids: [media.id] });
    expect(redraft.media_attachments).toMatchObject([{ id: media.id }]);

    // Deleted again, it is detached again; after a day it can no longer be attached and is swept.
    await h.request(`/api/v1/statuses/${redraft.id}`, bearer(alice.token, { method: "DELETE" }));
    expect(await row(h, media.id)).toMatchObject({ status_id: null });
    expect(await sweep(h, NOW + 25 * HOUR)).toBe(1);
    expect(await stored(keys)).toEqual([]);
    expect(await row(h, media.id)).toBeUndefined();
  });

  it("sweeps a reservation that never completed, and leaves attached media alone", async () => {
    const h = await users();
    const { alice } = h.users;
    const kept = await uploaded(h, alice, mediaForm(bytes(JPEG_WITH_GPS)));
    await post(h, alice, { status: "x", media_ids: [kept.id] });
    await sql(
      h.store,
      `INSERT INTO media_attachments (id, account_id, type, url, file_token, processed, gc_at)
			VALUES ('100000000000000077', ?, 'image', '', ?, 0, ?)`,
      alice.id,
      "C".repeat(43),
      new Date(NOW + HOUR).toISOString(),
    );
    await env.MEDIA.put("originals/100000000000000077", "partial");
    expect(await sweep(h, NOW + 30 * 60 * 1000)).toBe(0);
    expect(await sweep(h, NOW + 2 * HOUR)).toBe(1);
    expect(await env.MEDIA.head("originals/100000000000000077")).toBeNull();
    expect(await stored(await keysOf(h, kept.id))).toHaveLength(3);
    expect(await r2Keys(`originals/${kept.id}`)).toEqual([`originals/${kept.id}`]);
  });

  it("runs the sweep from the cron, but not while the env sets maintenance", async () => {
    const h = await users();
    const media = await uploaded(h, h.users.alice, mediaForm(bytes(JPEG_WITH_GPS)));
    const keys = await keysOf(h, media.id);
    const deps = { build: () => env.CF_VERSION_METADATA.id, now: () => NOW + 25 * HOUR, store: () => h.store };
    await handleScheduled({ ...env, MAINTENANCE: "readonly" } as Env, deps);
    expect(await stored(keys)).toEqual(keys);
    await handleScheduled(env, deps);
    expect(await stored(keys)).toEqual([]);
    expect(await row(h, media.id)).toBeUndefined();
  });

  it("presents media in statuses with meta, and publishes its type in the Note", async () => {
    const h = await users();
    await remoteFollows(h.store, await remoteAccount(h.store, "fan"), h.users.alice.id);
    const media = await uploaded(h, h.users.alice, mediaForm(bytes(JPEG_WITH_GPS)));
    const status = await post(h, h.users.alice, { status: "x", media_ids: [media.id] });
    expect(status.media_attachments).toEqual([media]);
    const [create] = await outbound(h.store);
    expect((create!.activity.object as { attachment: unknown }).attachment).toEqual([
      { type: "Document", mediaType: "image/webp", url: media.url, name: null, blurhash: media.blurhash },
    ]);
  });
});

// The blurhash of a local upload (platform/images.ts processImage): its preview's, stored, presented and published in
// the Note's Document with Mastodon's toot:blurhash term; any failure of the RGBA output keeps the upload without one.
describe("the blurhash of a local upload", () => {
  const AP = { headers: { accept: "application/activity+json" } };
  const formats = (codec: TestCodec) => codec.outputs.map((call) => call.options.format);

  async function storedBlurhash(h: { store: Parameters<typeof sql>[0] }, id: string): Promise<unknown> {
    return (
      await sql<{ blurhash: string | null }>(h.store, "SELECT blurhash FROM media_attachments WHERE id = ?", id)
    )[0]?.blurhash;
  }

  it("agrees in the upload answer, GET and the stored row", async () => {
    const h = await users();
    const media = await uploaded(h, h.users.alice, mediaForm(bytes(WIDE_PNG), {}, "w.png", "image/png"));
    expect(media.blurhash).toMatch(/^U.{35}$/);
    const got = await getJson<{ blurhash: string | null }>(h, `/api/v1/media/${media.id}`, h.users.alice.token);
    expect(got.body.blurhash).toBe(media.blurhash);
    expect(await storedBlurhash(h, media.id)).toBe(media.blurhash);
  });

  it.each([9520, 9422])("keeps the upload without one when the RGBA output fails with %i", async (code) => {
    const h = await users();
    h.codec.failRgba = code;
    const warn = vi.spyOn(console, "warn");
    const response = await upload(h, h.users.alice, mediaForm(bytes(WIDE_PNG), {}, "w.png", "image/png"));
    expect(response.status).toBe(200);
    const media = (await response.json()) as Attachment;
    expect(formats(h.codec)).toEqual(["image/png", "image/png", "rgba"]);
    expect(media.blurhash).toBeNull();
    expect(await storedBlurhash(h, media.id)).toBeNull();
    expect((await h.request(pathOf(media.url))).status).toBe(200);
    expect((await h.request(pathOf(media.preview_url))).status).toBe(200);
    expect(warn).toHaveBeenCalledWith({ event: "kopje.media.no_blurhash" });
    warn.mockRestore();
  });

  it.each(["output", "read"] as const)(
    "gives up a stalled RGBA %s before the save reserve and saves the upload without one",
    async (stall) => {
      const h = await users();
      h.codec.stallRgba = stall;
      // Once the preview is made, the clock stands just past RGBA_MIN_CALL_MS before the RGBA output's end.
      const late = NOW + 15 * 60 * 1000 - UPLOAD_SAVE_RESERVE_MS - RGBA_MIN_CALL_MS - 300;
      const encode = h.codec.encode.bind(h.codec);
      h.codec.encode = async (input, options) => {
        const output = await encode(input, options);
        if (options.still === true) {
          h.now.mockReturnValue(late);
        }
        return output;
      };
      const response = await upload(h, h.users.alice, mediaForm(bytes(WIDE_PNG), {}, "w.png", "image/png"));
      expect(response.status).toBe(200);
      const media = (await response.json()) as Attachment;
      expect(formats(h.codec)).toEqual(["image/png", "image/png", "rgba"]);
      expect(media.blurhash).toBeNull();
      expect(h.codec.rgbaCancelled).toBe(stall === "read" ? 1 : 0);
      expect((await h.request(pathOf(media.url))).status).toBe(200);
    },
    30_000,
  );

  it.each(["output", "read"] as const)(
    "gives up a stalled RGBA %s RGBA_CALL_MS after it starts, long before the save reserve, and saves without one",
    async (stall) => {
      const h = await users();
      h.codec.stallRgba = stall;
      // Once the preview is made, a minute after the reservation, each reading of the clock is RGBA_CALL_MS - 300 ms
      // later: the RGBA guard has 300 ms of its cap left, with the save reserve thirteen minutes away.
      const encode = h.codec.encode.bind(h.codec);
      h.codec.encode = async (input, options) => {
        const output = await encode(input, options);
        if (options.still === true) {
          let reads = 0;
          h.now.mockImplementation(() => NOW + 60_000 + reads++ * (RGBA_CALL_MS - 300));
        }
        return output;
      };
      const started = Date.now();
      const response = await upload(h, h.users.alice, mediaForm(bytes(WIDE_PNG), {}, "w.png", "image/png"));
      expect(Date.now() - started).toBeLessThan(25_000);
      expect(response.status).toBe(200);
      const media = (await response.json()) as Attachment;
      expect(formats(h.codec)).toEqual(["image/png", "image/png", "rgba"]);
      expect(media.blurhash).toBeNull();
      expect(h.codec.rgbaCancelled).toBe(stall === "read" ? 1 : 0);
      expect((await h.request(pathOf(media.url))).status).toBe(200);
    },
    30_000,
  );

  it("charges as many transformations as the upload asked Images for", async () => {
    const h = await users();
    const counters = async () =>
      (
        await sql<{ value: string }>(
          h.store,
          "SELECT value FROM kopje_state WHERE name LIKE 'images%transforms:%' ORDER BY name",
        )
      ).map((row) => Number(row.value));
    expect((await upload(h, h.users.alice, mediaForm(bytes(WIDE_PNG), {}, "w.png", "image/png"))).status).toBe(200);
    expect(h.codec.encodeCalls).toHaveLength(3);
    expect(await counters()).toEqual([3, 3]);
  });

  it("publishes a blurhash in each Document that has one, with Mastodon's term, in the Create, Update and outbox", async () => {
    const h = await users();
    const { alice } = h.users;
    await remoteFollows(h.store, await remoteAccount(h.store, "fan"), alice.id);
    const hashed = await uploaded(h, alice, mediaForm(bytes(WIDE_PNG), {}, "w.png", "image/png"));
    h.codec.failRgba = 9520;
    const bare = await uploaded(h, alice, mediaForm(bytes(PNG_PLAIN), {}, "p.png", "image/png"));
    const plain = await uploaded(h, alice, mediaForm(bytes(PNG_PLAIN), {}, "p.png", "image/png"));
    const both = await post(h, alice, { status: "both", media_ids: [hashed.id, bare.id] });
    await post(h, alice, { status: "none", media_ids: [plain.id] });
    await h.request(
      `/api/v1/statuses/${both.id}`,
      bearer(alice.token, json({ status: "both, edited", media_ids: [hashed.id, bare.id] }, { method: "PUT" })),
    );
    const sent = await outbound(h.store);
    type Note = { attachment: Record<string, unknown>[] };
    const documents = (activity: Record<string, unknown> | undefined) => (activity!.object as Note).attachment;
    const contextOf = (activity: Record<string, unknown> | undefined) =>
      (activity!["@context"] as [string, Record<string, unknown>])[1];
    const find = (type: string, content: string) =>
      sent.find(
        (item) =>
          item.activity.type === type &&
          String((item.activity.object as { content: string }).content).includes(content),
      )?.activity;
    const [create, none, update] = [find("Create", "both"), find("Create", "none"), find("Update", "edited")];
    for (const activity of [create, update]) {
      expect(documents(activity)).toEqual([
        expect.objectContaining({ url: hashed.url, blurhash: hashed.blurhash }),
        expect.not.objectContaining({ blurhash: expect.anything() }),
      ]);
      expect(contextOf(activity)).toMatchObject({ toot: "http://joinmastodon.org/ns#", blurhash: "toot:blurhash" });
    }
    expect(documents(none)).toEqual([expect.not.objectContaining({ blurhash: expect.anything() })]);
    expect(contextOf(none)).not.toHaveProperty("blurhash");
    // The object endpoint, the outbox and the featured collection read the Note again through Fedify, which serves the
    // JSON-LD it read: each keeps the blurhash and the term.
    const TERM = { toot: "http://joinmastodon.org/ns#", blurhash: "toot:blurhash" };
    type Served = Note & { id: string; "@context": [string, Record<string, unknown>] };
    const expected = [
      expect.objectContaining({ url: hashed.url, blurhash: hashed.blurhash }),
      expect.not.objectContaining({ blurhash: expect.anything() }),
    ];
    const served = (await (await h.request(new URL(both.uri as string).pathname, AP)).json()) as Served;
    expect(served.attachment).toEqual(expected);
    expect(served["@context"][1]).toMatchObject(TERM);
    const outbox = (await (await h.request("/ap/users/alice/outbox", AP)).json()) as { first: string };
    const first = new URL(outbox.first);
    const page = (await (await h.request(first.pathname + first.search, AP)).json()) as {
      orderedItems: { "@context": [string, Record<string, unknown>]; object: Served }[];
    };
    const listed = page.orderedItems.find((item) => item.object.id === both.uri);
    expect(listed?.object.attachment).toEqual(expected);
    expect(listed?.["@context"][1]).toMatchObject(TERM);
    await h.request(`/api/v1/statuses/${both.id}/pin`, bearer(alice.token, { method: "POST" }));
    const featured = (await (await h.request("/ap/users/alice/collections/featured", AP)).json()) as {
      orderedItems: Served[];
    };
    const pinned = featured.orderedItems.find((item) => item.id === both.uri);
    expect(pinned?.attachment).toEqual(expected);
    expect(pinned?.["@context"][1]).toMatchObject(TERM);
  });
});
