import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { beforeEach, describe, expect, it } from "vitest";

import { threadsOf } from "../cli/lib/cutover/verify-expect.js";
import { MAX_LOCAL_ADDRESSED } from "../src/platform/identity-bounds.js";
import {
  convert as convertIn,
  exportOf as exportIn,
  opened,
  tampered as tamperedIn,
  failing,
  rewriteExport,
  verify as verifyWith,
  workspace,
} from "./cutover-helpers.js";
import type { FixtureOptions } from "./legacy-fixture.js";

// The converter end to end on synthetic exports (DATA-11 to DATA-14): convert, then check the result against
// expectations computed independently from the export, and show the check fails on each kind of damage.

const space = workspace();
const exportOf = (options: FixtureOptions, name?: string) => exportIn(space.dir, options, name);
const convert = (exportPath: string, extra?: Parameters<typeof convertIn>[2]) =>
  convertIn(space.dir, exportPath, extra);
const verify = (exportPath: string, dumpPath: string, acceptDeletions = false) =>
  verifyWith(exportPath, dumpPath, { acceptDeletions });
const tampered = (dumpPath: string, sql: string) => tamperedIn(space.dir, dumpPath, sql);
const dir = () => space.dir;

describe("convert and verify-conversion", () => {
  for (const options of [
    { level: 0 },
    { level: 10 },
    { level: 10, line: "T2" as const },
    { level: 18 },
    { level: 23 },
    { level: 35 },
    { level: 39 },
    { level: 23, actorTypeDrift: true },
    { level: 39, actorTypeDrift: true },
  ]) {
    const name = `${options.line ?? "T1"} export at level ${options.level}${"actorTypeDrift" in options ? " with actors.type added back" : ""}`;
    it(`converts a ${name} and the independent check passes`, async () => {
      const exportPath = await exportOf(options);
      const { ok, manifest, dumpPath } = await convert(exportPath);
      expect(manifest.stop).toBeUndefined();
      expect(ok).toBe(true);
      const { ok: verified, report } = await verify(exportPath, dumpPath);
      const categories = (
        report as { categories: Record<string, { expected: number; missing: number; extra: number; changed: number }> }
      ).categories;
      const failing = Object.entries(categories).filter(([, c]) => c.missing + c.extra + c.changed > 0);
      expect(failing).toEqual([]);
      expect(verified).toBe(true);
      for (const name of [
        "accounts",
        "keys",
        "statuses",
        "audience",
        "follows",
        "favourites",
        "notifications",
        "clients",
      ]) {
        expect(categories[name]?.expected, name).toBeGreaterThan(0);
      }
      expect(categories.boosts?.expected ?? 0).toBe(options.level >= 2 ? 3 : 0);
      if (options.level >= 23) {
        expect(categories.edits?.expected).toBe(1);
      }
      if (options.level >= 32) {
        expect(categories.lists?.expected).toBe(1);
        expect(categories.blocks?.expected).toBe(2);
      }
    });
  }

  it("makes the conversations of the direct statuses carried, as migration 0009 makes them", async () => {
    const exportPath = await exportOf({ level: 39, directMessages: true });
    // The boosts, favourite and bookmark of the Note name it by the id it lost, so they are dropped.
    const { ok, dumpPath } = await convert(exportPath, { acceptDeletions: true });
    expect(ok).toBe(true);
    const { ok: verified, report } = await verify(exportPath, dumpPath);
    expect(verified).toBe(true);
    expect((report as { categories: Record<string, { expected: number }> }).categories.conversations?.expected).toBe(3);
    const db = await opened(dumpPath);
    const rows = () =>
      db
        .prepare(
          `SELECT a.username AS owner, c.thread, (SELECT group_concat(p.username) FROM json_each(c.participants) j
							JOIN accounts p ON p.id = j.value) AS participants, c.unread,
						(SELECT group_concat(s.content, ' | ') FROM (SELECT s.content FROM conversation_statuses cs
							JOIN statuses s ON s.id = cs.status_id WHERE cs.conversation_id = c.id ORDER BY s.id) s) AS statuses,
						c.last_status_id = (SELECT max(status_id) FROM conversation_statuses WHERE conversation_id = c.id) AS newest
					FROM conversations c JOIN accounts a ON a.id = c.account_id ORDER BY c.id`,
        )
        .all();
    // Alice's two direct messages to r0, each a thread of its own (r1, tagged in the second, is not addressed, so no
    // recipient), and r1's to her with her answer in its thread: read, as her answer is the last status.
    const converted = rows();
    expect(converted).toEqual([
      expect.objectContaining({
        owner: "alice",
        participants: "r0",
        unread: 0,
        statuses: "<p>@r0 a secret direct message</p>",
      }),
      expect.objectContaining({ owner: "alice", participants: "r0", unread: 0, newest: 1 }),
      expect.objectContaining({
        owner: "alice",
        // The conversation r1's object names, which alice's answer takes too.
        thread: "tag:remote.example,2024-03-01:objectId=171:objectType=Conversation",
        participants: "r1",
        unread: 0,
        statuses: expect.stringMatching(/just us<\/p> \| <p>@r1 just us, then<\/p>$/),
        newest: 1,
      }),
    ]);
    // The migration's own backfill makes the same rows of the converted statuses.
    const migration = await readFile(
      fileURLToPath(new URL("../migrations/0009_conversations.sql", import.meta.url)),
      "utf8",
    );
    db.exec("DELETE FROM conversations");
    db.exec(
      migration.slice(migration.indexOf("CREATE TABLE conversation_backfill"), migration.indexOf("CREATE TRIGGER")),
    );
    expect(rows()).toEqual(converted);
  });

  it("reads sqlite_sequence as D1 exports it (a reset, then the counter rows), and refuses a second reset", async () => {
    const exportPath = await exportOf({ level: 39, notificationSequence: 12n });
    const file = join(exportPath, "sqlite_sequence.sql");
    const text = await readFile(file, "utf8");
    expect(text).toMatch(
      /^PRAGMA defer_foreign_keys=TRUE;\nDELETE FROM sqlite_sequence;\nINSERT INTO "sqlite_sequence"/,
    );
    const { ok, manifest, dumpPath } = await convert(exportPath);
    expect(ok).toBe(true);
    expect(manifest.source).toMatchObject({ notificationSequence: "12" });
    expect((await verify(exportPath, dumpPath)).ok).toBe(true);

    await writeFile(file, `${text}DELETE FROM sqlite_sequence;\n`);
    const again = await convert(exportPath, { out: "out-again" });
    expect(again.ok).toBe(false);
    expect(again.manifest.stop).toMatchObject({ code: "unexpected-statement" });
    const { ok: verified, report } = await verify(exportPath, dumpPath);
    expect(verified).toBe(false);
    expect(report.stop).toMatchObject({ code: "unexpected-statement" });
  });

  it("keeps legacy ids, accepted follows without a Follow record, local media and old /ap/o ids", async () => {
    const exportPath = await exportOf({ level: 39 });
    const { manifest, dumpPath } = await convert(exportPath);
    const conversion = manifest.conversion as Record<string, Record<string, number>>;
    expect(conversion.normalized).toMatchObject({
      "follows:accepted-without-follow-record": 2,
      "list_accounts:not-followed-left-out": 1,
      "notifications:duplicate-merged": 1,
      "statuses:remote-without-original-uri": 1,
    });
    expect(conversion.legacyIds).toMatchObject({ accounts: 2, statuses: 6, statuses_ap_o: 3, media_ap_o: 3 });
    const db = await opened(dumpPath);
    const value = (sql: string) => Object.values(db.prepare(sql).get() ?? {})[0];
    // Accepted follows without a Follow record keep uri NULL; one with an activity gets its id.
    expect(value("SELECT count(*) FROM follows WHERE state = 'accepted' AND uri IS NULL")).toBe(2);
    expect(value("SELECT uri FROM follows WHERE uri LIKE '%/ap/a/follow-300'")).toBe(
      "https://kopje.test/ap/a/follow-300",
    );
    // A list keeps the account its owner follows; bob, who follows the owner but is not followed, is left out.
    expect(value("SELECT group_concat(a.username) FROM list_accounts la JOIN accounts a ON a.id = la.account_id")).toBe(
      "r0",
    );
    // Old media stays at its URLs, and old Image ids are kept.
    expect(value("SELECT count(*) FROM media_attachments WHERE url LIKE 'https://images.example/%'")).toBe(3);
    expect(value("SELECT count(*) FROM media_attachments WHERE status_id IS NULL AND legacy_ap_o IS NOT NULL")).toBe(1);
    // Every id is 18 digits; notifications keep theirs, and the counter continues past the largest.
    expect(value("SELECT count(*) FROM statuses WHERE length(id) <> 18")).toBe(0);
    expect(value("SELECT group_concat(id) FROM (SELECT id FROM notifications ORDER BY id)")).toBe("1,2,3,4,6,7,8,9");
    expect(value("SELECT seq FROM sqlite_sequence WHERE name = 'notifications'")).toBe(9);
    // The DM stays direct, and remote raw is the legacy text byte for byte.
    expect(value("SELECT visibility FROM statuses WHERE content LIKE '%secret direct%'")).toBe("direct");
    expect(value("SELECT count(*) FROM statuses WHERE raw IS NOT NULL")).toBe(4);
    expect(value("SELECT value FROM kopje_state WHERE name = 'last_local_id'")).toMatch(/^\d{18}$/);
    // The language is the primary subtag of the first in contentMap.
    expect(value("SELECT language FROM statuses WHERE content LIKE '%a reply to alice%'")).toBe("pt");
    // Spaced times with a zone are read in that zone; an update at publication is no edit.
    const times = (match: string) =>
      db.prepare(`SELECT published_at, edited_at FROM statuses WHERE content LIKE '%${match}%'`).get();
    expect(times("a DM to alice")).toEqual({
      published_at: "2024-03-01T11:49:00.000Z",
      edited_at: "2024-03-01T11:55:00.000Z",
    });
    expect(times("a reply to alice")).toEqual({ published_at: "2024-03-01T11:59:00.000Z", edited_at: null });
    expect(times("lost its original id")).toMatchObject({ edited_at: "2024-03-01T12:15:00.000Z" });
    // Hashtags as Kopje names them (Mastodon's HashtagNormalizer), once each: NFKC, lowercase, folded to ASCII, and
    // every number sign dropped, from a received Hashtag's name and from legacy's recorded names alike.
    expect(value("SELECT group_concat(name) FROM (SELECT name FROM status_tags ORDER BY name)")).toBe(
      "bare,cafe,cats,cats,double,foo,full,hash,small,wide,wildebeest",
    );
    // A hashtag is listed on hashtag timelines exactly when its status is public.
    expect(
      db
        .prepare(
          `SELECT s.visibility = 'public' AS public, t.public AS listed, count(*) AS n
					FROM status_tags t JOIN statuses s ON s.id = t.status_id GROUP BY 1, 2 ORDER BY 1, 2`,
        )
        .all(),
    ).toEqual([
      { public: 0, listed: 0, n: expect.any(Number) },
      { public: 1, listed: 1, n: expect.any(Number) },
    ]);
    // A mention is marked as one home's mentions stream reads exactly when its status is direct or limited
    // (REQUIRES_MENTION_SQL in src/domain/audience.ts, which this Node suite does not load), and names the status's
    // author.
    expect(
      value(
        "SELECT count(*) FROM status_mentions m JOIN statuses s ON s.id = m.status_id WHERE m.author_id IS NOT s.account_id",
      ),
    ).toBe(0);
    expect(
      db
        .prepare(
          `SELECT s.visibility IN ('direct', 'limited') AS required, m.requires_mention AS marked, count(*) AS n
					FROM status_mentions m JOIN statuses s ON s.id = m.status_id GROUP BY 1, 2 ORDER BY 1, 2`,
        )
        .all(),
    ).toEqual([
      { required: 0, marked: 0, n: expect.any(Number) },
      { required: 1, marked: 1, n: expect.any(Number) },
    ]);
    // An unset discoverable: false for a local account, as legacy had it; unknown for a remote one.
    expect(value("SELECT discoverable FROM accounts WHERE uri LIKE '%/users/alice'")).toBe(1);
    expect(value("SELECT discoverable FROM accounts WHERE uri LIKE '%/users/Bob'")).toBe(0);
    expect(value("SELECT count(*) FROM accounts WHERE domain IS NOT NULL AND discoverable IS NOT NULL")).toBe(0);
    db.close();
  });

  describe("the check fails on damage (DATA-12)", () => {
    const cases: [string, string, string][] = [
      ["a status is missing", "DELETE FROM statuses WHERE content LIKE '%followers only%'", "statuses"],
      ["content is emptied", "UPDATE statuses SET content = '' WHERE content LIKE '%followers only%'", "statuses"],
      [
        "content is rewritten to the same length",
        "UPDATE statuses SET content = replace(content, 'followers only', 'FOLLOWERS ONLY') WHERE content LIKE '%followers only%'",
        "statuses",
      ],
      [
        "source text is rewritten",
        "UPDATE statuses SET source_text = upper(source_text) WHERE source_text = 'Bob says hi'",
        "statuses",
      ],
      ["a DM is widened", "UPDATE statuses SET visibility = 'public' WHERE visibility = 'direct'", "audience"],
      ["remote raw is changed", "UPDATE statuses SET raw = replace(raw, 'Note', 'Nope') WHERE raw IS NOT NULL", "raw"],
      ["an edit is dropped", "DELETE FROM status_edits WHERE id = (SELECT min(id) FROM status_edits)", "edits"],
      [
        "an attachment moves",
        "UPDATE media_attachments SET url = url || '?' WHERE status_id IS NOT NULL",
        "attachments",
      ],
      ["a profile is changed", "UPDATE accounts SET display_name = 'X' WHERE domain IS NULL", "accounts"],
      ["a wrapped key byte changes", "UPDATE local_accounts SET privkey = zeroblob(length(privkey))", "keys"],
      ["a follow is dropped", "DELETE FROM follows WHERE state = 'pending'", "follows"],
      ["a follow loses its Follow record", "UPDATE follows SET uri = NULL", "follows"],
      [
        "a favourite is added",
        "INSERT INTO favourites (account_id, status_id) SELECT a.id, s.id FROM accounts a, statuses s WHERE a.domain IS NULL AND s.reblog_of_id IS NULL AND NOT EXISTS (SELECT 1 FROM favourites f WHERE f.account_id = a.id AND f.status_id = s.id) LIMIT 1",
        "favourites",
      ],
      ["a boost is dropped", "DELETE FROM statuses WHERE reblog_of_id IS NOT NULL", "boosts"],
      ["a notification is dropped", "DELETE FROM notifications WHERE id = 1", "notifications"],
      ["a list member is dropped", "DELETE FROM list_accounts", "list_accounts"],
      ["a setting changes", "UPDATE instance_settings SET value = '[\"x\"]' WHERE name = 'rules'", "settings"],
      ["a client secret changes", "UPDATE oauth_clients SET secret = 'x'", "clients"],
      ["a legacy id is lost", "UPDATE statuses SET legacy_id = NULL", "legacy_ids"],
      [
        "a DM recipient is removed",
        "DELETE FROM status_mentions WHERE status_id = (SELECT id FROM statuses WHERE content LIKE '%secret direct%')",
        "audience",
      ],
      [
        "a DM recipient is not marked",
        "UPDATE status_mentions SET requires_mention = 0 WHERE status_id = (SELECT id FROM statuses WHERE content LIKE '%secret direct%')",
        "audience",
      ],
      [
        "a public mention is marked",
        "UPDATE status_mentions SET requires_mention = 1 WHERE status_id IN (SELECT id FROM statuses WHERE visibility = 'public' AND reblog_of_id IS NULL)",
        "audience",
      ],
      [
        "a mention names another author",
        "UPDATE status_mentions SET author_id = (SELECT id FROM accounts WHERE uri LIKE '%/users/r4') WHERE status_id = (SELECT id FROM statuses WHERE content LIKE '%secret direct%')",
        "audience",
      ],
      [
        "a DM recipient is added",
        "INSERT INTO status_mentions (status_id, account_id, silent) SELECT s.id, a.id, 1 FROM statuses s, accounts a WHERE s.content LIKE '%secret direct%' AND a.uri LIKE '%/users/r4'",
        "audience",
      ],
      [
        "a followers-only status gets a non-follower recipient",
        "INSERT INTO status_mentions (status_id, account_id, silent) SELECT s.id, a.id, 0 FROM statuses s, accounts a WHERE s.content LIKE '%followers only%' AND a.uri LIKE '%/users/r3'",
        "audience",
      ],
      ["a reply link is dropped", "UPDATE statuses SET in_reply_to_id = NULL", "replies"],
      [
        "an unattached image changes owner",
        "UPDATE media_attachments SET account_id = (SELECT id FROM accounts WHERE uri LIKE '%/users/Bob') WHERE status_id IS NULL AND legacy_ap_o IS NOT NULL",
        "media",
      ],
      [
        "an image moves to another status",
        "UPDATE media_attachments SET status_id = (SELECT id FROM statuses WHERE content LIKE '%Bob says hi%') WHERE legacy_ap_o IS NOT NULL AND status_id IS NOT NULL",
        "media",
      ],
      [
        "a followers-only boost gets a recipient",
        "INSERT INTO status_mentions (status_id, account_id, silent) SELECT s.id, a.id, 1 FROM statuses s, accounts a WHERE s.uri LIKE '%000000000220' AND a.uri LIKE '%/users/r4'",
        "boosts",
      ],
      [
        "a followers-only status names another author",
        "UPDATE statuses SET account_id = (SELECT id FROM accounts WHERE uri LIKE '%/users/Bob') WHERE content LIKE '%followers only%'",
        "audience",
      ],
      ["a remote proxy alias is lost", "UPDATE statuses SET legacy_ap_o = NULL", "aliases"],
      [
        "the notification counter goes back",
        "UPDATE sqlite_sequence SET seq = 1 WHERE name = 'notifications'",
        "counters",
      ],
      ["a follow preference changes", "UPDATE follows SET notify = 1", "follows"],
      ["a mute gets an expiry", "UPDATE mutes SET expires_at = '2026-01-01T00:00:00.000Z'", "mutes"],
      ["a list policy changes", "UPDATE lists SET replies_policy = 'none'", "lists"],
      ["client scopes change", "UPDATE oauth_clients SET scopes = 'read write follow push admin'", "clients"],
      ["a client loses its website", "UPDATE oauth_clients SET website = NULL", "clients"],
      ["a hashtag is dropped", "DELETE FROM status_tags WHERE name = 'wildebeest'", "statuses"],
      ["a hashtag keeps its case", "UPDATE status_tags SET name = 'Cats' WHERE name = 'cats'", "statuses"],
      ["a public hashtag is not listed", "UPDATE status_tags SET public = 0 WHERE public = 1", "statuses"],
      ["a hidden hashtag is listed", "UPDATE status_tags SET public = 1 WHERE public = 0", "statuses"],
      [
        "a boost gets a hashtag",
        "INSERT INTO status_tags (status_id, name) SELECT id, 'cats' FROM statuses WHERE reblog_of_id IS NOT NULL LIMIT 1",
        "statuses",
      ],
      ["a status loses its language", "UPDATE statuses SET language = NULL WHERE language IS NOT NULL", "statuses"],
      ["a language keeps its region", "UPDATE statuses SET language = 'pt-BR' WHERE language = 'pt'", "statuses"],
      [
        "an update at publication becomes an edit",
        "UPDATE statuses SET edited_at = published_at WHERE content LIKE '%a reply to alice%'",
        "statuses",
      ],
      [
        "a time with an offset is read as UTC",
        "UPDATE statuses SET published_at = '2024-03-01T20:59:00.000Z' WHERE content LIKE '%a reply to alice%'",
        "statuses",
      ],
      [
        "an edit time at an offset is dropped",
        "UPDATE statuses SET edited_at = NULL WHERE content LIKE '%a DM to alice%'",
        "statuses",
      ],
      // The names an NFKC and lowercase normalization gave, before Kopje normalized as Mastodon does.
      ["a Hashtag keeps a second #", "UPDATE status_tags SET name = '#double' WHERE name = 'double'", "statuses"],
      ["a recorded name keeps its number sign", "UPDATE status_tags SET name = '#foo' WHERE name = 'foo'", "statuses"],
      ["a hashtag keeps its diacritic", "UPDATE status_tags SET name = 'café' WHERE name = 'cafe'", "statuses"],
      [
        "an unset local discoverable becomes unknown",
        "UPDATE accounts SET discoverable = NULL WHERE uri LIKE '%/users/Bob'",
        "accounts",
      ],
      [
        "an unset remote discoverable becomes false",
        "UPDATE accounts SET discoverable = 0 WHERE domain IS NOT NULL",
        "accounts",
      ],
      ["an actor type changes", "UPDATE accounts SET actor_type = 'Person' WHERE actor_type = 'Service'", "accounts"],
      // A URL within its stored bound is kept (src/platform/stored-bounds.ts).
      ["a remote profile loses its URL", "UPDATE accounts SET url = NULL WHERE domain IS NOT NULL", "accounts"],
      [
        "a remote status loses its URL",
        "UPDATE statuses SET url = NULL WHERE url IS NOT NULL AND reblog_of_id IS NULL",
        "statuses",
      ],
      ["an alias is dropped", "UPDATE local_accounts SET also_known_as = '[]'", "keys"],
      ["the default visibility changes", "UPDATE local_accounts SET default_visibility = 'public'", "keys"],
      ["the default sensitivity changes", "UPDATE local_accounts SET default_sensitive = 0", "keys"],
      ["the default language is dropped", "UPDATE local_accounts SET default_language = NULL", "keys"],
      ["a follow loses its languages", "UPDATE follows SET languages = NULL", "follows"],
      ["a favourite loses its Like record", "UPDATE favourites SET uri = NULL", "favourites"],
      ["a block loses its Block record", "UPDATE blocks SET uri = NULL", "blocks"],
      ["a status takes its own thread", "UPDATE statuses SET thread = uri WHERE in_reply_to_id IS NOT NULL", "threads"],
      ["a conversation is marked unread", "UPDATE conversations SET unread = 1 - unread", "conversations"],
      ["a conversation loses its statuses", "DELETE FROM conversation_statuses", "conversations"],
    ];
    let exportPath: string;
    let dumpPath: string;
    beforeEach(async () => {
      exportPath = await exportOf({ level: 39 });
      dumpPath = (await convert(exportPath)).dumpPath;
    });
    for (const [name, sql, category] of cases) {
      it(`FAILs when ${name}`, async () => {
        const { ok, report } = await verify(exportPath, await tampered(dumpPath, sql));
        expect(ok).toBe(false);
        const result = (report as { categories: Record<string, { missing: number; extra: number; changed: number }> })
          .categories[category];
        expect(result, category).toBeDefined();
        expect((result?.missing ?? 0) + (result?.extra ?? 0) + (result?.changed ?? 0)).toBeGreaterThan(0);
      });
    }

    it("passes on an untouched round trip through the same tamper path", async () => {
      expect((await verify(exportPath, await tampered(dumpPath, "SELECT 1"))).ok).toBe(true);
    });
  });

  it("stops on rows the bridge removes until --accept-deletions, and then still verifies", async () => {
    const exportPath = await exportOf({ level: 5, withDeletions: true });
    const stopped = await convert(exportPath);
    expect(stopped.ok).toBe(false);
    expect(stopped.manifest.stop).toMatchObject({ code: "deletions-not-accepted" });
    const accepted = await convert(exportPath, { acceptDeletions: true, out: "accepted" });
    expect(accepted.ok).toBe(true);
    expect((await verify(exportPath, accepted.dumpPath, true)).ok).toBe(true);
  });

  it("checks that one KEK candidate unwraps every key, naming candidates only (DATA-14)", async () => {
    const mixed = await exportOf({ level: 39, keks: { alice: "", bob: "legacy-kek-value" } });
    const stopped = await convert(mixed);
    expect(stopped.ok).toBe(false);
    expect(stopped.manifest.kek).toMatchObject({ uniform: false });
    expect(JSON.stringify(stopped.manifest)).not.toContain("legacy-kek-value");

    const same = await exportOf({ level: 39, keks: { alice: "legacy-kek-value", bob: "legacy-kek-value" } }, "same");
    const withoutSecret = await convert(same, { out: "no-secret" });
    expect(withoutSecret.manifest.kek).toMatchObject({ uniform: false, users: [{ kek: null }, { kek: null }] });
    const converted = await convert(same, { out: "secret", env: { USER_KEY: "legacy-kek-value" } });
    expect(converted.ok).toBe(true);
    expect(converted.manifest.kek).toMatchObject({ uniform: true, kek: "USER_KEY", emptyKek: false });
  });

  it("keeps wrapped keys byte for byte (DATA-1: no re-wrapping)", async () => {
    const exportPath = await exportOf({ level: 39 });
    const { dumpPath } = await convert(exportPath);
    const legacy = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
    for (const table of ["users"]) {
      legacy.exec(await readFile(join(exportPath, `${table}.sql`), "utf8"));
    }
    const db = await opened(dumpPath);
    const hex = (sql: string, d: DatabaseSync) => (d.prepare(sql).all() as { k: string }[]).map((r) => r.k).toSorted();
    expect(
      hex("SELECT hex(privkey) || ':' || hex(privkey_salt) || ':' || pubkey AS k FROM local_accounts", db),
    ).toEqual(hex("SELECT hex(privkey) || ':' || hex(privkey_salt) || ':' || pubkey AS k FROM users", legacy));
  });

  it("runs from the real CLI under Node and prints counts and digests only (DATA-13)", async () => {
    const exportPath = await exportOf({ level: 39 });
    const cli = fileURLToPath(new URL("../cli/kopje-admin.js", import.meta.url));
    const out = join(dir(), "cli-out");
    const run = promisify(execFile);
    const converted = await run(process.execPath, [
      cli,
      "convert",
      exportPath,
      "--out",
      out,
      "--base-time",
      "2026-10-20T00:00:00Z",
    ]);
    const verified = await run(process.execPath, [cli, "verify-conversion", exportPath, join(out, "kopje.dump")]);
    const printed = converted.stdout + converted.stderr + verified.stdout + verified.stderr;
    expect(verified.stdout).toContain('"result": "PASS"');
    for (const secret of [
      "secret direct message",
      "alice@example.com",
      "kopje.test",
      "BEGIN PUBLIC KEY",
      "fixture-client-secret",
      "remote.example",
    ]) {
      expect(printed).not.toContain(secret);
    }
    const manifest = await readFile(join(out, "manifest.json"), "utf8");
    for (const secret of [
      "secret direct message",
      "alice@example.com",
      "kopje.test",
      "BEGIN PUBLIC KEY",
      "fixture-client-secret",
      "remote.example",
    ]) {
      expect(manifest).not.toContain(secret);
    }
  });
});

describe("rows legacy never showed, and outbox rows written before 0016", () => {
  const notificationCount = async (dumpPath: string) => {
    const db = await opened(dumpPath);
    const n = (db.prepare("SELECT count(*) AS n FROM notifications").get() as { n: number }).n;
    db.close();
    return n;
  };

  it("drops notifications owned by a remote account, counted, and only with --accept-deletions", async () => {
    const plain = await convert(await exportOf({ level: 39 }, "plain"), { out: "plain" });
    const exportPath = await exportOf({ level: 39, remoteOwnedNotifications: true });
    const refused = await convert(exportPath);
    expect(refused.ok).toBe(false);
    expect(refused.manifest.stop).toMatchObject({ code: "conversion-refused" });
    expect(refused.manifest.conversion).toMatchObject({
      problems: {},
      dropped: { "notifications:owner-remote": 2 },
    });
    const { ok, dumpPath } = await convert(exportPath, { acceptDeletions: true, out: "accepted" });
    expect(ok).toBe(true);
    expect(await notificationCount(dumpPath)).toBe(await notificationCount(plain.dumpPath));
    // The independent check counts the dropped rows on its own, and passes only with the same consent.
    const refusedCheck = await verifyWith(exportPath, dumpPath);
    expect(refusedCheck.ok).toBe(false);
    expect(failing(refusedCheck.categories)).toEqual([]);
    expect(refusedCheck.report).toMatchObject({
      result: "FAIL",
      dropped: { "notifications:owner-remote": 2, accepted: false },
    });
    const { ok: verified, categories, report } = await verifyWith(exportPath, dumpPath, { acceptDeletions: true });
    expect(failing(categories)).toEqual([]);
    expect(report).toMatchObject({ dropped: { "notifications:owner-remote": 2, accepted: true } });
    expect(verified).toBe(true);
  });

  it("reads a row written before 0016 as its target, which may narrow the audience of its status", async () => {
    const exportPath = await exportOf({ level: 39, before0016: "narrowed" });
    const { ok, manifest, dumpPath } = await convert(exportPath);
    expect(manifest.stop).toBeUndefined();
    expect(ok).toBe(true);
    const db = await opened(dumpPath);
    const row = db.prepare("SELECT visibility FROM statuses WHERE content LIKE '%unlisted, with a CW%'").get();
    db.close();
    expect(row).toEqual({ visibility: "unlisted" });
    expect((await verify(exportPath, dumpPath)).ok).toBe(true);
  });

  // RES-3: a local status's Create stays within an outbox page: one addressing more than MAX_LOCAL_ADDRESSED accounts
  // stops the conversion, named by its object id, and no recipient is dropped; one at the bound converts.
  it("stops on a local status that addresses more accounts than its bound", async () => {
    const over = await exportOf({ level: 39, addressed: MAX_LOCAL_ADDRESSED + 1 });
    const refused = await convert(over);
    expect(refused.ok).toBe(false);
    const problems = Object.keys((refused.manifest.conversion as { problems: Record<string, number> }).problems);
    expect(problems).toEqual([expect.stringMatching(/^statuses:local-addressing-over-bound:https:\/\/kopje\.test\//)]);
  }, 300_000);

  it("converts a local status at its addressing bound with every recipient", async () => {
    const at = await exportOf({ level: 39, addressed: MAX_LOCAL_ADDRESSED });
    const converted = await convert(at);
    expect(converted.manifest.stop).toBeUndefined();
    expect(converted.ok).toBe(true);
    const db = await opened(converted.dumpPath);
    const row = db
      .prepare(
        "SELECT count(*) AS n FROM status_mentions m JOIN statuses s ON s.id = m.status_id WHERE s.content LIKE '%to many%' AND m.silent = 0",
      )
      .get();
    db.close();
    expect(row).toEqual({ n: MAX_LOCAL_ADDRESSED });
  }, 300_000);

  // DATA-15: the status keeps its own audience; a target outside it is a conflict, and so is any row while the time of
  // 0016 is unknown.
  for (const [name, options, edit] of [
    ["a target that would widen the audience", { level: 39, before0016: "widened" }, null],
    ["an unusable applied_at of 0016", { level: 39, before0016: "unusable-time" }, null],
    [
      "no applied_at in d1_migrations",
      { level: 39, before0016: "narrowed" },
      (text: string) =>
        text.replaceAll(
          /INSERT INTO "d1_migrations" \("id","name","applied_at"\) VALUES\((\d+),('[^']+'),'[^']+'\);/g,
          'INSERT INTO "d1_migrations" ("id","name") VALUES($1,$2);',
        ),
    ],
  ] as const) {
    it(`stops on ${name}`, async () => {
      const exportPath = await exportOf(options);
      if (edit !== null) {
        const file = join(exportPath, "d1_migrations.sql");
        const text = await readFile(file, "utf8");
        expect(edit(text)).not.toBe(text);
        await writeFile(file, edit(text));
      }
      const { ok, manifest } = await convert(exportPath, { acceptDeletions: true });
      expect(ok).toBe(false);
      expect(manifest.conversion).toMatchObject({ problems: { "statuses:addressing-conflict": 1 } });
    });
  }
});

describe("domain blocks", () => {
  it("stores them as the API does, merges what becomes one block, drops a non-domain counted, and verifies", async () => {
    const exportPath = await exportOf({ level: 39, domainBlockSpellings: true });
    const refused = await convert(exportPath);
    expect(refused.ok).toBe(false);
    expect(refused.manifest.conversion).toMatchObject({ dropped: { "domain_blocks:invalid-domain": 1 } });
    const { ok, manifest, dumpPath } = await convert(exportPath, { acceptDeletions: true, out: "accepted" });
    expect(ok).toBe(true);
    expect((manifest.conversion as { normalized: Record<string, number> }).normalized).toMatchObject({
      "domain_blocks:case-duplicate-merged": 1,
    });
    const db = await opened(dumpPath);
    const domains = db.prepare("SELECT domain FROM domain_blocks ORDER BY domain").all() as { domain: string }[];
    db.close();
    expect(domains.map((row) => row.domain)).toEqual([
      "spam.example",
      "trailing.example",
      "upper.example",
      "xn--bcher-kva.example",
    ]);
    // The check counts the dropped row on its own, and passes only with the same consent.
    const refusedCheck = await verifyWith(exportPath, dumpPath);
    expect(refusedCheck.ok).toBe(false);
    expect(refusedCheck.report).toMatchObject({
      result: "FAIL",
      dropped: { "domain_blocks:invalid-domain": 1, accepted: false },
    });
    const { ok: verified, categories, report } = await verifyWith(exportPath, dumpPath, { acceptDeletions: true });
    expect(failing(categories)).toEqual([]);
    expect(report).toMatchObject({ dropped: { "domain_blocks:invalid-domain": 1, accepted: true } });
    expect(verified).toBe(true);
  });
});

describe("a legacy object without an internal id", () => {
  // Legacy's objects.id is a TEXT PRIMARY KEY, which SQLite lets hold NULL. The row is still read, its addressing and
  // author keyed by String(id) as the converter looks them up.
  it("converts a remote public Note whose id is NULL, with its attachments", async () => {
    const exportPath = await exportOf({ level: 39 });
    const rewritten = await rewriteExport(exportPath, (text) => {
      const line = text.split("\n").find((l) => l.startsWith('INSERT INTO "objects"') && l.includes("こんにちは"));
      return line === undefined ? undefined : text.replace(line, line.replace(/VALUES\('[^']*'/, "VALUES(NULL"));
    });
    expect(rewritten).toBe(1);
    // The boosts, favourite and bookmark of the Note name it by the id it lost, so they are dropped.
    const { ok, dumpPath } = await convert(exportPath, { acceptDeletions: true });
    expect(ok).toBe(true);
    const db = await opened(dumpPath);
    const rows = db
      .prepare(
        `SELECT s.visibility, count(m.id) AS media FROM statuses s LEFT JOIN media_attachments m ON m.status_id = s.id
        WHERE s.content LIKE '%こんにちは%' GROUP BY s.id`,
      )
      .all();
    db.close();
    expect(rows).toEqual([{ visibility: "public", media: 2 }]);
  });
});

describe("text with a lone surrogate", () => {
  it("carries it with U+FFFD in its place, counted, and the independent check agrees", async () => {
    const exportPath = await exportOf({ level: 39, loneSurrogates: true });
    const { ok, manifest, dumpPath } = await convert(exportPath);
    expect(manifest.stop).toBeUndefined();
    expect(ok).toBe(true);
    // A display name, a bio, a status's content, content warning and attachment description.
    expect((manifest.conversion as { normalized: Record<string, number> }).normalized).toMatchObject({
      "text:lone-surrogate-replaced": 5,
    });
    const db = await opened(dumpPath);
    const value = (sql: string) => Object.values(db.prepare(sql).get() ?? {})[0];
    expect(value("SELECT count(*) FROM accounts WHERE display_name LIKE '%\uFFFD' OR note LIKE '%\uFFFD%'")).toBe(2);
    expect(
      value("SELECT count(*) FROM statuses WHERE content LIKE '%cut \uFFFD%' AND spoiler_text = 'cw \uFFFD'"),
    ).toBe(1);
    expect(value("SELECT count(*) FROM media_attachments WHERE description = 'alt \uFFFD'")).toBe(1);
    db.close();
    const { ok: verified, categories } = await verifyWith(exportPath, dumpPath);
    expect(failing(categories)).toEqual([]);
    expect(verified).toBe(true);
  });
});

describe("the expected threads", () => {
  it("walk each status once, so a 50,000-status chain is quick, and give a cycle each status’s own", () => {
    const uri = (i: number) => `https://remote.example/objects/${i}`;
    const replies: Record<string, string> = {};
    const statuses: Record<string, string> = {};
    for (let i = 1; i <= 50_000; i++) {
      statuses[uri(i)] = "[]";
      replies[uri(i)] = JSON.stringify([uri(i - 1), i > 1 ? uri(i - 1) : null]);
    }
    for (const [a, b] of [
      ["a", "b"],
      ["b", "a"],
    ] as const) {
      statuses[uri(0) + a] = "[]";
      replies[uri(0) + a] = JSON.stringify([uri(0) + b, uri(0) + b]);
    }
    const started = performance.now();
    const threadOf = threadsOf(replies, statuses);
    const threads = new Set(Array.from({ length: 50_000 }, (_, i) => threadOf(uri(50_000 - i))));
    expect(performance.now() - started).toBeLessThan(2000);
    expect([...threads]).toEqual([uri(0)]);
    expect([threadOf(uri(0) + "a"), threadOf(uri(0) + "b")]).toEqual([uri(0) + "b", uri(0) + "a"]);
  });
});
