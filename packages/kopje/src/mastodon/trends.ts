import {
  TREND_LINKS_LIMIT,
  TREND_LINKS_MAX_LIMIT,
  TREND_STATUSES_LIMIT,
  TREND_STATUSES_MAX_LIMIT,
  TREND_TAGS_LIMIT,
  TREND_TAGS_MAX_LIMIT,
} from "../domain/trends";
import {
  type ApiContext,
  type ApiHandler,
  authorized,
  optionalTokenCredential,
  present,
  requestParams,
  storeCall,
} from "./context";
import { LANGUAGES } from "./languages";
import { limitParam, offsetParam, type Params } from "./params";

// Trends (Mastodon 4.5's Api::V1::Trends::TagsController, StatusesController and LinksController; domain/trends.ts):
// the allowed trending hashtags, statuses and links, paged by offset.

// What Accept-Language is read of (RES-2), in code units.
const ACCEPT_LANGUAGE_UNITS = 1024;
const ISO_639_1 = new Set(LANGUAGES.map((l) => l.code));

// The preferred language of `header` (Accept-Language): the tag of the highest q-value (the earlier on a tie) whose
// primary subtag is an ISO 639-1 code, as that code; `en` when there is none (Mastodon's default locale).
export function preferredLanguage(header: string | undefined): string {
  const ranked = (header ?? "")
    .slice(0, ACCEPT_LANGUAGE_UNITS)
    .split(",")
    .map((part, index) => {
      const [tag = "", ...parameters] = part.trim().split(";");
      // RFC 9110 qvalue: 0 to 1 with at most three decimals; a q parameter of any other form drops the tag.
      const q = parameters.find((p) => /^\s*q\s*=/i.test(p));
      const value = q === undefined ? "1" : /^\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/i.exec(q)?.[1];
      return { code: tag.trim().split("-")[0]!.toLowerCase(), q: value === undefined ? 0 : Number(value), index };
    })
    .filter((entry) => entry.q > 0 && ISO_639_1.has(entry.code))
    .sort((a, b) => b.q - a.q || a.index - b.index);
  return ranked[0]?.code ?? "en";
}

// The Link header of an offset page (Api::V1::Trends::*Controller#next_path, #prev_path; pagination_params keeps
// `limit` only when sent): next at `next` when given, prev at offset - limit when offset is past limit, both at the
// canonical route.
function offsetLink(c: ApiContext, p: Params, route: string, offset: number, limit: number, next: number | null) {
  const url = (at: number) => {
    const target = new URL(route, c.req.url);
    if (p.get("limit") !== undefined) {
      target.searchParams.set("limit", String(limit));
    }
    target.searchParams.set("offset", String(at));
    return target.toString();
  };
  const links = [
    ...(next === null ? [] : [`<${url(next)}>; rel="next"`]),
    ...(offset > limit ? [`<${url(offset - limit)}>; rel="prev"`] : []),
  ];
  if (links.length > 0) {
    c.header("Link", links.join(", "));
  }
}

// Without a token the answer may be cached by anyone for 15 seconds (cache_if_unauthenticated!), varying as the
// controller's vary_by.
function listResponse(c: ApiContext, items: unknown[], anonymous: boolean, vary: string): Response {
  return anonymous
    ? c.json(items, 200, {
        "cache-control": "public, max-age=15, stale-while-revalidate=30, stale-if-error=86400",
        vary,
      })
    : c.json(items);
}

// GET /api/v1/trends/tags and GET /api/v1/trends (its alias), and GET /api/v1/admin/trends/tags for an admin without
// manage_taxonomies (`super`).
export const trendTags: ApiHandler = async (c, deps) => {
  const p = await requestParams(c, deps);
  if (p instanceof Response) {
    return p;
  }
  const credential = optionalTokenCredential(c, deps);
  const offset = offsetParam(p);
  const limit = limitParam(p, TREND_TAGS_LIMIT, TREND_TAGS_MAX_LIMIT);
  const input = { credential, offset, limit, now: deps.now(), present: present(c) };
  const page = authorized(await storeCall(c, deps, (s, b) => s.trendingTags(b, input)));
  if (limit > 0) {
    offsetLink(c, p, "/api/v1/trends/tags", offset, limit, page.read === limit ? offset + limit : null);
  }
  return listResponse(c, page.items, credential === null, "Authorization");
};

// GET /api/v1/trends/statuses, and GET /api/v1/admin/trends/statuses as trendTags. A page cut by its bytes continues
// after its last status (offset + consumed), so following next reaches every status once.
export const trendStatuses: ApiHandler = async (c, deps) => {
  const p = await requestParams(c, deps);
  if (p instanceof Response) {
    return p;
  }
  const credential = optionalTokenCredential(c, deps);
  const offset = offsetParam(p);
  const limit = limitParam(p, TREND_STATUSES_LIMIT, TREND_STATUSES_MAX_LIMIT);
  const language = preferredLanguage(c.req.header("accept-language"));
  const input = { credential, offset, limit, language, now: deps.now(), present: present(c) };
  const page = authorized(await storeCall(c, deps, (s, b) => s.trendingStatuses(b, input)));
  if (limit > 0) {
    const next = page.cut ? offset + page.consumed : page.read === limit ? offset + limit : null;
    offsetLink(c, p, "/api/v1/trends/statuses", offset, limit, next);
  }
  return listResponse(c, page.items, credential === null, "Authorization, Accept-Language");
};

// GET /api/v1/trends/links, and GET /api/v1/admin/trends/links as trendTags: the allowed trending links, the
// Accept-Language language first.
export const trendLinks: ApiHandler = async (c, deps) => {
  const p = await requestParams(c, deps);
  if (p instanceof Response) {
    return p;
  }
  const credential = optionalTokenCredential(c, deps);
  const offset = offsetParam(p);
  const limit = limitParam(p, TREND_LINKS_LIMIT, TREND_LINKS_MAX_LIMIT);
  const language = preferredLanguage(c.req.header("accept-language"));
  const input = { credential, offset, limit, language, now: deps.now(), present: present(c) };
  const page = authorized(await storeCall(c, deps, (s, b) => s.trendingLinks(b, input)));
  if (limit > 0) {
    offsetLink(c, p, "/api/v1/trends/links", offset, limit, page.read === limit ? offset + limit : null);
  }
  // vary_by 'Authorization, Accept-Language' (links_controller.rb:4) holds for a signed-in answer too.
  if (credential !== null) {
    c.header("Vary", "Authorization, Accept-Language");
  }
  return listResponse(c, page.items, credential === null, "Authorization, Accept-Language");
};
