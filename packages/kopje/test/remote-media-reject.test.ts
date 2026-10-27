import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { blockDomain, setRejectMedia } from './domain-block-helpers'
import { plannedRun, scansOf, staleStatistics } from './read-helpers'
import { backfillDone, maintain, mediaWorld, type MediaWorld, noteEmoji, snapshot } from './remote-media-helpers'
import { MAX_BLOCK_LABELS } from '../src/domain/audience'
import {
	admitRemoteMedia,
	claimRemoteMedia,
	LANE0_CLAIMS,
	maintainRemoteMedia,
	recordRemoteMedia,
	type RemoteMediaClaim,
	type RemoteMediaOutcome,
	syncAttachmentFiles,
	VALIDITY_WALK,
} from '../src/domain/remote-media'

// R38 reject_media in the cache of remote media (domain/remote-media.ts slotEligibleSql, audience.ts
// mediaRejectedSql; Mastodon's DomainBlock.reject_media?): a domain whose rule has reject_media gets nothing enqueued,
// claimed or recorded, and the validity walk retires what is cached of it. Each refusal has a control on another
// domain that the same call serves.

const CAP = 4 * 1024 * 1024 * 1024
let tokens = 0
const token = () => `J${String(++tokens).padStart(42, '0')}`

const claim = (w: MediaWorld) =>
	w.op(claimRemoteMedia, { now: w.clock.now, tokens: Array.from({ length: LANE0_CLAIMS }, token), cap: CAP })

const fence = (c: RemoteMediaClaim) => ({ slot: c.slot, claim: c.claim, generation: c.generation, token: c.token })

const stored: RemoteMediaOutcome = {
	kind: 'stored',
	contentType: 'image/png',
	stillType: null,
	bytes: 10,
	hosts: ['files.example'],
	category: 'image',
}

const record = (w: MediaWorld, c: RemoteMediaClaim) =>
	w.op(recordRemoteMedia, { ...fence(c), outcome: stored, now: w.clock.now })

const rejectMedia = (w: MediaWorld, domain: string) => blockDomain(w.t.store, domain, 'noop', { rejectMedia: true })

// Every slot claimed and stored, so the walk has files to retire.
async function storeAll(w: MediaWorld): Promise<void> {
	for (const c of (await claim(w)).claims) {
		expect(await record(w, c), c.url).toEqual({ held: true })
	}
}

// The slots by owner (an account or attachment id) or, for an emoji, its domain, with whether each holds a file.
async function slotsOf(w: MediaWorld): Promise<string[]> {
	const rows = await sql<{ kind: string; who: string; url: string; token: string | null }>(
		w.t.store,
		'SELECT kind, coalesce(owner_id, domain) AS who, url, token FROM remote_media ORDER BY kind, who, url'
	)
	return rows.map((r) => `${r.kind} ${r.who} ${r.url}${r.token === null ? '' : ' stored'}`)
}

describe('reject_media (R38) in the remote media cache', () => {
	it('enqueues nothing of an account, an attachment author or an emoji domain whose rule rejects media', async () => {
		const w = await mediaWorld()
		await backfillDone(w)
		await rejectMedia(w, 'rejected.example')
		const rejected = await w.remote({}, 'rejected.example')
		const kept = await w.remote({})
		const shot = snapshot('https://files.example/e/1.png')
		await noteEmoji(w, shot, 'rejected.example')
		await noteEmoji(w, shot, 'files.example')
		await w.attach(rejected.id, 'https://files.example/m/r.png')
		const keptMedia = (await w.attach(kept.id, 'https://files.example/m/k.png')).media
		expect(await slotsOf(w)).toEqual([
			`attachment ${keptMedia} https://files.example/m/k.png`,
			`avatar ${kept.id} ${kept.avatar}`,
			'emoji files.example https://files.example/e/1.png',
		])
		await w.exact()
	})

	it('removes the slots of an account or attachment at its next sync once its domain rejects media', async () => {
		const w = await mediaWorld()
		await backfillDone(w)
		const account = await w.remote({}, 'later.example')
		const { media } = await w.attach(account.id, 'https://files.example/m/l.png')
		await storeAll(w)
		expect(await slotsOf(w)).toHaveLength(2)
		await rejectMedia(w, 'later.example')
		await w.change(account.id, { avatar: account.avatar, header: null })
		// The status writer's sync of the same row (remote-statuses.ts writeMedia).
		await w.db((d) => syncAttachmentFiles(d, media, w.clock.now))
		expect(await slotsOf(w)).toEqual([])
		expect((await w.objects()).map((o) => o.state)).toEqual(['doomed', 'doomed'])
		await w.exact()
	})

	it('backfills nothing of a domain whose rule rejects media, in every phase', async () => {
		const w = await mediaWorld()
		const rejected = await w.remote({}, 'rejected.example')
		const kept = await w.remote({})
		const shot = snapshot('https://files.example/e/b.png')
		await sql(w.t.store, 'UPDATE accounts SET emojis = ?1 WHERE id IN (?2, ?3)', shot, rejected.id, kept.id)
		const rejectedPost = await w.attach(rejected.id, 'https://files.example/m/r.png')
		const keptPost = await w.attach(kept.id, 'https://files.example/m/k.png')
		await sql(
			w.t.store,
			'UPDATE statuses SET emojis = ?1 WHERE id IN (?2, ?3)',
			snapshot('https://files.example/e/s.png'),
			rejectedPost.status,
			keptPost.status
		)
		// What the writers enqueued is gone, so only the backfill enqueues.
		await sql(w.t.store, 'DELETE FROM remote_media')
		await sql(w.t.store, 'UPDATE remote_media_usage SET pending = 0')
		await rejectMedia(w, 'rejected.example')
		// Every slot seen after a round: the next round's validity walk would retire one enqueued in error.
		const seen = new Set<string>()
		for (let round = 0; round < 4; round++) {
			await maintain(w)
			for (const slot of await slotsOf(w)) {
				seen.add(slot)
			}
		}
		expect([...seen].sort()).toEqual([
			`attachment ${keptPost.media} https://files.example/m/k.png`,
			`avatar ${kept.id} ${kept.avatar}`,
			'emoji files.example https://files.example/e/b.png',
			'emoji files.example https://files.example/e/s.png',
		])
		await w.exact()
	})

	it('claims nothing of a domain once its rule rejects media, and records nothing for a block added during the fetch', async () => {
		const w = await mediaWorld()
		await backfillDone(w)
		const early = await w.remote({}, 'early.example')
		const during = await w.remote({}, 'during.example')
		const kept = await w.remote({})
		await noteEmoji(w, snapshot('https://files.example/e/d.png'), 'during.example')
		await rejectMedia(w, 'early.example')
		const claimed = await claim(w)
		// The early domain's slot is dropped at the claim; the others are claimed.
		expect(claimed.dropped).toBe(1)
		expect(claimed.claims.map((c) => c.url).sort()).toEqual(
			[during.avatar, kept.avatar, 'https://files.example/e/d.png'].sort()
		)
		expect((await w.slots()).some((s) => s.owner_id === early.id)).toBe(false)
		// A block committed while the fetches run: the fence refuses the admission and the record of its domain's
		// slots (the profile image by its account, the emoji by its slot's domain), and the object is doomed.
		await rejectMedia(w, 'during.example')
		for (const c of claimed.claims) {
			const ours = c.url !== kept.avatar
			expect(await w.op(admitRemoteMedia, { ...fence(c), hosts: ['files.example'] }), c.url).toEqual({
				held: !ours,
			})
			expect(await record(w, c), c.url).toEqual({ held: !ours })
		}
		expect(await slotsOf(w)).toEqual([
			`avatar ${during.id} ${during.avatar}`,
			`avatar ${kept.id} ${kept.avatar} stored`,
			'emoji during.example https://files.example/e/d.png',
		])
		expect((await w.objects()).map((o) => o.state).sort()).toEqual(['doomed', 'doomed', 'stored'])
		await w.exact()
	})

	it('retires in the validity walk every cached file of a domain whose rule came to reject media', async () => {
		const w = await mediaWorld()
		await backfillDone(w)
		const account = await w.remote({ header: 'https://files.example/h/1.png' }, 'walked.example')
		const kept = await w.remote({})
		await w.attach(account.id, 'https://files.example/m/w.png', { preview: 'https://files.example/m/w-icon.png' })
		await noteEmoji(w, snapshot('https://files.example/e/w.png'), 'walked.example')
		await storeAll(w)
		const block = await blockDomain(w.t.store, 'walked.example', 'noop')
		expect((await maintain(w)).counts.retired).toBe(0)
		await setRejectMedia(w.t.store, block.id, true)
		expect((await maintain(w)).counts.retired).toBe(5)
		expect(await slotsOf(w)).toEqual([`avatar ${kept.id} ${kept.avatar} stored`])
		expect((await w.objects()).filter((o) => o.state === 'doomed')).toHaveLength(5)
		await w.exact()
	})

	it('decides by the nearest block: a child without reject_media is exempt, a child with it rejects under a noop parent', async () => {
		const w = await mediaWorld()
		await backfillDone(w)
		const parent = await w.remote({}, 'parent.example')
		const exempt = await w.remote({}, 'a.parent.example')
		const deeper = await w.remote({}, 'x.a.parent.example')
		const other = await w.remote({}, 'other.example')
		const strict = await w.remote({}, 'b.other.example')
		await storeAll(w)
		// The child first: a create under a stricter ruling block is refused (DomainBlock#stricter_than?), but a parent
		// block may come later, or gain reject_media by an update.
		await blockDomain(w.t.store, 'a.parent.example', 'noop')
		await rejectMedia(w, 'parent.example')
		await blockDomain(w.t.store, 'other.example', 'noop')
		await rejectMedia(w, 'b.other.example')
		expect((await maintain(w)).counts.retired).toBe(2)
		const owners = (await w.slots()).map((s) => s.owner_id).sort()
		expect(owners).toEqual([exempt.id, deeper.id, other.id].sort())
		expect(owners).not.toContain(parent.id)
		expect(owners).not.toContain(strict.id)
		await w.exact()
	})

	it('rejects an emoji by its slot’s domain, keeping the same URL cached for another domain', async () => {
		const w = await mediaWorld()
		await backfillDone(w)
		const shared = snapshot('https://files.example/e/shared.png')
		await noteEmoji(w, shared, 'one.example')
		await noteEmoji(w, shared, 'two.example')
		await storeAll(w)
		await rejectMedia(w, 'one.example')
		expect((await maintain(w)).counts.retired).toBe(1)
		await noteEmoji(w, shared, 'one.example')
		await noteEmoji(w, shared, 'two.example')
		expect(await slotsOf(w)).toEqual(['emoji two.example https://files.example/e/shared.png stored'])
		await w.exact()
	})

	it(
		'seeks the reject_media rule by domain for each slot the validity walk reads, however many blocks, after ANALYZE and growth',
		{ timeout: 300_000 },
		async () => {
			const w = await mediaWorld()
			await backfillDone(w)
			// The deepest walk: a host past MAX_BLOCK_LABELS labels whose only block is its 2-label suffix, a noop without
			// reject_media, so every suffix of 2 to MAX_BLOCK_LABELS labels is sought and the slot stays eligible.
			const deep = [...Array.from({ length: MAX_BLOCK_LABELS + 2 }, (_, i) => `l${i}`), 'far', 'example'].join('.')
			const accounts = async (n: number) => {
				for (let i = 0; i < n; i++) {
					await w.remote({}, deep)
				}
			}
			await accounts(10)
			await blockDomain(w.t.store, 'far.example', 'noop')
			const capture = async () => {
				const { result, plans } = await plannedRun(
					w.t,
					/FROM remote_media WHERE id > \?1 ORDER BY id/,
					maintainRemoteMedia,
					{ now: w.clock.now, restoredAt: null, cap: CAP },
					true
				)
				expect(result.counts.retired).toBe(0)
				expect(plans).toHaveLength(1)
				const slots = (await w.slots()).length
				return { ...plans[0]!, slots }
			}
			const { before, after } = await staleStatistics(w.t, {
				capture,
				grow: async () => {
					await accounts(VALIDITY_WALK - 10)
					// Blocks of other domains, half with reject_media, none on any suffix of the walked host.
					await sql(
						w.t.store,
						`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
						INSERT INTO instance_domain_blocks (domain, severity, reject_media, created_at, updated_at)
						SELECT 'g' || i || '.example', 'noop', i % 2, 'x', 'x' FROM n`
					)
				},
			})
			// After growth the walk reads its cap of slots, each at the deepest walk.
			expect([before.slots, after.slots]).toEqual([10, VALIDITY_WALK])
			for (const { plan } of [before, after]) {
				// The rule walks seek by domain; the only scan of the blocks is availability's guard, an EXISTS over the
				// partial index of the suspend blocks (audience.ts SUSPEND_BLOCKS_SQL).
				expect(scansOf(plan, ['pn', 'pr']), plan.join('\n')).toEqual([])
				expect(
					scansOf(plan, ['instance_domain_blocks']).every((scan) => scan.endsWith('instance_domain_blocks_suspend')),
					plan.join('\n')
				).toBe(true)
			}
			// Rows read grow with the slots walked, not with the blocks.
			expect(after.rows / after.slots).toBeLessThanOrEqual(before.rows / before.slots + 1)
			await w.exact()
		}
	)
})
