import { runInDurableObject } from 'cloudflare:test'

import { LEGACY_EMPTY_KEK } from './federation-helpers'
import { BUILD } from './helpers'
import { IMPORT_CHUNK_STATEMENTS, readDumpFile, statementChunks } from '../cli/lib/format.js'
import { CONFIG_KEYS } from '../src/platform/access-settings'
import { readCatalog } from '../src/platform/dump-catalog'
import { END_LINE } from '../src/platform/dump-format'
import { sha256Hex } from '../src/platform/sha256'
import type { StoreStub } from '../src/platform/store-client'
import type { DumpCursor } from '../src/platform/store-dump'

export const ADMIN_EMAIL = 'admin@kopje.test'
export const TEAM_DOMAIN = 'kopje-team.cloudflareaccess.com'
export const ADMIN_AUD = 'aud-admin-0123456789'
export const SERVICE_CLIENT_ID = 'cli-client.access'

// The authority of an Access-authenticated admin: who, and the Access binding (team, AUD) the Worker verified with.
export const ACCESS = {
	kind: 'access',
	email: 'admin@kopje.test',
	commonName: null,
	teamDomain: 'kopje-team.cloudflareaccess.com',
	aud: 'aud-admin-0123456789',
} as const

// Gives the target the source's configuration (domain, Access settings), as an operator does with config: an import
// never carries configuration.
export async function copyConfig(source: StoreStub, target: StoreStub): Promise<void> {
	const { values } = await source.config(BUILD)
	await runInDurableObject(target, (_instance, state) => {
		for (const [name, value] of Object.entries(values)) {
			state.storage.sql.exec('INSERT OR REPLACE INTO instance_settings (name, value) VALUES (?, ?)', name, value)
		}
	})
}

// Gives a Store the default admin configuration (ACCESS is its admin) unless it has an admin already.
export async function ensureAdmin(store: StoreStub): Promise<void> {
	const { values } = await store.config(BUILD)
	if (values.admin_email === undefined) {
		await setAccess(store)
	}
}

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
			`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, ?, ?, ?)`,
			id(1),
			'alice@kopje.test',
			// A real wrapped key (the health report unwraps it), from the legacy fixture.
			LEGACY_EMPTY_KEK.privkey,
			LEGACY_EMPTY_KEK.salt,
			LEGACY_EMPTY_KEK.pubkey
		)
		// A mute with an expiry (0001): the dump must carry it, or the mute would become indefinite.
		sql.exec(
			`INSERT INTO mutes (account_id, target_account_id, hide_notifications, expires_at, created_at)
			 VALUES (?, ?, 0, '2026-10-13T00:00:00.000Z', ?)`,
			id(1),
			id(2),
			now
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
			// NUL, 0xFF, a quote and a newline: bytes a BLOB literal must carry as they are.
			new Uint8Array([0, 1, 2, 255, 39, 10])
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

type Refused = { ok: false; message: string }

// The dump calls of a Store: its RPCs, or a StoreAdmin over a kernel of chosen migrations.
export type DumpCalls = {
	start: () => Promise<{ ok: true; headerLine: string; cursor: DumpCursor } | Refused>
	next: (cursor: DumpCursor) => Promise<{ ok: true; chunk: Uint8Array; cursor: DumpCursor; done: boolean } | Refused>
	finish: (cursor: DumpCursor) => Promise<{ ok: true; trailerText: string | null } | Refused>
}

// A full dump through `calls`, as the CLI does it but in memory.
export async function collectDump(calls: DumpCalls): Promise<{ text: string; chunks: number }> {
	const started = await calls.start()
	if (!started.ok) {
		throw new Error(started.message)
	}
	let text = started.headerLine
	let cursor: DumpCursor = started.cursor
	let chunks = 0
	for (;;) {
		const step = await calls.next(cursor)
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
	const finished = await calls.finish(cursor)
	if (!finished.ok) {
		throw new Error(finished.message)
	}
	return { text: text + (finished.trailerText ?? ''), chunks }
}

// A full dump through the Store RPCs.
export function dumpViaRpc(store: StoreStub, maxBytes?: number): Promise<{ text: string; chunks: number }> {
	return collectDump({
		start: () => store.dumpStart(BUILD),
		next: (cursor) => store.dumpNext(BUILD, cursor, maxBytes),
		finish: (cursor) => store.dumpFinish(BUILD, cursor),
	})
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

// Every dumped table's rows as literal tuples, for comparing the data of two Stores. Configuration rows of
// instance_settings are left out: each Store keeps its own, and tests compare them on their own.
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
		// Each value as its storage class and the SHA-256 of its exact bytes, computed here independently of the dump
		// code (hex inside SQLite would exceed its 2 MB value limit for large values).
		for (const { name } of tables) {
			const columns = sql
				.exec<{ name: string }>('SELECT name FROM pragma_table_info(?)', name)
				.toArray()
				.flatMap((c) => [`typeof("${c.name}")`, `CAST("${c.name}" AS BLOB)`])
			const data = name === 'instance_settings' ? ` WHERE name NOT IN (${CONFIG_KEYS.map(() => '?').join(',')})` : ''
			const params = name === 'instance_settings' ? CONFIG_KEYS : []
			out[name] = [...sql.exec(`SELECT ${columns.join(', ')} FROM "${name}"${data}`, ...params).raw()]
				.map((row) => {
					const parts: string[] = []
					for (let i = 0; i < row.length; i += 2) {
						const bytes = row[i + 1]
						parts.push(
							`${row[i] as string}:${bytes instanceof ArrayBuffer ? sha256Hex(new Uint8Array(bytes)) : 'null'}`
						)
					}
					return parts.join(',')
				})
				.sort()
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
		sha256: (path: string) => {
			const bytes = files.get(path)
			return Promise.resolve(bytes === undefined ? null : sha256Hex(bytes))
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
	for await (const chunk of statementChunks(
		io,
		'dump.sql',
		file.bodyStart,
		file.bodyEnd,
		chunkBytes,
		IMPORT_CHUNK_STATEMENTS
	)) {
		chunks.push(chunk.bytes)
	}
	return chunks
}

// Runs a reset of an import to the end (a reset deletes in bounded steps, one call at a time).
export async function resetImport(store: StoreStub, id: string) {
	for (;;) {
		const step = await store.importReset(BUILD, ACCESS, id)
		if (!step.ok || step.done) {
			return step
		}
	}
}

// The import authority the RPC helpers use; a test with its own Access team passes that team's binding.
export type AccessAuthority = {
	kind: 'access'
	email: string | null
	commonName: string | null
	teamDomain: string
	aud: string
}

export async function beginImport(
	store: StoreStub,
	text: string,
	authority: AccessAuthority = ACCESS
): Promise<string> {
	await ensureAdmin(store)
	const begun = await store.importBegin(BUILD, authority, splitDump(text).header)
	if (!begun.ok) {
		throw new Error(`${begun.code}: ${begun.message}`)
	}
	return begun.progress.id
}

// Finishes an import whose chunks are all applied and runs verification to the end.
export async function finishImport(store: StoreStub, id: string, text: string, authority: AccessAuthority = ACCESS) {
	const finished = await store.importFinish(BUILD, authority, id, splitDump(text).trailer)
	if (!finished.ok) {
		throw new Error(`${finished.code}: ${finished.message}`)
	}
	for (;;) {
		const verified = await store.importVerify(BUILD, authority, id)
		if (!verified.ok) {
			throw new Error(`${verified.code}: ${verified.message}`)
		}
		if (verified.done) {
			return verified.report
		}
	}
}

// Imports a dump text through the Store RPCs and verifies it.
export async function importViaRpc(
	store: StoreStub,
	text: string,
	chunkBytes = 64 * 1024,
	authority: AccessAuthority = ACCESS
) {
	const id = await beginImport(store, text, authority)
	let seq = 0
	for (const chunk of await importChunks(text, chunkBytes)) {
		const result = await store.importChunk(BUILD, authority, id, ++seq, chunk)
		if (!result.ok) {
			throw new Error(`${result.code}: ${result.message}`)
		}
	}
	return { id, chunks: seq, report: await finishImport(store, id, text, authority) }
}

// Every row of every dumped table, and every set self-reference: a reset step may change at most its batch of these.
export function footprint(sql: SqlStorage): number {
	let total = 0
	for (const spec of readCatalog(sql)) {
		const where =
			spec.only === undefined
				? ''
				: ` WHERE "${spec.only.column}" IN (${spec.only.values.map((v) => `'${v}'`).join(',')})`
		total += sql.exec<{ n: number }>(`SELECT count(*) AS n FROM "${spec.name}"${where}`).one().n
		for (const column of spec.deferred) {
			total += sql.exec<{ n: number }>(`SELECT count(*) AS n FROM "${spec.name}" WHERE "${column}" IS NOT NULL`).one().n
		}
	}
	return total
}
