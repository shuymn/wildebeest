import { runInDurableObject } from 'cloudflare:test'

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { NOW } from './app-helpers'
import { migratedStore } from './helpers'
import { PolicyModel } from './policy-model'
import { accountId, REMOTE_DOMAINS, statusId, statusUri, type World, worldArb, writeWorld } from './policy-world'
import { rowsRead, watchedCursor } from './read-helpers'
import { Db } from '../src/db/sql'
import { getAccounts, listFollows, type PageQuery, relationships, userinfo } from '../src/domain/accounts'
import { getFeatured, getLocalNote, getOutbox } from '../src/domain/activities'
import {
	ADMIN_ACCOUNT_CANDIDATES,
	type AdminAccountFilter,
	type AdminAccountList,
	listAdminAccounts,
} from '../src/domain/admin-accounts'
import { CAPTURE_BOOST_SCAN, canView, deleteAudience, visibleSql, type Visibility } from '../src/domain/audience'
import { backfillConversations } from '../src/domain/conversation-rows'
import { listConversations } from '../src/domain/conversations'
import { directory, DIRECTORY_WINDOW } from '../src/domain/directory'
import { accountEndorsements, listEndorsements } from '../src/domain/endorsements'
import { accountFeaturedTags, FEATURED_COUNT_WINDOW, listFeaturedTags } from '../src/domain/featured-tags'
import {
	getFilter,
	listFilterKeywords,
	listFilters,
	listFiltersV1,
	listFilterStatuses,
	MAX_FILTER_KEYWORDS,
	MAX_FILTERS,
} from '../src/domain/filters'
import { getRemoteKey, inboxGate, inboxOwnerExists, KEY_REFRESH_MS, PURGE_BATCH } from '../src/domain/inbox'
import { listAccounts } from '../src/domain/lists'
import { getMarkers, MARKER_TIMELINES } from '../src/domain/markers'
import {
	dismissNotificationGroup,
	getNotificationGroup,
	GROUP_COUNT,
	GROUP_WALK,
	listGroupedNotifications,
	notificationGroupAccounts,
	unreadCount,
	unreadGroupCount,
} from '../src/domain/notification-groups'
import {
	acceptNotificationRequest,
	dismissNotificationRequest,
	getNotificationPolicy,
	getNotificationRequest,
	listNotificationRequests,
	notificationRequestsMerged,
	runNotificationRequestJobs,
} from '../src/domain/notification-requests'
import { clearNotifications, listNotifications, REMOVAL_BATCHES, REMOVAL_WINDOW } from '../src/domain/notifications'
import { readOperation, writeOperation } from '../src/domain/operation'
import { getPoll, vote } from '../src/domain/polls'
import {
	claimQuotes,
	linkQuotes,
	MAX_LINKED_QUOTES,
	QUOTE_ROUND,
	quoteWork,
	recheckStamp,
	revokeStamp,
} from '../src/domain/quotes'
import {
	claimCollectionSync,
	featureRemote,
	MAX_REMOTE_PINS,
	SYNC_LEASE_MS,
	unfeatureRemote,
} from '../src/domain/remote-collections'
import { type AdminReportFilter, createReport, listAdminReports } from '../src/domain/reports'
import { dueScheduled, listScheduled, publishScheduled } from '../src/domain/scheduled-statuses'
import { search } from '../src/domain/search'
import {
	favourite,
	getStatus,
	getStatuses,
	interactors,
	MAX_STATUSES_BY_ID,
	statusContext,
	statusQuotes,
} from '../src/domain/statuses'
import {
	streamAccept,
	streamConversations,
	streamDelete,
	streamDeleteUnits,
	streamEvents,
	streamListOwned,
	streamTokens,
	streamUnit,
} from '../src/domain/streaming'
import { suggestions } from '../src/domain/suggestions'
import { featuredTagSuggestions, followedTags, MAX_FOLLOWED_TAGS } from '../src/domain/tags'
import {
	accountStatuses,
	bookmarks,
	favourites,
	homeTimeline,
	listTimeline,
	publicTimeline,
	tagTimeline,
} from '../src/domain/timelines'
import { embeddedStatus } from '../src/domain/web-pages'
import { streamWindow } from '../src/domain/windows'
import type { StoreStub } from '../src/platform/store-client'
import type { StoreOperation } from '../src/platform/store-kernel'

// The bounds harness (docs/visibility.md, "The oracle and the bounds harness"): each read endpoint that takes a viewer
// runs over a generated world twice, once alone and once with many unrelated rows, and must read about the same number
// of rows (RES-7). Unrelated rows are what no viewer's read of the world should touch: other accounts with their
// statuses (never public, so no public or tag feed would list them, though they carry the tag the tag feed reads),
// replies and boosts among them, their follows, blocks, mutes and domain blocks of the world's accounts and domains,
// their favourites, bookmarks and notifications, their exclusive lists holding world accounts and their own, and their
// timeline markers.

// The world, the same in every run: the first of fast-check's samples for a fixed seed in which every endpoint has
// something to show the viewer (the first available local account). The viewer then follows everyone, favourites and
// bookmarks every status, has a notification from every account, has a list (VIEWER_LIST) of every account and a
// marker on each timeline; LISTED follows the viewer, and an account outside the world (SUGGESTED).
function viewerOf(world: World): number {
	return world.accounts.findIndex((account) => account.local && !account.suspended)
}

// The account whose followers and following the lists read: another account whose lists the viewer is shown. The
// viewer follows it (as everyone) and it follows the viewer, so each list shows the viewer something.
function listedOf(world: World): number {
	const model = new PolicyModel(world)
	const viewer = viewerOf(world)
	return world.accounts.findIndex((_, owner) => owner !== viewer && model.followListsShown(owner, viewer))
}

// The status the status endpoints read: a listable original with a listable reply and a listable public boost.
function targetOf(world: World): number {
	const model = new PolicyModel(world)
	const viewer = viewerOf(world)
	const listable = (s: number) => model.listable(s, viewer)
	return world.statuses.findIndex(
		(status, s) =>
			status.reblogOf === null &&
			listable(s) &&
			world.statuses.some((reply, r) => reply.replyTo === s && listable(r)) &&
			world.statuses.some((boost, b) => boost.reblogOf === s && boost.visibility === 'public' && listable(b))
	)
}

function rich(world: World): boolean {
	const model = new PolicyModel(world)
	const viewer = viewerOf(world)
	const publicListable = world.statuses.filter(
		(status, s) => status.visibility === 'public' && status.reblogOf === null && model.listable(s, viewer)
	)
	return (
		world.statuses.length >= 18 &&
		viewer >= 0 &&
		world.statuses.some(
			(status) => status.author === viewer && status.reblogOf === null && PINNABLE.has(status.visibility)
		) &&
		targetOf(world) >= 0 &&
		listedOf(world) >= 0 &&
		publicListable.some((status) => status.replyTo === null) &&
		publicListable.some((status) => status.tagged)
	)
}

// What a pin may name (the API refuses direct and limited statuses).
const PINNABLE: ReadonlySet<Visibility> = new Set(['public', 'unlisted', 'private'])

const WORLD = fc.sample(worldArb, { numRuns: 1000, seed: 20261015 }).find(rich) as World
const VIEWER = viewerOf(WORLD)
const TARGET = targetOf(WORLD)
const LISTED = listedOf(WORLD)
// The account the account statuses endpoint reads: the author of the most statuses.
const AUTHOR = WORLD.accounts.map((_, x) => x).sort((a, b) => authored(b) - authored(a))[0] as number

function authored(x: number): number {
	return WORLD.statuses.filter((status) => status.author === x).length
}

// The status the oEmbed read finds: a public or unlisted original of a local account that is not suspended.
const EMBEDDED = WORLD.statuses.findIndex((status) => {
	const author = WORLD.accounts[status.author]
	return (
		(status.visibility === 'public' || status.visibility === 'unlisted') &&
		status.reblogOf === null &&
		author?.local === true &&
		!author.suspended
	)
})

const VIEWER_LIST = '700000000000000001'
const SUGGESTED = '800000000000000001'
// The viewer's filter: warn, in every context, by keywords some of the world's statuses match and by the target status.
const VIEWER_FILTER = '720000000000000001'
const TOKEN_HASH = 'policy-bounds-token'
const PRESENT = { origin: 'https://kopje.test' }
const PAGE = { limit: 20 }
// The group of the viewer's follow notifications (and of the unrelated local accounts' own).
const FOLLOW_GROUP = 'follow-1'

// Unrelated rows: per unrelated remote account, three statuses (a reply and a boost among them) and its edges (a
// follow of a world account other than LISTED, whose followers are listed); one unrelated local account per ten remote
// ones, with mutes, domain blocks, favourites, bookmarks and notifications. The viewer's own blocks and mutes of
// unrelated accounts and domain blocks of domains nobody lives on grow with them.
const UNRELATED_ACCOUNT_BASE = 300000000000000000n
const UNRELATED_STATUS_BASE = 400000000000000000n
const UNRELATED_LIST_BASE = 710000000000000000n
const UNRELATED_FILTER_BASE = 730000000000000000n
const HIDDEN: readonly Visibility[] = ['unlisted', 'private', 'direct', 'limited']

function writeViewer(sql: SqlStorage): void {
	const viewer = accountId(VIEWER)
	sql.exec(
		"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('bounds', 'secret', 'bounds', 'urn:ietf:wg:oauth:2.0:oob', 'read profile')"
	)
	sql.exec(
		"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'bounds', ?, 'read profile')",
		TOKEN_HASH,
		viewer
	)
	WORLD.accounts.forEach((_, x) => {
		if (x === VIEWER) {
			return
		}
		sql.exec(
			`INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')
			ON CONFLICT (account_id, target_account_id) DO UPDATE SET state = 'accepted'`,
			viewer,
			accountId(x)
		)
		sql.exec(
			"INSERT INTO notifications (account_id, type, from_account_id, group_key) VALUES (?, 'follow', ?, ?)",
			viewer,
			accountId(x),
			FOLLOW_GROUP
		)
	})
	sql.exec(
		`INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')
		ON CONFLICT (account_id, target_account_id) DO UPDATE SET state = 'accepted'`,
		accountId(LISTED),
		viewer
	)
	// An account outside the world LISTED follows, which the viewer is suggested (R39).
	sql.exec(
		`INSERT INTO accounts (id, uri, username, domain, discoverable)
		VALUES (?, 'https://far.example/users/suggested', 'suggested', 'far.example', 1)`,
		SUGGESTED
	)
	sql.exec(
		"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
		accountId(LISTED),
		SUGGESTED
	)
	// The viewer endorses every account it follows and keeps a note on each.
	sql.exec(
		`INSERT INTO account_pins (account_id, target_account_id)
		SELECT account_id, target_account_id FROM follows WHERE account_id = ? AND state = 'accepted'`,
		viewer
	)
	sql.exec(
		`INSERT INTO account_notes (account_id, target_account_id, comment)
		SELECT account_id, target_account_id, 'note' FROM follows WHERE account_id = ?`,
		viewer
	)
	// The viewer pins its newest pinnable originals of the world (not the copies), and mutes the conversations of
	// every other status of the world.
	sql.exec(
		`INSERT INTO status_pins (account_id, status_id) SELECT account_id, id FROM statuses
		WHERE account_id = ?1 AND id >= ?2 AND reblog_of_id IS NULL AND visibility IN ('public', 'unlisted', 'private')
		ORDER BY id DESC LIMIT 5
		ON CONFLICT DO NOTHING`,
		viewer,
		statusId(0)
	)
	sql.exec(
		`INSERT INTO conversation_mutes (account_id, thread) SELECT ?1, thread FROM statuses
		WHERE id >= ?2 AND CAST(id AS INTEGER) % 2 = 0 ON CONFLICT DO NOTHING`,
		viewer,
		statusId(0)
	)
	sql.exec("INSERT INTO lists (id, account_id, title) VALUES (?, ?, 'everyone')", VIEWER_LIST, viewer)
	sql.exec(
		`INSERT INTO filters (id, account_id, title, context)
		VALUES (?, ?, 'some', '["home","notifications","public","thread","account"]')`,
		VIEWER_FILTER,
		viewer
	)
	sql.exec(
		`INSERT INTO filter_keywords (id, filter_id, keyword, whole_word) VALUES
			('720000000000000002', ?1, 'status 1', 1), ('720000000000000003', ?1, 'STATUS 2', 0)`,
		VIEWER_FILTER
	)
	sql.exec(
		"INSERT INTO filter_statuses (id, filter_id, status_id) VALUES ('720000000000000004', ?, ?)",
		VIEWER_FILTER,
		statusId(TARGET)
	)
	WORLD.accounts.forEach((_, x) => {
		sql.exec('INSERT INTO list_accounts (list_id, account_id) VALUES (?, ?)', VIEWER_LIST, accountId(x))
	})
	writeTagFollows(sql, viewer)
	writeFeaturedTags(sql, viewer)
	// A hashtag on the viewer's own statuses that they do not feature, which featured tag suggestions show.
	sql.exec(
		"INSERT INTO status_tags (status_id, name, public) SELECT id, 'birds', visibility = 'public' FROM statuses WHERE account_id = ?",
		viewer
	)
	writeMarkers(sql, viewer)
	writeScheduled(sql, viewer, VIEWER_SCHEDULED_BASE, 25)
	writePolls(sql, viewer)
	WORLD.statuses.forEach((status, s) => {
		sql.exec('INSERT INTO favourites (account_id, status_id) VALUES (?, ?)', viewer, statusId(s))
		sql.exec('INSERT INTO bookmarks (account_id, status_id) VALUES (?, ?)', viewer, statusId(s))
		if (status.author !== VIEWER) {
			sql.exec(
				"INSERT INTO notifications (account_id, type, from_account_id, status_id) VALUES (?, 'mention', ?, ?)",
				viewer,
				accountId(status.author),
				statusId(s)
			)
		}
	})
}

// The account follows the world's hashtag and another one.
function writeTagFollows(sql: SqlStorage, account: string): void {
	sql.exec("INSERT INTO tag_follows (account_id, name) VALUES (?1, 'cats'), (?1, 'dogs')", account)
}

// The account features the world's hashtag and another one (the counts as they would be kept).
function writeFeaturedTags(sql: SqlStorage, account: string): void {
	sql.exec(
		`INSERT INTO featured_tags (id, account_id, name, display_name, statuses_count, last_status_at)
		VALUES (?2, ?1, 'cats', 'Cats', 3, '2026-10-01T00:00:00.000Z'), (?3, ?1, 'dogs', 'dogs', 0, NULL)`,
		account,
		String(FEATURED_BASE + (BigInt(account) % 1_000_000n)),
		String(FEATURED_BASE + 1_000_000n + (BigInt(account) % 1_000_000n))
	)
}

const FEATURED_BASE = 740000000000000000n

// The notifications marker reads from the first notification on, so the unread counts have something to count.
function writeMarkers(sql: SqlStorage, account: string): void {
	for (const timeline of MARKER_TIMELINES) {
		sql.exec(
			"INSERT INTO markers (account_id, timeline, last_read_id, version, updated_at) VALUES (?, ?, ?, 1, '2026-01-01T00:00:00.000Z')",
			account,
			timeline,
			timeline === 'notifications' ? '1' : account
		)
	}
}

// A poll of four choices on every original status (copies included), each with the viewer's vote, so every endpoint
// presents a poll per status it shows.
function writePolls(sql: SqlStorage, viewer: string): void {
	sql.exec(
		`INSERT INTO polls (status_id, options, tallies, multiple, expires_at, votes_count, voters_count)
		SELECT id, '["a","b","c","d"]', '[1,0,0,0]', 0, ?, 1, 1 FROM statuses WHERE reblog_of_id IS NULL`,
		new Date(NOW + 3_600_000).toISOString()
	)
	sql.exec('INSERT INTO poll_votes (poll_id, account_id, choice) SELECT status_id, ?, 0 FROM polls', viewer)
}

// `count` scheduled statuses of `owner`, a day apart from a week after NOW, with ids from `base`.
const VIEWER_SCHEDULED_BASE = 720000000000000000n
const UNRELATED_SCHEDULED_BASE = 730000000000000000n

function writeScheduled(sql: SqlStorage, owner: string, base: bigint, count: number): void {
	sql.exec(
		`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
		INSERT INTO scheduled_statuses (id, account_id, scheduled_at, params)
		SELECT CAST(?2 + i AS TEXT), ?3, strftime('%Y-%m-%dT%H:%M:%fZ', ?4, '+' || (7 + i) || ' days'),
			json_object('text', 'later ' || i, 'spoiler_text', '', 'sensitive', NULL, 'language', NULL, 'visibility', NULL,
				'in_reply_to_id', NULL, 'media_ids', NULL)
		FROM n`,
		count,
		String(base),
		owner,
		new Date(NOW).toISOString()
	)
}

function writeUnrelated(sql: SqlStorage, remote: number): void {
	const worldAccounts = WORLD.accounts.length
	const account = (i: number) => String(UNRELATED_ACCOUNT_BASE + BigInt(i))
	const status = (i: number) => String(UNRELATED_STATUS_BASE + BigInt(i))
	const locals = Math.floor(remote / 10)
	for (let i = 0; i < remote + locals; i++) {
		const local = i >= remote
		const domain = local ? null : `far${i % 10}.example`
		sql.exec(
			'INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, ?, ?)',
			account(i),
			local ? `https://kopje.test/ap/users/u${i}` : `https://${domain}/users/u${i}`,
			`u${i}`,
			domain
		)
		if (local) {
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'test')",
				account(i),
				`u${i}@example.com`
			)
			writeMarkers(sql, account(i))
			writeTagFollows(sql, account(i))
			writeFeaturedTags(sql, account(i))
		}
	}
	for (let i = 0; i < remote; i++) {
		const author = account(i)
		const [first, reply, boost] = [status(3 * i), status(3 * i + 1), status(3 * i + 2)]
		const insert = (id: string, visibility: Visibility, extra: { replyTo?: string; reblogOf?: string } = {}) =>
			sql.exec(
				`INSERT INTO statuses (id, uri, account_id, reblog_of_id, in_reply_to_uri, in_reply_to_id, in_reply_to_account_id,
					visibility, content, published_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				id,
				`https://far.example/objects/${id}`,
				author,
				extra.reblogOf ?? null,
				extra.replyTo === undefined ? null : `https://far.example/objects/${extra.replyTo}`,
				extra.replyTo ?? null,
				extra.replyTo === undefined ? null : author,
				visibility,
				extra.reblogOf === undefined ? `<p>status ${id}</p>` : '',
				new Date(NOW).toISOString()
			)
		insert(first, HIDDEN[i % HIDDEN.length] ?? 'private')
		insert(reply, HIDDEN[(i + 1) % HIDDEN.length] ?? 'private', { replyTo: first })
		insert(boost, 'public', { reblogOf: first })
		// A poll of its own, its vote in it, and its vote in a world poll (a row only: the poll's counts stand).
		sql.exec(
			`INSERT INTO polls (status_id, options, tallies, votes_count, voters_count) VALUES (?, '["a","b"]', '[1,0]', 1, 1)`,
			first
		)
		sql.exec('INSERT INTO poll_votes (poll_id, account_id, choice) VALUES (?, ?, 0)', first, author)
		sql.exec(
			'INSERT INTO poll_votes (poll_id, account_id, choice) VALUES (?, ?, 1) ON CONFLICT DO NOTHING',
			statusId(TARGET),
			author
		)
		// The world's tag on statuses no tag feed lists, as the writers record it (not public).
		sql.exec("INSERT INTO status_tags (status_id, name, public) VALUES (?, 'cats', 0), (?, 'cats', 0)", first, reply)
		// The viewer's own choices about accounts and domains the world never shows them.
		const viewer = accountId(VIEWER)
		if (i % 3 === 0) {
			sql.exec('INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)', viewer, author)
		} else if (i % 3 === 1) {
			sql.exec(
				'INSERT INTO mutes (account_id, target_account_id, hide_notifications, expires_at) VALUES (?, ?, ?, ?)',
				viewer,
				author,
				i % 2,
				i % 4 === 1 ? null : new Date(NOW + 3_600_000).toISOString()
			)
		}
		if (i % 10 === 0) {
			sql.exec('INSERT INTO domain_blocks (account_id, domain) VALUES (?, ?)', viewer, `unused${i}.example`)
		}
		// A world account other than the viewer is mentioned; the viewer never is.
		const mentioned = (VIEWER + 1 + (i % (worldAccounts - 1))) % worldAccounts
		sql.exec(
			'INSERT INTO status_mentions (status_id, account_id, requires_mention, author_id) VALUES (?, ?, ?, ?)',
			first,
			accountId(mentioned),
			HIDDEN[i % HIDDEN.length] === 'direct' || HIDDEN[i % HIDDEN.length] === 'limited' ? 1 : 0,
			author
		)
		const world = accountId(i % worldAccounts)
		const followed = i % worldAccounts === LISTED ? accountId((LISTED + 1) % worldAccounts) : world
		sql.exec("INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')", author, followed)
		sql.exec(
			"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
			author,
			account((i + 1) % remote)
		)
		sql.exec('INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)', author, world)
	}
	for (let j = 0; j < locals; j++) {
		const owner = account(remote + j)
		// An exclusive list of the owner's, with a world account (other than LISTED, whose followers are listed) and an
		// unrelated one it follows.
		const list = String(UNRELATED_LIST_BASE + BigInt(j))
		const followed = [
			accountId(j % worldAccounts === LISTED ? (LISTED + 1) % worldAccounts : j % worldAccounts),
			account(j),
		]
		sql.exec("INSERT INTO lists (id, account_id, title, exclusive) VALUES (?, ?, 'l', 1)", list, owner)
		sql.exec('INSERT INTO list_accounts (list_id, account_id) VALUES (?, ?)', list, owner)
		for (const member of followed) {
			sql.exec("INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')", owner, member)
			sql.exec('INSERT INTO list_accounts (list_id, account_id) VALUES (?, ?)', list, member)
			// Endorsed, with a note: rows of the world's accounts no read of the viewer's touches.
			sql.exec('INSERT INTO account_pins (account_id, target_account_id) VALUES (?, ?)', owner, member)
			sql.exec("INSERT INTO account_notes (account_id, target_account_id, comment) VALUES (?, ?, 'n')", owner, member)
		}
		sql.exec(
			'INSERT INTO mutes (account_id, target_account_id, hide_notifications, expires_at) VALUES (?, ?, ?, ?)',
			owner,
			accountId(j % worldAccounts),
			j % 2,
			j % 3 === 0 ? null : new Date(NOW + (j % 3 === 1 ? -1 : 1) * 3_600_000).toISOString()
		)
		sql.exec('INSERT INTO domain_blocks (account_id, domain) VALUES (?, ?)', owner, REMOTE_DOMAINS[j % 2] ?? '')
		// A hide filter of the owner's in every context, by a keyword every world status matches and by world statuses.
		const filter = String(UNRELATED_FILTER_BASE + BigInt(j))
		sql.exec(
			`INSERT INTO filters (id, account_id, title, context, action)
			VALUES (?, ?, 'f', '["home","notifications","public","thread","account"]', 'hide')`,
			filter,
			owner
		)
		sql.exec(
			"INSERT INTO filter_keywords (id, filter_id, keyword) VALUES (?, ?, 'status')",
			String(UNRELATED_FILTER_BASE + 100_000n + BigInt(j)),
			filter
		)
		WORLD.statuses.forEach((_, s) => {
			sql.exec(
				'INSERT INTO filter_statuses (id, filter_id, status_id) VALUES (?, ?, ?)',
				String(UNRELATED_FILTER_BASE + 200_000n + BigInt(j * 100 + s)),
				filter,
				statusId(s)
			)
		})
		writeScheduled(sql, owner, UNRELATED_SCHEDULED_BASE + BigInt(j * 100), 30)
		// A private status of its own, pinned, and mutes of the world's conversations: rows no read of the viewer's
		// touches.
		const own = String(UNRELATED_STATUS_BASE + 900_000n + BigInt(j))
		sql.exec(
			`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			VALUES (?, ?, ?, 'private', '<p>own</p>', ?)`,
			own,
			`https://kopje.test/ap/o/unrelated-${j}`,
			owner,
			new Date(NOW).toISOString()
		)
		sql.exec('INSERT INTO status_pins (account_id, status_id) VALUES (?, ?)', owner, own)
		sql.exec(
			'INSERT INTO conversation_mutes (account_id, thread) SELECT DISTINCT ?, thread FROM statuses WHERE id >= ? AND id < ?',
			owner,
			statusId(0),
			String(UNRELATED_ACCOUNT_BASE)
		)
		for (let k = 0; k < 10; k++) {
			const target = status(3 * (j * 10 + k))
			sql.exec('INSERT INTO favourites (account_id, status_id) VALUES (?, ?)', owner, target)
			sql.exec('INSERT INTO bookmarks (account_id, status_id) VALUES (?, ?)', owner, target)
			sql.exec(
				"INSERT INTO notifications (account_id, type, from_account_id, status_id) VALUES (?, 'mention', ?, ?)",
				owner,
				accountId(k % worldAccounts),
				target
			)
			// Its follows from world accounts, in a group with the key of the viewer's.
			sql.exec(
				`INSERT INTO notifications (account_id, type, from_account_id, group_key) VALUES (?, 'follow', ?, ?)
				ON CONFLICT DO NOTHING`,
				owner,
				accountId(k % worldAccounts),
				FOLLOW_GROUP
			)
		}
	}
}

// The instance's domain, which the oEmbed read takes a URL's host against.
function writeDomain(sql: SqlStorage): void {
	sql.exec("INSERT INTO instance_settings (name, value) VALUES ('domain', 'kopje.test')")
}

async function worldWith(unrelated: number): Promise<StoreStub> {
	const store = await migratedStore()
	await runInDurableObject(store, (_instance, state) => {
		writeWorld(state.storage.sql, WORLD)
		writeDomain(state.storage.sql)
		writeViewer(state.storage.sql)
		writeUnrelated(state.storage.sql, unrelated)
		// The conversations of the direct statuses and mentions written, as migration 0009 makes them: the viewer's,
		// and the unrelated local accounts'.
		backfillConversations({ exec: (query: string) => state.storage.sql.exec(query) })
	})
	return store
}

// The world's history replicated: every status of the world `factor` times over, each copy older than every original
// (so the newest page is the world's), with its original's author, visibility, content, mentions and tag, a reply to
// the copy of its parent in the same replica and a boost of the copy of its original, and the viewer's favourite,
// bookmark and notification of it as the viewer has of the original. Replica 1 is the newest; within a replica the
// copies keep the world's order. A copy's id, and its edges' ids, depend only on its replica and its original, so the
// newest copies are the same whatever the factor. Accounts and the edges between them are not replicated.
const COPY_BASE = 190000000000000000n
const MAX_REPLICAS = 10_000
// The first id of the viewer's favourites, bookmarks and notifications of the world's own statuses, above every copy's.
const ORIGINAL_EDGE_BASE = 1_000_000_000

function copyId(replica: number, index: number): string {
	return String(COPY_BASE + BigInt((MAX_REPLICAS - replica) * WORLD.statuses.length + index))
}

function writeCopies(sql: SqlStorage, factor: number): void {
	const viewer = accountId(VIEWER)
	const replicas = 'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < ?1)'
	const statuses = WORLD.statuses.length
	// The copy in replica n of the status with id x (NULL for NULL), as copyId.
	const copy = (x: string) =>
		`CAST(${COPY_BASE} + (${MAX_REPLICAS} - n) * ${statuses} + (CAST(${x} AS INTEGER) - ${statusId(0)}) AS TEXT)`
	const params = [factor] as const
	sql.exec(
		`${replicas}
		INSERT INTO statuses (id, uri, account_id, reblog_of_id, in_reply_to_uri, in_reply_to_id, in_reply_to_account_id,
			visibility, content, search_text, published_at)
		SELECT ${copy('s.id')}, s.uri || '/r' || n, s.account_id, ${copy('s.reblog_of_id')},
			CASE WHEN s.in_reply_to_id IS NULL THEN s.in_reply_to_uri ELSE s.in_reply_to_uri || '/r' || n END,
			${copy('s.in_reply_to_id')}, s.in_reply_to_account_id, s.visibility, s.content, s.search_text,
			strftime('%Y-%m-%dT%H:%M:%fZ', s.published_at, '-' || (n * ${statuses}) || ' minutes')
		FROM statuses s, r`,
		...params
	)
	sql.exec(
		`${replicas}
		INSERT INTO status_mentions (status_id, account_id, silent, requires_mention, author_id)
		SELECT ${copy('m.status_id')}, m.account_id, m.silent, m.requires_mention, m.author_id FROM status_mentions m, r`,
		...params
	)
	sql.exec(
		`${replicas}
		INSERT INTO status_tags (status_id, name, public) SELECT ${copy('t.status_id')}, t.name, t.public FROM status_tags t, r`,
		...params
	)
	// The viewer's edges of the copies, in the copies' order and below those writeViewer then writes of the world's
	// statuses: the edge of a copy has the copy's offset from COPY_BASE, plus one.
	const edge = `CAST(id AS INTEGER) - ${COPY_BASE} + 1`
	const copies = 'FROM statuses WHERE id < ?2'
	sql.exec(`INSERT INTO favourites (id, account_id, status_id) SELECT ${edge}, ?1, id ${copies}`, viewer, statusId(0))
	sql.exec(`INSERT INTO bookmarks (id, account_id, status_id) SELECT ${edge}, ?1, id ${copies}`, viewer, statusId(0))
	sql.exec(
		`INSERT INTO notifications (id, account_id, type, from_account_id, status_id)
		SELECT ${edge}, ?1, 'mention', account_id, id ${copies} AND account_id <> ?1`,
		viewer,
		statusId(0)
	)
	// AUTOINCREMENT never reuses an id: a row just below ORIGINAL_EDGE_BASE, deleted, makes it the next id.
	const mark = ORIGINAL_EDGE_BASE - 1
	sql.exec('INSERT INTO favourites (id, account_id, status_id) VALUES (?, ?, ?)', mark, viewer, statusId(0))
	sql.exec('INSERT INTO bookmarks (id, account_id, status_id) VALUES (?, ?, ?)', mark, viewer, statusId(0))
	sql.exec(
		"INSERT INTO notifications (id, account_id, type, from_account_id) VALUES (?, ?, 'mark', ?)",
		mark,
		viewer,
		viewer
	)
	for (const table of ['favourites', 'bookmarks', 'notifications']) {
		sql.exec(`DELETE FROM ${table} WHERE id = ?`, mark)
	}
}

async function replicated(factor: number): Promise<StoreStub> {
	const store = await migratedStore()
	await runInDurableObject(store, (_instance, state) => {
		writeWorld(state.storage.sql, WORLD)
		writeDomain(state.storage.sql)
		writeCopies(state.storage.sql, factor)
		writeViewer(state.storage.sql)
		// The conversations of the direct statuses and the viewer's mentions, copies included, as migration 0009 makes
		// them.
		backfillConversations({ exec: (query: string) => state.storage.sql.exec(query) })
	})
	return store
}

const credential = { tokenHash: TOKEN_HASH, scope: 'read', now: NOW } as const
const target = { credential, now: NOW, id: statusId(TARGET), present: PRESENT }
const searchInput = { credential, limit: 20, offset: 0, following: false, localDomain: 'kopje.test', present: PRESENT }
const timeline = { credential, now: NOW, page: PAGE, local: false, remote: false, onlyMedia: false, present: PRESENT }
const notificationsQuery = { credential, page: PAGE, types: [], excludeTypes: [] }
const unread = { credential, limit: 100, types: [], excludeTypes: [] }

// What an endpoint that pages a viewer's history pages by: statuses (by status id: conversations by their last status's), the viewer's notifications,
// favourites or bookmarks (by their ids), or a status's interactors (accounts, which are not replicated).
type Paging = 'statuses' | 'notifications' | 'favourites' | 'bookmarks' | 'interactors'

// Each endpoint with its input, as the routes call them, and for one that pages the history, what it pages by.
const ENDPOINTS: [string, StoreOperation<never, unknown>, unknown, Paging?][] = [
	['home', homeTimeline, { credential, page: PAGE, present: PRESENT }, 'statuses'],
	['list', listTimeline, { credential, id: VIEWER_LIST, page: PAGE, present: PRESENT }, 'statuses'],
	['public', publicTimeline, timeline, 'statuses'],
	['tag', tagTimeline, { ...timeline, tag: 'cats', any: [], all: [], none: [] }, 'statuses'],
	[
		'account statuses',
		accountStatuses,
		{
			credential,
			now: NOW,
			account: accountId(AUTHOR),
			page: PAGE,
			onlyMedia: false,
			excludeReplies: false,
			excludeReblogs: false,
			pinned: false,
			tagged: null,
			present: PRESENT,
		},
		'statuses',
	],
	[
		'notifications',
		listNotifications,
		{ credential, page: PAGE, types: [], excludeTypes: [], accountId: null, present: PRESENT },
		'notifications',
	],
	[
		'grouped notifications',
		listGroupedNotifications,
		{ ...notificationsQuery, groupedTypes: null, expandAccounts: 'full', present: PRESENT },
		'notifications',
	],
	['notification group', getNotificationGroup, { credential, groupKey: FOLLOW_GROUP, present: PRESENT }],
	[
		'notification group accounts',
		notificationGroupAccounts,
		{ credential, groupKey: FOLLOW_GROUP, page: PAGE, present: PRESENT },
	],
	['unread count', unreadCount, { ...unread, accountId: null, groupedTypes: null }],
	['unread group count', unreadGroupCount, { ...unread, accountId: null, groupedTypes: null }],
	['context', statusContext, target],
	['conversations', listConversations, { credential, page: PAGE, present: PRESENT }, 'statuses'],
	['favourites', favourites, { credential, page: PAGE, present: PRESENT }, 'favourites'],
	['bookmarks', bookmarks, { credential, page: PAGE, present: PRESENT }, 'bookmarks'],
	['favourited_by', interactors, { ...target, kind: 'favourited_by', page: PAGE }, 'interactors'],
	['reblogged_by', interactors, { ...target, kind: 'reblogged_by', page: PAGE }, 'interactors'],
	['relationships', relationships, { credential, ids: WORLD.accounts.map((_, x) => accountId(x)) }],
	[
		'relationships with_suspended',
		relationships,
		{ credential, ids: WORLD.accounts.map((_, x) => accountId(x)), withSuspended: true },
	],
	[
		'followers',
		listFollows,
		{ credential, now: NOW, account: accountId(LISTED), direction: 'followers', page: PAGE, present: PRESENT },
	],
	[
		'following',
		listFollows,
		{ credential, now: NOW, account: accountId(LISTED), direction: 'following', page: PAGE, present: PRESENT },
	],
	// Among the viewer's follows: a search of every account reads the newest accounts the instance knows, a window
	// that grows with them up to its limit (ACCOUNT_RECENT_LIMIT).
	['account search', search, { ...searchInput, query: 'account', types: ['accounts'], following: true }],
	['status search', search, { ...searchInput, query: 'status', types: ['statuses'] }],
	['hashtag search', search, { ...searchInput, query: 'cats', types: ['hashtags'] }],
	['userinfo', userinfo, { credential: { ...credential, scope: 'profile' }, present: PRESENT }],
	['filters', listFilters, { credential }],
	['filter', getFilter, { credential, id: VIEWER_FILTER }],
	['filter keywords', listFilterKeywords, { credential, filterId: VIEWER_FILTER }],
	['filter statuses', listFilterStatuses, { credential, filterId: VIEWER_FILTER }],
	['filters v1', listFiltersV1, { credential }],
	['markers', getMarkers, { credential, timelines: [...MARKER_TIMELINES] }],
	['scheduled statuses', listScheduled, { credential, page: PAGE }],
	['poll', getPoll, { credential, id: statusId(TARGET), now: NOW }],
	['followed tags', followedTags, { credential, page: PAGE, present: PRESENT }],
	['featured tags', listFeaturedTags, { credential, present: PRESENT }],
	['account featured tags', accountFeaturedTags, { id: accountId(VIEWER), present: PRESENT }],
	['featured tag suggestions', featuredTagSuggestions, { credential, present: PRESENT }],
	['endorsements', listEndorsements, { credential, page: PAGE, present: PRESENT }],
	[
		'account endorsements',
		accountEndorsements,
		{ credential, now: NOW, account: accountId(VIEWER), page: PAGE, present: PRESENT },
	],
	['accounts by id', getAccounts, { ids: WORLD.accounts.map((_, x) => accountId(x)), present: PRESENT }],
	['suggestions', suggestions, { credential, version: 2, offset: 0, limit: 40, present: PRESENT }],
	[
		'pinned statuses',
		accountStatuses,
		{
			credential,
			now: NOW,
			account: accountId(VIEWER),
			page: PAGE,
			onlyMedia: false,
			excludeReplies: false,
			excludeReblogs: false,
			pinned: true,
			tagged: null,
			present: PRESENT,
		},
	],
	[
		'statuses by id',
		getStatuses,
		{
			credential,
			now: NOW,
			ids: WORLD.statuses.slice(0, MAX_STATUSES_BY_ID).map((_, s) => statusId(s)),
			present: PRESENT,
		},
	],
	['featured', getFeatured, { username: WORLD.accounts[VIEWER]?.name.toLowerCase() }],
	[
		'oembed',
		embeddedStatus,
		{
			url: `https://kopje.test/@${WORLD.accounts[WORLD.statuses[EMBEDDED]?.author ?? -1]?.name ?? ''}/${statusId(EMBEDDED)}`,
			present: PRESENT,
			now: NOW,
		},
	],
	['oembed by object URI', embeddedStatus, { url: statusUri(EMBEDDED), present: PRESENT, now: NOW }],
]

// How many rows a read may add when the unrelated rows grow from none to UNRELATED: a few for a planner's choice, far
// fewer than reading the unrelated rows would add.
const ALLOWANCE = 10
const UNRELATED = 1000

// Endpoints allowed more than ALLOWANCE in the unrelated-rows case, each with why. The extra rows are constant: the same
// with ten times the unrelated rows.
// R (statusRowBoundSql, status-rows.ts) seeks each status's rows by index once more before its chunk is read, and a
// seek reads the next index entry, which unrelated rows provide (3 rows with 1,000 or 10,000 unrelated rows).
const R_SEEKS = 'R (statusRowBoundSql) seeks the rows of each status once more, each seek reading the next index entry'
const UNRELATED_EXTRA: Record<string, { rows: number; why: string }> = {
	home: {
		rows: 3,
		why:
			"each followed hashtag's window judges its statuses again through homeFilterSql, and its probe of the viewer's " +
			`blocks and mutes reads the next index entry, which unrelated accounts provide; and ${R_SEEKS}`,
	},
	list: { rows: 2, why: R_SEEKS },
	notifications: { rows: 1, why: R_SEEKS },
	'grouped notifications': { rows: 2, why: R_SEEKS },
}

// What an endpoint showed: the items of a page, the members of a context, the results of a search, the entries of a
// list, one status, the timelines of markers, or the account userinfo claims, through the operation's ok result.
function shown(output: unknown): number {
	if (Array.isArray(output)) {
		return output.length
	}
	const value = output as Record<string, unknown>
	if (value.status === 'ok') {
		return shown(value.value)
	}
	if (Array.isArray(value.items)) {
		return value.items.length
	}
	if (Array.isArray(value.notification_groups)) {
		return value.notification_groups.length
	}
	if (typeof value.count === 'number') {
		return value.count
	}
	if (Array.isArray(value.options)) {
		return value.options.length
	}
	if (typeof value.sub === 'string') {
		return 1
	}
	if (Array.isArray(value.descendants) && Array.isArray(value.ancestors)) {
		return value.ancestors.length + value.descendants.length
	}
	// One status (the oEmbed read's).
	if (typeof value.uri === 'string' && Array.isArray(value.media_attachments)) {
		return 1
	}
	// A filter with its rules.
	if (Array.isArray(value.keywords) && Array.isArray(value.statuses)) {
		return 1
	}
	if (Array.isArray(value.accounts) && Array.isArray(value.statuses) && Array.isArray(value.hashtags)) {
		return value.accounts.length + value.statuses.length + value.hashtags.length
	}
	return MARKER_TIMELINES.filter((timeline) => timeline in value).length
}

type Entity = Record<string, unknown>

// What an endpoint showed, by identity and in order: statuses by id (and a boost's original), accounts by id,
// notifications by id, type, sender and status, hashtags by name, and relationships by their flags. Other objects
// (pages, contexts, search results, ok results) keep their shape.
function identities(output: unknown): unknown {
	if (Array.isArray(output)) {
		return output.map(identities)
	}
	if (output === null || typeof output !== 'object') {
		return output
	}
	const value = output as Entity
	if ('blocking' in value) {
		const {
			id,
			following,
			followed_by,
			requested,
			blocking,
			blocked_by,
			muting,
			muting_notifications,
			domain_blocking,
			endorsed,
			note,
		} = value
		return {
			id,
			following,
			followed_by,
			requested,
			blocking,
			blocked_by,
			muting,
			muting_notifications,
			domain_blocking,
			endorsed,
			note,
		}
	}
	// A notification group, without the time of its newest notification (written at each Store's own time).
	if ('notifications_count' in value) {
		const { latest_page_notification_at: _at, ...group } = value
		return group
	}
	if ('type' in value && 'account' in value) {
		return {
			id: value.id,
			type: value.type,
			account: (value.account as Entity).id,
			status: (value.status as Entity | null | undefined)?.id ?? null,
		}
	}
	if ('visibility' in value && 'account' in value) {
		return { id: value.id, reblog: (value.reblog as Entity | null)?.id ?? null }
	}
	// A conversation by what it shows: its id is numbered with the conversations a Store holds.
	if ('last_status' in value && 'unread' in value) {
		return { unread: value.unread, accounts: identities(value.accounts), last_status: identities(value.last_status) }
	}
	if ('acct' in value) {
		return value.id
	}
	if ('history' in value && 'name' in value) {
		return value.name
	}
	return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, identities(field)]))
}

describe('read endpoints do not read more rows as unrelated data grows (RES-7)', () => {
	it('reads the same rows with or without unrelated accounts, statuses and edges', async () => {
		const alone = await worldWith(0)
		const crowded = await worldWith(UNRELATED)
		// Every endpoint shows the viewer something, so a refused credential or an empty read cannot pass, and shows the
		// same with the unrelated rows as without.
		const outputs = async (store: StoreStub) =>
			runInDurableObject(store, (_instance, state) =>
				ENDPOINTS.map(([name, operation, input]) => [name, operation.run(state.storage.sql, input as never)] as const)
			)
		const withoutUnrelated = await outputs(alone)
		expect(withoutUnrelated.filter(([, output]) => shown(output) === 0).map(([name]) => name)).toEqual([])
		const named = (results: (readonly [string, unknown])[]) =>
			Object.fromEntries(results.map(([name, output]) => [name, identities(output)]))
		expect(named(await outputs(crowded))).toEqual(named(withoutUnrelated))
		const grown: string[] = []
		for (const [name, operation, input] of ENDPOINTS) {
			const few = await rowsRead({ store: alone }, operation, input as never)
			const many = await rowsRead({ store: crowded }, operation, input as never)
			if (many > few + ALLOWANCE + (UNRELATED_EXTRA[name]?.rows ?? 0)) {
				grown.push(`${name}: ${few} -> ${many}`)
			}
		}
		expect(grown).toEqual([])
	}, 60_000)
})

// The world's history grown by replicating it (writeCopies): its composition stays, so a read that walks past what it
// hides or filters reads a constant multiple of a page, while one that walks or sorts a whole history grows with the
// factor. Both factors are past the point where each author's history holds more than a page of what it shows. The
// author set is not grown (no follow cap bounds it yet), nor are skewed histories built.
describe("read endpoints read the same rows however long the world's history (RES-7)", () => {
	// Enough copies that every window (readWindow: 60 for a page of 20) fills on the middle page too.
	const FEW = 100
	const MANY = 400

	// Endpoints whose reads grow with the history, left out of the comparison.
	const GROWING = new Set([
		// Search reads windows of the viewer's library (LIBRARY_SOURCE_LIMIT per source) and, for hashtags, of their own
		// entries and the newest public statuses (HASHTAG_LIBRARY_LIMIT, HASHTAG_PUBLIC_WINDOW): they grow with the
		// history up to those limits.
		'status search',
		'hashtag search',
		// Suggestions read the hashtags of the viewer's newest statuses, a window that grows with their history up to its
		// limit (Tag::RECENT_STATUS_LIMIT).
		'featured tag suggestions',
	])

	type Measured = { endpoint: string; page: string; rows: number; shown: number; output: unknown }

	// Each endpoint's newest page, a page from the middle of the replicated history and the oldest page, or its one read
	// if it does not page the history.
	async function measure(factor: number): Promise<Measured[]> {
		const store = await replicated(factor)
		const viewer = accountId(VIEWER)
		const middle = await runInDurableObject(store, (_instance, state) => {
			// The viewer's edge halfway through those of the copies.
			const edge = (table: string) =>
				String(
					state.storage.sql
						.exec<{ id: number }>(
							`SELECT id FROM ${table} WHERE account_id = ?1 AND id < ?2 ORDER BY id
							LIMIT 1 OFFSET (SELECT count(*) / 2 FROM ${table} WHERE account_id = ?1 AND id < ?2)`,
							viewer,
							ORIGINAL_EDGE_BASE
						)
						.one().id
				)
			const cursors: Record<Paging, string | undefined> = {
				statuses: copyId(Math.floor(factor / 2), 0),
				notifications: edge('notifications'),
				favourites: edge('favourites'),
				bookmarks: edge('bookmarks'),
				// The target's interactors are accounts, which are not replicated: their newest page stands for the middle.
				interactors: undefined,
			}
			return cursors
		})
		const measured: Measured[] = []
		for (const [endpoint, operation, input, paging] of ENDPOINTS) {
			const maxId = paging === undefined ? undefined : middle[paging]
			const pages: [string, unknown][] =
				paging === undefined
					? [['once', input]]
					: [
							['newest', input],
							['middle', { ...(input as object), page: maxId === undefined ? PAGE : { ...PAGE, maxId } }],
							['oldest', { ...(input as object), page: { ...PAGE, minId: '1' } }],
						]
			for (const [page, paged] of pages) {
				const output = await runInDurableObject(store, (_instance, state) =>
					operation.run(state.storage.sql, paged as never)
				)
				const rows = await rowsRead({ store }, operation, paged as never)
				measured.push({ endpoint, page, rows, shown: shown(output), output })
			}
		}
		return measured
	}

	it(`reads the same rows with the world's history replicated ${FEW} or ${MANY} times`, async () => {
		const few = await measure(FEW)
		const many = await measure(MANY)
		// Every endpoint shows the viewer something on every page at either factor, and the same newest page (or one read).
		const empty = [...few, ...many].flatMap(({ endpoint, page, shown }) => (shown === 0 ? [`${endpoint} ${page}`] : []))
		expect(empty).toEqual([])
		const newest = (measured: Measured[]) =>
			Object.fromEntries(
				measured
					.filter(({ page }) => page === 'newest' || page === 'once')
					.map(({ endpoint, output }) => [endpoint, identities(output)])
			)
		expect(newest(many)).toEqual(newest(few))
		const grown = few.flatMap(({ endpoint, page, rows }, i) => {
			const manyRows = many[i]?.rows ?? Infinity
			return GROWING.has(endpoint) || manyRows <= rows + ALLOWANCE
				? []
				: [`${endpoint} ${page}: ${rows} -> ${manyRows}`]
		})
		expect(grown).toEqual([])
	}, 60_000)
})

// R2's domain term is looked up only for a remote viewer: a local or anonymous viewer reads the same rows however many
// public statuses of other authors (remote, on several domains) the rule passes, and a remote viewer on a domain the
// author blocks sees none.
describe("the author's domain block costs a local viewer nothing per status (R2, RES-7)", () => {
	const LOCAL_VIEWER = '500000000000000001'
	const BLOCKING_AUTHOR = '500000000000000002'
	const REMOTE_VIEWER = '500000000000000003'
	const OTHER_VIEWER = '500000000000000004'
	const author = (i: number) => String(510000000000000000n + BigInt(i))
	const status = (i: number) => String(520000000000000000n + BigInt(i))
	const BLOCKED_STATUS = '529999999999999999'
	const PUBLIC_TOKEN = 'public-statuses-token'
	const AUTHORS = 20

	async function publicStatuses(count: number): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			const account = (id: string, uri: string, username: string, domain: string | null) =>
				sql.exec('INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, ?, ?)', id, uri, username, domain)
			const local = (id: string, username: string) => {
				account(id, `https://kopje.test/ap/users/${username}`, username, null)
				sql.exec(
					"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'test')",
					id,
					`${username}@example.com`
				)
			}
			const insertStatus = (id: string, by: string) =>
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
					VALUES (?, ?, ?, 'public', '<p>hello</p>', ?)`,
					id,
					`https://kopje.test/objects/${id}`,
					by,
					new Date(NOW).toISOString()
				)
			local(LOCAL_VIEWER, 'viewer')
			local(BLOCKING_AUTHOR, 'author')
			account(REMOTE_VIEWER, 'https://blocked.example/users/r', 'r', 'blocked.example')
			account(OTHER_VIEWER, 'https://open.example/users/o', 'o', 'open.example')
			sql.exec("INSERT INTO domain_blocks (account_id, domain) VALUES (?, 'blocked.example')", BLOCKING_AUTHOR)
			insertStatus(BLOCKED_STATUS, BLOCKING_AUTHOR)
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('rows', 'secret', 'rows', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'rows', ?, 'read')",
				PUBLIC_TOKEN,
				LOCAL_VIEWER
			)
			// The same authors whatever the count.
			for (let a = 0; a < AUTHORS; a++) {
				account(author(a), `https://far${a % 10}.example/users/a${a}`, `a${a}`, `far${a % 10}.example`)
			}
			for (let i = 0; i < count; i++) {
				insertStatus(status(i), author(i % AUTHORS))
			}
		})
		return store
	}

	// Every status the read rule passes for the viewer, so the rule is judged once per stored status.
	const visibleCount = (viewer: string | null): StoreOperation<null, unknown> => ({
		kind: 'read',
		run: (sql) =>
			sql.exec(`SELECT count(*) AS n FROM main.statuses s WHERE ${visibleSql('s', '?1')}`, viewer).toArray(),
	})

	// The fewer fill the public timeline's window (readWindow: 60 for a page of 20).
	it('reads the same rows for a local viewer with 60 or 600 visible public statuses', async () => {
		const few = await publicStatuses(60)
		const many = await publicStatuses(600)
		const credential = { tokenHash: PUBLIC_TOKEN, scope: 'read', now: NOW } as const
		const input = { credential, now: NOW, page: PAGE, present: PRESENT, local: false, remote: false, onlyMedia: false }
		const page = async (store: StoreStub) => rowsRead({ store }, publicTimeline, input as never)
		expect(await page(many)).toBeLessThanOrEqual((await page(few)) + ALLOWANCE)
		// Over every stored status, a local viewer reads at most one row more than the anonymous viewer: the check that
		// it is not remote, once per query.
		for (const store of [few, many]) {
			const local = await rowsRead({ store }, visibleCount(LOCAL_VIEWER), null)
			const anonymous = await rowsRead({ store }, visibleCount(null), null)
			expect(local - anonymous).toBeLessThanOrEqual(1)
		}
	})

	it('hides a public status from a remote viewer on a domain its author blocks, and from no one else', async () => {
		const store = await publicStatuses(1)
		await runInDurableObject(store, (_instance, state) => {
			const db = new Db(state.storage.sql)
			expect(canView(db, REMOTE_VIEWER, BLOCKED_STATUS)).toBe(false)
			expect(canView(db, OTHER_VIEWER, BLOCKED_STATUS)).toBe(true)
			expect(canView(db, LOCAL_VIEWER, BLOCKED_STATUS)).toBe(true)
			expect(canView(db, null, BLOCKED_STATUS)).toBe(true)
		})
	})
})

// Home and a list's timeline read each author's own window (AuthorWindows in audience.ts): a page reads about a page of
// statuses per followed account or member, however many statuses each has, and wherever the page's cursor is. The
// viewer follows every author and has a list of them all; each author, and the viewer, has a history of public,
// unlisted and private statuses, some of them replies in their own thread, every one of which home and the list show;
// one more followed account and member has only direct statuses, addressed to someone else, which neither shows nor
// reads.
describe("home and list timelines read a page per author, not each author's history (RES-7)", () => {
	const VIEWER_ID = '600000000000000001'
	const LIST_ID = '600000000000000002'
	const HISTORY_TOKEN = 'history-token'
	const AUTHORS = 6
	const WHISPERER_ID = '600000000000000003'
	const ADDRESSEE_ID = '600000000000000004'
	const author = (i: number) => String(610000000000000000n + BigInt(i))
	const status = (i: number) => String(620000000000000000n + BigInt(i))
	const VISIBILITIES: readonly Visibility[] = ['public', 'unlisted', 'private']

	async function histories(perAuthor: number): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(
				"INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/viewer', 'viewer')",
				VIEWER_ID
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'viewer@example.com', X'00', X'00', 'test')",
				VIEWER_ID
			)
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('history', 'secret', 'history', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'history', ?, 'read')",
				HISTORY_TOKEN,
				VIEWER_ID
			)
			sql.exec("INSERT INTO lists (id, account_id, title) VALUES (?, ?, 'authors')", LIST_ID, VIEWER_ID)
			const authors = [VIEWER_ID]
			for (let a = 0; a < AUTHORS; a++) {
				sql.exec(
					'INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, ?, ?)',
					author(a),
					`https://far${a}.example/users/a${a}`,
					`a${a}`,
					`far${a}.example`
				)
				sql.exec(
					"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
					VIEWER_ID,
					author(a)
				)
				sql.exec('INSERT INTO list_accounts (list_id, account_id) VALUES (?, ?)', LIST_ID, author(a))
				authors.push(author(a))
			}
			// A followed account (in the list too) whose statuses are all direct, addressed to another local account.
			for (const [id, username] of [
				[WHISPERER_ID, 'whisperer'],
				[ADDRESSEE_ID, 'addressee'],
			] as const) {
				sql.exec(
					'INSERT INTO accounts (id, uri, username) VALUES (?, ?, ?)',
					id,
					`https://kopje.test/ap/users/${username}`,
					username
				)
				sql.exec(
					"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'test')",
					id,
					`${username}@example.com`
				)
			}
			sql.exec(
				"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
				VIEWER_ID,
				WHISPERER_ID
			)
			sql.exec('INSERT INTO list_accounts (list_id, account_id) VALUES (?, ?)', LIST_ID, WHISPERER_ID)
			authors.push(WHISPERER_ID)
			// The authors' statuses interleave, oldest first; every fourth is a reply in its author's own thread.
			for (let i = 0; i < perAuthor * authors.length; i++) {
				const by = authors[i % authors.length] ?? VIEWER_ID
				if (by === WHISPERER_ID) {
					sql.exec(
						`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
						VALUES (?, ?, ?, 'direct', '<p>psst</p>', ?)`,
						status(i),
						`https://kopje.test/objects/${status(i)}`,
						by,
						new Date(NOW).toISOString()
					)
					sql.exec(
						'INSERT INTO status_mentions (status_id, account_id, requires_mention, author_id) VALUES (?, ?, 1, ?)',
						status(i),
						ADDRESSEE_ID,
						by
					)
					continue
				}
				const parent = i >= authors.length && i % 4 === 0 ? status(i - authors.length) : null
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, in_reply_to_uri, in_reply_to_id, in_reply_to_account_id,
						visibility, content, published_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, '<p>hello</p>', ?)`,
					status(i),
					`https://kopje.test/objects/${status(i)}`,
					by,
					parent === null ? null : `https://kopje.test/objects/${parent}`,
					parent,
					parent === null ? null : by,
					VISIBILITIES[i % VISIBILITIES.length] ?? 'public',
					new Date(NOW).toISOString()
				)
			}
		})
		return store
	}

	// The shorter histories fill each author's stream (streamWindow: 40 for a page of 20).
	it('reads the same rows with 60 or 2,000 statuses per author, on the newest, a middle and the oldest page', async () => {
		const few = await histories(60)
		const many = await histories(2000)
		const credential = { tokenHash: HISTORY_TOKEN, scope: 'read', now: NOW } as const
		const grown: string[] = []
		// The newest page; a page from the middle of the longer histories (above every status of the shorter ones, so
		// their newest page); the oldest page.
		const middle = status((2000 * (AUTHORS + 2)) / 2)
		for (const page of [PAGE, { ...PAGE, maxId: middle }, { ...PAGE, minId: '1' }]) {
			for (const [name, operation, input] of [
				['home', homeTimeline, { credential, page, present: PRESENT }],
				['list', listTimeline, { credential, id: LIST_ID, page, present: PRESENT }],
			] as const) {
				// A full page from either store.
				const shownBy = async (store: StoreStub) =>
					runInDurableObject(store, (_instance, state) => shown(operation.run(state.storage.sql, input as never)))
				expect([await shownBy(few), await shownBy(many)]).toEqual([PAGE.limit, PAGE.limit])
				const fewRows = await rowsRead({ store: few }, operation as StoreOperation<never, unknown>, input as never)
				const manyRows = await rowsRead({ store: many }, operation as StoreOperation<never, unknown>, input as never)
				if (manyRows > fewRows + ALLOWANCE) {
					grown.push(`${name} ${JSON.stringify(page)}: ${fewRows} -> ${manyRows}`)
				}
			}
		}
		expect(grown).toEqual([])
	}, 60_000)
})

// The conversation list reads a page of the viewer's conversations through the (account, last status) index, and each
// one's last status and participants, however many conversations the viewer has and however long each is: the viewer
// has 20 or 2,000 conversations, each a thread of three direct statuses with one of ten remote accounts.
describe('the conversation list reads a page, not the history (RES-7)', () => {
	const VIEWER_ID = '800000000000000001'
	const HISTORY_TOKEN = 'conversations-token'
	const PARTNERS = 10
	const partner = (i: number) => String(810000000000000000n + BigInt(i))
	const status = (i: number) => String(820000000000000000n + BigInt(i))

	async function conversations(count: number): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(
				"INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/viewer', 'viewer')",
				VIEWER_ID
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'viewer@example.com', X'00', X'00', 'test')",
				VIEWER_ID
			)
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('history', 'secret', 'history', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'history', ?, 'read')",
				HISTORY_TOKEN,
				VIEWER_ID
			)
			for (let p = 0; p < PARTNERS; p++) {
				sql.exec(
					'INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, ?, ?)',
					partner(p),
					`https://far${p}.example/users/p${p}`,
					`p${p}`,
					`far${p}.example`
				)
			}
			// Each conversation: the partner writes, the viewer answers, the partner answers again.
			for (let c = 0; c < count; c++) {
				const with_ = partner(c % PARTNERS)
				for (let k = 0; k < 3; k++) {
					const id = status(3 * c + k)
					const author = k === 1 ? VIEWER_ID : with_
					const parent = k === 0 ? null : status(3 * c + k - 1)
					sql.exec(
						`INSERT INTO statuses (id, uri, account_id, in_reply_to_uri, in_reply_to_id, in_reply_to_account_id,
							visibility, content, published_at)
						VALUES (?, ?, ?, ?, ?, ?, 'direct', '<p>psst</p>', ?)`,
						id,
						`https://kopje.test/objects/${id}`,
						author,
						parent === null ? null : `https://kopje.test/objects/${parent}`,
						parent,
						parent === null ? null : k === 1 ? with_ : VIEWER_ID,
						new Date(NOW).toISOString()
					)
					sql.exec(
						'INSERT INTO status_mentions (status_id, account_id) VALUES (?, ?)',
						id,
						author === VIEWER_ID ? with_ : VIEWER_ID
					)
					if (author !== VIEWER_ID) {
						sql.exec(
							"INSERT INTO notifications (account_id, type, from_account_id, status_id) VALUES (?, 'mention', ?, ?)",
							VIEWER_ID,
							author,
							id
						)
					}
				}
			}
			backfillConversations({ exec: (query: string) => sql.exec(query) })
		})
		return store
	}

	it('reads the same rows with 20 or 2,000 conversations, on the newest, a middle and the oldest page', async () => {
		const few = await conversations(20)
		const many = await conversations(2000)
		const credential = { tokenHash: HISTORY_TOKEN, scope: 'read', now: NOW } as const
		const grown: string[] = []
		// A page from the middle of the longer history is above every conversation of the shorter one.
		const middle = status(3 * 1000 + 2)
		for (const page of [PAGE, { ...PAGE, maxId: middle }, { ...PAGE, minId: '1' }]) {
			const input = { credential, page, present: PRESENT }
			const shownBy = async (store: StoreStub) =>
				runInDurableObject(store, (_instance, state) => shown(listConversations.run(state.storage.sql, input)))
			expect([await shownBy(few), await shownBy(many)]).toEqual([PAGE.limit, PAGE.limit])
			const fewRows = await rowsRead({ store: few }, listConversations, input)
			const manyRows = await rowsRead({ store: many }, listConversations, input)
			if (manyRows > fewRows + ALLOWANCE) {
				grown.push(`${JSON.stringify(page)}: ${fewRows} -> ${manyRows}`)
			}
		}
		expect(grown).toEqual([])
	}, 60_000)
})

// What the viewer never sees of an author costs nothing, however long the author's history. Home reads the viewer's
// mentions per followed account (status_mentions_requires_mention), so an account the viewer does not follow, sending
// them direct statuses, is never read; and an account's statuses are not read when the viewer may see none of them:
// the account blocks the viewer, the viewer blocks it, or it is suspended or being deleted.
describe("reads skip an author's history the viewer never sees (RES-7)", () => {
	const VIEWER_ID = '640000000000000001'
	const FRIEND_ID = '640000000000000002'
	const STRANGER_ID = '640000000000000003'
	const BLOCKER_ID = '640000000000000004'
	const BLOCKED_ID = '640000000000000005'
	const SUSPENDED_ID = '640000000000000006'
	const DELETING_ID = '640000000000000007'
	const HIDDEN_AUTHORS = { blocker: BLOCKER_ID, blocked: BLOCKED_ID, suspended: SUSPENDED_ID, deleting: DELETING_ID }
	const SKIP_TOKEN = 'skip-token'
	const status = (i: number) => String(650000000000000000n + BigInt(i))

	async function histories(perAuthor: number): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			const local = (id: string, username: string, suspended = false) => {
				sql.exec(
					'INSERT INTO accounts (id, uri, username) VALUES (?, ?, ?)',
					id,
					`https://kopje.test/ap/users/${username}`,
					username
				)
				sql.exec(
					`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey, suspended_at)
					VALUES (?, ?, X'00', X'00', 'test', ?)`,
					id,
					`${username}@example.com`,
					suspended ? '2026-01-01T00:00:00.000Z' : null
				)
			}
			const remote = (id: string, username: string, deleting = false) =>
				sql.exec(
					'INSERT INTO accounts (id, uri, username, domain, deleted_at) VALUES (?, ?, ?, ?, ?)',
					id,
					`https://far.example/users/${username}`,
					username,
					'far.example',
					deleting ? '2026-01-01T00:00:00.000Z' : null
				)
			local(VIEWER_ID, 'viewer')
			local(SUSPENDED_ID, 'suspended', true)
			remote(FRIEND_ID, 'friend')
			remote(STRANGER_ID, 'stranger')
			remote(BLOCKER_ID, 'blocker')
			remote(BLOCKED_ID, 'blocked')
			remote(DELETING_ID, 'deleting', true)
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('skip', 'secret', 'skip', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'skip', ?, 'read')",
				SKIP_TOKEN,
				VIEWER_ID
			)
			sql.exec(
				"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
				VIEWER_ID,
				FRIEND_ID
			)
			sql.exec('INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)', BLOCKER_ID, VIEWER_ID)
			sql.exec('INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)', VIEWER_ID, BLOCKED_ID)
			// The friend's public statuses fill home; the stranger's direct statuses to the viewer interleave with them,
			// and each hidden author posts publicly, all newer than the friend's.
			const authors = [FRIEND_ID, STRANGER_ID, ...Object.values(HIDDEN_AUTHORS)]
			for (let i = 0; i < perAuthor * authors.length; i++) {
				const by = authors[i % authors.length] ?? FRIEND_ID
				const direct = by === STRANGER_ID
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
					VALUES (?, ?, ?, ?, '<p>hello</p>', ?)`,
					status(i),
					`https://far.example/objects/${status(i)}`,
					by,
					direct ? 'direct' : 'public',
					new Date(NOW).toISOString()
				)
				if (direct) {
					sql.exec(
						'INSERT INTO status_mentions (status_id, account_id, requires_mention, author_id) VALUES (?, ?, 1, ?)',
						status(i),
						VIEWER_ID,
						by
					)
				}
			}
		})
		return store
	}

	// The shorter histories fill the windows (streamWindow and readWindow, 40 and 60 for a page of 20).
	it('reads the same rows with 60 or 2,000 statuses per author', async () => {
		const few = await histories(60)
		const many = await histories(2000)
		const credential = { tokenHash: SKIP_TOKEN, scope: 'read', now: NOW } as const
		const reads: [string, StoreOperation<never, unknown>, unknown, number][] = [
			// A full page of the friend's statuses, none of the stranger's.
			['home', homeTimeline, { credential, page: PAGE, present: PRESENT }, PAGE.limit],
			...Object.entries(HIDDEN_AUTHORS).map(
				([name, account]) =>
					[
						`account statuses of ${name}`,
						accountStatuses,
						{
							credential,
							now: NOW,
							account,
							page: PAGE,
							onlyMedia: false,
							excludeReplies: false,
							excludeReblogs: false,
							pinned: false,
							tagged: null,
							present: PRESENT,
						},
						0,
					] as [string, StoreOperation<never, unknown>, unknown, number]
			),
		]
		const grown: string[] = []
		for (const [name, operation, input, expected] of reads) {
			const shownBy = async (store: StoreStub) =>
				runInDurableObject(store, (_instance, state) => shown(operation.run(state.storage.sql, input as never)))
			expect([name, await shownBy(few), await shownBy(many)]).toEqual([name, expected, expected])
			const fewRows = await rowsRead({ store: few }, operation, input as never)
			const manyRows = await rowsRead({ store: many }, operation, input as never)
			if (manyRows > fewRows + ALLOWANCE) {
				grown.push(`${name}: ${fewRows} -> ${manyRows}`)
			}
		}
		expect(grown).toEqual([])
	}, 60_000)
})

// Userinfo reads the token's own account: its newest public, unlisted or private status (last_status_at) comes from the
// partial index statuses_feed, so the rows read do not grow with the account's history, nor with its direct statuses,
// which are its newest here.
describe("userinfo reads the account, not the account's history (RES-7)", () => {
	const OWNER_ID = '800000000000000001'
	const OWNER_TOKEN = 'userinfo-token'
	const status = (i: number) => String(810000000000000000n + BigInt(i))

	async function history(count: number): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(
				"INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/owner', 'owner')",
				OWNER_ID
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'owner@example.com', X'00', X'00', 'test')",
				OWNER_ID
			)
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('userinfo', 'secret', 'userinfo', 'urn:ietf:wg:oauth:2.0:oob', 'profile')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'userinfo', ?, 'profile')",
				OWNER_TOKEN,
				OWNER_ID
			)
			// The oldest quarter is public, every later status direct.
			for (let i = 0; i < count; i++) {
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
					VALUES (?, ?, ?, ?, '<p>hello</p>', ?)`,
					status(i),
					`https://kopje.test/objects/${status(i)}`,
					OWNER_ID,
					i < count / 4 ? 'public' : 'direct',
					new Date(NOW).toISOString()
				)
			}
		})
		return store
	}

	it('reads the same rows with 20 or 2,000 statuses', async () => {
		const input = { credential: { tokenHash: OWNER_TOKEN, scope: 'profile', now: NOW }, present: PRESENT } as const
		const counts: number[] = []
		for (const store of [await history(20), await history(2000)]) {
			const output = await runInDurableObject(store, (_instance, state) => userinfo.run(state.storage.sql, input))
			expect(output).toMatchObject({ status: 'ok', value: { sub: 'https://kopje.test/ap/users/owner' } })
			counts.push(await rowsRead({ store }, userinfo, input))
		}
		const [few = 0, many = 0] = counts
		expect(many).toBeLessThanOrEqual(few + ALLOWANCE)
	}, 60_000)
})

// Filters are reported as a page is presented (filters.ts): each read for a signed-in viewer reads the viewer's active
// filters, compiled once, and seeks the page's statuses in the filters that name statuses. So a page costs the viewer's
// filter rows, which the caps bound (MAX_FILTERS, MAX_FILTER_KEYWORDS), and no more as the history grows, however many
// statuses the filters name. The viewer follows one author whose public statuses mention them; the filters, in every
// context, match none of them, so every page is full.
describe('filters cost a page their own rows, up to the caps, not the history (RES-7)', () => {
	const VIEWER_ID = '660000000000000001'
	const AUTHOR_ID = '660000000000000002'
	const FILTER_TOKEN = 'filter-token'
	const status = (i: number) => String(670000000000000000n + BigInt(i))
	const filter = (f: number) => String(680000000000000000n + BigInt(f))
	const CONTEXTS = '["home","notifications","public","thread","account"]'

	async function store(perAuthor: number, filters: number): Promise<StoreStub> {
		const stub = await migratedStore()
		await runInDurableObject(stub, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(
				"INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/viewer', 'viewer')",
				VIEWER_ID
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'viewer@example.com', X'00', X'00', 'test')",
				VIEWER_ID
			)
			sql.exec(
				"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://far.example/users/a', 'a', 'far.example')",
				AUTHOR_ID
			)
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('filters', 'secret', 'filters', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'filters', ?, 'read')",
				FILTER_TOKEN,
				VIEWER_ID
			)
			sql.exec(
				"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
				VIEWER_ID,
				AUTHOR_ID
			)
			for (let i = 0; i < perAuthor; i++) {
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
					VALUES (?, ?, ?, 'public', ?, ?)`,
					status(i),
					`https://far.example/objects/${status(i)}`,
					AUTHOR_ID,
					`<p>hello viewer, number ${i}</p>`,
					new Date(NOW).toISOString()
				)
				sql.exec(
					"INSERT INTO notifications (account_id, type, from_account_id, status_id) VALUES (?, 'mention', ?, ?)",
					VIEWER_ID,
					AUTHOR_ID,
					status(i)
				)
			}
			// Each filter has the most keywords (none of which the statuses hold) and names one of the author's oldest statuses,
			// below the newest page.
			for (let f = 0; f < filters; f++) {
				sql.exec(
					"INSERT INTO filters (id, account_id, title, context, action) VALUES (?, ?, 'f', ?, ?)",
					filter(f),
					VIEWER_ID,
					CONTEXTS,
					f % 2 === 0 ? 'hide' : 'warn'
				)
				for (let k = 0; k < MAX_FILTER_KEYWORDS; k++) {
					sql.exec(
						'INSERT INTO filter_keywords (id, filter_id, keyword, whole_word) VALUES (?, ?, ?, ?)',
						String(690000000000000000n + BigInt(f * 1000 + k)),
						filter(f),
						`absent ${f} ${k}`,
						k % 2
					)
				}
				sql.exec(
					'INSERT INTO filter_statuses (id, filter_id, status_id) VALUES (?, ?, ?)',
					String(695000000000000000n + BigInt(f)),
					filter(f),
					status(f % PAGE.limit)
				)
			}
		})
		return stub
	}

	const credential = { tokenHash: FILTER_TOKEN, scope: 'read', now: NOW } as const
	const reads: [string, StoreOperation<never, unknown>, unknown][] = [
		['home', homeTimeline, { credential, page: PAGE, present: PRESENT }],
		['public', publicTimeline, { ...timeline, credential }],
		[
			'account statuses',
			accountStatuses,
			{
				credential,
				now: NOW,
				account: AUTHOR_ID,
				page: PAGE,
				onlyMedia: false,
				excludeReplies: false,
				excludeReblogs: false,
				pinned: false,
				tagged: null,
				present: PRESENT,
			},
		],
		[
			'notifications',
			listNotifications,
			{ credential, page: PAGE, types: [], excludeTypes: [], accountId: null, present: PRESENT },
		],
	]

	async function measure(perAuthor: number, filters: number): Promise<Record<string, number>> {
		const stub = await store(perAuthor, filters)
		const rows: Record<string, number> = {}
		for (const [name, operation, input] of reads) {
			const output = await runInDurableObject(stub, (_instance, state) =>
				operation.run(state.storage.sql, input as never)
			)
			expect([name, shown(output)]).toEqual([name, PAGE.limit])
			rows[name] = await rowsRead({ store: stub }, operation, input as never)
		}
		return rows
	}

	// The fewer statuses fill the reads' windows (readWindow: 60 for a page of 20).
	it('reads the same rows with 60 or 2,000 statuses at the caps, and at most the filter rows more than with none', async () => {
		const none = await measure(60, 0)
		const few = await measure(60, MAX_FILTERS)
		const many = await measure(2000, MAX_FILTERS)
		const grown: string[] = []
		for (const [name] of reads) {
			const [base = 0, capped = 0, longer = 0] = [none[name], few[name], many[name]]
			// Per filter: its row, its contexts, its keywords (each through a json_each list of the filters), whether it
			// names statuses, and a seek per status of the page (and its json_each entry).
			if (capped > base + MAX_FILTERS * (2 * MAX_FILTER_KEYWORDS + 2 * PAGE.limit + 10) + ALLOWANCE) {
				grown.push(`${name} with filters: ${base} -> ${capped}`)
			}
			if (longer > capped + ALLOWANCE) {
				grown.push(`${name} with history: ${capped} -> ${longer}`)
			}
		}
		expect(grown).toEqual([])
	}, 120_000)
})

// Markers read the viewer's own rows through the (account_id, timeline) key: at most one per timeline, however many
// accounts have markers.
describe("markers read the viewer's rows, not every account's (RES-7)", () => {
	const VIEWER_ID = '630000000000000000'
	const MARKERS_TOKEN = 'markers-token'

	async function accountsWithMarkers(count: number): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO accounts (id, uri, username)
				SELECT CAST(630000000000000000 + i AS TEXT), 'https://kopje.test/ap/users/u' || i, 'u' || i FROM n`,
				count
			)
			sql.exec(
				`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
				SELECT id, username || '@example.com', X'00', X'00', 'test' FROM accounts`
			)
			for (const timeline of MARKER_TIMELINES) {
				sql.exec(
					`INSERT INTO markers (account_id, timeline, last_read_id, version, updated_at)
					SELECT account_id, ?, account_id, 1, '2026-01-01T00:00:00.000Z' FROM local_accounts`,
					timeline
				)
			}
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('markers', 'secret', 'markers', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'markers', ?, 'read')",
				MARKERS_TOKEN,
				VIEWER_ID
			)
		})
		return store
	}

	it('reads the same rows with 10 or 2,000 accounts that have markers', async () => {
		const credential = { tokenHash: MARKERS_TOKEN, scope: 'read', now: NOW } as const
		const input = { credential, timelines: [...MARKER_TIMELINES] }
		const few = await accountsWithMarkers(10)
		const many = await accountsWithMarkers(2000)
		const shownBy = async (store: StoreStub) =>
			runInDurableObject(store, (_instance, state) => shown(getMarkers.run(state.storage.sql, input)))
		expect([await shownBy(few), await shownBy(many)]).toEqual([2, 2])
		const fewRows = await rowsRead({ store: few }, getMarkers, input)
		expect(await rowsRead({ store: many }, getMarkers, input)).toBeLessThanOrEqual(fewRows + ALLOWANCE)
	})
})

// Endorsements and private notes (R28) add a dimension: the accounts one account endorses and keeps notes on. A page
// of endorsements reads the owner's from the cursor through the primary key, and a relationship looks its endorsement
// and note up by pair, so they read the same rows whether the viewer endorses and keeps notes on 60 accounts or 2,000.
describe('endorsements and notes read a page, however many an account has (RES-7)', () => {
	const VIEWER_ID = '640000000000000000'
	const ENDORSING_TOKEN = 'endorsing-token'
	const target = (i: number) => String(641000000000000000n + BigInt(i))

	async function endorsing(count: number): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(
				"INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/viewer', 'viewer')",
				VIEWER_ID
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'viewer@example.com', X'00', X'00', 'test')",
				VIEWER_ID
			)
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO accounts (id, uri, username, domain)
				SELECT CAST(?2 + i AS TEXT), 'https://far' || (i % 10) || '.example/users/u' || i, 'u' || i,
					'far' || (i % 10) || '.example'
				FROM n`,
				count,
				target(0)
			)
			sql.exec(
				`INSERT INTO follows (account_id, target_account_id, state)
				SELECT ?1, id, 'accepted' FROM accounts WHERE id <> ?1`,
				VIEWER_ID
			)
			sql.exec(
				'INSERT INTO account_pins (account_id, target_account_id) SELECT account_id, target_account_id FROM follows'
			)
			sql.exec(
				"INSERT INTO account_notes (account_id, target_account_id, comment) SELECT account_id, target_account_id, 'n' FROM follows"
			)
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('endorsing', 'secret', 'endorsing', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'endorsing', ?, 'read')",
				ENDORSING_TOKEN,
				VIEWER_ID
			)
		})
		return store
	}

	// The fewer fill the read's window (readWindow: 60 for a page of 20).
	it('reads the same rows with 60 or 2,000, on the newest, a middle and the oldest page', async () => {
		const few = await endorsing(60)
		const many = await endorsing(2000)
		const credential = { tokenHash: ENDORSING_TOKEN, scope: 'read', now: NOW } as const
		const grown: string[] = []
		// The newest page; a page from the middle of the longer list (above every account of the shorter one, so its
		// newest page); the oldest page.
		const pages = [PAGE, { ...PAGE, maxId: target(1000) }, { ...PAGE, minId: '1' }]
		const reads: [string, StoreOperation<never, unknown>, unknown][] = [
			...pages.flatMap((page): [string, StoreOperation<never, unknown>, unknown][] => [
				[`endorsements ${JSON.stringify(page)}`, listEndorsements, { credential, page, present: PRESENT }],
				[
					`account endorsements ${JSON.stringify(page)}`,
					accountEndorsements,
					{ credential: null, now: NOW, account: VIEWER_ID, page, present: PRESENT },
				],
			]),
			['relationships', relationships, { credential, ids: Array.from({ length: 20 }, (_, i) => target(i)) }],
			[
				'relationships with_suspended',
				relationships,
				{ credential, ids: Array.from({ length: 20 }, (_, i) => target(i)), withSuspended: true },
			],
		]
		for (const [name, operation, input] of reads) {
			const shownBy = async (store: StoreStub) =>
				runInDurableObject(store, (_instance, state) => shown(operation.run(state.storage.sql, input as never)))
			expect([name, await shownBy(few), await shownBy(many)]).toEqual([name, PAGE.limit, PAGE.limit])
			const fewRows = await rowsRead({ store: few }, operation, input as never)
			const manyRows = await rowsRead({ store: many }, operation, input as never)
			if (manyRows > fewRows + ALLOWANCE) {
				grown.push(`${name}: ${fewRows} -> ${manyRows}`)
			}
		}
		expect(grown).toEqual([])
	}, 60_000)
})

// A list's members add a dimension: the accounts one list holds. A page of members reads the list's from the cursor
// through the primary key, so it reads the same rows whether the list holds 60 accounts or 2,000.
describe("a list's members read a page, however many it holds (RES-7)", () => {
	const OWNER_ID = '650000000000000000'
	const LIST_ID = '659000000000000000'
	const OWNER_TOKEN = 'list-owner-token'
	const member = (i: number) => String(651000000000000000n + BigInt(i))

	async function holding(count: number): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(
				"INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/owner', 'owner')",
				OWNER_ID
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'owner@example.com', X'00', X'00', 'test')",
				OWNER_ID
			)
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO accounts (id, uri, username, domain)
				SELECT CAST(?2 + i AS TEXT), 'https://far' || (i % 10) || '.example/users/u' || i, 'u' || i,
					'far' || (i % 10) || '.example'
				FROM n`,
				count,
				member(0)
			)
			sql.exec(
				`INSERT INTO follows (account_id, target_account_id, state)
				SELECT ?1, id, 'accepted' FROM accounts WHERE id <> ?1`,
				OWNER_ID
			)
			sql.exec("INSERT INTO lists (id, account_id, title) VALUES (?, ?, 'l')", LIST_ID, OWNER_ID)
			sql.exec('INSERT INTO list_accounts (list_id, account_id) SELECT ?, target_account_id FROM follows', LIST_ID)
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('listing', 'secret', 'listing', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'listing', ?, 'read')",
				OWNER_TOKEN,
				OWNER_ID
			)
		})
		return store
	}

	// The fewer fill the read's window (readWindow: 60 for a page of 20).
	it('reads the same rows with 60 or 2,000, on the newest, a middle and the oldest page', async () => {
		const few = await holding(60)
		const many = await holding(2000)
		const credential = { tokenHash: OWNER_TOKEN, scope: 'read', now: NOW } as const
		const grown: string[] = []
		// The newest page; a page from the middle of the longer list (above every member of the shorter one, so its
		// newest page); the oldest page.
		for (const page of [PAGE, { ...PAGE, maxId: member(1000) }, { ...PAGE, minId: '1' }]) {
			const input = { credential, id: LIST_ID, page, present: PRESENT }
			const shownBy = async (store: StoreStub) =>
				runInDurableObject(store, (_instance, state) => shown(listAccounts.run(state.storage.sql, input)))
			expect([page, await shownBy(few), await shownBy(many)]).toEqual([page, PAGE.limit, PAGE.limit])
			const fewRows = await rowsRead({ store: few }, listAccounts, input)
			const manyRows = await rowsRead({ store: many }, listAccounts, input)
			if (manyRows > fewRows + ALLOWANCE) {
				grown.push(`${JSON.stringify(page)}: ${fewRows} -> ${manyRows}`)
			}
		}
		expect(grown).toEqual([])
	}, 60_000)
})

// A local account looked up by its exact username (a personal inbox, the outbox) is found through the index on
// lower(username), so the lookup reads the same rows whether the instance has 20 local accounts or 2,000.
describe('a local account is found by username, however many local accounts there are (RES-7)', () => {
	async function knowing(count: number): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(
				"INSERT INTO accounts (id, uri, username) VALUES ('660000000000000000', 'https://kopje.test/ap/users/alice', 'alice')"
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES ('660000000000000000', 'alice@example.com', X'00', X'00', 'test')"
			)
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO accounts (id, uri, username)
				SELECT CAST(661000000000000000 + i AS TEXT), 'https://kopje.test/ap/users/u' || i, 'u' || i FROM n`,
				count
			)
			sql.exec(
				`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
				SELECT id, username || '@example.com', X'00', X'00', 'test' FROM accounts WHERE username GLOB 'u[0-9]*'`
			)
		})
		return store
	}

	it('reads the same rows with 20 or 2,000 local accounts', async () => {
		const few = await knowing(20)
		const many = await knowing(2000)
		const reads: [string, StoreOperation<never, unknown>, unknown][] = [
			['inbox owner', inboxOwnerExists, { username: 'alice' }],
			['inbox gate', inboxGate, GATE_INPUT],
			['outbox', getOutbox, { username: 'alice', before: null }],
		]
		const grown: string[] = []
		for (const [name, operation, input] of reads) {
			const fewRows = await rowsRead({ store: few }, operation, input as never)
			const manyRows = await rowsRead({ store: many }, operation, input as never)
			if (manyRows > fewRows + ALLOWANCE) {
				grown.push(`${name}: ${fewRows} -> ${manyRows}`)
			}
		}
		expect(grown).toEqual([])
	})
})

const GATE_INPUT = { username: 'alice', actor: 'https://x.example/u', keyId: 'https://x.example/u#k' }

// The inbox gate (domain/inbox.ts inboxGate) looks each of its facts up by a key or an index: the same rows whether the
// Store holds 20 or 2,000 remote keys, and 20 or 2,000 instance domain blocks, each grown on its own. The asked actor
// and key are stored too, so the lookups find a row rather than stopping at an empty index.
describe('the inbox gate reads the same rows however many keys and domain blocks there are (RES-7)', () => {
	async function holding({ keys, blocks }: { keys: number; blocks: number }): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec("INSERT INTO instance_settings (name, value) VALUES ('domain', 'kopje.test')")
			sql.exec(
				"INSERT INTO accounts (id, uri, username) VALUES ('660000000000000000', 'https://kopje.test/ap/users/alice', 'alice')"
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES ('660000000000000000', 'alice@example.com', X'00', X'00', 'test')"
			)
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO accounts (id, uri, username, domain)
				SELECT CAST(670000000000000000 + i AS TEXT), CASE i WHEN 0 THEN 'https://x.example/u'
					ELSE 'https://k' || i || '.example/u' END, 'u', CASE i WHEN 0 THEN 'x.example' ELSE 'k' || i || '.example' END
				FROM n`,
				keys
			)
			sql.exec(
				`INSERT INTO remote_keys (key_id, account_id, pem, fetched_at)
				SELECT uri || '#k', id, 'pem', ?1 FROM accounts WHERE domain IS NOT NULL`,
				NOW
			)
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO instance_domain_blocks (domain, severity, created_at, updated_at)
				SELECT 'b' || i || '.example', 'suspend', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z' FROM n`,
				blocks
			)
		})
		return store
	}

	it.each([
		['remote keys', { keys: 20, blocks: 20 }, { keys: 2000, blocks: 20 }],
		['instance domain blocks', { keys: 20, blocks: 20 }, { keys: 20, blocks: 2000 }],
	])(
		'reads the same rows with 20 or 2,000 %s',
		async (_name, small, large) => {
			const few = await holding(small)
			const many = await holding(large)
			const gate = await runInDurableObject(few, (_instance, state) => inboxGate.run(state.storage.sql, GATE_INPUT))
			expect(gate).toEqual({
				domain: 'kopje.test',
				ownerExists: true,
				domainBlocked: false,
				key: { keyId: GATE_INPUT.keyId, stored: { owner: GATE_INPUT.actor, pem: 'pem', fetchedAt: NOW } },
			})
			const fewRows = await rowsRead({ store: few }, inboxGate, GATE_INPUT)
			const manyRows = await rowsRead({ store: many }, inboxGate, GATE_INPUT)
			expect(manyRows).toBeLessThanOrEqual(fewRows + ALLOWANCE)
		},
		60_000
	)

	// remote_keys.fetched_at has only an INTEGER affinity, so an imported row can hold any storage class. The gate hands
	// the Worker a number or null (never fresh, ID-1), and getRemoteKey judges the stored time the same way.
	it.each<[string, string, number | null, boolean]>([
		// SQLite's 'now' as a time; a numeric text would be stored as a number by the affinity.
		["'now'", 'text', null, false],
		["X'00'", 'blob', null, false],
		[String(NOW - 0.5), 'real', NOW - 0.5, true],
		[String(NOW - KEY_REFRESH_MS - 0.5), 'real', NOW - KEY_REFRESH_MS - 0.5, false],
		[String(NOW), 'integer', NOW, true],
	])('hands the Worker a stored time of %s (%s) as %s', async (stored, storageClass, fetchedAt, fresh) => {
		const store = await holding({ keys: 1, blocks: 1 })
		const read = await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(`UPDATE remote_keys SET fetched_at = ${stored} WHERE key_id = ?`, GATE_INPUT.keyId)
			return {
				storageClass: sql
					.exec<{ c: string }>('SELECT typeof(fetched_at) AS c FROM remote_keys WHERE key_id = ?', GATE_INPUT.keyId)
					.one().c,
				fetchedAt: inboxGate.run(sql, GATE_INPUT).key?.stored?.fetchedAt,
				fresh: getRemoteKey.run(sql, { keyId: GATE_INPUT.keyId, now: NOW })?.fresh,
			}
		})
		expect(read).toEqual({ storageClass, fetchedAt, fresh })
	})
})

// The rows an operation reads, writes included (rowsRead in read-helpers.ts counts reads only).
async function rowsTouched<I>(store: StoreStub, operation: StoreOperation<I, unknown>, input: I): Promise<number> {
	return runInDurableObject(store, (_instance, state) => {
		let read = 0
		const real = state.storage.sql
		const counting = {
			exec: (query: string, ...params: SqlStorageValue[]) => {
				const cursor = real.exec(query, ...params)
				return Object.defineProperty(
					watchedCursor(cursor, () => (read += cursor.rowsRead)),
					'rowsWritten',
					{
						get() {
							cursor.toArray()
							read += cursor.rowsRead
							return cursor.rowsWritten
						},
					}
				)
			},
		} as unknown as SqlStorage
		operation.run(counting, input)
		return read
	})
}

// Scheduled statuses (R26) add a dimension: the accounts that schedule, each up to its limit. An account's page reads
// its own index, and a publication round reads the due ones through the index by time, so both read the same rows
// with 10 accounts holding scheduled statuses or 300, each with 30, only one of them due.
describe('scheduled statuses read a page and a round, however many accounts schedule (RES-7)', () => {
	const OWNER = '820000000000000000'
	const TOKEN = 'scheduled-token'
	const account = (i: number) => String(820000000000000000n + BigInt(i))
	const DUE = '740000000000000001'

	async function schedules(accounts: number): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			for (let i = 0; i < accounts; i++) {
				sql.exec(
					'INSERT INTO accounts (id, uri, username) VALUES (?, ?, ?)',
					account(i),
					`https://kopje.test/ap/users/u${i}`,
					`u${i}`
				)
				sql.exec(
					"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'test')",
					account(i),
					`u${i}@example.com`
				)
				writeScheduled(sql, account(i), 750000000000000000n + BigInt(i * 100), 30)
			}
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('scheduled', 'secret', 'scheduled', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'scheduled', ?, 'read')",
				TOKEN,
				OWNER
			)
			sql.exec(
				`INSERT INTO scheduled_statuses (id, account_id, scheduled_at, params)
				VALUES (?, ?, ?, json_object('text', 'due', 'spoiler_text', '', 'sensitive', NULL, 'language', NULL,
					'visibility', NULL, 'in_reply_to_id', NULL, 'media_ids', NULL))`,
				DUE,
				account(1),
				new Date(NOW - 60_000).toISOString()
			)
		})
		return store
	}

	it('reads the same rows with 10 or 300 accounts holding scheduled statuses', async () => {
		const page = { credential: { tokenHash: TOKEN, scope: 'read', now: NOW }, page: PAGE } as const
		const due = { now: NOW, limit: 25 }
		const publish = { id: DUE, now: NOW, objectId: '00000000-0000-4000-8000-000000000001' }
		const measured: number[][] = []
		for (const store of [await schedules(10), await schedules(300)]) {
			const shown = await runInDurableObject(store, (_instance, state) => listScheduled.run(state.storage.sql, page))
			expect(shown).toMatchObject({ status: 'ok', value: { items: expect.any(Array) } })
			expect(shown.status === 'ok' ? shown.value.items.length : 0).toBe(PAGE.limit)
			const rows = [await rowsRead({ store }, listScheduled, page), await rowsTouched(store, dueScheduled, due)]
			rows.push(await rowsTouched(store, publishScheduled, publish))
			expect(
				await runInDurableObject(store, (_instance, state) =>
					state.storage.sql.exec('SELECT count(*) AS n FROM statuses').one()
				)
			).toEqual({ n: 1 })
			measured.push(rows)
		}
		const [few = [], many = []] = measured
		const grown = ['page', 'due', 'publish'].flatMap((name, k) =>
			(many[k] ?? Infinity) <= (few[k] ?? 0) + ALLOWANCE ? [] : [`${name}: ${few[k]} -> ${many[k]}`]
		)
		expect(grown).toEqual([])
	}, 60_000)
})

// Polls add two dimensions: the polls of a page and the votes in each. A page presents its polls by reading each
// poll's row and the viewer's own votes, and a vote reads the voter's own votes, so the rows read are the same with 10
// or 1,000 votes in each of a page's 20 polls.
describe('polls are presented from their counts, not their votes (RES-7)', () => {
	const VIEWER_ID = '830000000000000000'
	const AUTHOR_ID = '830000000000000001'
	const TOKEN = 'polls-token'
	const poll = (i: number) => String(840000000000000000n + BigInt(i))

	async function polled(votes: number): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			for (const [id, name] of [
				[VIEWER_ID, 'viewer'],
				[AUTHOR_ID, 'author'],
			] as const) {
				sql.exec(
					'INSERT INTO accounts (id, uri, username) VALUES (?, ?, ?)',
					id,
					`https://kopje.test/ap/users/${name}`,
					name
				)
				sql.exec(
					"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'test')",
					id,
					`${name}@example.com`
				)
			}
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO accounts (id, uri, username, domain)
				SELECT CAST(?2 + i AS TEXT), 'https://far.example/users/v' || i, 'v' || i, 'far.example' FROM n`,
				votes,
				String(850000000000000000n)
			)
			for (let i = 0; i < 20; i++) {
				sql.exec(
					"INSERT INTO statuses (id, uri, account_id, visibility, published_at) VALUES (?, ?, ?, 'public', ?)",
					poll(i),
					`https://kopje.test/ap/o/poll${i}`,
					AUTHOR_ID,
					new Date(NOW - 60_000).toISOString()
				)
				sql.exec(
					`INSERT INTO polls (status_id, options, tallies, multiple, expires_at, votes_count, voters_count)
					VALUES (?, '["a","b","c","d"]', ?, 1, ?, ?, ?)`,
					poll(i),
					JSON.stringify([votes, 0, 0, 0]),
					new Date(NOW + 3_600_000).toISOString(),
					votes,
					votes
				)
				sql.exec(
					"INSERT INTO poll_votes (poll_id, account_id, choice) SELECT ?, id, 0 FROM accounts WHERE domain = 'far.example'",
					poll(i)
				)
			}
			sql.exec('INSERT INTO poll_votes (poll_id, account_id, choice) VALUES (?, ?, 1)', poll(0), VIEWER_ID)
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('polls', 'secret', 'polls', 'urn:ietf:wg:oauth:2.0:oob', 'read write')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'polls', ?, 'read write')",
				TOKEN,
				VIEWER_ID
			)
		})
		return store
	}

	it('reads the same rows with 10 or 1,000 votes in each poll of a page', async () => {
		const read = { tokenHash: TOKEN, scope: 'read', now: NOW } as const
		const page = {
			credential: read,
			now: NOW,
			account: AUTHOR_ID,
			page: PAGE,
			onlyMedia: false,
			excludeReplies: false,
			excludeReblogs: false,
			pinned: false,
			tagged: null,
			present: PRESENT,
		}
		const show = { credential: read, id: poll(0), now: NOW }
		const cast = { credential: { ...read, scope: 'write' as const }, id: poll(0), choices: ['2'], now: NOW }
		const measured: number[][] = []
		for (const store of [await polled(10), await polled(1000)]) {
			const output = await runInDurableObject(store, (_instance, state) => accountStatuses.run(state.storage.sql, page))
			expect(output).toMatchObject({ status: 'ok' })
			const items = output.status === 'ok' ? (output.value?.items ?? []) : []
			expect(items.map((status) => status.poll?.own_votes)).toEqual([...Array.from({ length: 19 }, () => []), [1]])
			measured.push([
				await rowsRead({ store }, accountStatuses, page),
				await rowsRead({ store }, getPoll, show),
				await rowsTouched(store, vote, cast),
			])
		}
		const [few = [], many = []] = measured
		const grown = ['page', 'poll', 'vote'].flatMap((name, k) =>
			(many[k] ?? Infinity) <= (few[k] ?? 0) + ALLOWANCE ? [] : [`${name}: ${few[k]} -> ${many[k]}`]
		)
		expect(grown).toEqual([])
	}, 60_000)
})

// Home reads a window of each followed hashtag's public statuses (R9): a page per hashtag, however many statuses
// carry it, and the followed hashtags are capped (MAX_FOLLOWED_TAGS).
describe('followed hashtags cost home a window each, up to the cap, not their history (RES-7)', () => {
	const VIEWER_ID = '810000000000000001'
	const AUTHOR_ID = '810000000000000002'
	const TAGS_TOKEN = 'tags-token'
	// Statuses interleave the hashtags, so each hashtag has statuses on every page.
	const status = (tag: number, i: number) => String(820000000000000000n + BigInt(i * 1000 + tag))

	async function store(perTag: number, followed: number): Promise<StoreStub> {
		const stub = await migratedStore()
		await runInDurableObject(stub, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(
				"INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/viewer', 'viewer')",
				VIEWER_ID
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'viewer@example.com', X'00', X'00', 'test')",
				VIEWER_ID
			)
			sql.exec(
				"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://far.example/users/a', 'a', 'far.example')",
				AUTHOR_ID
			)
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('tags', 'secret', 'tags', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'tags', ?, 'read')",
				TAGS_TOKEN,
				VIEWER_ID
			)
			for (let tag = 0; tag < MAX_FOLLOWED_TAGS; tag++) {
				if (tag < followed) {
					sql.exec('INSERT INTO tag_follows (account_id, name) VALUES (?, ?)', VIEWER_ID, `t${tag}`)
				}
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
					INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
					SELECT CAST(?2 + i * 1000 AS TEXT), 'https://far.example/objects/' || ?3 || '-' || i, ?4, 'public', '<p>tagged</p>', ?5
					FROM n`,
					perTag,
					status(tag, 0),
					tag,
					AUTHOR_ID,
					new Date(NOW).toISOString()
				)
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
					INSERT INTO status_tags (status_id, name, public) SELECT CAST(?2 + i * 1000 AS TEXT), ?3, 1 FROM n`,
					perTag,
					status(tag, 0),
					`t${tag}`
				)
			}
		})
		return stub
	}

	const credential = { tokenHash: TAGS_TOKEN, scope: 'read', now: NOW } as const
	const pages: [string, PageQuery][] = [
		['newest', PAGE],
		['oldest', { ...PAGE, minId: '1' }],
	]

	async function measure(perTag: number, followed: number): Promise<Record<string, number>> {
		const stub = await store(perTag, followed)
		const rows: Record<string, number> = {}
		for (const [name, page] of pages) {
			const input = { credential, page, present: PRESENT }
			const output = await runInDurableObject(stub, (_instance, state) =>
				homeTimeline.run(state.storage.sql, input as never)
			)
			expect([name, shown(output)]).toEqual([name, followed === 0 ? 0 : PAGE.limit])
			rows[name] = await rowsRead({ store: stub }, homeTimeline, input as never)
		}
		return rows
	}

	it(`reads the same rows with 40 or 400 statuses per hashtag at the cap, and at most a window per hashtag more than with none`, async () => {
		const none = await measure(40, 0)
		const few = await measure(40, MAX_FOLLOWED_TAGS)
		const many = await measure(400, MAX_FOLLOWED_TAGS)
		const grown: string[] = []
		for (const [name] of pages) {
			const [base = 0, capped = 0, longer = 0] = [none[name], few[name], many[name]]
			// Per hashtag: its tag_follows entry, and a stream of streamWindow(limit) candidates, each with its status_tags
			// entry, its status and the merge's reads of it (about six); the rule reads a window of them, once.
			if (capped > base + MAX_FOLLOWED_TAGS * (7 * streamWindow(PAGE.limit) + 10) + ALLOWANCE) {
				grown.push(`${name} with hashtags: ${base} -> ${capped}`)
			}
			if (longer > capped + ALLOWANCE) {
				grown.push(`${name} with history: ${capped} -> ${longer}`)
			}
		}
		expect(grown).toEqual([])
	}, 120_000)
})

// Home and the followed hashtags list read the viewer's own tag_follows rows through the (account_id, ...) indexes,
// however many accounts follow hashtags.
describe("followed hashtags read the viewer's rows, not every account's (RES-7)", () => {
	const VIEWER_ID = '830000000000000005'
	const AUTHOR_ID = '840000000000000001'
	const TAGS_TOKEN = 'followed-token'

	async function accountsFollowingTags(count: number): Promise<StoreStub> {
		const stub = await migratedStore()
		await runInDurableObject(stub, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO accounts (id, uri, username)
				SELECT CAST(830000000000000000 + i AS TEXT), 'https://kopje.test/ap/users/u' || i, 'u' || i FROM n`,
				count
			)
			sql.exec(
				`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
				SELECT id, username || '@example.com', X'00', X'00', 'test' FROM accounts`
			)
			for (const name of ['cats', 'dogs', 'birds']) {
				sql.exec('INSERT INTO tag_follows (account_id, name) SELECT account_id, ? FROM local_accounts', name)
			}
			sql.exec(
				"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://far.example/users/a', 'a', 'far.example')",
				AUTHOR_ID
			)
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 39)
				INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				SELECT CAST(850000000000000000 + i AS TEXT), 'https://far.example/objects/' || i, ?, 'public', '<p>cats</p>', ?
				FROM n`,
				AUTHOR_ID,
				new Date(NOW).toISOString()
			)
			sql.exec("INSERT INTO status_tags (status_id, name, public) SELECT id, 'cats', 1 FROM statuses")
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('followed', 'secret', 'followed', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'followed', ?, 'read')",
				TAGS_TOKEN,
				VIEWER_ID
			)
		})
		return stub
	}

	it('reads the same rows with 10 or 2,000 accounts that follow hashtags', async () => {
		const credential = { tokenHash: TAGS_TOKEN, scope: 'read', now: NOW } as const
		const reads: [string, StoreOperation<never, unknown>, unknown, number][] = [
			['home', homeTimeline, { credential, page: PAGE, present: PRESENT }, PAGE.limit],
			['followed tags', followedTags, { credential, page: PAGE, present: PRESENT }, 3],
		]
		const few = await accountsFollowingTags(10)
		const many = await accountsFollowingTags(2000)
		for (const [name, operation, input, expected] of reads) {
			for (const stub of [few, many]) {
				const output = await runInDurableObject(stub, (_instance, state) =>
					operation.run(state.storage.sql, input as never)
				)
				expect([name, shown(output)]).toEqual([name, expected])
			}
			const small = await rowsRead({ store: few }, operation, input as never)
			const large = await rowsRead({ store: many }, operation, input as never)
			expect(large, name).toBeLessThanOrEqual(small + ALLOWANCE)
		}
	}, 60_000)
})

// Media an edit drops stays with its status, not shown (migration 0015_media_shown), up to four per edit. What a status
// shows is sought in the index media_attachments_status past what it no longer shows, so the reads of a status and of
// the media-only feeds do not grow with the media its edits dropped.
describe('statuses cost the media they show, not the media their edits dropped (RES-7)', () => {
	const AUTHOR_ID = '690000000000000001'
	const MEDIA_TOKEN = 'media-token'
	const status = (i: number) => String(691000000000000000n + BigInt(i))
	const media = (i: number, m: number) => String(692000000000000000n + BigInt(i * 1000 + m))
	const STATUSES = 25

	async function store(dropped: number): Promise<StoreStub> {
		const stub = await migratedStore()
		await runInDurableObject(stub, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(
				"INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/author', 'author')",
				AUTHOR_ID
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'author@example.com', X'00', X'00', 'test')",
				AUTHOR_ID
			)
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('media', 'secret', 'media', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'media', ?, 'read')",
				MEDIA_TOKEN,
				AUTHOR_ID
			)
			for (let i = 0; i < STATUSES; i++) {
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
					VALUES (?, ?, ?, 'public', '<p>hello</p>', ?)`,
					status(i),
					`https://kopje.test/objects/${status(i)}`,
					AUTHOR_ID,
					new Date(NOW).toISOString()
				)
				// The status shows one image; its edits dropped the others, the oldest first.
				for (let m = 0; m <= dropped; m++) {
					sql.exec(
						`INSERT INTO media_attachments (id, account_id, status_id, position, type, url, shown)
						VALUES (?, ?, ?, 0, 'image', ?, ?)`,
						media(i, m),
						AUTHOR_ID,
						status(i),
						`https://kopje.test/media/${media(i, m)}/full.png`,
						m === dropped ? 1 : 0
					)
				}
			}
		})
		return stub
	}

	it('reads the same rows with 4 or 396 media dropped per status', async () => {
		const credential = { tokenHash: MEDIA_TOKEN, scope: 'read', now: NOW } as const
		const reads: [string, StoreOperation<never, unknown>, unknown][] = [
			['status', getStatus, { credential, id: status(STATUSES - 1), present: PRESENT }],
			[
				'public, only media',
				publicTimeline,
				{ credential, now: NOW, page: PAGE, local: false, remote: false, onlyMedia: true, present: PRESENT },
			],
			[
				'account statuses, only media',
				accountStatuses,
				{
					credential,
					now: NOW,
					account: AUTHOR_ID,
					page: PAGE,
					onlyMedia: true,
					excludeReplies: false,
					excludeReblogs: false,
					pinned: false,
					tagged: null,
					present: PRESENT,
				},
			],
		]
		const [few, many] = [await store(4), await store(396)]
		const grown: string[] = []
		for (const [name, operation, input] of reads) {
			const output = await runInDurableObject(many, (_instance, state) =>
				operation.run(state.storage.sql, input as never)
			)
			// The newest status shows its one image, and none it dropped.
			expect(JSON.stringify(output)).toContain(media(STATUSES - 1, 396))
			expect(JSON.stringify(output)).not.toContain(media(STATUSES - 1, 395))
			const counts = [
				await rowsRead({ store: few }, operation, input as never),
				await rowsRead({ store: many }, operation, input as never),
			]
			if ((counts[1] ?? Infinity) > (counts[0] ?? 0) + ALLOWANCE) {
				grown.push(`${name}: ${counts[0]} -> ${counts[1]}`)
			}
		}
		expect(grown).toEqual([])
	}, 60_000)
})

// Pins (R31) are at most PIN_LIMIT per account; conversation mutes add a dimension: the conversations one account
// mutes. A status's `muted` and notify's check look the mute up by owner and thread, so presenting the viewer's
// statuses and notifying the viewer read the same rows whether they mute 20 conversations or 2,000.
describe('conversation mutes cost a lookup, however many an account has (RES-7)', () => {
	const VIEWER_ID = '650000000000000000'
	const OTHER_ID = '650000000000000001'
	const TOKENS = { viewer: 'muting-viewer', other: 'muting-other' }
	const status = (i: number) => String(651000000000000000n + BigInt(i))

	async function muting(count: number): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			for (const [id, name] of [
				[VIEWER_ID, 'viewer'],
				[OTHER_ID, 'other'],
			] as const) {
				sql.exec(
					'INSERT INTO accounts (id, uri, username) VALUES (?, ?, ?)',
					id,
					`https://kopje.test/ap/users/${name}`,
					name
				)
				sql.exec(
					"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'test')",
					id,
					`${name}@example.com`
				)
			}
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 19)
				INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				SELECT CAST(?1 + i AS TEXT), 'https://kopje.test/ap/o/m' || i, ?2, 'public', '<p>m</p>', ?3 FROM n`,
				status(0),
				VIEWER_ID,
				new Date(NOW).toISOString()
			)
			// Half of the viewer's statuses are in muted conversations; the other mutes name threads elsewhere.
			sql.exec(
				`INSERT INTO conversation_mutes (account_id, thread)
				SELECT ?1, thread FROM statuses WHERE CAST(id AS INTEGER) % 2 = 0`,
				VIEWER_ID
			)
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?2 - 11)
				INSERT INTO conversation_mutes (account_id, thread) SELECT ?1, 'https://far.example/objects/' || i FROM n`,
				VIEWER_ID,
				count
			)
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('muting', 'secret', 'muting', 'urn:ietf:wg:oauth:2.0:oob', 'read write')"
			)
			for (const [token, id] of [
				[TOKENS.viewer, VIEWER_ID],
				[TOKENS.other, OTHER_ID],
			] as const) {
				sql.exec(
					"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'muting', ?, 'read write')",
					token,
					id
				)
			}
		})
		return store
	}

	it('reads the same rows with 20 or 2,000 muted conversations', async () => {
		const few = await muting(20)
		const many = await muting(2000)
		const read = { tokenHash: TOKENS.viewer, scope: 'read', now: NOW } as const
		const byId = { credential: read, now: NOW, ids: Array.from({ length: 20 }, (_, i) => status(i)), present: PRESENT }
		const muted = async (store: StoreStub) =>
			runInDurableObject(store, (_instance, state) => {
				const output = getStatuses.run(state.storage.sql, byId) as { status: string; value: { muted?: boolean }[] }
				return output.value.filter((s) => s.muted === true).length
			})
		expect([await muted(few), await muted(many)]).toEqual([10, 10])
		const fewRows = await rowsRead({ store: few }, getStatuses, byId)
		expect(await rowsRead({ store: many }, getStatuses, byId)).toBeLessThanOrEqual(fewRows + ALLOWANCE)
		// A favourite of a status in a muted conversation, and of one elsewhere, notifies through notifiedSql.
		for (const target of [status(0), status(1)]) {
			const input = {
				credential: { tokenHash: TOKENS.other, scope: 'write:favourites', now: NOW } as const,
				id: target,
				now: NOW,
				present: PRESENT,
			}
			const rows = [await rowsTouched(few, favourite, input), await rowsTouched(many, favourite, input)]
			expect(rows[1]).toBeLessThanOrEqual(rows[0]! + ALLOWANCE)
		}
		const notified = async (store: StoreStub) =>
			(
				await runInDurableObject(store, (_instance, state) =>
					state.storage.sql.exec<{ status_id: string }>('SELECT status_id FROM notifications').toArray()
				)
			).map((n) => n.status_id)
		expect([await notified(few), await notified(many)]).toEqual([[status(1)], [status(1)]])
	}, 60_000)
})

// The object endpoint, the outbox and the featured collection serve a public status's Note (or its Create), which
// names its audience but not the remote accounts that boosted it: each reads the same rows whether 20 remote accounts
// boosted the status or 2,000.
describe('served Notes read their statuses, not their boosts (RES-7)', () => {
	const OWNER = '660000000000000000'
	const PINNED = '661000000000000000'
	const booster = (i: number) => String(662000000000000000n + BigInt(i))

	async function boosted(count: number): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(
				"INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/owner', 'owner')",
				OWNER
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'owner@example.com', X'00', X'00', 'test')",
				OWNER
			)
			sql.exec(
				`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				VALUES (?, 'https://kopje.test/ap/o/pinned', ?, 'public', '<p>pinned</p>', ?)`,
				PINNED,
				OWNER,
				new Date(NOW).toISOString()
			)
			sql.exec('INSERT INTO status_pins (account_id, status_id) VALUES (?, ?)', OWNER, PINNED)
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO accounts (id, uri, username, domain)
				SELECT CAST(?2 + i AS TEXT), 'https://far' || (i % 10) || '.example/users/b' || i, 'b' || i,
					'far' || (i % 10) || '.example' FROM n`,
				count,
				booster(0)
			)
			sql.exec(
				`INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, content, published_at)
				SELECT CAST(CAST(id AS INTEGER) + 1000000 AS TEXT), uri || '/boost', id, ?1, 'public', '', ?2
				FROM accounts WHERE domain IS NOT NULL`,
				PINNED,
				new Date(NOW).toISOString()
			)
		})
		return store
	}

	it('reads the same rows with 20 or 2,000 remote boosts of a public, pinned status', async () => {
		const few = await boosted(20)
		const many = await boosted(2000)
		const reads: [string, StoreOperation<never, unknown>, unknown][] = [
			['featured', getFeatured, { username: 'owner' }],
			['object', getLocalNote, { uri: 'https://kopje.test/ap/o/pinned' }],
			['outbox', getOutbox, { username: 'owner', before: '~' }],
		]
		const grown: string[] = []
		for (const [name, operation, input] of reads) {
			const served = (store: StoreStub) =>
				runInDurableObject(store, (_instance, state) => operation.run(state.storage.sql, input as never))
			const output = await served(few)
			expect([name, output]).not.toEqual([name, null])
			expect(JSON.stringify(output)).toContain('<p>pinned</p>')
			expect([name, await served(many)]).toEqual([name, output])
			const fewRows = await rowsRead({ store: few }, operation, input as never)
			const manyRows = await rowsRead({ store: many }, operation, input as never)
			if (manyRows > fewRows + ALLOWANCE) {
				grown.push(`${name}: ${fewRows} -> ${manyRows}`)
			}
		}
		expect(grown).toEqual([])
	})
})

// Grouped notifications add a dimension: the notifications of one group. A status favourited by `count` accounts
// within the hours of one group, between older follows and newer follow requests: a page of groups, a group, its
// accounts and the unread counts read the same rows with 2,500 favourites or 5,000 (one group dominating the walk,
// past its limit), since a walk reads at most GROUP_WALK notifications, a group counts at most GROUP_COUNT and a
// group's accounts are paged by its index.
describe('grouped notifications read a walk, however many notifications a group holds (RES-7)', () => {
	const VIEWER_ID = '650000000000000000'
	const STATUS_ID = '651000000000000000'
	const GROUP_TOKEN = 'grouping-token'
	const sender = (i: number) => String(652000000000000000n + BigInt(i))
	const FAVOURITES = `favourite-${STATUS_ID}-1`
	// The follows and follow requests around the group, and the first favourite's id.
	const FOLLOWS = 50
	const REQUESTS = 5
	const FIRST_FAVOURITE = FOLLOWS + 1

	async function grouping(count: number): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(
				"INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/viewer', 'viewer')",
				VIEWER_ID
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'viewer@example.com', X'00', X'00', 'test')",
				VIEWER_ID
			)
			sql.exec(
				`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				VALUES (?, 'https://kopje.test/ap/o/s', ?, 'public', '<p>s</p>', ?)`,
				STATUS_ID,
				VIEWER_ID,
				new Date(NOW).toISOString()
			)
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO accounts (id, uri, username, domain)
				SELECT CAST(?2 + i AS TEXT), 'https://far' || (i % 10) || '.example/users/u' || i, 'u' || i,
					'far' || (i % 10) || '.example'
				FROM n`,
				count,
				sender(0)
			)
			const notifications = (type: string, limit: number, groupKey: string | null) =>
				sql.exec(
					`INSERT INTO notifications (account_id, type, from_account_id, status_id, group_key)
					SELECT ?1, ?2, id, CASE WHEN ?2 = 'favourite' THEN ?3 END, ?4 FROM accounts
					WHERE id <> ?1 ORDER BY id LIMIT ?5`,
					VIEWER_ID,
					type,
					STATUS_ID,
					groupKey,
					limit
				)
			notifications('follow', FOLLOWS, null)
			notifications('favourite', count, FAVOURITES)
			notifications('follow_request', REQUESTS, null)
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('grouping', 'secret', 'grouping', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'grouping', ?, 'read')",
				GROUP_TOKEN,
				VIEWER_ID
			)
		})
		return store
	}

	it('reads the same rows with 2,500 or 5,000 notifications in a group, on the newest, a middle and the oldest page', async () => {
		// Both sizes are past the walk's limit, so the group dominates it at either.
		expect(GROUP_WALK).toBeLessThan(2500)
		const few = await grouping(2500)
		const many = await grouping(5000)
		const credential = { tokenHash: GROUP_TOKEN, scope: 'read', now: NOW } as const
		const groups = {
			credential,
			types: [],
			excludeTypes: [],
			groupedTypes: null,
			expandAccounts: 'full',
			present: PRESENT,
		}
		const counts = { credential, limit: 100, types: [], excludeTypes: [], accountId: null, groupedTypes: null }
		// The newest page; a page from the middle of the group (the same favourites at either size); the page above the
		// follows, oldest first into the group (the accounts, which page by max_id alone: the group's oldest page).
		const middle = { ...PAGE, maxId: String(FIRST_FAVOURITE + 450) }
		const reads: [string, StoreOperation<never, unknown>, unknown][] = [
			...[PAGE, middle, { ...PAGE, minId: String(FOLLOWS) }].map(
				(page): [string, StoreOperation<never, unknown>, unknown] => [
					`grouped notifications ${JSON.stringify(page)}`,
					listGroupedNotifications,
					{ ...groups, page },
				]
			),
			...[PAGE, middle, { ...PAGE, maxId: String(FIRST_FAVOURITE + PAGE.limit) }].map(
				(page): [string, StoreOperation<never, unknown>, unknown] => [
					`notification group accounts ${JSON.stringify(page)}`,
					notificationGroupAccounts,
					{ credential, groupKey: FAVOURITES, page, present: PRESENT },
				]
			),
			['notification group', getNotificationGroup, { credential, groupKey: FAVOURITES, present: PRESENT }],
			['unread count', unreadCount, counts],
			['unread group count', unreadGroupCount, counts],
		]
		const grown: string[] = []
		for (const [name, operation, input] of reads) {
			// Each shows as much at either size (the newest notifications differ by size).
			const shownBy = async (store: StoreStub) =>
				runInDurableObject(store, (_instance, state) => shown(operation.run(state.storage.sql, input as never)))
			const fewShown = await shownBy(few)
			expect([name, fewShown > 0]).toEqual([name, true])
			expect([name, await shownBy(many)]).toEqual([name, fewShown])
			const fewRows = await rowsRead({ store: few }, operation, input as never)
			const manyRows = await rowsRead({ store: many }, operation, input as never)
			if (manyRows > fewRows + ALLOWANCE) {
				grown.push(`${name}: ${fewRows} -> ${manyRows}`)
			}
		}
		expect(grown).toEqual([])
		// The newest page reads the follow requests and the group up to the walk's limit, at either size.
		for (const store of [few, many]) {
			const newest = await runInDurableObject(store, (_instance, state) =>
				listGroupedNotifications.run(state.storage.sql, { ...groups, page: PAGE } as never)
			)
			expect(
				(
					newest as { value: { notification_groups: { type: string; notifications_count: number }[] } }
				).value.notification_groups.map((group) => [group.type, group.notifications_count])
			).toEqual([...Array.from({ length: REQUESTS }, () => ['follow_request', 1]), ['favourite', GROUP_COUNT]])
		}
	}, 120_000)
})

// A followed hashtag whose newest statuses are a blocked author's: home inspects a bounded number of the hashtag's
// statuses (two pages, at least 40), so the blocked author's tagged history costs nothing more as it grows.
describe("a followed hashtag's hidden statuses cost home a bounded window (RES-7)", () => {
	const VIEWER_ID = '860000000000000001'
	const BLOCKED_ID = '860000000000000002'
	const AUTHOR_ID = '860000000000000003'
	const HIDDEN_TOKEN = 'hidden-token'

	async function store(hidden: number): Promise<StoreStub> {
		const stub = await migratedStore()
		await runInDurableObject(stub, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(
				"INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/viewer', 'viewer')",
				VIEWER_ID
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'viewer@example.com', X'00', X'00', 'test')",
				VIEWER_ID
			)
			for (const [id, name] of [
				[BLOCKED_ID, 'spam'],
				[AUTHOR_ID, 'a'],
			]) {
				sql.exec(
					"INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, ?, 'far.example')",
					id,
					`https://far.example/users/${name}`,
					name
				)
			}
			sql.exec('INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)', VIEWER_ID, BLOCKED_ID)
			sql.exec("INSERT INTO tag_follows (account_id, name) VALUES (?, 'cats')", VIEWER_ID)
			// 40 shown statuses of the hashtag, older than the blocked author's.
			const write = (base: bigint, count: number, author: string) => {
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
					INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
					SELECT CAST(?2 + i AS TEXT), 'https://far.example/objects/' || ?2 || '-' || i, ?3, 'public', '<p>cats</p>', ?4
					FROM n`,
					count,
					String(base),
					author,
					new Date(NOW).toISOString()
				)
				sql.exec(
					`INSERT INTO status_tags (status_id, name, public) SELECT id, 'cats', 1 FROM statuses WHERE account_id = ?`,
					author
				)
			}
			write(870000000000000000n, 40, AUTHOR_ID)
			write(880000000000000000n, hidden, BLOCKED_ID)
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('hidden', 'secret', 'hidden', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'hidden', ?, 'read')",
				HIDDEN_TOKEN,
				VIEWER_ID
			)
		})
		return stub
	}

	it('reads the same rows with 100 or 2,000 newer statuses of a blocked author with the hashtag', async () => {
		const credential = { tokenHash: HIDDEN_TOKEN, scope: 'read', now: NOW } as const
		const input = { credential, page: PAGE, present: PRESENT }
		const measure = async (hidden: number) => {
			const stub = await store(hidden)
			const output = await runInDurableObject(stub, (_instance, state) =>
				homeTimeline.run(state.storage.sql, input as never)
			)
			return { shown: shown(output), rows: await rowsRead({ store: stub }, homeTimeline, input as never) }
		}
		// With fewer hidden statuses than the window inspects, the shown ones below them fill the page.
		expect((await measure(20)).shown).toBe(PAGE.limit)
		const few = await measure(100)
		const many = await measure(2000)
		expect(many.shown).toBe(few.shown)
		expect(many.rows).toBeLessThanOrEqual(few.rows + ALLOWANCE)
	}, 60_000)
})

// Filtered notifications add a dimension others control: a sender the viewer's policy filters writes as many as it
// likes. Between the viewer's older follows and newer follow requests, `count` filtered mentions, each from a sender
// of its own with a request (many senders) or all from one sender with one request (one sender): the lists, the
// grouped list, both unread counts, the requests, a request, the policy's summary and `merged` read the same rows with
// 2,500 or 5,000 of them, since the reads that leave filtered notifications out read the partial index of the
// unfiltered ones (notifications_unfiltered), the requests are paged by their index and the summary reads at most 100;
// answering a request walks at most REQUEST_JOB_BATCHES windows of the sender's notifications in the request.
describe('filtered notifications and requests cost a read nothing (RES-7)', () => {
	const VIEWER_ID = '660000000000000000'
	const STATUS_BASE = 661000000000000000n
	const SENDER_BASE = 662000000000000000n
	const FILTER_TOKEN = 'filtered-token'
	const FOLLOWS = 50
	const REQUESTS = 5

	async function filtering(count: number, senders: 'many' | 'one'): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(
				"INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/viewer', 'viewer')",
				VIEWER_ID
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'viewer@example.com', X'00', X'00', 'test')",
				VIEWER_ID
			)
			const accounts = senders === 'many' ? count : 1
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO accounts (id, uri, username, domain)
				SELECT CAST(?2 + i AS TEXT), 'https://far' || (i % 10) || '.example/users/u' || i, 'u' || i,
					'far' || (i % 10) || '.example'
				FROM n`,
				Math.max(accounts, FOLLOWS + REQUESTS),
				String(SENDER_BASE)
			)
			// The direct statuses of the filtered mentions, each mentioning the viewer.
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				SELECT CAST(?2 + i AS TEXT), 'https://far.example/objects/' || i,
					CAST(?3 + CASE WHEN ?4 THEN i ELSE 0 END AS TEXT), 'direct', '<p>hi</p>', ?5
				FROM n`,
				count,
				String(STATUS_BASE),
				String(SENDER_BASE),
				senders === 'many' ? 1 : 0,
				new Date(NOW).toISOString()
			)
			sql.exec(
				"INSERT INTO status_mentions (status_id, account_id) SELECT id, ? FROM statuses WHERE visibility = 'direct'",
				VIEWER_ID
			)
			sql.exec(
				`INSERT INTO notifications (account_id, type, from_account_id) SELECT ?1, 'follow', id FROM accounts
				WHERE id <> ?1 ORDER BY id LIMIT ?2`,
				VIEWER_ID,
				FOLLOWS
			)
			sql.exec(
				`INSERT INTO notifications (account_id, type, from_account_id, status_id, filtered)
				SELECT ?, 'mention', account_id, id, 1 FROM statuses WHERE visibility = 'direct' ORDER BY id`,
				VIEWER_ID
			)
			sql.exec(
				`INSERT INTO notification_requests (account_id, from_account_id, last_status_id, notifications_count)
				SELECT ?1, account_id, max(id), min(count(*), 100) FROM statuses WHERE visibility = 'direct'
				GROUP BY account_id ORDER BY account_id`,
				VIEWER_ID
			)
			sql.exec(
				`INSERT INTO notifications (account_id, type, from_account_id) SELECT ?1, 'follow_request', id FROM accounts
				WHERE id <> ?1 ORDER BY id DESC LIMIT ?2`,
				VIEWER_ID,
				REQUESTS
			)
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('filtering', 'secret', 'filtering', 'urn:ietf:wg:oauth:2.0:oob', 'read write')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'filtering', ?, 'read write')",
				FILTER_TOKEN,
				VIEWER_ID
			)
		})
		return store
	}

	// The id of the viewer's newest request.
	const newestRequest = (store: StoreStub) =>
		runInDurableObject(
			store,
			(_instance, state) =>
				state.storage.sql.exec<{ id: number }>('SELECT max(id) AS id FROM notification_requests').one().id
		)

	// What a read showed: shown() for pages and counts; the summary for the policy, `merged` for its answer.
	const showing = (output: unknown): unknown => {
		const value = (output as { value: unknown }).value as Record<string, unknown>
		if ('summary' in value) {
			return value.summary
		}
		if ('merged' in value) {
			return value
		}
		if ('notifications_count' in value) {
			return value.notifications_count
		}
		return shown(output)
	}

	for (const senders of ['many', 'one'] as const) {
		it(`reads the same rows with 2,500 or 5,000 filtered mentions from ${senders === 'many' ? 'as many senders' : 'one sender'}`, async () => {
			const few = await filtering(2500, senders)
			const many = await filtering(5000, senders)
			const credential = { tokenHash: FILTER_TOKEN, scope: 'read', now: NOW } as const
			const list = {
				credential,
				types: [],
				excludeTypes: [],
				accountId: null,
				includeFiltered: false,
				present: PRESENT,
			}
			const groups = {
				credential,
				types: [],
				excludeTypes: [],
				groupedTypes: null,
				includeFiltered: false,
				expandAccounts: 'full',
				present: PRESENT,
			}
			const counts = {
				credential,
				limit: 100,
				types: [],
				excludeTypes: [],
				accountId: null,
				groupedTypes: null,
				includeFiltered: false,
			}
			// The newest page, and the page below the filtered mentions (the follows), by max_id at the first mention.
			const below = { ...PAGE, maxId: String(FOLLOWS + 1) }
			const reads: [string, StoreOperation<never, unknown>, (store: StoreStub) => Promise<unknown>][] = [
				...[PAGE, below].flatMap((page): [string, StoreOperation<never, unknown>, () => Promise<unknown>][] => [
					[`notifications ${JSON.stringify(page)}`, listNotifications, async () => ({ ...list, page })],
					[
						`grouped notifications ${JSON.stringify(page)}`,
						listGroupedNotifications,
						async () => ({ ...groups, page }),
					],
				]),
				['unread count', unreadCount, async () => counts],
				['unread group count', unreadGroupCount, async () => counts],
				['requests', listNotificationRequests, async () => ({ credential, page: PAGE, present: PRESENT })],
				[
					'request',
					getNotificationRequest,
					async (store) => ({ credential, id: String(await newestRequest(store)), present: PRESENT }),
				],
				['policy', getNotificationPolicy, async () => ({ credential })],
				['merged', notificationRequestsMerged, async () => ({ credential })],
			]
			const grown: string[] = []
			for (const [name, operation, inputOf] of reads) {
				const shownBy = async (store: StoreStub) => {
					const input = await inputOf(store)
					return runInDurableObject(store, (_instance, state) =>
						showing(operation.run(state.storage.sql, input as never))
					)
				}
				const fewShown = await shownBy(few)
				expect([name, fewShown !== 0]).toEqual([name, true])
				expect([name, await shownBy(many)]).toEqual([name, fewShown])
				const fewRows = await rowsRead({ store: few }, operation, (await inputOf(few)) as never)
				const manyRows = await rowsRead({ store: many }, operation, (await inputOf(many)) as never)
				if (manyRows > fewRows + ALLOWANCE) {
					grown.push(`${name}: ${fewRows} -> ${manyRows}`)
				}
			}
			// Answering the newest request, on a store of its own each: the request's batches, whatever the sender holds.
			const write = { credential: { tokenHash: FILTER_TOKEN, scope: 'write', now: NOW }, now: NOW }
			for (const [name, operation] of [
				['accept', acceptNotificationRequest],
				['dismiss', dismissNotificationRequest],
			] as const) {
				const rows = async (count: number) => {
					const store = await filtering(count, senders)
					return rowsRead({ store }, operation, { ...write, id: String(await newestRequest(store)) } as never)
				}
				const fewRows = await rows(2500)
				const manyRows = await rows(5000)
				if (manyRows > fewRows + ALLOWANCE) {
					grown.push(`${name}: ${fewRows} -> ${manyRows}`)
				}
			}
			expect(grown).toEqual([])
			// The viewer's lists show the follow requests and the follows alone.
			const newest = await runInDurableObject(few, (_instance, state) =>
				listNotifications.run(state.storage.sql, { ...list, page: { limit: 40 } })
			)
			expect(
				(newest as { value: { items: { type: string }[] } }).value.items
					.map((n) => n.type)
					.filter((t) => t === 'mention')
			).toEqual([])
		}, 240_000)
	}
})

// The work answered requests leave grows with how many senders are answered: `merged` and a round of the jobs read the
// same rows with 1,000 or 5,000 pending jobs, the viewer's and others'.
describe('pending request jobs cost merged and a round a bounded read (RES-7)', () => {
	const VIEWER_ID = '670000000000000000'
	const OTHER_ID = '670000000000000001'
	const SENDER_BASE = 671000000000000000n
	const JOB_TOKEN = 'jobs-token'

	async function backlog(count: number): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			for (const [id, name] of [
				[VIEWER_ID, 'viewer'],
				[OTHER_ID, 'other'],
			]) {
				sql.exec(
					'INSERT INTO accounts (id, uri, username) VALUES (?, ?, ?)',
					id,
					`https://kopje.test/ap/users/${name}`,
					name
				)
				sql.exec(
					"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'test')",
					id,
					`${name}@example.com`
				)
			}
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO accounts (id, uri, username, domain)
				SELECT CAST(?2 + i AS TEXT), 'https://far.example/users/j' || i, 'j' || i, 'far.example' FROM n`,
				count,
				String(SENDER_BASE)
			)
			// Each sender has notifications (to someone else) for a batch to walk.
			sql.exec(
				`INSERT INTO notifications (account_id, type, from_account_id)
				SELECT ?1, t.type, a.id FROM accounts a, (SELECT 'follow' AS type UNION ALL SELECT 'follow_request') t
				WHERE a.domain = 'far.example'`,
				OTHER_ID
			)
			sql.exec(
				`INSERT INTO notification_request_jobs (account_id, from_account_id, kind, cursor)
				SELECT CASE WHEN rowid % 2 = 0 THEN ?1 ELSE ?2 END, id, CASE WHEN rowid % 3 = 0 THEN 'accept' ELSE 'dismiss' END,
					(SELECT max(id) + 1 FROM notifications)
				FROM accounts WHERE domain = 'far.example'`,
				OTHER_ID,
				VIEWER_ID
			)
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('jobs', 'secret', 'jobs', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'jobs', ?, 'read')",
				JOB_TOKEN,
				VIEWER_ID
			)
		})
		return store
	}

	it('reads the same rows with 1,000 or 5,000 pending jobs', async () => {
		const few = await backlog(1000)
		const many = await backlog(5000)
		const credential = { tokenHash: JOB_TOKEN, scope: 'read', now: NOW } as const
		const grown: string[] = []
		for (const [name, operation, input] of [
			['merged', notificationRequestsMerged, { credential }],
			['round', runNotificationRequestJobs, { now: NOW }],
		] as [string, StoreOperation<never, unknown>, unknown][]) {
			const fewRows = await rowsRead({ store: few }, operation, input as never)
			const manyRows = await rowsRead({ store: many }, operation, input as never)
			if (manyRows > fewRows + ALLOWANCE) {
				grown.push(`${name}: ${fewRows} -> ${manyRows}`)
			}
		}
		expect(grown).toEqual([])
		const merged = await runInDurableObject(many, (_instance, state) =>
			notificationRequestsMerged.run(state.storage.sql, { credential })
		)
		expect(merged).toEqual({ status: 'ok', value: { merged: false } })
	}, 120_000)
})

// A request's last status is judged by the notification rule over that status alone: listing or showing the request
// reads the same rows with 1,000 or 5,000 statuses of other accounts the viewer may not see, stored before it.
describe("a request's last status costs a read nothing else (RES-7)", () => {
	const VIEWER_ID = '680000000000000000'
	const SENDER_ID = '680000000000000001'
	const OTHER_ID = '680000000000000002'
	const STATUS_BASE = 681000000000000000n
	const REQUEST_TOKEN = 'request-token'

	async function hidden(count: number): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(
				"INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/viewer', 'viewer')",
				VIEWER_ID
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'viewer@example.com', X'00', X'00', 'test')",
				VIEWER_ID
			)
			for (const [id, name] of [
				[SENDER_ID, 'sender'],
				[OTHER_ID, 'other'],
			]) {
				sql.exec(
					"INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, ?, 'far.example')",
					id,
					`https://far.example/users/${name}`,
					name
				)
			}
			// The other account's private statuses, which the viewer (no follower) may not see, stored first.
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				SELECT CAST(?2 + i AS TEXT), 'https://far.example/objects/p' || i, ?3, 'private', '<p>x</p>', ?4 FROM n`,
				count,
				String(STATUS_BASE),
				OTHER_ID,
				new Date(NOW).toISOString()
			)
			sql.exec(
				`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				VALUES ('689000000000000000', 'https://far.example/objects/dm', ?, 'direct', '<p>hi</p>', ?)`,
				SENDER_ID,
				new Date(NOW).toISOString()
			)
			sql.exec("INSERT INTO status_mentions (status_id, account_id) VALUES ('689000000000000000', ?)", VIEWER_ID)
			sql.exec(
				`INSERT INTO notifications (account_id, type, from_account_id, status_id, filtered)
				VALUES (?, 'mention', ?, '689000000000000000', 1)`,
				VIEWER_ID,
				SENDER_ID
			)
			sql.exec(
				`INSERT INTO notification_requests (account_id, from_account_id, last_status_id, notifications_count)
				VALUES (?, ?, '689000000000000000', 1)`,
				VIEWER_ID,
				SENDER_ID
			)
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('request', 'secret', 'request', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'request', ?, 'read')",
				REQUEST_TOKEN,
				VIEWER_ID
			)
		})
		return store
	}

	it('reads the same rows with 1,000 or 5,000 statuses the viewer may not see', async () => {
		const few = await hidden(1000)
		const many = await hidden(5000)
		const credential = { tokenHash: REQUEST_TOKEN, scope: 'read', now: NOW } as const
		const grown: string[] = []
		for (const [name, operation, input] of [
			['requests', listNotificationRequests, { credential, page: PAGE, present: PRESENT }],
			['request', getNotificationRequest, { credential, id: '1', present: PRESENT }],
		] as [string, StoreOperation<never, unknown>, unknown][]) {
			const shownBy = async (store: StoreStub) =>
				runInDurableObject(store, (_instance, state) => operation.run(state.storage.sql, input as never))
			const output = JSON.stringify(await shownBy(few))
			// The request shows its last status at either size.
			expect([name, output.includes('"last_status":{')]).toEqual([name, true])
			const fewRows = await rowsRead({ store: few }, operation, input as never)
			const manyRows = await rowsRead({ store: many }, operation, input as never)
			if (manyRows > fewRows + ALLOWANCE) {
				grown.push(`${name}: ${fewRows} -> ${manyRows}`)
			}
		}
		expect(grown).toEqual([])
	}, 120_000)
})

// The profile directory adds a dimension: the accounts the instance knows. A page reads a window of the partial index of
// discoverable accounts by its order, from the start, and judges each entry by key (R12: the viewer's blocks, mutes and
// domain blocks, and the entry's blocks of the viewer), so it reads the same rows whether the instance knows 20 or 2,000
// accounts of each kind it never lists first: accounts that are not discoverable (with the newest statuses), and
// discoverable ones with older statuses and older ids, available or not, that the viewer blocks, mutes or domain-blocks,
// that block the viewer, or that nothing hides. In front of them, 10 discoverable accounts the viewer is shown and 3 it
// is not, newer by status and by id. A last case grows the hidden accounts in front instead: the page reads its window
// and no further, so it shows nothing past it.
describe('the profile directory reads a window, however many accounts the instance knows (RES-7)', () => {
	const VIEWER_ID = '890000000000000000'
	const DIRECTORY_TOKEN = 'directory-token'
	const FRONT = 10
	const KINDS = ['undiscoverable', 'listed', 'blocked', 'muted', 'blocking', 'domain', 'suspended'] as const

	async function store(grown: number, hiddenInFront = 3): Promise<StoreStub> {
		const stub = await migratedStore()
		await runInDurableObject(stub, (_instance, state) => {
			const sql = state.storage.sql
			const account = (id: string, name: string, domain: string | null, discoverable: number | null) =>
				sql.exec(
					'INSERT INTO accounts (id, uri, username, domain, discoverable) VALUES (?, ?, ?, ?, ?)',
					id,
					domain === null ? `https://kopje.test/ap/users/${name}` : `https://${domain}/users/${name}`,
					name,
					domain,
					discoverable
				)
			const local = (id: string, suspended = false) =>
				sql.exec(
					`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey, suspended_at)
					VALUES (?, ?, X'00', X'00', 'test', ?)`,
					id,
					`${id}@example.com`,
					suspended ? '2026-01-01T00:00:00.000Z' : null
				)
			const status = (id: string, author: string) =>
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, visibility, published_at)
					VALUES (?, ?, ?, 'public', '2026-10-01T00:00:00.000Z')`,
					id,
					`https://kopje.test/o/${id}`,
					author
				)
			account(VIEWER_ID, 'viewer', null, 1)
			local(VIEWER_ID)
			sql.exec("INSERT INTO domain_blocks (account_id, domain) VALUES (?, 'blocked.example')", VIEWER_ID)
			// In front: FRONT shown accounts, local and remote, and the hidden ones, the newest by status and by id.
			for (let i = 0; i < FRONT + hiddenInFront; i++) {
				const id = String(880000000000000000n + BigInt(i))
				const hidden = i >= FRONT
				account(id, `front${i}`, i % 2 === 0 ? null : 'front.example', 1)
				if (i % 2 === 0) {
					local(id)
				}
				status(String(870000000000000000n + BigInt(i)), id)
				if (hidden) {
					sql.exec('INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)', VIEWER_ID, id)
				}
			}
			// The grown accounts, older by status and by id; those that are not discoverable post the newest statuses.
			KINDS.forEach((kind, k) => {
				for (let i = 0; i < grown; i++) {
					const id = String(300000000000000000n + BigInt(k * 100_000 + i))
					const isLocal = kind === 'suspended' || (kind === 'listed' && i % 2 === 0)
					const domain = isLocal ? null : kind === 'domain' ? 'blocked.example' : 'grown.example'
					account(id, `${kind}${i}`, domain, kind === 'undiscoverable' ? (i % 2 === 0 ? 0 : null) : 1)
					if (isLocal) {
						local(id, kind === 'suspended')
					}
					status(
						String((kind === 'undiscoverable' ? 990000000000000000n : 400000000000000000n) + BigInt(k * 100_000 + i)),
						id
					)
					if (kind === 'blocked') {
						sql.exec('INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)', VIEWER_ID, id)
					} else if (kind === 'muted') {
						sql.exec('INSERT INTO mutes (account_id, target_account_id) VALUES (?, ?)', VIEWER_ID, id)
					} else if (kind === 'blocking') {
						sql.exec('INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)', id, VIEWER_ID)
					}
				}
			})
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('directory', 'secret', 'directory', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'directory', ?, 'read')",
				DIRECTORY_TOKEN,
				VIEWER_ID
			)
		})
		return stub
	}

	const credential = { tokenHash: DIRECTORY_TOKEN, scope: 'read', now: NOW } as const
	const inputs = (['active', 'new'] as const).flatMap((order) =>
		[false, true].flatMap((local) =>
			[
				{ credential, now: NOW, order, local, offset: 0, limit: FRONT, present: PRESENT },
				{ credential: null, now: NOW, order, local, offset: 0, limit: FRONT, present: PRESENT },
			].map((input) => ({
				name: `${order}${local ? ' local' : ''}${input.credential === null ? ' anonymous' : ''}`,
				input,
			}))
		)
	)

	const measure = async (stub: StoreStub) => {
		const out: Record<string, { shown: string[]; rows: number }> = {}
		for (const { name, input } of inputs) {
			const accounts = await runInDurableObject(stub, (_instance, state) => directory.run(state.storage.sql, input))
			out[name] = {
				shown: (accounts.status === 'ok' ? accounts.value : []).map((account) => account.id),
				rows: await rowsRead({ store: stub }, directory, input),
			}
		}
		return out
	}

	it('reads the same rows with 20 or 2,000 accounts of each kind behind the page', async () => {
		const few = await measure(await store(20))
		const many = await measure(await store(2000))
		const grown: string[] = []
		for (const { name } of inputs) {
			const a = few[name]!
			const b = many[name]!
			// Not vacuous: the signed-in page is the shown accounts in front, the newest first.
			if (name === 'active') {
				expect(a.shown).toEqual(
					Array.from({ length: FRONT }, (_, i) => String(880000000000000000n + BigInt(FRONT - 1 - i)))
				)
			}
			expect(a.shown.length).toBeGreaterThan(0)
			expect(b.shown).toEqual(a.shown)
			if (b.rows > a.rows + ALLOWANCE) {
				grown.push(`${name}: ${a.rows} -> ${b.rows}`)
			}
		}
		expect(grown).toEqual([])
	}, 120_000)

	it('reads its window and no further, however many hidden accounts are in front', async () => {
		const window = DIRECTORY_WINDOW * FRONT
		const input = inputs.find(({ name }) => name === 'active')!.input
		const rowsWith = async (hidden: number) => {
			const stub = await store(20, hidden)
			const accounts = await runInDurableObject(stub, (_instance, state) => directory.run(state.storage.sql, input))
			return { shown: shown(accounts), rows: await rowsRead({ store: stub }, directory, input) }
		}
		// Half the window hidden: the shown accounts behind them fill the page.
		expect((await rowsWith(FRONT)).shown).toBe(FRONT)
		const few = await rowsWith(window)
		const many = await rowsWith(2000)
		expect(few.shown).toBe(0)
		expect(many.shown).toBe(0)
		expect(many.rows).toBeLessThanOrEqual(few.rows + ALLOWANCE)
	}, 120_000)
})

describe("a report reads its statuses by key, however long the account's history (RES-7)", () => {
	const VIEWER_ID = '690000000000000000'
	const TARGET_ID = '690000000000000001'
	const ACCOUNT_BASE = 692000000000000000n
	const STATUS_BASE = 691000000000000000n
	const REPORTED = '699000000000000000'
	const REPORT_TOKEN = 'report-token'

	// The reported account's history: `count` public statuses, each replying to an account of its own on the listed
	// domain, and as many earlier reports of it; the report names its newest status, a reply to one more account there.
	async function history(count: number): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec("INSERT INTO instance_settings (name, value) VALUES ('domain', 'kopje.test')")
			sql.exec(
				"INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/viewer', 'viewer')",
				VIEWER_ID
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'viewer@example.com', X'00', X'00', 'test')",
				VIEWER_ID
			)
			sql.exec(
				`INSERT INTO accounts (id, uri, username, domain, inbox_url, shared_inbox_url)
				VALUES (?, 'https://far.example/users/target', 'target', 'far.example', 'https://far.example/users/target/inbox',
					'https://far.example/inbox')`,
				TARGET_ID
			)
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO accounts (id, uri, username, domain, inbox_url)
				SELECT CAST(?2 + i AS TEXT), 'https://p' || i || '.example/users/p', 'p', 'p' || i || '.example',
					'https://p' || i || '.example/users/p/inbox' FROM n`,
				count,
				String(ACCOUNT_BASE)
			)
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO statuses (id, uri, account_id, in_reply_to_account_id, visibility, content, published_at)
				SELECT CAST(?2 + i AS TEXT), 'https://far.example/objects/s' || i, ?3, CAST(?4 + i AS TEXT), 'public',
					'<p>x</p>', ?5 FROM n`,
				count,
				String(STATUS_BASE),
				TARGET_ID,
				String(ACCOUNT_BASE),
				new Date(NOW).toISOString()
			)
			sql.exec(
				`INSERT INTO statuses (id, uri, account_id, in_reply_to_account_id, visibility, content, published_at)
				VALUES (?, 'https://far.example/objects/reported', ?, ?, 'public', '<p>x</p>', ?)`,
				REPORTED,
				TARGET_ID,
				String(ACCOUNT_BASE + BigInt(count)),
				new Date(NOW).toISOString()
			)
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO reports (account_id, target_account_id, status_ids, uri, created_at)
				SELECT ?2, ?3, json_array(CAST(?4 + i AS TEXT)), 'https://kopje.test/actor#reports/' || i, ?5 FROM n`,
				count,
				VIEWER_ID,
				TARGET_ID,
				String(STATUS_BASE),
				new Date(NOW).toISOString()
			)
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('report', 'secret', 'report', 'urn:ietf:wg:oauth:2.0:oob', 'write')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'report', ?, 'write')",
				REPORT_TOKEN,
				VIEWER_ID
			)
		})
		return store
	}

	it('reads the same rows with 20 or 2,000 statuses, replied-to accounts and reports of the account', async () => {
		const input = {
			credential: { tokenHash: REPORT_TOKEN, scope: 'write:reports', now: NOW } as const,
			account: TARGET_ID,
			statusIds: [REPORTED],
			comment: 'spam',
			category: undefined,
			ruleIds: [],
			forward: true,
			forwardToDomains: ['far.example', `p20.example`, 'p2000.example'],
			present: PRESENT,
			now: NOW,
		}
		const few = await history(20)
		const many = await history(2000)
		// Each forwards the report to the account's server and the one its reported status replies to.
		for (const [store, partner] of [
			[few, 'p20.example'],
			[many, 'p2000.example'],
		] as const) {
			const answer = await runInDurableObject(store, (_instance, state) => createReport.run(state.storage.sql, input))
			expect(answer).toMatchObject({ status: 'ok', value: { status: 'ok', report: { forwarded: true } } })
			const inboxes = await runInDurableObject(store, (_instance, state) =>
				state.storage.sql.exec<{ inbox_url: string }>('SELECT inbox_url FROM deliveries ORDER BY inbox_url').toArray()
			)
			expect(inboxes.map((row) => row.inbox_url)).toEqual([
				'https://far.example/inbox',
				`https://${partner}/users/p/inbox`,
			])
		}
		const fewRows = await rowsRead({ store: few }, createReport, input)
		const manyRows = await rowsRead({ store: many }, createReport, input)
		expect(manyRows).toBeLessThanOrEqual(fewRows + ALLOWANCE)
	}, 120_000)
})

// Clearing notifications and dismissing a group (R15's clears and dismissals) hide any number of notifications at once
// and delete them in bounded batches: the request and each round of the jobs touch the same rows with 2,500 or 5,000
// notifications to remove, and until the rounds are done, a read starts above what a clear hides (the lists, the
// grouped notifications, the unread counts) or above what a group's dismissal hides (the group's own reads), so it
// reads the same rows however many are hidden.
describe('clearing and dismissing touch a bounded batch, and reads skip what they hide (RES-7)', () => {
	const VIEWER_ID = '690000000000000000'
	const STATUS_ID = '691000000000000000'
	const SENDER_BASE = 692000000000000000n
	const CLEAR_TOKEN = 'clear-token'
	const FAVOURITES = `favourite-${STATUS_ID}-1`
	// The follows and follow requests newer than the favourites, shown above them.
	const FOLLOWS = 50
	const REQUESTS = 5
	const credential = (scope: string) => ({ tokenHash: CLEAR_TOKEN, scope, now: NOW }) as const
	// What a request removes at most.
	const IN_REQUEST = REMOVAL_WINDOW * REMOVAL_BATCHES

	// The viewer's status favourited `count` times in one group, then FOLLOWS follows and REQUESTS follow requests;
	// with `removal`, the favourites hidden as a clear or the group's dismissal records them, none deleted yet.
	async function removing(count: number, removal: 'clear' | 'dismissal' | null): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(
				"INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/viewer', 'viewer')",
				VIEWER_ID
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'viewer@example.com', X'00', X'00', 'test')",
				VIEWER_ID
			)
			sql.exec(
				`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				VALUES (?, 'https://kopje.test/ap/o/s', ?, 'public', '<p>s</p>', ?)`,
				STATUS_ID,
				VIEWER_ID,
				new Date(NOW).toISOString()
			)
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO accounts (id, uri, username, domain)
				SELECT CAST(?2 + i AS TEXT), 'https://far' || (i % 10) || '.example/users/u' || i, 'u' || i,
					'far' || (i % 10) || '.example'
				FROM n`,
				count,
				String(SENDER_BASE)
			)
			sql.exec(
				`INSERT INTO notifications (account_id, type, from_account_id, status_id, group_key)
				SELECT ?1, 'favourite', id, ?2, ?3 FROM accounts WHERE id <> ?1 ORDER BY id`,
				VIEWER_ID,
				STATUS_ID,
				FAVOURITES
			)
			if (removal === 'clear') {
				sql.exec('INSERT INTO notification_clears (account_id, max_id) SELECT ?, max(id) FROM notifications', VIEWER_ID)
			} else if (removal === 'dismissal') {
				sql.exec(
					'INSERT INTO notification_dismissals (account_id, group_key, max_id) SELECT ?, ?, max(id) FROM notifications',
					VIEWER_ID,
					FAVOURITES
				)
			}
			sql.exec(
				`INSERT INTO notifications (account_id, type, from_account_id, group_key)
				SELECT ?1, 'follow', id, 'follow-1' FROM accounts WHERE id <> ?1 ORDER BY id LIMIT ?2`,
				VIEWER_ID,
				FOLLOWS
			)
			sql.exec(
				`INSERT INTO notifications (account_id, type, from_account_id) SELECT ?1, 'follow_request', id FROM accounts
				WHERE id <> ?1 ORDER BY id DESC LIMIT ?2`,
				VIEWER_ID,
				REQUESTS
			)
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('clearing', 'secret', 'clearing', 'urn:ietf:wg:oauth:2.0:oob', 'read write')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'clearing', ?, 'read write')",
				CLEAR_TOKEN,
				VIEWER_ID
			)
		})
		return store
	}

	const pendingIn = (store: StoreStub) =>
		runInDurableObject(store, (_instance, state) =>
			state.storage.sql
				.exec<{ n: number }>(
					'SELECT (SELECT count(*) FROM notification_clears) + (SELECT count(*) FROM notification_dismissals) AS n'
				)
				.one()
		)
	const stored = (store: StoreStub) =>
		runInDurableObject(
			store,
			(_instance, state) => state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM notifications').one().n
		)

	it('touches the same rows in the request and in a round with 2,500 or 5,000 notifications to remove', async () => {
		const grown: string[] = []
		for (const [name, operation, input] of [
			['clear', clearNotifications, { credential: credential('write') }],
			['dismiss', dismissNotificationGroup, { credential: credential('write'), groupKey: FAVOURITES }],
		] as [string, StoreOperation<never, unknown>, unknown][]) {
			const touched = async (count: number) => {
				const store = await removing(count, null)
				const rows = await rowsTouched(store, operation, input as never)
				// Not vacuous: the request removed its batches and left the rest for the rounds.
				expect([name, count, await stored(store), await pendingIn(store)]).toEqual([
					name,
					count,
					count + FOLLOWS + REQUESTS - IN_REQUEST,
					{ n: 1 },
				])
				return rows
			}
			const fewRows = await touched(2500)
			const manyRows = await touched(5000)
			if (manyRows > fewRows + ALLOWANCE) {
				grown.push(`${name}: ${fewRows} -> ${manyRows}`)
			}
		}
		for (const removal of ['clear', 'dismissal'] as const) {
			const round = async (count: number) => {
				const store = await removing(count, removal)
				const rows = await rowsTouched(store, runNotificationRequestJobs, { now: NOW })
				expect([removal, count, await stored(store)]).toEqual([removal, count, count + FOLLOWS + REQUESTS - IN_REQUEST])
				return rows
			}
			const fewRows = await round(2500)
			const manyRows = await round(5000)
			if (manyRows > fewRows + ALLOWANCE) {
				grown.push(`${removal} round: ${fewRows} -> ${manyRows}`)
			}
		}
		expect(grown).toEqual([])
	}, 240_000)

	it('reads the same rows with 2,500 or 5,000 notifications hidden and not yet deleted', async () => {
		const read = credential('read')
		const list = {
			credential: read,
			types: [],
			excludeTypes: [],
			accountId: null,
			includeFiltered: false,
			present: PRESENT,
		}
		const groups = {
			credential: read,
			types: [],
			excludeTypes: [],
			groupedTypes: null,
			includeFiltered: false,
			expandAccounts: 'full',
			present: PRESENT,
		}
		const counts = {
			credential: read,
			limit: 100,
			types: [],
			excludeTypes: [],
			accountId: null,
			groupedTypes: null,
			includeFiltered: false,
		}
		// The newest page, and pages reaching down into what is hidden: below the follows by max_id, and above it by
		// min_id; the unread counts walk up from the oldest (no marker).
		const below = { ...PAGE, maxId: String(1e9) }
		const reads = (count: number): [string, StoreOperation<never, unknown>, unknown][] => {
			const firstFollow = String(count + 1)
			return [
				...[PAGE, { ...PAGE, maxId: firstFollow }, { ...PAGE, minId: '0' }].flatMap(
					(page): [string, StoreOperation<never, unknown>, unknown][] => [
						[`notifications ${JSON.stringify(page)}`, listNotifications, { ...list, page }],
						[`grouped notifications ${JSON.stringify(page)}`, listGroupedNotifications, { ...groups, page }],
					]
				),
				['unread count', unreadCount, counts],
				['unread group count', unreadGroupCount, counts],
				['notification group', getNotificationGroup, { credential: read, groupKey: FAVOURITES, present: PRESENT }],
				[
					'notification group accounts',
					notificationGroupAccounts,
					{ credential: read, groupKey: FAVOURITES, page: below, present: PRESENT },
				],
			]
		}
		// What a read showed, by its name, the same at either size.
		const showing = (output: unknown) => {
			const value = (output as { value: unknown }).value
			return value === null ? 0 : shown(output)
		}
		// Under a dismissal, the reads of the group itself; the walks of every group check each row's group by its key.
		const groupReads = new Set(['notification group', 'notification group accounts'])
		for (const removal of ['clear', 'dismissal'] as const) {
			const few = await removing(2500, removal)
			const many = await removing(5000, removal)
			const grown: string[] = []
			const shownAt = (store: StoreStub, operation: StoreOperation<never, unknown>, input: unknown) =>
				runInDurableObject(store, (_instance, state) => showing(operation.run(state.storage.sql, input as never)))
			const fewReads = reads(2500)
			const manyReads = reads(5000)
			for (const [i, [name, operation, fewInput]] of fewReads.entries()) {
				if (removal === 'dismissal' && !groupReads.has(name)) {
					continue
				}
				const manyInput = manyReads[i]![2]
				const fewShown = await shownAt(few, operation, fewInput)
				expect([removal, name, await shownAt(many, operation, manyInput)]).toEqual([removal, name, fewShown])
				const fewRows = await rowsRead({ store: few }, operation, fewInput as never)
				const manyRows = await rowsRead({ store: many }, operation, manyInput as never)
				if (manyRows > fewRows + ALLOWANCE) {
					grown.push(`${name}: ${fewRows} -> ${manyRows}`)
				}
			}
			expect([removal, grown]).toEqual([removal, []])
			// Not vacuous: the newest page shows the follow requests and the follows, and nothing of the favourites.
			const newest = await runInDurableObject(few, (_instance, state) =>
				listNotifications.run(state.storage.sql, { ...list, page: { limit: 80 } } as never)
			)
			expect(
				(newest as { value: { items: { type: string }[] } }).value.items
					.map((n) => n.type)
					.filter((t) => t === 'favourite')
			).toEqual([])
			expect((newest as { value: { items: unknown[] } }).value.items).toHaveLength(FOLLOWS + REQUESTS)
		}
	}, 240_000)
})

// What Kopje learned of a remote account's collections (migration 0025_remote_collections) is read like a local
// account's: its pins by their key (at most MAX_REMOTE_PINS), its featured hashtags (at most MAX_FEATURED_TAGS), and
// whether it hides its network by a key lookup. Each read, and a round's claim of the oldest waiting sync, reads the
// same rows however many statuses the account has, however many accounts follow it, and however many other remote
// accounts have pins, featured hashtags and syncs waiting or held by rounds.
describe("a remote account's learned collections cost a bounded read (RES-7)", () => {
	const OWNER = '930000000000000000'
	const OWNER_URI = 'https://far.example/users/owner'
	const OTHER_BASE = 931000000000000000n
	const STATUS_BASE = 940000000000000000n
	const FEATURED_BASE = 950000000000000000n

	async function learned(count: number): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			const raw = JSON.stringify({
				id: OWNER_URI,
				featured: `${OWNER_URI}/collections/featured`,
				featuredTags: `${OWNER_URI}/collections/tags`,
				followers: `${OWNER_URI}/followers`,
				following: `${OWNER_URI}/following`,
			})
			sql.exec(
				`INSERT INTO accounts (id, uri, username, domain, raw, hide_collections)
				VALUES (?, ?, 'owner', 'far.example', ?, 1)`,
				OWNER,
				OWNER_URI,
				raw
			)
			// Other remote accounts, each following the owner, with a pinned status, a featured hashtag and a sync waiting
			// behind the owner's, or in front of it and held by rounds.
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO accounts (id, uri, username, domain)
				SELECT CAST(?2 + i AS TEXT), 'https://far' || (i % 10) || '.example/users/o' || i, 'o' || i,
					'far' || (i % 10) || '.example' FROM n`,
				count,
				String(OTHER_BASE)
			)
			sql.exec(
				`INSERT INTO follows (account_id, target_account_id, state)
				SELECT id, ?, 'accepted' FROM accounts WHERE id <> ?1 AND domain IS NOT NULL`,
				OWNER
			)
			// The owner's statuses: MAX_REMOTE_PINS pinned, then FEATURED_COUNT_WINDOW and `count` more (a full window for the featured hashtags' count); the others' one each, pinned.
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				SELECT CAST(?2 + i AS TEXT), CASE WHEN i < ?3 THEN ?4 || '/statuses/pinned' || i ELSE ?4 || '/statuses/' || i END,
					?5, 'public', '<p>s</p>', '2026-10-01T00:00:00.000Z' FROM n`,
				MAX_REMOTE_PINS + FEATURED_COUNT_WINDOW + count,
				String(STATUS_BASE),
				MAX_REMOTE_PINS,
				OWNER_URI,
				OWNER
			)
			sql.exec(
				`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				SELECT CAST(CAST(id AS INTEGER) + 5000000 AS TEXT), uri || '/statuses/1', id, 'public', '<p>o</p>',
					'2026-10-01T00:00:00.000Z'
				FROM accounts WHERE id <> ? AND domain IS NOT NULL`,
				OWNER
			)
			sql.exec(
				`INSERT INTO status_pins (account_id, status_id)
				SELECT account_id, id FROM statuses WHERE account_id <> ?1 OR uri GLOB ?2`,
				OWNER,
				`${OWNER_URI}/statuses/pinned*`
			)
			sql.exec(
				`INSERT INTO featured_tags (id, account_id, name, display_name)
				SELECT CAST(?1 + CAST(id AS INTEGER) - ?2 AS TEXT), id, 'tag', 'Tag' FROM accounts WHERE domain IS NOT NULL`,
				String(FEATURED_BASE),
				String(OTHER_BASE - 10_000_000n)
			)
			sql.exec(
				`INSERT INTO collection_syncs (account_id, due_at)
				SELECT id, CASE WHEN id = ?1 THEN 10 ELSE 100 END FROM accounts WHERE domain IS NOT NULL`,
				OWNER
			)
			// Half of the others asked for theirs first, and rounds hold them (their leases end after NOW).
			sql.exec(
				`UPDATE collection_syncs SET due_at = ?1
				WHERE account_id IN (SELECT id FROM accounts WHERE id <> ?2 AND domain IS NOT NULL ORDER BY id LIMIT ?3 / 2)`,
				NOW + SYNC_LEASE_MS,
				OWNER,
				count
			)
		})
		return store
	}

	it('reads the same rows with 20 or 2,000 statuses, followers and other accounts with learned collections', async () => {
		const few = await learned(20)
		const many = await learned(2000)
		const statuses = {
			credential: null,
			now: NOW,
			account: OWNER,
			page: PAGE,
			onlyMedia: false,
			excludeReplies: false,
			excludeReblogs: false,
			pinned: true,
			tagged: null,
			present: PRESENT,
		}
		const follows = { credential: null, now: NOW, account: OWNER, page: PAGE, present: PRESENT }
		const reads: [string, StoreOperation<never, unknown>, unknown, (output: unknown) => void][] = [
			[
				'pinned statuses',
				accountStatuses,
				statuses,
				(output) => expect((output as { value: { items: unknown[] } }).value.items).toHaveLength(PAGE.limit),
			],
			[
				'featured tags',
				accountFeaturedTags,
				{ id: OWNER, present: PRESENT },
				(output) => expect(output).toEqual([expect.objectContaining({ name: 'Tag' })]),
			],
			[
				'followers',
				listFollows,
				{ ...follows, direction: 'followers' },
				(output) => expect((output as { value: { items: unknown[] } }).value.items).toEqual([]),
			],
			[
				'claim',
				claimCollectionSync,
				{ now: NOW },
				(output) => expect(output).toMatchObject({ accountUri: OWNER_URI, pending: true }),
			],
		]
		const grown: string[] = []
		for (const [name, operation, input, check] of reads) {
			for (const store of [few, many]) {
				check(await runInDurableObject(store, (_instance, state) => operation.run(state.storage.sql, input as never)))
			}
			// The claim was taken above: measured on fresh copies.
			const [a, b] = name === 'claim' ? [await learned(20), await learned(2000)] : [few, many]
			const fewRows = await rowsRead({ store: a }, operation, input as never)
			const manyRows = await rowsRead({ store: b }, operation, input as never)
			if (manyRows > fewRows + ALLOWANCE) {
				grown.push(`${name}: ${fewRows} -> ${manyRows}`)
			}
		}
		expect(grown).toEqual([])
	}, 120_000)
})

// A remote account's featured hashtags are counted at read time over its newest FEATURED_COUNT_WINDOW statuses Kopje
// holds (featured-tags.ts), never kept: learning one, featuring and unfeaturing it again and again, and reading them with
// matches sparse among many statuses (and as many statuses of others with the hashtag) touch the same rows whether the
// account has 400 statuses stored or 4,000, since its history is never walked past the window.
describe("a remote account's featured hashtags cost a window of its statuses (RES-7)", () => {
	const OWNER = '960000000000000000'
	const OTHER = '960000000000000001'
	const STATUS_BASE = 961000000000000000n
	const OTHER_BASE = 962000000000000000n
	const newest = (count: number) => String(STATUS_BASE + BigInt(count - 1))

	// The owner's `count` public statuses: the oldest and the newest carry #cats, none between.
	async function history(count: number, featured: boolean): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(
				"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://far.example/users/owner', 'owner', 'far.example')",
				OWNER
			)
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				SELECT CAST(?2 + i AS TEXT), 'https://far.example/s/' || i, ?3, 'public', '<p>s</p>',
					strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01', '+' || i || ' minutes') FROM n`,
				count,
				String(STATUS_BASE),
				OWNER
			)
			sql.exec(
				"INSERT INTO status_tags (status_id, name, public) VALUES (?, 'cats', 1), (?, 'cats', 1)",
				String(STATUS_BASE),
				newest(count)
			)
			// As many statuses with #cats by another account, so a walk of the hashtag grows as well.
			sql.exec(
				"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://far.example/users/other', 'other', 'far.example')",
				OTHER
			)
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				SELECT CAST(?2 + i AS TEXT), 'https://far.example/o/' || i, ?3, 'public', '<p>o</p>', '2026-01-02T00:00:00.000Z'
				FROM n`,
				count,
				String(OTHER_BASE),
				OTHER
			)
			sql.exec(
				"INSERT INTO status_tags (status_id, name, public) SELECT id, 'cats', 1 FROM statuses WHERE account_id = ?",
				OTHER
			)
			if (featured) {
				sql.exec(
					`INSERT INTO featured_tags (id, account_id, name, display_name, statuses_count, last_status_at)
					SELECT '970000000000000000', ?1, 'cats', 'cats', 2, published_at FROM statuses WHERE id = ?2`,
					OWNER,
					newest(count)
				)
			}
		})
		return store
	}

	const learn = writeOperation<{ now: number }, void>((db, { now }) => {
		featureRemote(db, OWNER, '#cats', now)
	})
	const toggle = writeOperation<{ now: number }, void>((db, { now }) => {
		for (let i = 0; i < 5; i++) {
			unfeatureRemote(db, OWNER, 'cats')
			featureRemote(db, OWNER, '#cats', now)
		}
	})

	it('reads the same rows with 400 or 4,000 statuses: learning, featuring again and again, and reading', async () => {
		expect(FEATURED_COUNT_WINDOW).toBeLessThan(400)
		const grown: string[] = []
		const cases: [string, boolean, StoreOperation<never, unknown>, (count: number) => unknown][] = [
			['learn', false, learn, () => ({ now: NOW })],
			['feature again', true, toggle, () => ({ now: NOW })],
			['read', true, accountFeaturedTags, () => ({ id: OWNER, present: PRESENT })],
		]
		for (const [name, featured, operation, input] of cases) {
			const few = await rowsTouched(await history(400, featured), operation, input(400) as never)
			const many = await rowsTouched(await history(4000, featured), operation, input(4000) as never)
			if (many > few + ALLOWANCE) {
				grown.push(`${name}: ${few} -> ${many}`)
			}
		}
		expect(grown).toEqual([])
		// Not vacuous: the read counts the newest status, the only one with the hashtag in the window.
		const store = await history(4000, false)
		await runInDurableObject(store, (_instance, state) => learn.run(state.storage.sql, { now: NOW }))
		const read = await runInDurableObject(store, (_instance, state) =>
			accountFeaturedTags.run(state.storage.sql, { id: OWNER, present: PRESENT })
		)
		expect(read).toEqual([expect.objectContaining({ statuses_count: '1', last_status_at: '2026-01-03' })])
	}, 120_000)
})

describe('a streamed notification reads its item, however many notifications there are (RES-7)', () => {
	const VIEWER_ID = '693000000000000000'
	const OTHER_ID = '693000000000000001'
	const SENDER_BASE = 694000000000000000n
	const TOKEN = 'stream-token'

	// The viewer and another local account, each with `count` notifications from as many remote senders, the viewer's
	// policy filtering some (every third), and a token of the viewer's.
	async function notified(count: number): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec("INSERT INTO instance_settings (name, value) VALUES ('domain', 'kopje.test')")
			for (const [id, name] of [
				[VIEWER_ID, 'viewer'],
				[OTHER_ID, 'other'],
			]) {
				sql.exec(
					'INSERT INTO accounts (id, uri, username) VALUES (?, ?, ?)',
					id,
					`https://kopje.test/ap/users/${name}`,
					name
				)
				sql.exec(
					"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'test')",
					id,
					`${name}@example.com`
				)
			}
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO accounts (id, uri, username, domain)
				SELECT CAST(?2 + i AS TEXT), 'https://far' || (i % 10) || '.example/users/u' || i, 'u' || i,
					'far' || (i % 10) || '.example'
				FROM n`,
				count,
				String(SENDER_BASE)
			)
			for (const recipient of [VIEWER_ID, OTHER_ID]) {
				sql.exec(
					`INSERT INTO notifications (account_id, type, from_account_id, filtered)
					SELECT ?1, 'follow', id, CAST(id AS INTEGER) % 3 = 0 FROM accounts WHERE domain IS NOT NULL ORDER BY id`,
					recipient
				)
			}
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('streaming', 'secret', 'streaming', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'streaming', ?, 'read')",
				TOKEN,
				VIEWER_ID
			)
		})
		return store
	}

	// The viewer's newest, a middle and the oldest notification shown, and a filtered one.
	async function targets(store: StoreStub): Promise<string[]> {
		return runInDurableObject(store, (_instance, state) => {
			const rows = state.storage.sql
				.exec<{ id: number; filtered: number }>(
					'SELECT id, filtered FROM notifications WHERE account_id = ? ORDER BY id DESC',
					VIEWER_ID
				)
				.toArray()
			const kept = rows.filter((row) => row.filtered === 0)
			return [kept[0], kept[Math.floor(kept.length / 2)], kept.at(-1), rows.find((row) => row.filtered === 1)].map(
				(row) => String(row!.id)
			)
		})
	}

	it('reads the same rows with 20 or 2,000 notifications of the viewer and of another account', async () => {
		const few = await notified(20)
		const many = await notified(2000)
		const unit = (notificationId: string) => ({
			kind: 'notification',
			subject: notificationId,
			accountId: VIEWER_ID,
			tokenHashes: [TOKEN],
			now: NOW,
		})
		const grown: string[] = []
		const fewTargets = await targets(few)
		const manyTargets = await targets(many)
		for (const [i, name] of ['newest', 'middle', 'oldest', 'filtered'].entries()) {
			const fewInput = unit(fewTargets[i]!)
			const manyInput = unit(manyTargets[i]!)
			// Not vacuous: the shown ones are presented, the filtered one is not.
			const made = await runInDurableObject(many, (_instance, state) => streamUnit.run(state.storage.sql, manyInput))
			expect([name, (made.payload as { type: string } | null)?.type ?? null]).toEqual([
				name,
				name === 'filtered' ? null : 'follow',
			])
			const fewRows = await rowsRead({ store: few }, streamUnit, fewInput)
			const manyRows = await rowsRead({ store: many }, streamUnit, manyInput)
			if (manyRows > fewRows + ALLOWANCE) {
				grown.push(`${name}: ${fewRows} -> ${manyRows}`)
			}
		}
		expect(grown).toEqual([])
	}, 120_000)

	it("reads a window of the journal, however long it is and whatever the viewer's history", async () => {
		const journal = async (count: number) => {
			const store = await notified(count)
			// Every notification journaled, the position at the start.
			await runInDurableObject(store, (_instance, state) => {
				state.storage.sql.exec(
					"INSERT INTO stream_events (kind, subject, created_at) SELECT 'notification', CAST(id AS TEXT), created_at FROM notifications ORDER BY id"
				)
			})
			return store
		}
		const few = await journal(100)
		const many = await journal(2000)
		const scan = { limit: 64 }
		const events = await runInDurableObject(many, (_instance, state) => streamEvents.run(state.storage.sql, scan))
		expect(events.events).toHaveLength(64)
		// The scan, and the upgrade's and the turn's token checks, which read the journal's head.
		const reads: [string, StoreOperation<never, unknown>, unknown][] = [
			['scan', streamEvents, scan],
			['accept', streamAccept, { tokenHash: TOKEN, now: NOW }],
			['tokens', streamTokens, { sockets: [{ tokenHash: TOKEN, accountId: VIEWER_ID }], now: NOW }],
		]
		const grown: string[] = []
		for (const [name, operation, input] of reads) {
			const fewRows = await rowsRead({ store: few }, operation, input as never)
			const manyRows = await rowsRead({ store: many }, operation, input as never)
			if (manyRows > fewRows + ALLOWANCE) {
				grown.push(`${name}: ${fewRows} -> ${manyRows}`)
			}
		}
		expect(grown).toEqual([])
	}, 120_000)
})

describe("a streamed status reads its item, however large the viewer's home and others' data (RES-7)", () => {
	const VIEWER_ID = '695000000000000000'
	// A followed author, an unfollowed author who mentions the viewer, and an unfollowed author of followed-hashtag posts.
	const AUTHOR_ID = '695000000000000001'
	const MENTIONER_ID = '695000000000000002'
	const TAGGER_ID = '695000000000000003'
	const OTHERS = 696000000000000000n
	const BOOSTERS = 697000000000000000n
	const AUTHOR_STATUSES = 790000000000000000n
	const TAGGED_STATUSES = 791000000000000000n
	const MENTION_STATUSES = 792000000000000000n
	const OTHER_STATUSES = 793000000000000000n
	const BOOSTS = 794000000000000000n
	const TAG_STATUSES = 795000000000000000n
	const TOKEN = 'stream-home-token'

	type Size = {
		perAuthor: number
		follows: number
		exclusive: number
		tags: number
		notifications: number
		boosts: number
	}

	// The viewer follows the author and `follows` other accounts (each with a status), has an exclusive list of
	// `exclusive` other accounts, follows #cats and `tags` other hashtags (each with a status), and has `notifications`
	// mentions from the mentioner. The author has `perAuthor` public statuses, the tagger as many with #cats, the
	// mentioner as many direct statuses mentioning the viewer; the author's newest is boosted by five followed accounts
	// and `boosts` unfollowed ones.
	async function home(size: Size): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			const at = new Date(NOW).toISOString()
			sql.exec("INSERT INTO instance_settings (name, value) VALUES ('domain', 'kopje.test')")
			sql.exec(
				"INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/viewer', 'viewer')",
				VIEWER_ID
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'viewer@example.com', X'00', X'00', 'test')",
				VIEWER_ID
			)
			for (const [id, name] of [
				[AUTHOR_ID, 'author'],
				[MENTIONER_ID, 'mentioner'],
				[TAGGER_ID, 'tagger'],
			]) {
				sql.exec(
					"INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, ?, 'far.example')",
					id,
					`https://far.example/users/${name}`,
					name
				)
			}
			// Others: the followed accounts, then the exclusive list's members, then the unfollowed boosters.
			const accounts = (base: bigint, count: number, prefix: string) =>
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
					INSERT INTO accounts (id, uri, username, domain)
					SELECT CAST(?2 + i AS TEXT), 'https://many.example/users/' || ?3 || i, ?3 || i, 'many.example' FROM n
					WHERE ?1 > 0`,
					count,
					String(base),
					prefix
				)
			accounts(OTHERS, size.follows + size.exclusive, 'o')
			accounts(BOOSTERS, size.boosts, 'b')
			sql.exec(
				"INSERT INTO follows (account_id, target_account_id, state, created_at) VALUES (?, ?, 'accepted', ?)",
				VIEWER_ID,
				AUTHOR_ID,
				at
			)
			sql.exec(
				`INSERT INTO follows (account_id, target_account_id, state, created_at)
				SELECT ?1, id, 'accepted', ?2 FROM accounts WHERE id GLOB '696*' ORDER BY id LIMIT ?3`,
				VIEWER_ID,
				at,
				size.follows
			)
			sql.exec(
				"INSERT INTO lists (id, account_id, title, exclusive) VALUES ('698000000000000000', ?, 'exclusive', 1)",
				VIEWER_ID
			)
			sql.exec(
				`INSERT INTO list_accounts (list_id, account_id)
				SELECT '698000000000000000', id FROM accounts WHERE id GLOB '696*' ORDER BY id LIMIT -1 OFFSET ?`,
				size.follows
			)
			const statuses = (base: bigint, author: string, count: number, visibility: string) =>
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
					INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, created_at)
					SELECT CAST(?2 + i AS TEXT), 'https://far.example/objects/' || (?2 + i), ?3, ?4, '<p>x</p>', ?5, ?5 FROM n`,
					count,
					String(base),
					author,
					visibility,
					at
				)
			statuses(AUTHOR_STATUSES, AUTHOR_ID, size.perAuthor, 'public')
			statuses(TAGGED_STATUSES, TAGGER_ID, size.perAuthor, 'public')
			sql.exec(
				"INSERT INTO status_tags (status_id, name, public) SELECT id, 'cats', 1 FROM statuses WHERE account_id = ?",
				TAGGER_ID
			)
			statuses(MENTION_STATUSES, MENTIONER_ID, size.notifications, 'direct')
			sql.exec(
				`INSERT INTO status_mentions (status_id, account_id, silent, requires_mention, author_id)
				SELECT id, ?1, 0, 1, account_id FROM statuses WHERE account_id = ?2`,
				VIEWER_ID,
				MENTIONER_ID
			)
			sql.exec(
				`INSERT INTO notifications (account_id, type, from_account_id, status_id)
				SELECT ?1, 'mention', account_id, id FROM statuses WHERE account_id = ?2 ORDER BY id`,
				VIEWER_ID,
				MENTIONER_ID
			)
			// One status of each other account (followed or listed).
			sql.exec(
				`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, created_at)
				SELECT CAST(?1 + CAST(id AS INTEGER) - ?2 AS TEXT), 'https://many.example/objects/' || id, id, 'public',
					'<p>x</p>', ?3, ?3
				FROM accounts WHERE id GLOB '696*'`,
				String(OTHER_STATUSES),
				String(OTHERS),
				at
			)
			// The hashtags: #cats and `tags` others, each of the others with a status of a followed account.
			sql.exec("INSERT INTO tag_follows (account_id, name) VALUES (?, 'cats')", VIEWER_ID)
			for (let t = 0; t < size.tags; t++) {
				sql.exec('INSERT INTO tag_follows (account_id, name) VALUES (?, ?)', VIEWER_ID, `other${t}`)
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, created_at)
					VALUES (?, ?, ?, 'public', '<p>x</p>', ?, ?)`,
					String(TAG_STATUSES + BigInt(t)),
					`https://far.example/objects/tag-${t}`,
					TAGGER_ID,
					at,
					at
				)
				sql.exec(
					'INSERT INTO status_tags (status_id, name, public) VALUES (?, ?, 1)',
					String(TAG_STATUSES + BigInt(t)),
					`other${t}`
				)
			}
			// The author's newest, boosted by five followed accounts and by the unfollowed boosters.
			sql.exec(
				`INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, content, published_at, created_at)
				SELECT CAST(?1 + row_number() OVER (ORDER BY id) AS TEXT), 'https://boost.example/' || id, id, ?2, 'public', '',
					?3, ?3
				FROM (SELECT * FROM (SELECT id FROM accounts WHERE id GLOB '696*' ORDER BY id LIMIT 5)
					UNION ALL SELECT id FROM accounts WHERE id GLOB '697*')`,
				String(BOOSTS),
				String(AUTHOR_STATUSES + BigInt(size.perAuthor - 1)),
				at
			)
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('stream-home', 'secret', 'stream-home', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'stream-home', ?, 'read')",
				TOKEN,
				VIEWER_ID
			)
		})
		return store
	}

	// The checks, by name: [kind, status id, the event and streams it must make in the grown world].
	function checks(size: Size): [string, string, string, string, string[]][] {
		const author = (i: number) => String(AUTHOR_STATUSES + BigInt(i))
		return [
			['newest of the author', 'status', author(size.perAuthor - 1), 'update', ['user']],
			['middle of the author', 'status', author(Math.floor(size.perAuthor / 2)), 'update', ['user']],
			['oldest of the author', 'status', author(0), 'update', ['user']],
			['a followed account', 'status', String(OTHER_STATUSES), 'update', ['user']],
			['an exclusive member', 'status', String(OTHER_STATUSES + BigInt(size.follows)), '', []],
			[
				'the newest followed-hashtag post',
				'status',
				String(TAGGED_STATUSES + BigInt(size.perAuthor - 1)),
				'update',
				['user'],
			],
			// Positioned at it, the oldest is the first of its window (R33's documented window difference).
			['the oldest followed-hashtag post', 'status', String(TAGGED_STATUSES), 'update', ['user']],
			['an edit in home', 'edit', author(size.perAuthor - 1), 'status.update', ['user']],
			[
				'an edit of the newest mention',
				'edit',
				String(MENTION_STATUSES + BigInt(size.notifications - 1)),
				'status.update',
				['user', 'user:notification'],
			],
			[
				'an edit of the oldest mention',
				'edit',
				String(MENTION_STATUSES),
				'status.update',
				['user', 'user:notification'],
			],
		]
	}

	it('reads the same rows with 20 or 2,000 statuses per author, 10 or 1,000 follows, 0 or 1,000 exclusive-list members, 0 or 40 unrelated followed hashtags, 20 or 2,000 notifications', async () => {
		const small: Size = { perAuthor: 20, follows: 10, exclusive: 0, tags: 0, notifications: 20, boosts: 0 }
		const large: Size = { perAuthor: 2000, follows: 1000, exclusive: 1000, tags: 40, notifications: 2000, boosts: 0 }
		const few = await home(small)
		const many = await home(large)
		const unit = (kind: string, subject: string) => ({
			kind,
			subject,
			accountId: VIEWER_ID,
			tokenHashes: [TOKEN],
			now: NOW,
		})
		const grown: string[] = []
		const fewChecks = checks(small)
		for (const [i, [name, kind, subject, event, streams]] of checks(large).entries()) {
			// Not vacuous: each check in the grown world makes what it must.
			const made = await runInDurableObject(many, (_instance, state) =>
				streamUnit.run(state.storage.sql, unit(kind, subject))
			)
			expect([name, made.event, made.streams.map((s) => s.stream)]).toEqual([name, event, streams])
			const fewRows = await rowsRead({ store: few }, streamUnit, unit(kind, fewChecks[i]![2]))
			const manyRows = await rowsRead({ store: many }, streamUnit, unit(kind, subject))
			if (manyRows > fewRows + ALLOWANCE) {
				grown.push(`${name}: ${fewRows} -> ${manyRows}`)
			}
		}
		expect(grown).toEqual([])
	}, 120_000)
})

describe("R32: a delete's capture reads the smaller of the status's boosts and each listener's follows (RES-7)", () => {
	const STATUS_ID = '780000000000000000'
	const AUTHOR_ID = '680000000000000000'
	const LISTENERS = 681000000000000000n
	const FOLLOWED = 682000000000000000n
	const BOOSTERS = 683000000000000000n
	const BOOSTS = 781000000000000000n

	type Size = { listeners: number; follows: number; boosts: number }

	// A public status; `listeners` local accounts, each following the same `follows` accounts (one of which boosted the
	// status) and the author; `boosts` boosts by accounts nobody follows.
	async function captured(size: Size): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			const at = new Date(NOW).toISOString()
			const accounts = (base: bigint, count: number, prefix: string, domain: string | null) =>
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
					INSERT INTO accounts (id, uri, username, domain)
					SELECT CAST(?2 + i AS TEXT), 'https://' || coalesce(?4, 'kopje.test') || '/users/' || ?3 || i, ?3 || i, ?4
					FROM n WHERE ?1 > 0`,
					count,
					String(base),
					prefix,
					domain
				)
			sql.exec(
				"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://far.example/users/author', 'author', 'far.example')",
				AUTHOR_ID
			)
			accounts(LISTENERS, size.listeners, 'l', null)
			sql.exec(
				`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
				SELECT id, username || '@example.com', X'00', X'00', 'test' FROM accounts WHERE id GLOB '681*'`
			)
			accounts(FOLLOWED, size.follows, 'f', 'many.example')
			accounts(BOOSTERS, size.boosts, 'b', 'boost.example')
			sql.exec(
				`INSERT INTO follows (account_id, target_account_id, state, created_at)
				SELECT l.id, t.id, 'accepted', ?1 FROM accounts l, accounts t
				WHERE l.id GLOB '681*' AND (t.id GLOB '682*' OR t.id = ?2)`,
				at,
				AUTHOR_ID
			)
			sql.exec(
				`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, created_at)
				VALUES (?, 'https://far.example/objects/s', ?, 'public', '<p>s</p>', ?, ?)`,
				STATUS_ID,
				AUTHOR_ID,
				at,
				at
			)
			// One followed account's boost, and the unfollowed boosters'.
			sql.exec(
				`INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, content, published_at, created_at)
				SELECT CAST(?1 + row_number() OVER (ORDER BY id) AS TEXT), 'https://boost.example/' || id, id, ?2, 'public', '',
					?3, ?3
				FROM (SELECT * FROM (SELECT id FROM accounts WHERE id GLOB '682*' ORDER BY id LIMIT 1)
					UNION ALL SELECT id FROM accounts WHERE id GLOB '683*')`,
				String(BOOSTS),
				STATUS_ID,
				at
			)
		})
		return store
	}

	const capture = readOperation<{ listeners: number }, { accountId: string; boosts: string[] }[]>((db, input) =>
		deleteAudience(
			db,
			STATUS_ID,
			Array.from({ length: input.listeners }, (_, i) => String(LISTENERS + BigInt(i))),
			40
		)
	)

	async function read(size: Size): Promise<number> {
		const store = await captured(size)
		const made = await runInDurableObject(store, (_instance, state) =>
			capture.run(state.storage.sql, { listeners: size.listeners })
		)
		// Not vacuous: every listener is captured with the followed account's boost, whichever side is read.
		expect(made.map((viewer) => viewer.boosts.length)).toEqual(Array(size.listeners).fill(size.follows > 0 ? 1 : 0))
		return rowsRead({ store }, capture, { listeners: size.listeners })
	}

	it("reads the same rows with 10 or 1,000 follows per listener, and a constant per listener, when the status's boosts are few", async () => {
		const few = await read({ listeners: 4, follows: 10, boosts: 0 })
		const followed = await read({ listeners: 4, follows: 1000, boosts: 0 })
		expect(followed).toBeLessThanOrEqual(few + ALLOWANCE)
		const listeners = await read({ listeners: 40, follows: 1000, boosts: 0 })
		// Each listener more costs the view check and its walk of the status's one boost, not its follows. Every
		// availability predicate the statements emit also reads the suspend blocks' index once (availableSql, R38), each
		// occurrence on its own: measured at 2 more rows per listener (432 for 36 listeners, against 360 before it).
		expect(listeners - followed).toBeLessThanOrEqual(36 * (ALLOWANCE + 2))
	}, 120_000)

	// A turn reads a delete's units a page at a time: the journal's scan reads no capture row, and a page reads its
	// viewers' rows only, whether the capture holds 1 viewer or 256 with 40 boosts each.
	it("reads a window of the journal and a page of a delete's units, however dense the captures", async () => {
		const journal = async (viewers: number) => {
			const store = await migratedStore()
			await runInDurableObject(store, (_instance, state) => {
				const sql = state.storage.sql
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 64)
					INSERT INTO stream_events (id, kind, subject, created_at)
					SELECT i, 'delete', ?, '2026-10-12T00:00:00.000Z' FROM n`,
					STATUS_ID
				)
				const boosts = JSON.stringify(Array.from({ length: 40 }, (_, i) => [String(BOOSTS + BigInt(i)), []]))
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
					INSERT INTO stream_delete_viewers (event_id, account_id, lists, boosts)
					SELECT e.id, CAST(?2 + n.i AS TEXT), '[]', ?3 FROM stream_events e, n`,
					viewers,
					String(LISTENERS),
					boosts
				)
			})
			return store
		}
		const few = await journal(1)
		const many = await journal(256)
		const page = { eventId: 1, statusId: STATUS_ID, after: null, rows: 8 }
		const made = await runInDurableObject(many, (_instance, state) => streamDeleteUnits.run(state.storage.sql, page))
		expect([made.units.length, made.next?.account]).toEqual([8 * 41, String(LISTENERS + 8n)])
		const reads: [string, StoreOperation<never, unknown>, unknown][] = [
			['scan', streamEvents, { limit: 64 }],
			['page', streamDeleteUnits, page],
		]
		for (const [name, operation, input] of reads) {
			const fewRows = await rowsRead({ store: few }, operation, input as never)
			const manyRows = await rowsRead({ store: many }, operation, input as never)
			expect(manyRows, name).toBeLessThanOrEqual(fewRows + ALLOWANCE)
		}
	}, 120_000)

	it('reads a bounded scan, then each listener’s follows, however many unfollowed accounts boosted the status', async () => {
		const within = await read({ listeners: 4, follows: 10, boosts: CAPTURE_BOOST_SCAN - 1 })
		const past = await read({ listeners: 4, follows: 10, boosts: CAPTURE_BOOST_SCAN })
		const far = await read({ listeners: 4, follows: 10, boosts: 10 * CAPTURE_BOOST_SCAN })
		// Within the scan, each listener walks the boosts once; past it, the scan and the follows.
		expect(within).toBeLessThanOrEqual(5 * (CAPTURE_BOOST_SCAN + ALLOWANCE))
		// Per listener: its view check and its follows (ten and the author).
		expect(past).toBeLessThanOrEqual(CAPTURE_BOOST_SCAN + 1 + 4 * (11 + 2 * ALLOWANCE))
		expect(far).toBeLessThanOrEqual(past + ALLOWANCE)
	}, 120_000)
})

// The `list` and `direct` streams' reads (design "Kopje streaming API" PR 3): a list's check (listStatus, narrowed to the
// status's author), a delete's capture of the lists, the ownership check of a subscription, and the conversation reads
// (the owner's newest changes, a conversation's unit) read the same rows however long the
// members' histories, however large the list and however many conversations the owner has.
describe("streamed lists and conversations read their items, however large the list and the owner's history (RES-7)", () => {
	const VIEWER_ID = '665000000000000000'
	const AUTHOR_ID = '665000000000000001'
	const MEMBERS = 666000000000000000n
	const AUTHOR_STATUSES = 760000000000000000n
	const MEMBER_STATUSES = 761000000000000000n
	const CONVERSATION_STATUSES = 762000000000000000n
	const LIST_ID = '667000000000000000'
	const TOKEN = 'stream-list-token'

	type Size = { perAuthor: number; members: number; conversations: number }

	// The viewer follows the author and `members` other accounts (each with a status), all in its list LIST_ID, and
	// listens on the list; the author has `perAuthor` public statuses; the viewer has `conversations` conversations, each
	// with its own direct status and change sequence, and its mark at the highest.
	async function world(size: Size): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			const at = new Date(NOW).toISOString()
			sql.exec("INSERT INTO instance_settings (name, value) VALUES ('domain', 'kopje.test')")
			sql.exec(
				"INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/viewer', 'viewer')",
				VIEWER_ID
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'viewer@example.com', X'00', X'00', 'test')",
				VIEWER_ID
			)
			sql.exec(
				"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://far.example/users/author', 'author', 'far.example')",
				AUTHOR_ID
			)
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO accounts (id, uri, username, domain)
				SELECT CAST(?2 + i AS TEXT), 'https://many.example/users/m' || i, 'm' || i, 'many.example' FROM n WHERE ?1 > 0`,
				size.members,
				String(MEMBERS)
			)
			sql.exec(
				`INSERT INTO follows (account_id, target_account_id, state, created_at)
				SELECT ?1, id, 'accepted', ?2 FROM accounts WHERE id <> ?1`,
				VIEWER_ID,
				at
			)
			sql.exec("INSERT INTO lists (id, account_id, title) VALUES (?, ?, 'list')", LIST_ID, VIEWER_ID)
			sql.exec(
				'INSERT INTO list_accounts (list_id, account_id) SELECT ?1, id FROM accounts WHERE id <> ?2',
				LIST_ID,
				VIEWER_ID
			)
			const statuses = (base: bigint, author: string, count: number, visibility: string) =>
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
					INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, created_at)
					SELECT CAST(?2 + i AS TEXT), 'https://far.example/objects/' || (?2 + i), ?3, ?4, '<p>x</p>', ?5, ?5 FROM n`,
					count,
					String(base),
					author,
					visibility,
					at
				)
			statuses(AUTHOR_STATUSES, AUTHOR_ID, size.perAuthor, 'public')
			sql.exec(
				`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, created_at)
				SELECT CAST(?1 + CAST(id AS INTEGER) - ?2 AS TEXT), 'https://many.example/objects/' || id, id, 'public',
					'<p>x</p>', ?3, ?3
				FROM accounts WHERE id GLOB '666*'`,
				String(MEMBER_STATUSES),
				String(MEMBERS),
				at
			)
			statuses(CONVERSATION_STATUSES, VIEWER_ID, size.conversations, 'direct')
			sql.exec(
				`INSERT INTO conversations (account_id, thread, participants, last_status_id, unread, stream_seq)
				SELECT account_id, thread, '[]', id, 0, CAST(id AS INTEGER) - ?2 + 1 FROM statuses WHERE account_id = ?1
				AND visibility = 'direct'`,
				VIEWER_ID,
				String(CONVERSATION_STATUSES)
			)
			sql.exec(
				'INSERT INTO conversation_statuses (conversation_id, status_id) SELECT id, last_status_id FROM conversations'
			)
			sql.exec('INSERT INTO stream_conversation_marks (account_id, seq) VALUES (?, ?)', VIEWER_ID, size.conversations)
			sql.exec(
				"INSERT INTO stream_subscriptions (account_id, stream_key, sockets) VALUES (?, ?, 1), (?, 'direct', 1)",
				VIEWER_ID,
				`list:${LIST_ID}`,
				VIEWER_ID
			)
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('stream-list', 'secret', 'stream-list', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'stream-list', ?, 'read')",
				TOKEN,
				VIEWER_ID
			)
		})
		return store
	}

	const conversation = async (store: StoreStub, seq: number) =>
		(
			await runInDurableObject(store, (_instance, state) =>
				state.storage.sql
					.exec<{ id: string }>(
						'SELECT CAST(id AS TEXT) AS id FROM conversations WHERE account_id = ? AND stream_seq = ?',
						VIEWER_ID,
						seq
					)
					.one()
			)
		).id

	// The reads, by name: [operation, input, what it must return in the grown world].
	async function reads(
		store: StoreStub,
		size: Size
	): Promise<[string, StoreOperation<never, unknown>, unknown, unknown][]> {
		const author = (i: number) => String(AUTHOR_STATUSES + BigInt(i))
		const unit = (kind: string, subject: string) => ({
			kind,
			subject,
			accountId: VIEWER_ID,
			tokenHashes: [TOKEN],
			lists: [LIST_ID],
			now: NOW,
		})
		const streams = (
			kind: string,
			subject: string,
			event: string,
			keys: string[]
		): [string, StoreOperation<never, unknown>, unknown, unknown] => [
			`${kind} ${subject}`,
			streamUnit,
			unit(kind, subject),
			{ event, streams: keys },
		]
		return [
			streams('status', author(size.perAuthor - 1), 'update', ['user', `list:${LIST_ID}`]),
			streams('status', author(0), 'update', ['user', `list:${LIST_ID}`]),
			streams('status', String(MEMBER_STATUSES + BigInt(size.members - 1)), 'update', ['user', `list:${LIST_ID}`]),
			streams('edit', author(0), 'status.update', ['user', `list:${LIST_ID}`]),
			streams('conversation', await conversation(store, size.conversations), 'conversation', ['direct']),
			streams('conversation', await conversation(store, 1), 'conversation', ['direct']),
			['owned', streamListOwned, { accountId: VIEWER_ID, listId: LIST_ID }, true],
			['changes', streamConversations, { accountId: VIEWER_ID, after: 0, upTo: size.conversations, limit: 20 }, 20],
		]
	}

	// What a read returned, reduced to what `reads` names.
	function summary(result: unknown): unknown {
		if (Array.isArray(result)) {
			return result.length
		}
		if (typeof result === 'object' && result !== null && 'streams' in result) {
			const made = result as { event: string; streams: { stream: string }[] }
			return { event: made.event, streams: made.streams.map((s) => s.stream) }
		}
		return result
	}

	it('reads the same rows with 20 or 2,000 statuses per author, 10 or 1,000 list members, 20 or 2,000 conversations', async () => {
		const small: Size = { perAuthor: 20, members: 10, conversations: 20 }
		const large: Size = { perAuthor: 2000, members: 1000, conversations: 2000 }
		const few = await world(small)
		const many = await world(large)
		const fewReads = await reads(few, small)
		const grown: string[] = []
		for (const [i, [name, operation, input, expected]] of (await reads(many, large)).entries()) {
			// Not vacuous: each read in the grown world returns what it must.
			const result = await runInDurableObject(many, (_instance, state) =>
				operation.run(state.storage.sql, input as never)
			)
			expect([name, summary(result)]).toEqual([name, expected])
			const fewRows = await rowsRead({ store: few }, operation, fewReads[i]![2] as never)
			const manyRows = await rowsRead({ store: many }, operation, input as never)
			if (manyRows > fewRows + ALLOWANCE) {
				grown.push(`${name}: ${fewRows} -> ${manyRows}`)
			}
		}
		expect(grown).toEqual([])
	}, 120_000)

	it("captures a delete's lists in the same rows, however large the list and the author's history", async () => {
		const capture = readOperation<{ statusId: string }, null>((db, { statusId }) => {
			streamDelete(db, statusId, NOW)
			return null
		})
		const measure = async (size: Size) => {
			const store = await world(size)
			const statusId = String(AUTHOR_STATUSES + BigInt(size.perAuthor - 1))
			const rows = await rowsRead({ store }, capture, { statusId })
			// Not vacuous: the viewer is captured with the list.
			expect(
				await runInDurableObject(store, (_instance, state) =>
					state.storage.sql.exec('SELECT lists FROM stream_delete_viewers').toArray()
				)
			).toEqual([{ lists: JSON.stringify([LIST_ID]) }])
			return rows
		}
		const few = await measure({ perAuthor: 20, members: 10, conversations: 20 })
		const many = await measure({ perAuthor: 2000, members: 1000, conversations: 20 })
		// The capture's view check reads the viewer's follows of the boosters (none here) and its list read is narrowed.
		expect(many).toBeLessThanOrEqual(few + ALLOWANCE)
	}, 120_000)
})

describe("streamed public and hashtag statuses read their items, however large the timelines and the viewer's filters (RES-7)", () => {
	const VIEWER_ID = '699000000000000000'
	const AUTHOR_ID = '699000000000000001'
	const LOCAL_ID = '699000000000000002'
	const MUTED_ID = '699000000000000003'
	const OTHERS = 699100000000000000n
	const FILTERED = 699200000000000000n
	const AUTHOR_STATUSES = 796000000000000000n
	const OTHER_STATUSES = 797000000000000000n
	const FILTERED_STATUSES = 798000000000000000n
	const MEDIA_STATUS = '799000000000000000'
	const MENTION_STATUS = '799000000000000001'
	const TOKEN = 'stream-feeds-token'
	// Every feed a socket may subscribe to with the world's hashtag, as the hub passes them (sorted).
	const FEEDS = [
		'hashtag:cats',
		'hashtag:local:cats',
		'public',
		'public:local',
		'public:local:media',
		'public:media',
		'public:remote',
		'public:remote:media',
	]

	type Size = { perAuthor: number; others: number; filtered: number }

	// A remote author with `perAuthor` public #cats statuses; `others` remote accounts with one each; `filtered` remote
	// accounts the viewer blocks, mutes or domain-blocks (a third each), with one each, all newer than the checked ones;
	// a local account's public #cats status with media, and another mentioning an account the viewer mutes.
	async function world(size: Size): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			const at = new Date(NOW).toISOString()
			sql.exec("INSERT INTO instance_settings (name, value) VALUES ('domain', 'kopje.test')")
			for (const [id, name, domain] of [
				[VIEWER_ID, 'viewer', null],
				[AUTHOR_ID, 'author', 'far.example'],
				[LOCAL_ID, 'local', null],
				[MUTED_ID, 'muted', 'far.example'],
			] as const) {
				sql.exec(
					'INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, ?, ?)',
					id,
					`https://${domain ?? 'kopje.test'}/users/${name}`,
					name,
					domain
				)
			}
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) SELECT id, username || '@example.com', X'00', X'00', 'test' FROM accounts WHERE domain IS NULL"
			)
			const accounts = (base: bigint, count: number, prefix: string) =>
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
					INSERT INTO accounts (id, uri, username, domain)
					SELECT CAST(?2 + i AS TEXT), 'https://' || ?3 || i || '.example/users/x', 'x', ?3 || i || '.example' FROM n
					WHERE ?1 > 0`,
					count,
					String(base),
					prefix
				)
			accounts(OTHERS, size.others, 'o')
			accounts(FILTERED, size.filtered, 'f')
			const statuses = (base: bigint, count: number, author: string | null) =>
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
					INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, created_at)
					SELECT CAST(?2 + i AS TEXT), 'https://far.example/objects/' || (?2 + i),
						coalesce(?3, CAST(?5 + i AS TEXT)), 'public', '<p>#cats</p>', ?4, ?4
					FROM n WHERE ?1 > 0`,
					count,
					String(base),
					author,
					at,
					String(author === null ? (base === OTHER_STATUSES ? OTHERS : FILTERED) : 0n)
				)
			statuses(AUTHOR_STATUSES, size.perAuthor, AUTHOR_ID)
			statuses(OTHER_STATUSES, size.others, null)
			statuses(FILTERED_STATUSES, size.filtered, null)
			for (const [id, content] of [
				[MEDIA_STATUS, '<p>#cats</p>'],
				[MENTION_STATUS, '<p>#cats @muted</p>'],
			]) {
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, created_at)
					VALUES (?, ?, ?, 'public', ?, ?, ?)`,
					id,
					`https://kopje.test/ap/o/${id}`,
					LOCAL_ID,
					content,
					at,
					at
				)
			}
			sql.exec("INSERT INTO status_tags (status_id, name, public) SELECT id, 'cats', 1 FROM statuses")
			sql.exec(
				"INSERT INTO media_attachments (id, account_id, status_id, type, url) VALUES ('799100000000000000', ?, ?, 'image', 'https://kopje.test/m')",
				LOCAL_ID,
				MEDIA_STATUS
			)
			sql.exec('INSERT INTO status_mentions (status_id, account_id, silent) VALUES (?, ?, 0)', MENTION_STATUS, MUTED_ID)
			sql.exec('INSERT INTO mutes (account_id, target_account_id) VALUES (?, ?)', VIEWER_ID, MUTED_ID)
			// The filtered accounts: blocked, muted and domain-blocked, a third each.
			sql.exec(
				`INSERT INTO blocks (account_id, target_account_id) SELECT ?1, id FROM accounts WHERE id GLOB '6992*' AND CAST(id AS INTEGER) % 3 = 0`,
				VIEWER_ID
			)
			sql.exec(
				`INSERT INTO mutes (account_id, target_account_id) SELECT ?1, id FROM accounts WHERE id GLOB '6992*' AND CAST(id AS INTEGER) % 3 = 1`,
				VIEWER_ID
			)
			sql.exec(
				`INSERT INTO domain_blocks (account_id, domain) SELECT ?1, domain FROM accounts WHERE id GLOB '6992*' AND CAST(id AS INTEGER) % 3 = 2`,
				VIEWER_ID
			)
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('stream-feeds', 'secret', 'stream-feeds', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'stream-feeds', ?, 'read')",
				TOKEN,
				VIEWER_ID
			)
		})
		return store
	}

	// The checks: [name, kind, status id, the event and streams it must make in the grown world].
	function checks(size: Size): [string, string, string, string, string[]][] {
		const author = (i: number) => String(AUTHOR_STATUSES + BigInt(i))
		const remote = ['hashtag:cats', 'public', 'public:remote']
		return [
			['newest of the author', 'status', author(size.perAuthor - 1), 'update', remote],
			['oldest of the author', 'status', author(0), 'update', remote],
			['an edit of the oldest', 'edit', author(0), 'status.update', remote],
			[
				'local with media',
				'status',
				MEDIA_STATUS,
				'update',
				['hashtag:cats', 'hashtag:local:cats', 'public', 'public:local', 'public:local:media', 'public:media'],
			],
			['a mention of a muted account', 'status', MENTION_STATUS, '', []],
			['a blocked author', 'status', String(FILTERED_STATUSES), '', []],
		]
	}

	it('reads the same rows with 20 or 2,000 statuses of the author, of others, and of accounts the viewer filters', async () => {
		const small: Size = { perAuthor: 20, others: 20, filtered: 21 }
		const large: Size = { perAuthor: 2000, others: 2000, filtered: 2001 }
		const few = await world(small)
		const many = await world(large)
		const unit = (kind: string, subject: string) => ({
			kind,
			subject,
			accountId: VIEWER_ID,
			tokenHashes: [TOKEN],
			feeds: FEEDS,
			now: NOW,
		})
		const grown: string[] = []
		const fewChecks = checks(small)
		for (const [i, [name, kind, subject, event, streams]] of checks(large).entries()) {
			// Not vacuous: each check in the grown world makes what it must.
			const made = await runInDurableObject(many, (_instance, state) =>
				streamUnit.run(state.storage.sql, unit(kind, subject))
			)
			expect([name, made.event, made.streams.map((s) => s.stream)]).toEqual([name, event, streams])
			const fewRows = await rowsRead({ store: few }, streamUnit, unit(kind, fewChecks[i]![2]))
			const manyRows = await rowsRead({ store: many }, streamUnit, unit(kind, subject))
			if (manyRows > fewRows + ALLOWANCE) {
				grown.push(`${name}: ${fewRows} -> ${manyRows}`)
			}
		}
		expect(grown).toEqual([])
	}, 120_000)

	it("captures a public status's tombstone in the same rows, however large its hashtag's timeline", async () => {
		const capture = readOperation<{ statusId: string }, null>((db, { statusId }) => {
			streamDelete(db, statusId, NOW)
			return null
		})
		const measure = async (size: Size) => {
			const store = await world(size)
			await runInDurableObject(store, (_instance, state) => {
				state.storage.sql.exec(
					"INSERT INTO stream_subscriptions (account_id, stream_key, sockets) VALUES (?1, 'public:local:media', 1), (?1, 'hashtag:cats', 1)",
					VIEWER_ID
				)
			})
			const rows = await rowsRead({ store }, capture, { statusId: MEDIA_STATUS })
			// Not vacuous: the tombstone and the feed's listener are captured.
			expect(
				await runInDurableObject(store, (_instance, state) =>
					state.storage.sql
						.exec(
							'SELECT t.local, t.media, t.tags, v.account_id FROM stream_delete_tombstones t JOIN stream_delete_viewers v USING (event_id)'
						)
						.toArray()
				)
			).toEqual([{ local: 1, media: 1, tags: '["cats"]', account_id: VIEWER_ID }])
			return rows
		}
		const few = await measure({ perAuthor: 20, others: 20, filtered: 21 })
		const many = await measure({ perAuthor: 2000, others: 2000, filtered: 2001 })
		expect(many).toBeLessThanOrEqual(few + ALLOWANCE)
	}, 120_000)
})

// The admin's list of reports (R37, GET /api/v1/admin/reports) reads one index range per filter, in id order: the
// unresolved reports through reports_state, a reporter's through reports_account_state, a reported account's through
// reports_target_state, and one reporter's of one account through reports_pair_state. Each case holds FEW matching
// reports, spread among `bulk` that do not match (the other state, other reporters, other accounts: with remote
// reporters, any number of them may report the account), and reads the same rows on the newest, a middle and the final
// page with 20 or 2,000 of them.
describe("the admin's report list reads a page, however many reports do not match (RES-7)", () => {
	const ADMIN_ID = '680000000000000000'
	const A = '680000000000000001'
	const B = '680000000000000002'
	const T = '681000000000000001'
	const U = '681000000000000002'
	const STATUS = '682000000000000001'
	const ADMIN_TOKEN = 'admin-reports-token'
	const FEW = 30
	const LIMIT = 10

	type Kind = { reporter: string; target: string; resolved: boolean }
	type Case = { name: string; filter: AdminReportFilter; match: Kind; bulk: Kind[] }

	const CASES: Case[] = [
		{
			name: 'unresolved',
			filter: { resolved: false, accountId: null, targetAccountId: null },
			match: { reporter: A, target: T, resolved: false },
			bulk: [{ reporter: A, target: T, resolved: true }],
		},
		{
			name: 'resolved',
			filter: { resolved: true, accountId: null, targetAccountId: null },
			match: { reporter: A, target: T, resolved: true },
			bulk: [{ reporter: B, target: U, resolved: false }],
		},
		{
			name: 'by reporter',
			filter: { resolved: false, accountId: A, targetAccountId: null },
			match: { reporter: A, target: T, resolved: false },
			bulk: [
				{ reporter: A, target: T, resolved: true },
				{ reporter: B, target: T, resolved: false },
			],
		},
		{
			name: 'by reported account',
			filter: { resolved: false, accountId: null, targetAccountId: T },
			match: { reporter: A, target: T, resolved: false },
			bulk: [
				{ reporter: A, target: T, resolved: true },
				{ reporter: A, target: U, resolved: false },
			],
		},
		{
			name: 'by both',
			filter: { resolved: false, accountId: A, targetAccountId: T },
			match: { reporter: A, target: T, resolved: false },
			bulk: [
				{ reporter: A, target: T, resolved: true },
				{ reporter: A, target: U, resolved: false },
				{ reporter: B, target: T, resolved: false },
				{ reporter: B, target: U, resolved: false },
			],
		},
	]

	// The FEW matching reports, each after `bulk / FEW` that do not match, in id order; each names the target's status.
	async function reports(c: Case, bulk: number): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec("INSERT INTO instance_settings (name, value) VALUES ('admin_email', 'admin@example.com')")
			for (const [id, name] of [
				[ADMIN_ID, 'admin'],
				[A, 'a'],
				[B, 'b'],
			] as const) {
				sql.exec(
					'INSERT INTO accounts (id, uri, username) VALUES (?, ?, ?)',
					id,
					`https://kopje.test/ap/users/${name}`,
					name
				)
				sql.exec(
					"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'test')",
					id,
					`${name}@example.com`
				)
			}
			for (const id of [T, U]) {
				sql.exec(
					"INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, 't', 'far.example')",
					id,
					`https://far.example/users/${id}`
				)
			}
			sql.exec(
				"INSERT INTO statuses (id, uri, account_id, visibility, content, published_at) VALUES (?, 'https://far.example/s/1', ?, 'public', '<p>x</p>', ?)",
				STATUS,
				T,
				new Date(NOW).toISOString()
			)
			const per = bulk / FEW
			const kinds = [...c.bulk, c.match]
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1),
				kinds(k, reporter, target, resolved) AS (SELECT key, value ->> '$.reporter', value ->> '$.target',
					value ->> '$.resolved' FROM json_each(?2))
				INSERT INTO reports (account_id, target_account_id, status_ids, uri, created_at, action_taken_at)
				SELECT kinds.reporter, kinds.target, json_array(?3), 'https://kopje.test/actor#reports/' || n.i, ?4,
					CASE WHEN kinds.resolved THEN ?4 END
				FROM n JOIN kinds ON kinds.k = CASE WHEN n.i % (?5 + 1) = ?5 THEN ?6 ELSE n.i % ?6 END
				ORDER BY n.i`,
				FEW * (per + 1),
				JSON.stringify(kinds),
				STATUS,
				new Date(NOW).toISOString(),
				per,
				c.bulk.length
			)
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('admin', 'secret', 'admin', 'urn:ietf:wg:oauth:2.0:oob', 'admin:read')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'admin', ?, 'admin:read')",
				ADMIN_TOKEN,
				ADMIN_ID
			)
		})
		return store
	}

	it('reads the same rows with 20 or 2,000 reports that do not match, on the newest, a middle and the final page', async () => {
		const credential = { tokenHash: ADMIN_TOKEN, scope: 'admin:read:reports', now: NOW } as const
		const grown: string[] = []
		for (const c of CASES) {
			const few = await reports(c, 20 * FEW)
			const many = await reports(c, 2000 * FEW)
			// The pages of each store, following next: the cursors strictly decrease, and only the last page is short.
			const walk = async (store: StoreStub) => {
				const inputs: unknown[] = []
				let maxId: string | undefined
				for (;;) {
					const input = { credential, filter: c.filter, page: { limit: LIMIT, maxId }, present: PRESENT }
					const page = await runInDurableObject(store, (_instance, state) =>
						listAdminReports.run(state.storage.sql, input)
					)
					if (page.status !== 'ok') {
						throw new Error(page.status)
					}
					expect(page.value.items.length, c.name).toBe(LIMIT)
					expect(page.value.items.every((report) => report.statuses.length === 1)).toBe(true)
					if (maxId !== undefined) {
						expect(BigInt(page.value.oldest!) < BigInt(maxId)).toBe(true)
					}
					inputs.push(input)
					maxId = page.value.oldest!
					if (!page.value.more) {
						break
					}
					if (inputs.length === FEW / LIMIT) {
						const end = await runInDurableObject(store, (_instance, state) =>
							listAdminReports.run(state.storage.sql, { ...input, page: { limit: LIMIT, maxId } })
						)
						expect(end).toMatchObject({ status: 'ok', value: { items: [], more: false } })
						break
					}
				}
				return inputs
			}
			const fewPages = await walk(few)
			const manyPages = await walk(many)
			expect(fewPages.length, c.name).toBe(FEW / LIMIT)
			for (const [i, input] of manyPages.entries()) {
				const fewRows = await rowsRead({ store: few }, listAdminReports, fewPages[i] as never)
				const manyRows = await rowsRead({ store: many }, listAdminReports, input as never)
				if (manyRows > fewRows + ALLOWANCE) {
					grown.push(`${c.name}, page ${i + 1}: ${fewRows} -> ${manyRows}`)
				}
			}
		}
		expect(grown).toEqual([])
	}, 300_000)
})

// The admin's list of accounts (R37, GET /api/v{1,2}/admin/accounts; design §5): the first rule of the filter drives
// the read. The local accounts (origin=local, email, staff or roles) are an operator-sized set; a username, display
// name or domain search reads one index range of at most ADMIN_ACCOUNT_CANDIDATES candidates; status=suspended reads
// the suspended local accounts and the accounts_deleted range in id order; anything else walks the primary key, newest
// first, skipping only local accounts (remote) or unavailable ones (active). Each case holds the same matches among 20
// or 2,000 times as many accounts that do not match (or, for the walks, that all match), and reads the same rows on
// the newest page, a middle one and the final one.
describe("the admin's account list reads a page, however many accounts do not match (RES-7)", () => {
	const ADMIN_ID = '690000000000000000'
	const ADMIN_TOKEN = 'admin-accounts-token'
	const FEW = 30
	const LIMIT = 10
	const NONE: AdminAccountFilter = {
		origin: null,
		status: null,
		roleIds: null,
		username: null,
		byDomain: null,
		displayName: null,
		email: null,
		ip: null,
		invitedBy: null,
	}

	// An account kind: a username (and display name) prefix, a domain (null: local), whether its deletion started, and
	// whether the instance suspended it (R38).
	type Kind = { username: string; domain: string | null; display: string; deleted?: boolean; suspended?: boolean }
	// `matching` selects the case's matches in SQL over `accounts a LEFT JOIN local_accounts l`.
	type Case = { name: string; filter: Partial<AdminAccountFilter>; match: Kind; bulk: Kind[]; matching: string }

	const remote = (username: string, domain = 'far.example', display = 'Bulk'): Kind => ({ username, domain, display })
	const CASES: Case[] = [
		{
			name: 'origin=local',
			filter: { origin: 'local' },
			match: { username: 'loc', domain: null, display: 'Loc' },
			bulk: [remote('rem')],
			matching: 'a.domain IS NULL',
		},
		{
			name: 'email',
			filter: { email: 'LOC' },
			match: { username: 'loc', domain: null, display: 'Loc' },
			bulk: [remote('rem')],
			matching: "l.email LIKE 'loc%'",
		},
		{
			name: 'staff',
			filter: { roleIds: ['3'] },
			match: { username: 'loc', domain: null, display: 'Loc' },
			bulk: [remote('rem')],
			matching: `a.id = '${ADMIN_ID}'`,
		},
		{
			name: 'username',
			filter: { username: 'Match' },
			match: remote('match'),
			bulk: [remote('bulk'), remote('other')],
			matching: "a.username LIKE 'match%'",
		},
		{
			name: 'username within a domain',
			filter: { username: 'match', byDomain: 'm.example' },
			match: remote('match', 'm.example'),
			bulk: [remote('match', 'o.example'), remote('bulk', 'm.example')],
			matching: "a.username LIKE 'match%' AND a.domain = 'm.example'",
		},
		{
			name: 'display_name',
			filter: { displayName: 'match' },
			match: remote('r', 'far.example', 'Match'),
			bulk: [remote('r', 'far.example', 'Bulk')],
			matching: "a.display_name LIKE 'Match%'",
		},
		{
			name: 'by_domain',
			filter: { byDomain: 'm.example' },
			match: remote('r', 'm.example'),
			bulk: [remote('r', 'o.example'), remote('r', 'p.example')],
			matching: "a.domain = 'm.example'",
		},
		{
			name: 'status=suspended',
			filter: { status: 'suspended' },
			match: { ...remote('gone'), deleted: true },
			bulk: [remote('r')],
			matching: 'a.deleted_at IS NOT NULL OR a.suspended_at IS NOT NULL OR l.suspended_at IS NOT NULL',
		},
		{
			name: 'status=suspended among remote accounts the instance suspended',
			filter: { status: 'suspended' },
			match: { ...remote('gone'), deleted: true },
			bulk: [{ ...remote('held'), suspended: true }, remote('r')],
			matching: 'a.deleted_at IS NOT NULL OR a.suspended_at IS NOT NULL OR l.suspended_at IS NOT NULL',
		},
		{
			name: 'status=suspended, a remote account the instance suspended',
			filter: { status: 'suspended' },
			match: { ...remote('held'), suspended: true },
			bulk: [remote('r')],
			matching: 'a.deleted_at IS NOT NULL OR a.suspended_at IS NOT NULL OR l.suspended_at IS NOT NULL',
		},
		{
			name: 'status=pending (nothing to read)',
			filter: { status: 'pending' },
			match: remote('r'),
			bulk: [remote('r')],
			matching: '0',
		},
		{ name: 'no filter', filter: {}, match: remote('r'), bulk: [remote('r')], matching: '1' },
		{
			name: 'origin=remote',
			filter: { origin: 'remote' },
			match: remote('r'),
			bulk: [remote('r')],
			matching: 'a.domain IS NOT NULL',
		},
		{
			name: 'status=active',
			filter: { status: 'active' },
			match: remote('r'),
			bulk: [remote('r')],
			matching: 'a.deleted_at IS NULL AND a.suspended_at IS NULL AND l.suspended_at IS NULL',
		},
		// The active walk among many remote accounts the instance suspended (R38).
		{
			name: 'status=active among suspended remote accounts',
			filter: { status: 'active' },
			match: remote('r'),
			bulk: [{ ...remote('held'), suspended: true }],
			matching: 'a.deleted_at IS NULL AND a.suspended_at IS NULL AND l.suspended_at IS NULL',
		},
		// The active walks among many remote accounts whose deletion has started (awaiting their purge).
		{
			name: 'status=active among accounts being deleted',
			filter: { status: 'active' },
			match: remote('r'),
			bulk: [{ ...remote('gone'), deleted: true }],
			matching: 'a.deleted_at IS NULL AND a.suspended_at IS NULL AND l.suspended_at IS NULL',
		},
		{
			name: 'origin=remote, status=active among accounts being deleted',
			filter: { origin: 'remote', status: 'active' },
			match: remote('r'),
			bulk: [{ ...remote('gone'), deleted: true }],
			matching: 'a.domain IS NOT NULL AND a.deleted_at IS NULL AND a.suspended_at IS NULL',
		},
	]

	// The admin, then `few` accounts of the matching kind among `bulk` of the other kinds: each match after bulk / few of
	// them in id order (interleaved), or all of them first.
	async function accountsStore(
		c: Pick<Case, 'match' | 'bulk'>,
		bulk: number,
		few = FEW,
		interleaved = true
	): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec("INSERT INTO instance_settings (name, value) VALUES ('admin_email', 'admin@example.com')")
			sql.exec(
				"INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/admin', 'admin')",
				ADMIN_ID
			)
			const per = interleaved ? bulk / few : 0
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1),
				kinds(k, username, domain, display, deleted, suspended) AS (SELECT key, value ->> '$.username',
					value ->> '$.domain', value ->> '$.display', value ->> '$.deleted', value ->> '$.suspended' FROM json_each(?2))
				INSERT INTO accounts (id, uri, username, domain, display_name, deleted_at, suspended_at, suspension_source)
				SELECT printf('%018d', 691000000000000000 + n.i),
					'https://' || coalesce(kinds.domain, 'kopje.test') || '/users/x' || n.i, kinds.username || n.i, kinds.domain,
					kinds.display || ' ' || n.i, CASE WHEN kinds.deleted THEN ?3 END, CASE WHEN kinds.suspended THEN ?3 END,
					CASE WHEN kinds.suspended THEN 'account' END
				FROM n JOIN kinds ON kinds.k = CASE
					WHEN ?7 THEN CASE WHEN n.i % (?4 + 1) = ?4 THEN ?5 ELSE n.i % ?5 END
					ELSE CASE WHEN n.i < ?6 THEN ?5 ELSE n.i % ?5 END END`,
				interleaved ? few * (per + 1) : bulk + few,
				JSON.stringify([...c.bulk, c.match]),
				new Date(NOW).toISOString(),
				per,
				c.bulk.length,
				few,
				interleaved ? 1 : 0
			)
			sql.exec(
				`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
				SELECT id, username || '@example.com', X'00', X'00', 'test' FROM accounts WHERE domain IS NULL`
			)
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('admin', 'secret', 'admin', 'urn:ietf:wg:oauth:2.0:oob', 'admin:read')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'admin', ?, 'admin:read')",
				ADMIN_TOKEN,
				ADMIN_ID
			)
		})
		return store
	}

	const credential = { tokenHash: ADMIN_TOKEN, scope: 'admin:read:accounts', now: NOW } as const
	const inputOf = (filter: Partial<AdminAccountFilter>, maxId?: string) => ({
		credential,
		filter: { ...NONE, ...filter },
		page: { limit: LIMIT, maxId },
		present: PRESENT,
	})

	async function list(
		store: StoreStub,
		filter: Partial<AdminAccountFilter>,
		maxId?: string
	): Promise<AdminAccountList> {
		const answer = await runInDurableObject(store, (_instance, state) =>
			listAdminAccounts.run(state.storage.sql, inputOf(filter, maxId))
		)
		if (answer.status !== 'ok') {
			throw new Error(answer.status)
		}
		return answer.value
	}

	const matchIds = async (store: StoreStub, matching: string) =>
		(
			await runInDurableObject(store, (_instance, state) =>
				state.storage.sql
					.exec<{ id: string }>(
						`SELECT a.id FROM accounts a LEFT JOIN local_accounts l ON l.account_id = a.id WHERE ${matching} ORDER BY a.id DESC`
					)
					.toArray()
			)
		).map((row) => row.id)

	it('reads the same rows with 20 or 2,000 times as many accounts, on the newest, a middle and the final page', async () => {
		const grown: string[] = []
		for (const c of CASES) {
			const few = await accountsStore(c, 20 * FEW)
			const many = await accountsStore(c, 2000 * FEW)
			// The few store's pages, following next: full until the last, the cursor strictly decreasing.
			const all = await matchIds(few, c.matching)
			const walked: string[] = []
			let maxId: string | undefined
			for (;;) {
				const page = await list(few, c.filter, maxId)
				expect(page.status, c.name).toBe('ok')
				if (page.status !== 'ok') {
					break
				}
				const ids = page.items.map((account) => account.id)
				walked.push(...ids)
				if (!page.more) {
					expect(walked.length, c.name).toBe(all.length)
					break
				}
				expect(ids.length, c.name).toBe(LIMIT)
				expect(maxId === undefined || page.oldest! < maxId, c.name).toBe(true)
				maxId = page.oldest!
			}
			expect(walked, c.name).toEqual(all)
			// The newest, a middle and the final page of each store: the expected accounts, and the same rows read.
			const read: number[][] = []
			for (const store of [few, many]) {
				const ids = store === few ? all : await matchIds(many, c.matching)
				const cursors = ids.length < 5 ? [undefined] : [undefined, ids[Math.floor(ids.length / 2)], ids.at(-5)]
				const rows: number[] = []
				for (const cursor of cursors) {
					const from = cursor === undefined ? 0 : ids.indexOf(cursor) + 1
					const page = await list(store, c.filter, cursor)
					expect(page, c.name).toMatchObject({ status: 'ok', more: from + LIMIT < ids.length })
					expect(page.status === 'ok' ? page.items.map((account) => account.id) : page.status, c.name).toEqual(
						ids.slice(from, from + LIMIT)
					)
					rows.push(await rowsRead({ store }, listAdminAccounts, inputOf(c.filter, cursor)))
				}
				read.push(rows)
			}
			for (const [n, manyRows] of read[1]!.entries()) {
				const fewRows = read[0]![n]!
				if (manyRows > fewRows + ALLOWANCE) {
					grown.push(`${c.name}, cursor ${n}: ${fewRows} -> ${manyRows}`)
				}
			}
		}
		expect(grown).toEqual([])
	}, 600_000)

	it('answers a search of zero or one match, and more than ADMIN_ACCOUNT_CANDIDATES as too broad', async () => {
		const searches: [string, Partial<AdminAccountFilter>][] = [
			['username', { username: 'match' }],
			['username within a domain', { username: 'match', byDomain: 'm.example' }],
			['display_name', { displayName: 'Match' }],
			['by_domain', { byDomain: 'm.example' }],
		]
		const kinds = { match: remote('match', 'm.example', 'Match'), bulk: [remote('bulk', 'o.example')] }
		for (const count of [0, 1, ADMIN_ACCOUNT_CANDIDATES + 1]) {
			const store = await accountsStore(kinds, 2000, count, false)
			for (const [name, filter] of searches) {
				const answer = await runInDurableObject(store, (_instance, state) =>
					listAdminAccounts.run(state.storage.sql, inputOf(filter))
				)
				if (count > ADMIN_ACCOUNT_CANDIDATES) {
					expect(answer, name).toEqual({ status: 'ok', value: { status: 'too_broad' } })
				} else {
					expect(answer, name).toMatchObject({ status: 'ok', value: { status: 'ok', more: false } })
					expect(answer.status === 'ok' && answer.value.status === 'ok' && answer.value.items.length, name).toBe(count)
				}
			}
		}
	}, 120_000)
})

// Received quotes (src/domain/quotes.ts) carry their verification work in their rows, and a stamp's Delete names them
// by its URI: both are counts others control (any server may send quotes, and may name any stamp in them). A job
// round's claim seeks the due work through quotes_due and takes QUOTE_ROUND; a stamp's Delete, revoking or (relayed
// without the author's proof) checking again, seeks the quotes of its author's statuses through quotes_approval and
// never reads the quotes of others naming the same stamp; a status stored links at most MAX_LINKED_QUOTES of the
// unresolved quotes naming it; a quote's work reads its own row and its quoted status, however often that is quoted.
describe('received quotes cost their work a bounded read (RES-7)', () => {
	const CAROL = '970000000000000001'
	const DAN = '970000000000000002'
	const BOB = '970000000000000003'
	const CAROL_URI = 'https://other.example/users/carol'
	const TARGET = '971000000000000000'
	const TARGET_URI = `${CAROL_URI}/statuses/target`
	const LATER = '972000000000000000'
	const LATER_URI = `${CAROL_URI}/statuses/later`
	const STAMP = `${CAROL_URI}/quote_authorizations/1`
	const QUOTING_BASE = 973000000000000000n
	const FIRST = String(QUOTING_BASE)

	// carol's status, quoted by bob three times naming carol's stamp (the first accepted: the quotes the Delete is about),
	// and `count` more quotes by bob of each kind: of dan's status naming the same stamp, of carol's naming no stamp,
	// with work due, with work held by a round's lease, and unresolved, naming the uri of carol's status stored later.
	async function quoted(count: number): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			for (const [id, name] of [
				[CAROL, 'carol'],
				[DAN, 'dan'],
				[BOB, 'bob'],
			] as const) {
				sql.exec(
					"INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, ?, 'other.example')",
					id,
					`https://other.example/users/${name}`,
					name
				)
			}
			sql.exec(
				`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at) VALUES
				(?1, ?2, ?3, 'public', '', '2026-10-01T00:00:00.000Z'),
				('971000000000000001', 'https://other.example/users/dan/statuses/1', ?4, 'public', '', '2026-10-01T00:00:00.000Z')`,
				TARGET,
				TARGET_URI,
				CAROL,
				DAN
			)
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 * 4 + 3 - 1)
				INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				SELECT CAST(?2 + i AS TEXT), 'https://other.example/users/bob/statuses/q' || i, ?3, 'public', '',
					'2026-10-01T00:00:00.000Z' FROM n`,
				count,
				FIRST,
				BOB
			)
			// k: 0 the three quotes of carol's status naming her stamp, then the other kinds in turn.
			sql.exec(
				`INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, approval_uri,
					verify_after, updated_at)
				SELECT id,
					CASE k WHEN 1 THEN 'https://other.example/users/dan/statuses/1' WHEN 4 THEN ?9 ELSE ?1 END,
					CASE k WHEN 1 THEN '971000000000000001' WHEN 4 THEN NULL ELSE ?2 END,
					CASE k WHEN 1 THEN ?5 WHEN 4 THEN NULL ELSE ?3 END,
					CASE WHEN n = 0 THEN 'accepted' ELSE 'pending' END,
					CASE WHEN k IN (0, 1) THEN ?4 END,
					CASE k WHEN 2 THEN ?6 WHEN 3 THEN ?7 END,
					'2026-10-01T00:00:00.000Z'
				FROM (SELECT id, n, CASE WHEN n < 3 THEN 0 ELSE (n - 3) % 4 + 1 END AS k
					FROM (SELECT id, CAST(id AS INTEGER) - ?8 AS n FROM statuses WHERE account_id = ?10))`,
				TARGET_URI,
				TARGET,
				CAROL,
				STAMP,
				DAN,
				NOW - 1,
				NOW + 60_000,
				FIRST,
				LATER_URI,
				BOB
			)
			sql.exec(
				"INSERT INTO statuses (id, uri, account_id, visibility, content, published_at) VALUES (?, ?, ?, 'public', '', '2026-10-01T00:00:00.000Z')",
				LATER,
				LATER_URI,
				CAROL
			)
		})
		return store
	}

	const revoke = writeOperation<void, unknown>((db) =>
		revokeStamp(db, { id: CAROL, uri: CAROL_URI }, STAMP, () => PURGE_BATCH, NOW)
	)
	const recheck = writeOperation<void, unknown>((db) => recheckStamp(db, { id: CAROL }, STAMP, NOW))
	const link = writeOperation<void, unknown>((db) => {
		linkQuotes(db, { id: LATER, uri: LATER_URI }, NOW)
	})

	it('reads the same rows with 400 or 4,000 quotes of each kind', async () => {
		const cases: [string, StoreOperation<never, unknown>, unknown][] = [
			['claim', claimQuotes, { now: NOW, limit: QUOTE_ROUND }],
			['revoke', revoke, undefined],
			['recheck', recheck, undefined],
			['link', link, undefined],
			['work', quoteWork, { statusId: FIRST, now: NOW }],
		]
		const grown: string[] = []
		const outputs: Record<string, { output: unknown; states: unknown[]; linked: unknown[] }> = {}
		for (const [name, operation, input] of cases) {
			const few = await rowsTouched(await quoted(400), operation, input as never)
			const many = await rowsTouched(await quoted(4000), operation, input as never)
			if (many > few + ALLOWANCE) {
				grown.push(`${name}: ${few} -> ${many}`)
			}
			const store = await quoted(4000)
			outputs[name] = await runInDurableObject(store, (_instance, state) => ({
				output: operation.run(state.storage.sql, input as never),
				states: state.storage.sql
					.exec('SELECT state, count(*) AS n FROM quotes WHERE approval_uri IS NOT NULL GROUP BY state ORDER BY state')
					.toArray(),
				linked: state.storage.sql.exec('SELECT count(*) AS n FROM quotes WHERE quoted_status_id = ?', LATER).toArray(),
			}))
		}
		expect(grown).toEqual([])
		// Not vacuous: each did its work on the rows that concern it, and only those.
		expect(outputs.claim!.output).toMatchObject({ ids: expect.any(Array), more: true })
		expect((outputs.claim!.output as { ids: string[] }).ids).toHaveLength(QUOTE_ROUND)
		expect(outputs.revoke!.states).toEqual([
			{ state: 'pending', n: 4000 },
			{ state: 'rejected', n: 2 },
			{ state: 'revoked', n: 1 },
		])
		expect(outputs.recheck!.output).toBe(true)
		expect(outputs.link!.linked).toEqual([{ n: MAX_LINKED_QUOTES }])
		expect(outputs.work!.output).toMatchObject({ quotedUri: TARGET_URI, approvalUri: STAMP })
	}, 120_000)
})

// Quotes shown and listed (R35): the account rows, a viewer token and the quote rows each case needs.
function quoteWorld(sql: SqlStorage, viewer: string, token: string, remotes: readonly [string, string][]): void {
	sql.exec(
		"INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/viewer', 'viewer')",
		viewer
	)
	sql.exec(
		"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'viewer@example.com', X'00', X'00', 'test')",
		viewer
	)
	for (const [id, domain] of remotes) {
		sql.exec(
			'INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, ?, ?)',
			id,
			`https://${domain}/users/u${id}`,
			`u${id}`,
			domain
		)
	}
	sql.exec(
		"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('quotes', 'secret', 'quotes', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
	)
	sql.exec(
		"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'quotes', ?, 'read')",
		token,
		viewer
	)
}

// Statuses (id, author, visibility) and the quotes they make (quoting status, quoted status, state), in two statements.
function quoteRows(
	sql: SqlStorage,
	statuses: readonly { id: string; author: string }[],
	quotes: readonly { status: string; quoted: string; state: string }[]
): void {
	sql.exec(
		`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
		SELECT json_extract(value, '$.id'), 'https://remote.example/s/' || json_extract(value, '$.id'),
			json_extract(value, '$.author'), 'public', '<p>status</p>', '2026-10-01T00:00:00.000Z'
		FROM json_each(?)`,
		JSON.stringify(statuses)
	)
	sql.exec(
		`INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, updated_at)
		SELECT json_extract(value, '$.status'), 'https://remote.example/s/' || json_extract(value, '$.quoted'),
			json_extract(value, '$.quoted'), (SELECT account_id FROM statuses WHERE id = json_extract(value, '$.quoted')),
			json_extract(value, '$.state'), '2026-10-01T00:00:00.000Z'
		FROM json_each(?)`,
		JSON.stringify(quotes)
	)
}

// A page of statuses shows each one's quote and the quoted status one level deep (status-presenter.ts): two reads of
// quote rows by the page's ids, never the quoted status's own quotes or the chain it starts.
describe('statuses with quotes are presented from their quote rows (RES-7)', () => {
	const VIEWER = '980000000000000000'
	const AUTHOR = '980000000000000001'
	const QUOTED_AUTHOR = '980000000000000002'
	const OTHERS = '980000000000000003'
	const TOKEN = 'quotes-page-token'
	const page = (i: number) => String(981000000000000000n + BigInt(i))
	const TARGET = '982000000000000000'
	const chain = (i: number) => String(983000000000000000n + BigInt(i))
	const other = (i: number) => String(984000000000000000n + BigInt(i))

	// AUTHOR's 20 statuses each quote TARGET, which `quoted` statuses quote in all, and which quotes the first status of
	// a chain `depth` long, all accepted.
	async function quoting(quoted: number, depth: number): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			quoteWorld(sql, VIEWER, TOKEN, [
				[AUTHOR, 'author.example'],
				[QUOTED_AUTHOR, 'quoted.example'],
				[OTHERS, 'others.example'],
			])
			const links = Array.from({ length: depth }, (_, i) => i)
			const others = Array.from({ length: quoted - 20 }, (_, i) => i)
			quoteRows(
				sql,
				[
					{ id: TARGET, author: QUOTED_AUTHOR },
					...links.map((i) => ({ id: chain(i), author: QUOTED_AUTHOR })),
					...Array.from({ length: 20 }, (_, i) => ({ id: page(i), author: AUTHOR })),
					...others.map((i) => ({ id: other(i), author: OTHERS })),
				],
				[
					...links.map((i) => ({ status: i === 0 ? TARGET : chain(i - 1), quoted: chain(i), state: 'accepted' })),
					...Array.from({ length: 20 }, (_, i) => ({ status: page(i), quoted: TARGET, state: 'accepted' })),
					...others.map((i) => ({ status: other(i), quoted: TARGET, state: 'accepted' })),
				]
			)
		})
		return store
	}

	it('reads the same rows with the quoted status quoted 20 or 2,000 times, on a chain 2 or 200 deep', async () => {
		const credential = { tokenHash: TOKEN, scope: 'read', now: NOW } as const
		const list = {
			credential,
			now: NOW,
			account: AUTHOR,
			page: PAGE,
			onlyMedia: false,
			excludeReblogs: false,
			excludeReplies: false,
			pinned: false,
			tagged: null,
			present: PRESENT,
		}
		const one = { credential, id: page(0), now: NOW, present: PRESENT }
		const measured: number[][] = []
		for (const [quoted, depth] of [
			[20, 2],
			[2000, 200],
		] as const) {
			const store = await quoting(quoted, depth)
			const output = await runInDurableObject(store, (_instance, state) => accountStatuses.run(state.storage.sql, list))
			const items = output.status === 'ok' ? (output.value?.items ?? []) : []
			// Not vacuous: every status shows the quoted status with its count and, as a ShallowQuote, the chain's first.
			expect(items).toHaveLength(20)
			for (const status of items) {
				expect(status.quote).toMatchObject({
					state: 'accepted',
					quoted_status: { id: TARGET, quotes_count: quoted, quote: { state: 'accepted', quoted_status_id: chain(0) } },
				})
			}
			measured.push([await rowsRead({ store }, accountStatuses, list), await rowsRead({ store }, getStatus, one)])
		}
		const [few = [], many = []] = measured
		const grown = ['page', 'status'].flatMap((name, k) =>
			(many[k] ?? Infinity) <= (few[k] ?? 0) + ALLOWANCE ? [] : [`${name}: ${few[k]} -> ${many[k]}`]
		)
		expect(grown).toEqual([])
	}, 120_000)
})

// The quotes list reads one window of a status's accepted quotes from its cursor (quotes_accepted, migration
// 0036_quotes_list) and applies the rule to that window only (statuses.ts statusQuotes): the same rows however many
// quotes the status has in any state, and however many of them the viewer may not list, which cost a request at most
// the window and empty pages whose next link moves on by it.
describe('the quotes list reads a window, however many quotes a status has (RES-7)', () => {
	const VIEWER = '985000000000000000'
	const QUOTED_AUTHOR = '985000000000000001'
	const QUOTER = '985000000000000002'
	const BLOCKED = '985000000000000003'
	const TOKEN = 'quotes-list-token'
	const TARGET = '986000000000000000'
	const quoting = (i: number) => String(987000000000000000n + BigInt(i))
	const credential = { tokenHash: TOKEN, scope: 'read', now: NOW } as const
	const input = (page: PageQuery) => ({ credential, id: TARGET, page, now: NOW, present: PRESENT })

	// TARGET's quotes, by quoting status id in order, each by QUOTER (listed), by BLOCKED (whom the viewer blocks), or in
	// another state than accepted.
	async function quoted(
		kinds: readonly ('listed' | 'blocked' | 'pending' | 'rejected' | 'revoked')[]
	): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			quoteWorld(sql, VIEWER, TOKEN, [
				[QUOTED_AUTHOR, 'quoted.example'],
				[QUOTER, 'quoter.example'],
				[BLOCKED, 'blocked.example'],
			])
			sql.exec('INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)', VIEWER, BLOCKED)
			quoteRows(
				sql,
				[
					{ id: TARGET, author: QUOTED_AUTHOR },
					...kinds.map((kind, i) => ({ id: quoting(i), author: kind === 'blocked' ? BLOCKED : QUOTER })),
				],
				kinds.map((kind, i) => ({
					status: quoting(i),
					quoted: TARGET,
					state: kind === 'listed' || kind === 'blocked' ? 'accepted' : kind,
				}))
			)
		})
		return store
	}

	type Listed = { items: { id: string }[]; newest: string | null; oldest: string | null; candidates: number }

	async function list(store: StoreStub, page: PageQuery): Promise<Listed> {
		const output = await runInDurableObject(store, (_instance, state) =>
			statusQuotes.run(state.storage.sql, input(page))
		)
		expect(output).toMatchObject({ status: 'ok', value: { status: 'ok' } })
		return output.status === 'ok' && output.value.status === 'ok'
			? output.value.value
			: { items: [], newest: null, oldest: null, candidates: 0 }
	}

	it('reads the same rows with 20 or 2,000 listed quotes and 2,000 in other states, on the newest, a middle and the oldest page', async () => {
		// Listed quotes every third id, the other states between them, then the rest of the other states beyond them.
		const layout = (listed: number) =>
			Array.from({ length: Math.max(3 * listed, 3000) }, (_, i) =>
				i % 3 === 0 && i / 3 < listed ? 'listed' : (['pending', 'rejected', 'revoked'] as const)[i % 3]!
			).slice(0, Math.max(3 * listed, 2000 + listed))
		const few = await quoted(layout(20))
		const many = await quoted(layout(2000))
		const pages: PageQuery[] = [PAGE, { ...PAGE, maxId: quoting(3000) }, { ...PAGE, minId: '1' }]
		const grown: string[] = []
		for (const page of pages) {
			for (const store of [few, many]) {
				const shownPage = await list(store, page)
				expect([JSON.stringify(page), shownPage.items.length]).toEqual([JSON.stringify(page), 20])
			}
			const fewRows = await rowsRead({ store: few }, statusQuotes, input(page))
			const manyRows = await rowsRead({ store: many }, statusQuotes, input(page))
			if (manyRows > fewRows + ALLOWANCE) {
				grown.push(`${JSON.stringify(page)}: ${fewRows} -> ${manyRows}`)
			}
		}
		expect(grown).toEqual([])
	}, 120_000)

	it('answers empty pages whose next link moves on by the window when 2,000 quotes are hidden', async () => {
		const few = await quoted(Array.from({ length: 40 }, () => 'blocked' as const))
		const many = await quoted(Array.from({ length: 2000 }, () => 'blocked' as const))
		let cursor: PageQuery = PAGE
		for (let request = 1; request <= 3; request++) {
			const shownPage = await list(many, cursor)
			// Empty, with the window's bounds: the next page starts below the window's oldest candidate.
			expect(shownPage).toEqual({
				items: [],
				newest: quoting(2000 - 1 - (request - 1) * 20),
				oldest: quoting(2000 - request * 20),
				candidates: 20,
			})
			expect(await rowsRead({ store: many }, statusQuotes, input(cursor))).toBeLessThanOrEqual(
				(await rowsRead({ store: few }, statusQuotes, input(PAGE))) + ALLOWANCE
			)
			cursor = { ...PAGE, maxId: shownPage.oldest ?? undefined }
		}
		// The quoted author lists them all (R2): the window's quotes.
		await runInDurableObject(many, (_instance, state) => {
			state.storage.sql.exec('UPDATE statuses SET account_id = ? WHERE id = ?', VIEWER, TARGET)
		})
		expect((await list(many, PAGE)).items).toHaveLength(20)
	}, 120_000)

	it('reaches one listed quote behind 1,000 hidden ones a window per request, each reading at most a window', async () => {
		const store = await quoted(['listed', ...Array.from({ length: 1000 }, () => 'blocked' as const)])
		let cursor: PageQuery = PAGE
		const reads: number[] = []
		let requests = 0
		let found: string[] = []
		while (found.length === 0) {
			requests++
			expect(requests).toBeLessThanOrEqual(1000 / PAGE.limit + 1)
			const shownPage = await list(store, cursor)
			found = shownPage.items.map((item) => item.id)
			reads.push(await rowsRead({ store }, statusQuotes, input(cursor)))
			cursor = { ...PAGE, maxId: shownPage.oldest ?? undefined }
		}
		expect(found).toEqual([quoting(0)])
		expect(requests).toBe(1000 / PAGE.limit + 1)
		// Each request reads at most what the first does; the last, a window of one, reads less.
		expect(Math.max(...reads)).toBeLessThanOrEqual((reads[0] ?? 0) + ALLOWANCE)
	}, 120_000)
})
