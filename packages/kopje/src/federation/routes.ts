import { nodeInfoToJson } from '@fedify/fedify'
import type { Context, Handler } from 'hono'

import { createKopjeFederation, type FederationDeps, type FederationState, nodeInfo } from './federation'
import type { LoaderDeps } from './loader'
import { createSnapshotSaver, snapshotKey } from './snapshot'
import type { SnapshotSource } from '../domain/snapshot'
import { readConfig, userKek } from '../platform/config'
import { callStore, type StoreResolver } from '../platform/store-client'
import type { KeyGen } from '../security/key-wrap'

// The federation GETs. All but the collections are always served (app/gate.ts) and kept as snapshots.
export const FEDERATION_GET_ROUTES = [
	'/.well-known/webfinger',
	'/.well-known/nodeinfo',
	'/nodeinfo/2.0',
	'/nodeinfo/2.1',
	'/actor',
	'/ap/users/:username',
	'/ap/users/:username/followers',
	'/ap/users/:username/following',
	'/ap/users/:username/outbox',
	'/ap/o/:uuid',
]

export type FederationRouteDeps = {
	build: (env: Env) => string
	now: () => number
	store: StoreResolver
	keygen: KeyGen
	loader: Omit<LoaderDeps, 'userAgent'>
}

// The domain comes from the setup gate (setup-gate.ts), which has already read it from the Store.
type FederationEnv = { Bindings: Env; Variables: { domain: string } }

const NODEINFO_20 = 'http://nodeinfo.diaspora.software/ns/schema/2.0'
const NODEINFO_21 = 'http://nodeinfo.diaspora.software/ns/schema/2.1'

export function federationHandler(deps: FederationRouteDeps): Handler<FederationEnv> {
	const saveSnapshot = createSnapshotSaver(deps.now)
	return async (c) => {
		const url = new URL(c.req.url)
		// Taken before rendering: the Store refuses a save rendered earlier than the one it keeps.
		const renderedAt = deps.now()
		const { response, source } = await respond(c, deps, url)
		const key = snapshotKey(url)
		if (source === null || key === null || response.status !== 200 || response.body === null) {
			return response
		}
		const body = await response.text()
		const contentType = response.headers.get('content-type') ?? 'application/json'
		c.executionCtx.waitUntil(
			saveSnapshot(deps.store(c.env), deps.build(c.env), key, { contentType, body }, source, renderedAt)
		)
		return new Response(body, response)
	}
}

// source: what the answer was rendered from, or null when the answer is not kept. Only canonical requests are kept:
// WebFinger keeps only the acct: URI and the actor URI of the stored username, so the rows stay bounded by the number
// of actors.
type Answer = { response: Response; source: SnapshotSource | null }

async function respond(c: Context<FederationEnv>, deps: FederationRouteDeps, url: URL): Promise<Answer> {
	switch (url.pathname) {
		case '/.well-known/nodeinfo':
			return { response: nodeInfoLinks(c.get('domain')), source: { kind: 'static' } }
		case '/nodeinfo/2.0':
			return nodeInfo20(c, deps)
		default:
			return LEGACY_OBJECT.test(url.pathname) ? objectOrAlias(c, deps, url) : viaFedify(c, deps, url)
	}
}

const LEGACY_OBJECT = /^\/ap\/o\/[0-9A-Za-z-]{1,64}$/

// /ap/o/<uuid>: a local status's Note (Fedify), else a legacy alias the cutover kept (domain/activities.ts,
// getLegacyObject). A remote proxy alias moves to the original for any client; an image is a document for ActivityPub
// clients only, as a Note is. Neither is kept as a snapshot.
async function objectOrAlias(c: Context<FederationEnv>, deps: FederationRouteDeps, url: URL): Promise<Answer> {
	const answer = await viaFedify(c, deps, url)
	if (answer.response.status !== 404 && answer.response.status !== 406) {
		return answer
	}
	const uuid = url.pathname.slice('/ap/o/'.length)
	const origin = `https://${c.get('domain')}`
	const alias = await callStore(() => deps.store(c.env).legacyObject(deps.build(c.env), { uuid, origin }))
	if (alias.location !== null) {
		return { response: new Response(null, { status: 301, headers: { location: alias.location } }), source: null }
	}
	if (alias.image !== null && answer.response.status === 404) {
		const response = new Response(alias.image, { headers: { 'content-type': 'application/activity+json' } })
		return { response, source: null }
	}
	return answer
}

async function viaFedify(c: Context<FederationEnv>, deps: FederationRouteDeps, url: URL): Promise<Answer> {
	const domain = c.get('domain')
	const config = readConfig(c.env)
	const { response, state } = await fetchFederation(
		{
			domain,
			build: deps.build(c.env),
			store: () => deps.store(c.env),
			kek: config.ok ? userKek(config.config) : '',
			now: deps.now,
			keygen: deps.keygen,
			loader: deps.loader,
		},
		c.req.raw,
		url
	)
	if (state.storeError !== null) {
		throw state.storeError
	}
	// An actor path counts only once the dispatcher has matched a local actor; /actor and NodeInfo are fixed.
	// Fedify decodes the path and parses the resource its own way, so the raw request must spell the canonical form
	// exactly: '/ap/users/Ali%63e' or a trailing-slash variant would otherwise each add a row for the same actor.
	const canonical =
		url.pathname === '/.well-known/webfinger'
			? canonicalWebFinger(url, domain, state.resolvedUsername)
			: url.pathname.startsWith('/ap/users/')
				? state.resolvedUsername !== null && url.pathname === `/ap/users/${state.resolvedUsername}`
				: true
	return { response, source: canonical ? state.source : null }
}

// One federation GET through Kopje's Fedify dispatchers, on the fixed domain. Shared by the Worker and the cutover's
// maintenance worker (src/maintenance-worker.ts), so both render actor documents and WebFinger the same way. A Store
// failure is left in state.storeError for the caller.
export async function fetchFederation(
	deps: FederationDeps,
	raw: Request,
	url: URL
): Promise<{ response: Response; state: FederationState }> {
	const state: FederationState = { resolvedUsername: null, source: null, storeError: null }
	const federation = createKopjeFederation(deps, state)
	// Fedify builds collection page links from the request URL, so the request is put on the fixed domain first.
	const request = new Request(new URL(`${url.pathname}${url.search}`, `https://${deps.domain}`), raw)
	const response = await federation.fetch(request, {
		contextData: state,
		onNotFound: () => new Response('Not Found', { status: 404 }),
		onNotAcceptable: () => new Response('Not Acceptable', { status: 406 }),
	})
	return { response, state }
}

function canonicalWebFinger(url: URL, domain: string, username: string | null): boolean {
	const resources = url.searchParams.getAll('resource')
	const resource = resources.length === 1 ? resources[0] : undefined
	return (
		username !== null &&
		(resource === `acct:${username}@${domain}` || resource === `https://${domain}/ap/users/${username}`)
	)
}

function nodeInfoLinks(domain: string): Response {
	return Response.json({
		links: [
			{ rel: NODEINFO_20, href: `https://${domain}/nodeinfo/2.0` },
			{ rel: NODEINFO_21, href: `https://${domain}/nodeinfo/2.1` },
		],
	})
}

// NodeInfo 2.0 is 2.1 without software.repository and software.homepage.
async function nodeInfo20(c: Context<FederationEnv>, deps: FederationRouteDeps): Promise<Answer> {
	const now = deps.now()
	const usage = await callStore(() => deps.store(c.env).nodeInfoUsage(deps.build(c.env), { now }))
	const info = nodeInfo(usage)
	const json = nodeInfoToJson({ ...info, software: { name: info.software.name, version: info.software.version } })
	const response = new Response(JSON.stringify({ ...(json as object), $schema: `${NODEINFO_20}#`, version: '2.0' }), {
		headers: { 'content-type': `application/json; profile="${NODEINFO_20}#"` },
	})
	return { response, source: { kind: 'nodeinfo', now, rendered: JSON.stringify(usage) } }
}
