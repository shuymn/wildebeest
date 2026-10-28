import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../../src/db/sql";
import {
  createAnnouncement,
  publishAnnouncement,
  reactToAnnouncement,
  unpublishAnnouncement,
  updateAnnouncement,
} from "../../src/domain/announcements";
import { streamAnnouncement } from "../../src/domain/stream-journal";
import { sha256Hex } from "../../src/security/tokens";
import { STREAM_LIMITS } from "../../src/stream-hub";
import {
  announcementHarness,
  derivedAnnouncementMaxima,
  idnMentionFill,
  mentionFill,
  reactionPath,
  seedAnnouncement,
  send,
  tagFill,
} from "../announcement-helpers";
import { seedAccount, sql } from "../api-helpers";
import { BUILD } from "../helpers";
import { localSnapshotAtCap } from "../local-emoji-helpers";
import { scopedToken } from "../read-helpers";
import { getJson } from "../status-helpers";
import { connect, drained, echo, type Inbox, type StreamMessage, subscribed } from "./stream-helpers";

// The `user` stream's announcement events (R33, R40; Mastodon's PublishScheduledAnnouncementWorker,
// UnpublishAnnouncementWorker and PublishAnnouncementReactionWorker): `announcement` with the entity as REST presents
// it, less the viewer's `read` and `me`; `announcement.reaction` with the name's count; `announcement.delete` with the
// id. Each write journals its own event, so the state when sent decides. Absence is proved with the drain barrier.

const EVENTS = ["announcement", "announcement.reaction", "announcement.delete"];

async function takeAllEvents(inbox: Inbox): Promise<void> {
  for (let left = events(inbox).length; left > 0; left--) {
    await inbox.next((m) => EVENTS.includes(m.event ?? ""));
  }
}

function events(inbox: Inbox): StreamMessage[] {
  return inbox.rest().filter((m) => EVENTS.includes(m.event ?? ""));
}

// The REST entity as the stream presents it: no `read`, no `me`.
function unviewed(entity: Record<string, unknown>): Record<string, unknown> {
  const { read: _read, reactions, ...rest } = entity as { read: boolean; reactions: Record<string, unknown>[] };
  return { ...rest, reactions: reactions.map(({ me: _me, ...reaction }) => reaction) };
}

describe("announcement events on user", () => {
  it("sends each transition as Mastodon does, presented with no viewer", async () => {
    const h = await announcementHarness(["alice", "bob"]);
    const inbox = await subscribed(h, h.users.alice.token, "user");
    const created = await h.admin.create({ text: "Hi @bob #news" });
    await drained(h, inbox);
    const [first, ...more] = events(inbox);
    expect(more).toEqual([]);
    expect(first).toMatchObject({ stream: ["user"], event: "announcement" });
    const listed = await getJson<Record<string, unknown>[]>(h, "/api/v1/announcements", h.users.alice.token);
    expect(JSON.parse(first!.payload!)).toEqual(unviewed(listed.body[0]!));
    expect(Object.keys(JSON.parse(first!.payload!))).not.toContain("read");
    await inbox.next((m) => m.event === "announcement");

    // A reaction, then its removal: the count goes to 0 with no image.
    await send(h, "PUT", reactionPath(created.id, "👍"), h.users.bob.token);
    await drained(h, inbox);
    await send(h, "DELETE", reactionPath(created.id, "👍"), h.users.bob.token);
    await drained(h, inbox);
    expect(events(inbox).map((m): unknown[] => [m.event, JSON.parse(m.payload!)])).toEqual([
      ["announcement.reaction", { name: "👍", count: 1, announcement_id: created.id }],
      ["announcement.reaction", { name: "👍", count: 0, announcement_id: created.id }],
    ]);
    await takeAllEvents(inbox);

    // An update of a published one, an unpublish, a publish and a delete; the delete's payload is the id itself.
    const take = async (): Promise<unknown[]> => {
      await drained(h, inbox);
      const [message, ...rest] = events(inbox);
      expect(rest).toEqual([]);
      await inbox.next((m) => EVENTS.includes(m.event ?? ""));
      return [
        message?.event,
        message?.event === "announcement"
          ? (JSON.parse(message.payload!) as { content: string }).content
          : message?.payload,
      ];
    };
    await h.admin.update(created.id, { text: "Changed" });
    expect(await take()).toEqual(["announcement", "<p>Changed</p>"]);
    await h.admin.unpublish(created.id);
    expect(await take()).toEqual(["announcement.delete", created.id]);
    // A change of an unpublished one sends nothing.
    await h.admin.update(created.id, { text: "Hidden" });
    await drained(h, inbox);
    expect(events(inbox)).toEqual([]);
    await h.admin.publish(created.id);
    expect(await take()).toEqual(["announcement", "<p>Hidden</p>"]);
    await h.admin.remove(created.id);
    expect(await take()).toEqual(["announcement.delete", created.id]);
    // A scheduled one is streamed when the cron publishes it, not when it is created.
    const scheduled = await h.admin.create({ scheduledAt: "2099-01-01T00:00:00.000Z" });
    await drained(h, inbox);
    expect(events(inbox)).toEqual([]);
    await h.store.announcementRound(BUILD, { now: Date.parse("2099-01-01T00:00:00.000Z") });
    await drained(h, inbox);
    expect(events(inbox).map((m) => [m.event, (JSON.parse(m.payload!) as { id: string }).id])).toEqual([
      ["announcement", scheduled.id],
    ]);
  });

  it("goes to `user` under read:statuses or read, and to no other stream or scope", async () => {
    const h = await announcementHarness(["alice"]);
    const statuses = await subscribed(h, await scopedToken(h, "read:statuses"), "user");
    const read = await subscribed(h, await scopedToken(h, "read"), "user");
    const notifications = await subscribed(h, await scopedToken(h, "read:notifications"), "user:notification");
    const others = await subscribed(h, h.users.alice.token, "user:notification", "public", "public:local", "direct");
    // A notifications-only token asking for `user` is refused the subscription.
    const notificationsOnUser = await connect(h, await scopedToken(h, "read:notifications"));
    notificationsOnUser.send({ type: "subscribe", stream: "user" });
    await echo(notificationsOnUser);
    await h.admin.create();
    await drained(h, statuses, read, notifications, others, notificationsOnUser);
    expect(events(statuses).map((m) => m.event)).toEqual(["announcement"]);
    expect(events(read).map((m) => m.event)).toEqual(["announcement"]);
    expect([events(notifications), events(others), events(notificationsOnUser)]).toEqual([[], [], []]);
    expect(notificationsOnUser.messages.some((m) => m.error !== undefined && m.status === 401)).toBe(true);
  });

  it("sends one event per write of a burst, each as the state is when it is sent", async () => {
    const h = await announcementHarness(["alice", "bob"]);
    const inbox = await subscribed(h, h.users.alice.token, "user");
    const authority = h.authority;
    const now = Date.now();
    const [alice, bob] = await Promise.all([sha256Hex(h.users.alice.token), sha256Hex(h.users.bob.token)]);
    // Written without the fan-out between them (the operations run in the Store, no turn requested).
    const created = await runInDurableObject(h.store, (_instance, state) => {
      const sql = state.storage.sql;
      const made = createAnnouncement.run(sql, {
        authority,
        text: "one",
        startsAt: null,
        endsAt: null,
        allDay: false,
        scheduledAt: null,
        now,
      });
      if (!made.ok) {
        throw new Error(made.code);
      }
      const { id } = made.announcement;
      updateAnnouncement.run(sql, { authority, id, changes: { text: "two" }, now: now + 1 });
      unpublishAnnouncement.run(sql, { authority, id, now: now + 2 });
      publishAnnouncement.run(sql, { authority, id, now: now + 3 });
      updateAnnouncement.run(sql, { authority, id, changes: { text: "three" }, now: now + 4 });
      // Two reactions of one name.
      for (const user of [alice, bob]) {
        const credential = { tokenHash: user, scope: "write:favourites" as const, now };
        const reacted = reactToAnnouncement.run(sql, { credential, id, name: "👍" });
        expect(reacted).toEqual({ status: "ok", value: "ok" });
      }
      return id;
    });
    const reaction = JSON.stringify([created, "👍"]);
    expect(await sql(h.store, "SELECT kind, subject FROM stream_events ORDER BY id")).toEqual([
      ...Array.from({ length: 5 }, () => ({ kind: "announcement", subject: created })),
      { kind: "announcement_reaction", subject: reaction },
      { kind: "announcement_reaction", subject: reaction },
    ]);
    await drained(h, inbox);
    const sent = events(inbox);
    expect(sent.map((m) => m.event)).toEqual([
      ...Array.from({ length: 5 }, () => "announcement"),
      "announcement.reaction",
      "announcement.reaction",
    ]);
    // Each is presented when it is sent, so all show the last state.
    for (const message of sent.slice(0, 5)) {
      expect((JSON.parse(message.payload!) as { content: string }).content).toBe("<p>three</p>");
    }
    for (const message of sent.slice(5)) {
      expect(JSON.parse(message.payload!)).toEqual({ name: "👍", count: 2, announcement_id: created });
    }
  });

  it("sends a socket opened while events are pending the changes written after it opened, and only those", async () => {
    const h = await announcementHarness(["alice", "bob"]);
    const early = await subscribed(h, h.users.alice.token, "user");
    const { id } = await h.admin.create({ text: "first" });
    await drained(h, early);
    await takeAllEvents(early);
    const [alice, bob] = await Promise.all([sha256Hex(h.users.alice.token), sha256Hex(h.users.bob.token)]);
    // The operations run in the Store directly, so no turn is requested, and neither is one by a socket's upgrade
    // or subscription: the fan-out is held until the drain barrier.
    const write = (text: string, reactor: string) =>
      runInDurableObject(h.store, (_instance, state) => {
        const sql = state.storage.sql;
        updateAnnouncement.run(sql, { authority: h.authority, id, changes: { text }, now: Date.now() });
        const credential = { tokenHash: reactor, scope: "write:favourites" as const, now: Date.now() };
        expect(reactToAnnouncement.run(sql, { credential, id, name: "👍" })).toEqual({ status: "ok", value: "ok" });
      });
    const position = () => sql<{ event_id: number }>(h.store, "SELECT event_id FROM stream_cursor");
    const held = await position();
    // An update and a reaction pending, then the second socket opens and subscribes.
    await write("pending", alice);
    const late = await connect(h, h.users.bob.token);
    late.send({ type: "subscribe", stream: "user" });
    await echo(late);
    // Then an update and a reaction written after it subscribed, still with nothing sent.
    await write("after", bob);
    expect(await position()).toEqual(held);
    expect(
      (
        await sql<{ kind: string }>(
          h.store,
          "SELECT kind FROM stream_events WHERE id > ? ORDER BY id",
          held[0]!.event_id,
        )
      ).map((row) => row.kind),
    ).toEqual(["announcement", "announcement_reaction", "announcement", "announcement_reaction"]);
    await drained(h, early, late);
    const shown = (inbox: Inbox) =>
      events(inbox).map((m) => [
        m.event,
        m.event === "announcement"
          ? (JSON.parse(m.payload!) as { content: string }).content
          : (JSON.parse(m.payload!) as { count: number }).count,
      ]);
    // Each presented when sent: the last text and both reactions.
    expect(shown(late)).toEqual([
      ["announcement", "<p>after</p>"],
      ["announcement.reaction", 2],
    ]);
    expect(shown(early)).toEqual([
      ["announcement", "<p>after</p>"],
      ["announcement.reaction", 2],
      ["announcement", "<p>after</p>"],
      ["announcement.reaction", 2],
    ]);
  });

  it("sends nothing to the socket of a revoked token, which is closed", async () => {
    const h = await announcementHarness(["alice"]);
    const inbox = await subscribed(h, h.users.alice.token, "user");
    await sql(h.store, "DELETE FROM oauth_tokens WHERE kind = 'access'");
    await h.admin.create();
    await drained(h);
    await inbox.closed();
    expect(events(inbox)).toEqual([]);
  });
});

describe("announcement events at their bounds (RES-3)", () => {
  it("sends the widest combined text and the reviewed texts, none skipped", async () => {
    const h = await announcementHarness(["alice"]);
    const inbox = await subscribed(h, h.users.alice.token, "user");
    // The widest combined text (hashtags, emoji and as many mentions as fit, as test/announcement-bounds.test.ts
    // builds it), imported, then published.
    const snapshot = JSON.parse(await localSnapshotAtCap(h.store, h.users.alice.id, 12_288)) as [string, string][];
    const emojiText = snapshot.map(([name]) => `:${name}:`).join(" ");
    const tags = tagFill();
    const room = 10_000 - new TextEncoder().encode(`${tags} ${emojiText} `).length;
    const combo = [tags, emojiText, await mentionFill(h.store, Math.floor((room + 1) / 625), 0)].join(" ");
    expect(new TextEncoder().encode(combo).length).toBeLessThanOrEqual(10_000);
    await seedAnnouncement(h.store, { id: "200000000000000009", text: combo, published: 0, published_at: null });
    const widest = await h.admin.publish("200000000000000009");
    // 3,332 references to one account whose URL is 2,048 bytes of ampersands, imported, then published.
    const u = await seedAccount(h.store, { username: "u", email: "u@example.com" });
    await sql(h.store, "UPDATE accounts SET url = ? WHERE id = ?", `https://r.example/?${"&".repeat(2029)}`, u);
    await seedAnnouncement(h.store, {
      id: "200000000000000001",
      text: `日 ${"@u ".repeat(3332)}`,
      published: 0,
      published_at: null,
    });
    await h.admin.publish("200000000000000001");
    // IDN mentions, a hashtag rendering to 310 KB, and linked hashtags followed by 8,200 quotes.
    const reviewed: [string, string][] = [
      ["200000000000000004", await idnMentionFill(h.store)],
      ["200000000000000002", `#${"\uFDFA".repeat(3333)}`],
      ["200000000000000003", `${"#a ".repeat(600)}${'"'.repeat(8200)}`],
    ];
    for (const [id, text] of reviewed) {
      await seedAnnouncement(h.store, { id, text, published: 0, published_at: null });
      await h.admin.publish(id);
    }
    await drained(h, inbox);
    const sent = events(inbox).map((m) => ({
      event: m.event,
      id: (JSON.parse(m.payload!) as { id: string }).id,
      bytes: new TextEncoder().encode(m.payload).length,
    }));
    console.log(JSON.stringify({ event: "announcement-stream-payloads", sent }));
    expect(sent.map((m) => [m.event, m.id])).toEqual([
      ["announcement", widest.id],
      ["announcement", "200000000000000001"],
      ["announcement", "200000000000000004"],
      ["announcement", "200000000000000002"],
      ["announcement", "200000000000000003"],
    ]);
    const contents = events(inbox).map((m) => (JSON.parse(m.payload!) as { content: string }).content);
    expect(contents.slice(3)).toEqual([
      `<p>#${"\uFDFA".repeat(3333)}</p>`,
      `<p>${"#a ".repeat(599)}#a ${"&quot;".repeat(8200)}</p>`,
    ]);
    // Each within the entity's derived maximum, and its double-encoded payload within the hub's limit.
    const derived = derivedAnnouncementMaxima();
    for (const { bytes } of sent) {
      expect(bytes).toBeLessThanOrEqual(derived.entity);
    }
    expect(derived.stream).toBeLessThan(STREAM_LIMITS.payloadBytes);
    expect((JSON.parse(events(inbox)[2]!.payload!) as { mentions: unknown[] }).mentions).toHaveLength(16);
  }, 60_000);
});

describe("the announcement journal", () => {
  // The journal helper on its own: a listener on `user`, the cursor at event 5.
  async function journal(rows: { id: number; kind: string; subject: string }[], cursor: number) {
    const h = await announcementHarness(["alice"]);
    await sql(
      h.store,
      "INSERT INTO stream_subscriptions (account_id, stream_key, sockets) VALUES (?, 'user', 1)",
      h.users.alice.id,
    );
    for (const row of rows) {
      await sql(
        h.store,
        "INSERT INTO stream_events (id, kind, subject, created_at) VALUES (?, ?, ?, '2026-10-12T00:00:00.000Z')",
        row.id,
        row.kind,
        row.subject,
      );
    }
    await sql(h.store, "UPDATE stream_cursor SET event_id = ?, account_id = NULL WHERE id = 1", cursor);
    const record = (kind: "announcement" | "announcement_reaction", subject: string) =>
      runInDurableObject(h.store, (_instance, state) =>
        streamAnnouncement(new Db(state.storage.sql), kind, subject, "2026-10-12T00:00:00.000Z"),
      );
    const ids = async () =>
      (await sql<{ id: number }>(h.store, "SELECT id FROM stream_events ORDER BY id")).map((row) => row.id);
    return { h, record, ids };
  }

  it("records every write, whether the same event is ahead of, at or behind the position", async () => {
    for (const [at, cursor] of [
      [6, 5],
      [5, 5],
      [4, 5],
    ] as const) {
      const j = await journal([{ id: at, kind: "announcement", subject: "a" }], cursor);
      await j.record("announcement", "a");
      await j.record("announcement_reaction", "a");
      expect(await j.ids()).toEqual([at, at + 1, at + 2]);
    }
  });

  it("records nothing while nobody listens on `user`, or once the journal spans 4,096 ids", async () => {
    const full = await journal(
      [
        { id: 1, kind: "status", subject: "1" },
        { id: 4097, kind: "status", subject: "2" },
      ],
      0,
    );
    await full.record("announcement", "a");
    expect(await full.ids()).toEqual([1, 4097]);
    const almost = await journal(
      [
        { id: 2, kind: "status", subject: "1" },
        { id: 4097, kind: "status", subject: "2" },
      ],
      0,
    );
    await almost.record("announcement", "a");
    expect(await almost.ids()).toEqual([2, 4097, 4098]);
    await sql(almost.h.store, "DELETE FROM stream_subscriptions");
    await almost.record("announcement", "b");
    expect(await almost.ids()).toEqual([2, 4097, 4098]);
  });
});
