import { chargeInstanceTransforms, TRANSFORMS_PER_UPLOAD } from './media'
import { mediaRebuildOperation, readOperation } from './operation'
import type { Db } from '../db/sql'
import { ACCESS_SETTINGS, accessRefusal, settingsFromRows, type SettingRow } from '../platform/access-settings'
import type { ImportAuthority } from '../platform/store-admin'
import { REBUILD_LEASE } from '../platform/store-flags'

// The media rebuild (mastodon/media-rebuild.ts): local media whose row is complete but whose served files are not in R2
// get them made again from their original. That is media restored from a backup (which holds only the originals) and
// the images the cutover moved out of Cloudflare Images (`convert --images`).
//
// The Store does not know which files exist in R2, and no column says so: an upload completes only after its files
// are written, and a restore or a conversion writes rows whose files were never made. So the Store lists every
// complete local row with a file token, in id order, and the Worker asks R2 for each. Rows that are doomed (gc_at
// passed) are left to the sweep. One listing scans at most SCAN_WINDOW rows by id, whatever they are, and returns at
// most REBUILD_PAGE candidates from them, with the id it scanned to: a long run of rows that are not candidates (remote,
// doomed) costs bounded work per call and is not scanned again.
//
// The rebuild runs only while nothing can delete media: the Store is unpublished after a verified import, or in its
// readonly maintenance, or the Worker's env MAINTENANCE is readonly or full (which stops the cron and every API
// write). Then no delete_media, sweep or reconciliation runs (their Store writes are refused before they touch R2), so
// no row can go while its files are written. And one rebuild call runs at a time, under a lease kept in kopje_state
// (REBUILD_LEASE), so no two calls charge and write the same row; while the lease is live the Store refuses to begin
// an import, reset one, reset a cutover or publish (platform/store-admin.ts), so the rows cannot change under it.
//
// Its writes (the lease, the transformation counter, the meta of a rebuilt row) are 'media-rebuild' operations, which
// the operator gate admits in readonly maintenance and while a verified import is unpublished (platform/store-flags.ts).
// Each checks the Access admin again in its transaction, as the cutover operations do (platform/store-admin.ts), and
// the counter and meta writes also the caller's lease.

export const REBUILD_PAGE = 50
export const SCAN_WINDOW = 500

export type RebuildRow = { id: string; token: string; contentType: string | null }

// rows: the candidates; next: the id the listing scanned to (the next listing starts after it); done: nothing is after
// it.
export type RebuildPage = { rows: RebuildRow[]; next: string | null; done: boolean }

function iso(ms: number): string {
	return new Date(ms).toISOString()
}

// Complete local media with a token that is not doomed: what is served, or should be.
const ELIGIBLE = `file_token IS NOT NULL AND processed = 1 AND url <> '' AND (gc_at IS NULL OR gc_at > ?)`

export const rebuildCandidates = readOperation<{ after: string | null; now: number }, RebuildPage>(
	(db, { after, now }) => {
		const scanned = db.all<{ id: string }>(
			'SELECT id FROM media_attachments WHERE id > ? ORDER BY id LIMIT ?',
			after ?? '',
			SCAN_WINDOW
		)
		const last = scanned.at(-1)?.id
		if (last === undefined) {
			return { rows: [], next: after, done: true }
		}
		const rows = db.all<RebuildRow>(
			`SELECT id, file_token AS token, content_type AS contentType FROM media_attachments
			WHERE ${ELIGIBLE} AND id > ? AND id <= ? ORDER BY id LIMIT ?`,
			iso(now),
			after ?? '',
			last,
			REBUILD_PAGE
		)
		if (rows.length === REBUILD_PAGE) {
			return { rows, next: rows.at(-1)?.id ?? last, done: false }
		}
		return { rows, next: last, done: scanned.length < SCAN_WINDOW }
	}
)

// Whether a row is still a candidate with this token: the rebuild asks after its files are written (mastodon/
// media-rebuild.ts).
export const rebuildRowLive = readOperation<{ id: string; token: string; now: number }, boolean>(
	(db, { id, token, now }) =>
		db.first(
			`SELECT 1 AS found FROM media_attachments WHERE id = ? AND file_token = ? AND ${ELIGIBLE}`,
			id,
			token,
			iso(now)
		) !== undefined
)

// The Access admin, checked against the saved configuration, as the Worker verified it. IMPORT_TOKEN and import
// sessions never rebuild: the cutover runs this through Access, after the token is retired.
function adminRefused(db: Db, authority: ImportAuthority): string | null {
	if (authority.kind !== 'access') {
		return 'only an Access admin rebuilds media'
	}
	const names = Object.values(ACCESS_SETTINGS)
	const rows = db.all<SettingRow>(
		`SELECT name, value FROM instance_settings WHERE name IN (${names.map(() => '?').join(',')})`,
		...names
	)
	return accessRefusal(settingsFromRows(rows), authority)
}

// The rebuild's lease (REBUILD_LEASE in kopje_state; not dumped, imported or reset).
// Well above one call (at most MAX_BUILDS_PER_CALL images, each step bounded by the call's deadline): a call that gives
// up a step keeps the lease until anything it began is long gone.
export const REBUILD_LEASE_MS = 5 * 60 * 1000

type Lease = { holder: string; until: number }

function readLease(db: Db): Lease | null {
	const value = db.first<{ value: string }>('SELECT value FROM kopje_state WHERE name = ?', REBUILD_LEASE)?.value
	return value === undefined ? null : (JSON.parse(value) as Lease)
}

function holds(db: Db, holder: string, now: number): boolean {
	const lease = readLease(db)
	return lease !== null && lease.holder === holder && lease.until > now
}

// The Store refuses other writes: a verified import is unpublished, or its readonly maintenance is on (the flags of
// platform/store-flags.ts).
function storeHeld(db: Db): boolean {
	return db.first("SELECT 1 AS found FROM kopje_state WHERE name IN ('unpublished', 'maintenance')") !== undefined
}

export type RebuildLeaseResult =
	| { status: 'ok'; until: number | null }
	| { status: 'needs-readonly' }
	| { status: 'busy'; until: number }
	| { status: 'denied'; reason: string }

// Takes (or renews) the lease for `holder`, or releases it. `envHeld`: the Worker's env MAINTENANCE is readonly or
// full. A release by a holder that no longer holds it changes nothing.
export const rebuildLease = mediaRebuildOperation<
	{ authority: ImportAuthority; holder: string; release?: boolean; envHeld: boolean; now: number },
	RebuildLeaseResult
>((db, { authority, holder, release, envHeld, now }) => {
	const refused = adminRefused(db, authority)
	if (refused !== null) {
		return { status: 'denied', reason: refused }
	}
	const lease = readLease(db)
	if (release === true) {
		if (lease?.holder === holder) {
			db.run('DELETE FROM kopje_state WHERE name = ?', REBUILD_LEASE)
		}
		return { status: 'ok', until: null }
	}
	if (!envHeld && !storeHeld(db)) {
		return { status: 'needs-readonly' }
	}
	if (lease !== null && lease.holder !== holder && lease.until > now) {
		return { status: 'busy', until: lease.until }
	}
	const until = now + REBUILD_LEASE_MS
	db.run(
		'INSERT OR REPLACE INTO kopje_state (name, value) VALUES (?, ?)',
		REBUILD_LEASE,
		JSON.stringify({ holder, until } satisfies Lease)
	)
	return { status: 'ok', until }
})

export type RebuildCharge =
	{ status: 'ok' } | { status: 'budget_exhausted' } | { status: 'lease-lost' } | { status: 'denied'; reason: string }

// Charges one rebuild's transformations (the full image and the preview) to the instance's budget of the month `now`
// is in, before Images is called, as an upload does (RES-6).
export const chargeRebuild = mediaRebuildOperation<
	{ authority: ImportAuthority; holder: string; limit: number; now: number },
	RebuildCharge
>((db, { authority, holder, limit, now }) => {
	const refused = adminRefused(db, authority)
	if (refused !== null) {
		return { status: 'denied', reason: refused }
	}
	if (!holds(db, holder, now)) {
		return { status: 'lease-lost' }
	}
	return chargeInstanceTransforms(db, TRANSFORMS_PER_UPLOAD, limit, now)
		? { status: 'ok' }
		: { status: 'budget_exhausted' }
})

type Size = { width: number; height: number }

export type RebuildRecord =
	{ status: 'ok' } | { status: 'gone' } | { status: 'lease-lost' } | { status: 'denied'; reason: string }

// Records the sizes of the files the rebuild made, before they are written: the row must still be eligible with the
// same token and type, so files are not written for a row that changed or went. Only meta changes. A row doomed after
// this is caught by rebuildRowLive once the files are written.
export const recordRebuild = mediaRebuildOperation<
	{
		authority: ImportAuthority
		holder: string
		id: string
		token: string
		contentType: string
		original: Size
		small: Size
		now: number
	},
	RebuildRecord
>((db, { authority, holder, id, token, contentType, original, small, now }) => {
	const refused = adminRefused(db, authority)
	if (refused !== null) {
		return { status: 'denied', reason: refused }
	}
	if (!holds(db, holder, now)) {
		return { status: 'lease-lost' }
	}
	const changed = db.run(
		`UPDATE media_attachments SET meta = ? WHERE id = ? AND file_token = ? AND content_type = ? AND ${ELIGIBLE}`,
		JSON.stringify({ original, small }),
		id,
		token,
		contentType,
		iso(now)
	)
	return changed === 0 ? { status: 'gone' } : { status: 'ok' }
})
