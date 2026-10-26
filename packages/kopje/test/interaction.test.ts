import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { apiHarness, seedAccount, sql } from './api-helpers'
import { countingStore, NOW, seedInstanceKey } from './app-helpers'
import { fixtureKeyGen } from './federation-helpers'
import { BUILD } from './helpers'
import { MASTODON, mastodonActor, RemoteWeb } from './inbox-helpers'
import { AS, mastodonNote } from './inbox-status-helpers'
import { quoting } from './quote-helpers'
import { plannedRun } from './read-helpers'
import { seedStatus } from './status-helpers'
import { attr, parseHtml, query, text } from './web-dom'
import {
	type Browser,
	callback,
	cookieHeader,
	csrfOf,
	LOGIN,
	ORIGIN,
	postForm,
	SESSION,
	setCookies,
	signIn,
	startSignInAt,
} from './web-helpers'
import { webFollow } from '../src/domain/interaction'
import { INTERACTION_TARGET_BYTES, interactionTarget, SESSION_LIFETIME_MS } from '../src/domain/web-session'
import type { StoreStub } from '../src/platform/store-client'
import { sha256Hex } from '../src/security/tokens'
import { csrfToken } from '../src/web/session'

// /authorize_interaction (design §8; WEB-1, WEB-2, WEB-4, VIS-4, AUTH-8): the look-up form, the sign-in round trip
// that keeps its target, the look-up that fetches and stores what it finds and shows only what an anonymous viewer may
// see, the follow and its outcomes, and the wakeups after each (design amendment A4).

const PRIVATE_HEADERS = {
	'cache-control': 'no-store',
	'content-security-policy':
		"default-src 'none'; style-src 'self'; img-src 'self' https:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
	'x-frame-options': 'DENY',
	'referrer-policy': 'same-origin',
}

async function world(options: { wrapStore?: (store: StoreStub) => StoreStub } = {}) {
	const web = new RemoteWeb()
	const h = await apiHarness({}, { federation: { keygen: fixtureKeyGen, loader: web.loader }, ...options })
	const aliceId = await seedAccount(h.store, { username: 'alice', email: 'alice@example.com', displayName: 'Alice' })
	const bob = await mastodonActor(web, 'bob')
	return { ...h, web, aliceId, bob }
}

type World = Awaited<ReturnType<typeof world>>

// bob's public Note, served at `id` (a path with an encoded slash, by default).
function servedNote(t: World, extra: Record<string, unknown> = {}) {
	const note = mastodonNote(t.bob, { id: `${t.bob.uri}/statuses/a%2Fb`, content: '<p>the note</p>', ...extra })
	t.web.serve(note.id, { '@context': AS, ...note })
	return note
}

// Every row of every table, to show that a request wrote nothing.
function everyRow(store: StoreStub): Promise<string> {
	return runInDurableObject(store, (_instance, state) =>
		state.storage.sql
			.exec<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'"
			)
			.toArray()
			.map(({ name }) => `${name}: ${JSON.stringify(state.storage.sql.exec(`SELECT * FROM "${name}"`).toArray())}`)
			.join('\n')
	)
}

// The fields of the page's form posting to `action`, as a browser submits them.
function formOf(html: string, action: string): URLSearchParams {
	const form = query(parseHtml(html), 'form').find((f) => attr(f, 'action') === action)
	if (form === undefined) {
		throw new Error(`no form posting to ${action}`)
	}
	const fields = new URLSearchParams()
	for (const input of query(form, 'input')) {
		fields.append(attr(input, 'name') ?? '', attr(input, 'value') ?? '')
	}
	return fields
}

function headersOf(response: Response) {
	return Object.fromEntries(Object.keys(PRIVATE_HEADERS).map((name) => [name, response.headers.get(name)]))
}

async function lookUpForm(t: World, browser: Browser | null, uri: string) {
	const page = await t.request(`/authorize_interaction?uri=${encodeURIComponent(uri)}`, {
		headers: browser === null ? {} : { cookie: browser.cookie },
	})
	expect(page.status).toBe(200)
	return formOf(await page.text(), '/authorize_interaction')
}

// A look-up posted from the form the page emits, and the follow form of what it found.
async function lookUp(t: World, browser: Browser, uri: string) {
	const response = await postForm(t, browser, '/authorize_interaction', await lookUpForm(t, browser, uri))
	const html = await response.text()
	return { response, html }
}

describe('GET /authorize_interaction (WEB-4)', () => {
	it('renders the look-up form, prefilled and with the session’s token, and fetches, stores and follows nothing', async () => {
		const t = await world()
		const note = servedNote(t)
		const browser = await signIn(t)
		const before = await everyRow(t.store)
		const signedOut = await t.request(`/authorize_interaction?uri=${encodeURIComponent(note.id)}`)
		const signedIn = await t.request(`/authorize_interaction?uri=${encodeURIComponent(note.id)}`, {
			headers: { cookie: browser.cookie },
		})
		for (const response of [signedOut, signedIn]) {
			expect(response.status).toBe(200)
			expect(headersOf(response)).toEqual(PRIVATE_HEADERS)
			expect(response.headers.get('access-control-allow-origin')).toBeNull()
		}
		const outForm = formOf(await signedOut.text(), '/authorize_interaction')
		expect([...outForm]).toEqual([['uri', note.id]])
		const html = await signedIn.text()
		const inForm = formOf(html, '/authorize_interaction')
		expect(inForm.get('uri')).toBe(note.id)
		expect(inForm.get('csrf')).toMatch(/^[\w-]{43}$/)
		// The field (amendment A7): a URL keyboard, no spellcheck, no autocomplete="off".
		const field = query(parseHtml(html), 'input').find((input) => attr(input, 'name') === 'uri')!
		expect([attr(field, 'inputmode'), attr(field, 'spellcheck'), attr(field, 'autocomplete')]).toEqual([
			'url',
			'false',
			null,
		])
		// Mastodon's acct parameter prefills the same field.
		expect(
			formOf(
				await (await t.request('/authorize_interaction?acct=acct:bob@mastodon.example')).text(),
				'/authorize_interaction'
			).get('uri')
		).toBe('bob@mastodon.example')
		expect(t.web.fetched).toEqual([])
		expect(await everyRow(t.store)).toBe(before)
		expect(t.doorbell).not.toHaveBeenCalled()
		expect(t.jobs).not.toHaveBeenCalled()
	})

	it('prefills only a bounded http(s) URL or address', async () => {
		const t = await world()
		const prefill = async (uri: string) =>
			formOf(
				await (await t.request(`/authorize_interaction?uri=${encodeURIComponent(uri)}`)).text(),
				'/authorize_interaction'
			).get('uri')
		expect(await prefill('@bob@mastodon.example')).toBe('@bob@mastodon.example')
		for (const refused of ['javascript:alert(1)', 'https://a.example/ b', 'https://a.example/\u0000', 'bob', 'x@y@z']) {
			expect(await prefill(refused), refused).toBe('')
		}
	})
})

describe('the interaction target (UTF-8 bytes)', () => {
	it('accepts INTERACTION_TARGET_BYTES and refuses one byte more, NUL and astral characters counted in bytes', () => {
		const base = 'https://a.example/'
		// Four bytes each: 2,048 bytes is the base and 507 astral characters and two ASCII ones.
		const astral = '\u{1F600}'.repeat(Math.floor((INTERACTION_TARGET_BYTES - base.length) / 4))
		const fill = 'x'.repeat(INTERACTION_TARGET_BYTES - base.length - astral.length * 2)
		const atBound = `${base}${astral}${fill}`
		expect(new TextEncoder().encode(atBound).length).toBe(INTERACTION_TARGET_BYTES)
		expect(interactionTarget(atBound)).toBe(atBound)
		expect(interactionTarget(`${atBound}x`)).toBeNull()
		expect(interactionTarget(`${base}\u0000`)).toBeNull()
		expect(interactionTarget('acct:bob@mastodon.example')).toBe('acct:bob@mastodon.example')
		expect(interactionTarget('ftp://a.example/')).toBeNull()
	})
})

describe('the sign-in round trip (WEB-4)', () => {
	it('keeps a URL target with an encoded slash through sign-in, and looks it up from the form it returns to', async () => {
		const t = await world()
		const note = servedNote(t)
		expect(note.id).toContain('%2F')
		// The form a signed-out browser gets, posted from this origin: to sign in, with the target.
		const form = await lookUpForm(t, null, note.id)
		const posted = await t.request('/authorize_interaction', {
			method: 'POST',
			headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
			body: form.toString(),
		})
		expect(posted.status).toBe(303)
		const login = posted.headers.get('location')!
		expect(login).toBe(
			`/login?${new URLSearchParams({ return: '/authorize_interaction', interaction: note.id }).toString()}`
		)
		expect(t.web.fetched).toEqual([])
		// The attempt keeps the target; the return path stays the fixed path.
		const started = await startSignInAt(t, login)
		const attempts = await sql<{ value: string }>(
			t.store,
			"SELECT value FROM kopje_state WHERE name LIKE 'web_login:%'"
		)
		expect(attempts.map((row) => JSON.parse(row.value) as unknown)).toMatchObject([
			{ returnTo: '/authorize_interaction', interaction: note.id },
		])
		const back = await callback(t, started.callback, { [LOGIN]: started.loginCookie })
		expect(back.status).toBe(303)
		expect(back.headers.get('location')).toBe(`/authorize_interaction?uri=${encodeURIComponent(note.id)}`)
		const sessionCookie = setCookies(back).values.get(SESSION)!
		const browser = { session: sessionCookie, cookie: cookieHeader({ [SESSION]: sessionCookie }) }

		// The page it returns to, prefilled with a fresh token; the look-up posted from it finds the note.
		const page = await t.request(back.headers.get('location')!, { headers: { cookie: browser.cookie } })
		const fields = formOf(await page.text(), '/authorize_interaction')
		expect(fields.get('uri')).toBe(note.id)
		const found = await postForm(t, browser, '/authorize_interaction', fields)
		expect(found.status).toBe(200)
		expect(headersOf(found)).toEqual(PRIVATE_HEADERS)
		const html = await found.text()
		expect(html).toContain('the note')
		expect(t.web.fetched).toContain(note.id)
		expect(await sql(t.store, 'SELECT visibility FROM statuses WHERE uri = ?', note.id)).toEqual([
			{ visibility: 'public' },
		])
		// The follow form names the author and returns to the same target.
		const follow = formOf(html, '/authorize_interaction/follow')
		expect(follow.get('uri')).toBe(note.id)
		const bobId = (await sql<{ id: string }>(t.store, 'SELECT id FROM accounts WHERE uri = ?', t.bob.uri))[0]?.id
		expect(follow.get('account_id')).toBe(bobId)
	})

	it('stores no target that is not a bounded URL or address, nor one for another return path', async () => {
		const t = await world()
		// Where the callback goes, and the target the attempt kept until then.
		const attempt = async (path: string) => {
			const started = await startSignInAt(t, path)
			const kept = await sql<{ value: string }>(t.store, "SELECT value FROM kopje_state WHERE name LIKE 'web_login:%'")
			const back = await callback(t, started.callback, { [LOGIN]: started.loginCookie })
			const { interaction } = JSON.parse(kept[0]?.value ?? '{}') as { interaction?: string | null }
			return [back.headers.get('location'), interaction]
		}
		const base = 'https://a.example/'
		const long = `${base}${'x'.repeat(INTERACTION_TARGET_BYTES - base.length + 1)}`
		for (const interaction of ['javascript:alert(1)', long, `${base}\u0000`, `${base} x`]) {
			const path = `/login?${new URLSearchParams({ return: '/authorize_interaction', interaction }).toString()}`
			expect(await attempt(path), interaction).toEqual(['/authorize_interaction', null])
		}
		const elsewhere = `/login?${new URLSearchParams({ return: '/settings', interaction: `${base}x` }).toString()}`
		expect(await attempt(elsewhere)).toEqual(['/settings', null])
		// The guard ran: the same attempt with a bounded target comes back to it.
		const kept = `/login?${new URLSearchParams({ return: '/authorize_interaction', interaction: `${base}x` }).toString()}`
		expect(await attempt(kept)).toEqual([`/authorize_interaction?uri=${encodeURIComponent(`${base}x`)}`, `${base}x`])
	})

	it('keeps an encoded-slash target through a cancelled sign-in and the retry it links', async () => {
		const t = await world()
		const note = servedNote(t)
		const login = `/login?${new URLSearchParams({ return: '/authorize_interaction', interaction: note.id }).toString()}`
		const started = await startSignInAt(t, login)
		const cancelled = new URL(started.callback)
		cancelled.searchParams.delete('code')
		cancelled.searchParams.set('error', 'access_denied')
		const page = await callback(t, cancelled, { [LOGIN]: started.loginCookie })
		expect(page.status).toBe(403)
		const retry = query(parseHtml(await page.text()), 'a')
			.map((a) => attr(a, 'href'))
			.find((href) => href?.startsWith('/login') === true)
		expect(retry).toBe(login)
		const again = await startSignInAt(t, retry!)
		const back = await callback(t, again.callback, { [LOGIN]: again.loginCookie })
		expect(back.headers.get('location')).toBe(`/authorize_interaction?uri=${encodeURIComponent(note.id)}`)
	})

	it('keeps a target in the Store only with the interaction return path, whatever the Worker sends', async () => {
		const t = await world()
		const begin = (returnTo: string, name: string) =>
			t.store.beginWebLogin(BUILD, {
				clientId: 'web',
				secret: 'secret',
				redirectUri: `${ORIGIN}/auth/callback`,
				attemptHash: name,
				state: 'state',
				challenge: 'challenge',
				returnTo,
				interaction: 'https://a.example/x',
				startedWith: null,
				now: NOW,
			})
		await begin('/settings', 'settings')
		await begin('/authorize_interaction', 'interaction')
		const kept = await sql<{ name: string; value: string }>(
			t.store,
			"SELECT name, value FROM kopje_state WHERE name LIKE 'web_login:%' ORDER BY name"
		)
		expect(kept.map((row) => [row.name, (JSON.parse(row.value) as { interaction: unknown }).interaction])).toEqual([
			['web_login:interaction', 'https://a.example/x'],
			['web_login:settings', null],
		])
	})

	it('reads the follow state by its key (follows_pair), with statistics older than the follows', async () => {
		const t = await world()
		const browser = await signIn(t)
		const credential = { tokenHash: await sha256Hex(browser.session), scope: 'write:follows' as const, now: NOW }
		const carol = await seedAccount(t.store, { username: 'carol', email: 'carol@example.com' })
		await sql(t.store, 'ANALYZE')
		// Grown past the statistics: alice follows 500 more accounts.
		for (let i = 0; i < 500; i++) {
			await seedAccount(t.store, { username: `f${i}` }).then((id) =>
				sql(
					t.store,
					"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
					t.aliceId,
					id
				)
			)
		}
		const { result, plans } = await plannedRun(t, /^SELECT state FROM follows/, webFollow, {
			credential,
			target: carol,
			now: NOW,
			present: { origin: ORIGIN },
		})
		expect(result).toMatchObject({ status: 'ok', value: { outcome: 'followed', account: { id: carol } } })
		expect(plans.map((p) => [p.plan, p.rows])).toEqual([
			[['SEARCH follows USING INDEX follows_pair (account_id=? AND target_account_id=?)'], 0],
		])
	})
})

describe('POST /authorize_interaction (look-up)', () => {
	it('refuses a missing, null or foreign Origin and a missing or wrong token, writing and fetching nothing', async () => {
		const t = await world()
		const note = servedNote(t)
		const browser = await signIn(t)
		const other = await signIn(t)
		const form = await lookUpForm(t, browser, note.id)
		const before = await everyRow(t.store)
		const refusals: [string, URLSearchParams, string | null][] = [
			['no origin', form, null],
			['null origin', form, 'null'],
			['foreign origin', form, 'https://evil.example'],
			['no token', new URLSearchParams({ uri: note.id }), ORIGIN],
			['wrong token', new URLSearchParams({ uri: note.id, csrf: 'x'.repeat(43) }), ORIGIN],
			['another session’s token', await lookUpForm(t, other, note.id), ORIGIN],
		]
		for (const [name, fields, origin] of refusals) {
			const response = await postForm(t, browser, '/authorize_interaction', fields, origin)
			expect(response.status, name).toBe(403)
			expect(headersOf(response), name).toEqual(PRIVATE_HEADERS)
		}
		expect(t.web.fetched).toEqual([])
		expect(await everyRow(t.store)).toBe(before)
		expect(t.jobs).not.toHaveBeenCalled()
		// The guard ran: the form as emitted, from this origin, looks the note up.
		const accepted = await postForm(t, browser, '/authorize_interaction', form)
		expect(accepted.status).toBe(200)
		expect(t.web.fetched).toContain(note.id)
	})

	it('sends a session without write:follows to sign in again before fetching anything, and retires it (AUTH-8)', async () => {
		const t = await world()
		const note = servedNote(t)
		const old = await signIn(t)
		const form = await lookUpForm(t, old, note.id)
		// A session issued before the web client had write:follows.
		await sql(
			t.store,
			"UPDATE oauth_tokens SET scopes = 'read:accounts write:accounts write:media' WHERE token_hash = ?",
			await sha256Hex(old.session)
		)
		const before = await everyRow(t.store)
		const response = await postForm(t, old, '/authorize_interaction', form)
		expect(response.status).toBe(303)
		const login = response.headers.get('location')!
		expect(login).toBe(
			`/login?${new URLSearchParams({ return: '/authorize_interaction', interaction: note.id }).toString()}`
		)
		// The live session is kept for the sign-in, which replaces it.
		expect(setCookies(response).lines).toEqual([])
		expect(t.web.fetched).toEqual([])
		expect(await everyRow(t.store)).toBe(before)

		const started = await startSignInAt(t, login, 'alice@example.com', old)
		const back = await callback(t, started.callback, { [LOGIN]: started.loginCookie, [SESSION]: old.session })
		expect(back.headers.get('location')).toBe(`/authorize_interaction?uri=${encodeURIComponent(note.id)}`)
		const fresh = setCookies(back).values.get(SESSION)!
		const renewed = { session: fresh, cookie: cookieHeader({ [SESSION]: fresh }) }
		// The old session is retired, as a cookie and as a bearer token; the new one has the scope and looks up.
		expect((await t.request('/settings', { headers: { cookie: old.cookie } })).status).toBe(302)
		expect(
			(await t.request('/api/v1/accounts/verify_credentials', { headers: { authorization: `Bearer ${old.session}` } }))
				.status
		).toBe(401)
		expect((await t.request('/settings', { headers: { cookie: renewed.cookie } })).status).toBe(200)
		const found = await lookUp(t, renewed, note.id)
		expect(found.response.status).toBe(200)
		expect(found.html).toContain('the note')
	})

	it('starts a family of its own when the upgrade signs in another account, so the retired cookie cannot sign it out', async () => {
		const t = await world()
		await seedAccount(t.store, { username: 'bob', email: 'bob@example.com', displayName: 'Bob' })
		const note = servedNote(t)
		const alice = await signIn(t)
		const form = await lookUpForm(t, alice, note.id)
		await sql(
			t.store,
			"UPDATE oauth_tokens SET scopes = 'read:accounts write:accounts write:media' WHERE token_hash = ?",
			await sha256Hex(alice.session)
		)
		const login = (await postForm(t, alice, '/authorize_interaction', form)).headers.get('location')!
		// Alice's browser signs in again, and Access authenticates Bob.
		const started = await startSignInAt(t, login, 'bob@example.com', alice)
		const back = await callback(t, started.callback, { [LOGIN]: started.loginCookie, [SESSION]: alice.session })
		expect(back.status).toBe(303)
		const fresh = setCookies(back).values.get(SESSION)!
		const bob = { session: fresh, cookie: cookieHeader({ [SESSION]: fresh }) }
		const whoami = (token: string) =>
			t.request('/api/v1/accounts/verify_credentials', { headers: { authorization: `Bearer ${token}` } })
		const me = await whoami(bob.session)
		expect(me.status).toBe(200)
		expect(((await me.json()) as { username: string }).username).toBe('bob')
		// Alice's session is retired, as a cookie and as a bearer token.
		expect((await t.request('/settings', { headers: { cookie: alice.cookie } })).status).toBe(302)
		expect((await whoami(alice.session)).status).toBe(401)
		// Her retired cookie and its form token, replayed to sign-out, end nothing of Bob's.
		const replay = await postForm(t, alice, '/logout', { csrf: await csrfToken(alice.session) })
		expect(replay.status).toBe(200)
		expect((await t.request('/settings', { headers: { cookie: bob.cookie } })).status).toBe(200)
		expect((await whoami(bob.session)).status).toBe(200)
		// The guard ran: Bob's own sign-out ends his session.
		await postForm(t, bob, '/logout', { csrf: await csrfOf(t, bob) })
		expect((await whoami(bob.session)).status).toBe(401)
	})

	it('never reuses a family recorded without its account, such as an older one two accounts shared', async () => {
		const t = await world()
		await seedAccount(t.store, { username: 'bob', email: 'bob@example.com', displayName: 'Bob' })
		const alice = await signIn(t)
		const bob = await signIn(t, 'bob@example.com')
		const [aliceHash, bobHash] = [await sha256Hex(alice.session), await sha256Hex(bob.session)]
		const state = async (name: string) =>
			JSON.parse(
				(await sql<{ value: string }>(t.store, 'SELECT value FROM kopje_state WHERE name = ?', name))[0]?.value ??
					'null'
			) as { family: string; expiresAt: number } | null
		// An older record: one family, written before owners were recorded, holding Alice's retired session and Bob's
		// live one (what a browser that signed in as Alice, then as Bob, was left with).
		const shared = (await state(`web_session:${aliceHash}`))!
		await sql(
			t.store,
			'UPDATE kopje_state SET value = ? WHERE name = ?',
			JSON.stringify({ ...(await state(`web_session:${bobHash}`))!, family: shared.family }),
			`web_session:${bobHash}`
		)
		await sql(
			t.store,
			'UPDATE kopje_state SET value = ? WHERE name = ?',
			JSON.stringify({ current: bobHash, ended: false, expiresAt: shared.expiresAt }),
			`web_family:${shared.family}`
		)
		await sql(t.store, 'DELETE FROM oauth_tokens WHERE token_hash = ?', aliceHash)

		// Bob's browser signs in again: the new session starts a family of its own.
		const started = await startSignInAt(t, '/login', 'bob@example.com', bob)
		const back = await callback(t, started.callback, { [LOGIN]: started.loginCookie, [SESSION]: bob.session })
		const fresh = setCookies(back).values.get(SESSION)!
		const renewed = { session: fresh, cookie: cookieHeader({ [SESSION]: fresh }) }
		const family = (await state(`web_session:${await sha256Hex(renewed.session)}`))!.family
		expect(family).not.toBe(shared.family)
		const whoami = (token: string) =>
			t.request('/api/v1/accounts/verify_credentials', { headers: { authorization: `Bearer ${token}` } })
		expect((await whoami(bob.session)).status).toBe(401)
		// Alice's retired cookie and its form token, replayed to sign-out, end nothing of Bob's.
		expect((await postForm(t, alice, '/logout', { csrf: await csrfToken(alice.session) })).status).toBe(200)
		expect((await t.request('/settings', { headers: { cookie: renewed.cookie } })).status).toBe(200)
		expect((await whoami(renewed.session)).status).toBe(200)
		// The guard ran: Bob's own sign-out ends it.
		await postForm(t, renewed, '/logout', { csrf: await csrfOf(t, renewed) })
		expect((await whoami(renewed.session)).status).toBe(401)
	})

	it('drops a revoked, expired or suspended session and fetches, stores and wakes nothing', async () => {
		for (const ending of ['revoked', 'expired', 'suspended'] as const) {
			const t = await world()
			const note = servedNote(t)
			const browser = await signIn(t)
			const lookUpFields = await lookUpForm(t, browser, note.id)
			const followFields = new URLSearchParams(lookUpFields)
			followFields.set('account_id', t.aliceId)
			if (ending === 'revoked') {
				await sql(t.store, 'DELETE FROM oauth_tokens WHERE token_hash = ?', await sha256Hex(browser.session))
			} else if (ending === 'expired') {
				t.now.mockReturnValue(NOW + SESSION_LIFETIME_MS)
			} else {
				await sql(
					t.store,
					'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?',
					new Date(NOW).toISOString(),
					t.aliceId
				)
			}
			const before = await everyRow(t.store)
			for (const path of ['/authorize_interaction', '/authorize_interaction/follow']) {
				const response = await postForm(t, browser, path, path.endsWith('follow') ? followFields : lookUpFields)
				expect([ending, path, response.status]).toEqual([ending, path, 303])
				expect(response.headers.get('location')).toMatch(/^\/login\?return=%2Fauthorize_interaction&interaction=/)
				expect(setCookies(response).lines.find((line) => line.startsWith(`${SESSION}=`))).toMatch(/Max-Age=0/)
			}
			expect(t.web.fetched).toEqual([])
			expect(await everyRow(t.store)).toBe(before)
			expect([t.doorbell.mock.calls.length, t.jobs.mock.calls.length]).toEqual([0, 0])
		}
	})

	it('refuses a session that expires while the target is fetched, judged at the time after the fetch', async () => {
		const t = await world()
		const note = servedNote(t)
		const browser = await signIn(t)
		const form = await lookUpForm(t, browser, note.id)
		const held = t.web.hold(note.id)
		const pending = postForm(t, browser, '/authorize_interaction', form)
		await held.reached
		t.now.mockReturnValue(NOW + SESSION_LIFETIME_MS)
		held.release()
		const response = await pending
		expect(response.status).toBe(303)
		expect(t.web.fetched).toContain(note.id)
		expect(await sql(t.store, 'SELECT id FROM statuses')).toEqual([])
	})

	it('answers 503 before any fetch while the Store refuses writes, with its signing key stored, and wakes nothing', async () => {
		const t = await world()
		const note = servedNote(t)
		const browser = await signIn(t)
		const lookUpFields = await lookUpForm(t, browser, note.id)
		const followFields = new URLSearchParams(lookUpFields)
		followFields.set('account_id', t.aliceId)
		await seedInstanceKey(t.store)
		await t.store.setMaintenance(BUILD, true)
		const before = await everyRow(t.store)
		expect((await postForm(t, browser, '/authorize_interaction', lookUpFields)).status).toBe(503)
		expect((await postForm(t, browser, '/authorize_interaction/follow', followFields)).status).toBe(503)
		expect(t.web.fetched).toEqual([])
		expect(await everyRow(t.store)).toBe(before)
		expect([t.doorbell.mock.calls.length, t.jobs.mock.calls.length]).toEqual([0, 0])
		// The guard ran: once writes are admitted, the same look-up fetches the note.
		await t.store.setMaintenance(BUILD, false)
		expect((await postForm(t, browser, '/authorize_interaction', lookUpFields)).status).toBe(200)
		expect(t.web.fetched).toContain(note.id)
	})

	it('answers the Origin before reading the body, oversized or malformed, on both POSTs', async () => {
		const t = await world()
		const browser = await signIn(t)
		// A body that records whether anything read it (no read ahead: high-water mark 0).
		const body = (bytes: Uint8Array) => {
			const read = { pulled: false }
			const stream = new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						read.pulled = true
						controller.enqueue(bytes)
						controller.close()
					},
				},
				{ highWaterMark: 0 }
			)
			return { read, stream }
		}
		const oversized = new TextEncoder().encode(`uri=${'x'.repeat(70 * 1024)}`)
		const malformed = new TextEncoder().encode('--x\r\nnot a part')
		for (const path of ['/authorize_interaction', '/authorize_interaction/follow']) {
			for (const [name, bytes, type] of [
				['oversized', oversized, 'application/x-www-form-urlencoded'],
				['malformed', malformed, 'multipart/form-data; boundary=x'],
			] as const) {
				for (const origin of [ORIGIN, 'https://evil.example']) {
					const { read, stream } = body(bytes)
					const response = await t.request(path, {
						method: 'POST',
						headers: { cookie: browser.cookie, origin, 'content-type': type },
						body: stream,
					})
					// A foreign Origin is refused unread; from this origin the body is read and refused (the witness).
					const expected = origin === ORIGIN ? [400, true] : [403, false]
					expect([path, name, origin, response.status, read.pulled]).toEqual([path, name, origin, ...expected])
				}
			}
		}
	})

	it('refuses a session revoked while the target was fetched, and stores nothing of it', async () => {
		const calls: string[] = []
		// Each Store call the requests make, by name, once it has answered.
		const t = await world({ wrapStore: (store) => countingStore(store, (name) => calls.push(name)).stub })
		const note = servedNote(t)
		const browser = await signIn(t)
		const form = await lookUpForm(t, browser, note.id)
		const held = t.web.hold(note.id)
		const pending = postForm(t, browser, '/authorize_interaction', form)
		await held.reached
		await sql(t.store, 'DELETE FROM oauth_tokens WHERE token_hash = ?', await sha256Hex(browser.session))
		calls.length = 0
		held.release()
		const response = await pending
		expect(response.status).toBe(303)
		expect(response.headers.get('location')).toMatch(/^\/login\?return=%2Fauthorize_interaction&interaction=/)
		// The fetch completed and the Store call was made, and refused in its transaction.
		expect(calls).toContain('resolveInteraction')
		expect(await sql(t.store, 'SELECT id FROM statuses')).toEqual([])
		expect(await sql(t.store, 'SELECT id FROM accounts WHERE uri = ?', t.bob.uri)).toEqual([])
		expect(t.jobs).not.toHaveBeenCalled()
	})

	it('shows a status only when an anonymous viewer may see it, though the instance actor was answered (VIS-4)', async () => {
		const t = await world()
		const browser = await signIn(t)
		const followers = mastodonNote(t.bob, {
			to: [`${t.bob.uri}/followers`],
			cc: [],
			content: '<p>for followers only</p>',
		})
		t.web.serve(followers.id, { '@context': AS, ...followers })
		// alice follows bob: she may see it through the API, and the page still shows it to nobody.
		const { html } = await lookUp(t, browser, followers.id)
		const bobId = (await sql<{ id: string }>(t.store, 'SELECT id FROM accounts WHERE uri = ?', t.bob.uri))[0]!.id
		await sql(
			t.store,
			"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
			t.aliceId,
			bobId
		)
		const again = await lookUp(t, browser, followers.id)
		for (const page of [html, again.html]) {
			expect(page).not.toContain('for followers only')
			expect(text(parseHtml(page))).toContain('Nothing that can be followed was found at this address.')
			expect(query(parseHtml(page), 'form').map((f) => attr(f, 'action'))).not.toContain(
				'/authorize_interaction/follow'
			)
		}
		// Fetched and stored with its audience: the branch that judges it ran.
		expect(t.web.fetched).toContain(followers.id)
		expect(await sql(t.store, 'SELECT visibility FROM statuses WHERE uri = ?', followers.id)).toEqual([
			{ visibility: 'private' },
		])
		// A public one by the same author is shown.
		const shown = await lookUp(t, browser, servedNote(t).id)
		expect(shown.html).toContain('the note')
	})

	it('finds this instance’s accounts and posts by address, profile URL and permalink, without fetching', async () => {
		const t = await world()
		const browser = await signIn(t)
		const carolId = await seedAccount(t.store, { username: 'carol', email: 'carol@example.com' })
		const shown = await seedStatus(t.store, {
			accountId: carolId,
			visibility: 'public',
			content: '<p>carol here</p>',
			uri: `${ORIGIN}/ap/o/shown`,
		})
		const hidden = await seedStatus(t.store, {
			accountId: carolId,
			visibility: 'private',
			content: '<p>carol only</p>',
			uri: `${ORIGIN}/ap/o/hidden`,
		})
		const followTarget = async (uri: string) => {
			const { response, html } = await lookUp(t, browser, uri)
			expect(response.status, uri).toBe(200)
			const form = query(parseHtml(html), 'form').find((f) => attr(f, 'action') === '/authorize_interaction/follow')
			return {
				html,
				account: form === undefined ? null : formOf(html, '/authorize_interaction/follow').get('account_id'),
			}
		}
		for (const uri of [
			'@carol@kopje.test',
			'carol@KOPJE.test',
			'acct:carol@kopje.test',
			`${ORIGIN}/@carol`,
			`${ORIGIN}/@Carol/`,
			`${ORIGIN}/@carol@kopje.test`,
			`${ORIGIN}/ap/users/carol`,
		]) {
			expect((await followTarget(uri)).account, uri).toBe(carolId)
		}
		for (const uri of [`${ORIGIN}/@carol/${shown}`, `${ORIGIN}/ap/o/shown`]) {
			const found = await followTarget(uri)
			expect([uri, found.account]).toEqual([uri, carolId])
			expect(found.html).toContain('carol here')
		}
		// Not shown: a private post, another author's path, an unknown account and a suspended one.
		const daveId = await seedAccount(t.store, { username: 'dave', email: 'dave@example.com' })
		await sql(
			t.store,
			'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?',
			new Date(NOW).toISOString(),
			daveId
		)
		for (const uri of [
			`${ORIGIN}/@carol/${hidden}`,
			`${ORIGIN}/ap/o/hidden`,
			`${ORIGIN}/@alice/${shown}`,
			'@nobody@kopje.test',
			`${ORIGIN}/@nobody`,
			'@dave@kopje.test',
			`${ORIGIN}/@dave`,
		]) {
			const found = await followTarget(uri)
			expect([uri, found.account]).toEqual([uri, null])
			expect(found.html).not.toContain('carol only')
		}
		expect(t.web.fetched).toEqual([])
	})

	it('finds an account by its address, and asks for the quote round of a stored quote at once (A4)', async () => {
		const t = await world()
		const browser = await signIn(t)
		t.web.serve(
			`${MASTODON}/.well-known/webfinger?resource=${encodeURIComponent('acct:bob@mastodon.example')}`,
			{
				subject: 'acct:bob@mastodon.example',
				links: [{ rel: 'self', type: 'application/activity+json', href: t.bob.uri }],
			},
			'application/jrd+json'
		)
		const account = await lookUp(t, browser, '@bob@mastodon.example')
		expect(account.response.status).toBe(200)
		expect(formOf(account.html, '/authorize_interaction/follow').get('uri')).toBe('@bob@mastodon.example')
		expect(t.jobs).not.toHaveBeenCalled()

		const quote = quoting(t.bob, `${MASTODON}/users/bob/statuses/quoted`, `${t.bob.uri}/quote_authorizations/1`)
		t.web.serve(quote.id, { '@context': AS, ...quote })
		const found = await lookUp(t, browser, quote.id)
		expect(found.response.status).toBe(200)
		// Asked during the request, with no cron run.
		expect(t.jobs).toHaveBeenCalledTimes(1)
	})
})

describe('POST /authorize_interaction/follow', () => {
	async function followed(t: World, browser: Browser, uri: string) {
		const { html } = await lookUp(t, browser, uri)
		const form = formOf(html, '/authorize_interaction/follow')
		return { form, follow: () => postForm(t, browser, '/authorize_interaction/follow', form) }
	}

	async function outcome(response: Response): Promise<string> {
		expect(response.status).toBe(200)
		expect(headersOf(response)).toEqual(PRIVATE_HEADERS)
		return text(query(parseHtml(await response.text()), 'h1')[0]!)
	}

	it('requests a remote follow and wakes delivery at once; a second follow is already requested', async () => {
		const t = await world()
		const browser = await signIn(t)
		const { follow } = await followed(t, browser, servedNote(t).id)
		expect(t.doorbell).not.toHaveBeenCalled()
		const first = await follow()
		expect(await outcome(first)).toBe('Follow requested')
		expect(t.doorbell).toHaveBeenCalledTimes(1)
		expect(await sql(t.store, 'SELECT state FROM follows WHERE account_id = ?', t.aliceId)).toEqual([
			{ state: 'pending' },
		])
		const second = await follow()
		expect(await outcome(second)).toBe('Follow requested')
		expect(t.doorbell).toHaveBeenCalledTimes(1)
	})

	it('tells apart followed, already requested, refused and not found', async () => {
		const t = await world()
		const browser = await signIn(t)
		// A local unlocked account, found by its actor URI in stored data (nothing is fetched for a local URL).
		const carolId = await seedAccount(t.store, { username: 'carol', email: 'carol@example.com' })
		const local = await followed(t, browser, `${ORIGIN}/ap/users/carol`)
		expect(t.web.fetched).toEqual([])
		const page = await local.follow()
		// Each outcome names the account the Store followed, never the form's text.
		expect(text(parseHtml(await page.clone().text()))).toContain('You are following carol (@carol@kopje.test).')
		expect(await outcome(page)).toBe('Following')
		expect(t.doorbell).toHaveBeenCalledTimes(1)

		const remote = await followed(t, browser, servedNote(t).id)
		await remote.follow()
		const again = await remote.follow()
		expect(text(parseHtml(await again.clone().text()))).toMatch(
			/A follow request to .+ \(@bob@mastodon\.example\) is already waiting for approval\./
		)
		expect(t.doorbell).toHaveBeenCalledTimes(2)

		// carol blocks alice: refused, and nothing is woken.
		await sql(t.store, 'DELETE FROM follows WHERE target_account_id = ?', carolId)
		await sql(t.store, 'INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)', carolId, t.aliceId)
		const refused = await local.follow()
		expect(text(parseHtml(await refused.clone().text()))).toContain(
			'carol (@carol@kopje.test) cannot be followed from your account.'
		)
		expect(await outcome(refused)).toBe('Cannot follow')
		const missing = local.form
		missing.set('account_id', '999999999999999999')
		const notFound = await postForm(t, browser, '/authorize_interaction/follow', missing)
		expect(await outcome(notFound)).toBe('Not found')
		expect(t.doorbell).toHaveBeenCalledTimes(2)
		expect(await sql(t.store, 'SELECT 1 FROM follows WHERE target_account_id = ?', carolId)).toEqual([])
	})

	it('refuses a missing, null or foreign Origin and a missing or wrong token, writing and waking nothing', async () => {
		const t = await world()
		const browser = await signIn(t)
		const other = await signIn(t)
		const { form } = await followed(t, browser, servedNote(t).id)
		const otherForm = (await followed(t, other, servedNote(t).id)).form
		const before = await everyRow(t.store)
		const withToken = (csrf: string | null) => {
			const fields = new URLSearchParams(form)
			fields.delete('csrf')
			if (csrf !== null) {
				fields.set('csrf', csrf)
			}
			return fields
		}
		const refusals: [string, URLSearchParams, string | null][] = [
			['no origin', form, null],
			['null origin', form, 'null'],
			['foreign origin', form, 'https://evil.example'],
			['no token', withToken(null), ORIGIN],
			['wrong token', withToken('x'.repeat(43)), ORIGIN],
			['another session’s token', withToken(otherForm.get('csrf')), ORIGIN],
		]
		for (const [name, fields, origin] of refusals) {
			const response = await postForm(t, browser, '/authorize_interaction/follow', fields, origin)
			expect(response.status, name).toBe(403)
		}
		expect(await everyRow(t.store)).toBe(before)
		expect(t.doorbell).not.toHaveBeenCalled()
		// The guard ran: the form as emitted follows.
		expect((await postForm(t, browser, '/authorize_interaction/follow', form)).status).toBe(200)
		expect(t.doorbell).toHaveBeenCalledTimes(1)
	})

	it('sends a session without write:follows, or none, to sign in and back to the look-up', async () => {
		const t = await world()
		const browser = await signIn(t)
		const note = servedNote(t)
		const { form } = await followed(t, browser, note.id)
		const back = `/login?${new URLSearchParams({ return: '/authorize_interaction', interaction: note.id }).toString()}`
		const signedOut = await t.request('/authorize_interaction/follow', {
			method: 'POST',
			headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
			body: form.toString(),
		})
		expect([signedOut.status, signedOut.headers.get('location')]).toEqual([303, back])
		await sql(
			t.store,
			"UPDATE oauth_tokens SET scopes = 'read:accounts write:accounts write:media' WHERE token_hash = ?",
			await sha256Hex(browser.session)
		)
		const before = await everyRow(t.store)
		const stale = await postForm(t, browser, '/authorize_interaction/follow', form)
		expect([stale.status, stale.headers.get('location')]).toEqual([303, back])
		expect(await everyRow(t.store)).toBe(before)
		expect(t.doorbell).not.toHaveBeenCalled()
	})
})
