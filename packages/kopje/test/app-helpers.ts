import { createExecutionContext, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

import { BUILD, migratedStore } from './helpers'
import { QueueSim } from './queue-sim'
import { createApp } from '../src/app/app'
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

// The real app over a given Store, with env overrides and a simulated queue that enforces the platform limits.
export function harness(store: StoreStub, overrides: Record<string, unknown> = {}, build = BUILD) {
	const queue = new QueueSim()
	const send = queue.send
	const testEnv = { ...env, QUEUE: queue.queue, ...overrides } as unknown as Env
	const app = createApp({ build: () => build, now: () => NOW, store: () => store })
	const request = (path: string, init?: RequestInit) =>
		app.fetch(new Request(`https://kopje.test${path}`, init), testEnv, createExecutionContext())
	return { app, request, send, queue, env: testEnv }
}
