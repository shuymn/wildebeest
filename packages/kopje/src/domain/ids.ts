import type { Db } from '../db/sql'

// A new generation of a quote's work (quotes.ts): drawn by every write the rule at the column names (migration
// 0033_quotes). Kept here, in a module that imports nothing, because inbox.ts builds a statement with it when it is
// loaded, whichever module of the domain's import cycle is loaded first.
export const NEW_GENERATION = '(abs(random()) % 9007199254740991)'

// API IDs: 18-digit snowflakes, (ms << 16) | 16 random bits, kept as TEXT and never read as JS numbers.

// Returns an integer in [0, maxExclusive).
export type RandomInt = (maxExclusive: number) => number

// Masks to the smallest power of two covering the range and draws again when the value falls outside it, so the
// result stays uniform (modulo would bias it). maxExclusive must be in [1, 2^31].
export const cryptoRandomInt: RandomInt = (maxExclusive) => {
	const mask = 2 ** Math.ceil(Math.log2(maxExclusive)) - 1
	const buffer = new Uint32Array(1)
	for (;;) {
		const value = (crypto.getRandomValues(buffer)[0] ?? 0) & mask
		if (value < maxExclusive) {
			return value
		}
	}
}

// IDs before this date would have fewer than 18 digits.
const EARLIEST_MS = Date.UTC(2018, 4, 10)

function snowflakeValue(ms: number, random: RandomInt): bigint {
	return (BigInt(ms) << 16n) | BigInt(random(0x10000))
}

function format(id: bigint): string {
	const text = id.toString()
	if (text.length !== 18) {
		throw new RangeError(`snowflake out of range: ${text}`)
	}
	return text
}

const LAST_LOCAL_ID = 'last_local_id'

// Allocates a local ID: max((now << 16) | rand16, last + 1), so IDs strictly increase even within one millisecond
// or when the clock goes back. The last ID lives in the Store state table, and the call must run inside the write
// operation that uses the ID, so both commit or roll back together. The clock comes from the caller (inside a DO,
// Date.now() does not advance during a request).
export function allocateLocalId(db: Db, nowMs: number, random: RandomInt = cryptoRandomInt): string {
	const last = db.first<{ value: string }>('SELECT value FROM kopje_state WHERE name = ?', LAST_LOCAL_ID)?.value
	const candidate = snowflakeValue(Math.max(nowMs, EARLIEST_MS), random)
	const id = format(last !== undefined && candidate <= BigInt(last) ? BigInt(last) + 1n : candidate)
	db.run('INSERT OR REPLACE INTO kopje_state (name, value) VALUES (?, ?)', LAST_LOCAL_ID, id)
	return id
}

// Remote objects use `published` truncated to the second plus 0-999 random ms. Future or unparsable times use now;
// times before 2018-05-10 are raised to that date.
export function remoteId(published: string, nowMs: number, random: RandomInt = cryptoRandomInt): string {
	const parsed = Date.parse(published)
	const ms = Math.max(Number.isNaN(parsed) || parsed > nowMs ? nowMs : parsed, EARLIEST_MS)
	return format(snowflakeValue(Math.floor(ms / 1000) * 1000 + random(1000), random))
}

const MAX_ID_ATTEMPTS = 5

// Inserts with a generated ID and generates a new one when the ID collides. Other UNIQUE violations propagate.
export function insertWithFreshId<T>(table: string, generate: () => string, insert: (id: string) => T): T {
	for (let attempt = 1; ; attempt++) {
		const id = generate()
		try {
			return insert(id)
		} catch (error) {
			const collided = error instanceof Error && error.message.includes(`UNIQUE constraint failed: ${table}.id`)
			if (!collided || attempt >= MAX_ID_ATTEMPTS) {
				throw error
			}
		}
	}
}
