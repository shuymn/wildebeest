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

// An app token (no user) with the given scope.
export async function appTokenWith(h: ApiHarness, scope: string): Promise<string> {
	const app = await registerApp(h, { scopes: scope })
	const response = await h.request(
		'/oauth/token',
		form({ grant_type: 'client_credentials', client_id: app.client_id, client_secret: app.client_secret, scope })
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
				return watchedCursor(cursor, () => (read += cursor.rowsRead))
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

// A SqlStorage over `real` that hands the rows each statement returns to `observe` (with the statement), as they leave
// SQLite: all at once for toArray and one, and once the statement is done or abandoned when Db.iterate steps it.
export function observedSql(real: SqlStorage, observe: (rows: readonly SqlRow[], query: string) => void): SqlStorage {
	return {
		exec: (query: string, ...params: SqlStorageValue[]) =>
			watchedCursor(
				real.exec(query, ...params),
				() => {},
				(rows) => observe(rows, query)
			),
	} as unknown as SqlStorage
}

// A cursor for a test's SqlStorage wrapper, over `cursor`: toArray, one and row-by-row iteration (Db.iterate), with
// `done` called after each read (once a stepped statement is done or abandoned) and `seen` given the rows it returned.
export function watchedCursor(
	cursor: SqlStorageCursor<SqlRow>,
	done: () => void,
	seen: (rows: SqlRow[]) => void = () => {}
) {
	const finished = (rows: SqlRow[]) => {
		seen(rows)
		done()
		return rows
	}
	return {
		toArray: () => finished(cursor.toArray()),
		one: () => finished([cursor.one()])[0]!,
		get rowsRead() {
			return cursor.rowsRead
		},
		get rowsWritten() {
			return cursor.rowsWritten
		},
		[Symbol.iterator](): IterableIterator<SqlRow> {
			const rows: SqlRow[] = []
			let open = true
			const close = () => {
				if (open) {
					open = false
					finished(rows)
				}
			}
			return {
				next: () => {
					const step = cursor.next()
					if (step.done === true) {
						close()
					} else {
						rows.push(step.value)
					}
					return step
				},
				return: (value?: unknown) => {
					close()
					return { done: true, value }
				},
				[Symbol.iterator]() {
					return this
				},
			} as IterableIterator<SqlRow>
		},
	}
}

// The longest string among `rows`' values, in UTF-16 code units.
export function longestString(rows: readonly SqlRow[]): number {
	let most = 0
	for (const value of rows.flatMap((row) => Object.values(row))) {
		most = Math.max(most, typeof value === 'string' ? value.length : 0)
	}
	return most
}
