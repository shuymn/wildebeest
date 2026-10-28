import type { Db } from "../db/sql";
import { boundedHref } from "../platform/http-url";
import { FILE_TOKEN } from "../platform/media-files";
import {
  EMOJI_CACHE_LIMIT,
  EMOJI_ENTRY_BYTES,
  EMOJI_SHORTCODE,
  EMOJI_SHORTCODE_LIMIT,
  EMOJI_URL_LIMIT,
  isEmojiUrl,
  LOCAL_EMOJI_SHORTCODE,
  MAX_EMOJIS,
} from "../platform/stored-bounds";
import { cachedImageUrls } from "./remote-media";

// Remote custom emoji (RES-2, HTML-3): the snapshot an object's Emoji tags leave in statuses.emojis,
// status_edits.emojis and accounts.emojis, and the CustomEmoji entities presented from it. Bounds, the stored form and
// the triggers that hold it: platform/stored-bounds.ts (EMOJI_COLUMNS, migration 0053_custom_emoji_snapshots).
// Mastodon keeps a global (shortcode, domain) registry (app/models/status.rb, account.rb); Kopje keeps what each
// object tagged instead. A remote emoji's image is cached by (domain, url) (remote-media.ts, MEDIA-7); a presenter
// shows the cached copy of the first EMOJI_CACHE_LIMIT entries that have one (EmojiCache), else the remote URL.

// An Emoji tag as federation/remote-emoji.ts reads it: a shortcode within EMOJI_SHORTCODE and its normalized url
// (emojiHref).
export type EmojiCandidate = { shortcode: string; url: string };

// REST::CustomEmojiSerializer. static_url is the cached copy's still (or the cached file itself), else url: Mastodon
// serves a still image it generates (an accepted risk). visible_in_picker is the column's default; category is omitted, as Mastodon omits it
// when none is loaded.
export type CustomEmoji = { shortcode: string; url: string; static_url: string; visible_in_picker: true };

// An emoji url as stored and presented: http(s), serialized, within EMOJI_URL_LIMIT bytes and EMOJI_URL_ALPHABET, so
// the stored-bound triggers accept what ingestion writes; else none (the tag, or the stored entry, is dropped).
export function emojiHref(raw: string | null): string | null {
  const href = boundedHref(raw, EMOJI_URL_LIMIT);
  return href !== null && isEmojiUrl(href) ? href : null;
}

// Whether `name` is a shortcode a snapshot may hold.
export function isShortcode(name: string): boolean {
  return name.length <= EMOJI_SHORTCODE_LIMIT && EMOJI_SHORTCODE.test(name);
}

// The shortcodes `texts` reference (RES-2: linear, no pattern built from data): every segment strictly between two
// colons of one text that is a shortcode, so a reference never spans two texts. A superset of Mastodon's SCAN_RE
// (app/models/custom_emoji.rb:34-37), which also asks for a boundary outside both colons: `:aa:bb:` references aa and
// bb here, neither there. It can only keep an emoji the author tagged; clients do the replacement.
export function shortcodesIn(texts: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const text of texts) {
    const segments = text.split(":");
    for (let i = 1; i < segments.length - 1; i++) {
      const segment = segments[i]!;
      if (segment !== "" && isShortcode(segment)) {
        names.add(segment);
      }
    }
  }
  return names;
}

function entryBytes(shortcode: string, url: string, staticUrl = url): number {
  return EMOJI_ENTRY_BYTES + shortcode.length + url.length + staticUrl.length;
}

// The cached copies a row read with its snapshot (platform/stored-bounds.ts emojiCacheSql), by entry index, and the
// origin their URLs are on.
type EmojiCache = { packed: ReadonlyMap<number, string>; origin: string };

// The cache of `value` (an emoji_cache column) on `origin`: only entries below EMOJI_CACHE_LIMIT, each a packed string;
// anything else is left out, so a malformed value shows the remote URLs.
export function emojiCacheOf(value: string | null, origin: string): EmojiCache {
  const packed = new Map<number, string>();
  let entries: unknown;
  try {
    entries = value === null ? [] : JSON.parse(value);
  } catch {
    entries = [];
  }
  for (const entry of Array.isArray(entries) ? (entries as unknown[]) : []) {
    if (Array.isArray(entry) && entry.length === 2) {
      const [index, object] = entry as [unknown, unknown];
      if (Number.isInteger(index) && (index as number) >= 0 && (index as number) < EMOJI_CACHE_LIMIT) {
        if (typeof object === "string") {
          packed.set(index as number, object);
        }
      }
    }
  }
  return { packed, origin };
}

// The URLs entry `index` with remote `url` presents: its cached copy (the file, and its still) when `cache` holds one
// for the index (the first EMOJI_CACHE_LIMIT entries only), else the remote url for both. The one decision of cached
// against remote for an emoji, as cachedImageUrls is for an image.
function emojiUrls(url: string, index: number, cache: EmojiCache | undefined): { url: string; static_url: string } {
  const cached =
    cache === undefined || index >= EMOJI_CACHE_LIMIT
      ? null
      : cachedImageUrls(cache.packed.get(index) ?? null, cache.origin);
  const image = cached === null ? null : emojiHref(cached.image);
  const still = cached === null ? null : emojiHref(cached.still);
  return image === null || still === null ? { url, static_url: url } : { url: image, static_url: still };
}

// The snapshot of `candidates` (in tag order) that `texts` (the object's final stored or presented texts) reference,
// as stored: the first candidate of each referenced name, while there are at most MAX_EMOJIS and their presented JSON
// stays within `bytes`, stopping at the first that does not fit (as remoteFields stops); null when none is kept. Its
// output always passes the column's trigger (emojisValid).
export function emojiSnapshot(
  candidates: readonly EmojiCandidate[],
  texts: readonly string[],
  bytes: number,
): string | null {
  const referenced = shortcodesIn(texts);
  const pairs: [string, string][] = [];
  const kept = new Set<string>();
  let size = 1;
  for (const { shortcode, url } of candidates) {
    if (kept.has(shortcode) || !referenced.has(shortcode)) {
      continue;
    }
    size += entryBytes(shortcode, url);
    if (pairs.length === MAX_EMOJIS || size > bytes) {
      break;
    }
    kept.add(shortcode);
    pairs.push([shortcode, url]);
  }
  return pairs.length === 0 ? null : JSON.stringify(pairs);
}

// The entities of a stored snapshot (HTML-3, RES-3), imported rows included: each url normalized again through
// emojiHref, an entry whose url does not pass dropped and the rest kept, then entries admitted while
// 1 + Σ(67 + n + 2·url) stays within `bytes`, stopping at the first that does not fit (normalizing an imported value
// may grow it). A stored value that is not a JSON array (the triggers refuse one) shows none, so a row never fails
// the request that presents it.
export function presentEmojis(stored: string | null, bytes: number, cache?: EmojiCache): CustomEmoji[] {
  let entries: unknown;
  try {
    entries = stored === null ? [] : JSON.parse(stored);
  } catch {
    entries = [];
  }
  const emojis: CustomEmoji[] = [];
  let size = 1;
  const list = Array.isArray(entries) ? (entries as unknown[]) : [];
  for (const [index, entry] of list.entries()) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      continue;
    }
    const [shortcode, raw] = entry as [unknown, unknown];
    if (typeof shortcode !== "string" || typeof raw !== "string") {
      continue;
    }
    const url = emojiHref(raw);
    if (url === null || !isShortcode(shortcode)) {
      continue;
    }
    const shown = emojiUrls(url, index, cache);
    size += entryBytes(shortcode, shown.url, shown.static_url);
    if (emojis.length === MAX_EMOJIS || size > bytes) {
      break;
    }
    emojis.push({ shortcode, ...shown, visible_in_picker: true });
  }
  return emojis;
}

// A JSON string literal of a stored snapshot: its names and urls, in order. The triggers keep a snapshot an array of
// [name, url] pairs of strings (emojisPastBoundSql), so the literals come in pairs; matchAll copies the pattern.
const STRING_LITERAL = /"(?:[^"\\]|\\.)*"/g;

// The entities of a stored snapshot whose shortcodes `texts` reference (shortcodesIn), in snapshot order, admitted as
// presentEmojis admits them while 1 + Σ(67 + n + 2·url) stays within `bytes`, stopping at the first that does not
// fit. The snapshot is read one literal at a time, never parsed whole: an unreferenced entry is skipped by its decoded
// name, and only a referenced one is normalized and measured, so at most one entry past the admitted ones is held.
// A literal that is not a JSON string (none the triggers accept) is skipped, so a row never fails its request.
export function referencedEmojis(
  stored: string | null,
  texts: readonly string[],
  bytes: number,
  cache?: EmojiCache,
): CustomEmoji[] {
  if (stored === null) {
    return [];
  }
  const referenced = shortcodesIn(texts);
  const literals = stored.matchAll(STRING_LITERAL);
  const emojis: CustomEmoji[] = [];
  let size = 1;
  for (let name = literals.next(), index = 0; name.done !== true; name = literals.next(), index++) {
    const url = literals.next();
    if (url.done === true) {
      break;
    }
    const shortcode = decodedString(name.value[0]);
    if (shortcode === null || !referenced.has(shortcode) || !isShortcode(shortcode)) {
      continue;
    }
    const href = emojiHref(decodedString(url.value[0]));
    if (href === null) {
      continue;
    }
    const shown = emojiUrls(href, index, cache);
    size += entryBytes(shortcode, shown.url, shown.static_url);
    if (emojis.length === MAX_EMOJIS || size > bytes) {
      break;
    }
    emojis.push({ shortcode, ...shown, visible_in_picker: true });
  }
  return emojis;
}

function decodedString(literal: string): string | null {
  try {
    const value = JSON.parse(literal) as unknown;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

// Poll#emojis (app/models/poll.rb:69-71): the status's emojis its choices reference, a subset of the status's.
export function pollEmojis(emojis: readonly CustomEmoji[], titles: readonly string[]): CustomEmoji[] {
  const referenced = shortcodesIn(titles);
  return emojis.filter((emoji) => referenced.has(emoji.shortcode));
}

// ---- Local custom emoji (migration 0055_local_custom_emojis, local-emojis.ts)

// Names a local snapshot looks up at most (RES-2): the texts' first distinct shortcodes in the local grammar.
export const MAX_LOCAL_EMOJI_NAMES = 1024;

// The snapshot of the enabled local emoji that `texts` reference, as emojiSnapshot stores it (null for none), so its
// output always passes the column's trigger. The names are the texts' shortcodes in the local grammar
// (LOCAL_EMOJI_SHORTCODE) in order of first occurrence, at most MAX_LOCAL_EMOJI_NAMES, looked up in one query through
// custom_emojis_enabled; an emoji whose url fails emojiHref is left out. Unlisted emoji (visible_in_picker 0) are
// used, disabled ones are not, as Mastodon's CustomEmoji.from_text uses every enabled local emoji (status.rb:279-286,
// account.rb:450-451, 486-488). The texts are the stored ones a presenter shows.
export function localEmojiSnapshot(db: Db, texts: readonly string[], bytes: number): string | null {
  const names = [...shortcodesIn(texts)].filter((name) => LOCAL_EMOJI_SHORTCODE.test(name));
  if (names.length === 0) {
    return null;
  }
  // json_each drives the join (CROSS JOIN), one index search per name; the rows are put in name order here, so no
  // sort runs in SQLite.
  const rows = db
    .all<{ i: number; shortcode: string; url: string }>(
      `SELECT j.key AS i, e.shortcode, m.url FROM json_each(?1) j
			CROSS JOIN custom_emojis e INDEXED BY custom_emojis_enabled ON e.shortcode = j.value AND e.disabled = 0
			JOIN media_attachments m ON m.id = e.id`,
      JSON.stringify(names.slice(0, MAX_LOCAL_EMOJI_NAMES)),
    )
    .toSorted((a, b) => a.i - b.i);
  const candidates = rows.flatMap((row) => {
    const url = emojiHref(row.url);
    return url === null ? [] : [{ shortcode: row.shortcode, url }];
  });
  return emojiSnapshot(candidates, texts, bytes);
}

// An Emoji tag as ActivityPub::EmojiSerializer writes it (app/serializers/activitypub/emoji_serializer.rb:8-30, its
// icon as ImageSerializer, image_serializer.rb:8-21): id /emojis/<id>, `:shortcode:`, its time and its image.
export type EmojiTag = {
  id: string;
  type: "Emoji";
  name: string;
  updated: string;
  icon: { type: "Image"; mediaType: string; url: string };
};

// The local emoji a stored snapshot names (statuses.emojis of a local status, accounts.emojis of a local account), as
// Emoji tags, in snapshot order: each entry presentEmojis keeps (within `bytes`) whose url is a served full image on
// `origin` (/media/<token>/full.png or .webp) of an emoji row with the same url and shortcode. Disabled emoji are
// kept (the object shows what was posted); an entry that resolves to none is left out. One query over at most
// MAX_EMOJIS file tokens, each by the unique index of media_attachments.file_token.
export function localEmojiTags(db: Db, stored: string | null, origin: string, bytes: number): EmojiTag[] {
  const entries = presentEmojis(stored, bytes);
  const prefix = `${origin}/media/`;
  const tokens = entries.flatMap(({ url }) => {
    const match = url.startsWith(prefix) ? /^([^/]+)\/full\.(png|webp)$/.exec(url.slice(prefix.length)) : null;
    return match !== null && FILE_TOKEN.test(match[1]!) ? [match[1]!] : [];
  });
  if (tokens.length === 0) {
    return [];
  }
  const rows = db.all<{ url: string; content_type: string; id: string; shortcode: string; created_at: string }>(
    `SELECT m.url, m.content_type, e.id, e.shortcode, e.created_at FROM json_each(?1) j
		CROSS JOIN media_attachments m ON m.file_token = j.value JOIN custom_emojis e ON e.id = m.id`,
    JSON.stringify(tokens.slice(0, MAX_EMOJIS)),
  );
  const byUrl = new Map(rows.map((row) => [row.url, row]));
  return entries.flatMap(({ shortcode, url }) => {
    const row = byUrl.get(url);
    const tag = row === undefined || row.shortcode !== shortcode ? null : emojiTag(origin, row);
    return tag === null ? [] : [tag];
  });
}

// An ISO 8601 instant as Kopje writes one (Date#toISOString), hour 00 to 23: what Temporal.Instant.from and peers
// parse.
const INSTANT = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

// Whether a stored time may be an Emoji's `updated`: an instant that Date reads back as itself. The one check every
// presenter of an Emoji tag goes through (Notes and Questions, the actor, Update(Person), /emojis/:id), so a stored
// value the 0055 CHECK should have refused drops the tag (or answers 404) rather than failing the document.
export function emojiInstant(stored: string): boolean {
  if (!INSTANT.test(stored)) {
    return false;
  }
  const ms = Date.parse(stored);
  return Number.isFinite(ms) && new Date(ms).toISOString() === stored;
}

// The tag of an emoji row, or null when its time is not an instant (emojiInstant).
export function emojiTag(
  origin: string,
  row: { id: string; shortcode: string; created_at: string; content_type: string; url: string },
): EmojiTag | null {
  if (!emojiInstant(row.created_at)) {
    return null;
  }
  return {
    id: `${origin}/emojis/${row.id}`,
    type: "Emoji",
    name: `:${row.shortcode}:`,
    updated: row.created_at,
    icon: { type: "Image", mediaType: row.content_type, url: row.url },
  };
}
