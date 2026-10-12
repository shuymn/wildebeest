// The Cloudflare API calls of /setup (B5b): checking the Zero Trust team, making the two Access applications and
// their policies, and reading Bot Fight Mode. Plain fetch against https://api.cloudflare.com/client/v4: a handful of
// endpoints does not need the official SDK, and the Worker stays within its size budget.
//
// SETUP-4: the API token lives only in the closure of one request's client. It is sent only to api.cloudflare.com as
// a bearer token, never stored, logged or returned, and every error message is built from the API's status and error
// codes with any occurrence of the token removed (CloudflareApiError).

export const API_BASE = 'https://api.cloudflare.com/client/v4'

// Pages of a listing read at most; 100 items each.
const MAX_PAGES = 10
const PER_PAGE = 100
const TIMEOUT_MS = 10_000

export class CloudflareApiError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message)
		this.name = 'CloudflareApiError'
	}
}

type Envelope<T> = {
	success?: boolean
	result?: T
	errors?: { code?: number; message?: string }[]
	result_info?: { total_pages?: number }
}

export type CloudflareApi = {
	get<T>(path: string, query?: Record<string, string>): Promise<T>
	list<T>(path: string, query?: Record<string, string>): Promise<T[]>
	send<T>(method: 'POST' | 'PUT', path: string, body: unknown): Promise<T>
}

// Removes the token from text that may echo it.
export function redact(text: string, token: string): string {
	return token === '' ? text : text.split(token).join('[redacted]')
}

export function cloudflareApi(token: string, fetcher: typeof fetch): CloudflareApi {
	async function call<T>(method: string, path: string, query: Record<string, string>, body?: unknown) {
		const url = new URL(`${API_BASE}${path}`)
		for (const [name, value] of Object.entries(query)) {
			url.searchParams.set(name, value)
		}
		let response: Response
		try {
			response = await fetcher(url.toString(), {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				// Workers have no 'error': a redirect answers 3xx, which is not ok.
				redirect: 'manual',
				signal: AbortSignal.timeout(TIMEOUT_MS),
			})
		} catch (error) {
			const reason = error instanceof Error ? error.name : 'error'
			throw new CloudflareApiError(0, `${method} ${path}: the Cloudflare API could not be reached (${reason})`)
		}
		let envelope: Envelope<T>
		try {
			envelope = (await response.json()) as Envelope<T>
		} catch {
			throw new CloudflareApiError(response.status, `${method} ${path}: HTTP ${response.status}`)
		}
		if (!response.ok || envelope.success !== true || envelope.result === undefined) {
			const errors = (envelope.errors ?? [])
				.slice(0, 3)
				.map((e) => `${e.code ?? '?'} ${String(e.message ?? '').slice(0, 200)}`)
				.join('; ')
			const message = `${method} ${path}: HTTP ${response.status}${errors === '' ? '' : ` (${errors})`}`
			throw new CloudflareApiError(response.status, redact(message, token))
		}
		return envelope
	}
	return {
		async get<T>(path: string, query: Record<string, string> = {}) {
			return (await call<T>('GET', path, query)).result as T
		},
		async list<T>(path: string, query: Record<string, string> = {}) {
			const items: T[] = []
			for (let page = 1; page <= MAX_PAGES; page++) {
				const envelope = await call<T[]>('GET', path, { ...query, page: String(page), per_page: String(PER_PAGE) })
				const result = envelope.result ?? []
				items.push(...result)
				const total = envelope.result_info?.total_pages
				if (result.length < PER_PAGE || total === undefined || page >= total) {
					break
				}
			}
			return items
		},
		async send<T>(method: 'POST' | 'PUT', path: string, body: unknown) {
			return (await call<T>(method, path, {}, body)).result as T
		},
	}
}

// ---- step 2: the Zero Trust team

// A team name (the first label of <team>.cloudflareaccess.com) or the whole team domain.
export function teamDomainOf(input: string): string | null {
	const name = input
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, '')
		.replace(/\/+$/, '')
		.replace(/\.cloudflareaccess\.com$/, '')
	return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name) ? `${name}.cloudflareaccess.com` : null
}

// The team exists when its key set (what security/access-jwt.ts verifies against) lists a key.
export async function checkTeam(teamDomain: string, fetcher: typeof fetch): Promise<string | null> {
	try {
		const response = await fetcher(`https://${teamDomain}/cdn-cgi/access/certs`, {
			// Workers have no 'error': a redirect answers 3xx, which is not ok.
			redirect: 'manual',
			signal: AbortSignal.timeout(TIMEOUT_MS),
		})
		if (!response.ok) {
			return `the team's key set answered HTTP ${response.status}`
		}
		const body = (await response.json()) as { keys?: unknown }
		return Array.isArray(body.keys) && body.keys.length > 0 ? null : "the team's key set lists no keys"
	} catch {
		return "the team's key set could not be read"
	}
}

// ---- step 3: the Access applications

type Account = { id: string; name?: string }
type Policy = { id: string; name: string }
type App = { id: string; name: string; aud?: string }
type ServiceToken = { id: string; client_id?: string }

export type AccessPlan = {
	domain: string
	adminEmail: string
	// The account to use; null finds it (the token must then reach exactly one account).
	accountId: string | null
	serviceTokenClientId: string | null
}

export type AccessResult = { accountId: string; signInAud: string; adminAud: string }

// Names that identify Kopje's objects for this domain, so a run again reconciles them instead of adding copies.
export function accessNames(domain: string) {
	return {
		adminPolicy: `Kopje ${domain} admin`,
		cliPolicy: `Kopje ${domain} admin CLI`,
		signInApp: `Kopje ${domain} sign-in`,
		adminApp: `Kopje ${domain} admin`,
	}
}

const ACCOUNT_ID = /^[0-9a-f]{32}$/

async function findAccount(api: CloudflareApi, given: string | null): Promise<string> {
	if (given !== null) {
		if (!ACCOUNT_ID.test(given)) {
			throw new CloudflareApiError(400, 'the account ID must be 32 hexadecimal characters')
		}
		return given
	}
	const accounts = await api.list<Account>('/accounts')
	const [only] = accounts
	if (accounts.length !== 1 || only === undefined) {
		throw new CloudflareApiError(
			400,
			`the token reaches ${accounts.length} accounts; enter the account ID of the one to use`
		)
	}
	return only.id
}

async function upsert<T extends { id: string; name: string }>(
	api: CloudflareApi,
	collection: string,
	existing: T[],
	body: { name: string } & Record<string, unknown>
): Promise<T> {
	const found = existing.find((item) => item.name === body.name)
	return found === undefined
		? api.send<T>('POST', collection, body)
		: api.send<T>('PUT', `${collection}/${found.id}`, body)
}

// Creates or updates (by name) the reusable policies and the two self-hosted applications:
//   sign-in: <domain>/oauth/authorize, admitting the admin's email;
//   admin:   <domain>/admin, admitting the admin's email and, when given, the admin CLI's service token.
// Returns their AUD tags. Running it again with a fresh token updates the same objects.
export async function reconcileAccess(api: CloudflareApi, plan: AccessPlan): Promise<AccessResult> {
	const accountId = await findAccount(api, plan.accountId)
	const base = `/accounts/${accountId}/access`
	const names = accessNames(plan.domain)

	let tokenId: string | null = null
	if (plan.serviceTokenClientId !== null) {
		const tokens = await api.list<ServiceToken>(`${base}/service_tokens`)
		tokenId = tokens.find((t) => t.client_id === plan.serviceTokenClientId)?.id ?? null
		if (tokenId === null) {
			throw new CloudflareApiError(404, 'no service token of this account has that client ID')
		}
	}

	const policies = await api.list<Policy>(`${base}/policies`)
	const admin = await upsert(api, `${base}/policies`, policies, {
		name: names.adminPolicy,
		decision: 'allow',
		include: [{ email: { email: plan.adminEmail } }],
		exclude: [],
		require: [],
	})
	const adminPolicies = [{ id: admin.id, precedence: 1 }]
	if (tokenId !== null) {
		const cli = await upsert(api, `${base}/policies`, policies, {
			name: names.cliPolicy,
			decision: 'non_identity',
			include: [{ service_token: { token_id: tokenId } }],
			exclude: [],
			require: [],
		})
		adminPolicies.push({ id: cli.id, precedence: 2 })
	}

	const apps = await api.list<App>(`${base}/apps`)
	const app = (name: string, path: string, policies: { id: string; precedence: number }[]) =>
		upsert(api, `${base}/apps`, apps, {
			name,
			type: 'self_hosted',
			domain: `${plan.domain}${path}`,
			destinations: [{ type: 'public', uri: `${plan.domain}${path}` }],
			session_duration: '24h',
			app_launcher_visible: false,
			policies,
		})
	const signIn = await app(names.signInApp, '/oauth/authorize', [{ id: admin.id, precedence: 1 }])
	const adminApp = await app(names.adminApp, '/admin', adminPolicies)
	if (typeof signIn.aud !== 'string' || typeof adminApp.aud !== 'string') {
		throw new CloudflareApiError(502, 'the Cloudflare API returned an application without an AUD tag')
	}
	return { accountId, signInAud: signIn.aud, adminAud: adminApp.aud }
}

// ---- step 6: Bot Fight Mode

type Zone = { id: string; name: string }

// on/off when the token can read the zone and its bot settings; unknown otherwise (the static warning stands).
export async function botFightMode(
	api: CloudflareApi,
	domain: string
): Promise<{ state: 'on' | 'off' | 'unknown'; reason: string | null }> {
	try {
		const labels = domain.split('.')
		let zone: Zone | undefined
		for (let i = 0; i < labels.length - 1 && zone === undefined; i++) {
			const name = labels.slice(i).join('.')
			zone = (await api.get<Zone[]>('/zones', { name })).find((z) => z.name === name)
		}
		if (zone === undefined) {
			return { state: 'unknown', reason: 'the token sees no zone for this domain' }
		}
		const settings = await api.get<{ fight_mode?: boolean }>(`/zones/${zone.id}/bot_management`)
		return { state: settings.fight_mode === true ? 'on' : 'off', reason: null }
	} catch (error) {
		if (error instanceof CloudflareApiError) {
			return { state: 'unknown', reason: error.message }
		}
		throw error
	}
}
