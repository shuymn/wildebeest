import type { InboxDeps } from './inbox'
import { dnsCheckHost } from './loader'
import { fetchRemoteFile, type RemoteFile, type RemoteFileFailure } from './remote-file'
import { WEB_MEDIA_TIMEOUT_MS, WEB_PAGE_MAX_STORE_CALLS, WEB_PAGE_MAX_SUBREQUESTS } from './web-page'
import {
	LANE0_CLAIMS,
	REMOTE_MEDIA_HOLD_MS,
	type RemoteMediaClaim,
	type RemoteMediaClaims,
	type RemoteMediaFence,
	type RemoteMediaMaintenance,
	type RemoteMediaOutcome,
	VALIDATION_HEADS,
} from '../domain/remote-media'
import { readConfig } from '../platform/config'
import { DeadlinePassed, inTime, within } from '../platform/deadline'
import { errorFields } from '../platform/error-message'
import { callStore, type StoreStub } from '../platform/store-client'
import { randomToken } from '../security/tokens'

// The cache of remote media, the Worker's part (domain/remote-media.ts; MEDIA-7, NET-3 in docs/threat-model.md): one
// round per cron tick, outside the env's maintenance, on its own (jobs/scheduled.ts scheduledRemoteMedia). A round has
// one deadline, ROUND_MS after its start, split into three allocations:
//   - maintenance, MAINTENANCE_MS: the Store's maintenance call (which reads the restore marker: a restore younger
//     than its settle period stops the round here, before any write or R2 operation), one R2 delete of the doomed
//     objects due and its confirmation, the PITR validation's heads and their record, and at most one orphan sweep an
//     hour (one R2 list of remote/, the Store's lookup, one R2 delete);
//   - fetches, until FETCH_END_MS: the claim, then each claimed file fetched (federation/remote-file.ts), verified,
//     put in the media bucket (remote/<token>/full, then remote/<token>/still), LANE0_CONCURRENCY at a time;
//   - the finish, until ROUND_MS: records and releases only.
// Every external operation is started only when its own budget fits what is left of its allocation (STORE_CALL_MS for
// a Store call, R2_DELETE_MS for a delete or list, R2_HEAD_MS for a head, at most PUT_MS for a put within the file's
// deadline), and given up at its end. A file's deadline (WEB_MEDIA_TIMEOUT_MS, Mastodon's read_deadline) covers its
// DNS checks, hops, body and puts, and never passes the fetch allocation. What is given up may still land:
//   - a put lands under a token the Store reserved and charged, and the token is only ever doomed with its deletion due
//     LATE_PUT_MS after its Store-recorded claim (A1), after any put of its invocation;
//   - a late R2 delete is idempotent: a doomed object leaves the ledger only once a delete returned in time;
//   - a late head or list is discarded, its work left for a later round;
//   - a late Store call counts as given up (inTime); its effects are fenced by claim and generation.
// A put given up still holds its buffer: no claim starts while one runs (A11, `running`).

export const ROUND_MS = 240_000
export const MAINTENANCE_MS = 45_000
export const FETCH_END_MS = 220_000
export const STORE_CALL_MS = 5_000
export const R2_DELETE_MS = 10_000
export const R2_HEAD_MS = 5_000
export const PUT_MS = 15_000
export const LANE0_CONCURRENCY = 3
// A claim's hold outlasts twice the round that holds it.
if (REMOTE_MEDIA_HOLD_MS < 2 * ROUND_MS) {
	throw new Error('REMOTE_MEDIA_HOLD_MS must be at least twice a remote media round')
}
// The sink's ceilings over a round's claims: each file at most WEB_PAGE_MAX_SUBREQUESTS (4 hops of 2 DNS lookups and a
// request) and WEB_PAGE_MAX_STORE_CALLS policy reads before DNS (and as many after, which the sink does not charge).
export const REMOTE_MEDIA_SUBREQUESTS = LANE0_CLAIMS * WEB_PAGE_MAX_SUBREQUESTS
export const REMOTE_MEDIA_POLICY_CALLS = LANE0_CLAIMS * WEB_PAGE_MAX_STORE_CALLS
// The round's own Store calls, derived from every call it makes: the maintenance, the deletion's confirmation, the
// validation's record, the orphan sweep's lookup, the claim, and per claim two admissions (before the full put and
// before the still put) and one record or release.
export const REMOTE_MEDIA_OWN_STORE_CALLS = 5 + LANE0_CLAIMS * 3
// R2 per round: at most 2 puts a claim, VALIDATION_HEADS heads, one list and two deletes (the doomed batch, the
// orphans).
export const REMOTE_MEDIA_PUTS = LANE0_CLAIMS * 2
export const REMOTE_MEDIA_HEADS = VALIDATION_HEADS

export type RemoteMediaDeps = InboxDeps & {
	// Tests only: the bucket, the tokens, and the fetch of one file.
	bucket?: (env: Env) => R2Bucket
	randomToken?: () => string
	fetchRemoteFile?: typeof fetchRemoteFile
}

export type RemoteMediaRound = {
	status: RemoteMediaMaintenance['status'] | 'failed'
	deleted: number
	validated: number
	orphans: number
	claimed: number
	stored: number
	failed: number
	unattempted: number
	released: number
	lost: number
	// Whether the round started no further claim (a call given up still runs, or the fetch window ended).
	stopped: boolean
}

// The puts a round gave up that are still running: each keeps its buffer, so no round starts a claim while any is.
// Module scope: one isolate's.
const running = new Set<Promise<unknown>>()

// The given-up puts still running, for the memory model's witnesses.
export function outstandingRemoteMediaCalls(): number {
	return running.size
}

// `work` within `end` (within), a call given up kept in `running` until it settles.
async function bounded<T>(work: () => Promise<T>, end: number, now: () => number): Promise<T> {
	let call: Promise<T> | undefined
	try {
		return await within(
			() => {
				call = work()
				return call
			},
			end,
			now
		)
	} catch (error) {
		if (error instanceof DeadlinePassed && call !== undefined) {
			const given: Promise<T> = call
			running.add(given)
			given.then(
				() => running.delete(given),
				() => running.delete(given)
			)
		}
		throw error
	}
}

// Whether the env holds the Worker in maintenance (a write must not start).
function envMaintenance(env: Env): boolean {
	const config = readConfig(env)
	return !config.ok || config.config.MAINTENANCE !== 'off'
}

// The end of an operation of `budget` ms started now within an allocation ending at `end`, or null when it does not
// fit (it is not started).
export function admitted(budget: number, end: number, now: () => number): number | null {
	const at = now()
	return at + budget <= end ? at + budget : null
}

type ClaimResult = { outcome: RemoteMediaOutcome; step: string; host: string | null }

// The outcome of a fetch that failed: a policy RPC error, the shared budget, or a timeout at the window's end leaves
// the attempt unattempted (it does not count); any other failure is permanent or transient as the sink classed it.
function failedOutcome(failure: RemoteFileFailure, windowEnd: number, now: number): RemoteMediaOutcome {
	if (failure.policyFailed || failure.kind === 'budget' || (failure.kind === 'timeout' && now >= windowEnd)) {
		return { kind: 'unattempted' }
	}
	return { kind: 'failed', permanent: !failure.transient }
}

// One round (above). Returns what it did, for the logs and tests.
export async function remoteMediaRound(env: Env, deps: RemoteMediaDeps): Promise<RemoteMediaRound> {
	const round: RemoteMediaRound = {
		status: 'unset',
		deleted: 0,
		validated: 0,
		orphans: 0,
		claimed: 0,
		stored: 0,
		failed: 0,
		unattempted: 0,
		released: 0,
		lost: 0,
		stopped: running.size > 0,
	}
	if (envMaintenance(env)) {
		return round
	}
	const config = readConfig(env)
	const cap = config.ok ? config.config.REMOTE_MEDIA_CACHE_BYTES : 0
	const build = deps.build(env)
	const rpc = <T>(call: (store: StoreStub) => Promise<T>) => callStore(() => call(deps.store(env)))
	const bucket = deps.bucket?.(env) ?? env.MEDIA
	const start = deps.now()
	const maintenanceEnd = start + MAINTENANCE_MS
	const fetchEnd = start + FETCH_END_MS
	const end = start + ROUND_MS
	// A Store call of the allocation ending at `until`, started only when its budget fits.
	const store = async <T>(call: (s: StoreStub) => Promise<T>, until: number): Promise<T> => {
		const by = admitted(STORE_CALL_MS, until, deps.now)
		if (by === null || envMaintenance(env)) {
			throw new DeadlinePassed()
		}
		return inTime(() => rpc(call), by, deps.now)
	}

	// ---- Maintenance
	const maintained = await store(
		(s) => s.maintainRemoteMedia(build, { cap }) as Promise<RemoteMediaMaintenance>,
		maintenanceEnd
	)
	round.status = maintained.status
	if (maintained.status !== 'ready') {
		if (maintained.status === 'settling') {
			console.log({ event: 'kopje.remote_media.settling' })
		}
		return round
	}
	const { counts } = maintained
	if (Object.values(counts).some((n) => n > 0)) {
		console.log({ event: 'kopje.remote_media.maintained', ...counts })
	}
	if (maintained.drift !== null) {
		console.warn({ event: 'kopje.remote_media.drift_found', ...maintained.drift })
	}
	console.log({ event: 'kopje.remote_media.usage', ...maintained.usage })
	try {
		await deleteDoomed(maintained.deletions)
		await validate(maintained.validation)
		if (maintained.sweep !== null) {
			await sweep(maintained.sweep)
		}
	} catch (error) {
		if (!(error instanceof DeadlinePassed)) {
			console.error({ event: 'kopje.remote_media.maintenance_failed', ...errorFields(error) })
		}
	}

	async function deleteDoomed(deletions: RemoteMediaMaintenance['deletions']): Promise<void> {
		if (deletions.length === 0) {
			return
		}
		const by = admitted(R2_DELETE_MS, maintenanceEnd, deps.now)
		if (by === null) {
			return
		}
		let deleted = false
		try {
			await bounded(() => bucket.delete(deletions.flatMap((deletion) => deletion.keys)), by, deps.now)
			deleted = true
		} catch (error) {
			if (!(error instanceof DeadlinePassed)) {
				console.warn({ event: 'kopje.remote_media.delete_failed', ...errorFields(error) })
			}
		}
		const tokens = deletions.map((deletion) => deletion.token)
		const confirmed = await store((s) => s.confirmRemoteMediaDeleted(build, { tokens, deleted }), maintenanceEnd)
		round.deleted = confirmed.confirmed
	}

	async function validate(objects: RemoteMediaMaintenance['validation']): Promise<void> {
		const results: { token: string; missing: boolean }[] = []
		for (const object of objects) {
			let missing = false
			for (const key of object.keys) {
				const by = admitted(R2_HEAD_MS, maintenanceEnd, deps.now)
				if (by === null) {
					break
				}
				const head = await bounded(() => bucket.head(key), by, deps.now)
				missing ||= head === null
			}
			results.push({ token: object.token, missing })
		}
		if (results.length > 0) {
			await store((s) => s.recordRemoteMediaValidation(build, { results }), maintenanceEnd)
			round.validated = results.length
		}
	}

	async function sweep(cursor: string): Promise<void> {
		const by = admitted(R2_DELETE_MS, maintenanceEnd, deps.now)
		if (by === null) {
			return
		}
		const listed = await bounded(
			() => bucket.list({ prefix: 'remote/', limit: 1000, ...(cursor === '' ? {} : { cursor }) }),
			by,
			deps.now
		)
		const keys = listed.objects.map((object) => ({ key: object.key, uploaded: object.uploaded.getTime() }))
		const next = listed.truncated ? listed.cursor : null
		const { orphans } = await store((s) => s.remoteMediaOrphans(build, { keys, cursor: next }), maintenanceEnd)
		const deleteBy = orphans.length === 0 ? null : admitted(R2_DELETE_MS, maintenanceEnd, deps.now)
		if (deleteBy !== null) {
			await bounded(() => bucket.delete(orphans), deleteBy, deps.now)
			round.orphans = orphans.length
		}
	}

	// ---- Fetches
	if (running.size > 0) {
		round.stopped = true
		return round
	}
	const token = deps.randomToken ?? randomToken
	const tokens = Array.from({ length: LANE0_CLAIMS }, token)
	let claimed: RemoteMediaClaims
	try {
		claimed = await store((s) => s.claimRemoteMedia(build, { tokens, cap }) as Promise<RemoteMediaClaims>, fetchEnd)
	} catch (error) {
		if (!(error instanceof DeadlinePassed)) {
			console.error({ event: 'kopje.remote_media.claim_failed', ...errorFields(error) })
		}
		return round
	}
	if (claimed.expired > 0 || claimed.dropped > 0 || claimed.deferred > 0) {
		console.log({
			event: 'kopje.remote_media.claimed',
			expired: claimed.expired,
			dropped: claimed.dropped,
			deferred: claimed.deferred,
		})
	}
	if (claimed.domain === null || claimed.claims.length === 0) {
		return round
	}
	round.claimed = claimed.claims.length
	const domain = claimed.domain
	const fetchFile = deps.fetchRemoteFile ?? fetchRemoteFile
	const dns = deps.loader.checkHost ?? dnsCheckHost
	const budget = { subrequests: REMOTE_MEDIA_SUBREQUESTS, storeCalls: REMOTE_MEDIA_POLICY_CALLS, deadline: fetchEnd }
	const fence = (claim: RemoteMediaClaim): RemoteMediaFence => ({
		slot: claim.slot,
		claim: claim.claim,
		generation: claim.generation,
		token: claim.token,
	})
	// An admission before a put: the env's maintenance first, then the Store's write under the fence.
	const admit = async (claim: RemoteMediaClaim, hosts: string[], until: number): Promise<boolean> => {
		try {
			return (await store((s) => s.admitRemoteMedia(build, { ...fence(claim), hosts }), until)).held
		} catch {
			return false
		}
	}

	const runClaim = async (claim: RemoteMediaClaim): Promise<ClaimResult> => {
		const deadline = Math.min(fetchEnd, deps.now() + WEB_MEDIA_TIMEOUT_MS)
		const file: RemoteFile | RemoteFileFailure = await fetchFile(
			claim.url,
			{
				fetch: deps.loader.fetch,
				checkHost: dns,
				admit: (host) => rpc((s) => s.webHopRefused(build, { host })),
				domain,
				now: deps.now,
			},
			{ kind: claim.kind, category: claim.category, deadline, budget }
		)
		if (!file.ok) {
			return { outcome: failedOutcome(file, deadline, deps.now()), step: file.kind, host: file.host }
		}
		if (file.mode !== 'buffered') {
			// Streamed kinds are not claimed by this release (lane 1).
			await file.body.cancel().catch(() => {})
			return { outcome: { kind: 'failed', permanent: true }, step: 'mode', host: null }
		}
		const host = file.hosts.at(-1) ?? null
		const put = async (key: string, bytes: Uint8Array, contentType: string): Promise<boolean> => {
			const by = Math.min(deadline, deps.now() + PUT_MS)
			if (by <= deps.now() || envMaintenance(env)) {
				return false
			}
			try {
				await bounded(() => bucket.put(key, bytes, { httpMetadata: { contentType } }), by, deps.now)
				return true
			} catch (error) {
				if (!(error instanceof DeadlinePassed)) {
					console.warn({ event: 'kopje.remote_media.put_failed', ...errorFields(error) })
				}
				return false
			}
		}
		if (!(await admit(claim, file.hosts, deadline))) {
			return { outcome: { kind: 'unattempted' }, step: 'admission', host }
		}
		if (!(await put(`remote/${claim.token}/full`, file.bytes, file.type))) {
			return { outcome: { kind: 'failed', permanent: false }, step: 'put', host }
		}
		if (file.still !== null) {
			if (!(await admit(claim, file.hosts, deadline))) {
				return { outcome: { kind: 'partial' }, step: 'admission', host }
			}
			if (!(await put(`remote/${claim.token}/still`, file.still.bytes, file.still.type))) {
				return { outcome: { kind: 'partial' }, step: 'put', host }
			}
		}
		return {
			outcome: {
				kind: 'stored',
				contentType: file.type,
				stillType: file.still?.type ?? null,
				bytes: file.bytes.byteLength + (file.still?.bytes.byteLength ?? 0),
				hosts: file.hosts,
				category: 'image',
			},
			step: 'stored',
			host,
		}
	}

	const record = (claim: RemoteMediaClaim, outcome: RemoteMediaOutcome) =>
		store((s) => s.recordRemoteMedia(build, { ...fence(claim), outcome }), end)

	const queue = [...claimed.claims]
	const worker = async () => {
		for (let claim = queue.shift(); claim !== undefined; claim = queue.shift()) {
			if (round.stopped || running.size > 0 || deps.now() >= fetchEnd) {
				round.stopped = true
				queue.unshift(claim)
				return
			}
			let result: ClaimResult
			try {
				result = await runClaim(claim)
			} catch (error) {
				// The claim stays open and is claimed again after its hold.
				round.lost++
				if (!(error instanceof DeadlinePassed)) {
					console.error({ event: 'kopje.remote_media.claim_failed', ...errorFields(error) })
				}
				continue
			}
			if (result.step !== 'stored') {
				console.log({ event: 'kopje.remote_media.no_file', kind: claim.kind, step: result.step, host: result.host })
			}
			try {
				if ((await record(claim, result.outcome)).held) {
					const kind = result.outcome.kind
					if (kind === 'stored') {
						round.stored++
					} else if (kind === 'unattempted') {
						round.unattempted++
					} else {
						round.failed++
					}
				} else {
					round.lost++
				}
			} catch (error) {
				round.lost++
				if (!(error instanceof DeadlinePassed)) {
					console.error({ event: 'kopje.remote_media.record_failed', ...errorFields(error) })
				}
			}
		}
	}
	await Promise.all(Array.from({ length: LANE0_CONCURRENCY }, worker))
	for (const claim of queue) {
		try {
			if ((await record(claim, { kind: 'unattempted' })).held) {
				round.released++
			}
		} catch (error) {
			if (!(error instanceof DeadlinePassed)) {
				console.error({ event: 'kopje.remote_media.release_failed', ...errorFields(error) })
			}
			break
		}
	}
	return round
}
