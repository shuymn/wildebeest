import { runInDurableObject } from 'cloudflare:test'

import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'

import { migratedStore } from './helpers'
import { NOTIFICATION_TYPES, PolicyModel, type Viewer } from './policy-model'
import { accountId, BLOCKABLE_DOMAINS, runs, statusId, type World, worldArb, writeWorld } from './policy-world'
import { Db } from '../src/db/sql'
import {
	availableLocalSql,
	availableSql,
	blockedSql,
	blocksSql,
	canView,
	domainBlocksSql,
	filteredForSql,
	followableBySql,
	homeFilterSql,
	inDomainSql,
	listableSql,
	listedForSql,
	mentionableBySql,
	shownSql,
	visibleSql,
} from '../src/domain/audience'
import type { StoreStub } from '../src/platform/store-client'

// The policy oracle (docs/visibility.md, "The oracle and the bounds harness"): each fragment of src/domain/audience.ts
// is evaluated in the Store over every relevant pair of a generated world (test/policy-world.ts) and must accept
// exactly what the plain model of its rule (test/policy-model.ts) accepts. A failure prints the shrunk world, the
// pairs only one side accepts, and the seed to replay it with (FC_SEED=<seed> pnpm vitest run test/policy-oracle.test.ts).

// Cases per property: each costs one Store round trip, so the file stays within a few seconds.
const CASES = 150

// Every account as an id, and every viewer: every account and the anonymous viewer (NULL).
const ACCOUNTS = 'SELECT id FROM accounts'
const VIEWERS = `(${ACCOUNTS} UNION ALL SELECT NULL)`

type Evaluate = (db: Db, world: World) => string[]
type Expect = (model: PolicyModel) => string[]

// Readable names for the keys both sides produce.
function namer(world: World) {
	const names = new Map<string | null, string>([[null, 'anonymous']])
	world.accounts.forEach((account, i) => names.set(accountId(i), account.name))
	world.statuses.forEach((status, i) => names.set(statusId(i), status.name))
	return (...ids: (string | number | null)[]) =>
		ids.map((id) => (typeof id === 'string' || id === null ? (names.get(id) ?? String(id)) : String(id))).join(' ')
}

function viewers(world: World): Viewer[] {
	return [null, ...world.accounts.map((_, i) => i)]
}

function accounts(world: World): number[] {
	return world.accounts.map((_, i) => i)
}

function statuses(world: World): number[] {
	return world.statuses.map((_, i) => i)
}

function name(world: World, x: Viewer): string {
	return x === null ? 'anonymous' : (world.accounts[x]?.name ?? String(x))
}

describe('the policy fragments agree with the model of their rules', () => {
	let store: StoreStub
	beforeAll(async () => {
		store = await migratedStore()
	})

	async function agree(evaluate: Evaluate, expected: Expect): Promise<void> {
		await fc.assert(
			fc.asyncProperty(worldArb, async (world) => {
				const actual = await runInDurableObject(store, (_instance, state) => {
					writeWorld(state.storage.sql, world)
					return evaluate(new Db(state.storage.sql), world)
				})
				const model = new Set(expected(new PolicyModel(world)))
				const sql = new Set(actual)
				expect({
					onlySql: [...sql].filter((key) => !model.has(key)).sort(),
					onlyModel: [...model].filter((key) => !sql.has(key)).sort(),
				}).toEqual({ onlySql: [], onlyModel: [] })
			}),
			runs(CASES)
		)
	}

	// Rows of x (and y) ids a query accepts, named.
	function pairs(query: string, ...params: SqlStorageValue[]): Evaluate {
		return (db, world) => {
			const named = namer(world)
			return db
				.all<{ x: string | null; y?: string | null }>(query, ...params)
				.map((row) => (row.y === undefined ? named(row.x) : named(row.x, row.y)))
		}
	}

	it('availableSql (R1)', () =>
		agree(pairs(`SELECT a.id AS x FROM accounts a WHERE ${availableSql('a.id')}`), (m) =>
			accounts(m.world).flatMap((x) => (m.available(x) ? [name(m.world, x)] : []))
		))

	it('availableLocalSql (R1)', () =>
		agree(
			pairs(`SELECT a.id AS x FROM accounts a LEFT JOIN local_accounts l ON l.account_id = a.id
				WHERE ${availableLocalSql('l')}`),
			(m) => accounts(m.world).flatMap((x) => (m.available(x) ? [name(m.world, x)] : []))
		))

	// Every (owner, x) pair of accounts a two-account predicate accepts.
	function accountPairs(
		fragment: (owner: string, x: string) => string,
		model: (m: PolicyModel, owner: number, x: number) => boolean
	) {
		return agree(
			pairs(`SELECT o.id AS x, a.id AS y FROM accounts o CROSS JOIN accounts a WHERE ${fragment('o.id', 'a.id')}`),
			(m) =>
				accounts(m.world).flatMap((owner) =>
					accounts(m.world).flatMap((x) => (model(m, owner, x) ? [`${name(m.world, owner)} ${name(m.world, x)}`] : []))
				)
		)
	}

	it('blocksSql', () => accountPairs(blocksSql, (m, owner, x) => m.blocks(owner, x)))

	it('domainBlocksSql', () => accountPairs(domainBlocksSql, (m, owner, x) => m.domainBlocks(owner, x)))

	it('blockedSql', () => accountPairs(blockedSql, (m, owner, x) => m.blocked(owner, x)))

	it('mentionableBySql (R17)', () =>
		accountPairs(
			(author, x) => mentionableBySql(x, author),
			(m, author, x) => m.mentionableBy(x, author)
		))

	it('followableBySql (R21)', () =>
		accountPairs(
			(viewer, x) => followableBySql(x, viewer),
			(m, viewer, x) => m.followableBy(x, viewer)
		))

	it('inDomainSql', () =>
		agree(
			(db, world) => {
				const named = namer(world)
				return db
					.all<{ x: string; domain: string }>(
						`SELECT a.id AS x, d.value AS domain FROM accounts a CROSS JOIN json_each(?1) d
						WHERE ${inDomainSql('a', 'd.value')}`,
						JSON.stringify(BLOCKABLE_DOMAINS)
					)
					.map((row) => `${named(row.x)} ${row.domain}`)
			},
			(m) =>
				accounts(m.world).flatMap((x) =>
					BLOCKABLE_DOMAINS.flatMap((domain) => (m.inDomain(x, domain) ? [`${name(m.world, x)} ${domain}`] : []))
				)
		))

	// Every (viewer, x) pair, the anonymous viewer included, a viewer's account predicate accepts at the world's time.
	function viewerAccountPairs(
		fragment: (x: string, viewer: string, now: string) => string,
		model: (m: PolicyModel, x: number, viewer: Viewer) => boolean
	) {
		return agree(
			(db, world) =>
				pairs(
					`SELECT v.id AS x, a.id AS y FROM ${VIEWERS} v CROSS JOIN accounts a WHERE ${fragment('a.id', 'v.id', '?1')}`,
					world.now
				)(db, world),
			(m) =>
				viewers(m.world).flatMap((viewer) =>
					accounts(m.world).flatMap((x) =>
						model(m, x, viewer) ? [`${name(m.world, viewer)} ${name(m.world, x)}`] : []
					)
				)
		)
	}

	it('filteredForSql (R7)', () => viewerAccountPairs(filteredForSql, (m, x, viewer) => m.filteredFor(x, viewer)))

	it('listedForSql (R12)', () => viewerAccountPairs(listedForSql, (m, x, viewer) => m.listedFor(x, viewer)))

	// Every (viewer, status) pair, the anonymous viewer included, a status predicate accepts at the world's time.
	function viewerStatusPairs(
		fragment: (s: string, viewer: string, now: string) => string,
		model: (m: PolicyModel, s: number, viewer: Viewer) => boolean
	) {
		return agree(
			(db, world) => {
				const query = `SELECT v.id AS x, st.id AS y FROM ${VIEWERS} v CROSS JOIN statuses st
					WHERE ${fragment('st', 'v.id', '?1')}`
				// visibleSql has no time.
				return pairs(query, ...(query.includes('?1') ? [world.now] : []))(db, world)
			},
			(m) =>
				viewers(m.world).flatMap((viewer) =>
					statuses(m.world).flatMap((s) =>
						model(m, s, viewer) ? [`${name(m.world, viewer)} ${m.status(s).name}`] : []
					)
				)
		)
	}

	it('visibleSql (R2)', () =>
		viewerStatusPairs(
			(s, viewer) => visibleSql(s, viewer),
			(m, s, viewer) => m.visible(s, viewer)
		))

	it('listableSql (R8)', () => viewerStatusPairs(listableSql, (m, s, viewer) => m.listable(s, viewer)))

	it('homeFilterSql (R9)', () => viewerStatusPairs(homeFilterSql, (m, s, viewer) => m.homeFilter(s, viewer)))

	it('canView (R3)', () =>
		agree(
			(db, world) => {
				const named = namer(world)
				const ids = [null, ...world.accounts.map((_, i) => accountId(i))]
				return ids.flatMap((viewer) =>
					world.statuses.flatMap((_, s) => (canView(db, viewer, statusId(s)) ? [named(viewer, statusId(s))] : []))
				)
			},
			(m) =>
				viewers(m.world).flatMap((viewer) =>
					statuses(m.world).flatMap((s) =>
						m.viewable(s, viewer) ? [`${name(m.world, viewer)} ${m.status(s).name}`] : []
					)
				)
		))

	// Every (recipient, type, sender, status or none) a local recipient is shown, at the world's time.
	it('shownSql (R15)', () =>
		agree(
			(db, world) => {
				const named = namer(world)
				return db
					.all<{ r: string; type: string; sender: string; status: string | null }>(
						`SELECT nr0.account_id AS r, nt.value AS type, nf.id AS sender, ns.id AS status
						FROM local_accounts nr0 CROSS JOIN json_each(?1) nt CROSS JOIN accounts nf
						CROSS JOIN (SELECT id FROM statuses UNION ALL SELECT NULL) ns
						WHERE ${shownSql('nr0.account_id', 'nt.value', 'nf.id', 'ns.id', '?2')}`,
						JSON.stringify(NOTIFICATION_TYPES),
						world.now
					)
					.map(
						(row) => `${named(row.r)} ${row.type} ${named(row.sender)} ${row.status === null ? '-' : named(row.status)}`
					)
			},
			(m) =>
				accounts(m.world)
					.filter((r) => m.world.accounts[r]?.local === true)
					.flatMap((r) =>
						NOTIFICATION_TYPES.flatMap((type) =>
							accounts(m.world).flatMap((from) =>
								[null, ...statuses(m.world)].flatMap((s) =>
									m.shown(r, type, from, s)
										? [`${name(m.world, r)} ${type} ${name(m.world, from)} ${s === null ? '-' : m.status(s).name}`]
										: []
								)
							)
						)
					)
		))
})
