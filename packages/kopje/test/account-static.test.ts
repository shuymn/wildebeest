import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { type Account, partialAccountsOf, presentAccountById, PROFILE_URL_LIMIT } from "../src/domain/accounts";
import { profileAssignSql } from "../src/domain/media";
import { isAnimated } from "../src/platform/image-bytes";
import { STATIC_URL_LIMIT } from "../src/platform/stored-bounds";
import { bearer, sql } from "./api-helpers";
import { ANIMATED_WEBP, PNG_PLAIN } from "./fixtures/images";
import { bytes, framesKeepingCodec, multipartForm } from "./media-helpers";
import { aliceWithFollower, ESCAPED_STATIC_WITNESS, rawBytes as raw } from "./profile-fixtures";
import { scansOf, staleStatistics } from "./read-helpers";
import { getJson, post } from "./status-helpers";
import { csrfOf, ORIGIN, signIn } from "./web-helpers";

// Account#avatar_static and #header_static (Mastodon v4.5.11 REST::AccountSerializer, account_serializer.rb:79-81,
// 87-89): for an upload whose served file is animated, its still preview (domain/media.ts profileAssignSql, migration
// 0061_account_static_images); otherwise the image. Shown only with the image (both defaults when it is not), each
// within its presenter's URL bound as JSON writes it (RES-2).

const DEFAULT_AVATAR = `${ORIGIN}/assets/avatar.jpg`;
const DEFAULT_HEADER = `${ORIGIN}/assets/header.jpg`;
const utf8 = (value: string) => new TextEncoder().encode(value).length;

// Alice and a remote follower over a codec whose WebP served files are animated (framesKeepingCodec).
async function setup() {
  const codec = framesKeepingCodec();
  const h = await aliceWithFollower({ images: () => codec });
  const patch = (parts: [string, File][]) =>
    h.request("/api/v1/accounts/update_credentials", {
      method: "PATCH",
      body: multipartForm(parts),
      headers: { authorization: `Bearer ${h.users.alice.token}` },
    });
  const present = (id = h.users.alice.id) =>
    runInDurableObject(h.store, (_instance, state) =>
      presentAccountById(new Db(state.storage.sql), id, { origin: ORIGIN }),
    );
  return { ...h, codec, patch, present };
}

type H = Awaited<ReturnType<typeof setup>>;

const animated = (name = "a.webp") => new File([bytes(ANIMATED_WEBP)], name, { type: "image/webp" });
const still = (name = "a.png") => new File([bytes(PNG_PLAIN)], name, { type: "image/png" });

async function served(h: H, url: string): Promise<Uint8Array> {
  return new Uint8Array(await (await h.request(new URL(url).pathname)).arrayBuffer());
}

async function stored(h: H) {
  const [row] = await sql<{
    avatar: number;
    header: number;
    avatar_static_url: string | null;
    header_static_url: string | null;
  }>(
    h.store,
    `SELECT avatar_static_url, header_static_url,
			avatar_static_url IS (SELECT preview_url FROM media_attachments WHERE url = a.avatar_url) AS avatar,
			header_static_url IS (SELECT preview_url FROM media_attachments WHERE url = a.header_url) AS header
		FROM accounts a WHERE id = ?`,
    h.users.alice.id,
  );
  return row!;
}

// Stores alice's images and statics as given, `CAST(? AS TEXT)` for an ArrayBuffer (raw bytes).
async function setImages(h: H, id: string, columns: Record<string, string | ArrayBuffer | null>) {
  const names = Object.keys(columns);
  await sql(
    h.store,
    `UPDATE accounts SET ${names.map((name) => `${name} = CAST(? AS TEXT)`).join(", ")} WHERE id = ?`,
    ...Object.values(columns),
    id,
  );
}

describe("avatar_static and header_static of uploads", () => {
  it("are the still previews of animated images, served still while the images are animated", async () => {
    const h = await setup();
    const response = await h.patch([
      ["avatar", animated()],
      ["header", animated("h.webp")],
    ]);
    expect(response.status).toBe(200);
    const account = await response.json<Account>();
    for (const [image, still] of [
      [account.avatar, account.avatar_static],
      [account.header, account.header_static],
    ] as const) {
      expect(image).toMatch(/^https:\/\/kopje\.test\/media\/[A-Za-z0-9_-]+\/full\.webp$/);
      expect(still).toBe(image.replace(/\/full\.webp$/, "/small.webp"));
      expect(isAnimated(await served(h, image), "image/webp")).toBe(true);
      expect(isAnimated(await served(h, still), "image/webp")).toBe(false);
    }
    expect(await stored(h)).toMatchObject({ avatar: 1, header: 1 });
    expect(
      await sql(h.store, "SELECT json_extract(meta, '$.animated') AS animated FROM media_attachments ORDER BY id"),
    ).toEqual([{ animated: 1 }, { animated: 1 }]);
    // The same wherever the account is shown: verify_credentials, a status's account, the push icon's source.
    const verified = (await getJson<Account>(h, "/api/v1/accounts/verify_credentials", h.users.alice.token)).body;
    const status = await post(h, h.users.alice, { status: "hello" });
    const read = (await getJson<{ account: Account }>(h, `/api/v1/statuses/${status.id}`, h.users.alice.token)).body;
    for (const shown of [verified, read.account, await h.present()]) {
      expect([shown?.avatar_static, shown?.header_static]).toEqual([account.avatar_static, account.header_static]);
    }
  });

  it("are the images for still uploads, follow a replacement both ways, and are the defaults once removed", async () => {
    const h = await setup();
    const shown = async () => (await h.patch([])).json<Account>();
    expect((await h.patch([["avatar", still()]])).status).toBe(200);
    let account = await shown();
    expect(account.avatar_static).toBe(account.avatar);
    expect((await stored(h)).avatar_static_url).toBeNull();
    expect((await h.patch([["avatar", animated()]])).status).toBe(200);
    account = await shown();
    expect(account.avatar_static).toMatch(/\/small\.webp$/);
    expect((await h.patch([["avatar", still("b.png")]])).status).toBe(200);
    account = await shown();
    expect([account.avatar_static, (await stored(h)).avatar_static_url]).toEqual([account.avatar, null]);
    expect((await h.patch([["header", animated()]])).status).toBe(200);
    for (const kind of ["avatar", "header"]) {
      const removed = await h.request(`/api/v1/profile/${kind}`, bearer(h.users.alice.token, { method: "DELETE" }));
      expect(removed.status).toBe(200);
    }
    account = await shown();
    expect([account.avatar, account.avatar_static, account.header, account.header_static]).toEqual([
      DEFAULT_AVATAR,
      DEFAULT_AVATAR,
      DEFAULT_HEADER,
      DEFAULT_HEADER,
    ]);
    expect(await stored(h)).toMatchObject({ avatar_static_url: null, header_static_url: null });
  });

  it("are set from the settings page too", async () => {
    const h = await setup();
    const browser = await signIn(h);
    for (const kind of ["avatar", "header"]) {
      const form = multipartForm([
        ["csrf", await csrfOf(h, browser)],
        ["file", animated()],
      ]);
      const response = await h.request(`/settings/${kind}`, {
        method: "POST",
        headers: { cookie: browser.cookie, origin: ORIGIN },
        body: form,
      });
      expect(response.status, kind).toBe(303);
    }
    expect(await stored(h)).toMatchObject({
      avatar: 1,
      header: 1,
      avatar_static_url: expect.stringMatching(/small\.webp$/),
    });
  });

  it("are the defaults while the account is suspended", async () => {
    const h = await setup();
    expect((await h.patch([["avatar", animated()]])).status).toBe(200);
    await sql(h.store, "UPDATE local_accounts SET suspended_at = '2026-01-01T00:00:00.000Z'");
    expect(await h.present()).toMatchObject({ avatar: DEFAULT_AVATAR, avatar_static: DEFAULT_AVATAR, suspended: true });
  });

  it("show in an account moved to the local account (Account#moved)", async () => {
    const h = await setup();
    expect((await h.patch([["avatar", animated()]])).status).toBe(200);
    const source = "870000000000000001";
    await sql(
      h.store,
      `INSERT INTO accounts (id, uri, username, domain, moved_to_account_id)
			VALUES (?, 'https://remote.example/users/m', 'm', 'remote.example', ?)`,
      source,
      h.users.alice.id,
    );
    const alice = await h.present();
    expect((await h.present(source))?.moved).toMatchObject({
      id: h.users.alice.id,
      avatar: alice?.avatar,
      avatar_static: alice?.avatar_static,
    });
    expect(alice?.avatar_static).toMatch(/\/small\.webp$/);
  });
});

describe("profileAssignSql", () => {
  const UPLOAD = "900000000000000001";
  const IMAGE = "https://kopje.test/media/AAAA/full.webp";

  // Assigns an upload of `preview` and `meta` as alice's avatar; her stored static. An ArrayBuffer is stored as TEXT
  // of its raw bytes, or with `storage` 'blob' as a BLOB.
  async function assigned(
    h: H,
    preview: SqlStorageValue,
    meta = '{"animated":true}',
    storage: "text" | "blob" = "text",
  ) {
    return runInDurableObject(h.store, (_instance, state) => {
      const db = state.storage.sql;
      db.exec("DELETE FROM media_attachments WHERE id = ?", UPLOAD);
      const cast = preview instanceof ArrayBuffer && storage === "text";
      db.exec(
        `INSERT INTO media_attachments (id, account_id, type, url, preview_url, meta)
				VALUES (?, ?, 'image', ?, ${cast ? "CAST(? AS TEXT)" : "?"}, ?)`,
        UPLOAD,
        h.users.alice.id,
        IMAGE,
        preview,
        meta,
      );
      if (storage === "blob") {
        expect(db.exec("SELECT typeof(preview_url) AS t FROM media_attachments WHERE id = ?", UPLOAD).one().t).toBe(
          "blob",
        );
      }
      db.exec(profileAssignSql("avatar"), UPLOAD, h.users.alice.id);
      return db
        .exec<{ avatar_url: string; still: ArrayBuffer | null; preview: ArrayBuffer | null }>(
          `SELECT a.avatar_url, CAST(a.avatar_static_url AS BLOB) AS still, CAST(m.preview_url AS BLOB) AS preview
					FROM accounts a, media_attachments m WHERE a.id = ? AND m.id = ?`,
          h.users.alice.id,
          UPLOAD,
        )
        .one();
    });
  }

  it("copies an animated upload preview within the stored bound, byte for byte, and nothing else", async () => {
    const h = await setup();
    // 512 bytes of malformed UTF-8: copied as stored, never decoded.
    const malformed = await assigned(h, raw(`https://x/${"ÿ".repeat(STATIC_URL_LIMIT - 10)}`));
    expect(malformed.avatar_url).toBe(IMAGE);
    expect(malformed.still).not.toBeNull();
    expect(new Uint8Array(malformed.still!)).toEqual(new Uint8Array(malformed.preview!));
    // Past the bound, with a NUL, NULL, a BLOB, or a still upload: no static, the image set.
    for (const [name, preview, meta] of [
      ["513 bytes", `https://x/${"a".repeat(STATIC_URL_LIMIT - 9)}`],
      ["a NUL", "https://x/a\u0000b"],
      ["NULL", null],
      ["a BLOB", raw("https://x/small.webp")],
      ["a still upload", "https://x/small.webp", '{"original":{"width":1,"height":1}}'],
      ["animated false", "https://x/small.webp", '{"animated":false}'],
    ] as const) {
      const result =
        name === "a BLOB" ? await assigned(h, preview, '{"animated":true}', "blob") : await assigned(h, preview, meta);
      expect([result.avatar_url, result.still], name).toEqual([IMAGE, null]);
    }
  });

  it("reads the upload and the account by their keys, with no statistics and with stale ones", async () => {
    const h = await setup();
    const plan = () =>
      runInDurableObject(h.store, (_instance, state) =>
        state.storage.sql
          .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${profileAssignSql("header")}`, UPLOAD, h.users.alice.id)
          .toArray()
          .map((row) => row.detail),
      );
    const check = (details: string[]) => {
      expect(details.join("\n")).toMatch(/SEARCH m USING INDEX sqlite_autoindex_media_attachments_1 \(id=\?\)/);
      expect(details.join("\n")).toMatch(
        /SEARCH accounts USING (INTEGER PRIMARY KEY|INDEX sqlite_autoindex_accounts_1) \(/,
      );
      expect(scansOf(details, ["m", "media_attachments", "accounts"])).toEqual([]);
    };
    check(await plan());
    const { before, after } = await staleStatistics(h, {
      capture: plan,
      // The account's uploads grow past what the statistics saw: 10,000 more rows of one account.
      grow: () =>
        sql(
          h.store,
          `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
					INSERT INTO media_attachments (id, account_id, type, url)
					SELECT CAST(910000000000000000 + i AS TEXT), ?1, 'image', 'https://kopje.test/media/k' || i || '/full.png' FROM n`,
          h.users.alice.id,
        ),
    });
    check(before);
    check(after);
  }, 60_000);
});

describe("presented statics within their bounds (RES-2)", () => {
  // The stored witnesses: 512 bytes that the trigger takes (11 + 192 malformed bytes + 309 backslashes), which
  // serialize within PROFILE_URL_LIMIT (each 0xFF becomes %EF%BF%BD) but whose JSON doubles the backslashes past it;
  // and an image of 2,048 stored bytes, within its stored bound, whose JSON is past it.
  const STATIC_WITNESS = ESCAPED_STATIC_WITNESS;
  const IMAGE_WITNESS = `https://x/?${"\\".repeat(2037)}`;
  const VALID_STATIC = "https://kopje.test/media/AAAA/small.webp";
  const VALID_IMAGE = "https://kopje.test/media/AAAA/full.webp";

  it("are the stored bounds of the witnesses", () => {
    expect(STATIC_WITNESS.byteLength).toBe(STATIC_URL_LIMIT);
    expect(utf8(IMAGE_WITNESS)).toBe(PROFILE_URL_LIMIT);
    const href = new URL(new TextDecoder().decode(STATIC_WITNESS)).href;
    expect(href.length).toBe(PROFILE_URL_LIMIT);
    expect(utf8(JSON.stringify(href))).toBeGreaterThan(PROFILE_URL_LIMIT + 2);
    expect(new URL(IMAGE_WITNESS).href).toBe(IMAGE_WITNESS);
  });

  // Alice (full and partial) and a remote account moved to her (nested), each image as `columns` stores it.
  async function shown(columns: Record<string, string | ArrayBuffer | null>) {
    const h = await setup();
    await setImages(h, h.users.alice.id, columns);
    const source = "870000000000000001";
    await sql(
      h.store,
      `INSERT INTO accounts (id, uri, username, domain, moved_to_account_id)
			VALUES (?, 'https://remote.example/users/m', 'm', 'remote.example', ?)`,
      source,
      h.users.alice.id,
    );
    const full = await h.present();
    const nested = (await h.present(source))?.moved ?? undefined;
    const partial = await runInDurableObject(h.store, (_instance, state) => [
      ...partialAccountsOf(new Db(state.storage.sql), [h.users.alice.id], { origin: ORIGIN }),
    ]);
    const shownAs = (account: Pick<Account, "avatar" | "avatar_static"> & Partial<Account>) => [
      account.avatar,
      account.avatar_static,
      ...(account.header === undefined ? [] : [account.header, account.header_static]),
    ];
    return {
      full: shownAs(full!),
      nested: shownAs(nested!),
      partial: shownAs(partial[0]!),
      all: [full, nested, partial],
    };
  }

  const jsonWithin = (values: unknown, limit: number) => {
    for (const value of [values].flat(2)) {
      if (typeof value === "object" && value !== null) {
        for (const key of ["avatar", "avatar_static", "header", "header_static"] as const) {
          const href = (value as Partial<Account>)[key];
          if (href !== undefined) {
            expect(utf8(JSON.stringify(href)), key).toBeLessThanOrEqual(limit + 2);
          }
        }
      }
    }
  };

  it("shows the image for a static whose JSON passes its bound, in every presenter", async () => {
    const result = await shown({ avatar_url: VALID_IMAGE, avatar_static_url: STATIC_WITNESS });
    expect(result.full.slice(0, 2)).toEqual([VALID_IMAGE, VALID_IMAGE]);
    expect(result.partial).toEqual([VALID_IMAGE, VALID_IMAGE]);
    expect(result.nested.slice(0, 2)).toEqual([VALID_IMAGE, VALID_IMAGE]);
    jsonWithin(result.all, PROFILE_URL_LIMIT);
  });

  it("shows both defaults for an image whose JSON passes its bound, or that is no http(s) URL", async () => {
    for (const image of [IMAGE_WITNESS, "ftp://kopje.test/a.png"]) {
      for (const still of [STATIC_WITNESS, VALID_STATIC]) {
        const result = await shown({
          avatar_url: image,
          avatar_static_url: still,
          header_url: image,
          header_static_url: still,
        });
        expect(result.full).toEqual([DEFAULT_AVATAR, DEFAULT_AVATAR, DEFAULT_HEADER, DEFAULT_HEADER]);
        expect(result.nested).toEqual([DEFAULT_AVATAR, DEFAULT_AVATAR, DEFAULT_HEADER, DEFAULT_HEADER]);
        expect(result.partial).toEqual([DEFAULT_AVATAR, DEFAULT_AVATAR]);
        jsonWithin(result.all, PROFILE_URL_LIMIT);
      }
    }
  }, 60_000);

  it("shows a valid static with its valid image, in every presenter", async () => {
    const result = await shown({ avatar_url: VALID_IMAGE, avatar_static_url: VALID_STATIC });
    expect(result.full.slice(0, 2)).toEqual([VALID_IMAGE, VALID_STATIC]);
    expect(result.nested.slice(0, 2)).toEqual([VALID_IMAGE, VALID_STATIC]);
    expect(result.partial).toEqual([VALID_IMAGE, VALID_STATIC]);
  });
});
