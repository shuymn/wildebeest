// Synthetic legacy Wildebeest D1 exports, at any supported migration level, in the shape `wrangler d1 export
// --table` writes (one SQL text per table: the table's CREATE statement, then one INSERT per row). Every row is made
// up here; no real export is ever read. Row shapes follow the legacy writers (createPerson,
// createObject, addObjectInOutbox, createReblog, insertActivity, the notification writers).
//
// T1 fixtures are built from the canonical migrations (cli/legacy-migrations); T2 fixtures from the cloudflare/
// wildebeest 0.0.1 texts of 0000-0010 (fixtures/upstream-migrations, taken from the history before the fork
// reformatted them).

import { webcrypto } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { canonicalLegacyDatabase, legacyMigrations } from "../cli/lib/cutover/legacy-load.js";

export const DOMAIN = "kopje.test";
const ORIGIN = `https://${DOMAIN}`;
const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
const IMAGES = "https://images.example/media";
// The account cloudflare/wildebeest's default header is under.
export const UPSTREAM_HEADER =
  "https://imagedelivery.net/NkfPDviynOyTAOI79ar_GQ/b24caf12-5230-48c4-0bf7-2f40063bd400/header";
export const FOREIGN_IMAGE = "https://imagedelivery.net/OtherAccount0123/foreign-1/public";

// `wrangler d1 export --table sqlite_sequence` writes no CREATE TABLE for it, but a reset before the counter rows.
const SEQUENCE_HEADER = "PRAGMA defer_foreign_keys=TRUE;\nDELETE FROM sqlite_sequence;\n";

export type FixtureOptions = {
  level: number;
  line?: "T1" | "T2";
  // Rows the bridge removes: a duplicate remote object (0021), a duplicate favourite (0034), a reblog without its
  // outbox row (0017) and a subscription (0007), each where the level is below that migration.
  withDeletions?: boolean;
  // The KEK each local user's key is wrapped with (legacy: env.userKEK, often unset, so '').
  keks?: { alice: string; bob: string } | undefined;
  // Boosts need the audience an outbox row has from 0002 on; below that the converter refuses them. Default: level >= 2.
  boosts?: boolean;
  // Notifications, and the exported sqlite_sequence counter of actor_notifications (none when undefined).
  notifications?: boolean;
  notificationSequence?: bigint;
  // A remote object whose stored author differs from its attributedTo, so 0021 rewrites it (levels below 0021).
  authorChange?: boolean;
  // r4's followers property spelled with an upper-case host and :443, and a status of r4 to its followers as normally
  // spelled, Bob absent from to.
  followersSpelling?: boolean;
  // Keep the database the export was written from open and return it, as the live legacy D1 (the fingerprint suite).
  live?: boolean;
  // From level 20: actors.type as an instance has it that ran an earlier form of 0020, which dropped the column; it
  // was added back with ALTER TABLE ADD COLUMN, so it is nullable and comes after mastodon_id (actorTypeDrift below).
  actorTypeDrift?: boolean;
  // Notifications legacy wrote for the remote author of a boosted or liked status, which it never listed.
  remoteOwnedNotifications?: boolean;
  // From level 16: a local status's outbox row written before 0016 was applied, which 0016 left with its single target
  // in `to` and an empty `cc`. 'narrowed': an unlisted status whose target was its followers; 'widened': a
  // followers-only status with a Public target; 'unusable-time': as narrowed, with an unreadable applied_at for 0016.
  before0016?: "narrowed" | "widened" | "unusable-time";
  // A lone surrogate (half of a character outside the BMP, as a cut string leaves it) in remote JSON text: a display
  // name, a bio, and a status's content, content warning and attachment description.
  loneSurrogates?: boolean;
  // Local images in Cloudflare Images under this account hash (imagedelivery.net/<hash>/<id>/<variant>): avatars
  // avatar-0 and avatar-1, alice's header header-0, the images image-1 to image-3, and from level 23 image-9, which
  // only the first version of the edited status shows, and image-8, which both versions of it show, described
  // 'before' and then 'after'; the unlisted status shows image-1 again. Bob's header is then
  // the upstream default, and his first status shows an image of another account.
  imagesAccount?: string;
  // More of alice's domain blocks, spelled as legacy never stored them: 'spam.example.' (the same block as
  // 'Spam.Example' once normalized), 'Upper.Example', 'trailing.example.', 'bücher.example', and 'not a domain'.
  domainBlockSpellings?: boolean;
  // A direct exchange: r1 writes to alice (who is notified of it), and alice answers in its thread.
  directMessages?: boolean;
  // A public status of alice's that mentions this many more remote accounts, each its own actor.
  addressed?: number;
};

export type LegacyFixture = {
  level: number;
  texts: Map<string, string>;
  users: { username: string; email: string; uri: string }[];
  // With `live`: the database the export was written from.
  database?: DatabaseSync;
};

type Row = Record<string, SQLInputValue | undefined>;

function upstreamDatabase(level: number): DatabaseSync {
  const dir = fileURLToPath(new URL("./fixtures/upstream-migrations/", import.meta.url));
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  for (const file of readdirSync(dir)
    .toSorted()
    .slice(0, level + 1)) {
    db.exec(readFileSync(`${dir}${file}`, "utf8"));
  }
  return db;
}

// The canonical schema up to 0019, then actors.type dropped and added back as a plain nullable column (the triggers that
// read it set aside meanwhile), then the canonical migrations from 0020 on.
function actorTypeDriftDatabase(level: number): DatabaseSync {
  if (level < 20) {
    throw new Error("actorTypeDrift needs level 20 or later");
  }
  const db = canonicalLegacyDatabase(19);
  const triggers = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'actors'")
    .all() as { name: string; sql: string }[];
  for (const { name } of triggers) {
    db.exec(`DROP TRIGGER "${name}"`);
  }
  db.exec("ALTER TABLE `actors` DROP COLUMN `type`");
  db.exec("ALTER TABLE `actors` ADD COLUMN `type` text");
  for (const { sql } of triggers) {
    db.exec(sql);
  }
  for (const migration of legacyMigrations().slice(20, level + 1)) {
    db.exec(migration.sql);
  }
  return db;
}

function migrationNames(level: number): string[] {
  const dir = fileURLToPath(new URL("../cli/legacy-migrations/", import.meta.url));
  return readdirSync(dir)
    .toSorted()
    .slice(0, level + 1);
}

// Legacy timestamps: STRFTIME('%Y-%m-%d %H:%M:%f') in cdate columns, ISO 8601 in properties.
const BASE = Date.parse("2024-03-01T09:00:00.000Z");
const at = (minutes: number) => new Date(BASE + minutes * 60_000);
const cdate = (minutes: number) => at(minutes).toISOString().replace("T", " ").replace("Z", "");
const iso = (minutes: number) => at(minutes).toISOString();
// The time in legacy's spaced form with a zone, as legacy may keep one: 'YYYY-MM-DD HH:MM:SS+09:00' or '...Z'.
const spaced = (minutes: number, zone: "Z" | `${"+" | "-"}${string}`) => {
  const offset =
    zone === "Z" ? 0 : (zone.startsWith("-") ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4)));
  const local = new Date(at(minutes).getTime() + offset * 60_000).toISOString();
  return `${local.slice(0, 19).replace("T", " ")}${zone}`;
};
const snowflake = (minutes: number, low: number) => ((BigInt(at(minutes).getTime()) << 16n) | BigInt(low)).toString();

async function wrappedKey(kek: string) {
  const subtle = webcrypto.subtle;
  const pair = (await subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = await subtle.exportKey("pkcs8", pair.privateKey);
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const material = await subtle.importKey("raw", new TextEncoder().encode(kek), "PBKDF2", false, ["deriveKey"]);
  const key = await subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 10000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const privkey = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: salt }, key, pkcs8));
  const spki = Buffer.from(await subtle.exportKey("spki", pair.publicKey)).toString("base64");
  return { privkey, salt, pubkey: `-----BEGIN PUBLIC KEY-----\n${spki}\n-----END PUBLIC KEY-----` };
}

function literal(value: SQLInputValue | undefined): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Uint8Array) {
    return `X'${Buffer.from(value).toString("hex")}'`;
  }
  return `'${(value as string).replaceAll("'", "''")}'`;
}

export async function buildLegacyFixture(options: FixtureOptions): Promise<LegacyFixture> {
  const {
    level,
    line = "T1",
    withDeletions = false,
    keks = { alice: "", bob: "" },
    boosts = level >= 2,
    notifications = true,
    notificationSequence,
    authorChange = false,
    followersSpelling = false,
    live = false,
    actorTypeDrift = false,
    remoteOwnedNotifications = false,
    before0016,
    loneSurrogates = false,
    imagesAccount,
    domainBlockSpellings = false,
    directMessages = false,
    addressed = 0,
  } = options;
  const images = imagesAccount === undefined ? IMAGES : `https://imagedelivery.net/${imagesAccount}`;
  if (before0016 !== undefined && level < 16) {
    throw new Error("before0016 needs level 16 or later");
  }
  const db =
    line === "T2"
      ? upstreamDatabase(level)
      : actorTypeDrift
        ? actorTypeDriftDatabase(level)
        : canonicalLegacyDatabase(level);
  const columns = new Map<string, string[]>();
  const columnsOf = (table: string): string[] => {
    let list = columns.get(table);
    if (list === undefined) {
      list = (
        db.prepare("SELECT name FROM pragma_table_xinfo(?) WHERE hidden = 0").all(table) as { name: string }[]
      ).map((c) => c.name);
      columns.set(table, list);
    }
    return list;
  };
  const has = (table: string, column?: string) =>
    column === undefined ? columnsOf(table).length > 0 : columnsOf(table).includes(column);
  // Inserts the row's keys that exist at this level.
  const insert = (table: string, row: Row) => {
    if (!has(table)) {
      return;
    }
    const keys = Object.keys(row).filter((k) => has(table, k) && row[k] !== undefined);
    db.prepare(
      `INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
    ).run(...keys.map((k) => row[k] as SQLInputValue));
  };

  // ---- actors
  const userKeys = { alice: await wrappedKey(keks.alice), bob: await wrappedKey(keks.bob) };
  const users = [
    { username: "alice", email: "alice@example.com", uri: `${ORIGIN}/ap/users/alice`, key: userKeys.alice },
    { username: "Bob", email: "bob@example.com", uri: `${ORIGIN}/ap/users/Bob`, key: userKeys.bob },
  ];
  const localIds = [snowflake(1, 11), "7b0c6c1e-2f43-4c43-9f6e-1d7d0c7f2a10"];
  users.forEach((user, i) => {
    const properties = {
      id: user.uri,
      type: "Person",
      preferredUsername: user.username,
      name: i === 0 ? "Alice 🦬 アリス" : "Bob",
      summary: i === 0 ? "<p>self-hosted, it&#39;s me</p>" : "",
      inbox: `${user.uri}/inbox`,
      outbox: `${user.uri}/outbox`,
      following: `${user.uri}/following`,
      followers: `${user.uri}/followers`,
      url: `${ORIGIN}/@${user.username}`,
      // Bob never set it: legacy showed and published false.
      discoverable: i === 0 ? true : undefined,
      manuallyApprovesFollowers: i === 1,
      icon: { type: "Image", url: `${images}/avatar-${i}/avatar` },
      image:
        i === 0
          ? { type: "Image", url: `${images}/header-${i}/header` }
          : imagesAccount === undefined
            ? undefined
            : { type: "Image", url: UPSTREAM_HEADER },
      alsoKnownAs: i === 0 ? ["https://old.example/users/alice"] : undefined,
      publicKey: { id: `${user.uri}#main-key`, owner: user.uri, publicKeyPem: user.key.pubkey },
    };
    insert("actors", {
      id: user.uri,
      type: "Person",
      email: user.email,
      privkey: user.key.privkey,
      privkey_salt: user.key.salt,
      pubkey: user.key.pubkey,
      cdate: cdate(i),
      properties: JSON.stringify(properties),
      is_admin: i === 0 ? 1 : null,
      mastodon_id: localIds[i],
      username: user.username.toLowerCase(),
      domain: DOMAIN,
    });
    if (has("users")) {
      insert("users", {
        id: `00000000-0000-4000-8000-00000000000${i}`,
        actor_id: user.uri,
        email: user.email,
        privkey: user.key.privkey,
        privkey_salt: user.key.salt,
        pubkey: user.key.pubkey,
        is_admin: i === 0 ? 1 : 0,
        cdate: cdate(i),
      });
    }
  });
  if (level >= 11) {
    db.prepare("DELETE FROM actor_preferences").run();
    insert("actor_preferences", {
      id: users[0]?.uri,
      posting_default_visibility: "unlisted",
      posting_default_sensitive: 1,
      posting_default_language: "ja",
    });
  }
  const alice = users[0]?.uri ?? "";
  const bob = users[1]?.uri ?? "";

  const remote = [0, 1, 2, 3, 4, 5].map((i) => {
    const host = i < 4 ? "remote.example" : "other.example";
    const uri = `https://${host}/users/r${i}`;
    insert("actors", {
      id: uri,
      type: i === 5 ? "Service" : "Person",
      cdate: cdate(10 + i),
      properties: JSON.stringify({
        "@context": ["https://www.w3.org/ns/activitystreams"],
        id: uri,
        type: i === 5 ? "Service" : "Person",
        preferredUsername: i === 2 ? "Remote2" : `r${i}`,
        name: i === 3 ? "" : `Ｒｅｍｏｔｅ ${i}`,
        summary: `<p>bio ${i}</p>`,
        url: `https://${host}/@r${i}`,
        inbox: `${uri}/inbox`,
        followers: followersSpelling && i === 4 ? "https://OTHER.example:443/users/r4/followers" : `${uri}/followers`,
        endpoints: i === 1 ? {} : { sharedInbox: `https://${host}/inbox` },
        icon: { type: "Image", url: `https://files.${host}/a/${i}.png` },
        published: "2022-01-0" + (i + 1) + "T00:00:00Z",
        manuallyApprovesFollowers: i === 4,
      }),
      mastodon_id: i === 1 ? "b1d4f0a8-5c64-4a52-9a52-6f0b1c9e7a01" : snowflake(10 + i, 100 + i),
      username: (i === 2 ? "Remote2" : `r${i}`).toLowerCase(),
      domain: host,
    });
    return { uri, host, followers: `${uri}/followers` };
  });
  const r = (i: number) => remote[i] ?? { uri: "", host: "", followers: "" };
  const many = Array.from({ length: addressed }, (_, i) => {
    const uri = `https://many.example/users/m${i}`;
    insert("actors", {
      id: uri,
      type: "Person",
      cdate: cdate(16),
      properties: JSON.stringify({
        "@context": ["https://www.w3.org/ns/activitystreams"],
        id: uri,
        type: "Person",
        preferredUsername: `m${i}`,
        inbox: `${uri}/inbox`,
        followers: `${uri}/followers`,
      }),
      mastodon_id: snowflake(16, 1000 + i),
      username: `m${i}`,
      domain: "many.example",
    });
    return uri;
  });

  // ---- objects
  let objectCounter = 0;
  const objectId = () => `${ORIGIN}/ap/o/0f0f0f0f-0000-4000-8000-${String(++objectCounter).padStart(12, "0")}`;
  const localOriginal = (id: string) => (level >= 21 ? id : null);
  type Note = { id: string; uri: string; mastodonId: string; author: string; minutes: number };
  const notes: Note[] = [];

  const image = (n: number, attachedTo: boolean) => {
    const id = objectId();
    const properties = {
      type: "Image",
      id,
      url: `${images}/image-${n}/usercontent`,
      description: attachedTo ? "a wildebeest" : "",
      mediaType: "image/jpeg",
    };
    insert("objects", {
      id,
      mastodon_id: n === 1 ? snowflake(20, 1) : `c5a0a5f2-6a1f-4a42-8d18-2b6c0a1d9e3${n}`,
      type: "Image",
      cdate: cdate(20 + n),
      original_actor_id: alice,
      original_object_id: localOriginal(id),
      properties: JSON.stringify(properties),
      local: 1,
    });
    return properties;
  };
  const attachedImage = image(1, true);
  image(2, false);
  const hiddenImage = image(3, true);

  const outbox = (actor: string, object: string, minutes: number, to: string[], cc: string[]) => {
    const id = `00000000-0000-4000-9000-${String(++objectCounter).padStart(12, "0")}`;
    insert("outbox_objects", {
      id,
      actor_id: actor,
      object_id: object,
      cdate: cdate(minutes),
      published_date: cdate(minutes),
      target: to[0] ?? PUBLIC,
      to: JSON.stringify(to),
      cc: JSON.stringify(cc),
    });
    return id;
  };

  type LocalNote = {
    author: string;
    username: string;
    minutes: number;
    text: string;
    to: string[];
    cc: string[];
    mastodonId: string;
    tags?: unknown[];
    attachment?: unknown[] | undefined;
    inReplyTo?: Note;
    urlTail?: string;
    sensitive?: boolean;
    spoiler?: string;
  };
  const localNote = (input: LocalNote): Note => {
    const id = objectId();
    const properties: Record<string, unknown> = {
      type: "Note",
      id,
      attributedTo: input.author,
      content: `<p>${input.text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</p>`,
      source: { content: input.text, mediaType: "text/plain" },
      to: input.to,
      cc: input.cc,
      attachment: input.attachment ?? [],
      tag: input.tags ?? [],
      sensitive: input.sensitive ?? false,
      spoiler_text: input.spoiler ?? "",
      url: `${ORIGIN}/@${input.username}/${input.urlTail ?? input.mastodonId}`,
      published: iso(input.minutes),
      inReplyTo: input.inReplyTo?.uri ?? null,
    };
    insert("objects", {
      id,
      mastodon_id: input.mastodonId,
      type: "Note",
      cdate: cdate(input.minutes),
      original_actor_id: input.author,
      original_object_id: localOriginal(id),
      reply_to_object_id: input.inReplyTo?.id ?? null,
      in_reply_to_id: level >= 36 ? (input.inReplyTo?.id ?? null) : undefined,
      properties: JSON.stringify(properties),
      local: 1,
    });
    outbox(input.author, id, input.minutes, input.to, input.cc);
    if (level >= 15) {
      insert("actor_activities", {
        id: `aa000000-0000-4000-8000-${String(++objectCounter).padStart(12, "0")}`,
        actor_id: input.author,
        cdate: cdate(input.minutes),
        activity: JSON.stringify({
          id: `${ORIGIN}/ap/a/create-${objectCounter}`,
          type: "Create",
          actor: input.author,
          object: id,
        }),
      });
    }
    const note = { id, uri: id, mastodonId: input.mastodonId, author: input.author, minutes: input.minutes };
    notes.push(note);
    return note;
  };

  type RemoteNote = {
    author: number;
    minutes: number;
    content: string;
    to: string[];
    cc: string[];
    mastodonId: string;
    tags?: unknown[];
    attachment?: unknown[];
    inReplyTo?: Note;
    summary?: string;
    lostOriginal?: boolean;
    // Default: { ja: content }.
    contentMap?: Record<string, string>;
    // Defaults: published a minute before `minutes`, not updated.
    published?: string;
    updated?: string;
    // Mastodon's conversation identifier, kept in the object.
    conversation?: string;
  };
  const remoteNote = (input: RemoteNote): Note => {
    const proxy = objectId();
    const author = r(input.author);
    const uri = `${author.uri}/statuses/${100 + objectCounter}`;
    const properties = {
      "@context": ["https://www.w3.org/ns/activitystreams", { sensitive: "as:sensitive" }],
      id: uri,
      type: "Note",
      summary: input.summary ?? null,
      inReplyTo: input.inReplyTo?.uri ?? null,
      published: input.published ?? iso(input.minutes - 1),
      updated: input.updated,
      url: `https://${author.host}/@r${input.author}/${100 + objectCounter}`,
      attributedTo: author.uri,
      to: input.to,
      cc: input.cc,
      sensitive: input.summary !== undefined,
      content: input.content,
      contentMap: input.contentMap ?? { ja: input.content },
      attachment: input.attachment ?? [],
      tag: input.tags ?? [],
      ...(input.conversation === undefined ? {} : { conversation: input.conversation }),
    };
    const original = input.lostOriginal === true ? (level >= 21 ? proxy : null) : uri;
    insert("objects", {
      id: proxy,
      mastodon_id: input.mastodonId,
      type: "Note",
      cdate: cdate(input.minutes),
      original_actor_id: author.uri,
      original_object_id: original,
      reply_to_object_id: input.inReplyTo?.id ?? null,
      in_reply_to_id: level >= 36 ? (input.inReplyTo?.id ?? null) : undefined,
      properties: JSON.stringify(properties),
      local: 0,
    });
    const note = {
      id: proxy,
      uri: input.lostOriginal === true ? proxy : uri,
      mastodonId: input.mastodonId,
      author: author.uri,
      minutes: input.minutes,
    };
    notes.push(note);
    return note;
  };

  const r0Post = remoteNote({
    author: 0,
    minutes: 100,
    content: '<p>こんにちは <a href="https://remote.example/tags/cats" class="hashtag">#cats</a></p>',
    to: [PUBLIC],
    cc: [r(0).followers],
    mastodonId: snowflake(99, 7),
    // Names Kopje normalizes as Mastodon does: every number sign (fullwidth and small ones after NFKC) dropped with the
    // other characters no hashtag holds, and a Latin letter with a diacritic folded to ASCII.
    tags: [
      { type: "Hashtag", name: "#Cats", href: "https://remote.example/tags/cats" },
      { type: "Hashtag", name: "#Café", href: "https://remote.example/tags/cafe" },
      { type: "Hashtag", name: "#ＣＡＴＳ", href: "https://remote.example/tags/cats" },
      { type: "Hashtag", name: "＃Ｆｕｌｌ", href: "https://remote.example/tags/full" },
      { type: "Hashtag", name: "﹟Small", href: "https://remote.example/tags/small" },
      { type: "Hashtag", name: "##Double", href: "https://remote.example/tags/double" },
      { type: "Hashtag", name: "Bare", href: "https://remote.example/tags/bare" },
    ],
    attachment: [
      { type: "Document", mediaType: "video/mp4", url: "https://files.remote.example/m/1.mp4", name: "a clip" },
      { type: "Document", mediaType: "image/png", url: "https://files.remote.example/m/2.png", name: null },
    ],
  });
  const publicNote = localNote({
    author: alice,
    username: "alice",
    minutes: 110,
    text: "It's a #Wildebeest day; quotes ' and \"double\" and a\nnewline",
    to: [PUBLIC],
    cc: [`${alice}/followers`],
    mastodonId: snowflake(110, 3),
    tags: [{ type: "Hashtag", name: "#Wildebeest", href: `${ORIGIN}/tags/wildebeest` }],
    attachment: [attachedImage],
  });
  if (has("note_hashtags")) {
    // Names as legacy took them from the text after #: a number sign left in them goes when the name is normalized.
    for (const value of ["wildebeest", "ＷＩＬＤＥＢＥＥＳＴ", "＃Wide", "﹟Foo", "#Hash"]) {
      insert("note_hashtags", { value, object_id: publicNote.id, cdate: cdate(110) });
    }
  }
  if (has("idempotency_keys")) {
    insert("idempotency_keys", { key: "idem-key-1", object_id: publicNote.id, expires_at: cdate(170) });
  }
  const unlisted = localNote({
    author: alice,
    username: "alice",
    minutes: 120,
    text: "unlisted, with a CW",
    to: [`${alice}/followers`],
    cc: [PUBLIC],
    mastodonId: "d9a3c8e0-7f1b-4c2a-a4d3-8f3e2b1c0d55",
    urlTail: "d9a3c8e0-7f1b-4c2a-a4d3-8f3e2b1c0d55",
    sensitive: true,
    spoiler: "CW: spoilers",
    // A hashtag of a status that is not public: never listed on a hashtag timeline.
    tags: [{ type: "Hashtag", name: "#Cats", href: `${ORIGIN}/tags/cats` }],
    // With imagesAccount: the image the public note shows, shown again.
    attachment: imagesAccount === undefined ? undefined : [{ type: "Image", url: `${images}/image-1/usercontent` }],
  });
  const followersOnly = localNote({
    author: alice,
    username: "alice",
    minutes: 130,
    text: "followers only",
    attachment: [hiddenImage],
    to: [`${alice}/followers`],
    cc: [],
    mastodonId: snowflake(130, 9),
    // Legacy let only alice's followers read this, whatever it mentions: r2 and Bob follow alice, r3 does not.
    tags: [
      { type: "Mention", href: r(2).uri, name: "@Remote2@remote.example" },
      { type: "Mention", href: r(3).uri, name: "@r3@remote.example" },
      { type: "Mention", href: bob, name: "@Bob" },
    ],
    // Lazily converted: the URL still carries the UUID the note was created with.
    urlTail: "e1e2e3e4-0000-4000-8000-000000000130",
  });
  localNote({
    author: alice,
    username: "alice",
    minutes: 140,
    text: "@r0 a secret direct message",
    to: [r(0).uri],
    cc: [],
    mastodonId: snowflake(140, 2),
    tags: [{ type: "Mention", href: r(0).uri, name: "@r0@remote.example" }],
  });
  localNote({
    author: alice,
    username: "alice",
    minutes: 145,
    text: "@r0 only for r0, though it tags r1 and copies r2",
    to: [r(0).uri],
    cc: [r(2).uri],
    mastodonId: snowflake(145, 2),
    tags: [
      { type: "Mention", href: r(0).uri, name: "@r0@remote.example" },
      { type: "Mention", href: r(1).uri, name: "@r1@remote.example" },
    ],
  });
  if (many.length > 0) {
    localNote({
      author: alice,
      username: "alice",
      minutes: 146,
      text: "to many",
      to: [PUBLIC],
      cc: [`${alice}/followers`, ...many],
      mastodonId: snowflake(146, 2),
      tags: many.map((uri, i) => ({ type: "Mention", href: uri, name: `@m${i}@many.example` })),
    });
  }
  const edited = localNote({
    author: alice,
    username: "alice",
    minutes: 150,
    text: "edited text, second version",
    to: [PUBLIC],
    cc: [`${alice}/followers`],
    mastodonId: snowflake(150, 4),
    inReplyTo: r0Post,
    // With imagesAccount: image-8, whose description the edit changed.
    attachment:
      imagesAccount === undefined
        ? undefined
        : [{ type: "Image", url: `${images}/image-8/usercontent`, name: "after" }],
  });
  if (level >= 23) {
    const firstVersion = {
      type: "Note",
      id: edited.id,
      content: "<p>edited text, first version</p>",
      spoiler_text: "",
      sensitive: false,
      attachment:
        imagesAccount === undefined
          ? []
          : [
              { type: "Image", url: `${images}/image-8/usercontent`, name: "before" },
              { type: "Image", url: `${images}/image-9/usercontent`, name: "first" },
            ],
      published: iso(150),
    };
    insert("object_revisions", { object_id: edited.id, properties: JSON.stringify(firstVersion), cdate: cdate(155) });
    db.prepare("UPDATE objects SET properties = json_set(properties, '$.updated', ?) WHERE id = ?").run(
      iso(155),
      edited.id,
    );
  }
  const bobNote = localNote({
    author: bob,
    username: "Bob",
    minutes: 160,
    text: "Bob says hi",
    to: [PUBLIC],
    cc: [`${bob}/followers`],
    mastodonId: "f00dfeed-1234-4abc-8def-0123456789ab",
    attachment: imagesAccount === undefined ? undefined : [{ type: "Image", url: FOREIGN_IMAGE }],
  });
  localNote({
    author: bob,
    username: "Bob",
    minutes: 165,
    text: "Bob answers the followers",
    to: [PUBLIC],
    cc: [`${bob}/followers`],
    mastodonId: snowflake(165, 3),
    inReplyTo: followersOnly,
  });
  if (authorChange) {
    // Stored with author r0 but attributedTo r1, addressed to r0's followers and alice: legacy let r0's followers
    // read it; 0021 rewrites the author to r1, under whom it would read as a DM to alice.
    const proxy = objectId();
    insert("objects", {
      id: proxy,
      mastodon_id: snowflake(168, 4),
      type: "Note",
      cdate: cdate(168),
      original_actor_id: r(0).uri,
      original_object_id: `${r(1).uri}/statuses/author-change`,
      properties: JSON.stringify({
        id: `${r(1).uri}/statuses/author-change`,
        type: "Note",
        attributedTo: r(1).uri,
        content: "<p>whose followers?</p>",
        to: [r(0).followers, alice],
        cc: [],
        published: iso(168),
      }),
      local: 0,
    });
  }
  remoteNote({
    author: 1,
    minutes: 170,
    content: '<p><span class="h-card"><a href="https://kopje.test/@alice">@alice</a></span> a DM to alice</p>',
    to: [alice],
    cc: [bob],
    mastodonId: snowflake(169, 5),
    tags: [{ type: "Mention", href: alice, name: "@alice@kopje.test" }],
    // Spaced times with zones: published in UTC (Z), edited later at a non-zero offset.
    published: spaced(169, "Z"),
    updated: spaced(175, "+05:30"),
  });
  const directToAlice = directMessages
    ? remoteNote({
        author: 1,
        minutes: 172,
        content: '<p><span class="h-card"><a href="https://kopje.test/@alice">@alice</a></span> just us</p>',
        to: [alice],
        cc: [],
        mastodonId: snowflake(171, 3),
        tags: [{ type: "Mention", href: alice, name: "@alice@kopje.test" }],
        conversation: "tag:remote.example,2024-03-01:objectId=171:objectType=Conversation",
      })
    : null;
  if (directToAlice !== null) {
    localNote({
      author: alice,
      username: "alice",
      minutes: 174,
      text: "@r1 just us, then",
      to: [r(1).uri],
      cc: [],
      mastodonId: snowflake(174, 2),
      tags: [{ type: "Mention", href: r(1).uri, name: "@r1@remote.example" }],
      inReplyTo: directToAlice,
    });
  }
  remoteNote({
    author: 2,
    minutes: 180,
    content: "<p>a reply to alice</p>",
    to: [PUBLIC],
    cc: [r(2).followers, alice],
    mastodonId: "a2a2a2a2-0000-4000-8000-000000000180",
    inReplyTo: publicNote,
    tags: [{ type: "Mention", href: alice, name: "@alice@kopje.test" }],
    summary: "CW 注意",
    // Two languages with regions: Kopje keeps the first one's primary subtag.
    contentMap: { "pt-BR": "<p>uma resposta</p>", en: "<p>a reply to alice</p>" },
    // Updated at its publication, both spaced at other offsets: no edit.
    published: spaced(179, "+09:00"),
    updated: spaced(179, "+00:00"),
  });
  if (followersSpelling) {
    remoteNote({
      author: 4,
      minutes: 185,
      content: "<p>for my followers, however they are spelled</p>",
      to: [r(4).followers],
      cc: [],
      mastodonId: snowflake(184, 2),
    });
  }
  remoteNote({
    author: 3,
    minutes: 190,
    content: "<p>unlisted from r3, lost its original id</p>",
    to: [r(3).followers],
    cc: [PUBLIC],
    mastodonId: snowflake(189, 6),
    lostOriginal: true,
    // Edited, the time spaced and in UTC (Z).
    updated: spaced(195, "Z"),
  });
  if (withDeletions && level < 21) {
    // A second copy of r0's post whose original_object_id is the first copy's id: 0021 removes it.
    insert("objects", {
      id: objectId(),
      mastodon_id: "dddddddd-0000-4000-8000-000000000021",
      type: "Note",
      cdate: cdate(101),
      original_actor_id: r(0).uri,
      original_object_id: r0Post.id,
      properties: JSON.stringify({ id: r0Post.uri, type: "Note", content: "<p>dup</p>" }),
      local: 0,
    });
  }

  // ---- boosts
  const boost = (
    actor: string,
    note: Note,
    minutes: number,
    mastodonId: string,
    announce: string,
    to: string[],
    cc: string[],
  ) => {
    const outboxId = outbox(actor, note.id, minutes, to, cc);
    if (level >= 17) {
      insert("actor_reblogs", {
        id: announce,
        mastodon_id: mastodonId,
        actor_id: actor,
        object_id: note.id,
        outbox_object_id: outboxId,
        cdate: cdate(minutes),
      });
    } else {
      insert("actor_reblogs", { id: mastodonId, actor_id: actor, object_id: note.id, cdate: cdate(minutes) });
    }
  };
  if (boosts) {
    boost(
      alice,
      r0Post,
      200,
      "bb000000-0000-4000-8000-000000000200",
      `${ORIGIN}/ap/a/bb000000-0000-4000-8000-000000000200`,
      [PUBLIC],
      [r(0).uri, `${alice}/followers`],
    );
    boost(
      r(1).uri,
      publicNote,
      210,
      snowflake(210, 8),
      `https://remote.example/users/r1/statuses/900/activity`,
      [PUBLIC],
      [alice, r(1).followers],
    );
    // A followers-only boost.
    boost(
      bob,
      r0Post,
      220,
      "bb000000-0000-4000-8000-000000000220",
      `${ORIGIN}/ap/a/bb000000-0000-4000-8000-000000000220`,
      [`${bob}/followers`],
      [],
    );
  }
  if (withDeletions && level < 17) {
    // A reblog without an outbox row: 0017 keeps only reblogs it can pair with one.
    insert("actor_reblogs", {
      id: "cc000000-0000-4000-8000-000000000017",
      actor_id: r(2).uri,
      object_id: publicNote.id,
      cdate: cdate(215),
    });
  }

  // ---- follows (with and without Follow records)
  const follow = (
    actor: string,
    target: string,
    state: string,
    minutes: number,
    uri: string | null,
    extra: Row = {},
  ) => {
    insert("actor_following", {
      id: `f0000000-0000-4000-8000-${String(minutes).padStart(12, "0")}`,
      actor_id: actor,
      target_actor_id: target,
      target_actor_acct: target,
      state,
      cdate: cdate(minutes),
      uri: level >= 26 ? uri : undefined,
      ...extra,
    });
  };
  follow(alice, r(0).uri, "accepted", 300, null, { show_reblogs: 0, languages: '["ja"]' });
  if (level >= 15) {
    insert("actor_activities", {
      id: "aa000000-0000-4000-8000-000000000300",
      actor_id: alice,
      cdate: cdate(300),
      activity: JSON.stringify({ id: `${ORIGIN}/ap/a/follow-300`, type: "Follow", actor: alice, object: r(0).uri }),
    });
  }
  follow(alice, r(1).uri, "pending", 301, null);
  follow(r(2).uri, alice, "accepted", 302, null);
  follow(r(3).uri, bob, "accepted", 303, "https://remote.example/follows/303");
  follow(bob, alice, "accepted", 304, null);
  follow(r(4).uri, alice, "pending", 305, null);

  // ---- favourites
  const favourite = (actor: string, note: Note, minutes: number) =>
    insert("actor_favourites", {
      id: `fa000000-0000-4000-8000-${String(minutes).padStart(12, "0")}`,
      actor_id: actor,
      object_id: note.id,
      cdate: cdate(minutes),
    });
  favourite(alice, r0Post, 400);
  if (level >= 15) {
    insert("actor_activities", {
      id: "aa000000-0000-4000-8000-000000000400",
      actor_id: alice,
      cdate: cdate(400),
      activity: JSON.stringify({ id: `${ORIGIN}/ap/a/like-400`, type: "Like", actor: alice, object: r0Post.uri }),
    });
  }
  favourite(r(1).uri, publicNote, 401);
  favourite(bob, publicNote, 402);
  if (withDeletions && level < 34) {
    favourite(r(1).uri, publicNote, 403);
  }

  // ---- notifications (one duplicate pair)
  let notificationId = 0;
  const notify = (type: string, to: string, from: string, object: Note | null, minutes: number) =>
    insert("actor_notifications", {
      id: ++notificationId,
      type,
      actor_id: to,
      from_actor_id: from,
      object_id: object?.id ?? null,
      cdate: cdate(minutes),
    });
  if (notifications) {
    notify("favourite", alice, r(1).uri, publicNote, 500);
    notify("reblog", alice, r(1).uri, publicNote, 501);
    notify("mention", alice, r(2).uri, notes.find((n) => n.author === r(2).uri) ?? null, 502);
    notify("follow", alice, r(2).uri, null, 503);
    notify("follow", alice, r(2).uri, null, 504);
    notify("follow_request", alice, r(4).uri, null, 505);
    notify("favourite", alice, bob, publicNote, 506);
    notify("follow", bob, r(3).uri, null, 507);
    notify("mention", bob, alice, followersOnly, 508);
    if (directToAlice !== null) {
      notify("mention", alice, r(1).uri, directToAlice, 511);
    }
  }
  if (remoteOwnedNotifications) {
    notify("reblog", r(0).uri, r(1).uri, r0Post, 509);
    notify("favourite", r(0).uri, r(2).uri, r0Post, 510);
  }

  // ---- clients, settings, subscriptions
  insert("clients", {
    id: "0c0c0c0c-0000-4000-8000-000000000001",
    secret: "fixture-client-secret-1",
    name: "Client One",
    redirect_uris: "app.one.example:/oauth",
    website: "https://one.example",
    scopes: "read write follow push",
    cdate: cdate(600),
  });
  insert("clients", {
    id: "0c0c0c0c-0000-4000-8000-000000000002",
    secret: "fixture-client-secret-2",
    name: "Client Two",
    redirect_uris: "https://two.example/",
    website: null,
    scopes: null,
    cdate: cdate(601),
  });
  if (level >= 8) {
    insert("server_settings", { setting_name: "server name", setting_value: "Fixture Herd" });
    insert("server_settings", { setting_name: "server description", setting_value: "A synthetic legacy instance" });
    insert("server_settings", { setting_name: "extended description", setting_value: "<p>私のサーバー</p>" });
    insert("server_rules", { text: "No spam" });
    insert("server_rules", { text: "スパム禁止" });
  }
  if (level >= 7 || withDeletions) {
    insert("subscriptions", {
      actor_id: alice,
      client_id: "0c0c0c0c-0000-4000-8000-000000000002",
      endpoint: "https://push.example/x",
      key_p256dh: "p256",
      key_auth: "auth",
      alert_mention: 1,
      alert_status: 0,
      alert_reblog: 1,
      alert_follow: 1,
      alert_follow_request: 1,
      alert_favourite: 1,
      alert_poll: 0,
      alert_update: 0,
      alert_admin_sign_up: 0,
      alert_admin_report: 0,
      policy: "all",
    });
  }

  // ---- 0030-0032 relationship tables
  insert("blocks", {
    id: "b0000000-0000-4000-8000-000000000001",
    account_id: alice,
    target_account_id: r(5).uri,
    uri: `${ORIGIN}/ap/a/block-1`,
    created_at: cdate(700),
  });
  insert("blocks", {
    id: "b0000000-0000-4000-8000-000000000002",
    account_id: r(4).uri,
    target_account_id: alice,
    uri: null,
    created_at: cdate(701),
  });
  insert("mutes", {
    id: "b0000000-0000-4000-8000-000000000003",
    account_id: alice,
    target_account_id: r(3).uri,
    hide_notifications: 0,
    created_at: cdate(702),
  });
  insert("domain_blocks", {
    id: "b0000000-0000-4000-8000-000000000004",
    account_id: alice,
    domain: "Spam.Example",
    created_at: cdate(703),
  });
  if (domainBlockSpellings) {
    const spellings = ["spam.example.", "Upper.Example", "trailing.example.", "bücher.example", "not a domain"];
    spellings.forEach((domain, i) => {
      insert("domain_blocks", {
        id: `b0000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`,
        account_id: alice,
        domain,
        created_at: cdate(710 + i),
      });
    });
  }
  insert("bookmarks", {
    id: "b0000000-0000-4000-8000-000000000005",
    account_id: alice,
    status_id: r0Post.id,
    created_at: cdate(704),
  });
  insert("bookmarks", {
    id: "b0000000-0000-4000-8000-000000000006",
    account_id: bob,
    status_id: bobNote.id,
    created_at: cdate(705),
  });
  const listId = snowflake(706, 1);
  insert("lists", {
    id: listId,
    account_id: alice,
    title: "友人",
    replies_policy: "followed",
    exclusive: 1,
    created_at: cdate(706),
    updated_at: cdate(706),
  });
  insert("list_accounts", { list_id: listId, account_id: r(0).uri, created_at: cdate(707) });
  insert("list_accounts", { list_id: listId, account_id: bob, created_at: cdate(708) });

  // ---- the export
  db.exec(
    "CREATE TABLE d1_migrations(\n\t\tid         INTEGER PRIMARY KEY AUTOINCREMENT,\n\t\tname       TEXT UNIQUE,\n\t\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL\n)",
  );
  if (loneSurrogates) {
    const LONE = "\ud83d";
    // JSON.stringify escapes the lone surrogate, so the stored JSON text itself stays well formed.
    type Properties = Record<string, unknown> & { attachment?: { name?: string }[] };
    const edit = (table: "actors" | "objects", id: string, change: (p: Properties) => void) => {
      const row = db.prepare(`SELECT properties FROM ${table} WHERE id = ?`).get(id) as { properties: string };
      const properties = JSON.parse(row.properties) as Properties;
      change(properties);
      db.prepare(`UPDATE ${table} SET properties = ? WHERE id = ?`).run(JSON.stringify(properties), id);
    };
    edit("actors", r(1).uri, (p) => {
      p.name = `${String(p.name)} ${LONE}`;
    });
    edit("actors", r(2).uri, (p) => {
      p.summary = `<p>bio ${LONE}</p>`;
    });
    edit("objects", r0Post.id, (p) => {
      p.content = `<p>cut ${LONE}</p>`;
      p.summary = `cw ${LONE}`;
      p.attachment![1]!.name = `alt ${LONE}`;
    });
  }
  let appliedAt0016: string | null = null;
  if (before0016 !== undefined) {
    const [note, target] = before0016 === "widened" ? [followersOnly, PUBLIC] : [unlisted, `${alice}/followers`];
    db.prepare(`UPDATE outbox_objects SET "to" = ?, cc = '[]' WHERE object_id = ?`).run(
      JSON.stringify([target]),
      note.id,
    );
    appliedAt0016 = before0016 === "unusable-time" ? "not a time" : cdate(before0016 === "widened" ? 135 : 125);
  }
  migrationNames(level).forEach((name, i) =>
    db
      .prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)")
      .run(name, name.startsWith("0016_") && appliedAt0016 !== null ? appliedAt0016 : cdate(-1000 + i)),
  );
  const texts = exportDatabase(db);
  if (notificationSequence !== undefined) {
    texts.set(
      "sqlite_sequence",
      `${SEQUENCE_HEADER}INSERT INTO "sqlite_sequence" ("name","seq") VALUES('actor_notifications',${notificationSequence});\n`,
    );
  }
  const fixture = { level, texts, users: users.map(({ username, email, uri }) => ({ username, email, uri })) };
  if (live) {
    return { ...fixture, database: db };
  }
  db.close();
  return fixture;
}

// The export of a database as `wrangler d1 export --table` writes it, one text per table. With `sequence`, also
// sqlite_sequence as the database holds it (the live D1 of the fingerprint suite).
export function exportDatabase(
  db: DatabaseSync,
  { sequence = false }: { sequence?: boolean } = {},
): Map<string, string> {
  const texts = new Map<string, string>();
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
    name: string;
    sql: string;
  }[];
  for (const { name, sql } of tables) {
    if (name.startsWith("sqlite_") || name.startsWith("search_fts") || /VIRTUAL/i.test(sql)) {
      continue;
    }
    // Generated columns are listed too, as a worst case for the loader.
    const all = (db.prepare("SELECT name FROM pragma_table_xinfo(?)").all(name) as { name: string }[]).map(
      (c) => c.name,
    );
    const parts = ["PRAGMA defer_foreign_keys=TRUE;", `${sql};`];
    const select = db.prepare(`SELECT ${all.map((c) => `"${c}"`).join(",")} FROM "${name}" ORDER BY rowid`);
    select.setReadBigInts(true);
    for (const row of select.all() as Record<string, SQLInputValue>[]) {
      parts.push(
        `INSERT INTO "${name}" (${all.map((c) => `"${c}"`).join(",")}) VALUES(${all.map((c) => literal(row[c])).join(",")});`,
      );
    }
    texts.set(name, `${parts.join("\n")}\n`);
  }
  if (sequence) {
    const rows = db.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name").all() as {
      name: string;
      seq: number;
    }[];
    texts.set(
      "sqlite_sequence",
      SEQUENCE_HEADER +
        rows.map((r) => `INSERT INTO "sqlite_sequence" ("name","seq") VALUES('${r.name}',${r.seq});\n`).join(""),
    );
  }
  return texts;
}
