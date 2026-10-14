import { runInDurableObject } from 'cloudflare:test'

import { type ApiHarness, apiHarness, bearer, json, login, registerApp, seedAccount, sql } from './api-helpers'
import { NOW } from './app-helpers'
import type { Visibility } from '../src/domain/audience'
import { allocateLocalId } from '../src/domain/ids'
import { writeOperation } from '../src/domain/operation'
import { htmlToPlainText } from '../src/domain/plain-text'
import { normalizeSearchText } from '../src/domain/search-text'
import type { StoreStub } from '../src/platform/store-client'

// Fixtures for statuses, timelines and notifications: signed-in local users, remote accounts, statuses written
// straight into the Store (for shapes the API cannot make, such as remote and limited statuses), and the
// relationships that have no endpoint yet (blocks, mutes, domain blocks).

export type User = { id: string; token: string }

export type Status = Record<string, unknown> & {
	id: string
	content?: string
	visibility: string
	reblog: Status | null
	account: { id: string; acct: string }
	mentions: { id: string; acct: string }[]
	tags: { name: string; url: string }[]
}

// A harness with signed-in local users, by username. Each gets a token with every scope.
export async function community<const N extends string>(
	names: readonly N[],
	scope = 'read write follow',
	deps: Parameters<typeof apiHarness>[1] = {},
	overrides: Record<string, unknown> = {}
): Promise<ApiHarness & { users: Record<N, User> }> {
	const h = await apiHarness(overrides, deps)
	const app = await registerApp(h)
	const users = {} as Record<N, User>
	for (const name of names) {
		const id = await seedAccount(h.store, { username: name, email: `${name}@example.com` })
		const { token } = await login(h, { app, email: `${name}@example.com`, scope })
		users[name] = { id, token }
	}
	return { ...h, users }
}

export async function remoteAccount(store: StoreStub, username: string, domain = 'remote.example'): Promise<string> {
	return seedAccount(store, { username, domain })
}

export type SeedStatus = {
	accountId: string
	visibility: Visibility
	content?: string
	mentions?: { accountId: string; silent?: boolean }[]
	inReplyToId?: string
	reblogOfId?: string
	tags?: string[]
	uri?: string
	published?: number
}

const seedStatusOperation = writeOperation<SeedStatus & { now: number }, string>((db, input) => {
	const id = allocateLocalId(db, input.published ?? input.now)
	const parentUri =
		input.inReplyToId === undefined
			? null
			: (db.first<{ uri: string }>('SELECT uri FROM statuses WHERE id = ?', input.inReplyToId)?.uri ?? null)
	db.run(
		`INSERT INTO statuses (id, uri, account_id, reblog_of_id, in_reply_to_uri, in_reply_to_id, visibility, content,
			published_at, search_text)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id,
		input.uri ?? `https://remote.example/objects/${id}`,
		input.accountId,
		input.reblogOfId ?? null,
		parentUri,
		input.inReplyToId ?? null,
		input.visibility,
		input.reblogOfId === undefined ? (input.content ?? `<p>status ${id}</p>`) : '',
		new Date(input.published ?? input.now).toISOString(),
		input.reblogOfId === undefined ? normalizeSearchText(htmlToPlainText(input.content ?? '')) : null
	)
	for (const mention of input.mentions ?? []) {
		db.run(
			'INSERT INTO status_mentions (status_id, account_id, silent) VALUES (?, ?, ?)',
			id,
			mention.accountId,
			mention.silent === true ? 1 : 0
		)
	}
	for (const tag of input.tags ?? []) {
		db.run(
			"INSERT INTO status_tags (status_id, name, public) SELECT id, ?, visibility = 'public' FROM statuses WHERE id = ?",
			tag,
			id
		)
	}
	return id
})

// Writes a status row directly (a remote status, a limited one, a boost by a remote account, ...).
export async function seedStatus(store: StoreStub, status: SeedStatus): Promise<string> {
	return runInDurableObject(store, (_instance, state) =>
		seedStatusOperation.run(state.storage.sql, { ...status, now: NOW })
	)
}

export async function post(h: ApiHarness, user: User, body: Record<string, unknown>): Promise<Status> {
	const response = await h.request('/api/v1/statuses', bearer(user.token, json(body)))
	if (response.status !== 200) {
		throw new Error(`post failed: ${response.status} ${await response.text()}`)
	}
	return response.json()
}

export async function act(h: ApiHarness, user: User, path: string, body: Record<string, unknown> = {}) {
	return h.request(path, bearer(user.token, json(body)))
}

export async function follow(h: ApiHarness, user: User, targetId: string): Promise<void> {
	const response = await act(h, user, `/api/v1/accounts/${targetId}/follow`)
	if (response.status !== 200) {
		throw new Error(`follow failed: ${response.status} ${await response.text()}`)
	}
}

// A remote account following a local one, as an accepted inbound Follow leaves it.
export async function remoteFollows(store: StoreStub, followerId: string, targetId: string): Promise<void> {
	await sql(
		store,
		"INSERT INTO follows (account_id, target_account_id, state, created_at) VALUES (?, ?, 'accepted', ?)",
		followerId,
		targetId,
		new Date(NOW).toISOString()
	)
}

export async function block(store: StoreStub, accountId: string, targetId: string): Promise<void> {
	await sql(store, 'INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)', accountId, targetId)
}

export async function mute(
	store: StoreStub,
	accountId: string,
	targetId: string,
	hideNotifications = true
): Promise<void> {
	await sql(
		store,
		'INSERT INTO mutes (account_id, target_account_id, hide_notifications) VALUES (?, ?, ?)',
		accountId,
		targetId,
		hideNotifications ? 1 : 0
	)
}

export async function domainBlock(store: StoreStub, accountId: string, domain: string): Promise<void> {
	await sql(store, 'INSERT INTO domain_blocks (account_id, domain) VALUES (?, ?)', accountId, domain)
}

export async function getJson<T = unknown>(
	h: ApiHarness,
	path: string,
	token?: string
): Promise<{ status: number; body: T }> {
	const response = await h.request(path, token === undefined ? {} : bearer(token))
	return { status: response.status, body: (await response.json()) as T }
}

export async function ids(h: ApiHarness, path: string, token?: string): Promise<string[]> {
	const { status, body } = await getJson<{ id: string }[]>(h, path, token)
	if (status !== 200) {
		throw new Error(`${path}: ${status} ${JSON.stringify(body)}`)
	}
	return body.map((item) => item.id)
}

export type Outbound = {
	activity: Record<string, unknown> & { type: string; to?: string[]; cc?: string[]; object?: unknown }
	audience: { followers: boolean; accounts: string[] }
}

export async function outbound(store: StoreStub): Promise<(Outbound & { signer: string })[]> {
	const rows = await sql<{ account_id: string; body: string }>(
		store,
		'SELECT account_id, body FROM outbound_activities ORDER BY id'
	)
	return rows.map((row) => ({ signer: row.account_id, ...(JSON.parse(row.body) as Outbound) }))
}
