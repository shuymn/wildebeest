import { runInDurableObject } from 'cloudflare:test'

import { expect } from 'vitest'

import { type ApiHarness, bearer, form, login, registerApp, setSetting, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { BUILD } from './helpers'
import { community } from './status-helpers'
import { Db } from '../src/db/sql'
import { remoteModerationRound } from '../src/domain/remote-suspension'
import type { StoreStub } from '../src/platform/store-client'

// Remote suspension through the Mastodon admin API, for the suites of R38 (remote-suspension*.test.ts): the admin
// world, the action and unsuspension, the remote job's rounds, and inbound activities through the Store's inbox.

const OWNER = 'owner@example.com'
const ADMIN_SCOPES = 'read write admin:read admin:write'
export const ORIGIN = 'https://kopje.test'

export async function userToken(h: ApiHarness, email: string, scope: string): Promise<string> {
	const app = await registerApp(h, { scopes: scope })
	return (await login(h, { app, scope, email })).token
}

// The owner (the OAuth admin) and four local accounts, each signed in; `admin` is the owner's admin token.
export async function world(overrides: Record<string, unknown> = {}) {
	const h = await community(['owner', 'alice', 'bob', 'carol', 'dan'], 'read write follow', {}, overrides)
	await setSetting(h.store, 'admin_email', OWNER)
	const admin = await userToken(h, OWNER, ADMIN_SCOPES)
	return { h, admin, ...h.users }
}

export type World = Awaited<ReturnType<typeof world>>

type Answer = { status: number; body: unknown }

async function answer(response: Response): Promise<Answer> {
	return { status: response.status, body: await response.json() }
}

export async function act(w: World, id: string, body: Record<string, string>, token = w.admin): Promise<Answer> {
	return answer(await w.h.request(`/api/v1/admin/accounts/${id}/action`, bearer(token, form(body))))
}

export async function unsuspend(w: World, id: string, token = w.admin): Promise<Answer> {
	return answer(await w.h.request(`/api/v1/admin/accounts/${id}/unsuspend`, bearer(token, { method: 'POST' })))
}

export async function adminEntity(w: World, id: string): Promise<Record<string, unknown>> {
	const response = await w.h.request(`/api/v1/admin/accounts/${id}`, bearer(w.admin))
	expect(response.status).toBe(200)
	return response.json()
}

export async function adminIds(w: World, query: string): Promise<string[]> {
	const response = await w.h.request(`/api/v2/admin/accounts?${query}`, bearer(w.admin))
	expect(response.status).toBe(200)
	return (await response.json<{ id: string }[]>()).map((account) => account.id)
}

export const jobs = (store: StoreStub) =>
	sql<{ kind: string; subject: string; mode: string; phase: string; cursor: string }>(
		store,
		'SELECT kind, subject, mode, phase, cursor FROM remote_moderation_jobs ORDER BY id'
	)

// One round of the remote jobs in its own transaction, as runModerationJobs runs it; with the rows it wrote.
export async function round(
	store: StoreStub,
	after = 0
): Promise<{ id: number; delivers: boolean; rows: number } | null> {
	return runInDurableObject(store, (_instance, state) =>
		state.storage.transactionSync(() => {
			const db = new Db(state.storage.sql)
			const before = db.first<{ n: number }>('SELECT total_changes() AS n')!.n
			const ran = remoteModerationRound(db, NOW, after)
			const rows = db.first<{ n: number }>('SELECT total_changes() AS n')!.n - before
			return ran === null ? null : { ...ran, rows }
		})
	)
}

// Runs the Store's jobs (the moderation jobs among them, as the Queue and the cron do) until none is left; how many
// calls it took.
export async function settle(store: StoreStub): Promise<number> {
	for (let call = 1; call <= 200; call++) {
		if (!(await store.runInboundJobs(BUILD, { now: NOW })).pending) {
			return call
		}
	}
	throw new Error('the jobs did not settle')
}

// Rounds until the job is in the follows phase: the gate before its first Reject.
export async function toFollows(store: StoreStub): Promise<void> {
	for (let i = 0; i < 20; i++) {
		if ((await jobs(store))[0]?.phase === 'follows') {
			return
		}
		await round(store)
	}
	throw new Error('the job never reached its follows phase')
}

// The Rejects recorded so far: their signer, recipient and whether each withdraws (outbound_activities.retracts).
export const rejects = (store: StoreStub) =>
	sql<{ signer: string; follower: string; retracts: number }>(
		store,
		`SELECT account_id AS signer, json_extract(body, '$.activity.object.actor') AS follower, retracts
		FROM outbound_activities WHERE json_extract(body, '$.activity.type') = 'Reject' ORDER BY id`
	)

export const uriOf = async (store: StoreStub, id: string) =>
	(await sql<{ uri: string }>(store, 'SELECT uri FROM accounts WHERE id = ?', id))[0]!.uri

let sequence = 0

// An activity from the remote actor `uri` through the Store's inbox, verified as the Worker passes it with the actor's
// stored row (no document).
export async function receive(
	store: StoreStub,
	uri: string,
	activity: Record<string, unknown> & { type: string }
): Promise<{ applied: boolean; reason: string }> {
	return store.receiveActivity(BUILD, {
		now: NOW,
		origin: ORIGIN,
		actorUri: uri,
		actor: null,
		activity: { id: `${new URL(uri).origin}/activities/${++sequence}`, ...activity },
	} as Parameters<StoreStub['receiveActivity']>[1])
}
