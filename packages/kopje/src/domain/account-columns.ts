import { type ColumnMap, fixedColumns } from "../db/columns";
import { DOMAIN_BYTES } from "../platform/identity-bounds";
import {
  ACCOUNT_EMOJIS_BYTES,
  boundedLocalFieldsSql,
  byteBoundSql,
  byteCut,
  EMOJI_CACHE_BYTES,
  emojiCacheSql,
  isoTimeSql,
  MOVED_TO_ID_BYTES,
  presentedCountSql,
  presentedLocalFieldsSql,
  REMOTE_FIELD_INDEXES,
  REMOTE_FIELD_LINKS_BYTES,
  REMOTE_VERIFIED_SHOWN,
  STATIC_URL_LIMIT,
} from "../platform/stored-bounds";
import { availableJoinedSql, REACHES_FOLLOWERS_SQL } from "./audience";
import { REMOTE_FIELD_SOURCE_BYTES } from "./field-verification";
import { actorUriSql, cutSql, USERNAME_LIMIT, usernameSql } from "./profile-bounds";

// The account row as every presentation reads it (ACCOUNT_COLUMN_MAP) and a moved-to account nested in one
// (MOVED_ACCOUNT_COLUMNS), with the bounds they rest on; accounts.ts presents them. Imports only leaves, so modules
// that build SQL at load (status-rows.ts) can use it whatever the import order.

// Fields a remote profile shows: its PropertyValue attachments (ProcessAccountService#property_values), the name as
// plain text and the value as sanitized HTML (HTML-1, its links http(s) only, HTML-3), as Mastodon renders them.
// Kopje's bounds (RES-2): at most MAX_REMOTE_FIELDS, names cut at 255 code units, values at FIELD_VALUE_RAW_LIMIT
// before sanitizing, and REMOTE_FIELDS_BYTES in all. Mastodon keeps more: 50 fields
// (ActivityPub::ProcessAccountService::MAX_PROFILE_FIELDS) and 2,047 characters of each stripped name and value
// (Account::Field::MAX_CHARACTERS_COMPAT).
export const MAX_REMOTE_FIELDS = REMOTE_FIELD_INDEXES;
export const FIELD_NAME_LIMIT = 255;
export const FIELD_VALUE_RAW_LIMIT = 4096;
// The most UTF-8 bytes of field JSON one account carries: read from SQLite (REMOTE_ATTACHMENT_SQL) and, again, shown
// (remoteFields). An answer of N presented accounts thus carries at most N × 32 KiB of fields; an answer of many
// (a list's members with limit=0, familiar followers) at most ANSWER_BYTES in all.
export const REMOTE_FIELDS_BYTES = 32 * 1024;

// A remote account's attachment as ACCOUNT_COLUMN_MAP projects it, chosen and cut in SQL so that the stored actor
// document (up to the fetch budget, 2 MiB) never reaches the isolate: a JSON list of {name, value} entries in
// document order, at most MAX_REMOTE_FIELDS of them, the name cut (cutSql) at FIELD_NAME_LIMIT and the value at
// FIELD_VALUE_RAW_LIMIT code points, and only the leading entries whose JSON fits REMOTE_FIELDS_BYTES (size: the
// list's length in bytes once each entry and the ones before it are included). The bound is in bytes because
// escaping inflates characters up to six times. An entry counts when it is an object whose `type` is
// 'PropertyValue' or a list holding it and whose name and value are strings; an attachment that is one object
// counts as a list of one. SQLite counts code points where JavaScript counts code units, so remoteFields cuts again.
// `eligibility` (ingestion only, remote-field-links.ts): each entry kept by the same filter, order, limit and window
// (counted on the entry without it) also carries `src`, its original value before any cut, only when Mastodon would
// read the field (ActivityPub::ProcessAccountService#property_values: an attachment that is an array, a type that is
// exactly the text 'PropertyValue') and that value is text of at most REMOTE_FIELD_SOURCE_BYTES bytes with no NUL (so
// within Account::Field::MAX_CHARACTERS_COMPAT, uncut); remoteFieldLink judges it.
export function remoteAttachmentSql({ eligibility }: { eligibility: boolean }): string {
  const value = "e.value ->> '$.value'";
  const src = eligibility
    ? `, CASE WHEN json_type(a.raw, '$.attachment') = 'array' AND json_type(e.value, '$.type') = 'text'
				AND e.value ->> '$.type' = 'PropertyValue' AND length(CAST(${value} AS BLOB)) <= ${REMOTE_FIELD_SOURCE_BYTES}
				AND instr(CAST(${value} AS BLOB), x'00') = 0 THEN ${value} END AS src`
    : "";
  const entry = eligibility
    ? "CASE WHEN k.src IS NULL THEN k.entry ELSE json_insert(k.entry, '$.src', k.src) END"
    : "k.entry";
  return `CASE WHEN a.domain IS NOT NULL THEN (
		SELECT '[' || COALESCE(group_concat(${entry}, ',' ORDER BY k.key), '') || ']'
		FROM (SELECT c.key, c.entry${eligibility ? ", c.src" : ""},
				1 + sum(length(CAST(c.entry AS BLOB)) + 1) OVER (ORDER BY c.key) AS size
			FROM (SELECT e.key, json_object('name', ${cutSql("e.value ->> '$.name'", FIELD_NAME_LIMIT)},
					'value', ${cutSql(value, FIELD_VALUE_RAW_LIMIT)}) AS entry${src}
				FROM json_each(CASE json_type(a.raw, '$.attachment') WHEN 'array' THEN a.raw -> '$.attachment'
					ELSE json_array(a.raw -> '$.attachment') END) e
				WHERE e.type = 'object' AND json_type(e.value, '$.name') = 'text' AND json_type(e.value, '$.value') = 'text'
					AND json_type(e.value, '$.type') IN ('text', 'array')
					AND EXISTS (SELECT 1 FROM json_each(e.value, '$.type') t WHERE t.type = 'text' AND t.value = 'PropertyValue')
				ORDER BY e.key LIMIT ${MAX_REMOTE_FIELDS}) c) k
		WHERE k.size <= ${REMOTE_FIELDS_BYTES}) END`;
}
const REMOTE_ATTACHMENT_SQL = remoteAttachmentSql({ eligibility: false });

// A remote account's verification times (remote-field-links.ts, migration 0068), projected in SQL so that no stored
// value past its bound reaches the Worker: the row's links when text of at most REMOTE_FIELD_LINKS_BYTES with no NUL
// and valid JSON, then of its first REMOTE_VERIFIED_SHOWN entries those with an integer index from 0 to
// REMOTE_FIELD_INDEXES - 1 and a 24-byte ISO time (isoTimeSql), as [index, time]: at most REMOTE_VERIFIED_JSON_BYTES
// (test/status-bounds.test.ts derives it). By its key; null for a local account or a remote one with no row.
export const REMOTE_VERIFIED_JSON_BYTES = 129;
const REMOTE_VERIFIED_SQL = `CASE WHEN a.domain IS NOT NULL THEN (SELECT CASE WHEN typeof(r.links) = 'text'
		AND length(CAST(r.links AS BLOB)) <= ${REMOTE_FIELD_LINKS_BYTES} AND instr(CAST(r.links AS BLOB), x'00') = 0
		AND json_valid(r.links) AND json_type(r.links) = 'array'
	THEN (SELECT json_group_array(json_array(rt.i, rt.t) ORDER BY rt.k) FROM (SELECT e.key AS k, e.value ->> '$[0]' AS i,
			e.value ->> '$[2]' AS t FROM json_each(r.links) e
			WHERE e.type = 'array' AND json_type(e.value, '$[0]') = 'integer' AND json_type(e.value, '$[2]') = 'text'
			ORDER BY e.key LIMIT ${REMOTE_VERIFIED_SHOWN}) rt
		WHERE rt.i BETWEEN 0 AND ${REMOTE_FIELD_INDEXES - 1} AND ${isoTimeSql("rt.t")} IS NOT NULL) END
	FROM remote_field_links r WHERE r.account_id = a.id) END`;

// RES-2: stored profile bounds: platform/stored-bounds.ts; username and actor id read projections: profile-bounds.ts;
// fields: REMOTE_ATTACHMENT_SQL and remoteFields. Maxima: the account occurrence in docs/threat-model.md, "Maxima of
// presented units".
export const ACCOUNT_COLUMN_MAP = {
  id: "a.id",
  uri: actorUriSql("a.uri"),
  username: usernameSql("a.username"),
  domain: "a.domain",
  actor_type: "a.actor_type",
  display_name: "a.display_name",
  note: "a.note",
  url: "a.url",
  avatar_url: "a.avatar_url",
  header_url: "a.header_url",
  avatar_static_url: "a.avatar_static_url",
  header_static_url: "a.header_static_url",
  locked: "a.locked",
  discoverable: "a.discoverable",
  indexable: "a.indexable",
  followers_count: presentedCountSql("a.followers_count"),
  following_count: presentedCountSql("a.following_count"),
  statuses_count: presentedCountSql("a.statuses_count"),
  created_at: "a.created_at",
  available: availableJoinedSql("a", "l"),
  last_status_at: lastStatusAtSql("a"),
  local_fields: presentedLocalFieldsSql("l.fields"),
  verified_links: `CASE WHEN ${boundedLocalFieldsSql("l.fields")} IS NOT NULL THEN l.verified_links END`,
  hide_collections: "COALESCE(l.hide_collections, a.hide_collections)",
  attachment: REMOTE_ATTACHMENT_SQL,
  remote_verified: REMOTE_VERIFIED_SQL,
  emojis: "a.emojis",
  emoji_cache: emojiCacheSql("a.emojis", "a.domain"),
  moved_to_account_id: "a.moved_to_account_id",
} as const satisfies ColumnMap;

// The date of the account `a`'s newest status its followers reach.
function lastStatusAtSql(a: string): string {
  return `(SELECT substr(s.published_at, 1, 10) FROM statuses s
		WHERE s.account_id = ${a}.id AND s.visibility IN ${REACHES_FOLLOWERS_SQL} ORDER BY s.id DESC LIMIT 1)`;
}

// The account an account moved to, as it presents nested in Account#moved (docs/mastodon-deviations.md, "Accounts"):
// its identity and counts, no note or fields, and of its emojis only those its cut display name references, so that
// no target is read past what it shows (RES-3). Every text is cut in SQL by its raw UTF-8 bytes (an imported value
// may be malformed UTF-8, which SQLite's substr counts as fewer characters), then by its decoded limit in the
// presenter (presentMovedAccount): display_name at MOVED_DISPLAY_NAME_LIMIT code points (400 bytes read), username at
// USERNAME_LIMIT (1,020 bytes read), created_at at 24 and last_status_at at 10 (96 and 40 bytes read). The uri and
// URLs read as unset past MOVED_URL_LIMIT bytes (the statics past STATIC_URL_LIMIT, their stored bound), and are shown
// only within MOVED_URL_LIMIT as JSON writes them; emojis are the stored snapshot (ACCOUNT_EMOJIS_BYTES, 0053's
// trigger), shown within MOVED_EMOJIS_BYTES of JSON. A target whose domain passes DOMAIN_BYTES is not read (no
// `moved`).
export const MOVED_DISPLAY_NAME_LIMIT = 100;
export const MOVED_URL_LIMIT = 512;
export const MOVED_EMOJIS_BYTES = 2048;
// The decoded limits of created_at and last_status_at, in code points (an ISO time, a date).
export const MOVED_CREATED_AT_LIMIT = 24;
export const MOVED_LAST_STATUS_AT_LIMIT = 10;
// A code point is at most four UTF-8 bytes.
const POINT_BYTES = 4;

const movedFlag = (column: string) => `CASE ${column} WHEN 1 THEN 1 WHEN 0 THEN 0 END`;
// byteCut of a NOT NULL column: substr of an empty BLOB is NULL, read as ''.
const textCut = (column: string, bytes: number) => `coalesce(${byteCut(column, bytes)}, '')`;

const MOVED_COLUMN_MAP = {
  id: "m.id",
  uri: actorUriSql("m.uri", MOVED_URL_LIMIT),
  username: textCut(usernameSql("m.username"), POINT_BYTES * USERNAME_LIMIT),
  domain: "m.domain",
  actor_type: "CASE WHEN m.actor_type IN ('Service', 'Application', 'Group') THEN m.actor_type ELSE 'Person' END",
  display_name: textCut("m.display_name", POINT_BYTES * MOVED_DISPLAY_NAME_LIMIT),
  url: byteBoundSql("m.url", MOVED_URL_LIMIT),
  avatar_url: byteBoundSql("m.avatar_url", MOVED_URL_LIMIT),
  header_url: byteBoundSql("m.header_url", MOVED_URL_LIMIT),
  avatar_static_url: byteBoundSql("m.avatar_static_url", STATIC_URL_LIMIT),
  header_static_url: byteBoundSql("m.header_static_url", STATIC_URL_LIMIT),
  locked: movedFlag("m.locked"),
  discoverable: movedFlag("m.discoverable"),
  indexable: movedFlag("m.indexable"),
  followers_count: presentedCountSql("m.followers_count"),
  following_count: presentedCountSql("m.following_count"),
  statuses_count: presentedCountSql("m.statuses_count"),
  created_at: textCut("m.created_at", POINT_BYTES * MOVED_CREATED_AT_LIMIT),
  available: availableJoinedSql("m", "ml"),
  last_status_at: byteCut(lastStatusAtSql("m"), POINT_BYTES * MOVED_LAST_STATUS_AT_LIMIT),
  hide_collections: movedFlag("COALESCE(ml.hide_collections, m.hide_collections)"),
  emojis: "m.emojis",
  emoji_cache: emojiCacheSql("m.emojis", "m.domain"),
} as const satisfies ColumnMap;

// The most UTF-8 bytes each column of MOVED_COLUMN_MAP reads (0 for a number), which its row heap rests on.
export const MOVED_ACCOUNT_CAPS: { readonly [K in keyof typeof MOVED_COLUMN_MAP]: number } = {
  id: MOVED_TO_ID_BYTES,
  uri: MOVED_URL_LIMIT,
  username: POINT_BYTES * USERNAME_LIMIT,
  domain: DOMAIN_BYTES,
  actor_type: "Application".length,
  display_name: POINT_BYTES * MOVED_DISPLAY_NAME_LIMIT,
  url: MOVED_URL_LIMIT,
  avatar_url: MOVED_URL_LIMIT,
  header_url: MOVED_URL_LIMIT,
  avatar_static_url: STATIC_URL_LIMIT,
  header_static_url: STATIC_URL_LIMIT,
  locked: 0,
  discoverable: 0,
  indexable: 0,
  followers_count: 0,
  following_count: 0,
  statuses_count: 0,
  created_at: POINT_BYTES * MOVED_CREATED_AT_LIMIT,
  available: 0,
  last_status_at: POINT_BYTES * MOVED_LAST_STATUS_AT_LIMIT,
  hide_collections: 0,
  emojis: ACCOUNT_EMOJIS_BYTES,
  emoji_cache: EMOJI_CACHE_BYTES,
};

export const MOVED_ACCOUNT_COLUMNS = fixedColumns(MOVED_COLUMN_MAP, MOVED_ACCOUNT_CAPS);
