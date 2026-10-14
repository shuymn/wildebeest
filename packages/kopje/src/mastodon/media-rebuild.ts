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
// stripped, long edge capped, a preview); the Store records the real sizes in meta; only then are
// files/<token>/{full,small} written; and once both writes have completed the Store is asked whether the row is still
// live. A row deleted meanwhile (delete_media, then the sweep, which deletes its objects before the row) may have had
// its objects deleted before these writes landed, and a swept row that had completed leaves no tombstone, so nothing
// else would delete them: the rebuild deletes them itself. A deletion after that answer comes after the writes, so the
// sweep's own deletes remove the files. Images refusing for quota (9422) or the monthly budget being spent stops the
// call.
//
// Bounds per call: one listing (at most SCAN_WINDOW rows scanned, REBUILD_PAGE candidates) and at most
// MAX_BUILDS_PER_CALL re-encoded, one at a time (an original is at most 16 MB), so a call stays within a request's
// subrequests and memory.

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
	const page = await store.mediaRebuildCandidates(build, { after: input.after, now: deps.now() })
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

	for (const row of page.rows) {
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
		// The object's size, also for a ranged read: a dry run reports what the real run would.
		if (original.size > IMAGE_SIZE_LIMIT) {
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
		const keys = [fileKey(row.token, 'full'), fileKey(row.token, 'small')] as const
		await bucket.put(keys[0], full.bytes, { httpMetadata: { contentType: full.contentType } })
		await bucket.put(keys[1], small.bytes, { httpMetadata: { contentType: small.contentType } })
		// The row may have been doomed and swept while the files were written; the sweep's deletes may then have run
		// before these writes landed. Both writes have completed, so asking now settles it: a row that is still live
		// has its files, and any deletion after this answer deletes them through the sweep; a row that went gets its
		// files deleted here, so nothing serves them again.
		if (!(await store.mediaRebuildRowLive(build, { id: row.id, token: row.token, now: deps.now() }))) {
			await bucket.delete([...keys])
			counts.gone++
			handled = row.id
			continue
		}
		counts.built++
		handled = row.id
	}
	handled = page.next
	return step(null, page.done)
}
