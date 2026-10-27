import { runInDurableObject } from 'cloudflare:test'

import { beforeAll, describe, expect, it } from 'vitest'

import { type AccessTeam, accessToken, adminHarness, adminTeam, serviceClaims, setTeamAccess } from './access-helpers'
import { BUILD, LATEST_MIGRATION, migratedStore } from './helpers'
import { ADMIN_AUD, ADMIN_EMAIL, memoryIO, SERVICE_CLIENT_ID, seedStore, tableSnapshot } from './ops-helpers'
import { linkPosts, storedLink, author as trendAuthor, trendStatus } from './trend-helpers'
import { run } from '../cli/lib/main.js'
import type { StoreStub } from '../src/platform/store-client'

let team: AccessTeam

beforeAll(async () => {
	team = await adminTeam()
})

const CLIENT_ID = 'cli-client.access'
const CLIENT_SECRET = 'service-token-secret-value-0123456789'
const IMPORT_TOKEN = 'import-token-0123456789abcdef0123456789'

type Hook = (request: Request, forward: () => Promise<Response>) => Promise<Response>

// The Worker behind an Access edge: the edge turns a valid service token into a JWT and redirects anything else to
// its login page, like Cloudflare Access does.
function edge(store: StoreStub, hook?: Hook, env: Record<string, unknown> = {}) {
	const { app, env: testEnv } = adminHarness(store, team, { IMPORT_TOKEN, ...env })
	const seen: Request[] = []
	const fetch = async (input: string, init?: RequestInit) => {
		const request = new Request(input, init)
		seen.push(request.clone())
		if (
			request.headers.get('CF-Access-Client-Id') !== CLIENT_ID ||
			request.headers.get('CF-Access-Client-Secret') !== CLIENT_SECRET
		) {
			return new Response(null, { status: 302, headers: { location: 'https://team.cloudflareaccess.com/login' } })
		}
		const headers = new Headers(request.headers)
		headers.delete('CF-Access-Client-Id')
		headers.delete('CF-Access-Client-Secret')
		headers.set('Cf-Access-Jwt-Assertion', await accessToken(team, serviceClaims()))
		const forwarded = new Request(request, { headers })
		const forward = async () =>
			app.fetch(forwarded, testEnv, { waitUntil: () => {}, passThroughOnException: () => {} } as never)
		return hook === undefined ? forward() : hook(forwarded, forward)
	}
	return { fetch, seen }
}

function streams() {
	const out: string[] = []
	const err: string[] = []
	return {
		stdout: { write: (text: string) => void out.push(text), isTTY: false },
		stderr: { write: (text: string) => void err.push(text), isTTY: false },
		out: () => out.join(''),
		err: () => err.join(''),
	}
}

const ENV = {
	KOPJE_ADMIN_URL: 'https://admin.kopje.test',
	CF_ACCESS_CLIENT_ID: CLIENT_ID,
	CF_ACCESS_CLIENT_SECRET: CLIENT_SECRET,
	KOPJE_IMPORT_TOKEN: IMPORT_TOKEN,
}

async function cli(
	argv: string[],
	options: {
		fetch: (input: string, init?: RequestInit) => Promise<Response>
		io?: ReturnType<typeof memoryIO>
		env?: Record<string, string | undefined>
		platform?: string
	}
) {
	const s = streams()
	const code = await run({
		argv,
		env: { ...ENV, ...options.env },
		io: options.io ?? memoryIO(),
		stdout: s.stdout,
		stderr: s.stderr,
		fetch: options.fetch,
		sleep: () => Promise.resolve(),
		platform: options.platform ?? 'linux',
	})
	return { code, out: s.out(), err: s.err() }
}

async function sourceStore(statuses = 30): Promise<StoreStub> {
	const store = await migratedStore()
	await seedStore(store, statuses)
	await setTeamAccess(store, team)
	return store
}

function withoutState(snapshot: Record<string, string[]>) {
	const { kopje_state: _s, ...rest } = snapshot
	return rest
}

describe('kopje-admin', () => {
	it('dumps to a file and imports it into an empty Store with the import token', async () => {
		const source = await sourceStore()
		const io = memoryIO()
		const dumped = await cli(['dump', 'backup.sql', '--chunk-mib', '1'], { fetch: edge(source).fetch, io })
		expect(dumped.code, dumped.err).toBe(0)
		expect(io.text('backup.sql')).toMatch(/-- kopje-dump-end\n$/)
		expect(io.files.has('backup.sql.state.json')).toBe(false)

		const target = await migratedStore()
		const imported = await cli(['import', 'backup.sql', '--import-token', '--chunk-mib', '1'], {
			fetch: edge(target).fetch,
			io,
		})
		expect(imported.code, imported.err).toBe(0)
		expect(JSON.parse(imported.out)).toMatchObject({ ok: true })
		expect(imported.err).toContain('import verified')
		// The dump's Access rows did not configure the target: it is still in bootstrap.
		expect((await cli(['health'], { fetch: edge(target).fetch })).code).toBe(1)

		// The cutover sets them explicitly, with the import token, while the Store has no admin access.
		const configured = await cli(
			[
				'config',
				'--import-token',
				`access_team_domain=${team.teamDomain}`,
				`access_admin_aud=${ADMIN_AUD}`,
				`admin_email=${ADMIN_EMAIL}`,
				`access_service_token_client_id=${SERVICE_CLIENT_ID}`,
				'domain=kopje.test',
			],
			{ fetch: edge(target).fetch }
		)
		expect(configured.code, configured.err).toBe(0)
		expect((await cli(['health'], { fetch: edge(target).fetch })).code).toBe(0)
		expect((await cli(['config', '--import-token', 'domain=x.test'], { fetch: edge(target).fetch })).code).toBe(1)
		expect(withoutState(await tableSnapshot(target))).toEqual(withoutState(await tableSnapshot(source)))
	})

	it('resumes a dump after a crash mid-write without gaps or overlaps', async () => {
		const source = await sourceStore(60)
		const straight = memoryIO()
		expect((await cli(['dump', 'a.sql', '--chunk-mib', '1'], { fetch: edge(source).fetch, io: straight })).code).toBe(0)

		const io = memoryIO()
		let appends = 0
		io.failAppend = (path, bytes) => (path === 'b.sql' && ++appends === 3 ? bytes.slice(0, 10) : null)
		const crashed = await cli(['dump', 'b.sql', '--chunk-mib', '0.002'], { fetch: edge(source).fetch, io })
		expect(crashed.code).toBe(1)
		expect(crashed.err).toContain('disk full')
		expect(io.files.has('b.sql.state.json')).toBe(true)

		io.failAppend = null
		const resumed = await cli(['dump', 'b.sql', '--chunk-mib', '0.002'], { fetch: edge(source).fetch, io })
		expect(resumed.code, resumed.err).toBe(0)
		expect(resumed.err).toContain('resuming dump')
		expect(bodyAndTrailer(io.text('b.sql'))).toEqual(bodyAndTrailer(straight.text('a.sql')))
	})

	it('resumes an import after a lost response and after a crash', async () => {
		const io = memoryIO()
		expect(
			(await cli(['dump', 'c.sql', '--chunk-mib', '1'], { fetch: edge(await sourceStore(60)).fetch, io })).code
		).toBe(0)
		const target = await migratedStore()

		// Chunk 2 is applied but its response is lost; chunk 4 never arrives because the process dies.
		let chunks = 0
		let dead = false
		const flaky = edge(target, async (request, forward) => {
			if (dead) {
				throw new TypeError('network connection lost')
			}
			if (new URL(request.url).pathname === '/admin/import/chunk') {
				chunks++
				if (chunks === 2) {
					await forward()
					throw new TypeError('network connection lost')
				}
				if (chunks === 4) {
					dead = true
					throw new TypeError('network connection lost')
				}
			}
			return forward()
		})
		const first = await cli(['import', 'c.sql', '--import-token', '--chunk-mib', '0.004'], { fetch: flaky.fetch, io })
		expect(first.code).toBe(1)
		expect(first.err).toContain('chunk 2 was applied despite the error')

		// The chunk size of the first run is kept, so the digests line up.
		const second = await cli(['import', 'c.sql', '--import-token'], { fetch: edge(target).fetch, io })
		expect(second.code, second.err).toBe(0)
		expect(second.err).toMatch(/resuming import .* after chunk 3/)
		expect(JSON.parse(second.out)).toMatchObject({ ok: true })
	})

	it('never prints secrets and explains an Access refusal', async () => {
		const store = await sourceStore(0)
		const wrongSecret = await cli(['health'], {
			fetch: edge(store).fetch,
			env: { CF_ACCESS_CLIENT_SECRET: 'wrong-secret-value' },
		})
		expect(wrongSecret.code).toBe(1)
		expect(wrongSecret.err).toContain('check the Access service token')

		const { fetch, seen } = edge(store)
		const health = await cli(['health'], { fetch })
		expect(health.code).toBe(0)
		const sql = await cli(['sql', `SELECT '${CLIENT_SECRET}' AS echoed`], { fetch })
		for (const text of [wrongSecret.out, wrongSecret.err, health.out, health.err, sql.out, sql.err]) {
			expect(text).not.toContain(CLIENT_SECRET)
			expect(text).not.toContain(IMPORT_TOKEN)
		}
		expect(sql.out).toContain('***')
		// The import token is only sent with --import-token.
		expect(seen.every((r) => !r.headers.has('Kopje-Import-Token'))).toBe(true)
	})

	it('runs the small commands', async () => {
		const store = await sourceStore(0)
		const { fetch } = edge(store)
		expect(JSON.parse((await cli(['version'], { fetch })).out)).toMatchObject({ store: { applied: LATEST_MIGRATION } })
		expect((await cli(['capacity'], { fetch })).out).toMatch(/^database .*(?:\n +\d+ {2}\w+)*\n +\d+ {2}accounts$/m)
		expect(JSON.parse((await cli(['spool'], { fetch })).out)).toMatchObject({ parts: 1 })
		expect(JSON.parse((await cli(['maintenance', 'on'], { fetch })).out)).toEqual({ maintenance: true })
		expect(JSON.parse((await cli(['maintenance', 'off'], { fetch })).out)).toEqual({ maintenance: false })
		expect(JSON.parse((await cli(['upgrade', 'retry'], { fetch })).out)).toMatchObject({ ok: true })
		expect(JSON.parse((await cli(['pitr', 'bookmark'], { fetch })).out)).toMatchObject({ bookmark: expect.any(String) })
		expect(JSON.parse((await cli(['sql', 'SELECT count(*) AS n FROM accounts'], { fetch })).out)).toMatchObject({
			rows: [[2]],
		})
		const refused = await cli(['sql', 'DELETE FROM accounts'], { fetch })
		expect(refused.code).toBe(1)
		expect(refused.err).toContain('only a single SELECT or WITH statement')
	})

	it('lists given-up deliveries and retries them (RES-5)', async () => {
		const store = await sourceStore(0)
		const { fetch } = edge(store)
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			const { account_id } = sql.exec<{ account_id: string }>('SELECT account_id FROM local_accounts LIMIT 1').one()
			sql.exec(
				`INSERT INTO outbound_activities (id, account_id, body, created_at)
				VALUES (1, ?, '{"activity":{"id":"https://kopje.test/x","type":"Create"},"audience":{"followers":true,"accounts":[]}}', 0)`,
				account_id
			)
			sql.exec(
				`INSERT INTO deliveries (id, activity_id, account_id, inbox_url, lane, state, attempts, next_attempt_at,
					last_status, last_error, updated_at)
				VALUES (7, 1, ?, 'https://remote.example/inbox', 'https://remote.example', 'gave_up', 15, 0, 410, 'HTTP 410', 0)`,
				account_id
			)
		})
		const listed = JSON.parse((await cli(['deliveries'], { fetch })).out)
		expect(listed).toMatchObject({
			backlog: { gaveUp: 1, pending: 0 },
			gaveUp: [{ id: '7', inbox: 'https://remote.example/inbox', activityType: 'Create', lastStatus: 410 }],
		})
		expect(JSON.parse((await cli(['deliveries', 'retry', '7'], { fetch })).out)).toEqual({
			retried: 1,
			skipped: 0,
			refused: 0,
			more: false,
			next: null,
		})
		expect(JSON.parse((await cli(['deliveries'], { fetch })).out)).toMatchObject({ backlog: { gaveUp: 0, pending: 1 } })
		expect(JSON.parse((await cli(['deliveries', 'retry', '--all'], { fetch })).out)).toEqual({
			retried: 0,
			skipped: 0,
			refused: 0,
		})
		// A superseded activity (its Undo or Delete was recorded since) is refused with a reason.
		await runInDurableObject(store, (_instance, state) => {
			state.storage.sql.exec("UPDATE deliveries SET state = 'gave_up', lease_token = NULL WHERE id = 7")
			state.storage.sql.exec('UPDATE outbound_activities SET superseded = 1 WHERE id = 1')
		})
		const refused = await cli(['deliveries', 'retry', '7'], { fetch })
		expect(refused.code).toBe(1)
		expect(refused.err).toContain('supersedes')
		expect(JSON.parse((await cli(['deliveries', 'retry', '--all'], { fetch })).out)).toEqual({
			retried: 0,
			skipped: 1,
			refused: 0,
		})
		expect((await cli(['deliveries', 'retry'], { fetch })).code).toBe(2)
		expect((await cli(['deliveries', 'retry', '7', '--all'], { fetch })).code).toBe(2)
		expect((await cli(['deliveries', '--before', 'x'], { fetch })).code).toBe(2)
	})

	it('makes every failing job fresh, a page at a time (RES-5)', async () => {
		const store = await sourceStore(0)
		const { fetch, seen } = edge(store)
		await runInDurableObject(store, (_instance, state) => {
			state.storage.sql.exec(
				`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 150)
				INSERT INTO inbound_jobs (kind, key, actor_uri, created_at, attempts, due_at)
				SELECT 'delete', printf('9%017d', i), 'https://remote.example/users/x', i, 6, NULL FROM k`
			)
		})
		expect(JSON.parse((await cli(['jobs', 'retry'], { fetch })).out)).toEqual({ reset: 150 })
		expect(seen.filter((r) => new URL(r.url).pathname === '/admin/jobs/retry')).toHaveLength(2)
		await runInDurableObject(store, (_instance, state) => {
			expect(state.storage.sql.exec('SELECT count(*) AS n FROM inbound_jobs WHERE attempts > 0').one().n).toBe(0)
		})
		expect((await cli(['jobs'], { fetch })).code).toBe(2)
		expect((await cli(['jobs', 'retry', 'x'], { fetch })).code).toBe(2)
	})

	it("sets the instance's public settings, a document from a file with its other values in one request", async () => {
		const store = await sourceStore(0)
		const { fetch, seen } = edge(store)
		const io = memoryIO(new Map([['terms.html', new TextEncoder().encode('<p>Terms</p>\n')]]))
		const set = await cli(['instance', 'title=Herd', 'show_domain_blocks=users'], { fetch })
		expect(set.code, set.err).toBe(0)
		expect(JSON.parse(set.out)).toMatchObject({ values: { title: 'Herd', show_domain_blocks: 'users' } })
		const before = seen.length
		const terms = await cli(
			['instance', 'terms_of_service', '--file', 'terms.html', 'terms_of_service_effective_date=2026-11-01'],
			{ fetch, io }
		)
		expect(terms.code, terms.err).toBe(0)
		// One request carried both: the first terms of service needs its date.
		expect(seen.length - before).toBe(1)
		expect(await seen.at(-1)?.json()).toEqual({
			values: { terms_of_service: '<p>Terms</p>\n', terms_of_service_effective_date: '2026-11-01' },
		})
		expect(JSON.parse((await cli(['instance'], { fetch })).out)).toEqual({
			values: {
				title: 'Herd',
				terms_of_service: '<p>Terms</p>',
				terms_of_service_effective_date: '2026-11-01',
				show_domain_blocks: 'users',
			},
		})
		// An empty value removes.
		expect((await cli(['instance', 'title='], { fetch })).code).toBe(0)
		expect(JSON.parse((await cli(['instance'], { fetch })).out).values).not.toHaveProperty('title')
		// A refused value exits 1; malformed arguments and the import token exit 2 before any request.
		expect((await cli(['instance', 'title= '], { fetch })).code).toBe(1)
		const count = seen.length
		for (const argv of [
			['instance', 'title'],
			['instance', 'title=a', 'title=b'],
			['instance', 'terms_of_service=x', '--file', 'terms.html'],
			['instance', '--import-token'],
		]) {
			expect((await cli(argv, { fetch, io })).code, argv.join(' ')).toBe(2)
		}
		expect(seen.length).toBe(count)
	})

	it('adds, lists and removes account invitations (AUTH-9)', async () => {
		const store = await sourceStore(0)
		const { fetch, seen } = edge(store)
		const added = await cli(['invitation', 'add', 'bob@example.com', 'bob'], { fetch })
		expect(added.code, added.err).toBe(0)
		expect(JSON.parse(added.out)).toMatchObject({ invitation: { email: 'bob@example.com', username: 'bob' } })
		expect(JSON.parse((await cli(['invitation'], { fetch })).out)).toMatchObject({
			invitations: [{ email: 'bob@example.com', username: 'bob' }],
		})
		const taken = await cli(['invitation', 'add', 'carol@example.com', 'BOB'], { fetch })
		expect(taken.code).toBe(1)
		expect(taken.err).toContain('already has @BOB')
		expect(JSON.parse((await cli(['invitation', 'remove', 'BOB@example.com'], { fetch })).out)).toMatchObject({
			removed: { username: 'bob' },
		})
		expect((await cli(['invitation', 'remove', 'bob@example.com'], { fetch })).code).toBe(1)
		expect((await cli(['moderation-log'], { fetch })).out).toContain('"target_type": "AccountInvitation"')
		// Malformed arguments exit 2 before any request.
		const count = seen.length
		for (const argv of [
			['invitation', 'add', 'bob@example.com'],
			['invitation', 'add', 'bob@example.com', 'bob', 'x'],
			['invitation', 'remove'],
			['invitation', 'list'],
		]) {
			expect((await cli(argv, { fetch })).code, argv.join(' ')).toBe(2)
		}
		expect(seen.length).toBe(count)
	})

	it("sets a local account's email and shows the moderation log (VIS-29, AUTH-5)", async () => {
		const store = await sourceStore(0)
		const { fetch } = edge(store)
		expect(JSON.parse((await cli(['account', 'set-email', 'alice', ADMIN_EMAIL], { fetch })).out)).toEqual({
			username: 'alice',
			email: ADMIN_EMAIL,
		})
		expect(JSON.parse((await cli(['health'], { fetch })).out)).toMatchObject({
			oauthAdmin: { status: 'ok', username: 'alice' },
		})
		const log = JSON.parse((await cli(['moderation-log'], { fetch })).out)
		expect(log).toMatchObject({
			entries: [
				{
					actor: 'access',
					action: 'change_email',
					target_type: 'Account',
					// The service token's client id; the CLI masks its own credentials in what it prints.
					detail: { username: 'alice', identity: '***' },
				},
			],
			next: null,
		})
		expect(JSON.parse((await cli(['moderation-log', '--before', log.entries[0].id], { fetch })).out)).toEqual({
			entries: [],
			next: null,
		})
		const missing = await cli(['account', 'set-email', 'nobody', 'n@example.com'], { fetch })
		expect(missing.code).toBe(1)
		expect(missing.err).toContain('no local account @nobody')
		expect((await cli(['account', 'set-email', 'alice'], { fetch })).code).toBe(2)
		const awake = await cli(['account', 'unsuspend', 'alice'], { fetch })
		expect(awake.code).toBe(1)
		expect(awake.err).toContain('@alice is not suspended')
		await runInDurableObject(store, (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE local_accounts SET suspended_at = '2026-10-01T00:00:00.000Z', credential_epoch = 1 WHERE account_id = (SELECT id FROM accounts WHERE username = 'alice')"
			)
		})
		expect(JSON.parse((await cli(['account', 'unsuspend', '@alice'], { fetch })).out)).toEqual({ username: 'alice' })
		expect((await cli(['moderation-log'], { fetch })).out).toContain('"action": "unsuspend"')
		expect((await cli(['account', 'unsuspend'], { fetch })).code).toBe(2)
		expect((await cli(['account', 'unsuspend', 'alice', 'x'], { fetch })).code).toBe(2)
		expect((await cli(['moderation-log', '--before', 'x'], { fetch })).code).toBe(2)
	})

	it('lists trends with their reviews, and approves and rejects hashtags and posts, each logged', async () => {
		const store = await sourceStore(0)
		const { fetch, seen } = edge(store)
		const author = await trendAuthor(store, 'trender', { domain: 'remote.example' })
		const post = await trendStatus(store, { author, published: Date.now() - 3_600_000, favourites: 9 })
		await store.trendsRound(BUILD, { now: Date.now() })
		const listed = await cli(['trends'], { fetch })
		expect(listed.code, listed.err).toBe(0)
		expect(listed.out).toContain('"tags": []')
		expect(listed.out).toContain(`"id": "${post}"`)
		expect(listed.out).toContain('"requires_review": true')
		const tag = await cli(['trends', 'approve-tag', 'Kopje'], { fetch })
		expect(JSON.parse(tag.out)).toMatchObject({ name: 'kopje', trendable: true, requires_review: false, score: 0 })
		expect(JSON.parse((await cli(['trends', 'reject', post], { fetch })).out)).toMatchObject({
			id: post,
			trendable: false,
			requires_review: false,
		})
		expect(JSON.parse((await cli(['trends', 'approve', post, '--author'], { fetch })).out)).toMatchObject({
			id: post,
			trendable: false,
		})
		expect(await seen.at(-1)?.json()).toEqual({ author: true })
		expect(JSON.parse((await cli(['trends', 'statuses', '--offset', '1'], { fetch })).out)).toMatchObject({
			statuses: [],
		})
		const log = JSON.parse((await cli(['moderation-log'], { fetch })).out) as {
			entries: { action: string; target_type: string }[]
		}
		expect(log.entries.map((e) => [e.action, e.target_type])).toEqual([
			['approve', 'Account'],
			['reject', 'Status'],
			['approve', 'Tag'],
		])
		// A refusal exits 1; malformed arguments exit 2 before any request.
		expect((await cli(['trends', 'approve-tag', 'not a tag'], { fetch })).code).toBe(1)
		expect((await cli(['trends', 'approve', '999999999999999999'], { fetch })).code).toBe(1)
		const count = seen.length
		for (const argv of [
			['trends', 'links', 'x'],
			['trends', 'bogus'],
			['trends', 'tags', 'x'],
			['trends', '--offset', 'x'],
			['trends', 'approve', 'x'],
			['trends', 'approve-tag'],
			['trends', 'approve', post, post],
		]) {
			expect((await cli(argv, { fetch })).code, argv.join(' ')).toBe(2)
		}
		expect(seen.length).toBe(count)
	})

	it('lists link trends and publishers, and reviews links and publishers, each logged', async () => {
		const store = await sourceStore(0)
		const { fetch, seen } = edge(store)
		const author = await trendAuthor(store, 'linker', { domain: 'remote.example' })
		const link = 'https://a.news.example/story'
		await linkPosts(store, [author], link, Date.now() - 3_600_000)
		await storedLink(store, link, 3, 3, Date.now())
		const listed = await cli(['trends', 'links'], { fetch })
		expect(listed.code, listed.err).toBe(0)
		expect(JSON.parse(listed.out)).toMatchObject({ links: [{ url: link, requires_review: true, score: 3 }] })
		expect(JSON.parse((await cli(['trends', 'approve-link', link], { fetch })).out)).toMatchObject({
			url: link,
			trendable: true,
		})
		expect(JSON.parse((await cli(['trends', 'reject-link', link, '--publisher'], { fetch })).out)).toMatchObject({
			url: link,
			trendable: false,
			publisher: { domain: 'a.news.example', trendable: false },
		})
		expect(await seen.at(-1)?.json()).toEqual({ url: link, publisher: true })
		expect(JSON.parse((await cli(['trends', 'approve-publisher', 'News.Example'], { fetch })).out)).toMatchObject({
			domain: 'news.example',
			trendable: true,
		})
		expect(JSON.parse((await cli(['trends', 'publishers'], { fetch })).out)).toMatchObject({
			publishers: [
				{ domain: 'a.news.example', trendable: false },
				{ domain: 'news.example', trendable: true },
			],
		})
		const log = JSON.parse((await cli(['moderation-log'], { fetch })).out) as {
			entries: { action: string; target_type: string }[]
		}
		expect(log.entries.map((e) => [e.action, e.target_type])).toEqual([
			['approve', 'PreviewCardProvider'],
			['reject', 'PreviewCardProvider'],
			['approve', 'PreviewCard'],
		])
		// A refusal exits 1; malformed arguments exit 2 before any request.
		expect((await cli(['trends', 'approve-link', 'http://a.news.example/'], { fetch })).code).toBe(1)
		expect((await cli(['trends', 'approve-publisher', 'example'], { fetch })).code).toBe(1)
		const count = seen.length
		for (const argv of [
			['trends', 'approve-link'],
			['trends', 'approve-link', link, link],
			['trends', 'reject-publisher'],
			['trends', 'publishers', 'x'],
		]) {
			expect((await cli(argv, { fetch })).code, argv.join(' ')).toBe(2)
		}
		expect(seen.length).toBe(count)
	})

	it('adds, lists, changes, publishes, unpublishes and deletes announcements, each logged', async () => {
		const store = await sourceStore(0)
		const { fetch, seen } = edge(store)
		const io = memoryIO(
			new Map([
				['hello.txt', new TextEncoder().encode('Hello #kopje\n')],
				['changed.txt', new TextEncoder().encode('Changed')],
			])
		)
		const added = await cli(
			[
				'announcement',
				'add',
				'hello.txt',
				'--starts',
				'2026-11-01',
				'--ends',
				'2026-11-02',
				'--all-day',
				'--at',
				'2099-01-01',
			],
			{ fetch, io }
		)
		expect(added.code, added.err).toBe(0)
		expect(await seen.at(-1)?.json()).toEqual({
			text: 'Hello #kopje\n',
			startsAt: '2026-11-01',
			endsAt: '2026-11-02',
			allDay: true,
			scheduledAt: '2099-01-01',
		})
		const { id } = JSON.parse(added.out) as { id: string }
		expect(JSON.parse(added.out)).toMatchObject({ published: false, scheduled_at: '2099-01-01T00:00:00.000Z' })
		const set = await cli(['announcement', 'set', id, 'text=changed.txt', 'at=', 'all-day=off'], { fetch, io })
		expect(set.code, set.err).toBe(0)
		expect(await seen.at(-1)?.json()).toEqual({ text: 'Changed', scheduledAt: null, allDay: false })
		expect(JSON.parse((await cli(['announcement', 'publish', id], { fetch })).out)).toMatchObject({ published: true })
		expect(JSON.parse((await cli(['announcement', 'unpublish', id], { fetch })).out)).toMatchObject({
			published: false,
		})
		expect(JSON.parse((await cli(['announcement'], { fetch })).out)).toMatchObject({
			announcements: [{ id, text: 'Changed' }],
			next: null,
		})
		expect((await cli(['announcement', 'delete', id], { fetch })).code).toBe(2)
		expect(JSON.parse((await cli(['announcement', 'delete', id, '--yes'], { fetch })).out)).toEqual({ deleted: id })
		const log = JSON.parse((await cli(['moderation-log'], { fetch })).out) as { entries: { action: string }[] }
		expect(log.entries.map((entry) => entry.action)).toEqual(['delete', 'unpublish', 'publish', 'update', 'create'])
		// A refusal exits 1; malformed arguments exit 2 before any request.
		const blank = memoryIO(new Map([['blank.txt', new TextEncoder().encode(' ')]]))
		expect((await cli(['announcement', 'add', 'blank.txt'], { fetch, io: blank })).code).toBe(1)
		const count = seen.length
		for (const argv of [
			['announcement', 'add'],
			['announcement', 'add', 'hello.txt', '--starts', '2026-11-01'],
			['announcement', 'set', id],
			['announcement', 'set', id, 'colour=red'],
			['announcement', 'set', id, 'all-day=yes'],
			['announcement', 'publish', 'x'],
			['announcement', 'publish', id, id],
			['announcement', '--before', 'x'],
			['announcement', 'pin', id],
		]) {
			expect((await cli(argv, { fetch, io })).code, argv.join(' ')).toBe(2)
		}
		expect(seen.length).toBe(count)
	})

	it('checks its arguments', async () => {
		const { fetch } = edge(await sourceStore(0))
		expect((await cli([], { fetch })).code).toBe(2)
		expect((await cli(['maintenance', 'maybe'], { fetch })).code).toBe(2)
		expect((await cli(['pitr', 'restore', 'abc'], { fetch })).code).toBe(2)
		expect((await cli(['import-reset'], { fetch })).code).toBe(2)
		expect((await cli(['dump', 'x.sql', '--chunk-mib', '99'], { fetch })).code).toBe(2)
		expect((await cli(['health'], { fetch, env: { KOPJE_ADMIN_URL: undefined } })).code).toBe(2)
		expect((await cli(['health'], { fetch, env: { KOPJE_ADMIN_URL: 'http://admin.kopje.test' } })).code).toBe(1)
		expect((await cli(['import', 'x.sql', '--import-token'], { fetch, env: { KOPJE_IMPORT_TOKEN: '' } })).code).toBe(2)
	})

	it('completes a dump whose finish response was lost', async () => {
		const source = await sourceStore(0)
		const io = memoryIO()
		const lost = edge(source, async (request, forward) => {
			const response = await forward()
			if (new URL(request.url).pathname === '/admin/dump/finish') {
				throw new TypeError('network connection lost')
			}
			return response
		})
		expect((await cli(['dump', 'd.sql'], { fetch: lost.fetch, io })).code).toBe(1)
		const rerun = await cli(['dump', 'd.sql'], { fetch: edge(source).fetch, io })
		expect(rerun.code, rerun.err).toBe(0)
		expect(io.text('d.sql')).toMatch(/-- kopje-dump-end\n$/)
	})

	// Interrupted before the first verify call reached the Store; a lost verify response is the next tests' case.
	it('resumes an import that was interrupted before verification', async () => {
		const io = memoryIO()
		expect((await cli(['dump', 'e.sql'], { fetch: edge(await sourceStore(0)).fetch, io })).code).toBe(0)
		const target = await migratedStore()
		const interrupted = edge(target, async (request, forward) => {
			if (new URL(request.url).pathname === '/admin/import/verify') {
				throw new TypeError('network connection lost')
			}
			return forward()
		})
		expect((await cli(['import', 'e.sql', '--import-token'], { fetch: interrupted.fetch, io })).code).toBe(1)
		const rerun = await cli(['import', 'e.sql', '--import-token'], { fetch: edge(target).fetch, io })
		expect(rerun.code, rerun.err).toBe(0)
		expect(JSON.parse(rerun.out)).toMatchObject({ ok: true })
	})

	it('releases the remote freeze before --restart discards a dump in progress', async () => {
		const source = await sourceStore(60)
		const io = memoryIO()
		let appends = 0
		io.failAppend = (path, bytes) => (path === 'f.sql' && ++appends === 3 ? bytes.slice(0, 10) : null)
		expect((await cli(['dump', 'f.sql', '--chunk-mib', '0.002'], { fetch: edge(source).fetch, io })).code).toBe(1)
		expect(await source.health(BUILD)).toMatchObject({ dump: { id: expect.any(String) } })

		io.failAppend = null
		const restarted = await cli(['dump', 'f.sql', '--restart'], { fetch: edge(source).fetch, io })
		expect(restarted.code, restarted.err).toBe(0)
		expect(await source.health(BUILD)).toMatchObject({ dump: null })
	})

	it('aborts the remote dump when writing its header fails, and --restart recovers', async () => {
		const source = await sourceStore(0)
		const io = memoryIO()
		io.failAppend = (path, bytes) => (path === 'g.sql' ? bytes.slice(0, 5) : null)
		const failed = await cli(['dump', 'g.sql'], { fetch: edge(source).fetch, io })
		expect(failed.code).toBe(1)
		expect(await source.health(BUILD)).toMatchObject({ dump: null })

		io.failAppend = null
		const restarted = await cli(['dump', 'g.sql', '--restart'], { fetch: edge(source).fetch, io })
		expect(restarted.code, restarted.err).toBe(0)
		expect(io.text('g.sql')).toMatch(/-- kopje-dump-end\n$/)
	})

	it('continues the same dump when the start response was lost', async () => {
		const source = await sourceStore(0)
		const io = memoryIO()
		const lost = edge(source, async (request, forward) => {
			const response = await forward()
			if (new URL(request.url).pathname === '/admin/dump/start') {
				throw new TypeError('network connection lost')
			}
			return response
		})
		expect((await cli(['dump', 'h.sql'], { fetch: lost.fetch, io })).code).toBe(1)
		expect(await source.health(BUILD)).toMatchObject({ dump: { id: expect.any(String) } })
		const rerun = await cli(['dump', 'h.sql'], { fetch: edge(source).fetch, io })
		expect(rerun.code, rerun.err).toBe(0)
		expect(await source.health(BUILD)).toMatchObject({ dump: null })
	})

	it('reports a verified import whose verify response was lost', async () => {
		const io = memoryIO()
		expect((await cli(['dump', 'i.sql'], { fetch: edge(await sourceStore(0)).fetch, io })).code).toBe(0)
		const target = await migratedStore()
		const lost = edge(target, async (request, forward) => {
			const response = await forward()
			if (new URL(request.url).pathname === '/admin/import/verify') {
				throw new TypeError('network connection lost')
			}
			return response
		})
		expect((await cli(['import', 'i.sql', '--import-token'], { fetch: lost.fetch, io })).code).toBe(1)
		const rerun = await cli(['import', 'i.sql', '--import-token'], { fetch: edge(target).fetch, io })
		expect(rerun.code, rerun.err).toBe(0)
		expect(JSON.parse(rerun.out)).toMatchObject({ ok: true })
	})

	// RES-6: a version that saved larger chunk limits cannot finish against the Store's bounds; the resume stops before
	// sending anything and points at a reset.
	it.each([
		['bytes only (no statement limit)', (saved: { chunkBytes: number }) => ({ ...saved, chunkStatements: undefined })],
		['bytes above the bound', (saved: { chunkBytes: number }) => ({ ...saved, chunkBytes: 8 * 1024 * 1024 })],
	])('refuses to resume an import whose saved chunks are %s, until it is reset', async (_case, outdated) => {
		const io = memoryIO()
		expect((await cli(['dump', 'o.sql'], { fetch: edge(await sourceStore(0)).fetch, io })).code).toBe(0)
		const target = await migratedStore()
		let sent = 0
		const crash = edge(target, async (request, forward) => {
			if (new URL(request.url).pathname === '/admin/import/chunk' && ++sent > 2) {
				throw new TypeError('network connection lost')
			}
			return forward()
		})
		const first = await cli(['import', 'o.sql', '--import-token', '--chunk-mib', '0.002'], { fetch: crash.fetch, io })
		expect(first.code).toBe(1)
		const sidecar = JSON.parse(new TextDecoder().decode(io.files.get('o.sql.import.json'))) as { chunkBytes: number }
		io.files.set('o.sql.import.json', new TextEncoder().encode(JSON.stringify(outdated(sidecar))))

		const watched = edge(target)
		const resumed = await cli(['import', 'o.sql'], { fetch: watched.fetch, io })
		expect(resumed.code).toBe(1)
		expect(resumed.err).toMatch(/import-chunks-outdated: .*import-reset o\.sql --yes/)
		expect(watched.seen.filter((r) => new URL(r.url).pathname === '/admin/import/chunk')).toHaveLength(0)

		expect((await cli(['import-reset', 'o.sql', '--yes'], { fetch: edge(target).fetch, io })).code).toBe(0)
		const again = await cli(['import', 'o.sql', '--import-token'], { fetch: edge(target).fetch, io })
		expect(again.code, again.err).toBe(0)
		expect(JSON.parse(again.out)).toMatchObject({ ok: true })
	})

	it('abandons a stranded token import only with --abandon-stale --import-token, after the idle time', async () => {
		const io = memoryIO()
		expect((await cli(['dump', 'k.sql'], { fetch: edge(await sourceStore(0)).fetch, io })).code).toBe(0)
		const target = await migratedStore()
		const crash = edge(target, async (request, forward) => {
			if (new URL(request.url).pathname === '/admin/import/chunk') {
				throw new TypeError('network connection lost')
			}
			return forward()
		})
		expect((await cli(['import', 'k.sql', '--import-token'], { fetch: crash.fetch, io })).code).toBe(1)
		// The session file is lost.
		io.files.delete('k.sql.import.json')
		expect((await cli(['import-reset', '--abandon-stale', '--yes'], { fetch: edge(target).fetch })).code).toBe(2)
		const early = await cli(['import-reset', '--abandon-stale', '--import-token', '--yes'], {
			fetch: edge(target).fetch,
		})
		expect(early.code).toBe(1)
		expect(early.err).toMatch(/possible after \d{4}-\d\d-\d\dT/)
	})

	it('refuses to report the outcome of a different file at the same path', async () => {
		const io = memoryIO()
		expect((await cli(['dump', 'l.sql'], { fetch: edge(await sourceStore(0)).fetch, io })).code).toBe(0)
		expect((await cli(['dump', 'other.sql'], { fetch: edge(await sourceStore(5)).fetch, io })).code).toBe(0)
		const target = await migratedStore()
		const lost = edge(target, async (request, forward) => {
			const response = await forward()
			if (new URL(request.url).pathname === '/admin/import/verify') {
				throw new TypeError('network connection lost')
			}
			return response
		})
		expect((await cli(['import', 'l.sql', '--import-token'], { fetch: lost.fetch, io })).code).toBe(1)
		// Another dump now sits at the same path; the saved state still names the first import.
		io.files.set('l.sql', io.files.get('other.sql')!)
		const rerun = await cli(['import', 'l.sql', '--import-token'], { fetch: edge(target).fetch, io })
		expect(rerun.code).toBe(1)
		expect(rerun.err).toContain('does not match this file')
	})

	// The file is replaced while the Store verifies: each component is changed on its own, so each check is pinned.
	it.each<[string, (text: string) => string]>([
		['header', (text) => text.replace(/"createdAt":"[^"]+"/, '"createdAt":"2000-01-01T00:00:00.000Z"')],
		[
			'trailer',
			(text) => text.replace(/(-- kopje-dump-trailer \{"tables":\[[^\n]*?\{"name":"accounts","rows":)(\d+)/, '$1999'),
		],
		[
			'chunk count',
			(text) => {
				const extra = text
					.split('\n')
					.filter((line) => line.startsWith('INSERT INTO "statuses"'))
					.slice(0, 12)
				return text.replace('\n-- kopje-dump-trailer ', `\n${extra.join('\n')}\n-- kopje-dump-trailer `)
			},
		],
		['body', (text) => text.replace("'bulk 1 x", "'bulk 1 y")],
	])('rejects an outcome when the %s changed during verification', async (component, mutate) => {
		const io = memoryIO()
		expect((await cli(['dump', 'v.sql'], { fetch: edge(await sourceStore(60)).fetch, io })).code).toBe(0)
		const original = io.text('v.sql')
		expect(mutate(original)).not.toBe(original)
		const target = await migratedStore()
		const swap = edge(target, async (request, forward) => {
			if (new URL(request.url).pathname === '/admin/import/verify') {
				io.files.set('v.sql', new TextEncoder().encode(mutate(original)))
			}
			return forward()
		})
		const run = await cli(['import', 'v.sql', '--import-token', '--chunk-mib', '0.002'], { fetch: swap.fetch, io })
		expect(run.code).toBe(1)
		expect(run.err).toContain(`does not match this file (${component})`)
	})

	it('redacts a session credential that comes back inside an error', async () => {
		const io = memoryIO()
		expect((await cli(['dump', 'r.sql'], { fetch: edge(await sourceStore(0)).fetch, io })).code).toBe(0)
		const target = await migratedStore()
		let session = ''
		const echo = edge(target, async (request, forward) => {
			if (new URL(request.url).pathname === '/admin/import/finish') {
				session = (JSON.parse(io.text('r.sql.import.json')) as { session: string }).session
				return Response.json({ error: `rejected ${session}`, code: 'x', detail: { session } }, { status: 400 })
			}
			return forward()
		})
		const run = await cli(['import', 'r.sql', '--import-token'], { fetch: echo.fetch, io })
		expect(run.code).toBe(1)
		expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/)
		expect(run.out + run.err).toContain('rejected ***')
		expect(run.out + run.err).not.toContain(session)
	})

	it('warns on Windows that the session file is not private', async () => {
		const io = memoryIO()
		expect((await cli(['dump', 'w.sql'], { fetch: edge(await sourceStore(0)).fetch, io })).code).toBe(0)
		const run = await cli(['import', 'w.sql', '--import-token'], {
			fetch: edge(await migratedStore()).fetch,
			io,
			platform: 'win32',
		})
		expect(run.code, run.err).toBe(0)
		expect(run.err).toContain('not private on Windows')
		const unix = await cli(['dump', 'u.sql'], { fetch: edge(await sourceStore(0)).fetch, io })
		expect(unix.err).not.toContain('Windows')
	})

	it('never prints the session credential of a token import', async () => {
		const io = memoryIO()
		expect((await cli(['dump', 'm.sql'], { fetch: edge(await sourceStore(0)).fetch, io })).code).toBe(0)
		const target = await migratedStore()
		const crash = edge(target, async (request, forward) => {
			if (new URL(request.url).pathname === '/admin/import/finish') {
				throw new TypeError('network connection lost')
			}
			return forward()
		})
		const outputs = [await cli(['import', 'm.sql', '--import-token'], { fetch: crash.fetch, io })]
		const { session } = JSON.parse(io.text('m.sql.import.json')) as { session: string }
		expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/)
		outputs.push(await cli(['import', 'm.sql', '--import-token'], { fetch: edge(target).fetch, io }))
		outputs.push(await cli(['import-reset', 'm.sql', '--yes'], { fetch: edge(target).fetch, io }))
		for (const output of outputs) {
			expect(output.out + output.err).not.toContain(session)
		}
	})

	it('shows the saved report of a failed import instead of finishing it again', async () => {
		const io = memoryIO()
		expect((await cli(['dump', 'j.sql'], { fetch: edge(await sourceStore(0)).fetch, io })).code).toBe(0)
		// A wrong checksum for one table makes verification fail.
		const text = io
			.text('j.sql')
			.replace(/("name":"accounts","rows":\d+,"checksum":")[0-9a-f]{64}/, `$1${'0'.repeat(64)}`)
		io.files.set('j.sql', new TextEncoder().encode(text))
		const target = await migratedStore()
		const lost = edge(target, async (request, forward) => {
			const response = await forward()
			if (new URL(request.url).pathname === '/admin/import/verify') {
				throw new TypeError('network connection lost')
			}
			return response
		})
		expect((await cli(['import', 'j.sql', '--import-token'], { fetch: lost.fetch, io })).code).toBe(1)
		const rerun = await cli(['import', 'j.sql', '--import-token'], { fetch: edge(target).fetch, io })
		expect(rerun.code).toBe(1)
		expect(JSON.parse(rerun.out)).toMatchObject({ ok: false, problems: [expect.stringMatching(/^accounts/)] })
		expect(rerun.err).toContain('FAILED verification')
	})
})

function bodyAndTrailer(text: string) {
	const lines = text.split('\n')
	const trailer = JSON.parse((lines.at(-3) ?? '').replace('-- kopje-dump-trailer ', '')) as unknown
	return { body: lines.slice(1, -3).join('\n'), trailer }
}
