import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

import { BUILD, migratedStore } from './helpers'
import { QueueSim } from './queue-sim'
import { type AppDeps, createApp } from '../src/app/app'
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
const offline: AppDeps['federation'] = {
	loader: { fetch: () => Promise.reject(new Error('no network in tests')), checkHost: () => Promise.resolve() },
}

// The real app over a given Store, with env overrides and a simulated queue that enforces the platform limits. A
// request settles its waitUntil work (snapshot saves) before it returns.
export function harness(
	store: StoreStub,
	overrides: Record<string, unknown> = {},
	build = BUILD,
	federation: AppDeps['federation'] = offline
) {
	const queue = new QueueSim()
	const send = queue.send
	const testEnv = { ...env, QUEUE: queue.queue, ...overrides } as unknown as Env
	const app = createApp({ build: () => build, now: () => NOW, store: () => store, federation })
	const request = async (path: string, init?: RequestInit) => {
		const ctx = createExecutionContext()
		const response = await app.fetch(new Request(`https://kopje.test${path}`, init), testEnv, ctx)
		await waitOnExecutionContext(ctx)
		return response
	}
	return { app, request, send, queue, env: testEnv }
}
