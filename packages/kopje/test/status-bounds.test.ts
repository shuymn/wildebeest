import { runInDurableObject } from 'cloudflare:test'

import { parseFragment } from 'parse5'
import { describe, expect, it } from 'vitest'

import { setSetting, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { BUILD } from './helpers'
import { ALICE, setup, type Setup } from './inbox-status-helpers'
import { MAX_BIO, maxFields } from './profile-fixtures'
import { observedSql, rowsRead } from './read-helpers'
import { community, post, remoteAccount } from './status-helpers'
import { Db, rowHeapBytes } from '../src/db/sql'
import { createActivity, getFeatured, noteOf, OUTBOX_BYTES, PIN_LIMIT, statusFacts } from '../src/domain/activities'
import { ANSWER_BYTES } from '../src/domain/answer-budget'
import { type VisibleStatusId } from '../src/domain/audience'
import { listConversations, MAX_PRESENTED_PARTICIPANTS } from '../src/domain/conversations'
import { MAX_FILTER_KEYWORD, MAX_FILTER_KEYWORDS, MAX_FILTER_TITLE, MAX_FILTERS } from '../src/domain/filters'
import { listGroupedNotifications } from '../src/domain/notification-groups'
import { ACTOR_URI_LIMIT, PROFILE_URL_LIMIT, USERNAME_LIMIT } from '../src/domain/profile-bounds'
import { getAdminReport } from '../src/domain/reports'
import {
	MAX_MEDIA_DESCRIPTION_LENGTH,
	MAX_REMOTE_OPTION_LENGTH,
	MAX_REMOTE_OPTIONS,
	MAX_STATUS_MEDIA,
	MAX_STATUS_MENTION_ROWS,
	MAX_PRESENTED_TAGS,
	MAX_STATUS_TAGS,
	MAX_TAG_LENGTH,
	MEDIA_URL_LIMIT,
} from '../src/domain/status-bounds'
import { presentation, presentStatusesWithin } from '../src/domain/status-presenter'
import { statusRowBoundSql } from '../src/domain/status-rows'
import { getStatus, getStatuses, statusHistory, statusSource } from '../src/domain/statuses'
import { parseRemoteStatus } from '../src/federation/remote-status'
import { utf8Length } from '../src/platform/dump-format'
import { MAX_LOCAL_ADDRESSED } from '../src/platform/identity-bounds'
import type { StoreOperation } from '../src/platform/store-kernel'
import {
	jsonStringBytes,
	REMOTE_BIO_BYTES,
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

// How a fixture fills text at its bound: `escaped` with characters JSON escapes to six bytes (the most JSON for the
// fewest bytes read); `derived`, the same with mentioned accounts that have no stored url, so their url is derived
// from the host and the username; `raw` with what reads the most bytes from SQLite for each bound: ASCII where the
// bound is in bytes, and four-byte characters (W) where it is in characters.
type Fill = 'escaped' | 'derived' | 'raw'
const W = '𠀀'
const RAW_BIO = `<p>${'x'.repeat(REMOTE_BIO_BYTES - 9)}</p>`

// A remote account with every profile column at its bound; `light`: only what a mention reads is at its bound.
async function maximalAccount(t: Setup, light = false, fill: Fill = 'escaped'): Promise<string> {
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
		light ? '' : (fill === 'raw' ? W : C).repeat(2048),
		light ? '' : fill === 'raw' ? RAW_BIO : MAX_BIO,
		light && fill === 'derived' ? null : atLimit(`https://${HOST}/@${id}/`, PROFILE_URL_LIMIT),
		light ? null : atLimit(`https://${HOST}/a/${id}/`, PROFILE_URL_LIMIT),
		light ? null : atLimit(`https://${HOST}/h/${id}/`, PROFILE_URL_LIMIT),
		light ? null : JSON.stringify({ type: 'Person', attachment: maxFields() })
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
async function maximalParts(t: Setup, fill: Fill = 'escaped'): Promise<Parts> {
	const mentions: string[] = []
	for (let i = 0; i < MAX_STATUS_MENTION_ROWS; i++) {
		mentions.push(await maximalAccount(t, true, fill))
	}
	const counted = fill === 'raw' ? W : C
	return {
		content: fill === 'raw' ? 'x'.repeat(STATUS_CONTENT_BYTES - 2) : C.repeat((STATUS_CONTENT_BYTES - 2) / 6),
		spoiler: fill === 'raw' ? 'x'.repeat(SPOILER_BYTES - 2) : C.repeat(Math.floor((SPOILER_BYTES - 2) / 6)),
		media: Array.from({ length: MAX_STATUS_MEDIA }, (_, i) => ({
			url: atLimit(`https://${HOST}/m/${i}/`, MEDIA_URL_LIMIT),
			preview: atLimit(`https://${HOST}/p/${i}/`, MEDIA_URL_LIMIT),
			description: counted.repeat(MAX_MEDIA_DESCRIPTION_LENGTH),
			meta: MAX_META,
		})),
		mentions,
		tags: Array.from({ length: MAX_STATUS_TAGS }, (_, i) => maxTag(i)),
		poll: Array.from({ length: MAX_REMOTE_OPTIONS }, () => counted.repeat(MAX_REMOTE_OPTION_LENGTH)),
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

	it('refuses a status id over its bound in UTF-8 bytes, and ignores such a url', () => {
		const long = `https://remote.example/notes/${'é'.repeat(2_100)}`
		expect(note({ id: long })).toBeNull()
		expect(note({ url: long }).url).toBeNull()
		expect(note({ url: 'https://remote.example/@u/1' }).url).toBe('https://remote.example/@u/1')
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
		await sql(t.store, 'UPDATE accounts SET username = ? WHERE id = ?', `u\u0000${C.repeat(253)}`, mentions[2]!)
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
		const { answer, longest } = await read(t, getStatus, id)
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
		expect(status.mentions.map((m) => m.id)).toEqual(mentions.toSorted().slice(0, MAX_STATUS_MENTION_ROWS))
		const cut = status.mentions.find((m) => m.id === mentions[0])!
		expect(cut).toEqual({
			id: mentions[0],
			username: `u${'v'.repeat(USERNAME_LIMIT - 1)}`,
			acct: `u${'v'.repeat(USERNAME_LIMIT - 1)}@${HOST}`,
			// Its url derived from the host and the username would pass PROFILE_URL_LIMIT: none fits, so ''.
			url: '',
		})
		// A NUL hides what follows it from GLOB; the username is still read within its JSON bound.
		const nul = status.mentions.find((m) => m.id === mentions[2])!
		expect(jsonStringBytes(nul.username as string)).toBeLessThanOrEqual(USERNAME_LIMIT + 2)
		expect(jsonStringBytes(nul.acct as string)).toBeLessThanOrEqual(USERNAME_LIMIT + 2 + HOST.length + 1)
		const odd = status.mentions.find((m) => m.id === mentions[1])!
		expect(odd.username).toBe(C.repeat(Math.floor(USERNAME_LIMIT / 6)))
		expect(jsonStringBytes(odd.username as string)).toBeLessThanOrEqual(USERNAME_LIMIT + 2)
		// The over-long name sorts first: it takes one of the MAX_PRESENTED_TAGS rows read and is left out.
		expect(status.tags.map((tag) => tag.name)).toEqual(
			Array.from({ length: MAX_PRESENTED_TAGS - 1 }, (_, i) => `t${String(i).padStart(3, '0')}`)
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
			// A small snapshot whose single fields are past their bounds: a long URL, description and meta.
			JSON.stringify([
				'not an attachment',
				...Array.from({ length: 6 }, (_, i) => ({
					id: `m${i}`,
					type: 'image',
					url: atLimit(`https://${HOST}/m/${i}/`, MEDIA_URL_LIMIT + i),
					preview_url: atLimit(`https://${HOST}/p/${i}/`, MEDIA_URL_LIMIT),
					description: 'd'.repeat(2 * MAX_MEDIA_DESCRIPTION_LENGTH),
					meta: i === 0 ? { original: { width: 1, height: 1 } } : { x: 'x'.repeat(2_000) },
					extra: 'x'.repeat(1_000),
				})),
			]),
			JSON.stringify(['a', 'b'])
		)
		const { answer, longest } = await read(t, statusHistory, id)
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
		// The first MAX_STATUS_MEDIA entries (the string among them left out), each rebuilt within the column bounds.
		expect(second!.media_attachments).toEqual(
			Array.from({ length: MAX_STATUS_MEDIA - 1 }, (_, i) => ({
				id: `m${i}`,
				type: 'image',
				url: i === 0 ? atLimit(`https://${HOST}/m/0/`, MEDIA_URL_LIMIT) : null,
				preview_url: atLimit(`https://${HOST}/p/${i}/`, MEDIA_URL_LIMIT),
				remote_url: null,
				preview_remote_url: null,
				text_url: null,
				meta: i === 0 ? { original: { width: 1, height: 1 } } : null,
				description: 'd'.repeat(MAX_MEDIA_DESCRIPTION_LENGTH),
				blurhash: null,
			}))
		)
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
		const source = await read(t, statusSource, id)
		expect(source.answer).toEqual({ id, text: '', spoiler_text: '' })
		expect(source.longest).toBeLessThanOrEqual(STATUS_CONTENT_BYTES)
	})
})

describe('each per-status cap reads a bounded number of rows (RES-7)', () => {
	it('reads at most its cap of rows whatever a converted status holds, each status once', async () => {
		const t = await setup()
		const author = await maximalAccount(t, true)
		const id = await storedStatus(t, author, {
			content: '<p>x</p>',
			spoiler: '',
			media: [],
			mentions: [],
			tags: [],
			poll: null,
		})
		const many = 10_000
		// Rejected rows that sort before the presented ones: over-long tag names, hidden media and silent mentions.
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?2 - 1)
			INSERT INTO status_tags (status_id, name, public) SELECT ?1, 'a' || printf('%05d', i) || ?3, 1 FROM n`,
			id,
			many,
			'x'.repeat(MAX_TAG_LENGTH)
		)
		await sql(t.store, "INSERT INTO status_tags (status_id, name, public) VALUES (?1, 'shown', 1)", id)
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?3 - 1)
			INSERT INTO media_attachments (id, account_id, status_id, position, type, url, shown)
			SELECT CAST(800000000000000000 + i AS TEXT), ?2, ?1, i, 'image', 'https://m.example/' || i, 0 FROM n`,
			id,
			author,
			many
		)
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT CAST(700000000000000000 + i AS TEXT), 'https://m.example/users/s' || i, 's' || i, 'm.example' FROM n`,
			many
		)
		await sql(
			t.store,
			`INSERT INTO status_mentions (status_id, account_id, silent, requires_mention, author_id)
			SELECT ?1, id, 1, 0, ?2 FROM accounts WHERE id BETWEEN '700000000000000000' AND '700000000000009999'`,
			id,
			author
		)
		const credentialOf = await credential(t)
		const rows = (ids: string[]) =>
			rowsRead(t, getStatuses as never, { credential: credentialOf, now: NOW, ids, present: { origin: ORIGIN } })
		const once = await rows([id])
		// The status, its account, at most MAX_STATUS_MENTION_ROWS mentions, MAX_PRESENTED_TAGS tags and MAX_STATUS_MEDIA
		// media, and a constant number of other rows; never the 30,000 rejected ones.
		expect(once).toBeLessThan(MAX_STATUS_MENTION_ROWS + MAX_PRESENTED_TAGS + MAX_STATUS_MEDIA + 200)
		// Repeating the id adds only the rows of reading the repeated ids, not another status's worth.
		expect(await rows([id, id, id, id])).toBeLessThanOrEqual(once + 8)
		const { answer } = await read(t, getStatus, id)
		expect(answer).toMatchObject({ media_attachments: [], mentions: [], tags: [] })
	})
})

describe('a conversation presents its first participants (RES-3)', () => {
	it('reads only the participants it presents out of SQLite, whatever the row stores', async () => {
		const t = await setup()
		const author = await maximalAccount(t, true)
		const id = await storedStatus(t, author, {
			content: '<p>x</p>',
			spoiler: '',
			media: [],
			mentions: [],
			tags: [],
			poll: null,
		})
		const stored = Array.from({ length: 5_000 }, (_, i) => String(600_000_000_000_000_000n + BigInt(i)))
		await sql(
			t.store,
			"INSERT INTO conversations (account_id, thread, participants, last_status_id) VALUES (?, 'th', ?, ?)",
			ALICE,
			JSON.stringify(stored),
			id
		)
		const listed = await measured(
			t,
			listConversations as never,
			{
				credential: await credential(t),
				page: { limit: 1 },
				present: { origin: ORIGIN },
			} as never
		)
		// The stored list is 105,000 bytes; what leaves SQLite is the last status with its author and URLs (about 15 KB)
		// and 12 ids of the list.
		expect(listed.sqliteBytes).toBeLessThan(30_000)
	})
})

describe('an ordinary status keeps its mentions and hashtags (RES-2)', () => {
	it('shows a current mention after more silent rows than the cap, as an edited status keeps them', async () => {
		const h = await community(['alice'])
		const bob = await remoteAccount(h.store, 'bob')
		const posted = await post(h, h.users.alice, { status: '@bob@remote.example hello' })
		// Recipients an edit removed stay as silent rows, without a cap, and may sort before the current one.
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT CAST(100000000000000000 + i AS TEXT), 'https://old.example/users/o' || i, 'o' || i, 'old.example' FROM n`,
			MAX_STATUS_MENTION_ROWS + 50
		)
		await sql(
			h.store,
			`INSERT INTO status_mentions (status_id, account_id, silent, requires_mention, author_id)
			SELECT ?1, id, 1, 0, ?2 FROM accounts WHERE domain = 'old.example'`,
			posted.id,
			h.users.alice.id
		)
		const response = await h.request(`/api/v1/statuses/${posted.id}`, {
			headers: { authorization: `Bearer ${h.users.alice.token}` },
		})
		const shown = (await response.json()) as { mentions: { id: string }[] }
		// The silent rows sort before the current mention.
		expect(bob > String(100_000_000_000_000_000n + BigInt(MAX_STATUS_MENTION_ROWS + 50))).toBe(true)
		expect(shown.mentions.map((m) => m.id)).toEqual([bob])
	})

	it('records a local hashtag past its bound, and leaves it out of the 70 presented when it sorts first', async () => {
		const h = await community(['alice'])
		const long = 'a'.repeat(MAX_TAG_LENGTH + 1)
		const cjk = Array.from({ length: MAX_PRESENTED_TAGS }, (_, i) => `#${String.fromCodePoint(0x4e00 + i)}`)
		const posted = await post(h, h.users.alice, { status: `#${long} ${cjk.join(' ')}` })
		// Stored and associated, as Mastodon records it.
		expect(
			await sql(h.store, 'SELECT name FROM status_tags WHERE status_id = ? AND name = ?', posted.id, long)
		).toEqual([{ name: long }])
		// It sorts before the others, takes one of the MAX_PRESENTED_TAGS rows read, and is left out: 69 are presented.
		expect(posted.tags.map((tag) => `#${tag.name}`).toSorted()).toEqual(cjk.toSorted().slice(0, MAX_PRESENTED_TAGS - 1))
	})

	it("keeps a local post with a hashtag past its bound on that hashtag's timeline, after an edit too", async () => {
		const h = await community(['alice'])
		const long = 'a'.repeat(MAX_TAG_LENGTH + 1)
		const posted = await post(h, h.users.alice, { status: `hello #${long}` })
		const timeline = async () => {
			const response = await h.request(`/api/v1/timelines/tag/${long}`, {
				headers: { authorization: `Bearer ${h.users.alice.token}` },
			})
			return ((await response.json()) as { id: string }[]).map((status) => status.id)
		}
		expect(await timeline()).toEqual([posted.id])
		const edited = await h.request(`/api/v1/statuses/${posted.id}`, {
			method: 'PUT',
			headers: { authorization: `Bearer ${h.users.alice.token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ status: `edited #${long}` }),
		})
		expect(edited.status).toBe(200)
		expect(await timeline()).toEqual([posted.id])
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
		const { answer } = await read(t, getStatus, id)
		expect(answer).toMatchObject({ content: stored, spoiler_text: spoiler })
	})
})

// The viewer's own filters at their bounds (filters.ts): MAX_FILTERS of them in every context, each with a title of
// MAX_FILTER_TITLE characters and a keyword of MAX_FILTER_KEYWORD that the statuses' text holds, and each naming the
// given statuses, so every presented status carries every filter with a keyword match and its status matches.
async function maximalFilters(t: Setup, fill: Fill, statuses: readonly string[]): Promise<void> {
	// The first keyword is what the statuses hold, so it matches; the rest fill the filter's keywords.
	const matching = (fill === 'raw' ? 'x' : C).repeat(MAX_FILTER_KEYWORD)
	const other = (k: number) =>
		fill === 'raw' ? `${String.fromCodePoint(0x20000 + k)}${W.repeat(MAX_FILTER_KEYWORD - 1)}` : matching
	for (let i = 0; i < MAX_FILTERS; i++) {
		const filter = nextId()
		await sql(
			t.store,
			`INSERT INTO filters (id, account_id, title, context, action) VALUES (?, ?, ?, ?, 'warn')`,
			filter,
			ALICE,
			(fill === 'raw' ? W : C).repeat(MAX_FILTER_TITLE),
			JSON.stringify(['home', 'notifications', 'public', 'thread', 'account'])
		)
		for (let k = 0; k < MAX_FILTER_KEYWORDS; k++) {
			await sql(
				t.store,
				'INSERT INTO filter_keywords (id, filter_id, keyword, whole_word) VALUES (?, ?, ?, 0)',
				nextId(),
				filter,
				k === 0 ? matching : other(k)
			)
		}
		for (const status of statuses) {
			await sql(
				t.store,
				'INSERT INTO filter_statuses (id, filter_id, status_id) VALUES (?, ?, ?)',
				nextId(),
				filter,
				status
			)
		}
	}
}

type Shape = { sqlite: number; json: number; rows: number; nodes: number }

// A quote of a status and a boost of the quote, each part of every status at its bound and each account at its
// bounds, filled as `fill`, with alice's filters at their bounds naming all three.
async function maximalStatuses(fill: Fill) {
	const t = await setup()
	const [booster, quoter, quotedAuthor] = [
		await maximalAccount(t, false, fill),
		await maximalAccount(t, false, fill),
		await maximalAccount(t, false, fill),
	]
	const quoted = await storedStatus(t, quotedAuthor, await maximalParts(t, fill))
	const quote = await storedStatus(t, quoter, await maximalParts(t, fill))
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
	await maximalFilters(t, fill, [quoted, quote, boost])
	return { t, quoted, quote, boost }
}

async function measureShapes(fill: Fill): Promise<Record<string, Shape>> {
	const { t, quoted, quote, boost } = await maximalStatuses(fill)
	const shape = (m: Measure): Shape => ({
		sqlite: m.sqliteBytes,
		json: jsonBytes(m.answer),
		rows: m.rows,
		nodes: nodes(m.answer),
	})
	const one = await read(t, getStatus, quoted)
	const pair = await read(t, getStatus, boost)
	// Every part at its bound is shown, and every filter with its match.
	const shown = one.answer as Presented & { filtered: { keyword_matches: string[]; status_matches: string[] }[] }
	expect(shown.media_attachments).toHaveLength(MAX_STATUS_MEDIA)
	expect(shown.mentions).toHaveLength(MAX_STATUS_MENTION_ROWS)
	expect(shown.tags).toHaveLength(MAX_PRESENTED_TAGS)
	expect(shown.poll!.options).toHaveLength(MAX_REMOTE_OPTIONS)
	expect(shown.filtered).toHaveLength(MAX_FILTERS)
	expect(shown.filtered[0]!.keyword_matches).toHaveLength(1)
	expect(shown.filtered[0]!.status_matches).toEqual([quoted])
	expect((pair.answer as { reblog: { quote: { quoted_status: unknown } } }).reblog.quote.quoted_status).not.toBeNull()
	// A conversation of alice's with more participants than presented, each at its bounds, whose last status is the
	// quote, read end to end.
	const participants: string[] = []
	for (let i = 0; i < MAX_PRESENTED_PARTICIPANTS + 8; i++) {
		participants.push(await maximalAccount(t, false, fill))
	}
	await sql(
		t.store,
		"INSERT INTO conversations (account_id, thread, participants, last_status_id) VALUES (?, 'th', ?, ?)",
		ALICE,
		JSON.stringify(participants.toSorted()),
		quote
	)
	const listed = await measured(
		t,
		listConversations as never,
		{
			credential: await credential(t),
			page: { limit: 1 },
			present: { origin: ORIGIN },
		} as never
	)
	const [talk] = (listed.answer as { items: { accounts: { id: string }[]; last_status: unknown }[] }).items
	expect(talk!.accounts.map((a) => a.id)).toEqual(participants.toSorted().slice(0, MAX_PRESENTED_PARTICIPANTS))
	expect(talk!.last_status).not.toBeNull()
	// A favourite group of alice's with its 8 sample accounts at their bounds, its status the quote, read as a page of
	// one group.
	for (let i = 0; i < 8; i++) {
		await sql(
			t.store,
			`INSERT INTO notifications (account_id, type, from_account_id, status_id, created_at, group_key)
			VALUES (?, 'favourite', ?, ?, ?, 'favourite-maximal-1')`,
			ALICE,
			await maximalAccount(t, false, fill),
			quote,
			new Date(NOW).toISOString()
		)
	}
	const grouped = await measured(
		t,
		listGroupedNotifications as never,
		{
			credential: await credential(t),
			page: { limit: 1 },
			types: [],
			excludeTypes: [],
			groupedTypes: null,
			includeFiltered: false,
			expandAccounts: 'full',
			present: { origin: ORIGIN },
		} as never
	)
	const { next: _next, prev: _prev, ...group } = grouped.answer as Record<string, unknown> & { accounts: unknown[] }
	expect(group.accounts).toHaveLength(8)
	// A report of the quoter by alice naming the quote (its first status, past REPORT_STATUS_BYTES alone), assigned to
	// and resolved by alice (local accounts only), read by alice as the OAuth admin.
	await sql(t.store, "UPDATE local_accounts SET email = 'alice@kopje.test' WHERE account_id = ?", ALICE)
	await setSetting(t.store, 'admin_email', 'alice@kopje.test')
	const adminToken = 'admin-token'
	await sql(
		t.store,
		"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'test', ?, 'admin:read')",
		await sha256Hex(adminToken),
		ALICE
	)
	const [report] = await sql<{ id: string }>(
		t.store,
		`INSERT INTO reports (account_id, target_account_id, status_ids, uri, created_at, assigned_account_id,
			action_taken_by_account_id)
		VALUES (?, ?, ?, 'https://kopje.test/actor#reports/maximal', ?, ?, ?) RETURNING CAST(id AS TEXT) AS id`,
		ALICE,
		(await sql<{ account_id: string }>(t.store, 'SELECT account_id FROM statuses WHERE id = ?', quote))[0]!.account_id,
		JSON.stringify([quote, quoted]),
		new Date(NOW).toISOString(),
		ALICE,
		ALICE
	)
	const reported = await measured(
		t,
		getAdminReport as never,
		{
			credential: { tokenHash: await sha256Hex(adminToken), scope: 'admin:read', now: NOW },
			id: report!.id,
			present: { origin: ORIGIN },
		} as never
	)
	const shownReport = (reported.answer as { report: { statuses: { id: string }[] } }).report
	expect(shownReport.statuses.map((status) => status.id)).toEqual([quote])
	const account = (one.answer as Presented).account
	return {
		account: { sqlite: one.profileBytes, json: jsonBytes(account), rows: 1, nodes: nodes(account) },
		status: shape(one),
		quote: shape(await read(t, getStatus, quote)),
		boostOfQuote: shape(pair),
		conversation: { ...shape({ ...listed, answer: talk }), sqlite: listed.sqliteBytes },
		group: shape({ ...grouped, answer: group }),
		report: shape({ ...reported, answer: shownReport }),
	}
}

describe('the table of maxima (RES-3)', () => {
	// docs/threat-model.md "Maxima of presented units" states these. An answer admits a whole item, so every atomic
	// shape stays within 80% of ANSWER_BYTES (8 MiB) with filters included.
	const LIMIT = 0.8 * 8 * 1024 * 1024

	it.each<[string, Fill, Record<string, Shape>]>([
		[
			'the escaped worst case: the most JSON',
			'escaped',
			{
				account: { sqlite: 97_844, json: 121_710, rows: 1, nodes: 36 },
				status: { sqlite: 2_723_475, json: 2_595_446, rows: 1_381, nodes: 2_267 },
				quote: { sqlite: 4_873_593, json: 5_190_925, rows: 1_710, nodes: 4_536 },
				boostOfQuote: { sqlite: 4_981_840, json: 5_564_762, rows: 1_763, nodes: 5_439 },
				conversation: { sqlite: 6_048_177, json: 6_651_414, rows: 1_724, nodes: 4_959 },
				group: { sqlite: 5_657_299, json: 6_165_029, rows: 1_737, nodes: 4_836 },
				report: { sqlite: 4_978_089, json: 5_318_285, rows: 1_719, nodes: 4_661 },
			},
		],
		[
			'mentions whose url is derived',
			'derived',
			{
				account: { sqlite: 97_844, json: 121_710, rows: 1, nodes: 36 },
				status: { sqlite: 2_315_475, json: 2_185_846, rows: 1_381, nodes: 2_267 },
				quote: { sqlite: 4_057_593, json: 4_371_725, rows: 1_710, nodes: 4_536 },
				boostOfQuote: { sqlite: 4_165_840, json: 4_745_562, rows: 1_763, nodes: 5_439 },
				conversation: { sqlite: 5_232_177, json: 5_832_214, rows: 1_724, nodes: 4_959 },
				group: { sqlite: 4_841_299, json: 5_345_829, rows: 1_737, nodes: 4_836 },
				report: { sqlite: 4_162_089, json: 4_499_085, rows: 1_719, nodes: 4_661 },
			},
		],
		[
			'the raw worst case: the most bytes read from SQLite',
			'raw',
			{
				account: { sqlite: 114_914, json: 117_615, rows: 1, nodes: 36 },
				status: { sqlite: 4_281_022, json: 2_157_753, rows: 1_381, nodes: 2_267 },
				quote: { sqlite: 6_491_087, json: 4_315_539, rows: 1_710, nodes: 4_536 },
				boostOfQuote: { sqlite: 6_616_404, json: 4_531_681, rows: 1_763, nodes: 5_439 },
				conversation: { sqlite: 7_870_511, json: 5_726_888, rows: 1_724, nodes: 4_959 },
				group: { sqlite: 7_411_353, json: 5_256_883, rows: 1_737, nodes: 4_836 },
				report: { sqlite: 6_612_653, json: 4_438_804, rows: 1_719, nodes: 4_661 },
			},
		],
	])('measures %s', async (_name, fill, expected) => {
		const shapes = await measureShapes(fill)
		expect(shapes).toEqual(expected)
		for (const shape of Object.values(shapes)) {
			expect(shape.json).toBeLessThanOrEqual(LIMIT)
		}
	})

	// R (status-rows.ts), which statusStream plans its chunks by, is at least the heap RowMeter counts of the rows each
	// shape reads, with every part at its bound: the viewer's filters naming each status, her votes in every choice,
	// and every flag of hers.
	it('bounds the rows each shape reads by R', async () => {
		const { t, quoted, quote, boost } = await maximalStatuses('raw')
		for (const id of [quoted, quote]) {
			await sql(t.store, 'UPDATE polls SET multiple = 1 WHERE status_id = ?', id)
			await sql(
				t.store,
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ? - 1)
				INSERT INTO poll_votes (poll_id, account_id, choice, generation, created_at) SELECT ?, ?, i, 0, ? FROM n`,
				MAX_REMOTE_OPTIONS,
				id,
				ALICE,
				new Date(NOW).toISOString()
			)
		}
		for (const id of [quoted, quote, boost]) {
			const at = new Date(NOW).toISOString()
			await sql(t.store, 'INSERT INTO favourites (account_id, status_id, created_at) VALUES (?, ?, ?)', ALICE, id, at)
			await sql(t.store, 'INSERT INTO bookmarks (account_id, status_id, created_at) VALUES (?, ?, ?)', ALICE, id, at)
			await sql(
				t.store,
				"INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at) VALUES (?, ?, ?, ?, 'public', ?)",
				nextId(),
				`https://kopje.test/boosts/${id}`,
				ALICE,
				id,
				at
			)
		}
		const measuredShapes = await runInDurableObject(t.store, (_instance, state) => {
			const real = state.storage.sql
			const viewer = { accountId: ALICE, now: new Date(NOW).toISOString() }
			return [quoted, quote, boost].map((id) => {
				const visible = [id as VisibleStatusId]
				const shared = presentation(new Db(real), visible, { origin: ORIGIN, viewer })
				let bytes = 0
				let rows = 0
				const counting = observedSql(real, (read) => {
					for (const row of read) {
						rows++
						bytes += rowHeapBytes(row)
					}
				})
				presentStatusesWithin(new Db(counting), shared, visible, Infinity, true, 1)
				const [bound] = real
					.exec<{ bytes: number }>(statusRowBoundSql(), JSON.stringify(visible), ALICE, MAX_FILTERS)
					.toArray()
				return { bytes, rows, bound: bound!.bytes }
			})
		})
		for (const shape of measuredShapes) {
			expect(shape.bytes).toBeLessThanOrEqual(shape.bound)
		}
		console.info(
			`R at the maxima (status, quote, boost of a quote): ${measuredShapes.map((m) => `${m.bound} for ${m.bytes} counted in ${m.rows} rows`).join('; ')}`
		)
	}, 300_000)

	// The largest atomic items through the real Store RPC (32 MiB per return): the boost of a quote alone, and an
	// answer of the boost, the quote and the quoted status, which admits the boost and stops at the quote. Raw fill is
	// the most serialized bytes (four-byte characters), escaped fill the most JSON.
	it.each<[string, Fill]>([
		['escaped', 'escaped'],
		['raw', 'raw'],
	])(
		'returns the largest atomic items through the Store RPC, %s',
		async (_name, fill) => {
			const { t, quoted, quote, boost } = await maximalStatuses(fill)
			const input = {
				credential: { ...(await credential(t)), scope: 'read' as const },
				now: NOW,
				present: { origin: ORIGIN },
			}
			const one = await t.store.getStatus(BUILD, { ...input, id: boost })
			const many = await t.store.getStatuses(BUILD, { ...input, ids: [boost, quote, quoted] })
			expect(one.status === 'ok' && one.value.status === 'ok' && one.value.value.id).toBe(boost)
			expect(many.status === 'ok' && many.value.map((s) => s.id)).toEqual([boost])
			const sizes = [jsonBytes(one), jsonBytes(many)]
			for (const size of sizes) {
				expect(size).toBeLessThanOrEqual(ANSWER_BYTES)
			}
			console.info(`Store RPC, ${fill}: the boost of a quote ${sizes[0]}, the lookup ${sizes[1]} JSON bytes`)
		},
		120_000
	)
})

describe('ActivityPub Notes of a local status at its bounds (RES-3)', () => {
	// A converted local status with every part at its bound,
	// built as statusFacts and noteOf build the object endpoint's Note, the outbox's Create and the featured
	// collection's Notes. docs/threat-model.md "Maxima of presented units" states the Note and the Create.
	it('measures the Note and the Create, within OUTBOX_BYTES, and five Notes of the featured collection', async () => {
		const t = await setup()
		const parts = await maximalParts(t)
		// Addressed to MAX_LOCAL_ADDRESSED accounts, each actor id at ACTOR_URI_LIMIT: the mentions above and more.
		const base = 950_000_000_000_000_000n
		const more = MAX_LOCAL_ADDRESSED - parts.mentions.length
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT CAST(?2 + i AS TEXT), substr(?3 || (?2 + i) || '/' || ?4, 1, ?5), 'a' || i, ?6 FROM n`,
			more,
			String(base),
			`https://${HOST}/users/`,
			'u'.repeat(ACTOR_URI_LIMIT),
			ACTOR_URI_LIMIT,
			HOST
		)
		parts.mentions = [...parts.mentions, ...Array.from({ length: more }, (_, i) => String(base + BigInt(i + 1)))]
		const ids: string[] = []
		for (let i = 0; i < PIN_LIMIT; i++) {
			const id = await storedStatus(t, ALICE, parts)
			await sql(t.store, 'INSERT INTO status_pins (account_id, status_id) VALUES (?, ?)', ALICE, id)
			ids.push(id)
		}
		const measuredNote = await runInDurableObject(t.store, (_instance, state) => {
			let sqlite = 0
			let rows = 0
			const counting = observedSql(state.storage.sql, (read) => {
				for (const row of read) {
					rows++
					for (const value of Object.values(row)) {
						sqlite += typeof value === 'string' ? utf8Length(value) : 8
					}
				}
			})
			const facts = statusFacts(new Db(counting), ids[0]!, { reached: false })!
			const note = noteOf(facts)
			return {
				sqlite,
				rows,
				nodes: nodes(note),
				note: jsonBytes(note),
				create: jsonBytes(createActivity(facts).activity),
				tags: facts.tags.length,
				longest: Math.max(...facts.tags.map((tag) => [...tag.name].length)),
				mentions: facts.mentions.length,
				media: facts.media.length,
			}
		})
		expect(measuredNote).toMatchObject({ tags: MAX_PRESENTED_TAGS, mentions: MAX_STATUS_MENTION_ROWS, media: 4 })
		expect(measuredNote.longest).toBeLessThanOrEqual(MAX_TAG_LENGTH)
		expect(measuredNote.create).toBeLessThanOrEqual(OUTBOX_BYTES)
		const featured = await runInDurableObject(t.store, (_instance, state) =>
			getFeatured.run(state.storage.sql, { username: 'alice' })
		)
		// Five such Notes pass the bound: the first ones are shown whole, the rest by their uri.
		let items = featured as unknown
		while (!Array.isArray(items)) {
			items = (items as { value: unknown }).value
		}
		const pins = items as { uri: string; note: string | null }[]
		const featuredBytes = jsonBytes(pins)
		expect(featuredBytes).toBeLessThanOrEqual(ANSWER_BYTES)
		const whole = pins.filter((item) => item.note !== null).length
		expect(whole).toBeGreaterThan(0)
		expect(whole).toBeLessThan(PIN_LIMIT)
		expect(pins).toHaveLength(PIN_LIMIT)
		// Three hashtags far past their bound, as a converted row may hold them, are left out, as the Status entity leaves
		// them out.
		const long = await storedStatus(t, ALICE, {
			...parts,
			mentions: [],
			media: [],
			poll: null,
			tags: [1, 2, 3].map((i) => `${i}${'x'.repeat(240_000)}`),
		})
		const shown = await runInDurableObject(t.store, (_instance, state) => {
			const facts = statusFacts(new Db(state.storage.sql), long, { reached: false })!
			return { tags: facts.tags.length, create: jsonBytes(createActivity(facts).activity) }
		})
		expect(shown.tags).toBe(0)
		expect(shown.create).toBeLessThan(200_000)
		expect({ ...measuredNote, featured: featuredBytes, whole }).toEqual({
			sqlite: 3_685_367,
			rows: 1_276,
			nodes: 2_616,
			note: 4_220_294,
			create: 6_276_334,
			tags: MAX_PRESENTED_TAGS,
			longest: MAX_TAG_LENGTH,
			mentions: MAX_STATUS_MENTION_ROWS,
			media: 4,
			featured: 4_413_221,
			whole: 1,
		})
	}, 300_000)
})
