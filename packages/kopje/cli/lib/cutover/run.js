// `kopje-admin convert` and `kopje-admin verify-conversion`: the cutover from a legacy Wildebeest export, offline.
// Everything runs on the operator's machine. The outputs that hold data (the dump) are created exclusively with mode
// 0600 and published atomically; what the commands print and the manifest hold only counts, fixed codes and digests
// (docs/cutover.md, DATA-13).

import { createHash, randomBytes } from 'node:crypto'
import {
	closeSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeSync,
} from 'node:fs'
import { join } from 'node:path'

import { convertLegacy } from './convert.js'
import { checkKeks } from './kek.js'
import { createKopjeDatabase, migrationRecords, readCatalog, sha256Hex, writeDump } from './kopje-db.js'
import { loadLegacyExport } from './legacy-load.js'
import { ExportError } from './sql-script.js'
import { actualFromDump, compareConversion } from './verify-actual.js'
import { expectedFromLegacy } from './verify-expect.js'

export const CONVERTER_VERSION = '2'
export const DUMP_FILE = 'kopje.dump'
export const MANIFEST_FILE = 'manifest.json'

// Preflight limits. A V8 string holds at most 2^29 - 24 UTF-16 units, so one export file (or the dump verify reads)
// must stay under 512 MiB. The whole export is capped at 1 GiB: the converter reads one file at a time but keeps the
// legacy and the Kopje database in memory, about three times the export at peak, which stays within a workstation's
// memory. Exports larger than that are well past the size a single-user or small legacy instance reaches.
export const MAX_FILE_BYTES = 512 * 1024 * 1024 - 1
export const MAX_EXPORT_BYTES = 1024 * 1024 * 1024

// What a stop code means, for the manifest. Messages are fixed text; details are counts, levels and digests.
const MESSAGES = /** @type {Record<string, string>} */ ({
	'deletions-not-accepted': 'bridging removes rows; review source.deletions and pass --accept-deletions to continue',
	'conversion-refused': 'the conversion found rows it cannot carry over; see the reasons',
	'unsupported-level': 'the export is at a migration level the converter does not support',
	'unknown-migrations': 'd1_migrations is not a prefix of the canonical legacy migrations',
	'schema-mismatch': 'the export schema differs from the canonical schema at its level',
	'null-in-not-null-column':
		'a column that is nullable in the export only holds NULL, which the canonical schema refuses',
	'export-too-large': 'the export exceeds the size limits (docs/cutover.md)',
})

export function packageVersion() {
	return String(JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version)
}

/** @param {string} path */
export function exportFiles(path) {
	if (statSync(path).isDirectory()) {
		return readdirSync(path)
			.filter((f) => f.endsWith('.sql'))
			.sort()
			.map((f) => join(path, f))
	}
	return [path]
}

/** @param {string[]} files */
export function checkSizes(files) {
	let total = 0
	for (const file of files) {
		const size = statSync(file).size
		total += size
		if (size > MAX_FILE_BYTES || total > MAX_EXPORT_BYTES) {
			throw new ExportError('export-too-large', { files: files.length })
		}
	}
	return total
}

/** @param {string} text */
function digest(text) {
	return createHash('sha256').update(text).digest('hex')
}

/** @param {Record<string, number>} bag */
function total(bag) {
	return Object.values(bag).reduce((a, b) => a + b, 0)
}

/**
 * @param {unknown} value
 * @returns {number}
 */
export function parseBaseTime(value) {
	const ms = typeof value === 'string' ? Date.parse(value) : NaN
	if (Number.isNaN(ms) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/.test(String(value))) {
		throw new Error('--base-time must be an ISO 8601 UTC time such as 2026-10-20T00:00:00Z')
	}
	return ms
}

/**
 * The output directory: an existing directory that is not a symbolic link, or a new one (mode 0700), holding neither
 * output yet.
 * @param {string} outDir
 */
function prepareOutput(outDir) {
	let info = null
	try {
		info = lstatSync(outDir)
	} catch {
		mkdirSync(outDir, { recursive: true, mode: 0o700 })
		info = lstatSync(outDir)
	}
	if (info.isSymbolicLink() || !info.isDirectory()) {
		throw new ExportError('output-not-a-directory')
	}
	for (const name of [DUMP_FILE, MANIFEST_FILE]) {
		let exists = true
		try {
			lstatSync(join(outDir, name))
		} catch {
			exists = false
		}
		if (exists) {
			throw new ExportError('output-exists')
		}
	}
}

/**
 * Writes a file under a fresh temporary name (created exclusively, so no existing file or link is followed, mode
 * 0600), then publishes it under its name with link(2), which refuses an existing name, and removes the temporary name.
 * @param {string} outDir
 * @param {string} name
 * @param {(path: string) => void} write writes the whole file to the path it gets, creating it exclusively
 */
function publish(outDir, name, write) {
	const temporary = join(outDir, `.${name}.${randomBytes(8).toString('hex')}.tmp`)
	try {
		write(temporary)
		linkSync(temporary, join(outDir, name))
	} catch (error) {
		if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EEXIST') {
			throw new ExportError('output-exists')
		}
		throw error
	} finally {
		try {
			unlinkSync(temporary)
		} catch {
			// already gone
		}
	}
}

/**
 * @param {string} path
 * @param {string} text
 */
function writeExclusive(path, text) {
	const fd = openSync(path, 'wx', 0o600)
	try {
		writeSync(fd, text)
		fsyncSync(fd)
	} finally {
		closeSync(fd)
	}
}

/**
 * @typedef {{ exportPath: string, acceptDeletions: boolean, acceptTruncation?: boolean, baseTime: number,
 *   env: Record<string, string | undefined> }} SourceOptions
 */

/** @param {unknown} error */
function stopOf(error) {
	if (error instanceof ExportError) {
		return { code: error.code, message: MESSAGES[error.code] ?? error.code, detail: error.detail }
	}
	// Database and parser errors can quote data; only their class is reported.
	return {
		code: 'failed',
		message: 'the conversion failed',
		detail: { error: error instanceof Error ? error.name : 'unknown' },
	}
}

/**
 * @param {SourceOptions & { outDir: string, catalogPath?: string, domain?: string, version: string }} options
 * @returns {Promise<{ ok: boolean, manifest: Record<string, unknown> }>}
 */
export async function convertExport(options) {
	const { outDir, baseTime, env, acceptDeletions, acceptTruncation = false, catalogPath, version } = options
	prepareOutput(outDir)
	const manifest = /** @type {Record<string, any>} */ ({
		tool: { command: 'kopje-admin convert', converter: CONVERTER_VERSION, version },
		baseTime: new Date(baseTime).toISOString(),
	})
	const publishManifest = () =>
		publish(outDir, MANIFEST_FILE, (path) => writeExclusive(path, `${JSON.stringify(manifest, null, 2)}\n`))
	try {
		const files = exportFiles(options.exportPath)
		manifest.exportBytes = checkSizes(files)
		const {
			db: legacy,
			report,
			originalActorIds,
			source,
		} = loadLegacyExport({
			texts: files.map((file) => () => readFileSync(file, 'utf8')),
			acceptDeletions,
			baseTime,
		})
		manifest.source = report

		const users = /** @type {any[]} */ (
			legacy.prepare('SELECT actor_id, privkey, privkey_salt, pubkey FROM users ORDER BY rowid').all()
		).map((u) => ({ uri: String(u.actor_id), privkey: u.privkey, salt: u.privkey_salt, pubkey: String(u.pubkey) }))
		const kek = await checkKeks(users, env)
		manifest.kek = kek

		const kopje = createKopjeDatabase()
		const summary = convertLegacy(legacy, kopje, {
			baseTime,
			originalActorIds,
			notificationSequence: report.notificationSequence,
			source,
			acceptTruncation,
			domain: options.domain,
		})
		legacy.close()
		manifest.conversion = {
			domainSha256: digest(summary.domain),
			localAccounts: summary.localAccounts,
			problems: summary.problems,
			dropped: summary.dropped,
			normalized: summary.normalized,
			legacyIds: summary.legacy,
		}
		/** @type {string[]} */
		const reasons = []
		if (total(summary.problems) > 0) {
			reasons.push('conversion.problems')
		}
		if (total(summary.dropped) > 0 && !acceptDeletions) {
			reasons.push('conversion.dropped (pass --accept-deletions)')
		}
		if (!kek.uniform) {
			reasons.push('kek.users')
		}
		if (reasons.length > 0) {
			kopje.close()
			throw new ExportError('conversion-refused', { reasons })
		}

		let catalog = readCatalog(kopje)
		const migrations = migrationRecords()
		if (catalogPath !== undefined) {
			const target = JSON.parse(readFileSync(catalogPath, 'utf8'))
			if (JSON.stringify(target.migrations) !== JSON.stringify(migrations)) {
				kopje.close()
				throw new ExportError('catalog-migrations-differ')
			}
			catalog = target.tables
		}
		/** @type {{ current: ReturnType<typeof writeDump> | null }} */
		const trailer = { current: null }
		publish(outDir, DUMP_FILE, (path) => {
			trailer.current = writeDump(kopje, {
				path,
				catalog,
				migrations,
				createdAt: new Date(baseTime).toISOString(),
				source: { build: 'kopje-admin convert', version },
			})
		})
		kopje.close()
		const written = /** @type {ReturnType<typeof writeDump>} */ (trailer.current)
		manifest.tables = written.tables
		manifest.dump = { file: DUMP_FILE, sha256: sha256Hex(readFileSync(join(outDir, DUMP_FILE))), body: written.body }
		manifest.result = 'converted'
		publishManifest()
		return { ok: true, manifest }
	} catch (error) {
		if (error instanceof ExportError && error.code === 'output-exists') {
			throw error
		}
		manifest.result = 'stopped'
		manifest.stop = stopOf(error)
		publishManifest()
		return { ok: false, manifest }
	}
}

/**
 * Checks a Kopje dump (the converted one, or a dump of the Store after the import) against expectations computed
 * independently from the legacy export.
 * @param {SourceOptions & { dumpPath: string }} options
 * @returns {Promise<{ ok: boolean, report: Record<string, unknown> }>}
 */
export async function verifyConversion(options) {
	try {
		const files = exportFiles(options.exportPath)
		checkSizes(files)
		checkSizes([options.dumpPath])
		const {
			db,
			report: source,
			originalActorIds,
			source: addressing,
		} = loadLegacyExport({
			texts: files.map((file) => () => readFileSync(file, 'utf8')),
			acceptDeletions: options.acceptDeletions,
		})
		const { records, overLimit } = expectedFromLegacy(db, {
			originalActorIds,
			source: addressing,
			notificationSequence: source.notificationSequence,
		})
		db.close()
		const actual = actualFromDump(readFileSync(options.dumpPath, 'utf8'))
		const report = /** @type {Record<string, unknown> & { result: string }} */ (
			await compareConversion(records, actual)
		)
		report.truncation = { overLimit, accepted: options.acceptTruncation === true }
		if (overLimit > 0 && options.acceptTruncation !== true) {
			report.result = 'FAIL'
		}
		return { ok: report.result === 'PASS', report }
	} catch (error) {
		return { ok: false, report: { result: 'FAIL', stop: stopOf(error) } }
	}
}
