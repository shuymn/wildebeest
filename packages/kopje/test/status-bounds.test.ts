import { runInDurableObject } from 'cloudflare:test'

import { parseFragment } from 'parse5'
import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { ALICE, setup, type Setup } from './inbox-status-helpers'
import { observedSql } from './read-helpers'
import { community, post, remoteAccount } from './status-helpers'
import { ACTOR_URI_LIMIT, PROFILE_URL_LIMIT, USERNAME_LIMIT } from '../src/domain/profile-bounds'
import {
	MAX_MEDIA_DESCRIPTION_LENGTH,
	MAX_REMOTE_OPTION_LENGTH,
	MAX_REMOTE_OPTIONS,
	MAX_STATUS_MEDIA,
	MAX_STATUS_MENTION_ROWS,
	MAX_STATUS_TAGS,
	MAX_TAG_LENGTH,
	MEDIA_URL_LIMIT,
} from '../src/domain/status-bounds'
import { getStatus, statusHistory, statusSource } from '../src/domain/statuses'
import { parseRemoteStatus } from '../src/federation/remote-status'
import { utf8Length } from '../src/platform/dump-format'
import type { StoreOperation } from '../src/platform/store-kernel'
import {
	jsonStringBytes,
	sanitizeRemoteBio,
	sanitizeRemoteContent,
	sanitizeRemoteHtml,
	SPOILER_BYTES,
	STATUS_CONTENT_BYTES,
} from '../src/security/html'
import { sha256Hex } from '../src/security/tokens'

// RES-2: one presented status has a known size. Each column a remote server controls is bounded where it is stored
// and again as it is read (status-bounds.ts), so a row stored before a bound, or converted at the cutover, leaves
// SQLite within it too. The maxima measured here are docs/threat-model.md's table (RES-3).

const ORIGIN = 'https://kopje.test'
// A control character: one code point that JSON escapes to six bytes, the most any code point takes.
const C = '\u0001'
// A remote host of 2,000 characters: an actor id of ACTOR_URI_LIMIT holds it, so no stored domain is longer.
const HOST = `${'d'.repeat(1992)}.example`

let sequence = 900_000_000_000_000_000n
const nextId = () => String(sequence++)

const atLimit = (prefix: string, limit: number) => prefix.padEnd(limit, 'u')

// Every variable part an account presents at its bound (as test/account-answer-bytes.test.ts).
const MAX_BIO = sanitizeRemoteBio(`<p>${`${C}"<a>x</a>`.repeat(20_000)}</p>`)
const MAX_FIELDS = Array.from({ length: 16 }, () => ({
	type: 'PropertyValue',
	name: 'n'.repeat(255),
	value: 'v'.repeat(4096),
}))

// A remote account with every profile column at its bound; `light`: only what a mention reads is at its bound.
async function maximalAccount(t: Setup, light = false): Promise<string> {
	const id = nextId()
	const username = `${'u'.repeat(USERNAME_LIMIT - 18)}${id}`
	await sql(
		t.store,
		`INSERT INTO accounts (id, uri, username, domain, display_name, note, url, avatar_url, header_url, raw)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id,
		atLimit(`https://${HOST}/users/${id}/`, ACTOR_URI_LIMIT),
		username,
		HOST,
		light ? '' : C.repeat(2048),
		light ? '' : MAX_BIO,
		atLimit(`https://${HOST}/@${id}/`, PROFILE_URL_LIMIT),
		light ? null : atLimit(`https://${HOST}/a/${id}/`, PROFILE_URL_LIMIT),
		light ? null : atLimit(`https://${HOST}/h/${id}/`, PROFILE_URL_LIMIT),
		light ? null : JSON.stringify({ type: 'Person', attachment: MAX_FIELDS })
	)
	return id
}

type Parts = {
	content: string
	spoiler: string
	media: { url: string; preview: string | null; description: string; meta: string | null }[]
	mentions: string[]
	tags: string[]
	poll: string[] | null
	uri?: string
	url?: string
}

// A public remote status of `author` with the given parts, written as a converted row may hold them.
async function storedStatus(t: Setup, author: string, parts: Parts): Promise<string> {
	const id = nextId()
	await sql(
		t.store,
		`INSERT INTO statuses (id, uri, url, account_id, visibility, spoiler_text, content, published_at)
		VALUES (?, ?, ?, ?, 'public', ?, ?, ?)`,
		id,
		parts.uri ?? atLimit(`https://${HOST}/objects/${id}/`, 4096),
		parts.url ?? atLimit(`https://${HOST}/notes/${id}/`, 4096),
		author,
		parts.spoiler,
		parts.content,
		new Date(NOW - 60_000).toISOString()
	)
	for (const [position, m] of parts.media.entries()) {
		await sql(
			t.store,
			`INSERT INTO media_attachments (id, account_id, status_id, position, type, url, preview_url, description, meta,
				focus_x, focus_y)
			VALUES (?, ?, ?, ?, 'image', ?, ?, ?, ?, -1, -1)`,
			nextId(),
			author,
			id,
			position,
			m.url,
			m.preview,
			m.description,
			m.meta
		)
	}
	await sql(
		t.store,
		`INSERT INTO status_mentions (status_id, account_id, silent, requires_mention, author_id)
		SELECT ?, value, 0, 0, ? FROM json_each(?)`,
		id,
		author,
		JSON.stringify(parts.mentions)
	)
	await sql(
		t.store,
		'INSERT INTO status_tags (status_id, name, public) SELECT ?, value, 1 FROM json_each(?)',
		id,
		JSON.stringify(parts.tags)
	)
	if (parts.poll !== null) {
		await sql(
			t.store,
			`INSERT INTO polls (status_id, options, tallies, votes_count, voters_count, expires_at)
			VALUES (?, ?, ?, ?, ?, ?)`,
			id,
			JSON.stringify(parts.poll),
			JSON.stringify(parts.poll.map(() => Number.MAX_SAFE_INTEGER)),
			Number.MAX_SAFE_INTEGER,
			Number.MAX_SAFE_INTEGER,
			new Date(NOW + 86_400_000).toISOString()
		)
	}
	return id
}

// A meta of MEDIA_META_BYTES: the dimensions, padded with a key presentMedia does not read.
const MAX_META = (() => {
	const base = { original: { width: 100_000, height: 100_000 }, small: { width: 100_000, height: 100_000 }, x: '' }
	return JSON.stringify({ ...base, x: 'x'.repeat(1024 - JSON.stringify(base).length) })
})()

// A tag name of MAX_TAG_LENGTH code points of four bytes each: the longest URL encodeURIComponent makes of one.
const maxTag = (i: number) => `${String.fromCodePoint(0x20000 + i)}${'𠀀'.repeat(MAX_TAG_LENGTH - 1)}`

// A status with every part at its bound: content of STATUS_CONTENT_BYTES and a warning of SPOILER_BYTES as JSON
// strings, MAX_STATUS_MEDIA attachments at theirs, MAX_STATUS_MENTION_ROWS mentions of accounts at theirs,
// MAX_STATUS_TAGS tags and a poll of MAX_REMOTE_OPTIONS choices of MAX_REMOTE_OPTION_LENGTH escaping characters.
async function maximalParts(t: Setup): Promise<Parts> {
	const mentions: string[] = []
	for (let i = 0; i < MAX_STATUS_MENTION_ROWS; i++) {
		mentions.push(await maximalAccount(t, true))
	}
	return {
		content: C.repeat((STATUS_CONTENT_BYTES - 2) / 6),
		spoiler: C.repeat(Math.floor((SPOILER_BYTES - 2) / 6)),
		media: Array.from({ length: MAX_STATUS_MEDIA }, (_, i) => ({
			url: atLimit(`https://${HOST}/m/${i}/`, MEDIA_URL_LIMIT),
			preview: atLimit(`https://${HOST}/p/${i}/`, MEDIA_URL_LIMIT),
			description: C.repeat(MAX_MEDIA_DESCRIPTION_LENGTH),
			meta: MAX_META,
		})),
		mentions,
		tags: Array.from({ length: MAX_STATUS_TAGS }, (_, i) => maxTag(i)),
		poll: Array.from({ length: MAX_REMOTE_OPTIONS }, () => C.repeat(MAX_REMOTE_OPTION_LENGTH)),
	}
}

type Measure = { answer: unknown; rows: number; sqliteBytes: number; longest: number; profileBytes: number }

// Runs a read over a SqlStorage that measures what leaves SQLite: the rows, the UTF-8 bytes of their values (eight per
// number) and the longest value's bytes.
async function measured<I>(t: Setup, operation: StoreOperation<I, unknown>, input: I): Promise<Measure> {
	return runInDurableObject(t.store, (_instance, state) => {
		let rows = 0
		let sqliteBytes = 0
		let longest = 0
		let profileBytes = 0
		const counting = observedSql(state.storage.sql, (read) => {
			for (const row of read) {
				rows++
				const profile = 'note' in row && 'display_name' in row
				for (const value of Object.values(row)) {
					const bytes = typeof value === 'string' ? utf8Length(value) : 8
					sqliteBytes += bytes
					profileBytes += profile ? bytes : 0
					longest = Math.max(longest, bytes)
				}
			}
		})
		let answer = operation.run(counting, input) as Record<string, unknown>
		while (answer.status === 'ok' && 'value' in answer) {
			answer = answer.value as Record<string, unknown>
		}
		return { answer, rows, sqliteBytes, longest, profileBytes }
	})
}

const credential = async (t: Setup) => ({ tokenHash: await sha256Hex(t.tokens.alice), scope: 'read', now: NOW })

const read = async (t: Setup, operation: StoreOperation<never, unknown>, id: string) =>
	measured(t, operation, { credential: await credential(t), now: NOW, id, present: { origin: ORIGIN } } as never)

// The objects, arrays and strings a presented value holds.
function nodes(value: unknown): number {
	if (Array.isArray(value)) {
		return 1 + value.reduce((sum: number, item) => sum + nodes(item), 0)
	}
	if (typeof value === 'object' && value !== null) {
		return 1 + Object.values(value).reduce((sum: number, item) => sum + nodes(item), 0)
	}
	return typeof value === 'string' ? 1 : 0
}

const jsonBytes = (value: unknown) => utf8Length(JSON.stringify(value))

type Presented = Record<string, unknown> & {
	content: string
	spoiler_text: string
	uri: string
	url: string | null
	account: Record<string, unknown>
	media_attachments: Record<string, unknown>[]
	mentions: Record<string, unknown>[]
	tags: { name: string; url: string }[]
	poll: { options: { title: string }[] } | null
}

describe('a remote status is stored within its bounds (RES-2)', () => {
	const note = (extra: Record<string, unknown>) =>
		parseRemoteStatus({
			id: 'https://remote.example/notes/1',
			type: 'Note',
			attributedTo: 'https://remote.example/users/u',
			to: ['https://www.w3.org/ns/activitystreams#Public'],
			content: '<p>x</p>',
			...extra,
		})!

	it('sanitizes a fitting prefix of over-long content into well-formed HTML within STATUS_CONTENT_BYTES', () => {
		for (const content of [
			'<a>'.repeat(16_666),
			`<p>${'日本語の本文と<a href="https://example.com/a">リンク</a>です。'.repeat(2_000)}</p>`,
			`<p>${`${C}"<b>x</b>`.repeat(5_000)}</p>`,
		]) {
			const stored = note({ content }).content
			expect(stored).toBe(sanitizeRemoteContent(content))
			expect(jsonStringBytes(stored)).toBeLessThanOrEqual(STATUS_CONTENT_BYTES)
			expect(jsonStringBytes(stored)).toBeGreaterThan(STATUS_CONTENT_BYTES / 2)
			const errors: string[] = []
			parseFragment(stored, { onParseError: (error) => errors.push(error.code) })
			expect(errors.filter((code) => code !== 'control-character-in-input-stream')).toEqual([])
		}
	})

	it('cuts a content warning to SPOILER_BYTES at a code point, and refuses over-long media URLs', () => {
		const spoiler = note({ summary: '注意'.repeat(5_000) }).spoilerText
		expect(jsonStringBytes(spoiler)).toBeLessThanOrEqual(SPOILER_BYTES)
		expect(spoiler).toBe('注意'.repeat(5_000).slice(0, spoiler.length))
		expect(spoiler.length).toBe(Math.floor((SPOILER_BYTES - 2) / 3))
		const bisons = note({ summary: '🦬'.repeat(5_000) }).spoilerText
		expect(bisons).toBe('🦬'.repeat(Math.floor((SPOILER_BYTES - 2) / 4)))
		const long = atLimit('https://remote.example/media/', MEDIA_URL_LIMIT + 1)
		const fits = atLimit('https://remote.example/media/', MEDIA_URL_LIMIT)
		const media = note({
			attachment: [
				{ type: 'Document', mediaType: 'image/png', url: long },
				{ type: 'Document', mediaType: 'image/png', url: fits, icon: long },
			],
		}).media
		expect(media.map((m) => [m.url, m.previewUrl])).toEqual([[fits, null]])
	})
})

describe('a local status is written within its bounds (RES-2)', () => {
	it('refuses a post whose rendered mentions pass STATUS_CONTENT_BYTES, writing nothing', async () => {
		const h = await community(['alice'])
		const target = await remoteAccount(h.store, 'a')
		await sql(
			h.store,
			'UPDATE accounts SET url = ? WHERE id = ?',
			atLimit('https://remote.example/@a/', PROFILE_URL_LIMIT),
			target
		)
		const response = await h.request('/api/v1/statuses', {
			method: 'POST',
			headers: { authorization: `Bearer ${h.users.alice.token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ status: '@a@remote.example '.repeat(160) }),
		})
		expect(response.status).toBe(422)
		expect(await sql(h.store, 'SELECT id FROM statuses')).toEqual([])
		// Fewer mentions fit, and are rendered whole.
		const posted = await post(h, h.users.alice, { status: '@a@remote.example '.repeat(40) })
		expect(jsonStringBytes(posted.content!)).toBeLessThanOrEqual(STATUS_CONTENT_BYTES)
		expect(posted.mentions).toHaveLength(1)
	})
})

describe('a stored status is read within its bounds (RES-2)', () => {
	it('projects over-long stored columns within their bounds, as the bytes leaving SQLite show', async () => {
		const t = await setup()
		const author = await maximalAccount(t)
		await sql(
			t.store,
			'UPDATE accounts SET uri = ? WHERE id = ?',
			atLimit(`https://${HOST}/users/long/`, ACTOR_URI_LIMIT + 1),
			author
		)
		const mentions: string[] = []
		for (let i = 0; i < MAX_STATUS_MENTION_ROWS + 50; i++) {
			mentions.push(await maximalAccount(t, true))
		}
		// A converted username of 64 KiB and URLs past their bounds.
		await sql(
			t.store,
			'UPDATE accounts SET username = ?, url = ?, uri = ? WHERE id = ?',
			`u${'v'.repeat(64 * 1024)}`,
			atLimit('https://remote.example/@u/', PROFILE_URL_LIMIT + 1),
			atLimit('https://remote.example/users/u/', ACTOR_URI_LIMIT + 1),
			mentions[0]!
		)
		// A converted username outside Mastodon's remote format, of characters that escape to six bytes.
		await sql(t.store, 'UPDATE accounts SET username = ? WHERE id = ?', C.repeat(300), mentions[1]!)
		const id = await storedStatus(t, author, {
			content: C.repeat(Math.floor(STATUS_CONTENT_BYTES / 6) + 1),
			spoiler: C.repeat(SPOILER_BYTES),
			media: Array.from({ length: MAX_STATUS_MEDIA + 2 }, (_, i) => ({
				url: atLimit(`https://${HOST}/m/${i}/`, MEDIA_URL_LIMIT + i),
				preview: atLimit(`https://${HOST}/p/${i}/`, MEDIA_URL_LIMIT + 1),
				description: C.repeat(MAX_MEDIA_DESCRIPTION_LENGTH + 100),
				meta: `{"x":"${'x'.repeat(2000)}"}`,
			})),
			mentions,
			tags: [
				...Array.from({ length: MAX_STATUS_TAGS + 50 }, (_, i) => `t${String(i).padStart(3, '0')}`),
				'a'.repeat(300),
			],
			poll: Array.from({ length: MAX_REMOTE_OPTIONS }, () => 'x'.repeat(6_000)),
			uri: atLimit(`https://${HOST}/objects/long/`, 4097),
			url: atLimit(`https://${HOST}/notes/long/`, 4097),
		})
		const { answer, longest } = await read(t, getStatus as never, id)
		const status = answer as Presented
		expect(status.content).toBe('')
		expect(status.spoiler_text).toBe(C.repeat(Math.floor((SPOILER_BYTES - 2) / 6)))
		expect(jsonStringBytes(status.spoiler_text)).toBeLessThanOrEqual(SPOILER_BYTES)
		expect([status.uri, status.url]).toEqual(['', ''])
		expect(status.account.url).toBe(atLimit(`https://${HOST}/@${author}/`, PROFILE_URL_LIMIT))
		expect(status.media_attachments).toHaveLength(MAX_STATUS_MEDIA)
		expect(status.media_attachments.map((m) => m.url)).toEqual([
			atLimit(`https://${HOST}/m/0/`, MEDIA_URL_LIMIT),
			null,
			null,
			null,
		])
		for (const m of status.media_attachments) {
			expect(m).toMatchObject({ preview_url: m.url, meta: null })
			expect(m.description).toBe(C.repeat(MAX_MEDIA_DESCRIPTION_LENGTH))
		}
		expect(status.mentions).toHaveLength(MAX_STATUS_MENTION_ROWS)
		const cut = status.mentions.find((m) => m.id === mentions[0])!
		expect(cut).toEqual({
			id: mentions[0],
			username: `u${'v'.repeat(USERNAME_LIMIT - 1)}`,
			acct: `u${'v'.repeat(USERNAME_LIMIT - 1)}@${HOST}`,
			url: `${ORIGIN}/@u${'v'.repeat(USERNAME_LIMIT - 1)}@${HOST}`,
		})
		const odd = status.mentions.find((m) => m.id === mentions[1])!
		expect(odd.username).toBe(C.repeat(Math.floor(USERNAME_LIMIT / 6)))
		expect(jsonStringBytes(odd.username as string)).toBeLessThanOrEqual(USERNAME_LIMIT + 2)
		expect(status.tags.map((tag) => tag.name)).toEqual(
			Array.from({ length: MAX_STATUS_TAGS }, (_, i) => `t${String(i).padStart(3, '0')}`)
		)
		expect(status.poll!.options.map((o) => o.title)).toEqual(
			Array.from({ length: MAX_REMOTE_OPTIONS }, () => 'x'.repeat(MAX_REMOTE_OPTION_LENGTH))
		)
		// The longest value that left SQLite is the poll's choices as a JSON array, within their bound: the 64 KiB
		// username, the over-long content and the 600 KB of stored choices stayed.
		expect(longest).toBeLessThanOrEqual(MAX_REMOTE_OPTIONS * (6 * MAX_REMOTE_OPTION_LENGTH + 3) + 1)
		expect(longest).toBeLessThan(STATUS_CONTENT_BYTES)
	})

	it('projects edit history snapshots and the source within their bounds', async () => {
		const t = await setup()
		const author = await maximalAccount(t)
		const id = await storedStatus(t, author, {
			content: '<p>now</p>',
			spoiler: '',
			media: [],
			mentions: [],
			tags: [],
			poll: null,
		})
		const snapshot = (i: number) => ({ id: `m${i}`, type: 'image', description: C.repeat(10_000) })
		await sql(
			t.store,
			`INSERT INTO status_edits (status_id, content, spoiler_text, media_json, poll_options, created_at) VALUES
				(?1, ?2, ?3, ?4, ?5, ?6), (?1, '<p>b</p>', '', ?7, ?8, ?6)`,
			id,
			C.repeat(STATUS_CONTENT_BYTES),
			'注'.repeat(SPOILER_BYTES),
			JSON.stringify(Array.from({ length: 10 }, (_, i) => snapshot(i))),
			JSON.stringify(Array.from({ length: 150 }, (_, i) => `${i}${'o'.repeat(2_000)}`)),
			new Date(NOW).toISOString(),
			JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ id: `m${i}` }))),
			JSON.stringify(['a', 'b'])
		)
		const { answer, longest } = await read(t, statusHistory as never, id)
		const [first, second] = answer as {
			content: string
			spoiler_text: string
			media_attachments: unknown[]
			poll: { options: { title: string }[] } | null
		}[]
		expect(first!.content).toBe('')
		expect(first!.spoiler_text).toBe('注'.repeat(Math.floor((SPOILER_BYTES - 2) / 6)))
		expect(first!.media_attachments).toEqual([])
		expect(first!.poll!.options).toHaveLength(MAX_REMOTE_OPTIONS)
		expect(first!.poll!.options[7]!.title).toBe(`7${'o'.repeat(MAX_REMOTE_OPTION_LENGTH - 1)}`)
		expect(second!.media_attachments).toEqual(Array.from({ length: MAX_STATUS_MEDIA }, (_, i) => ({ id: `m${i}` })))
		expect(second!.poll!.options.map((o) => o.title)).toEqual(['a', 'b'])
		expect(longest).toBeLessThanOrEqual(STATUS_CONTENT_BYTES)
		// The source a local author reads back for editing.
		await sql(
			t.store,
			'UPDATE statuses SET source_text = ?, content = ? WHERE id = ?',
			C.repeat(STATUS_CONTENT_BYTES),
			C.repeat(STATUS_CONTENT_BYTES),
			id
		)
		await sql(t.store, 'UPDATE statuses SET account_id = ? WHERE id = ?', ALICE, id)
		const source = await read(t, statusSource as never, id)
		expect(source.answer).toEqual({ id, text: '', spoiler_text: '' })
		expect(source.longest).toBeLessThanOrEqual(STATUS_CONTENT_BYTES)
	})
})

// Realistic posts of each implementation at its own length limit, in Japanese with its own markup.
const misskey = () => {
	const mention = '<a href="https://misskey.example/@bob" class="u-url mention">@bob@misskey.example</a>'
	const tag = '<a href="https://misskey.example/tags/日本語" rel="tag">#日本語</a>'
	const link = '<a href="https://example.com/path/to/page">https://example.com/path/to/page</a>'
	return `<p><span>${Array.from({ length: 30 }, () => `${'本文の文章です。'.repeat(11)} ${mention} ${tag} ${link}<br>`).join('')}</span></p>`
}
const pleroma = () => {
	const mention =
		'<span class="h-card"><a class="u-url mention" data-user="AbCdEf123" href="https://pleroma.example/users/bob" ' +
		'rel="ugc">@<span>bob</span></a></span>'
	const tag = '<a class="hashtag" data-tag="日本語" href="https://pleroma.example/tag/日本語" rel="tag ugc">#日本語</a>'
	const link = '<a href="https://example.com/path/to/page" rel="ugc">https://example.com/path/to/page</a>'
	return Array.from({ length: 50 }, () => `${'本文の文章です。'.repeat(11)} ${mention} ${tag} ${link}<br/>`).join('')
}
const gotosocial = () => {
	const mention =
		'<span class="h-card"><a href="https://gts.example/@bob" class="mention" rel="nofollow noreferrer noopener" ' +
		'target="_blank">@<span>bob</span></a></span>'
	const tag =
		'<a href="https://gts.example/tags/日本語" class="mention hashtag" rel="tag nofollow noreferrer noopener" ' +
		'target="_blank">#<span>日本語</span></a>'
	return Array.from({ length: 50 }, () => `<p>${'本文の文章です。'.repeat(11)} ${mention} ${tag}</p>`).join('')
}
const mastodon = () =>
	'<p><span class="h-card" translate="no"><a href="https://mastodon.example/@bob" class="u-url mention">@<span>bob</span>' +
	`</a></span> ${'本文の文章です。'.repeat(55)}</p><p><a href="https://mastodon.example/tags/日本語" ` +
	'class="mention hashtag" rel="tag">#<span>日本語</span></a></p>'

describe('realistic content is never cut (RES-2)', () => {
	it.each([
		['Misskey (3,000 characters)', misskey],
		['Pleroma and Akkoma (5,000)', pleroma],
		['GoToSocial (5,000)', gotosocial],
		['Mastodon (500)', mastodon],
	])('keeps %s whole, as stored and as read', async (_name, html) => {
		const stored = sanitizeRemoteContent(html())
		expect(stored).toBe(sanitizeRemoteHtml(html()))
		expect(jsonStringBytes(stored)).toBeLessThan(STATUS_CONTENT_BYTES / 2)
		const spoiler = 'ネタバレ注意。'.repeat(70)
		expect(
			parseRemoteStatus({
				id: 'https://remote.example/notes/1',
				type: 'Note',
				to: ['https://www.w3.org/ns/activitystreams#Public'],
				content: html(),
				summary: spoiler,
			})
		).toMatchObject({ content: stored, spoilerText: spoiler })
		const t = await setup()
		const author = await maximalAccount(t, true)
		const id = await storedStatus(t, author, {
			content: stored,
			spoiler,
			media: [],
			mentions: [],
			tags: [],
			poll: null,
		})
		const { answer } = await read(t, getStatus as never, id)
		expect(answer).toMatchObject({ content: stored, spoiler_text: spoiler })
	})
})

describe('the table of maxima (RES-3)', () => {
	it('measures a status, a quote, a boost of a quote and an account at every bound', async () => {
		const t = await setup()
		const [booster, quoter, quotedAuthor] = [await maximalAccount(t), await maximalAccount(t), await maximalAccount(t)]
		const quoted = await storedStatus(t, quotedAuthor, await maximalParts(t))
		const quote = await storedStatus(t, quoter, await maximalParts(t))
		await sql(
			t.store,
			`INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, updated_at)
			SELECT ?1, uri, id, account_id, 'accepted', ?3 FROM statuses WHERE id = ?2`,
			quote,
			quoted,
			new Date(NOW).toISOString()
		)
		const boost = nextId()
		await sql(
			t.store,
			`INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at)
			VALUES (?, ?, ?, ?, 'public', ?)`,
			boost,
			atLimit(`https://${HOST}/announces/${boost}/`, 4096),
			booster,
			quote,
			new Date(NOW).toISOString()
		)
		const one = await read(t, getStatus as never, quoted)
		const pair = await read(t, getStatus as never, boost)
		const shape = (m: Measure) => ({
			sqlite: m.sqliteBytes,
			json: jsonBytes(m.answer),
			rows: m.rows,
			nodes: nodes(m.answer),
		})
		const status = shape(one)
		const boosted = shape(pair)
		const account = (one.answer as Presented).account
		// The status read is complete: every part at its bound is shown.
		const shown = one.answer as Presented
		expect(shown.content.length).toBe((STATUS_CONTENT_BYTES - 2) / 6)
		expect(shown.media_attachments).toHaveLength(MAX_STATUS_MEDIA)
		expect(shown.mentions).toHaveLength(MAX_STATUS_MENTION_ROWS)
		expect(shown.tags).toHaveLength(MAX_STATUS_TAGS)
		expect(shown.poll!.options).toHaveLength(MAX_REMOTE_OPTIONS)
		expect((pair.answer as { reblog: { quote: { quoted_status: unknown } } }).reblog.quote.quoted_status).not.toBeNull()
		const quoting = shape(await read(t, getStatus as never, quote))
		// docs/threat-model.md "Maxima of presented units" states these; the composite shapes are derived from them.
		expect({ status, quoting, boosted, account: { sqlite: one.profileBytes, json: jsonBytes(account) } }).toEqual({
			status: { sqlite: 2_179_603, json: 2_478_427, rows: 311, nodes: 1_607 },
			quoting: { sqlite: 4_359_149, json: 4_956_887, rows: 620, nodes: 3_216 },
			boosted: { sqlite: 4_465_596, json: 5_087_375, rows: 623, nodes: 3_269 },
			account: { sqlite: 97_844, json: 121_710 },
		})
	})
})
