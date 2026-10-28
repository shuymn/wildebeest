import type { CustomEmoji } from "../src/domain/custom-emojis";
import {
  ACCOUNT_EMOJIS_BYTES,
  EMOJI_SHORTCODE_LIMIT,
  EMOJI_URL_LIMIT,
  STATUS_EMOJIS_BYTES,
} from "../src/platform/stored-bounds";

// Custom emoji snapshots at their bounds (RES-2, platform/stored-bounds.ts EMOJI_COLUMNS), as [shortcode, url] pairs.
// Every url is a fixed point of WHATWG normalization, so the presenter keeps it as stored.

export type Pairs = [string, string][];

// The CustomEmoji entity a test expects for a shortcode and its url, as REST::CustomEmojiSerializer shows it.
export function customEmoji(shortcode: string, url: string): CustomEmoji {
  return { shortcode, url, static_url: url, visible_in_picker: true };
}

// An http url of exactly `bytes` bytes, distinct by `key`.
export function emojiUrl(bytes: number, key = ""): string {
  const prefix = `http://a/${key}`;
  if (prefix.length > bytes) {
    throw new Error(`no url of ${bytes} bytes for ${key}`);
  }
  return prefix.padEnd(bytes, "x");
}

// A shortcode of exactly `length` characters, distinct by `i` (its base-36 digits in front).
export function shortcode(length: number, i: number): string {
  const key = i.toString(36);
  if (key.length > length) {
    throw new Error(`no shortcode of ${length} characters for ${i}`);
  }
  return key.padEnd(length, "_");
}

// The maximal entry: a 128-character name and a 512-byte url. A maximal entry contributes 1,219 bytes to a nonempty
// presented array, including its separator.
export function maximalEntry(i: number): [string, string] {
  return [shortcode(EMOJI_SHORTCODE_LIMIT, i), emojiUrl(EMOJI_URL_LIMIT, `${i}/`)];
}

// Exactly STATUS_EMOJIS_BYTES presented: 10 maximal entries and one of 8 characters at an 11-byte url
// (1 + 10 × 1,219 + 97). `over`: one more character in the last name.
export function statusAtCap(over = false): Pairs {
  return [...Array.from({ length: 10 }, (_, i) => maximalEntry(i)), [shortcode(over ? 9 : 8, 10), "http://a/bc"]];
}

// Exactly ACCOUNT_EMOJIS_BYTES presented: 4 maximal entries, one of 90 characters at a 512-byte url and one of 1
// character at 'http://a/' (1 + 4 × 1,219 + 1,181 + 86). `over`: one more character in the 90-character name.
export function accountAtCap(over = false): Pairs {
  return [
    ...Array.from({ length: 4 }, (_, i) => maximalEntry(i)),
    [shortcode(over ? 91 : 90, 4), emojiUrl(EMOJI_URL_LIMIT, "4/")],
    ["z", "http://a/"],
  ];
}

// Exactly STATUS_EMOJIS_BYTES presented with the shortest names: 11 one-character names at 512-byte urls and one
// two-character name at a 103-byte url (1 + 11 × 1,092 + 275); `over`: a three-character one. The names a poll's
// choices can reference with the fewest characters (the emoji-poll fill of test/status-bounds.test.ts).
export function statusShortNames(over = false): Pairs {
  return [
    ...Array.from({ length: 11 }, (_, i): [string, string] => ["abcdefghijk"[i]!, emojiUrl(EMOJI_URL_LIMIT, `${i}/`)]),
    [over ? "lmn" : "lm", emojiUrl(103, "l/")],
  ];
}

// `pairs` as stored, padded with trailing JSON whitespace to exactly `bytes` UTF-8 bytes.
export function padded(pairs: Pairs, bytes: number): string {
  const text = JSON.stringify(pairs);
  if (text.length > bytes) {
    throw new Error("snapshot past its padding");
  }
  return text.padEnd(bytes, " ");
}

// `pairs` as stored, each name's characters written as \u escapes, then padded to exactly `bytes`.
export function escaped(pairs: Pairs, bytes: number): string {
  const text = `[${pairs
    .map(
      ([n, u]) =>
        `["${[...n].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}",${JSON.stringify(u)}]`,
    )
    .join(",")}]`;
  if (text.length > bytes) {
    throw new Error("snapshot past its padding");
  }
  return text.padEnd(bytes, " ");
}

// The stored values at the full cap of each column: what reads the most bytes from SQLite (a valid snapshot padded).
export const STATUS_EMOJIS_FULL = padded(statusAtCap(), STATUS_EMOJIS_BYTES);
export const ACCOUNT_EMOJIS_FULL = padded(accountAtCap(), ACCOUNT_EMOJIS_BYTES);
