import { env } from 'cloudflare:workers'

import type { StoreStub } from '../src/platform/store-client'

// The build identity of this test run: the Workers version id that both the Worker and the Store see.
export const BUILD = env.CF_VERSION_METADATA.id

// Each test gets its own Store object, so test files can run in parallel without sharing state.
export function freshStore(): StoreStub {
	return env.STORE.getByName(crypto.randomUUID())
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
