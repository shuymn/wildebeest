import { describe, expect, it } from "vitest";

import { announcementHarness, reactionPath, seedAnnouncement, send, T0 } from "./announcement-helpers";
import { bearer, sql } from "./api-helpers";
import { seedEmojiRow } from "./local-emoji-helpers";
import { appToken, appTokenWith, scopedToken } from "./read-helpers";
import { getJson, remoteAccount } from "./status-helpers";

// Announcements as clients see them (Api::V1::AnnouncementsController, Announcements::ReactionsController,
// REST::AnnouncementSerializer): the list of published ones with the viewer's read and reactions, dismissals and
// reactions, under the access Mastodon gives each route (AUTH-2); R40, MD-4.

type Listed = {
  id: string;
  content: string;
  read: boolean;
  starts_at: string | null;
  mentions: { id: string; acct: string }[];
  tags: { name: string; url: string }[];
  emojis: { shortcode: string }[];
  reactions: { name: string; count: number; me: boolean; url?: string; static_url?: string }[];
};

const list = async (h: Parameters<typeof getJson>[0], token: string) => {
  const { status, body } = await getJson<Listed[]>(h, "/api/v1/announcements", token);
  expect(status).toBe(200);
  return body;
};

describe("GET /api/v1/announcements", () => {
  it("presents a published announcement in Mastodon’s key order, rendered from its text", async () => {
    const h = await announcementHarness(["alice", "bob"]);
    const media = await seedEmojiRow(h.store, { id: "300000000000000001", shortcode: "blob", owner: h.users.alice.id });
    const remote = await remoteAccount(h.store, "carol", "remote.example");
    const created = await h.admin.create({
      text: "Hi @bob and @carol@remote.example and @nobody, see #News and https://example.com/a :blob:\n\nBye <b>",
      startsAt: "2026-11-01T00:00:00.000Z",
      endsAt: "2026-11-02T00:00:00.000Z",
      allDay: true,
    });
    expect(await send(h, "PUT", reactionPath(created.id, "👍"), h.users.bob.token)).toEqual({ status: 200, body: {} });
    const [entity, ...rest] = await list(h, h.users.alice.token);
    expect(rest).toEqual([]);
    expect(Object.keys(entity!)).toEqual([
      "id",
      "content",
      "starts_at",
      "ends_at",
      "all_day",
      "published_at",
      "updated_at",
      "read",
      "mentions",
      "statuses",
      "tags",
      "emojis",
      "reactions",
    ]);
    const mediaUrl = `https://kopje.test/media/${media.token}/full.png`;
    expect(entity).toEqual({
      id: created.id,
      content:
        '<p>Hi <span class="h-card"><a href="https://kopje.test/@bob" class="u-url mention">@<span>bob</span></a></span>' +
        ' and <span class="h-card"><a href="https://remote.example/@carol" class="u-url mention">@<span>carol</span></a></span>' +
        ' and @nobody, see <a href="https://kopje.test/tags/news" class="mention hashtag" rel="tag">#<span>News</span></a>' +
        ' and <a href="https://example.com/a" target="_blank" rel="nofollow noopener noreferrer"><span class="invisible">https://</span><span class="">example.com/a</span><span class="invisible"></span></a> :blob:</p>' +
        "<p>Bye &lt;b&gt;</p>",
      starts_at: "2026-11-01T00:00:00.000Z",
      ends_at: "2026-11-02T00:00:00.000Z",
      all_day: true,
      published_at: created.published_at,
      updated_at: created.updated_at,
      read: false,
      mentions: [
        { id: h.users.bob.id, username: "bob", url: "https://kopje.test/@bob", acct: "bob" },
        { id: remote, username: "carol", url: "https://remote.example/@carol", acct: "carol@remote.example" },
      ],
      statuses: [],
      tags: [{ name: "news", url: "https://kopje.test/tags/news" }],
      emojis: [{ shortcode: "blob", url: mediaUrl, static_url: mediaUrl, visible_in_picker: true }],
      reactions: [{ name: "👍", count: 1, me: false }],
    });
  });

  it("lists only published ones, oldest first by start, schedule, publication or creation, then id", async () => {
    const h = await announcementHarness(["alice"]);
    const id = (n: number) => String(200_000_000_000_000_000n + BigInt(n));
    await seedAnnouncement(h.store, { id: id(1), text: "published late", published_at: "2026-10-05T00:00:00.000Z" });
    await seedAnnouncement(h.store, {
      id: id(2),
      text: "starts early",
      starts_at: "2026-10-01T00:00:00.000Z",
      ends_at: "2026-12-01T00:00:00.000Z",
    });
    await seedAnnouncement(h.store, { id: id(4), text: "tie, higher id", published_at: "2026-10-03T00:00:00.000Z" });
    await seedAnnouncement(h.store, { id: id(3), text: "tie, lower id", published_at: "2026-10-03T00:00:00.000Z" });
    await seedAnnouncement(h.store, { id: id(5), text: "draft", published: 0, published_at: null });
    await seedAnnouncement(h.store, {
      id: id(6),
      text: "scheduled",
      published: 0,
      published_at: null,
      scheduled_at: T0,
    });
    expect((await list(h, h.users.alice.token)).map((a) => a.id)).toEqual([id(2), id(3), id(4), id(1)]);
  });

  it("answers any user token whatever its scopes, refuses others (AUTH-2), and reads no parameter", async () => {
    const h = await announcementHarness(["alice"]);
    await h.admin.create();
    for (const scope of ["read:accounts read:statuses", "write", "push"]) {
      const { status, body } = await getJson<unknown[]>(h, "/api/v1/announcements", await scopedToken(h, scope));
      expect([status, body.length]).toEqual([200, 1]);
    }
    // with_dismissed is ignored, as Mastodon 4.5 ignores it.
    await send(
      h,
      "POST",
      `/api/v1/announcements/${(await list(h, h.users.alice.token))[0]!.id}/dismiss`,
      h.users.alice.token,
    );
    expect(await list(h, h.users.alice.token)).toHaveLength(1);
    expect(
      (await getJson<unknown[]>(h, "/api/v1/announcements?with_dismissed=false", h.users.alice.token)).body,
    ).toHaveLength(1);
    expect((await h.request("/api/v1/announcements")).status).toBe(401);
    expect((await h.request("/api/v1/announcements", bearer("nope"))).status).toBe(401);
    expect(await getJson(h, "/api/v1/announcements", await appToken(h))).toEqual({
      status: 422,
      body: { error: "This method requires an authenticated user" },
    });
    const token = await scopedToken(h, "read");
    await sql(
      h.store,
      "UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?",
      "2026-01-01",
      h.users.alice.id,
    );
    expect((await h.request("/api/v1/announcements", bearer(token))).status).toBe(403);
  });

  it("shows a suspended or unknown mention as text and only available accounts in mentions (R1)", async () => {
    const h = await announcementHarness(["alice", "bob"]);
    await sql(h.store, "UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?", T0, h.users.bob.id);
    await h.admin.create({ text: "@bob @alice@kopje.test @ALICE" });
    const [entity] = await list(h, h.users.alice.token);
    expect(entity!.mentions.map((m) => m.acct)).toEqual(["alice"]);
    expect(entity!.content).toBe(
      '<p>@bob <span class="h-card"><a href="https://kopje.test/@alice" class="u-url mention">@<span>alice</span></a></span>' +
        ' <span class="h-card"><a href="https://kopje.test/@alice" class="u-url mention">@<span>alice</span></a></span></p>',
    );
  });
});

describe("POST /api/v1/announcements/:id/dismiss", () => {
  it("marks it read for the viewer only, idempotently", async () => {
    const h = await announcementHarness(["alice", "bob"]);
    const { id } = await h.admin.create();
    const path = `/api/v1/announcements/${id}/dismiss`;
    expect(await send(h, "POST", path, h.users.alice.token)).toEqual({ status: 200, body: {} });
    expect(await send(h, "POST", path, h.users.alice.token)).toEqual({ status: 200, body: {} });
    expect((await list(h, h.users.alice.token)).map((a) => a.read)).toEqual([true]);
    expect((await list(h, h.users.bob.token)).map((a) => a.read)).toEqual([false]);
  });
});

describe("the routes of one announcement", () => {
  const recordNotFound = { status: 404, body: { error: "Record not found" } };
  const routes = (id: string): [string, string, string][] => [
    ["POST", `/api/v1/announcements/${id}/dismiss`, "write:accounts"],
    ["PUT", reactionPath(id, "👍"), "write:favourites"],
    ["PATCH", reactionPath(id, "❤"), "write:favourites"],
    ["DELETE", reactionPath(id, "👍"), "write:favourites"],
  ];

  it("answer 404 for an unpublished, unknown or non-digit id (R40)", async () => {
    const h = await announcementHarness(["alice"]);
    const draft = await h.admin.create({ scheduledAt: "2099-01-01T00:00:00.000Z" });
    const unpublished = await h.admin.create();
    await h.admin.unpublish(unpublished.id);
    for (const id of [draft.id, unpublished.id, "123456789012345678", "1", "abc", `${draft.id}0`]) {
      for (const [method, path] of routes(id)) {
        expect(await send(h, method, path, h.users.alice.token), `${method} ${path}`).toEqual(recordNotFound);
      }
    }
  });

  it("answer the user under their scopes (AUTH-2)", async () => {
    const h = await announcementHarness(["alice"]);
    const { id } = await h.admin.create();
    for (const [method, path, scope] of routes(id)) {
      // The DELETE removes the PUT's reaction.
      expect(await send(h, method, path, await scopedToken(h, scope)), `${method} ${path}`).toEqual({
        status: 200,
        body: {},
      });
      expect((await send(h, method, path)).status).toBe(401);
      expect((await send(h, method, path, "nope")).status).toBe(401);
      expect(await send(h, method, path, await scopedToken(h, "read"))).toEqual({
        status: 403,
        body: { error: "This action is outside the authorized scopes" },
      });
      expect(await send(h, method, path, await appTokenWith(h, scope))).toEqual({
        status: 422,
        body: { error: "This method requires an authenticated user" },
      });
    }
    const token = await scopedToken(h, "write");
    await sql(h.store, "UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?", T0, h.users.alice.id);
    for (const [method, path] of routes(id)) {
      expect((await send(h, method, path, token)).status).toBe(403);
    }
  });
});

describe("reactions", () => {
  const invalid = (message: string) => ({ status: 422, body: { error: `Validation failed: ${message}` } });

  it("counts each name, with the viewer’s own `me`, in order of first reaction, and removes the viewer’s own", async () => {
    const h = await announcementHarness(["alice", "bob"]);
    const { id } = await h.admin.create();
    await send(h, "PUT", reactionPath(id, "👍"), h.users.alice.token);
    await send(h, "PATCH", reactionPath(id, "❤"), h.users.bob.token);
    await send(h, "PUT", reactionPath(id, "👍"), h.users.bob.token);
    const shown = async (token: string) => (await list(h, token))[0]!.reactions;
    expect(await shown(h.users.alice.token)).toEqual([
      { name: "👍", count: 2, me: true },
      { name: "❤", count: 1, me: false },
    ]);
    expect(await shown(h.users.bob.token)).toEqual([
      { name: "👍", count: 2, me: true },
      { name: "❤", count: 1, me: true },
    ]);
    expect(await send(h, "PUT", reactionPath(id, "👍"), h.users.alice.token)).toEqual({
      status: 422,
      body: { error: "Duplicate record" },
    });
    // Unqualified and qualified forms are different names, each stored as sent.
    expect(await send(h, "PUT", reactionPath(id, "❤️"), h.users.alice.token)).toEqual({ status: 200, body: {} });
    expect(await send(h, "DELETE", reactionPath(id, "❤"), h.users.alice.token)).toEqual({
      status: 404,
      body: { error: "Record not found" },
    });
    expect(await send(h, "DELETE", reactionPath(id, "👍"), h.users.alice.token)).toEqual({ status: 200, body: {} });
    // 👍's first reaction left with Alice's, so ❤'s is now the earliest.
    expect(await shown(h.users.alice.token)).toEqual([
      { name: "❤", count: 1, me: false },
      { name: "👍", count: 1, me: false },
      { name: "❤️", count: 1, me: true },
    ]);
  });

  it("refuses as Mastodon, in its order: blank, then the emoji and the limit together, then a repeat", async () => {
    const h = await announcementHarness(["alice", "bob"]);
    const { id } = await h.admin.create();
    const put = (name: string, token = h.users.alice.token) => send(h, "PUT", reactionPath(id, name), token);
    const blank = invalid("Name can't be blank");
    // Rails' [[:space:]]: ASCII and Unicode white space, U+0085 included; U+FEFF is not blank.
    for (const name of [" ", "  ", "\t", "　", "\u0085", "  "]) {
      expect(await put(name), JSON.stringify(name)).toEqual(blank);
    }
    expect(await put("﻿")).toEqual(invalid("Name is not a recognized emoji"));
    for (const name of ["a", "1", "#", "❤❤", "<b>", "blob", "\u{1F600}".repeat(32) + "a"]) {
      expect(await put(name), name).toEqual(invalid("Name is not a recognized emoji"));
    }
    for (const name of ["1⃣", "2⃣", "3⃣", "4⃣", "5⃣", "6⃣", "7⃣", "8⃣"]) {
      expect(await put(name), name).toEqual({ status: 200, body: {} });
    }
    // At eight names: a new one is refused, with the emoji error first when both apply; an existing one is added.
    expect(await put("👍")).toEqual(invalid("Limit of different reactions reached"));
    expect(await put("a")).toEqual(invalid("Name is not a recognized emoji, Limit of different reactions reached"));
    expect(await put(" ")).toEqual(blank);
    expect(await put("\u0085")).toEqual(blank);
    expect(await put("1⃣", h.users.bob.token)).toEqual({ status: 200, body: {} });
    expect(await put("1⃣", h.users.bob.token)).toEqual({ status: 422, body: { error: "Duplicate record" } });
    // An unpublished announcement is 404 before any of this.
    await h.admin.unpublish(id);
    expect(await put(" ")).toEqual({ status: 404, body: { error: "Record not found" } });
  });

  it("names an enabled local custom emoji by its shortcode, groups by name, and shows the first one’s image", async () => {
    const h = await announcementHarness(["alice", "bob"]);
    const { id } = await h.admin.create();
    const first = await seedEmojiRow(h.store, { id: "300000000000000001", shortcode: "blob", owner: h.users.alice.id });
    await seedEmojiRow(h.store, {
      id: "300000000000000002",
      shortcode: "gone",
      owner: h.users.alice.id,
      disabled: true,
    });
    expect(await send(h, "PUT", reactionPath(id, "gone"), h.users.alice.token)).toEqual(
      invalid("Name is not a recognized emoji"),
    );
    expect(await send(h, "PUT", reactionPath(id, "blob"), h.users.alice.token)).toEqual({ status: 200, body: {} });
    // The emoji is replaced: disabled, and another of the shortcode enabled. Bob's reaction names the new one.
    await sql(h.store, "UPDATE custom_emojis SET disabled = 1 WHERE id = '300000000000000001'");
    const second = await seedEmojiRow(h.store, {
      id: "300000000000000003",
      shortcode: "blob",
      owner: h.users.alice.id,
    });
    expect(await send(h, "PUT", reactionPath(id, "blob"), h.users.bob.token)).toEqual({ status: 200, body: {} });
    const url = `https://kopje.test/media/${first.token}/full.png`;
    expect((await list(h, h.users.bob.token))[0]!.reactions).toEqual([
      { name: "blob", count: 2, me: true, url, static_url: url },
    ]);
    expect(await sql(h.store, "SELECT custom_emoji_id FROM announcement_reactions ORDER BY id")).toEqual([
      { custom_emoji_id: first.id },
      { custom_emoji_id: second.id },
    ]);
  });

  it("keeps an imported reaction id past 2^53 exact: its order and its emoji image", async () => {
    const h = await announcementHarness(["alice", "bob"]);
    const { id } = await h.admin.create();
    const emoji = await seedEmojiRow(h.store, { id: "300000000000000001", shortcode: "blob", owner: h.users.alice.id });
    // Ids 9 and 10 order numerically (as text, '10' sorts first); 2^53 + 1 is not a JavaScript number (it would
    // read as 2^53, which names no row).
    await sql(
      h.store,
      `INSERT INTO announcement_reactions (id, announcement_id, account_id, name, custom_emoji_id) VALUES
				(10, ?1, ?2, '❤', NULL), (9, ?1, ?2, '👍', NULL), (9007199254740993, ?1, ?3, 'blob', ?4)`,
      id,
      h.users.alice.id,
      h.users.bob.id,
      emoji.id,
    );
    const url = `https://kopje.test/media/${emoji.token}/full.png`;
    expect((await list(h, h.users.alice.token))[0]!.reactions).toEqual([
      { name: "👍", count: 1, me: true },
      { name: "❤", count: 1, me: true },
      { name: "blob", count: 1, me: false, url, static_url: url },
    ]);
    // Its removal reads no id back.
    expect(await send(h, "DELETE", reactionPath(id, "blob"), h.users.bob.token)).toEqual({ status: 200, body: {} });
    expect(
      await sql(
        h.store,
        "SELECT CAST(id AS TEXT) AS id FROM announcement_reactions ORDER BY announcement_reactions.id",
      ),
    ).toEqual([{ id: "9" }, { id: "10" }]);
  });

  it("accepts RGI emoji and their unqualified forms at the route", async () => {
    const h = await announcementHarness(["alice"]);
    const { id } = await h.admin.create();
    for (const name of ["🇯🇵", "👨‍👩‍👧", "🏋🏼‍♂", "1️⃣", "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}"]) {
      expect(await send(h, "PUT", reactionPath(id, name), h.users.alice.token), name).toEqual({
        status: 200,
        body: {},
      });
    }
    expect((await list(h, h.users.alice.token))[0]!.reactions).toHaveLength(5);
  });
});
