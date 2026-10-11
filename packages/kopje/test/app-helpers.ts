import { createExecutionContext, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

import { vi } from 'vitest'

import { freshStore } from './helpers'
import { createApp } from '../src/app/app'
import { MIGRATIONS } from '../src/db/migrations'
import type { StoreStub } from '../src/platform/store-client'
import { StoreKernel } from '../src/platform/store-kernel'
import { BUILD_VERSION } from '../src/version'

export const NOW = Date.parse('2026-10-12T00:00:00.000Z')

export async function migratedStore(): Promise<StoreStub> {
	const store = freshStore()
	await runInDurableObject(store, (_instance, state) =>
		new StoreKernel(state, { build: BUILD_VERSION, migrations: MIGRATIONS, log: () => {} }).upgrade()
	)
	return store
}

// The real app over a given Store, with env overrides and a recording queue.
export function harness(store: StoreStub, overrides: Record<string, unknown> = {}, build = BUILD_VERSION) {
	const send = vi.fn<(body: unknown, options?: QueueSendOptions) => Promise<void>>(() => Promise.resolve())
	const testEnv = { ...env, QUEUE: { send }, ...overrides } as unknown as Env
	const app = createApp({ build, now: () => NOW, store: () => store })
	const request = (path: string, init?: RequestInit) =>
		app.fetch(new Request(`https://kopje.test${path}`, init), testEnv, createExecutionContext())
	return { request, send }
}
