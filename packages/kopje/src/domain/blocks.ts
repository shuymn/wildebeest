import {
	ACCOUNT_COLUMNS,
	type Account,
	type AccountRow,
	type Page,
	type PageQuery,
	type Present,
	presentAccount,
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
import { activeMuteSql, domainBlockMatchSql } from './audience'
import { userReadOperation, userWriteOperation } from './auth'
import { recountLocal, retractFollow } from './inbox'
import type { Db } from '../db/sql'

// Blocks, mutes and domain blocks of local users (Mastodon 4.5's BlockService, UnblockService, MuteService,
// UnmuteService, AccountDomainBlocksController and AfterBlockDomainFromAccountService). Their effect on what a user
// sees and is notified of is applied where those are read and written (audience.ts, notifications.ts, timelines.ts);
// here they are recorded, and the relationships they end are ended:
//
//   - A block ends the follows between the two accounts, either way and in either state. Our follow of a remote
//     account is undone there (Undo Follow), and a remote account's follow of us is answered with a Reject; a remote
//     target is sent the Block, and an unblock its Undo. A local block always applies: the ended Follow's id is
//     recorded as retracted (ID-7) only within the remote actor's retraction cap, since the block itself refuses that
//     actor's Follows while it lasts.
//   - A mute is local only. It hides notifications too unless notifications=false, and expires after duration seconds
//     (0: never); an expired mute stops applying at its time (activeMuteSql) and is swept later.
//   - A domain block hides every account of that domain (domainBlockMatchSql: its stored domain or its actor's host,
//     exactly, as Mastodon's AccountDomainBlock matches) and removes the user's followers there, accepted or
//     requested, each with a Reject, at most DOMAIN_BLOCK_BATCH per call (RES-6). Followers left over are never
//     delivered to (audienceTargets) and are removed by the next call for the domain. The user's own follows of
//     accounts there stay, as in Mastodon.

export const DOMAIN_BLOCK_BATCH = 500

type Party = { id: string; uri: string; local: number }

function party(db: Db, id: string): Party | undefined {
	return db.first<Party>('SELECT id, uri, domain IS NULL AS local FROM accounts WHERE id = ?', id)
}

// Ends the follow of `follower` to `target` in either state, with its follow notifications, as UnfollowService and
// RejectFollowService do: a local follower's follow of a remote target is undone there, and a remote follower of a
// local target is sent a Reject (one that withdraws the follow if it had been accepted, deliveries.ts).
function endFollow(db: Db, follower: Party, target: Party, now: number): void {
	const edge = db.first<{ id: string; uri: string | null; state: string }>(
		`DELETE FROM follows WHERE account_id = ? AND target_account_id = ?
		RETURNING CAST(id AS TEXT) AS id, uri, state`,
		follower.id,
		target.id
	)
	if (edge === undefined) {
		return
	}
	db.run(
		"DELETE FROM notifications WHERE account_id = ? AND from_account_id = ? AND type IN ('follow', 'follow_request')",
		target.id,
		follower.id
	)
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
	} else if (follower.local === 0 && target.local === 1) {
		if (edge.uri !== null) {
			retractFollow(db, follower.uri, edge.uri, now)
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
			{ withdraws: edge.state === 'accepted' }
		)
	}
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
		recountLocal(db, [viewer.id, target.id])
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
	if (ascending) {
		rows.reverse()
	}
	return { items: rows.map(item), newest: rows[0]?.cursor ?? null, oldest: rows.at(-1)?.cursor ?? null }
}

// GET /api/v1/blocks: the accounts the viewer blocks, by the block's id.
export const listBlocks = userReadOperation<{ page: PageQuery; present: Present }, Page<Account>>(
	(db, { page, present }, { accountId }) => {
		const ascending = page.minId !== undefined
		const rows = db.all<AccountRow & { cursor: string }>(
			`SELECT CAST(b.id AS TEXT) AS cursor, ${ACCOUNT_COLUMNS}
			FROM blocks b JOIN accounts a ON a.id = b.target_account_id LEFT JOIN local_accounts l ON l.account_id = a.id
			WHERE b.account_id = ?1
				AND (?2 IS NULL OR b.id < CAST(?2 AS INTEGER)) AND (?3 IS NULL OR b.id > CAST(?3 AS INTEGER))
			ORDER BY b.id ${ascending ? 'ASC' : 'DESC'} LIMIT ?4`,
			accountId,
			page.maxId ?? null,
			page.minId ?? page.sinceId ?? null,
			page.limit
		)
		return edgePage(rows, ascending, (row) => presentAccount(row, present))
	}
)

// GET /api/v1/mutes: the accounts the viewer mutes now, by the mute's id, each with its expiry (Mastodon's
// REST::MutedAccountSerializer).
export const listMutes = userReadOperation<{ page: PageQuery; present: Present }, Page<MutedAccount>>(
	(db, { page, present }, { accountId, now }) => {
		const ascending = page.minId !== undefined
		const rows = db.all<AccountRow & { cursor: string; mute_expires_at: string | null }>(
			`SELECT CAST(m.id AS TEXT) AS cursor, m.expires_at AS mute_expires_at, ${ACCOUNT_COLUMNS}
			FROM mutes m JOIN accounts a ON a.id = m.target_account_id LEFT JOIN local_accounts l ON l.account_id = a.id
			WHERE m.account_id = ?1 AND ${activeMuteSql('m', '?5')}
				AND (?2 IS NULL OR m.id < CAST(?2 AS INTEGER)) AND (?3 IS NULL OR m.id > CAST(?3 AS INTEGER))
			ORDER BY m.id ${ascending ? 'ASC' : 'DESC'} LIMIT ?4`,
			accountId,
			page.maxId ?? null,
			page.minId ?? page.sinceId ?? null,
			page.limit,
			new Date(now).toISOString()
		)
		return edgePage(rows, ascending, (row) => ({
			...presentAccount(row, present),
			mute_expires_at: row.mute_expires_at,
		}))
	}
)

// GET /api/v1/domain_blocks: the domains the viewer blocks, by the block's id.
export const listDomainBlocks = userReadOperation<{ page: PageQuery }, Page<string>>((db, { page }, { accountId }) => {
	const ascending = page.minId !== undefined
	const rows = db.all<{ cursor: string; domain: string }>(
		`SELECT CAST(id AS TEXT) AS cursor, domain FROM domain_blocks
			WHERE account_id = ?1
				AND (?2 IS NULL OR id < CAST(?2 AS INTEGER)) AND (?3 IS NULL OR id > CAST(?3 AS INTEGER))
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

// The user's followers, accepted or requested, on `domain` (as a domain block matches them).
function followersOn(db: Db, accountId: string, domain: string, limit: number): Party[] {
	return db.all<Party>(
		`SELECT a.id, a.uri, 0 AS local, a.locked FROM follows f JOIN accounts a ON a.id = f.account_id
			JOIN (SELECT ?2 AS domain) d
		WHERE f.target_account_id = ?1 AND ${domainBlockMatchSql('d', 'a')}
		ORDER BY f.id LIMIT ?3`,
		accountId,
		domain,
		limit
	)
}

// POST /api/v1/domain_blocks (Account#block_domain! and AfterBlockDomainFromAccountService): records the block, then
// removes a batch of the user's followers on the domain, each with a Reject. `domain` is normalized by the caller.
export const blockDomain = userWriteOperation<{ domain: string; now: number }, DomainBlockResult>(
	(db, { domain, now }, { accountId }) => {
		if (isLocalDomain(db, domain)) {
			return { status: 'local' }
		}
		db.run(
			'INSERT INTO domain_blocks (account_id, domain, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
			accountId,
			domain,
			new Date(now).toISOString()
		)
		const viewer = party(db, accountId)
		if (viewer !== undefined) {
			for (const follower of followersOn(db, accountId, domain, DOMAIN_BLOCK_BATCH)) {
				endFollow(db, follower, viewer, now)
			}
			recountLocal(db, [accountId])
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
			`SELECT COUNT(*) AS n FROM follows f JOIN accounts a ON a.id = f.${other} JOIN (SELECT ?2 AS domain) d
			WHERE f.${anchor} = ?1 AND f.state = 'accepted' AND ${domainBlockMatchSql('d', 'a')}`,
			accountId,
			domain
		)?.n ?? 0
	return {
		following_count: count('account_id', 'target_account_id'),
		followers_count: count('target_account_id', 'account_id'),
	}
})
