import { type DocumentLoader, FetchError } from '@fedify/fedify'

import { createRemoteLoaders, type FederationDeps, type FederationState, type RemoteLoaders } from './federation'
import { hasActivityStreamsContext } from './inbound'
import type { InboxDeps } from './inbox'
import { isTransientLoadError, REQUEST_DEADLINE_MS, requestBudget } from './loader'
import { fetchActor } from './remote-actor'
import { fetchRemoteStatus, idOf } from './remote-status'
import type { RemoteActorInput } from '../domain/inbox'
import {
	type Fetched,
	QUOTE_LEASE_MS,
	QUOTE_ROUND,
	QUOTE_STAGES,
	type QuoteVerification,
	type QuoteVerified,
	type StampInput,
} from '../domain/quotes'
import type { RemoteStatusInput } from '../domain/remote-statuses'
import { readConfig, userKek } from '../platform/config'
import { errorFields } from '../platform/error-message'
import { withinJsonBounds } from '../platform/json-bounds'
import { callStore, type StoreStub } from '../platform/store-client'
import { StoreUnavailableError } from '../platform/store-errors'

// The Worker's part of verifying a received quote (domain/quotes.ts, Mastodon's ActivityPub::VerifyQuoteService), run
// only by the job rounds (jobs/queue.ts, after the Store's inbound jobs, from the Queue and cron; an inbox request that
// made work due asks the Queue for one). A round claims QUOTE_ROUND quotes oldest due first, leasing them, and goes
// through each one's stages: the quoted status when it is not stored, that status's author when the Store does not have
// it or its stored document is a day old, the status again once its author is stored, and the stamp
// (QuoteAuthorization), one document each, fetched through the safe loader (NET-1) within a whole fetch budget of its
// own (RES-6: every fetch and redirect hop counts), signed with the key of the work's rechecked fetch_as (a local
// recipient of the quoting status, or a local follower of its author) or else the instance actor's (DATA-7). The Store
// keeps what each stage completed and decides in one transaction; every failure of a stage is charged (a budget or
// deadline that ran out included), so a stage that never fits a budget is given up after the last attempt, except a
// stale stored author's refetch, whose fallback to the stored account is uncharged (domain/inbox.ts applyRefresh). The
// stamp's embedded objects are never trusted: only their ids are read. Nothing of this instance's origin is fetched.

// A round's claim must outlast the round (domain/quotes.ts QUOTE_LEASE_MS): twice its worst case of fetching.
export const QUOTE_ROUND_WORST_MS = QUOTE_ROUND * QUOTE_STAGES * REQUEST_DEADLINE_MS
if (QUOTE_LEASE_MS < 2 * QUOTE_ROUND_WORST_MS) {
	throw new Error('QUOTE_LEASE_MS must be at least twice a round of QUOTE_ROUND quotes of QUOTE_STAGES stages')
}

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
	const types = (Array.isArray(document.type) ? document.type : [document.type]).filter(
		(type): type is string => typeof type === 'string'
	)
	const first = (value: unknown) => idOf(Array.isArray(value) ? value[0] : value)
	return {
		context: hasActivityStreamsContext(document['@context']),
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

// One quote's work, a stage at a time (quoteWork: the quoted status, its author, the status again once its author is
// stored, the stamp): each stage fetches one document through loaders of its own (`loadersFor(signer)`, signer the
// work's rechecked fetch_as, a username, or null), so nothing one stage fetched answers another's fetch, and hands it
// to the Store, which applies it only to the generation, stage and fetch address of the work it read. Returns whether
// work is left due now: this quote's (unfinished), or another's (a quoted status it stored has a quote of its own), for
// a later round.
async function verifyQuote(
	rpc: Rpc,
	build: string,
	origin: string,
	statusId: string,
	loadersFor: (signer: string | null) => RemoteLoaders,
	now: () => number,
	run: { generation: number; state: FederationState }
): Promise<boolean> {
	// The quoted status, its author, the status again (now storable), the stamp, and the decision.
	for (let stage = 0; stage < QUOTE_STAGES; stage++) {
		const work = await rpc((s) => s.quoteWork(build, { statusId, now: now() }))
		if (work === null) {
			return false
		}
		// The first stage is the claimed work's: if the quote changed since the claim, its outcome is discarded.
		const generation = stage === 0 ? run.generation : work.generation
		const loaders = loadersFor(work.signer)
		const input: QuoteVerification = {
			statusId,
			now: now(),
			origin,
			quotedUri: work.quotedUri,
			approvalUri: work.approvalUri,
			generation,
			stage: work.stage,
			fetch: work.fetch,
		}
		if (work.stage === 'quoted' && work.fetch !== null) {
			input.quoted = await loadStatus(work.fetch, origin, loaders.document)
		} else if (work.stage === 'author' && work.fetch !== null) {
			input.author = await loadActor(work.fetch, origin, loaders)
		} else if (work.stage === 'stamp' && work.fetch !== null) {
			input.stamp = await loadStamp(work.fetch, origin, loaders.document)
		}
		// A Store refusal inside a loader (a signing key's RPC in maintenance) made the fetch fail: that is no outcome of
		// the quote's. The round stops before submitting anything, and nothing is charged.
		if (run.state.storeError !== null) {
			throw run.state.storeError
		}
		let result: QuoteVerified
		try {
			result = await rpc((s) => s.completeQuote(build, { ...input, now: now() }))
		} catch (error) {
			// What the Store could not apply (a document it cannot store) fails this quote alone, charged; maintenance still
			// stops the round.
			if (error instanceof StoreUnavailableError) {
				throw error
			}
			console.error({ event: 'kopje.quote.stage.failed', ...errorFields(error) })
			await rpc((s) => s.chargeQuote(build, { statusId, generation, stage: work.stage, fetch: work.fetch, now: now() }))
			return false
		}
		if (!result.next) {
			return !result.done || result.due
		}
	}
	return true
}

// One job round (jobs/queue.ts): up to QUOTE_ROUND quotes whose work is due, oldest first, claimed for the round, each
// stage of each with a whole fetch budget of its own, so a heavy or failing quote starves no other. Returns whether
// more work is due. A Store refusal surfaces as StoreUnavailableError for the caller; a claimed quote whose round died
// is claimed again after its lease.
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
	const state: FederationState = { resolvedUsername: null, source: null, storeError: null, ticket: null }
	const loadersFor = (signer: string | null) =>
		createRemoteLoaders(federation, state, signer, requestBudget(Date.now()))
	const rpc: Rpc = (call) => callStore(() => call(store()))
	let more = claimed.more
	for (const [i, id] of claimed.ids.entries()) {
		const left = await verifyQuote(rpc, build, origin, id, loadersFor, deps.now, {
			generation: claimed.generations[i]!,
			state,
		})
		if (state.storeError !== null) {
			throw state.storeError
		}
		more ||= left
	}
	return more
}
