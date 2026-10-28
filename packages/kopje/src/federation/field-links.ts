import { FIELD_LINK_HOLD_MS, type FieldLinksClaim, type FieldLinksFence } from "../domain/field-links";
import { DeadlinePassed, inTime } from "../platform/deadline";
import { outputMaxUnits, SCAN_LIMITS, type ScanLimits } from "../platform/html-scan";
import { PACKAGE_VERSION } from "../platform/package-version";
import { callStore, type StoreStub } from "../platform/store-client";
import { LOCAL_FIELDS, REMOTE_VERIFIED_SHOWN } from "../platform/stored-bounds";
import type { InboxDeps } from "./inbox";
import { dnsCheckHost } from "./loader";
import {
  admittedHops,
  fetchWebPage,
  probeRedirect,
  REDIRECT_PROBE_TIMEOUT_MS,
  WEB_PAGE_MAX_REDIRECTS,
  WEB_PAGE_PAIR_MAX_STORE_CALLS,
  WEB_PAGE_PAIR_MAX_SUBREQUESTS,
  WEB_PAGE_TIMEOUT_MS,
  type WebPageBudget,
  type WebPageDeps,
  type WebPageFailure,
} from "./web-page";

// The Worker's part of verifying profile links, of local accounts (domain/field-links.ts) and of remote ones
// (domain/remote-field-links.ts) in one round (Mastodon's VerifyLinkService, app/services/verify_link_service.rb,
// v4.5.11), a caller of the web-page sink (federation/web-page.ts, NET-3). The cron runs one round per tick,
// outside maintenance, independently of its other work (jobs/scheduled.ts scheduledFieldLinks); nothing else does (a
// save or an actor's store only arms a check). A round:
//   1. claims one due account (claimFieldLinks: a local one first), with the link back its claim returns (a local
//      account's https://<domain>/@<username>, a remote one's profile URL or actor id) and its candidate values (at
//      most LOCAL_FIELDS, which REMOTE_VERIFIED_SHOWN equals);
//   2. for each value in order: GETs it through the sink (Accept text/html, at most 3 redirects to any origin, 200
//      text/html or application/xhtml+xml only, a 1 MiB prefix, scanned for rel=me only); verified when an <a> or
//      <link> with the rel token "me" has an href equal to the link back ASCII case-insensitively (Mastodon's
//      href.downcase == link_back.downcase, :31); else, when the first such element has an href, HEADs it without
//      following and verifies when the raw Location is exactly the link back, whatever the status (:36, :40-48);
//      then records the outcome under the claim's fence (recordFieldLink), verified or not, so no later claim of the
//      same save checks the value again, and stops at once when the fence is lost; a value whose check ran out of the
//      round's budget or deadline, or whose domain policy could not be read, is unchecked and records nothing;
//   3. finishes the claim (finishFieldLinks), which schedules a next check while a candidate is left.
// Every hop's domain policy is a Store write, read before and after its DNS check (web-page.ts admittedHops), so no
// redirect, DNS check or request starts once maintenance is entered.
// Bounds (RES-6): the whole round, its finish included, ends within FIELD_LINK_ROUND_MS. All values share
// FIELD_LINK_SUBREQUESTS (each value's GET and HEAD at their ceilings: DNS checks included) and FIELD_LINK_STORE_CALLS
// pre-DNS domain-policy reads, charged by the sink, and make at most FIELD_LINK_ADMISSIONS post-DNS admissions (one
// per hop), within the checks' deadline, FIELD_LINK_FINISH_MS before the round's, which keeps that time for the
// finish. The round's own Store calls are one claim, at most LOCAL_FIELDS records (each within the checks' deadline)
// and one finish (within the round's), each started only before its deadline, given up at it, and its result not
// used when it arrives at or past it. The scan collects rel=me hrefs, the title and lang only
// (FIELD_LINK_SCAN): FIELD_LINK_OUTPUT_MAX_UNITS UTF-16 code units at most. Logs carry the event, the sink's failure
// kind and reason, and the hostname only.

export const FIELD_LINK_ROUND_MS = 60_000;
export const FIELD_LINK_FINISH_MS = 10_000;
export const FIELD_LINK_CHECKS_MS = FIELD_LINK_ROUND_MS - FIELD_LINK_FINISH_MS;
// A claim must outlast the round that holds it: twice its worst case.
if (FIELD_LINK_HOLD_MS < 2 * FIELD_LINK_ROUND_MS) {
  throw new Error("FIELD_LINK_HOLD_MS must be at least twice a field link round");
}
// One value's check at its ceiling (the GET, then the HEAD) fits the checks window, so a round whose claim answers
// with that much and a record left before the checks deadline checks at least one value, and a save's values are all
// checked within LOCAL_FIELDS such claims (domain/field-links.ts). A claim answering later leaves its values due
// again after the hold.
if (WEB_PAGE_TIMEOUT_MS + REDIRECT_PROBE_TIMEOUT_MS >= FIELD_LINK_CHECKS_MS) {
  throw new Error("a field link check at its ceiling must fit the checks' window");
}
// The budgets below are per LOCAL_FIELDS values; a remote claim's values are at most REMOTE_VERIFIED_SHOWN.
if (REMOTE_VERIFIED_SHOWN > LOCAL_FIELDS) {
  throw new Error("REMOTE_VERIFIED_SHOWN must not pass LOCAL_FIELDS");
}
export const FIELD_LINK_SUBREQUESTS = LOCAL_FIELDS * WEB_PAGE_PAIR_MAX_SUBREQUESTS;
export const FIELD_LINK_STORE_CALLS = LOCAL_FIELDS * WEB_PAGE_PAIR_MAX_STORE_CALLS;
// Post-DNS admissions: one per hop, each value's GET hops and its HEAD.
export const FIELD_LINK_ADMISSIONS = LOCAL_FIELDS * (WEB_PAGE_MAX_REDIRECTS + 2);
export const FIELD_LINK_SCAN: Partial<ScanLimits> = Object.freeze({ links: 0, metas: 0, jsonLd: 0 });
export const FIELD_LINK_OUTPUT_MAX_UNITS = outputMaxUnits({ ...SCAN_LIMITS, ...FIELD_LINK_SCAN });

type Sink = { fetchWebPage: typeof fetchWebPage; probeRedirect: typeof probeRedirect };

export type FieldLinksDeps = InboxDeps & {
  // Tests only: a sink over a scanner that holds a scan (federation/web-page.ts createWebPageSink).
  sink?: Sink;
};

export type FieldLinksRound = {
  claimed: boolean;
  // The claim's account: a local one, a remote one (fields of remote profiles, domain/remote-field-links.ts), or none.
  target: "local" | "remote" | null;
  expired: number;
  verified: number;
  unchecked: number;
  finished: boolean;
  givenUp: number;
};

type Outcome = "verified" | "unverified" | "unchecked";

const asciiLower = (value: string) => value.replace(/[A-Z]+/g, (upper) => upper.toLowerCase());

function logged(failure: WebPageFailure, step: "get" | "head"): void {
  console.log({
    event: "kopje.field_links.unverified",
    step,
    kind: failure.kind,
    reason: failure.reason ?? null,
    host: failure.host,
  });
}

// One value's check within the round's `budget` (its deadline the round's), its hops admitted by `admission` (one per
// value: a policy RPC error at any hop of its GET or HEAD leaves it unchecked).
async function checkLink(
  sink: Sink,
  value: string,
  linkBack: string,
  web: WebPageDeps,
  budget: WebPageBudget,
  admissionFailed: () => boolean,
): Promise<Outcome> {
  const spent = (failure: WebPageFailure): Outcome =>
    admissionFailed() || failure.kind === "budget" || (failure.kind === "timeout" && web.now() >= budget.deadline)
      ? "unchecked"
      : "unverified";
  const page = await sink.fetchWebPage(value, web, { budget, scan: FIELD_LINK_SCAN });
  if (!page.ok) {
    logged(page, "get");
    return spent(page);
  }
  const back = asciiLower(linkBack);
  if (page.scan.relMe.some((href) => href !== null && asciiLower(href) === back)) {
    return "verified";
  }
  const first = page.scan.relMe[0];
  if (first === undefined || first === null) {
    return "unverified";
  }
  const probe = await sink.probeRedirect(first, web, { budget });
  if (!probe.ok) {
    logged(probe, "head");
    return spent(probe);
  }
  return probe.location === linkBack ? "verified" : "unverified";
}

// One round (above). A Store refusal (maintenance) surfaces as StoreUnavailableError: the claim, open, is claimed
// again after its hold. Returns what it did, for the logs and tests.
export async function fieldLinksRound(env: Env, deps: FieldLinksDeps): Promise<FieldLinksRound> {
  const build = deps.build(env);
  const rpc = <T>(call: (store: StoreStub) => Promise<T>) => callStore(() => call(deps.store(env)));
  const start = deps.now();
  const end = start + FIELD_LINK_ROUND_MS;
  const deadline = start + FIELD_LINK_CHECKS_MS;
  const round: FieldLinksRound = {
    claimed: false,
    target: null,
    expired: 0,
    verified: 0,
    unchecked: 0,
    finished: false,
    givenUp: 0,
  };
  // The RPC stub types a union of results as a union of promises: the operation's own type is restored.
  const claim: FieldLinksClaim = await inTime(
    () => rpc((s) => s.claimFieldLinks(build, { now: deps.now() }) as Promise<FieldLinksClaim>),
    deadline,
    deps.now,
  );
  round.givenUp = claim.givenUp;
  round.expired = claim.expired;
  if (claim.givenUp > 0 || claim.expired > 0) {
    console.log({ event: "kopje.field_links.given_up", accounts: claim.givenUp, expired: claim.expired });
  }
  if (claim.kind !== "claimed") {
    return round;
  }
  round.claimed = true;
  round.target = claim.target;
  const fence: FieldLinksFence =
    claim.target === "local"
      ? { target: "local", accountId: claim.accountId, token: claim.token, epoch: claim.epoch }
      : { target: "remote", accountId: claim.accountId, token: claim.token, generation: claim.generation };
  const dns = deps.loader.checkHost ?? dnsCheckHost;
  // The instance's origin, never the link back's (a remote claim's is the remote profile).
  const userAgent = `Kopje/${PACKAGE_VERSION} (+${claim.origin}/)`;
  const budget: WebPageBudget = { subrequests: FIELD_LINK_SUBREQUESTS, storeCalls: FIELD_LINK_STORE_CALLS, deadline };
  const sink = deps.sink ?? { fetchWebPage, probeRedirect };
  let unchecked = 0;
  for (const [i, value] of claim.values.entries()) {
    if (deps.now() >= deadline) {
      unchecked += claim.values.length - i;
      break;
    }
    const admission = admittedHops((host) => rpc((s) => s.webHopRefused(build, { host })), dns);
    const web: WebPageDeps = { fetch: deps.loader.fetch, ...admission.web, userAgent, now: deps.now };
    const outcome = await checkLink(sink, value, claim.linkBack, web, budget, admission.failed);
    if (outcome === "unchecked") {
      unchecked++;
      continue;
    }
    let recorded: { held: boolean; recorded: boolean };
    try {
      recorded = await inTime(
        () =>
          rpc((s) => s.recordFieldLink(build, { ...fence, value, verified: outcome === "verified", now: deps.now() })),
        deadline,
        deps.now,
      );
    } catch (error) {
      if (!(error instanceof DeadlinePassed)) {
        throw error;
      }
      // The record may still land: the values left without a durable record (the rest, and this one unless its
      // record lands) stay due, checked after the hold.
      unchecked += claim.values.length - i;
      break;
    }
    if (!recorded.held) {
      return round;
    }
    round.verified += recorded.recorded ? 1 : 0;
  }
  round.unchecked = unchecked;
  const finished = await inTime(
    () => rpc((s) => s.finishFieldLinks(build, { ...fence, now: deps.now() })),
    end,
    deps.now,
  );
  round.finished = finished.held;
  return round;
}
