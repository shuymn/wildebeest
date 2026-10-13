import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { exportOf, workspace, writeExport } from './cutover-helpers.js'
import { buildLegacyFixture, exportDatabase } from './legacy-fixture.js'
import {
	checkMaintenanceWorker,
	checkSnapshotKeys,
	maintenanceWorker,
	WORKER_FILE,
} from '../cli/lib/cutover/maintenance.js'
import { preflight, readPagesProject, SPOOL_QUEUE_BINDING } from '../cli/lib/cutover/preflight.js'
import {
	buildMaintenance,
	externalImports,
	gzipKiB,
	MAINTENANCE_WORKER_LIMIT_KIB,
} from '../scripts/build-maintenance.mjs'

// The cutover's maintenance worker as `kopje-admin maintenance-worker` writes it (OPS-7: only real keys, DATA-13:
// aggregate reports), the bundle it is made of (it runs on the legacy Pages project's settings), and
// `kopje-admin cutover-preflight` (resources found from the Pages project's bindings, never a secret printed).
// test/maintenance-worker.test.ts serves the generated file next to a real Store.

const space = workspace()
let bundleDir = ''

beforeAll(async () => {
	bundleDir = await mkdtemp(join(tmpdir(), 'kopje-maintenance-bundle-'))
	buildMaintenance(bundleDir)
}, 120_000)

afterAll(async () => {
	await rm(bundleDir, { recursive: true, force: true })
})

async function generate(
	options: { domain?: string; keks?: { alice: string; bob: string }; env?: Record<string, string> } = {}
) {
	const fixture = await buildLegacyFixture({ level: 39, keks: options.keks })
	const exportPath = await writeExport(space.dir, fixture.texts)
	const outDir = join(space.dir, 'pages')
	const result = await maintenanceWorker({
		exportPath,
		domain: options.domain ?? 'kopje.test',
		outDir,
		env: options.env ?? {},
		bundleDir,
	})
	return { ...result, fixture, exportPath, outDir }
}

type Snapshot = { domain: string; inboxes: string[]; documents: Record<string, { contentType: string; body: string }> }

function snapshotIn(source: string): Snapshot {
	const line = source.split('\n')[1]!
	return JSON.parse(line.slice('const KOPJE_MAINTENANCE_SNAPSHOT = '.length, -1)) as Snapshot
}

describe('the maintenance worker bundle', () => {
	it('imports no Node.js or Cloudflare module and stays small, since it runs on the legacy settings', async () => {
		const worker = await readFile(join(bundleDir, 'maintenance-worker.js'), 'utf8')
		expect(externalImports(worker)).toEqual([])
		expect(gzipKiB(worker)).toBeLessThan(MAINTENANCE_WORKER_LIMIT_KIB)
		expect(worker).not.toMatch(/sourceMappingURL/)
		// The spool binding the preflight asks for is the one the worker reads.
		const module = (await import(join(bundleDir, 'maintenance-worker.js'))) as { SPOOL_QUEUE_BINDING: string }
		expect(module.SPOOL_QUEUE_BINDING).toBe(SPOOL_QUEUE_BINDING)
	})

	it('tells a bundle with a node: import apart', () => {
		expect(externalImports('import{a}from"node:net";import("cloudflare:workers")')).toEqual([
			'node:net',
			'cloudflare:workers',
		])
	})
})

describe('kopje-admin maintenance-worker', () => {
	it('writes the bundle with a snapshot of public documents only, and reports aggregates (DATA-13)', async () => {
		const { ok, report, fixture, outDir } = await generate()
		expect(ok).toBe(true)
		expect(report).toMatchObject({ result: 'written', actors: 2, documents: 6, kek: { uniform: true, kek: 'empty' } })
		const text = JSON.stringify(report)
		expect(text).not.toContain('kopje.test')
		for (const user of fixture.users) {
			expect(text).not.toContain(user.username)
		}

		const source = await readFile(join(outDir, WORKER_FILE), 'utf8')
		expect(source.startsWith('// Kopje cutover maintenance worker')).toBe(true)
		expect(source).toContain(await readFile(join(bundleDir, 'maintenance-worker.js'), 'utf8'))
		for (const user of fixture.users) {
			expect(source).not.toContain(user.email)
		}
		expect(source).not.toMatch(/privkey|PRIVATE KEY/)
		expect(snapshotIn(source).inboxes.sort()).toEqual(['Bob', 'alice'])
	})

	it('refuses an export of another domain', async () => {
		const { ok, report, outDir } = await generate({ domain: 'other.example' })
		expect(ok).toBe(false)
		expect(report.stop).toMatchObject({ code: 'domain-differs' })
		await expect(readFile(join(outDir, WORKER_FILE))).rejects.toThrow()
	})

	it('refuses keys no single KEK unwraps (DATA-14)', async () => {
		const { ok, report } = await generate({ keks: { alice: '', bob: 'another-kek' }, env: { userKEK: 'another-kek' } })
		expect(ok).toBe(false)
		expect(report.stop).toMatchObject({ code: 'kek-not-uniform' })
		expect(JSON.stringify(report)).not.toContain('another-kek')
	})

	it('never replaces an existing _worker.js, and needs the bundles', async () => {
		const first = await generate()
		expect(first.ok).toBe(true)
		const again = await maintenanceWorker({
			exportPath: first.exportPath,
			domain: 'kopje.test',
			outDir: first.outDir,
			env: {},
			bundleDir,
		})
		expect(again.report.stop).toMatchObject({ code: 'output-exists' })
		const missing = await maintenanceWorker({
			exportPath: first.exportPath,
			domain: 'kopje.test',
			outDir: join(space.dir, 'elsewhere'),
			env: {},
			bundleDir: join(space.dir, 'no-bundle'),
		})
		expect(missing.report.stop).toMatchObject({ code: 'bundle-missing' })
	})
})

describe('the snapshot is fresh when it is deployed (OPS-7)', () => {
	async function withLive() {
		const fixture = await buildLegacyFixture({ level: 39, live: true })
		const db = fixture.database!
		let n = 0
		// With `withData`, the other tables are exported without rows (`wrangler d1 export --no-data`).
		const exportNow = (withData?: string[]) => {
			const texts = exportDatabase(db, { sequence: true })
			const schemaOnly = (text: string) =>
				text
					.split('\n')
					.filter((line) => !line.startsWith('INSERT INTO'))
					.join('\n')
			return writeExport(
				space.dir,
				withData === undefined
					? texts
					: new Map([...texts].map(([table, text]) => [table, withData.includes(table) ? text : schemaOnly(text)])),
				`export-${++n}`
			)
		}
		const outDir = join(space.dir, 'pages')
		const generated = await maintenanceWorker({
			exportPath: await exportNow(),
			domain: 'kopje.test',
			outDir,
			env: {},
			bundleDir,
		})
		expect(generated.ok).toBe(true)
		const check = async (exportPath: string) =>
			checkMaintenanceWorker({ exportPath, domain: 'kopje.test', workerDir: outDir, env: {}, bundleDir })
		return { db, exportNow, check, generated }
	}

	it('records what it captured, and is current against an export of the same data', async () => {
		const { exportNow, check, generated } = await withLive()
		expect(generated.report).toMatchObject({
			actors: 2,
			snapshotSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
			keysSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
		})
		expect(await check(await exportNow())).toMatchObject({ ok: true, report: { result: 'current' } })
	})

	it('works from an export with the rows of the actors and keys alone, which is faster to take', async () => {
		const { exportNow, check } = await withLive()
		const small = await exportNow(['d1_migrations', 'actors', 'users', 'sqlite_sequence'])
		expect(await check(small)).toMatchObject({ ok: true, report: { result: 'current' } })
	})

	it.each<[string, (db: DatabaseSync) => void]>([
		[
			'a profile changed',
			(db) =>
				db.exec(
					`UPDATE actors SET properties = json_set(properties, '$.name', 'Renamed') WHERE id = 'https://kopje.test/ap/users/alice'`
				),
		],
		[
			'a key replaced',
			(db) => {
				// Bob's key pair moves to alice and alice's to Bob: both still unwrap, but neither document is the deployed one.
				const rows = db
					.prepare('SELECT actor_id, pubkey, privkey, privkey_salt FROM users ORDER BY actor_id')
					.all() as {
					actor_id: string
					pubkey: string
					privkey: Uint8Array
					privkey_salt: Uint8Array
				}[]
				const [a, b] = rows as [(typeof rows)[0], (typeof rows)[0]]
				db.exec("UPDATE users SET privkey = randomblob(32), privkey_salt = randomblob(16), pubkey = 'swap' || rowid")
				const set = db.prepare('UPDATE users SET pubkey = ?, privkey = ?, privkey_salt = ? WHERE actor_id = ?')
				set.run(b.pubkey, b.privkey, b.privkey_salt, a.actor_id)
				set.run(a.pubkey, a.privkey, a.privkey_salt, b.actor_id)
			},
		],
	])('is stale once %s', async (_name, write) => {
		const { db, exportNow, check } = await withLive()
		write(db)
		const result = await check(await exportNow())
		expect(result).toMatchObject({ ok: false, report: { result: 'stale' } })
		expect(result.report.changedDocuments).toBeGreaterThan(0)
	})
})

describe('the snapshot never serves a key other than the real one (OPS-7)', () => {
	async function rendered() {
		const { ok, outDir, fixture } = await generate()
		expect(ok).toBe(true)
		const snapshot = snapshotIn(await readFile(join(outDir, WORKER_FILE), 'utf8'))
		const legacy = fixture.users.map((user) => user.uri)
		const document = (username: string) => snapshot.documents[`path:/ap/users/${username}`]!
		return { snapshot, legacy, document }
	}

	function users(snapshot: Snapshot) {
		return ['alice', 'Bob'].map((username) => {
			const body = JSON.parse(snapshot.documents[`path:/ap/users/${username}`]!.body) as {
				id: string
				publicKey: { publicKeyPem: string }
			}
			return { uri: body.id, pubkey: body.publicKey.publicKeyPem }
		})
	}

	it('accepts the rendered keys', async () => {
		const { snapshot } = await rendered()
		expect(() => checkSnapshotKeys(snapshot, users(snapshot))).not.toThrow()
	})

	it.each([
		[
			'another public key',
			(actor: Record<string, any>, other: Record<string, any>) => {
				actor.publicKey.publicKeyPem = other.publicKey.publicKeyPem
			},
		],
		[
			'another key id',
			(actor: Record<string, any>) => {
				actor.publicKey.id = `${actor.id}#other-key`
			},
		],
		[
			'another owner',
			(actor: Record<string, any>, other: Record<string, any>) => {
				actor.publicKey.owner = other.id
			},
		],
		[
			'another actor at the path',
			(actor: Record<string, any>, other: Record<string, any>) => {
				actor.id = other.id
			},
		],
	])('refuses a snapshot with %s', async (_name, tamper) => {
		const { snapshot, document } = await rendered()
		const expected = users(snapshot)
		const alice = JSON.parse(document('alice').body) as Record<string, any>
		const bob = JSON.parse(document('Bob').body) as Record<string, any>
		tamper(alice, bob)
		document('alice').body = JSON.stringify(alice)
		expect(() => checkSnapshotKeys(snapshot, expected)).toThrow(/snapshot-key-mismatch/)
	})

	it('refuses a snapshot that leaves a local actor out', async () => {
		const { snapshot } = await rendered()
		const expected = users(snapshot)
		delete snapshot.documents['path:/ap/users/Bob']
		expect(() => checkSnapshotKeys(snapshot, expected)).toThrow(/snapshot-actors-differ/)
	})
})

// The Pages project as the API answers GET /accounts/<id>/pages/projects/<name>, with placeholders throughout.
function pagesProject(overrides: { production?: Record<string, unknown>; preview?: Record<string, unknown> } = {}) {
	const production = {
		compatibility_date: '2023-01-09',
		d1_databases: { DATABASE: { id: '00000000-0000-4000-8000-00000000d100' } },
		queue_producers: { QUEUE: { name: 'legacy-queue' } },
		durable_object_namespaces: { DO_CACHE: { namespace_id: 'do-namespace-placeholder' } },
		kv_namespaces: { KV_CACHE: { namespace_id: 'kv-namespace-placeholder' } },
		env_vars: {
			DOMAIN: { type: 'plain_text', value: 'kopje.test' },
			ADMIN_EMAIL: { type: 'plain_text', value: 'admin@kopje.test' },
			userKEK: { type: 'secret_text', value: 'secret-value-never-printed' },
		},
		...overrides.production,
	}
	return {
		success: true,
		result: {
			name: 'legacy-pages',
			subdomain: 'legacy-pages.pages.dev',
			production_branch: 'main',
			domains: ['legacy-pages.pages.dev', 'kopje.test'],
			source: { type: 'github', config: { deployments_enabled: true } },
			deployment_configs: {
				production,
				preview: { d1_databases: { DATABASE: { id: '00000000-0000-4000-8000-00000000d100' } }, ...overrides.preview },
			},
		},
	}
}

describe('kopje-admin cutover-preflight', () => {
	const status = (report: ReturnType<typeof readPagesProject>, id: string) =>
		report.checks.find((check) => check.id === id)?.status

	it('finds the resources from the bindings and lists what the cutover needs', () => {
		const report = readPagesProject(pagesProject())
		expect(report.domain).toBe('kopje.test')
		expect(report.production.d1).toEqual([{ binding: 'DATABASE', id: '00000000-0000-4000-8000-00000000d100' }])
		expect(report.production.queues).toEqual([{ binding: 'QUEUE', id: 'legacy-queue' }])
		expect(report.kekCandidates).toEqual(['userKEK'])
		expect(status(report, 'legacy-d1')).toBe('pass')
		expect(status(report, 'preview-writes-legacy-d1')).toBe('warn')
		expect(status(report, 'spool-binding')).toBe('todo')
		expect(status(report, 'git-deployments')).toBe('todo')
		const text = JSON.stringify(report)
		expect(text).not.toContain('secret-value-never-printed')
		expect(text).not.toContain('admin@kopje.test')
	})

	it('fails on what would send the cutover to the wrong place', () => {
		const noDatabase = readPagesProject(pagesProject({ production: { d1_databases: {} } }))
		expect(status(noDatabase, 'legacy-d1')).toBe('fail')
		expect(status(readPagesProject(pagesProject(), { domain: 'other.example' }), 'domain')).toBe('fail')
		const spoolToLegacy = pagesProject({
			production: { queue_producers: { QUEUE: { name: 'legacy-queue' }, KOPJE_QUEUE: { name: 'legacy-queue' } } },
		})
		expect(status(readPagesProject(spoolToLegacy), 'spool-binding')).toBe('fail')
		const spoolElsewhere = pagesProject({
			production: { queue_producers: { QUEUE: { name: 'legacy-queue' }, KOPJE_QUEUE: { name: 'some-queue' } } },
		})
		expect(status(readPagesProject(spoolElsewhere, { kopjeQueue: 'kopje-queue' }), 'spool-binding')).toBe('fail')
		const spoolKopje = pagesProject({
			production: { queue_producers: { QUEUE: { name: 'legacy-queue' }, KOPJE_QUEUE: { name: 'kopje-queue' } } },
		})
		expect(status(readPagesProject(spoolKopje, { kopjeQueue: 'kopje-queue' }), 'spool-binding')).toBe('pass')
		expect(() => readPagesProject({ result: { name: 'x' } })).toThrow(/not-a-pages-project/)
	})

	it('reads the level and the KEK from an export, and runs from the real CLI', async () => {
		const exportPath = await exportOf(space.dir, { level: 39 })
		const projectPath = join(space.dir, 'project.json')
		await writeFile(projectPath, JSON.stringify(pagesProject()))
		const report = await preflight({ projectPath, exportPath, env: {} })
		expect(report.export).toMatchObject({ level: 39, line: 'T1', localUsers: 2, kek: { uniform: true } })

		const cli = fileURLToPath(new URL('../cli/kopje-admin.js', import.meta.url))
		const { stdout } = await promisify(execFile)(process.execPath, [
			cli,
			'cutover-preflight',
			projectPath,
			'--export',
			exportPath,
		])
		expect(JSON.parse(stdout)).toMatchObject({ ok: true, export: { level: 39 } })
		expect(stdout).not.toContain('secret-value-never-printed')
	})
})
