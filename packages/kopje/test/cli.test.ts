import { beforeAll, describe, expect, it } from 'vitest'

import { type AccessTeam, accessToken, adminHarness, adminTeam, serviceClaims, setTeamAccess } from './access-helpers'
import { BUILD, migratedStore } from './helpers'
import { ADMIN_AUD, ADMIN_EMAIL, memoryIO, SERVICE_CLIENT_ID, seedStore, tableSnapshot } from './ops-helpers'
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
		expect(JSON.parse((await cli(['version'], { fetch })).out)).toMatchObject({ store: { applied: '0000_initial' } })
		expect((await cli(['capacity'], { fetch })).out).toMatch(/^database .*\n.* accounts$/m)
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

	it('resumes an import that was interrupted during verification', async () => {
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
