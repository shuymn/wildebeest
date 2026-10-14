import m0000 from '../../migrations/0000_initial.sql'
import m0001 from '../../migrations/0001_mute_expiry.sql'

// Store migrations in apply order. Append only: an applied file is recorded by name and checksum and must
// never change. Each file runs in its own transaction, must finish well under 30 seconds, and must be pure SQL.
export const MIGRATIONS: readonly { name: string; sql: string }[] = [
	{ name: '0000_initial', sql: m0000 },
	{ name: '0001_mute_expiry', sql: m0001 },
]
