import type { Database } from 'wildebeest/backend/src/database'
import { MastodonId } from 'wildebeest/backend/src/types'

export async function generateMastodonId(db: Database, table: string, now: Date): Promise<MastodonId> {
	if (now === undefined) {
		now = new Date()
	}
	const timePart = BigInt(now.getTime()) << 16n

	const digest = await crypto.subtle.digest(
		{ name: 'MD5' },
		new TextEncoder().encode(table + randomBytes(16) + String(timePart))
	)
	const hash = bytesToHex(new Uint8Array(digest))

	const sequenceBase = BigInt('0x' + hash.substring(0, 4))
	const tail = (sequenceBase + BigInt(await nextval(db, table))) & 65535n

	return String(timePart | tail)
}

function randomBytes(length: number): string {
	const buffer = new Uint8Array(length)
	crypto.getRandomValues(buffer)
	return bytesToHex(buffer)
}

function bytesToHex(bytes: Uint8Array): string {
	return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function nextval(db: Database, table: string): Promise<number> {
	const key = table + '_id_seq'
	const { value } = await db
		.prepare(
			`
INSERT INTO id_sequences (key, value)
VALUES (?1, COALESCE((SELECT value FROM id_sequences WHERE key = ?1), 0) + 1)
ON CONFLICT(key) DO UPDATE SET value = excluded.value
RETURNING value;
`
		)
		.bind(key)
		.first<{ value: number }>()
		.then((row) => {
			if (!row) {
				throw new Error('row is undefined')
			}
			return row
		})

	return value
}
