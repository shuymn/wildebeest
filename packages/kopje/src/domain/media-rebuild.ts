import { chargeInstanceTransforms, TRANSFORMS_PER_UPLOAD } from './media'
import { mediaRebuildOperation, readOperation } from './operation'
import type { Db } from '../db/sql'
import { ACCESS_SETTINGS, accessRefusal, settingsFromRows, type SettingRow } from '../platform/access-settings'
import type { ImportAuthority } from '../platform/store-admin'

// The media rebuild (mastodon/media-rebuild.ts): local media whose row is complete but whose served files are not in R2
// get them made again from their original. That is media restored from a backup (which holds only the originals) and
// the images the cutover moved out of Cloudflare Images (`convert --images`).
//
// The Store does not know which files exist in R2, and no column says so: an upload completes only after its files
// are written, and a restore or a conversion writes rows whose files were never made. So the Store lists every
// complete local row with a file token, in id order and bounded pages, and the Worker asks R2 for each. Rows that are
// doomed (gc_at passed) are left to the sweep.
//
// The two writes (the transformation counter, the meta of a rebuilt row) are 'media-rebuild' operations, which the
// operator gate admits in readonly maintenance and while a verified import is unpublished (platform/store-flags.ts),
// so the files can be made before publication. Each checks the Access admin again in its transaction, as the cutover
// operations do (platform/store-admin.ts).

export const REBUILD_PAGE = 50

export type RebuildRow = { id: string; token: string; contentType: string | null }

function iso(ms: number): string {
	return new Date(ms).toISOString()
}

// Complete local media with a token that is not doomed: what is served, or should be.
const ELIGIBLE = `file_token IS NOT NULL AND processed = 1 AND url <> '' AND (gc_at IS NULL OR gc_at > ?)`

export const rebuildCandidates = readOperation<{ after: string | null; now: number }, RebuildRow[]>(
	(db, { after, now }) =>
		db.all<RebuildRow>(
			`SELECT id, file_token AS token, content_type AS contentType FROM media_attachments
			WHERE ${ELIGIBLE} AND id > ? ORDER BY id LIMIT ?`,
			iso(now),
			after ?? '',
			REBUILD_PAGE
		)
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

export type RebuildCharge = { status: 'ok' } | { status: 'budget_exhausted' } | { status: 'denied'; reason: string }

// Charges one rebuild's transformations (the full image and the preview) to the instance's budget of the month `now`
// is in, before Images is called, as an upload does (RES-6).
export const chargeRebuild = mediaRebuildOperation<
	{ authority: ImportAuthority; limit: number; now: number },
	RebuildCharge
>((db, { authority, limit, now }) => {
	const refused = adminRefused(db, authority)
	if (refused !== null) {
		return { status: 'denied', reason: refused }
	}
	return chargeInstanceTransforms(db, TRANSFORMS_PER_UPLOAD, limit, now)
		? { status: 'ok' }
		: { status: 'budget_exhausted' }
})

type Size = { width: number; height: number }

export type RebuildRecord = { status: 'ok' } | { status: 'gone' } | { status: 'denied'; reason: string }

// Records the sizes of the files the rebuild made, before they are written: the row must still be eligible with the
// same token and type, so files are never written for a row that changed or went. Only meta changes.
export const recordRebuild = mediaRebuildOperation<
	{
		authority: ImportAuthority
		id: string
		token: string
		contentType: string
		original: Size
		small: Size
		now: number
	},
	RebuildRecord
>((db, { authority, id, token, contentType, original, small, now }) => {
	const refused = adminRefused(db, authority)
	if (refused !== null) {
		return { status: 'denied', reason: refused }
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
