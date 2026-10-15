import { env } from 'cloudflare:workers'

import { afterAll, expect } from 'vitest'

import { Db } from '../src/db/sql'

// Setup of every Workers suite (vitest.config.ts): records each distinct statement the suite runs through Db, in the
// Store or in a test, and after the suite has its expression depth measured on Node (test-node/sql-depth.ts).

export const statements = new Set<string>()

// As test-node/sql-depth.ts reports one.
export type DeepStatement = { depth: number; sql: string }

// eslint-disable-next-line @typescript-eslint/unbound-method -- each is called back on the Db it was called on
const { all, run } = Db.prototype
Db.prototype.all = function (this: Db, query: string, ...params: SqlStorageValue[]) {
	statements.add(query)
	return all.call(this, query, ...params)
} as typeof all
Db.prototype.run = function (this: Db, query: string, ...params: SqlStorageValue[]) {
	statements.add(query)
	return run.call(this, query, ...params)
}

export async function measure(sql: string[]): Promise<DeepStatement[]> {
	const service = (env as unknown as { SQL_DEPTH: Fetcher }).SQL_DEPTH
	const response = await service.fetch('http://sql-depth/', { method: 'POST', body: JSON.stringify(sql) })
	if (!response.ok) {
		throw new Error(await response.text())
	}
	return response.json()
}

afterAll(async () => {
	expect(await measure([...statements])).toEqual([])
})
