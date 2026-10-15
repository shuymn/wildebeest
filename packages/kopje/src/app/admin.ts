import { type Context, Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

import { drainJournal } from './cutover'
import { healthReport } from './health'
import { rewrapKeys } from './key-rewrap'
import type { LoaderDeps } from '../federation/loader'
import { rebuildMedia } from '../mastodon/media-rebuild'
import { type AccessSettings, adminRefusal, adminUsable, normalizeTeamDomain } from '../platform/access-settings'
import { readBackupConfig } from '../platform/backup-config'
import { readBoundedBody } from '../platform/body'
import { previousUserKek, readConfig, userKek } from '../platform/config'
import { errorMessage } from '../platform/error-message'
import type { ImageCodec } from '../platform/images'
import { readQueueBacklog } from '../platform/queue-backlog'
import type { ImportAuthority } from '../platform/store-admin'
import type { StoreResolver, StoreStub } from '../platform/store-client'
import { toStoreUnavailable } from '../platform/store-errors'
import { type AccessDeps, type AccessIdentity, verifyAccessClaims } from '../security/access-jwt'
import { constantTimeEqual } from '../security/tokens'

// The admin HTTP API behind its own Access application. Every request is authenticated here as well, and every
// import or configuration mutation passes its authority to the Store, which checks it where it writes:
//   - Cf-Access-Jwt-Assertion verified against the team JWKS with the AUD from instance_settings, from the admin's
//     email or the admin CLI's service token (common_name = the configured client id); or
//   - Kopje-Import-Token = IMPORT_TOKEN, while the Store is in bootstrap (no usable admin access): to read its health,
//     version and catalog, to configure it (/admin/config), to begin an import into it while it is empty, and to
//     abandon a token import whose session was lost and idle for 15 minutes. Used for the cutover, then removed.
//   - Kopje-Import-Session = the credential that begin returned for a token import: only for that import.
// The maintenance gate does not apply: these routes are how an operator works on a Store in maintenance.

export const ADMIN_PREFIX = '/admin'
export const IMPORT_TOKEN_HEADER = 'Kopje-Import-Token'
export const IMPORT_SESSION_HEADER = 'Kopje-Import-Session'
const MIN_IMPORT_TOKEN_LENGTH = 32
const JSON_BODY_LIMIT = 1024 * 1024
// A chunk of statements plus room for nothing else; the Store refuses anything larger.
const IMPORT_CHUNK_LIMIT = 16 * 1024 * 1024
// IMPORT_TOKEN: reads only while in bootstrap (checked here); mutations are checked by the Store.
const TOKEN_READ_PATHS = [/^\/admin\/(health|version|catalog|config)$/]
// The import token may name a running token import (its id and phase only) to abandon it when its session was lost.
const TOKEN_PROGRESS_PATH = /^\/admin\/import\/progress$/
const TOKEN_WRITE_PATHS = [/^\/admin\/import\/(begin|reset)$/, /^\/admin\/config$/, /^\/admin\/publish$/]
const SESSION_PATHS = [/^\/admin\/import\/(chunk|finish|verify|progress|reset)$/]
const SESSION_SECRET = /^[A-Za-z0-9_-]{43}$/

export type AdminDeps = AccessDeps & {
	build: (env: Env) => string
	store: StoreResolver
	// Remote fetches of the cutover rollback drain (app/cutover.ts).
	loader: Omit<LoaderDeps, 'userAgent'>
	// Rings the delivery doorbell after a retry, and after a publication that recorded profile Updates.
	doorbell: (env: Env) => Promise<void>
	// Re-encoding for the media rebuild.
	images: (env: Env) => ImageCodec
}

type AdminVariables = { auth: ImportAuthority }
type AdminEnv = { Bindings: Env; Variables: AdminVariables }

type Refusal = { ok: false; code: string; message: string }

const STATUS: Record<string, ContentfulStatusCode> = {
	'not-read-only': 400,
	'invalid-cursor': 400,
	'invalid-header': 400,
	'invalid-trailer': 400,
	'invalid-chunk': 400,
	'out-of-order': 400,
	'chunk-too-large': 413,
	'trailer-mismatch': 400,
	'body-mismatch': 400,
	'out-of-range': 400,
	'query-failed': 400,
	'dump-not-found': 404,
	'wrong-authority': 403,
	'not-bootstrap': 403,
	'invalid-config': 400,
	'invalid-op-id': 400,
	'import-id-required': 400,
	'import-not-found': 404,
	published: 409,
	'journal-not-empty': 409,
	'drain-in-progress': 409,
	'rollback-in-progress': 409,
	'not-unpublished': 409,
	'pitr-unavailable': 503,
	'chunk-failed': 500,
}

function refusal(c: Context, result: Refusal): Response {
	const { ok: _ok, code, message, ...rest } = result as Refusal & Record<string, unknown>
	return c.json({ error: message, code, ...rest }, STATUS[code] ?? 409)
}

// A Store result: { ok: true, ... } as 200, a refusal with its status.
function reply<T extends { ok: boolean }>(c: Context, result: T): Response {
	if (!result.ok) {
		return refusal(c, result as unknown as Refusal)
	}
	const { ok: _ok, ...rest } = result
	return c.json(rest)
}

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
	const body = await readBoundedBody(c.req.raw, JSON_BODY_LIMIT)
	if (body === 'too-large') {
		throw new AdminRequestError(413, 'request body too large')
	}
	if (body.byteLength === 0) {
		return {}
	}
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(body))
		if (typeof value !== 'object' || value === null || Array.isArray(value)) {
			throw new Error('not an object')
		}
		return value as Record<string, unknown>
	} catch {
		throw new AdminRequestError(400, 'request body must be a JSON object')
	}
}

class AdminRequestError extends Error {
	constructor(
		readonly status: ContentfulStatusCode,
		message: string
	) {
		super(message)
	}
}

function parseTime(value: string): number | null {
	if (/^\d{1,16}$/.test(value)) {
		return Number(value)
	}
	const parsed = Date.parse(value)
	return Number.isNaN(parsed) ? null : parsed
}

// The admin policy over a verified Access token (platform/access-settings.ts), plus the shape of a service token:
// no email and an empty sub. common_name alone is not enough: Access also uses it for the name on an mTLS client
// certificate.
function adminAllowed(identity: AccessIdentity, access: AccessSettings): string | null {
	if (identity.email === null && identity.subject !== '') {
		return 'this service token is not the admin CLI token'
	}
	return adminRefusal(access, identity)
}

export function adminRoutes({ build, store, fetch, now, doorbell, loader, images }: AdminDeps) {
	const admin = new Hono<AdminEnv>()
	const stub = (c: Context<AdminEnv>): StoreStub => store(c.env)

	admin.use(
		createMiddleware<AdminEnv>(async (c, next) => {
			// Requests without any credential are refused before the Store is asked for settings.
			const presented = c.req.header(IMPORT_TOKEN_HEADER)
			const session = c.req.header(IMPORT_SESSION_HEADER)
			const assertion = c.req.header('Cf-Access-Jwt-Assertion')
			if (session !== undefined) {
				if (!SESSION_SECRET.test(session) || !SESSION_PATHS.some((p) => p.test(c.req.path))) {
					return c.json({ error: 'an import session only continues its own import' }, 403)
				}
				c.set('auth', { kind: 'import-session', secret: session })
				return next()
			}
			if (presented === undefined && (assertion === undefined || assertion === '')) {
				return c.json({ error: 'missing Cf-Access-Jwt-Assertion' }, 401)
			}
			if (presented !== undefined) {
				const secret = (c.env as { IMPORT_TOKEN?: unknown }).IMPORT_TOKEN
				if (typeof secret !== 'string' || secret.length < MIN_IMPORT_TOKEN_LENGTH) {
					return c.json(
						{ error: `IMPORT_TOKEN is not set (it must be at least ${MIN_IMPORT_TOKEN_LENGTH} characters)` },
						401
					)
				}
				if (!constantTimeEqual(presented, secret)) {
					return c.json({ error: 'invalid import token' }, 401)
				}
				const write = c.req.method === 'POST' && TOKEN_WRITE_PATHS.some((p) => p.test(c.req.path))
				const progress = c.req.method === 'GET' && TOKEN_PROGRESS_PATH.test(c.req.path)
				const read = c.req.method === 'GET' && TOKEN_READ_PATHS.some((p) => p.test(c.req.path))
				if (!write && !read && !progress) {
					return c.json({ error: 'the import token only bootstraps an empty Store' }, 403)
				}
				if (read || progress) {
					// Reads only while admin access is not usable; during an import that is the target's saved configuration.
					const gate = await stub(c).adminGate(build(c.env))
					if (read ? !gate.bootstrap : adminUsable(gate.access)) {
						return c.json({ error: 'the import token is accepted only while the Store has no admin access' }, 403)
					}
				}
				c.set('auth', { kind: 'import-token' })
				return next()
			}
			const { access } = await stub(c).adminGate(build(c.env))
			if (access.teamDomain === null || access.adminAud === null) {
				return c.json({ error: 'Access is not configured for /admin' }, 401)
			}
			const verified = await verifyAccessClaims(
				assertion,
				{ teamDomain: access.teamDomain, aud: access.adminAud },
				{ fetch, now }
			)
			if (!verified.ok) {
				return c.json({ error: `invalid Access token (${verified.reason})` }, 401)
			}
			const refused = adminAllowed(verified, access)
			if (refused !== null) {
				return c.json({ error: refused }, 403)
			}
			// The Store checks the identity and the binding it was verified with again where it writes.
			c.set('auth', {
				kind: 'access',
				email: verified.email,
				commonName: verified.commonName,
				teamDomain: normalizeTeamDomain(access.teamDomain),
				aud: access.adminAud,
			})
			await next()
		})
	)

	admin.get('/health', async (c) => {
		const b = build(c.env)
		const config = readConfig(c.env)
		let health: ReturnType<StoreStub['health']> | undefined
		const once = {
			health: () => (health ??= stub(c).health(b)),
			localKeys: (caller: string) => stub(c).localKeys(caller),
			backupState: (caller: string) => stub(c).backupState(caller),
		}
		const report = await healthReport(b, config, () => once, { backup: readBackupConfig(c.env) })
		let detail: unknown
		try {
			detail = await once.health()
		} catch (error) {
			detail = { error: errorMessage(error) }
		}
		const maintenance = config.ok ? config.config.MAINTENANCE : null
		return c.json({ ...report, maintenance, store: detail })
	})

	admin.get('/version', async (c) => {
		const b = build(c.env)
		// The Store runs from the same script, so its package version is the Worker's too.
		return c.json({ worker: { build: b }, store: await stub(c).version(b) })
	})

	admin.get('/capacity', async (c) => c.json(await stub(c).capacity(build(c.env))))

	admin.get('/spool', async (c) => c.json(await stub(c).spool(build(c.env))))

	admin.post('/maintenance', async (c) => {
		const { on } = await jsonBody(c)
		if (typeof on !== 'boolean') {
			return c.json({ error: 'expected {"on": true|false}' }, 400)
		}
		const result = await stub(c).setMaintenance(build(c.env), on)
		return 'ok' in result ? refusal(c, result) : c.json(result)
	})

	admin.post('/upgrade/retry', async (c) => {
		const result = await stub(c).retryUpgrade(build(c.env))
		return c.json(result, result.ok ? 200 : 409)
	})

	admin.post('/sql', async (c) => {
		const { sql, limit } = await jsonBody(c)
		if (typeof sql !== 'string' || (limit !== undefined && typeof limit !== 'number')) {
			return c.json({ error: 'expected {"sql": string, "limit"?: number}' }, 400)
		}
		return reply(c, await stub(c).query(build(c.env), sql, limit))
	})

	// ---- deliveries: the backlog and the given-up rows, and putting them back (RES-5)

	admin.get('/deliveries', async (c) => {
		const before = c.req.query('before')
		const limit = c.req.query('limit')
		if ((before !== undefined && !/^\d{1,19}$/.test(before)) || (limit !== undefined && !/^\d{1,3}$/.test(limit))) {
			return c.json({ error: 'before must be a delivery id and limit a number' }, 400)
		}
		const input = {
			...(before === undefined ? {} : { before }),
			...(limit === undefined ? {} : { limit: Number(limit) }),
		}
		return c.json(await stub(c).deliveriesReport(build(c.env), input))
	})

	admin.post('/deliveries/retry', async (c) => {
		const { ids, all, after } = await jsonBody(c)
		const named =
			Array.isArray(ids) && ids.length > 0 && ids.every((id) => typeof id === 'string' && /^\d{1,19}$/.test(id))
		const cursor = after === undefined || (typeof after === 'string' && /^\d{1,19}$/.test(after))
		if ((all === true ? ids !== undefined : !named || after !== undefined) || !cursor) {
			return c.json({ error: 'expected {"ids": [string, ...]} or {"all": true, "after"?: string}' }, 400)
		}
		const result = await stub(c).retryDeliveries(build(c.env), {
			ids: all === true ? 'all' : (ids as string[]),
			now: now(),
			...(typeof after === 'string' ? { after } : {}),
		})
		if (!result.ok) {
			const error =
				result.code === 'superseded'
					? 'a later activity about the same object (an Undo, a Delete or an Update) supersedes these; sending them again could undo it'
					: 'these copies are addressed to a silent recipient without a personal inbox; they are never sent elsewhere'
			return c.json({ error, code: result.code, ids: result.ids }, 409)
		}
		if (result.retried > 0) {
			await doorbell(c.env).catch(() => {})
		}
		const { ok: _ok, ...rest } = result
		return c.json(rest)
	})

	// ---- media rebuild (mastodon/media-rebuild.ts): one bounded step under the Store's rebuild lease; the CLI follows
	// `next` until `done`. Access admin only: the import token and import sessions never reach this path, and the Store
	// checks the admin again where it writes. It writes only while nothing can delete media: before publication, or in
	// the Store's maintenance once it has settled (`rebuild-needs-readonly`, `rebuild-settling` otherwise).

	admin.post('/media/rebuild', async (c) => {
		const { after, dryRun } = await jsonBody(c)
		if (
			(after !== undefined && after !== null && (typeof after !== 'string' || !/^\d{18}$/.test(after))) ||
			(dryRun !== undefined && typeof dryRun !== 'boolean')
		) {
			return c.json({ error: 'expected {"after"?: media id, "dryRun"?: boolean}' }, 400)
		}
		const config = readConfig(c.env)
		const result = await rebuildMedia(
			{
				build: build(c.env),
				store: stub(c),
				bucket: c.env.MEDIA,
				images: images(c.env),
				now,
				authority: c.get('auth'),
				monthlyTransforms: config.ok ? config.config.IMAGES_MONTHLY_TRANSFORMS : 0,
			},
			{ after: typeof after === 'string' ? after : null, dryRun: dryRun === true }
		)
		return reply(c, result)
	})

	// ---- the KEK rewrap (app/key-rewrap.ts): one page of local keys moved from USER_KEK_PREVIOUS to USER_KEK; the CLI
	// follows `next` until `done`. Access admin only: the import token and import sessions never reach this path, and the
	// Store checks the admin again where it writes.

	admin.post('/keys/rewrap', async (c) => {
		const { after } = await jsonBody(c)
		if (after !== undefined && after !== null && (typeof after !== 'string' || !/^\d{18}$/.test(after))) {
			return c.json({ error: 'expected {"after"?: account id}' }, 400)
		}
		const config = readConfig(c.env)
		if (!config.ok) {
			return c.json({ error: 'the Worker configuration is invalid (see kopje-admin health)', code: 'invalid-env' }, 409)
		}
		const result = await rewrapKeys(
			{
				build: build(c.env),
				store: stub(c),
				authority: c.get('auth'),
				kek: userKek(config.config),
				previous: previousUserKek(config.config),
			},
			{ after: typeof after === 'string' ? after : null }
		)
		return reply(c, result)
	})

	// ---- dump

	admin.post('/dump/start', async (c) => {
		const { leaseSeconds, opId } = await jsonBody(c)
		if (
			(leaseSeconds !== undefined && typeof leaseSeconds !== 'number') ||
			(opId !== undefined && typeof opId !== 'string')
		) {
			return c.json({ error: 'expected {"leaseSeconds"?: number, "opId"?: string}' }, 400)
		}
		return reply(c, await stub(c).dumpStart(build(c.env), leaseSeconds, opId))
	})

	// The response is the cursor as one JSON line, then the chunk bytes.
	admin.post('/dump/next', async (c) => {
		const { cursor, maxBytes } = await jsonBody(c)
		if (maxBytes !== undefined && typeof maxBytes !== 'number') {
			return c.json({ error: 'maxBytes must be a number' }, 400)
		}
		const result = await stub(c).dumpNext(build(c.env), cursor, maxBytes)
		if (!result.ok) {
			return refusal(c, result)
		}
		const head = new TextEncoder().encode(
			`${JSON.stringify({ cursor: result.cursor, done: result.done, leaseUntil: result.leaseUntil })}\n`
		)
		const body = new Uint8Array(head.byteLength + result.chunk.byteLength)
		body.set(head, 0)
		body.set(result.chunk, head.byteLength)
		return new Response(body, {
			headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' },
		})
	})

	admin.post('/dump/finish', async (c) => {
		const { cursor, abort } = await jsonBody(c)
		return reply(c, await stub(c).dumpFinish(build(c.env), cursor, abort === true))
	})

	// ---- import

	admin.get('/catalog', async (c) => c.json(await stub(c).catalog(build(c.env))))

	admin.post('/import/begin', async (c) => {
		const { header } = await jsonBody(c)
		return reply(c, await stub(c).importBegin(build(c.env), c.get('auth'), header))
	})

	admin.get('/import/progress', async (c) =>
		c.json(await stub(c).importProgress(build(c.env), c.get('auth'), c.req.query('id')))
	)

	admin.post('/import/chunk', async (c) => {
		const id = c.req.query('id')
		const seq = Number(c.req.query('seq'))
		if (id === undefined || !Number.isSafeInteger(seq)) {
			return c.json({ error: 'expected ?id=<import id>&seq=<chunk number>' }, 400)
		}
		const body = await readBoundedBody(c.req.raw, IMPORT_CHUNK_LIMIT)
		if (body === 'too-large') {
			return c.json({ error: `a chunk may hold at most ${IMPORT_CHUNK_LIMIT} bytes`, code: 'chunk-too-large' }, 413)
		}
		return reply(c, await stub(c).importChunk(build(c.env), c.get('auth'), id, seq, body))
	})

	admin.post('/import/finish', async (c) => {
		const { id, trailer } = await jsonBody(c)
		if (typeof id !== 'string') {
			return c.json({ error: 'expected {"id": string, "trailer": object}' }, 400)
		}
		return reply(c, await stub(c).importFinish(build(c.env), c.get('auth'), id, trailer))
	})

	admin.post('/import/verify', async (c) => {
		const { id } = await jsonBody(c)
		if (typeof id !== 'string') {
			return c.json({ error: 'expected {"id": string}' }, 400)
		}
		return reply(c, await stub(c).importVerify(build(c.env), c.get('auth'), id))
	})

	admin.post('/import/reset', async (c) => {
		const { confirm, id, abandonStale } = await jsonBody(c)
		if (
			confirm !== true ||
			(id !== undefined && typeof id !== 'string') ||
			(abandonStale !== undefined && typeof abandonStale !== 'boolean')
		) {
			return c.json(
				{ error: 'reset deletes all data of this Store; send {"confirm": true, "id"?: string, "abandonStale"?: true}' },
				400
			)
		}
		return reply(c, await stub(c).importReset(build(c.env), c.get('auth'), id, abandonStale === true))
	})

	// ---- configuration (instance values and Access authority; never changed by an import)

	admin.get('/config', async (c) => c.json(await stub(c).config(build(c.env))))

	admin.post('/config', async (c) => {
		const { values } = await jsonBody(c)
		return reply(c, await stub(c).setConfig(build(c.env), c.get('auth'), values))
	})

	// ---- cutover (docs/cutover-runbook.md): publication, the rollback journal and drain, the reset after an import.
	// Access admin only: the import token and import sessions never reach these paths.

	admin.get('/cutover/status', async (c) => c.json(await stub(c).cutoverStatus(build(c.env))))

	// Publication: ends the readonly state a verified import leaves. An Access admin, or IMPORT_TOKEN while the Store
	// has no usable admin access (the Store checks both).
	admin.post('/publish', async (c) => {
		const { confirm } = await jsonBody(c)
		if (confirm !== true) {
			return c.json({ error: 'publishing ends the cutover for good; send {"confirm": true}' }, 400)
		}
		const result = await stub(c).publish(build(c.env), c.get('auth'))
		if (result.ok && result.profileUpdates > 0) {
			await doorbell(c.env).catch(() => {})
		}
		return reply(c, result)
	})

	// Ends a rollback, once Kopje's Queue and its dead-letter queue (bound as KOPJE_DLQ, read for its metrics only) both
	// hold nothing (no message counted and no bytes, which a delayed message still shows), read through their metrics and
	// failing closed: no copy of a handed-off request is left to arrive or to be redriven, so its receipts can go.
	admin.post('/cutover/close', async (c) => {
		const { confirm } = await jsonBody(c)
		if (confirm !== true) {
			return c.json({ error: 'send {"confirm": true}' }, 400)
		}
		const queued = await readQueueBacklog(c.env.QUEUE)
		const dead = queued?.empty ? await readQueueBacklog((c.env as { KOPJE_DLQ?: Queue }).KOPJE_DLQ) : null
		if (!queued?.empty || !dead?.empty) {
			return c.json(
				{
					error:
						"Kopje's Queue or its dead-letter queue (KOPJE_DLQ) is not empty (a delayed message shows only in its bytes), or cannot be read",
					code: 'queue-not-empty',
					backlog: queued?.count ?? null,
					deadLetters: dead?.count ?? null,
				},
				409
			)
		}
		return reply(c, await stub(c).closeRollback(build(c.env), c.get('auth')))
	})

	admin.post('/cutover/drain', async (c) => {
		const { accounts, fallback, unordered } = await jsonBody(c)
		const result = await drainJournal(
			c.env,
			{ build: build(c.env), store: stub(c), loader, holder: crypto.randomUUID(), now },
			c.get('auth'),
			{ accounts, fallback, unordered }
		)
		if (!result.ok) {
			return c.json({ error: result.message, code: result.code }, result.status)
		}
		const { ok: _ok, ...rest } = result
		return c.json(rest)
	})

	admin.post('/cutover/discard-kept', async (c) => {
		const { confirm } = await jsonBody(c)
		if (confirm !== true) {
			return c.json({ error: 'this deletes the kept requests; send {"confirm": true}' }, 400)
		}
		return reply(c, await stub(c).journalDiscardKept(build(c.env), c.get('auth')))
	})

	// Like a PITR restore, refused unless the env MAINTENANCE=full holds the instance from outside.
	admin.post('/cutover/reset', async (c) => {
		const { confirm } = await jsonBody(c)
		if (confirm !== true) {
			return c.json({ error: 'reset deletes all data of this Store; send {"confirm": true}' }, 400)
		}
		const config = readConfig(c.env)
		if (!config.ok || config.config.MAINTENANCE !== 'full') {
			return c.json(
				{ error: 'set MAINTENANCE=full on the Worker before a cutover reset', code: 'maintenance-required' },
				409
			)
		}
		return reply(c, await stub(c).cutoverReset(build(c.env), c.get('auth')))
	})

	// ---- PITR

	admin.get('/pitr/bookmark', async (c) => {
		const at = c.req.query('at')
		const time = at === undefined ? undefined : parseTime(at)
		if (time === null) {
			return c.json({ error: 'at must be an ISO 8601 time or epoch milliseconds' }, 400)
		}
		return reply(c, await stub(c).pitrBookmark(build(c.env), time))
	})

	// Restoring rewinds every flag inside the Store, so it is refused unless the env MAINTENANCE=full holds the
	// instance from outside. The Store restarts to apply the bookmark, which fails this call with the abort reason.
	admin.post('/pitr/restore', async (c) => {
		const { bookmark } = await jsonBody(c)
		if (typeof bookmark !== 'string' || !/^[0-9A-Za-z-]{1,256}$/.test(bookmark)) {
			return c.json({ error: 'expected {"bookmark": string}' }, 400)
		}
		const config = readConfig(c.env)
		if (!config.ok || config.config.MAINTENANCE !== 'full') {
			return c.json(
				{ error: 'set MAINTENANCE=full on the Worker before a PITR restore', code: 'maintenance-required' },
				409
			)
		}
		try {
			await stub(c).pitrToBookmark(build(c.env), bookmark)
		} catch (error) {
			if (errorMessage(error).includes('restoring PITR bookmark')) {
				return c.json({ status: 'restoring', bookmark }, 202)
			}
			throw error
		}
		return c.json({ status: 'restoring', bookmark }, 202)
	})

	admin.onError((error, c) => {
		if (error instanceof AdminRequestError) {
			return c.json({ error: error.message }, error.status)
		}
		const unavailable = toStoreUnavailable(error)
		if (unavailable !== undefined) {
			const status = unavailable.reason === 'version-mismatch' ? 409 : 503
			return c.json({ error: unavailable.message, code: unavailable.reason }, status)
		}
		console.error({ event: 'kopje.admin.error', path: c.req.path, error: errorMessage(error) })
		return c.json({ error: errorMessage(error), code: 'internal' }, 500)
	})

	return admin
}

export function isAdminPath(path: string): boolean {
	return path === ADMIN_PREFIX || path.startsWith(`${ADMIN_PREFIX}/`)
}
