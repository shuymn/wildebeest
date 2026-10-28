import {
  CARD_HOLD_MS,
  CARD_ROUND_CLAIMS,
  type CardClaim,
  type CardClaims,
  type CardEndpoint,
  type CardFields,
  type CardOutcome,
  cardHost,
  storedCardText,
} from "../domain/link-cards";
import { DeadlinePassed, inTime } from "../platform/deadline";
import { errorFields } from "../platform/error-message";
import { PACKAGE_VERSION } from "../platform/package-version";
import { railsBlank } from "../platform/rails-blank";
import { callStore, type StoreStub } from "../platform/store-client";
import {
  CARD_IMAGE_DESCRIPTION_JSON_BYTES,
  CARD_OPTIONAL_URL_LIMIT,
  CARD_TEXTS,
  CARD_URL_LIMIT,
} from "../platform/stored-bounds";
import { discoverOembed, expandTemplate, oembedCard, oembedTemplate } from "./card-oembed";
import type { InboxDeps } from "./inbox";
import { CARD_SCAN, linkDetails } from "./link-details";
import { dnsCheckHost } from "./loader";
import {
  admittedHops,
  fetchWebJson,
  fetchWebPage,
  WEB_JSON_BODY_LIMIT,
  WEB_PAGE_MAX_REDIRECTS,
  WEB_PAGE_MAX_STORE_CALLS,
  WEB_PAGE_MAX_SUBREQUESTS,
  WEB_PAGE_TIMEOUT_MS,
  type WebJson,
  type WebPage,
  type WebPageBudget,
  type WebPageDeps,
  type WebPageFailure,
  webPageUrlRefusal,
} from "./web-page";

// The Worker's part of status cards (domain/link-cards.ts; Mastodon's LinkCrawlWorker and FetchLinkCardService,
// v4.5.11), a caller of the web-page sink (federation/web-page.ts, NET-3). The cron runs one round per tick,
// outside the env's maintenance, on its own (jobs/scheduled.ts scheduledLinkCards); nothing else fetches a card. A
// round:
//   1. claims at most CARD_ROUND_CLAIMS due rows (claimCards), each with its host's cached oEmbed template, within the
//      fetches' deadline;
//   2. fetches the claims, CARD_CONCURRENCY at a time, each in at most CARD_CHAINS GET chains through the sink (the
//      transitions below), then records the outcome under the claim's fence (recordCard), with the endpoint a cold
//      claim discovered, within the deadline, or an unattempted one within the round's end. A lost fence or an error
//      ends that claim alone;
//   3. releases the claims it did not start, one by one (unattempted), within the round's end.
// A page GET: Accept text/html, Accept-Language CARD_ACCEPT_LANGUAGE, the User-Agent Kopje/<version>
// (+https://<domain>/) Bot, at most 3 redirects, 200 text/html or application/xhtml+xml only, a 1 MiB prefix, scanned
// with CARD_SCAN; its OpenGraph fields (link-details.ts) are the card unless the title is blank. An endpoint GET: the
// sink's JSON mode (fetchWebJson: the same User-Agent and nothing else, any content type, a whole body of at most
// WEB_JSON_BODY_LIMIT bytes), its document mapped by card-oembed.ts oembedCard.
// The transitions, in order (T0-T20; Mastodon's attempt_oembed then attempt_opengraph,
// fetch_link_card_service.rb:39-43, 108-163; deviations in docs/mastodon-deviations.md, "Link previews"):
//   T0   a claim URL the sink refuses (webPageUrlRefusal: a port, an IP literal) is no card, before any network step;
//   T1   a cached template whose expansion passes (card-oembed.ts expandTemplate) makes the cached path: chain 1 the
//        endpoint, chain 2 the page for OpenGraph only, no further endpoint even if the page declares one (T16:
//        Mastodon fetches the cached endpoint again);
//   T2   any other cached row is ignored: the cold path, chain 1 the page, chain 2 the endpoint it declares (T18:
//        card-oembed.ts discoverOembed), if any;
//   T3-T15  an endpoint's answer: a card (oembedCard); a fallback to the page's OpenGraph for a non-200 (T4), an
//        unsupported encoding, invalid UTF-8 or JSON or an empty body (T5), a null root (T6), past the JSON caps (T8),
//        an invalid version or a blank type (T9), rich, a photo without a url or a blank title (T13); no card for
//        another root (T7), a body past WEB_JSON_BODY_LIMIT (T10), a transport failure (T11: network, a timeout before
//        the deadline, redirects, a refused or blocked hop), an unknown or non-string type (T14, T15);
//   T12  the shared budget, the deadline or a policy RPC error in either chain makes the claim unattempted;
//   T17  a page's outcomes: a card, none (no 200, not HTML, unparsable, a blank title (T19), a refused
//        host), or unattempted;
//   T20  a cold claim's endpoint, when URL_REGEX makes a template of it, is cached under the page's final host with
//        any held outcome; the cached path never writes.
// The page's scan is dropped once its fields (cut to their stored bounds), the endpoint and its template are taken,
// before chain 2; an endpoint's buffers are dropped before the cached path's page chain.
// Every hop's domain policy is admitted as a Store write before and after its DNS check (web-page.ts admittedHops,
// once per claim across both chains), so no redirect, DNS check or request starts once maintenance is entered.
// A policy RPC that fails at either point marks the claim: it is released unattempted, while a host the policy
// refuses is no card.
// Bounds (RES-6): the whole round ends within CARD_ROUND_MS, its fetches within CARD_FETCHES_MS (at most
// ceil(CARD_ROUND_CLAIMS / CARD_CONCURRENCY) × CARD_CHAINS sink calls of WEB_PAGE_TIMEOUT_MS each, checked below);
// the claims share CARD_SUBREQUESTS DNS and HTTP subrequests and CARD_STORE_CALLS pre-DNS policy reads, charged by
// the sink, and make at most CARD_ADMISSIONS post-DNS admissions (one per hop, at most WEB_PAGE_MAX_REDIRECTS + 1 per
// chain); the round's own Store calls are one claim and at most CARD_ROUND_CLAIMS records or releases
// (CARD_OWN_STORE_CALLS); memory, test/link-card-rounds.test.ts. Logs carry the event, the chain, the sink's failure
// kind and reason, and the hostname only.

export const CARD_ROUND_MS = 60_000;
export const CARD_FINISH_MS = 10_000;
export const CARD_FETCHES_MS = CARD_ROUND_MS - CARD_FINISH_MS;
export const CARD_CONCURRENCY = 3;
export const CARD_CHAINS = 2;
// A claim must outlast the round that holds it: twice its worst case.
if (CARD_HOLD_MS < 2 * CARD_ROUND_MS) {
  throw new Error("CARD_HOLD_MS must be at least twice a link card round");
}
// Every claim's chains, CARD_CONCURRENCY at a time, fit the fetches' window at the sink's timeout.
if (Math.ceil(CARD_ROUND_CLAIMS / CARD_CONCURRENCY) * CARD_CHAINS * WEB_PAGE_TIMEOUT_MS > CARD_FETCHES_MS) {
  throw new Error("a link card round's chains must fit CARD_FETCHES_MS");
}
export const CARD_SUBREQUESTS = CARD_ROUND_CLAIMS * CARD_CHAINS * WEB_PAGE_MAX_SUBREQUESTS;
export const CARD_STORE_CALLS = CARD_ROUND_CLAIMS * CARD_CHAINS * WEB_PAGE_MAX_STORE_CALLS;
export const CARD_ADMISSIONS = CARD_ROUND_CLAIMS * CARD_CHAINS * (WEB_PAGE_MAX_REDIRECTS + 1);
export const CARD_OWN_STORE_CALLS = 1 + CARD_ROUND_CLAIMS;
export const CARD_OEMBED_BODY_LIMIT = WEB_JSON_BODY_LIMIT;
// Mastodon's "#{I18n.default_locale}, *;q=0.5" (fetch_link_card_service.rb:48-52), at its default locale.
export const CARD_ACCEPT_LANGUAGE = "en, *;q=0.5";

export type LinkCardsDeps = InboxDeps & {
  // Tests only: the sink's GETs (federation/web-page.ts createWebPageSink, fetchWebJson).
  fetchWebPage?: typeof fetchWebPage;
  fetchWebJson?: typeof fetchWebJson;
};

export type LinkCardsRound = {
  claimed: number;
  attached: number;
  none: number;
  unattempted: number;
  released: number;
  lost: number;
};

// One claim's outcome, the failure and chain that decided it, and the endpoint a cold claim discovered.
type Fetched = {
  outcome: CardOutcome;
  failure?: WebPageFailure;
  chain?: "page" | "oembed";
  endpoint?: CardEndpoint;
};

// Whether a failed chain leaves the claim unattempted (T12): a policy RPC error, the shared budget, or a timeout once
// the fetches' deadline has passed.
function unattempted(failure: WebPageFailure, admissionFailed: boolean, spent: boolean): boolean {
  return admissionFailed || failure.kind === "budget" || (failure.kind === "timeout" && spent);
}

// The card's fields as the Store keeps them (domain/link-cards.ts recordCard applies the same cuts): what a cold claim
// retains of its page while its endpoint is fetched.
function storedFields(fields: CardFields): CardFields {
  const url = (value: string) => (value.length <= CARD_OPTIONAL_URL_LIMIT ? value : "");
  return {
    ...fields,
    title: storedCardText(fields.title, CARD_TEXTS.title),
    description: storedCardText(fields.description, CARD_TEXTS.description),
    authorName: storedCardText(fields.authorName, CARD_TEXTS.author_name),
    providerName: storedCardText(fields.providerName, CARD_TEXTS.provider_name),
    authorUrl: url(fields.authorUrl),
    providerUrl: url(fields.providerUrl),
    imageUrl: fields.imageUrl.length <= CARD_URL_LIMIT ? fields.imageUrl : "",
    imageDescription: storedCardText(fields.imageDescription, CARD_IMAGE_DESCRIPTION_JSON_BYTES),
    finalUrl: fields.finalUrl.length <= CARD_URL_LIMIT ? fields.finalUrl : "",
  };
}

// A page chain's outcome (T17, T19).
function pageOutcome(page: WebPage | WebPageFailure, admissionFailed: boolean, spent: boolean): Fetched {
  if (!page.ok) {
    const kind = unattempted(page, admissionFailed, spent) ? "unattempted" : "none";
    return { outcome: { kind }, failure: page, chain: "page" };
  }
  const fields = storedFields(linkDetails(page.scan, page.finalUrl));
  return { outcome: railsBlank(fields.title) ? { kind: "none" } : { kind: "card", fields }, chain: "page" };
}

// The sink's failures of an endpoint chain that fall back to the page (T4, T5, T8); the others are no card (T10, T11)
// or unattempted (T12).
const FALLBACK_FAILURES = new Set<WebPageFailure["kind"]>(["status", "encoding", "unparsable"]);

// An endpoint chain's outcome (T3-T15), or null for a fallback to the page's OpenGraph. A card's final URL is
// `finalUrl` (its trend identity, migration 0071_link_trends): the cold path's page after redirects, or the claim URL
// on the cached path, which fetched no page.
function endpointOutcome(
  answer: WebJson | WebPageFailure,
  endpoint: string,
  finalUrl: string,
  admissionFailed: boolean,
  spent: boolean,
): Fetched | null {
  if (!answer.ok) {
    if (unattempted(answer, admissionFailed, spent)) {
      return { outcome: { kind: "unattempted" }, failure: answer, chain: "oembed" };
    }
    return FALLBACK_FAILURES.has(answer.kind) ? null : { outcome: { kind: "none" }, failure: answer, chain: "oembed" };
  }
  const mapped = oembedCard(answer.value, endpoint);
  if (mapped.kind === "fallback") {
    return null;
  }
  return {
    outcome: mapped.kind === "card" ? { kind: "card", fields: { ...mapped.fields, finalUrl } } : mapped,
    chain: "oembed",
  };
}

// One round (above). Returns what it did, for the logs and tests.
export async function linkCardsRound(env: Env, deps: LinkCardsDeps): Promise<LinkCardsRound> {
  const build = deps.build(env);
  const rpc = <T>(call: (store: StoreStub) => Promise<T>) => callStore(() => call(deps.store(env)));
  const start = deps.now();
  const end = start + CARD_ROUND_MS;
  const deadline = start + CARD_FETCHES_MS;
  const round: LinkCardsRound = { claimed: 0, attached: 0, none: 0, unattempted: 0, released: 0, lost: 0 };
  const claimed = await inTime(
    () => rpc((s) => s.claimCards(build, { now: deps.now() }) as Promise<CardClaims>),
    deadline,
    deps.now,
  );
  if (claimed.expired > 0 || claimed.givenUp > 0) {
    console.log({ event: "kopje.link_cards.dropped", expired: claimed.expired, givenUp: claimed.givenUp });
  }
  if (claimed.domain === null || claimed.claims.length === 0) {
    return round;
  }
  round.claimed = claimed.claims.length;
  const budget: WebPageBudget = { subrequests: CARD_SUBREQUESTS, storeCalls: CARD_STORE_CALLS, deadline };
  const get = deps.fetchWebPage ?? fetchWebPage;
  const getJson = deps.fetchWebJson ?? fetchWebJson;
  const dns = deps.loader.checkHost ?? dnsCheckHost;
  const userAgent = `Kopje/${PACKAGE_VERSION} (+https://${claimed.domain}/) Bot`;
  const record = (claim: CardClaim, outcome: CardOutcome, until: number, endpoint?: CardEndpoint) =>
    inTime(
      () =>
        rpc((s) =>
          s.recordCard(build, {
            statusId: claim.statusId,
            token: claim.token,
            generation: claim.generation,
            outcome,
            ...(endpoint === undefined ? {} : { endpoint }),
            now: deps.now(),
          }),
        ),
      until,
      deps.now,
    );

  const fetchCard = async (claim: CardClaim): Promise<Fetched> => {
    // T0: before any network or cache work.
    if (webPageUrlRefusal(claim.url) !== null) {
      return { outcome: { kind: "none" } };
    }
    // One admission for both chains, so a policy RPC error in either marks the claim.
    const admission = admittedHops((host) => rpc((s) => s.webHopRefused(build, { host })), dns);
    const web: WebPageDeps = { fetch: deps.loader.fetch, ...admission.web, userAgent, now: deps.now };
    const spent = () => deps.now() >= deadline;
    const page = async () =>
      pageOutcome(
        await get(claim.url, web, { budget, scan: CARD_SCAN, acceptLanguage: CARD_ACCEPT_LANGUAGE }),
        admission.failed(),
        spent(),
      );
    const endpointChain = async (endpoint: string, finalUrl: string) =>
      endpointOutcome(await getJson(endpoint, web, { budget }), endpoint, finalUrl, admission.failed(), spent());
    // Chain 1 of the cold path: the page's outcome, the endpoint it declares (T18) and what the cache keeps of it
    // (T20); the scan is not retained.
    const coldPage = async (): Promise<{
      fetched: Fetched;
      endpoint: string | null;
      finalUrl: string;
      record?: CardEndpoint;
    }> => {
      const answer = await get(claim.url, web, { budget, scan: CARD_SCAN, acceptLanguage: CARD_ACCEPT_LANGUAGE });
      const fetched = pageOutcome(answer, admission.failed(), spent());
      if (!answer.ok) {
        return { fetched, endpoint: null, finalUrl: "" };
      }
      const endpoint = discoverOembed(answer.scan.links, answer.finalUrl);
      const host = cardHost(answer.finalUrl);
      const template = endpoint === null ? null : oembedTemplate(endpoint);
      const record = host === null || template === null ? undefined : { host, template };
      return { fetched, endpoint, finalUrl: answer.finalUrl, record };
    };
    // T1: the cached path, the endpoint first, then the page for OpenGraph only (T16).
    const cached = claim.oembed === null ? null : expandTemplate(claim.oembed, claim.url);
    if (cached !== null) {
      return (await endpointChain(cached, claim.url)) ?? (await page());
    }
    // T2: the cold path, chain 2 only once chain 1's page is dropped.
    const cold = await coldPage();
    if (cold.endpoint === null) {
      return cold.fetched;
    }
    return { ...((await endpointChain(cold.endpoint, cold.finalUrl)) ?? cold.fetched), endpoint: cold.record };
  };

  const queue = [...claimed.claims];
  const worker = async () => {
    for (let claim = queue.shift(); claim !== undefined; claim = queue.shift()) {
      if (deps.now() >= deadline) {
        queue.unshift(claim);
        return;
      }
      try {
        const { outcome, failure, chain, endpoint } = await fetchCard(claim);
        if (failure !== undefined) {
          console.log({
            event: "kopje.link_cards.no_card",
            outcome: outcome.kind,
            chain: chain ?? "page",
            kind: failure.kind,
            reason: failure.reason ?? null,
            host: failure.host,
          });
        }
        // An unattempted claim (the deadline or the budget ran out during its fetch) is released within the finish
        // window, as the unstarted ones are; a fetched outcome only before the fetches' deadline.
        const recorded = await record(claim, outcome, outcome.kind === "unattempted" ? end : deadline, endpoint);
        if (!recorded.held) {
          round.lost++;
        } else {
          round[outcome.kind === "card" ? "attached" : outcome.kind]++;
        }
      } catch (error) {
        // The claim stays open and is claimed again after its hold; the others go on.
        round.lost++;
        if (!(error instanceof DeadlinePassed)) {
          console.error({ event: "kopje.link_cards.claim_failed", ...errorFields(error) });
        }
      }
    }
  };
  await Promise.all(Array.from({ length: CARD_CONCURRENCY }, worker));
  for (const claim of queue) {
    try {
      if ((await record(claim, { kind: "unattempted" }, end)).held) {
        round.released++;
      }
    } catch (error) {
      if (!(error instanceof DeadlinePassed)) {
        console.error({ event: "kopje.link_cards.release_failed", ...errorFields(error) });
      }
      break;
    }
  }
  return round;
}
