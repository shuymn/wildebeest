import type { Database } from '@wildebeest/backend/database'
import { insertIdSequence } from '@wildebeest/backend/database/d1/querier'
import { MastodonId } from '@wildebeest/backend/types'

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

if (import.meta.vitest) {
	const { makeDB } = await import('@wildebeest/backend/test/utils')
	test('generateMastodonId', async () => {
		const db = makeDB()

		// @ts-expect-error for testing
		randomBytes = () => '0123456789abcdef0123456789abcdef'

		const id1 = await generateMastodonId(db, 'test', new Date('2022-12-18T14:42:59.001Z'))
		expect(id1).toBe('109535204409443108')
		const first = await db
			.prepare(`SELECT value FROM id_sequences WHERE key = 'test_id_seq'`)
			.first<{ value: number }>()
		expect(first?.value).toBe(1)

		const id2 = await generateMastodonId(db, 'test', new Date('2022-12-18T14:42:59.002Z'))
		expect(id2).toBe('109535204409475804')
		const second = await db
			.prepare(`SELECT value FROM id_sequences WHERE key = 'test_id_seq'`)
			.first<{ value: number }>()
		expect(second?.value).toBe(2)

		const id3 = await generateMastodonId(db, 'test', new Date('2022-12-18T14:42:59.002Z'))
		expect(id3 !== id2).toBe(true)

		const id4 = await generateMastodonId(db, 'test', new Date('2022-12-18T14:42:59.003Z'))
		expect(id4 > id3).toBe(true)
	})
}
