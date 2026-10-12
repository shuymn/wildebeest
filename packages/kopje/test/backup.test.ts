import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

import { Decrypter, generateX25519Identity, identityToRecipient } from 'age-encryption'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BUILD, migratedStore } from './helpers'
import { copyConfig, importViaRpc, memoryIO, seedStore, tableSnapshot } from './ops-helpers'
import { S3Mock } from './s3-mock'
import { run as cliRun } from '../cli/lib/main.js'
import { healthReport } from '../src/app/health'
import {
	type BackupDeps,
	type BackupFaultPoint,
	type BackupManifest,
	MIN_PART_BYTES,
	runBackup,
	scheduledBackup,
} from '../src/jobs/backup'
import { readBackupConfig } from '../src/platform/backup-config'
import { readConfig } from '../src/platform/config'
import type { StoreStub } from '../src/platform/store-client'

// B6b: the scheduled encrypted backup (DATA-4, DATA-9, DATA-10, OPS-5), against the real Store and an in-memory S3.

const identity = await generateX25519Identity()
const recipient = await identityToRecipient(identity)
const SECRET = 'kopje-dummy-s3-secret-0123456789'
const PREFIX = 'kopje-backup/'
// 2026-10-13 03:00 UTC; the job's clock. The Store's own dump lease runs on real time.
const NOW = Date.parse('2026-10-13T03:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const MINUTE = 60 * 1000

function backupEnv(overrides: Record<string, string | undefined> = {}): Env {
	return {
		...env,
		BACKUP_AGE_RECIPIENT: recipient,
		BACKUP_S3_ENDPOINT: 'https://s3.test',
		BACKUP_S3_BUCKET: 'kopje-backups',
		BACKUP_S3_ACCESS_KEY_ID: 'AKIDKOPJETEST',
		BACKUP_S3_SECRET_ACCESS_KEY: SECRET,
		...overrides,
	} as unknown as Env
}

type Harness = {
	store: StoreStub
	s3: S3Mock
	env: Env
	clock: { now: number }
	logs: Record<string, unknown>[]
	faults: Map<BackupFaultPoint, number>
	run(extra?: Partial<BackupDeps>): Promise<string>
}

async function harness(options: { env?: Env; seed?: boolean; store?: StoreStub } = {}): Promise<Harness> {
	const store = options.store ?? (await migratedStore())
	if (options.seed !== false && options.store === undefined) {
		await seedStore(store, 20)
	}
	const s3 = new S3Mock()
	const clock = { now: NOW }
	const logs: Record<string, unknown>[] = []
	// A fault fires once when its count reaches zero: n = 0 crashes at the first time the point is reached.
	const faults = new Map<BackupFaultPoint, number>()
	const h: Harness = {
		store,
		s3,
		env: options.env ?? backupEnv(),
		clock,
		logs,
		faults,
		run: (extra = {}) =>
			runBackup(h.env, {
				build: () => BUILD,
				store: () => store,
				now: () => clock.now,
				fetch: s3.fetch,
				log: (entry) => logs.push(entry),
				partBytes: MIN_PART_BYTES,
				chunkBytes: 256 * 1024,
				sleep: async () => {},
				inject: (point) => {
					const left = faults.get(point)
					if (left === undefined) {
						return
					}
					if (left === 0) {
						faults.delete(point)
						throw new Error(`crash at ${point}`)
					}
					faults.set(point, left - 1)
				},
				...extra,
			}),
	}
	return h
}

async function decrypt(bytes: Uint8Array | undefined): Promise<Uint8Array> {
	expect(bytes).toBeDefined()
	const d = new Decrypter()
	d.addIdentity(identity)
	return d.decrypt(bytes!)
}

async function manifestOf(h: Harness, id = '2026-10-13'): Promise<BackupManifest> {
	const bytes = await decrypt(h.s3.objects.get(`${PREFIX}backups/${id}/manifest.json.age`))
	return JSON.parse(new TextDecoder().decode(bytes)) as BackupManifest
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
		b.toString(16).padStart(2, '0')
	).join('')
}

// The restore path (docs/backup.md): decrypt the manifest and the dump, check the manifest's sizes and digests of
// both, and return the dump text for import (DATA-10).
async function restoreDump(h: Harness, id = '2026-10-13'): Promise<string> {
	const manifest = await manifestOf(h, id)
	const ciphertext = h.s3.objects.get(manifest.dump.key)!
	expect({ size: ciphertext.byteLength, sha256: await sha256Hex(ciphertext) }).toEqual({
		size: manifest.dump.size,
		sha256: manifest.dump.sha256,
	})
	const plaintext = await decrypt(ciphertext)
	expect({ size: plaintext.byteLength, sha256: await sha256Hex(plaintext) }).toEqual(manifest.dump.plaintext)
	return new TextDecoder().decode(plaintext)
}

async function storeHealth(store: StoreStub) {
	return store.health(BUILD)
}

async function backupState(store: StoreStub) {
	return (await store.backupState(BUILD)).state
}

function snowflake(ms: number, n = 0): string {
	return ((BigInt(ms) << 16n) | BigInt(n)).toString()
}

async function clearOriginals(): Promise<void> {
	const listing = await env.MEDIA.list({ prefix: 'originals/' })
	await Promise.all(listing.objects.map((o) => env.MEDIA.delete(o.key)))
}

function withoutState(snapshot: Record<string, string[]>): Record<string, string[]> {
	const { kopje_state: _state, ...rest } = snapshot
	return rest
}

// Rows big enough that the dump spans several 5 MiB parts.
async function addLargeRows(store: StoreStub, rows: number, bytes: number): Promise<void> {
	await runInDurableObject(store, (_instance, state) => {
		for (let i = 0; i < rows; i++) {
			state.storage.sql.exec(
				`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at) VALUES (?, ?, ?, 'public', ?, ?)`,
				String(120_000_000_000_000_000n + BigInt(i)),
				`https://kopje.test/ap/o/large-${i}`,
				'110000000000000001',
				`large ${i} ${'kopje-plaintext-marker '.repeat(Math.ceil(bytes / 23))}`.slice(0, bytes),
				'2026-10-12T00:00:00.000Z'
			)
		}
	})
}

beforeEach(clearOriginals)
afterEach(clearOriginals)

describe('backup configuration', () => {
	it('does no work and says so when enabled but not configured', async () => {
		const h = await harness({ env: backupEnv({ BACKUP_S3_SECRET_ACCESS_KEY: undefined, BACKUP_S3_BUCKET: '' }) })
		expect(await h.run()).toBe('not-configured')
		expect(h.s3.requests).toEqual([])
		expect(await h.store.backupState(BUILD)).toMatchObject({ rev: 0 })

		const report = await healthReport(BUILD, readConfig(h.env), () => h.store, {
			checkKeys: false,
			backup: readBackupConfig(h.env),
		})
		expect(report.checks.backup).toEqual({
			ok: true,
			state: 'not-configured',
			missing: ['BACKUP_S3_BUCKET', 'BACKUP_S3_SECRET_ACCESS_KEY'],
			warning: expect.stringContaining('not configured'),
		})
	})

	it('is off only with BACKUP_ENABLED=false, and refuses invalid settings without naming their values', async () => {
		expect(readBackupConfig(backupEnv({ BACKUP_ENABLED: 'false' }))).toEqual({ state: 'disabled' })
		const h = await harness({ env: backupEnv({ BACKUP_ENABLED: 'false' }) })
		expect(await h.run()).toBe('disabled')
		expect(h.s3.requests).toEqual([])

		const invalid = backupEnv({
			BACKUP_AGE_RECIPIENT: 'AGE-SECRET-KEY-1NOTAPUBLICKEY',
			BACKUP_S3_ENDPOINT: `http://user:${SECRET}@s3.test/path`,
			BACKUP_S3_PREFIX: '../escape/',
			BACKUP_RETENTION: '0',
		})
		const result = readBackupConfig(invalid)
		expect(result.state).toBe('invalid')
		const text = JSON.stringify(result)
		expect(text).not.toContain(SECRET)
		expect(text).not.toContain('AGE-SECRET-KEY')
		expect(result).toMatchObject({
			issues: [
				expect.stringMatching(/^BACKUP_AGE_RECIPIENT/),
				expect.stringMatching(/^BACKUP_S3_ENDPOINT/),
				expect.stringMatching(/^BACKUP_S3_PREFIX/),
				expect.stringMatching(/^BACKUP_RETENTION/),
			],
		})
	})

	it('skips under env maintenance, like the other scheduled jobs', async () => {
		const h = await harness({ env: backupEnv({ MAINTENANCE: 'readonly' }) })
		const outcome = await scheduledBackup(h.env, {
			build: () => BUILD,
			store: () => h.store,
			now: () => NOW,
			fetch: h.s3.fetch,
		})
		expect(outcome).toBeNull()
		expect(h.s3.requests).toEqual([])
	})
})

describe('backup run', () => {
	it('writes the encrypted dump, new originals and the manifest last, and records the success (DATA-4, DATA-10)', async () => {
		const h = await harness()
		const old = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3, ...new TextEncoder().encode('exif-location-marker')])
		const oldKey = `originals/${snowflake(NOW - 2 * DAY)}`
		// Uploaded within the settle window: left for the next backup.
		const fresh = `originals/${snowflake(NOW - 10 * MINUTE)}`
		await env.MEDIA.put(oldKey, old)
		await env.MEDIA.put(fresh, new Uint8Array([9]))

		expect(await h.run()).toBe('done')

		const manifestKey = `${PREFIX}backups/2026-10-13/manifest.json.age`
		const dumpKey = `${PREFIX}backups/2026-10-13/dump.kopje.age`
		const mediaKey = `${PREFIX}media/2026-10-13/${oldKey}.age`
		expect([...h.s3.objects.keys()].sort()).toEqual([dumpKey, manifestKey, mediaKey])
		// The manifest is the last object written.
		expect(h.s3.requests.filter((r) => r.op === 'put' || r.op === 'complete-upload').at(-1)?.key).toBe(manifestKey)

		const manifest = await manifestOf(h)
		expect(manifest).toMatchObject({
			format: 'kopje-backup',
			version: 1,
			id: '2026-10-13',
			createdAt: new Date(NOW).toISOString(),
			kopje: { version: expect.any(String), build: BUILD },
			schema: { version: '0000_initial' },
			recipients: [recipient],
			dump: { key: dumpKey },
			media: { after: null, through: oldKey },
		})
		expect(manifest.media.objects).toEqual([
			{
				source: oldKey,
				key: mediaKey,
				size: h.s3.objects.get(mediaKey)!.byteLength,
				sha256: await sha256Hex(h.s3.objects.get(mediaKey)!),
				plaintext: { size: old.byteLength, sha256: await sha256Hex(old) },
			},
		])
		expect(await decrypt(h.s3.objects.get(mediaKey))).toEqual(old)
		const text = await restoreDump(h)
		expect(text.startsWith('-- kopje-dump-header ')).toBe(true)
		expect(text.endsWith('-- kopje-dump-end\n')).toBe(true)

		// DATA-4: nothing the bucket received is plaintext.
		for (const body of h.s3.received) {
			const decoded = new TextDecoder().decode(body)
			expect(decoded.startsWith('age-encryption.org/v1\n')).toBe(true)
			for (const marker of ['kopje-dump-header', 'exif-location-marker', 'kopje-backup', 'bulk 1 ']) {
				expect(decoded).not.toContain(marker)
			}
		}
		// R2 keeps every original (nothing is deleted from R2).
		expect((await env.MEDIA.list({ prefix: 'originals/' })).objects.map((o) => o.key).sort()).toEqual(
			[oldKey, fresh].sort()
		)

		const state = await backupState(h.store)
		expect(state).toMatchObject({
			runner: null,
			run: null,
			lastSuccess: {
				id: '2026-10-13',
				at: NOW,
				manifest: manifestKey,
				manifestSha256: await sha256Hex(h.s3.objects.get(manifestKey)!),
				media: 1,
			},
			lastFailure: null,
			mediaAfter: oldKey,
		})
		expect((await storeHealth(h.store)).dump).toBeNull()

		// Once a day: the same day is not due again; the next one copies only the originals added since.
		expect(await h.run()).toBe('not-due')
		h.clock.now = NOW + DAY
		expect(await h.run()).toBe('done')
		const next = await manifestOf(h, '2026-10-14')
		expect(next.media).toMatchObject({ after: oldKey, through: fresh })
		expect(next.media.objects.map((o) => o.source)).toEqual([fresh])
	})

	it('waits for BACKUP_HOUR_UTC', async () => {
		const h = await harness({ env: backupEnv({ BACKUP_HOUR_UTC: '4' }) })
		expect(await h.run()).toBe('not-due')
		h.clock.now = NOW + 60 * MINUTE
		expect(await h.run()).toBe('done')
	})

	it('round-trips a dump larger than one part: dump, encrypt, decrypt, import, same data (DATA-10)', async () => {
		const h = await harness()
		// About 12 MiB of rows: three parts of at least 5 MiB except the last (the mock enforces S3's rule).
		await addLargeRows(h.store, 8, 1536 * 1024)
		expect(await h.run()).toBe('done')
		expect(h.s3.count('upload-part')).toBeGreaterThanOrEqual(3)
		const text = await restoreDump(h)
		expect(h.s3.received.some((b) => new TextDecoder().decode(b).includes('kopje-plaintext-marker'))).toBe(false)

		const target = await migratedStore()
		await copyConfig(h.store, target)
		const { report } = await importViaRpc(target, text, 4 * 1024 * 1024)
		expect(report).toMatchObject({ ok: true, foreignKeyViolations: 0, problems: [] })
		expect(withoutState(await tableSnapshot(target))).toEqual(withoutState(await tableSnapshot(h.store)))
	})

	it('a busy runner keeps a second invocation out, and a lost lease stops the first (OPS-5)', async () => {
		const h = await harness()
		// The first invocation dies holding the run; until its lease ends, others stay out.
		h.faults.set('manifest-stage', 0)
		await expect(h.run()).rejects.toThrow('crash at manifest-stage')
		expect(await h.run()).toBe('busy')
		h.clock.now += 6 * MINUTE
		expect(await h.run()).toBe('done')
	})
})

describe('backup resumption (OPS-5)', () => {
	it('restarts a dump that died mid-dump: the freeze and the upload are released, the next run completes', async () => {
		const h = await harness()
		await addLargeRows(h.store, 8, 1536 * 1024)
		h.faults.set('dump-chunk', 3)
		await expect(h.run()).rejects.toThrow('crash at dump-chunk')
		// The dead invocation left the Store frozen (until its lease) and an upload open.
		expect((await storeHealth(h.store)).dump).not.toBeNull()
		expect(h.s3.uploads.size).toBe(1)

		h.clock.now += 6 * MINUTE
		expect(await h.run()).toBe('done')
		expect(h.s3.uploads.size).toBe(0)
		expect((await storeHealth(h.store)).dump).toBeNull()
		expect((await backupState(h.store)).lastSuccess?.id).toBe('2026-10-13')
		await restoreDump(h)
	})

	it('restarts a dump that died after some parts were uploaded', async () => {
		const h = await harness()
		await addLargeRows(h.store, 8, 1536 * 1024)
		h.faults.set('dump-part', 1)
		await expect(h.run()).rejects.toThrow('crash at dump-part')
		const saved = (await backupState(h.store)).run
		expect(saved?.dump).toMatchObject({ parts: 2, uploadId: expect.any(String) })
		const dead = saved!.dump!.uploadId!
		expect(h.s3.uploads.get(dead)?.parts.size).toBe(2)

		h.clock.now += 6 * MINUTE
		expect(await h.run()).toBe('done')
		expect(h.s3.uploads.has(dead)).toBe(false)
		expect(h.s3.requests).toContainEqual({ op: 'abort-upload', key: saved!.dump!.key, status: 204 })
		expect((await storeHealth(h.store)).dump).toBeNull()
		const target = await migratedStore()
		await copyConfig(h.store, target)
		const { report } = await importViaRpc(target, await restoreDump(h), 4 * 1024 * 1024)
		expect(report).toMatchObject({ ok: true })
	})

	it('a run that died after its upload completed restarts the dump without a manifest in between', async () => {
		const h = await harness()
		h.faults.set('dump-complete', 0)
		await expect(h.run()).rejects.toThrow('crash at dump-complete')
		expect([...h.s3.objects.keys()].some((k) => k.endsWith('manifest.json.age'))).toBe(false)
		h.clock.now += 6 * MINUTE
		expect(await h.run()).toBe('done')
		await restoreDump(h)
	})

	it('resumes before the manifest without dumping again', async () => {
		const h = await harness()
		await env.MEDIA.put(`originals/${snowflake(NOW - DAY)}`, new Uint8Array([1, 2, 3]))
		h.faults.set('manifest-stage', 0)
		await expect(h.run()).rejects.toThrow('crash at manifest-stage')
		expect([...h.s3.objects.keys()].some((k) => k.endsWith('manifest.json.age'))).toBe(false)
		const uploads = h.s3.count('create-upload')
		const puts = h.s3.count('put')

		h.clock.now += 6 * MINUTE
		expect(await h.run()).toBe('done')
		expect(h.s3.count('create-upload')).toBe(uploads)
		// Only the manifest is written: the media copy is not repeated.
		expect(h.s3.count('put')).toBe(puts + 1)
		expect((await manifestOf(h)).media.objects).toHaveLength(1)
		await restoreDump(h)
	})

	it('resumes after the manifest was written but the success was not recorded', async () => {
		const h = await harness()
		h.faults.set('manifest-written', 0)
		await expect(h.run()).rejects.toThrow('crash at manifest-written')
		const first = await manifestOf(h)
		h.clock.now += 6 * MINUTE
		expect(await h.run()).toBe('done')
		// The rewritten manifest says the same thing.
		expect(await manifestOf(h)).toEqual(first)
		expect((await backupState(h.store)).lastSuccess?.id).toBe('2026-10-13')
	})

	it('resumes media copying after a crash and spans invocations under a time budget', async () => {
		const h = await harness()
		const keys = [1, 2, 3, 4].map((n) => `originals/${snowflake(NOW - 2 * DAY, n)}`)
		for (const key of keys) {
			await env.MEDIA.put(key, new TextEncoder().encode(`original ${key}`))
		}
		h.faults.set('media-copied', 1)
		await expect(h.run()).rejects.toThrow('crash at media-copied')
		expect((await backupState(h.store)).run?.media.after).toBe(keys[0])

		// A budget of zero copies nothing this time and leaves the run for the next cron.
		h.clock.now += 6 * MINUTE
		expect(await h.run({ mediaBudgetMs: 0 })).toBe('paused')
		expect((await backupState(h.store)).runner).toBeNull()
		expect(await h.run()).toBe('done')
		const manifest = await manifestOf(h)
		expect(manifest.media.objects.map((o) => o.source)).toEqual(keys)
		expect(h.s3.count('create-upload')).toBe(1)
		for (const object of manifest.media.objects) {
			expect(new TextDecoder().decode(await decrypt(h.s3.objects.get(object.key)))).toBe(`original ${object.source}`)
		}
	})

	it('gives up on a run that keeps dying and records it', async () => {
		const h = await harness()
		for (let i = 0; i < 4; i++) {
			h.faults.set('manifest-stage', 0)
			await expect(h.run()).rejects.toThrow('crash at manifest-stage')
			h.clock.now += 6 * MINUTE
		}
		expect(await h.run()).toBe('failed')
		expect((await backupState(h.store)).lastFailure).toMatchObject({ reason: 'interrupted', stage: 'manifest' })
		// After the retry delay the run continues where it was.
		h.clock.now += 61 * MINUTE
		expect(await h.run()).toBe('done')
	})
})

describe('backup failures (OPS-5, DATA-9)', () => {
	it('releases the Store freeze and aborts the upload when the job fails, then waits before retrying', async () => {
		const h = await harness()
		// The first part fills while most of the dump is still unread, so the failure comes during the freeze.
		await addLargeRows(h.store, 8, 1536 * 1024)
		h.s3.fail = (op) => (op === 'upload-part' ? 500 : undefined)
		let frozenAtFailure: boolean | undefined
		const fetch = async (request: Request) => {
			if (frozenAtFailure === undefined && new URL(request.url).searchParams.has('partNumber')) {
				frozenAtFailure = (await storeHealth(h.store)).dump !== null
			}
			return h.s3.fetch(request)
		}
		expect(await h.run({ fetch })).toBe('failed')
		expect(frozenAtFailure).toBe(true)
		// Released at once, not when the dump lease runs out.
		expect((await storeHealth(h.store)).dump).toBeNull()
		expect((await storeHealth(h.store)).readonly).toBe(false)
		expect(h.s3.uploads.size).toBe(0)
		const state = await backupState(h.store)
		expect(state).toMatchObject({
			runner: null,
			lastFailure: { id: '2026-10-13', at: NOW, stage: 'dump', reason: 's3-upload-part-500' },
			retryAt: NOW + 60 * MINUTE,
			run: { stage: 'dump', dump: null },
		})
		const report = await healthReport(BUILD, readConfig(h.env), () => h.store, {
			checkKeys: false,
			backup: readBackupConfig(h.env),
			now: NOW,
		})
		expect(report.ok).toBe(false)
		expect(report.checks.backup).toMatchObject({
			ok: false,
			lastFailure: { reason: 's3-upload-part-500' },
			inProgress: { id: '2026-10-13', stage: 'dump' },
		})

		h.s3.fail = undefined
		expect(await h.run()).toBe('waiting')
		h.clock.now += 61 * MINUTE
		expect(await h.run()).toBe('done')
		const after = await healthReport(BUILD, readConfig(h.env), () => h.store, {
			checkKeys: false,
			backup: readBackupConfig(h.env),
			now: h.clock.now,
		})
		expect(after.checks.backup).toMatchObject({ ok: true, state: 'idle', lastSuccess: { id: '2026-10-13' } })
	})

	it('a refused dump (another dump holds the freeze) fails without touching that dump', async () => {
		const h = await harness()
		const other = await h.store.dumpStart(BUILD, 60, 'operator-dump-1')
		expect(other.ok).toBe(true)
		expect(await h.run()).toBe('failed')
		expect((await backupState(h.store)).lastFailure?.reason).toBe('dump-dump-in-progress')
		expect((await storeHealth(h.store)).dump).not.toBeNull()
		expect(h.s3.count('create-upload')).toBe(0)
	})

	it('aborts abandoned multipart uploads under its prefix only', async () => {
		const h = await harness()
		const stray = h.s3.strayUpload(`${PREFIX}backups/2026-10-12/dump.kopje.age`, new Uint8Array(10))
		const foreign = h.s3.strayUpload('someone-else/backup.tar')
		expect(await h.run()).toBe('done')
		expect(h.s3.uploads.has(stray)).toBe(false)
		expect(h.s3.uploads.has(foreign)).toBe(true)
	})

	it('never logs, saves or reports a secret or an S3 response (DATA-5, DATA-9)', async () => {
		const h = await harness()
		h.s3.fail = (op) => (op === 'create-upload' ? 403 : undefined)
		expect(await h.run()).toBe('failed')
		const report = await healthReport(BUILD, readConfig(h.env), () => h.store, {
			checkKeys: false,
			backup: readBackupConfig(h.env),
		})
		const seen = JSON.stringify([h.logs, await h.store.backupState(BUILD), report])
		for (const marker of [SECRET, 'AccessDenied', 'Injected', 'AKIDKOPJETEST', 's3.test']) {
			expect(seen).not.toContain(marker)
		}
		expect(seen).toContain('s3-create-upload-403')
	})
})

describe('backup retention (OPS-5)', () => {
	function preload(s3: S3Mock, ids: string[], complete = true): void {
		for (const id of ids) {
			s3.objects.set(`${PREFIX}backups/${id}/dump.kopje.age`, new Uint8Array([1]))
			if (complete) {
				s3.objects.set(`${PREFIX}backups/${id}/manifest.json.age`, new Uint8Array([2]))
			}
		}
	}

	it('keeps the newest N complete backups and deletes older ones, only its own objects under its prefix', async () => {
		const h = await harness({ env: backupEnv({ BACKUP_RETENTION: '3' }) })
		preload(h.s3, ['2026-10-08', '2026-10-10', '2026-10-12'])
		// Incomplete (no manifest): an older one goes, a newer one than the oldest kept stays.
		preload(h.s3, ['2026-10-01'], false)
		preload(h.s3, ['2026-10-11'], false)
		const untouched = [
			'other-app/backups/2026-10-01/dump.kopje.age',
			`${PREFIX}backups/2026-10-01/notes.txt`,
			`${PREFIX}media/2026-10-01/originals/110000000000000001.age`,
			`${PREFIX}backups/README`,
		]
		for (const key of untouched) {
			h.s3.objects.set(key, new Uint8Array([3]))
		}
		expect(await h.run()).toBe('done')

		const keys = [...h.s3.objects.keys()]
		for (const id of ['2026-10-13', '2026-10-12', '2026-10-10']) {
			expect(keys).toContain(`${PREFIX}backups/${id}/manifest.json.age`)
			expect(keys).toContain(`${PREFIX}backups/${id}/dump.kopje.age`)
		}
		expect(keys).toContain(`${PREFIX}backups/2026-10-11/dump.kopje.age`)
		for (const id of ['2026-10-08', '2026-10-01']) {
			expect(keys).not.toContain(`${PREFIX}backups/${id}/manifest.json.age`)
			expect(keys).not.toContain(`${PREFIX}backups/${id}/dump.kopje.age`)
		}
		for (const key of untouched) {
			expect(keys).toContain(key)
		}
		// The manifest goes first, so a half-deleted backup never looks complete.
		const deletes = h.s3.requests.filter((r) => r.op === 'delete').map((r) => r.key)
		expect(deletes.indexOf(`${PREFIX}backups/2026-10-08/manifest.json.age`)).toBeLessThan(
			deletes.indexOf(`${PREFIX}backups/2026-10-08/dump.kopje.age`)
		)
		expect(deletes.every((k) => k?.startsWith(`${PREFIX}backups/`))).toBe(true)
	})

	it('never deletes the newest complete backup, even when the new manifest is not listed yet', async () => {
		const h = await harness({ env: backupEnv({ BACKUP_RETENTION: '1' }) })
		preload(h.s3, ['2026-10-11', '2026-10-12'])
		h.s3.hidden.add(`${PREFIX}backups/2026-10-13/manifest.json.age`)
		expect(await h.run()).toBe('done')
		const keys = [...h.s3.objects.keys()]
		expect(keys).toContain(`${PREFIX}backups/2026-10-12/manifest.json.age`)
		expect(keys).toContain(`${PREFIX}backups/2026-10-13/manifest.json.age`)
		expect(keys).not.toContain(`${PREFIX}backups/2026-10-11/manifest.json.age`)
	})

	it('records a retention failure without failing the backup', async () => {
		const h = await harness()
		h.s3.fail = (op) => (op === 'list' ? 500 : undefined)
		expect(await h.run()).toBe('done')
		expect(await backupState(h.store)).toMatchObject({
			lastSuccess: { id: '2026-10-13' },
			retentionFailure: { at: NOW, reason: 's3-list-500' },
		})
	})
})

describe('backup restore path (DATA-10)', () => {
	async function verify(io: ReturnType<typeof memoryIO>, args: string[]) {
		let out = ''
		let err = ''
		const code = await cliRun({
			argv: ['backup-verify', ...args],
			env: {},
			io,
			stdout: { write: (t: string) => void (out += t) },
			stderr: { write: (t: string) => void (err += t) },
		})
		return { code, out, err }
	}

	it('kopje-admin backup-verify checks decrypted files against the manifest and refuses a changed one', async () => {
		const h = await harness()
		const original = new TextEncoder().encode('an original')
		const key = `originals/${snowflake(NOW - DAY)}`
		await env.MEDIA.put(key, original)
		expect(await h.run()).toBe('done')
		const manifest = await manifestOf(h)

		// What an operator has after `age -d` on each downloaded object.
		const io = memoryIO()
		const encrypted = h.s3.objects.get(manifest.dump.key)!
		io.files.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)))
		io.files.set('dump.kopje', await decrypt(encrypted))
		io.files.set('dump.kopje.age', encrypted)
		io.files.set(`media/${key}`, await decrypt(h.s3.objects.get(manifest.media.objects[0]!.key)))

		const ok = await verify(io, ['manifest.json', 'dump.kopje', '--encrypted', 'dump.kopje.age', '--media', 'media'])
		expect(ok).toMatchObject({ code: 0, out: expect.stringContaining('backup 2026-10-13 matches its manifest') })

		// The same length with one byte changed fails, for the dump and for an original.
		const dump = io.files.get('dump.kopje')!
		const changed = dump.slice()
		changed[changed.length - 30] = (changed[changed.length - 30] ?? 0) ^ 1
		io.files.set('dump.kopje', changed)
		io.files.set(`media/${key}`, new TextEncoder().encode('an origjnal'))
		const bad = await verify(io, ['manifest.json', 'dump.kopje', '--media', 'media'])
		expect(bad.code).toBe(1)
		expect(bad.err).toContain("dump: dump.kopje does not match the manifest's SHA-256")
		expect(bad.err).toContain(`media: media/${key} does not match`)

		// A truncated dump, and a manifest that was not decrypted.
		io.files.set('dump.kopje', dump.slice(0, 100))
		expect((await verify(io, ['manifest.json', 'dump.kopje'])).err).toContain('the manifest says')
		io.files.set('manifest.age', h.s3.objects.get(`${PREFIX}backups/2026-10-13/manifest.json.age`)!)
		expect((await verify(io, ['manifest.age', 'dump.kopje'])).code).toBe(1)
	})
})
