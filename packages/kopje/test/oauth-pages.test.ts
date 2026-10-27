import { describe, expect, it } from 'vitest'

import { apiHarness, consentPage, decide, registerApp, seedAccount } from './api-helpers'
import { attr, classes, one, parseHtml, query, text } from './web-dom'
import { startSignIn } from './web-helpers'
import { PRIVATE_PAGE_HEADERS } from '../browser/headers'
import { STYLESHEET } from '../src/web/asset-versions'

// The pages of /oauth/authorize (app/authorize.tsx): the private pages' headers and script-free CSP (WEB-2), the
// shared layout and stylesheet, and the catalogue's text.

async function withAlice() {
	const h = await apiHarness()
	await seedAccount(h.store, { username: 'alice', email: 'alice@example.com', displayName: 'Alice' })
	return h
}

// The private pages' answer: their exact headers (no 'unsafe-inline', no script source), the stylesheet, no script.
async function privatePage(response: Response, status: number) {
	expect(response.status).toBe(status)
	expect(Object.fromEntries(response.headers)).toEqual(PRIVATE_PAGE_HEADERS)
	const html = await response.text()
	expect(html.startsWith('<!DOCTYPE html><html lang="en">')).toBe(true)
	expect(html).toContain(`<link rel="stylesheet" href="${STYLESHEET}"/>`)
	expect(html).not.toContain('<script')
	expect(html).not.toContain('<style')
	return parseHtml(html)
}

describe('the OAuth pages', () => {
	it('show a third-party app its name, website as text, the account and each scope, approve before deny', async () => {
		const h = await withAlice()
		const app = await registerApp(h)
		const doc = await privatePage(await consentPage(h, app, { scope: 'read write:statuses follow' }), 200)
		expect(text(one(doc, 'h1'))).toBe('Authorize Test Client')
		const terms = query(doc, 'dt').map(text)
		const values = query(doc, 'dd').map(text)
		expect(terms).toEqual(['Website', 'Account', 'Permissions'])
		expect(values.slice(0, 2)).toEqual(['https://client.test', '@alice'])
		// The client's claimed website is never a link.
		expect(query(doc, 'a').map((a) => attr(a, 'href'))).toEqual(['#content'])
		const scopes = one(doc, 'ul', 'scopes')
		expect(attr(scopes, 'role')).toBe('list')
		expect(query(scopes, 'code').map(text)).toEqual(['read', 'write:statuses', 'follow'])
		const buttons = query(doc, 'button').map((b) => [classes(b).join(' '), attr(b, 'value'), text(b)])
		expect(buttons).toEqual([
			['btn primary', 'approve', 'Authorize'],
			['btn', 'deny', 'Deny'],
		])
		const form = one(doc, 'form')
		expect([attr(form, 'method'), attr(form, 'action')]).toEqual(['post', '/oauth/authorize'])
	})

	it('word the instance’s own web UI as signing in', async () => {
		const h = await withAlice()
		const { consent } = await startSignIn(h)
		const doc = await privatePage(consent, 200)
		expect(text(one(doc, 'h1'))).toBe('Sign in')
		expect(text(one(one(doc, 'main'), 'p'))).toBe("Sign in to this server's settings as @alice?")
		expect(query(doc, 'dl')).toEqual([])
		expect(query(doc, 'button').map((b) => [classes(b).join(' '), text(b)])).toEqual([
			['btn primary', 'Sign in'],
			['btn', 'Cancel'],
		])
	})

	it('show the out-of-band code whole in a field, with no copy control', async () => {
		const h = await withAlice()
		const app = await registerApp(h, { redirectUri: 'urn:ietf:wg:oauth:2.0:oob' })
		const doc = await privatePage(await decide(h, app, 'approve'), 200)
		expect(text(one(doc, 'h1'))).toBe('Authorization code')
		const field = one(doc, 'div', 'copy')
		expect(query(field, 'code').map((c) => [classes(c).join(' '), text(c)])).toEqual([
			['mono', expect.stringMatching(/^token-\d+-/)],
		])
		expect(query(doc, 'button')).toEqual([])
	})

	it('show their refusals from the catalogue, the out-of-band errors with their code', async () => {
		const h = await withAlice()
		const unknown = await privatePage(
			await consentPage(h, { client_id: 'nope', client_secret: '', redirect_uri: 'https://client.test/callback' }),
			400
		)
		expect(query(unknown, 'h1').map(text)).toEqual(['Unknown application'])
		expect(text(one(one(unknown, 'main'), 'p'))).toBe('The application is not registered on this server.')
		const app = await registerApp(h, { redirectUri: 'urn:ietf:wg:oauth:2.0:oob', scopes: 'read' })
		const failed = await privatePage(await consentPage(h, app, { scope: 'write' }), 400)
		expect(query(failed, 'h1').map(text)).toEqual(['Authorization failed'])
		expect(text(one(one(failed, 'main'), 'p'))).toMatch(/^invalid_scope: /)
		const denied = await privatePage(await decide(h, app, 'deny', { scope: 'read' }), 403)
		expect(query(denied, 'h1').map(text)).toEqual(['Authorization denied'])
	})
})
