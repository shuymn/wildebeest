import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { sweepMedia } from "../src/mastodon/media";
import { API_BODY_LIMIT, FILE_PART_SLACK } from "../src/mastodon/params";
import type { StoreStub } from "../src/platform/store-client";
import { bearer, json, sql, userToken } from "./api-helpers";
import { NOW } from "./app-helpers";
import { PNG_PLAIN } from "./fixtures/images";
import { type Attachment, bytes, mediaForm, multipartForm, TestCodec, uploaded } from "./media-helpers";
import { community, getJson, outbound, post } from "./status-helpers";

// `thumbnail` on media uploads, media updates and status edits: Kopje media are images, so any thumbnail is refused
// with MediaAttachment's validation error (Mastodon v4.5.11 app/models/media_attachment.rb:207), before any work.

const REFUSED = { error: "Validation failed: Thumbnail must be blank" };
const DATA_URI = `data:image/png;base64,${PNG_PLAIN}`;

// A bucket that records the keys put through it (RES-6: a refused upload writes nothing).
function recordingBucket(): { bucket: R2Bucket; puts: string[] } {
  const real = env.MEDIA;
  const puts: string[] = [];
  const bucket = {
    put: (key: string, value: Uint8Array, options?: R2PutOptions) => {
      puts.push(key);
      return real.put(key, value, options);
    },
    delete: (keys: string | string[]) => real.delete(keys),
    get: (key: string) => real.get(key),
    head: (key: string) => real.head(key),
    list: (options?: R2ListOptions) => real.list(options),
  } as unknown as R2Bucket;
  return { bucket, puts };
}

async function users() {
  const codec = new TestCodec();
  const { bucket, puts } = recordingBucket();
  const h = await community(["alice", "bob"], "read write follow", { images: () => codec }, { MEDIA: bucket });
  return { ...h, codec, puts };
}

const png = () => new File([bytes(PNG_PLAIN)], "t.png", { type: "image/png" });

async function state(store: StoreStub): Promise<{ name: string; value: string }[]> {
  return sql<{ name: string; value: string }>(store, "SELECT name, value FROM kopje_state ORDER BY name");
}

// A raw multipart upload: an image file, then an empty `thumbnail` file part with an empty filename (Rack drops it).
function emptyFilenameUpload(): { body: Uint8Array; type: string } {
  const encoder = new TextEncoder();
  const head = encoder.encode(
    '--b\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n',
  );
  const tail = encoder.encode(
    '\r\n--b\r\nContent-Disposition: form-data; name="thumbnail"; filename=""\r\n' +
      "Content-Type: image/png\r\n\r\n\r\n--b--\r\n",
  );
  const image = bytes(PNG_PLAIN);
  const body = new Uint8Array(head.length + image.length + tail.length);
  body.set(head);
  body.set(image, head.length);
  body.set(tail, head.length + image.length);
  return { body, type: "multipart/form-data; boundary=b" };
}

describe.each(["v1", "v2"] as const)("POST /api/%s/media with a thumbnail", (version) => {
  const send = (h: Awaited<ReturnType<typeof users>>, form: FormData, query = "", token = h.users.alice.token) =>
    h.request(`/api/${version}/media${query}`, bearer(token, { method: "POST", body: form }));

  it("refuses a thumbnail file before any transformation, budget charge or write (RES-6)", async () => {
    const h = await users();
    const before = await state(h.store);
    const response = await send(
      h,
      multipartForm([
        ["file", png()],
        ["thumbnail", png()],
      ]),
    );
    expect([response.status, await response.json()]).toEqual([422, REFUSED]);
    expect(h.codec.calls).toBe(0);
    expect(h.puts).toEqual([]);
    // The attempt is counted, and no transformation is charged to either budget.
    const after = await state(h.store);
    const attempts = after.find((row) => row.name === `media_attempts:${h.users.alice.id}`);
    expect(JSON.parse(attempts?.value ?? "[]")).toEqual([NOW]);
    expect(after.filter((row) => row.name.startsWith("images_"))).toEqual(
      before.filter((row) => row.name.startsWith("images_")),
    );
    // The reservation is abandoned, and the sweep takes it at once.
    expect(await sql(h.store, "SELECT processed, url, gc_at FROM media_attachments")).toEqual([
      { processed: 1, url: "", gc_at: new Date(NOW).toISOString() },
    ]);
    const swept = await sweepMedia(env, {
      build: () => env.CF_VERSION_METADATA.id,
      now: () => NOW,
      store: () => h.store,
    });
    expect(swept).toBe(1);
    expect(await sql(h.store, "SELECT id FROM media_attachments")).toEqual([]);
  });

  it("refuses a zero-byte file and non-empty text, a data URI past the field bound included", async () => {
    const h = await users();
    const zero = new File([], "empty.png", { type: "image/png" });
    for (const thumbnail of [zero, DATA_URI, "x", `data:image/png;base64,${"A".repeat(7000)}`]) {
      const response = await send(
        h,
        multipartForm([
          ["file", png()],
          ["thumbnail", thumbnail],
        ]),
      );
      expect([response.status, await response.json()]).toEqual([422, REFUSED]);
    }
    expect(h.codec.calls).toBe(0);
    expect(h.puts).toEqual([]);
  });

  it("reads empty text and an empty filename as absent", async () => {
    const h = await users();
    expect(
      (
        await send(
          h,
          multipartForm([
            ["file", png()],
            ["thumbnail", ""],
          ]),
        )
      ).status,
    ).toBe(200);
    const { body, type } = emptyFilenameUpload();
    const emptyName = await h.request(
      `/api/${version}/media`,
      bearer(h.users.alice.token, { method: "POST", body, headers: { "content-type": type } }),
    );
    expect(emptyName.status).toBe(200);
  });

  it("reads the last of repeated thumbnail parts, as Rails assigns them", async () => {
    const h = await users();
    const fileThenText = multipartForm([
      ["file", png()],
      ["thumbnail", png()],
      ["thumbnail", ""],
    ]);
    expect((await send(h, fileThenText)).status).toBe(200);
    const textThenFile = multipartForm([
      ["file", png()],
      ["thumbnail", ""],
      ["thumbnail", png()],
    ]);
    expect([(await send(h, textThenFile)).status]).toEqual([422]);
  });

  it("reads the query when the body sends none, its last value winning, and the body over the query", async () => {
    const h = await users();
    const plain = () => multipartForm([["file", png()]]);
    for (const query of ["?thumbnail=x", "?thumbnail=&thumbnail=x"]) {
      const response = await send(h, plain(), query);
      expect([query, response.status, await response.json()]).toEqual([query, 422, REFUSED]);
    }
    expect((await send(h, plain(), "?thumbnail=x&thumbnail=")).status).toBe(200);
    const blankBody = multipartForm([
      ["file", png()],
      ["thumbnail", ""],
    ]);
    expect((await send(h, blankBody, "?thumbnail=x")).status).toBe(200);
    const fileBody = multipartForm([
      ["file", png()],
      ["thumbnail", png()],
    ]);
    expect((await send(h, fileBody, "?thumbnail=")).status).toBe(422);
  });

  it("answers an over-long description first, and authentication before either", async () => {
    const h = await users();
    const both = () =>
      multipartForm([
        ["file", png()],
        ["description", "x".repeat(1501)],
        ["thumbnail", png()],
      ]);
    const described = await send(h, both());
    expect([described.status, await described.json()]).toEqual([
      422,
      { error: "Validation failed: Description is too long (maximum is 1500 characters)" },
    ]);
    const thumbnailOnly = () =>
      multipartForm([
        ["file", png()],
        ["thumbnail", png()],
      ]);
    expect((await send(h, thumbnailOnly(), "", "not-a-token")).status).toBe(401);
    const reader = await userToken(h, "alice@example.com", "read");
    expect((await send(h, thumbnailOnly(), "", reader)).status).toBe(403);
    expect(h.codec.calls).toBe(0);
  });
});

describe.each(["PUT", "PATCH"] as const)("%s /api/v1/media/:id with a thumbnail", (method) => {
  async function described() {
    const h = await users();
    const media = await uploaded(h, h.users.alice, mediaForm(bytes(PNG_PLAIN), { description: "kept" }));
    const update = (init: RequestInit, token = h.users.alice.token, query = "") =>
      h.request(`/api/v1/media/${media.id}${query}`, bearer(token, { ...init, method }));
    return { h, media, update };
  }

  it("refuses a multipart thumbnail file and changes nothing", async () => {
    const { h, media, update } = await described();
    const response = await update({
      body: multipartForm([
        ["description", "new"],
        ["thumbnail", png()],
      ]),
    });
    expect([response.status, await response.json()]).toEqual([422, REFUSED]);
    const shown = await getJson<Attachment>(h, `/api/v1/media/${media.id}`, h.users.alice.token);
    expect(shown.body.description).toBe("kept");
  });

  it("refuses JSON and query text, and reads null or empty text as absent", async () => {
    const { update } = await described();
    const refused = await update(json({ thumbnail: DATA_URI }));
    expect([refused.status, await refused.json()]).toEqual([422, REFUSED]);
    expect((await update(json({ description: "d" }), undefined, "?thumbnail=x")).status).toBe(422);
    for (const thumbnail of [null, "", { nested: null }]) {
      const response = await update(json({ thumbnail, description: "still" }));
      expect([JSON.stringify(thumbnail), response.status]).toEqual([JSON.stringify(thumbnail), 200]);
    }
  });

  it("bounds the body at the text limit plus one part header allowance (RES-1)", async () => {
    const { update } = await described();
    const small = new File([new Uint8Array(4096)], "t.bin");
    expect((await update({ body: multipartForm([["thumbnail", small]]) })).status).toBe(422);
    const large = new File([new Uint8Array(API_BODY_LIMIT + FILE_PART_SLACK)], "t.bin");
    const tooLarge = await update({ body: multipartForm([["thumbnail", large]]) });
    expect([tooLarge.status, await tooLarge.json()]).toEqual([413, { error: "Request body is too large" }]);
  });

  it("answers authentication first, and the thumbnail before the media lookup", async () => {
    const { h, update } = await described();
    const body = () => multipartForm([["thumbnail", png()]]);
    expect((await update({ body: body() }, "not-a-token")).status).toBe(401);
    const reader = await userToken(h, "alice@example.com", "read");
    expect((await update({ body: body() }, reader)).status).toBe(403);
    const foreign = await update({ body: body() }, h.users.bob.token);
    expect([foreign.status, await foreign.json()]).toEqual([422, REFUSED]);
  });
});

describe("media_attributes[][thumbnail] on a status edit", () => {
  async function withMedia() {
    const h = await users();
    const media = await uploaded(h, h.users.alice, mediaForm(bytes(PNG_PLAIN), {}, "a.png", "image/png"));
    const status = await post(h, h.users.alice, { status: "x", media_ids: [media.id] });
    const edit = (init: RequestInit, token = h.users.alice.token) =>
      h.request(`/api/v1/statuses/${status.id}`, bearer(token, { ...init, method: "PUT" }));
    const editJson = (attributes: unknown[], token?: string) =>
      edit(json({ status: "edited", media_ids: [media.id], media_attributes: attributes }), token);
    const updates = async () => (await outbound(h.store)).filter((o) => o.activity.type === "Update").length;
    return { h, media, status, edit, editJson, updates };
  }

  it("refuses a JSON data URI on an entry with an id, before anything is written", async () => {
    const { h, media, status, editJson, updates } = await withMedia();
    const sent = await updates();
    const response = await editJson([{ id: media.id, description: "d", thumbnail: DATA_URI }]);
    expect([response.status, await response.json()]).toEqual([422, REFUSED]);
    const shown = await getJson<{ content: string }>(h, `/api/v1/statuses/${status.id}`, h.users.alice.token);
    expect(shown.body.content).toBe("<p>x</p>");
    const history = await getJson<unknown[]>(h, `/api/v1/statuses/${status.id}/history`, h.users.alice.token);
    expect(history.body).toHaveLength(1);
    expect(await updates()).toBe(sent);
  });

  it("refuses a multipart thumbnail file grouped with an id", async () => {
    const { media, edit } = await withMedia();
    const body = multipartForm([
      ["status", "edited"],
      ["media_ids[]", media.id],
      ["media_attributes[][id]", media.id],
      ["media_attributes[][thumbnail]", png()],
    ]);
    const response = await edit({ body });
    expect([response.status, await response.json()]).toEqual([422, REFUSED]);
  });

  it("groups on file-valued fields as Rack does, so a thumbnail left without an id is ignored", async () => {
    const { media, edit } = await withMedia();
    const sequential = multipartForm([
      ["status", "edited"],
      ["media_ids[]", media.id],
      ["media_attributes[][id]", png()],
      ["media_attributes[][thumbnail]", png()],
      ["media_attributes[][id]", media.id],
    ]);
    expect((await edit({ body: sequential })).status).toBe(200);
    // A later file-valued `id` replaces the text one, and reads as absent.
    const indexed = multipartForm([
      ["status", "edited again"],
      ["media_ids[]", media.id],
      ["media_attributes[0][id]", media.id],
      ["media_attributes[0][thumbnail]", png()],
      ["media_attributes[0][id]", png()],
    ]);
    expect((await edit({ body: indexed })).status).toBe(200);
  });

  it("reads empty text and nested nulls as absent, and ignores an entry without an id", async () => {
    const { media, editJson } = await withMedia();
    const accepted: unknown[][] = [
      [{ id: media.id, thumbnail: "" }],
      [{ id: media.id, thumbnail: null }],
      [{ id: media.id, thumbnail: { nested: null } }],
      [{ id: media.id, thumbnail: [null] }],
      [{ thumbnail: DATA_URI }],
    ];
    for (const attributes of accepted) {
      const response = await editJson(attributes);
      expect([JSON.stringify(attributes), response.status]).toEqual([JSON.stringify(attributes), 200]);
    }
  });

  it("answers authentication first, and the thumbnail before the status lookup", async () => {
    const { h, media, editJson } = await withMedia();
    const attributes = [{ id: media.id, thumbnail: DATA_URI }];
    expect((await editJson(attributes, "not-a-token")).status).toBe(401);
    const reader = await userToken(h, "alice@example.com", "read");
    expect((await editJson(attributes, reader)).status).toBe(403);
    const foreign = await editJson(attributes, h.users.bob.token);
    expect([foreign.status, await foreign.json()]).toEqual([422, REFUSED]);
  });
});
