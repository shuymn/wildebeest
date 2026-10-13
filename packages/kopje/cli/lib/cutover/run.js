// `kopje-admin convert` and `kopje-admin verify-conversion`: the cutover from a legacy Wildebeest export, offline.
// Everything runs on the operator's machine. The outputs that hold data (the dump) are written with mode 0600; what the
// commands print and the manifest hold only counts, digests and table-level summaries (docs/cutover.md).

import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { convertLegacy } from './convert.js'
import { checkKeks } from './kek.js'
import { createKopjeDatabase, migrationRecords, readCatalog, sha256Hex, writeDump } from './kopje-db.js'
import { LegacyLoadError, loadLegacyExport } from './legacy-load.js'
import { actualFromDump, compareConversion } from './verify-actual.js'
import { expectedFromLegacy } from './verify-expect.js'

export const CONVERTER_VERSION = '1'

export function packageVersion() {
	return String(JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version)
}
export const DUMP_FILE = 'kopje.dump'
export const MANIFEST_FILE = 'manifest.json'

/**
 * The export's SQL texts: every *.sql file of a directory in name order, or one file.
 * @param {string} path
 * @returns {Generator<string>}
 */
function* exportTexts(path) {
	if (statSync(path).isDirectory()) {
		for (const name of readdirSync(path)
			.filter((f) => f.endsWith('.sql'))
			.sort()) {
			yield readFileSync(join(path, name), 'utf8')
		}
	} else {
		yield readFileSync(path, 'utf8')
	}
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
 * @typedef {{ exportPath: string, acceptDeletions: boolean, baseTime: number, env: Record<string, string | undefined> }} SourceOptions
 */

/**
 * Loads and bridges the export, reporting refusals as a result rather than an exception.
 * @param {SourceOptions} options
 */
function load({ exportPath, acceptDeletions }) {
	try {
		return { ok: /** @type {const} */ (true), ...loadLegacyExport({ texts: exportTexts(exportPath), acceptDeletions }) }
	} catch (error) {
		if (error instanceof LegacyLoadError) {
			return { ok: /** @type {const} */ (false), code: error.code, message: error.message, detail: error.detail }
		}
		throw error
	}
}

/**
 * @param {SourceOptions & { outDir: string, catalogPath?: string, domain?: string, version: string }} options
 * @returns {Promise<{ ok: boolean, manifest: Record<string, unknown> }>}
 */
export async function convertExport(options) {
	const { outDir, baseTime, env, acceptDeletions, catalogPath, version } = options
	mkdirSync(outDir, { recursive: true, mode: 0o700 })
	const manifest = /** @type {Record<string, any>} */ ({
		tool: { command: 'kopje-admin convert', converter: CONVERTER_VERSION, version },
		baseTime: new Date(baseTime).toISOString(),
	})
	const write = () =>
		writeFileSync(join(outDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })

	const loaded = load(options)
	if (!loaded.ok) {
		manifest.result = 'stopped'
		manifest.stop = { code: loaded.code, message: loaded.message, detail: loaded.detail }
		write()
		return { ok: false, manifest }
	}
	const { db: legacy, report, originalActorIds } = loaded
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
	const stops = []
	if (total(summary.problems) > 0) {
		stops.push('the conversion found rows it cannot carry over (conversion.problems)')
	}
	if (total(summary.dropped) > 0 && !acceptDeletions) {
		stops.push('rows reference accounts or statuses that do not exist (conversion.dropped); pass --accept-deletions')
	}
	if (!kek.uniform) {
		stops.push('no single KEK candidate unwraps every local key (kek.users)')
	}
	if (stops.length > 0) {
		manifest.result = 'stopped'
		manifest.stop = { code: 'conversion-refused', reasons: stops }
		write()
		kopje.close()
		return { ok: false, manifest }
	}

	let catalog = readCatalog(kopje)
	const migrations = migrationRecords()
	if (catalogPath !== undefined) {
		const target = JSON.parse(readFileSync(catalogPath, 'utf8'))
		if (JSON.stringify(target.migrations) !== JSON.stringify(migrations)) {
			kopje.close()
			throw new Error("the target's migrations differ from this CLI's; use the kopje-admin of the target's version")
		}
		catalog = target.tables
	}
	const path = join(outDir, DUMP_FILE)
	const trailer = writeDump(kopje, {
		path,
		catalog,
		migrations,
		createdAt: new Date(baseTime).toISOString(),
		source: { build: 'kopje-admin convert', version },
	})
	kopje.close()
	manifest.tables = trailer.tables
	manifest.dump = { file: DUMP_FILE, sha256: sha256Hex(readFileSync(path)), body: trailer.body }
	manifest.result = 'converted'
	write()
	return { ok: true, manifest }
}

/**
 * Checks a Kopje dump (the converted one, or a dump of the Store after import) against expectations computed
 * independently from the legacy export.
 * @param {SourceOptions & { dumpPath: string }} options
 * @returns {Promise<{ ok: boolean, report: Record<string, unknown> }>}
 */
export async function verifyConversion(options) {
	const loaded = load(options)
	if (!loaded.ok) {
		return { ok: false, report: { result: 'FAIL', stop: { code: loaded.code, message: loaded.message } } }
	}
	const expected = expectedFromLegacy(loaded.db, { originalActorIds: loaded.originalActorIds })
	loaded.db.close()
	const actual = actualFromDump(readFileSync(options.dumpPath, 'utf8'))
	const report = await compareConversion(expected, actual)
	return { ok: report.result === 'PASS', report }
}
