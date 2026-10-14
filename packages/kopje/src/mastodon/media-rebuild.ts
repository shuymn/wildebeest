import {
	REBUILD_LEASE_MS,
	type RebuildCharge,
	type RebuildLeaseResult,
	type RebuildRecord,
} from '../domain/media-rebuild'
import { DeadlinePassed, within } from '../platform/deadline'
import { sniffImageType } from '../platform/image-bytes'
import { type ImageCodec, IMAGE_SIZE_LIMIT, processImage, servedTypeOf } from '../platform/images'
import { fileKey, MEDIA_VARIANTS, originalKey } from '../platform/media-files'
import type { ImportAuthority } from '../platform/store-admin'
import type { StoreStub } from '../platform/store-client'

// Rebuilds the served files of local media from their originals (domain/media-rebuild.ts), one bounded call at a time
// from /admin/media/rebuild; the CLI (`kopje-admin media-rebuild`) follows the cursor to the end. A row whose two files
// exist is skipped, so running it again resumes, and a finished run changes nothing.
//
// A call that writes runs only while nothing can delete media (the Store unpublished after a verified import, or in
// readonly maintenance that began at least REBUILD_SETTLE_MS ago; otherwise `rebuild-needs-readonly` or
// `rebuild-settling`), and holds the Store's rebuild lease, so one call runs at a time (`rebuild-busy`) and, while it
// runs, the Store refuses every media-deleting write, leaving maintenance, imports, resets and publication. The env
// MAINTENANCE is not seen by the Store: the operator must not change it during a rebuild. A dry run writes nothing and
// takes no lease.
//
// The lease (REBUILD_LEASE_MS, at the Store's clock) is renewed before each row. Within a row, steps without a lasting
// effect (R2 reads, Images, Store calls, whose writes check the lease again) are given up LEASE_MARGIN_MS before the
// renewed lease would end; R2 writes and deletes are never given up: each is awaited to completion while a heartbeat
// renews the lease every REBUILD_HEARTBEAT_MS, so the lease cannot end under a write this call started while the call
// runs. If a renewal fails while a write is pending, the call reports `lease-overrun` and does not release the lease.
// A call that gave up a step keeps the lease until it expires. The bound: per row, at most two R2 reads, five Images
// calls and five Store calls, each given up within the lease, then at most three R2 writes, each awaited.
//
// Each row that lacks a file: its original is read from originals/<id>; the original's type must be served as the
// row's content_type (its URLs name that type, so a mismatch is reported and left alone, never rewritten); the
// instance's transformation budget is charged; processImage re-encodes it as an upload does (MEDIA-3: metadata
// stripped, long edge capped, a preview); the Store records the real sizes in meta; only then are
// files/<token>/{full,small} written; and once both writes have completed the Store is asked whether the row is still
// live, and the files are deleted again if it is not (defence in depth: nothing deletes rows while the rebuild may
// run). Images refusing for quota (9422) or the monthly budget being spent stops the call.
//
// Bounds per call: one listing (at most SCAN_WINDOW rows scanned, REBUILD_PAGE candidates) and at most
// MAX_BUILDS_PER_CALL re-encoded, one at a time (an original is at most 16 MB), so a call stays within a request's
// subrequests and memory.

export const MAX_BUILDS_PER_CALL = 10

// What a row leaves of its renewed lease unused, against clock differences between the Worker and the Store.
const LEASE_MARGIN_MS = 60_000
export const REBUILD_HEARTBEAT_MS = 60_000

export type RebuildOutcome =
	'built' | 'would-build' | 'skipped-existing' | 'original-missing' | 'type-mismatch' | 'failed' | 'gone'

// Rows an operator has to look at: the original is missing, its type does not match the row, or re-encoding failed.
export type RebuildProblem = { id: string; outcome: 'original-missing' | 'type-mismatch' | 'failed'; detail?: string }

export type RebuildStep =
	| {
			ok: true
			counts: Record<RebuildOutcome, number>
			problems: RebuildProblem[]
			// True when the call reached the last row; otherwise the next call continues after `next` (null: from the
			// start).
			done: boolean
			next: string | null
			// quota: Images refused (9422); budget: IMAGES_MONTHLY_TRANSFORMS is spent this month; deadline: a step was
			// given up (the lease is kept until it expires); lease-overrun: the lease could not be renewed while a write
			// was pending (it is not released).
			stopped: 'quota' | 'budget' | 'deadline' | 'lease-overrun' | null
	  }
	| {
			ok: false
			code: 'wrong-authority' | 'rebuild-needs-readonly' | 'rebuild-settling' | 'rebuild-busy' | 'rebuild-lease-lost'
			message: string
			readyAt?: number
	  }

export type RebuildDeps = {
	build: string
	store: StoreStub
	bucket: R2Bucket
	images: ImageCodec
	now: () => number
	authority: ImportAuthority
	monthlyTransforms: number
	// The lease holder of this call (a fresh id by default), and the heartbeat while a write is pending.
	holder?: string
	heartbeatMs?: number
}

class Refused extends Error {
	constructor(
		readonly code: 'wrong-authority' | 'rebuild-lease-lost',
		message: string
	) {
		super(message)
	}
}

function emptyCounts(): Record<RebuildOutcome, number> {
	return {
		built: 0,
		'would-build': 0,
		'skipped-existing': 0,
		'original-missing': 0,
		'type-mismatch': 0,
		failed: 0,
		gone: 0,
	}
}

// The longest signature sniffImageType reads.
const SIGNATURE_BYTES = 16

export async function rebuildMedia(
	deps: RebuildDeps,
	input: { after: string | null; dryRun: boolean }
): Promise<RebuildStep> {
	const { build, store, now } = deps
	if (input.dryRun) {
		return pass(deps, input, null)
	}
	const holder = deps.holder ?? crypto.randomUUID()
	const lease = async (release: boolean): Promise<RebuildLeaseResult> =>
		await store.mediaRebuildLease(build, { authority: deps.authority, holder, release })
	const taken = await within(() => lease(false), now() + REBUILD_LEASE_MS - LEASE_MARGIN_MS, now)
	switch (taken.status) {
		case 'denied':
			return { ok: false, code: 'wrong-authority', message: taken.reason }
		case 'needs-readonly':
			return {
				ok: false,
				code: 'rebuild-needs-readonly',
				message:
					'media-rebuild writes only before publication or in the Store maintenance (kopje-admin maintenance on, then wait 20 minutes)',
			}
		case 'settling':
			return {
				ok: false,
				code: 'rebuild-settling',
				message: `maintenance began too recently; media-rebuild writes from ${new Date(taken.readyAt).toISOString()}`,
				readyAt: taken.readyAt,
			}
		case 'busy':
			return { ok: false, code: 'rebuild-busy', message: 'another media-rebuild call holds the lease; try again' }
		case 'released':
		case 'ok':
			break
	}
	const control: Lease = { holder, lease, lost: false }
	let result: RebuildStep | undefined
	try {
		result = await pass(deps, input, control)
		return result
	} finally {
		// Kept when a step was given up (it may still land) or when the lease could not be renewed under a write.
		const keep = result?.ok === true && (result.stopped === 'deadline' || result.stopped === 'lease-overrun')
		if (!keep && !control.lost) {
			await within(() => lease(true), now() + LEASE_MARGIN_MS, now).catch(() => {})
		}
	}
}

type Lease = { holder: string; lease: (release: boolean) => Promise<RebuildLeaseResult>; lost: boolean }

async function pass(
	deps: RebuildDeps,
	input: { after: string | null; dryRun: boolean },
	control: Lease | null
): Promise<RebuildStep> {
	const { build, store, bucket, now } = deps
	let deadline = now() + REBUILD_LEASE_MS - LEASE_MARGIN_MS
	const bounded = <T>(work: () => Promise<T>) => within(work, deadline, now)
	// Renews the lease (a row then has the whole lease); the deadline follows the time the Store grants.
	const renew = async (): Promise<number> => {
		const asked = now()
		const renewed = await within(() => control!.lease(false), deadline, now)
		if (renewed.status !== 'ok') {
			throw new Refused('rebuild-lease-lost', 'the rebuild lease could not be renewed')
		}
		deadline = asked + renewed.remainingMs - LEASE_MARGIN_MS
		return renewed.remainingMs
	}
	// An R2 write or delete: never given up. The lease is renewed meanwhile; a failed renewal marks it lost.
	const settled = async <T>(work: Promise<T>): Promise<T> => {
		if (control === null) {
			return work
		}
		const timer = setInterval(() => {
			control.lease(false).then(
				(renewed) => {
					if (renewed.status !== 'ok') {
						control.lost = true
					}
				},
				() => {
					control.lost = true
				}
			)
		}, deps.heartbeatMs ?? REBUILD_HEARTBEAT_MS)
		try {
			return await work
		} finally {
			clearInterval(timer)
		}
	}
	const counts = emptyCounts()
	const problems: RebuildProblem[] = []
	let builds = 0
	// The last row handled; a stop leaves the row it stopped at for the next call.
	let handled = input.after
	const step = (stopped: 'quota' | 'budget' | 'deadline' | 'lease-overrun' | null, done: boolean): RebuildStep => ({
		ok: true,
		counts,
		problems,
		done,
		next: handled,
		stopped,
	})
	const report = (problem: RebuildProblem) => {
		counts[problem.outcome]++
		problems.push(problem)
	}
	try {
		const page = await bounded(() => store.mediaRebuildCandidates(build, { after: input.after }))
		for (const row of page.rows) {
			if (control !== null) {
				await renew()
			}
			const heads = await bounded(() =>
				Promise.all(MEDIA_VARIANTS.map((variant) => bucket.head(fileKey(row.token, variant))))
			)
			if (heads.every((head) => head !== null)) {
				counts['skipped-existing']++
				handled = row.id
				continue
			}
			if (control !== null && builds >= MAX_BUILDS_PER_CALL) {
				return step(null, false)
			}
			const original = await bounded(() =>
				bucket.get(
					originalKey(row.id),
					control === null ? { range: { offset: 0, length: SIGNATURE_BYTES } } : undefined
				)
			)
			if (original === null) {
				report({ id: row.id, outcome: 'original-missing' })
				handled = row.id
				continue
			}
			// The object's size, also for a ranged read: a dry run reports what the real run would.
			if (original.size > IMAGE_SIZE_LIMIT) {
				await original.body.cancel()
				report({ id: row.id, outcome: 'failed', detail: 'too_large' })
				handled = row.id
				continue
			}
			const bytes = new Uint8Array(await bounded(() => original.arrayBuffer()))
			const type = sniffImageType(bytes)
			if (type === null) {
				report({ id: row.id, outcome: 'failed', detail: 'unsupported' })
				handled = row.id
				continue
			}
			if (servedTypeOf(type) !== row.contentType) {
				report({ id: row.id, outcome: 'type-mismatch', detail: `${type} is served as ${servedTypeOf(type)}` })
				handled = row.id
				continue
			}
			if (control === null) {
				counts['would-build']++
				handled = row.id
				continue
			}
			builds++
			const charged = await bounded<RebuildCharge>(
				async () =>
					await store.chargeMediaRebuild(build, {
						authority: deps.authority,
						holder: control.holder,
						limit: deps.monthlyTransforms,
					})
			)
			if (charged.status === 'denied') {
				throw new Refused('wrong-authority', charged.reason)
			}
			if (charged.status === 'lease-lost') {
				throw new Refused('rebuild-lease-lost', 'the rebuild lease expired during the call')
			}
			if (charged.status === 'budget_exhausted') {
				return step('budget', false)
			}
			const processed = await bounded(() => processImage(deps.images, bytes))
			if (!processed.ok) {
				if (processed.reason === 'quota') {
					return step('quota', false)
				}
				report({ id: row.id, outcome: 'failed', detail: processed.detail ?? processed.reason })
				handled = row.id
				continue
			}
			const { full, small } = processed.image
			if (full.contentType !== row.contentType || small.contentType !== row.contentType) {
				report({ id: row.id, outcome: 'type-mismatch', detail: `re-encoded as ${full.contentType}` })
				handled = row.id
				continue
			}
			const recorded = await bounded<RebuildRecord>(
				async () =>
					await store.recordMediaRebuild(build, {
						authority: deps.authority,
						holder: control.holder,
						id: row.id,
						token: row.token,
						contentType: full.contentType,
						original: { width: full.width, height: full.height },
						small: { width: small.width, height: small.height },
					})
			)
			if (recorded.status === 'denied') {
				throw new Refused('wrong-authority', recorded.reason)
			}
			if (recorded.status === 'lease-lost') {
				throw new Refused('rebuild-lease-lost', 'the rebuild lease expired during the call')
			}
			if (recorded.status === 'gone') {
				counts.gone++
				handled = row.id
				continue
			}
			const keys = [fileKey(row.token, 'full'), fileKey(row.token, 'small')] as const
			await settled(bucket.put(keys[0], full.bytes, { httpMetadata: { contentType: full.contentType } }))
			await settled(bucket.put(keys[1], small.bytes, { httpMetadata: { contentType: small.contentType } }))
			// Defence in depth: nothing deletes rows while a rebuild holds the lease, but if the row went while the files
			// were written, they are deleted again so nothing serves them.
			const live = await bounded(() => store.mediaRebuildRowLive(build, { id: row.id, token: row.token }))
			if (!live) {
				await settled(bucket.delete([...keys]))
				counts.gone++
			} else {
				counts.built++
			}
			handled = row.id
			if (control.lost) {
				return step('lease-overrun', false)
			}
		}
		handled = page.next
		return step(null, page.done)
	} catch (error) {
		if (error instanceof DeadlinePassed) {
			return step(control?.lost === true ? 'lease-overrun' : 'deadline', false)
		}
		if (error instanceof Refused) {
			return { ok: false, code: error.code, message: error.message }
		}
		throw error
	}
}
