import { REBUILD_PAGE } from '../domain/media-rebuild'
import { sniffImageType } from '../platform/image-bytes'
import { type ImageCodec, IMAGE_SIZE_LIMIT, processImage, servedTypeOf } from '../platform/images'
import { fileKey, MEDIA_VARIANTS, originalKey } from '../platform/media-files'
import type { ImportAuthority } from '../platform/store-admin'
import type { StoreStub } from '../platform/store-client'

// Rebuilds the served files of local media from their originals (domain/media-rebuild.ts), one bounded call at a time
// from /admin/media/rebuild; the CLI (`kopje-admin media-rebuild`) follows the cursor to the end. A row whose two files
// exist is skipped, so running it again resumes, and a finished run changes nothing.
//
// Each row that lacks a file: its original is read from originals/<id>; the original's type must be served as the
// row's content_type (its URLs name that type, so a mismatch is reported and left alone, never rewritten); the
// instance's transformation budget is charged; processImage re-encodes it as an upload does (MEDIA-3: metadata
// stripped, long edge capped, a preview); the Store records the real sizes in meta; and only then are
// files/<token>/{full,small} written. Images refusing for quota (9422) or the monthly budget being spent stops the call.
//
// Bounds per call: at most REBUILD_PAGE rows are looked at and at most MAX_BUILDS_PER_CALL are re-encoded, one at a
// time (an original is at most 16 MB), so a call stays within a request's subrequests and memory.

export const MAX_BUILDS_PER_CALL = 10

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
			// quota: Images refused (9422); budget: IMAGES_MONTHLY_TRANSFORMS is spent this month.
			stopped: 'quota' | 'budget' | null
	  }
	| { ok: false; code: 'wrong-authority'; message: string }

export type RebuildDeps = {
	build: string
	store: StoreStub
	bucket: R2Bucket
	images: ImageCodec
	now: () => number
	authority: ImportAuthority
	monthlyTransforms: number
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
	const { build, store, bucket } = deps
	const rows = await store.mediaRebuildCandidates(build, { after: input.after, now: deps.now() })
	const counts = emptyCounts()
	const problems: RebuildProblem[] = []
	let builds = 0
	// The last row handled; a stop leaves the row it stopped at for the next call.
	let handled = input.after
	const step = (stopped: 'quota' | 'budget' | null, done: boolean): RebuildStep => ({
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

	for (const row of rows) {
		const heads = await Promise.all(MEDIA_VARIANTS.map((variant) => bucket.head(fileKey(row.token, variant))))
		if (heads.every((head) => head !== null)) {
			counts['skipped-existing']++
			handled = row.id
			continue
		}
		if (!input.dryRun && builds >= MAX_BUILDS_PER_CALL) {
			return step(null, false)
		}
		const original = await bucket.get(
			originalKey(row.id),
			input.dryRun ? { range: { offset: 0, length: SIGNATURE_BYTES } } : undefined
		)
		if (original === null) {
			report({ id: row.id, outcome: 'original-missing' })
			handled = row.id
			continue
		}
		if (!input.dryRun && original.size > IMAGE_SIZE_LIMIT) {
			await original.body.cancel()
			report({ id: row.id, outcome: 'failed', detail: 'too_large' })
			handled = row.id
			continue
		}
		const bytes = new Uint8Array(await original.arrayBuffer())
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
		if (input.dryRun) {
			counts['would-build']++
			handled = row.id
			continue
		}
		builds++
		const charged = await store.chargeMediaRebuild(build, {
			authority: deps.authority,
			limit: deps.monthlyTransforms,
			now: deps.now(),
		})
		if (charged.status === 'denied') {
			return { ok: false, code: 'wrong-authority', message: charged.reason }
		}
		if (charged.status === 'budget_exhausted') {
			return step('budget', false)
		}
		const processed = await processImage(deps.images, bytes)
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
		const recorded = await store.recordMediaRebuild(build, {
			authority: deps.authority,
			id: row.id,
			token: row.token,
			contentType: full.contentType,
			original: { width: full.width, height: full.height },
			small: { width: small.width, height: small.height },
			now: deps.now(),
		})
		if (recorded.status === 'denied') {
			return { ok: false, code: 'wrong-authority', message: recorded.reason }
		}
		if (recorded.status === 'gone') {
			counts.gone++
			handled = row.id
			continue
		}
		await bucket.put(fileKey(row.token, 'full'), full.bytes, { httpMetadata: { contentType: full.contentType } })
		await bucket.put(fileKey(row.token, 'small'), small.bytes, { httpMetadata: { contentType: small.contentType } })
		counts.built++
		handled = row.id
	}
	return step(null, rows.length < REBUILD_PAGE)
}
