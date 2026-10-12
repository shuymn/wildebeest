import { type BackupConfig, readBackupConfig } from '../platform/backup-config'
import { encryptBytes, encryptStream, sha256Of, toHex } from '../platform/backup-crypto'
import {
	type BackupRun,
	type BackupState,
	type Digest,
	type DumpProgress,
	type DumpResult,
	EMPTY_BACKUP_STATE,
	type MediaCopy,
} from '../platform/backup-state'
import { readConfig } from '../platform/config'
import { errorFields } from '../platform/error-message'
import { PACKAGE_VERSION } from '../platform/package-version'
import { S3Client, S3Error, type S3Fetch } from '../platform/s3'
import type { StoreResolver, StoreStub } from '../platform/store-client'
import type { DumpCursor } from '../platform/store-dump'
import { StoreUnavailableError, toStoreUnavailable } from '../platform/store-errors'

// The daily encrypted backup (docs/backup.md). Each 5-minute cron asks whether a backup is due or running, and if so
// takes the runner lease and moves the run forward:
//
//   dump      the Store's dump (B6a's chunked RPCs, the import format), age-encrypted as it streams into one S3
//             multipart upload. The Store is frozen (readonly, inbound spooled) from dumpStart to dumpFinish; the
//             freeze is released as soon as the last chunk is read, on any failure, and by its lease if the Worker
//             dies. age's stream state cannot be saved, so an interrupted dump is restarted, never continued: its
//             upload is aborted and a new dump begins.
//   media     every R2 original added since the last successful backup, each encrypted on its own, under
//             media/<run>/. Progress is saved after every object, and the stage spans invocations.
//   manifest  written last, so its presence marks a complete backup.
//   retention keeps the newest BACKUP_RETENTION complete backups and deletes older ones, only under backups/.
//
// Nothing is ever deleted from R2. Every byte sent to the bucket is ciphertext (DATA-4), and neither secrets nor error
// messages reach logs, the saved state or health: failures are recorded as fixed reason codes (DATA-5, DATA-9).

export const DUMP_NAME = 'dump.kopje.age'
export const MANIFEST_NAME = 'manifest.json.age'
export const MANIFEST_FORMAT = 'kopje-backup'
const ORIGINALS = 'originals/'

const MIB = 1024 * 1024
// S3 parts are at least 5 MiB except the last.
export const MIN_PART_BYTES = 5 * MIB
const PART_BYTES = 8 * MIB
const CHUNK_BYTES = 4 * MIB
// The freeze lease, renewed by every dump chunk. It bounds how long a dead job keeps the Store frozen.
const DUMP_LEASE_SECONDS = 180
// The runner lease, renewed by every save. Another invocation takes over only after it ends.
const RUNNER_LEASE_MS = 5 * 60 * 1000
// Media copying stops for this invocation after this long and continues at the next cron.
const MEDIA_BUDGET_MS = 10 * 60 * 1000
// An original is copied only once its id is older than this, so an upload still in flight is not skipped.
const MEDIA_SETTLE_MS = 60 * 60 * 1000
const MEDIA_LIST_LIMIT = 100
export const MAX_MEDIA_PER_RUN = 2000
// Originals are at most 16 MiB (platform/images.ts); anything far larger is not a Kopje upload.
const MAX_MEDIA_BYTES = 64 * MIB
const RETRY_MS = 60 * 60 * 1000
// Invocations that may die holding one run before it is recorded as failed.
const MAX_ATTEMPTS = 3

export type BackupFaultPoint =
	| 'dump-chunk'
	| 'dump-part'
	| 'dump-complete'
	| 'media-copied'
	| 'manifest-stage'
	| 'manifest-written'

export type BackupDeps = {
	build: (env: Env) => string
	store: StoreResolver
	now: () => number
	fetch: S3Fetch
	log?: (entry: Record<string, unknown>) => void
	randomId?: () => string
	partBytes?: number
	chunkBytes?: number
	mediaBudgetMs?: number
	// Tests: throwing at a point simulates the Worker dying there (no cleanup runs, nothing is recorded).
	inject?: (point: BackupFaultPoint) => void
	sleep?: (ms: number) => Promise<void>
}

export type BackupOutcome =
	| 'disabled'
	| 'not-configured'
	| 'invalid'
	| 'busy'
	| 'waiting'
	| 'not-due'
	| 'done'
	| 'paused'
	| 'failed'

export class BackupError extends Error {
	constructor(readonly code: string) {
		super(code)
		this.name = 'BackupError'
	}
}

// A simulated death of the Worker (deps.inject): it propagates past every cleanup.
class Crash extends Error {}

// Another invocation took the run over; this one stops without recording anything.
class LostRunner extends Error {}

const SAFE_CODE = /^[a-z0-9-]{1,64}$/

// A failure as a fixed code: never an error message, which could carry a URL, a response or a secret.
export function failureReason(error: unknown): string {
	if (error instanceof BackupError || error instanceof S3Error) {
		return SAFE_CODE.test(error.message) ? error.message : 'unexpected'
	}
	const unavailable = error instanceof StoreUnavailableError ? error : toStoreUnavailable(error)
	if (unavailable !== null) {
		return 'store-unavailable'
	}
	const fields = errorFields(error)
	return `unexpected-${(fields.name ?? fields.error).replace(/[^A-Za-z0-9]/g, '').toLowerCase()}`.slice(0, 64)
}

function refusal(prefix: string, code: unknown): BackupError {
	const text = `${prefix}-${String(code)}`
	return new BackupError(SAFE_CODE.test(text) ? text : `${prefix}-refused`)
}

export function utcDate(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10)
}

// A snowflake id's time: the id is (ms << 16) | 16 random bits (domain/ids.ts).
function snowflakeMs(id: string): number {
	return Number(BigInt(id) >> 16n)
}

export function backupPrefix(config: BackupConfig): string {
	return `${config.prefix}backups/`
}

export function mediaPrefix(config: BackupConfig): string {
	return `${config.prefix}media/`
}

// The cron entry point: nothing runs while the env sets maintenance or is invalid, as for the other jobs.
export async function scheduledBackup(env: Env, deps: BackupDeps): Promise<BackupOutcome | null> {
	const config = readConfig(env)
	if (!config.ok || config.config.MAINTENANCE !== 'off') {
		return null
	}
	try {
		return await runBackup(env, deps)
	} catch (error) {
		;(deps.log ?? defaultLog)({ event: 'kopje.backup.error', ...errorFields(error) })
		return null
	}
}

function defaultLog(entry: Record<string, unknown>): void {
	console.log(entry)
}

export async function runBackup(env: Env, deps: BackupDeps): Promise<BackupOutcome> {
	const settings = readBackupConfig(env)
	if (settings.state !== 'ready') {
		return settings.state
	}
	return new BackupJob(env, settings.config, deps).run()
}

class BackupJob {
	readonly #env: Env
	readonly #config: BackupConfig
	readonly #deps: BackupDeps
	readonly #build: string
	readonly #store: StoreStub
	readonly #s3: S3Client
	readonly #log: (entry: Record<string, unknown>) => void
	readonly #runner: string
	readonly #partBytes: number
	#rev = 0
	#state: BackupState = EMPTY_BACKUP_STATE

	constructor(env: Env, config: BackupConfig, deps: BackupDeps) {
		this.#env = env
		this.#config = config
		this.#deps = deps
		this.#build = deps.build(env)
		this.#store = deps.store(env)
		this.#s3 = new S3Client(config, deps.fetch, deps.sleep)
		this.#log = deps.log ?? defaultLog
		this.#runner = (deps.randomId ?? (() => crypto.randomUUID()))()
		this.#partBytes = Math.max(MIN_PART_BYTES, deps.partBytes ?? PART_BYTES)
	}

	async run(): Promise<BackupOutcome> {
		const loaded = await this.#store.backupState(this.#build)
		this.#rev = loaded.rev
		this.#state = loaded.state
		const now = this.#deps.now()
		const { runner, run, retryAt } = this.#state
		if (runner !== null && now < runner.until) {
			return 'busy'
		}
		if (retryAt !== null && now < retryAt) {
			return 'waiting'
		}
		if (run === null && !this.#due(now)) {
			return 'not-due'
		}
		// A run whose runner lease ran out without a release: that invocation died.
		const crashed = run !== null && runner !== null
		try {
			await this.#save((s) => {
				s.retryAt = null
				if (s.run === null) {
					s.run = {
						id: utcDate(now),
						startedAt: now,
						attempts: 0,
						stage: 'dump',
						dump: null,
						result: null,
						media: { from: s.mediaAfter, after: s.mediaAfter, objects: [] },
						manifestAt: null,
					}
				} else if (crashed) {
					s.run.attempts++
				}
			})
		} catch (error) {
			if (error instanceof LostRunner) {
				return 'busy'
			}
			throw error
		}
		const current = this.#run()
		this.#log({ event: 'kopje.backup.run', id: current.id, stage: current.stage, attempts: current.attempts, crashed })
		try {
			if (current.dump !== null) {
				await this.#releaseDump(current.dump)
			}
			if (current.attempts > MAX_ATTEMPTS) {
				throw new BackupError('interrupted')
			}
			if (this.#run().stage === 'dump') {
				await this.#dump()
			}
			if (this.#run().stage === 'media' && (await this.#media()) === 'paused') {
				await this.#save(() => {}, true)
				return 'paused'
			}
			await this.#manifest()
			return 'done'
		} catch (error) {
			if (error instanceof Crash) {
				throw error.cause
			}
			if (error instanceof LostRunner) {
				return 'busy'
			}
			await this.#fail(error)
			return 'failed'
		}
	}

	#run(): BackupRun {
		const run = this.#state.run
		if (run === null) {
			throw new BackupError('no-run')
		}
		return run
	}

	// Due once per UTC day, at or after BACKUP_HOUR_UTC, unless that day's backup already succeeded.
	#due(now: number): boolean {
		if (new Date(now).getUTCHours() < this.#config.hourUtc) {
			return false
		}
		return this.#state.lastSuccess?.id !== utcDate(now)
	}

	// Saves a copy of the state with the runner lease renewed (or released), compare-and-set on rev.
	async #save(mutate: (state: BackupState) => void, release = false): Promise<void> {
		const next = structuredClone(this.#state)
		mutate(next)
		next.runner = release ? null : { id: this.#runner, until: this.#deps.now() + RUNNER_LEASE_MS }
		const result = await this.#store.backupSave(this.#build, this.#rev, next)
		if (!result.ok) {
			if (result.code === 'conflict') {
				throw new LostRunner()
			}
			throw new BackupError(`state-${result.code}`)
		}
		this.#rev = result.rev
		this.#state = next
	}

	#fault(point: BackupFaultPoint): void {
		try {
			this.#deps.inject?.(point)
		} catch (error) {
			throw new Crash(point, { cause: error })
		}
	}

	async #fail(error: unknown): Promise<void> {
		const run = this.#state.run
		const reason = failureReason(error)
		this.#log({
			event: 'kopje.backup.failed',
			id: run?.id ?? null,
			stage: run?.stage ?? null,
			reason,
			...errorFields(error),
		})
		const now = this.#deps.now()
		try {
			await this.#save((s) => {
				s.lastFailure = { id: run?.id ?? null, at: now, stage: run?.stage ?? null, reason }
				s.retryAt = now + RETRY_MS
				if (s.run !== null) {
					s.run.attempts = 0
					if (s.run.stage === 'dump') {
						s.run.dump = null
					}
				}
			}, true)
		} catch (saveError) {
			// The runner lease ends on its own; the next invocation recovers the run.
			this.#log({ event: 'kopje.backup.record_failed', ...errorFields(saveError) })
		}
	}

	// Releases what a dead invocation left: the Store's freeze (found by its cursor, or by opId if the cursor was never
	// saved) and the multipart upload.
	async #releaseDump(dump: DumpProgress): Promise<void> {
		let cursor = dump.cursor
		if (cursor === null) {
			// Asking with the same opId returns that dump while it runs. If it already ended, this starts a fresh one,
			// which is aborted on the next line: a freeze of one round trip.
			const again = await this.#store.dumpStart(this.#build, DUMP_LEASE_SECONDS, dump.opId)
			cursor = again.ok ? again.cursor : null
		}
		if (cursor !== null) {
			// Refused when that dump finished, expired or was replaced: then there is no freeze of ours to release.
			await this.#store.dumpFinish(this.#build, cursor, true)
		}
		if (dump.uploadId !== null) {
			await this.#s3.abortMultipart(dump.key, dump.uploadId)
		}
		await this.#save((s) => {
			if (s.run !== null) {
				s.run.dump = null
			}
		})
	}

	// Multipart uploads under backups/ that no run holds: from an invocation that died before saving the upload id.
	async #abortStrayUploads(): Promise<void> {
		let uploads: { key: string; uploadId: string }[]
		try {
			uploads = await this.#s3.listUploads(backupPrefix(this.#config))
		} catch (error) {
			// Some S3-compatible stores do not list uploads; a bucket lifecycle rule then cleans up (docs/backup.md).
			this.#log({ event: 'kopje.backup.list_uploads_failed', reason: failureReason(error) })
			return
		}
		for (const upload of uploads) {
			await this.#s3.abortMultipart(upload.key, upload.uploadId)
			this.#log({ event: 'kopje.backup.upload_aborted' })
		}
	}

	async #dump(): Promise<void> {
		const run = this.#run()
		const key = `${backupPrefix(this.#config)}${run.id}/${DUMP_NAME}`
		await this.#abortStrayUploads()
		const opId = crypto.randomUUID()
		// The opId is saved first, so a death right after dumpStart can still find and release this dump.
		await this.#save((s) => {
			s.run!.dump = { opId, cursor: null, key, uploadId: null, parts: 0, bytes: 0 }
		})
		const started = await this.#store.dumpStart(this.#build, DUMP_LEASE_SECONDS, opId)
		if (!started.ok) {
			throw refusal('dump', started.code)
		}
		const header = started.header
		let cursor: DumpCursor = started.cursor
		let frozen = true
		let uploadId: string | null = null
		let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
		try {
			uploadId = await this.#s3.createMultipart(key, 'application/octet-stream')
			const id = uploadId
			await this.#save((s) => {
				s.run!.dump = { opId, cursor, key, uploadId: id, parts: 0, bytes: 0 }
			})

			const plainDigest = new crypto.DigestStream('SHA-256')
			const plainWriter = plainDigest.getWriter()
			let plainBytes = 0
			const encoder = new TextEncoder()
			const pending: Uint8Array[] = [encoder.encode(started.headerLine)]
			let ended = false
			// Pulls the next piece of the dump file: header line, chunks, then the trailer from dumpFinish (which ends the
			// freeze at once, before the last parts are uploaded).
			const next = async (): Promise<Uint8Array | null> => {
				for (;;) {
					const piece = pending.shift()
					if (piece !== undefined) {
						if (piece.byteLength === 0) {
							continue
						}
						return piece
					}
					if (ended) {
						return null
					}
					if (cursor.phase === 'done') {
						const finished = await this.#store.dumpFinish(this.#build, cursor)
						if (!finished.ok || finished.trailerText === null) {
							throw finished.ok ? new BackupError('dump-aborted') : refusal('dump', finished.code)
						}
						frozen = false
						ended = true
						this.#log({ event: 'kopje.backup.dump.released', id: run.id })
						pending.push(encoder.encode(finished.trailerText))
						continue
					}
					const step = await this.#store.dumpNext(this.#build, cursor, this.#deps.chunkBytes ?? CHUNK_BYTES)
					if (!step.ok) {
						throw refusal('dump', step.code)
					}
					cursor = step.cursor
					pending.push(step.chunk)
					this.#fault('dump-chunk')
				}
			}
			const plaintext = new ReadableStream<Uint8Array>(
				{
					pull: async (controller) => {
						const piece = await next()
						if (piece === null) {
							controller.close()
							return
						}
						plainBytes += piece.byteLength
						await plainWriter.write(piece)
						controller.enqueue(piece)
					},
				},
				{ highWaterMark: 0 }
			)

			reader = (await encryptStream(this.#config.recipients, plaintext)).getReader()
			const cipherDigest = new crypto.DigestStream('SHA-256')
			const cipherWriter = cipherDigest.getWriter()
			let cipherBytes = 0
			const part = new Uint8Array(this.#partBytes)
			let filled = 0
			const parts: { partNumber: number; etag: string }[] = []
			const flush = async () => {
				const partNumber = parts.length + 1
				const etag = await this.#s3.uploadPart(key, id, partNumber, part.slice(0, filled))
				parts.push({ partNumber, etag })
				filled = 0
				const at = cursor
				await this.#save((s) => {
					s.run!.dump = { opId, cursor: at, key, uploadId: id, parts: parts.length, bytes: cipherBytes }
				})
				this.#fault('dump-part')
			}
			for (;;) {
				const { done, value } = await reader.read()
				if (done) {
					break
				}
				cipherBytes += value.byteLength
				await cipherWriter.write(value)
				for (let offset = 0; offset < value.byteLength; ) {
					const take = Math.min(this.#partBytes - filled, value.byteLength - offset)
					part.set(value.subarray(offset, offset + take), filled)
					filled += take
					offset += take
					if (filled === this.#partBytes) {
						await flush()
					}
				}
			}
			if (filled > 0 || parts.length === 0) {
				await flush()
			}
			await this.#s3.completeMultipart(key, id, parts)
			this.#fault('dump-complete')
			await plainWriter.close()
			await cipherWriter.close()
			const result: DumpResult = {
				key,
				size: cipherBytes,
				sha256: toHex(await cipherDigest.digest),
				plaintext: { size: plainBytes, sha256: toHex(await plainDigest.digest) },
				createdAt: header.createdAt,
				source: header.source,
				migrations: header.migrations,
			}
			await this.#save((s) => {
				s.run!.stage = 'media'
				s.run!.dump = null
				s.run!.result = result
			})
			this.#log({ event: 'kopje.backup.dump.uploaded', id: run.id, bytes: cipherBytes, parts: parts.length })
		} catch (error) {
			if (error instanceof Crash) {
				throw error
			}
			await reader?.cancel().catch(() => {})
			// Release the freeze first, then the upload; a failure of either is cleaned up by the next attempt.
			if (frozen) {
				await this.#store.dumpFinish(this.#build, cursor, true).catch(() => {})
			}
			if (uploadId !== null) {
				await this.#s3.abortMultipart(key, uploadId).catch(() => {})
			}
			throw error
		}
	}

	async #media(): Promise<'done' | 'paused'> {
		const deadline = this.#deps.now() + (this.#deps.mediaBudgetMs ?? MEDIA_BUDGET_MS)
		const run = this.#run()
		const horizon = run.startedAt - MEDIA_SETTLE_MS
		let copied = 0
		for (;;) {
			const listing = await this.#env.MEDIA.list({
				prefix: ORIGINALS,
				limit: MEDIA_LIST_LIMIT,
				...(this.#run().media.after === null ? {} : { startAfter: this.#run().media.after! }),
			})
			let reachedHorizon = false
			for (const object of listing.objects) {
				if (this.#run().media.objects.length >= MAX_MEDIA_PER_RUN) {
					reachedHorizon = true
					break
				}
				if (this.#deps.now() >= deadline) {
					this.#log({ event: 'kopje.backup.media.paused', id: run.id, copied })
					return 'paused'
				}
				const id = object.key.slice(ORIGINALS.length)
				const isMediaId = /^\d{18}$/.test(id)
				if (isMediaId && snowflakeMs(id) >= horizon) {
					reachedHorizon = true
					break
				}
				const copy = isMediaId ? await this.#copyOriginal(object.key) : null
				await this.#save((s) => {
					s.run!.media.after = object.key
					if (copy !== null) {
						s.run!.media.objects.push(copy)
					}
				})
				if (copy !== null) {
					copied++
				}
			}
			if (reachedHorizon || !listing.truncated) {
				break
			}
		}
		await this.#save((s) => {
			s.run!.stage = 'manifest'
			s.run!.manifestAt = this.#deps.now()
		})
		this.#log({ event: 'kopje.backup.media.done', id: run.id, copied, total: this.#run().media.objects.length })
		return 'done'
	}

	// Copies one original, encrypted, under media/<run>/. Writing the same key again after a crash is harmless.
	async #copyOriginal(source: string): Promise<MediaCopy | null> {
		const object = await this.#env.MEDIA.get(source)
		if (object === null) {
			// Deleted since it was listed (a failed upload's cleanup); nothing to keep.
			return null
		}
		if (object.size > MAX_MEDIA_BYTES) {
			await object.body.cancel()
			throw new BackupError('media-too-large')
		}
		const plaintext = new Uint8Array(await object.arrayBuffer())
		const ciphertext = await encryptBytes(this.#config.recipients, plaintext)
		const key = `${mediaPrefix(this.#config)}${this.#run().id}/${source}.age`
		await this.#s3.put(key, ciphertext, 'application/octet-stream')
		this.#fault('media-copied')
		return {
			source,
			key,
			size: ciphertext.byteLength,
			sha256: await sha256Of(ciphertext),
			plaintext: await digestOf(plaintext),
		}
	}

	async #manifest(): Promise<void> {
		this.#fault('manifest-stage')
		const run = this.#run()
		const result = run.result
		if (result === null || run.manifestAt === null) {
			throw new BackupError('manifest-without-dump')
		}
		const manifest = buildManifest(run, result, this.#config.recipients)
		const key = `${backupPrefix(this.#config)}${run.id}/${MANIFEST_NAME}`
		const ciphertext = await encryptBytes(this.#config.recipients, new TextEncoder().encode(JSON.stringify(manifest)))
		await this.#s3.put(key, ciphertext, 'application/octet-stream')
		this.#fault('manifest-written')
		const now = this.#deps.now()
		// Recorded apart from the bucket, so an operator can tell this manifest from one written by someone else holding
		// the recipient's public key and bucket access (anyone can encrypt to a public key).
		const manifestSha256 = await sha256Of(ciphertext)
		await this.#save((s) => {
			s.lastSuccess = {
				id: run.id,
				at: now,
				manifest: key,
				manifestSha256,
				dumpBytes: result.size,
				media: run.media.objects.length,
			}
			s.mediaAfter = run.media.after
			s.run = null
		})
		this.#log({
			event: 'kopje.backup.succeeded',
			id: run.id,
			manifestSha256,
			bytes: result.size,
			media: run.media.objects.length,
		})
		let retentionFailure: { at: number; reason: string } | null = null
		try {
			const deleted = await this.#retention()
			this.#log({ event: 'kopje.backup.retention', kept: this.#config.retention, deleted })
		} catch (error) {
			retentionFailure = { at: now, reason: failureReason(error) }
			this.#log({ event: 'kopje.backup.retention_failed', reason: retentionFailure.reason, ...errorFields(error) })
		}
		await this.#save((s) => {
			s.retentionFailure = retentionFailure
		}, true)
	}

	// Keeps the newest `retention` complete backups (those with a manifest). Deletes, only under backups/ and only the
	// two object names this job writes, every backup older than the oldest one kept: its manifest first, so a half-
	// deleted backup never looks complete. The newest complete backup is never deleted (retention is at least 1).
	async #retention(): Promise<number> {
		const base = backupPrefix(this.#config)
		const runs = new Map<string, Set<string>>()
		for (const object of await this.#s3.list(base)) {
			const match = /^(\d{4}-\d{2}-\d{2})\/(dump\.kopje\.age|manifest\.json\.age)$/.exec(object.key.slice(base.length))
			if (match === null) {
				continue
			}
			const [, id = '', name = ''] = match
			runs.set(id, (runs.get(id) ?? new Set()).add(name))
		}
		const complete = [...runs]
			.filter(([, names]) => names.has(MANIFEST_NAME))
			.map(([id]) => id)
			.sort()
			.reverse()
		const oldestKept = complete[this.#config.retention - 1]
		if (oldestKept === undefined) {
			return 0
		}
		let deleted = 0
		for (const [id, names] of [...runs].sort(([a], [b]) => (a < b ? -1 : 1))) {
			if (id >= oldestKept) {
				continue
			}
			for (const name of [MANIFEST_NAME, DUMP_NAME]) {
				if (names.has(name)) {
					await this.#s3.delete(`${base}${id}/${name}`)
					deleted++
				}
			}
		}
		return deleted
	}
}

async function digestOf(bytes: Uint8Array): Promise<Digest> {
	return { size: bytes.byteLength, sha256: await sha256Of(bytes) }
}

export type BackupManifest = ReturnType<typeof buildManifest>

function buildManifest(run: BackupRun, result: DumpResult, recipients: readonly string[]) {
	return {
		format: MANIFEST_FORMAT,
		version: 1,
		id: run.id,
		createdAt: new Date(run.manifestAt ?? 0).toISOString(),
		kopje: { version: PACKAGE_VERSION, build: result.source.build, dumpVersion: result.source.version },
		schema: {
			version: result.migrations.at(-1)?.name ?? null,
			migrations: result.migrations,
		},
		recipients: [...recipients],
		dump: {
			key: result.key,
			size: result.size,
			sha256: result.sha256,
			plaintext: result.plaintext,
			createdAt: result.createdAt,
		},
		media: {
			after: run.media.from,
			through: run.media.after,
			objects: run.media.objects,
		},
	}
}
