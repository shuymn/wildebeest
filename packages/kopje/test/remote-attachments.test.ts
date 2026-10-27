import { env } from 'cloudflare:workers'

import { describe, expect, it, vi } from 'vitest'

import { sql } from './api-helpers'
import { blockDomain } from './domain-block-helpers'
import { BUILD } from './helpers'
import { MASTODON, mastodonActor } from './inbox-helpers'
import { create, followed, mastodonNote, remove, update } from './inbox-status-helpers'
import { writtenBy } from './inbox-store-helpers'
import { plannedRun, scansOf, staleStatistics } from './read-helpers'
import { mp4 } from './remote-media-fixtures'
import {
	backfillDone,
	bucketWith,
	deferred,
	GIF,
	maintain,
	type MediaWorld,
	mediaWorld,
	PNG,
	settle,
} from './remote-media-helpers'
import { Db } from '../src/db/sql'
import { deleteStatusBatch, PURGE_BATCH, purgeBatch } from '../src/domain/inbox'
import { writeOperation } from '../src/domain/operation'
import {
	BACKFILL_BATCH,
	CLAIM_WALK,
	admitRemoteMedia,
	claimRemoteMedia,
	LATE_PUT_MS,
	maintainRemoteMedia,
	recordRemoteMedia,
	RETENTION_BATCH,
	retireAccountSlots,
	retireStatusMediaSlots,
	SLOT_RETIRE_CHANGES,
} from '../src/domain/remote-media'
import { presentMedia, type MediaRow } from '../src/domain/status-presenter'
import { outstandingRemoteMediaCalls, STORE_CALL_MS } from '../src/federation/remote-media'
import { WEB_MEDIA_TIMEOUT_MS } from '../src/federation/web-page'
import { MEDIA_SLOT_WINDOW } from '../src/platform/stored-bounds'

// Remote attachments in the cache of remote media (domain/remote-media.ts syncAttachmentFiles and the removal steps,
// federation/remote-media.ts lane 1, status-presenter.ts presentMedia): what the status writer enqueues and resets,
// what a removal retires before the rows it names go, what retention and the backfill take, what the round stores,
// and what a status shows.

const CAP = 4 * 1024 * 1024 * 1024
const ORIGIN = 'https://kopje.test'
const DAY = 24 * 60 * 60 * 1000
const MiB = 1024 * 1024

type AttachmentSlot = {
	id: number
	kind: string
	owner_id: string
	url: string
	category: string
	lane: number
	generation: number
	due_at: number | null
	token: string | null
}

const attachmentSlots = (w: MediaWorld) =>
	sql<AttachmentSlot>(
		w.t.store,
		`SELECT id, kind, owner_id, url, category, lane, generation, due_at, token FROM remote_media
		WHERE kind IN ('attachment', 'thumbnail') ORDER BY url, kind`
	)

// An audit pass under way whose cursor is past every token: each charge change is added to its sums too.
const midAudit = (w: MediaWorld) =>
	sql(
		w.t.store,
		`INSERT OR REPLACE INTO kopje_state (name, value)
		VALUES ('remote_media_audit', '{"cursor":"${'z'.repeat(43)}","bytes":0,"doomed":0}')`
	)
const audit = async (w: MediaWorld) =>
	(await sql<{ value: string }>(w.t.store, "SELECT value FROM kopje_state WHERE name = 'remote_media_audit'"))[0]?.value

const removal = writeOperation<{ id: string }, boolean>((db, { id }) => deleteStatusBatch(db, id, Date.now()))

// Slots whose attachment row is gone: none may be left by any removal.
const orphans = (w: MediaWorld) =>
	sql<{ id: number }>(
		w.t.store,
		`SELECT r.id FROM remote_media r WHERE r.kind IN ('attachment', 'thumbnail')
		AND NOT EXISTS (SELECT 1 FROM media_attachments m WHERE m.id = r.owner_id)`
	)

const image = (n: number, icon = false) => ({
	type: 'Document',
	mediaType: 'image/png',
	url: `${MASTODON}/system/media/${n}.png`,
	...(icon ? { icon: { type: 'Image', mediaType: 'image/png', url: `${MASTODON}/system/media/${n}-small.png` } } : {}),
})
const video = (n: number) => ({ type: 'Document', mediaType: 'video/mp4', url: `${MASTODON}/system/media/${n}.mp4` })

// A world with bob followed, the backfill done.
async function world() {
	const w = await mediaWorld()
	await backfillDone(w)
	const bob = await mastodonActor(w.t.web, 'bob')
	await followed(w.t, bob)
	return { w, bob }
}

// Every pending slot stored by a round, the files served as `files` says.
async function storeAll(w: MediaWorld, files: Record<string, Uint8Array>) {
	for (const [url, body] of Object.entries(files)) {
		w.serve(url, body, { 'content-length': String(body.length) })
	}
	return w.round()
}

describe('the status writer (remote-statuses.ts writeMedia)', () => {
	it('enqueues each attachment’s file in lane 1 by its category and its icon in lane 0', async () => {
		const { w, bob } = await world()
		const note = mastodonNote(bob, { attachment: [image(1, true), video(2)] })
		expect(await w.t.post(bob, create(bob, note))).toBe(202)
		expect(
			(await attachmentSlots(w)).map((s) => ({ kind: s.kind, url: s.url, category: s.category, lane: s.lane }))
		).toEqual([
			{ kind: 'thumbnail', url: `${MASTODON}/system/media/1-small.png`, category: 'image', lane: 0 },
			{ kind: 'attachment', url: `${MASTODON}/system/media/1.png`, category: 'image', lane: 1 },
			{ kind: 'attachment', url: `${MASTODON}/system/media/2.mp4`, category: 'video', lane: 1 },
		])
		expect((await attachmentSlots(w)).every((s) => s.due_at !== null)).toBe(true)
		await w.exact()
	})

	it('resets a changed URL, dooms a dropped attachment’s files before its row goes, and keeps an unchanged one', async () => {
		const { w, bob } = await world()
		const note = mastodonNote(bob, { attachment: [image(1, true), image(2), video(3)] })
		expect(await w.t.post(bob, create(bob, note))).toBe(202)
		const out = await storeAll(w, {
			[`${MASTODON}/system/media/1.png`]: PNG,
			[`${MASTODON}/system/media/1-small.png`]: PNG,
			[`${MASTODON}/system/media/2.png`]: PNG,
			[`${MASTODON}/system/media/3.mp4`]: mp4(),
		})
		expect(out).toMatchObject({ stored: 4 })
		const before = new Map((await attachmentSlots(w)).map((s) => [`${s.kind} ${s.url}`, s]))
		// The first keeps its file and changes its icon; the second is dropped; the third is kept as it was.
		const edited = {
			...note,
			attachment: [
				{ ...image(1), icon: { type: 'Image', mediaType: 'image/png', url: `${MASTODON}/system/media/1-new.png` } },
				video(3),
			],
		}
		expect(await w.t.post(bob, update(bob, edited, '2026-10-11T12:10:00Z'))).toBe(202)
		const after = await attachmentSlots(w)
		expect(after.map((s) => `${s.kind} ${s.url}`)).toEqual([
			`thumbnail ${MASTODON}/system/media/1-new.png`,
			`attachment ${MASTODON}/system/media/1.png`,
			`attachment ${MASTODON}/system/media/3.mp4`,
		])
		const icon = after.find((s) => s.kind === 'thumbnail')!
		expect(icon).toMatchObject({
			token: null,
			generation: before.get(`thumbnail ${MASTODON}/system/media/1-small.png`)!.generation + 1,
		})
		expect(icon.due_at).not.toBeNull()
		for (const kept of [`attachment ${MASTODON}/system/media/1.png`, `attachment ${MASTODON}/system/media/3.mp4`]) {
			expect(after.find((s) => `${s.kind} ${s.url}` === kept)).toEqual(before.get(kept))
		}
		// The old icon's object and the dropped attachment's are doomed; the kept files' stay stored (bob's own
		// profile images, never served, are not this test's).
		const objects = await w.objects()
		expect(
			objects
				.filter((o) => o.state === 'stored')
				.map((o) => o.slot_id)
				.sort()
		).toEqual(
			[
				before.get(`attachment ${MASTODON}/system/media/1.png`)!.id,
				before.get(`attachment ${MASTODON}/system/media/3.mp4`)!.id,
			].sort()
		)
		expect(objects.filter((o) => o.state === 'doomed' && o.kind !== 'avatar' && o.kind !== 'header')).toHaveLength(2)
		expect(await orphans(w)).toEqual([])
		await w.exact()
	})

	it('resets the file of an attachment whose type changes at the same URL, so the earlier claim’s record is lost', async () => {
		const { w, bob } = await world()
		const url = `${MASTODON}/system/media/1.bin`
		const note = mastodonNote(bob, { attachment: [{ type: 'Document', mediaType: 'image/png', url }] })
		expect(await w.t.post(bob, create(bob, note))).toBe(202)
		const [first] = await attachmentSlots(w)
		expect(first).toMatchObject({ category: 'image' })
		// A claim of the image, its fetch under way while the Update arrives.
		const tokens = Array.from({ length: 30 }, (_, i) => `C${String(i).padStart(42, '0')}`)
		const claimed = await w.op(claimRemoteMedia, { now: w.clock.now, tokens, cap: CAP })
		const claim = claimed.claims.find((c) => c.url === url)!
		expect(claim).toMatchObject({ kind: 'attachment', category: 'image' })
		const edited = { ...note, attachment: [{ type: 'Document', mediaType: 'video/mp4', url }] }
		expect(await w.t.post(bob, update(bob, edited, '2026-10-11T12:10:00Z'))).toBe(202)
		const [second] = await attachmentSlots(w)
		expect(second).toMatchObject({ id: first!.id, url, category: 'video', generation: first!.generation + 1 })
		// The image's admission and its record come late: both refused, its reservation doomed, the slot pending again.
		const fence = { slot: claim.slot, claim: claim.claim, generation: claim.generation, token: claim.token }
		expect(await w.op(admitRemoteMedia, { ...fence, hosts: [new URL(MASTODON).host] })).toEqual({ held: false })
		const outcome = {
			kind: 'stored' as const,
			contentType: 'image/png',
			stillType: null,
			bytes: 100,
			hosts: [new URL(MASTODON).host],
			category: 'image' as const,
		}
		expect(await w.op(recordRemoteMedia, { ...fence, outcome, now: w.clock.now })).toEqual({ held: false })
		const [after] = await attachmentSlots(w)
		expect(after).toMatchObject({ token: null, category: 'video' })
		expect(after!.due_at).not.toBeNull()
		expect((await w.objects()).find((o) => o.token === claim.token)).toMatchObject({ state: 'doomed', slot_id: null })
		await w.exact()
	})

	it('enqueues nothing for an attachment that arrived longer ago than the retention, unless it is 0', async () => {
		const w = await mediaWorld()
		const author = await w.remote({ avatar: null })
		await w.attach(author.id, 'https://files.example/m/old.png', {
			createdAt: new Date(w.clock.now - 15 * DAY).toISOString(),
		})
		await w.attach(author.id, 'https://files.example/m/new.png', {
			createdAt: new Date(w.clock.now - 13 * DAY).toISOString(),
		})
		expect((await attachmentSlots(w)).map((s) => s.url)).toEqual(['https://files.example/m/new.png'])
		// Retention 0 keeps everything, whenever it arrived.
		await backfillDone(w)
		await maintain(w, 0)
		await w.attach(author.id, 'https://files.example/m/older.png', {
			createdAt: new Date(w.clock.now - 400 * DAY).toISOString(),
		})
		expect((await attachmentSlots(w)).map((s) => s.url)).toEqual([
			'https://files.example/m/new.png',
			'https://files.example/m/older.png',
		])
		await w.exact()
	})
})

describe('the removal of a status and of an account', () => {
	// A status of `n` attachments, each with a stored file and a reserved icon (a claim whose record never came).
	async function cached(w: MediaWorld, n: number) {
		const author = await w.remote({ avatar: null })
		const first = await w.attach(author.id, 'https://files.example/m/0.png', {
			preview: 'https://files.example/p/0.png',
		})
		const status = first.status
		await sql(
			w.t.store,
			`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?3)
			INSERT INTO media_attachments (id, account_id, status_id, position, type, url, preview_url)
			SELECT CAST(CAST(?4 AS INTEGER) + CAST(i AS INTEGER) AS TEXT), ?1, ?2, i, 'image',
				'https://files.example/m/' || i || '.png', 'https://files.example/p/' || i || '.png'
			FROM k WHERE i <= ?3`,
			author.id,
			status,
			n - 1,
			first.media
		)
		await sql(
			w.t.store,
			`INSERT INTO remote_media (kind, owner_id, account_id, url, host, category, lane, generation, enqueued_at, due_at)
			SELECT k.kind, m.id, m.account_id, CASE k.kind WHEN 'attachment' THEN m.url ELSE m.preview_url END,
				'files.example', 'image', k.kind = 'attachment', 0, 1, 1
			FROM media_attachments m CROSS JOIN (SELECT 'attachment' AS kind UNION ALL SELECT 'thumbnail') k
			WHERE m.status_id = ?1 AND m.id <> ?2`,
			status,
			first.media
		)
		const media = (
			await sql<{ id: string }>(
				w.t.store,
				'SELECT id FROM media_attachments WHERE status_id = ? ORDER BY position',
				status
			)
		).map((row) => row.id)
		await sql(
			w.t.store,
			`INSERT INTO remote_media_objects (token, slot_id, state, charge, kind, content_type, claimed_at, stored_at)
			SELECT 'S' || printf('%042d', id), id, CASE kind WHEN 'attachment' THEN 'stored' ELSE 'reserved' END, 10, kind,
				CASE kind WHEN 'attachment' THEN 'image/png' END, 1, CASE kind WHEN 'attachment' THEN 1 END
			FROM remote_media WHERE kind IN ('attachment', 'thumbnail')`
		)
		await sql(
			w.t.store,
			`UPDATE remote_media SET token = 'S' || printf('%042d', id), ext = 'png', stored_at = 1, due_at = NULL
			WHERE kind = 'attachment'`
		)
		await sql(
			w.t.store,
			`UPDATE remote_media_usage SET bytes = (SELECT sum(charge) FROM remote_media_objects),
				pending = (SELECT count(*) FROM remote_media WHERE due_at IS NOT NULL)`
		)
		await w.exact()
		return { author, status, media }
	}

	it('costs SLOT_RETIRE_CHANGES, its most, to retire a pending slot with its reserved object mid-audit', async () => {
		const w = await mediaWorld()
		const { status } = await cached(w, 1)
		// Only the icon's slot: pending, its object reserved and counted by the audit pass.
		await sql(w.t.store, "DELETE FROM remote_media_objects WHERE kind = 'attachment'")
		await sql(w.t.store, "DELETE FROM remote_media WHERE kind = 'attachment'")
		await sql(w.t.store, 'UPDATE remote_media_usage SET bytes = (SELECT sum(charge) FROM remote_media_objects)')
		await midAudit(w)
		const before = { usage: await w.usage(), audit: await audit(w) }
		const { rows: changes } = await writtenBy(w.t.store, (d) =>
			retireStatusMediaSlots(d, status, { left: () => 100 }, w.clock.now)
		)
		// Every write it can make was made once: the object doomed, its charge and the audit's sums, the slot deleted, the
		// pending count.
		expect(await attachmentSlots(w)).toEqual([])
		expect((await w.objects()).map((o) => o.state)).toEqual(['doomed'])
		expect(await w.usage()).toEqual({
			...before.usage,
			doomed: before.usage.doomed + 10,
			pending: before.usage.pending - 1,
		})
		expect(await audit(w)).not.toEqual(before.audit)
		expect(changes).toBe(SLOT_RETIRE_CHANGES)
	})

	it.each([0, 1, 4, 5, 9, 10, 14, 15, 20])(
		'retires no more slots than %i changes left allow mid-audit, nothing under a slot’s worst case',
		async (left) => {
			const w = await mediaWorld()
			const { status } = await cached(w, 2)
			await midAudit(w)
			const { rows: out } = await writtenBy(w.t.store, (d) =>
				retireStatusMediaSlots(d, status, { left: () => left }, w.clock.now)
			)
			expect(out).toBeLessThanOrEqual(left)
			const retired = 4 - (await attachmentSlots(w)).length
			expect(retired).toBe(Math.min(Math.floor(left / SLOT_RETIRE_CHANGES), 4))
			await w.exact()
		}
	)

	it.each([4, 5])(
		'retires an account’s pending slot with its reserved object mid-audit only with %i changes left of 5',
		async (left) => {
			const w = await mediaWorld()
			const { author } = await cached(w, 1)
			await sql(w.t.store, "DELETE FROM remote_media_objects WHERE kind = 'attachment'")
			await sql(w.t.store, "DELETE FROM remote_media WHERE kind = 'attachment'")
			await sql(w.t.store, 'UPDATE remote_media_usage SET bytes = (SELECT sum(charge) FROM remote_media_objects)')
			await midAudit(w)
			const written = await writtenBy(w.t.store, (d) =>
				retireAccountSlots(d, author.id, { left: () => left }, w.clock.now)
			)
			const out = { result: written.result, changes: written.rows }
			expect(out.changes).toBeLessThanOrEqual(left)
			expect(out).toEqual(left < SLOT_RETIRE_CHANGES ? { result: 'more', changes: 0 } : { result: 'done', changes: 5 })
			await w.exact()
		}
	)

	// Each batch of the production removal, its rows changed, until nothing remains.
	async function batches(w: MediaWorld, run: (d: Db) => boolean) {
		const wrote: number[] = []
		for (let more = true; more;) {
			expect(wrote.length).toBeLessThan(40)
			const out = await writtenBy(w.t.store, run)
			wrote.push(out.rows)
			more = out.result
		}
		return wrote
	}

	it.each(['delete', 'purge'] as const)(
		'keeps each %s batch within its rows, retiring stored and reserved files mid-audit, and resumes to the end',
		async (kind) => {
			const w = await mediaWorld()
			// 150 attachments: 150 stored files and 150 pending icons with reserved objects, all counted by the audit.
			const { author, status } = await cached(w, 150)
			await midAudit(w)
			const uri = (await sql<{ uri: string }>(w.t.store, 'SELECT uri FROM accounts WHERE id = ?', author.id))[0]!.uri
			if (kind === 'purge') {
				await sql(w.t.store, "UPDATE accounts SET deleted_at = '2026-10-01T00:00:00.000Z' WHERE id = ?", author.id)
			}
			const wrote = await batches(w, (d) =>
				kind === 'delete' ? deleteStatusBatch(d, status, w.clock.now) : purgeBatch(d, uri, w.clock.now)
			)
			expect(wrote.length).toBeGreaterThan(2)
			expect(wrote.every((n) => n <= PURGE_BATCH)).toBe(true)
			expect(await sql(w.t.store, 'SELECT 1 FROM statuses WHERE id = ?', status)).toEqual([])
			expect(await attachmentSlots(w)).toEqual([])
			expect((await w.objects()).every((o) => o.state === 'doomed')).toBe(true)
			await w.exact()
		}
	)

	it(
		'reads a bounded window a batch for a status with many uncached attachments before a cached one, or many uploads',
		{ timeout: 120_000 },
		async () => {
			const w = await mediaWorld()
			const { author, status, media } = await cached(w, 1)
			// 1,000 uncached attachments ahead of the cached one.
			await sql(w.t.store, 'UPDATE media_attachments SET position = 5000 WHERE id = ?', media[0]!)
			await sql(
				w.t.store,
				`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 1000)
				INSERT INTO media_attachments (id, account_id, status_id, position, type, url)
				SELECT CAST(CAST(?3 AS INTEGER) + 10 + CAST(i AS INTEGER) AS TEXT), ?1, ?2, i, 'image',
					'https://files.example/u/' || i FROM k`,
				author.id,
				status,
				media[0]!
			)
			// And 1,000 rows of uploads on it too (as only an import could store), ahead of everything.
			await sql(
				w.t.store,
				`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 1000)
				INSERT INTO media_attachments (id, account_id, status_id, position, type, url, file_token, content_type, processed)
				SELECT '2' || printf('%017d', i), ?1, ?2, 0, 'image', 'https://files.example/up/' || i,
					'token-' || printf('%017d', i) || '-remote0123456789abc', 'image/jpeg', 1 FROM k`,
				author.id,
				status
			)
			// A local status with 1,000 uploads.
			const local = (await sql<{ id: string }>(w.t.store, 'SELECT account_id AS id FROM local_accounts LIMIT 1'))[0]!.id
			const own = `7${'9'.repeat(17)}`
			await sql(
				w.t.store,
				`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				VALUES (?1, 'https://kopje.test/s/1', ?2, 'public', '', '2026-10-01T00:00:00.000Z')`,
				own,
				local
			)
			await sql(
				w.t.store,
				`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 1000)
				INSERT INTO media_attachments (id, account_id, status_id, position, type, url, file_token, content_type, processed)
				SELECT '3' || printf('%017d', i), ?1, ?2, i, 'image', 'https://kopje.test/media/' || i,
					'token-' || printf('%017d', i) || '-0123456789abcdef0123', 'image/jpeg', 1 FROM k`,
				local,
				own
			)
			const window = /SELECT id, file_token FROM media_attachments INDEXED BY media_attachments_status/
			for (const id of [status, own]) {
				for (let i = 0, more = true; more; i++) {
					expect(i).toBeLessThan(20)
					const { result, plans } = await plannedRun(w.t, window, removal, { id })
					// A local status's removal reads only the completion check's window: its retire step returns first.
					if (id === own) {
						expect(plans).toHaveLength(1)
					}
					for (const { rows } of plans) {
						// The window and a slot seek for each of its rows, at most.
						expect(rows).toBeLessThanOrEqual(2 * MEDIA_SLOT_WINDOW + 1)
					}
					more = result
				}
			}
			expect(await sql(w.t.store, 'SELECT 1 FROM statuses WHERE id IN (?, ?)', status, own)).toEqual([])
			expect(await attachmentSlots(w)).toEqual([])
			expect(await orphans(w)).toEqual([])
			await w.exact()
		}
	)

	it('retires every cached file of a deleted status before its attachment rows go, across batches', async () => {
		const { w, bob } = await world()
		const note = mastodonNote(bob, { attachment: [image(1, true), video(2)] })
		expect(await w.t.post(bob, create(bob, note))).toBe(202)
		await storeAll(w, {
			[`${MASTODON}/system/media/1.png`]: PNG,
			[`${MASTODON}/system/media/1-small.png`]: PNG,
			[`${MASTODON}/system/media/2.mp4`]: mp4(),
		})
		expect(await w.t.post(bob, remove(bob, note.id))).toBe(202)
		for (let i = 0; i < 10 && (await sql(w.t.store, 'SELECT 1 FROM statuses WHERE uri = ?', note.id)).length > 0; i++) {
			await w.t.store.runInboundJobs(BUILD, { now: w.clock.now })
		}
		expect(await sql(w.t.store, 'SELECT 1 FROM statuses WHERE uri = ?', note.id)).toEqual([])
		expect(await attachmentSlots(w)).toEqual([])
		expect((await w.objects()).every((o) => o.state === 'doomed')).toBe(true)
		await w.exact()
	})

	it('keeps an attachment row while a slot names it, so none is left naming a row that is gone', async () => {
		const w = await mediaWorld()
		const { status, media } = await cached(w, 1)
		// A slot the retire step leaves: written again as it deletes the icon's slot (a test trigger, once), so the media
		// delete that follows in the batch meets an attachment row a slot still names.
		await sql(
			w.t.store,
			`CREATE TRIGGER test_late_attachment_slot AFTER DELETE ON remote_media
			WHEN OLD.owner_id = '${media[0]}' AND OLD.kind = 'thumbnail'
				AND NOT EXISTS (SELECT 1 FROM kopje_state WHERE name = 'test_late')
			BEGIN
				INSERT INTO kopje_state (name, value) VALUES ('test_late', '1');
				INSERT INTO remote_media (kind, owner_id, account_id, url, host, category, lane, generation, enqueued_at, failed_at)
				VALUES ('thumbnail', OLD.owner_id, OLD.account_id, OLD.url, OLD.host, 'image', 0, 0, 1, 1);
			END`
		)
		const uri = (await sql<{ uri: string }>(w.t.store, 'SELECT uri FROM statuses WHERE id = ?', status))[0]!.uri
		await sql(
			w.t.store,
			"INSERT INTO inbound_jobs (kind, key, actor_uri, created_at) VALUES ('delete', ?1, ?2, ?3)",
			status,
			uri,
			w.clock.now
		)
		for (let i = 0; i < 5; i++) {
			await w.t.store.runInboundJobs(BUILD, { now: w.clock.now })
		}
		expect(await sql(w.t.store, 'SELECT 1 FROM statuses WHERE id = ?', status)).toEqual([])
		expect(await orphans(w)).toEqual([])
		expect(await sql(w.t.store, "SELECT 1 FROM kopje_state WHERE name = 'test_late'")).toHaveLength(1)
		await w.exact()
	})

	it('retires the cached files of an account’s unattached attachments in its purge before the rows go', async () => {
		const w = await mediaWorld()
		const { author, status, media } = await cached(w, 2)
		await sql(w.t.store, 'UPDATE media_attachments SET status_id = NULL WHERE status_id = ?', status)
		// A slot that appears after the purge retired the account's, before the unattached rows go: written as the step
		// before deletes a mention of the account (a test trigger, once).
		await sql(w.t.store, 'INSERT INTO status_mentions (status_id, account_id) VALUES (?1, ?2)', status, author.id)
		await sql(
			w.t.store,
			`CREATE TRIGGER test_late_unattached_slot AFTER DELETE ON status_mentions
			WHEN OLD.account_id = '${author.id}' AND NOT EXISTS (SELECT 1 FROM kopje_state WHERE name = 'test_late')
			BEGIN
				INSERT INTO kopje_state (name, value) VALUES ('test_late', '1');
				INSERT INTO remote_media (kind, owner_id, account_id, url, host, category, lane, generation, enqueued_at, failed_at)
				VALUES ('thumbnail', '${media[0]}', OLD.account_id, 'https://files.example/late.png', 'files.example', 'image', 0, 0,
					1, 1);
			END`
		)
		const uri = (await sql<{ uri: string }>(w.t.store, 'SELECT uri FROM accounts WHERE id = ?', author.id))[0]!.uri
		await sql(w.t.store, "UPDATE accounts SET deleted_at = '2026-10-01T00:00:00.000Z' WHERE id = ?", author.id)
		for (let more = true; more;) {
			more = await w.db((d: Db) => purgeBatch(d, uri, w.clock.now))
			// After every batch: no slot names a row that is gone.
			expect(await orphans(w)).toEqual([])
		}
		expect(await sql(w.t.store, "SELECT 1 FROM kopje_state WHERE name = 'test_late'")).toHaveLength(1)
		expect(await sql(w.t.store, 'SELECT 1 FROM media_attachments WHERE account_id = ?', author.id)).toEqual([])
		expect(await attachmentSlots(w)).toEqual([])
		expect((await w.objects()).every((o) => o.state === 'doomed')).toBe(true)
		await w.exact()
	})
})

describe('retention and the backfill', () => {
	it('dooms stored attachment files and icons past the retention, newest kept, and nothing at 0', async () => {
		const w = await mediaWorld()
		const author = await w.remote({ avatar: 'https://files.example/a.png' })
		await w.attach(author.id, 'https://files.example/m/1.png', { preview: 'https://files.example/p/1.png' })
		await w.attach(author.id, 'https://files.example/m/2.png')
		await backfillDone(w)
		const out = await storeAll(w, {
			'https://files.example/a.png': PNG,
			'https://files.example/m/1.png': PNG,
			'https://files.example/p/1.png': PNG,
			'https://files.example/m/2.png': PNG,
		})
		expect(out).toMatchObject({ stored: 4 })
		// The first attachment's files were stored 15 days ago, the second's a day ago, the avatar 15 days ago.
		await sql(
			w.t.store,
			`UPDATE remote_media_objects SET stored_at = ?1 WHERE slot_id IN (SELECT id FROM remote_media
				WHERE url IN ('https://files.example/m/1.png', 'https://files.example/p/1.png', 'https://files.example/a.png'))`,
			w.clock.now - 15 * DAY
		)
		await sql(
			w.t.store,
			"UPDATE remote_media_objects SET stored_at = ?1 WHERE slot_id IN (SELECT id FROM remote_media WHERE url = 'https://files.example/m/2.png')",
			w.clock.now - DAY
		)
		expect((await maintain(w, 0)).counts.aged).toBe(0)
		expect(await attachmentSlots(w)).toHaveLength(3)
		expect((await maintain(w, 14)).counts.aged).toBe(2)
		expect((await attachmentSlots(w)).map((s) => s.url)).toEqual(['https://files.example/m/2.png'])
		expect(await sql(w.t.store, "SELECT 1 FROM remote_media WHERE kind = 'avatar'")).toHaveLength(1)
		await w.exact()
	})

	it('walks the attachments shown with their statuses within the retention once the accounts are done', async () => {
		const w = await mediaWorld()
		const author = await w.remote({ avatar: null })
		const idAt = (ms: number) => (BigInt(ms) << 16n).toString()
		const status = (await w.attach(author.id, 'https://files.example/m/seed.png')).status
		await sql(w.t.store, 'DELETE FROM remote_media')
		await sql(w.t.store, 'UPDATE remote_media_usage SET pending = 0')
		for (const [id, url, extra] of [
			[idAt(w.clock.now - DAY), 'https://files.example/m/recent.png', ''],
			[idAt(w.clock.now - 30 * DAY), 'https://files.example/m/old.png', ''],
			[idAt(w.clock.now - 2 * DAY), 'https://files.example/m/hidden.png', 'hidden'],
		] as const) {
			await sql(
				w.t.store,
				`INSERT INTO media_attachments (id, account_id, status_id, position, type, url, shown)
				VALUES (?1, ?2, ?3, 1, 'image', ?4, ?5)`,
				id,
				author.id,
				status,
				url,
				extra === 'hidden' ? 0 : 1
			)
		}
		// The previous release's backfill, finished.
		await sql(
			w.t.store,
			`INSERT OR REPLACE INTO kopje_state (name, value)
			VALUES ('remote_media_backfill', '{"v":2,"phase":"statuses","cursor":"","partial":null,"done":true}')`
		)
		const phases: string[] = []
		for (let i = 0; i < 6; i++) {
			await maintain(w, 14)
			const [state] = await sql<{ value: string }>(
				w.t.store,
				"SELECT value FROM kopje_state WHERE name = 'remote_media_backfill'"
			)
			const parsed = JSON.parse(state!.value) as { v: number; phase: string; done: boolean }
			phases.push(parsed.done ? 'done' : parsed.phase)
			if (parsed.done) {
				expect(parsed.v).toBe(3)
				break
			}
		}
		expect(phases).toEqual(['attachments', 'statuses', 'done'])
		expect((await attachmentSlots(w)).map((s) => s.url)).toEqual([
			'https://files.example/m/recent.png',
			'https://files.example/m/seed.png',
		])
		await w.exact()
	})
	it(
		'reads the retention walk, the attachments phase and the lane 1 walk by their indexes, after ANALYZE and growth',
		{ timeout: 120_000 },
		async () => {
			const w = await mediaWorld()
			const author = await w.remote({ avatar: null })
			const status = (await w.attach(author.id, 'https://files.example/m/seed.png')).status
			// Attachments whose ids are their arrival: `n` from `from` on, arrived `at`, each with a stored file then.
			const grow = async (from: number, n: number, at: number) => {
				await sql(
					w.t.store,
					`WITH RECURSIVE k(i) AS (SELECT ?1 UNION ALL SELECT i + 1 FROM k WHERE i < ?1 + ?2 - 1)
					INSERT INTO media_attachments (id, account_id, status_id, position, type, url)
					SELECT CAST(CAST(?3 AS INTEGER) + CAST(i AS INTEGER) AS TEXT), ?4, ?5, 1, 'image', 'https://files.example/g/' || i FROM k`,
					from,
					n,
					(BigInt(at) << 16n).toString(),
					author.id,
					status
				)
				await sql(
					w.t.store,
					`INSERT INTO remote_media (kind, owner_id, account_id, url, host, category, lane, generation, enqueued_at,
						token, ext, stored_at)
					SELECT 'attachment', m.id, m.account_id, m.url, 'files.example', 'image', 1, 0, 1,
						'G' || printf('%042d', m.rowid), 'png', ?2
					FROM media_attachments m WHERE m.url GLOB 'https://files.example/g/*' AND m.id >= ?1
						AND NOT EXISTS (SELECT 1 FROM remote_media r WHERE r.owner_id = m.id)`,
					(BigInt(at) << 16n).toString(),
					at
				)
				await sql(
					w.t.store,
					`INSERT INTO remote_media_objects (token, slot_id, state, charge, kind, content_type, claimed_at, stored_at)
					SELECT token, id, 'stored', 1, kind, 'image/png', 1, stored_at FROM remote_media
					WHERE token GLOB 'G*' AND NOT EXISTS (SELECT 1 FROM remote_media_objects o WHERE o.token = remote_media.token)`
				)
				await sql(
					w.t.store,
					`UPDATE remote_media_usage SET bytes = (SELECT sum(charge) FROM remote_media_objects),
						pending = (SELECT count(*) FROM remote_media WHERE due_at IS NOT NULL)`
				)
			}
			await grow(1, 20, w.clock.now - DAY)
			const phase = () =>
				sql(
					w.t.store,
					`INSERT OR REPLACE INTO kopje_state (name, value)
					VALUES ('remote_media_backfill', '{"v":3,"phase":"attachments","cursor":"9999999999999999999","partial":null,"done":false}')`
				)
			// The retention walk, the attachments phase's window and count, and the lanes' walks and demand.
			const pattern = /INDEXED BY (remote_media_objects_stored|remote_media_due)\b|WHERE id < \?1 AND id >= \?2/
			const capture = async () => {
				await phase()
				const maintained = await plannedRun(w.t, pattern, maintainRemoteMedia, {
					now: w.clock.now,
					restoredAt: null,
					cap: CAP,
					retentionDays: 14,
				})
				const claimed = await plannedRun(w.t, pattern, claimRemoteMedia, {
					now: w.clock.now,
					tokens: ['T'.repeat(43)],
					cap: CAP,
				})
				return [...maintained.plans, ...claimed.plans]
			}
			const { before, after } = await staleStatistics(w.t, {
				capture,
				// 20,000 more attachments that arrived within the retention, their files stored then.
				grow: () => grow(1000, 20_000, w.clock.now - 2 * DAY),
			})
			for (const plans of [before, after]) {
				expect(plans.length).toBeGreaterThanOrEqual(4)
				for (const { plan, rows } of plans) {
					expect(
						scansOf(plan, ['remote_media', 'remote_media_objects', 'media_attachments', 'm', 'r', 'rm']),
						plan.join('\n')
					).toEqual([])
					expect(rows).toBeLessThanOrEqual(3 * Math.max(BACKFILL_BATCH, RETENTION_BATCH, CLAIM_WALK) + 1)
				}
			}
		}
	)
})

describe('the round over attachments (lane 1)', () => {
	it('claims no file of an attachment whose status is hidden or has a delete job waiting', async () => {
		const w = await mediaWorld()
		const author = await w.remote({ avatar: null })
		const hidden = await w.attach(author.id, 'https://files.example/m/hidden.png')
		const deleting = await w.attach(author.id, 'https://files.example/m/deleting.png')
		await w.attach(author.id, 'https://files.example/m/shown.png')
		await sql(w.t.store, 'UPDATE statuses SET withdrawn = 1 WHERE id = ?', hidden.status)
		await sql(
			w.t.store,
			"INSERT INTO inbound_jobs (kind, key, actor_uri, created_at) VALUES ('delete', ?1, 'https://files.example/u', 1)",
			deleting.status
		)
		for (const url of ['hidden', 'deleting', 'shown']) {
			w.serve(`https://files.example/m/${url}.png`, PNG)
		}
		expect(await w.round()).toMatchObject({ claimed: 1, stored: 1 })
		expect(w.requests.filter((r) => r.includes('/m/'))).toEqual(['GET https://files.example/m/shown.png'])
		await w.exact()
	})

	// A streamed file served in two chunks, the second only when read: whether its body was cancelled.
	// `at` runs as the request arrives. Chunks are views of `file`, nothing copied.
	function served(w: MediaWorld, url: string, file: Uint8Array, at: () => void = () => {}) {
		const state = { cancelled: false }
		w.serve(url, () => {
			at()
			let sent = 0
			const body = new ReadableStream<Uint8Array>({
				pull: (controller) => {
					if (sent === 0) {
						controller.enqueue(file.subarray(0, 1.5 * MiB))
					} else if (sent === 1) {
						controller.enqueue(file.subarray(1.5 * MiB))
					} else {
						controller.close()
					}
					sent++
				},
				cancel: () => {
					state.cancelled = true
				},
			})
			return new Response(body, { headers: { 'content-length': String(file.length) } })
		})
		return state
	}

	it(
		'stores a streamed video just under 40 MiB whole, exactly its length, and charges it',
		{ timeout: 60_000 },
		async () => {
			const w = await mediaWorld()
			const author = await w.remote({ avatar: null })
			const url = 'https://files.example/m/v.mp4'
			const { media } = await w.attach(author.id, url, { type: 'video' })
			const file = mp4({ mdat: 40 * MiB - 1 - mp4({ mdat: 0 }).length })
			expect(file.length).toBe(40 * MiB - 1)
			served(w, url, file)
			expect(await w.round()).toMatchObject({ claimed: 1, stored: 1 })
			const [slot] = await attachmentSlots(w)
			expect(slot).toMatchObject({ owner_id: media, category: 'video', due_at: null })
			const [object] = await w.objects()
			expect(object).toMatchObject({
				state: 'stored',
				charge: file.length,
				content_type: 'video/mp4',
				still_type: null,
			})
			const stored = await env.MEDIA.get(`remote/${slot!.token}/full`)
			expect(stored!.size).toBe(file.length)
			const digest = async (bytes: ArrayBuffer | Uint8Array) =>
				Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).join(',')
			expect(await digest(await stored!.arrayBuffer())).toBe(await digest(file))
			expect(w.requests.filter((r) => r.endsWith(url))).toHaveLength(1)
			await w.exact()
		}
	)

	it('cancels a streamed body its admission refuses, putting nothing', async () => {
		const w = await mediaWorld()
		const author = await w.remote({ avatar: null })
		const url = 'https://files.example/m/v.mp4'
		await w.attach(author.id, url, { type: 'video' })
		const body = served(w, url, mp4({ mdat: 3 * MiB }))
		// The host is blocked after the fetch, before the admission.
		const store = new Proxy(w.t.store, {
			get: (target, key) => {
				const real = Reflect.get(target, key) as unknown
				if (key !== 'admitRemoteMedia' || typeof real !== 'function') {
					return real
				}
				return async (...args: unknown[]) => {
					await blockDomain(w.t.store, 'files.example', 'suspend')
					return (real as (...a: unknown[]) => Promise<unknown>).apply(target, args)
				}
			},
		})
		const puts: string[] = []
		const bucket = bucketWith({
			put: (key, real) => {
				puts.push(key)
				return real()
			},
		})
		expect(await w.round({ store: () => store, bucket: () => bucket })).toMatchObject({ claimed: 1, stored: 0 })
		expect(body.cancelled).toBe(true)
		expect(puts).toEqual([])
		await w.exact()
	})

	it(
		'gives up a streamed put at the file deadline, keeps the call outstanding, and dooms what lands late',
		{ timeout: 30_000 },
		async () => {
			const w = await mediaWorld()
			const author = await w.remote({ avatar: null })
			const url = 'https://files.example/m/v.mp4'
			await w.attach(author.id, url, { type: 'video' })
			// The fetch takes all of the file's deadline but its admission's Store call and a second: the put, held, is
			// given up at the deadline, some six seconds of real time later.
			const file = mp4({ mdat: 3 * MiB })
			served(w, url, file, () => {
				w.clock.now += WEB_MEDIA_TIMEOUT_MS - STORE_CALL_MS - 1000
			})
			// The put reads the whole body at once, and its answer is held past the deadline: it lands late.
			const gate = deferred()
			let landed: Promise<unknown> | undefined
			const bucket = bucketWith({
				put: async (_key, real) => {
					landed = real()
					await gate.promise
					return landed
				},
			})
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
			try {
				expect(await w.round({ bucket: () => bucket })).toMatchObject({ claimed: 1, stored: 0, failed: 1 })
				expect(outstandingRemoteMediaCalls()).toBeGreaterThan(0)
				const [object] = await w.objects()
				// Doomed for after any put of its claim can land.
				expect(object).toMatchObject({ state: 'doomed', slot_id: null })
				expect(object!.due_at).toBeGreaterThanOrEqual(object!.claimed_at + LATE_PUT_MS)
			} finally {
				warn.mockRestore()
				gate.resolve()
				await settle(() => outstandingRemoteMediaCalls() === 0)
			}
			// The late put succeeded: its file is in the bucket, whole, under the doomed object's key.
			await expect(landed).resolves.toBeTruthy()
			const [object] = await w.objects()
			expect((await env.MEDIA.head(`remote/${object!.token}/full`))?.size).toBe(file.length)
			expect((await attachmentSlots(w))[0]).toMatchObject({ token: null })
			await w.exact()
		}
	)

	it('reads one attachment file at a time while profile images go on beside it', async () => {
		const w = await mediaWorld()
		const author = await w.remote({ avatar: 'https://files.example/a.gif' })
		w.serve(author.avatar!, GIF)
		const held = deferred()
		let reading = 0
		let most = 0
		for (const n of [1, 2]) {
			const url = `https://files.example/m/${n}.gif`
			await w.attach(author.id, url)
			w.serve(url, async () => {
				reading++
				most = Math.max(most, reading)
				if (n === 1) {
					await held.promise
				}
				reading--
				return new Response(GIF)
			})
		}
		const round = w.round()
		await settle(() => w.requests.some((r) => r.endsWith('/m/1.gif')))
		await settle(() => w.requests.some((r) => r.endsWith('/a.gif')))
		expect(w.requests.some((r) => r.endsWith('/m/2.gif'))).toBe(false)
		held.resolve()
		expect(await round).toMatchObject({ claimed: 3, stored: 3 })
		expect(most).toBe(1)
		await w.exact()
	})
})

describe('the presented attachment (presentMedia)', () => {
	const row = (over: Partial<MediaRow>): MediaRow => ({
		id: '800000000000000001',
		type: 'image',
		url: 'https://files.example/m/1.png',
		preview_url: 'https://files.example/p/1.png',
		description: '',
		meta: null,
		focus_x: 0,
		focus_y: 0,
		blurhash: null,
		remote: 1,
		cached: null,
		cached_preview: null,
		...over,
	})
	const token = (c: string) => c.repeat(43)

	it('shows the cached file and icon on the origin, the still or the file as the preview, and keeps the remote URLs', () => {
		const file = `${token('F')}:gif:png`
		const icon = `${token('I')}:png:`
		expect(presentMedia(row({ cached: file, cached_preview: icon }), ORIGIN)).toMatchObject({
			url: `${ORIGIN}/media/r/${token('F')}/full.gif`,
			preview_url: `${ORIGIN}/media/r/${token('I')}/full.png`,
			remote_url: 'https://files.example/m/1.png',
			preview_remote_url: 'https://files.example/p/1.png',
		})
		// No cached icon: an image's still, else the file itself.
		expect(presentMedia(row({ cached: file }), ORIGIN).preview_url).toBe(`${ORIGIN}/media/r/${token('F')}/still.png`)
		expect(presentMedia(row({ cached: `${token('F')}:png:`, preview_url: null }), ORIGIN).preview_url).toBe(
			`${ORIGIN}/media/r/${token('F')}/full.png`
		)
		// Nothing cached: the remote URLs, as before.
		expect(presentMedia(row({}), ORIGIN)).toMatchObject({
			url: 'https://files.example/m/1.png',
			preview_url: 'https://files.example/p/1.png',
		})
		// Without an origin nothing is read from the cache.
		expect(presentMedia(row({ cached: file, cached_preview: icon }))).toMatchObject({
			url: 'https://files.example/m/1.png',
			preview_url: 'https://files.example/p/1.png',
		})
	})

	it('shows a cached video without an icon as its own preview, its remote icon first when it has one', () => {
		const file = `${token('V')}:mp4:`
		expect(presentMedia(row({ type: 'video', cached: file, preview_url: null }), ORIGIN)).toMatchObject({
			url: `${ORIGIN}/media/r/${token('V')}/full.mp4`,
			preview_url: `${ORIGIN}/media/r/${token('V')}/full.mp4`,
			preview_remote_url: null,
		})
		expect(presentMedia(row({ type: 'video', cached: file }), ORIGIN).preview_url).toBe('https://files.example/p/1.png')
	})

	it('shows the cache in a status and its remote URLs in its edit history', async () => {
		const { w, bob } = await world()
		const note = mastodonNote(bob, { attachment: [image(1)] })
		expect(await w.t.post(bob, create(bob, note))).toBe(202)
		await storeAll(w, { [`${MASTODON}/system/media/1.png`]: PNG })
		const edited = { ...note, content: '<p>edited</p>' }
		expect(await w.t.post(bob, update(bob, edited, '2026-10-11T12:10:00Z'))).toBe(202)
		const [slot] = await attachmentSlots(w)
		const [status] = await sql<{ id: string }>(w.t.store, 'SELECT id FROM statuses WHERE uri = ?', note.id)
		const { body } = await w.t.api<{ media_attachments: { url: string; remote_url: string }[] }>(
			`/api/v1/statuses/${status!.id}`
		)
		expect(body.media_attachments[0]!.url).toMatch(new RegExp(`/media/r/${slot!.token}/full\\.png$`))
		expect(body.media_attachments[0]!.remote_url).toBe(`${MASTODON}/system/media/1.png`)
		const history = await w.t.api<{ media_attachments: { url: string }[] }[]>(`/api/v1/statuses/${status!.id}/history`)
		expect(history.body.flatMap((edit) => edit.media_attachments.map((m) => m.url))).toEqual(
			history.body.map(() => `${MASTODON}/system/media/1.png`)
		)
	})
})
