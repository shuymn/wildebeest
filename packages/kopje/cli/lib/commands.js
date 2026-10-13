/* global setTimeout, crypto */
import { AdminError } from './client.js'
import {
	chainDigest,
	IMPORT_CHUNK_BYTES,
	IMPORT_CHUNK_STATEMENTS,
	readDumpFile,
	sha256Hex,
	statementChunks,
	utf8,
} from './format.js'

/**
 * @typedef {import('./client.js').AdminClient} AdminClient
 * @typedef {import('./client.js').Json} Json
 * @typedef {import('./format.js').FileIO} FileIO
 * @typedef {{ progress(text: string): void, info(text: string): void, secret?(value: string): void }} Output
 * @typedef {{ bytes: number, statements: number }} ChunkLimits
 */

const MIB = 1024 * 1024
const RETRIES = 5

/**
 * @param {number} attempt
 * @param {(ms: number) => Promise<void>} sleep
 */
function backoff(attempt, sleep) {
	return sleep(Math.min(30_000, 500 * 2 ** attempt))
}

/** @param {number} bytes */
export function formatBytes(bytes) {
	if (bytes >= MIB) {
		return `${(bytes / MIB).toFixed(1)} MiB`
	}
	if (bytes >= 1024) {
		return `${(bytes / 1024).toFixed(1)} KiB`
	}
	return `${bytes} B`
}

/**
 * @param {number} bytes
 * @param {number} startedAt
 * @param {() => number} now
 */
function rate(bytes, startedAt, now) {
	const seconds = Math.max(0.001, (now() - startedAt) / 1000)
	return `${formatBytes(bytes / seconds)}/s`
}

/**
 * Dumps the Store into a local file. Resumable: <file>.state.json is written before the dump starts, with an op id
 * that makes the start repeatable, and then holds the cursor and the file length after the last complete chunk, so
 * a rerun truncates any partial write and continues from that cursor (or asks the start again by its op id).
 * @param {{ client: AdminClient, io: FileIO, out: Output, path: string, maxBytes?: number, leaseSeconds?: number,
 *   restart?: boolean, now?: () => number, sleep?: (ms: number) => Promise<void> }} options
 */
export async function dumpToFile({
	client,
	io,
	out,
	path,
	maxBytes,
	leaseSeconds,
	restart = false,
	now = Date.now,
	sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
	const statePath = `${path}.state.json`
	/** @param {string} opId */
	const start = (opId) =>
		client.post('/admin/dump/start', leaseSeconds === undefined ? { opId } : { leaseSeconds, opId })
	if (restart) {
		// Release the freeze of the dump being discarded first; it cannot be found once the state file is gone.
		const previous = await io.readText(statePath)
		if (previous !== null) {
			await abandonDump(client, out, JSON.parse(previous), start)
		}
		await io.remove(statePath)
		await io.remove(path)
	}
	const saved = await io.readText(statePath)
	/** @type {{ opId: string, cursor?: any, offset?: number, trailerText?: string, tables?: number }} */
	let state = saved === null ? { opId: crypto.randomUUID() } : JSON.parse(saved)
	if (saved === null) {
		if ((await io.size(path)) !== null) {
			throw new Error(`${path} already exists; choose another file or pass --restart`)
		}
		await io.writeTextAtomic(statePath, JSON.stringify(state))
	}
	if (state.cursor === undefined) {
		// A new dump, or one whose start response or header write was lost: the op id finds the same dump again.
		const started = await start(state.opId)
		try {
			await io.remove(path)
			const header = utf8.encode(started.headerLine)
			await io.append(path, header)
			state = { ...state, cursor: started.cursor, offset: header.byteLength, tables: started.header.tables.length }
			await io.writeTextAtomic(statePath, JSON.stringify(state))
		} catch (error) {
			// Nothing local can continue this dump, so do not leave the Store frozen until the lease ends.
			await client.post('/admin/dump/finish', { cursor: started.cursor, abort: true }).catch(() => {})
			throw error
		}
		out.info(`dump ${started.cursor.dump} started (${state.tables} tables)`)
	} else {
		// Anything after the recorded offset is a partial write of a chunk that is fetched again.
		await io.truncate(path, state.offset ?? 0)
		out.info(`resuming dump ${state.cursor.dump} at ${formatBytes(state.offset ?? 0)}`)
	}

	const startedAt = now()
	let offset = state.offset ?? 0
	const startOffset = offset
	while (state.trailerText === undefined && state.cursor.phase !== 'done') {
		let step
		for (let attempt = 0; ; attempt++) {
			try {
				step = await client.dumpNext(state.cursor, maxBytes)
				break
			} catch (error) {
				if (error instanceof AdminError && error.code === 'dump-lease-expired') {
					throw new Error('the dump lease expired, so the Store may have changed; rerun with --restart')
				}
				if (!(error instanceof AdminError) || !error.transient || attempt >= RETRIES) {
					throw error
				}
				out.info(`retrying after: ${error.message}`)
				await backoff(attempt, sleep)
			}
		}
		await io.append(path, step.chunk)
		offset += step.chunk.byteLength
		state = { ...state, cursor: step.meta.cursor, offset }
		await io.writeTextAtomic(statePath, JSON.stringify(state))
		const where = state.cursor.phase === 'rows' ? `table ${state.cursor.table + 1}/${state.tables}` : state.cursor.phase
		out.progress(`${formatBytes(offset)} written, ${where}, ${rate(offset - startOffset, startedAt, now)}`)
	}

	if (state.trailerText === undefined) {
		const finished = await client.post('/admin/dump/finish', { cursor: state.cursor })
		state = { ...state, trailerText: finished.trailerText }
		await io.writeTextAtomic(statePath, JSON.stringify(state))
	}
	await io.truncate(path, offset)
	await io.append(path, utf8.encode(state.trailerText ?? ''))
	await io.remove(statePath)
	/** @type {Json} */
	const trailer = JSON.parse((state.trailerText ?? '').split('\n')[0]?.replace(/^-- kopje-dump-trailer /, '') ?? '{}')
	out.info(`dump complete: ${trailer.body.statements} statements, ${formatBytes(offset)} of statements and header`)
	return trailer
}

/**
 * Aborts the remote dump a saved state belongs to: by its cursor, or, when the start never got saved, by asking the
 * start again with the same op id (which returns that dump while it runs) and aborting that.
 * @param {AdminClient} client
 * @param {Output} out
 * @param {{ opId?: string, cursor?: any, trailerText?: string }} state
 * @param {(opId: string) => Promise<Json>} start
 */
async function abandonDump(client, out, state, start) {
	if (state.trailerText !== undefined) {
		return
	}
	// Already gone or finished, or the lease is someone else's: nothing of ours holds it. Anything else is an error.
	const gone = ['dump-not-found', 'dump-finished', 'dump-in-progress']
	try {
		const cursor = state.cursor ?? (state.opId === undefined ? undefined : (await start(state.opId)).cursor)
		if (cursor !== undefined) {
			await client.post('/admin/dump/finish', { cursor, abort: true })
			out.info(`aborted dump ${cursor.dump}`)
		}
	} catch (error) {
		if (!(error instanceof AdminError && error.code !== null && gone.includes(error.code))) {
			throw error
		}
	}
}

/**
 * Imports a dump file into an empty Store and verifies it. Resumable: the Store records the last applied chunk and a
 * chain digest; a rerun re-splits the file with the same chunk size, checks the digest up to that chunk, and
 * continues in the phase the import reached. After any failed chunk the progress is read back instead of assuming
 * the chunk was rolled back. A token import is continued with the session credential begin returned, which is kept
 * in <file>.import.json (mode 0600) and never printed.
 * @param {{ client: AdminClient, io: FileIO, out: Output, path: string, chunkBytes?: number,
 *   now?: () => number, sleep?: (ms: number) => Promise<void>, privateFiles?: boolean }} options
 */
export async function importFromFile({
	client: baseClient,
	io,
	out,
	path,
	chunkBytes: requestedChunkBytes,
	now = Date.now,
	sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	privateFiles = true,
}) {
	const file = await readDumpFile(io, path)
	const statePath = `${path}.import.json`
	const saved = await io.readText(statePath)
	/** @type {{ id: string, chunkBytes: number, chunkStatements?: number, session?: string } | null} */
	const local = saved === null ? null : JSON.parse(saved)
	/** @type {Json} */
	let progress
	let client = baseClient
	if (local !== null) {
		// A started import continues by its id: a token import only with its session (IMPORT_TOKEN no longer applies
		// once it began), an Access import with Access.
		if (local.session !== undefined) {
			out.secret?.(local.session)
			client = baseClient.withSession(local.session)
		}
		progress = (await readProgress(client, local.id, sleep)).progress
		if (progress === null) {
			throw new Error(`import ${local.id} is no longer on the Store; remove ${statePath} to start a new import`)
		}
		out.info(`resuming import ${progress.id} (${progress.state}) after chunk ${progress.lastSeq}`)
	} else {
		const begun = await baseClient.post('/admin/import/begin', { header: file.header })
		progress = begun.progress
		if (typeof begun.session === 'string') {
			out.secret?.(begun.session)
			client = baseClient.withSession(begun.session)
			if (!privateFiles) {
				// Mode 0600 does not keep a file private on Windows; no ACLs are set here.
				out.info(
					`warning: ${statePath} holds the import session and is not private on Windows; import from macOS, Linux or WSL`
				)
			}
		}
		await io.writeTextAtomic(
			statePath,
			JSON.stringify({
				id: progress.id,
				chunkBytes: requestedChunkBytes ?? IMPORT_CHUNK_BYTES,
				chunkStatements: IMPORT_CHUNK_STATEMENTS,
				session: begun.session,
			})
		)
		out.info(
			begun.resumed
				? `resuming import ${progress.id} (${progress.state}) after chunk ${progress.lastSeq}`
				: `import ${progress.id} begun (${file.header.tables.length} tables, ${formatBytes(file.bodyEnd - file.bodyStart)})`
		)
	}
	// Chunk boundaries must be the same as in the earlier run for the digests to match. A state file without
	// chunkStatements comes from a version that split by bytes only.
	const chunks = {
		bytes: local?.chunkBytes ?? requestedChunkBytes ?? IMPORT_CHUNK_BYTES,
		statements: local === null ? IMPORT_CHUNK_STATEMENTS : (local.chunkStatements ?? Infinity),
	}
	if (progress.state === 'resetting') {
		throw new Error(`import ${progress.id} is being reset; finish it with import-reset ${path} --yes`)
	}
	// Before an outcome or a later phase is taken as this file's, the file must be the one the Store received.
	await checkIdentity({ io, path, file, progress, chunks, whole: progress.state !== 'receiving' })

	if (progress.state === 'verified' || progress.state === 'failed') {
		// Decided already (a lost response): report it. A failed import keeps its state file for a reset.
		if (progress.state === 'verified') {
			await io.remove(statePath)
		}
		/** @type {Json} */
		const report = progress.report
		return report
	}
	if (progress.state === 'receiving') {
		await sendChunks({ client, io, out, path, file, progress, chunks, now, sleep })
	}
	await client.post('/admin/import/finish', { id: progress.id, trailer: file.trailer })
	out.info('all chunks applied; verifying')
	for (;;) {
		const result = await client.post('/admin/import/verify', { id: progress.id })
		if (result.done) {
			// The file may have changed while the Store verified: read it again before taking the outcome as its own.
			const current = await readDumpFile(io, path)
			await checkIdentity({ io, path, file: current, progress: result.progress, chunks, whole: true })
			if (result.progress?.state === 'verified') {
				await io.remove(statePath)
			}
			/** @type {Json} */
			const report = result.report
			return report
		}
		out.progress(`verifying: ${result.progress?.state ?? ''}`)
	}
}

/**
 * Checks that the file is the dump the Store's import received: the same header and trailer, and with `whole`, the
 * same chunks (count and chain digest), which binds the body as well.
 * @param {{ io: FileIO, path: string, file: import('./format.js').DumpFile, progress: Json, chunks: ChunkLimits,
 *   whole: boolean }} options
 */
async function checkIdentity({ io, path, file, progress, chunks, whole }) {
	/** @param {string} what */
	const mismatch = (what) =>
		new Error(`import ${progress.id} on the Store does not match this file (${what}); is it the same dump?`)
	if ((await sha256Hex(JSON.stringify(file.header))) !== progress.headerSha256) {
		throw mismatch('header')
	}
	if (progress.trailerSha256 !== null && (await sha256Hex(JSON.stringify(file.trailer))) !== progress.trailerSha256) {
		throw mismatch('trailer')
	}
	if (!whole) {
		return
	}
	let seq = 0
	let digest = ''
	for await (const chunk of statementChunks(io, path, file.bodyStart, file.bodyEnd, chunks.bytes, chunks.statements)) {
		seq++
		digest = await chainDigest(digest, chunk.bytes)
	}
	if (seq !== progress.lastSeq) {
		throw mismatch('chunk count')
	}
	if (digest !== progress.digest) {
		throw mismatch('body')
	}
}

/**
 * Sends the chunks after the Store's last one, checking that the chunks before it match what the Store recorded.
 * @param {{ client: AdminClient, io: FileIO, out: Output, path: string, file: import('./format.js').DumpFile,
 *   progress: Json, chunks: ChunkLimits, now: () => number, sleep: (ms: number) => Promise<void> }} options
 */
async function sendChunks({ client, io, out, path, file, progress, chunks, now, sleep }) {
	const total = file.bodyEnd - file.bodyStart
	const startedAt = now()
	let sent = 0
	let seq = 0
	let digest = ''
	for await (const chunk of statementChunks(io, path, file.bodyStart, file.bodyEnd, chunks.bytes, chunks.statements)) {
		seq++
		const previous = digest
		digest = await chainDigest(previous, chunk.bytes)
		if (seq < progress.lastSeq) {
			continue
		}
		if (seq === progress.lastSeq) {
			if (digest !== progress.digest) {
				throw new Error(
					`the Store's import ${progress.id} does not match this file at chunk ${seq}; reset the Store and import again`
				)
			}
			continue
		}
		await sendChunk({ client, out, id: progress.id, seq, bytes: chunk.bytes, digest, sleep })
		sent += chunk.bytes.byteLength
		const done = chunk.offset + chunk.bytes.byteLength - file.bodyStart
		out.progress(
			`chunk ${seq}: ${formatBytes(done)}/${formatBytes(total)} (${Math.floor((done / Math.max(total, 1)) * 100)}%), ${rate(sent, startedAt, now)}`
		)
	}
	if (seq < progress.lastSeq) {
		throw new Error(`the Store has ${progress.lastSeq} chunks but this file has only ${seq}; reset and import again`)
	}
}

/**
 * @param {{ client: AdminClient, out: Output, id: string, seq: number, bytes: Uint8Array, digest: string,
 *   sleep: (ms: number) => Promise<void> }} options
 */
async function sendChunk({ client, out, id, seq, bytes, digest, sleep }) {
	for (let attempt = 0; ; attempt++) {
		try {
			const result = await client.postBytes('/admin/import/chunk', bytes, { id, seq: String(seq) })
			if (result.duplicate && result.progress.lastSeq === seq && result.progress.digest !== digest) {
				throw new Error(`chunk ${seq} was applied with different content; reset the Store and import again`)
			}
			return
		} catch (error) {
			if (!(error instanceof AdminError)) {
				throw error
			}
			// The error is no proof that nothing was written: ask the Store what it has.
			const { progress } = await readProgress(client, id, sleep)
			if (progress === null || progress.id !== id) {
				throw new Error(`the import disappeared from the Store (${error.message})`)
			}
			if (progress.lastSeq >= seq) {
				if (progress.lastSeq === seq && progress.digest !== digest) {
					throw new Error(`chunk ${seq} is recorded with a different digest; reset the Store and import again`)
				}
				out.info(`chunk ${seq} was applied despite the error (${error.message})`)
				return
			}
			const retryable = error.transient && error.code !== 'invalid-chunk' && progress.lastSeq === seq - 1
			if (!retryable || attempt >= RETRIES) {
				throw error
			}
			out.info(`retrying chunk ${seq} after: ${error.message}`)
			await backoff(attempt, sleep)
		}
	}
}

/**
 * @param {AdminClient} client
 * @param {string} id
 * @param {(ms: number) => Promise<void>} sleep
 * @returns {Promise<Json>}
 */
async function readProgress(client, id, sleep) {
	for (let attempt = 0; ; attempt++) {
		try {
			return await client.get('/admin/import/progress', { id })
		} catch (error) {
			if (!(error instanceof AdminError) || !error.transient || attempt >= RETRIES) {
				throw error
			}
			await backoff(attempt, sleep)
		}
	}
}

const RUN_ID = '\\d{4}-\\d{2}-\\d{2}-[0-9a-f]{8}'
const ATTEMPT_ID = '[0-9a-f]{16}'
const SOURCE = /^originals\/\d{18}$/

/** @param {string} text */
function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

class VerifyError extends Error {}

/**
 * Checks decrypted backup files against their decrypted manifest (docs/backup.md), in order, and stops at the first
 * mismatch: the dump (and the encrypted dump), then the media index, then each original the index marks copied,
 * decrypted under mediaDir at its key (<dir>/originals/<id>). Every index entry is validated before any is used: its
 * source must be exactly originals/<18-digit id>, and a copied entry's object must be named under the media/ prefix of
 * the run that copied it. `problem` is the first mismatch; `missing` lists the originals the dump references that the
 * backup does not hold, so coverage is incomplete.
 * @param {{ io: FileIO, manifestPath: string, dumpPath?: string, encryptedPath?: string, indexPath?: string,
 *   mediaDir?: string }} options
 */
export async function verifyBackup({ io, manifestPath, dumpPath, encryptedPath, indexPath, mediaDir }) {
	/** @type {any} */
	const manifest = await readJson(io, manifestPath)
	if (manifest?.format !== 'kopje-backup' || manifest.version !== 1 || typeof manifest.id !== 'string') {
		throw new Error(`${manifestPath} is not a version 1 Kopje backup manifest`)
	}
	/** @type {{ source: string, state: string }[]} */
	const missing = []
	/**
	 * @param {string} label
	 * @param {string} path
	 * @param {{ size: number, sha256: string }} expected
	 */
	const check = async (label, path, expected) => {
		const size = await io.size(path)
		if (size === null) {
			throw new VerifyError(`${label}: ${path} does not exist`)
		}
		if (size !== expected.size) {
			throw new VerifyError(`${label}: ${path} has ${size} bytes, the manifest says ${expected.size}`)
		}
		if ((await io.sha256(path)) !== expected.sha256) {
			throw new VerifyError(`${label}: ${path} does not match the manifest's SHA-256`)
		}
	}
	try {
		const base = new RegExp(`^(.*)backups/${escapeRegExp(manifest.id)}/(${ATTEMPT_ID})/dump\\.kopje\\.age$`).exec(
			String(manifest.dump?.key)
		)
		if (base === null || !new RegExp(`^${RUN_ID}$`).test(manifest.id)) {
			throw new VerifyError('manifest: the dump key is not a key this backup writes')
		}
		const prefix = base[1] ?? ''
		if (dumpPath !== undefined) {
			await check('dump', dumpPath, manifest.dump.plaintext)
		}
		if (encryptedPath !== undefined) {
			await check('encrypted dump', encryptedPath, manifest.dump)
		}
		if (indexPath !== undefined) {
			await check('media index', indexPath, manifest.mediaIndex.plaintext)
			/** @type {any} */
			const index = await readJson(io, indexPath)
			if (index?.format !== 'kopje-backup-media-index' || index.run !== manifest.id || !Array.isArray(index.objects)) {
				throw new VerifyError(`media index: ${indexPath} is not the index of backup ${manifest.id}`)
			}
			/** @type {{ source: string, plaintext: { size: number, sha256: string } }[]} */
			const copied = []
			for (const entry of index.objects) {
				const source = entry?.source
				if (typeof source !== 'string' || !SOURCE.test(source)) {
					throw new VerifyError('media index: an entry names something other than originals/<18-digit id>')
				}
				if (entry.state === 'copied') {
					const key = new RegExp(
						`^${escapeRegExp(prefix)}media/(${RUN_ID})/${ATTEMPT_ID}/${escapeRegExp(source)}\\.age$`
					).exec(String(entry.key))
					if (key === null || key[1] !== entry.run) {
						throw new VerifyError(`media index: the object of ${source} is not under its run's media/ prefix`)
					}
					copied.push({ source, plaintext: entry.plaintext })
				} else if (entry.state === 'pending' || entry.state === 'absent') {
					missing.push({ source, state: entry.state })
				} else {
					throw new VerifyError(`media index: ${source} has an unknown state`)
				}
			}
			if (mediaDir !== undefined) {
				for (const { source, plaintext } of copied) {
					await check('media', `${mediaDir.replace(/\/+$/, '')}/${source}`, plaintext)
				}
			}
		}
	} catch (error) {
		if (error instanceof VerifyError) {
			return { manifest, problem: error.message, missing }
		}
		throw error
	}
	return { manifest, problem: null, missing }
}

/**
 * @param {FileIO} io
 * @param {string} path
 * @returns {Promise<unknown>}
 */
async function readJson(io, path) {
	const text = await io.readText(path)
	if (text === null) {
		throw new Error(`${path} does not exist`)
	}
	/** @type {unknown} */
	let value
	try {
		value = JSON.parse(text)
	} catch {
		throw new Error(`${path} is not JSON; decrypt it first with age -d`)
	}
	return value
}
