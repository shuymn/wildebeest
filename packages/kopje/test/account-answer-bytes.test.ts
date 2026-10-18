import { runInDurableObject } from 'cloudflare:test'

import { Person } from '@fedify/vocab'
import { parseFragment } from 'parse5'
import { describe, expect, it } from 'vitest'

import { bearer, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { ALICE, setup, type Setup } from './inbox-status-helpers'
import { field, MAX_BIO, maxFields } from './profile-fixtures'
import { longestString, observedSql } from './read-helpers'
import { community, post, remoteAccount, seedStatus } from './status-helpers'
import { Db } from '../src/db/sql'
import {
	DISPLAY_NAME_LIMIT,
	familiarFollowers,
	listFollows,
	MAX_FAMILIAR_FOLLOWERS,
	MAX_REMOTE_FIELDS,
	presentAccountsWithin,
	PROFILE_URL_LIMIT,
	USERNAME_LIMIT,
} from '../src/domain/accounts'
import { ANSWER_BYTES } from '../src/domain/answer-budget'
import { listAccounts, MAX_LIST_MEMBERS_ANSWERED } from '../src/domain/lists'
import { createStatus, getStatus } from '../src/domain/statuses'
import { remoteActorInput } from '../src/federation/remote-actor'
import { utf8Length } from '../src/platform/dump-format'
import type { StoreOperation } from '../src/platform/store-kernel'
import { jsonStringBytes, REMOTE_BIO_BYTES, sanitizeRemoteBio, sanitizeRemoteHtml } from '../src/security/html'
import { sha256Hex } from '../src/security/tokens'

// RES-2: one presented account has a known size, as stored and as read, so a page of accounts does too. RES-3: an
// answer of many accounts (list members and endorsements with limit=0, familiar followers) stays within
// ANSWER_BYTES as serialized, reading at most one chunk past it; a typical answer is never cut.

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

// Every variable part an account presents at its bound (RES-2): a bio of REMOTE_BIO_BYTES (MAX_BIO), a display name of
// DISPLAY_NAME_LIMIT characters that escape to six bytes each, URLs of PROFILE_URL_LIMIT, and fields of about
// REMOTE_FIELDS_BYTES (maxFields).
const atLimit = (prefix: string) => prefix.padEnd(PROFILE_URL_LIMIT, 'u')
const maximal = (i: number): Profile => ({
	displayName: '\u0001'.repeat(DISPLAY_NAME_LIMIT),
	note: MAX_BIO,
	url: atLimit(`https://max.example/@u${i}/`),
	avatar: atLimit(`https://max.example/a${i}/`),
	header: atLimit(`https://max.example/h${i}/`),
	attachment: maxFields(),
})
// What one such account is at most as read from SQLite and as serialized (ACCOUNT_COLUMNS's comment).
const READ_MAX = 115_000
const SHOWN_MAX = 125_000

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
		const counting = observedSql(real, (rows) => {
			for (const row of rows.filter((r) => 'note' in r && 'display_name' in r)) {
				profiles++
				for (const value of Object.values(row)) {
					bytes += typeof value === 'string' ? utf8Length(value) : 8
				}
			}
		})
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

const BASE = 600_000_000_000_000_000n

async function follows(t: Setup, followers: readonly string[], followed: readonly string[], state = 'accepted') {
	await sql(
		t.store,
		`INSERT INTO follows (account_id, target_account_id, state)
		SELECT f.value, x.value, ? FROM json_each(?) f, json_each(?) x`,
		state,
		JSON.stringify(followers),
		JSON.stringify(followed)
	)
}

async function shownBytes(t: Setup, path: string): Promise<{ body: unknown; bytes: number }> {
	const response = await t.request(path, { headers: { authorization: `Bearer ${t.tokens.alice}` } })
	expect(response.status).toBe(200)
	const text = await response.text()
	return { body: JSON.parse(text) as unknown, bytes: utf8Length(text) }
}

describe('one account has a known size (RES-2)', () => {
	it('stores a remote bio within REMOTE_BIO_BYTES, as sanitized HTML, and refuses over-long profile URLs', async () => {
		const long = `https://example.com/${'x'.repeat(PROFILE_URL_LIMIT)}`
		for (const summary of [
			'<a>'.repeat(16_666),
			`<p>${'日本語の自己紹介と<a href="https://example.com/a">リンク</a>です。'.repeat(2_000)}</p>`,
			`<p>${'\u0001"<b>x</b>'.repeat(10_000)}</p>`,
		]) {
			const actor = await Person.fromJsonLd({
				'@context': 'https://www.w3.org/ns/activitystreams',
				id: 'https://example.com/users/u',
				type: 'Person',
				preferredUsername: 'u',
				summary,
				url: long,
				icon: { type: 'Image', url: long },
				image: { type: 'Image', url: 'https://example.com/header.png' },
			})
			const input = await remoteActorInput(actor, {})
			const note = input!.note
			expect(jsonStringBytes(note)).toBeLessThanOrEqual(REMOTE_BIO_BYTES)
			// Most of the bound is used, and the stored bio parses as HTML without a structural error (no tag cut
			// mid-way); control characters in text are the sender's, kept as the sanitizer keeps them.
			expect(jsonStringBytes(note)).toBeGreaterThan(REMOTE_BIO_BYTES / 2)
			const errors: string[] = []
			parseFragment(note, { onParseError: (error) => errors.push(error.code) })
			expect(errors.filter((code) => code !== 'control-character-in-input-stream')).toEqual([])
			expect(note.endsWith('>')).toBe(true)
			expect([input!.url, input!.avatarUrl, input!.headerUrl]).toEqual([null, null, 'https://example.com/header.png'])
		}
	})

	it('keeps realistic bios whole: Mastodon, Misskey, Pleroma and GoToSocial at their limits', () => {
		const link = (i: number) =>
			`<a href="https://example.com/${i}" rel="nofollow noopener" target="_blank" translate="no">` +
			`<span class="invisible">https://</span><span class="">example.com/${i}</span><span class="invisible"></span></a>`
		const tag = (i: number) =>
			`<a href="https://social.example/tags/t${i}" class="mention hashtag" rel="tag">#<span>t${i}</span></a>`
		const sizes = [
			// Mastodon: 500 characters, with links and hashtags.
			`<p>${'自己紹介'.repeat(80)} ${link(1)} ${tag(1)} ${tag(2)}</p>`,
			// Misskey: 1,500 characters.
			`<p>${'自己紹介の文章です。'.repeat(150)}</p>`,
			// Pleroma and GoToSocial: 5,000 characters of Japanese in paragraphs, and 5,000 with a link every 100.
			`<p>${'自己紹介の文章です。'.repeat(100)}</p>`.repeat(5),
			Array.from({ length: 50 }, (_, i) => `<p>${'自己紹介の文章です。'.repeat(7)} ${link(i)} ${tag(i)}</p>`).join(''),
		].map((bio) => {
			expect(sanitizeRemoteBio(bio)).toBe(sanitizeRemoteHtml(bio))
			return jsonStringBytes(sanitizeRemoteBio(bio))
		})
		// 1,437, 4,509, 15,037 and 27,712 bytes: the largest under half the bound.
		expect(Math.max(...sizes)).toBeLessThan(REMOTE_BIO_BYTES / 2)
	})

	it('reads a stored over-long bio as empty and over-long URLs as none', async () => {
		const t = await setup()
		const [id] = await accounts(t, 1, BASE, typical)
		const long = `https://example.com/${'x'.repeat(PROFILE_URL_LIMIT)}`
		await sql(
			t.store,
			'UPDATE accounts SET note = ?, display_name = ?, url = ?, avatar_url = ?, header_url = ? WHERE id = ?',
			`<p>${'x'.repeat(REMOTE_BIO_BYTES)}</p>`,
			'n'.repeat(DISPLAY_NAME_LIMIT + 100),
			long,
			long,
			long,
			id!
		)
		const { body } = await shownBytes(t, `/api/v1/accounts/${id}`)
		expect(body).toMatchObject({
			note: '',
			display_name: 'n'.repeat(DISPLAY_NAME_LIMIT),
			url: `https://m.example/@u${id}`,
			avatar: `${ORIGIN}/assets/avatar.png`,
			header: `${ORIGIN}/assets/header.png`,
		})
		// A bio within the raw bound that escapes past it reads as empty too; one at the bound is kept.
		await sql(t.store, 'UPDATE accounts SET note = ? WHERE id = ?', '\u0001'.repeat(REMOTE_BIO_BYTES / 2), id!)
		expect((await shownBytes(t, `/api/v1/accounts/${id}`)).body).toMatchObject({ note: '' })
		await sql(t.store, 'UPDATE accounts SET note = ? WHERE id = ?', MAX_BIO, id!)
		expect((await shownBytes(t, `/api/v1/accounts/${id}`)).body).toMatchObject({ note: MAX_BIO })
	})

	it('guards a stored bio with an embedded NUL by its whole bytes, and cuts a display name by code points', async () => {
		const t = await setup()
		const [id] = await accounts(t, 1, BASE, typical)
		const shown = async (note: string, displayName = 'n') => {
			await sql(t.store, 'UPDATE accounts SET note = ?, display_name = ? WHERE id = ?', note, displayName, id!)
			return (await shownBytes(t, `/api/v1/accounts/${id}`)).body as { note: string; display_name: string }
		}
		// A NUL does not hide the rest from the guards: past the raw bound, or escaping past it, the bio reads as empty.
		expect((await shown(`<p>a\u0000${'x'.repeat(REMOTE_BIO_BYTES)}</p>`)).note).toBe('')
		expect((await shown(`<p>a${'\u0000'.repeat(REMOTE_BIO_BYTES / 4)}</p>`)).note).toBe('')
		expect((await shown('<p>a\u0000b</p>')).note).toBe('<p>a\u0000b</p>')
		// Supplementary characters count once each: 2,048 of them, 4,096 UTF-16 units.
		const bisons = '🦬'.repeat(DISPLAY_NAME_LIMIT + 10)
		expect((await shown('', bisons)).display_name).toBe('🦬'.repeat(DISPLAY_NAME_LIMIT))
		expect((await shown('', `a${bisons}`)).display_name).toBe(`a${'🦬'.repeat(DISPLAY_NAME_LIMIT - 1)}`)
	})

	it('shows a mention with a stored over-long URL by its derived URL, in a status and in a composed one', async () => {
		const h = await community(['alice'])
		const carol = await remoteAccount(h.store, 'carol')
		const long = `https://remote.example/${'x'.repeat(PROFILE_URL_LIMIT)}`
		await sql(h.store, 'UPDATE accounts SET url = ? WHERE id = ?', long, carol)
		const derived = 'https://remote.example/@carol'
		// Composed: the mention links the derived URL.
		const status = await post(h, h.users.alice, { status: '@carol@remote.example hi' })
		expect(status.content).not.toContain(long)
		expect(status.content).toContain(`href="${derived}"`)
		expect(status.mentions).toEqual([{ id: carol, username: 'carol', url: derived, acct: 'carol@remote.example' }])
		// Presented: a stored status mentioning the account.
		const stored = await seedStatus(h.store, {
			accountId: h.users.alice.id,
			visibility: 'public',
			mentions: [{ accountId: carol }],
		})
		const response = await h.request(`/api/v1/statuses/${stored}`, bearer(h.users.alice.token))
		const body = await response.text()
		expect(body).not.toContain(long)
		expect((JSON.parse(body) as { mentions: { url: string }[] }).mentions.map((m) => m.url)).toEqual([derived])
	})

	it('shows a mention of a converted account by its cut username, in a status and in a composed one', async () => {
		const h = await community(['alice'])
		const [carol, dave] = [await remoteAccount(h.store, 'carol'), await remoteAccount(h.store, 'dave')]
		const long = `https://remote.example/${'x'.repeat(PROFILE_URL_LIMIT)}`
		// A converted 64 KiB username (no text can name it), and one of 300 characters a post can name; both with an
		// over-long stored URL.
		const huge = `c${'u'.repeat(64 * 1024)}`
		const named = `d${'v'.repeat(299)}`
		await sql(h.store, 'UPDATE accounts SET username = ?, url = ? WHERE id = ?', huge, long, carol)
		await sql(h.store, 'UPDATE accounts SET username = ?, url = ? WHERE id = ?', named, long, dave)
		const credential = (scope: string) =>
			sha256Hex(h.users.alice.token).then((tokenHash) => ({ tokenHash, scope, now: NOW }))
		// Each mention carries the username cut at USERNAME_LIMIT, and the acct and URL derived from it.
		const expectMention = (mention: Record<string, unknown>, id: string, username: string) => {
			const cut = username.slice(0, USERNAME_LIMIT)
			expect(mention).toEqual({
				id,
				username: cut,
				acct: `${cut}@remote.example`,
				url: `https://remote.example/@${cut}`,
			})
			expect(utf8Length(JSON.stringify(mention))).toBeLessThan(1000)
		}
		const runLongest = (operation: StoreOperation<never, unknown>, input: unknown) =>
			runInDurableObject(h.store, (_instance, state) => {
				let most = 0
				const real = state.storage.sql
				const counting = observedSql(real, (rows) => {
					most = Math.max(most, longestString(rows))
				})
				let answer = operation.run(counting, input as never) as Record<string, unknown>
				while (answer.status === 'ok' && 'value' in answer) {
					answer = answer.value as Record<string, unknown>
				}
				return { most, status: answer as unknown as { content: string; mentions: unknown[] } }
			})
		// Composed: the 300-character username resolves and is shown cut; the 64 KiB one stays text.
		const composed = await runLongest(createStatus, {
			credential: await credential('write:statuses'),
			text: `@${named}@remote.example @${huge.slice(0, 100)}@remote.example hi`,
			spoilerText: '',
			mediaIds: [],
			objectId: '00000000-0000-4000-8000-000000000001',
			now: NOW,
			present: { origin: ORIGIN },
		})
		expect(composed.most).toBeLessThanOrEqual(2048)
		expect(composed.status.content).not.toContain(long)
		expect(composed.status.mentions).toHaveLength(1)
		expectMention(composed.status.mentions[0] as Record<string, unknown>, dave, named)
		// Presented: a stored status mentioning both.
		const stored = await seedStatus(h.store, {
			accountId: h.users.alice.id,
			visibility: 'public',
			mentions: [{ accountId: carol }, { accountId: dave }],
		})
		const read = await runLongest(getStatus, {
			credential: await credential('read:statuses'),
			id: stored,
			present: { origin: ORIGIN },
		})
		expect(read.most).toBeLessThanOrEqual(2048)
		const response = await h.request(`/api/v1/statuses/${stored}`, bearer(h.users.alice.token))
		const body = await response.text()
		expect(body).not.toContain(long)
		const mentions = (JSON.parse(body) as { mentions: Record<string, unknown>[] }).mentions
		const byId = new Map(mentions.map((mention) => [mention.id, mention]))
		expectMention(byId.get(carol)!, carol, huge)
		expectMention(byId.get(dave)!, dave, named)
	})

	it('reads and answers a page of 80 followers at every bound from a window of 240', async () => {
		const t = await setup()
		const ids = await accounts(t, 240, BASE, maximal)
		await follows(t, ids, [ALICE])
		const read = await measured(t, listFollows, {
			credential: await credential(t, 'read:accounts'),
			account: ALICE,
			direction: 'followers',
			page: { limit: 80 },
			present: { origin: ORIGIN },
			now: NOW,
		})
		expect(read.profiles).toBe(80)
		expect(read.bytes).toBeLessThanOrEqual(80 * READ_MAX)
		const { body, bytes } = await shownBytes(t, `/api/v1/accounts/${ALICE}/followers?limit=80`)
		expect((body as unknown[]).length).toBe(80)
		expect(bytes).toBeLessThanOrEqual(80 * SHOWN_MAX)
		// Each account is near its bound.
		expect(bytes).toBeGreaterThan(80 * 100_000)
	}, 60_000)
})

describe('answers of many accounts are bounded in bytes (RES-3)', () => {
	it(`answers ${MAX_LIST_MEMBERS_ANSWERED} typical members whole, in about a quarter of the budget`, async () => {
		const t = await setup()
		const ids = await accounts(t, MAX_LIST_MEMBERS_ANSWERED, BASE, typical)
		await listOf(t, ids)
		const answer = await membersAnswer(t, `/api/v1/lists/${LIST}/accounts?limit=0`)
		expect(answer.ids).toEqual([...ids].reverse())
		expect(answer.next).toBeNull()
		// 2,083 bytes a member.
		expect(answer.bytes).toBeLessThan(ANSWER_BYTES / 4)
	}, 60_000)

	it(`cuts ${MAX_LIST_MEMBERS_ANSWERED} members at Misskey's limits and links next to the rest`, async () => {
		const t = await setup()
		const ids = await accounts(t, MAX_LIST_MEMBERS_ANSWERED, BASE, large)
		await listOf(t, ids)
		const answers = await walk(t, `/api/v1/lists/${LIST}/accounts?limit=0`)
		// About 8 KiB a member: two answers.
		expect(answers).toHaveLength(2)
		for (const answer of answers) {
			expect(answer.bytes).toBeLessThanOrEqual(ANSWER_BYTES)
		}
		expect(answers.flatMap((answer) => answer.ids)).toEqual([...ids].reverse())
		expect(new URL(answers[0]!.next!).searchParams.get('limit')).toBe('0')
	}, 60_000)

	it('reads the same bounded rows for 100 and 400 members at every bound, and pages to the rest', async () => {
		const read: Read[] = []
		for (const count of [100, 400]) {
			const t = await setup()
			const ids = await accounts(t, count, BASE, maximal)
			await listOf(t, ids)
			const first = await measured(t, listAccounts, await listInput(t))
			read.push(first)
			// The budget, and at most one chunk of 50 read past it.
			expect(first.bytes).toBeLessThanOrEqual(ANSWER_BYTES + 50 * READ_MAX)
			const answers = await walk(t, `/api/v1/lists/${LIST}/accounts?limit=0`)
			for (const answer of answers) {
				expect(answer.bytes).toBeLessThanOrEqual(ANSWER_BYTES)
			}
			expect(answers.flatMap((answer) => answer.ids)).toEqual([...ids].reverse())
		}
		// About 68 fit: the first two chunks are read, however many members there are.
		expect(read[0]!.profiles).toBe(100)
		expect(read[1]!.profiles).toBe(100)
		expect((read[1]!.answer as { items: unknown[] }).items.length).toBeGreaterThan(50)
	}, 120_000)

	it('answers the first account alone when it alone passes the budget, so a continuation moves on', async () => {
		const t = await setup()
		const ids = await accounts(t, 3, BASE, typical)
		const answer = await runInDurableObject(t.store, (_instance, state) => {
			const db = new Db(state.storage.sql)
			const present = { origin: ORIGIN }
			return [true, false].map((leading) => presentAccountsWithin(db, ids, present, 10, leading))
		})
		expect(answer.map((a) => [a.items.map((item) => item.id), a.cut])).toEqual([
			[[ids[0]], true],
			[[], true],
		])
	})

	it('cuts the answer by its serialized bytes when sanitizing grows the fields', async () => {
		const t = await setup()
		// Each value of 600 code units sanitizes to 9.8 KB: three fields shown, about 30 KB a member.
		const ids = await accounts(t, 400, BASE, (i) => ({
			...typical(i),
			attachment: Array.from({ length: MAX_REMOTE_FIELDS }, () => field('n', '<a>'.repeat(200))),
		}))
		await listOf(t, ids)
		const answers = await walk(t, `/api/v1/lists/${LIST}/accounts?limit=0`)
		expect(answers.length).toBeGreaterThan(1)
		for (const answer of answers) {
			expect(answer.bytes).toBeLessThanOrEqual(ANSWER_BYTES)
		}
		expect(answers.flatMap((answer) => answer.ids)).toEqual([...ids].reverse())
	}, 60_000)

	it('pages a cut answer past pending and unavailable members, each available one once', async () => {
		const t = await setup()
		const ids = await accounts(t, 200, BASE, maximal)
		await listOf(t, ids)
		// Every third member is being deleted; every other one is followed with a pending request only.
		const gone = ids.filter((_, i) => i % 3 === 0)
		await sql(
			t.store,
			'UPDATE accounts SET deleted_at = ? WHERE id IN (SELECT value FROM json_each(?))',
			new Date(NOW).toISOString(),
			JSON.stringify(gone)
		)
		await follows(
			t,
			[ALICE],
			ids.filter((_, i) => i % 2 === 0),
			'pending'
		)
		const answers = await walk(t, `/api/v1/lists/${LIST}/accounts?limit=0`)
		expect(answers.length).toBeGreaterThan(1)
		expect(answers.flatMap((answer) => answer.ids)).toEqual(ids.filter((id) => !gone.includes(id)).reverse())
	}, 60_000)

	it('cuts the endorsements answer by its bytes and links next to the rest', async () => {
		const t = await setup()
		const ids = await accounts(t, 150, BASE, maximal)
		await follows(t, [ALICE], ids)
		await sql(
			t.store,
			'INSERT INTO account_pins (account_id, target_account_id) SELECT ?, value FROM json_each(?)',
			ALICE,
			JSON.stringify(ids)
		)
		const answers = await walk(t, '/api/v1/endorsements?limit=0')
		expect(answers.length).toBeGreaterThan(1)
		for (const answer of answers) {
			expect(answer.bytes).toBeLessThanOrEqual(ANSWER_BYTES)
		}
		expect(answers.flatMap((answer) => answer.ids)).toEqual([...ids].reverse())
	}, 60_000)
})

describe('familiar followers share the answer bytes (RES-3)', () => {
	type Entry = { id: string; accounts: { id: string }[] }
	const ask = async (t: Setup, targets: readonly string[]) => {
		const query = targets.map((id) => `id[]=${id}`).join('&')
		const { body, bytes } = await shownBytes(t, `/api/v1/accounts/familiar_followers?${query}`)
		expect(bytes).toBeLessThanOrEqual(ANSWER_BYTES)
		return new Map((body as Entry[]).map((entry) => [entry.id, entry.accounts.map((a) => a.id)]))
	}

	it('answers one account whole when all its familiar followers fit, at every bound', async () => {
		const t = await setup()
		const [target] = await accounts(t, 1, 590_000_000_000_000_000n, typical)
		const followers = await accounts(t, MAX_FAMILIAR_FOLLOWERS / 2, BASE, maximal)
		await follows(t, [ALICE], followers)
		await follows(t, followers, [target!])
		// 40 accounts of about 120 KB: 4.8 MB.
		expect((await ask(t, [target!])).get(target!)).toEqual([...followers].reverse())
	}, 60_000)

	it('gives the whole budget to the one account with followers, whatever the order and the empty ones', async () => {
		const t = await setup()
		const targets = await accounts(t, 20, 590_000_000_000_000_000n, typical)
		const [big, hidden, ...empty] = targets
		const followers = await accounts(t, MAX_FAMILIAR_FOLLOWERS, BASE, maximal)
		await follows(t, [ALICE], followers)
		await follows(t, followers, [big!, hidden!])
		await sql(t.store, 'UPDATE accounts SET hide_collections = 1 WHERE id = ?', hidden!)
		const first = await ask(t, [big!, hidden!, ...empty])
		const last = await ask(t, [...empty, hidden!, big!])
		expect(first).toEqual(last)
		expect(first.get(hidden!)).toEqual([])
		for (const id of empty) {
			expect(first.get(id)).toEqual([])
		}
		// 80 such accounts pass the budget; about 68 fit, far more than a twentieth of it.
		const shown = first.get(big!)!
		expect(shown).toEqual([...followers].reverse().slice(0, shown.length))
		expect(shown.length).toBeGreaterThan(60)
		expect(shown.length).toBeLessThan(MAX_FAMILIAR_FOLLOWERS)
	}, 60_000)

	it('shares the budget so one large account does not crowd out the others, in any order', async () => {
		const t = await setup()
		const targets = await accounts(t, 20, 590_000_000_000_000_000n, typical)
		const heavy = await accounts(t, MAX_FAMILIAR_FOLLOWERS, BASE, maximal)
		const light = await accounts(t, MAX_FAMILIAR_FOLLOWERS, 610_000_000_000_000_000n, typical)
		await follows(t, [ALICE], [...heavy, ...light])
		await follows(t, heavy, targets.slice(0, 1))
		await follows(t, light, targets.slice(1))
		const forward = await ask(t, targets)
		expect(await ask(t, [...targets].reverse())).toEqual(forward)
		for (const id of targets.slice(1)) {
			expect(forward.get(id)).toEqual([...light].reverse())
		}
		// The typical ones take about 3.2 MB; the large one takes what is left.
		const shown = forward.get(targets[0]!)!
		expect(shown).toEqual([...heavy].reverse().slice(0, shown.length))
		expect(shown.length).toBeGreaterThan(30)
		const read = await measured(t, familiarFollowers, {
			credential: await credential(t, 'read:follows'),
			ids: targets,
			present: { origin: ORIGIN },
		})
		// What is shown, and at most one account per requested account read past it.
		expect(read.profiles).toBeLessThanOrEqual(shown.length + 1 + 19 * MAX_FAMILIAR_FOLLOWERS)
		expect(read.bytes).toBeLessThanOrEqual(ANSWER_BYTES + 20 * READ_MAX)
	}, 60_000)
})
