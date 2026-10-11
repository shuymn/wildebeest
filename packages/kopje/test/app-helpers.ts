import { createExecutionContext, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

import { vi } from 'vitest'

import { BUILD, freshStore } from './helpers'
import { createApp } from '../src/app/app'
import { MIGRATIONS } from '../src/db/migrations'
import type { StoreStub } from '../src/platform/store-client'
import { StoreKernel } from '../src/platform/store-kernel'

export const NOW = Date.parse('2026-10-12T00:00:00.000Z')

export async function migratedStore(): Promise<StoreStub> {
	const store = freshStore()
	await runInDurableObject(store, (_instance, state) =>
		new StoreKernel(state, { build: BUILD, migrations: MIGRATIONS, log: () => {} }).upgrade()
	)
	return store
}

// The real app over a given Store, with env overrides and a recording queue.
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

export function harness(store: StoreStub, overrides: Record<string, unknown> = {}, build = BUILD) {
	const send = vi.fn<(body: unknown, options?: QueueSendOptions) => Promise<void>>(() => Promise.resolve())
	const testEnv = { ...env, QUEUE: { send }, ...overrides } as unknown as Env
	const app = createApp({ build: () => build, now: () => NOW, store: () => store })
	const request = (path: string, init?: RequestInit) =>
		app.fetch(new Request(`https://kopje.test${path}`, init), testEnv, createExecutionContext())
	return { app, request, send }
}
