import { bearer, json, sql } from './api-helpers'
import { NOW } from './app-helpers'
import type { World } from './remote-suspension-helpers'
import type { MeasureInput } from '../src/domain/admin-measures'
import { sha256Hex } from '../src/security/tokens'

// Fixtures of the admin measure tests (test/admin-measures*.test.ts): requests, and rows inserted in bulk.

export const ADMIN_SCOPES = 'read write admin:read admin:write'
export const MEASURES = '/api/v1/admin/measures'

export type Measure = {
	key: string
	unit: string | null
	total: string
	human_value?: string
	previous_total?: string
	data: { date: string; value: string }[]
}

export async function measure(w: World, body: Record<string, unknown>, token: string | null = w.admin) {
	const init = json(body)
	const response = await w.h.request(MEASURES, token === null ? init : bearer(token, init))
	return { status: response.status, body: (await response.json()) as unknown }
}

// The admin's credential and a measure's input, for a Store operation run directly.
export async function measureInput(w: World, input: MeasureInput) {
	const credential = { tokenHash: await sha256Hex(w.admin), scope: 'admin:read' as const, now: NOW }
	return { credential, ...input }
}

let next = 7_000_000_000_000

// `n` new remote accounts on `domain`, with ids after the returned base.
export async function remoteAccountsOn(w: Pick<World, 'h'>, n: number, domain: string): Promise<number> {
	const base = next
	next += 1_000_000
	await sql(
		w.h.store,
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO accounts (id, uri, username, domain)
		SELECT printf('%018d', ?2 + i), 'https://' || ?3 || '/users/u' || (?2 + i), 'u' || i, ?3 FROM n`,
		n,
		base,
		domain
	)
	return base
}

// The accounts remoteAccountsOn made after `base`, as a SQL condition on `column` (?1 base, ?2 n).
const NEW_IDS = (column: string) => `${column} > printf('%018d', ?1) AND ${column} <= printf('%018d', ?1 + ?2)`

// `n` new remote accounts on `domain`, each with a follow in `state`: of the account by `local` (out), or of `local`
// by the account (in).
async function followsOf(
	w: Pick<World, 'h'>,
	direction: 'out' | 'in',
	local: string,
	n: number,
	domain: string,
	state: string
): Promise<void> {
	const base = await remoteAccountsOn(w, n, domain)
	const pair = direction === 'out' ? '?3, id' : 'id, ?3'
	await sql(
		w.h.store,
		`INSERT INTO follows (account_id, target_account_id, state)
		SELECT ${pair}, ?4 FROM accounts WHERE ${NEW_IDS('id')}`,
		base,
		n,
		local,
		state
	)
}

// `n` new remote accounts on `domain`, followed by `follower` in `state`.
export const followed = (w: Pick<World, 'h'>, follower: string, n: number, domain: string, state = 'accepted') =>
	followsOf(w, 'out', follower, n, domain, state)

// `n` new remote accounts on `domain`, each following `local` in `state`.
export const followersOn = (w: Pick<World, 'h'>, local: string, n: number, domain: string, state = 'accepted') =>
	followsOf(w, 'in', local, n, domain, state)

let reportSequence = 0

// `n` reports by `reporter` of `target`, filed at `createdAt` and resolved at `actionTakenAt` (null: unresolved).
export async function reportsOf(
	w: Pick<World, 'h'>,
	n: number,
	reporter: string,
	target: string,
	createdAt: string,
	actionTakenAt: string | null = null
): Promise<void> {
	const base = reportSequence
	reportSequence += n
	await sql(
		w.h.store,
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO reports (account_id, target_account_id, uri, created_at, action_taken_at)
		SELECT ?2, ?3, 'https://kopje.test/reports/' || (?4 + i), ?5, ?6 FROM n`,
		n,
		reporter,
		target,
		base,
		createdAt,
		actionTakenAt
	)
}

let localSequence = 0

// `n` new local accounts (rows only: no credentials), created at `createdAt`.
export async function localAccounts(w: Pick<World, 'h'>, n: number, createdAt: string): Promise<void> {
	const base = 6_000_000_000_000 + localSequence
	localSequence += n
	await sql(
		w.h.store,
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO accounts (id, uri, username)
		SELECT printf('%018d', ?2 + i), 'https://kopje.test/ap/users/l' || (?2 + i), 'l' || (?2 + i) FROM n`,
		n,
		base
	)
	await sql(
		w.h.store,
		`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey, created_at)
		SELECT id, username || '@local.example', X'00', X'00', 'test', ?3 FROM accounts WHERE ${NEW_IDS('id')}`,
		base,
		n,
		createdAt
	)
}
