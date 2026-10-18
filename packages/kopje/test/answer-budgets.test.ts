import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { type ApiHarness, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { BUILD } from './helpers'
import { MAX_BIO, maxFields } from './profile-fixtures'
import { observedSql } from './read-helpers'
import { community, domainBlock, mute, remoteAccount, seedStatus } from './status-helpers'
import { Db } from '../src/db/sql'
import { admit, admittedPage, ANSWER_BYTES, jsonBytes } from '../src/domain/answer-budget'
import { type VisibleStatusId } from '../src/domain/audience'
import { filterTextLimits, MAX_FILTER_REQUEST_TEXT } from '../src/domain/filters'
import { presentation, presentStatuses, presentStatusesWithin } from '../src/domain/status-presenter'
import { utf8Length } from '../src/platform/dump-format'
import { sha256Hex } from '../src/security/tokens'

// RES-3: one answer that presents statuses is within ANSWER_BYTES as serialized, containers included, owned by the
// Store operation that returns it (docs/response-inventory.md). Items are admitted whole in traversal order, the
// first whatever its size; a cut page continues from its last admitted item in both directions; a context keeps the
// nearest ancestors and history the newest revisions; search, an offset endpoint, returns fewer results.

const ORIGIN = 'https://kopje.test'
// A control character, which JSON escapes to six bytes.
const C = '\u0001'
const DAY = 86_400_000

let sequence = 700_000_000_000_000_000n
const nextId = () => String(sequence++)

// A public remote status of about 0.97 MB of JSON: content of 20,000 escaping characters (and "needle", which search
// finds), a poll of 100 choices of 1,000 and 4 attachments with descriptions of 10,000, each at its bound (RES-2).
// Nine such pass ANSWER_BYTES, so a page of them is cut.
async function bigStatus(
	h: ApiHarness,
	author: string,
	published: number,
	extra: { tags?: string[]; inReplyToId?: string } = {}
): Promise<string> {
	const id = await seedStatus(h.store, {
		accountId: author,
		visibility: 'public',
		content: `<p>needle ${C.repeat(20_000)}</p>`,
		published,
		...extra,
	})
	await sql(
		h.store,
		`INSERT INTO polls (status_id, options, tallies, votes_count, voters_count, expires_at)
		VALUES (?, ?, ?, 0, 0, ?)`,
		id,
		JSON.stringify(Array.from({ length: 100 }, () => C.repeat(1000))),
		JSON.stringify(Array.from({ length: 100 }, () => 0)),
		new Date(NOW + DAY).toISOString()
	)
	for (let position = 0; position < 4; position++) {
		await sql(
			h.store,
			`INSERT INTO media_attachments (id, account_id, status_id, position, type, url, description)
			VALUES (?, ?, ?, ?, 'image', 'https://remote.example/m.png', ?)`,
			nextId(),
			author,
			id,
			position,
			C.repeat(10_000)
		)
	}
	return id
}

type Answer<T> = { status: number; bytes: number; body: T; next: string | null; prev: string | null }

// The answer of a GET as the client receives it: its body's bytes and its Link header's next and prev paths.
async function answer<T = { id: string }[]>(h: ApiHarness, path: string, token?: string): Promise<Answer<T>> {
	const response = await h.request(path, token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } })
	const text = await response.text()
	const link = (rel: string) => {
		const url = new RegExp(`<([^>]+)>; rel="${rel}"`).exec(response.headers.get('link') ?? '')?.[1]
		return url === undefined ? null : `${new URL(url).pathname}${new URL(url).search}`
	}
	return {
		status: response.status,
		bytes: utf8Length(text),
		body: JSON.parse(text) as T,
		next: link('next'),
		prev: link('prev'),
	}
}

type Walked = { ids: string[]; pages: { shown: string[]; bytes: number; cursor: string | null }[] }

// Walks a list by its Link header from `path`: `next` (older, newest first) or `prev` (newer, each page shown newest
// first, collected oldest first). `keep` is added back to each link (since_id or max_id, which links drop, as
// Mastodon's). Each page keeps the cursor its link carries.
async function walk(h: ApiHarness, path: string, rel: 'next' | 'prev', token?: string, keep = ''): Promise<Walked> {
	const walked: Walked = { ids: [], pages: [] }
	for (let at: string | null = path; at !== null;) {
		const page: Answer<{ id: string }[]> = await answer(h, at, token)
		expect(page.status).toBe(200)
		expect(page.bytes).toBeLessThanOrEqual(ANSWER_BYTES)
		const shown = page.body.map((status) => status.id)
		if (shown.length === 0) {
			break
		}
		const link: string | null = page[rel]
		const cursor =
			link === null ? null : new URLSearchParams(link.split('?')[1]).get(rel === 'next' ? 'max_id' : 'min_id')
		walked.pages.push({ shown, bytes: page.bytes, cursor })
		walked.ids.push(...(rel === 'next' ? shown : shown.toReversed()))
		at = link === null ? null : `${link}${keep}`
		expect(walked.pages.length).toBeLessThan(40)
	}
	return walked
}

// A walk cut by the answer budget: every status once, in order, at least one page cut by bytes (one more status of
// `size` would pass ANSWER_BYTES), and each such page continuing from its last status in traversal order (`cursorOf`
// gives its cursor: the status id, or a bookmark's or favourite's id).
function expectByteCutWalk(
	name: string,
	walked: Walked,
	expected: readonly string[],
	rel: 'next' | 'prev',
	size: number,
	cursorOf: (id: string) => string = (id) => id
): void {
	expect([name, walked.ids]).toEqual([name, expected])
	const cut = walked.pages.filter((page) => page.bytes + size + 1 > ANSWER_BYTES)
	expect([name, cut.length]).not.toEqual([name, 0])
	for (const page of cut) {
		const last = rel === 'next' ? page.shown.at(-1)! : page.shown[0]!
		expect([name, page.cursor]).toEqual([name, cursorOf(last)])
	}
}

type World = Awaited<ReturnType<typeof world>>

const run = (kind: 'V' | 'M', n: number) => Array.from({ length: n }, () => kind)

// Alice, a remote author of twenty big statuses (V[0] newest), tagged #big and #needle, which alice follows, lists,
// bookmarks and favourites; and a muted author whose 135 small public statuses lie between them, newest first:
// V[0..9], 115 muted, V[10..19], 20 muted. A public page of 40 reads a window of 120 candidates, so its first window,
// from either end, ends in muted statuses and is cut (B0b) after ten big statuses, which the answer budget cuts first.
async function world() {
	const h = await community(['alice', 'bob'])
	const { alice } = h.users
	const author = await remoteAccount(h.store, 'big')
	const muted = await remoteAccount(h.store, 'muted')
	await mute(h.store, alice.id, muted)
	const kinds = [...run('V', 10), ...run('M', 115), ...run('V', 10), ...run('M', 20)].toReversed()
	const big: string[] = []
	const small: string[] = []
	for (const [i, kind] of kinds.entries()) {
		const published = NOW - (kinds.length - i) * 60_000
		if (kind === 'V') {
			big.push(await bigStatus(h, author, published, { tags: ['big', 'needle'] }))
		} else {
			small.push(await seedStatus(h.store, { accountId: muted, visibility: 'public', published }))
		}
	}
	const V = big.toReversed()
	await sql(
		h.store,
		"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
		alice.id,
		author
	)
	const list = nextId()
	await sql(h.store, "INSERT INTO lists (id, account_id, title) VALUES (?, ?, 'big')", list, alice.id)
	await sql(h.store, 'INSERT INTO list_accounts (list_id, account_id) VALUES (?, ?)', list, author)
	for (const id of big) {
		await sql(h.store, 'INSERT INTO bookmarks (account_id, status_id) VALUES (?, ?)', alice.id, id)
		await sql(h.store, 'INSERT INTO favourites (account_id, status_id) VALUES (?, ?)', alice.id, id)
	}
	// Each status's bookmark and favourite id, the cursors of those lists.
	const edges = async (table: string) =>
		new Map(
			(
				await sql<{ id: string; status_id: string }>(h.store, `SELECT CAST(id AS TEXT) AS id, status_id FROM ${table}`)
			).map((row) => [row.status_id, row.id])
		)
	const size = Math.min(...(await Promise.all(V.map((id) => bytesOf(h, alice.token, id)))))
	return {
		h,
		alice,
		author,
		muted,
		V,
		small: small.toReversed(),
		list,
		bookmarks: await edges('bookmarks'),
		favourites: await edges('favourites'),
		size,
	}
}

// The JSON of one status as the viewer is shown it alone.
async function bytesOf(h: ApiHarness, token: string, id: string): Promise<number> {
	return (await answer<unknown>(h, `/api/v1/statuses/${id}`, token)).bytes
}

// `count` remote accounts named `prefix` and a number, in id order, each at its bounds (RES-2): a bio of 64 KiB,
// a display name of 2,048 escaping characters and 16 fields at theirs, about 121 KB of JSON each.
async function maximalAccounts(h: ApiHarness, prefix: string, count: number): Promise<string[]> {
	const ids: string[] = []
	for (let i = 0; i < count; i++) {
		const id = await remoteAccount(h.store, `${prefix}${String(i).padStart(3, '0')}`)
		await sql(
			h.store,
			'UPDATE accounts SET note = ?, display_name = ?, raw = ? WHERE id = ?',
			MAX_BIO,
			C.repeat(2048),
			JSON.stringify({ type: 'Person', attachment: maxFields() }),
			id
		)
		ids.push(id)
	}
	return ids.toSorted()
}

async function statusBytes(w: World, id: string): Promise<number> {
	return bytesOf(w.h, w.alice.token, id)
}

describe('admission (RES-3)', () => {
	it('admits whole items while they fit, the first whatever its size', () => {
		const items = ['a'.repeat(8), 'b'.repeat(8), 'c'.repeat(8)]
		const size = jsonBytes(items[0]) + 1
		// Exactly the budget: all; one byte less: the last is the first rejected.
		expect(admit(items, 3 * size, true)).toEqual({ items, bytes: 3 * size, consumed: 3, cut: false })
		expect(admit(items, 3 * size - 1, true)).toEqual({
			items: items.slice(0, 2),
			bytes: 2 * size,
			consumed: 2,
			cut: true,
		})
		// An item past the whole budget is admitted first, and only first.
		expect(admit(items, 1, true)).toEqual({ items: items.slice(0, 1), bytes: size, consumed: 1, cut: true })
		expect(admit(items, 1, false)).toEqual({ items: [], bytes: 0, consumed: 0, cut: true })
		// Nothing to show is consumed, never admitted.
		expect(admit([undefined, 'x', undefined], 4, true)).toEqual({ items: ['x'], bytes: 4, consumed: 3, cut: false })
	})

	it('continues a cut page from its last admitted row, dropping a window continuation', () => {
		const rows = ['5', '4', '3', '2', '1']
		const page = { rows, newest: '6', oldest: '0', cut: true }
		const two = (traversal: readonly string[]) => ({ items: traversal.slice(0, 2), bytes: 0, consumed: 2, cut: true })
		expect(admittedPage(page, false, (r) => r, two)).toEqual({ items: ['5', '4'], newest: '6', oldest: '4', cut: true })
		// min_id walks oldest first and shows newest first.
		expect(admittedPage(page, true, (r) => r, two)).toEqual({ items: ['2', '1'], newest: '2', oldest: '0', cut: true })
		const all = (traversal: readonly string[]) => ({ items: [...traversal], bytes: 0, consumed: 5, cut: false })
		expect(admittedPage(page, true, (r) => r, all)).toEqual({ items: rows, newest: '6', oldest: '0', cut: true })
	})
})

describe('status pages are answers within ANSWER_BYTES (RES-3)', () => {
	it('walk every status once in both directions, each cut by bytes, before a window continuation too', async () => {
		const w = await world()
		const { h, alice, V, size } = w
		const lists = [
			['public', '/api/v1/timelines/public?limit=40'],
			['home', '/api/v1/timelines/home?limit=40'],
			['list', `/api/v1/timelines/list/${w.list}?limit=40`],
			['tag', '/api/v1/timelines/tag/big?limit=40'],
			['account statuses', `/api/v1/accounts/${w.author}/statuses?limit=40`],
		] as const
		const inner = V.slice(1, 19)
		for (const [name, path] of lists) {
			expectByteCutWalk(name, await walk(h, path, 'next', alice.token), V, 'next', size)
			expectByteCutWalk(name, await walk(h, `${path}&min_id=1`, 'prev', alice.token), V.toReversed(), 'prev', size)
			// since_id walks newest first above its bound; with max_id, between both, either way.
			const since = `&since_id=${w.small.at(-1)!}`
			expectByteCutWalk(name, await walk(h, `${path}${since}`, 'next', alice.token, since), V, 'next', size)
			const below = `&since_id=${V[19]!}`
			const down = await walk(h, `${path}&max_id=${V[0]!}${below}`, 'next', alice.token, below)
			expectByteCutWalk(`${name} between`, down, inner, 'next', size)
			const above = `&max_id=${V[0]!}`
			const up = await walk(h, `${path}&min_id=${V[19]!}${above}`, 'prev', alice.token, above)
			expectByteCutWalk(`${name} between`, up, inner.toReversed(), 'prev', size)
		}
		// The public timeline's first pages from either end: ten big statuses passed in a window cut at muted statuses
		// (B0b), cut by bytes before them, so the link continues from the last one shown, not from the window's end.
		for (const [rel, path] of [
			['next', '/api/v1/timelines/public?limit=40'],
			['prev', '/api/v1/timelines/public?limit=40&min_id=1'],
		] as const) {
			const [first] = (await walk(h, path, rel, alice.token)).pages
			expect(first!.shown.length).toBeLessThan(10)
			expect(first!.cursor).toBe(rel === 'next' ? first!.shown.at(-1) : first!.shown[0])
			// The first rejected status is the one that does not fit.
			expect(first!.bytes + size + 1).toBeGreaterThan(ANSWER_BYTES)
		}
		for (const [name, path, edges] of [
			['bookmarks', '/api/v1/bookmarks?limit=40', w.bookmarks],
			['favourites', '/api/v1/favourites?limit=40', w.favourites],
		] as const) {
			const cursorOf = (id: string) => edges.get(id)!
			expectByteCutWalk(name, await walk(h, path, 'next', alice.token), V, 'next', size, cursorOf)
			const ascending = await walk(h, `${path}&min_id=0`, 'prev', alice.token)
			expectByteCutWalk(name, ascending, V.toReversed(), 'prev', size, cursorOf)
			const since = `&since_id=${cursorOf(V[19]!)}`
			const above = await walk(h, `${path}${since}`, 'next', alice.token, since)
			expectByteCutWalk(name, above, V.slice(0, 19), 'next', size, cursorOf)
			const down = await walk(h, `${path}&max_id=${cursorOf(V[0]!)}${since}`, 'next', alice.token, since)
			expectByteCutWalk(`${name} between`, down, inner, 'next', size, cursorOf)
			const max = `&max_id=${cursorOf(V[0]!)}`
			const up = await walk(h, `${path}&min_id=${cursorOf(V[19]!)}${max}`, 'prev', alice.token, max)
			expectByteCutWalk(`${name} between`, up, inner.toReversed(), 'prev', size, cursorOf)
		}
	}, 600_000)

	it('stop pinned statuses at a byte cut, and walk quotes once each', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		// Ten of bob's big statuses, pinned in an order unlike their ids': newest pin first is P. X, unpinned, lies
		// between the newest two by id.
		const posts: string[] = []
		let X = ''
		for (let i = 0; i < 10; i++) {
			if (i === 9) {
				X = await seedStatus(h.store, { accountId: bob.id, visibility: 'public', published: NOW - 690_000 })
			}
			posts.push(await bigStatus(h, bob.id, NOW - (20 - i) * 60_000))
		}
		expect(X > posts[8]! && X < posts[9]!).toBe(true)
		const P = [3, 7, 0, 9, 1, 8, 2, 6, 4, 5].map((i) => posts[i]!)
		for (const [i, id] of P.toReversed().entries()) {
			await sql(
				h.store,
				'INSERT INTO status_pins (account_id, status_id, created_at) VALUES (?, ?, ?)',
				bob.id,
				id,
				new Date(NOW - DAY + i * 60_000).toISOString()
			)
		}
		const size = Math.min(...(await Promise.all(posts.map((id) => bytesOf(h, alice.token, id)))))
		// Pins do not continue past a byte cut: the first that fit, in pin order, with no next link (RES-3).
		const pinned = `/api/v1/accounts/${bob.id}/statuses?pinned=true&limit=40`
		const first = await answer(h, pinned, alice.token)
		const shown = first.body.map((s) => s.id)
		expect(shown.length).toBeLessThan(P.length)
		expect(shown).toEqual(P.slice(0, shown.length))
		expect(first.bytes + size + 1).toBeGreaterThan(ANSWER_BYTES)
		expect(first.next).toBeNull()
		// A max_id that is no pin keeps its status-id ceiling, cut or not.
		const below = await answer(h, `${pinned}&max_id=${X}`, alice.token)
		const under = P.filter((id) => id < X)
		expect(below.body.map((s) => s.id)).toEqual(under.slice(0, below.body.length))
		expect(below.body.length).toBeLessThan(under.length)
		expect(below.next).toBeNull()
		// min_id pages pins by status id, oldest first; a cut page offers no next link either.
		const oldest = await answer(h, `${pinned}&min_id=1`, alice.token)
		const ascending = oldest.body.map((s) => s.id).toReversed()
		expect(ascending).toEqual(posts.slice(0, ascending.length))
		expect(ascending.length).toBeLessThan(posts.length)
		expect(oldest.next).toBeNull()
		// Ten big statuses quoting a small one.
		const author = await remoteAccount(h.store, 'quoter')
		const quoted = await seedStatus(h.store, { accountId: author, visibility: 'public', published: NOW - 2 * DAY })
		const quoting: string[] = []
		for (let i = 0; i < 10; i++) {
			const id = await bigStatus(h, author, NOW - DAY + i * 60_000)
			await sql(
				h.store,
				`INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, updated_at)
				SELECT ?1, uri, id, account_id, 'accepted', ?3 FROM statuses WHERE id = ?2`,
				id,
				quoted,
				new Date(NOW).toISOString()
			)
			quoting.push(id)
		}
		const quoteSize = Math.min(...(await Promise.all(quoting.map((id) => bytesOf(h, alice.token, id)))))
		const quotes = `/api/v1/statuses/${quoted}/quotes?limit=40`
		const newest = quoting.toReversed()
		expectByteCutWalk('quotes', await walk(h, quotes, 'next', alice.token), newest, 'next', quoteSize)
		expectByteCutWalk('quotes', await walk(h, `${quotes}&min_id=1`, 'prev', alice.token), quoting, 'prev', quoteSize)
	}, 300_000)

	it('reads at most one chunk of statuses past the cut out of SQLite', async () => {
		const w = await world()
		const one = await sqliteBytes(w, (db, viewer) => {
			const shared = presentation(db, [w.V[0] as VisibleStatusId], { origin: ORIGIN, viewer })
			return presentStatusesWithin(db, shared, [w.V[0] as VisibleStatusId], ANSWER_BYTES, true).items.length
		})
		const page = await sqliteBytes(w, (db, viewer) => {
			const ids = w.V as VisibleStatusId[]
			const shared = presentation(db, ids, { origin: ORIGIN, viewer })
			return presentStatusesWithin(db, shared, ids, ANSWER_BYTES - 1, true).items.length
		})
		expect(one.result).toBe(1)
		expect(page.result).toBeLessThan(w.V.length)
		// Rows are read 4 statuses at a time (STATUS_CHUNK): the chunks up to the first rejected status, no more.
		const chunks = Math.ceil((page.result + 1) / 4)
		expect(page.largest).toBeLessThanOrEqual(4 * one.largest * 1.01)
		expect(page.bytes).toBeLessThanOrEqual(chunks * 4 * one.bytes * 1.01)
	})
})

// What a read takes out of SQLite as alice: all its bytes and the most one query returns.
async function sqliteBytes(
	w: World,
	read: (db: Db, viewer: { accountId: string; now: string }) => number
): Promise<{ result: number; bytes: number; largest: number }> {
	return runInDurableObject(w.h.store, (_instance, state) => {
		let bytes = 0
		let largest = 0
		const counting = observedSql(state.storage.sql, (rows) => {
			let query = 0
			for (const row of rows) {
				for (const value of Object.values(row)) {
					query += typeof value === 'string' ? utf8Length(value) : 8
				}
			}
			bytes += query
			largest = Math.max(largest, query)
		})
		const result = read(new Db(counting), { accountId: w.alice.id, now: new Date(NOW).toISOString() })
		return { result, bytes, largest }
	})
}

describe('composite answers within ANSWER_BYTES (RES-3)', () => {
	it('keeps the nearest ancestors on half the budget, and the descendants on the rest', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const author = await remoteAccount(h.store, 'thread')
		const chain: string[] = []
		for (let i = 0; i < 14; i++) {
			chain.push(await bigStatus(h, author, NOW - (20 - i) * 60_000, i === 0 ? {} : { inReplyToId: chain[i - 1]! }))
		}
		const size = (await answer<unknown>(h, `/api/v1/statuses/${chain[1]!}`, alice.token)).bytes + 1
		const frame = jsonBytes({ ancestors: [], descendants: [] })
		type Context = { ancestors: { id: string }[]; descendants: { id: string }[] }
		const context = async (at: number) => {
			const read = await answer<Context>(h, `/api/v1/statuses/${chain[at]!}/context`, alice.token)
			expect(read.bytes).toBeLessThanOrEqual(ANSWER_BYTES)
			return { ancestors: read.body.ancestors.map((s) => s.id), descendants: read.body.descendants.map((s) => s.id) }
		}
		// Every status here is the same size: half the budget takes `half`, and the descendants the rest.
		const half = Math.floor(Math.floor((ANSWER_BYTES - frame) / 2) / size)
		const rest = (taken: number) => Math.floor((ANSWER_BYTES - frame - taken * size) / size)
		const middle = await context(7)
		expect(middle.ancestors).toEqual(chain.slice(7 - half, 7))
		expect(middle.descendants).toEqual(chain.slice(8, 8 + rest(half)))
		// Few ancestors leave the rest to the descendants; no descendants leave the ancestors their half.
		const early = await context(1)
		expect(early.ancestors).toEqual(chain.slice(0, 1))
		expect(early.descendants).toEqual(chain.slice(2, 2 + rest(1)))
		expect(early.descendants.length).toBeGreaterThan(half)
		const last = await context(13)
		expect(last).toEqual({ ancestors: chain.slice(13 - half, 13), descendants: [] })
	}, 300_000)

	it('keeps the newest revisions of an edit history, oldest first', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const author = await remoteAccount(h.store, 'editor')
		const status = await bigStatus(h, author, NOW - DAY)
		const edits = 16
		for (let i = 0; i < edits; i++) {
			await sql(
				h.store,
				`INSERT INTO status_edits (status_id, content, spoiler_text, media_json, poll_options, created_at)
				VALUES (?, ?, ?, '[]', ?, ?)`,
				status,
				`<p>${String(i).padStart(2, '0')} ${C.repeat(20_000)}</p>`,
				String(i).padStart(2, '0'),
				JSON.stringify(Array.from({ length: 100 }, () => C.repeat(1000))),
				new Date(NOW - DAY + i * 60_000).toISOString()
			)
		}
		const read = await answer<{ spoiler_text: string }[]>(h, `/api/v1/statuses/${status}/history`, alice.token)
		expect(read.bytes).toBeLessThanOrEqual(ANSWER_BYTES)
		const shown = read.body.map((edit) => Number(edit.spoiler_text))
		expect(shown.length).toBeLessThan(edits)
		expect(shown).toEqual(Array.from({ length: shown.length }, (_, i) => edits - shown.length + i))
		// The next older revision is the first that does not fit.
		const each = jsonBytes(read.body[0]) + 1
		expect(read.bytes + each).toBeGreaterThan(ANSWER_BYTES)
	})

	it('answers a fixed-id lookup with the ids that fit, in the order asked', async () => {
		const w = await world()
		const query = w.V.map((id) => `id[]=${id}`).join('&')
		const read = await answer(w.h, `/api/v1/statuses?${query}`, w.alice.token)
		expect(read.bytes).toBeLessThanOrEqual(ANSWER_BYTES)
		const shown = read.body.map((s) => s.id)
		expect(shown).toEqual(w.V.slice(0, shown.length))
		expect(read.bytes + (await statusBytes(w, w.V[shown.length]!)) + 1).toBeGreaterThan(ANSWER_BYTES)
	}, 300_000)

	it('answers search as one answer: fewer statuses, the offset continuing after them', async () => {
		const w = await world()
		const { h, alice } = w
		const found: string[] = []
		for (let offset = 0, page = 0; page < 10; page++) {
			const read = await answer<{ accounts: unknown[]; statuses: { id: string }[]; hashtags: unknown[] }>(
				h,
				`/api/v2/search?q=needle&limit=40&offset=${offset}`,
				alice.token
			)
			expect(read.bytes).toBeLessThanOrEqual(ANSWER_BYTES)
			if (read.body.statuses.length === 0) {
				break
			}
			// A client advancing by the number received (Tusky, Ivory) continues after the cut; Mastodon's web client
			// takes a short answer for the last one.
			expect(page > 0 || read.body.statuses.length < w.V.length).toBe(true)
			found.push(...read.body.statuses.map((s) => s.id))
			offset += read.body.statuses.length
		}
		expect(found).toEqual(w.V)
	}, 300_000)

	it('shares one budget among the resolved account, accounts, statuses and hashtags', async () => {
		const w = await world()
		const { h, alice } = w
		const needles = await maximalAccounts(h, 'needle', 45)
		const [resolved] = await maximalAccounts(h, 'resolved', 1)
		const blocked = await remoteAccount(h.store, 'needleblocked', 'blocked.example')
		await domainBlock(h.store, alice.id, 'blocked.example')
		const credential = { tokenHash: await sha256Hex(alice.token), scope: 'read' as const, now: NOW }
		const search = async (resolvedAccountId: string) => {
			const found = await h.store.search(BUILD, {
				credential,
				query: 'needle',
				types: ['accounts', 'statuses', 'hashtags'],
				limit: 40,
				offset: 0,
				following: false,
				localDomain: 'kopje.test',
				present: { origin: ORIGIN },
				resolvedAccountId,
			})
			if (found.status !== 'ok') {
				throw new Error(found.status)
			}
			return found.value
		}
		const found = await search(resolved!)
		// The resolved account first, then the search's own, within the limit; the statuses that fit what the accounts
		// left; the hashtag after them.
		expect(found.accounts.map((a) => a.id)).toEqual([resolved, ...needles.slice(0, 39)])
		expect(found.statuses.map((s) => s.id)).toEqual(w.V.slice(0, found.statuses.length))
		expect(found.statuses.length).toBeGreaterThan(0)
		expect(found.hashtags.map((t) => t.name)).toEqual(['needle'])
		expect(jsonBytes(found)).toBeLessThanOrEqual(ANSWER_BYTES)
		// The next status is the first rejected: with it, the accounts and statuses alone pass the budget.
		const items = (list: readonly unknown[]) => list.reduce<number>((sum, item) => sum + jsonBytes(item) + 1, 0)
		const taken =
			jsonBytes({ accounts: [], statuses: [], hashtags: [] }) + items(found.accounts) + items(found.statuses)
		expect(taken + (await statusBytes(w, w.V[found.statuses.length]!)) + 1).toBeGreaterThan(ANSWER_BYTES)
		// A resolved account the viewer may not find is not put first.
		expect((await search(blocked)).accounts[0]?.id).toBe(needles[0])
	}, 300_000)

	it('answers the account search within the budget, its offset continuing after a cut', async () => {
		const w = await world()
		const { h, alice } = w
		const needles = await maximalAccounts(h, 'needle', 90)
		const found: string[] = []
		for (let offset = 0, page = 0; page < 10; page++) {
			const read = await answer(h, `/api/v1/accounts/search?q=needle&limit=80&offset=${offset}`, alice.token)
			expect(read.bytes).toBeLessThanOrEqual(ANSWER_BYTES)
			const shown = read.body.map((a) => a.id)
			if (shown.length === 0) {
				break
			}
			if (page === 0) {
				// Cut by bytes: the next account would pass the budget.
				expect(shown.length).toBeLessThan(needles.length)
				const next = await answer<unknown>(h, `/api/v1/accounts/${needles[shown.length]!}`, alice.token)
				expect(read.bytes + next.bytes + 1).toBeGreaterThan(ANSWER_BYTES)
			}
			found.push(...shown)
			offset += shown.length
		}
		expect(found).toEqual(needles)
	}, 300_000)

	it('shares a profile page between its account and its statuses, next following the last one shown', async () => {
		const h = await community(['bob'])
		const { bob } = h.users
		const posts: string[] = []
		for (let i = 0; i < 12; i++) {
			posts.push(await bigStatus(h, bob.id, NOW - (20 - i) * 60_000))
		}
		const newest = posts.toReversed()
		const shown: string[] = []
		let maxId: string | null = null
		for (let page = 0; page < 5; page++) {
			const read = await h.store.profilePage(BUILD, { username: 'bob', maxId, present: { origin: ORIGIN }, now: NOW })
			expect(read.status).toBe('ok')
			if (read.status !== 'ok') {
				return
			}
			expect(jsonBytes(read)).toBeLessThanOrEqual(ANSWER_BYTES)
			shown.push(...read.statuses.map((s) => s.id))
			if (read.next === null) {
				break
			}
			expect(read.next).toBe(read.statuses.at(-1)!.id)
			maxId = read.next
		}
		expect(shown).toEqual(newest)
	}, 300_000)
})

describe('the shared filter allowance (RES-3)', () => {
	it('matches each status as the unchunked presentation does, past the allowance', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const author = await remoteAccount(h.store, 'long')
		// 60 statuses of 9,000 code units (540,000 in all, past MAX_FILTER_REQUEST_TEXT), each with "needle" at a
		// different depth, so the level decides which match.
		const ids: string[] = []
		for (let i = 0; i < 60; i++) {
			const depth = 150 * i
			const text = `${'x'.repeat(depth)} needle ${'y'.repeat(9_000 - depth)}`
			ids.push(await seedStatus(h.store, { accountId: author, visibility: 'public', content: `<p>${text}</p>` }))
		}
		await h.request('/api/v2/filters', {
			method: 'POST',
			headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ title: 'n', context: ['public'], keywords_attributes: [{ keyword: 'needle' }] }),
		})
		const [whole, chunked] = await runInDurableObject(h.store, (_instance, state) => {
			const db = new Db(state.storage.sql)
			const options = { origin: ORIGIN, viewer: { accountId: alice.id, now: new Date(NOW).toISOString() } }
			const visible = ids as VisibleStatusId[]
			const shared = presentation(db, visible, options)
			return [
				presentStatuses(db, visible, options),
				[
					...presentStatusesWithin(db, shared, visible.slice(0, 7), ANSWER_BYTES, true).items,
					...presentStatusesWithin(db, shared, visible.slice(7), ANSWER_BYTES, true).items,
				],
			]
		})
		expect(chunked).toEqual(whole)
		// The allowance cuts as filterTextLimits gives it over the 60 texts: a needle matches when it ends by its level.
		const [level] = filterTextLimits(Array.from({ length: 60 }, () => 9_008))
		const matched = whole.map((s) => (s.filtered ?? []).length > 0)
		expect(matched).toEqual(ids.map((_, i) => 150 * i + 7 <= level!))
		expect(matched).toContain(false)
	}, 300_000)

	it('matches a status quoted by many once, within the allowance', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const author = await remoteAccount(h.store, 'quoting')
		// 40 statuses of 10,000 code units, each quoting the same status of 10,000: 41 targets share the allowance.
		const long = (word: string) => `<p>${'y'.repeat(9_993)} ${word}</p>`
		const quoted = await seedStatus(h.store, { accountId: author, visibility: 'public', content: long('quoted') })
		const ids: string[] = []
		for (let i = 0; i < 40; i++) {
			const id = await seedStatus(h.store, { accountId: author, visibility: 'public', content: long('status') })
			await sql(
				h.store,
				`INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, updated_at)
				SELECT ?1, uri, id, account_id, 'accepted', ?3 FROM statuses WHERE id = ?2`,
				id,
				quoted,
				new Date(NOW).toISOString()
			)
			ids.push(id)
		}
		await h.request('/api/v2/filters', {
			method: 'POST',
			headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ title: 'n', context: ['public'], keywords_attributes: [{ keyword: 'needle' }] }),
		})
		const result = await runInDurableObject(h.store, (_instance, state) => {
			const db = new Db(state.storage.sql)
			const options = { origin: ORIGIN, viewer: { accountId: alice.id, now: new Date(NOW).toISOString() } }
			const visible = ids as VisibleStatusId[]
			const shared = presentation(db, visible, options)
			const items = presentStatusesWithin(db, shared, visible, ANSWER_BYTES, true).items
			return { items, level: shared.level, units: shared.matched.units, whole: presentStatuses(db, visible, options) }
		})
		expect(result.items).toHaveLength(40)
		expect(result.items).toEqual(result.whole)
		const [level] = filterTextLimits(Array.from({ length: 41 }, () => 10_000))
		expect(result.level).toBe(level)
		// Each status and the quoted status once: 41 texts at the level, not 80.
		expect(result.units).toBe(41 * level!)
		expect(result.units).toBeLessThanOrEqual(MAX_FILTER_REQUEST_TEXT)
	}, 300_000)
})

describe('realistic content is never cut (RES-3)', () => {
	it('answers a page of 40 long realistic statuses whole', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const author = await remoteAccount(h.store, 'real')
		// Pleroma's and Akkoma's 5,000 characters of Japanese with links, a poll of 4 and 4 described attachments.
		const text = `<p>${'東京在住のソフトウェア開発者です。'.repeat(280)}<a href="https://example.com/">link</a></p>`
		for (let i = 0; i < 40; i++) {
			const id = await seedStatus(h.store, { accountId: author, visibility: 'public', content: text, tags: ['real'] })
			await sql(
				h.store,
				`INSERT INTO polls (status_id, options, tallies, votes_count, voters_count, expires_at)
				VALUES (?, '["はい","いいえ","たぶん","わからない"]', '[0,0,0,0]', 0, 0, ?)`,
				id,
				new Date(NOW + DAY).toISOString()
			)
			for (let position = 0; position < 4; position++) {
				await sql(
					h.store,
					`INSERT INTO media_attachments (id, account_id, status_id, position, type, url, description)
					VALUES (?, ?, ?, ?, 'image', 'https://remote.example/m.png', ?)`,
					nextId(),
					author,
					id,
					position,
					'写真の説明。'.repeat(250)
				)
			}
		}
		const read = await answer(h, '/api/v1/timelines/tag/real?limit=40', alice.token)
		expect(read.body).toHaveLength(40)
		expect(read.bytes).toBeLessThan(ANSWER_BYTES / 4)
	}, 300_000)
})

describe('the Store RPC returns a maximal answer (RES-3)', () => {
	it('returns a timeline page, a context and search at the budget, under the 32 MiB RPC limit', async () => {
		const w = await world()
		const { h, alice } = w
		// Ten replies under V[11], so its context passes the budget.
		let parent = w.V[11]!
		for (let i = 0; i < 10; i++) {
			parent = await bigStatus(h, w.author, NOW - 1000 + i, { inReplyToId: parent })
		}
		const credential = { tokenHash: await sha256Hex(alice.token), scope: 'read' as const, now: NOW }
		const present = { origin: ORIGIN }
		const page = await h.store.publicTimeline(BUILD, {
			credential,
			now: NOW,
			page: { limit: 40 },
			local: false,
			remote: false,
			onlyMedia: false,
			present,
		})
		const context = await h.store.statusContext(BUILD, { credential, now: NOW, id: w.V[11]!, present })
		const search = await h.store.search(BUILD, {
			credential,
			query: 'needle',
			types: ['accounts', 'statuses', 'hashtags'],
			limit: 40,
			offset: 0,
			following: false,
			localDomain: 'kopje.test',
			present,
		})
		const sizes = [page, context, search].map((value) => jsonBytes(value))
		for (const size of sizes) {
			expect(size).toBeGreaterThan(ANSWER_BYTES - 1_100_000)
			expect(size).toBeLessThanOrEqual(ANSWER_BYTES + 100)
		}
		console.info(`Store RPC answers (JSON bytes): page ${sizes[0]}, context ${sizes[1]}, search ${sizes[2]}`)
	}, 300_000)
})
