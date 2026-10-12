import { runInDurableObject } from 'cloudflare:test'

import { BUILD } from './helpers'
import { readDumpFile, statementChunks } from '../cli/lib/format.js'
import { END_LINE } from '../src/platform/dump-format'
import type { StoreStub } from '../src/platform/store-client'
import type { DumpCursor } from '../src/platform/store-dump'

export const ADMIN_EMAIL = 'admin@kopje.test'
export const TEAM_DOMAIN = 'kopje-team.cloudflareaccess.com'
export const ADMIN_AUD = 'aud-admin-0123456789'
export const SERVICE_CLIENT_ID = 'cli-client.access'

function id(n: number): string {
	return String(110_000_000_000_000_000n + BigInt(n))
}

// Fills a migrated Store with rows that exercise the dump format: BLOBs, NUL inside TEXT, quotes, newlines and
// non-ASCII text, a reply whose row comes before its parent's (so the reference must be linked after all rows),
// a boost, AUTOINCREMENT counters ahead of max(id), WITHOUT ROWID tables, and allowlisted and excluded kopje_state.
// `statuses` extra statuses make the dump span many chunks.
export async function seedStore(store: StoreStub, statuses = 0): Promise<void> {
	await runInDurableObject(store, (_instance, state) => {
		const sql = state.storage.sql
		const now = '2026-10-12T00:00:00.000Z'
		sql.exec(
			`INSERT INTO accounts (id, uri, username, domain, display_name, note) VALUES
			 (?, 'https://kopje.test/ap/users/alice', 'alice', NULL, 'Alice ''A''', 'line1
line2 ✓ 🦬'),
			 (?, 'https://remote.test/users/bob', 'bob', 'remote.test', 'Bob', '')`,
			id(1),
			id(2)
		)
		sql.exec(
			`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, ?, ?, 'PUBKEY')`,
			id(1),
			'alice@kopje.test',
			new Uint8Array([0, 1, 2, 255, 39, 10]),
			new Uint8Array([9, 8, 7])
		)
		// The reply arrives first with its parent unresolved, then the parent, then the link is resolved.
		sql.exec(
			`INSERT INTO statuses (id, uri, account_id, in_reply_to_uri, visibility, content, published_at)
			 VALUES (?, 'https://remote.test/s/reply', ?, 'https://kopje.test/ap/o/parent', 'public', ?, ?)`,
			id(10),
			id(2),
			`nul${String.fromCharCode(0)}inside 'q' ;\n`,
			now
		)
		sql.exec(
			`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			 VALUES (?, 'https://kopje.test/ap/o/parent', ?, 'public', 'parent', ?)`,
			id(11),
			id(1),
			now
		)
		sql.exec('UPDATE statuses SET in_reply_to_id = ? WHERE id = ?', id(11), id(10))
		sql.exec(
			`INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at)
			 VALUES (?, 'https://remote.test/announce/1', ?, ?, 'public', ?)`,
			id(12),
			id(2),
			id(11),
			now
		)
		for (let i = 0; i < statuses; i++) {
			sql.exec(
				`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at) VALUES (?, ?, ?, 'public', ?, ?)`,
				id(1000 + i),
				`https://kopje.test/ap/o/bulk-${i}`,
				id(1),
				`bulk ${i} ${'x'.repeat(400)}`,
				now
			)
		}
		sql.exec("INSERT INTO status_tags (status_id, name) VALUES (?, 'kopje'), (?, 'zebra')", id(11), id(11))
		sql.exec(
			"INSERT INTO notifications (id, account_id, type, from_account_id, status_id) VALUES (5, ?, 'favourite', ?, ?), (9, ?, 'follow', ?, NULL)",
			id(1),
			id(2),
			id(11),
			id(1),
			id(2)
		)
		// The counter stays ahead of max(id) after a delete; the dump must keep it.
		sql.exec('DELETE FROM notifications WHERE id = 9')
		sql.exec("INSERT INTO instance_settings (name, value) VALUES ('domain', 'kopje.test'), ('title', 'Kopje')")
		sql.exec(
			"INSERT INTO inbound_spool (spool_id, part, part_count, fragment, spooled_at) VALUES ('s1', 0, 2, ?, 1)",
			new Uint8Array([120, 156, 0])
		)
		sql.exec(
			"INSERT INTO fedify_kv (key, value, expires_at) VALUES ('[\"k\",1]', '{\"v\":true}', NULL), ('[\"a\"]', '1', 5)"
		)
		sql.exec("INSERT OR REPLACE INTO kopje_state (name, value) VALUES ('last_local_id', ?)", id(99))
		sql.exec("INSERT OR REPLACE INTO kopje_state (name, value) VALUES ('upgrade_bookmark', 'source-only')")
	})
}

export async function setAccess(store: StoreStub, overrides: Record<string, string> = {}): Promise<void> {
	const settings: Record<string, string> = {
		access_team_domain: TEAM_DOMAIN,
		access_admin_aud: ADMIN_AUD,
		admin_email: ADMIN_EMAIL,
		access_service_token_client_id: SERVICE_CLIENT_ID,
		...overrides,
	}
	await runInDurableObject(store, (_instance, state) => {
		for (const [name, value] of Object.entries(settings)) {
			state.storage.sql.exec('INSERT OR REPLACE INTO instance_settings (name, value) VALUES (?, ?)', name, value)
		}
	})
}

// A full dump through the Store RPCs, as the CLI does it but in memory.
export async function dumpViaRpc(store: StoreStub, maxBytes?: number): Promise<{ text: string; chunks: number }> {
	const started = await store.dumpStart(BUILD)
	if (!started.ok) {
		throw new Error(started.message)
	}
	let text = started.headerLine
	let cursor: DumpCursor = started.cursor
	let chunks = 0
	for (;;) {
		const step = await store.dumpNext(BUILD, cursor, maxBytes)
		if (!step.ok) {
			throw new Error(step.message)
		}
		text += new TextDecoder().decode(step.chunk)
		cursor = step.cursor
		chunks++
		if (step.done) {
			break
		}
	}
	const finished = await store.dumpFinish(BUILD, cursor)
	if (!finished.ok) {
		throw new Error(finished.message)
	}
	return { text: text + (finished.trailerText ?? ''), chunks }
}

export function splitDump(text: string): { header: unknown; body: string; trailer: unknown } {
	const lines = text.split('\n')
	const header = JSON.parse((lines[0] ?? '').replace(/^-- kopje-dump-header /, ''))
	const trailerLine = text.lastIndexOf('\n-- kopje-dump-trailer ')
	const bodyStart = (lines[0] ?? '').length + 1
	const body = text.slice(bodyStart, trailerLine + 1)
	const trailerText = text.slice(trailerLine + 1, text.length - END_LINE.length - 2)
	return { header, body, trailer: JSON.parse(trailerText.replace(/^-- kopje-dump-trailer /, '')) }
}

// Every dumped table's rows as literal tuples, for comparing two Stores.
export async function tableSnapshot(store: StoreStub): Promise<Record<string, string[]>> {
	return runInDurableObject(store, (_instance, state) => {
		const sql = state.storage.sql
		const out: Record<string, string[]> = {}
		const tables = sql
			.exec<{
				name: string
			}>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT IN ('kopje_migrations', 'kopje_state') ORDER BY name"
			)
			.toArray()
		for (const { name } of tables) {
			const columns = sql
				.exec<{ name: string }>('SELECT name FROM pragma_table_info(?)', name)
				.toArray()
				.map((c) => `quote(hex(CAST("${c.name}" AS BLOB))) || typeof("${c.name}")`)
			out[name] = sql
				.exec<{ row: string }>(`SELECT ${columns.join(" || ',' || ")} AS row FROM "${name}" ORDER BY 1`)
				.toArray()
				.map((r) => r.row)
		}
		out.kopje_state = sql
			.exec<{ row: string }>("SELECT name || '=' || value AS row FROM kopje_state ORDER BY name")
			.toArray()
			.map((r) => r.row)
		return out
	})
}

// In-memory FileIO for the CLI code, with an optional hook that fails an append (a crash mid-write).
export function memoryIO(files = new Map<string, Uint8Array>()) {
	const io = {
		files,
		failAppend: null as null | ((path: string, bytes: Uint8Array) => Uint8Array | null),
		size: (path: string) => Promise.resolve(files.get(path)?.byteLength ?? null),
		read: (path: string, position: number, length: number) =>
			Promise.resolve((files.get(path) ?? new Uint8Array()).slice(position, position + length)),
		// When failAppend returns bytes, only those are written and the append fails.
		append: (path: string, bytes: Uint8Array) => {
			const partial = io.failAppend?.(path, bytes) ?? null
			const written = partial ?? bytes
			const current = files.get(path) ?? new Uint8Array()
			const next = new Uint8Array(current.byteLength + written.byteLength)
			next.set(current, 0)
			next.set(written, current.byteLength)
			files.set(path, next)
			return partial === null ? Promise.resolve() : Promise.reject(new Error('disk full'))
		},
		truncate: (path: string, length: number) => {
			files.set(path, (files.get(path) ?? new Uint8Array()).slice(0, length))
			return Promise.resolve()
		},
		readText: (path: string) => {
			const bytes = files.get(path)
			return Promise.resolve(bytes === undefined ? null : new TextDecoder().decode(bytes))
		},
		writeTextAtomic: (path: string, text: string) => {
			files.set(path, new TextEncoder().encode(text))
			return Promise.resolve()
		},
		remove: (path: string) => {
			files.delete(path)
			return Promise.resolve()
		},
		text: (path: string) => new TextDecoder().decode(files.get(path)),
	}
	return io
}

// Statement chunks of a dump text as the CLI would send them.
export async function importChunks(text: string, chunkBytes: number): Promise<Uint8Array[]> {
	const io = memoryIO(new Map([['dump.sql', new TextEncoder().encode(text)]]))
	const file = await readDumpFile(io, 'dump.sql')
	const chunks: Uint8Array[] = []
	for await (const chunk of statementChunks(io, 'dump.sql', file.bodyStart, file.bodyEnd, chunkBytes)) {
		chunks.push(chunk.bytes)
	}
	return chunks
}

export async function beginImport(store: StoreStub, text: string): Promise<string> {
	const begun = await store.importBegin(BUILD, splitDump(text).header, 'access')
	if (!begun.ok) {
		throw new Error(`${begun.code}: ${begun.message}`)
	}
	return begun.progress.id
}

// Finishes an import whose chunks are all applied and runs verification to the end.
export async function finishImport(store: StoreStub, id: string, text: string) {
	const finished = await store.importFinish(BUILD, id, splitDump(text).trailer)
	if (!finished.ok) {
		throw new Error(`${finished.code}: ${finished.message}`)
	}
	for (;;) {
		const verified = await store.importVerify(BUILD, id)
		if (!verified.ok) {
			throw new Error(`${verified.code}: ${verified.message}`)
		}
		if (verified.done) {
			return verified.report
		}
	}
}

// Imports a dump text through the Store RPCs and verifies it.
export async function importViaRpc(store: StoreStub, text: string, chunkBytes = 64 * 1024) {
	const id = await beginImport(store, text)
	let seq = 0
	for (const chunk of await importChunks(text, chunkBytes)) {
		const result = await store.importChunk(BUILD, id, ++seq, chunk)
		if (!result.ok) {
			throw new Error(`${result.code}: ${result.message}`)
		}
	}
	return { id, chunks: seq, report: await finishImport(store, id, text) }
}
