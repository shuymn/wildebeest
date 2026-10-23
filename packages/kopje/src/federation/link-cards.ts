import type { InboxDeps } from './inbox'
import { CARD_SCAN, linkDetails } from './link-details'
import { dnsCheckHost } from './loader'
import {
	admittedHops,
	fetchWebPage,
	WEB_PAGE_MAX_REDIRECTS,
	WEB_PAGE_MAX_STORE_CALLS,
	WEB_PAGE_MAX_SUBREQUESTS,
	type WebPage,
	type WebPageBudget,
	type WebPageDeps,
	type WebPageFailure,
	webPageUrlRefusal,
} from './web-page'
import {
	CARD_HOLD_MS,
	CARD_ROUND_CLAIMS,
	type CardClaim,
	type CardClaims,
	type CardOutcome,
} from '../domain/link-cards'
import { DeadlinePassed, inTime } from '../platform/deadline'
import { errorFields } from '../platform/error-message'
import { PACKAGE_VERSION } from '../platform/package-version'
import { railsBlank } from '../platform/rails-blank'
import { callStore, type StoreStub } from '../platform/store-client'

// The Worker's part of status cards (domain/link-cards.ts; Mastodon's LinkCrawlWorker and FetchLinkCardService,
// v4.5.11), the second caller of the web-page sink (federation/web-page.ts, NET-3). The cron runs one round per tick,
// outside the env's maintenance, on its own (jobs/scheduled.ts scheduledLinkCards); nothing else fetches a card. A
// round:
//   1. claims at most CARD_ROUND_CLAIMS due rows (claimCards), within the fetches' deadline;
//   2. fetches the claims, CARD_CONCURRENCY at a time: a URL the sink's rules refuse (webPageUrlRefusal: a port, an IP
//      literal) is no card before any network step; else a GET through the sink (Accept text/html, Accept-Language
//      CARD_ACCEPT_LANGUAGE, the User-Agent Kopje/<version> (+https://<domain>/) Bot, at most 3 redirects, 200
//      text/html or application/xhtml+xml only, a 1 MiB prefix, scanned with CARD_SCAN), whose page's fields
//      (link-details.ts) are the card unless its title is blank; then records the outcome under the claim's fence
//      (recordCard) within the deadline, or an unattempted one within the round's end. A lost fence or an error ends
//      that claim alone;
//   3. releases the claims it did not start, one by one (unattempted), within the round's end.
// Every hop's domain policy is admitted as a Store write before and after its DNS check (web-page.ts admittedHops), so
// no redirect, DNS check or request starts once maintenance is entered (AM4). A policy RPC that fails at either point
// marks the claim (AM20): it is released unattempted, while a host the policy refuses is no card.
// Outcomes: a card; none for every other failure (no 200, not HTML, unparsable, a blank title, a refused host);
// unattempted for the shared budget, the deadline and a policy RPC error.
// Bounds (RES-6): the whole round ends within CARD_ROUND_MS; the claims share CARD_SUBREQUESTS DNS and HTTP
// subrequests and CARD_STORE_CALLS pre-DNS policy reads, charged by the sink, and make at most CARD_ADMISSIONS
// post-DNS admissions (one per hop, at most WEB_PAGE_MAX_REDIRECTS + 1 per GET); the round's own Store calls are one
// claim and at most CARD_ROUND_CLAIMS records or releases (CARD_OWN_STORE_CALLS). Logs carry the event, the sink's
// failure kind and reason, and the hostname only.

export const CARD_ROUND_MS = 60_000
export const CARD_FINISH_MS = 10_000
export const CARD_FETCHES_MS = CARD_ROUND_MS - CARD_FINISH_MS
export const CARD_CONCURRENCY = 2
// A claim must outlast the round that holds it: twice its worst case.
if (CARD_HOLD_MS < 2 * CARD_ROUND_MS) {
	throw new Error('CARD_HOLD_MS must be at least twice a link card round')
}
export const CARD_SUBREQUESTS = CARD_ROUND_CLAIMS * WEB_PAGE_MAX_SUBREQUESTS
export const CARD_STORE_CALLS = CARD_ROUND_CLAIMS * WEB_PAGE_MAX_STORE_CALLS
export const CARD_ADMISSIONS = CARD_ROUND_CLAIMS * (WEB_PAGE_MAX_REDIRECTS + 1)
export const CARD_OWN_STORE_CALLS = 1 + CARD_ROUND_CLAIMS
// Mastodon's "#{I18n.default_locale}, *;q=0.5" (fetch_link_card_service.rb:48-52), at its default locale.
export const CARD_ACCEPT_LANGUAGE = 'en, *;q=0.5'

export type LinkCardsDeps = InboxDeps & {
	// Tests only: the sink's GET (federation/web-page.ts createWebPageSink).
	fetchWebPage?: typeof fetchWebPage
}

export type LinkCardsRound = {
	claimed: number
	attached: number
	none: number
	unattempted: number
	released: number
	lost: number
}

// One claim's GET of a page, mapped to its outcome.
type Fetched = { outcome: CardOutcome; failure?: WebPageFailure }

function outcomeOf(page: WebPage | WebPageFailure, admissionFailed: boolean, spent: boolean): Fetched {
	if (!page.ok) {
		const unattempted = admissionFailed || page.kind === 'budget' || (page.kind === 'timeout' && spent)
		return { outcome: { kind: unattempted ? 'unattempted' : 'none' }, failure: page }
	}
	const fields = linkDetails(page.scan, page.finalUrl)
	return { outcome: railsBlank(fields.title) ? { kind: 'none' } : { kind: 'card', fields } }
}

// One round (above). Returns what it did, for the logs and tests.
export async function linkCardsRound(env: Env, deps: LinkCardsDeps): Promise<LinkCardsRound> {
	const build = deps.build(env)
	const rpc = <T>(call: (store: StoreStub) => Promise<T>) => callStore(() => call(deps.store(env)))
	const start = deps.now()
	const end = start + CARD_ROUND_MS
	const deadline = start + CARD_FETCHES_MS
	const round: LinkCardsRound = { claimed: 0, attached: 0, none: 0, unattempted: 0, released: 0, lost: 0 }
	const claimed = await inTime(
		() => rpc((s) => s.claimCards(build, { now: deps.now() }) as Promise<CardClaims>),
		deadline,
		deps.now
	)
	if (claimed.expired > 0 || claimed.givenUp > 0) {
		console.log({ event: 'kopje.link_cards.dropped', expired: claimed.expired, givenUp: claimed.givenUp })
	}
	if (claimed.domain === null || claimed.claims.length === 0) {
		return round
	}
	round.claimed = claimed.claims.length
	const budget: WebPageBudget = { subrequests: CARD_SUBREQUESTS, storeCalls: CARD_STORE_CALLS, deadline }
	const get = deps.fetchWebPage ?? fetchWebPage
	const dns = deps.loader.checkHost ?? dnsCheckHost
	const userAgent = `Kopje/${PACKAGE_VERSION} (+https://${claimed.domain}/) Bot`
	const record = (claim: CardClaim, outcome: CardOutcome, until: number) =>
		inTime(
			() =>
				rpc((s) =>
					s.recordCard(build, {
						statusId: claim.statusId,
						token: claim.token,
						generation: claim.generation,
						outcome,
						now: deps.now(),
					})
				),
			until,
			deps.now
		)

	const fetchCard = async (claim: CardClaim): Promise<Fetched> => {
		if (webPageUrlRefusal(claim.url) !== null) {
			return { outcome: { kind: 'none' } }
		}
		const admission = admittedHops((host) => rpc((s) => s.webHopRefused(build, { host })), dns)
		const web: WebPageDeps = { fetch: deps.loader.fetch, ...admission.web, userAgent, now: deps.now }
		const page = await get(claim.url, web, { budget, scan: CARD_SCAN, acceptLanguage: CARD_ACCEPT_LANGUAGE })
		return outcomeOf(page, admission.failed(), deps.now() >= deadline)
	}

	const queue = [...claimed.claims]
	const worker = async () => {
		for (let claim = queue.shift(); claim !== undefined; claim = queue.shift()) {
			if (deps.now() >= deadline) {
				queue.unshift(claim)
				return
			}
			try {
				const { outcome, failure } = await fetchCard(claim)
				if (failure !== undefined) {
					console.log({
						event: 'kopje.link_cards.no_card',
						outcome: outcome.kind,
						kind: failure.kind,
						reason: failure.reason ?? null,
						host: failure.host,
					})
				}
				// An unattempted claim (the deadline or the budget ran out during its fetch) is released within the finish
				// window, as the unstarted ones are; a fetched outcome only before the fetches' deadline.
				const recorded = await record(claim, outcome, outcome.kind === 'unattempted' ? end : deadline)
				if (!recorded.held) {
					round.lost++
				} else {
					round[outcome.kind === 'card' ? 'attached' : outcome.kind]++
				}
			} catch (error) {
				// The claim stays open and is claimed again after its hold; the others go on.
				round.lost++
				if (!(error instanceof DeadlinePassed)) {
					console.error({ event: 'kopje.link_cards.claim_failed', ...errorFields(error) })
				}
			}
		}
	}
	await Promise.all(Array.from({ length: CARD_CONCURRENCY }, worker))
	for (const claim of queue) {
		try {
			if ((await record(claim, { kind: 'unattempted' }, end)).held) {
				round.released++
			}
		} catch (error) {
			if (!(error instanceof DeadlinePassed)) {
				console.error({ event: 'kopje.link_cards.release_failed', ...errorFields(error) })
			}
			break
		}
	}
	return round
}
