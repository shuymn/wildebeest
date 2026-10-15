import { resolveAccountId } from './accounts'
import { recordOutbound } from './activities'
import { availableSql, DISTRIBUTABLE_SQL } from './audience'
import { userReadOperation, userWriteOperation } from './auth'
import { allocateLocalId } from './ids'
import { readOperation } from './operation'
import { isHashtagName } from './status-text'
import { normalizeTag } from './tag-name'
import type { Db } from '../db/sql'

// Featured hashtags (Mastodon 4.5's FeaturedTag, CreateFeaturedTagService and RemoveFeaturedTagService,
// Api::V1::FeaturedTagsController and Accounts::FeaturedTagsController). A local account features up to
// MAX_FEATURED_TAGS hashtags on its profile; each shows how many of the account's public and unlisted statuses carry
// it and when the newest was published. Those two are kept as the account's statuses are written, edited and deleted
// (countFeaturedTags, uncountFeaturedTags), as FeaturedTag#increment and #decrement keep them, so a read never counts.
// Featuring or unfeaturing sends the account's followers an Add or a Remove of the Hashtag (CreateFeaturedTagService,
// RemoveFeaturedTagService), and the actor's featuredTags collection lists them (federation.ts). Kopje does not read
// the featured hashtags of remote accounts.

// FeaturedTag::LIMIT, and its message (featured_tags.errors.limit).
export const MAX_FEATURED_TAGS = 10
const TOO_MANY = 'You have already featured the maximum number of hashtags'

// REST::FeaturedTagSerializer.
export type FeaturedTag = {
	id: string
	name: string
	url: string
	statuses_count: string
	last_status_at: string | null
}

type FeaturedRow = {
	id: string
	name: string
	display_name: string
	statuses_count: number
	last_status_at: string | null
	username: string
}

const FEATURED_COLUMNS = `f.id, f.name, f.display_name, f.statuses_count, f.last_status_at, a.username`
const FEATURED_FROM = 'FROM featured_tags f JOIN accounts a ON a.id = f.account_id'

// The URL of the account's statuses with the hashtag (Mastodon's short_account_tag_url): its profile, tagged.
export function taggedUrl(origin: string, username: string, name: string): string {
	return `${origin}/@${username}/tagged/${encodeURIComponent(name)}`
}

function presentFeatured(row: FeaturedRow, origin: string): FeaturedTag {
	return {
		id: row.id,
		name: row.display_name,
		url: taggedUrl(origin, row.username, row.name),
		statuses_count: String(row.statuses_count),
		// Mastodon shows the date of the newest status only (last_status_at.to_date.iso8601).
		last_status_at: row.last_status_at?.slice(0, 10) ?? null,
	}
}

// GET /api/v1/featured_tags: the viewer's featured hashtags, the most used first (order(statuses_count: :desc)).
export const listFeaturedTags = userReadOperation<{ present: { origin: string } }, FeaturedTag[]>(
	(db, { present }, { accountId }) =>
		db
			.all<FeaturedRow>(
				`SELECT ${FEATURED_COLUMNS} ${FEATURED_FROM} WHERE f.account_id = ? ORDER BY f.statuses_count DESC, f.id`,
				accountId
			)
			.map((row) => presentFeatured(row, present.origin))
)

// GET /api/v1/accounts/:id/featured_tags: an account's featured hashtags, to anyone, none for an account that is not
// available (Accounts::FeaturedTagsController: @account.unavailable? ? []). Null for an unknown account.
export const accountFeaturedTags = readOperation<{ id: string; present: { origin: string } }, FeaturedTag[] | null>(
	(db, { id, present }) => {
		const accountId = resolveAccountId(db, id)
		if (accountId === null) {
			return null
		}
		return db
			.all<FeaturedRow>(
				`SELECT ${FEATURED_COLUMNS} ${FEATURED_FROM} WHERE f.account_id = ?1 AND ${availableSql('?1')} ORDER BY f.id`,
				accountId
			)
			.map((row) => presentFeatured(row, present.origin))
	}
)

export type FeatureResult =
	{ status: 'ok'; value: FeaturedTag } | { status: 'invalid'; errors: string[] } | { status: 'not_found' }

// The account's featured hashtag of the normalized name, if any.
export function featuredTagNamed(db: Db, accountId: string, name: string): FeaturedRow | undefined {
	return db.first<FeaturedRow>(
		`SELECT ${FEATURED_COLUMNS} ${FEATURED_FROM} WHERE f.account_id = ? AND f.name = ?`,
		accountId,
		name
	)
}

// Features the hashtag `display` (a valid hashtag name) for the account: the row, with its counts read from the
// account's statuses as FeaturedTag#reset_data reads them, and the Add its followers are sent. Refused at
// MAX_FEATURED_TAGS (validate_featured_tags_limit). The caller has checked that it is not featured yet.
function insertFeatured(
	db: Db,
	accountId: string,
	display: string,
	now: number,
	origin: string
): { status: 'ok'; row: FeaturedRow } | { status: 'invalid'; errors: string[] } {
	const name = normalizeTag(display)
	const featured = db.first<{ n: number }>('SELECT count(*) AS n FROM featured_tags WHERE account_id = ?', accountId)
	if ((featured?.n ?? 0) >= MAX_FEATURED_TAGS) {
		return { status: 'invalid', errors: [TOO_MANY] }
	}
	// The account's public and unlisted statuses with the hashtag, and the newest (by id, as Mastodon's default order
	// picks it). A walk of the account's own statuses, once, when the account features the hashtag.
	const counted = db.first<{ n: number; last: string | null }>(
		`SELECT c.n, (SELECT published_at FROM statuses WHERE id = c.last_id) AS last
		FROM (SELECT count(*) AS n, max(s.id) AS last_id FROM statuses s
			WHERE s.account_id = ?1 AND s.reblog_of_id IS NULL AND s.visibility IN ${DISTRIBUTABLE_SQL}
				AND EXISTS (SELECT 1 FROM status_tags t WHERE t.status_id = s.id AND t.name = ?2)) c`,
		accountId,
		name
	)
	db.run(
		`INSERT INTO featured_tags (id, account_id, name, display_name, statuses_count, last_status_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		allocateLocalId(db, now),
		accountId,
		name,
		display,
		counted?.n ?? 0,
		counted?.last ?? null,
		new Date(now).toISOString()
	)
	const row = featuredTagNamed(db, accountId, name)
	if (row === undefined) {
		throw new Error('the featured hashtag was not written')
	}
	recordFeaturedChange(db, accountId, 'Add', row, now, origin)
	return { status: 'ok', row }
}

// FeaturedTag's normalization of a name: surrounding whitespace and one leading # dropped.
function displayName(name: string): string {
	return name.trim().replace(/^#/, '')
}

// POST /api/v1/featured_tags (CreateFeaturedTagService with a name): the featured hashtag of that name if the account
// already features it under the same spelling, else a new one, with FeaturedTag's validations in its order and with
// Rails' messages. Mastodon finds an existing one by the name as written, so the same hashtag under another spelling
// fails the uniqueness validation of its tag.
export const createFeaturedTag = userWriteOperation<
	{ name: string; now: number; present: { origin: string } },
	FeatureResult
>((db, input, { accountId }) => {
	const display = displayName(input.name)
	const name = normalizeTag(display)
	const existing = display === '' ? undefined : featuredTagNamed(db, accountId, name)
	if (existing !== undefined && existing.display_name === display) {
		return { status: 'ok', value: presentFeatured(existing, input.present.origin) }
	}
	const errors: string[] = []
	if (display === '') {
		errors.push("Name can't be blank")
	} else if (!isHashtagName(display)) {
		errors.push('Name is invalid')
	}
	if (existing !== undefined) {
		errors.push('Tag has already been taken')
	}
	const count = db.first<{ n: number }>('SELECT count(*) AS n FROM featured_tags WHERE account_id = ?', accountId)
	if ((count?.n ?? 0) >= MAX_FEATURED_TAGS) {
		errors.push(TOO_MANY)
	}
	if (errors.length > 0) {
		return { status: 'invalid', errors }
	}
	const written = insertFeatured(db, accountId, display, input.now, input.present.origin)
	return written.status === 'ok' ? { status: 'ok', value: presentFeatured(written.row, input.present.origin) } : written
})

// DELETE /api/v1/featured_tags/:id (RemoveFeaturedTagService): the viewer's own only; a Remove to their followers.
export const deleteFeaturedTag = userWriteOperation<{ id: string; now: number; origin: string }, boolean>(
	(db, { id, now, origin }, { accountId }) => {
		const row = db.first<FeaturedRow>(
			`SELECT ${FEATURED_COLUMNS} ${FEATURED_FROM} WHERE f.id = ? AND f.account_id = ?`,
			id,
			accountId
		)
		if (row === undefined) {
			return false
		}
		removeFeatured(db, accountId, row, now, origin)
		return true
	}
)

function removeFeatured(db: Db, accountId: string, row: FeaturedRow, now: number, origin: string): void {
	db.run('DELETE FROM featured_tags WHERE id = ?', row.id)
	recordFeaturedChange(db, accountId, 'Remove', row, now, origin)
}

// POST /api/v1/tags/:id/feature (CreateFeaturedTagService with a tag): features the hashtag `display` (a valid name)
// unless the account already does.
export function featureTag(
	db: Db,
	accountId: string,
	display: string,
	now: number,
	origin: string
): { status: 'ok' } | { status: 'invalid'; errors: string[] } {
	if (featuredTagNamed(db, accountId, normalizeTag(display)) !== undefined) {
		return { status: 'ok' }
	}
	const written = insertFeatured(db, accountId, display, now, origin)
	return written.status === 'ok' ? { status: 'ok' } : written
}

// POST /api/v1/tags/:id/unfeature (RemoveFeaturedTagService with a tag): nothing when it is not featured.
export function unfeatureTag(db: Db, accountId: string, name: string, now: number, origin: string): void {
	const row = featuredTagNamed(db, accountId, name)
	if (row !== undefined) {
		removeFeatured(db, accountId, row, now, origin)
	}
}

// The Add or Remove of a featured hashtag (ActivityPub::AddSerializer and RemoveSerializer with a FeaturedTag): the
// Hashtag (ActivityPub::HashtagSerializer: its name with a #, and the account's statuses with it) added to or removed
// from the collection Mastodon names as the target, the actor's featured collection, which Mastodon's
// ActivityPub::Activity::Add and Remove match against the actor's `featured`. Mastodon's has no id; Kopje's carries
// one, as every activity it records does. Sent to the followers, as ActivityPub::AccountRawDistributionWorker sends it.
function recordFeaturedChange(
	db: Db,
	accountId: string,
	type: 'Add' | 'Remove',
	row: FeaturedRow,
	now: number,
	origin: string
): void {
	const actor = db.first<{ uri: string }>('SELECT uri FROM accounts WHERE id = ?', accountId)?.uri
	if (actor === undefined) {
		return
	}
	recordOutbound(
		db,
		accountId,
		{
			activity: {
				'@context': ['https://www.w3.org/ns/activitystreams', { Hashtag: 'as:Hashtag' }],
				id: `${actor}#featured_tags/${allocateLocalId(db, now)}`,
				type,
				actor,
				target: `${actor}/collections/featured`,
				object: { type: 'Hashtag', href: taggedUrl(origin, row.username, row.name), name: `#${row.display_name}` },
			},
			audience: { followers: true, accounts: [] },
		},
		now
	)
}

// ---- Counts. A status counts for a featured hashtag of its author when it is an original (not a boost), public or
// unlisted, and carries the hashtag (FeaturedTag#visible_tagged_account_statuses: distributable_visibility).

// The status's author, its publication time, and the names of its hashtags its author features, if it counts (none
// when it does not, or when its author features none of them).
export type FeaturedOfStatus = { accountId: string; publishedAt: string; id: string; names: string[] }

export function featuredOfStatus(db: Db, statusId: string): FeaturedOfStatus | null {
	const status = db.first<{ account_id: string; published_at: string; counted: number }>(
		`SELECT account_id, published_at, reblog_of_id IS NULL AND visibility IN ${DISTRIBUTABLE_SQL} AS counted
		FROM statuses WHERE id = ?`,
		statusId
	)
	if (status === undefined || status.counted !== 1) {
		return null
	}
	const names = db
		.all<{ name: string }>(
			`SELECT t.name FROM status_tags t JOIN featured_tags f ON f.account_id = ?2 AND f.name = t.name
			WHERE t.status_id = ?1`,
			statusId,
			status.account_id
		)
		.map((row) => row.name)
	return { accountId: status.account_id, publishedAt: status.published_at, id: statusId, names }
}

// After the hashtags of a status were written (a post, an edit): the featured hashtags it gained count it, those it
// lost no longer do (ProcessHashtagsService#update_featured_tags!). `before` is featuredOfStatus before the write.
export function countFeaturedTags(db: Db, statusId: string, before: FeaturedOfStatus | null): void {
	const after = featuredOfStatus(db, statusId)
	if (after === null) {
		return
	}
	const previous = new Set(before?.names ?? [])
	const current = new Set(after.names)
	const added = after.names.filter((name) => !previous.has(name))
	const removed = [...previous].filter((name) => !current.has(name))
	if (added.length > 0) {
		// FeaturedTag#increment. Mastodon sets last_status_at to the status's time even when the status is older than
		// the newest with the hashtag (an edit adding it to an old status); Kopje keeps the newest.
		db.run(
			`UPDATE featured_tags SET statuses_count = statuses_count + 1,
				last_status_at = max(coalesce(last_status_at, ''), ?3)
			WHERE account_id = ?1 AND name IN (SELECT value FROM json_each(?2))`,
			after.accountId,
			JSON.stringify(added),
			after.publishedAt
		)
	}
	decrement(db, { ...after, names: removed })
}

// Before a status is deleted: the featured hashtags it counted for no longer count it (RemoveStatusService#
// remove_from_hashtags).
export function uncountFeaturedTags(db: Db, statusId: string): void {
	const featured = featuredOfStatus(db, statusId)
	if (featured !== null) {
		decrement(db, featured)
	}
}

// FeaturedTag#decrement for the status's featured hashtags `names`: one less, and when the status was the newest
// with the hashtag, the time of the newest before it, found by walking the account's statuses back from it (the work
// Mastodon also does there). The last one leaves the count at zero and no time.
function decrement(db: Db, status: FeaturedOfStatus): void {
	if (status.names.length === 0) {
		return
	}
	db.run(
		`UPDATE featured_tags SET statuses_count = max(statuses_count - 1, 0),
			last_status_at = CASE
				WHEN statuses_count <= 1 THEN NULL
				WHEN last_status_at > ?3 THEN last_status_at
				ELSE (SELECT s.published_at FROM statuses s
					WHERE s.account_id = ?1 AND s.id < ?4 AND s.reblog_of_id IS NULL AND s.visibility IN ${DISTRIBUTABLE_SQL}
						AND EXISTS (SELECT 1 FROM status_tags t WHERE t.status_id = s.id AND t.name = featured_tags.name)
					ORDER BY s.id DESC LIMIT 1)
			END
		WHERE account_id = ?1 AND name IN (SELECT value FROM json_each(?2))`,
		status.accountId,
		JSON.stringify(status.names),
		status.publishedAt,
		status.id
	)
}
