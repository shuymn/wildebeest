import fc from 'fast-check'
import { inject } from 'vitest'

import type { Visibility } from '../src/domain/audience'

// A generated world for the policy oracle (test/policy-oracle.test.ts) and the bounds harness
// (test/policy-bounds.test.ts): local accounts (one of them may be suspended, some may hide their network), remote
// accounts on two domains (one of them may be being deleted, its statuses and edges still stored), statuses of every
// visibility with mentions (some silent), boosts and replies (some to a status never stored, and some continuing such
// a reply, as a purge leaves a reply to the account it removes), and the edges the rules read: follows (pending and
// accepted), blocks both ways, mutes with and without an expiry and with and without notifications, and domain blocks
// in their stored form. Accounts and statuses are referred to by index; writeWorld gives them fixed ids.

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
// The times a world may be judged at, an hour apart, so a mute's expiry falls before, at or after them.
const TIMES = ['2026-10-12T00:00:00.000Z', '2026-10-12T01:00:00.000Z', '2026-10-12T02:00:00.000Z'] as const
const HOUR_MS = 3_600_000

type WorldAccount = {
	name: string
	local: boolean
	suspended: boolean
	// Remote accounts only: its deletion has started (accounts.deleted_at), and its purge has removed nothing yet.
	deleting: boolean
	// Local accounts only: hide_collections.
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

export type World = {
	accounts: WorldAccount[]
	statuses: WorldStatus[]
	follows: { from: number; to: number; accepted: boolean; showReblogs: boolean; notify: boolean }[]
	blocks: { from: number; to: number }[]
	mutes: { from: number; to: number; expiresAt: string | null; hideNotifications: boolean }[]
	domainBlocks: { owner: number; domain: string }[]
	now: string
}

const ACCOUNT_BASE = 100000000000000000n
const STATUS_BASE = 200000000000000000n

export function accountId(index: number): string {
	return String(ACCOUNT_BASE + BigInt(index))
}

export function statusId(index: number): string {
	return String(STATUS_BASE + BigInt(index))
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
				hidesCollections: false,
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
		return {
			accounts,
			statuses,
			follows: unique(
				raw.follows.map((f) => ({ ...f, from: f.from % n, to: f.to % n })).filter((f) => f.from !== f.to),
				pair
			),
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
			now: raw.now,
		}
	})

// The tables a world fills, in an order that deletes children first.
const WORLD_TABLES = [
	'notifications',
	'favourites',
	'bookmarks',
	'status_tags',
	'status_mentions',
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
			'INSERT INTO accounts (id, uri, username, domain, search_text, deleted_at) VALUES (?, ?, ?, ?, ?, ?)',
			accountId(i),
			account.uri,
			username,
			account.domain,
			`account ${account.domain === null ? username : `${username}@${account.domain}`}`,
			account.deleting ? '2026-01-01T00:00:00.000Z' : null
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
			`https://${INSTANCE_DOMAIN}/ap/o/${i}`,
			accountId(status.author),
			status.reblogOf === null ? null : statusId(status.reblogOf),
			status.replyToUnknown
				? `https://elsewhere.example/objects/${i}`
				: status.replyTo === null
					? null
					: `https://${INSTANCE_DOMAIN}/ap/o/${status.replyTo}`,
			status.replyTo === null ? null : statusId(status.replyTo),
			partners[i] ?? null,
			status.visibility,
			status.reblogOf === null ? `<p>status ${i}</p>` : '',
			status.reblogOf === null ? `status ${i}` : null,
			new Date(Date.parse(TIMES[0]) - (world.statuses.length - i) * 60_000).toISOString()
		)
		for (const mention of status.mentions) {
			sql.exec(
				'INSERT INTO status_mentions (status_id, account_id, silent) VALUES (?, ?, ?)',
				statusId(i),
				accountId(mention.account),
				mention.silent ? 1 : 0
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
}
