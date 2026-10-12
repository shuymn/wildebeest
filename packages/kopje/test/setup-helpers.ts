import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

import { vi } from 'vitest'

import { type AccessTeam, accessTeam, type ApiHarness } from './api-helpers'
import { NOW, offline } from './app-helpers'
import { BUILD, migratedStore } from './helpers'
import { QueueSim } from './queue-sim'
import { ORIGIN, setCookies } from './web-helpers'
import { createApp } from '../src/app/app'
import { API_BASE } from '../src/platform/cloudflare-api'
import { type ImageCodec, ImageCodecError } from '../src/platform/images'
import type { StoreStub } from '../src/platform/store-client'

// Driving /setup as an operator's browser would, against a fake of the Cloudflare API (never the real one).

export const SETUP_TOKEN = 'setup-token-0123456789abcdefghijklmnopqrstuvwxyz'
export const SETUP = '__Host-kopje_setup'
export const ACCOUNT_ID = '0123456789abcdef0123456789abcdef'
export const SERVICE_TOKEN_CLIENT_ID = 'abc123.access'
export const ADMIN = 'owner@example.com'

type Item = Record<string, unknown> & { id: string; name: string }

export type FakeCloudflare = {
	fetch: ReturnType<typeof vi.fn<typeof fetch>>
	apps: Item[]
	policies: Item[]
	// Every API call: method, path and the bearer token it carried.
	calls: { method: string; path: string; token: string | null; body: unknown }[]
	// Makes the next API call fail, echoing the token in its error message as a careless API might.
	failNext: (status: number) => void
	accounts: { id: string; name: string }[]
	fightMode: boolean | null
}

// The Access API of one account (apps, reusable policies, service tokens, zones and Bot Management), plus the team's
// key set served by `team`. The sign-in application gets the team's AUD, so tokens of `team` sign in afterwards.
export function fakeCloudflare(team: AccessTeam): FakeCloudflare {
	const apps: Item[] = []
	const policies: Item[] = []
	const calls: FakeCloudflare['calls'] = []
	let failure: number | null = null
	let serial = 0
	const fake: FakeCloudflare = {
		apps,
		policies,
		calls,
		accounts: [{ id: ACCOUNT_ID, name: 'Operator' }],
		fightMode: false,
		failNext: (status) => {
			failure = status
		},
		fetch: vi.fn<typeof fetch>(async (input, init) => {
			const request = new Request(input, init)
			const url = new URL(request.url)
			if (!request.url.startsWith(API_BASE)) {
				return team.fetch(input, init)
			}
			const path = url.pathname.slice(new URL(API_BASE).pathname.length)
			const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? null
			const body = request.method === 'GET' ? undefined : await request.json()
			calls.push({ method: request.method, path, token, body })
			const ok = (result: unknown) => Response.json({ success: true, errors: [], result })
			if (failure !== null) {
				const status = failure
				failure = null
				return Response.json(
					{ success: false, errors: [{ code: 10000, message: `Authentication error for ${token}` }] },
					{ status }
				)
			}
			const base = `/accounts/${ACCOUNT_ID}/access`
			const collection = (items: Item[], prefix: string, make: (body: Item) => Item) => {
				if (request.method === 'GET' && path === prefix) {
					return ok(items)
				}
				if (request.method === 'POST' && path === prefix) {
					const item = make({ ...(body as Item), id: `id-${++serial}` })
					items.push(item)
					return ok(item)
				}
				const at = items.findIndex((item) => `${prefix}/${item.id}` === path)
				const existing = items[at]
				if (request.method === 'PUT' && existing !== undefined) {
					items[at] = { ...existing, ...(body as Item), id: existing.id }
					return ok(items[at])
				}
				return null
			}
			if (path === '/accounts' && request.method === 'GET') {
				return ok(fake.accounts)
			}
			if (path === `${base}/service_tokens` && request.method === 'GET') {
				return ok([{ id: 'token-uuid-1', client_id: SERVICE_TOKEN_CLIENT_ID, name: 'cli' }])
			}
			const answer =
				collection(policies, `${base}/policies`, (item) => item) ??
				collection(apps, `${base}/apps`, (item) => ({
					...item,
					aud: String(item.domain).endsWith('/oauth/authorize') ? team.aud : `admin-aud-${serial}`,
				}))
			if (answer !== null) {
				return answer
			}
			if (path === '/zones' && request.method === 'GET') {
				const name = url.searchParams.get('name')
				return ok(name === 'kopje.test' ? [{ id: 'zone-1', name }] : [])
			}
			if (path === '/zones/zone-1/bot_management' && request.method === 'GET') {
				if (fake.fightMode === null) {
					return Response.json({ success: false, errors: [{ code: 9109, message: 'Unauthorized' }] }, { status: 403 })
				}
				return ok({ fight_mode: fake.fightMode })
			}
			return Response.json({ success: false, errors: [{ code: 7003, message: 'No route' }] }, { status: 404 })
		}),
	}
	return fake
}

// A codec that answers like the Images binding: a WebP, or the given error code.
export function fakeImages(error: number | null = null): ImageCodec {
	const webp = new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ')
	return {
		info: () => Promise.resolve({ format: 'image/webp', width: 1, height: 1 }),
		encode: () => (error === null ? Promise.resolve(webp) : Promise.reject(new ImageCodecError(error, 'images'))),
	}
}

export type SetupHarness = Awaited<ReturnType<typeof setupHarness>>

export async function setupHarness(
	options: { overrides?: Record<string, unknown>; images?: ImageCodec; store?: StoreStub } = {}
) {
	const store = options.store ?? (await migratedStore())
	const team = await accessTeam()
	const cf = fakeCloudflare(team)
	const queue = new QueueSim()
	let counter = 0
	const testEnv = {
		...env,
		QUEUE: queue.queue,
		SETUP_TOKEN,
		...options.overrides,
	} as unknown as Env
	let clock = NOW
	const app = createApp({
		build: () => BUILD,
		now: () => clock,
		store: () => store,
		fetch: cf.fetch,
		federation: offline,
		randomToken: () => `token-${++counter}-${crypto.randomUUID()}`,
		images: () => options.images ?? fakeImages(),
		doorbell: () => Promise.resolve(),
	})
	const request = async (path: string, init?: RequestInit, origin = ORIGIN): Promise<Response> => {
		const ctx = createExecutionContext()
		const response = await app.fetch(new Request(`${origin}${path}`, init), testEnv, ctx)
		await waitOnExecutionContext(ctx)
		return response
	}
	const advance = (ms: number) => {
		clock += ms
	}
	// web-helpers' sign-in drives this harness like apiHarness: request and team are what it uses.
	const asApi = { store, team, request, env: testEnv } as unknown as ApiHarness
	return { store, team, cf, queue, request, env: testEnv, advance, asApi }
}

// A browser that entered the setup token: its Cookie header and the setup page's form token.
export type SetupBrowser = { cookie: string; secret: string }

export async function setupLogin(h: SetupHarness, token = SETUP_TOKEN): Promise<SetupBrowser> {
	const response = await h.request('/setup/login', {
		method: 'POST',
		headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ token }).toString(),
	})
	const secret = setCookies(response).values.get(SETUP)
	if (response.status !== 303 || secret === undefined) {
		throw new Error(`setup login failed: ${response.status}`)
	}
	return { cookie: `${SETUP}=${encodeURIComponent(secret)}`, secret }
}

export async function formToken(h: SetupHarness, cookie: string): Promise<string> {
	const page = await h.request('/setup', { headers: { cookie } })
	const token = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1]
	if (token === undefined) {
		throw new Error(`no form token on /setup (${page.status})`)
	}
	return token
}

// A form post from the setup page (origin null leaves the header out). The form token is fetched unless given.
export async function setupPost(
	h: SetupHarness,
	cookie: string,
	path: string,
	fields: Record<string, string> = {},
	options: { origin?: string | null; csrf?: string | null } = {}
): Promise<Response> {
	const origin = options.origin === undefined ? ORIGIN : options.origin
	const csrf = options.csrf === undefined ? await formToken(h, cookie) : options.csrf
	const headers: Record<string, string> = { cookie, 'content-type': 'application/x-www-form-urlencoded' }
	if (origin !== null) {
		headers.origin = origin
	}
	const body = new URLSearchParams({ ...fields, ...(csrf === null ? {} : { csrf }) })
	return h.request(path, { method: 'POST', headers, body: body.toString() })
}

export const API_TOKEN = 'cf-api-token-SECRET-0123456789abcdefghij'

export function accessFields(h: SetupHarness, apiToken = API_TOKEN, extra: Record<string, string> = {}) {
	return {
		team: h.team.teamDomain.split('.')[0] ?? '',
		admin_email: ADMIN,
		api_token: apiToken,
		...extra,
	}
}

// Steps 1, 3 and 7 for one setup browser.
export async function completeWizard(h: SetupHarness, browser: SetupBrowser, username = 'owner'): Promise<Response> {
	await setupPost(h, browser.cookie, '/setup/domain', { domain: 'kopje.test' })
	const access = await setupPost(h, browser.cookie, '/setup/access', accessFields(h))
	if (access.status !== 200) {
		throw new Error(`access step failed: ${access.status} ${await access.text()}`)
	}
	return setupPost(h, browser.cookie, '/setup/admin', { username, email: ADMIN })
}
