/* global crypto */
// The actual side of the conversion check, read from a Kopje dump (the converted file, or a dump of the Store after the
// import), and the comparison with the expected side (verify-expect.js). Plain JS without Node APIs, so the same check
// runs in the Workers test pool against a real Store.
//
// Each category maps a key built from AP URIs to the exact record. The check FAILs on any missing, extra or changed
// record: content that is missing or rewritten (even to the same length), a dropped relationship, or a different count.
// The report has counts and SHA-256 digests only, never records or keys.

import { readDumpText, textOf } from "./dump-parse.js";

/** @typedef {Record<string, Record<string, string>>} Records */

// Categories where only the expected keys are checked: the Store holds more ids than the legacy instance had, and
// its own settings (configuration, keys made at setup) besides the imported ones. The keys the expected side names in
// <category>_absent (a setting the conversion drops) must still be absent.
const SUBSET = new Set(["legacy_ids", "settings"]);

export const CATEGORIES = [
  "accounts",
  "profile_updates",
  "keys",
  "raw",
  "statuses",
  "audience",
  "replies",
  "aliases",
  "counters",
  "edits",
  "attachments",
  "media",
  "media_files",
  "boosts",
  "legacy_ids",
  "follows",
  "favourites",
  "bookmarks",
  "blocks",
  "mutes",
  "domain_blocks",
  "lists",
  "list_accounts",
  "notifications",
  "threads",
  "conversations",
  "settings",
  "clients",
  "emojis",
];

// Kopje's limited is legacy's direct with silent recipients: the same audience, its mentions.
/** @param {string | null} v */
const legacyVisibility = (v) => (v === "limited" ? "direct" : v);

/** @param {string | undefined} literal */
function int(literal) {
  return literal === undefined || literal === "NULL" ? null : Number(literal);
}

/** @param {string | undefined} literal */
function blobHex(literal) {
  return literal === undefined || !/^[Xx]'/.test(literal) ? "" : literal.slice(2, -1).toUpperCase();
}

/**
 * A media meta value in comparison form: full and preview sizes, null where absent.
 * @param {unknown} meta
 */
function sizesOf(meta) {
  if (typeof meta !== "object" || meta === null) {
    return null;
  }
  const m =
    /** @type {{ original?: { width?: unknown, height?: unknown } | null, small?: { width?: unknown, height?: unknown } | null }} */ (
      meta
    );
  /** @type {unknown[]} */
  const sizes = [
    m.original?.width ?? null,
    m.original?.height ?? null,
    m.small?.width ?? null,
    m.small?.height ?? null,
  ];
  return sizes;
}

/**
 * @param {string} text the whole dump
 * @returns {Records}
 */
export function actualFromDump(text) {
  /** @type {Records} */
  const out = {};
  /** @param {string} category @param {string} key @param {unknown} value */
  const put = (category, key, value) => {
    const records = (out[category] ??= {});
    records[key] = JSON.stringify(value);
  };
  /** @type {Map<string, { uri: string, local: boolean }>} */
  const accounts = new Map();
  /** @type {Map<string, { uri: string, author: string, record: unknown[], visibility: string | null, inReplyTo: string | null, alias: string | null, remote: boolean, thread: string | null }>} */
  const statuses = new Map();
  /** @type {Map<string, string>} */
  const reblogOf = new Map();
  /** @type {Map<string, string>} */
  const parentOf = new Map();
  /** @type {Map<string, [string, number, number, string][]>} status id -> its recipients, each with silent, requires_mention and author_id */
  const mentions = new Map();
  /** @type {Map<string, [string, number][]>} status id -> its hashtags, each with status_tags.public */
  const tags = new Map();
  /** @type {Map<string, unknown[]>} */
  const edits = new Map();
  /** @type {Map<string, [number, unknown[]][]>} */
  const media = new Map();
  /** @type {Map<string, { owner: string, thread: string, participants: string, last: string, unread: number | null }>} */
  const conversations = new Map();
  /** @type {Map<string, string[]>} conversation id -> its status ids */
  const conversationStatuses = new Map();
  // Rows holding an emoji snapshot, by table, boosts included, and local custom emoji (migration
  // 0055_local_custom_emojis): legacy has no custom emoji, so a conversion writes none (each is an extra record of
  // `emojis`, and the report counts them).
  const emojiRows = { accounts: 0, statuses: 0, status_edits: 0, custom_emojis: 0 };
  /** @type {unknown} the kopje_state profile_updates value: ids of local accounts that publication announces */
  let profileUpdates = [];
  const account = (/** @type {string | null} */ id) => (id === null ? undefined : accounts.get(id));
  const status = (/** @type {string | null} */ id) => (id === null ? undefined : statuses.get(id));

  const { statements } = readDumpText(text);
  for (const statement of statements) {
    if (statement.kind === "link") {
      if (statement.table === "statuses") {
        const id = textOf(statement.where.find(([c]) => c === "id")?.[1]);
        const target = textOf(statement.set.find(([c]) => c === "reblog_of_id")?.[1]);
        const parent = textOf(statement.set.find(([c]) => c === "in_reply_to_id")?.[1]);
        if (id !== null && target !== null) {
          reblogOf.set(id, target);
        }
        if (id !== null && parent !== null) {
          parentOf.set(id, parent);
        }
      }
      continue;
    }
    /** @type {Record<string, string>} */
    const row = {};
    statement.columns.forEach((column, i) => {
      row[column] = statement.literals[i] ?? "NULL";
    });
    /** @param {string} column */
    const t = (column) => textOf(row[column]);
    switch (statement.table) {
      case "accounts": {
        const uri = t("uri") ?? "";
        const local = row.domain === "NULL";
        emojiRows.accounts += row.emojis === undefined || row.emojis === "NULL" ? 0 : 1;
        accounts.set(t("id") ?? "", { uri, local });
        put("accounts", uri, [
          local ? 1 : 0,
          local ? t("username") : null,
          t("display_name"),
          t("note"),
          t("avatar_url"),
          t("header_url"),
          int(row.locked),
          t("actor_type"),
          int(row.discoverable),
          t("url"),
        ]);
        if (row.raw !== "NULL") {
          put("raw", `account ${uri}`, t("raw"));
        }
        put("legacy_ids", `account ${t("id") ?? ""}`, uri);
        if (row.legacy_id !== "NULL") {
          put("legacy_ids", `account ${t("legacy_id") ?? ""}`, uri);
        }
        break;
      }
      case "local_accounts": {
        const owner = account(t("account_id"));
        /** @type {unknown} */
        let aliases;
        try {
          aliases = JSON.parse(t("also_known_as") ?? "");
        } catch {
          aliases = "(not JSON)";
        }
        put("keys", owner?.uri ?? "", [
          t("email"),
          blobHex(row.privkey),
          blobHex(row.privkey_salt),
          t("pubkey"),
          aliases,
          t("default_visibility"),
          int(row.default_sensitive),
          t("default_language"),
        ]);
        break;
      }
      case "statuses": {
        const uri = t("uri") ?? "";
        const owner = account(t("account_id"));
        const author = owner?.uri ?? "";
        const id = t("id") ?? "";
        emojiRows.statuses += row.emojis === undefined || row.emojis === "NULL" ? 0 : 1;
        statuses.set(id, {
          uri,
          author,
          record: [
            author,
            t("content"),
            t("source_text"),
            t("spoiler_text"),
            int(row.sensitive),
            t("published_at"),
            t("language"),
            t("edited_at"),
            t("url"),
          ],
          visibility: legacyVisibility(t("visibility")),
          inReplyTo: t("in_reply_to_uri"),
          alias: t("legacy_ap_o"),
          remote: owner !== undefined && !owner.local,
          thread: t("thread"),
        });
        if (row.raw !== "NULL") {
          put("raw", `status ${uri}`, t("raw"));
        }
        put("legacy_ids", `status ${id}`, uri);
        if (row.legacy_id !== "NULL") {
          put("legacy_ids", `status ${t("legacy_id") ?? ""}`, uri);
        }
        break;
      }
      case "status_tags": {
        const id = t("status_id") ?? "";
        tags.set(id, [...(tags.get(id) ?? []), [t("name") ?? "", Number(int(row.public))]]);
        break;
      }
      case "status_mentions": {
        const id = t("status_id") ?? "";
        mentions.set(id, [
          ...(mentions.get(id) ?? []),
          [
            account(t("account_id"))?.uri ?? "",
            Number(int(row.silent)),
            Number(int(row.requires_mention)),
            account(t("author_id"))?.uri ?? "",
          ],
        ]);
        break;
      }
      case "sqlite_sequence":
        if (t("name") === "notifications") {
          put("counters", "notifications", row.seq);
        }
        break;
      case "status_edits": {
        const uri = status(t("status_id"))?.uri ?? "";
        emojiRows.status_edits += row.emojis === undefined || row.emojis === "NULL" ? 0 : 1;
        // The attachments a version shows, as its media_json presents them.
        /** @type {({ url?: unknown, preview_url?: unknown, description?: unknown, meta?: unknown } | null)[]} */
        let shown = [];
        try {
          const parsed = /** @type {unknown} */ (JSON.parse(t("media_json") ?? "[]"));
          shown = Array.isArray(parsed) ? /** @type {typeof shown} */ (parsed) : [];
        } catch {
          shown = [];
        }
        const media = shown.map(
          (m) =>
            /** @type {unknown[]} */ ([m?.url ?? null, m?.preview_url ?? null, m?.description ?? "", sizesOf(m?.meta)]),
        );
        edits.set(uri, [...(edits.get(uri) ?? []), [t("content"), t("spoiler_text"), int(row.sensitive), media]]);
        break;
      }
      case "media_attachments": {
        if (row.legacy_ap_o !== "NULL") {
          put("media", t("legacy_ap_o") ?? "", [
            t("url"),
            account(t("account_id"))?.uri ?? null,
            row.status_id === "NULL" ? null : (status(t("status_id"))?.uri ?? null),
          ]);
        }
        // Local media served from R2, as `convert --images` makes it from Cloudflare Images.
        if (row.file_token !== undefined && row.file_token !== "NULL") {
          /** @type {unknown} */
          let meta = null;
          try {
            meta = /** @type {unknown} */ (JSON.parse(t("meta") ?? "null"));
          } catch {
            meta = null;
          }
          put("media_files", t("file_token") ?? "", [t("url"), t("preview_url"), t("content_type"), sizesOf(meta)]);
        }
        // What the status shows now; an image only its earlier versions show (shown 0) is compared through them.
        const owner = int(row.shown) === 0 ? undefined : status(t("status_id"));
        if (owner !== undefined) {
          media.set(owner.uri, [
            ...(media.get(owner.uri) ?? []),
            [Number(int(row.position)), [t("url"), t("description")]],
          ]);
        }
        break;
      }
      case "follows":
        put("follows", `${account(t("account_id"))?.uri} ${account(t("target_account_id"))?.uri}`, [
          t("state"),
          t("uri"),
          int(row.show_reblogs),
          int(row.notify),
          t("languages"),
        ]);
        break;
      case "favourites":
        put("favourites", `${account(t("account_id"))?.uri} ${status(t("status_id"))?.uri}`, [t("uri")]);
        break;
      case "bookmarks":
        put("bookmarks", `${account(t("account_id"))?.uri} ${status(t("status_id"))?.uri}`, 1);
        break;
      case "blocks":
        put("blocks", `${account(t("account_id"))?.uri} ${account(t("target_account_id"))?.uri}`, [t("uri")]);
        break;
      case "mutes":
        put("mutes", `${account(t("account_id"))?.uri} ${account(t("target_account_id"))?.uri}`, [
          int(row.hide_notifications),
          t("expires_at"),
        ]);
        break;
      case "domain_blocks":
        put("domain_blocks", `${account(t("account_id"))?.uri} ${t("domain")}`, 1);
        break;
      case "lists":
        put("lists", t("id") ?? "", [
          account(t("account_id"))?.uri,
          t("title"),
          t("replies_policy"),
          int(row.exclusive),
        ]);
        break;
      case "list_accounts":
        put("list_accounts", `${t("list_id")} ${account(t("account_id"))?.uri}`, 1);
        break;
      case "notifications":
        put("notifications", row.id ?? "", [
          t("type"),
          account(t("account_id"))?.uri,
          account(t("from_account_id"))?.uri,
          row.status_id === "NULL" ? "" : status(t("status_id"))?.uri,
        ]);
        break;
      case "conversations":
        conversations.set(t("id") ?? "", {
          owner: t("account_id") ?? "",
          thread: t("thread") ?? "",
          participants: t("participants") ?? "",
          last: t("last_status_id") ?? "",
          unread: int(row.unread),
        });
        break;
      case "conversation_statuses": {
        const id = t("conversation_id") ?? "";
        const members = conversationStatuses.get(id);
        if (members === undefined) {
          conversationStatuses.set(id, [t("status_id") ?? ""]);
        } else {
          members.push(t("status_id") ?? "");
        }
        break;
      }
      case "instance_settings":
        put("settings", t("name") ?? "", t("value"));
        break;
      case "kopje_state":
        if (t("name") === "profile_updates") {
          try {
            profileUpdates = JSON.parse(t("value") ?? "");
          } catch {
            profileUpdates = ["(not a list)"];
          }
        }
        break;
      case "oauth_clients":
        put("clients", t("id") ?? "", [t("secret"), t("name"), t("redirect_uris"), t("scopes"), t("website")]);
        break;
      case "custom_emojis":
        emojiRows.custom_emojis++;
        break;
      default:
        break;
    }
  }
  for (const [id, entry] of statuses) {
    const target = reblogOf.get(id);
    if (target !== undefined) {
      const boostRecipients = (mentions.get(id) ?? []).toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      put("boosts", entry.uri, [entry.author, statuses.get(target)?.uri, entry.visibility, boostRecipients]);
      continue;
    }
    put("threads", entry.uri, entry.thread);
    put("statuses", entry.uri, [
      ...entry.record,
      (tags.get(id) ?? []).toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    ]);
    tags.delete(id);
    const recipients = (mentions.get(id) ?? []).toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const open = entry.visibility === "public" || entry.visibility === "unlisted";
    put("audience", entry.uri, [entry.visibility, recipients, open ? null : entry.author]);
    const parent = parentOf.get(id);
    if (entry.inReplyTo !== null || parent !== undefined) {
      put("replies", entry.uri, [entry.inReplyTo, parent === undefined ? null : (statuses.get(parent)?.uri ?? null)]);
    }
    if (entry.remote && entry.alias !== null) {
      put("aliases", entry.alias, entry.uri);
    }
  }
  // Hashtags of a boost or of no status are records of their own, so they fail as extra ones.
  for (const [id, names] of tags) {
    put("statuses", `hashtags of ${statuses.get(id)?.uri ?? `no status ${id}`}`, names);
  }
  // Each conversation by its owner, thread and the other accounts, with its statuses; and whether its last status is
  // its newest, and it is unread exactly when that one is someone else's.
  for (const [id, c] of conversations) {
    const owner = account(c.owner)?.uri;
    /** @type {unknown} */
    let participants;
    try {
      participants = JSON.parse(c.participants);
    } catch {
      participants = null;
    }
    const others = Array.isArray(participants)
      ? participants.map((x) => account(String(x))?.uri ?? `unknown account ${String(x)}`).toSorted()
      : ["(not a list)"];
    const members = (conversationStatuses.get(id) ?? []).toSorted();
    const newest = members.at(-1);
    put("conversations", `${owner} ${c.thread} ${others.join(" ")}`, [
      members.map((m) => statuses.get(m)?.uri ?? `no status ${m}`).toSorted(),
      c.last === newest,
      c.unread === (status(newest ?? null)?.author !== owner ? 1 : 0),
    ]);
  }
  // A repeated id is a record of its own, so it fails as an extra one.
  const listed = new Set();
  for (const [index, id] of (Array.isArray(profileUpdates) ? profileUpdates : ["(not a list)"]).entries()) {
    const owner = account(typeof id === "string" ? id : null);
    const key = owner?.local === true ? owner.uri : `not a local account: ${String(id)}`;
    put("profile_updates", listed.has(key) ? `repeated at ${index}: ${key}` : key, 1);
    listed.add(key);
  }
  for (const [uri, versions] of edits) {
    put("edits", uri, versions);
  }
  for (const [table, rows] of Object.entries(emojiRows)) {
    if (rows > 0) {
      put("emojis", table, rows);
    }
  }
  for (const [uri, items] of media) {
    put(
      "attachments",
      uri,
      items.toSorted((a, b) => a[0] - b[0]).map(([, value]) => value),
    );
  }
  return out;
}

/** @param {string} text */
async function sha256(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** @param {Record<string, string>} records @param {string[]} keys */
function canonical(records, keys) {
  return keys
    .toSorted()
    .map((key) => `${JSON.stringify(key)}\t${records[key]}\n`)
    .join("");
}

/**
 * Compares the expected and actual records. The report holds counts and digests only.
 * @param {Records} expected
 * @param {Records} actual
 */
export async function compareConversion(expected, actual) {
  /** @type {Record<string, { expected: number, actual: number, missing: number, extra: number, changed: number, expectedSha256: string, actualSha256: string }>} */
  const categories = {};
  let failed = false;
  for (const name of CATEGORIES) {
    const want = expected[name] ?? {};
    const have = actual[name] ?? {};
    const wantKeys = Object.keys(want);
    const subset = SUBSET.has(name);
    const haveKeys = subset ? wantKeys.filter((k) => k in have) : Object.keys(have);
    let missing = 0;
    let changed = 0;
    for (const key of wantKeys) {
      if (!(key in have)) {
        missing++;
      } else if (have[key] !== want[key]) {
        changed++;
      }
    }
    // A subset category's keys the expected side names absent (verify-expect.js settings_absent) must be absent.
    const absent = Object.keys(expected[`${name}_absent`] ?? {}).filter((k) => k in have).length;
    const extra = subset ? absent : haveKeys.filter((k) => !(k in want)).length;
    failed ||= missing + changed + extra > 0;
    categories[name] = {
      expected: wantKeys.length,
      actual: haveKeys.length,
      missing,
      extra,
      changed,
      expectedSha256: await sha256(canonical(want, wantKeys)),
      actualSha256: await sha256(canonical(have, haveKeys)),
    };
  }
  // The rows holding an emoji snapshot, and the local custom emoji, by table (none expected).
  const emojis = Object.fromEntries(
    ["accounts", "statuses", "status_edits", "custom_emojis"].map((table) => [
      table,
      Number(actual.emojis?.[table] ?? 0),
    ]),
  );
  return { result: failed ? "FAIL" : "PASS", categories, emojis };
}
