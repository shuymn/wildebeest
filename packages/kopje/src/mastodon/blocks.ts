import { blockedDomain } from "../platform/domain-name";
import { relationshipResponse } from "./accounts";
import {
  type ApiHandler,
  authorized,
  present,
  refuseAfterAuth,
  requestParams,
  storeCall,
  userCredential,
} from "./context";
import { mastodonError } from "./errors";
import { pageQuery, pageResponse } from "./pagination";
import { type Params, parseBoolean } from "./params";

// Blocks, mutes and domain blocks (Mastodon 4.5's AccountsController#block/#unblock/#mute/#unmute, BlocksController,
// MutesController, DomainBlocksController and DomainBlocks::PreviewsController); the Store does the work
// (domain/blocks.ts).

// block, unblock and unmute take only the account: each answers its Relationship.
function relation(call: "block" | "unblock" | "unmute"): ApiHandler {
  return async (c, deps) => {
    const input = { credential: userCredential(c, deps), target: c.req.param("id") ?? "", now: deps.now() };
    return relationshipResponse(c, authorized(await storeCall(c, deps, (s, b) => s[call](b, input))));
  };
}

export const block = relation("block");
export const unblock = relation("unblock");
export const unmute = relation("unmute");

// The latest expiry a mute can have: ISO 8601 times compare as text only up to year 9999.
const MAX_EXPIRY = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

// When a mute of `duration` seconds expires, as Mastodon reads the parameter (`to_i`: an integer prefix, anything else
// 0): null for 0 (never); a negative duration has already expired, and a very long one ends at MAX_EXPIRY.
function muteExpiry(duration: string | undefined, now: number): string | null {
  const seconds = Number.parseInt(duration ?? "", 10);
  if (Number.isNaN(seconds) || seconds === 0) {
    return null;
  }
  return new Date(Math.min(Math.max(now + seconds * 1000, now), MAX_EXPIRY)).toISOString();
}

// notifications defaults to true (Account#mute!).
export const mute: ApiHandler = async (c, deps) => {
  const p = await requestParams(c, deps);
  if (p instanceof Response) {
    return p;
  }
  const now = deps.now();
  const input = {
    credential: userCredential(c, deps),
    target: c.req.param("id") ?? "",
    notifications: parseBoolean(p.get("notifications")) ?? true,
    expiresAt: muteExpiry(p.get("duration"), now),
    now,
  };
  return relationshipResponse(c, authorized(await storeCall(c, deps, (s, b) => s.mute(b, input))));
};

// GET /api/v1/blocks and /api/v1/mutes: the accounts, paged by Link headers.
function accounts(call: "listBlocks" | "listMutes"): ApiHandler {
  return async (c, deps) => {
    const p = await requestParams(c, deps);
    if (p instanceof Response) {
      return p;
    }
    const page = pageQuery(p);
    const input = { credential: userCredential(c, deps), page, present: present(c) };
    return pageResponse(c, authorized(await storeCall(c, deps, (s, b) => s[call](b, input))), page.limit);
  };
}

export const blocks = accounts("listBlocks");
export const mutes = accounts("listMutes");

// Mastodon's DomainBlocksController pages 100 domains by default and at most 200.
const DOMAIN_BLOCKS_LIMIT = 100;
const MAX_DOMAIN_BLOCKS_LIMIT = 200;

export const domainBlocks: ApiHandler = async (c, deps) => {
  const p = await requestParams(c, deps);
  if (p instanceof Response) {
    return p;
  }
  const page = pageQuery(p, DOMAIN_BLOCKS_LIMIT, MAX_DOMAIN_BLOCKS_LIMIT);
  const credential = userCredential(c, deps);
  const result = authorized(await storeCall(c, deps, (s, b) => s.listDomainBlocks(b, { credential, page })));
  return pageResponse(c, result, page.limit);
};

// The `domain` parameter as a domain block stores it (`blockedDomain`); null when absent or not a domain name.
function domainParam(p: Params): { domain: string | null; blank: boolean } {
  const raw = (p.get("domain") ?? "").trim();
  return { domain: raw === "" ? null : blockedDomain(raw), blank: raw === "" };
}

export const blockDomain: ApiHandler = async (c, deps) => {
  const p = await requestParams(c, deps);
  if (p instanceof Response) {
    return p;
  }
  const { domain, blank } = domainParam(p);
  if (domain === null) {
    const problem = blank ? "Domain can't be blank" : "Domain is invalid";
    return refuseAfterAuth(c, deps, mastodonError(422, `Validation failed: ${problem}`));
  }
  const input = { credential: userCredential(c, deps), domain, now: deps.now() };
  const result = authorized(await storeCall(c, deps, (s, b) => s.blockDomain(b, input)));
  if (result.status === "local") {
    return mastodonError(422, "Validation failed: Domain is this server's own domain");
  }
  return c.json({});
};

// Unblocking a domain that is not blocked, or no domain at all, answers {} as Mastodon does.
export const unblockDomain: ApiHandler = async (c, deps) => {
  const p = await requestParams(c, deps);
  if (p instanceof Response) {
    return p;
  }
  const input = { credential: userCredential(c, deps), domain: domainParam(p).domain };
  authorized(await storeCall(c, deps, (s, b) => s.unblockDomain(b, input)));
  return c.json({});
};

export const previewDomainBlock: ApiHandler = async (c, deps) => {
  const p = await requestParams(c, deps);
  if (p instanceof Response) {
    return p;
  }
  const { domain, blank } = domainParam(p);
  if (blank) {
    return refuseAfterAuth(c, deps, mastodonError(400, "param is missing or the value is empty: domain"));
  }
  if (domain === null) {
    return refuseAfterAuth(c, deps, c.json({ following_count: 0, followers_count: 0 }));
  }
  const credential = userCredential(c, deps);
  return c.json(authorized(await storeCall(c, deps, (s, b) => s.previewDomainBlock(b, { credential, domain }))));
};
