import { type Database, QueryBuilder } from 'wildebeest/backend/src/database'
import type { Env } from 'wildebeest/backend/src/types'

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

	psqlOnly(): string {
		return ''
	},

	jsonSet(obj: string, field: string, value: string): string {
		return `json_set(${obj}, '$.${field}', ${value})`
	},

	timeNormalize(column: string): string {
		return `strftime('%Y-%m-%d %H:%M:%f', ${column})`
	},
}

export default function make({ DATABASE }: Pick<Env, 'DATABASE'>): Database {
	const db = DATABASE as any
	db.qb = qb
	db.client = 'd1'

	return db as Database
}
