import m0000 from '../../migrations/0000_initial.sql'
import m0002 from '../../migrations/0002_web_push.sql'

// Store migrations in apply order. Append only: an applied file is recorded by name and checksum and must
// never change. Each file runs in its own transaction, must finish well under 30 seconds, and must be pure SQL.
export const MIGRATIONS: readonly { name: string; sql: string }[] = [
	{ name: '0000_initial', sql: m0000 },
	{ name: '0002_web_push', sql: m0002 },
]
