import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { seedAccount, sql } from './api-helpers'
import { migratedStore } from './helpers'
import { block, domainBlock, mute, remoteFollows, seedStatus } from './status-helpers'
import { Db } from '../src/db/sql'
import {
	addressingOf,
	canView,
	interpretAddressing,
	listableSql,
	PUBLIC_COLLECTION,
	type Visibility,
} from '../src/domain/audience'
import type { StoreStub } from '../src/platform/store-client'

const FOLLOWERS = 'https://remote.example/users/author/followers'

describe('interpretAddressing (Mastodon StatusParser#visibility, ProcessStatus#process_audience)', () => {
	const known = new Map([
		['https://kopje.test/ap/users/alice', 'A'],
		['https://kopje.test/ap/users/bob', 'B'],
		['https://remote.example/users/carol', 'C'],
	])
	const base = { followersUri: FOLLOWERS, mentionUris: [], known }

	it('reads public, unlisted, private and direct from to and cc', () => {
		expect(interpretAddressing({ ...base, to: [PUBLIC_COLLECTION], cc: [FOLLOWERS] }).visibility).toBe('public')
		expect(interpretAddressing({ ...base, to: ['as:Public'], cc: [] }).visibility).toBe('public')
		expect(interpretAddressing({ ...base, to: [FOLLOWERS], cc: ['Public'] }).visibility).toBe('unlisted')
		expect(interpretAddressing({ ...base, to: [FOLLOWERS], cc: [] }).visibility).toBe('private')
		expect(
			interpretAddressing({
				...base,
				to: ['https://kopje.test/ap/users/alice'],
				cc: [],
				mentionUris: ['https://kopje.test/ap/users/alice'],
			})
		).toEqual({ visibility: 'direct', mentions: [{ accountId: 'A', silent: false }] })
	})

	it('reads Misskey specified (addressed but not mentioned) as limited with silent mentions', () => {
		expect(
			interpretAddressing({
				...base,
				to: ['https://kopje.test/ap/users/alice', 'https://kopje.test/ap/users/bob', 'https://unknown.example/u/x'],
				cc: [],
				mentionUris: ['https://kopje.test/ap/users/alice'],
			})
		).toEqual({
			visibility: 'limited',
			mentions: [
				{ accountId: 'A', silent: false },
				{ accountId: 'B', silent: true },
			],
		})
	})

	it('gives the owner of the personal inbox it arrived at a silent mention', () => {
		expect(interpretAddressing({ ...base, to: [FOLLOWERS], cc: [], deliveredTo: 'B' })).toEqual({
			visibility: 'private',
			mentions: [{ accountId: 'B', silent: true }],
		})
		// A direct status delivered to someone not addressed is limited: they may see it, but are not listed.
		expect(interpretAddressing({ ...base, to: [], cc: [], deliveredTo: 'B' }).visibility).toBe('limited')
	})
})

describe('addressingOf (Mastodon TagManager#to and #cc)', () => {
	const recipients = [
		{ accountId: 'C', uri: 'https://remote.example/users/carol', silent: false },
		{ accountId: 'D', uri: 'https://remote.example/users/dave', silent: true },
	]
	const carol = 'https://remote.example/users/carol'
	it.each<[Visibility, { to: string[]; cc: string[] }]>([
		['public', { to: [PUBLIC_COLLECTION], cc: [FOLLOWERS, carol] }],
		['unlisted', { to: [FOLLOWERS], cc: [PUBLIC_COLLECTION, carol] }],
		['private', { to: [FOLLOWERS], cc: [carol] }],
		['direct', { to: [carol], cc: [] }],
		['limited', { to: [carol], cc: [] }],
	])('%s never writes a silent recipient', (visibility, expected) => {
		expect(addressingOf(visibility, FOLLOWERS, recipients)).toEqual(expected)
	})
})

// The read rule against the real schema, viewer by viewer (Mastodon's spec/policies/status_policy_spec.rb #show?).
describe('canView and the list rule', () => {
	type Cast = Record<'author' | 'follower' | 'mentioned' | 'silent' | 'stranger' | 'blocked' | 'pending', string>

	async function cast(store: StoreStub): Promise<Cast> {
		const ids = {} as Cast
		for (const name of ['author', 'follower', 'mentioned', 'silent', 'stranger', 'blocked', 'pending'] as const) {
			ids[name] = await seedAccount(store, { username: name })
		}
		await remoteFollows(store, ids.follower, ids.author)
		await remoteFollows(store, ids.blocked, ids.author)
		await sql(
			store,
			"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'pending')",
			ids.pending,
			ids.author
		)
		await block(store, ids.author, ids.blocked)
		return ids
	}

	async function view(
		store: StoreStub,
		viewer: string | null,
		status: string
	): Promise<{ show: boolean; list: boolean }> {
		return runInDurableObject(store, (_instance, state) => {
			const db = new Db(state.storage.sql)
			const listed = db.first(
				`SELECT 1 AS yes FROM statuses s WHERE s.id = ?2 AND ${listableSql('s', '?1')}`,
				viewer,
				status
			)
			return { show: canView(db, viewer, status), list: listed !== undefined }
		})
	}

	const EVERYONE = ['author', 'follower', 'mentioned', 'silent', 'stranger', 'pending', 'anonymous'] as const
	const EXPECTED: Record<Visibility, readonly (typeof EVERYONE)[number][]> = {
		public: EVERYONE,
		unlisted: EVERYONE,
		private: ['author', 'follower', 'mentioned', 'silent'],
		direct: ['author', 'mentioned', 'silent'],
		limited: ['author', 'mentioned', 'silent'],
	}

	it.each(Object.entries(EXPECTED) as [Visibility, readonly string[]][])(
		'%s is seen by exactly the right viewers, and never by one the author blocks',
		async (visibility, allowed) => {
			const store = await migratedStore()
			const ids = await cast(store)
			const status = await seedStatus(store, {
				accountId: ids.author,
				visibility,
				mentions: [{ accountId: ids.mentioned }, { accountId: ids.silent, silent: true }, { accountId: ids.blocked }],
			})
			for (const viewer of [...EVERYONE, 'blocked'] as const) {
				const viewerId = viewer === 'anonymous' ? null : ids[viewer]
				const seen = await view(store, viewerId, status)
				expect({ viewer, ...seen }).toEqual({ viewer, show: allowed.includes(viewer), list: allowed.includes(viewer) })
			}
		}
	)

	it("hides a suspended author's statuses from everyone", async () => {
		const store = await migratedStore()
		const ids = await cast(store)
		const status = await seedStatus(store, { accountId: ids.author, visibility: 'public' })
		await sql(
			store,
			"UPDATE local_accounts SET suspended_at = '2026-01-01T00:00:00.000Z' WHERE account_id = ?",
			ids.author
		)
		for (const viewer of [ids.author, ids.follower, null]) {
			expect(await view(store, viewer, status)).toEqual({ show: false, list: false })
		}
	})

	it('shows the blocked, muted or domain-blocked author by itself but keeps them out of lists (StatusFilter)', async () => {
		const store = await migratedStore()
		const viewer = await seedAccount(store, { username: 'viewer' })
		const blockedAuthor = await seedAccount(store, { username: 'b', domain: 'one.example' })
		const mutedAuthor = await seedAccount(store, { username: 'm', domain: 'two.example' })
		const domainBlocked = await seedAccount(store, { username: 'd', domain: 'three.example' })
		await block(store, viewer, blockedAuthor)
		await mute(store, viewer, mutedAuthor)
		await domainBlock(store, viewer, 'three.example')
		for (const author of [blockedAuthor, mutedAuthor, domainBlocked]) {
			const status = await seedStatus(store, { accountId: author, visibility: 'public' })
			expect(await view(store, viewer, status)).toEqual({ show: true, list: false })
			// A boost of it by someone else is filtered too.
			const booster = await seedAccount(store, { username: `boost${author.slice(-4)}`, domain: 'four.example' })
			const boost = await seedStatus(store, { accountId: booster, visibility: 'public', reblogOfId: status })
			expect(await view(store, viewer, boost)).toEqual({ show: true, list: false })
		}
	})

	it('needs the original of a boost to be visible as well', async () => {
		const store = await migratedStore()
		const ids = await cast(store)
		const original = await seedStatus(store, { accountId: ids.author, visibility: 'private' })
		const boost = await seedStatus(store, { accountId: ids.author, visibility: 'public', reblogOfId: original })
		expect(await view(store, ids.stranger, boost)).toEqual({ show: false, list: false })
		expect(await view(store, ids.follower, boost)).toEqual({ show: true, list: true })
	})
})
