import { runInDurableObject } from 'cloudflare:test'

import { type ApiHarness, seedAccount, setSetting } from './api-helpers'
import { NOW } from './app-helpers'
import { type SqlRow, watchedCursor } from './read-helpers'
import { community } from './status-helpers'
import { Db, rowHeapBytes } from '../src/db/sql'
import { type VisibleStatusId } from '../src/domain/audience'
import { MAX_STATUS_MENTION_ROWS } from '../src/domain/status-bounds'
import { type ChunkPlan, presentation, presentStatusesWithin, type Status } from '../src/domain/status-presenter'
import { statusRowBoundSql } from '../src/domain/status-rows'
import { CONTENT_JSON_BYTES } from '../src/platform/stored-bounds'

// Fixtures of the chunk planning tests (test/status-rows.test.ts): answers of statuses of mixed shapes and sizes, built
// in SQL, and what a presentation of them reads.

export const ORIGIN = 'https://kopje.test'
export const VIEWER_NOW = new Date(NOW).toISOString()

let sequence = 820_000_000_000_000_000n
export const nextId = () => String(sequence++)

// One status of an answer as the fixtures build it: what it is (a status, a quote of another, or a boost of a status
// or a quote), and the size of each part of its status rows.
export type Item = {
	kind: 'status' | 'quote' | 'boost' | 'boostOfQuote'
	text: number
	wide: boolean
	mentions: number
	tags: number
	media: number
	poll: number
	viewer: boolean
	// Which of its statuses a local account of the fixture's writes (alice first, the OAuth admin of an admin fixture),
	// each drawn apart; the others share one remote author of the item's. `local`: the top-level status (a boost's own
	// row), `originalLocal`: a boost's original, `quotedLocal`: the quoted status of a quote or of a boost's original.
	local?: boolean
	originalLocal?: boolean
	quotedLocal?: boolean
	// The stored emoji snapshots of its statuses and of its author, if any.
	emojis?: { status: string | null; author: string | null }
}

export type Fixture = { viewer: string; token: string; mentioned: string[]; filter: string; locals: string[] }

// The local accounts of an admin fixture: an operator-sized deployment (about 10 accounts, admin-authority.ts).
const ADMIN_FIXTURE_LOCALS = 10

// alice, MAX_STATUS_MENTION_ROWS remote accounts to mention (on hosts of 60 characters) and one filter of hers that
// names the statuses built (so each carries a filter result) with a keyword. `admin`: alice is the OAuth admin
// (admin_email) among ADMIN_FIXTURE_LOCALS local accounts, which items marked local are written by.
export async function fixture({ admin = false }: { admin?: boolean } = {}): Promise<{ h: ApiHarness; f: Fixture }> {
	const h = await community(['alice'])
	const viewer = h.users.alice.id
	const locals = [viewer]
	if (admin) {
		await setSetting(h.store, 'admin_email', 'alice@example.com')
		// Long emails, so the admin lookup's scan (M in R) outweighs the slack of R's constant terms.
		for (let i = 1; i < ADMIN_FIXTURE_LOCALS; i++) {
			locals.push(await seedAccount(h.store, { username: `local${i}`, email: `${'e'.repeat(230)}${i}@example.com` }))
		}
	}
	const filter = nextId()
	const mentioned = await runInDurableObject(h.store, (_instance, state) => {
		const sql = state.storage.sql
		const ids: string[] = []
		for (let i = 0; i < MAX_STATUS_MENTION_ROWS; i++) {
			const id = nextId()
			const host = `${'m'.repeat(48)}${i}.example`
			sql.exec(
				'INSERT INTO accounts (id, uri, username, domain, url) VALUES (?, ?, ?, ?, ?)',
				id,
				`https://${host}/users/u${i}`,
				`u${i}`,
				host,
				`https://${host}/@u${i}`
			)
			ids.push(id)
		}
		sql.exec(
			"INSERT INTO filters (id, account_id, title, context, action) VALUES (?, ?, 'f', '[\"public\"]', 'warn')",
			filter,
			viewer
		)
		sql.exec(
			"INSERT INTO filter_keywords (id, filter_id, keyword, whole_word) VALUES (?, ?, 'needle', 0)",
			nextId(),
			filter
		)
		return ids
	})
	return { h, f: { viewer, token: h.users.alice.token, mentioned, filter, locals } }
}

// Wide text of `points` code points whose content (`<p>needle …</p>`) stays within its stored bound
// (CONTENT_JSON_BYTES as a JSON string, RES-2): four-byte characters outside the BMP while they fit WIDE_BYTES, and
// past that as many as fit with three-byte ones for the rest, which cover every `text` the generator draws (at most
// 40,000, 120,000 bytes of three-byte characters).
const WIDE_BYTES = CONTENT_JSON_BYTES - JSON.stringify('<p>needle </p>').length
function wideText(points: number): string {
	const astral = Math.min(points, Math.max(0, WIDE_BYTES - 3 * points))
	return `${'𠀀'.repeat(astral)}${'名'.repeat(points - astral)}`
}

// The next local account each fixture writes with, in turn from alice: kept per fixture, so which local account an item
// gets depends only on the items built with that fixture, never on the tests that ran before in the worker.
const localTurns = new WeakMap<Fixture, number>()

// Writes the status rows of `item` (its original, quoted status and boost too) and returns its top-level id.
export function build(sql: SqlStorage, f: Fixture, item: Item): string {
	let remote: string | undefined
	const authorOf = (local: boolean | undefined): string => {
		if (local === true) {
			const turn = localTurns.get(f) ?? 0
			localTurns.set(f, turn + 1)
			return f.locals[turn % f.locals.length]!
		}
		if (remote === undefined) {
			remote = nextId()
			sql.exec(
				`INSERT INTO accounts (id, uri, username, domain, display_name, raw, emojis)
				VALUES (?, ?, 'author', 'remote.example', ?, ?, ?)`,
				remote,
				`https://remote.example/users/${remote}`,
				(item.wide ? '名' : 'n').repeat(item.text % 300),
				JSON.stringify({ attachment: [{ type: 'PropertyValue', name: 'k', value: 'v'.repeat(item.text % 500) }] }),
				item.emojis?.author ?? null
			)
		}
		return remote
	}
	const top = authorOf(item.local)
	const status = (parts: Item, author: string): string => {
		const id = nextId()
		sql.exec(
			`INSERT INTO statuses (id, uri, account_id, visibility, content, spoiler_text, published_at, emojis)
			VALUES (?, ?, ?, 'public', ?, ?, ?, ?)`,
			id,
			`https://remote.example/objects/${id}`,
			author,
			`<p>needle ${parts.wide ? wideText(parts.text) : 'x'.repeat(parts.text)}</p>`,
			'w'.repeat(parts.text % 100),
			VIEWER_NOW,
			parts.emojis?.status ?? null
		)
		for (const account of f.mentioned.slice(0, parts.mentions)) {
			sql.exec(
				`INSERT INTO status_mentions (status_id, account_id, silent, requires_mention, author_id)
				VALUES (?, ?, 0, 0, ?)`,
				id,
				account,
				author
			)
		}
		for (let i = 0; i < parts.tags; i++) {
			// Names across the BMP and past it, whose UTF-16 order differs from SQLite's.
			const name = i % 3 === 0 ? `${String.fromCodePoint(0x20000 + i)}t` : i % 3 === 1 ? `￠${i}` : `t${i}`
			sql.exec('INSERT INTO status_tags (status_id, name, public) VALUES (?, ?, 1)', id, name)
		}
		for (let position = parts.media - 1; position >= 0; position--) {
			sql.exec(
				`INSERT INTO media_attachments (id, account_id, status_id, position, type, url, description)
				VALUES (?, ?, ?, ?, 'image', 'https://remote.example/m.png', ?)`,
				nextId(),
				author,
				id,
				position,
				'd'.repeat(parts.text % 2000)
			)
		}
		if (parts.poll > 0) {
			sql.exec(
				`INSERT INTO polls (status_id, options, tallies, multiple, votes_count, voters_count, expires_at)
				VALUES (?, ?, ?, 1, 0, 0, ?)`,
				id,
				JSON.stringify(Array.from({ length: parts.poll }, (_, i) => `choice ${i} ${'c'.repeat(parts.text % 50)}`)),
				JSON.stringify(Array.from({ length: parts.poll }, () => 0)),
				new Date(NOW + 86_400_000).toISOString()
			)
		}
		if (parts.viewer) {
			sql.exec('INSERT INTO favourites (account_id, status_id, created_at) VALUES (?, ?, ?)', f.viewer, id, VIEWER_NOW)
			sql.exec('INSERT INTO bookmarks (account_id, status_id, created_at) VALUES (?, ?, ?)', f.viewer, id, VIEWER_NOW)
			sql.exec('INSERT INTO filter_statuses (id, filter_id, status_id) VALUES (?, ?, ?)', nextId(), f.filter, id)
			for (let choice = 0; choice < parts.poll; choice++) {
				sql.exec(
					'INSERT INTO poll_votes (poll_id, account_id, choice, generation, created_at) VALUES (?, ?, ?, 0, ?)',
					id,
					f.viewer,
					choice,
					VIEWER_NOW
				)
			}
		}
		return id
	}
	const quote = (parts: Item, author: string): string => {
		const quoted = status({ ...parts, text: Math.floor(parts.text / 2) }, authorOf(item.quotedLocal))
		const id = status(parts, author)
		sql.exec(
			`INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, updated_at)
			SELECT ?1, uri, id, account_id, 'accepted', ?3 FROM statuses WHERE id = ?2`,
			id,
			quoted,
			VIEWER_NOW
		)
		return id
	}
	const boost = (original: string): string => {
		const id = nextId()
		sql.exec(
			"INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at) VALUES (?, ?, ?, ?, 'public', ?)",
			id,
			`https://remote.example/announces/${id}`,
			top,
			original,
			VIEWER_NOW
		)
		return id
	}
	switch (item.kind) {
		case 'status':
			return status(item, top)
		case 'quote':
			return quote(item, top)
		case 'boost':
			return boost(status(item, authorOf(item.originalLocal)))
		case 'boostOfQuote':
			return boost(quote(item, authorOf(item.originalLocal)))
	}
}

export type Read = { query: string; params: SqlStorageValue[]; rows: SqlRow[] }

// The rows of a presentation of `ids` under one shared presentation (read without observation), as statusStream
// reads them with `chunks`, and each hydrate's reads apart (a segment starts at the presenter's first status query).
export function observedPresentation(
	state: DurableObjectState,
	viewer: string,
	ids: readonly string[],
	chunks: ChunkPlan | number
): { items: Status[]; reads: Read[]; segments: { ids: string[]; reads: Read[] }[] } {
	const real = state.storage.sql
	const reads: Read[] = []
	const observed = {
		exec: (query: string, ...params: SqlStorageValue[]) => {
			const read: Read = { query, params, rows: [] }
			reads.push(read)
			return watchedCursor(
				real.exec(query, ...params),
				() => {},
				(rows) => read.rows.push(...rows)
			)
		},
	} as unknown as SqlStorage
	const options = { origin: ORIGIN, viewer: { accountId: viewer, now: VIEWER_NOW } }
	const visible = ids as VisibleStatusId[]
	const shared = presentation(new Db(real), visible, options)
	const { items } = presentStatusesWithin(new Db(observed), shared, visible, Infinity, true, chunks)
	const segments: { ids: string[]; reads: Read[] }[] = []
	for (const read of reads) {
		if (read.query === statusRowBoundSql()) {
			continue
		}
		if (read.query.includes('b.reblog_of_id AS value')) {
			segments.push({ ids: JSON.parse(read.params[0] as string) as string[], reads: [] })
		}
		segments.at(-1)!.reads.push(read)
	}
	return { items, reads, segments }
}

// A SqlStorage over `real` that records the statements it runs, in order.
export function recordingSql(real: SqlStorage): { sql: SqlStorage; reads: string[] } {
	const reads: string[] = []
	const sql = {
		exec: (query: string, ...params: SqlStorageValue[]) => {
			reads.push(query)
			return watchedCursor(real.exec(query, ...params), () => {})
		},
	} as unknown as SqlStorage
	return { sql, reads }
}

// How many windows of R and chunks of the presenter the statements `reads` hold.
export function planCounts(reads: readonly string[]): { windows: number; chunks: number } {
	return {
		windows: reads.filter((query) => query === statusRowBoundSql()).length,
		chunks: reads.filter((query) => query.includes('b.reblog_of_id AS value')).length,
	}
}

// The heap of `rows` as RowMeter counts it (rowHeapBytes), which R bounds.
export function heap(rows: readonly SqlRow[]): number {
	return rows.reduce((sum, row) => sum + rowHeapBytes(row), 0)
}

export const rowsOf = (reads: readonly Read[]) => reads.flatMap((read) => read.rows)

export function boundsOf(state: DurableObjectState, viewer: string | null, ids: readonly string[], filterRows: number) {
	const bounds = new Map<string, number>()
	for (const row of state.storage.sql
		.exec<{ k: number; bytes: number }>(statusRowBoundSql(), JSON.stringify(ids), viewer, filterRows)
		.toArray()) {
		bounds.set(ids[row.k]!, row.bytes)
	}
	return bounds
}
