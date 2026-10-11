import m0000 from '../../migrations/0000_initial.sql'

// Store migrations in apply order. Append only: an applied file is recorded by name and checksum and must
// never change. Each file runs in its own transaction, must finish well under 30 seconds, and must be pure SQL.
export const MIGRATIONS: readonly { name: string; sql: string }[] = [{ name: '0000_initial', sql: m0000 }]
