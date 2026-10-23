import { FetchError } from '@fedify/fedify'

import { createRemoteLoaders, type FederationDeps, type FederationState, type RemoteLoaders } from './federation'
import { originOf } from './inbound'
import { typeIs } from './json-shapes'
import { requestBudget } from './loader'
import { fetchActor } from './remote-actor'
import { ACTOR_TYPES, idOf, parseRemoteStatus } from './remote-status'
import type { RemoteActorInput } from '../domain/inbox'
import type { Resolved } from '../domain/remote-statuses'
import { readConfig, userKek } from '../platform/config'
import { hostDomain, normalizeDomain, parseAddress } from '../platform/domain-name'
import { withinJsonBounds } from '../platform/json-bounds'
import { callStore, type StoreResolver } from '../platform/store-client'

// Search resolution (GET /api/v2/search?resolve=true, and GET /api/v1/accounts/search?resolve=true for addresses;
// design: インスタンス actor): a URL or a user@domain address is fetched through the safe loader (NET-1), signed by
// the instance actor and never served from the signed-document cache (NET-4), within one request's fetch budget
// (RES-6), and parsed as inbound documents are (ID-2, ID-8, RES-2). The Store then stores it with inbound validation
// and answers only what the viewer may see (resolveSearch). Only authenticated requests get here (resolveQuery in
// mastodon/search.ts checks the token first).
//
// As Mastodon's ResolveURLService and ResolveAccountService, with these differences: a URL must answer with an
// ActivityPub document itself (an HTML page's alternate link is not followed), and an address is stored under the
// host of the actor its WebFinger names (no second WebFinger round trip to confirm a split domain).

export type ResolverDeps = {
	build: (env: Env) => string
	store: StoreResolver
	now: () => number
	keygen: FederationDeps['keygen']
	loader: FederationDeps['loader']
}

export type Resolver = (env: Env, query: string) => Promise<Resolved>

const NONE: Resolved = { kind: 'none' }

export function createResolver(deps: ResolverDeps): Resolver {
	return async (env, query) => {
		const build = deps.build(env)
		const store = () => deps.store(env)
		const domain = await callStore(() => store().instanceDomain(build))
		if (domain === null) {
			return NONE
		}
		const config = readConfig(env)
		const state: FederationState = { resolvedUsername: null, source: null, storeError: null, ticket: null }
		const loaders = createRemoteLoaders(
			{
				domain,
				build,
				store,
				kek: config.ok ? userKek(config.config) : '',
				now: deps.now,
				keygen: deps.keygen,
				loader: deps.loader,
			},
			state,
			null,
			requestBudget(Date.now())
		)
		const resolved = await resolveWith(loaders, query.trim(), domain)
		if (state.storeError !== null) {
			throw state.storeError
		}
		return resolved
	}
}

async function resolveWith(loaders: RemoteLoaders, query: string, domain: string): Promise<Resolved> {
	const address = parseAddress(query)
	if (address !== null) {
		return address.domain === domain ? NONE : resolveAddress(loaders, address.username, address.domain)
	}
	let url: URL
	try {
		url = new URL(query)
	} catch {
		return NONE
	}
	// A local URL is answered from stored data (resolveSearch's lookup by uri).
	return url.host === domain ? NONE : resolveUrl(loaders, url.href)
}

// An actor, with the canonical address its host declares (declaredDomain).
async function resolveAccount(loaders: RemoteLoaders, uri: string): Promise<Resolved> {
	const fetched = await fetchActor(uri, loaders.document, loaders.context)
	if (fetched.kind !== 'ok' || fetched.input === null) {
		return NONE
	}
	const actor = fetched.input
	const confirmed = await declaredDomain(loaders, actor)
	return { kind: 'account', actor: confirmed === undefined ? actor : { ...actor, confirmedDomain: confirmed } }
}

type WebFinger = { subject: string | null; self: string | null }

// A WebFinger (RFC 7033) answer for acct:username@host: its subject and the actor its self link names; 'missing'
// when the server answers that there is no such account (404 or 410, an authoritative negative); null when there is no
// usable answer (a network error, a timeout, a 5xx, the fetch budget, or a document that cannot be read), which
// proves nothing either way.
async function webfingerAt(
	loaders: RemoteLoaders,
	username: string,
	host: string
): Promise<WebFinger | 'missing' | null> {
	const resource = `acct:${username}@${host}`
	let jrd: unknown
	try {
		jrd = (await loaders.webfinger(`https://${host}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`))
			.document
	} catch (error) {
		const status = error instanceof FetchError ? error.response?.status : undefined
		return status === 404 || status === 410 ? 'missing' : null
	}
	if (!withinJsonBounds(jrd) || typeof jrd !== 'object' || jrd === null) {
		return null
	}
	const { subject, links } = jrd as { subject?: unknown; links?: unknown }
	const self = (Array.isArray(links) ? links : []).find(
		(link): link is { href: string } =>
			typeof link === 'object' &&
			link !== null &&
			(link as { rel?: unknown }).rel === 'self' &&
			typeof (link as { href?: unknown }).href === 'string' &&
			typeof (link as { type?: unknown }).type === 'string' &&
			/^application\/(activity\+json|ld\+json)/.test((link as { type: string }).type)
	)
	return { subject: typeof subject === 'string' ? subject : null, self: self?.href ?? null }
}

// The username and domain of a WebFinger subject: acct:<username>@<domain>, exactly one @ and no empty part, with
// the domain normalized (normalizeDomain); null otherwise.
function splitAcct(subject: string | null): { username: string; domain: string } | null {
	const parts = (subject ?? '').replace(/^acct:/, '').split('@')
	if (parts.length !== 2) {
		return null
	}
	const [username = '', raw = ''] = parts
	const domain = normalizeDomain(raw)
	return username === '' || domain === null ? null : { username, domain }
}

// The canonical domain of an actor's address, as Mastodon's ActivityPub::ProcessAccountService#check_webfinger! and
// ResolveAccountService#process_webfinger! decide it (v4.7.3): the actor's own host declares the address in the subject
// of its WebFinger for acct:<preferredUsername>@<host>, and a subject on another domain is only a candidate, which
// that domain must confirm: its WebFinger for the subject names the same actor id as self. Confirmed: the candidate;
// the host's answer naming the actor under its own name, or any answer that does not confirm: the host. undefined
// when the host gives no usable answer (the Store then keeps what it has for this exact username, accountDomain).
// The address a search was made with plays no part: an alias never sets or replaces the canonical domain.
async function declaredDomain(loaders: RemoteLoaders, actor: RemoteActorInput): Promise<string | undefined> {
	// The actor's host, in the normalized form; an actor id with a port (or that does not normalize) is not checked:
	// the Store keeps what it has for this username (accountDomain).
	const host = normalizeDomain(hostDomain(actor.uri))
	if (host === null) {
		return undefined
	}
	const declared = await webfingerAt(loaders, actor.username, host)
	if (declared === null) {
		return undefined
	}
	if (declared === 'missing') {
		return host
	}
	const subject = splitAcct(declared.subject)
	if (subject === null || subject.username.toLowerCase() !== actor.username.toLowerCase()) {
		return host
	}
	if (subject.domain === host) {
		return declared.self === actor.uri ? host : undefined
	}
	// A transient failure at the candidate keeps what is stored for this username; only an authoritative answer
	// (missing, or naming another subject or actor) gives the host.
	const candidate = await webfingerAt(loaders, subject.username, subject.domain)
	if (candidate === null) {
		return undefined
	}
	const confirmed = candidate === 'missing' ? null : splitAcct(candidate.subject)
	return candidate !== 'missing' &&
		candidate.self === actor.uri &&
		confirmed?.username.toLowerCase() === subject.username.toLowerCase() &&
		confirmed.domain === subject.domain
		? subject.domain
		: host
}

// An address: the actor its WebFinger names, found by its actor id. Its canonical address is the one its host
// declares (declaredDomain), never the address searched for.
async function resolveAddress(loaders: RemoteLoaders, username: string, domain: string): Promise<Resolved> {
	const found = await webfingerAt(loaders, username, domain)
	const href = found === null || found === 'missing' ? null : found.self
	return href === null ? NONE : resolveAccount(loaders, href)
}

// A URL: an actor, or a status with its author (the author has the status's origin, as for inbound objects).
async function resolveUrl(loaders: RemoteLoaders, url: string): Promise<Resolved> {
	let document: unknown
	try {
		document = (await loaders.document(url)).document
	} catch {
		return NONE
	}
	if (typeof document !== 'object' || document === null) {
		return NONE
	}
	const type = (document as { type?: unknown }).type
	const id = idOf(document)
	if (typeIs(type, ACTOR_TYPES)) {
		return id === null ? NONE : resolveAccount(loaders, id)
	}
	const status = parseRemoteStatus(document)
	if (status === null || status.attributedTo === null) {
		return NONE
	}
	if (originOf(status.attributedTo) !== originOf(status.uri)) {
		return NONE
	}
	const author = await fetchActor(status.attributedTo, loaders.document, loaders.context)
	return author.kind === 'ok' && author.input !== null ? { kind: 'status', status, author: author.input } : NONE
}
