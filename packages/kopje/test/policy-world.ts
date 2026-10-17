import fc from 'fast-check'
import { inject } from 'vitest'

import type { Visibility } from '../src/domain/audience'
import type { RepliesPolicy } from '../src/domain/lists'

// A generated world for the policy oracle (test/policy-oracle.test.ts) and the bounds harness
// (test/policy-bounds.test.ts): local accounts (one of them may be suspended, some may hide their network), remote
// accounts on two domains (one of them may be being deleted, its statuses and edges still stored, and some may hide
// their network, as Kopje learned of them), statuses of every
// visibility with mentions (some silent), boosts and replies (some to a status never stored, and some continuing such
// a reply, as a purge leaves a reply to the account it removes), and the edges the rules read: follows (pending and
// accepted), blocks both ways, mutes with and without an expiry and with and without notifications, and domain blocks
// in their stored form; and local accounts' lists, exclusive or not, with each replies_policy, whose members are their
// owner and accounts it follows, accepted or pending (whatever else the owner blocks, mutes or domain-blocks); and the
// local accounts that follow the hashtag tagged statuses carry; and quotes (R35) in every stored state, legacy or not,
// self-quotes among them, of statuses of every visibility, and quotes whose quoted status is gone. Accounts, statuses
// and lists are referred to by index; writeWorld gives them fixed ids.

declare module 'vitest' {
	interface ProvidedContext {
		// FC_SEED from the environment (vitest.config.ts), to replay a run fast-check reported.
		fcSeed: string
	}
}

// fast-check's parameters for a property: its case count, and the seed FC_SEED gives, else `seed` if given (a property
// whose coverage must not depend on chance), else a random one.
export function runs(numRuns: number, seed?: number): fc.Parameters<unknown> {
	const given = inject('fcSeed')
	if (given !== '') {
		return { numRuns, seed: Number(given) }
	}
	return seed === undefined ? { numRuns } : { numRuns, seed }
}

const LOCALS = 4
const INSTANCE_DOMAIN = 'kopje.test'
export const REMOTE_DOMAINS = ['one.example', 'two.example'] as const
// What a domain block may name: each remote domain, the hosts some actor ids live on, the instance's own domain and a
// domain nobody lives on.
export const BLOCKABLE_DOMAINS = [
	...REMOTE_DOMAINS,
	'social.one.example',
	'social.two.example',
	INSTANCE_DOMAIN,
	'three.example',
] as const

const VISIBILITIES: readonly Visibility[] = ['public', 'unlisted', 'private', 'direct', 'limited']
const REPLIES_POLICIES: readonly RepliesPolicy[] = ['followed', 'list', 'none']
// The times a world may be judged at, an hour apart, so a mute's expiry falls before, at or after them.
const TIMES = ['2026-10-12T00:00:00.000Z', '2026-10-12T01:00:00.000Z', '2026-10-12T02:00:00.000Z'] as const
const HOUR_MS = 3_600_000

type WorldAccount = {
	name: string
	local: boolean
	suspended: boolean
	// Remote accounts only: its deletion has started (accounts.deleted_at), and its purge has removed nothing yet.
	deleting: boolean
	// hide_collections: a local account's setting, or what Kopje learned of a remote account's.
	hidesCollections: boolean
	// Remote accounts only: the stored domain. The actor id's host may differ from it (see HOSTS).
	domain: string | null
	uri: string
}

export type WorldStatus = {
	name: string
	author: number
	visibility: Visibility
	mentions: { account: number; silent: boolean }[]
	reblogOf: number | null
	replyTo: number | null
	// A reply to a status the server never stored (replyTo is null): its parent and partner are unknown.
	replyToUnknown: boolean
	tagged: boolean
}

// How an actor id's host relates to the account's stored domain: the same, a subdomain, with a port, with a trailing
// dot (alone or with a subdomain and a port), or the other remote domain (a domain confirmed elsewhere).
const HOSTS = ['same', 'subdomain', 'port', 'dotted', 'subdomain-dotted-port', 'elsewhere'] as const

function actorHost(form: (typeof HOSTS)[number], domain: string): string {
	switch (form) {
		case 'same':
			return domain
		case 'subdomain':
			return `social.${domain}`
		case 'port':
			return `${domain}:8443`
		case 'dotted':
			return `${domain}.`
		case 'subdomain-dotted-port':
			return `social.${domain}.:8443`
		case 'elsewhere':
			return REMOTE_DOMAINS.find((other) => other !== domain) ?? domain
	}
}

// The stored states of a quote (migration 0033_quotes).
export const QUOTE_STATES = ['pending', 'accepted', 'rejected', 'revoked', 'deleted'] as const

// A quote by the status `status` of the status `quoted` (an original, never itself; null: the quoted status is gone,
// as a detach leaves it, never accepted). legacy: the Note had no `quote` property.
export type WorldQuote = {
	status: number
	quoted: number | null
	state: (typeof QUOTE_STATES)[number]
	legacy: boolean
}

// A list of a local account. Its members are the owner or accounts the owner follows (in either state): a Store holds
// no other (migration 0007_list_members, the converter), so the world has none.
export type WorldList = {
	owner: number
	repliesPolicy: RepliesPolicy
	exclusive: boolean
	members: number[]
}

export type World = {
	accounts: WorldAccount[]
	statuses: WorldStatus[]
	follows: { from: number; to: number; accepted: boolean; showReblogs: boolean; notify: boolean }[]
	blocks: { from: number; to: number }[]
	mutes: { from: number; to: number; expiresAt: string | null; hideNotifications: boolean }[]
	domainBlocks: { owner: number; domain: string }[]
	lists: WorldList[]
	// Pins of accounts' own originals that are not direct or limited, as the API makes them for a local account and
	// Kopje learns them of a remote one.
	pins: { account: number; status: number }[]
	// Local accounts' conversation mutes, each of a thread (statuses.thread) of the world's statuses.
	conversationMutes: { account: number; thread: string }[]
	// Local accounts that follow the hashtag the world's tagged statuses carry.
	tagFollowers: number[]
	// Quotes, at most one by each status (an original).
	quotes: WorldQuote[]
	now: string
}

const ACCOUNT_BASE = 100000000000000000n
const STATUS_BASE = 200000000000000000n
const LIST_BASE = 600000000000000000n

export function accountId(index: number): string {
	return String(ACCOUNT_BASE + BigInt(index))
}

export function statusId(index: number): string {
	return String(STATUS_BASE + BigInt(index))
}

export function listId(index: number): string {
	return String(LIST_BASE + BigInt(index))
}

// The uri writeWorld gives a status, and the uri of the status never stored that a reply to one names.
export function statusUri(index: number): string {
	return `https://${INSTANCE_DOMAIN}/ap/o/${index}`
}

export function unknownParentUri(index: number): string {
	return `https://elsewhere.example/objects/${index}`
}

// The thread of a status (statuses.thread, which a reply takes from its parent when it is stored): the uri of the
// status its reply chain starts at, or, when that one replies to a status never stored, the uri it names.
export function threadOf(statuses: readonly WorldStatus[], s: number): string {
	let at = s
	for (let parent = statuses[at]?.replyTo ?? null; parent !== null; parent = statuses[at]?.replyTo ?? null) {
		at = parent
	}
	return statuses[at]?.replyToUnknown === true ? unknownParentUri(at) : statusUri(at)
}

// Keeps the first of each key.
function unique<T>(items: readonly T[], key: (item: T) => string): T[] {
	const seen = new Set<string>()
	return items.filter((item) => {
		const k = key(item)
		return seen.has(k) ? false : (seen.add(k), true)
	})
}

const remoteArb = fc.record({
	domain: fc.constantFrom(...REMOTE_DOMAINS),
	host: fc.constantFrom(...HOSTS),
})

const statusArb = fc.record({
	author: fc.nat(),
	visibility: fc.constantFrom(...VISIBILITIES),
	mentions: fc.array(fc.record({ account: fc.nat(), silent: fc.boolean() }), { maxLength: 3 }),
	// thread: a reply to one of the author's own statuses, preferably one of their replies (continuing a thread).
	kind: fc.constantFrom('original', 'reply', 'thread', 'boost'),
	target: fc.nat(),
	tagged: fc.boolean(),
})

const edgeArb = fc.record({ from: fc.nat(), to: fc.nat() })

export const worldArb: fc.Arbitrary<World> = fc
	.record({
		remotes: fc.array(remoteArb, { minLength: 2, maxLength: 3 }),
		suspended: fc.option(fc.integer({ min: 0, max: LOCALS - 1 }), { freq: 4 }),
		hidden: fc.array(fc.constantFrom(false, false, true), { minLength: LOCALS, maxLength: LOCALS }),
		statuses: fc.array(statusArb, { maxLength: 22, size: 'max' }),
		follows: fc.array(
			fc.record({
				from: fc.nat(),
				to: fc.nat(),
				accepted: fc.boolean(),
				showReblogs: fc.boolean(),
				notify: fc.boolean(),
			}),
			{ maxLength: 20, size: 'max' }
		),
		blocks: fc.array(edgeArb, { maxLength: 8, size: 'max' }),
		mutes: fc.array(
			fc.record({
				from: fc.nat(),
				to: fc.nat(),
				expiry: fc.constantFrom(null, -HOUR_MS, 0, HOUR_MS),
				hideNotifications: fc.boolean(),
			}),
			{ maxLength: 8, size: 'max' }
		),
		domainBlocks: fc.array(fc.record({ owner: fc.nat(), domain: fc.constantFrom(...BLOCKABLE_DOMAINS) }), {
			maxLength: 4,
			size: 'max',
		}),
		now: fc.constantFrom(...TIMES),
		// Last, so the other fields of a seed's worlds stay as they were before it was added.
		deleting: fc.option(fc.nat(), { freq: 3 }),
		// Statuses (not boosts) made replies to a status never stored, once all statuses are drawn.
		replyToUnknown: fc.array(fc.nat(), { maxLength: 3 }),
		// Lists, each member drawn from its owner and the accounts the owner follows.
		lists: fc.array(
			fc.record({
				owner: fc.nat(),
				repliesPolicy: fc.constantFrom(...REPLIES_POLICIES),
				exclusive: fc.boolean(),
				members: fc.array(fc.nat(), { maxLength: 5 }),
			}),
			{ maxLength: 4 }
		),
		// Last, as above: pins (each a choice among the author's pinnable statuses) and conversation mutes.
		pins: fc.array(fc.record({ account: fc.nat(), status: fc.nat() }), { maxLength: 4 }),
		conversationMutes: fc.array(fc.record({ account: fc.nat(), status: fc.nat() }), { maxLength: 4 }),
	})
	.map((raw): World => {
		const accounts: WorldAccount[] = []
		for (let i = 0; i < LOCALS; i++) {
			accounts.push({
				name: `L${i}`,
				local: true,
				suspended: raw.suspended === i,
				deleting: false,
				hidesCollections: raw.hidden[i] ?? false,
				domain: null,
				uri: `https://${INSTANCE_DOMAIN}/ap/users/l${i}`,
			})
		}
		raw.remotes.forEach((remote, i) => {
			accounts.push({
				name: `R${i}`,
				local: false,
				suspended: false,
				deleting: raw.deleting !== null && raw.deleting % raw.remotes.length === i,
				// Drawn from bits already drawn, as tagFollowers below: about one remote account in four.
				hidesCollections: raw.follows[LOCALS + i]?.showReblogs === true && raw.follows[LOCALS + i]?.notify === true,
				domain: remote.domain,
				uri: `https://${actorHost(remote.host, remote.domain)}/users/r${i}`,
			})
		})
		const n = accounts.length
		const statuses: WorldStatus[] = []
		const boosted = new Set<string>()
		raw.statuses.forEach((raw, i) => {
			const author = raw.author % n
			const originals = statuses.flatMap((status, index) => (status.reblogOf === null ? [index] : []))
			const target = originals.length === 0 ? null : (originals[raw.target % originals.length] ?? null)
			const own = originals.filter((index) => statuses[index]?.author === author)
			const ownReplies = own.filter((index) => statuses[index]?.replyTo !== null)
			const thread = ownReplies.length > 0 ? ownReplies : own
			const boost = raw.kind === 'boost' && target !== null && !boosted.has(`${author}:${target}`)
			if (boost) {
				boosted.add(`${author}:${target}`)
			}
			statuses.push({
				name: `S${i}`,
				author,
				visibility: raw.visibility,
				mentions: unique(
					raw.mentions.map((m) => ({ account: m.account % n, silent: m.silent })),
					(m) => String(m.account)
				),
				reblogOf: boost ? target : null,
				replyToUnknown: false,
				replyTo:
					raw.kind === 'reply'
						? target
						: raw.kind === 'thread'
							? (thread[raw.target % Math.max(thread.length, 1)] ?? target)
							: null,
				tagged: !boost && raw.tagged,
			})
		})
		for (const n of raw.replyToUnknown) {
			const status = statuses[n % Math.max(statuses.length, 1)]
			if (status !== undefined && status.reblogOf === null) {
				status.replyTo = null
				status.replyToUnknown = true
			}
		}
		const pair = (e: { from: number; to: number }) => `${e.from}:${e.to}`
		const follows = unique(
			raw.follows.map((f) => ({ ...f, from: f.from % n, to: f.to % n })).filter((f) => f.from !== f.to),
			pair
		)
		return {
			accounts,
			statuses,
			follows,
			blocks: unique(
				raw.blocks.map((b) => ({ from: b.from % n, to: b.to % n })).filter((b) => b.from !== b.to),
				pair
			),
			mutes: unique(
				raw.mutes
					.map((m) => ({
						from: m.from % LOCALS,
						to: m.to % n,
						expiresAt: m.expiry === null ? null : new Date(Date.parse(raw.now) + m.expiry).toISOString(),
						hideNotifications: m.hideNotifications,
					}))
					.filter((m) => m.from !== m.to),
				pair
			),
			domainBlocks: unique(
				raw.domainBlocks.map((d) => ({ owner: d.owner % LOCALS, domain: d.domain })),
				(d) => `${d.owner}:${d.domain}`
			),
			lists: raw.lists.map((list) => {
				const owner = list.owner % LOCALS
				const candidates = [owner, ...follows.flatMap((f) => (f.from === owner ? [f.to] : []))]
				const members = list.members.map((m) => candidates[m % candidates.length] ?? owner)
				return { ...list, owner, members: [...new Set(members)] }
			}),
			pins: unique(
				[
					...raw.pins.map((p) => ({ account: p.account % LOCALS, status: p.status })),
					// Remote accounts' pins, drawn from the same bits (a new field would change the worlds the fixed seeds of
					// the other properties give): each draw with an even status also pins one of a remote account's.
					...raw.pins.flatMap((p) =>
						p.status % 2 === 0
							? [{ account: LOCALS + (p.account % raw.remotes.length), status: Math.floor(p.status / 2) }]
							: []
					),
				].flatMap((p) => {
					const account = p.account
					const pinnable = statuses.flatMap((status, s) =>
						status.author === account &&
						status.reblogOf === null &&
						status.visibility !== 'direct' &&
						status.visibility !== 'limited'
							? [s]
							: []
					)
					const status = pinnable[p.status % Math.max(pinnable.length, 1)]
					return status === undefined ? [] : [{ account, status }]
				}),
				(p) => `${p.account}:${p.status}`
			),
			conversationMutes:
				statuses.length === 0
					? []
					: unique(
							raw.conversationMutes.map((m) => ({
								account: m.account % LOCALS,
								thread: threadOf(statuses, m.status % statuses.length),
							})),
							(m) => `${m.account}:${m.thread}`
						),
			// Local accounts following the world's hashtag, drawn from bits already drawn (a new field would change the
			// worlds the fixed seeds of the other properties give): about one local account in four.
			tagFollowers: Array.from({ length: LOCALS }, (_, x) => x).filter(
				(x) => raw.follows[x]?.showReblogs === true && raw.follows[x]?.notify === true
			),
			// Quotes, drawn from bits already drawn (a new field would change the worlds the fixed seeds of the other
			// properties give): about one original in three quotes another original (with one bit, one of its author's own
			// when there is one) or a status that is gone, in each stored state, legacy or not.
			quotes: raw.statuses.flatMap((r, s): WorldQuote[] => {
				const k = Math.floor(r.target / 2)
				if (statuses[s]?.reblogOf !== null || k % 3 !== 0) {
					return []
				}
				const bits = Math.floor(k / 3)
				const author = statuses[s]?.author
				const originals = statuses.flatMap((status, o) => (status.reblogOf === null && o !== s ? [o] : []))
				const own = originals.filter((o) => statuses[o]?.author === author)
				const candidates = Math.floor(bits / 10) % 2 === 1 && own.length > 0 ? own : originals
				const gone = Math.floor(bits / 20) % 5 === 0
				const quoted = gone ? null : (candidates[Math.floor(bits / 100) % Math.max(candidates.length, 1)] ?? null)
				const drawn = QUOTE_STATES[bits % QUOTE_STATES.length] ?? 'pending'
				// An accepted quote has its quoted status (the schema's CHECK); a detach makes it deleted.
				const state = quoted === null && drawn === 'accepted' ? 'deleted' : drawn
				return [{ status: s, quoted, state, legacy: Math.floor(bits / 5) % 2 === 1 }]
			}),
			now: raw.now,
		}
	})

// The tables a world fills, in an order that deletes children first.
const WORLD_TABLES = [
	'status_pins',
	'conversation_mutes',
	'conversation_statuses',
	'conversations',
	'list_accounts',
	'lists',
	'tag_follows',
	'notifications',
	'favourites',
	'bookmarks',
	'status_tags',
	'status_mentions',
	'quotes',
	'statuses',
	'follows',
	'blocks',
	'mutes',
	'domain_blocks',
	'local_accounts',
	'accounts',
]

// Replaces the Store's accounts, statuses and edges with the world's, so one Store serves every case of a property.
export function writeWorld(sql: SqlStorage, world: World): void {
	for (const table of WORLD_TABLES) {
		sql.exec(`DELETE FROM ${table}`)
	}
	world.accounts.forEach((account, i) => {
		const username = account.name.toLowerCase()
		// Every account's search text holds "account", so an account search for it reads them all.
		sql.exec(
			`INSERT INTO accounts (id, uri, username, domain, search_text, deleted_at, hide_collections)
			VALUES (?, ?, ?, ?, ?, ?, ?)`,
			accountId(i),
			account.uri,
			username,
			account.domain,
			`account ${account.domain === null ? username : `${username}@${account.domain}`}`,
			account.deleting ? '2026-01-01T00:00:00.000Z' : null,
			// A remote account Kopje has not learned of hides nothing, as one that shows its network.
			account.local || !account.hidesCollections ? null : 1
		)
		if (account.local) {
			sql.exec(
				`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey, suspended_at, hide_collections)
				VALUES (?, ?, X'00', X'00', 'test', ?, ?)`,
				accountId(i),
				`${username}@example.com`,
				account.suspended ? '2026-01-01T00:00:00.000Z' : null,
				account.hidesCollections ? 1 : 0
			)
		}
	})
	// in_reply_to_account_id as statuses.ts writes it (Status#carried_over_reply_to_account_id): the parent's author,
	// or, when the author continues their own reply, that reply's partner; none for a reply to a status never stored.
	const partners: (string | null)[] = []
	world.statuses.forEach((status, i) => {
		const parent = status.replyTo === null ? undefined : world.statuses[status.replyTo]
		const parentPartner = status.replyTo === null ? null : (partners[status.replyTo] ?? null)
		partners.push(
			parent === undefined
				? null
				: parent.author === status.author && (parent.replyTo !== null || parent.replyToUnknown)
					? parentPartner
					: accountId(parent.author)
		)
		sql.exec(
			`INSERT INTO statuses (id, uri, account_id, reblog_of_id, in_reply_to_uri, in_reply_to_id, in_reply_to_account_id,
				visibility, content, search_text, published_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			statusId(i),
			statusUri(i),
			accountId(status.author),
			status.reblogOf === null ? null : statusId(status.reblogOf),
			status.replyToUnknown ? unknownParentUri(i) : status.replyTo === null ? null : statusUri(status.replyTo),
			status.replyTo === null ? null : statusId(status.replyTo),
			partners[i] ?? null,
			status.visibility,
			status.reblogOf === null ? `<p>status ${i}</p>` : '',
			status.reblogOf === null ? `status ${i}` : null,
			new Date(Date.parse(TIMES[0]) - (world.statuses.length - i) * 60_000).toISOString()
		)
		for (const mention of status.mentions) {
			sql.exec(
				'INSERT INTO status_mentions (status_id, account_id, silent, requires_mention, author_id) VALUES (?, ?, ?, ?, ?)',
				statusId(i),
				accountId(mention.account),
				mention.silent ? 1 : 0,
				status.visibility === 'direct' || status.visibility === 'limited' ? 1 : 0,
				accountId(status.author)
			)
		}
		if (status.tagged) {
			sql.exec(
				"INSERT INTO status_tags (status_id, name, public) VALUES (?, 'cats', ?)",
				statusId(i),
				status.visibility === 'public' ? 1 : 0
			)
		}
	})
	for (const f of world.follows) {
		sql.exec(
			'INSERT INTO follows (account_id, target_account_id, state, show_reblogs, notify) VALUES (?, ?, ?, ?, ?)',
			accountId(f.from),
			accountId(f.to),
			f.accepted ? 'accepted' : 'pending',
			f.showReblogs ? 1 : 0,
			f.notify ? 1 : 0
		)
	}
	for (const b of world.blocks) {
		sql.exec('INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)', accountId(b.from), accountId(b.to))
	}
	for (const m of world.mutes) {
		sql.exec(
			'INSERT INTO mutes (account_id, target_account_id, hide_notifications, expires_at) VALUES (?, ?, ?, ?)',
			accountId(m.from),
			accountId(m.to),
			m.hideNotifications ? 1 : 0,
			m.expiresAt
		)
	}
	for (const d of world.domainBlocks) {
		sql.exec('INSERT INTO domain_blocks (account_id, domain) VALUES (?, ?)', accountId(d.owner), d.domain)
	}
	for (const follower of world.tagFollowers) {
		sql.exec("INSERT INTO tag_follows (account_id, name) VALUES (?, 'cats')", accountId(follower))
	}
	world.lists.forEach((list, l) => {
		sql.exec(
			'INSERT INTO lists (id, account_id, title, replies_policy, exclusive) VALUES (?, ?, ?, ?, ?)',
			listId(l),
			accountId(list.owner),
			`list ${l}`,
			list.repliesPolicy,
			list.exclusive ? 1 : 0
		)
		for (const member of list.members) {
			sql.exec('INSERT INTO list_accounts (list_id, account_id) VALUES (?, ?)', listId(l), accountId(member))
		}
	})
	// Pinned in order, a minute apart, so the newest pin is the last.
	world.pins.forEach((p, i) => {
		sql.exec(
			'INSERT INTO status_pins (account_id, status_id, created_at) VALUES (?, ?, ?)',
			accountId(p.account),
			statusId(p.status),
			new Date(Date.parse(TIMES[0]) + i * 60_000).toISOString()
		)
	})
	for (const m of world.conversationMutes) {
		sql.exec('INSERT INTO conversation_mutes (account_id, thread) VALUES (?, ?)', accountId(m.account), m.thread)
	}
	for (const q of world.quotes) {
		const quoted = q.quoted === null ? undefined : world.statuses[q.quoted]
		sql.exec(
			`INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, legacy, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`,
			statusId(q.status),
			q.quoted === null ? unknownParentUri(q.status) : statusUri(q.quoted),
			q.quoted === null ? null : statusId(q.quoted),
			quoted === undefined ? null : accountId(quoted.author),
			q.state,
			q.legacy ? 1 : 0,
			TIMES[0]
		)
	}
}
