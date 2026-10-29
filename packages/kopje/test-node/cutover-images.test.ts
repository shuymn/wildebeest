import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { convertLegacy } from "../cli/lib/cutover/convert.js";
import { imageSize } from "../cli/lib/cutover/image-size.js";
import {
  exportImages,
  imageSecret,
  LEGACY_DEFAULT_AVATAR,
  mediaToken,
  readImagesFile,
} from "../cli/lib/cutover/images-export.js";
import { createKopjeDatabase, MAX_PROFILE_UPDATES } from "../cli/lib/cutover/kopje-db.js";
import { loadLegacyExport } from "../cli/lib/cutover/legacy-load.js";
import { IMAGE_SIZE_LIMIT, TOKEN_SHAPE } from "../cli/lib/cutover/upload-rules.js";
import { run } from "../cli/lib/main.js";
import { nodeIO } from "../cli/lib/node-io.js";
import { FILE_TOKEN } from "../src/platform/media-files.js";
import { convert, exportOf, failing, opened, tampered, verify, workspace } from "./cutover-helpers.js";
import { FOREIGN_IMAGE, UPSTREAM_HEADER } from "./legacy-fixture.js";

// Moving a legacy instance's images out of Cloudflare Images (docs/cutover.md, "Media"): images-export downloads them
// with a fake fetch (no network), convert --images maps the references to local media, and verify-conversion --images
// checks the result from the mapping alone.

const space = workspace();
const ACCOUNT = "OperatorAccount0123";
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const ORIGIN = "https://kopje.test";

// ---- image bytes: valid headers, enough for the signature check and the size reader.

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(45);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  bytes.set([0, 0, 0, 0, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44], 33);
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  // SOI, an APP1 Exif segment (as a camera writes it), SOF0, EOI.
  const exif = [0xff, 0xe1, 0x00, 0x0a, 0x45, 0x78, 0x69, 0x66, 0, 0, 1, 2];
  const sof = [0xff, 0xc0, 0x00, 0x11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3];
  return new Uint8Array([0xff, 0xd8, ...exif, ...sof, ...Array.from({ length: 9 }, () => 0), 0xff, 0xd9]);
}

function gif(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0x47,
    0x49,
    0x46,
    0x38,
    0x39,
    0x61,
    width & 0xff,
    width >> 8,
    height & 0xff,
    height >> 8,
    0,
    0,
    0,
  ]);
}

function riff(chunk: string, body: number[]): Uint8Array {
  const bytes = new Uint8Array(Math.max(30, 20 + body.length));
  bytes.set([..."RIFF"].map((c) => c.charCodeAt(0)));
  bytes.set(
    [..."WEBP"].map((c) => c.charCodeAt(0)),
    8,
  );
  bytes.set(
    [...chunk].map((c) => c.charCodeAt(0)),
    12,
  );
  bytes.set(body, 20);
  return bytes;
}

function webpExtended(width: number, height: number): Uint8Array {
  const u24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
  return riff("VP8X", [0, 0, 0, 0, ...u24(width - 1), ...u24(height - 1)]);
}

function webpLossless(width: number, height: number): Uint8Array {
  const bits = (width - 1) | ((height - 1) << 14);
  return riff("VP8L", [0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff]);
}

function webpLossy(width: number, height: number): Uint8Array {
  return riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, width & 0xff, width >> 8, height & 0xff, height >> 8]);
}

// The fixture's images under ACCOUNT (legacy-fixture.ts, imagesAccount), one of each type and size.
const FILES: Record<string, Uint8Array> = {
  "avatar-0": png(400, 400),
  "avatar-1": jpeg(5000, 3000),
  "header-0": webpExtended(1500, 500),
  "image-1": gif(800, 600),
  "image-2": png(64, 32),
  "image-3": jpeg(1024, 768),
  "image-8": png(30, 20),
  "image-9": png(10, 20),
};

type Answer = Uint8Array | number | (() => Response);

// A fake fetch that answers by image id, from either source, and records what was asked.
function fakeFetch(answers: Record<string, Answer>) {
  const calls: { url: string; init?: RequestInit | undefined }[] = [];
  const fetch = (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const api = /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[0-9a-f]{32}\/images\/v1\/([^/]+)\/blob$/.exec(
      url,
    );
    const delivery = /^https:\/\/imagedelivery\.net\/[^/]+\/([^/]+)\/[^/]+$/.exec(url);
    const answer = answers[api?.[1] ?? delivery?.[1] ?? ""];
    if (answer === undefined || typeof answer === "number") {
      return Promise.resolve(new Response("no", { status: answer ?? 404 }));
    }
    return Promise.resolve(typeof answer === "function" ? answer() : new Response(new Uint8Array(answer)));
  };
  return { fetch, calls };
}

async function exportFixture() {
  return exportOf(space.dir, { level: 39, imagesAccount: ACCOUNT });
}

async function downloaded(answers: Record<string, Answer> = FILES, extra: { token?: string } = {}) {
  const exportPath = await exportFixture();
  const outDir = join(space.dir, "images");
  const { fetch, calls } = fakeFetch(answers);
  const result = await exportImages({
    exportPath,
    accountHash: ACCOUNT,
    outDir,
    fetch,
    ...(extra.token === undefined ? {} : { accountId: ACCOUNT_ID, token: extra.token }),
  });
  return { exportPath, outDir, calls, ...result };
}

async function imagesJson(outDir: string) {
  return JSON.parse(await readFile(join(outDir, "images.json"), "utf8")) as {
    accountHash: string;
    domain: string;
    images: Record<string, Record<string, unknown>>;
  };
}

describe("the image header reader", () => {
  it("reads the size of PNG, JPEG, GIF and every WebP form", () => {
    expect(imageSize(png(400, 300), "image/png")).toEqual({ width: 400, height: 300 });
    expect(imageSize(jpeg(5000, 3000), "image/jpeg")).toEqual({ width: 5000, height: 3000 });
    expect(imageSize(gif(800, 600), "image/gif")).toEqual({ width: 800, height: 600 });
    expect(imageSize(webpExtended(1500, 500), "image/webp")).toEqual({ width: 1500, height: 500 });
    expect(imageSize(webpLossless(321, 123), "image/webp")).toEqual({ width: 321, height: 123 });
    expect(imageSize(webpLossy(640, 480), "image/webp")).toEqual({ width: 640, height: 480 });
  });

  it("gives null for truncated, damaged or unread headers", () => {
    expect(imageSize(png(400, 300).subarray(0, 20), "image/png")).toBeNull();
    expect(imageSize(png(0, 300), "image/png")).toBeNull();
    expect(imageSize(jpeg(10, 10).subarray(0, 16), "image/jpeg")).toBeNull();
    const noFrame = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    expect(imageSize(noFrame, "image/jpeg")).toBeNull();
    const badLength = jpeg(10, 10);
    badLength[5] = 0xff;
    expect(imageSize(badLength, "image/jpeg")).toBeNull();
    expect(imageSize(riff("VP8 ", [0, 0, 0, 1, 2, 3]), "image/webp")).toBeNull();
    expect(imageSize(png(10, 10), "image/avif")).toBeNull();
  });
});

describe("file tokens", () => {
  it("have the shape the upload path makes and serves (test/cutover-upload-rules.test.ts pins the other side)", () => {
    const secret = imageSecret();
    expect(secret).toMatch(TOKEN_SHAPE);
    expect(imageSecret()).not.toBe(secret);
    const token = mediaToken(secret, "attachment\nhttps://kopje.test/ap/o/1\n0");
    expect(token).toMatch(TOKEN_SHAPE);
    expect(token).toMatch(FILE_TOKEN);
    // One per row, and the same for the same row.
    expect(mediaToken(secret, "attachment\nhttps://kopje.test/ap/o/1\n1")).not.toBe(token);
    expect(mediaToken(secret, "attachment\nhttps://kopje.test/ap/o/1\n0")).toBe(token);
    expect(mediaToken(imageSecret(), "attachment\nhttps://kopje.test/ap/o/1\n0")).not.toBe(token);
  });
});

describe("images-export", () => {
  it("downloads each image once from its delivery URL, checks it and records it", async () => {
    const { ok, report, outDir, calls } = await downloaded();
    expect(ok).toBe(true);
    expect(report).toMatchObject({ images: 8, downloaded: 8, kept: 0, from: "delivery", malformedUrls: 0 });
    // The variant as found in the data, no credentials; the foreign and upstream accounts are not fetched.
    expect(calls.map((c) => c.url).toSorted()).toEqual(
      [
        "avatar-0/avatar",
        "avatar-1/avatar",
        "header-0/header",
        "image-1/usercontent",
        "image-2/usercontent",
        "image-3/usercontent",
        "image-8/usercontent",
        "image-9/usercontent",
      ].map((path) => `https://imagedelivery.net/${ACCOUNT}/${path}`),
    );
    for (const { init } of calls) {
      const headers = new Headers(init?.headers);
      expect(headers.has("authorization")).toBe(false);
      // Naming WebP or AVIF would make Images re-encode the stored image into that format.
      expect(headers.get("accept")).not.toMatch(/webp|avif/);
    }
    const file = await imagesJson(outDir);
    expect(file).toMatchObject({ accountHash: ACCOUNT, domain: "kopje.test" });
    expect(file.images["avatar-1"]).toMatchObject({
      state: "ok",
      type: "image/jpeg",
      width: 5000,
      height: 3000,
      from: "delivery",
      sha256: createHash("sha256")
        .update(FILES["avatar-1"] ?? "")
        .digest("hex"),
    });
    expect(file.images["header-0"]).toMatchObject({ type: "image/webp", width: 1500, height: 500 });
    for (const entry of Object.values(file.images)) {
      expect(entry.secret).toMatch(TOKEN_SHAPE);
    }
    expect(await readFile(join(outDir, "originals", "avatar-1"))).toEqual(Buffer.from(FILES["avatar-1"] ?? []));
    expect((await stat(join(outDir, "originals", "avatar-1"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(outDir, "images.json"))).mode & 0o777).toBe(0o600);
    expect((await readdir(join(outDir, "originals"))).filter((name) => name.startsWith("."))).toEqual([]);
  });

  it("uses the Images API with the token when given an account id, and never follows a redirect with it", async () => {
    const { ok, report, calls, outDir } = await downloaded(FILES, { token: "images-api-token-value" });
    expect(ok).toBe(true);
    expect(report).toMatchObject({ from: "api", downloaded: 8 });
    for (const { url, init } of calls) {
      expect(url).toMatch(
        new RegExp(`^https://api\\.cloudflare\\.com/client/v4/accounts/${ACCOUNT_ID}/images/v1/[a-z0-9-]+/blob$`),
      );
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer images-api-token-value");
      expect(init?.redirect).toBe("error");
    }
    expect(await readFile(join(outDir, "images.json"), "utf8")).not.toContain("images-api-token-value");
  });

  it("resumes: verified files are kept, a damaged one is fetched again, and tokens never change", async () => {
    const first = await downloaded();
    const before = await imagesJson(first.outDir);
    await writeFile(join(first.outDir, "originals", "image-2"), "damaged");
    await rm(join(first.outDir, "originals", "image-3"));
    const { fetch, calls } = fakeFetch(FILES);
    const again = await exportImages({
      exportPath: first.exportPath,
      accountHash: ACCOUNT,
      outDir: first.outDir,
      fetch,
    });
    expect(again.ok).toBe(true);
    expect(again.report).toMatchObject({ images: 8, kept: 6, downloaded: 2 });
    expect(calls.map((c) => c.url.split("/")[4]!).toSorted()).toEqual(["image-2", "image-3"]);
    expect(await imagesJson(first.outDir)).toEqual(before);
    expect(await readFile(join(first.outDir, "originals", "image-2"))).toEqual(Buffer.from(FILES["image-2"] ?? []));

    const idle = fakeFetch(FILES);
    await exportImages({ exportPath: first.exportPath, accountHash: ACCOUNT, outDir: first.outDir, fetch: idle.fetch });
    expect(idle.calls).toEqual([]);
  });

  it("keeps an image secret through ok, missing and ok again, so a recovered image keeps its URLs", async () => {
    const first = await downloaded();
    const secret = (await imagesJson(first.outDir)).images["image-2"]?.secret;
    expect(secret).toMatch(TOKEN_SHAPE);
    const again = (answers: Record<string, Answer>) =>
      exportImages({
        exportPath: first.exportPath,
        accountHash: ACCOUNT,
        outDir: first.outDir,
        fetch: fakeFetch(answers).fetch,
      });
    await rm(join(first.outDir, "originals", "image-2"));
    expect((await again({ ...FILES, "image-2": 404 })).ok).toBe(false);
    expect((await imagesJson(first.outDir)).images["image-2"]).toEqual({
      state: "missing",
      secret,
      reason: "not-found",
    });
    await again({ ...FILES, "image-2": new TextEncoder().encode("not an image") });
    expect((await imagesJson(first.outDir)).images["image-2"]).toEqual({
      state: "missing",
      secret,
      reason: "unsupported-type",
    });
    expect((await again(FILES)).ok).toBe(true);
    expect((await imagesJson(first.outDir)).images["image-2"]).toMatchObject({ state: "ok", secret });
  });

  it("marks a 404, a wrong type, an oversized file and too many pixels missing, and exits 3 for them", async () => {
    const oversized = () =>
      new Response(new Uint8Array(16), { headers: { "content-length": String(IMAGE_SIZE_LIMIT + 1) } });
    // Without a declared length, the body is read no further than the limit.
    const streamed = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024));
          },
        }),
      );
    const { ok, report, outDir } = await downloaded({
      ...FILES,
      "avatar-1": 404,
      "header-0": new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      "image-1": oversized,
      "image-2": streamed,
      "image-3": png(5000, 5000),
    });
    expect(ok).toBe(false);
    expect(report).toMatchObject({
      downloaded: 3,
      missing: { total: 5, "not-found": 1, "unsupported-type": 1, "too-large": 2, "too-many-pixels": 1 },
    });
    const file = await imagesJson(outDir);
    expect(file.images["avatar-1"]).toMatchObject({ state: "missing", reason: "not-found" });
    expect(file.images["image-3"]).toMatchObject({ state: "missing", reason: "too-many-pixels" });
    expect((await readdir(join(outDir, "originals"))).toSorted()).toEqual(["avatar-0", "image-8", "image-9"]);
  });

  it("stops on a server error, keeping what it downloaded, and refuses another instance or account", async () => {
    const exportPath = await exportFixture();
    const outDir = join(space.dir, "images");
    const failing503 = fakeFetch({ ...FILES, "image-1": 503 });
    await expect(
      exportImages({ exportPath, accountHash: ACCOUNT, outDir, fetch: failing503.fetch }),
    ).rejects.toMatchObject({ code: "images-fetch-failed", detail: { status: 503 } });
    const saved = await imagesJson(outDir);
    expect(Object.keys(saved.images).length).toBeGreaterThan(0);
    expect(saved.images["image-1"]).toBeUndefined();

    const { fetch } = fakeFetch(FILES);
    await expect(exportImages({ exportPath, accountHash: "AnotherAccount99", outDir, fetch })).rejects.toMatchObject({
      code: "images-file-differs",
    });
    await expect(
      exportImages({ exportPath, accountHash: "NkfPDviynOyTAOI79ar_GQ", outDir: join(space.dir, "x"), fetch }),
    ).rejects.toMatchObject({ code: "images-account-invalid" });
    await expect(
      exportImages({ exportPath, accountHash: ACCOUNT, outDir: join(space.dir, "y"), fetch, accountId: ACCOUNT_ID }),
    ).rejects.toMatchObject({ code: "images-api-incomplete" });
  });

  it("runs from the CLI with the token from the environment only, and never prints it", async () => {
    const exportPath = await exportFixture();
    const outDir = join(space.dir, "cli-images");
    const output: string[] = [];
    const stream = { write: (text: string) => void output.push(text) };
    const { fetch, calls } = fakeFetch(FILES);
    const token = "cli-images-token-value";
    const common = { io: nodeIO, stdout: stream, stderr: stream, fetch };
    const args = ["images-export", exportPath, "--images-account", ACCOUNT, "--out", outDir];
    expect(await run({ ...common, argv: [...args, "--account-id", ACCOUNT_ID], env: {} })).toBe(2);
    expect(calls).toEqual([]);
    const code = await run({ ...common, argv: [...args, "--account-id", ACCOUNT_ID], env: { CF_IMAGES_TOKEN: token } });
    expect(code).toBe(0);
    expect(calls).toHaveLength(8);
    const printed = output.join("");
    expect(printed).toContain('"downloaded": 8');
    for (const secret of [token, "kopje.test", ACCOUNT, "avatar-0"]) {
      expect(printed).not.toContain(secret);
    }
  });
});

describe("convert and verify-conversion with --images", () => {
  async function converted(extra: { answers?: Record<string, Answer>; acceptMissingImages?: boolean } = {}) {
    const { exportPath, outDir: imagesDir } = await downloaded(extra.answers ?? FILES);
    const result = await convert(space.dir, exportPath, {
      imagesDir,
      acceptMissingImages: extra.acceptMissingImages,
      acceptDeletions: true,
    });
    return { exportPath, imagesDir, ...result, file: await imagesJson(imagesDir) };
  }

  it("maps avatars, headers, attachments and edits to local media, and the independent check passes", async () => {
    const { ok, manifest, dumpPath, exportPath, imagesDir, file } = await converted();
    expect(manifest.stop).toBeUndefined();
    expect(ok).toBe(true);
    // avatar-0, avatar-1, header-0, image-1 twice, image-3 and image-8 (attached; image-8 also in the earlier version),
    // image-2 (unattached), image-9 (an earlier version only); Bob's upstream default header; one foreign attachment.
    expect(manifest.images).toEqual({
      mapped: 10,
      missing: 0,
      upstream: 1,
      foreign: 1,
      unmapped: 0,
      originals: 9,
      acceptMissing: false,
    });
    const db = await opened(dumpPath);
    const row = (sql: string, ...params: string[]) => db.prepare(sql).get(...params) as Record<string, unknown>;
    const statusUri = (content: string) => String(row("SELECT uri FROM statuses WHERE content LIKE ?", content).uri);
    // Each row's token, from the image's secret and the reference's key.
    const token = (imageId: string, key: string) => mediaToken(String(file.images[imageId]?.secret), key);
    const alice = `${ORIGIN}/ap/users/alice`;
    const bobUri = `${ORIGIN}/ap/users/Bob`;
    const tokens = {
      "avatar-0": token("avatar-0", `profile\n${alice}\navatar`),
      "header-0": token("header-0", `profile\n${alice}\nheader`),
      "avatar-1": token("avatar-1", `profile\n${bobUri}\navatar`),
      "image-1": token("image-1", `attachment\n${statusUri("%Wildebeest day%")}\n0`),
      "image-1 again": token("image-1", `attachment\n${statusUri("%unlisted, with a CW%")}\n0`),
      "image-3": token("image-3", `attachment\n${statusUri("%followers only%")}\n0`),
      "image-2": token(
        "image-2",
        `image\n${String(row("SELECT 'https://kopje.test/ap/o/' || legacy_ap_o AS id FROM media_attachments WHERE status_id IS NULL AND legacy_ap_o IS NOT NULL").id)}`,
      ),
      "image-8": token("image-8", `attachment\n${statusUri("%second version%")}\n0`),
      "image-9": token("image-9", `edit\n${statusUri("%second version%")}\nimage-9`),
    };
    const media = (name: keyof typeof tokens) =>
      row(
        `SELECT m.id, a.username, m.status_id IS NOT NULL AS attached, m.shown, m.gc_at, m.type, m.url, m.preview_url,
					m.content_type, m.meta, m.processed FROM media_attachments m JOIN accounts a ON a.id = m.account_id
				WHERE m.file_token = ?`,
        tokens[name],
      );
    expect(new Set(Object.values(tokens)).size).toBe(9);

    // Profiles: the full file of a kept, unattached row; PNG stays PNG, JPEG becomes WebP, sized as the upload path.
    const aliceRow = row("SELECT avatar_url, header_url FROM accounts WHERE username = 'alice' AND domain IS NULL");
    expect(aliceRow).toEqual({
      avatar_url: `${ORIGIN}/media/${tokens["avatar-0"]}/full.png`,
      header_url: `${ORIGIN}/media/${tokens["header-0"]}/full.webp`,
    });
    const bob = row("SELECT avatar_url, header_url FROM accounts WHERE username = 'Bob' AND domain IS NULL");
    expect(bob).toEqual({ avatar_url: `${ORIGIN}/media/${tokens["avatar-1"]}/full.webp`, header_url: null });
    // Both profiles changed, so publication announces both (kopje_state profile_updates, sorted account ids).
    const localIds = (
      db.prepare("SELECT id FROM accounts WHERE domain IS NULL ORDER BY id").all() as { id: string }[]
    ).map((a) => a.id);
    expect(JSON.parse(String(row("SELECT value FROM kopje_state WHERE name = 'profile_updates'").value))).toEqual(
      localIds,
    );
    expect(media("avatar-1")).toMatchObject({
      username: "Bob",
      attached: 0,
      gc_at: null,
      type: "image",
      url: bob.avatar_url,
      preview_url: `${ORIGIN}/media/${tokens["avatar-1"]}/small.webp`,
      content_type: "image/webp",
      meta: JSON.stringify({ original: { width: 3840, height: 2304 }, small: { width: 640, height: 384 } }),
      processed: 1,
    });
    expect(media("avatar-0")).toMatchObject({
      url: aliceRow.avatar_url,
      content_type: "image/png",
      meta: JSON.stringify({ original: { width: 400, height: 400 }, small: { width: 400, height: 400 } }),
    });

    // Attachments: each status's row has files of its own, also when two statuses show one image.
    for (const name of ["image-1", "image-1 again"] as const) {
      expect(media(name)).toMatchObject({
        username: "alice",
        attached: 1,
        url: `${ORIGIN}/media/${tokens[name]}/full.webp`,
        content_type: "image/webp",
      });
    }
    expect(media("image-2")).toMatchObject({ attached: 0, url: `${ORIGIN}/media/${tokens["image-2"]}/full.png` });
    // An image only an earlier version shows has a row of its own, of the status but not shown, as an edit that drops
    // media leaves it; the version names its files.
    expect(media("image-9")).toMatchObject({
      attached: 1,
      shown: 0,
      gc_at: null,
      username: "alice",
      content_type: "image/png",
    });
    expect(
      row(
        "SELECT s.uri FROM media_attachments m JOIN statuses s ON s.id = m.status_id WHERE m.file_token = ?",
        tokens["image-9"],
      ),
    ).toEqual({ uri: statusUri("%second version%") });
    const edits = (
      db.prepare("SELECT media_json FROM status_edits ORDER BY rowid").all() as { media_json: string }[]
    ).map((e) => JSON.parse(e.media_json) as { url: string; preview_url: string; description: string | null }[]);
    expect(edits.flat()).toContainEqual(
      expect.objectContaining({
        url: `${ORIGIN}/media/${tokens["image-9"]}/full.png`,
        preview_url: `${ORIGIN}/media/${tokens["image-9"]}/small.png`,
      }),
    );
    // Both versions show image-8's row, each with the description it had then.
    const image8 = `${ORIGIN}/media/${tokens["image-8"]}/full.png`;
    expect(edits.map((version) => version.filter((m) => m.url === image8).map((m) => m.description))).toEqual([
      ["before"],
      ["after"],
    ]);
    // Another account's image stays where it is; nothing points to Cloudflare Images under the operator's account.
    expect(row("SELECT count(*) AS n FROM media_attachments WHERE url = ?", FOREIGN_IMAGE).n).toBe(1);
    const dump = await readFile(dumpPath, "utf8");
    expect(dump).not.toContain(`imagedelivery.net/${ACCOUNT}`);
    expect(dump).not.toContain("NkfPDviynOyTAOI79ar_GQ");

    // One original per row, named for the R2 key originals/<media id>, byte for byte, mode 0600.
    const out = join(space.dir, "out", "originals");
    const names = (await readdir(out)).toSorted();
    expect(names).toHaveLength(9);
    for (const name of Object.keys(tokens) as (keyof typeof tokens)[]) {
      const mediaId = String(media(name).id);
      expect(names).toContain(mediaId);
      expect(await readFile(join(out, mediaId))).toEqual(Buffer.from(FILES[name.split(" ")[0] ?? ""] ?? []));
      expect((await stat(join(out, mediaId))).mode & 0o777).toBe(0o600);
    }
    db.close();

    const {
      ok: verified,
      categories,
      report,
    } = await verify(exportPath, dumpPath, { acceptDeletions: true, imagesDir });
    expect(failing(categories)).toEqual([]);
    expect(verified).toBe(true);
    expect(categories.media_files?.expected).toBe(9);
    expect(categories.profile_updates?.expected).toBe(2);
    expect(report.images).toEqual({ missing: 0, unmapped: 0, acceptMissing: false });

    // Deterministic for a given base time and mapping.
    const again = await convert(space.dir, exportPath, { imagesDir, acceptDeletions: true, out: "out-again" });
    expect(await readFile(again.dumpPath, "utf8")).toBe(dump);
  });

  it("drops legacy's default avatar for local accounts only", async () => {
    const exportPath = await exportFixture();
    const actors = join(exportPath, "actors.sql");
    await writeFile(
      actors,
      (await readFile(actors, "utf8"))
        .replace(`https://imagedelivery.net/${ACCOUNT}/avatar-1/avatar`, LEGACY_DEFAULT_AVATAR)
        .replace("https://files.remote.example/a/0.png", LEGACY_DEFAULT_AVATAR),
    );
    const imagesDir = join(space.dir, "images");
    const exported = await exportImages({
      exportPath,
      accountHash: ACCOUNT,
      outDir: imagesDir,
      fetch: fakeFetch(FILES).fetch,
    });
    expect(exported.report).toMatchObject({ images: 7 });
    const { ok, manifest, dumpPath } = await convert(space.dir, exportPath, { imagesDir, acceptDeletions: true });
    expect(ok).toBe(true);
    expect(manifest.images).toMatchObject({ upstream: 2, mapped: 9 });
    const db = await opened(dumpPath);
    const avatar = (uri: string) =>
      (db.prepare("SELECT avatar_url FROM accounts WHERE uri = ?").get(uri) as { avatar_url: string | null })
        .avatar_url;
    expect(avatar(`${ORIGIN}/ap/users/Bob`)).toBeNull();
    expect(avatar("https://remote.example/users/r0")).toBe(LEGACY_DEFAULT_AVATAR);
    db.close();
    const verified = await verify(exportPath, dumpPath, { acceptDeletions: true, imagesDir });
    expect(failing(verified.categories)).toEqual([]);
    expect(verified.ok).toBe(true);
  });

  it("stops when more local profiles changed than publication announces", async () => {
    // The converter stops where the Store's importer refuses (src/platform/dump-catalog.ts, Workers types only).
    const catalog = await readFile(new URL("../src/platform/dump-catalog.ts", import.meta.url), "utf8");
    expect(catalog).toMatch(new RegExp(`^export const MAX_PROFILE_UPDATES = ${MAX_PROFILE_UPDATES};?$`, "m"));
    const exportPath = await exportFixture();
    const imagesDir = join(space.dir, "images");
    const exported = await exportImages({
      exportPath,
      accountHash: ACCOUNT,
      outDir: imagesDir,
      fetch: fakeFetch(FILES).fetch,
    });
    expect(exported.ok).toBe(true);
    const names = (await readdir(exportPath)).filter((f) => f.endsWith(".sql"));
    const loaded = loadLegacyExport({
      texts: await Promise.all(names.map((f) => readFile(join(exportPath, f), "utf8"))),
      acceptDeletions: true,
    });
    // MAX_PROFILE_UPDATES copies of Bob, whose avatar maps and whose default header is dropped, beside alice and Bob.
    const bob = `${ORIGIN}/ap/users/Bob`;
    for (let i = 0; i < MAX_PROFILE_UPDATES; i++) {
      const name = `Copy${i}`;
      const uri = `${ORIGIN}/ap/users/${name}`;
      // privkey and privkey_salt are unique in legacy.
      const byte = i.toString(16).padStart(2, "0");
      for (const [table, key] of [
        ["actors", "id"],
        ["users", "actor_id"],
      ] as const) {
        loaded.db.exec(`CREATE TEMP TABLE copy AS SELECT * FROM ${table} WHERE ${key} = '${bob}'`);
        loaded.db.exec(
          table === "actors"
            ? `UPDATE copy SET id = '${uri}', mastodon_id = '${name}', username = '${name.toLowerCase()}',
							properties = replace(replace(properties, '${bob}', '${uri}'), '"preferredUsername":"Bob"',
								'"preferredUsername":"${name}"')`
            : `UPDATE copy SET id = '${name}', actor_id = '${uri}', email = '${name}@example.com',
							privkey = privkey || X'${byte}', privkey_salt = privkey_salt || X'${byte}'`,
        );
        loaded.db.exec(`INSERT INTO ${table} SELECT * FROM copy; DROP TABLE copy`);
      }
    }
    const images = readImagesFile(imagesDir);
    if (images === null) {
      throw new Error("no images.json");
    }
    const summary = convertLegacy(loaded.db, createKopjeDatabase(), {
      images,
      baseTime: Date.parse("2026-10-20T00:00:00.000Z"),
      originalActorIds: loaded.originalActorIds,
      notificationSequence: loaded.report.notificationSequence,
      source: loaded.source,
    });
    loaded.db.close();
    expect(summary.localAccounts).toBe(MAX_PROFILE_UPDATES + 2);
    expect(summary.problems).toEqual({ "profile-updates-over-limit": 1 });
  });

  it("without --images keeps every URL as it was", async () => {
    const exportPath = await exportFixture();
    const { ok, manifest, dumpPath } = await convert(space.dir, exportPath, { acceptDeletions: true });
    expect(ok).toBe(true);
    expect(manifest.images).toBeUndefined();
    const db = await opened(dumpPath);
    const value = (sql: string) => Object.values(db.prepare(sql).get() ?? {})[0];
    expect(value("SELECT count(*) FROM media_attachments WHERE file_token IS NOT NULL")).toBe(0);
    expect(value("SELECT header_url FROM accounts WHERE username = 'Bob' AND domain IS NULL")).toContain(
      "NkfPDviynOyTAOI79ar_GQ",
    );
    // Nothing for publication to announce.
    expect(value("SELECT count(*) FROM kopje_state WHERE name = 'profile_updates'")).toBe(0);
    db.close();
  });

  it("lists only the local profiles whose images changed for publication to announce", async () => {
    const exportPath = await exportFixture();
    const actors = join(exportPath, "actors.sql");
    // Bob's avatar and header become images of another account, which the conversion keeps.
    await writeFile(
      actors,
      (await readFile(actors, "utf8"))
        .replace(`https://imagedelivery.net/${ACCOUNT}/avatar-1/avatar`, FOREIGN_IMAGE)
        .replace(UPSTREAM_HEADER, FOREIGN_IMAGE),
    );
    const imagesDir = join(space.dir, "images");
    const exported = await exportImages({
      exportPath,
      accountHash: ACCOUNT,
      outDir: imagesDir,
      fetch: fakeFetch(FILES).fetch,
    });
    expect(exported.ok).toBe(true);
    const { ok, dumpPath } = await convert(space.dir, exportPath, { imagesDir, acceptDeletions: true });
    expect(ok).toBe(true);
    const db = await opened(dumpPath);
    const row = (sql: string) => db.prepare(sql).get() as Record<string, unknown>;
    const alice = String(row("SELECT id FROM accounts WHERE username = 'alice' AND domain IS NULL").id);
    expect(row("SELECT avatar_url, header_url FROM accounts WHERE username = 'Bob' AND domain IS NULL")).toEqual({
      avatar_url: FOREIGN_IMAGE,
      header_url: FOREIGN_IMAGE,
    });
    expect(JSON.parse(String(row("SELECT value FROM kopje_state WHERE name = 'profile_updates'").value))).toEqual([
      alice,
    ]);
    db.close();
    const verified = await verify(exportPath, dumpPath, { acceptDeletions: true, imagesDir });
    expect(failing(verified.categories)).toEqual([]);
    expect(verified.categories.profile_updates?.expected).toBe(1);
  });

  it("refuses a URL of the operator account that images.json does not map", async () => {
    const { exportPath, outDir: imagesDir } = await downloaded();
    const file = await imagesJson(imagesDir);
    delete file.images["image-3"];
    await writeFile(join(imagesDir, "images.json"), JSON.stringify({ format: 1, ...file }));
    const { ok, manifest } = await convert(space.dir, exportPath, { imagesDir, acceptDeletions: true });
    expect(ok).toBe(false);
    expect(manifest.stop).toMatchObject({ code: "conversion-refused", detail: { reasons: ["images-unmapped"] } });
    expect(manifest.images).toMatchObject({ unmapped: 1 });
  });

  it("stops on missing images unless accepted, then leaves their references out", async () => {
    const answers = { ...FILES, "avatar-1": 404, "image-1": 404 };
    const stopped = await converted({ answers });
    expect(stopped.ok).toBe(false);
    expect(stopped.manifest.stop).toMatchObject({
      code: "conversion-refused",
      detail: { reasons: ["images-missing (pass --accept-missing-images)"] },
    });
    const { exportPath, imagesDir } = stopped;
    const { ok, manifest, dumpPath } = await convert(space.dir, exportPath, {
      imagesDir,
      acceptMissingImages: true,
      acceptDeletions: true,
      out: "out-accepted",
    });
    expect(ok).toBe(true);
    expect(manifest.images).toMatchObject({ mapped: 7, missing: 3, originals: 6, acceptMissing: true });
    const db = await opened(dumpPath);
    const value = (sql: string) => Object.values(db.prepare(sql).get() ?? {})[0];
    expect(value("SELECT avatar_url FROM accounts WHERE username = 'Bob' AND domain IS NULL")).toBeNull();
    // The status that showed image-1 has no attachment left; its old Image id has no row.
    expect(
      value(
        "SELECT count(*) FROM media_attachments m JOIN statuses s ON s.id = m.status_id WHERE s.content LIKE '%Wildebeest day%'",
      ),
    ).toBe(0);
    db.close();
    expect((await verify(exportPath, dumpPath, { acceptDeletions: true, imagesDir })).ok).toBe(false);
    const accepted = await verify(exportPath, dumpPath, {
      acceptDeletions: true,
      imagesDir,
      acceptMissingImages: true,
    });
    expect(failing(accepted.categories)).toEqual([]);
    expect(accepted.ok).toBe(true);
  });

  // Runs verify-conversion once per case below, each on a fresh tampered copy of the dump, so its time grows with the
  // cases.
  it("verify-conversion catches a media URL, a profile image or a served type that differs from the mapping", async () => {
    const { dumpPath, exportPath, imagesDir } = await converted();
    const cases: [string, string[]][] = [
      [
        "UPDATE media_attachments SET url = replace(url, '/full.', '/small.') WHERE status_id IS NOT NULL AND file_token IS NOT NULL",
        ["attachments", "media", "media_files"],
      ],
      ["UPDATE accounts SET avatar_url = NULL WHERE username = 'alice' AND domain IS NULL", ["accounts"]],
      // The profiles publication announces.
      ["DELETE FROM kopje_state WHERE name = 'profile_updates'", ["profile_updates"]],
      [
        "UPDATE kopje_state SET value = (SELECT json_array(min(id)) FROM accounts WHERE domain IS NULL) WHERE name = 'profile_updates'",
        ["profile_updates"],
      ],
      // A repeated id, and an id that is no local account.
      [
        "UPDATE kopje_state SET value = (SELECT json_array(min(id), min(id), max(id)) FROM accounts WHERE domain IS NULL) WHERE name = 'profile_updates'",
        ["profile_updates"],
      ],
      [
        "UPDATE kopje_state SET value = (SELECT json_insert(value, '$[#]', 'no-such-account') FROM kopje_state WHERE name = 'profile_updates') WHERE name = 'profile_updates'",
        ["profile_updates"],
      ],
      ["UPDATE media_attachments SET content_type = 'image/jpeg' WHERE file_token IS NOT NULL", ["media_files"]],
      [
        'UPDATE media_attachments SET meta = \'{"original":{"width":1,"height":1}}\' WHERE file_token IS NOT NULL',
        ["media_files"],
      ],
      // What an edit's versions show (status_edits.media_json): a URL, a preview, a description, a size, an image.
      ["UPDATE status_edits SET media_json = replace(media_json, '/full.png', '/small.png')", ["edits"]],
      ["UPDATE status_edits SET media_json = replace(media_json, '/small.png', '/small.webp')", ["edits"]],
      ["UPDATE status_edits SET media_json = replace(media_json, '\"first\"', '\"changed\"')", ["edits"]],
      ["UPDATE status_edits SET media_json = replace(media_json, '\"width\":10,', '\"width\":11,')", ["edits"]],
      ["UPDATE status_edits SET media_json = '[]'", ["edits"]],
      // An earlier version given the description the image has now.
      ["UPDATE status_edits SET media_json = replace(media_json, '\"before\"', '\"after\"')", ["edits"]],
    ];
    for (const [sql, categories] of cases) {
      const damaged = await tampered(space.dir, dumpPath, sql);
      const result = await verify(exportPath, damaged, { acceptDeletions: true, imagesDir });
      expect(result.ok, sql).toBe(false);
      expect(failing(result.categories), sql).toEqual(categories);
    }
  }, 60_000);
});
