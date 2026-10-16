import { type DocumentLoader, FetchError } from '@fedify/fedify'

import { createRemoteLoaders, type FederationDeps, type FederationState, type RemoteLoaders } from './federation'
import type { InboxDeps } from './inbox'
import { BudgetExceededError, type FetchBudget, isTransientLoadError, requestBudget } from './loader'
import { fetchActor } from './remote-actor'
import { fetchRemoteStatus, idOf } from './remote-status'
import type { RemoteActorInput } from '../domain/inbox'
import { type Fetched, QUOTE_ROUND, type QuoteVerification, type StampInput } from '../domain/quotes'
import type { RemoteStatusInput } from '../domain/remote-statuses'
import { readConfig, userKek } from '../platform/config'
import { withinJsonBounds } from '../platform/json-bounds'
import { callStore, type StoreStub } from '../platform/store-client'

// The Worker's part of verifying a received quote (domain/quotes.ts, Mastodon's ActivityPub::VerifyQuoteService): it
// fetches what the Store's work names, through the safe loader (NET-1) within a fetch budget (RES-6) that counts every
// fetch and redirect hop, and hands each document to the Store, which keeps what it completed and decides in one
// transaction. Three stages of one document each: the quoted status when it is not stored, that status's author when
// the Store does not have it, and the stamp (QuoteAuthorization). Each stage fits one budget, so a stage started with a
// whole budget always finishes, and a quote whose stages need more than one budget goes on from where the last round
// stopped. The stamp's embedded objects are never trusted: only their ids are read. Nothing of this instance's origin
// is fetched.
//
// The inbox request that stored a quote runs its work inline (federation/inbound.ts) with what is left of its budget;
// the job rounds (jobs/queue.ts, after the Store's inbound jobs, from the Queue and cron) take the rest, QUOTE_ROUND
// quotes oldest due first, each with a budget of its own. Either way each fetch is signed with the key of the work's
// rechecked fetch_as (a local recipient of the quoting status, or a local follower of its author) or else the instance
// actor's (DATA-7).

const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams'

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function originOf(uri: string): string | null {
	try {
		return new URL(uri).origin
	} catch {
		return null
	}
}

function failureOf(error: unknown): Exclude<Fetched<never>, { kind: 'ok' }> {
	if (error instanceof BudgetExceededError) {
		return { kind: 'budget' }
	}
	const status = error instanceof FetchError ? error.response?.status : undefined
	if (status === 404 || status === 410) {
		return { kind: 'gone' }
	}
	return { kind: isTransientLoadError(error) ? 'transient' : 'unusable' }
}

// A document of another origin, or why there is none.
async function load(uri: string, origin: string, loader: DocumentLoader): Promise<Fetched<unknown>> {
	if (originOf(uri) === null || originOf(uri) === origin) {
		return { kind: 'unusable' }
	}
	try {
		const { document } = await loader(uri)
		return withinJsonBounds(document) ? { kind: 'ok', value: document } : { kind: 'unusable' }
	} catch (error) {
		return failureOf(error)
	}
}

// The quoted status, parsed as inbound statuses are (its id must be the one asked for: checked by the Store).
async function loadStatus(uri: string, origin: string, loader: DocumentLoader): Promise<Fetched<RemoteStatusInput>> {
	const loaded = await load(uri, origin, loader)
	if (loaded.kind !== 'ok') {
		return loaded
	}
	const fetched = await fetchRemoteStatus(uri, () =>
		Promise.resolve({ document: loaded.value, documentUrl: uri, contextUrl: null })
	)
	return fetched.kind === 'ok' ? { kind: 'ok', value: fetched.status } : { kind: 'unusable' }
}

// A stamp as compacted JSON with the ActivityStreams context: ids only.
export function stampOf(document: unknown): StampInput | null {
	if (!isObject(document)) {
		return null
	}
	const context = document['@context']
	const types = (Array.isArray(document.type) ? document.type : [document.type]).filter(
		(type): type is string => typeof type === 'string'
	)
	const first = (value: unknown) => idOf(Array.isArray(value) ? value[0] : value)
	return {
		context: context === AS_CONTEXT || (Array.isArray(context) && context.includes(AS_CONTEXT)),
		types,
		id: typeof document.id === 'string' ? document.id : null,
		attributedTo: first(document.attributedTo),
		interactingObject: first(document.interactingObject),
		interactionTarget: first(document.interactionTarget),
	}
}

async function loadStamp(uri: string, origin: string, loader: DocumentLoader): Promise<Fetched<StampInput>> {
	const loaded = await load(uri, origin, loader)
	if (loaded.kind !== 'ok') {
		return loaded
	}
	const stamp = stampOf(loaded.value)
	return stamp === null ? { kind: 'unusable' } : { kind: 'ok', value: stamp }
}

// The quoted status's author, parsed as any actor (none of this instance's origin is fetched).
async function loadActor(uri: string, origin: string, loaders: RemoteLoaders): Promise<Fetched<RemoteActorInput>> {
	if (originOf(uri) === null || originOf(uri) === origin) {
		return { kind: 'unusable' }
	}
	const fetched = await fetchActor(uri, loaders.document, loaders.context)
	if (fetched.kind === 'ok') {
		return fetched.input === null ? { kind: 'unusable' } : { kind: 'ok', value: fetched.input }
	}
	return { kind: fetched.kind }
}

type Rpc = <T>(call: (store: StoreStub) => Promise<T>) => Promise<T>

// The loaders a quote's fetches go through, and the budget they draw on (the request's, or the quote's own in a round).
export type QuoteLoaders = { loaders: RemoteLoaders; budget: FetchBudget }

function spent(budget: FetchBudget): boolean {
	return budget.fetches <= 0 || budget.bytes <= 0 || Date.now() >= budget.deadline
}

// A failure that may pass, told apart from the budget running out (which charges the quote no attempt).
function charged<T>(fetched: Fetched<T>, budget: FetchBudget): Fetched<T> {
	return fetched.kind === 'transient' && spent(budget) ? { kind: 'budget' } : fetched
}

// One quote's work, a stage at a time (quoteWork: the quoted status, its author, the stamp): each stage fetches one
// document with `loadersFor(signer)` (signer: the work's rechecked fetch_as, a username, or null) and hands it to the
// Store, which keeps what it completed, so a round that runs out of budget leaves the next round at the first stage not
// done. Returns whether work is left due now: this quote's (unfinished), or another's (a quoted status it stored has a
// quote of its own), for a later round.
export async function verifyQuote(
	rpc: Rpc,
	build: string,
	origin: string,
	statusId: string,
	loadersFor: (signer: string | null) => QuoteLoaders,
	now: () => number
): Promise<boolean> {
	for (let stage = 0; stage < 4; stage++) {
		const work = await rpc((s) => s.quoteWork(build, { statusId }))
		if (work === null) {
			return false
		}
		const { loaders, budget } = loadersFor(work.signer)
		const input: QuoteVerification = {
			statusId,
			now: now(),
			origin,
			quotedUri: work.quotedUri,
			approvalUri: work.approvalUri,
		}
		if (work.fetch !== null && spent(budget)) {
			input[work.stage === 'quoted' ? 'quoted' : work.stage === 'author' ? 'author' : 'stamp'] = { kind: 'budget' }
		} else if (work.stage === 'quoted' && work.fetch !== null) {
			input.quoted = charged(await loadStatus(work.fetch, origin, loaders.document), budget)
		} else if (work.stage === 'author' && work.fetch !== null) {
			input.author = charged(await loadActor(work.fetch, origin, loaders), budget)
		} else if (work.stage === 'stamp' && work.fetch !== null) {
			input.stamp = charged(await loadStamp(work.fetch, origin, loaders.document), budget)
		}
		const result = await rpc((s) => s.completeQuote(build, { ...input, now: now() }))
		if (!result.next) {
			return !result.done || result.due
		}
	}
	return true
}

// One job round (jobs/queue.ts): up to QUOTE_ROUND quotes whose work is due, oldest first, claimed for the round, each
// within a request's fetch budget of its own. Returns whether more work is due. A Store refusal surfaces as
// StoreUnavailableError for the caller; a claimed quote whose round died is claimed again after its lease.
export async function verifyQuotes(env: Env, deps: InboxDeps): Promise<boolean> {
	const build = deps.build(env)
	const store = () => deps.store(env)
	const domain = await callStore(() => store().instanceDomain(build))
	if (domain === null) {
		return false
	}
	const origin = `https://${domain}`
	const claimed = await callStore(() => store().claimQuotes(build, { now: deps.now(), limit: QUOTE_ROUND }))
	if (claimed.ids.length === 0) {
		return claimed.more
	}
	const config = readConfig(env)
	const federation: FederationDeps = {
		domain,
		build,
		store,
		kek: config.ok ? userKek(config.config) : '',
		now: deps.now,
		keygen: deps.keygen,
		loader: deps.loader,
	}
	const state: FederationState = { resolvedUsername: null, source: null, storeError: null }
	// Each quote has a fetch budget of its own: a heavy or failing one never starves the others of the round.
	const loadersOf = () => {
		const budget = requestBudget(Date.now())
		const bySigner = new Map<string | null, QuoteLoaders>()
		return (signer: string | null) => {
			let loaders = bySigner.get(signer)
			if (loaders === undefined) {
				loaders = { loaders: createRemoteLoaders(federation, state, signer, budget), budget }
				bySigner.set(signer, loaders)
			}
			return loaders
		}
	}
	const rpc: Rpc = (call) => callStore(() => call(store()))
	let more = claimed.more
	for (const id of claimed.ids) {
		const left = await verifyQuote(rpc, build, origin, id, loadersOf(), deps.now)
		if (state.storeError !== null) {
			throw state.storeError
		}
		more ||= left
	}
	return more
}
