import type { Present } from './accounts'
import { visibleSql } from './audience'
import { optionalUserReadOperation } from './auth'
import { isHashtagName } from './status-text'
import { normalizeTag } from './tag-name'

// A hashtag as GET /api/v1/tags/:id shows it (Mastodon 4.0.2's Tag entity). Kopje has no tags table: any valid name is
// a tag, used or not, as Mastodon builds an unsaved Tag for a name it has never seen. The name is the normalized one
// statuses and search show. Tag follows do not exist yet, so a signed-in viewer follows none.

export type TagHistory = { day: string; uses: string; accounts: string }

export type Tag = { name: string; url: string; history: TagHistory[]; following?: false }

const HISTORY_DAYS = 7
const DAY_MS = 86_400_000

// Seven days of uses and distinct authors, today (UTC) first, as Mastodon's TagSerializer#history. It counts public
// originals only (Mastodon's Trends::Tags registers public statuses only) that anyone may see (visibleSql with no
// viewer: never a status of a suspended account), so it is the same for every viewer and reveals nothing a status's
// audience hides (VIS-12): the rule is applied in the query, with no limit for hidden statuses to take up. Days come
// from published_at. The work is a range of the (name, status_id) index cut by status id (RES-7): ids carry the
// publication time of statuses Kopje created or received (domain/ids.ts), and the receipt time of ids a cutover kept,
// so the range holds the tag's statuses the instance received in the last seven days, and the work follows the
// instance's own receive volume.
export const getTag = optionalUserReadOperation<{ name: string; now: number; present: Present }, Tag | null>(
	(db, { name, now, present }, { accountId: viewerId }) => {
		if (!isHashtagName(name)) {
			return null
		}
		const tag = normalizeTag(name)
		const today = Math.floor(now / DAY_MS) * DAY_MS
		const since = today - (HISTORY_DAYS - 1) * DAY_MS
		const rows = db.all<{ day: string; uses: number; accounts: number }>(
			`SELECT substr(s.published_at, 1, 10) AS day, COUNT(*) AS uses, COUNT(DISTINCT s.account_id) AS accounts
			FROM status_tags t JOIN statuses s ON s.id = t.status_id
			WHERE t.name = ?1 AND t.status_id >= ?2 AND s.visibility = 'public' AND s.reblog_of_id IS NULL
				AND ${visibleSql('s', 'NULL')}
			GROUP BY day`,
			tag,
			(BigInt(since) << 16n).toString()
		)
		const byDay = new Map(rows.map((row) => [row.day, row]))
		const history = Array.from({ length: HISTORY_DAYS }, (_, index) => {
			const start = today - index * DAY_MS
			const row = byDay.get(new Date(start).toISOString().slice(0, 10))
			return { day: String(start / 1000), uses: String(row?.uses ?? 0), accounts: String(row?.accounts ?? 0) }
		})
		return {
			name: tag,
			url: `${present.origin}/tags/${encodeURIComponent(tag)}`,
			history,
			...(viewerId === null ? {} : { following: false as const }),
		}
	}
)
