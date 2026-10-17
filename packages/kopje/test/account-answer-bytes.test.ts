import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { ALICE, setup, type Setup } from './inbox-status-helpers'
import {
	ACCOUNT_ANSWER_BYTES,
	ACCOUNT_BYTES_SQL,
	ACCOUNT_FROM,
	familiarFollowers,
	MAX_FAMILIAR_FOLLOWERS,
	MAX_REMOTE_FIELDS,
} from '../src/domain/accounts'
import { listAccounts, MAX_LIST_MEMBERS_ANSWERED } from '../src/domain/lists'
import { utf8Length } from '../src/platform/dump-format'
import type { StoreOperation } from '../src/platform/store-kernel'
import { sanitizeRemoteHtml } from '../src/security/html'
import { sha256Hex } from '../src/security/tokens'

// RES-3: an answer of many accounts (a list's members with limit=0, familiar followers) stays within
// ACCOUNT_ANSWER_BYTES, both in the account rows that leave SQLite and in the serialized answer, whatever the
// accounts' bios and fields; a typical answer is never cut.

const ORIGIN = 'https://kopje.test'
const LIST = '800000000000000001'

type Profile = {
	displayName: string
	note: string
	url: string
	avatar: string
	header: string
	attachment: unknown[]
}

const field = (name: string, value: string) => ({ type: 'PropertyValue', name, value })
const link = (href: string) =>
	`<a href="${href}" target="_blank" rel="nofollow noopener me" translate="no"><span class="invisible">https://</span>` +
	`<span class="">${href.slice(8)}</span><span class="invisible"></span></a>`
const media = (kind: string, i: number) =>
	`https://files.social.example/accounts/${kind}/109/348/${String(i).padStart(3, '0')}/456/789/012/original/` +
	'0123456789abcdef.png'

// A Mastodon user's profile as Mastodon renders it: a two-paragraph bio with a link and a hashtag, four fields.
const typical = (i: number): Profile => ({
	displayName: `Alice Example ${i} 🦬`,
	note:
		'<p>Software developer in Tokyo. Coffee, cats, open source and the fediverse. 東京在住のソフトウェア開発者です。' +
		'Posts in English and 日本語.</p><p>Blog: ' +
		link(`https://alice${i}.example.com/blog`) +
		' <a href="https://social.example/tags/fediverse" class="mention hashtag" rel="nofollow noopener" ' +
		'target="_blank">#<span>fediverse</span></a></p>',
	url: `https://social.example/@alice${i}`,
	avatar: media('avatars', i),
	header: media('headers', i),
	attachment: [
		field('Website', link(`https://alice${i}.example.com`)),
		field('GitHub', link(`https://github.com/alice${i}`)),
		field('Pronouns', 'she/her'),
		field('Location', 'Tokyo, Japan 🗼'),
	],
})

// A profile at Misskey's own limits: a 50-character name, a 1,500-character bio and 16 fields, all in Japanese.
const large = (i: number): Profile => ({
	displayName: `${'名'.repeat(48)}${String(i % 100).padStart(2, '0')}`,
	note: `<p>${'自己紹介の文章です。'.repeat(75)}<br>${'よろしくお願いします。'.repeat(68)}</p>`,
	url: `https://misskey.example/@user${i}`,
	avatar: media('avatars', i),
	header: media('headers', i),
	attachment: Array.from({ length: MAX_REMOTE_FIELDS }, (_, f) =>
		field(`項目${f}`, f % 2 === 0 ? link(`https://example.com/user${i}/links/${f}`) : '説明の文章です。'.repeat(10))
	),
})

// Every variable part at its bound: a bio the sanitizer grew from REMOTE_HTML_RAW_LIMIT code units (16,666 empty
// links, about 0.8 MB, escaping to more), a display name of 2,048 characters that escape to six bytes each, 2 KiB
// URLs, and 16 fields whose values sanitizing grows fivefold.
const MAX_NOTE = sanitizeRemoteHtml('<a>'.repeat(16_666))
const maximal = (i: number): Profile => ({
	displayName: '\u0001'.repeat(2048),
	note: MAX_NOTE,
	url: `https://max.example/@u${i}/${'u'.repeat(2000)}`,
	avatar: `https://max.example/a${i}/${'a'.repeat(2000)}`,
	header: `https://max.example/h${i}/${'h'.repeat(2000)}`,
	attachment: Array.from({ length: MAX_REMOTE_FIELDS }, () => field('n'.repeat(255), '&'.repeat(4096))),
})

// `count` remote accounts from `base` with the profile of each, oldest id first.
async function accounts(t: Setup, count: number, base: bigint, profile: (i: number) => Profile): Promise<string[]> {
	const ids = Array.from({ length: count }, (_, i) => String(base + BigInt(i)))
	const rows = ids.map((id, i) => {
		const p = profile(i)
		return [
			id,
			`https://m.example/users/u${id}`,
			`u${id}`,
			p.displayName,
			p.note,
			p.url,
			p.avatar,
			p.header,
			JSON.stringify({ type: 'Person', attachment: p.attachment }),
		]
	})
	// In batches of JSON within SQLite's largest string in a Durable Object (2 MB).
	const batches: string[][][] = [[]]
	let size = 0
	for (const row of rows) {
		const bytes = utf8Length(JSON.stringify(row))
		if (size + bytes > 1_000_000 && batches.at(-1)!.length > 0) {
			batches.push([])
			size = 0
		}
		batches.at(-1)!.push(row)
		size += bytes
	}
	for (const batch of batches) {
		await sql(
			t.store,
			`INSERT INTO accounts (id, uri, username, domain, display_name, note, url, avatar_url, header_url, raw)
			SELECT r.value ->> 0, r.value ->> 1, r.value ->> 2, 'm.example', r.value ->> 3, r.value ->> 4, r.value ->> 5,
				r.value ->> 6, r.value ->> 7, r.value ->> 8
			FROM json_each(?) r`,
			JSON.stringify(batch)
		)
	}
	return ids
}

async function listOf(t: Setup, members: readonly string[]): Promise<void> {
	await sql(t.store, "INSERT OR IGNORE INTO lists (id, account_id, title) VALUES (?, ?, 'l')", LIST, ALICE)
	await sql(
		t.store,
		'INSERT INTO list_accounts (list_id, account_id) SELECT ?, value FROM json_each(?)',
		LIST,
		JSON.stringify(members)
	)
}

type Read = { answer: unknown; profiles: number; bytes: number }

// Runs a read over a SqlStorage that measures the account rows leaving SQLite: how many, and their UTF-8 bytes.
async function measured<I>(t: Setup, operation: StoreOperation<I, unknown>, input: I): Promise<Read> {
	return runInDurableObject(t.store, (_instance, state) => {
		let profiles = 0
		let bytes = 0
		const real = state.storage.sql
		const counting = {
			exec: (query: string, ...params: SqlStorageValue[]) => {
				const cursor = real.exec(query, ...params)
				const count = (rows: Record<string, SqlStorageValue>[]) => {
					for (const row of rows.filter((r) => 'note' in r && 'display_name' in r)) {
						profiles++
						for (const value of Object.values(row)) {
							bytes += typeof value === 'string' ? utf8Length(value) : 8
						}
					}
					return rows
				}
				return { toArray: () => count(cursor.toArray()), one: () => count([cursor.one()])[0]! }
			},
		} as unknown as SqlStorage
		let answer = operation.run(counting, input) as Record<string, unknown>
		while (answer.status === 'ok' && 'value' in answer) {
			answer = answer.value as Record<string, unknown>
		}
		return { answer, profiles, bytes }
	})
}

async function credential(t: Setup, scope: string) {
	return { tokenHash: await sha256Hex(t.tokens.alice), scope, now: NOW } as never
}

type Answer = { ids: string[]; bytes: number; next: string | null }

async function membersAnswer(t: Setup, path: string): Promise<Answer> {
	const response = await t.request(path, { headers: { authorization: `Bearer ${t.tokens.alice}` } })
	expect(response.status).toBe(200)
	const body = await response.text()
	const next = /<([^>]+)>; rel="next"/.exec(response.headers.get('link') ?? '')?.[1] ?? null
	return { ids: (JSON.parse(body) as { id: string }[]).map((a) => a.id), bytes: utf8Length(body), next }
}

// Follows each Link next from `path` to the end: every answer, in order.
async function walk(t: Setup, path: string): Promise<Answer[]> {
	const answers = [await membersAnswer(t, path)]
	for (let next = answers[0]!.next; next !== null; next = answers.at(-1)!.next) {
		const url = new URL(next)
		answers.push(await membersAnswer(t, `${url.pathname}${url.search}`))
		expect(answers.length).toBeLessThanOrEqual(MAX_LIST_MEMBERS_ANSWERED)
	}
	return answers
}

const listInput = async (t: Setup) => ({
	credential: await credential(t, 'read:lists'),
	id: LIST,
	page: null,
	present: { origin: ORIGIN },
})

describe('answers of many accounts are bounded in bytes (RES-3)', () => {
	it('counts at least what each account serializes to, as ACCOUNT_COLUMNS reads it', async () => {
		const t = await setup()
		const empty = (): Profile => ({
			displayName: '',
			note: '',
			url: '',
			avatar: '',
			header: '',
			attachment: Array.from({ length: MAX_REMOTE_FIELDS }, () => field('', '')),
		})
		const ids = [
			...(await accounts(t, 1, 610_000_000_000_000_000n, typical)),
			...(await accounts(t, 1, 620_000_000_000_000_000n, large)),
			...(await accounts(t, 1, 630_000_000_000_000_000n, empty)),
			// Escapes: quotes, backslashes, newlines and control characters in the name and bio.
			...(await accounts(t, 1, 640_000_000_000_000_000n, (i) => ({
				...typical(i),
				displayName: '"\\\n\u0001'.repeat(400),
				note: `<p>${'"\\\n\u0007'.repeat(4000)}</p>`,
			}))),
		]
		await sql(t.store, 'UPDATE accounts SET url = NULL, avatar_url = NULL, header_url = NULL WHERE id = ?', ids[2]!)
		await sql(t.store, 'UPDATE accounts SET username = ? WHERE id = ?', 'u'.repeat(255), ids[2]!)
		for (const id of ids) {
			const [row] = await sql<{ bytes: number }>(
				t.store,
				`SELECT ${ACCOUNT_BYTES_SQL} AS bytes FROM ${ACCOUNT_FROM} WHERE a.id = ?`,
				id
			)
			const shown = await t.api(`/api/v1/accounts/${id}`)
			expect(utf8Length(JSON.stringify(shown.body))).toBeLessThanOrEqual(row!.bytes)
		}
	})

	it(`answers ${MAX_LIST_MEMBERS_ANSWERED} typical members whole, in about a quarter of the budget`, async () => {
		const t = await setup()
		const ids = await accounts(t, MAX_LIST_MEMBERS_ANSWERED, 600_000_000_000_000_000n, typical)
		await listOf(t, ids)
		const answer = await membersAnswer(t, `/api/v1/lists/${LIST}/accounts?limit=0`)
		expect(answer.ids).toEqual([...ids].reverse())
		expect(answer.next).toBeNull()
		// 2,083 bytes a member.
		expect(answer.bytes).toBeLessThan(ACCOUNT_ANSWER_BYTES / 4)
	}, 60_000)

	it(`cuts ${MAX_LIST_MEMBERS_ANSWERED} members at Misskey's limits and links next to the rest`, async () => {
		const t = await setup()
		const ids = await accounts(t, MAX_LIST_MEMBERS_ANSWERED, 600_000_000_000_000_000n, large)
		await listOf(t, ids)
		const answers = await walk(t, `/api/v1/lists/${LIST}/accounts?limit=0`)
		// About 8 KiB a member: two answers.
		expect(answers).toHaveLength(2)
		for (const answer of answers) {
			expect(answer.bytes).toBeLessThanOrEqual(ACCOUNT_ANSWER_BYTES)
		}
		expect(answers.flatMap((answer) => answer.ids)).toEqual([...ids].reverse())
		expect(new URL(answers[0]!.next!).searchParams.get('limit')).toBe('0')
	}, 60_000)

	it('reads and answers the same bounded bytes for 24 and 96 members at every bound, and pages to the rest', async () => {
		const read: Read[] = []
		for (const count of [24, 96]) {
			const t = await setup()
			const ids = await accounts(t, count, 600_000_000_000_000_000n, maximal)
			await listOf(t, ids)
			const first = await measured(t, listAccounts, await listInput(t))
			read.push(first)
			expect(first.bytes).toBeLessThanOrEqual(ACCOUNT_ANSWER_BYTES)
			const answers = await walk(t, `/api/v1/lists/${LIST}/accounts?limit=0`)
			for (const answer of answers) {
				expect(answer.bytes).toBeLessThanOrEqual(ACCOUNT_ANSWER_BYTES)
			}
			expect(answers.flatMap((answer) => answer.ids)).toEqual([...ids].reverse())
		}
		// Each member counts over 4 MB (its bio past ESCAPED_EXACT_BYTES at six bytes a byte): the same one or two,
		// however many there are.
		expect(read[0]!.profiles).toBe(read[1]!.profiles)
		expect(read[0]!.profiles).toBeLessThanOrEqual(2)
		expect((read[0]!.answer as { items: unknown[] }).items).toHaveLength(read[0]!.profiles)
	}, 120_000)

	it('answers the first member alone when it passes the budget, so the next link moves on', async () => {
		const t = await setup()
		const [huge] = await accounts(t, 1, 690_000_000_000_000_000n, maximal)
		const rest = await accounts(t, 3, 600_000_000_000_000_000n, typical)
		// 1.5 million control characters escape to 9 MB (a row holds at most 2 MB).
		await sql(t.store, 'UPDATE accounts SET note = ? WHERE id = ?', '\u0001'.repeat(1_500_000), huge!)
		await listOf(t, [huge!, ...rest])
		const answers = await walk(t, `/api/v1/lists/${LIST}/accounts?limit=0`)
		expect(answers.map((answer) => answer.ids)).toEqual([[huge], [...rest].reverse()])
	}, 60_000)

	it('cuts the answer by its serialized bytes when sanitizing grows the fields', async () => {
		const t = await setup()
		// Each value of 600 code units sanitizes to 9.8 KB: three fields shown, about 30 KB, where the read counts 11 KB.
		const ids = await accounts(t, 400, 600_000_000_000_000_000n, (i) => ({
			...typical(i),
			attachment: Array.from({ length: MAX_REMOTE_FIELDS }, () => field('n', '<a>'.repeat(200))),
		}))
		await listOf(t, ids)
		const first = await measured(t, listAccounts, await listInput(t))
		expect(first.profiles).toBe(400)
		const answers = await walk(t, `/api/v1/lists/${LIST}/accounts?limit=0`)
		expect(answers.length).toBeGreaterThan(1)
		for (const answer of answers) {
			expect(answer.bytes).toBeLessThanOrEqual(ACCOUNT_ANSWER_BYTES)
		}
		expect(answers.flatMap((answer) => answer.ids)).toEqual([...ids].reverse())
	}, 60_000)

	it('shares the familiar followers budget, so one large account does not starve the others', async () => {
		const t = await setup()
		const targets = await accounts(t, 20, 590_000_000_000_000_000n, typical)
		// The first target's 80 followers have 110 KB bios; the others share 80 typical followers.
		const heavy = await accounts(t, MAX_FAMILIAR_FOLLOWERS, 600_000_000_000_000_000n, (i) => ({
			...typical(i),
			note: `<p>${'&amp;'.repeat(22_000)}</p>`,
		}))
		const light = await accounts(t, MAX_FAMILIAR_FOLLOWERS, 610_000_000_000_000_000n, typical)
		const follows = async (followers: readonly string[], followed: readonly string[]) =>
			sql(
				t.store,
				`INSERT INTO follows (account_id, target_account_id, state)
				SELECT f.value, x.value, 'accepted' FROM json_each(?) f, json_each(?) x`,
				JSON.stringify(followers),
				JSON.stringify(followed)
			)
		await follows([ALICE], [...heavy, ...light])
		await follows(heavy, targets.slice(0, 1))
		await follows(light, targets.slice(1))
		const query = targets.map((id) => `id[]=${id}`).join('&')
		const response = await t.request(`/api/v1/accounts/familiar_followers?${query}`, {
			headers: { authorization: `Bearer ${t.tokens.alice}` },
		})
		const body = await response.text()
		expect(utf8Length(body)).toBeLessThanOrEqual(ACCOUNT_ANSWER_BYTES)
		const shown = JSON.parse(body) as { id: string; accounts: { id: string }[] }[]
		expect(shown.map((entry) => entry.id)).toEqual(targets)
		// Its share, a twentieth of the budget, holds three.
		expect(shown[0]!.accounts.map((a) => a.id)).toEqual([...heavy].reverse().slice(0, 3))
		for (const entry of shown.slice(1)) {
			expect(entry.accounts.map((a) => a.id)).toEqual([...light].reverse())
		}
		const read = await measured(t, familiarFollowers, {
			credential: await credential(t, 'read:follows'),
			ids: targets,
			present: { origin: ORIGIN },
		})
		expect(read.bytes).toBeLessThanOrEqual(ACCOUNT_ANSWER_BYTES)
		expect(read.profiles).toBe(3 + 19 * MAX_FAMILIAR_FOLLOWERS)
	}, 60_000)
})
