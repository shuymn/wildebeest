import { AdminError, createClient } from './client.js'
import { dumpToFile, formatBytes, importFromFile } from './commands.js'

export const USAGE = `Usage: kopje-admin <command> [options]

Commands
  health                        detailed health report
  version                       Worker build and Store schema version
  capacity                      database size and rows per table
  spool                         spooled inbox parts waiting for replay
  maintenance on|off            enter or leave the Store's readonly maintenance
  upgrade retry                 re-run a failed schema upgrade for the current build
  dump <file>                   dump the Store to <file> (resumable)
      --chunk-mib <n>           chunk size in MiB, 0.001-16 (default 16)
      --lease-seconds <n>       freeze lease, renewed by every chunk (default 600)
      --restart                 discard <file> and its saved cursor and start over
  import <file>                 import <file> into an empty Store and verify (resumable)
      --chunk-mib <n>           chunk size in MiB, 0.001-16 (default 8)
      --import-token            begin with KOPJE_IMPORT_TOKEN (cutover into an empty Store without admin access);
                                the import then continues with its own session, kept in <file>.import.json
  import-reset [<file>] --yes   take the Store back to before an import (its imported rows are deleted; schema and
                                configuration stay); the import is the one saved for <file>, or else the running one,
                                and a token import is reset with the session kept for <file>
      --abandon-stale --import-token
                                recover a token import whose session file was lost: IMPORT_TOKEN resets it once it
                                has been idle for 15 minutes (the error says when) while admin access is not usable
  config                        show the instance values and the Access settings of /admin
  config <name>=<value>|<name>= set (or with an empty value, remove) them; names: domain, access_aud,
                                access_team_domain, access_admin_aud, admin_email, access_service_token_client_id.
                                An import never changes them. With --import-token only while the Store has no
                                usable admin access (bootstrap)
  catalog                       migrations and tables a dump for this Store must declare
  pitr bookmark [--at <time>]   current bookmark, or the one for an ISO 8601 time
  pitr restore <bookmark> --yes restore the Store to a bookmark (requires MAINTENANCE=full)
  sql <query> [--limit <n>]     run a single read-only SELECT/WITH statement

Environment
  KOPJE_ADMIN_URL               base URL of the instance's admin host, e.g. https://admin.example.com
  CF_ACCESS_CLIENT_ID           Access service token client id      (sent as CF-Access-Client-Id)
  CF_ACCESS_CLIENT_SECRET       Access service token client secret  (sent as CF-Access-Client-Secret)
  KOPJE_IMPORT_TOKEN            the IMPORT_TOKEN secret, used only with --import-token
`

/**
 * @typedef {{ write(text: string): void, isTTY?: boolean }} Stream
 * @typedef {{ argv: string[], env: Record<string, string | undefined>, io: import('./format.js').FileIO,
 *   stdout: Stream, stderr: Stream, fetch?: import('./client.js').Fetch, now?: () => number,
 *   sleep?: (ms: number) => Promise<void> }} RunOptions
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
	const valued = new Set(['chunk-mib', 'lease-seconds', 'at', 'limit'])
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

// Replaces every secret value in a text, as a last line of defense for anything printed.
/** @param {string[]} secrets */
function redactor(secrets) {
	const values = secrets.filter((s) => s.length >= 4)
	/** @param {string} text */
	return (text) => values.reduce((out, secret) => out.split(secret).join('***'), text)
}

/**
 * Runs one CLI command. Returns the process exit code.
 * @param {RunOptions} options
 */
export async function run({ argv, env, io, stdout, stderr, fetch, now = Date.now, sleep }) {
	const secrets = [env.CF_ACCESS_CLIENT_SECRET, env.KOPJE_IMPORT_TOKEN, env.CF_ACCESS_CLIENT_ID].filter(
		/** @returns {s is string} */ (s) => typeof s === 'string'
	)
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
	}

	try {
		const { positional, flags } = parseArgs(argv)
		const [command, ...rest] = positional
		if (command === undefined || command === 'help' || flags.help === true) {
			stdout.write(USAGE)
			return command === undefined && flags.help !== true ? 2 : 0
		}
		const url = env.KOPJE_ADMIN_URL
		if (url === undefined || url === '') {
			throw new UsageError('set KOPJE_ADMIN_URL to the admin base URL')
		}
		const useToken = flags['import-token'] === true
		const tokenCommands = ['import', 'import-reset', 'config', 'health', 'version', 'catalog']
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
				const chunkMib = numberFlag(flags, 'chunk-mib', 0.001, 16)
				const report = await importFromFile({
					client,
					io,
					out,
					path,
					chunkBytes: chunkMib === undefined ? undefined : Math.floor(chunkMib * 1024 * 1024),
					now,
					sleep,
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
