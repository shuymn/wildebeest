import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

import { fixtureKeyGen } from './federation-helpers'
import { BUILD, migratedStore } from './helpers'
import { QueueSim } from './queue-sim'
import { type AppDeps, createApp } from '../src/app/app'
import { instanceActorKey } from '../src/federation/federation'
import type { InboxDeps } from '../src/federation/inbox'
import type { QueueDeps } from '../src/jobs/queue'
import { readConfig, userKek } from '../src/platform/config'
import type { StoreStub } from '../src/platform/store-client'

export const NOW = Date.parse('2026-10-12T00:00:00.000Z')

// Leaves a persisted readonly hold of this build in a Store whose kernel has not loaded its state yet, as a failed
// upgrade would. Also completes setup so federation routes are reachable.
export async function heldStore(): Promise<StoreStub> {
	const store = await migratedStore()
	await runInDurableObject(store, (_instance, state) => {
		const hold = { reason: 'upgrade-failed', build: BUILD, detail: 'test', at: NOW }
		state.storage.sql.exec("INSERT INTO kopje_state (name, value) VALUES ('hold', ?)", JSON.stringify(hold))
		state.storage.sql.exec("INSERT INTO instance_settings (name, value) VALUES ('domain', 'kopje.test')")
	})
	return store
}

// Remote fetches are refused unless a test injects a fetch.
export const offline: Required<NonNullable<AppDeps['federation']>> = {
	keygen: fixtureKeyGen,
	loader: { fetch: () => Promise.reject(new Error('no network in tests')), checkHost: () => Promise.resolve() },
}

// The real app over a given Store, with env overrides and a simulated queue that enforces the platform limits. A
// request settles its waitUntil work (snapshot saves) before it returns.
export function harness(
	store: StoreStub,
	overrides: Record<string, unknown> = {},
	build = BUILD,
	federation: AppDeps['federation'] = offline,
	now: () => number = () => NOW
) {
	const queue = new QueueSim()
	const send = queue.send
	const testEnv = { ...env, QUEUE: queue.queue, ...overrides } as unknown as Env
	const app = createApp({ build: () => build, now, store: () => store, federation })
	const request = async (path: string, init?: RequestInit) => {
		const ctx = createExecutionContext()
		const response = await app.fetch(new Request(`https://kopje.test${path}`, init), testEnv, ctx)
		await waitOnExecutionContext(ctx)
		return response
	}
	return { app, request, send, queue, env: testEnv }
}

// What the queue consumer needs to replay inbox requests over a given Store, offline unless a loader is given.
// Deliveries a doorbell starts go to the same fetch, never to the network.
export function inboxDeps(store: () => StoreStub, loader: InboxDeps['loader'] = offline.loader) {
	return {
		build: () => BUILD,
		store: () => store(),
		now: () => NOW,
		keygen: fixtureKeyGen,
		loader,
		delivery: { now: () => NOW, fetch: loader.fetch, checkHost: () => Promise.resolve() },
	} satisfies InboxDeps & QueueDeps
}

// One Store call as countingStore saw it: recorded when it starts, its answer or error filled in when it settles.
export type StoreCall = { name: string; args: unknown[]; settled: boolean; answer?: unknown; error?: unknown }

// The instance actor's key, stored as its first use leaves it (federation.ts instanceActorKey) under the test env's
// KEK, so that a count of Store calls leaves out that one-time write.
export async function seedInstanceKey(store: StoreStub): Promise<void> {
	const config = readConfig(env as unknown as Env)
	await instanceActorKey((call) => call(store), BUILD, config.ok ? userKek(config.config) : '', fixtureKeyGen)
}

// The Store with each call recorded in order, as a request makes them: calls has the method names, records the
// calls with their arguments and answers. Each call answers or rejects as the Store did; answered(name) runs once a
// call has answered.
export function countingStore(store: StoreStub, answered: (name: string) => void = () => {}) {
	const calls: string[] = []
	const records: StoreCall[] = []
	const stub = new Proxy(store, {
		get: (target, name) => {
			const value = Reflect.get(target, name) as unknown
			return typeof value === 'function'
				? async (...args: unknown[]) => {
						// Cloned as called: a caller may change an argument (prefetched) after the call.
						const record: StoreCall = { name: String(name), args: structuredClone(args), settled: false }
						calls.push(record.name)
						records.push(record)
						const call = (target as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[String(name)]!
						try {
							record.answer = await call(...args)
						} catch (error) {
							record.error = error
							throw error
						} finally {
							record.settled = true
						}
						answered(record.name)
						return record.answer
					}
				: value
		},
	})
	return { stub, calls, records }
}
