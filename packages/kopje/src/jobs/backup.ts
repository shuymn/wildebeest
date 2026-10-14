import { type BackupConfig, readBackupConfig } from '../platform/backup-config'
import { encryptBytes, encryptStream, sha256Of, toHex } from '../platform/backup-crypto'
import {
	type BackupRun,
	type BackupState,
	type Coverage,
	type DumpProgress,
	type DumpResult,
	EMPTY_BACKUP_STATE,
	type MediaRow,
	type ObjectDigest,
} from '../platform/backup-state'
import { readConfig } from '../platform/config'
import { errorFields } from '../platform/error-message'
import { PACKAGE_VERSION } from '../platform/package-version'
import { S3Client, S3Error, type S3Fetch } from '../platform/s3'
import type { StoreResolver, StoreStub } from '../platform/store-client'
import type { DumpCursor } from '../platform/store-dump'
import { StoreUnavailableError, toStoreUnavailable } from '../platform/store-errors'

// The daily encrypted backup (docs/backup.md). Each 5-minute cron asks whether a backup is due or running, and if so
// takes the runner lease (in the Store) and moves the run forward within one invocation deadline:
//
//   dump      the Store's dump (B6a's chunked RPCs, the import format), age-encrypted as it streams into one S3
//             multipart upload. The Store is frozen (readonly, inbound spooled) from dumpStart until the last chunk is
//             read; then the job records which originals the dump references and ends the freeze at once. The freeze
//             also ends on any failure (by opId, even when dumpStart's answer was lost) and by its lease if the Worker
//             dies. age's stream state cannot be saved, so an interrupted dump is restarted, never continued.
//   media     each referenced original not yet in this bucket, encrypted on its own; progress is in the Store's
//             media index (backup_media) and the stage spans invocations.
//   index     the complete media index: every original the dump references, with its object and digests, or why it
//             is missing.
//   manifest  written last, with the digests of the dump and the index, so its presence marks a complete backup.
//   retention keeps the newest BACKUP_RETENTION complete backups and deletes older ones, only under backups/.
//
// Fencing (OPS-5): every object a run writes is named <run id>/<attempt>, the attempt being the invocation that holds
// the lease. An invocation that lost the lease can finish a request already in flight, but only into its own names,
// never into objects another invocation recorded. Every Store write checks the lease in its transaction.
//
// Nothing is ever deleted from R2. Every byte sent to the bucket is ciphertext (DATA-4), and neither secrets nor error
// messages reach logs, the saved state or health: failures are recorded as fixed reason codes (DATA-5, DATA-9).

export const DUMP_NAME = 'dump.kopje.age'
export const INDEX_NAME = 'media-index.json.age'
export const MANIFEST_NAME = 'manifest.json.age'
export const MANIFEST_FORMAT = 'kopje-backup'
export const INDEX_FORMAT = 'kopje-backup-media-index'

const MIB = 1024 * 1024
// S3 parts are at least 5 MiB except the last.
export const MIN_PART_BYTES = 5 * MIB
const PART_BYTES = 8 * MIB
const CHUNK_BYTES = 4 * MIB
// The freeze lease, renewed by every dump chunk. It bounds how long a dead job keeps the Store frozen.
const DUMP_LEASE_SECONDS = 180
// The runner lease, renewed by every save. It is the platform's wall-time limit of a cron invocation, so a live runner
// never loses it between two saves (one request and its retries end by the invocation deadline).
const RUNNER_LEASE_MS = 15 * 60 * 1000
// Of the cron's 15 minutes of wall time; the reserve is kept for the last checkpoint and cleanup.
const INVOCATION_MS = 13 * 60 * 1000
const RESERVE_MS = 60 * 1000
// Plaintext bytes one invocation may encrypt, to stay inside the cron's 30 seconds of CPU: age, both SHA-256 digests
// and the copies cost about 4-6 ms of CPU per MiB measured on a 2026 desktop CPU (docs/backup.md), so this leaves room
// for a slower machine. Media copying and the index wait for the next cron at the budget; a dump cannot be split, so a
// dump larger than the budget fails as dump-too-large.
export const WORK_BYTES = 512 * MIB
const MEDIA_PAGE = 100
export const MAX_MEDIA_PER_RUN = 2000
// Originals are at most 16 MiB (platform/images.ts); anything far larger is not a Kopje upload.
const MAX_MEDIA_BYTES = 64 * MIB
const RETRY_MS = 60 * 60 * 1000
// Invocations that may die holding one run before it is recorded as failed.
export const MAX_ATTEMPTS = 3

export type BackupFaultPoint =
	| 'dump-chunk'
	| 'dump-part'
	| 'dump-complete'
	| 'media-copied'
	| 'index-stage'
	| 'manifest-stage'
	| 'manifest-written'
	| 'retention-deleted'

export type BackupDeps = {
	build: (env: Env) => string
	store: StoreResolver
	now: () => number
	fetch: S3Fetch
	log?: (entry: Record<string, unknown>) => void
	partBytes?: number
	chunkBytes?: number
	invocationMs?: number
	workBytes?: number
	maxMediaPerRun?: number
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
	| 'unpublished'
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

// Another invocation holds the run now; this one stops without recording anything.
class LostRunner extends Error {}

// The invocation deadline is near: the run is saved and continues at the next cron.
class OutOfTime extends Error {}

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

function randomHex(bytes: number): string {
	return toHex(crypto.getRandomValues(new Uint8Array(bytes)))
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
	// This invocation: the runner lease holder, and the attempt segment of every object name it writes.
	readonly #attempt = randomHex(8)
	readonly #partBytes: number
	readonly #deadline: number
	// Plaintext bytes encrypted by this invocation.
	#work = 0
	readonly #workLimit: number
	readonly #maxMedia: number
	#state: BackupState = EMPTY_BACKUP_STATE

	constructor(env: Env, config: BackupConfig, deps: BackupDeps) {
		this.#env = env
		this.#config = config
		this.#deps = deps
		this.#build = deps.build(env)
		this.#store = deps.store(env)
		this.#deadline = deps.now() + (deps.invocationMs ?? INVOCATION_MS)
		this.#s3 = new S3Client(config, deps.fetch, { sleep: deps.sleep, budget: () => this.#budget() })
		this.#log = deps.log ?? defaultLog
		this.#partBytes = Math.max(MIN_PART_BYTES, deps.partBytes ?? PART_BYTES)
		this.#workLimit = deps.workBytes ?? WORK_BYTES
		this.#maxMedia = deps.maxMediaPerRun ?? MAX_MEDIA_PER_RUN
	}

	// Time left for requests, keeping the reserve for the last checkpoint and cleanup.
	#budget(): number {
		return this.#deadline - RESERVE_MS - this.#deps.now()
	}

	async run(): Promise<BackupOutcome> {
		const now = this.#deps.now()
		const seen = await this.#store.backupState(this.#build)
		if (seen.runner !== null && now < seen.runner.until) {
			return 'busy'
		}
		if (seen.retryAt !== null && now < seen.retryAt) {
			return 'waiting'
		}
		if (seen.run === null && !this.#due(seen, now)) {
			return 'not-due'
		}
		const fingerprint = await this.#fingerprint()
		const claim = await this.#store.backupClaim(this.#build, this.#attempt, now, RUNNER_LEASE_MS)
		if (!claim.ok) {
			// Unpublished: nothing runs (no S3 call, no dump) until the instance is published.
			return claim.code === 'unpublished' ? 'unpublished' : 'busy'
		}
		this.#state = claim.state
		try {
			await this.#abortStrayUploads()
			const held = this.#state.run
			if (held !== null && held.fingerprint !== fingerprint) {
				await this.#abandon(held)
			}
			if (this.#state.run === null) {
				if (!this.#due(this.#state, now)) {
					await this.#save(() => {}, { release: true })
					return 'not-due'
				}
				await this.#save((s) => {
					s.retryAt = null
					s.run = {
						id: `${utcDate(now)}-${randomHex(4)}`,
						startedAt: now,
						attempts: 0,
						stage: 'dump',
						fingerprint,
						recipients: [...this.#config.recipients],
						dump: null,
						result: null,
						copied: 0,
						index: null,
						manifestAt: null,
					}
				})
			} else if (claim.crashed) {
				await this.#save((s) => {
					s.run!.attempts++
				})
			}
			const run = this.#run()
			this.#log({ event: 'kopje.backup.run', id: run.id, stage: run.stage, attempts: run.attempts })
			if (run.dump !== null) {
				await this.#releaseDump(run.dump)
			}
			if (run.attempts >= MAX_ATTEMPTS) {
				throw new BackupError('interrupted')
			}
			if (this.#run().stage === 'dump') {
				await this.#dump()
			}
			if (this.#run().stage === 'media') {
				await this.#media()
			}
			if (this.#run().stage === 'index') {
				await this.#index()
			}
			await this.#manifest()
			return 'done'
		} catch (error) {
			if (error instanceof Crash) {
				throw error.cause
			}
			if (error instanceof LostRunner) {
				this.#log({ event: 'kopje.backup.lost_lease', id: this.#state.run?.id ?? null })
				return 'busy'
			}
			if (error instanceof OutOfTime) {
				return this.#pause()
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

	#runBase(run: BackupRun): string {
		return `${backupPrefix(this.#config)}${run.id}/${this.#attempt}/`
	}

	// Due once per UTC day, at or after BACKUP_HOUR_UTC, on a day after the last successful backup's: a clock that
	// went back never reuses a day that already has a backup.
	#due(state: BackupState, now: number): boolean {
		if (new Date(now).getUTCHours() < this.#config.hourUtc) {
			return false
		}
		const last = state.lastSuccess?.id.slice(0, 10)
		return last === undefined || utcDate(now) > last
	}

	// The bucket (endpoint, bucket, region, prefix) and the recipients: a run, and every media copy, is valid only for
	// the fingerprint it was made under.
	async #fingerprint(): Promise<string> {
		const { endpoint, bucket, region, prefix, recipients } = this.#config
		return sha256Of(
			new TextEncoder().encode(JSON.stringify([endpoint, bucket, region, prefix, [...recipients].sort()]))
		)
	}

	// Saves a copy of the state if this invocation still holds the lease (checked in the Store), renewing it.
	async #save(
		mutate: (state: BackupState) => void,
		{ release = false, pruneTo = null }: { release?: boolean; pruneTo?: string | null } = {}
	): Promise<void> {
		const next = structuredClone(this.#state)
		mutate(next)
		const result = await this.#store.backupSave(
			this.#build,
			this.#attempt,
			this.#deps.now(),
			RUNNER_LEASE_MS,
			next,
			release,
			pruneTo
		)
		if (!result.ok) {
			if (result.code === 'lost') {
				throw new LostRunner()
			}
			throw new BackupError(`state-${result.code}`)
		}
		this.#state = { ...next, runner: release ? null : { id: this.#attempt, until: result.until } }
	}

	#fault(point: BackupFaultPoint): void {
		try {
			this.#deps.inject?.(point)
		} catch (error) {
			throw new Crash(point, { cause: error })
		}
	}

	#checkTime(): void {
		if (this.#budget() <= 0 || this.#work >= this.#workLimit) {
			throw new OutOfTime()
		}
	}

	async #pause(): Promise<BackupOutcome> {
		const run = this.#state.run
		this.#log({ event: 'kopje.backup.paused', id: run?.id ?? null, stage: run?.stage ?? null })
		try {
			await this.#save(() => {}, { release: true })
		} catch (error) {
			if (!(error instanceof LostRunner)) {
				this.#log({ event: 'kopje.backup.record_failed', ...errorFields(error) })
			}
		}
		return 'paused'
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
			// The run keeps its dump handles; the next invocation releases them again (idempotent).
			await this.#save(
				(s) => {
					s.lastFailure = { id: run?.id ?? null, at: now, stage: run?.stage ?? null, reason }
					s.retryAt = now + RETRY_MS
					if (s.run !== null) {
						s.run.attempts = 0
					}
				},
				{ release: true }
			)
		} catch (saveError) {
			// The runner lease ends on its own; the next invocation recovers the run.
			this.#log({ event: 'kopje.backup.record_failed', ...errorFields(saveError) })
		}
	}

	// A run whose destination or recipients no longer match the settings cannot continue: its objects are in another
	// bucket, or encrypted to other keys. It is dropped, and its freeze released; a new run starts.
	async #abandon(run: BackupRun): Promise<void> {
		if (run.dump !== null) {
			await this.#store.dumpAbort(this.#build, run.dump.opId)
		}
		this.#log({ event: 'kopje.backup.abandoned', id: run.id, reason: 'settings-changed' })
		await this.#save((s) => {
			s.run = null
		})
	}

	// Releases what an earlier invocation left: the Store's freeze (by opId, which never starts a dump) and the
	// multipart upload. Both are no-ops when already released.
	async #releaseDump(dump: DumpProgress): Promise<void> {
		await this.#store.dumpAbort(this.#build, dump.opId)
		if (dump.uploadId !== null) {
			await this.#s3.abortMultipart(dump.key, dump.uploadId)
		}
		await this.#save((s) => {
			s.run!.dump = null
		})
	}

	// Multipart uploads under backups/ that no live invocation is writing: this one holds the lease, so any upload
	// there is from an invocation that died or lost the lease.
	async #abortStrayUploads(): Promise<void> {
		let uploads: { key: string; uploadId: string }[]
		try {
			uploads = await this.#s3.listUploads(backupPrefix(this.#config))
		} catch (error) {
			// Not every store or policy lists uploads; the bucket's lifecycle rule then cleans up (docs/backup.md).
			this.#log({ event: 'kopje.backup.list_uploads_failed', reason: failureReason(error) })
			return
		}
		for (const upload of uploads) {
			await this.#s3.abortMultipart(upload.key, upload.uploadId)
			this.#log({ event: 'kopje.backup.upload_aborted' })
		}
	}

	// Streams `next` through age into a multipart upload. Each part is preceded by a save, so a part is uploaded only
	// while this invocation holds the lease. The plaintext counts toward the invocation's byte budget, and crossing it
	// throws `overBudget()`. On failure, `release` runs first (the dump's freeze), then the stream is cancelled and the
	// upload aborted.
	async #upload({
		key,
		next,
		onStart,
		onPart,
		recipients,
		overBudget,
		release = () => Promise.resolve(),
	}: {
		key: string
		next: () => Promise<Uint8Array | null>
		onStart: (uploadId: string) => Promise<void>
		onPart: (parts: number, bytes: number) => Promise<void>
		recipients: readonly string[]
		overBudget: () => Error
		release?: () => Promise<void>
	}): Promise<ObjectDigest> {
		const uploadId = await this.#s3.createMultipart(key, 'application/octet-stream')
		let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
		try {
			await onStart(uploadId)
			const plainDigest = new crypto.DigestStream('SHA-256')
			const plainWriter = plainDigest.getWriter()
			let plainBytes = 0
			const plaintext = new ReadableStream<Uint8Array>(
				{
					pull: async (controller) => {
						for (;;) {
							const piece = await next()
							if (piece === null) {
								controller.close()
								return
							}
							if (piece.byteLength > 0) {
								plainBytes += piece.byteLength
								this.#work += piece.byteLength
								if (this.#work > this.#workLimit) {
									throw overBudget()
								}
								await plainWriter.write(piece)
								controller.enqueue(piece)
								return
							}
						}
					},
				},
				{ highWaterMark: 0 }
			)
			reader = (await encryptStream(recipients, plaintext)).getReader()
			const cipherDigest = new crypto.DigestStream('SHA-256')
			const cipherWriter = cipherDigest.getWriter()
			let cipherBytes = 0
			const part = new Uint8Array(this.#partBytes)
			let filled = 0
			const parts: { partNumber: number; etag: string }[] = []
			const flush = async () => {
				const partNumber = parts.length + 1
				parts.push({ partNumber, etag: await this.#s3.uploadPart(key, uploadId, partNumber, part.slice(0, filled)) })
				filled = 0
				await onPart(parts.length, cipherBytes)
			}
			for (;;) {
				const { done, value } = await reader.read()
				if (done) {
					break
				}
				cipherBytes += value.byteLength
				await cipherWriter.write(value)
				for (let offset = 0; offset < value.byteLength;) {
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
			await this.#s3.completeMultipart(key, uploadId, parts)
			await plainWriter.close()
			await cipherWriter.close()
			return {
				key,
				size: cipherBytes,
				sha256: toHex(await cipherDigest.digest),
				plaintext: { size: plainBytes, sha256: toHex(await plainDigest.digest) },
			}
		} catch (error) {
			if (!(error instanceof Crash)) {
				await release().catch(() => {})
				await reader?.cancel().catch(() => {})
				await this.#s3.abortMultipart(key, uploadId).catch(() => {})
			}
			throw error
		}
	}

	async #dump(): Promise<void> {
		const run = this.#run()
		const key = `${this.#runBase(run)}${DUMP_NAME}`
		const opId = crypto.randomUUID()
		// The opId is saved first, so whatever happens after dumpStart (even a lost answer) can release this dump.
		await this.#save((s) => {
			s.run!.dump = { opId, key, uploadId: null, parts: 0, bytes: 0 }
		})
		try {
			const started = await this.#store.dumpStart(this.#build, DUMP_LEASE_SECONDS, opId)
			if (!started.ok) {
				throw refusal('dump', started.code)
			}
			const { header } = started
			let cursor: DumpCursor = started.cursor
			const encoder = new TextEncoder()
			const pending: Uint8Array[] = [encoder.encode(started.headerLine)]
			let ended = false
			// The dump file, piece by piece: header, chunks, trailer. When the last chunk has been read, the originals
			// it references are recorded and the freeze ends at once; the last chunk and the trailer are kept here.
			const next = async (): Promise<Uint8Array | null> => {
				const piece = pending.shift()
				if (piece !== undefined) {
					return piece
				}
				if (ended) {
					return null
				}
				const step = await this.#store.dumpNext(this.#build, cursor, this.#deps.chunkBytes ?? CHUNK_BYTES)
				if (!step.ok) {
					throw refusal('dump', step.code)
				}
				cursor = step.cursor
				this.#fault('dump-chunk')
				if (step.done) {
					// One Store transaction: the freeze lease must still hold (else writes may have resumed and the
					// membership would not match the dump), the run's media membership is replaced, the freeze ends.
					const finished = await this.#store.backupFinishDump(
						this.#build,
						this.#attempt,
						this.#deps.now(),
						run.id,
						run.fingerprint,
						opId,
						cursor
					)
					if (!finished.ok) {
						throw finished.code === 'lost' ? new LostRunner() : refusal('dump', finished.code)
					}
					if (finished.trailerText === null) {
						throw new BackupError('dump-aborted')
					}
					ended = true
					this.#log({ event: 'kopje.backup.dump.released', id: run.id, media: finished.required })
					pending.push(encoder.encode(finished.trailerText))
				}
				return step.chunk
			}
			const progress = (uploadId: string | null, parts: number, bytes: number) =>
				this.#save((s) => {
					s.run!.dump = { opId, key, uploadId, parts, bytes }
				})
			let uploadId: string | null = null
			const digest = await this.#upload({
				key,
				next,
				onStart: async (id) => {
					uploadId = id
					await progress(id, 0, 0)
				},
				onPart: async (parts, bytes) => {
					await progress(uploadId, parts, bytes)
					this.#fault('dump-part')
				},
				recipients: run.recipients,
				overBudget: () => new BackupError('dump-too-large'),
				// The freeze is released before the stream and the upload are cleaned up.
				release: async () => {
					await this.#store.dumpAbort(this.#build, opId)
				},
			})
			this.#fault('dump-complete')
			const result: DumpResult = {
				...digest,
				createdAt: header.createdAt,
				source: header.source,
				migrations: header.migrations,
			}
			await this.#save((s) => {
				s.run!.stage = 'media'
				s.run!.dump = null
				s.run!.result = result
			})
			this.#log({ event: 'kopje.backup.dump.uploaded', id: run.id, bytes: digest.size })
		} catch (error) {
			if (!(error instanceof Crash)) {
				// Released at once, whatever failed; a no-op if the dump already finished. The handles stay in the run
				// for the next invocation in case this fails too.
				await this.#store.dumpAbort(this.#build, opId).catch(() => {})
			}
			throw error
		}
	}

	async #media(): Promise<void> {
		const run = this.#run()
		let copied = 0
		for (;;) {
			const page = await this.#store.backupMedia(this.#build, run.id, null, MEDIA_PAGE, true)
			if (page.length === 0 || this.#run().copied >= this.#maxMedia) {
				break
			}
			for (const row of page) {
				if (this.#run().copied >= this.#maxMedia) {
					break
				}
				this.#checkTime()
				await this.#copyOriginal(run, row)
				copied++
			}
		}
		await this.#save((s) => {
			s.run!.stage = 'index'
		})
		this.#log({ event: 'kopje.backup.media.done', id: run.id, copied, total: this.#run().copied })
	}

	// Copies one original, encrypted, to media/<run>/<attempt>/<key>.age, or records that R2 no longer has it.
	async #copyOriginal(run: BackupRun, row: MediaRow): Promise<void> {
		const object = await this.#env.MEDIA.get(row.source)
		let copy: ObjectDigest | null = null
		if (object !== null) {
			if (object.size > MAX_MEDIA_BYTES) {
				await object.body.cancel()
				throw new BackupError('media-too-large')
			}
			if (this.#work > 0 && this.#work + object.size > this.#workLimit) {
				await object.body.cancel()
				throw new OutOfTime()
			}
			const plaintext = new Uint8Array(await object.arrayBuffer())
			this.#work += plaintext.byteLength
			const ciphertext = await encryptBytes(run.recipients, plaintext)
			const key = `${mediaPrefix(this.#config)}${run.id}/${this.#attempt}/${row.source}.age`
			await this.#s3.put(key, ciphertext, 'application/octet-stream')
			this.#fault('media-copied')
			copy = {
				key,
				size: ciphertext.byteLength,
				sha256: await sha256Of(ciphertext),
				plaintext: { size: plaintext.byteLength, sha256: await sha256Of(plaintext) },
			}
		}
		const recorded = await this.#store.backupRecord(
			this.#build,
			this.#attempt,
			this.#deps.now(),
			row.source,
			copy === null ? { state: 'absent' } : { state: 'copied', destination: run.fingerprint, run: run.id, copy }
		)
		if (!recorded.ok) {
			throw recorded.code === 'lost' ? new LostRunner() : refusal('record', recorded.code)
		}
		await this.#save((s) => {
			s.run!.copied++
		})
	}

	// The complete media index of this run, streamed from backup_media.
	async #index(): Promise<void> {
		this.#fault('index-stage')
		this.#checkTime()
		const run = this.#run()
		const coverage: Coverage = await this.#store.backupCoverage(this.#build, run.id)
		const encoder = new TextEncoder()
		const pending: Uint8Array[] = [
			encoder.encode(`{"format":"${INDEX_FORMAT}","version":1,"run":${JSON.stringify(run.id)},"objects":[`),
		]
		let after: string | null = null
		let first = true
		let ended = false
		const next = async (): Promise<Uint8Array | null> => {
			for (;;) {
				const piece = pending.shift()
				if (piece !== undefined) {
					return piece
				}
				if (ended) {
					return null
				}
				const page = await this.#store.backupMedia(this.#build, run.id, after, 1000, false)
				if (page.length === 0) {
					ended = true
					pending.push(encoder.encode('\n]}\n'))
					continue
				}
				after = page.at(-1)!.source
				let text = ''
				for (const row of page) {
					text += `${first ? '' : ','}\n${indexEntry(row)}`
					first = false
				}
				pending.push(encoder.encode(text))
			}
		}
		// An index too large for a whole invocation's budget can never be written; otherwise it waits for the next cron.
		const fresh = this.#work === 0
		const index = await this.#upload({
			key: `${this.#runBase(run)}${INDEX_NAME}`,
			next,
			onStart: () => this.#save(() => {}),
			onPart: () => this.#save(() => {}),
			recipients: run.recipients,
			overBudget: () => (fresh ? new BackupError('index-too-large') : new OutOfTime()),
		})
		await this.#save((s) => {
			s.run!.stage = 'manifest'
			s.run!.index = { ...index, coverage }
			s.run!.manifestAt = this.#deps.now()
		})
	}

	async #manifest(): Promise<void> {
		this.#fault('manifest-stage')
		this.#checkTime()
		const run = this.#run()
		const { result, index } = run
		if (result === null || index === null || run.manifestAt === null) {
			throw new BackupError('manifest-without-dump')
		}
		const manifest = buildManifest(run, this.#attempt, result, index)
		const key = `${this.#runBase(run)}${MANIFEST_NAME}`
		const ciphertext = await encryptBytes(run.recipients, new TextEncoder().encode(JSON.stringify(manifest)))
		// The lease is checked right before the write.
		await this.#save(() => {})
		await this.#s3.put(key, ciphertext, 'application/octet-stream')
		this.#fault('manifest-written')
		const now = this.#deps.now()
		// Recorded apart from the bucket, so an operator can tell this manifest from one written by someone else holding
		// the recipient's public key and bucket access (anyone can encrypt to a public key).
		const manifestSha256 = await sha256Of(ciphertext)
		await this.#save(
			(s) => {
				s.lastSuccess = {
					id: run.id,
					at: now,
					manifest: key,
					manifestSha256,
					dumpBytes: result.size,
					coverage: index.coverage,
				}
				s.run = null
			},
			{ pruneTo: run.id }
		)
		this.#log({
			event: 'kopje.backup.succeeded',
			id: run.id,
			manifest: key,
			manifestSha256,
			bytes: result.size,
			media: index.coverage,
		})
		let retentionFailure: { at: number; reason: string } | null = null
		try {
			const deleted = await this.#retention()
			this.#log({ event: 'kopje.backup.retention', kept: this.#config.retention, deleted })
		} catch (error) {
			if (error instanceof Crash || error instanceof LostRunner) {
				throw error
			}
			retentionFailure = { at: now, reason: failureReason(error) }
			this.#log({ event: 'kopje.backup.retention_failed', reason: retentionFailure.reason, ...errorFields(error) })
		}
		await this.#save(
			(s) => {
				s.retentionFailure = retentionFailure
			},
			{ release: true }
		)
	}

	// Keeps the newest `retention` complete backups: runs with at least one manifest, selected by manifest only. Every
	// run older than the oldest one kept is deleted, complete or not; only the three object names this job writes, only
	// under backups/, all manifests of a run first, so a half-deleted run never looks complete. The newest complete
	// backup is never deleted (retention is at least 1). media/ is never deleted: the kept indexes refer to it.
	async #retention(): Promise<number> {
		const base = backupPrefix(this.#config)
		const runs = new Map<string, { manifests: string[]; others: string[] }>()
		for (const object of await this.#s3.list(base)) {
			const match =
				/^(\d{4}-\d{2}-\d{2}-[0-9a-f]{8})\/[0-9a-f]{16}\/(dump\.kopje\.age|media-index\.json\.age|manifest\.json\.age)$/.exec(
					object.key.slice(base.length)
				)
			if (match === null) {
				continue
			}
			const [, id = '', name = ''] = match
			const entry = runs.get(id) ?? { manifests: [], others: [] }
			;(name === MANIFEST_NAME ? entry.manifests : entry.others).push(object.key)
			runs.set(id, entry)
		}
		const complete = [...runs]
			.filter(([, entry]) => entry.manifests.length > 0)
			.map(([id]) => id)
			.sort()
			.reverse()
		const oldestKept = complete[this.#config.retention - 1]
		if (oldestKept === undefined) {
			return 0
		}
		await this.#save(() => {})
		let deleted = 0
		for (const [id, entry] of [...runs].sort(([a], [b]) => (a < b ? -1 : 1))) {
			if (id >= oldestKept) {
				continue
			}
			for (const key of [...entry.manifests, ...entry.others]) {
				await this.#s3.delete(key)
				this.#fault('retention-deleted')
				deleted++
			}
		}
		return deleted
	}
}

function indexEntry(row: MediaRow): string {
	return JSON.stringify(
		row.state === 'copied'
			? {
					source: row.source,
					state: row.state,
					key: row.key,
					size: row.size,
					sha256: row.sha256,
					plaintext: { size: row.plain_size, sha256: row.plain_sha256 },
					run: row.copied_run,
				}
			: { source: row.source, state: row.state }
	)
}

export type BackupManifest = ReturnType<typeof buildManifest>

function buildManifest(
	run: BackupRun,
	attempt: string,
	result: DumpResult,
	index: ObjectDigest & { coverage: Coverage }
) {
	return {
		format: MANIFEST_FORMAT,
		version: 1,
		id: run.id,
		attempt,
		createdAt: new Date(run.manifestAt ?? 0).toISOString(),
		kopje: { version: PACKAGE_VERSION, build: result.source.build, dumpVersion: result.source.version },
		schema: {
			version: result.migrations.at(-1)?.name ?? null,
			migrations: result.migrations,
		},
		recipients: [...run.recipients],
		dump: {
			key: result.key,
			size: result.size,
			sha256: result.sha256,
			plaintext: result.plaintext,
			createdAt: result.createdAt,
		},
		mediaIndex: { key: index.key, size: index.size, sha256: index.sha256, plaintext: index.plaintext },
		media: index.coverage,
	}
}
