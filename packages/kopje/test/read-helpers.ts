import { runInDurableObject } from 'cloudflare:test'

import { type ApiHarness, form, login, registerApp, sql } from './api-helpers'
import type { StoreOperation } from '../src/platform/store-kernel'

// Fixtures for the read endpoints clients call at startup: tokens of limited reach, rows-read measurement (RES-7) and
// many remote accounts.

export const DAY_MS = 86_400_000

export async function appToken(h: ApiHarness): Promise<string> {
	const app = await registerApp(h)
	const response = await h.request(
		'/oauth/token',
		form({ grant_type: 'client_credentials', client_id: app.client_id, client_secret: app.client_secret })
	)
	return (await response.json<{ access_token: string }>()).access_token
}

// A token of alice's with only the given scope.
export async function scopedToken(h: ApiHarness, scope: string): Promise<string> {
	const app = await registerApp(h, { scopes: scope })
	return (await login(h, { app, scope, email: 'alice@example.com' })).token
}

// Runs a read operation over a SqlStorage that counts the rows each statement reads.
export async function rowsRead<I>(
	h: Pick<ApiHarness, 'store'>,
	operation: StoreOperation<I, unknown>,
	input: I
): Promise<number> {
	return runInDurableObject(h.store, (_instance, state) => {
		let read = 0
		const real = state.storage.sql
		const counting = {
			exec: (query: string, ...params: SqlStorageValue[]) => {
				const cursor = real.exec(query, ...params)
				return {
					toArray: () => {
						const rows = cursor.toArray()
						read += cursor.rowsRead
						return rows
					},
				}
			},
		} as unknown as SqlStorage
		operation.run(counting, input)
		return read
	})
}

export async function remoteAccounts(h: ApiHarness, domains: number, perDomain: number, base = 500000000000000000n) {
	await sql(
		h.store,
		`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ? - 1)
		INSERT INTO accounts (id, uri, username, domain)
		SELECT CAST(? + i AS TEXT), 'https://d' || (i % ?) || '.example/users/u' || i, 'u' || i, 'd' || (i % ?) || '.example'
		FROM n`,
		domains * perDomain,
		String(base),
		domains,
		domains
	)
}

export type SqlRow = Record<string, SqlStorageValue>

// A SqlStorage over `real` that hands every row a statement returns (toArray or one) to `observe`, as it leaves SQLite.
export function observedSql(real: SqlStorage, observe: (rows: readonly SqlRow[]) => void): SqlStorage {
	return {
		exec: (query: string, ...params: SqlStorageValue[]) => {
			const cursor = real.exec(query, ...params)
			const seen = (rows: SqlRow[]) => {
				observe(rows)
				return rows
			}
			return { toArray: () => seen(cursor.toArray()), one: () => seen([cursor.one()])[0]! }
		},
	} as unknown as SqlStorage
}

// The longest string among `rows`' values, in UTF-16 code units.
export function longestString(rows: readonly SqlRow[]): number {
	let most = 0
	for (const value of rows.flatMap((row) => Object.values(row))) {
		most = Math.max(most, typeof value === 'string' ? value.length : 0)
	}
	return most
}
