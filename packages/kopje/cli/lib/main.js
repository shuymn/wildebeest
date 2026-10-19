/* global globalThis */
import { AdminError, createClient } from './client.js'
import { dumpToFile, formatBytes, importFromFile, verifyBackup } from './commands.js'

export const USAGE = `Usage: kopje-admin <command> [options]

Commands
  health                        detailed health report
  version                       Worker build and Store schema version
  capacity                      database size and rows per table
  spool                         spooled inbox parts waiting for replay
  deliveries [--before <id>]    delivery backlog and the deliveries that gave up, newest first
  deliveries retry <id>...|--all
                                put given-up deliveries back in their lanes with fresh attempts
  moderation-log [--before <id>]
                                the moderation log, newest first: every admin write through the Mastodon admin API
                                and every account repair below, with who made it
  account set-email <username> <email>
                                set a local account's email (it signs in with it through Access). Refused when another
                                local account's email is the same after trimming and lowercasing. Repairs the Mastodon
                                admin API's admin, the one local account whose email matches admin_email (health shows
                                oauthAdmin); logged in the moderation log
  account unsuspend <username>  unsuspend a local account as the Mastodon admin API does (its old tokens stay refused,
                                so it signs in again). Recovers a suspended admin, whom no admin can unsuspend; logged
                                in the moderation log
  maintenance on|off            enter or leave the Store's readonly maintenance
  upgrade retry                 re-run a failed schema upgrade for the current build
  media-rebuild [--dry-run]     make the served files of local media whose files are missing (a restore, the
                                cutover's moved images) from their originals in R2, and correct their sizes. Writes only
                                before publish, or 20 minutes after "maintenance on" (the env MAINTENANCE is not
                                enough), one call at a time. Prints counts and the rows to look at; exits 3 when an original is
                                missing, a type does not match, re-encoding failed, the Images quota or monthly budget
                                stopped it, or the Store is not readonly (run it again later: made files are skipped)
  keys rewrap                   move every local private key from USER_KEK_PREVIOUS (unset: the empty KEK) to
                                USER_KEK, the same keys under a new wrapping (docs/setup.md, "Rotating the KEK").
                                Resumable: keys already under USER_KEK are skipped. Prints counts and the keys it could
                                not move; exits 3 when any failed
  dump <file>                   dump the Store to <file> (resumable)
      --chunk-mib <n>           chunk size in MiB, 0.001-16 (default 16)
      --lease-seconds <n>       freeze lease, renewed by every chunk (default 600)
      --restart                 discard <file> and its saved cursor and start over
  import <file>                 import <file> into an empty Store and verify (resumable)
      --chunk-mib <n>           chunk size in MiB, 0.001-4 (default 4); a chunk also holds at most 2000 statements
      --import-token            begin with KOPJE_IMPORT_TOKEN (cutover into an empty Store without admin access);
                                the import then continues with its own session, kept in <file>.import.json (mode
                                0600). That file must stay private: run token imports on macOS, Linux or WSL, since
                                Windows does not honor the mode (the CLI warns there)
  publish --yes                 end the readonly state a verified import leaves: the Store accepts writes and
                                delivers again (no cutover reset afterwards). With --import-token while the Store has
                                no admin access
  import-reset [<file>] --yes   take the Store back to before an import (its imported rows are deleted; schema and
                                configuration stay); the import is the one saved for <file>, or else the running one,
                                and a token import is reset with the session kept for <file>. An interrupted
                                reset leaves the Store resetting until this command is run again
      --abandon-stale --import-token
                                recover a token import whose session file was lost: IMPORT_TOKEN resets it once it
                                has been idle for 15 minutes (the error says when) while admin access is not usable
  config                        show the instance values and the Access settings of /admin
  config <name>=<value>|<name>= set (or with an empty value, remove) them; names: domain, access_aud,
                                access_team_domain, access_admin_aud, admin_email, access_service_token_client_id.
                                An import never changes them. With --import-token only while the Store has no
                                usable admin access (bootstrap)
  instance                      show the instance's public settings and the documents' stamps
  instance <name>=<value>|<name>= ...
                                set (or with an empty value, remove) them in one request; names: title,
                                description, contact_email, extended_description, privacy_policy, terms_of_service,
                                terms_of_service_effective_date (YYYY-MM-DD), show_domain_blocks and
                                show_domain_blocks_rationale (disabled, users or all). They are data: set them after a
                                cutover import, which refuses a Store that holds them
  instance <document> --file <path> [<name>=<value> ...]
                                set a document (extended_description, privacy_policy or terms_of_service) to the HTML
                                in <path>, with the other values in the same request, e.g. terms_of_service --file
                                terms.html terms_of_service_effective_date=2026-11-01. Documents are HTML (convert
                                Markdown first), sanitized when served
  catalog                       migrations and tables a dump for this Store must declare
  cutover status                the cutover's publication mark, rollback journal and import state
  cutover drain --worker <dir> [--fallback <username>] [--unordered --yes]
                                rolling back: hand the requests Kopje spooled to the legacy Queue (LEGACY_QUEUE) one at
                                a time, in spool order, each verified first, to a legacy account of the maintenance
                                worker's snapshot in <dir>; waits while Kopje's or the legacy Queue holds messages.
                                Exits 3 when it stops (the legacy DLQ holds messages, metrics cannot be read, a key
                                may verify later) or has run 45 minutes without finishing. --unordered --yes, only after
                                a stop on journal-full, sends the journal's head past the collection barrier (it may
                                then overtake an older request still in Kopje's Queue)
  cutover discard-kept --yes    delete the kept requests (failed verification, or no legacy recipient), after
                                inspecting them with sql
  cutover close --yes           end a rollback once Kopje's Queue is empty: its handoff receipts are removed
  cutover reset --yes           take the Store back to empty after a completed import, keeping the configuration;
                                only before publication, with MAINTENANCE=full and an empty journal
  pitr bookmark [--at <time>]   current bookmark, or the one for an ISO 8601 time
  pitr restore <bookmark> --yes restore the Store to a bookmark (requires MAINTENANCE=full)
  sql <query> [--limit <n>]     run a single read-only SELECT/WITH statement
  backup-verify <manifest.json> [<dump file>]
                                check a decrypted backup against its decrypted manifest (sizes and SHA-256), stopping
                                at the first mismatch; works offline, without KOPJE_ADMIN_URL (docs/backup.md). Exits 1
                                when a file does not match, 3 when all match but the backup lacks originals the dump
                                uses. Give the dump, --index, or both
      --encrypted <file.age>    also check the encrypted dump as downloaded
      --index <file.json>       check the decrypted media index and every entry in it (run this before downloading
                                any media), and report the media coverage
      --media <dir>             with --index: also check every original the index lists, decrypted under <dir> at
                                its key (<dir>/originals/<id>)

Cutover from a legacy Wildebeest instance (offline; docs/cutover.md)
  convert <export> --out <dir> --base-time <time>
                                convert a legacy D1 export (a directory of \`wrangler d1 export --table\` files, or one
                                file of them) into <dir>/kopje.dump for \`import\`, with <dir>/manifest.json. Exits 3
                                when it stops for a decision (see the manifest); prints counts and digests only
      --accept-deletions        carry on although bridging or conversion leaves rows out (their counts are reported)
      --accept-truncation       carry on although HTML longer than the sanitizer's limit loses its end (counted)
      --catalog <file>          the target's \`catalog\` output, instead of this CLI's own schema
      --domain <host>           refuse unless the legacy instance's domain is this one
      --images <dir>            move the images in Cloudflare Images that images-export downloaded to <dir> into local
                                media; their originals are written to <out>/originals/<media id> for R2
      --accept-missing-images   carry on although images missing from <dir> leave references out (counted)
                                The legacy KEK candidates are read from userKEK and USER_KEY in the environment
  verify-conversion <export> <dump file> [--accept-deletions] [--accept-truncation]
                    [--images <dir> [--accept-missing-images]]
                                check a converted dump, or a dump of the Store after the import, against the legacy
                                export (expectations computed independently). Exits 1 on FAIL
  images-export <export> --images-account <hash> --out <dir> [--account-id <id>]
                                download the legacy instance's images from Cloudflare Images (the account hash of its
                                imagedelivery.net URLs) to <dir>/originals with <dir>/images.json, resumable: a rerun
                                (on a later export) downloads only what is not there yet. With --account-id and
                                CF_IMAGES_TOKEN the originals come from the Images API, else from the delivery URLs.
                                Exits 3 when an image is missing
  cutover-preflight <pages-project.json> [--export <export>] [--domain <host>] [--kopje-queue <name>]
                                read the legacy Pages project (as the API returns it, saved to a file) and report its
                                bindings, the D1 to export, the KEK candidates and what Kopje needs; with --export also
                                the migration level and which KEK unwraps every key. Exits 1 when a check fails
  maintenance-worker <export> --domain <host> --out <dir>
                                write <dir>/_worker.js, the maintenance worker that replaces the legacy Pages routes
                                during the cutover: actor documents and WebFinger as Kopje renders them, every inbox
                                POST spooled to Kopje's Queue (binding KOPJE_QUEUE). Exits 3 when it stops
  maintenance-worker-check <export> --domain <host> --worker <dir>
                                check that <dir>/_worker.js still holds what the (newer) export holds: the same local
                                actors, keys and profiles. Exits 1 when it is stale
  fingerprint tables-sql         print the read-only SQL that lists the tables to export (run it with
                                \`wrangler d1 execute <db> --remote --json --command\`)
  fingerprint sequence-sql      print the SQL that reads sqlite_sequence, and
  fingerprint sequence-file <answer.json>
                                turn its answer into sqlite_sequence.sql, for a D1 that does not export it with --table
  fingerprint export <export>   fingerprint an export: per table, the row count and a digest of every row whole (no
                                content is printed). Exits 2 when sqlite_sequence lacks the notification counter
  fingerprint compare <first.json> <second.json> [--manifest <manifest.json>]
                                compare two fingerprints; with the converter's manifest, also its row counts and
                                notification counter. Exits 1 unless everything matches

Environment
  KOPJE_ADMIN_URL               base URL of the instance's admin host, e.g. https://admin.example.com
  CF_ACCESS_CLIENT_ID           Access service token client id      (sent as CF-Access-Client-Id)
  CF_ACCESS_CLIENT_SECRET       Access service token client secret  (sent as CF-Access-Client-Secret)
  KOPJE_IMPORT_TOKEN            the IMPORT_TOKEN secret, used only with --import-token
  CF_IMAGES_TOKEN               an API token that can read Cloudflare Images, used only by images-export --account-id
`

/**
 * @typedef {{ write(text: string): void, isTTY?: boolean }} Stream
 * @typedef {{ argv: string[], env: Record<string, string | undefined>, io: import('./format.js').FileIO,
 *   stdout: Stream, stderr: Stream, fetch?: import('./client.js').Fetch, now?: () => number,
 *   sleep?: (ms: number) => Promise<void>, platform?: string }} RunOptions
 */

/**
 * @param {string[]} argv
 * @returns {{ positional: string[], flags: Record<string, string | true> }}
 */
function parseArgs(argv) {
	/** @type {string[]} */
	const positional = []
	/** @type {Record<string, string | true>} */
	const flags = {}
	const valued = new Set([
		'chunk-mib',
		'lease-seconds',
		'at',
		'limit',
		'before',
		'encrypted',
		'index',
		'media',
		'out',
		'base-time',
		'catalog',
		'domain',
		'export',
		'kopje-queue',
		'manifest',
		'fallback',
		'worker',
		'images',
		'images-account',
		'account-id',
		'file',
	])
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? ''
		if (arg.startsWith('--')) {
			const name = arg.slice(2)
			if (valued.has(name)) {
				const value = argv[++i]
				if (value === undefined) {
					throw new UsageError(`--${name} needs a value`)
				}
				flags[name] = value
			} else {
				flags[name] = true
			}
		} else {
			positional.push(arg)
		}
	}
	return { positional, flags }
}

class UsageError extends Error {}

/**
 * convert and verify-conversion: offline, without KOPJE_ADMIN_URL. The cutover modules load node:sqlite, so they are
 * imported only here.
 * @param {string} command
 * @param {string[]} rest
 * @param {Record<string, string | true>} flags
 * @param {{ env: Record<string, string | undefined>, print: (value: unknown) => void, info: (text: string) => void }} io
 */
async function cutover(command, rest, flags, { env, print, info }) {
	const { convertExport, packageVersion, parseBaseTime, verifyConversion } = await import('./cutover/run.js')
	const { ExportError } = await import('./cutover/sql-script.js')
	const acceptDeletions = flags['accept-deletions'] === true
	const acceptTruncation = flags['accept-truncation'] === true
	const acceptMissingImages = flags['accept-missing-images'] === true
	const imagesDir = typeof flags.images === 'string' ? flags.images : undefined
	if (acceptMissingImages && imagesDir === undefined) {
		throw new UsageError('--accept-missing-images applies only with --images <dir>')
	}
	if (command === 'convert') {
		const [exportPath] = rest
		const { out, catalog, domain } = flags
		if (
			exportPath === undefined ||
			rest.length > 1 ||
			typeof out !== 'string' ||
			typeof flags['base-time'] !== 'string'
		) {
			throw new UsageError('convert <export> --out <dir> --base-time <time> [--accept-deletions] [--catalog <file>]')
		}
		let baseTime
		try {
			baseTime = parseBaseTime(flags['base-time'])
		} catch (error) {
			throw new UsageError(error instanceof Error ? error.message : String(error))
		}
		let result
		try {
			result = await convertExport({
				exportPath,
				outDir: out,
				acceptDeletions,
				acceptTruncation,
				baseTime,
				catalogPath: typeof catalog === 'string' ? catalog : undefined,
				domain: typeof domain === 'string' ? domain : undefined,
				env,
				version: packageVersion(),
				imagesDir,
				acceptMissingImages,
			})
		} catch (error) {
			// Only refusals of the output directory get here; they carry a fixed code.
			info(`convert refused: ${error instanceof ExportError ? error.code : 'failed'}`)
			return 3
		}
		const { ok, manifest } = result
		print(manifest)
		info(ok ? `converted; import ${out}/kopje.dump` : 'conversion stopped; see the manifest')
		return ok ? 0 : 3
	}
	const [exportPath, dumpPath] = rest
	if (exportPath === undefined || dumpPath === undefined || rest.length > 2) {
		throw new UsageError('verify-conversion <export> <dump file> [--accept-deletions]')
	}
	const { ok, report } = await verifyConversion({
		exportPath,
		dumpPath,
		acceptDeletions,
		acceptTruncation,
		baseTime: 0,
		env,
		imagesDir,
		acceptMissingImages,
	})
	print(report)
	info(ok ? 'conversion verified: PASS' : 'conversion check FAILED')
	return ok ? 0 : 1
}

/**
 * images-export: downloads the legacy instance's images from Cloudflare Images (offline but for those downloads).
 * @param {string[]} rest
 * @param {Record<string, string | true>} flags
 * @param {{ env: Record<string, string | undefined>, fetch: import('./client.js').Fetch, print: (value: unknown) => void,
 *   info: (text: string) => void, progress: (text: string) => void }} io
 */
async function imagesExport(rest, flags, { env, fetch, print, info, progress }) {
	const [exportPath] = rest
	const accountHash = flags['images-account']
	const outDir = flags.out
	const accountId = flags['account-id']
	const token = env.CF_IMAGES_TOKEN === '' ? undefined : env.CF_IMAGES_TOKEN
	if (
		exportPath === undefined ||
		rest.length > 1 ||
		typeof accountHash !== 'string' ||
		typeof outDir !== 'string' ||
		accountId === true
	) {
		throw new UsageError('images-export <export> --images-account <hash> --out <dir> [--account-id <id>]')
	}
	if (accountId !== undefined && token === undefined) {
		throw new UsageError('images-export --account-id needs CF_IMAGES_TOKEN in the environment')
	}
	const { exportImages } = await import('./cutover/images-export.js')
	const { ExportError } = await import('./cutover/sql-script.js')
	try {
		const { ok, report } = await exportImages({
			exportPath,
			accountHash,
			outDir,
			accountId,
			token: accountId === undefined ? undefined : token,
			fetch,
			progress,
		})
		print(report)
		info(ok ? `images exported; convert with --images ${outDir}` : 'images exported, some are missing; see the counts')
		return ok ? 0 : 3
	} catch (error) {
		if (error instanceof ExportError) {
			const status = typeof error.detail.status === 'number' ? ` (HTTP ${error.detail.status})` : ''
			info(`images-export refused: ${error.code}${status}`)
			return error.code === 'images-fetch-failed' ? 1 : 3
		}
		throw error
	}
}

/**
 * cutover-preflight, maintenance-worker and fingerprint: offline helpers of the cutover runbook
 * (docs/cutover-runbook.md). They read files only and print configuration, counts and digests.
 * @param {string} command
 * @param {string[]} rest
 * @param {Record<string, string | true>} flags
 * @param {{ env: Record<string, string | undefined>, print: (value: unknown) => void, raw: (text: string) => void,
 *   stdoutRaw: (text: string) => void, info: (text: string) => void }} io
 */
async function cutoverOps(command, rest, flags, { env, print, raw, stdoutRaw, info }) {
	/** @param {string} name */
	const text = (name) => {
		const value = flags[name]
		if (value === true) {
			throw new UsageError(`--${name} needs a value`)
		}
		return value
	}
	if (command === 'cutover-preflight') {
		const [projectPath] = rest
		if (projectPath === undefined || rest.length > 1) {
			throw new UsageError(
				'cutover-preflight <pages-project.json> [--export <export>] [--domain <host>] [--kopje-queue <name>]'
			)
		}
		const { preflight } = await import('./cutover/preflight.js')
		const report = await preflight({
			projectPath,
			exportPath: text('export'),
			domain: text('domain'),
			kopjeQueue: text('kopje-queue'),
			env,
		})
		print(report)
		info(report.ok ? 'preflight: no check failed; do the todo items' : 'preflight: a check FAILED')
		return report.ok ? 0 : 1
	}
	if (command === 'maintenance-worker') {
		const [exportPath] = rest
		const domain = text('domain')
		const outDir = text('out')
		if (exportPath === undefined || rest.length > 1 || domain === undefined || outDir === undefined) {
			throw new UsageError('maintenance-worker <export> --domain <host> --out <dir>')
		}
		const { maintenanceWorker } = await import('./cutover/maintenance.js')
		const { ok, report } = await maintenanceWorker({ exportPath, domain, outDir, env })
		print(report)
		info(ok ? `written: ${outDir}/_worker.js` : 'maintenance worker not written; see stop')
		return ok ? 0 : 3
	}
	if (command === 'maintenance-worker-check') {
		const [exportPath] = rest
		const domain = text('domain')
		const workerDir = text('worker')
		if (exportPath === undefined || rest.length > 1 || domain === undefined || workerDir === undefined) {
			throw new UsageError('maintenance-worker-check <export> --domain <host> --worker <dir>')
		}
		const { checkMaintenanceWorker } = await import('./cutover/maintenance.js')
		const { ok, report } = await checkMaintenanceWorker({ exportPath, domain, workerDir, env })
		print(report)
		info(ok ? 'the maintenance worker is current' : 'the maintenance worker is NOT current; generate it again')
		return ok ? 0 : 1
	}
	const fingerprint = await import('./cutover/fingerprint.js')
	// node:fs only here, as the other cutover modules: the rest of the CLI goes through io.
	const { readFileSync } = await import('node:fs')
	const [sub, ...files] = rest
	/**
	 * @param {string} path
	 * @returns {unknown}
	 */
	const json = (path) => {
		try {
			return /** @type {unknown} */ (JSON.parse(readFileSync(path, 'utf8')))
		} catch {
			throw new UsageError(`${path} cannot be read as JSON`)
		}
	}
	try {
		if (sub === 'tables-sql' && files.length === 0) {
			raw(fingerprint.TABLES_SQL)
			return 0
		}
		if (sub === 'sequence-sql' && files.length === 0) {
			raw(fingerprint.SEQUENCE_SQL)
			return 0
		}
		if (sub === 'sequence-file' && files.length === 1) {
			stdoutRaw(fingerprint.sequenceFile(json(/** @type {string} */ (files[0]))))
			return 0
		}
		if (sub === 'export' && files.length === 1) {
			print(fingerprint.fingerprintExport(/** @type {string} */ (files[0])))
			return 0
		}
		if (sub === 'compare' && files.length === 2) {
			const manifestPath = text('manifest')
			const report = fingerprint.compareFingerprints(
				fingerprint.parseFingerprint(json(/** @type {string} */ (files[0]))),
				fingerprint.parseFingerprint(json(/** @type {string} */ (files[1]))),
				manifestPath === undefined ? undefined : fingerprint.parseManifest(json(manifestPath))
			)
			print(report)
			info(report.result === 'PASS' ? 'fingerprints match: PASS' : 'fingerprints differ: FAIL')
			return report.result === 'PASS' ? 0 : 1
		}
	} catch (error) {
		if (error instanceof fingerprint.FingerprintError || error instanceof fingerprint.ExportError) {
			info(`fingerprint refused: ${error.code}`)
			return 2
		}
		throw error
	}
	throw new UsageError(
		'fingerprint tables-sql | sequence-sql | sequence-file <answer.json> | export <export> | compare <first.json> <second.json> [--manifest <manifest.json>]'
	)
}

/**
 * @param {Record<string, string | true>} flags
 * @param {string} name
 * @param {number} min
 * @param {number} max
 */
function numberFlag(flags, name, min, max) {
	const value = flags[name]
	if (value === undefined) {
		return undefined
	}
	const number = Number(value)
	if (typeof value !== 'string' || !Number.isFinite(number) || number < min || number > max) {
		throw new UsageError(`--${name} must be a number from ${min} to ${max}`)
	}
	return number
}

// Replaces every secret value in a text, as a last line of defense for anything printed. Secrets learned while running
// (an import session) are added to the same list.
/** @param {string[]} secrets */
function redactor(secrets) {
	/** @param {string} text */
	return (text) => secrets.filter((s) => s.length >= 4).reduce((out, secret) => out.split(secret).join('***'), text)
}

/**
 * Runs one CLI command. Returns the process exit code.
 * @param {RunOptions} options
 */
export async function run({
	argv,
	env,
	io,
	stdout,
	stderr,
	fetch,
	now = Date.now,
	sleep,
	platform = globalThis.process?.platform,
}) {
	const secrets = [
		env.CF_ACCESS_CLIENT_SECRET,
		env.KOPJE_IMPORT_TOKEN,
		env.CF_ACCESS_CLIENT_ID,
		env.userKEK,
		env.USER_KEY,
		env.CF_IMAGES_TOKEN,
	].filter(/** @returns {s is string} */ (s) => typeof s === 'string')
	const redact = redactor(secrets)
	/** @param {unknown} value */
	const print = (value) =>
		stdout.write(`${redact(typeof value === 'string' ? value : JSON.stringify(value, null, 2))}\n`)
	let lastProgress = 0
	const out = {
		/** @param {string} text */
		progress(text) {
			if (stderr.isTTY) {
				stderr.write(`\r\x1b[2K${redact(text)}`)
			} else if (now() - lastProgress >= 2000) {
				lastProgress = now()
				stderr.write(`${redact(text)}\n`)
			}
		},
		/** @param {string} text */
		info(text) {
			stderr.write(`${stderr.isTTY ? '\r\x1b[2K' : ''}${redact(text)}\n`)
		},
		/** @param {string} value */
		secret(value) {
			secrets.push(value)
		},
	}

	try {
		const { positional, flags } = parseArgs(argv)
		const [command, ...rest] = positional
		if (command === undefined || command === 'help' || flags.help === true) {
			stdout.write(USAGE)
			return command === undefined && flags.help !== true ? 2 : 0
		}
		if (command === 'backup-verify') {
			const [manifestPath, dumpPath] = rest
			const { encrypted, index, media } = flags
			if (
				manifestPath === undefined ||
				(dumpPath === undefined && index === undefined) ||
				rest.length > 2 ||
				[encrypted, index, media].includes(true) ||
				(media !== undefined && index === undefined)
			) {
				throw new UsageError(
					'backup-verify <manifest.json> [<dump file>] [--encrypted <file.age>] [--index <file.json> [--media <dir>]]'
				)
			}
			const result = await verifyBackup({
				io,
				manifestPath,
				dumpPath,
				encryptedPath: /** @type {string | undefined} */ (encrypted),
				indexPath: /** @type {string | undefined} */ (index),
				mediaDir: /** @type {string | undefined} */ (media),
			})
			if (result.problem !== null) {
				out.info(result.problem)
				return 1
			}
			const { manifest, missing } = result
			print(
				`backup ${manifest.id} matches its manifest (schema ${manifest.schema.version}, Kopje ${manifest.kopje.version})`
			)
			if (missing.length > 0) {
				for (const entry of missing) {
					out.info(`missing: ${entry.source} (${entry.state})`)
				}
				out.info(
					`incomplete: ${missing.length} of ${manifest.media.required} originals the dump references are not in this backup`
				)
				return 3
			}
			return 0
		}
		if (command === 'convert' || command === 'verify-conversion') {
			return await cutover(command, rest, flags, { env, print, info: (text) => out.info(text) })
		}
		if (command === 'images-export') {
			return await imagesExport(rest, flags, {
				env,
				fetch: fetch ?? ((input, init) => globalThis.fetch(input, init)),
				print,
				info: (text) => out.info(text),
				progress: (text) => out.progress(text),
			})
		}
		if (
			command === 'cutover-preflight' ||
			command === 'maintenance-worker' ||
			command === 'maintenance-worker-check' ||
			command === 'fingerprint'
		) {
			return await cutoverOps(command, rest, flags, {
				env,
				print,
				raw: (text) => stdout.write(`${text}\n`),
				stdoutRaw: (text) => stdout.write(text),
				info: (text) => out.info(text),
			})
		}
		const url = env.KOPJE_ADMIN_URL
		if (url === undefined || url === '') {
			throw new UsageError('set KOPJE_ADMIN_URL to the admin base URL')
		}
		const useToken = flags['import-token'] === true
		const tokenCommands = ['import', 'import-reset', 'config', 'health', 'version', 'catalog', 'publish']
		if (useToken && !tokenCommands.includes(command)) {
			throw new UsageError(`--import-token applies only to ${tokenCommands.join(', ')}`)
		}
		if (flags['abandon-stale'] === true && (command !== 'import-reset' || !useToken)) {
			throw new UsageError('--abandon-stale is import-reset --abandon-stale --import-token --yes')
		}
		if (useToken && (env.KOPJE_IMPORT_TOKEN ?? '') === '') {
			throw new UsageError('--import-token needs KOPJE_IMPORT_TOKEN in the environment')
		}
		const client = createClient({
			url,
			fetch,
			credentials: {
				accessClientId: env.CF_ACCESS_CLIENT_ID,
				accessClientSecret: env.CF_ACCESS_CLIENT_SECRET,
				importToken: useToken ? env.KOPJE_IMPORT_TOKEN : undefined,
			},
		})

		switch (command) {
			case 'health': {
				const report = await client.get('/admin/health')
				print(report)
				return report.ok ? 0 : 1
			}
			case 'version':
				print(await client.get('/admin/version'))
				return 0
			case 'capacity': {
				const capacity = await client.get('/admin/capacity')
				print(`database ${formatBytes(capacity.databaseSize)}`)
				for (const table of capacity.tables) {
					print(`${String(table.rows).padStart(12)}  ${table.name}`)
				}
				return 0
			}
			case 'spool':
				print(await client.get('/admin/spool'))
				return 0
			case 'deliveries': {
				if (rest[0] === 'retry') {
					const ids = rest.slice(1)
					const all = flags.all === true
					if (all === ids.length > 0 || !ids.every((id) => /^\d{1,19}$/.test(id))) {
						throw new UsageError('deliveries retry <id>... | deliveries retry --all')
					}
					if (!all) {
						print(await client.post('/admin/deliveries/retry', { ids }))
						return 0
					}
					// Every page of eligible rows, following the cursor.
					const total = { retried: 0, skipped: 0, refused: 0 }
					/** @type {string | null} */
					let after = null
					do {
						const page = await client.post(
							'/admin/deliveries/retry',
							after === null ? { all: true } : { all: true, after }
						)
						total.retried += page.retried
						total.refused += page.refused
						total.skipped = Math.max(total.skipped, page.skipped)
						after = page.more ? page.next : null
					} while (after !== null)
					print(total)
					return 0
				}
				if (rest.length > 0) {
					throw new UsageError('deliveries [--before <id>] | deliveries retry <id>...|--all')
				}
				const before = flags.before
				if (before !== undefined && (typeof before !== 'string' || !/^\d{1,19}$/.test(before))) {
					throw new UsageError('--before takes a delivery id')
				}
				print(await client.get(`/admin/deliveries${before === undefined ? '' : `?before=${before}`}`))
				return 0
			}
			case 'moderation-log': {
				if (rest.length > 0) {
					throw new UsageError('moderation-log [--before <id>]')
				}
				const before = flags.before
				if (before !== undefined && (typeof before !== 'string' || !/^\d{1,19}$/.test(before))) {
					throw new UsageError('--before takes a log entry id')
				}
				print(await client.get(`/admin/moderation-log${before === undefined ? '' : `?before=${before}`}`))
				return 0
			}
			case 'account': {
				const [action, username, email] = rest
				if (action === 'unsuspend' && username !== undefined && rest.length === 2) {
					print(await client.post('/admin/accounts/unsuspend', { username }))
					return 0
				}
				if (action !== 'set-email' || username === undefined || email === undefined || rest.length !== 3) {
					throw new UsageError('account set-email <username> <email> | account unsuspend <username>')
				}
				print(await client.post('/admin/accounts/email', { username, email }))
				return 0
			}
			case 'catalog':
				print(await client.get('/admin/catalog'))
				return 0
			case 'config': {
				if (rest.length === 0) {
					print(await client.get('/admin/config'))
					return 0
				}
				/** @type {Record<string, string | null>} */
				const values = {}
				for (const pair of rest) {
					const at = pair.indexOf('=')
					if (at <= 0) {
						throw new UsageError('config <name>=<value> ...')
					}
					const value = pair.slice(at + 1)
					values[pair.slice(0, at)] = value === '' ? null : value
				}
				print(await client.post('/admin/config', { values }))
				return 0
			}
			case 'instance': {
				const file = flags.file
				if (rest.length === 0 && file === undefined) {
					print(await client.get('/admin/instance'))
					return 0
				}
				/** @type {Record<string, string | null>} */
				const values = {}
				let pairs = rest
				if (file !== undefined) {
					// A document's text and the other values in one request, so a first terms of service carries its date.
					const [document, ...others] = rest
					if (typeof file !== 'string' || document === undefined || document.includes('=')) {
						throw new UsageError('instance <document> --file <path> [<name>=<value> ...]')
					}
					const text = await io.readText(file)
					if (text === null) {
						throw new Error(`cannot read ${file}`)
					}
					values[document] = text
					pairs = others
				}
				for (const pair of pairs) {
					const at = pair.indexOf('=')
					if (at <= 0 || Object.hasOwn(values, pair.slice(0, at))) {
						throw new UsageError('instance <name>=<value> ... (each name once)')
					}
					const value = pair.slice(at + 1)
					values[pair.slice(0, at)] = value === '' ? null : value
				}
				print(await client.post('/admin/instance', { values }))
				return 0
			}
			case 'maintenance': {
				const mode = rest[0]
				if (mode !== 'on' && mode !== 'off') {
					throw new UsageError('maintenance on|off')
				}
				print(await client.post('/admin/maintenance', { on: mode === 'on' }))
				return 0
			}
			case 'upgrade': {
				if (rest[0] !== 'retry') {
					throw new UsageError('upgrade retry')
				}
				print(await client.post('/admin/upgrade/retry'))
				return 0
			}
			case 'media-rebuild': {
				if (rest.length > 0) {
					throw new UsageError('media-rebuild [--dry-run]')
				}
				const dryRun = flags['dry-run'] === true
				const pause =
					sleep ?? ((/** @type {number} */ ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms)))
				/** @type {Record<string, number>} */
				const counts = {}
				/** @type {unknown[]} */
				const problems = []
				/** @type {string | null} */
				let after = null
				/** @type {string | null} */
				let stopped = null
				// Another call holds the rebuild lease (or one of ours gave up a step and kept it): wait for it, at most
				// a little longer than the lease lasts.
				let busySince = null
				for (;;) {
					let step
					try {
						step = await client.post('/admin/media/rebuild', { after, dryRun })
					} catch (error) {
						if (error instanceof AdminError && error.code === 'rebuild-needs-readonly') {
							out.info(
								'media-rebuild writes only before publication or in the Store maintenance: run `kopje-admin maintenance on`, wait 20 minutes (until nothing that may delete media is still running), run media-rebuild, then `maintenance off`'
							)
							return 3
						}
						if (error instanceof AdminError && error.code === 'rebuild-settling') {
							out.info(`${error.message}; run it again then`)
							return 3
						}
						if (error instanceof AdminError && error.code === 'rebuild-busy') {
							busySince ??= now()
							if (now() - busySince > 6 * 60 * 1000) {
								out.info('another media-rebuild holds the lease; run it again later')
								return 3
							}
							out.progress('media-rebuild: waiting for the rebuild lease')
							await pause(5000)
							continue
						}
						throw error
					}
					busySince = null
					for (const [outcome, n] of Object.entries(step.counts)) {
						counts[outcome] = (counts[outcome] ?? 0) + n
					}
					problems.push(...step.problems)
					out.progress(`media-rebuild: ${JSON.stringify(counts)}`)
					if (step.stopped === 'quota' || step.stopped === 'budget') {
						stopped = step.stopped
						break
					}
					if (step.done) {
						break
					}
					after = step.next
				}
				print({ dryRun, ...counts, 'quota-stopped': stopped !== null, stopped, problems })
				if (stopped !== null) {
					out.info(
						stopped === 'quota'
							? 'stopped: Images refused for quota (9422); run it again once the allowance renews'
							: 'stopped: the monthly transformation budget (IMAGES_MONTHLY_TRANSFORMS) is spent; raise it or wait'
					)
				}
				return stopped !== null || problems.length > 0 ? 3 : 0
			}
			case 'keys': {
				if (rest.length !== 1 || rest[0] !== 'rewrap') {
					throw new UsageError('keys rewrap')
				}
				const counts = { rewrapped: 0, current: 0, failed: 0 }
				/** @type {unknown[]} */
				const failures = []
				/** @type {string | null} */
				let after = null
				for (;;) {
					const step = await client.post('/admin/keys/rewrap', { after })
					counts.rewrapped += step.counts.rewrapped
					counts.current += step.counts.current
					counts.failed += step.counts.failed
					failures.push(...step.failures)
					out.progress(`keys rewrap: ${JSON.stringify(counts)}`)
					if (step.done) {
						break
					}
					after = step.next
				}
				print({ ...counts, failures })
				if (failures.length > 0) {
					out.info(
						'some keys were not rewrapped (changed: run it again; unwrap-failed or pubkey-mismatch: neither KEK fits them)'
					)
				}
				return failures.length > 0 ? 3 : 0
			}
			case 'dump': {
				const path = rest[0]
				if (path === undefined) {
					throw new UsageError('dump <file>')
				}
				const chunkMib = numberFlag(flags, 'chunk-mib', 0.001, 16)
				await dumpToFile({
					client,
					io,
					out,
					path,
					maxBytes: chunkMib === undefined ? undefined : Math.floor(chunkMib * 1024 * 1024),
					leaseSeconds: numberFlag(flags, 'lease-seconds', 30, 3600),
					restart: flags.restart === true,
					now,
					sleep,
				})
				return 0
			}
			case 'import': {
				const path = rest[0]
				if (path === undefined) {
					throw new UsageError('import <file>')
				}
				const chunkMib = numberFlag(flags, 'chunk-mib', 0.001, 4)
				const report = await importFromFile({
					client,
					io,
					out,
					path,
					chunkBytes: chunkMib === undefined ? undefined : Math.floor(chunkMib * 1024 * 1024),
					now,
					sleep,
					privateFiles: platform !== 'win32',
				})
				print(report)
				out.info(
					report.ok ? 'import verified' : `import FAILED verification; run import-reset ${path} --yes and import again`
				)
				return report.ok ? 0 : 1
			}
			case 'import-reset': {
				if (flags.yes !== true) {
					throw new UsageError('import-reset deletes all data of the Store; pass --yes')
				}
				// A reset names its import: the one saved for <file>, or else the one running on the Store. A token
				// import is reset with the session kept for its file, or with --abandon-stale once it is idle.
				const saved = rest[0] === undefined ? null : await io.readText(`${rest[0]}.import.json`)
				/** @type {{ id: string, session?: string } | null} */
				const local = saved === null ? null : JSON.parse(saved)
				const resetter = typeof local?.session === 'string' ? client.withSession(local.session) : client
				const id = local?.id ?? (await client.get('/admin/import/progress')).progress?.id
				if (typeof id !== 'string') {
					throw new Error('there is no import to reset')
				}
				const body = { confirm: true, id, ...(flags['abandon-stale'] === true ? { abandonStale: true } : {}) }
				for (;;) {
					const step = await resetter.post('/admin/import/reset', body)
					if (step.done) {
						break
					}
					out.progress(`resetting import ${id}`)
				}
				out.info(`import ${id} reset`)
				if (rest[0] !== undefined) {
					await io.remove(`${rest[0]}.import.json`)
				}
				return 0
			}
			case 'publish': {
				if (flags.yes !== true) {
					throw new UsageError(
						'publish ends the readonly state of an import for good (no cutover reset after it); pass --yes'
					)
				}
				print(await client.post('/admin/publish', { confirm: true }))
				return 0
			}
			case 'cutover': {
				const [sub] = rest
				if (sub === 'status') {
					print(await client.get('/admin/cutover/status'))
					return 0
				}
				if (sub === 'drain') {
					// The legacy local accounts come from the maintenance worker's snapshot, never from a request.
					const workerDir = flags.worker
					const fallback = flags.fallback
					if (typeof workerDir !== 'string' || (fallback !== undefined && typeof fallback !== 'string')) {
						throw new UsageError('cutover drain --worker <maintenance worker dir> [--fallback <username>]')
					}
					const { snapshotIn, WORKER_FILE } = await import('./cutover/worker-file.js')
					const accounts = snapshotIn((await io.readText(`${workerDir}/${WORKER_FILE}`)) ?? '').inboxes
					const pause =
						sleep ?? ((/** @type {number} */ ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms)))
					// Past the collection barrier, only after a stop on journal-full (the Store checks it).
					const unordered = flags.unordered === true
					if (unordered && flags.yes !== true) {
						throw new UsageError('cutover drain --unordered may reorder requests; pass --yes')
					}
					const totals = { sent: 0, unverified: 0, noRecipient: 0 }
					const deadline = now() + 45 * 60 * 1000
					for (;;) {
						const round = await client.post('/admin/cutover/drain', { accounts, fallback, unordered })
						totals.sent += round.sent
						totals.unverified += round.unverified
						totals.noRecipient += round.noRecipient
						const { pending, sending } = round.journal
						out.progress(`sent ${totals.sent}, kept ${totals.unverified + totals.noRecipient}, pending ${pending}`)
						if (round.stopped !== null) {
							print({ ...totals, journal: round.journal, stopped: round.stopped })
							out.info(`drain stopped (${round.stopped}); act on it, then run it again`)
							return 3
						}
						if (round.waiting === null && round.sent === 0 && pending + sending === 0) {
							print({ ...totals, journal: round.journal })
							out.info('rollback journal drained')
							return 0
						}
						if (round.sent > 0) {
							continue
						}
						// No progress this round (a busy lane, or records set aside): pause, and give up at the deadline.
						if (now() > deadline) {
							print({ ...totals, journal: round.journal, waiting: round.waiting })
							out.info(`not done after 45 minutes (${round.waiting ?? 'records set aside'}); run it again`)
							return 3
						}
						await pause(2000)
					}
				}
				if (sub === 'discard-kept') {
					if (flags.yes !== true) {
						throw new UsageError('cutover discard-kept deletes the kept requests; pass --yes')
					}
					print(await client.post('/admin/cutover/discard-kept', { confirm: true }))
					return 0
				}
				if (sub === 'close') {
					if (flags.yes !== true) {
						throw new UsageError(`cutover ${sub} --yes`)
					}
					print(await client.post(`/admin/cutover/${sub}`, { confirm: true }))
					return 0
				}
				if (sub === 'reset') {
					if (flags.yes !== true) {
						throw new UsageError('cutover reset deletes all data of the Store; pass --yes')
					}
					const started = await client.post('/admin/cutover/reset', { confirm: true })
					let done = started.done === true
					while (!done) {
						out.progress(`resetting the Store (${started.id})`)
						done = (await client.post('/admin/import/reset', { confirm: true, id: started.id })).done === true
					}
					out.info(started.id === null ? 'the Store is already empty' : 'the Store is empty again')
					return 0
				}
				throw new UsageError(
					'cutover status | drain --worker <dir> [--fallback <username>] [--unordered --yes] | discard-kept --yes | close --yes | reset --yes'
				)
			}
			case 'pitr': {
				if (rest[0] === 'bookmark') {
					const at = flags.at
					print(await client.get('/admin/pitr/bookmark', typeof at === 'string' ? { at } : undefined))
					return 0
				}
				if (rest[0] === 'restore') {
					const bookmark = rest[1]
					if (bookmark === undefined || flags.yes !== true) {
						throw new UsageError('pitr restore <bookmark> --yes')
					}
					print(await client.post('/admin/pitr/restore', { bookmark }))
					out.info('the Store restarts to apply the bookmark; check `health`, then leave MAINTENANCE=full')
					return 0
				}
				throw new UsageError('pitr bookmark [--at <time>] | pitr restore <bookmark> --yes')
			}
			case 'sql': {
				const query = rest.join(' ')
				if (query === '') {
					throw new UsageError('sql <query>')
				}
				const limit = numberFlag(flags, 'limit', 1, 1000)
				print(await client.post('/admin/sql', limit === undefined ? { sql: query } : { sql: query, limit }))
				return 0
			}
			default:
				throw new UsageError(`unknown command ${command}`)
		}
	} catch (error) {
		if (error instanceof UsageError) {
			stderr.write(`${redact(error.message)}\n\n${USAGE}`)
			return 2
		}
		const message = error instanceof Error ? error.message : String(error)
		out.info(`error: ${message}`)
		if (error instanceof AdminError && Object.keys(error.body).length > 0) {
			const { error: _message, ...detail } = error.body
			if (Object.keys(detail).length > 0) {
				out.info(JSON.stringify(detail, null, 2))
			}
		}
		return 1
	}
}
