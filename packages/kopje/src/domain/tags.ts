import type { Present } from './accounts'
import { optionalUserReadOperation } from './auth'
import { isHashtagName, normalizeTag } from './status-text'

// A hashtag as GET /api/v1/tags/:id shows it (Mastodon 4.0.2's Tag entity). Kopje has no tags table: any valid name is
// a tag, used or not, as Mastodon builds an unsaved Tag for a name it has never seen. The name is the normalized one
// statuses and search show. Tag follows do not exist yet, so a signed-in viewer follows none.

export type TagHistory = { day: string; uses: string; accounts: string }

export type Tag = { name: string; url: string; history: TagHistory[]; following?: false }

const HISTORY_DAYS = 7
const DAY_MS = 86_400_000

// RES-7: the history reads at most this many of the tag's newest statuses in its window, through the (name, status_id)
// index; past it the counts of the oldest days stop growing.
export const MAX_TAG_HISTORY_STATUSES = 10_000

// Seven days of uses and distinct authors, today (UTC) first, as Mastodon's TagSerializer#history. It counts public and
// unlisted originals (Mastodon counts distributable statuses), never a status of a suspended account, so it is the
// same for every viewer and reveals nothing a status's audience hides (VIS-1). Days come from published_at; the window
// is cut by status id, which carries the publication time (domain/ids.ts).
export const getTag = optionalUserReadOperation<{ name: string; now: number; present: Present }, Tag | null>(
	(db, { name, now, present }, viewerId) => {
		if (!isHashtagName(name)) {
			return null
		}
		const tag = normalizeTag(name)
		const today = Math.floor(now / DAY_MS) * DAY_MS
		const since = today - (HISTORY_DAYS - 1) * DAY_MS
		const rows = db.all<{ day: string; uses: number; accounts: number }>(
			`SELECT substr(s.published_at, 1, 10) AS day, COUNT(*) AS uses, COUNT(DISTINCT s.account_id) AS accounts
			FROM (SELECT status_id FROM status_tags WHERE name = ?1 AND status_id >= ?2 ORDER BY status_id DESC LIMIT ?3) t
			JOIN statuses s ON s.id = t.status_id
			WHERE s.visibility IN ('public', 'unlisted') AND s.reblog_of_id IS NULL
				AND NOT EXISTS (SELECT 1 FROM local_accounts sus WHERE sus.account_id = s.account_id AND sus.suspended_at IS NOT NULL)
			GROUP BY day`,
			tag,
			(BigInt(since) << 16n).toString(),
			MAX_TAG_HISTORY_STATUSES
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
