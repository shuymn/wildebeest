import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { run } from "../cli/lib/main.js";
import { Db } from "../src/db/sql";
import { localEmojiSnapshot, localEmojiTags } from "../src/domain/custom-emojis";
import { adminEmojis, completeEmoji, customEmojis } from "../src/domain/local-emojis";
import { expiredMedia, purgeMedia, WRITE_WINDOW_MS } from "../src/domain/media";
import { REBUILD_SETTLE_MS, rebuildCandidates } from "../src/domain/media-rebuild";
import { reconcileMedia, sweepMedia } from "../src/mastodon/media";
import { rebuildMedia } from "../src/mastodon/media-rebuild";
import { EMOJI_IMAGE_LIMIT, EMOJI_PREVIEW_LIMIT } from "../src/platform/emoji-image";
import type { EncodeOptions } from "../src/platform/images";
import type { StoreStub } from "../src/platform/store-client";
import { toStoreUnavailable } from "../src/platform/store-errors";
import { MAX_ENABLED_EMOJIS } from "../src/platform/stored-bounds";
import { adminClaims, adminHarness, adminTeam, serviceClaims, setTeamAccess, type AccessTeam } from "./access-helpers";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { AVIF, GIF, JPEG_WITH_GPS, PNG_PLAIN, WEBP_PLAIN } from "./fixtures/images";
import { BUILD, migratedStore, rejectionOf } from "./helpers";
import { addEmoji, added, base64, emojiStore, pngOf, pngOfBytes } from "./local-emoji-helpers";
import { bytes, r2Keys, TestCodec } from "./media-helpers";
import { ACCESS, copyConfig, dumpViaRpc, importViaRpc, memoryIO } from "./ops-helpers";

// Local custom emoji (migration 0055_local_custom_emojis, domain/local-emojis.ts, mastodon/emoji-upload.ts): the
// Access admin's upload and changes (AUTH-5), the image limits in their units (MEDIA-3, MEDIA-4, RES-1), the atomic
// promotion (MEDIA-2) and the failure paths.

// A codec whose encodes return the given outputs in turn (full, then small), each checked as processImage checks it.
class OutputCodec extends TestCodec {
  constructor(private readonly given: Uint8Array[]) {
    super();
  }

  override encode(bytes: Uint8Array, options: EncodeOptions): Promise<Uint8Array> {
    this.encodeCalls.push(options);
    const next = this.given[this.encodeCalls.length - 1];
    return next === undefined ? this.real.encode(bytes, options) : Promise.resolve(next);
  }
}

async function mediaRow(store: StoreStub, id: string) {
  const [row] = await sql<{ processed: number; gc_at: string | null; url: string; account_id: string }>(
    store,
    "SELECT processed, gc_at, url, account_id FROM media_attachments WHERE id = ?",
    id,
  );
  return row;
}

async function transforms(store: StoreStub): Promise<number> {
  const rows = await sql<{ value: string }>(
    store,
    "SELECT value FROM kopje_state WHERE name LIKE 'images_transforms:%'",
  );
  return Number(rows[0]?.value ?? "0");
}

const logRows = (store: StoreStub) =>
  sql<{ actor: string; action: string; target_type: string; target_id: string }>(
    store,
    "SELECT actor, action, target_type, target_id FROM admin_actions ORDER BY id",
  );

describe("emoji upload", () => {
  it("keeps the image for good with its emoji row, owned by the OAuth admin, and logs it", async () => {
    const { store, adminId } = await emojiStore();
    const codec = new TestCodec();
    const emoji = await added(store, "blobcat", { body: { category: "  Cats  " }, codec });
    // The full image and the preview, and no RGBA: an emoji has no blurhash, and is charged two.
    expect(codec.outputs.map((call) => call.options.format)).toEqual(["image/png", "image/png"]);
    expect(emoji).toEqual({
      id: expect.stringMatching(/^\d{18}$/),
      shortcode: "blobcat",
      url: expect.stringMatching(/^https:\/\/kopje\.test\/media\/[A-Za-z0-9_-]+\/full\.png$/),
      static_url: emoji.url,
      category: "Cats",
      visible_in_picker: true,
      disabled: false,
      created_at: expect.stringMatching(/Z$/),
    });
    expect(await mediaRow(store, emoji.id)).toEqual({ processed: 1, gc_at: null, url: emoji.url, account_id: adminId });
    const token = new URL(emoji.url).pathname.split("/")[2]!;
    expect(await r2Keys()).toEqual(
      expect.arrayContaining([`originals/${emoji.id}`, `files/${token}/full`, `files/${token}/small`]),
    );
    expect(await transforms(store)).toBe(2);
    expect(await logRows(store)).toEqual([
      { actor: "access", action: "create", target_type: "CustomEmoji", target_id: emoji.id },
    ]);
  });

  it("accepts PNG, GIF and WebP, serving GIF and WebP as WebP, and refuses JPEG, AVIF and SVG before reserving", async () => {
    const { store } = await emojiStore();
    expect((await added(store, "png", { image: bytes(PNG_PLAIN) })).url).toMatch(/full\.png$/);
    expect((await added(store, "gif", { image: bytes(GIF) })).url).toMatch(/full\.webp$/);
    expect((await added(store, "webp", { image: bytes(WEBP_PLAIN) })).url).toMatch(/full\.webp$/);
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    for (const image of [bytes(JPEG_WITH_GPS), bytes(AVIF), svg]) {
      expect(await addEmoji(store, "other", { image })).toMatchObject({ ok: false, code: "invalid-image" });
    }
    expect(await sql(store, "SELECT id FROM media_attachments WHERE processed = 0")).toEqual([]);
    expect(await transforms(store)).toBe(6);
  });

  it("accepts an input of 262,143 bytes and refuses 262,144, before anything is charged", async () => {
    const { store } = await emojiStore();
    const at = pngOfBytes(EMOJI_IMAGE_LIMIT - 1, 1024, 60);
    const past = pngOfBytes(EMOJI_IMAGE_LIMIT, 1024, 60);
    expect(at.length).toBe(262_143);
    expect((await addEmoji(store, "at", { image: at })).ok).toBe(true);
    const codec = new TestCodec();
    expect(await addEmoji(store, "past", { image: past, codec })).toMatchObject({
      ok: false,
      code: "image-too-large",
    });
    expect(codec.calls).toBe(0);
    expect(await transforms(store)).toBe(2);
  });

  it("accepts edges of 1,024 and refuses 1,025 on each axis, read by the free info() before the charge", async () => {
    const { store } = await emojiStore();
    expect((await addEmoji(store, "wide", { image: await pngOf(1024, 1) })).ok).toBe(true);
    expect((await addEmoji(store, "tall", { image: await pngOf(1, 1024) })).ok).toBe(true);
    for (const [w, h] of [
      [1025, 1],
      [1, 1025],
    ] as const) {
      const codec = new TestCodec();
      expect(await addEmoji(store, "past", { image: await pngOf(w, h), codec })).toMatchObject({
        ok: false,
        code: "image-too-large",
      });
      expect([codec.infoCalls, codec.encodeCalls.length]).toEqual([1, 0]);
    }
    expect(await transforms(store)).toBe(4);
  });

  it("publishes a full image of 262,143 bytes and refuses 262,144 before any R2 write, keeping the charge", async () => {
    const { store } = await emojiStore();
    const small = await pngOf(8, 8);
    const at = new OutputCodec([pngOfBytes(EMOJI_IMAGE_LIMIT - 1, 1024, 60), small]);
    expect((await addEmoji(store, "at", { codec: at })).ok).toBe(true);
    const before = await r2Keys();
    const past = new OutputCodec([pngOfBytes(EMOJI_IMAGE_LIMIT, 1024, 60), small]);
    expect(await addEmoji(store, "past", { codec: past })).toMatchObject({ ok: false, code: "image-too-large" });
    expect(await r2Keys()).toEqual(before);
    const [reservation] = await sql<{ processed: number; gc_at: string | null; url: string }>(
      store,
      "SELECT processed, gc_at, url FROM media_attachments WHERE url = '' ORDER BY id DESC",
    );
    expect(reservation).toMatchObject({ processed: 1, url: "" });
    expect(reservation?.gc_at).not.toBeNull();
    expect(await transforms(store)).toBe(4);
  });

  it("publishes a preview of 524,288 bytes and refuses 524,289", async () => {
    const { store } = await emojiStore();
    const full = await pngOf(8, 8);
    const at = new OutputCodec([full, pngOfBytes(EMOJI_PREVIEW_LIMIT, 1024, 120)]);
    expect((await addEmoji(store, "at", { codec: at })).ok).toBe(true);
    const past = new OutputCodec([full, pngOfBytes(EMOJI_PREVIEW_LIMIT + 1, 1024, 120)]);
    expect(await addEmoji(store, "past", { codec: past })).toMatchObject({ ok: false, code: "image-too-large" });
  });

  it("refuses a body that is not strict base64, and an Images failure abandons the reservation", async () => {
    const { store } = await emojiStore();
    const image = base64(bytes(PNG_PLAIN));
    const { uploadEmoji } = await import("../src/mastodon/emoji-upload");
    const deps = {
      build: BUILD,
      store,
      bucket: env.MEDIA,
      images: new TestCodec(),
      now: Date.now,
      authority: ACCESS,
      monthlyTransforms: 5000,
      token: "a".repeat(43),
    };
    for (const bad of [` ${image}`, image.slice(0, -1), `${image}\n`]) {
      expect(await uploadEmoji(deps, { shortcode: "aa", image: bad })).toMatchObject({ code: "invalid-image" });
    }
    const failing = new TestCodec();
    failing.failEncode = 9412;
    expect(await addEmoji(store, "aa", { codec: failing })).toMatchObject({ ok: false, code: "invalid-image" });
    const [row] = await sql<{ processed: number; url: string }>(store, "SELECT processed, url FROM media_attachments");
    expect(row).toEqual({ processed: 1, url: "" });
    expect(await sql(store, "SELECT id FROM custom_emojis")).toEqual([]);
  });

  it("refuses shortcodes outside 2 to 128 ASCII letters, digits and underscores", async () => {
    const { store } = await emojiStore();
    expect((await addEmoji(store, "ab")).ok).toBe(true);
    expect((await addEmoji(store, "x".repeat(128))).ok).toBe(true);
    for (const shortcode of ["a", "x".repeat(129), "a+b", "a-b", "café", "a\u0000b", "a:b"]) {
      expect(await addEmoji(store, shortcode)).toMatchObject({ ok: false, code: "invalid-shortcode" });
    }
  });

  it("bounds the category in code points and UTF-8 bytes, refuses controls, normalizes, and reads empty as none", async () => {
    const { store } = await emojiStore();
    // 64 code points of 4 bytes are 256 bytes, the most both bounds allow; a lone surrogate becomes U+FFFD first.
    const accepted: [string, string | null][] = [
      ["日".repeat(64), "日".repeat(64)],
      ["\u{1F600}".repeat(64), "\u{1F600}".repeat(64)],
      ["\uD800x", "\uFFFDx"],
      ["", null],
      ["   ", null],
    ];
    for (const [i, [category, stored]] of accepted.entries()) {
      expect(await addEmoji(store, `ok_${i}`, { body: { category } })).toMatchObject({
        ok: true,
        emoji: { category: stored },
      });
    }
    for (const category of [
      "日".repeat(65),
      "\u{1F600}".repeat(65),
      "a".repeat(257),
      "a\u0001",
      "a\u007f",
      "a\u0000",
    ]) {
      expect(await addEmoji(store, "past", { body: { category } })).toMatchObject({
        ok: false,
        code: "invalid-category",
      });
    }
    const [row] = await sql<{ bytes: number }>(
      store,
      "SELECT length(CAST(category AS BLOB)) AS bytes FROM custom_emojis WHERE shortcode = 'ok_1'",
    );
    expect(row?.bytes).toBe(256);
  });

  it("refuses an enabled shortcode unless replacing, which disables the old emoji in the same transaction", async () => {
    const { store } = await emojiStore();
    const first = await added(store, "blob");
    expect(await addEmoji(store, "blob")).toMatchObject({ ok: false, code: "shortcode-taken" });
    const second = await added(store, "blob", { body: { replace: true } });
    const rows = await sql<{ id: string; disabled: number }>(
      store,
      "SELECT id, disabled FROM custom_emojis ORDER BY id",
    );
    expect(rows).toEqual([
      { id: first.id, disabled: 1 },
      { id: second.id, disabled: 0 },
    ]);
    expect((await logRows(store)).map((row) => [row.action, row.target_id])).toEqual([
      ["create", first.id],
      ["disable", first.id],
      ["create", second.id],
    ]);
    // The replaced emoji's image is kept, as every disabled emoji's.
    expect(await mediaRow(store, first.id)).toMatchObject({ processed: 1, gc_at: null });
  });

  it("refuses with no-oauth-admin when no local account is the OAuth admin, before reserving", async () => {
    const { store } = await emojiStore();
    await sql(store, "UPDATE instance_settings SET value = 'nobody@kopje.test' WHERE name = 'admin_email'");
    const result = await reserveCall(store, "nobody@kopje.test");
    expect(result).toMatchObject({ ok: false, code: "no-oauth-admin" });
    expect(await sql(store, "SELECT id FROM media_attachments")).toEqual([]);
  });

  it("refuses at the monthly budget with budget-exhausted (429), charging nothing", async () => {
    const { store } = await emojiStore();
    expect(await addEmoji(store, "aa", { monthlyTransforms: 1 })).toMatchObject({
      ok: false,
      code: "budget-exhausted",
    });
    expect(await transforms(store)).toBe(0);
  });
});

// The Store with one method's calls passed through `wrap`.
function intercept(
  store: StoreStub,
  name: string,
  wrap: (call: () => Promise<unknown>) => Promise<unknown>,
): StoreStub {
  const stub = store as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  return new Proxy(store, {
    get(_target, key: string) {
      return (...args: unknown[]) => (key === name ? wrap(() => stub[key]!(...args)) : stub[key]!(...args));
    },
  });
}

async function reserveCall(store: StoreStub, email: string) {
  return store.reserveEmoji(BUILD, {
    authority: { ...ACCESS, email },
    token: "b".repeat(43),
    shortcode: "aa",
    replace: false,
    limit: 5000,
  });
}

describe("emoji completion", () => {
  it("is refused after the writer deadline, and the abandoned reservation is swept with a tombstone", async () => {
    const { store } = await emojiStore();
    const reserved = await store.reserveEmoji(BUILD, {
      authority: ACCESS,
      token: "c".repeat(43),
      shortcode: "late",
      replace: false,
      limit: 5000,
    });
    if (!reserved.ok) {
      throw new Error(reserved.code);
    }
    const late = await runInDurableObject(store, (_instance, state) =>
      completeEmoji.run(state.storage.sql, {
        authority: ACCESS,
        id: reserved.id,
        token: "c".repeat(43),
        shortcode: "late",
        category: null,
        visibleInPicker: true,
        replace: false,
        contentType: "image/png",
        original: { width: 1, height: 1 },
        small: { width: 1, height: 1 },
        now: Date.now() + WRITE_WINDOW_MS,
      }),
    );
    expect(late).toMatchObject({ ok: false, code: "upload-expired" });
    expect(await store.abandonEmoji(BUILD, { authority: ACCESS, id: reserved.id, token: "c".repeat(43) })).toBe(
      "abandoned",
    );
    const swept = await sweepMedia(env, { build: () => BUILD, now: () => Date.now() + 60_000, store: () => store });
    expect(swept).toBe(1);
    expect(await sql(store, "SELECT media_id FROM media_orphans")).toEqual([{ media_id: reserved.id }]);
  });

  it("answers a lost first answer on the retry, and keeps the files when both answers are lost", async () => {
    const { store } = await emojiStore();
    let calls = 0;
    const lossy = (lose: number) =>
      intercept(store, "completeEmoji", async (call) => {
        const result = await call();
        if (++calls <= lose) {
          throw new Error("answer lost");
        }
        return result;
      });
    const once = await addEmoji(lossy(1), "once");
    expect(once).toMatchObject({ ok: true, emoji: { shortcode: "once" } });
    calls = 0;
    const token = "d".repeat(43);
    await expect(addEmoji(lossy(2), "twice", { token })).rejects.toThrow("answer lost");
    const [kept] = await sql<{ id: string; processed: number; gc_at: string | null }>(
      store,
      "SELECT m.id, m.processed, m.gc_at FROM custom_emojis e JOIN media_attachments m ON m.id = e.id WHERE e.shortcode = 'twice'",
    );
    expect(kept).toMatchObject({ processed: 1, gc_at: null });
    expect(await r2Keys(`files/${token}/`)).toEqual([`files/${token}/full`, `files/${token}/small`]);
    expect((await store.adminEmojis(BUILD, {})).emojis.map((e) => e.shortcode)).toEqual(["once", "twice"]);
  });

  it("lets one of two concurrent adds of a shortcode win; the other is abandoned", async () => {
    const { store } = await emojiStore();
    // The first add holds after its reservation while the second completes.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: () => void = () => {};
    const atGate = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gated = intercept(store, "completeEmoji", async (call) => {
      reached();
      await held;
      return call();
    });
    const first = addEmoji(gated, "race");
    await atGate;
    const second = await addEmoji(store, "race");
    expect(second.ok).toBe(true);
    release();
    expect(await first).toMatchObject({ ok: false, code: "shortcode-taken" });
    expect(await sql(store, "SELECT count(*) AS n FROM custom_emojis WHERE shortcode = 'race'")).toEqual([{ n: 1 }]);
    expect(await sql(store, "SELECT processed FROM media_attachments WHERE url = ''")).toEqual([{ processed: 1 }]);
  });
});

describe("emoji cap", () => {
  it("accepts the 1,000th enabled emoji, refuses the 1,001st, and accepts a replace at the cap", async () => {
    const { store, adminId } = await emojiStore();
    await runInDurableObject(store, (_instance, state) => {
      for (let i = 0; i < MAX_ENABLED_EMOJIS - 1; i++) {
        const id = String(130_000_000_000_000_000n + BigInt(i));
        state.storage.sql.exec(
          `INSERT INTO media_attachments (id, account_id, type, url, file_token, content_type, meta, processed)
					VALUES (?, ?, 'image', ?, ?, 'image/png', '{"original":{"width":1,"height":1}}', 1)`,
          id,
          adminId,
          `https://kopje.test/media/tok${String(i).padStart(29, "0")}/full.png`,
          `tok${String(i).padStart(29, "0")}`,
        );
        state.storage.sql.exec(
          "INSERT INTO custom_emojis (id, shortcode, created_at) VALUES (?, ?, '2026-10-12T00:00:00.000Z')",
          id,
          `e${i}`,
        );
      }
    });
    expect((await addEmoji(store, "last")).ok).toBe(true);
    expect(await addEmoji(store, "over")).toMatchObject({ ok: false, code: "emoji-limit" });
    expect((await addEmoji(store, "last", { body: { replace: true } })).ok).toBe(true);
    expect(await sql(store, "SELECT count(*) AS n FROM custom_emojis WHERE disabled = 0")).toEqual([{ n: 1000 }]);
    const disabled = (await sql<{ id: string }>(store, "SELECT id FROM custom_emojis WHERE disabled = 1"))[0]!.id;
    expect(
      await store.updateEmoji(BUILD, { authority: ACCESS, id: disabled, changes: { disabled: false } }),
    ).toMatchObject({ ok: false, code: "shortcode-taken" });
    const other = (await sql<{ id: string }>(store, "SELECT id FROM custom_emojis WHERE shortcode = 'e0'"))[0]!.id;
    await store.updateEmoji(BUILD, { authority: ACCESS, id: other, changes: { disabled: true } });
    await store.updateEmoji(BUILD, { authority: ACCESS, id: disabled, changes: {} });
    expect((await addEmoji(store, "e0")).ok).toBe(true);
    expect(
      await store.updateEmoji(BUILD, { authority: ACCESS, id: other, changes: { disabled: false } }),
    ).toMatchObject({ ok: false, code: "shortcode-taken" });
  }, 60_000);
});

describe("POST /admin/emojis", () => {
  let team: AccessTeam;

  beforeEach(async () => {
    team = await adminTeam();
  });

  async function harness() {
    const { store } = await emojiStore();
    await setTeamAccess(store, team);
    return { store, ...adminHarness(store, team, {}, undefined, () => new TestCodec()) };
  }

  it("adds, lists, changes, disables and enables for the Access admin, each logged", async () => {
    const { store, post, as } = await harness();
    const response = await post(adminClaims(), "/admin/emojis", {
      shortcode: "blob",
      image: base64(await pngOf(4, 4)),
      visibleInPicker: false,
    });
    expect(response.status).toBe(200);
    const emoji = await response.json<{ id: string; visible_in_picker: boolean }>();
    expect(emoji.visible_in_picker).toBe(false);
    const set = await post(adminClaims(), `/admin/emojis/${emoji.id}`, { category: "Blobs", visibleInPicker: true });
    expect(await set.json()).toMatchObject({ category: "Blobs", visible_in_picker: true });
    expect(await (await post(adminClaims(), `/admin/emojis/${emoji.id}`, { disabled: true })).json()).toMatchObject({
      disabled: true,
    });
    expect(await (await post(adminClaims(), `/admin/emojis/${emoji.id}`, { disabled: false })).json()).toMatchObject({
      disabled: false,
    });
    expect(await (await post(adminClaims(), `/admin/emojis/${emoji.id}`, { category: "" })).json()).toMatchObject({
      category: null,
    });
    const listed = await (await as(adminClaims(), "/admin/emojis")).json<{ emojis: unknown[]; next: string | null }>();
    expect(listed).toEqual({ emojis: [expect.objectContaining({ id: emoji.id, shortcode: "blob" })], next: null });
    expect((await logRows(store)).map((row) => row.action)).toEqual([
      "create",
      "update",
      "disable",
      "enable",
      "update",
    ]);
  });

  it("answers each refusal with its status", async () => {
    const { post } = await harness();
    const image = base64(await pngOf(4, 4));
    const status = async (path: string, body: unknown) => {
      const response = await post(adminClaims(), path, body);
      return [response.status, (await response.json<{ code?: string }>()).code];
    };
    expect(await status("/admin/emojis", { shortcode: "a", image })).toEqual([400, "invalid-shortcode"]);
    expect(await status("/admin/emojis", { shortcode: "aa", image, category: "a\u0001" })).toEqual([
      400,
      "invalid-category",
    ]);
    expect(await status("/admin/emojis", { shortcode: "aa", image: "not base64!" })).toEqual([400, "invalid-image"]);
    expect(await status("/admin/emojis", { shortcode: "aa", image: base64(await pngOf(2000, 1)) })).toEqual([
      422,
      "image-too-large",
    ]);
    expect(await status("/admin/emojis", { shortcode: "aa", image })).toEqual([200, undefined]);
    expect(await status("/admin/emojis", { shortcode: "aa", image })).toEqual([409, "shortcode-taken"]);
    expect(await status("/admin/emojis/123456789012345678", { disabled: true })).toEqual([404, "emoji-not-found"]);
  });

  it("is refused for the import token and import sessions, and the Store refuses any authority but Access", async () => {
    const { store } = await emojiStore();
    await setTeamAccess(store, team);
    const token = "import-token-0123456789abcdef0123456789";
    const { request } = adminHarness(store, team, { IMPORT_TOKEN: token }, undefined, () => new TestCodec());
    for (const headers of [{ "Kopje-Import-Token": token }, { "Kopje-Import-Session": "a".repeat(43) }] as Record<
      string,
      string
    >[]) {
      for (const path of ["/admin/emojis", "/admin/emojis/123456789012345678"]) {
        const response = await request(path, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ shortcode: "aa", image: base64(bytes(PNG_PLAIN)) }),
        });
        expect(response.status).toBe(403);
      }
    }
    for (const authority of [{ kind: "import-token" } as const, { kind: "import-session", secret: "x" } as const]) {
      const reserved = await store.reserveEmoji(BUILD, {
        authority,
        token: "e".repeat(43),
        shortcode: "aa",
        replace: false,
        limit: 5000,
      });
      expect(reserved).toMatchObject({ ok: false, code: "wrong-authority" });
      expect(
        await store.updateEmoji(BUILD, { authority, id: "123456789012345678", changes: { disabled: true } }),
      ).toMatchObject({ ok: false, code: "wrong-authority" });
    }
    expect(await sql(store, "SELECT id FROM media_attachments")).toEqual([]);
  });
});

describe("emoji query plans at saturation, with stale statistics", () => {
  it("reads each production query through its index, with no temporary B-tree", async () => {
    const { store, adminId } = await emojiStore();
    // Statistics taken while the table was empty, then MAX_ENABLED_EMOJIS enabled rows and as many disabled.
    await sql(store, "ANALYZE");
    await runInDurableObject(store, (_instance, state) => {
      state.storage.sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
				INSERT INTO media_attachments (id, account_id, type, url, file_token, content_type, meta, processed)
				SELECT CAST(140000000000000000 + i AS TEXT), ?, 'image', 'https://kopje.test/media/' || printf('tok%029d', i)
					|| '/full.png', printf('tok%029d', i), 'image/png', '{"original":{"width":1,"height":1}}', 1 FROM n`,
        adminId,
      );
      state.storage.sql.exec(
        `INSERT INTO custom_emojis (id, shortcode, disabled, created_at)
				SELECT id, 'e' || substr(id, 15), CAST(substr(id, 15) AS INTEGER) > 1000, '2026-10-12T00:00:00.000Z'
				FROM media_attachments`,
      );
    });
    const plans = await runInDurableObject(store, (_instance, state) => {
      const real = state.storage.sql;
      const seen: Record<string, string> = {};
      const capturing = (label: string, pattern: RegExp) =>
        ({
          exec: (query: string, ...params: SqlStorageValue[]) => {
            if (pattern.test(query)) {
              seen[label] = real
                .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...params)
                .toArray()
                .map((row) => row.detail)
                .join(" | ");
            }
            return real.exec(query, ...params);
          },
        }) as unknown as SqlStorage;
      customEmojis.run(capturing("list", /INDEXED BY custom_emojis_enabled/), undefined);
      localEmojiSnapshot(new Db(capturing("snapshot", /json_each/)), [":e0001: :e0002:"], 12_288);
      localEmojiTags(
        new Db(capturing("tags", /json_each/)),
        JSON.stringify([["e0001", `https://kopje.test/media/tok${"0".repeat(28)}1/full.png`]]),
        "https://kopje.test",
        12_288,
      );
      adminEmojis.run(capturing("admin", /FROM custom_emojis e/), { after: "140000000000000500" });
      expiredMedia.run(capturing("expired", /gc_at <= /), { now: NOW + 10 ** 10, limit: 100 });
      purgeMedia.run(capturing("purge", /json_each/), { ids: ["140000000000000001"], now: NOW + 10 ** 10 });
      rebuildCandidates.run(capturing("rebuild", /AS emoji/), { after: null, now: NOW });
      const plan = (query: string) =>
        real
          .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`)
          .toArray()
          .map((row) => row.detail)
          .join(" | ");
      seen.cap = plan("SELECT count(*) FROM custom_emojis WHERE disabled = 0");
      return seen;
    });
    expect(plans.list).toMatch(/SCAN e USING INDEX custom_emojis_enabled/);
    expect(plans.list).not.toMatch(/TEMP B-TREE/);
    expect(plans.snapshot).toMatch(
      /^SCAN j VIRTUAL TABLE .* SEARCH e USING INDEX custom_emojis_enabled \(shortcode=\?\)/,
    );
    expect(plans.snapshot).not.toMatch(/TEMP B-TREE/);
    expect(plans.tags).toMatch(/SEARCH m USING INDEX sqlite_autoindex_media_attachments_\d \(file_token=\?\)/);
    expect(plans.tags).toMatch(/SEARCH e USING (INTEGER PRIMARY KEY|INDEX sqlite_autoindex_custom_emojis_1)/);
    expect(plans.admin).toMatch(/SEARCH e USING INDEX sqlite_autoindex_custom_emojis_1 \(id>\?\)/);
    expect(plans.admin).not.toMatch(/TEMP B-TREE/);
    expect(plans.expired).toMatch(/media_attachments_gc/);
    for (const label of ["expired", "purge", "rebuild"]) {
      expect(plans[label], label).toMatch(
        /SEARCH \w+_e USING COVERING INDEX sqlite_autoindex_custom_emojis_1 \(id=\?\)|SEARCH e USING COVERING INDEX sqlite_autoindex_custom_emojis_1 \(id=\?\)/,
      );
    }
    expect(plans.cap).toMatch(/SCAN custom_emojis USING COVERING INDEX custom_emojis_enabled/);
  }, 60_000);
});

describe("emoji dump and import", () => {
  it("round-trips emoji, refuses an image past the recorded edge limit, and revalidates an imported category", async () => {
    const { store } = await emojiStore();
    const kept = await added(store, "kept");
    const off = await added(store, "off");
    await store.updateEmoji(BUILD, { authority: ACCESS, id: off.id, changes: { disabled: true } });
    await sql(
      store,
      `UPDATE custom_emojis SET category = CAST(X'${"EDA080".repeat(64)}' AS TEXT) WHERE id = ?`,
      kept.id,
    );
    const { text } = await dumpViaRpc(store);
    const target = await migratedStore();
    await copyConfig(store, target);
    expect((await importViaRpc(target, text)).report).toMatchObject({ ok: true, problems: [] });
    const listed = await target.adminEmojis(BUILD, {});
    expect(listed.emojis.map((e) => [e.shortcode, e.disabled, e.category])).toEqual([
      ["kept", false, null],
      ["off", true, null],
    ]);
    expect(await target.customEmojis(BUILD)).toEqual([
      { shortcode: "kept", url: kept.url, static_url: kept.url, visible_in_picker: true },
    ]);
    // The same dump with the image's recorded width past 1,024 fails its chunk with the trigger's message.
    const wide = text.replace(/"original":\{"width":16,/, '"original":{"width":1025,');
    expect(wide).not.toBe(text);
    const other = await migratedStore();
    await copyConfig(store, other);
    await expect(importViaRpc(other, wide)).rejects.toThrow(
      /custom_emojis: the image is not a kept local upload within the emoji limits/,
    );
  });
});

describe("kopje-admin emoji", () => {
  it("adds from a file, lists, sets, disables and enables through the admin API", async () => {
    const team = await adminTeam();
    const { store } = await emojiStore();
    await setTeamAccess(store, team);
    const h = adminHarness(store, team, {}, undefined, () => new TestCodec());
    const io = memoryIO(new Map([["blob.png", await pngOf(8, 8)]]));
    const cli = async (argv: string[]) => {
      const out: string[] = [];
      const fetch = async (input: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.delete("CF-Access-Client-Id");
        headers.delete("CF-Access-Client-Secret");
        const url = new URL(input);
        return h.as(serviceClaims(), `${url.pathname}${url.search}`, { ...init, headers });
      };
      const code = await run({
        argv,
        env: {
          KOPJE_ADMIN_URL: "https://admin.kopje.test",
          CF_ACCESS_CLIENT_ID: "id",
          CF_ACCESS_CLIENT_SECRET: "secret",
        },
        io,
        stdout: { write: (text: string) => void out.push(text), isTTY: false },
        stderr: { write: () => {}, isTTY: false },
        fetch,
      });
      return { code, out: out.join("") };
    };
    const add = await cli(["emoji", "add", "blob", "blob.png", "--category", "Blobs", "--unlisted"]);
    expect(add.code).toBe(0);
    const id = (JSON.parse(add.out) as { id: string }).id;
    expect(await store.adminEmojis(BUILD, {})).toMatchObject({
      emojis: [{ id, shortcode: "blob", category: "Blobs", visible_in_picker: false }],
    });
    expect((await cli(["emoji", "set", id, "category=", "picker=on"])).code).toBe(0);
    expect((await cli(["emoji", "disable", id])).code).toBe(0);
    expect((await store.adminEmojis(BUILD, {})).emojis[0]).toMatchObject({
      category: null,
      visible_in_picker: true,
      disabled: true,
    });
    expect((await cli(["emoji", "enable", id])).code).toBe(0);
    const listed = await cli(["emoji"]);
    expect(JSON.parse(listed.out)).toMatchObject({ emojis: [{ id, disabled: false }], next: null });
    expect((await cli(["emoji", "--after", id])).out).toContain('"emojis": []');
    for (const argv of [
      ["emoji", "add", "blob"],
      ["emoji", "set", id, "size=2"],
      ["emoji", "disable", "x"],
      ["emoji", "drop", id],
    ]) {
      expect((await cli(argv)).code, argv.join(" ")).toBe(2);
    }
  });
});

describe("emoji restore and rebuild", () => {
  it("restores enabled and disabled emoji from a dump and their originals, and their posts resolve again", async () => {
    const { store, adminId } = await emojiStore();
    const on = await added(store, "on");
    const off = await added(store, "off");
    await store.updateEmoji(BUILD, { authority: ACCESS, id: off.id, changes: { disabled: true } });
    const uri = "https://kopje.test/ap/o/restored";
    await sql(
      store,
      `INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, emojis)
			VALUES ('180000000000000001', ?, ?, 'public', '<p>:on: :off:</p>', '2026-10-12T00:00:00.000Z', ?)`,
      uri,
      adminId,
      JSON.stringify([
        ["on", on.url],
        ["off", off.url],
      ]),
    );
    const { text } = await dumpViaRpc(store);
    const target = await migratedStore();
    await copyConfig(store, target);
    expect((await importViaRpc(target, text)).report).toMatchObject({ ok: true, problems: [] });
    // A backup holds the originals only: the served files are gone until the rebuild makes them.
    const tokens = [on, off].map((emoji) => new URL(emoji.url).pathname.split("/")[2]!);
    await env.MEDIA.delete(tokens.flatMap((token) => [`files/${token}/full`, `files/${token}/small`]));
    const step = await rebuildMedia(
      {
        build: BUILD,
        store: target,
        bucket: env.MEDIA,
        images: new TestCodec(),
        now: Date.now,
        authority: ACCESS,
        monthlyTransforms: 5000,
      },
      { after: null, dryRun: false },
    );
    expect(step).toMatchObject({ ok: true, done: true, problems: [], counts: { built: 2 } });
    expect(await r2Keys(`files/${tokens[0]}/`)).toHaveLength(2);
    expect(await r2Keys(`files/${tokens[1]}/`)).toHaveLength(2);
    expect((await target.customEmojis(BUILD)).map((emoji) => emoji.shortcode)).toEqual(["on"]);
    const note = JSON.parse((await target.localNote(BUILD, { uri }))!) as { tag: { type: string; name: string }[] };
    expect(note.tag.filter((tag) => tag.type === "Emoji").map((tag) => tag.name)).toEqual([":on:", ":off:"]);
  });
});

describe("emoji abandon under the rebuild lease", () => {
  it("keeps the files of an upload that failed while the lease was live, and the sweep cleans them up later", async () => {
    const { store } = await emojiStore();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: () => void = () => {};
    const atGate = new Promise<void>((resolve) => {
      reached = resolve;
    });
    // The upload holds before its completion, then the Store answers neither completion.
    const gated = intercept(store, "completeEmoji", async () => {
      reached();
      await held;
      throw new Error("completion lost");
    });
    const token = "f".repeat(43);
    const upload = addEmoji(gated, "leased", { token });
    await atGate;
    // Meanwhile the Store enters settled maintenance and a rebuild takes its lease.
    await sql(
      store,
      "INSERT OR REPLACE INTO kopje_state (name, value) VALUES ('maintenance', ?)",
      JSON.stringify({ mode: "readonly", at: Date.now() - REBUILD_SETTLE_MS - 60_000 }),
    );
    expect(
      await store.mediaRebuildLease(BUILD, { authority: ACCESS, holder: "rebuild", release: false }),
    ).toMatchObject({ status: "ok" });
    // The maintenance flag gone (as by hand), so only the lease refuses the abandon (as media-rebuild.test.ts's
    // "refuses leaving maintenance and every media-deleting write while the lease is live").
    await sql(store, "DELETE FROM kopje_state WHERE name = 'maintenance'");
    release();
    await expect(upload).rejects.toThrow("completion lost");
    const [reservation] = await sql<{ id: string }>(
      store,
      "SELECT id FROM media_attachments WHERE file_token = ?",
      token,
    );
    const refused = await rejectionOf(store.abandonEmoji(BUILD, { authority: ACCESS, id: reservation!.id, token }));
    expect(toStoreUnavailable(refused)?.reason).toBe("rebuild-in-progress");
    // The abandon was refused under the lease: the reservation and its files stay.
    const [row] = await sql<{ id: string; processed: number }>(
      store,
      "SELECT id, processed FROM media_attachments WHERE file_token = ?",
      token,
    );
    expect(row?.processed).toBe(0);
    expect(await r2Keys(`files/${token}/`)).toEqual([`files/${token}/full`, `files/${token}/small`]);
    // Once the lease and maintenance end, the sweep takes the reservation and reconciliation its keys.
    await store.mediaRebuildLease(BUILD, { authority: ACCESS, holder: "rebuild", release: true });
    const later = Date.now() + 2 * 60 * 60 * 1000;
    const deps = { build: () => BUILD, store: () => store, now: () => later };
    expect(await sweepMedia(env, deps)).toBe(1);
    expect(await reconcileMedia(env, { ...deps, now: () => later + 25 * 60 * 60 * 1000 })).toBe(1);
    expect(await r2Keys(`files/${token}/`)).toEqual([]);
    expect(await r2Keys(`originals/${row!.id}`)).toEqual([]);
  });
});
