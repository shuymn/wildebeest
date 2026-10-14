import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

import { MIGRATIONS } from '../src/db/migrations'
import type { StoreStub } from '../src/platform/store-client'
import { type KernelOptions, type Migration, StoreKernel } from '../src/platform/store-kernel'

// The build identity of this test run: the Workers version id that both the Worker and the Store see.
export const BUILD = env.CF_VERSION_METADATA.id

// The shipped migrations by name, in order, and the newest: what a migrated Store reports as applied.
export const MIGRATION_NAMES = MIGRATIONS.map((m) => m.name)
export const LATEST_MIGRATION = MIGRATION_NAMES.at(-1)

// Each test gets its own Store object, so test files can run in parallel without sharing state.
export function freshStore(): StoreStub {
	return env.STORE.getByName(crypto.randomUUID())
}

// A kernel of this build with logging silenced.
export function testKernel(
	state: DurableObjectState,
	migrations: readonly Migration[] = MIGRATIONS,
	extra: Partial<KernelOptions> = {}
): StoreKernel {
	return new StoreKernel(state, { build: BUILD, migrations, log: () => {}, ...extra })
}

export async function migratedStore(): Promise<StoreStub> {
	const store = freshStore()
	await runInDurableObject(store, (_instance, state) => testKernel(state).upgrade())
	return store
}

// Fixes the instance domain, as /setup does, so federation routes are reachable.
export async function completeSetup(store: StoreStub): Promise<void> {
	await runInDurableObject(store, (_instance, state) => {
		state.storage.sql.exec("INSERT INTO instance_settings (name, value) VALUES ('domain', 'kopje.test')")
	})
}

// Settles an RPC call and returns its rejection. Handing an RPC promise straight to expect().rejects leaves the
// pipelined promise unhandled in the pool.
export async function rejectionOf(call: Promise<unknown>): Promise<unknown> {
	return call.then(
		() => undefined,
		(error: unknown) => error
	)
}

export function tableNames(sql: SqlStorage): string[] {
	return sql
		.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
		.toArray()
		.map((row) => row.name)
}
