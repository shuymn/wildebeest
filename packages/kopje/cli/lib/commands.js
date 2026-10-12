/* global setTimeout */
import { AdminError } from './client.js'
import { chainDigest, readDumpFile, statementChunks, utf8 } from './format.js'

/**
 * @typedef {import('./client.js').AdminClient} AdminClient
 * @typedef {import('./client.js').Json} Json
 * @typedef {import('./format.js').FileIO} FileIO
 * @typedef {{ progress(text: string): void, info(text: string): void }} Output
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
 * Dumps the Store into a local file. Resumable: the cursor and the file length after the last complete chunk are
 * kept in <file>.state.json, so a rerun truncates any partial write and continues from that cursor.
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
	if (restart) {
		// Release the freeze of the dump being discarded first; its cursor is lost once the state file is gone.
		const previous = await io.readText(statePath)
		if (previous !== null) {
			const { cursor, trailerText } = JSON.parse(previous)
			if (trailerText === undefined) {
				try {
					await client.post('/admin/dump/finish', { cursor, abort: true })
					out.info(`aborted dump ${cursor.dump}`)
				} catch (error) {
					// Already gone or finished: nothing holds the lease. Anything else keeps the local state.
					if (!(error instanceof AdminError && (error.code === 'dump-not-found' || error.code === 'dump-finished'))) {
						throw error
					}
				}
			}
		}
		await io.remove(statePath)
		await io.remove(path)
	}
	const saved = await io.readText(statePath)
	/** @type {{ cursor: any, offset: number, trailerText?: string, tables: number }} */
	let state
	if (saved === null) {
		if ((await io.size(path)) !== null) {
			throw new Error(`${path} already exists; choose another file or pass --restart`)
		}
		const started = await client.post('/admin/dump/start', leaseSeconds === undefined ? {} : { leaseSeconds })
		const header = utf8.encode(started.headerLine)
		await io.append(path, header)
		state = { cursor: started.cursor, offset: header.byteLength, tables: started.header.tables.length }
		await io.writeTextAtomic(statePath, JSON.stringify(state))
		out.info(`dump ${started.cursor.dump} started (${state.tables} tables)`)
	} else {
		state = JSON.parse(saved)
		// Anything after the recorded offset is a partial write of a chunk that is fetched again.
		await io.truncate(path, state.offset)
		out.info(`resuming dump ${state.cursor.dump} at ${formatBytes(state.offset)}`)
	}

	const startedAt = now()
	const startOffset = state.offset
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
		state = { ...state, cursor: step.meta.cursor, offset: state.offset + step.chunk.byteLength }
		await io.writeTextAtomic(statePath, JSON.stringify(state))
		const where = state.cursor.phase === 'rows' ? `table ${state.cursor.table + 1}/${state.tables}` : state.cursor.phase
		out.progress(`${formatBytes(state.offset)} written, ${where}, ${rate(state.offset - startOffset, startedAt, now)}`)
	}

	if (state.trailerText === undefined) {
		const finished = await client.post('/admin/dump/finish', { cursor: state.cursor })
		state = { ...state, trailerText: finished.trailerText }
		await io.writeTextAtomic(statePath, JSON.stringify(state))
	}
	await io.truncate(path, state.offset)
	await io.append(path, utf8.encode(state.trailerText ?? ''))
	await io.remove(statePath)
	/** @type {Json} */
	const trailer = JSON.parse((state.trailerText ?? '').split('\n')[0]?.replace(/^-- kopje-dump-trailer /, '') ?? '{}')
	out.info(
		`dump complete: ${trailer.body.statements} statements, ${formatBytes(state.offset)} of statements and header`
	)
	return trailer
}

/**
 * Imports a dump file into an empty Store and verifies it. Resumable: the Store records the last applied chunk and a
 * chain digest; a rerun re-splits the file with the same chunk size, checks the digest up to that chunk, and
 * continues. After any failed chunk the progress is read back instead of assuming the chunk was rolled back.
 * @param {{ client: AdminClient, io: FileIO, out: Output, path: string, chunkBytes?: number,
 *   now?: () => number, sleep?: (ms: number) => Promise<void> }} options
 */
export async function importFromFile({
	client,
	io,
	out,
	path,
	chunkBytes: requestedChunkBytes,
	now = Date.now,
	sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
	const file = await readDumpFile(io, path)
	const statePath = `${path}.import.json`
	const begun = await client.post('/admin/import/begin', { header: file.header })
	const progress = begun.progress
	const saved = await io.readText(statePath)
	const local = saved === null ? null : JSON.parse(saved)
	// Chunk boundaries must be the same as in the earlier run for the digests to match.
	const chunkBytes = local !== null && local.id === progress.id ? local.chunkBytes : (requestedChunkBytes ?? 8 * MIB)
	await io.writeTextAtomic(statePath, JSON.stringify({ id: progress.id, chunkBytes }))
	out.info(
		begun.resumed
			? `resuming import ${progress.id} after chunk ${progress.lastSeq}`
			: `import ${progress.id} begun (${file.header.tables.length} tables, ${formatBytes(file.bodyEnd - file.bodyStart)})`
	)

	const total = file.bodyEnd - file.bodyStart
	const startedAt = now()
	let sent = 0
	let seq = 0
	let digest = ''
	for await (const chunk of statementChunks(io, path, file.bodyStart, file.bodyEnd, chunkBytes)) {
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

	await client.post('/admin/import/finish', { id: progress.id, trailer: file.trailer })
	out.info('all chunks applied; verifying')
	for (;;) {
		const result = await client.post('/admin/import/verify', { id: progress.id })
		if (result.done) {
			await io.remove(statePath)
			/** @type {Json} */
			const report = result.report
			return report
		}
		out.progress(`verifying: ${result.progress?.state ?? ''}`)
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
			const { progress } = await readProgress(client, sleep)
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
 * @param {(ms: number) => Promise<void>} sleep
 * @returns {Promise<Json>}
 */
async function readProgress(client, sleep) {
	for (let attempt = 0; ; attempt++) {
		try {
			return await client.get('/admin/import/progress')
		} catch (error) {
			if (!(error instanceof AdminError) || !error.transient || attempt >= RETRIES) {
				throw error
			}
			await backoff(attempt, sleep)
		}
	}
}
