import { decodeHTMLStrict } from "entities/decode";

import type { CardFields } from "../domain/link-cards";
import { TREND_LANGUAGES } from "../domain/trend-languages";
import { outputMaxUnits, type PageMeta, type PageScan, SCAN_LIMITS, type ScanLimits } from "../platform/html-scan";
import { httpUrl } from "../platform/http-url";
import { railsBlank } from "../platform/rails-blank";
import { CARD_URL_LIMIT, cardDimension, iframeDimension, presentedEmbedSrc } from "../platform/stored-bounds";

// A link card's fields from a scanned page (platform/html-scan.ts), as Mastodon's LinkDetailsExtractor reads them from
// OpenGraph, JSON-LD and the title (app/lib/link_details_extractor.rb, v4.5.11). Pure: the round (link-cards.ts) bounds
// and stores what it returns. Mastodon's rules kept:
//   - a chain of sources falls back only when a source is absent (Ruby's `||` on nil): an empty string stops it;
//   - a meta is the first whose property or name equals the key ASCII case-insensitively (opengraph_tag), or whose
//     name does (meta_tag), its content then; the texts are entity-decoded a second time (HTMLEntities, :317-319);
//   - JSON-LD: each script in order, CDATA lines removed (CDATA_JUNK_PATTERN), entity-decoded, parsed; the first
//     object of a supported @type (NewsArticle, WebPage) in the first script that holds one;
//   - URLs: blank, "null" and "undefined" refused before they are resolved against the page (valid_url_or_nil);
//   - a language matched exactly first, its region stripped only on a miss (valid_locale_or_nil);
//   - twitter:player (:135-157): a valid URL makes a video whose iframe src it is, when the src passes the stored
//     rule (stored-bounds.ts presentedEmbedSrc; else a link); twitter:player:width and :height are every card's
//     dimensions and the player's iframe dimensions;
//   - link_type (:139-145): an article when the supported JSON-LD object's @type is NewsArticle or the first og:type
//     is exactly article, whatever the card's type (a video may be an article);
//   - the image (:114-119, 171-177): og:image as a valid URL (cardImageSource: https only, a declared deviation), and
//     og:image:alt as the scan decoded it, its description ('' when absent; Mastodon decodes it no second time).
// Declared deviations (docs/mastodon-deviations.md, "Link previews"): a malformed JSON-LD shape (an @type lookup on an
// array or a number, a string author) is skipped where Mastodon raises or reads a substring; a value that is not a
// string reads as absent; JSON.parse replaces Oj; a meta value past the scan's bound reads as absent; the title is the
// first HTML <title> anywhere, not only head's; author_url is an absolute http(s) URL or ''; the dimensions are read
// strictly (cardDimension, iframeDimension); twitter:player:stream (embed_url) is not read.

// What the card's scan collects: the metas, the <link> elements (for an oEmbed endpoint, federation/card-oembed.ts; the
// canonical URL is not read), the JSON-LD scripts, the title and lang; no rel=me. At most CARD_OUTPUT_MAX_UNITS UTF-16
// code units of strings (test/link-details.test.ts recomputes it): html-scan.ts OUTPUT_MAX_UNITS less the rel=me term.
export const CARD_SCAN: Partial<ScanLimits> = Object.freeze({ relMe: 0 });
export const CARD_OUTPUT_MAX_UNITS = outputMaxUnits({ ...SCAN_LIMITS, ...CARD_SCAN });

// The card's fields (domain/link-cards.ts CardFields): decoded, the title stripped as Ruby's String#strip, the time in
// the 24-byte ISO form (Date#toISOString) or null.
export type LinkDetails = CardFields;

type Json = Record<string, unknown>;

const SUPPORTED_TYPES = new Set(["NewsArticle", "WebPage"]);
// CDATA_JUNK_PATTERN (:10-18): a line holding only a CDATA opening or closing in comment style. Ruby's ^ and $ match at
// line boundaries, and its \s* may span blank lines before it, as JavaScript's does with the m flag.
const CDATA_JUNK = /^\s*(?:\/\*\s*<!\[CDATA\[\s*\*\/|\/\/\s*<!\[CDATA\[|\/\*\s*\]\]>\s*\*\/|\/\/\s*\]\]>)\s*$/gm;
// Ruby's String#strip: NUL, tab, LF, VT, FF, CR and space at either end.
const RUBY_STRIP = /^[\0\t\n\v\f\r ]+|[\0\t\n\v\f\r ]+$/g;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

// HTMLEntities :expanded's decode (:317-319; htmlentities' Decoder): only references closed by a semicolon, a numeric
// one mapped straight to its code point (NUL, C1 and the rest, with no HTML5 replacement), a named one by its name. A
// surrogate or a code point past U+10FFFF, on which Ruby's Integer#chr raises, is kept as written (a declared
// deviation); the HTML5 entity table stands in for :expanded's.
const REFERENCE = /&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9.]*));/g;

export function decodeEntities(value: string): string {
  return value.replace(REFERENCE, (whole, decimal?: string, hex?: string) => {
    if (decimal === undefined && hex === undefined) {
      return decodeHTMLStrict(whole);
    }
    const point = decimal === undefined ? Number.parseInt(hex!, 16) : Number.parseInt(decimal, 10);
    return point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) ? whole : String.fromCodePoint(point);
  });
}

const decode = (value: string | null): string | null => (value === null ? null : decodeEntities(value));

// The first item of `value` that is an object, arrays flattened in order (first_of_hash, :95-97), else `value` itself
// when it is an object. Iterative: a parsed script may nest deeply.
function firstObject(value: unknown): Json | null {
  if (!Array.isArray(value)) {
    return isObject(value) ? value : null;
  }
  const stack: unknown[][] = [value];
  const at: number[] = [0];
  while (stack.length > 0) {
    const top = stack.length - 1;
    const list = stack[top]!;
    const i = at[top]!;
    if (i >= list.length) {
      stack.pop();
      at.pop();
      continue;
    }
    at[top] = i + 1;
    const item = list[i];
    if (Array.isArray(item)) {
      stack.push(item);
      at.push(0);
    } else if (isObject(item)) {
      return item;
    }
  }
  return null;
}

// The supported object of one script's text, or null (StructuredData#json and #valid?).
function structuredObject(raw: string): Json | null {
  const source = raw.replace(CDATA_JUNK, "");
  if (railsBlank(source)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeEntities(source));
  } catch {
    return null;
  }
  for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
    if (isObject(item) && typeof item["@type"] === "string" && SUPPORTED_TYPES.has(item["@type"])) {
      // An empty object is not `present?`, but a supported one holds @type.
      return item;
    }
  }
  return null;
}

type Structured = {
  type: string;
  headline: string | null;
  description: string | null;
  datePublished: string | null;
  language: string | null;
  authorName: string | null;
  authorUrl: string | null;
  publisherName: string | null;
};

// The first script's supported object (structured_data, :251-272), read for the fields used and then dropped.
function structuredData(scripts: readonly string[]): Structured | null {
  for (const raw of scripts) {
    const json = structuredObject(raw);
    if (json === null) {
      continue;
    }
    let language: unknown = json.inLanguage;
    if (Array.isArray(language)) {
      language = language[0];
    }
    if (isObject(language)) {
      language = language.alternateName ?? language.name;
    }
    const author = firstObject(json.author) ?? {};
    const name = author.name;
    return {
      type: json["@type"] as string,
      headline: text(json.headline),
      description: text(json.description),
      datePublished: text(json.datePublished),
      language: text(language),
      authorName: Array.isArray(name)
        ? name.every((part) => typeof part === "string")
          ? name.join(", ")
          : null
        : text(name),
      authorUrl: text(author.url),
      publisherName: text((firstObject(json.publisher) ?? {}).name),
    };
  }
  return null;
}

// The content of the first meta matching `key` (lowercased), or null: opengraph_tag by property or name, meta_tag by
// name only. A meta with no content, or one past the scan's bound, ends the lookup as Mastodon's nil does.
function metaContent(metas: readonly PageMeta[], key: string, byName = false): string | null {
  const meta = metas.find((m) => m.name === key || (!byName && m.property === key));
  return meta?.content ?? null;
}

// valid_url_or_nil (:227-237): an http(s) URL resolved against the page, or null.
export function validUrl(value: string | null, base: string): string | null {
  if (value === null || railsBlank(value) || value === "null" || value === "undefined") {
    return null;
  }
  try {
    const url = new URL(value, base);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "" ? url.href : null;
  } catch {
    return null;
  }
}

// A card image's source: an https URL within CARD_URL_LIMIT, else '' (Mastodon fetches http too; the stored rule,
// cardUrlPastSql, judges the rest at record).
export function cardImageSource(url: string | null): string {
  return url !== null && url.startsWith("https://") && url.length <= CARD_URL_LIMIT ? url : "";
}

// host_to_url (:221-225): a scheme added to a bare host.
function hostToUrl(value: string | null): string | null {
  if (value === null || railsBlank(value)) {
    return null;
  }
  return /^https?:\/\//.test(value) ? value : `http://${value}`;
}

// valid_locale_or_nil (languages_helper.rb:279-287) over TREND_LANGUAGES, Mastodon's SUPPORTED_LOCALES.
function validLocale(value: string | null): string | null {
  if (value === null || railsBlank(value)) {
    return null;
  }
  if (TREND_LANGUAGES.has(value)) {
    return value;
  }
  const code = value.split(/[_-]/)[0] ?? "";
  return TREND_LANGUAGES.has(code) ? code : null;
}

// An ISO 8601 date or date-time (RFC 3339 included) as Rails casts it to a time, in the 24-byte form; a time without
// an offset is UTC (Rails' default zone). Else null, an offset past 23 hours or 59 minutes included.
const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?$/;

export function publishedTime(value: string | null): string | null {
  const match = value === null ? null : ISO_DATE_TIME.exec(value.trim());
  if (match === null) {
    return null;
  }
  const [, year, month, day, hour = "00", minute = "00", second = "00", fraction = "", zone = "Z"] = match;
  const days = new Date(0);
  days.setUTCFullYear(Number(year), Number(month), 0);
  if (
    Number(month) < 1 ||
    Number(month) > 12 ||
    Number(day) < 1 ||
    Number(day) > days.getUTCDate() ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  ) {
    return null;
  }
  const [, sign, hours = "0", minutes = "0"] = /^([+-])(\d{2})(?::?(\d{2}))?$/.exec(zone) ?? [];
  if (Number(hours) > 23 || Number(minutes) > 59) {
    return null;
  }
  const offset = (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes));
  const at = new Date(0);
  at.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  at.setUTCHours(Number(hour), Number(minute), Number(second), Number(`${fraction.slice(1)}000`.slice(0, 3)));
  const time = at.getTime() - offset * 60_000;
  if (!Number.isFinite(time)) {
    return null;
  }
  const out = new Date(time).toISOString();
  return out.length === 24 ? out : null;
}

// The card's fields of `scan`, the page at `finalUrl` (the URL after redirects, which relative URLs resolve against,
// and the card's trend identity, which the Store judges by the stored URL rule). A title that is blank (Rails' blank?)
// means no card: the caller judges it.
export function linkDetails(scan: PageScan, finalUrl: string): LinkDetails {
  const metas = scan.metas;
  // Each key is a lowercase literal, as the scan lowercases the metas' property and name.
  const og = (key: string) => metaContent(metas, key);
  const sd = structuredData(scan.jsonLd);
  const title = decode(sd?.headline ?? og("og:title") ?? scan.title);
  const player = validUrl(og("twitter:player"), finalUrl);
  const src = player === null ? null : presentedEmbedSrc(player);
  const [width, height] = [og("twitter:player:width"), og("twitter:player:height")];
  return {
    title: title === null ? "" : title.replace(RUBY_STRIP, ""),
    description: decode(sd?.description ?? og("og:description") ?? metaContent(metas, "description", true)) ?? "",
    authorName: decode(sd?.authorName ?? og("og:author") ?? og("og:author:username")) ?? "",
    authorUrl: httpUrl(sd?.authorUrl ?? null)?.href ?? "",
    providerName: decode(sd?.publisherName ?? og("og:site_name")) ?? "",
    providerUrl: validUrl(hostToUrl(og("og:site")), finalUrl) ?? "",
    language: validLocale(sd?.language ?? og("og:locale") ?? scan.lang),
    publishedAt: publishedTime(sd?.datePublished ?? og("article:published_time")),
    type: src === null ? "link" : "video",
    width: cardDimension(width),
    height: cardDimension(height),
    embedSrc: src ?? "",
    iframeWidth: src === null ? null : iframeDimension(width),
    iframeHeight: src === null ? null : iframeDimension(height),
    imageUrl: cardImageSource(validUrl(og("og:image"), finalUrl)),
    imageDescription: og("og:image:alt") ?? "",
    linkType: sd?.type === "NewsArticle" || og("og:type") === "article" ? "article" : "unknown",
    finalUrl,
  };
}
