import { STATUSES_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { fromHex } from "../platform/dump-literals";
import type { Page, PageQuery, Present } from "./accounts";
import { visibleSql } from "./audience";
import { optionalUserReadOperation, userReadOperation, userWriteOperation } from "./auth";
import { featureTag, unfeatureTag } from "./featured-tags";
import { tagNameSql } from "./status-bounds";
import { isHashtagName } from "./status-text";
import { listedTagName, listedTagNameSql, TAG_NAME_TOO_LONG, withinTagNameBound } from "./tag-bounds";
import { normalizeTag } from "./tag-name";
import { edgeRangeSql } from "./windows";

// A hashtag as Mastodon 4.5's REST::TagSerializer shows it. Kopje has no tags table: any valid name is a tag, used or
// not, as Mastodon builds an unsaved Tag for a name it has never seen (Api::V1::TagsController#set_or_create_tag). The
// name is the normalized one statuses and search show. A signed-in viewer is also told whether they follow the hashtag
// (tag_follows) and feature it on their profile (featured_tags, domain/featured-tags.ts).

export type TagHistory = { day: string; uses: string; accounts: string };

export type Tag = {
  id: string;
  name: string;
  url: string;
  history: TagHistory[];
  following?: boolean;
  featuring?: boolean;
};

// The Tag's id (Mastodon 4.3.1+ sends its tags row id). Kopje has no tags table, so the id is derived from the
// normalized name: the 64-bit FNV-1a hash of its UTF-8 bytes, cut to 63 bits so it reads as a positive bigint, in
// decimal. It is the same on every endpoint, instance and release, and two names share one with a chance of about
// n²/2⁶⁴ for n names, which no instance approaches. Nothing takes it back: /api/v1/tags/:id takes the name, and the
// clients surveyed use a Tag's id only to tell tags apart (Phanpy, the official Android app for featured hashtags) or
// use the name instead (Ice Cubes).
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = (1n << 64n) - 1n;
const MASK_63 = (1n << 63n) - 1n;

export function tagId(name: string): string {
  return idOfBytes(new TextEncoder().encode(name));
}

export function idOfBytes(bytes: Uint8Array): string {
  let hash = FNV_OFFSET;
  for (const byte of bytes) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK_64;
  }
  return (hash & MASK_63).toString();
}

// A hashtag as presented, `name`, and as stored, `key`: the hex of its stored bytes (SQLite's hex()). The key is the
// identity its id, history and relationships are read by, so a stored name whose bytes are not UTF-8 (an import's,
// which v2 search shows decoded) never takes another row's identity.
export type TagKey = { name: string; key: string };

export function tagKey(name: string): TagKey {
  return { name, key: hexOf(new TextEncoder().encode(name)) };
}

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

const HISTORY_DAYS = 7;
const DAY_MS = 86_400_000;

// Kopje's cap on the hashtags an account follows, where Mastodon has none: home reads a window of each followed
// hashtag's public statuses on every page (timelines.ts), so the hashtags bound that read (RES-7), as the caps on
// filters bound the matching every presentation does. Generous for a person.
export const MAX_FOLLOWED_TAGS = 100;
const TOO_MANY_FOLLOWED = "You have reached the maximum number of followed hashtags";

// Seven days of uses and distinct authors, today (UTC) first, as Mastodon's TagSerializer#history: an anonymous public
// aggregate (VIS-12). It counts public originals (Mastodon's Trends::Tags registers public statuses only) of available
// authors (visibleSql with no viewer), so it is the same for every viewer, whatever they block or mute, and reveals
// nothing a status's audience hides. Days come from published_at. The work is a range of the (name, status_id) index
// of public hashtags (status_tags_public) cut by status id (RES-7): ids carry the publication time of statuses Kopje
// created or received (domain/ids.ts), and the receipt time of ids a cutover kept, so the range holds the tag's public
// statuses the instance received in the last seven days. The range drives, each status sought by id.
// `rows` 'full' (one hashtag: GET /api/v1/tags/:id and the writes on it) applies the rule to the whole range, so the
// work follows the instance's receive volume. A number (a list, MD-5) takes the newest that many entries of the range
// raw, before the rule: a boost or an unavailable author's public entry takes a slot, so a list may undercount. The
// cap is per hashtag, never shared by a page, so a hashtag's counts do not depend on the list it is in.
export type HistoryRows = "full" | number;
// The trends lists' cap, and every other list's (v2 search, followed_tags, featured_tags/suggestions): those page up
// to 200 hashtags, which LISTED_HISTORY_ROWS keeps within RES-7 (docs/threat-model.md).
export const TREND_HISTORY_ROWS = 200;
export const LISTED_HISTORY_ROWS = 20;

export function tagHistory(db: Db, tag: TagKey, now: number, rows: HistoryRows): TagHistory[] {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const since = (BigInt(today - (HISTORY_DAYS - 1) * DAY_MS) << 16n).toString();
  const rule = `s.visibility = 'public' AND s.reblog_of_id IS NULL AND ${visibleSql("s", "NULL")}`;
  const from =
    rows === "full"
      ? `status_tags t INDEXED BY status_tags_public
				CROSS JOIN statuses s INDEXED BY ${STATUSES_ID_INDEX} ON s.id = t.status_id
				WHERE t.name = CAST(unhex(?1) AS TEXT) AND t.public = 1 AND t.status_id >= ?2 AND ${rule}`
      : `(SELECT t.status_id FROM status_tags t INDEXED BY status_tags_public
					WHERE t.name = CAST(unhex(?1) AS TEXT) AND t.public = 1 AND t.status_id >= ?2
					ORDER BY t.status_id DESC LIMIT ?3) c
				CROSS JOIN statuses s INDEXED BY ${STATUSES_ID_INDEX} ON s.id = c.status_id WHERE ${rule}`;
  const days = db.all<{ day: string; uses: number; accounts: number }>(
    `SELECT substr(s.published_at, 1, 10) AS day, count(*) AS uses, count(DISTINCT s.account_id) AS accounts
		FROM ${from} GROUP BY day`,
    ...(rows === "full" ? [tag.key, since] : [tag.key, since, rows]),
  );
  return historyDays(days, today);
}

// The seven days from `today` (a UTC midnight) back, each with its row of `rows` (by YYYY-MM-DD) or zeros, as
// Mastodon's TagSerializer#history writes them.
export function historyDays(
  rows: readonly { day: string; uses: number; accounts: number }[],
  today: number,
): TagHistory[] {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  return Array.from({ length: HISTORY_DAYS }, (_, index) => {
    const start = today - index * DAY_MS;
    const row = byDay.get(new Date(start).toISOString().slice(0, 10));
    return { day: String(start / 1000), uses: String(row?.uses ?? 0), accounts: String(row?.accounts ?? 0) };
  });
}

// The viewer's relationship to each of the hashtags `tags` (TagRelationshipsPresenter): the keys of the ones they
// follow and the ones they feature, two seeks of the (account_id, name) indexes per name, by its stored bytes.
function tagRelationships(
  db: Db,
  viewerId: string,
  tags: readonly TagKey[],
): { following: Set<string>; featuring: Set<string> } {
  const of = (table: "tag_follows" | "featured_tags") =>
    new Set(
      db
        .all<{ key: string }>(
          `SELECT hex(name) AS key FROM ${table}
					WHERE account_id = ?1 AND name IN (SELECT CAST(unhex(value) AS TEXT) FROM json_each(?2))`,
          viewerId,
          JSON.stringify([...new Set(tags.map((tag) => tag.key))]),
        )
        .map((row) => row.key),
    );
  return { following: of("tag_follows"), featuring: of("featured_tags") };
}

// Hashtags as the viewer sees them: with `following` and `featuring` for a signed-in viewer, and their history
// (tagHistory with `rows`), each identified by its key (a name given as text, by its UTF-8 bytes). A list's names are
// read through listedTagNameSql and listedTagName, v2 search's through searchedTagKey (tag-bounds.ts).
export function presentTags(
  db: Db,
  names: readonly (string | TagKey)[],
  viewerId: string | null,
  present: Present,
  now: number,
  rows: HistoryRows,
): Tag[] {
  const tags = names.map((name) => (typeof name === "string" ? tagKey(name) : name));
  const relationships = viewerId === null ? null : tagRelationships(db, viewerId, tags);
  return tags.map((tag) => ({
    id: idOfBytes(new Uint8Array(fromHex(tag.key))),
    name: tag.name,
    url: `${present.origin}/tags/${encodeURIComponent(tag.name)}`,
    history: tagHistory(db, tag, now, rows),
    ...(relationships === null
      ? {}
      : { following: relationships.following.has(tag.key), featuring: relationships.featuring.has(tag.key) }),
  }));
}

function presentTag(db: Db, name: string, viewerId: string | null, present: Present, now: number): Tag {
  const [tag] = presentTags(db, [name], viewerId, present, now, "full");
  if (tag === undefined) {
    throw new Error("a tag was not presented");
  }
  return tag;
}

// GET /api/v1/tags/:id. Null for a name that is not a hashtag.
export const getTag = optionalUserReadOperation<{ name: string; now: number; present: Present }, Tag | null>(
  (db, { name, now, present }, { accountId: viewerId }) => {
    const tag = tagName(name);
    return tag === null ? null : presentTag(db, tag, viewerId, present, now);
  },
);

// The hashtag `name` names, as the request names it: a hashtag name (Tag::HASHTAG_NAME_RE) normalized, or null for one
// that is not, or that leaves no name when normalized (a lone combining mark leaves none).
export function tagName(name: string): string | null {
  const tag = isHashtagName(name) ? normalizeTag(name) : "";
  return tag === "" ? null : tag;
}

export type TagInput = { name: string; now: number; present: Present };

export type TagResult =
  | { status: "ok"; value: Tag }
  | { status: "not_found" }
  | { status: "invalid"; errors: string[] };

// A write on the hashtag `name` (Api::V1::TagsController): a name that is not a hashtag is not found; the response is
// the hashtag as the viewer now sees it.
function tagWrite(
  change: (
    db: Db,
    accountId: string,
    input: TagInput & { tag: string },
  ) => { status: "ok" } | { status: "invalid"; errors: string[] },
) {
  return userWriteOperation<TagInput, TagResult>((db, input, { accountId }) => {
    const tag = tagName(input.name);
    if (tag === null) {
      return { status: "not_found" };
    }
    const result = change(db, accountId, { ...input, tag });
    return result.status === "ok"
      ? { status: "ok", value: presentTag(db, tag, accountId, input.present, input.now) }
      : result;
  });
}

// POST /api/v1/tags/:id/follow (TagFollow.find_or_create_by!): nothing more when already followed. Refused for a name
// past the list bound (tag-bounds.ts), even one an import already follows, and at MAX_FOLLOWED_TAGS, Kopje's own caps.
export const followTag = tagWrite((db, accountId, { tag, now }) => {
  if (!withinTagNameBound(tag)) {
    return { status: "invalid", errors: [TAG_NAME_TOO_LONG] };
  }
  if (db.first("SELECT 1 AS x FROM tag_follows WHERE account_id = ? AND name = ?", accountId, tag) !== undefined) {
    return { status: "ok" };
  }
  const followed = db.first<{ n: number }>("SELECT count(*) AS n FROM tag_follows WHERE account_id = ?", accountId);
  if ((followed?.n ?? 0) >= MAX_FOLLOWED_TAGS) {
    return { status: "invalid", errors: [TOO_MANY_FOLLOWED] };
  }
  db.run(
    "INSERT INTO tag_follows (account_id, name, created_at) VALUES (?, ?, ?)",
    accountId,
    tag,
    new Date(now).toISOString(),
  );
  return { status: "ok" };
});

// POST /api/v1/tags/:id/unfollow: nothing when not followed. Home is a read, so the hashtag's statuses leave it at
// once (Mastodon's TagUnmergeWorker).
export const unfollowTag = tagWrite((db, accountId, { tag }) => {
  db.run("DELETE FROM tag_follows WHERE account_id = ? AND name = ?", accountId, tag);
  return { status: "ok" };
});

// POST /api/v1/tags/:id/feature and /unfeature (CreateFeaturedTagService, RemoveFeaturedTagService with a tag). A
// hashtag featured this way is shown under its normalized name.
export const featureTagOperation = tagWrite((db, accountId, { tag, now, present }) =>
  featureTag(db, accountId, tag, now, present.origin),
);

export const unfeatureTagOperation = tagWrite((db, accountId, { tag, now, present }) => {
  unfeatureTag(db, accountId, tag, now, present.origin);
  return { status: "ok" };
});

// GET /api/v1/followed_tags (Api::V1::FollowedTagsController): the viewer's followed hashtags, newest follow first,
// paged by the follow's id through tag_follows_account.
export const followedTags = userReadOperation<{ page: PageQuery; present: Present }, Page<Tag>>(
  (db, { page, present }, { accountId, now }) => {
    const ascending = page.minId !== undefined;
    // A name the list bound refuses (an import's: tag_follows bounds no name) is left out; the page still reads
    // toward its limit by its rows (Page.cut), so the Link header passes it.
    const rows = db.all<{ id: string; key: string | null }>(
      `SELECT CAST(f.id AS TEXT) AS id, ${listedTagNameSql("f.name")} AS key FROM tag_follows f
			WHERE f.account_id = ?1 AND ${edgeRangeSql("f.id", "?2", "?3")}
			ORDER BY f.id ${ascending ? "ASC" : "DESC"} LIMIT ?4`,
      accountId,
      page.maxId ?? null,
      page.minId ?? page.sinceId ?? null,
      page.limit,
    );
    if (ascending) {
      rows.reverse();
    }
    return {
      items: presentTags(
        db,
        rows.flatMap((row) => listedTagName(row.key) ?? []),
        accountId,
        present,
        now,
        LISTED_HISTORY_ROWS,
      ),
      newest: rows[0]?.id ?? null,
      oldest: rows.at(-1)?.id ?? null,
      cut: rows.length >= page.limit,
    };
  },
);

// Tag::RECENT_STATUS_LIMIT and Api::V1::FeaturedTags::SuggestionsController::RECENT_TAGS_LIMIT.
const RECENT_STATUSES = 1000;
const SUGGESTIONS = 10;

// GET /api/v1/featured_tags/suggestions (Tag.suggestions_for_account): the hashtags of the viewer's newest 1,000
// statuses that they do not feature yet, the most used first (ties by name), at most 10. A window of the viewer's own
// statuses through statuses_account, whatever their history.
export const featuredTagSuggestions = userReadOperation<{ present: Present }, Tag[]>(
  (db, { present }, { accountId, now }) => {
    const rows = db.all<{ key: string }>(
      `SELECT ${listedTagNameSql("t.name")} AS key FROM (SELECT id FROM statuses WHERE account_id = ?1 ORDER BY id DESC LIMIT ?2) r
			CROSS JOIN status_tags t ON t.status_id = r.id
			WHERE ${tagNameSql("t.name")} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM featured_tags f WHERE f.account_id = ?1 AND f.name = t.name)
			GROUP BY t.name ORDER BY count(*) DESC, t.name LIMIT ?3`,
      accountId,
      RECENT_STATUSES,
      SUGGESTIONS,
    );
    return presentTags(
      db,
      rows.flatMap((row) => listedTagName(row.key) ?? []),
      accountId,
      present,
      now,
      LISTED_HISTORY_ROWS,
    );
  },
);
