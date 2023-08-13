import type { Database } from 'wildebeest/backend/src/database'
import { insertIdSequence } from 'wildebeest/backend/src/database/d1/querier'
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
	const { value } = (await insertIdSequence(db, { key: table + '_id_seq' })) as { value: number }
	return value
}
