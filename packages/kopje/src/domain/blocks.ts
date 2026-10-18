import {
	type Account,
	accountPage,
	accountsOf,
	edgeRangeSql,
	type Page,
	type PageQuery,
	type Present,
	relationshipResult,
	type RelationshipResult,
	resolveAccountId,
} from './accounts'
import {
	blockActivity,
	blockUri,
	followAnswerActivity,
	followUri,
	recordOutbound,
	undoBlockActivity,
	undoFollowActivity,
} from './activities'
import { admit, admittedPage, ARRAY_ANSWER_BYTES } from './answer-budget'
import { activeMuteSql, inDomainSql } from './audience'
import { userReadOperation, userWriteOperation } from './auth'
import { leaveConversationsWith } from './conversations'
import { retractFollow } from './inbox'
import { writeOperation } from './operation'
import type { Db } from '../db/sql'

// Blocks, mutes and domain blocks of local users (Mastodon 4.5's BlockService, UnblockService, MuteService,
// UnmuteService, AccountDomainBlocksController and AfterBlockDomainFromAccountService). Their effect on what a user
// sees and is notified of is applied where those are read and written (audience.ts, notifications.ts, timelines.ts);
// here they are recorded, and the relationships they end are ended:
//
//   - A block ends the follows between the two accounts, either way and in either state, and the blocker's
//     conversations with the blocked account (AfterBlockService#clear_conversations!). Our follow of a remote
//     account is undone there (Undo Follow), and a remote account's follow of us is answered with a Reject; a remote
//     target is sent the Block, and an unblock its Undo. A local block always applies: the ended Follow's id is
//     recorded as retracted (ID-7) only within the remote actor's retraction cap, since the block itself refuses that
//     actor's Follows while it lasts.
//   - A mute is local only. It hides notifications too unless notifications=false, and expires after duration seconds
//     (0: never); an expired mute stops applying at its time (activeMuteSql) and is swept later.
//   - A domain block hides every account of that domain (inDomainSql: its stored domain or its actor's host,
//     exactly, as Mastodon's AccountDomainBlock matches), and ends the user's follows to and from accounts there, in
//     either state (AfterBlockDomainFromAccountService: a Reject to each follower, an Undo of each of our follows).
//     That is a durable cleanup (domain_block_cleanups) done in batches that each scan DOMAIN_BLOCK_WINDOW follows by
//     id (RES-6, RES-7): the first in the request, the rest by runDomainBlockCleanups, which the Queue and the cron
//     run with the inbound jobs. Meanwhile followers there get nothing that carries content recorded after the block
//     (recipientsFor in audience.ts).
//     An unblock deletes the cleanup with the block: what was removed stays removed, and the rest stays.

// Follows rows one cleanup batch scans, and batches one runDomainBlockCleanups call does at most.
export const DOMAIN_BLOCK_WINDOW = 500
export const DOMAIN_BLOCK_BATCHES_PER_RUN = 4

type Party = { id: string; uri: string; local: number }

function party(db: Db, id: string): Party | undefined {
	return db.first<Party>('SELECT id, uri, domain IS NULL AS local FROM accounts WHERE id = ?', id)
}

// Ends the follow of `follower` to `target` in either state, with its follow notifications, as UnfollowService and
// RejectFollowService do: a local follower's follow of a remote target is undone there, and a remote follower of a
// local target is sent a Reject (one that withdraws the follow if it had been accepted, deliveries.ts). The local
// sides' counts lose the removed edge if it was accepted (a remote account's counts are its server's). Returns
// whether an activity was recorded. severing (R38): a remote follower's request (pending) is deleted without a Reject,
// as Mastodon's SuspendAccountService leaves a suspended account's requests unanswered; an accepted follow's Reject
// goes to the follower's current inbox alone (audienceOnly), as Mastodon's reject_remote_follows! sends it, never to
// the earlier receivers of the Accepts it withdraws, so recording it costs a constant.
function endFollow(db: Db, follower: Party, target: Party, now: number, severing = false): boolean {
	const edge = db.first<{ id: string; uri: string | null; state: string }>(
		`DELETE FROM follows WHERE account_id = ? AND target_account_id = ?
		RETURNING CAST(id AS TEXT) AS id, uri, state`,
		follower.id,
		target.id
	)
	if (edge === undefined) {
		return false
	}
	db.run(
		"DELETE FROM notifications WHERE account_id = ? AND from_account_id = ? AND type IN ('follow', 'follow_request')",
		target.id,
		follower.id
	)
	if (edge.state === 'accepted') {
		db.run(
			'UPDATE accounts SET following_count = max(following_count - 1, 0) WHERE id = ? AND domain IS NULL',
			follower.id
		)
		db.run(
			'UPDATE accounts SET followers_count = max(followers_count - 1, 0) WHERE id = ? AND domain IS NULL',
			target.id
		)
	}
	if (follower.local === 1 && target.local === 0) {
		recordOutbound(
			db,
			follower.id,
			undoFollowActivity({
				followUri: edge.uri ?? followUri(follower.uri, edge.id),
				actorUri: follower.uri,
				targetUri: target.uri,
				targetId: target.id,
			}),
			now
		)
		return true
	}
	if (follower.local === 0 && target.local === 1) {
		if (edge.uri !== null) {
			retractFollow(db, follower.uri, edge.uri, now)
		}
		if (severing && edge.state !== 'accepted') {
			return false
		}
		recordOutbound(
			db,
			target.id,
			followAnswerActivity('Reject', {
				localActorUri: target.uri,
				followerUri: follower.uri,
				followerId: follower.id,
				followUri: edge.uri,
				edgeId: edge.id,
			}),
			now,
			{ withdraws: edge.state === 'accepted', audienceOnly: severing }
		)
		return true
	}
	return false
}

// R38's severing (remote-suspension.ts) of a follow between a remote and a local account, either way; see endFollow
// for the Reject/Undo rules. Returns whether an activity was recorded.
export function severFollow(db: Db, followerId: string, targetId: string, now: number): boolean {
	const follower = party(db, followerId)
	const target = party(db, targetId)
	return follower !== undefined && target !== undefined && endFollow(db, follower, target, now, true)
}

type Target = { status: 'ok'; viewer: Party; target: Party } | { status: 'not_found' } | { status: 'forbidden' }

// The account a block or mute names. Any stored account may be blocked or muted, a suspended one included; nobody
// blocks or mutes themselves.
function relationTarget(db: Db, viewerId: string, id: string): Target {
	const resolved = resolveAccountId(db, id)
	const target = resolved === null ? undefined : party(db, resolved)
	const viewer = party(db, viewerId)
	if (target === undefined || viewer === undefined) {
		return { status: 'not_found' }
	}
	return target.id === viewer.id ? { status: 'forbidden' } : { status: 'ok', viewer, target }
}

export type RelationInput = { target: string; now: number }

// BlockService: the follows either way end, then the block is recorded, and a remote target is sent the Block. Blocking
// an account already blocked changes nothing.
export const block = userWriteOperation<RelationInput, RelationshipResult>((db, input, { accountId }) => {
	const found = relationTarget(db, accountId, input.target)
	if (found.status !== 'ok') {
		return found
	}
	const { viewer, target } = found
	const existing = db.first(
		'SELECT 1 AS x FROM blocks WHERE account_id = ? AND target_account_id = ?',
		viewer.id,
		target.id
	)
	if (existing === undefined) {
		endFollow(db, viewer, target, input.now)
		endFollow(db, target, viewer, input.now)
		leaveConversationsWith(db, viewer.id, target.id)
		// AfterBlockService#clear_notification_requests!: the request of the blocked account's filtered mentions goes.
		db.run('DELETE FROM notification_requests WHERE account_id = ? AND from_account_id = ?', viewer.id, target.id)
		// BlockService#call: a permission given to the account by accepting its request goes too, so after an unblock its
		// notifications meet the policy again.
		db.run('DELETE FROM notification_permissions WHERE account_id = ? AND from_account_id = ?', viewer.id, target.id)
		const edge = db.first<{ id: string }>(
			`INSERT INTO blocks (account_id, target_account_id, created_at) VALUES (?, ?, ?)
			RETURNING CAST(id AS TEXT) AS id`,
			viewer.id,
			target.id,
			new Date(input.now).toISOString()
		)
		if (edge !== undefined && target.local === 0) {
			const uri = blockUri(viewer.uri, edge.id)
			db.run('UPDATE blocks SET uri = ? WHERE id = CAST(? AS INTEGER)', uri, edge.id)
			recordOutbound(
				db,
				viewer.id,
				blockActivity({ blockUri: uri, actorUri: viewer.uri, targetUri: target.uri, targetId: target.id }),
				input.now
			)
		}
	}
	return relationshipResult(db, viewer.id, target.id, input.now)
})

// UnblockService: the block goes, and a remote target is sent its Undo. A migrated block without a uri is named as
// this instance would have named it.
export const unblock = userWriteOperation<RelationInput, RelationshipResult>((db, input, { accountId }) => {
	const found = relationTarget(db, accountId, input.target)
	if (found.status !== 'ok') {
		return found
	}
	const { viewer, target } = found
	const removed = db.first<{ id: string; uri: string | null }>(
		'DELETE FROM blocks WHERE account_id = ? AND target_account_id = ? RETURNING CAST(id AS TEXT) AS id, uri',
		viewer.id,
		target.id
	)
	if (removed !== undefined && target.local === 0) {
		recordOutbound(
			db,
			viewer.id,
			undoBlockActivity({
				blockUri: removed.uri ?? blockUri(viewer.uri, removed.id),
				actorUri: viewer.uri,
				targetUri: target.uri,
				targetId: target.id,
			}),
			input.now
		)
	}
	return relationshipResult(db, viewer.id, target.id, input.now)
})

// POST /api/v1/accounts/:id/remove_from_followers (RemoveFromFollowersService): the account's accepted follow of the
// viewer ends as a block ends it (endFollow): a remote follower is sent the Reject that withdraws it, a local one's
// follow simply ends. A pending request is left alone (the service reads passive_relationships, accepted follows only),
// and so is everything else for any other stored account, the viewer included.
export const removeFromFollowers = userWriteOperation<RelationInput, RelationshipResult>((db, input, { accountId }) => {
	const resolved = resolveAccountId(db, input.target)
	const follower = resolved === null ? undefined : party(db, resolved)
	const viewer = party(db, accountId)
	if (follower === undefined || viewer === undefined) {
		return { status: 'not_found' }
	}
	const accepted = db.first(
		"SELECT 1 AS x FROM follows WHERE account_id = ? AND target_account_id = ? AND state = 'accepted'",
		follower.id,
		viewer.id
	)
	if (accepted !== undefined) {
		endFollow(db, follower, viewer, input.now)
	}
	return relationshipResult(db, viewer.id, follower.id, input.now)
})

// Account#mute!: a new mute, or new options for an existing one (an expired one included). expiresAt is null for an
// indefinite mute.
export const mute = userWriteOperation<
	RelationInput & { notifications: boolean; expiresAt: string | null },
	RelationshipResult
>((db, input, { accountId }) => {
	const found = relationTarget(db, accountId, input.target)
	if (found.status !== 'ok') {
		return found
	}
	db.run(
		`INSERT INTO mutes (account_id, target_account_id, hide_notifications, expires_at, created_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (account_id, target_account_id) DO UPDATE SET hide_notifications = excluded.hide_notifications,
			expires_at = excluded.expires_at`,
		found.viewer.id,
		found.target.id,
		input.notifications ? 1 : 0,
		input.expiresAt,
		new Date(input.now).toISOString()
	)
	return relationshipResult(db, found.viewer.id, found.target.id, input.now)
})

export const unmute = userWriteOperation<RelationInput, RelationshipResult>((db, input, { accountId }) => {
	const found = relationTarget(db, accountId, input.target)
	if (found.status !== 'ok') {
		return found
	}
	db.run('DELETE FROM mutes WHERE account_id = ? AND target_account_id = ?', found.viewer.id, found.target.id)
	return relationshipResult(db, found.viewer.id, found.target.id, input.now)
})

export type MutedAccount = Account & { mute_expires_at: string | null }

// Keyset pages over an edge table's INTEGER id (the cursor), newest first, as listFollows pages.
function edgePage<R extends { cursor: string }, T>(rows: R[], ascending: boolean, item: (row: R) => T): Page<T> {
	const read = edgeRows(rows, ascending)
	return { ...read, items: read.rows.map(item) }
}

function edgeRows<R extends { cursor: string }>(rows: R[], ascending: boolean) {
	if (ascending) {
		rows.reverse()
	}
	return { rows, newest: rows[0]?.cursor ?? null, oldest: rows.at(-1)?.cursor ?? null }
}

// GET /api/v1/blocks: the accounts the viewer blocks, by the block's id, within ANSWER_BYTES (accountPage).
export const listBlocks = userReadOperation<{ page: PageQuery; present: Present }, Page<Account>>(
	(db, { page, present }, { accountId }) => {
		const ascending = page.minId !== undefined
		const rows = db.all<{ cursor: string; id: string }>(
			`SELECT CAST(b.id AS TEXT) AS cursor, b.target_account_id AS id FROM blocks b
			WHERE b.account_id = ?1 AND ${edgeRangeSql('b.id', '?2', '?3')}
			ORDER BY b.id ${ascending ? 'ASC' : 'DESC'} LIMIT ?4`,
			accountId,
			page.maxId ?? null,
			page.minId ?? page.sinceId ?? null,
			page.limit
		)
		return accountPage(db, edgeRows(rows, ascending), ascending, (row) => row.cursor, present)
	}
)

// GET /api/v1/mutes: the accounts the viewer mutes now, by the mute's id, each with its expiry (Mastodon's
// REST::MutedAccountSerializer), within ANSWER_BYTES: admitted in traversal order, a page cut there continuing from
// its last admitted account (admittedPage).
export const listMutes = userReadOperation<{ page: PageQuery; present: Present }, Page<MutedAccount>>(
	(db, { page, present }, _viewer, { accountId, now }) => {
		const ascending = page.minId !== undefined
		const rows = db.all<{ cursor: string; id: string; mute_expires_at: string | null }>(
			`SELECT CAST(m.id AS TEXT) AS cursor, m.target_account_id AS id, m.expires_at AS mute_expires_at FROM mutes m
			WHERE m.account_id = ?1 AND ${activeMuteSql('m', '?5')}
				AND ${edgeRangeSql('m.id', '?2', '?3')}
			ORDER BY m.id ${ascending ? 'ASC' : 'DESC'} LIMIT ?4`,
			accountId,
			page.maxId ?? null,
			page.minId ?? page.sinceId ?? null,
			page.limit,
			now
		)
		return admittedPage(
			edgeRows(rows, ascending),
			ascending,
			(row) => row.cursor,
			(traversal) => {
				const accounts = accountsOf(
					db,
					traversal.map((row) => row.id),
					present
				)
				function* muted(): Generator<MutedAccount | undefined> {
					for (const row of traversal) {
						const account = accounts.next().value
						yield account === undefined ? undefined : { ...account, mute_expires_at: row.mute_expires_at }
					}
				}
				return admit(muted(), ARRAY_ANSWER_BYTES, true)
			}
		)
	}
)

// GET /api/v1/domain_blocks: the domains the viewer blocks, by the block's id.
export const listDomainBlocks = userReadOperation<{ page: PageQuery }, Page<string>>((db, { page }, { accountId }) => {
	const ascending = page.minId !== undefined
	const rows = db.all<{ cursor: string; domain: string }>(
		`SELECT CAST(id AS TEXT) AS cursor, domain FROM domain_blocks
			WHERE account_id = ?1
				AND ${edgeRangeSql('id', '?2', '?3')}
			ORDER BY id ${ascending ? 'ASC' : 'DESC'} LIMIT ?4`,
		accountId,
		page.maxId ?? null,
		page.minId ?? page.sinceId ?? null,
		page.limit
	)
	return edgePage(rows, ascending, (row) => row.domain)
})

export type DomainBlockResult = { status: 'ok' } | { status: 'local' }

// This instance's own domain cannot be blocked: its accounts are local, and no domain block applies to them.
function isLocalDomain(db: Db, domain: string): boolean {
	const own = db.first<{ value: string }>("SELECT value FROM instance_settings WHERE name = 'domain'")?.value
	return own !== undefined && own.toLowerCase() === domain
}

type Cleanup = { domain_block_id: number; account_id: string; domain: string; bound: number; cursor: number }

// One batch of a cleanup: the next DOMAIN_BLOCK_WINDOW follows by id (whoever's they are, so the rows read are bounded
// however few match), of which the user's follows to and from accounts of the domain end. The cleanup is done when
// the scan reaches its bound. Returns whether an activity was recorded.
function cleanupBatch(db: Db, cleanup: Cleanup, now: number): boolean {
	const last = db.first<{ last: number | null }>(
		'SELECT max(id) AS last FROM (SELECT id FROM follows WHERE id > ? AND id <= ? ORDER BY id LIMIT ?)',
		cleanup.cursor,
		cleanup.bound,
		DOMAIN_BLOCK_WINDOW
	)?.last
	const user = party(db, cleanup.account_id)
	let recorded = false
	if (last != null && user !== undefined) {
		const ended = db.all<{ follower: string; target: string; other: string; other_uri: string }>(
			`SELECT f.account_id AS follower, f.target_account_id AS target, a.id AS other, a.uri AS other_uri
			FROM follows f JOIN accounts a ON a.id = IIF(f.account_id = ?1, f.target_account_id, f.account_id)
			WHERE f.id > ?3 AND f.id <= ?4 AND ?1 IN (f.account_id, f.target_account_id) AND ${inDomainSql('a', '?2')}
			ORDER BY f.id`,
			cleanup.account_id,
			cleanup.domain,
			cleanup.cursor,
			last
		)
		for (const edge of ended) {
			const other = { id: edge.other, uri: edge.other_uri, local: 0 }
			const ends = edge.follower === user.id ? endFollow(db, user, other, now) : endFollow(db, other, user, now)
			recorded = ends || recorded
		}
	}
	if (last == null || last >= cleanup.bound) {
		db.run('DELETE FROM domain_block_cleanups WHERE domain_block_id = ?', cleanup.domain_block_id)
	} else {
		db.run('UPDATE domain_block_cleanups SET cursor = ? WHERE domain_block_id = ?', last, cleanup.domain_block_id)
	}
	return recorded
}

const NEXT_CLEANUP = `SELECT c.domain_block_id, d.account_id, d.domain, c.bound, c.cursor
	FROM domain_block_cleanups c JOIN domain_blocks d ON d.id = c.domain_block_id
	ORDER BY c.created_at, c.domain_block_id LIMIT 1`

// The cleanups' next batches, oldest cleanup first, at most DOMAIN_BLOCK_BATCHES_PER_RUN (the Queue and the cron call
// it with the inbound jobs, store.ts). pending: a cleanup has batches left; delivers: activities were recorded.
export const runDomainBlockCleanups = writeOperation<{ now: number }, { pending: boolean; delivers: boolean }>(
	(db, { now }) => {
		let delivers = false
		for (let batch = 0; batch < DOMAIN_BLOCK_BATCHES_PER_RUN; batch++) {
			const cleanup = db.first<Cleanup>(NEXT_CLEANUP)
			if (cleanup === undefined) {
				break
			}
			delivers = cleanupBatch(db, cleanup, now) || delivers
		}
		return { pending: db.first(NEXT_CLEANUP) !== undefined, delivers }
	}
)

// POST /api/v1/domain_blocks (Account#block_domain! and AfterBlockDomainFromAccountService): records the block and
// its cleanup, and does the cleanup's first batch. `domain` is normalized by the caller. Blocking a domain already
// blocked changes nothing.
export const blockDomain = userWriteOperation<{ domain: string; now: number }, DomainBlockResult>(
	(db, { domain, now }, { accountId }) => {
		if (isLocalDomain(db, domain)) {
			return { status: 'local' }
		}
		const created = db.first<{ id: number }>(
			'INSERT INTO domain_blocks (account_id, domain, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING id',
			accountId,
			domain,
			new Date(now).toISOString()
		)
		const bound = db.first<{ bound: number | null }>('SELECT max(id) AS bound FROM follows')?.bound
		if (created !== undefined && bound != null) {
			db.run(
				'INSERT INTO domain_block_cleanups (domain_block_id, bound, created_at) VALUES (?, ?, ?)',
				created.id,
				bound,
				now
			)
			cleanupBatch(db, { domain_block_id: created.id, account_id: accountId, domain, bound, cursor: 0 }, now)
		}
		return { status: 'ok' }
	}
)

// DELETE /api/v1/domain_blocks: nothing that the block removed comes back.
export const unblockDomain = userWriteOperation<{ domain: string | null }, null>((db, { domain }, { accountId }) => {
	if (domain !== null) {
		db.run('DELETE FROM domain_blocks WHERE account_id = ? AND domain = ?', accountId, domain)
	}
	return null
})

// GET /api/v1/domain_blocks/preview (DomainBlockPreviewPresenter): how many of the user's accepted follows and
// followers a block of the domain would concern.
export const previewDomainBlock = userReadOperation<
	{ domain: string },
	{ following_count: number; followers_count: number }
>((db, { domain }, { accountId }) => {
	const count = (anchor: string, other: string) =>
		db.first<{ n: number }>(
			`SELECT COUNT(*) AS n FROM follows f JOIN accounts a ON a.id = f.${other}
			WHERE f.${anchor} = ?1 AND f.state = 'accepted' AND ${inDomainSql('a', '?2')}`,
			accountId,
			domain
		)?.n ?? 0
	return {
		following_count: count('account_id', 'target_account_id'),
		followers_count: count('target_account_id', 'account_id'),
	}
})
