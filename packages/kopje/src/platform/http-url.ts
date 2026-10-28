import { hostDomain, normalizeDomain } from "./domain-name";
import { STATUS_URI_LIMIT } from "./identity-bounds";

// A stored URL as it may be emitted to clients and peers (HTML-3): parsed, absolute, and http: or https:, else null.
// Applied at the presenters, so imported and federated values are covered whatever was stored.
export function httpUrl(value: string | null): URL | null {
  if (value === null) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

// URL parsing has already normalized IPv4 forms like 0x7f.1 or 2130706433 to dotted quads.
const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

// NET-1's rules that need no lookup: https, no credentials, no literal IP, no local or single-label name. The rule a
// URL breaks, or null. Every outbound sink applies them (NET-3, federation/loader.ts, federation/web-page.ts), and so
// does Web Push registration before it stores an endpoint (PUSH-2).
export type PublicShapeViolation = "scheme" | "credentials" | "ip-literal" | "local-host";

export function publicShapeViolation(url: URL): PublicShapeViolation | null {
  if (url.protocol !== "https:") {
    return "scheme";
  }
  if (url.username !== "" || url.password !== "") {
    return "credentials";
  }
  const host = url.hostname;
  if (host.startsWith("[") || IPV4_LITERAL.test(host)) {
    return "ip-literal";
  }
  if (host === "localhost" || host.endsWith(".localhost") || !host.includes(".")) {
    return "local-host";
  }
  return null;
}

// The longest URL a web page sink hop requests (NET-3), in characters of its serialized ASCII form.
export const WEB_URL_LIMIT = 2048;

export type WebUrlRefusal = "invalid-url" | PublicShapeViolation | "port" | "trailing-dot" | "url-too-long";

// The URL a web page sink hop requests (federation/web-page.ts), its fragment removed, or the rule it breaks: NET-1's
// rules that need no lookup, the default port, no trailing dot, at most WEB_URL_LIMIT characters.
export function webUrl(input: string | URL): URL | WebUrlRefusal {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return "invalid-url";
  }
  url.hash = "";
  const violation = publicShapeViolation(url);
  if (violation !== null) {
    return violation;
  }
  if (url.port !== "") {
    return "port";
  }
  if (url.hostname.endsWith(".")) {
    return "trailing-dot";
  }
  return url.href.length > WEB_URL_LIMIT ? "url-too-long" : url;
}

// The rule a remote media URL breaks (NET-3): webUrl's, or the instance's own host `domain`; null when it is fetched.
// Shared by the fetch (federation/remote-file.ts) and the enqueue (domain/remote-media.ts), so nothing is enqueued
// that the fetch refuses.
export function remoteMediaUrlRefusal(input: string, domain: string): WebUrlRefusal | "own-host" | null {
  const url = webUrl(input);
  if (!(url instanceof URL)) {
    return url;
  }
  return hostDomain(url.href) === (normalizeDomain(domain) ?? domain) ? "own-host" : null;
}

// publicShapeViolation as a message, or null.
export function publicShapeRefusal(url: URL): string | null {
  switch (publicShapeViolation(url)) {
    case "scheme":
      return `Refused non-https URL: ${url.protocol}`;
    case "credentials":
      return "Refused URL with credentials";
    case "ip-literal":
      return `Refused literal IP host: ${url.hostname}`;
    case "local-host":
      return `Refused local host: ${url.hostname}`;
    case null:
      return null;
  }
}

// The serialized form of an http(s) URL when it is at most `limit` characters (a serialized URL is ASCII, so its
// length is its size in bytes), else null: a presented URL stays within its bound however it was derived or
// normalized (RES-2).
export function boundedHref(value: string | null, limit: number): string | null {
  const href = httpUrl(value)?.href ?? null;
  return href !== null && href.length <= limit ? href : null;
}

// The longest fetch target a Store answer prepares (store.ts, the rule): the longest identity fetched, a status uri, in
// serialized URL characters, which are ASCII bytes.
export const FETCH_TARGET_LIMIT = STATUS_URI_LIMIT;

// The serialized form of a URL the document loader would request (NET-1's shape, federation/loader.ts) within
// FETCH_TARGET_LIMIT, else null. Both the Worker's hint and the Store's preparation judge a target with it, so a
// target the loader refuses is never prepared for.
export function fetchableHref(value: string): string | null {
  const url = httpUrl(value);
  return url !== null && publicShapeViolation(url) === null && url.href.length <= FETCH_TARGET_LIMIT ? url.href : null;
}
