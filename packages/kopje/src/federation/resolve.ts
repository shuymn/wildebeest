import { createRemoteLoaders, type FederationDeps, type FederationState, type RemoteLoaders } from './federation'
import { originOf } from './inbound'
import { requestBudget } from './loader'
import { fetchActor } from './remote-actor'
import { ACTOR_TYPES, idOf, parseRemoteStatus, typeIs } from './remote-status'
import { ADDRESS_QUERY, type Resolved } from '../domain/remote-statuses'
import { readConfig, userKek } from '../platform/config'
import { withinJsonBounds } from '../platform/json-bounds'
import { callStore, type StoreResolver } from '../platform/store-client'

// Search resolution (GET /api/v2/search?resolve=true, design: インスタンス actor): a URL or a user@domain address is
// fetched through the safe loader (NET-1), signed by the instance actor and never served from the signed-document
// cache (NET-4), within one request's fetch budget (RES-6), and parsed as inbound documents are (ID-2, ID-8, RES-2).
// The Store then stores it with inbound validation and answers only what the viewer may see (resolveSearch). Only
// authenticated requests get here (mastodon/search.ts checks the token first).
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
		const state: FederationState = { resolvedUsername: null, source: null, storeError: null }
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
	const address = ADDRESS_QUERY.exec(query)
	if (address !== null) {
		const [, username = '', host = ''] = address
		return host.toLowerCase() === domain ? NONE : resolveAddress(loaders, username, host.toLowerCase())
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

async function resolveAccount(loaders: RemoteLoaders, uri: string): Promise<Resolved> {
	const fetched = await fetchActor(uri, loaders.document, loaders.context)
	return fetched.kind === 'ok' && fetched.input !== null ? { kind: 'account', actor: fetched.input } : NONE
}

// WebFinger (RFC 7033) for the address, then the actor its self link names.
async function resolveAddress(loaders: RemoteLoaders, username: string, host: string): Promise<Resolved> {
	const resource = `acct:${username}@${host}`
	let jrd: unknown
	try {
		jrd = (await loaders.webfinger(`https://${host}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`))
			.document
	} catch {
		return NONE
	}
	if (!withinJsonBounds(jrd) || typeof jrd !== 'object' || jrd === null) {
		return NONE
	}
	const links = (jrd as { links?: unknown }).links
	const self = (Array.isArray(links) ? links : []).find(
		(link): link is { href: string } =>
			typeof link === 'object' &&
			link !== null &&
			(link as { rel?: unknown }).rel === 'self' &&
			typeof (link as { href?: unknown }).href === 'string' &&
			typeof (link as { type?: unknown }).type === 'string' &&
			/^application\/(activity\+json|ld\+json)/.test((link as { type: string }).type)
	)
	return self === undefined ? NONE : resolveAccount(loaders, self.href)
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
