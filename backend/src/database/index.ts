import type { Env } from 'wildebeest/backend/src/types'

export interface Database extends D1Database {
	prepare(query: string): PreparedStatement
	dump(): Promise<ArrayBuffer>
	batch<T = unknown>(statements: PreparedStatement[]): Promise<D1Result<T>[]>
	exec(query: string): Promise<D1ExecResult>
	qb: QueryBuilder
}

export interface PreparedStatement extends D1PreparedStatement {
	// https://developers.cloudflare.com/d1/platform/client-api/#type-conversion
	bind(...values: (null | number | string | boolean | ArrayBuffer)[]): PreparedStatement
}

export interface QueryBuilder {
	jsonExtract(obj: string, prop: string): string
	jsonExtractIsNull(obj: string, prop: string): string
	jsonArrayLength(array: string): string
	set(array: string): string
	epoch(): string
	insertOrIgnore(q: string): string
	jsonSet(obj: string, field: string, value: string): string
	timeNormalize(column: string): string
}

const qb: QueryBuilder = {
	jsonExtract(obj: string, prop: string): string {
		return `json_extract(${obj}, '$.${prop}')`
	},

	jsonExtractIsNull(obj: string, prop: string): string {
		return `${qb.jsonExtract(obj, prop)} IS NULL`
	},

	jsonArrayLength(array: string): string {
		return `json_array_length(${array})`
	},

	set(array: string): string {
		return `(SELECT value FROM json_each(${array}))`
	},

	epoch(): string {
		return '00-00-00 00:00:00'
	},

	insertOrIgnore(q: string): string {
		return `INSERT OR IGNORE ${q}`
	},

	jsonSet(obj: string, field: string, value: string): string {
		return `json_set(${obj}, '$.${field}', ${value})`
	},

	timeNormalize(column: string): string {
		return `strftime('%Y-%m-%d %H:%M:%f', ${column})`
	},
}

export async function getDatabase({ DATABASE }: Pick<Env, 'DATABASE'>): Promise<Database> {
	const db = DATABASE

	return {
		prepare: (query: string) => db.prepare(query),
		dump: () => db.dump(),
		batch: <T = unknown>(statements: PreparedStatement[]) => db.batch<T>(statements),
		exec: (query: string) => db.exec(query),
		qb,
	}
}
