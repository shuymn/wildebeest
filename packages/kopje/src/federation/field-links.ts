import type { InboxDeps } from './inbox'
import {
	fetchWebPage,
	probeRedirect,
	WEB_PAGE_PAIR_MAX_STORE_CALLS,
	WEB_PAGE_PAIR_MAX_SUBREQUESTS,
	type WebPageBudget,
	type WebPageDeps,
	type WebPageFailure,
} from './web-page'
import { FIELD_LINK_HOLD_MS, type FieldLinksClaim, type FieldLinksFence } from '../domain/field-links'
import { DeadlinePassed, within } from '../platform/deadline'
import { outputMaxUnits, SCAN_LIMITS, type ScanLimits } from '../platform/html-scan'
import { PACKAGE_VERSION } from '../platform/package-version'
import { callStore, type StoreStub } from '../platform/store-client'
import { LOCAL_FIELDS } from '../platform/stored-bounds'

// The Worker's part of verifying local profile links (domain/field-links.ts, Mastodon's VerifyLinkService,
// app/services/verify_link_service.rb, v4.5.11), the first caller of the web-page sink (federation/web-page.ts,
// NET-3). The cron runs one round per tick, outside maintenance, independently of its other work
// (jobs/scheduled.ts scheduledFieldLinks); nothing else does (a save only arms a check). A round:
//   1. claims one due account (claimFieldLinks), with its link back https://<domain>/@<username> and its candidate
//      values (at most LOCAL_FIELDS);
//   2. for each value in order: GETs it through the sink (Accept text/html, at most 3 redirects to any origin, 200
//      text/html or application/xhtml+xml only, a 1 MiB prefix, scanned for rel=me only); verified when an <a> or
//      <link> with the rel token "me" has an href equal to the link back ASCII case-insensitively (Mastodon's
//      href.downcase == link_back.downcase, :31); else, when the first such element has an href, HEADs it without
//      following and verifies when the raw Location is exactly the link back, whatever the status (:36, :40-48);
//      then records the outcome under the claim's fence (recordFieldLink), and stops at once when the fence is lost;
//   3. finishes the claim (finishFieldLinks) with the values claimed and those it could not check: a value whose
//      check ran out of the round's budget or deadline.
// Bounds (RES-6): the whole round, its finish included, ends within FIELD_LINK_ROUND_MS. All values share
// FIELD_LINK_SUBREQUESTS (each value's GET and HEAD at their ceilings: DNS checks included) and FIELD_LINK_STORE_CALLS
// domain-policy reads, and the checks' deadline, FIELD_LINK_FINISH_MS before the round's, which keeps that time for the
// finish. The round's own Store calls are one claim, at most LOCAL_FIELDS records (each within the checks' deadline)
// and one finish (within the round's), each started only before its deadline, given up at it, and its result not
// used when it arrives at or past it. The scan collects rel=me hrefs, the title and lang only
// (FIELD_LINK_SCAN): FIELD_LINK_OUTPUT_MAX_UNITS UTF-16 code units at most. Logs carry the event, the sink's failure
// kind and reason, and the hostname only.

export const FIELD_LINK_ROUND_MS = 60_000
export const FIELD_LINK_FINISH_MS = 10_000
export const FIELD_LINK_CHECKS_MS = FIELD_LINK_ROUND_MS - FIELD_LINK_FINISH_MS
// A claim must outlast the round that holds it: twice its worst case.
if (FIELD_LINK_HOLD_MS < 2 * FIELD_LINK_ROUND_MS) {
	throw new Error('FIELD_LINK_HOLD_MS must be at least twice a field link round')
}
export const FIELD_LINK_SUBREQUESTS = LOCAL_FIELDS * WEB_PAGE_PAIR_MAX_SUBREQUESTS
export const FIELD_LINK_STORE_CALLS = LOCAL_FIELDS * WEB_PAGE_PAIR_MAX_STORE_CALLS
export const FIELD_LINK_SCAN: Partial<ScanLimits> = Object.freeze({ links: 0, metas: 0, jsonLd: 0 })
export const FIELD_LINK_OUTPUT_MAX_UNITS = outputMaxUnits({ ...SCAN_LIMITS, ...FIELD_LINK_SCAN })

type Sink = { fetchWebPage: typeof fetchWebPage; probeRedirect: typeof probeRedirect }

export type FieldLinksDeps = InboxDeps & {
	// Tests only: a sink over a scanner that holds a scan (federation/web-page.ts createWebPageSink).
	sink?: Sink
}

export type FieldLinksRound = {
	claimed: boolean
	verified: number
	unchecked: number
	finished: boolean
	givenUp: number
}

type Outcome = 'verified' | 'unverified' | 'unchecked'

const asciiLower = (value: string) => value.replace(/[A-Z]+/g, (upper) => upper.toLowerCase())

function logged(failure: WebPageFailure, step: 'get' | 'head'): void {
	console.log({
		event: 'kopje.field_links.unverified',
		step,
		kind: failure.kind,
		reason: failure.reason ?? null,
		host: failure.host,
	})
}

// One value's check within the round's `budget` (its deadline the round's).
async function checkLink(
	sink: Sink,
	value: string,
	linkBack: string,
	web: WebPageDeps,
	budget: WebPageBudget
): Promise<Outcome> {
	const spent = (failure: WebPageFailure): Outcome =>
		failure.kind === 'budget' || (failure.kind === 'timeout' && web.now() >= budget.deadline)
			? 'unchecked'
			: 'unverified'
	const page = await sink.fetchWebPage(value, web, { budget, scan: FIELD_LINK_SCAN })
	if (!page.ok) {
		logged(page, 'get')
		return spent(page)
	}
	const back = asciiLower(linkBack)
	if (page.scan.relMe.some((href) => href !== null && asciiLower(href) === back)) {
		return 'verified'
	}
	const first = page.scan.relMe[0]
	if (first === undefined || first === null) {
		return 'unverified'
	}
	const probe = await sink.probeRedirect(first, web, { budget })
	if (!probe.ok) {
		logged(probe, 'head')
		return spent(probe)
	}
	return probe.location === linkBack ? 'verified' : 'unverified'
}

// A Store call within `end` (within: not started at or past it, given up at it), whose result arriving at or past it
// is not used either.
async function inTime<T>(work: () => Promise<T>, end: number, now: () => number): Promise<T> {
	const result = await within(work, end, now)
	if (now() >= end) {
		throw new DeadlinePassed()
	}
	return result
}

// One round (above). A Store refusal (maintenance) surfaces as StoreUnavailableError: the claim, open, is claimed
// again after its hold. Returns what it did, for the logs and tests.
export async function fieldLinksRound(env: Env, deps: FieldLinksDeps): Promise<FieldLinksRound> {
	const build = deps.build(env)
	const rpc = <T>(call: (store: StoreStub) => Promise<T>) => callStore(() => call(deps.store(env)))
	const start = deps.now()
	const end = start + FIELD_LINK_ROUND_MS
	const deadline = start + FIELD_LINK_CHECKS_MS
	const round: FieldLinksRound = { claimed: false, verified: 0, unchecked: 0, finished: false, givenUp: 0 }
	// The RPC stub types a union of results as a union of promises: the operation's own type is restored.
	const claim: FieldLinksClaim = await inTime(
		() => rpc((s) => s.claimFieldLinks(build, { now: deps.now() }) as Promise<FieldLinksClaim>),
		deadline,
		deps.now
	)
	round.givenUp = claim.givenUp
	if (claim.givenUp > 0) {
		console.log({ event: 'kopje.field_links.given_up', accounts: claim.givenUp })
	}
	if (claim.kind !== 'claimed') {
		return round
	}
	round.claimed = true
	const fence: FieldLinksFence = { accountId: claim.accountId, token: claim.token, epoch: claim.epoch }
	const origin = new URL(claim.linkBack).origin
	const web: WebPageDeps = {
		fetch: deps.loader.fetch,
		...(deps.loader.checkHost === undefined ? {} : { checkHost: deps.loader.checkHost }),
		refusesHost: (host) => rpc((s) => s.fetchRefused(build, { host })),
		userAgent: `Kopje/${PACKAGE_VERSION} (+${origin}/)`,
		now: deps.now,
	}
	const budget: WebPageBudget = { subrequests: FIELD_LINK_SUBREQUESTS, storeCalls: FIELD_LINK_STORE_CALLS, deadline }
	const sink = deps.sink ?? { fetchWebPage, probeRedirect }
	const unchecked: string[] = []
	for (const [i, value] of claim.values.entries()) {
		if (deps.now() >= deadline) {
			unchecked.push(...claim.values.slice(i))
			break
		}
		const outcome = await checkLink(sink, value, claim.linkBack, web, budget)
		if (outcome === 'unchecked') {
			unchecked.push(value)
			continue
		}
		let recorded: { held: boolean; recorded: boolean }
		try {
			recorded = await inTime(
				() =>
					rpc((s) => s.recordFieldLink(build, { ...fence, value, verified: outcome === 'verified', now: deps.now() })),
				deadline,
				deps.now
			)
		} catch (error) {
			if (!(error instanceof DeadlinePassed)) {
				throw error
			}
			// The record may still land; the value and the rest are checked again after the hold.
			unchecked.push(...claim.values.slice(i))
			break
		}
		if (!recorded.held) {
			return round
		}
		round.verified += recorded.recorded ? 1 : 0
	}
	round.unchecked = unchecked.length
	const finished = await inTime(
		() => rpc((s) => s.finishFieldLinks(build, { ...fence, claimed: claim.values, unchecked, now: deps.now() })),
		end,
		deps.now
	)
	round.finished = finished.held
	return round
}
