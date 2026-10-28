import { fromHex } from "../platform/dump-literals";
import { jsonBytes } from "./answer-budget";
import { MAX_TAG_LENGTH, TAG_NAME_BYTES, tagNameSql } from "./status-bounds";

// The name bound of a hashtag Kopje lists (v2 search, followed_tags, featured_tags/suggestions, featured hashtags and
// the actor's featuredTags) and accepts for a follow or a feature (RES-3): at most MAX_TAG_LENGTH code points and
// TAG_NAME_BYTES UTF-8 bytes, the bound a status's hashtags are read by (tagNameSql). Mastodon sets none; a name past
// it is refused with a 422 (docs/mastodon-deviations.md, Hashtags). A listed name also round-trips through strict
// UTF-8, so the name presented, and bound again as the key of its history and relationships, is the stored bytes, and
// holds no NUL; so it escapes in JSON to TAG_NAME_JSON_BYTES at most and its url percent-encodes to 3 × TAG_NAME_BYTES.
export const TAG_NAME_JSON_BYTES = 6 * MAX_TAG_LENGTH;
export const TAG_NAME_TOO_LONG = `Name is too long (maximum is ${MAX_TAG_LENGTH} characters)`;

const ENCODER = new TextEncoder();
const STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// The acceptance rule of a follow or a feature, for the normalized name (and a featured hashtag's spelling).
export function withinTagNameBound(name: string): boolean {
  return ENCODER.encode(name).length <= TAG_NAME_BYTES && [...name].length <= MAX_TAG_LENGTH;
}

// A stored name as a list reads it: the hex of its bytes within tagNameSql's bound, else NULL (never read whole).
export function listedTagNameSql(column: string): string {
  return `hex(${tagNameSql(column)})`;
}

// The name a listedTagNameSql key presents, or null when the list leaves it out: not well-formed UTF-8, a NUL, or past
// the bounds as decoded (an import's).
export function listedTagName(key: string | null): string | null {
  if (key === null || key === "") {
    return null;
  }
  let name: string;
  try {
    name = STRICT.decode(fromHex(key));
  } catch {
    return null;
  }
  return withinTagNameBound(name) && !name.includes("\0") && jsonBytes(name) - 2 <= TAG_NAME_JSON_BYTES ? name : null;
}

const LENIENT = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

// A v2 search hashtag from its key (hex(tagNameSql(name)), so within that bound before the page's LIMIT): its name
// decoded as the Store reads text (a malformed byte as U+FFFD), never left out, so the page's count is the rows it
// consumed and a client advancing its offset by the count neither repeats nor skips; its identity is the key.
export function searchedTagKey(key: string): { name: string; key: string } {
  return { name: LENIENT.decode(fromHex(key)), key };
}
