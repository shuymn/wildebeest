import { describe, expect, it } from 'vitest'

import { type ApiHarness, apiHarness, bearer, seedAccount, setSetting, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { appToken, remoteAccounts, rowsRead } from './read-helpers'
import { community, getJson } from './status-helpers'
import { MAX_BLOCK_COMMENT } from '../src/domain/admin-domain-blocks'
import { ANSWER_BYTES, jsonBytes } from '../src/domain/answer-budget'
import { instancePeers, instanceRules, MAX_PEERS, PEER_SEARCH_LIMIT, searchPeers } from '../src/domain/instance'
import { MAX_DOMAIN_LENGTH, publicDomain, publicDomainBlocks } from '../src/domain/instance-domain-blocks'
import { sha256Hex } from '../src/platform/sha256'
import { INSTANCE_DOCUMENT_BYTES } from '../src/platform/stored-bounds'
import { REMOTE_HTML_RAW_LIMIT, sanitizeRemoteHtml } from '../src/security/html'
import { sha256Hex as tokenHash } from '../src/security/tokens'

// /api/v1/instance/*: public reads clients make at startup and on an about page (AUTH-2), with the peers and the
// public block list bounded (RES-3, RES-7).

describe('instance details', () => {
	it('lists the rules as every instance endpoint shows them, with a hint and translations as Mastodon', async () => {
		const h = await apiHarness()
		await setSetting(
			h.store,
			'rules',
			JSON.stringify(['Be kind', { id: 'r2', text: 'No spam', hint: 'No ads either' }, { text: 'Hi', hint: 3 }])
		)
		const rules = await getJson(h, '/api/v1/instance/rules')
		expect(rules).toEqual({
			status: 200,
			body: [
				{ id: '1', text: 'Be kind', hint: '', translations: {} },
				{ id: 'r2', text: 'No spam', hint: 'No ads either', translations: {} },
				{ id: '3', text: 'Hi', hint: '', translations: {} },
			],
		})
		const v1 = await getJson<{ rules: unknown }>(h, '/api/v1/instance')
		const v2 = await getJson<{ rules: unknown }>(h, '/api/v2/instance')
		expect(v1.body.rules).toEqual(rules.body)
		expect(v2.body.rules).toEqual(rules.body)
	})

	it('reads only the rules setting, whatever the accounts (RES-7)', async () => {
		const measure = async (accounts: number) => {
			const h = await apiHarness()
			await setSetting(h.store, 'rules', JSON.stringify(['Be kind']))
			await remoteAccounts(h, 50, accounts / 50)
			return rowsRead(h, instanceRules, undefined)
		}
		const small = await measure(1000)
		const large = await measure(8000)
		expect(small).toBeLessThanOrEqual(1)
		expect(large).toBe(small)
	}, 60_000)

	it('lists each known remote domain once, in order, and no local account', async () => {
		const h = await apiHarness()
		await seedAccount(h.store, { username: 'alice' })
		await seedAccount(h.store, { username: 'bob', domain: 'b.example' })
		await seedAccount(h.store, { username: 'carol', domain: 'a.example' })
		await seedAccount(h.store, { username: 'dave', domain: 'b.example' })
		expect(await getJson(h, '/api/v1/instance/peers')).toEqual({ status: 200, body: ['a.example', 'b.example'] })
	})

	it('bounds the peers and reads rows by domain, not by account (RES-3, RES-7)', async () => {
		const measure = async (perDomain: number) => {
			const h = await apiHarness()
			await remoteAccounts(h, 50, perDomain)
			return rowsRead(h, instancePeers, undefined)
		}
		const small = await measure(20)
		const large = await measure(80)
		expect(large).toBeLessThan(small * 1.5)

		const h = await apiHarness()
		await remoteAccounts(h, MAX_PEERS + 5, 1)
		const { body } = await getJson<string[]>(h, '/api/v1/instance/peers')
		expect(body).toHaveLength(MAX_PEERS)
		expect(new Set(body).size).toBe(MAX_PEERS)
	}, 60_000)

	it('searches the peers by domain prefix, as Mastodon with the peers API on', async () => {
		const h = await apiHarness()
		await seedAccount(h.store, { username: 'alice' })
		for (const [username, domain] of [
			['bob', 'mastodon.example'],
			['carol', 'mastodon.example'],
			['dave', 'masto.example'],
			['erin', 'misskey.example'],
			['frank', 'xn--r8jz45g.example'],
			['grace', '123.example'],
		] as const) {
			await seedAccount(h.store, { username, domain })
		}
		const search = (q: string) => getJson(h, `/api/v1/peers/search?q=${encodeURIComponent(q)}`)
		expect(await search('masto')).toEqual({ status: 200, body: ['masto.example', 'mastodon.example'] })
		// Normalized as a host: trimmed, a trailing slash dropped, lowercased, IDNA-encoded.
		expect(await search('  MASTODON.example/ ')).toEqual({ status: 200, body: ['mastodon.example'] })
		expect(await search('例え')).toEqual({ status: 200, body: ['xn--r8jz45g.example'] })
		expect(await search('pleroma')).toEqual({ status: 200, body: [] })
		// As Addressable reads a host, not WHATWG: a trailing dot dropped, and numbers kept as written (not 0.0.0.123).
		expect(await search('mastodon.example.')).toEqual({ status: 200, body: ['mastodon.example'] })
		expect(await search('123')).toEqual({ status: 200, body: ['123.example'] })
		// Not a host: Mastodon rescues Addressable's InvalidURIError with [].
		expect(await search('masto/don')).toEqual({ status: 200, body: [] })
		// A blank q leaves Mastodon's @domains unset: null.
		for (const path of ['/api/v1/peers/search', '/api/v1/peers/search?q=%20']) {
			const response = await h.request(path)
			expect(response.status).toBe(200)
			expect(await response.text()).toBe('null')
		}
	})

	it('bounds a peer search to its limit, reading one row past it (RES-3, RES-7)', async () => {
		const h = await apiHarness()
		await remoteAccounts(h, 50, 4)
		const peers = (await getJson<string[]>(h, '/api/v1/instance/peers')).body
		const matching = peers.filter((domain) => domain.startsWith('d1'))
		expect(matching.length).toBeGreaterThan(PEER_SEARCH_LIMIT)
		const { body } = await getJson<string[]>(h, '/api/v1/peers/search?q=d1')
		expect(body).toEqual(matching.slice(0, PEER_SEARCH_LIMIT))
		expect(body).toHaveLength(PEER_SEARCH_LIMIT)
		expect(await rowsRead(h, searchPeers, { prefix: 'd1' })).toBeLessThanOrEqual(2 * (PEER_SEARCH_LIMIT + 1))
	})

	it('lists the ISO 639-1 languages with English names', async () => {
		const h = await apiHarness()
		const { status, body } = await getJson<{ code: string; name: string }[]>(h, '/api/v1/instance/languages')
		expect(status).toBe(200)
		expect(body).toHaveLength(183)
		expect(body).toContainEqual({ code: 'en', name: 'English' })
		expect(body).toContainEqual({ code: 'ja', name: 'Japanese' })
		expect(new Set(body.map((language) => language.code)).size).toBe(183)
		expect(body.every((language) => /^[a-z]{2}$/.test(language.code) && language.name !== '')).toBe(true)
	})

	it('has no translation languages, as Mastodon without a translation service', async () => {
		const h = await apiHarness()
		expect(await getJson(h, '/api/v1/instance/translation_languages')).toEqual({ status: 200, body: {} })
	})

	it('answers the activity with an empty 404, as Mastodon with the API off', async () => {
		const h = await apiHarness()
		const response = await h.request('/api/v1/instance/activity')
		expect(response.status).toBe(404)
		expect(await response.text()).toBe('')
	})

	it('is public: no token is needed and a stale one is ignored', async () => {
		const h = await apiHarness()
		for (const path of [
			'/api/v1/instance/rules',
			'/api/v1/instance/peers',
			'/api/v1/instance/extended_description',
			'/api/v1/instance/languages',
			'/api/v1/instance/translation_languages',
			'/api/v1/peers/search?q=a',
		]) {
			expect((await h.request(path)).status).toBe(200)
			expect((await h.request(path, bearer('stale'))).status).toBe(200)
		}
	})
})

// The instance's documents (domain/instance.ts): available exactly when their rows exist, sanitized once per sink
// (HTML-1): in the Store for the API, at the page for the web.
describe('instance documents', () => {
	const SANITIZED_CASE =
		'<p>Hi<script>alert(1)</script> <a href="https://example.com/x">link</a> <a href="javascript:x">js</a></p>'
	const SANITIZED =
		'<p>Hi <a href="https://example.com/x" rel="nofollow noopener" target="_blank">link</a> ' +
		'<a rel="nofollow noopener" target="_blank">js</a></p>'

	it('serves the privacy policy sanitized with its stamp, null for a converted one, and 404 without one', async () => {
		const h = await apiHarness()
		const v2 = async () =>
			(await getJson<{ configuration: { urls: { privacy_policy: unknown } } }>(h, '/api/v2/instance')).body
				.configuration.urls.privacy_policy
		expect(await getJson(h, '/api/v1/instance/privacy_policy')).toEqual({ status: 404, body: { error: 'Not Found' } })
		expect(await v2()).toBeNull()
		await setSetting(h.store, 'privacy_policy', SANITIZED_CASE)
		expect(await getJson(h, '/api/v1/instance/privacy_policy')).toEqual({
			status: 200,
			body: { updated_at: null, content: SANITIZED },
		})
		await setSetting(h.store, 'privacy_policy_updated_at', '2026-10-01T12:00:00.000Z')
		expect(await getJson(h, '/api/v1/instance/privacy_policy')).toEqual({
			status: 200,
			body: { updated_at: '2026-10-01T12:00:00.000Z', content: SANITIZED },
		})
		expect(await v2()).toBe('https://kopje.test/privacy-policy')
		await sql(h.store, "DELETE FROM instance_settings WHERE name = 'privacy_policy'")
		expect(await getJson(h, '/api/v1/instance/privacy_policy')).toEqual({ status: 404, body: { error: 'Not Found' } })
		expect(await v2()).toBeNull()
	})

	it('serves the terms of service as the current version, effective strictly after its date', async () => {
		const h = await apiHarness()
		const terms = (path = '') => getJson(h, `/api/v1/instance/terms_of_service${path}`)
		expect(await terms()).toEqual({ status: 404, body: { error: 'Not Found' } })
		expect(await terms('/2026-01-01')).toEqual({ status: 404, body: { error: 'Record not found' } })
		await setSetting(h.store, 'terms_of_service', SANITIZED_CASE)
		// Without its date the document is not available.
		expect(await terms()).toEqual({ status: 404, body: { error: 'Not Found' } })
		// The clock is NOW, 2026-10-12 (UTC).
		for (const [date, effective] of [
			['2026-10-11', true],
			['2026-10-12', false],
			['2026-11-01', false],
		] as const) {
			await setSetting(h.store, 'terms_of_service_effective_date', date)
			const body = { effective_date: date, effective, content: SANITIZED, succeeded_by: null }
			expect(await terms()).toEqual({ status: 200, body })
			expect(await terms(`/${date}`)).toEqual({ status: 200, body })
		}
		for (const other of ['/2026-11-02', '/2026-11-1', '/2026-02-30', '/today']) {
			expect(await terms(other)).toEqual({ status: 404, body: { error: 'Record not found' } })
		}
		const v2 = async () =>
			(await getJson<{ configuration: { urls: { terms_of_service: unknown } } }>(h, '/api/v2/instance')).body
				.configuration.urls.terms_of_service
		expect(await v2()).toBe('https://kopje.test/terms-of-service')
		await sql(
			h.store,
			"DELETE FROM instance_settings WHERE name IN ('terms_of_service', 'terms_of_service_effective_date')"
		)
		expect(await terms()).toEqual({ status: 404, body: { error: 'Not Found' } })
		expect(await terms('/2026-11-01')).toEqual({ status: 404, body: { error: 'Record not found' } })
		expect((await h.request('/terms-of-service')).status).toBe(404)
		expect((await h.request('/terms-of-service/2026-11-01')).status).toBe(404)
		expect(await v2()).toBeNull()
	})

	it("serves the extended description sanitized, and Mastodon's empty answer without one", async () => {
		const h = await apiHarness()
		const path = '/api/v1/instance/extended_description'
		expect(await getJson(h, path)).toEqual({ status: 200, body: { updated_at: null, content: '' } })
		await setSetting(h.store, 'extended_description', SANITIZED_CASE)
		await setSetting(h.store, 'extended_description_updated_at', '2026-10-02T00:00:00.000Z')
		expect(await getJson(h, path)).toEqual({
			status: 200,
			body: { updated_at: '2026-10-02T00:00:00.000Z', content: SANITIZED },
		})
	})

	// HTML-1, RES-2: a document at its bound whose links lengthen it past REMOTE_HTML_RAW_LIMIT once sanitized keeps its
	// end in the API and on the pages: each sink sanitizes the stored text once.
	it('keeps the end of a document that sanitizing lengthens past the raw cap', async () => {
		const h = await apiHarness()
		const link = '<a href="https://e.example/">x</a>'
		const marker = '<p>END-OF-DOCUMENT</p>'
		const document = `${link.repeat(Math.floor((INSTANCE_DOCUMENT_BYTES - marker.length) / link.length))}${marker}`
		expect(new TextEncoder().encode(document).length).toBeLessThanOrEqual(INSTANCE_DOCUMENT_BYTES)
		const sanitized = sanitizeRemoteHtml(document)
		expect(sanitized.length).toBeGreaterThan(REMOTE_HTML_RAW_LIMIT)
		expect(sanitized).toContain('END-OF-DOCUMENT')
		for (const name of ['extended_description', 'privacy_policy', 'terms_of_service']) {
			await setSetting(h.store, name, document)
		}
		await setSetting(h.store, 'terms_of_service_effective_date', '2026-11-01')
		for (const name of ['extended_description', 'privacy_policy', 'terms_of_service']) {
			const { body } = await getJson<{ content: string }>(h, `/api/v1/instance/${name}`)
			expect(body.content, name).toBe(sanitized)
		}
		for (const path of ['/about', '/privacy-policy', '/terms-of-service']) {
			const response = await h.request(path)
			expect(response.status, path).toBe(200)
			expect(await response.text(), path).toContain('<p>END-OF-DOCUMENT</p>')
		}
	})
})

// GET /api/v1/instance/domain_blocks (instance-domain-blocks.ts publicDomainBlocks), as Mastodon 4.5.11's controller.
describe('public domain blocks', () => {
	const block = (
		domain: string,
		severity: 'suspend' | 'noop',
		fields: { obfuscate?: boolean; comment?: string } = {}
	) => [domain, severity, fields.obfuscate === true ? 1 : 0, 'private note', fields.comment ?? null] as const
	const seed = async (h: ApiHarness, blocks: (readonly [string, string, number, string, string | null])[]) => {
		for (const row of blocks) {
			await sql(
				h.store,
				`INSERT INTO instance_domain_blocks (domain, severity, obfuscate, private_comment, public_comment, created_at,
					updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				...row,
				'2026-10-01T00:00:00.000Z',
				'2026-10-01T00:00:00.000Z'
			)
		}
	}
	const sha = (text: string) => sha256Hex(text)

	// Tokens of every kind: a user, a suspended user, an app, an unknown one, an expired one and one of an earlier
	// credential epoch.
	async function world() {
		const h = await community(['alice', 'bob', 'carol', 'dave'])
		await seed(h, [block('spam.example', 'suspend', { comment: 'spam' }), block('quiet.example', 'noop')])
		await sql(
			h.store,
			'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?',
			new Date(NOW).toISOString(),
			h.users.bob.id
		)
		await sql(
			h.store,
			'UPDATE oauth_tokens SET expires_at = ? WHERE token_hash = ?',
			new Date(NOW - 1000).toISOString(),
			await tokenHash(h.users.carol.token)
		)
		await sql(
			h.store,
			'UPDATE local_accounts SET credential_epoch = credential_epoch + 1 WHERE account_id = ?',
			h.users.dave.id
		)
		const tokens = {
			none: undefined,
			user: h.users.alice.token,
			app: await appToken(h),
			unknown: 'unknown-token',
			expired: h.users.carol.token,
			stale: h.users.dave.token,
		}
		return { h, tokens, suspended: h.users.bob.token }
	}

	const listed = [{ domain: 'spam.example', digest: sha('spam.example'), severity: 'suspend', comment: null }]

	it('answers by show_domain_blocks, refusing a suspended user first, as Mastodon orders its checks', async () => {
		const { h, tokens, suspended } = await world()
		const get = async (token: string | undefined) => {
			const response = await h.request('/api/v1/instance/domain_blocks', token === undefined ? {} : bearer(token))
			const text = await response.text()
			return { status: response.status, body: text === '' ? '' : (JSON.parse(text) as unknown) }
		}
		for (const setting of [null, 'disabled', 'users', 'all']) {
			if (setting !== null) {
				await setSetting(h.store, 'show_domain_blocks', setting)
			}
			expect(await get(suspended), String(setting)).toEqual({
				status: 403,
				body: { error: 'Your login is currently disabled' },
			})
			for (const [kind, token] of Object.entries(tokens)) {
				const shown = setting === 'all' || (setting === 'users' && kind === 'user')
				expect(await get(token), `${String(setting)} ${kind}`).toEqual(
					shown ? { status: 200, body: listed } : { status: 404, body: '' }
				)
			}
		}
	})

	it('shows the public comment by show_domain_blocks_rationale, never the private one', async () => {
		const { h, tokens } = await world()
		await setSetting(h.store, 'show_domain_blocks', 'all')
		const comments = async (token: string | undefined) =>
			(await getJson<{ comment: unknown }[]>(h, '/api/v1/instance/domain_blocks', token)).body.map((b) => b.comment)
		for (const [setting, anonymous, user] of [
			['disabled', null, null],
			['users', null, 'spam'],
			['all', 'spam', 'spam'],
		] as const) {
			await setSetting(h.store, 'show_domain_blocks_rationale', setting)
			expect([await comments(undefined), await comments(tokens.user), await comments(tokens.app)]).toEqual([
				[anonymous],
				[user],
				[anonymous],
			])
		}
		expect(await (await h.request('/api/v1/instance/domain_blocks')).text()).not.toContain('private note')
	})

	it('lists only suspends in domain order, obfuscated as Mastodon, each with the digest of its domain', async () => {
		const h = await apiHarness()
		await setSetting(h.store, 'show_domain_blocks', 'all')
		await seed(h, [
			block('zeta.example', 'suspend'),
			block('hostname.example.com', 'suspend', { obfuscate: true }),
			block('a.bc', 'suspend', { obfuscate: true }),
			block('alpha.example', 'noop', { obfuscate: true }),
			block('beta.example', 'suspend'),
		])
		expect(await getJson(h, '/api/v1/instance/domain_blocks')).toEqual({
			status: 200,
			body: [
				{ domain: 'a.*c', digest: sha('a.bc'), severity: 'suspend', comment: null },
				{ domain: 'beta.example', digest: sha('beta.example'), severity: 'suspend', comment: null },
				{ domain: 'hostna**.******e.com', digest: sha('hostname.example.com'), severity: 'suspend', comment: null },
				{ domain: 'zeta.example', digest: sha('zeta.example'), severity: 'suspend', comment: null },
			],
		})
		expect(publicDomain('hostname.example.com')).toBe('hostna**.******e.com')
		expect(publicDomain('a.bc')).toBe('a.*c')
	})

	// RES-7: the rows read do not grow with the noop blocks, which the partial index leaves out.
	it('reads the same rows whatever the noop blocks, and one empty chunk for a list of noops', async () => {
		const measure = async (noops: number, suspends = 10) => {
			const h = await apiHarness()
			await setSetting(h.store, 'show_domain_blocks', 'all')
			await sql(
				h.store,
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO instance_domain_blocks (domain, severity, created_at, updated_at)
				SELECT printf('n%05d.example', i), 'noop', '', '' FROM n WHERE ?1 > 0`,
				noops
			)
			await sql(
				h.store,
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO instance_domain_blocks (domain, severity, created_at, updated_at)
				SELECT printf('s%05d.example', i), 'suspend', '', '' FROM n WHERE ?1 > 0`,
				suspends
			)
			return rowsRead(h, publicDomainBlocks, { credential: null })
		}
		const base = await measure(0)
		for (const noops of [1_000, 10_000]) {
			expect(await measure(noops), String(noops)).toBe(base)
		}
		// The two setting rows, and one chunk that finds no suspend.
		const empty = await measure(0, 0)
		expect(empty).toBeLessThanOrEqual(4)
		expect(await measure(10_000, 0)).toBe(empty)
	}, 120_000)

	// RES-2, RES-3: one block at every bound, then 2,000 of nearly that size, which cross the chunks at 500 and 1,000
	// and the budget past 1,300: the answer is a strict prefix in domain order within ANSWER_BYTES, and the rows read are
	// at most the admitted blocks and one chunk.
	it('admits whole blocks in domain order within ANSWER_BYTES, reading at most one chunk past them', async () => {
		const deepest = [63, 63, 63, 63].map((n, i) => String.fromCharCode(97 + i).repeat(n)).join('.')
		expect(deepest).toHaveLength(MAX_DOMAIN_LENGTH)
		const comment = '\u0001'.repeat(MAX_BLOCK_COMMENT)
		const unit = { domain: deepest, digest: sha(deepest), severity: 'suspend', comment }
		expect(jsonBytes(unit)).toBe(6_378)

		const h = await apiHarness()
		await setSetting(h.store, 'show_domain_blocks', 'all')
		await setSetting(h.store, 'show_domain_blocks_rationale', 'all')
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 2000 - 1)
			INSERT INTO instance_domain_blocks (domain, severity, public_comment, created_at, updated_at)
			SELECT printf('b%04d.example', i), 'suspend', ?1, '', '' FROM n`,
			comment
		)
		const response = await h.request('/api/v1/instance/domain_blocks')
		const text = await response.text()
		expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(ANSWER_BYTES)
		const body = JSON.parse(text) as { domain: string; comment: string }[]
		expect(body.length).toBeGreaterThan(1_000)
		expect(body.length).toBeLessThan(2_000)
		expect(body.map((b) => b.domain)).toEqual(
			Array.from({ length: body.length }, (_, i) => `b${String(i).padStart(4, '0')}.example`)
		)
		expect(body.every((b) => b.comment === comment)).toBe(true)
		const read = await rowsRead(h, publicDomainBlocks, { credential: null })
		// The two setting rows, the admitted blocks and at most the rest of their last chunk.
		expect(read).toBeLessThanOrEqual(2 + body.length + 500)
	}, 120_000)
})
