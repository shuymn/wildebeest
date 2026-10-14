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
// A call that writes runs only while nothing can delete media (the Store unpublished or in readonly maintenance, or
// the env MAINTENANCE readonly or full; otherwise `rebuild-needs-readonly`), and holds the Store's rebuild lease, so
// one call runs at a time (`rebuild-busy`) and no import, reset or publication starts meanwhile. The call's deadline
// is LEASE_MARGIN_MS before the lease ends: every awaited step (R2, Images, the Store) is given up at it and nothing
// new starts after it, and a call that gave up a step keeps the lease until it expires, since what it began may still
// land. A dry run writes nothing and takes no lease.
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

// What the call leaves of the lease unused, against clock differences between the Worker and the Store.
const LEASE_MARGIN_MS = 60_000
// No new row is started once less than this is left before the deadline.
const ROW_BUDGET_MS = 60_000

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
			// given up at the call's deadline (the lease is kept until it expires).
			stopped: 'quota' | 'budget' | 'deadline' | null
	  }
	| {
			ok: false
			code: 'wrong-authority' | 'rebuild-needs-readonly' | 'rebuild-busy' | 'rebuild-lease-lost'
			message: string
	  }

export type RebuildDeps = {
	build: string
	store: StoreStub
	bucket: R2Bucket
	images: ImageCodec
	now: () => number
	authority: ImportAuthority
	monthlyTransforms: number
	// The env MAINTENANCE is readonly or full.
	envHeld: boolean
	// The lease holder of this call (a fresh id by default).
	holder?: string
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
	const started = now()
	const leaseEnd = started + REBUILD_LEASE_MS
	const deadline = leaseEnd - LEASE_MARGIN_MS
	if (input.dryRun) {
		return pass(deps, input, null, deadline)
	}
	const holder = deps.holder ?? crypto.randomUUID()
	const lease = async (release: boolean): Promise<RebuildLeaseResult> =>
		await store.mediaRebuildLease(build, {
			authority: deps.authority,
			holder,
			release,
			envHeld: deps.envHeld,
			now: now(),
		})
	const taken = await within(() => lease(false), deadline, now)
	switch (taken.status) {
		case 'denied':
			return { ok: false, code: 'wrong-authority', message: taken.reason }
		case 'needs-readonly':
			return {
				ok: false,
				code: 'rebuild-needs-readonly',
				message:
					'media-rebuild runs only while the Store refuses other writes: before publication, or in maintenance (kopje-admin maintenance on, or MAINTENANCE=readonly)',
			}
		case 'busy':
			return { ok: false, code: 'rebuild-busy', message: 'another media-rebuild call holds the lease; try again' }
		case 'ok':
			break
	}
	let result: RebuildStep | undefined
	try {
		result = await pass(deps, input, holder, deadline)
		return result
	} finally {
		// A step given up at the deadline may still land: the lease is kept until it expires.
		if (result === undefined || !(result.ok && result.stopped === 'deadline')) {
			await within(() => lease(true), leaseEnd, now).catch(() => {})
		}
	}
}

async function pass(
	deps: RebuildDeps,
	input: { after: string | null; dryRun: boolean },
	holder: string | null,
	deadline: number
): Promise<RebuildStep> {
	const { build, store, bucket, now } = deps
	const bounded = <T>(work: () => Promise<T>) => within(work, deadline, now)
	const counts = emptyCounts()
	const problems: RebuildProblem[] = []
	let builds = 0
	// The last row handled; a stop leaves the row it stopped at for the next call.
	let handled = input.after
	const step = (stopped: 'quota' | 'budget' | 'deadline' | null, done: boolean): RebuildStep => ({
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
		const page = await bounded(() => store.mediaRebuildCandidates(build, { after: input.after, now: now() }))
		for (const row of page.rows) {
			if (now() > deadline - ROW_BUDGET_MS) {
				return step(null, false)
			}
			const heads = await bounded(() =>
				Promise.all(MEDIA_VARIANTS.map((variant) => bucket.head(fileKey(row.token, variant))))
			)
			if (heads.every((head) => head !== null)) {
				counts['skipped-existing']++
				handled = row.id
				continue
			}
			if (holder !== null && builds >= MAX_BUILDS_PER_CALL) {
				return step(null, false)
			}
			const original = await bounded(() =>
				bucket.get(originalKey(row.id), holder === null ? { range: { offset: 0, length: SIGNATURE_BYTES } } : undefined)
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
			if (holder === null) {
				counts['would-build']++
				handled = row.id
				continue
			}
			builds++
			const charged = await bounded<RebuildCharge>(
				async () =>
					await store.chargeMediaRebuild(build, {
						authority: deps.authority,
						holder,
						limit: deps.monthlyTransforms,
						now: now(),
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
						holder,
						id: row.id,
						token: row.token,
						contentType: full.contentType,
						original: { width: full.width, height: full.height },
						small: { width: small.width, height: small.height },
						now: now(),
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
			await bounded(() => bucket.put(keys[0], full.bytes, { httpMetadata: { contentType: full.contentType } }))
			await bounded(() => bucket.put(keys[1], small.bytes, { httpMetadata: { contentType: small.contentType } }))
			// Defence in depth: nothing deletes rows while a rebuild may run, but if the row went while the files were
			// written, they are deleted again so nothing serves them.
			if (!(await bounded(() => store.mediaRebuildRowLive(build, { id: row.id, token: row.token, now: now() })))) {
				await bounded(() => bucket.delete([...keys]))
				counts.gone++
				handled = row.id
				continue
			}
			counts.built++
			handled = row.id
		}
		handled = page.next
		return step(null, page.done)
	} catch (error) {
		if (error instanceof DeadlinePassed) {
			return step('deadline', false)
		}
		if (error instanceof Refused) {
			return { ok: false, code: error.code, message: error.message }
		}
		throw error
	}
}
