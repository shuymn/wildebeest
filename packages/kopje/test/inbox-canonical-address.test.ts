import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { AP, mastodonActor, type RemoteWeb, type TestActor } from './inbox-helpers'
import {
	accountId,
	ALICE,
	ALICE_URI,
	AS,
	create,
	DAVE,
	DAVE_URI,
	followed,
	mastodonNote,
	type Setup,
	setup,
} from './inbox-status-helpers'

// The canonical address of a remote account (NET-4, VIS-5), as Mastodon 4.7.3's
// ActivityPub::ProcessAccountService#check_webfinger! and ResolveAccountService decide it: the actor's own host
// declares the address in the subject of its WebFinger answer, another domain in it is a candidate that must name the
// same actor back, and the confirmation holds only for the (username, domain, actor id) it was made for. Aliases never
// set it. Domain blocks match the stored domain and the actor's host alike.

const HOST = 'social.example'
const CANONICAL = 'nice.example'

function serveWebFinger(web: RemoteWeb, resource: string, subject: string, self: string): void {
	const host = resource.split('@')[1]!
	web.serve(
		`https://${host}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`,
		{ subject, links: [{ rel: 'self', type: AP, href: self }] },
		'application/jrd+json'
	)
}

// ali lives on social.example and declares ali@nice.example, which nice.example confirms.
async function splitDomain(t: Setup, extra: Record<string, unknown> = {}): Promise<TestActor> {
	const ali = await mastodonActor(t.web, 'ali', { origin: `https://${HOST}`, key: 3, extra })
	serveWebFinger(t.web, `acct:ali@${HOST}`, `acct:ali@${CANONICAL}`, ali.uri)
	serveWebFinger(t.web, `acct:ali@${CANONICAL}`, `acct:ali@${CANONICAL}`, ali.uri)
	return ali
}

type Found = { accounts: { id: string; acct: string }[] }

const resolve = (t: Setup, address: string, as: 'alice' | 'dave' = 'alice') =>
	t.api<Found>(`/api/v2/search?resolve=true&type=accounts&q=${encodeURIComponent(address)}`, as)

const stored = (t: Setup, uri: string) =>
	sql(t.store, 'SELECT username, domain, confirmed_username FROM accounts WHERE uri = ?', uri)

describe('the canonical address of a remote account', () => {
	it('stores the domain the actor’s host declares and that domain confirms (split domain), with unsigned WebFinger', async () => {
		const t = await setup()
		const ali = await splitDomain(t)
		expect((await resolve(t, `ali@${CANONICAL}`)).body.accounts.map((a) => a.acct)).toEqual([`ali@${CANONICAL}`])
		expect(await stored(t, ali.uri)).toEqual([{ username: 'ali', domain: CANONICAL, confirmed_username: 'ali' }])
		const webfinger = t.web.fetched.flatMap((url, i) =>
			url.includes('/.well-known/webfinger') ? [t.web.signers[i]] : []
		)
		expect(webfinger.length).toBeGreaterThan(0)
		expect(new Set(webfinger)).toEqual(new Set(['unsigned']))
		// An inbound activity with the same username keeps it; the exact address finds it.
		await t.post(ali, { '@context': AS, id: `${ali.uri}#follow`, type: 'Follow', actor: ali.uri, object: DAVE_URI })
		expect(await stored(t, ali.uri)).toEqual([{ username: 'ali', domain: CANONICAL, confirmed_username: 'ali' }])
		const exact = await t.api<Found>(`/api/v2/search?type=accounts&q=ali%40${CANONICAL}`)
		expect(exact.body.accounts.map((a) => a.acct)).toEqual([`ali@${CANONICAL}`])
	})

	it('falls back to the actor’s host when the username changes after the confirmation', async () => {
		const t = await setup()
		const ali = await splitDomain(t)
		await resolve(t, `ali@${CANONICAL}`)
		ali.document.preferredUsername = 'admin'
		t.web.serve(ali.uri, ali.document)
		const update = { '@context': AS, id: `${ali.uri}#update`, type: 'Update', actor: ali.uri, object: ali.document }
		expect(await t.post(ali, update)).toBe(202)
		expect(await stored(t, ali.uri)).toEqual([{ username: 'admin', domain: HOST, confirmed_username: null }])
		const id = (await accountId(t.store, ali.uri))!
		const shown = await t.api<{ acct: string }>(`/api/v1/accounts/${id}`)
		expect(shown.body.acct).toBe(`admin@${HOST}`)
	})

	it('keeps the actor’s host when the declared domain does not name the actor back', async () => {
		const t = await setup()
		const evil = await mastodonActor(t.web, 'alice', { origin: 'https://evil.example', key: 3 })
		serveWebFinger(t.web, 'acct:alice@evil.example', 'acct:alice@victim.example', evil.uri)
		serveWebFinger(
			t.web,
			'acct:alice@victim.example',
			'acct:alice@victim.example',
			'https://victim.example/users/alice'
		)
		expect((await resolve(t, 'alice@evil.example')).body.accounts.map((a) => a.acct)).toEqual(['alice@evil.example'])
		expect(await stored(t, evil.uri)).toEqual([{ username: 'alice', domain: 'evil.example', confirmed_username: null }])
		// victim.example's own address resolves to its own actor, never to the claimant.
		const victim = await resolve(t, 'alice@victim.example')
		expect(victim.body.accounts.map((a) => a.acct)).not.toContain('alice@evil.example')
		expect(await sql(t.store, "SELECT uri FROM accounts WHERE domain = 'victim.example'")).not.toContainEqual({
			uri: evil.uri,
		})
	})

	it('never lets a third-party alias replace a confirmed domain or evade a block on it', async () => {
		const t = await setup()
		const ali = await splitDomain(t)
		await resolve(t, `ali@${CANONICAL}`, 'dave')
		// The third party answers for the actor's own username too, as if it were the actor's domain.
		serveWebFinger(t.web, 'acct:anyone@alias.example', 'acct:anyone@alias.example', ali.uri)
		serveWebFinger(t.web, 'acct:ali@alias.example', 'acct:ali@alias.example', ali.uri)
		expect((await resolve(t, 'anyone@alias.example', 'dave')).body.accounts.map((a) => a.acct)).toEqual([
			`ali@${CANONICAL}`,
		])
		expect(await stored(t, ali.uri)).toEqual([{ username: 'ali', domain: CANONICAL, confirmed_username: 'ali' }])
		// While the host does not answer, the alias leaves the stored address as it is.
		t.web.fail(`https://${HOST}/.well-known/webfinger?resource=${encodeURIComponent(`acct:ali@${HOST}`)}`, 503)
		expect((await resolve(t, 'anyone@alias.example', 'dave')).body.accounts.map((a) => a.acct)).toEqual([
			`ali@${CANONICAL}`,
		])
		expect(await stored(t, ali.uri)).toEqual([{ username: 'ali', domain: CANONICAL, confirmed_username: 'ali' }])
		// A block of the canonical domain holds through the alias, for search and the inbox.
		await sql(t.store, 'INSERT INTO domain_blocks (account_id, domain) VALUES (?, ?)', ALICE, CANONICAL)
		expect((await resolve(t, 'anyone@alias.example')).body.accounts).toEqual([])
		const follow = { '@context': AS, id: `${ali.uri}#follow`, type: 'Follow', actor: ali.uri, object: ALICE_URI }
		expect(await t.post(ali, follow)).toBe(202)
		expect(await sql(t.store, 'SELECT * FROM follows WHERE target_account_id = ?', ALICE)).toEqual([])
	})

	it('applies a block of the actor’s host on every path, whatever domain it was confirmed under (VIS-5)', async () => {
		const t = await setup()
		const ali = await splitDomain(t)
		const mover = await mastodonActor(t.web, 'mover', { origin: 'https://old.example', key: 4 })
		ali.document.alsoKnownAs = [mover.uri]
		t.web.serve(ali.uri, ali.document)
		await resolve(t, `ali@${CANONICAL}`, 'dave')
		// dave follows ali (the helper also has ali follow alice, which is undone here).
		const aliId = await followed(t, ali, DAVE)
		await sql(t.store, 'DELETE FROM follows WHERE account_id = ? AND target_account_id = ?', aliId, ALICE)
		const moverId = await followed(t, mover, ALICE)
		await sql(t.store, 'INSERT INTO domain_blocks (account_id, domain) VALUES (?, ?)', ALICE, HOST)
		expect((await stored(t, ali.uri))[0]).toMatchObject({ domain: CANONICAL })

		// Search, resolution included.
		expect((await resolve(t, `ali@${CANONICAL}`)).body.accounts).toEqual([])
		expect((await t.api<Found>('/api/v2/search?type=accounts&q=ali')).body.accounts).toEqual([])
		expect((await t.api<Found>('/api/v2/search?type=accounts&q=ali', 'dave')).body.accounts.map((a) => a.id)).toEqual([
			aliId,
		])
		// Timelines.
		const note = mastodonNote(ali)
		await t.post(ali, create(ali, note))
		const timeline = (as: 'alice' | 'dave') =>
			t.api<{ uri: string }[]>('/api/v1/timelines/public?remote=true', as).then((r) => r.body.map((s) => s.uri))
		expect(await timeline('dave')).toEqual([note.id])
		expect(await timeline('alice')).toEqual([])
		// Notifications, as read.
		await sql(
			t.store,
			"INSERT INTO notifications (account_id, type, from_account_id, created_at) VALUES (?, 'follow', ?, '2026-10-11T00:00:00Z')",
			ALICE,
			aliId
		)
		expect((await t.api<unknown[]>('/api/v1/notifications')).body).toEqual([])
		// Relationships.
		const relationships = await t.api<{ domain_blocking: boolean }[]>(`/api/v1/accounts/relationships?id[]=${aliId}`)
		expect(relationships.body[0]?.domain_blocking).toBe(true)
		// The inbox.
		const follow = { '@context': AS, id: `${ali.uri}#follow-alice`, type: 'Follow', actor: ali.uri, object: ALICE_URI }
		await t.post(ali, follow)
		expect(
			await sql(t.store, 'SELECT * FROM follows WHERE account_id = ? AND target_account_id = ?', aliId, ALICE)
		).toEqual([])
		// A Move to it does not carry alice's follow over.
		const move = {
			'@context': AS,
			id: `${mover.uri}#move`,
			type: 'Move',
			actor: mover.uri,
			object: mover.uri,
			target: ali.uri,
		}
		expect(await t.post(mover, move)).toBe(202)
		expect(
			await sql(t.store, 'SELECT * FROM follows WHERE account_id = ? AND target_account_id = ?', ALICE, aliId)
		).toEqual([])
		expect(
			await sql(t.store, 'SELECT * FROM follows WHERE account_id = ? AND target_account_id = ?', ALICE, moverId)
		).toEqual([])
	})
})

describe('the domains of WebFinger subjects and addresses, parsed one way', () => {
	async function declaring(t: Setup, subject: string): Promise<TestActor> {
		const ali = await mastodonActor(t.web, 'ali', { origin: `https://${HOST}`, key: 3 })
		serveWebFinger(t.web, `acct:ali@${HOST}`, subject, ali.uri)
		return ali
	}

	for (const subject of [
		`acct:ali@evil.example@${CANONICAL}`,
		`acct:ali@${CANONICAL}.`,
		`acct:ali@${CANONICAL}:443`,
		`acct:@${CANONICAL}`,
		`acct:ali@`,
		`acct:ali@user:pass@${CANONICAL}`,
		'acct:ali@127.0.0.1',
		'acct:ali@localhost',
	]) {
		it(`keeps the actor’s host for a declared subject it cannot read exactly: ${subject}`, async () => {
			const t = await setup()
			const ali = await declaring(t, subject)
			// Even if a domain would confirm whatever a looser parser read from it.
			serveWebFinger(t.web, `acct:ali@${CANONICAL}`, `acct:ali@${CANONICAL}`, ali.uri)
			await resolve(t, `ali@${HOST}`)
			expect(await stored(t, ali.uri)).toEqual([{ username: 'ali', domain: HOST, confirmed_username: null }])
			expect(t.web.fetched.filter((url) => url.startsWith(`https://${CANONICAL}/`))).toEqual([])
		})
	}

	it('stores a declared domain in its normalized form: lowercase, and punycode for an IDN', async () => {
		const t = await setup()
		const ali = await declaring(t, `acct:ali@NICE.Example`)
		serveWebFinger(t.web, `acct:ali@${CANONICAL}`, `acct:ali@${CANONICAL}`, ali.uri)
		await resolve(t, `ali@${HOST}`)
		expect(await stored(t, ali.uri)).toEqual([{ username: 'ali', domain: CANONICAL, confirmed_username: 'ali' }])

		const u = await setup()
		const idn = 'ニース.example'
		const ascii = new URL(`https://${idn}/`).hostname
		expect(ascii).toMatch(/^xn--/)
		const other = await declaring(u, `acct:ali@${idn}`)
		serveWebFinger(u.web, `acct:ali@${ascii}`, `acct:ali@${ascii}`, other.uri)
		await resolve(u, `ali@${HOST}`)
		expect(await stored(u, other.uri)).toEqual([{ username: 'ali', domain: ascii, confirmed_username: 'ali' }])
	})

	it('fetches nothing for an address whose domain carries a port', async () => {
		const t = await setup()
		expect((await resolve(t, `ali@${CANONICAL}:443`)).body.accounts).toEqual([])
		expect(t.web.fetched).toEqual([])
	})
})

describe('round 4: host spellings, transient failures, IDN addresses and candidate subjects', () => {
	it('blocks an actor whose id has another port or a trailing dot by its normalized host (VIS-5)', async () => {
		const t = await setup()
		const ported = await mastodonActor(t.web, 'bob', { origin: 'https://blocked.example:8443', key: 3 })
		const dotted = await mastodonActor(t.web, 'carol', { origin: 'https://blocked.example.', key: 4 })
		await sql(t.store, "INSERT INTO domain_blocks (account_id, domain) VALUES (?, 'blocked.example')", ALICE)
		for (const actor of [ported, dotted]) {
			const follow = { '@context': AS, id: `${actor.uri}#follow`, type: 'Follow', actor: actor.uri, object: ALICE_URI }
			expect(await t.post(actor, follow)).toBe(202)
			// Mastodon's normalized_host: the hostname without its port, lowercase, punycode; here also without a dot.
			expect(await sql(t.store, 'SELECT domain FROM accounts WHERE uri = ?', actor.uri)).toEqual([
				{ domain: 'blocked.example' },
			])
		}
		expect(await sql(t.store, 'SELECT * FROM follows WHERE target_account_id = ?', ALICE)).toEqual([])
		expect((await t.api<Found>('/api/v2/search?type=accounts&q=blocked.example')).body.accounts).toEqual([])
	})

	it('keeps a confirmation through a transient failure at the candidate, and drops it on an authoritative 404', async () => {
		const t = await setup()
		const ali = await splitDomain(t)
		await resolve(t, `ali@${CANONICAL}`)
		const candidate = `https://${CANONICAL}/.well-known/webfinger?resource=${encodeURIComponent(`acct:ali@${CANONICAL}`)}`
		serveWebFinger(t.web, 'acct:anyone@alias.example', 'acct:anyone@alias.example', ali.uri)
		t.web.fail(candidate, 503)
		await resolve(t, 'anyone@alias.example', 'dave')
		expect(await stored(t, ali.uri)).toEqual([{ username: 'ali', domain: CANONICAL, confirmed_username: 'ali' }])
		t.web.fail(candidate, 404)
		await resolve(t, 'anyone@alias.example', 'dave')
		expect(await stored(t, ali.uri)).toEqual([{ username: 'ali', domain: HOST, confirmed_username: null }])
	})

	it('stores no confirmation when the candidate names the actor under another subject', async () => {
		for (const subject of [`acct:someone@${CANONICAL}`, 'acct:ali@other.example']) {
			const t = await setup()
			const ali = await mastodonActor(t.web, 'ali', { origin: `https://${HOST}`, key: 3 })
			serveWebFinger(t.web, `acct:ali@${HOST}`, `acct:ali@${CANONICAL}`, ali.uri)
			// The right actor id as self, under the wrong subject.
			serveWebFinger(t.web, `acct:ali@${CANONICAL}`, subject, ali.uri)
			await resolve(t, `ali@${HOST}`)
			expect(await stored(t, ali.uri), subject).toEqual([{ username: 'ali', domain: HOST, confirmed_username: null }])
		}
	})

	it('finds an IDN address in its Unicode and punycode forms alike', async () => {
		const t = await setup()
		const unicode = 'ニース.example'
		const ascii = new URL(`https://${unicode}/`).hostname
		const ali = await mastodonActor(t.web, 'ali', { origin: `https://${HOST}`, key: 3 })
		serveWebFinger(t.web, `acct:ali@${HOST}`, `acct:ali@${ascii}`, ali.uri)
		serveWebFinger(t.web, `acct:ali@${ascii}`, `acct:ali@${ascii}`, ali.uri)
		const resolved = await resolve(t, `ali@${unicode}`)
		expect(resolved.body.accounts.map((a) => a.acct)).toEqual([`ali@${ascii}`])
		const id = resolved.body.accounts[0]!.id
		for (const domain of [unicode, ascii]) {
			const exact = await t.api<Found>(`/api/v2/search?type=accounts&q=${encodeURIComponent(`ali@${domain}`)}`)
			expect(
				exact.body.accounts.map((a) => a.id),
				domain
			).toEqual([id])
			const lookup = await t.api<{ id: string }>(`/api/v1/accounts/lookup?acct=${encodeURIComponent(`ali@${domain}`)}`)
			expect(lookup.body.id, domain).toBe(id)
		}
	})
})
