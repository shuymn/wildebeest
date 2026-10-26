import { type ApiHarness } from './api-helpers'
import type { PageCursor, Paging } from '../src/domain/web-pages/paging'
import type { ProfileTab } from '../src/domain/web-pages/profile'

// Driving the web UI as a browser would: the sign-in through /login, the consent page behind Access and the callback,
// with cookies carried by hand. ORIGIN is the instance origin the harness serves.

export const ORIGIN = 'https://kopje.test'

export type Browser = { session: string; cookie: string }

// Name and value of each cookie a response sets, and the raw Set-Cookie lines.
export function setCookies(response: Response): { values: Map<string, string>; lines: string[] } {
	// Workers keeps each Set-Cookie line apart under getAll.
	const lines = response.headers.getAll('set-cookie')
	const values = new Map<string, string>()
	for (const line of lines) {
		const [pair = ''] = line.split(';')
		const at = pair.indexOf('=')
		values.set(pair.slice(0, at), decodeURIComponent(pair.slice(at + 1)))
	}
	return { values, lines }
}

export const SESSION = '__Host-kopje_session'
export const LOGIN = '__Host-kopje_login'

export function cookieHeader(cookies: Record<string, string>): string {
	return Object.entries(cookies)
		.map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
		.join('; ')
}

export type SignIn = {
	login: Response
	loginCookie: string
	authorize: URL
	consent: Response
	approved: Response
	callback: URL
	// Submits the consent form again: a second code for the same sign-in attempt.
	approveAgain: () => Promise<URL>
}

// /login, then the consent page and its approval as the given Access identity, up to (not including) the callback.
// `browser` is the session the browser already has, which /login sees as its cookie.
export async function startSignIn(
	h: ApiHarness,
	email = 'alice@example.com',
	returnTo?: string,
	browser?: Browser
): Promise<SignIn> {
	const login = await h.request(returnTo === undefined ? '/login' : `/login?return=${encodeURIComponent(returnTo)}`, {
		headers: browser === undefined ? {} : { cookie: browser.cookie },
	})
	if (login.status !== 302) {
		throw new Error(`login failed: ${login.status} ${await login.text()}`)
	}
	const loginCookie = setCookies(login).values.get(LOGIN) ?? ''
	const authorize = new URL(login.headers.get('location') ?? '', ORIGIN)
	const assertion = await h.team.assertion({ email })
	const consent = await h.request(`${authorize.pathname}${authorize.search}`, {
		headers: { 'cf-access-jwt-assertion': assertion },
	})
	const html = await consent.clone().text()
	const fields = new URLSearchParams()
	for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)) {
		fields.set(match[1] ?? '', (match[2] ?? '').replaceAll('&amp;', '&'))
	}
	fields.set('decision', 'approve')
	const approve = () =>
		h.request('/oauth/authorize', {
			method: 'POST',
			headers: {
				'cf-access-jwt-assertion': assertion,
				origin: ORIGIN,
				'content-type': 'application/x-www-form-urlencoded',
			},
			body: fields.toString(),
		})
	const approved = await approve()
	const callback = new URL(approved.headers.get('location') ?? '', ORIGIN)
	const approveAgain = async () => new URL((await approve()).headers.get('location') ?? '', ORIGIN)
	return { login, loginCookie, authorize, consent, approved, callback, approveAgain }
}

export function callback(h: ApiHarness, url: URL, cookies: Record<string, string>): Promise<Response> {
	return h.request(`${url.pathname}${url.search}`, { headers: { cookie: cookieHeader(cookies) } })
}

// A signed-in browser: the session cookie's value and the Cookie header that carries it.
export async function signIn(h: ApiHarness, email = 'alice@example.com'): Promise<Browser> {
	const started = await startSignIn(h, email)
	const response = await callback(h, started.callback, { [LOGIN]: started.loginCookie })
	const session = setCookies(response).values.get(SESSION)
	if (response.status !== 303 || session === undefined) {
		throw new Error(`callback failed: ${response.status} ${await response.text()}`)
	}
	return { session, cookie: cookieHeader({ [SESSION]: session }) }
}

// The anti-forgery token of the settings page this browser sees.
export async function csrfOf(h: ApiHarness, browser: Browser): Promise<string> {
	const page = await h.request('/settings', { headers: { cookie: browser.cookie } })
	const token = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1]
	if (token === undefined) {
		throw new Error(`no csrf token on the settings page (${page.status})`)
	}
	return token
}

// A form post from a page of this origin (override origin to test WEB-1; null leaves the header out).
export function postForm(
	h: ApiHarness,
	browser: Browser,
	path: string,
	fields: Record<string, string> | URLSearchParams,
	origin: string | null = ORIGIN
): Promise<Response> {
	const headers: Record<string, string> = {
		cookie: browser.cookie,
		'content-type': 'application/x-www-form-urlencoded',
	}
	if (origin !== null) {
		headers.origin = origin
	}
	return h.request(path, { method: 'POST', headers, body: new URLSearchParams(fields).toString() })
}

// The input of a profile read of the Posts tab older than `maxId`, or of its first page.
export function postsTab(
	handle: string,
	maxId: string | null,
	now: number
): { handle: string; tab: ProfileTab; cursor: PageCursor; now: number } {
	return { handle, tab: { kind: 'posts' }, cursor: maxId === null ? null : { maxId }, now }
}

// The older page's max_id a profile read offers (design §4): its oldest end, when more lies past it.
export function olderOf(page: { paging: Paging }): string | null {
	return page.paging.more ? page.paging.oldest : null
}
