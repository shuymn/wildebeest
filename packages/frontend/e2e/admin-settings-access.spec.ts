// Runs the built Pages worker (`dist/_worker.js`) in workerd to prove that only an instance admin
// can read or write the server settings, through both the route loaders and the route actions.
//
// Cloudflare Access is replaced by a local signing key: the worker fetches the Access certs through
// Miniflare's outbound service, so a signed `CF_Authorization` cookie authenticates any mock user.
//
// Requires `pnpm run build` and `pnpm run database:create-mock`. The mock database is copied, never
// modified.
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const origin = 'http://0.0.0.0'
const accessDomain = '0.0.0.0.cloudflareaccess.com'
const accessAud = 'DEV_AUD'
const kid = 'e2e-access-key'
const databaseId = '83821907-97fd-44b4-8f21-e3d6b736e7ef'

type Identity = 'anonymous' | 'non-admin' | 'admin'
const emails: Record<Exclude<Identity, 'anonymous'>, string> = {
	'non-admin': 'Ben@test.email',
	admin: 'george@test.email',
}

const loaderPaths = [
	'/settings/server-settings/branding',
	'/settings/server-settings/about',
	'/settings/server-settings/rules',
	'/settings/server-settings/rules/edit/1',
	'/settings/migration',
]

// Every server settings form, and a payload that would change the stored state.
const actionForms: { path: string; form: Record<string, string> }[] = [
	{ path: '/settings/server-settings/branding', form: { 'server name': 'pwned', 'server description': 'pwned' } },
	{ path: '/settings/server-settings/about', form: { 'extended description': 'pwned', 'privacy policy': 'pwned' } },
	{ path: '/settings/server-settings/rules', form: { text: 'pwned' } },
	{ path: '/settings/server-settings/rules/edit/1', form: { id: '1', text: 'pwned' } },
]

// The rule edit page never renders for the admin either (see above), so its action id cannot be read
// from the page. The layout `onRequest` guard runs before Qwik looks the action up.
const unrenderedActionPaths = new Set(['/settings/server-settings/rules/edit/1'])

const base64url = (data: ArrayBuffer | string) =>
	Buffer.from(typeof data === 'string' ? data : new Uint8Array(data)).toString('base64url')

async function startWorker(options: { routeAllMethodsToQwik: boolean }) {
	const keys = (await crypto.subtle.generateKey(
		{ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
		true,
		['sign', 'verify']
	)) as CryptoKeyPair
	const jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid, alg: 'RS256' }

	const bundle = await build({
		entryPoints: [join(root, 'packages/frontend/dist/_worker.js')],
		bundle: true,
		format: 'esm',
		platform: 'neutral',
		mainFields: ['module', 'main'],
		write: false,
		logLevel: 'error',
	})
	let script = bundle.outputFiles[0].text
	if (options.routeAllMethodsToQwik) {
		// Production routes only GET to Qwik. Routing every method to it shows that the actions
		// themselves are guarded and do not depend on that routing.
		const routed = script.replace(/\.get\("\*",\s*(\w+\(\{\s*render:)/, '.all("*", $1')
		expect(routed !== script, 'the Qwik GET route was not found in the worker bundle').toBe(true)
		script = routed
	}

	const persist = mkdtempSync(join(tmpdir(), 'wildebeest-e2e-d1-'))
	cpSync(join(root, '.wrangler/state/v3/d1'), persist, { recursive: true })

	const mf: Miniflare = new Miniflare({
		modules: [{ type: 'ESModule', path: join(root, 'packages/frontend/dist/_e2e_worker.mjs'), contents: script }],
		compatibilityDate: '2022-12-20',
		d1Databases: { DATABASE: databaseId },
		d1Persist: persist,
		bindings: {
			DOMAIN: '0.0.0.0',
			INSTANCE_TITLE: 'Test Wildebeest',
			INSTANCE_DESCR: 'My Wildebeest Instance',
			ACCESS_AUTH_DOMAIN: accessDomain,
			ACCESS_AUD: accessAud,
			ADMIN_EMAIL: 'george@test.email',
			userKEK: 'test-kek',
		},
		outboundService: async (request) => {
			const url = new URL(request.url)
			if (url.origin === `https://${accessDomain}` && url.pathname === '/cdn-cgi/access/certs') {
				return Response.json({ keys: [jwk] })
			}
			if (url.origin === origin) {
				// the frontend loaders call the instance's own API
				return mf.dispatchFetch(request)
			}
			return new Response('unexpected outbound request', { status: 599 })
		},
	})

	async function cookieFor(identity: Identity): Promise<string | undefined> {
		if (identity === 'anonymous') {
			return undefined
		}
		const now = Math.floor(Date.now() / 1000)
		const header = base64url(JSON.stringify({ alg: 'RS256', kid }))
		const payload = base64url(
			JSON.stringify({
				aud: [accessAud],
				email: emails[identity],
				exp: now + 600,
				iat: now,
				iss: `https://${accessDomain}`,
				sub: emails[identity],
			})
		)
		const signature = await crypto.subtle.sign(
			'RSASSA-PKCS1-v1_5',
			keys.privateKey,
			new TextEncoder().encode(`${header}.${payload}`)
		)
		return `CF_Authorization=${header}.${payload}.${base64url(signature)}`
	}

	async function request(
		identity: Identity,
		path: string,
		init: { method?: string; form?: Record<string, string> } = {}
	) {
		const headers: Record<string, string> = { origin }
		const cookie = await cookieFor(identity)
		if (cookie) {
			headers.cookie = cookie
		}
		const body = init.form ? new URLSearchParams(init.form).toString() : undefined
		if (body) {
			headers['content-type'] = 'application/x-www-form-urlencoded'
		}
		const response = await mf.dispatchFetch(origin + path, {
			method: init.method ?? 'GET',
			headers,
			body,
			redirect: 'manual',
		})
		return { status: response.status, text: await response.text() }
	}

	async function storedState(): Promise<string> {
		const db = await mf.getD1Database('DATABASE')
		const settings = await db.prepare('SELECT setting_name, setting_value FROM server_settings ORDER BY 1').all()
		const rules = await db.prepare('SELECT id, text FROM server_rules ORDER BY id').all()
		return JSON.stringify([settings.results, rules.results])
	}

	// Action ids are only rendered for an admin, in each form's `action` attribute.
	async function actionId(path: string): Promise<string> {
		const page = await request('admin', path)
		expect(page.status).toEqual(200)
		const match = page.text.match(/\?qaction=([\w-]+)/)
		expect(match, `no action form on ${path}`).not.toBeNull()
		return match![1]
	}

	async function dispose() {
		await mf.dispose()
		rmSync(persist, { recursive: true, force: true })
	}

	return { request, storedState, actionId, dispose }
}

test.describe('server settings access', () => {
	// The worker is driven directly, without a browser: run it once, in the Chromium project.
	test.skip(() => test.info().project.name !== 'chromium')
	test.describe.configure({ mode: 'serial', timeout: 120 * 1000 })

	for (const routeAllMethodsToQwik of [false, true]) {
		const routing = routeAllMethodsToQwik ? 'every method routed to Qwik' : 'production routing'

		test(`only an admin can read or write the server settings (${routing})`, async () => {
			const worker = await startWorker({ routeAllMethodsToQwik })
			try {
				for (const path of loaderPaths) {
					for (const loader of [path, `${path}/q-data.json`]) {
						expect((await worker.request('anonymous', loader)).status, `anonymous GET ${loader}`).toEqual(401)
						expect((await worker.request('non-admin', loader)).status, `non-admin GET ${loader}`).toEqual(403)
						const admin = await worker.request('admin', loader)
						// The rule edit loader compares the numeric rule id with the string route param and
						// answers 404 to the admin too; that is past the guard.
						expect(admin.status, `admin GET ${loader}`).toEqual(path.includes('/rules/edit/') ? 404 : 200)
					}
				}
				// the admin can read the stored settings, nobody else gets them in a response
				const settingsPage = await worker.request('admin', '/settings/server-settings/about')
				expect(settingsPage.text).toContain('this is a test wildebeest instance!')

				const before = await worker.storedState()
				for (const { path, form } of actionForms) {
					const id = unrenderedActionPaths.has(path) ? 'unknown' : await worker.actionId(path)
					for (const target of [`${path}?qaction=${id}`, `${path}/q-data.json?qaction=${id}`]) {
						for (const identity of ['anonymous', 'non-admin'] as const) {
							const response = await worker.request(identity, target, { method: 'POST', form })
							expect(response.status, `${identity} POST ${target}`).toBeGreaterThanOrEqual(400)
							expect(response.text).not.toContain('this is a test wildebeest instance!')
						}
					}
				}
				expect(await worker.storedState()).toEqual(before)

				// Positive control: with every method routed to Qwik, the same action succeeds for the admin.
				if (routeAllMethodsToQwik) {
					const { path, form } = actionForms[0]
					const id = await worker.actionId(path)
					const response = await worker.request('admin', `${path}/q-data.json?qaction=${id}`, {
						method: 'POST',
						form,
					})
					expect(response.status).toEqual(200)
					expect(await worker.storedState()).toContain('pwned')
				}
			} finally {
				await worker.dispose()
			}
		})
	}
})
