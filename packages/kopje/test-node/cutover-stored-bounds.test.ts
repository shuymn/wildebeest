import { describe, expect, it } from 'vitest'

import { convert, exportOf, failing, opened, rewriteExport, tampered, verify, workspace } from './cutover-helpers.js'
import {
	cutJsonString,
	jsonStringBytes,
	REMOTE_BIO_BYTES,
	sanitizeRemoteBio,
	sanitizeRemoteContent,
	sanitizeRemoteHtml,
	SPOILER_BYTES,
	STATUS_CONTENT_BYTES,
} from '../cli/lib/cutover/kopje-runtime.js'
import {
	contentSql,
	displayNameSql,
	mediaDescriptionSql,
	mediaMetaSql,
	mediaUrlSql,
	noteSql,
	pollOptionsSql,
	profileUrlSql,
	sourceTextSql,
	spoilerSql,
	statusUrlSql,
} from '../src/platform/stored-bounds.js'

// RES-2: a converted row holds what the Worker would store (src/platform/stored-bounds.ts). Values at each stored
// bound and one past it, with U+0000 and characters outside the BMP, are converted to their writers' output, each
// change counted under its column, and every covered column of every converted row is a fixed point of its read
// projection. Verification computes the same values.

const space = workspace()

// Every covered column and its projection.
const COVERED: [table: string, column: string, projection: (column: string) => string][] = [
	['accounts', 'display_name', displayNameSql],
	['accounts', 'note', noteSql],
	['accounts', 'url', profileUrlSql],
	['accounts', 'avatar_url', profileUrlSql],
	['accounts', 'header_url', profileUrlSql],
	['statuses', 'content', contentSql],
	['statuses', 'spoiler_text', spoilerSql],
	['statuses', 'source_text', sourceTextSql],
	['statuses', 'url', statusUrlSql],
	['media_attachments', 'url', mediaUrlSql],
	['media_attachments', 'preview_url', mediaUrlSql],
	['media_attachments', 'description', mediaDescriptionSql],
	['media_attachments', 'meta', mediaMetaSql],
	['status_edits', 'content', contentSql],
	['status_edits', 'spoiler_text', spoilerSql],
	['status_edits', 'poll_options', pollOptionsSql],
]

// Every covered column of every row is a fixed point of its projection.
function expectFixedPoints(db: Awaited<ReturnType<typeof opened>>): void {
	for (const [table, column, projection] of COVERED) {
		const off = db
			.prepare(`SELECT count(*) AS n FROM ${table} WHERE (${projection(column)}) IS NOT ${column}`)
			.get() as { n: number }
		expect(off.n, `${table}.${column}`).toBe(0)
	}
}

// `prefix` padded with 'x' to `bytes` UTF-8 bytes (an ASCII prefix).
const urlOf = (prefix: string, bytes: number) => prefix.padEnd(bytes, 'x')
// A JSON string's body, as the export's JSON holds it.
const json = (text: string) => JSON.stringify(text).slice(1, -1)

// Applies `edit` to every file of the export; returns how many files it changed.
const edited = (exportPath: string, edit: (text: string) => string) =>
	rewriteExport(exportPath, (text) => {
		const next = edit(text)
		return next !== text ? next : undefined
	})

describe('converted rows at the stored bounds', () => {
	it('stores each value as its writer does, counts the change, and verifies', async () => {
		const exportPath = await exportOf(space.dir, { level: 39 })
		const astral = '\u{1F600}'
		// r0 at each bound, r1 one past it.
		const nameAt = `${astral.repeat(1000)}\u0000${'n'.repeat(1048)}`
		const nameOver = 'é'.repeat(2049)
		const replace = (from: string, to: string) => edited(exportPath, (text) => text.replaceAll(from, to))
		expect(await replace('"name":"Ｒｅｍｏｔｅ 0"', `"name":"${json(nameAt)}"`)).toBe(1)
		expect(await replace('"name":"Ｒｅｍｏｔｅ 1"', `"name":"${json(nameOver)}"`)).toBe(1)
		expect(await replace('<p>bio 0</p>', `<p>bio${json('\u0000')} 0</p>`)).toBe(1)
		const profileAt = urlOf('https://remote.example/@r0#', 2048)
		const profileOver = urlOf('https://remote.example/@r1#', 2049)
		expect(await replace('"url":"https://remote.example/@r0"', `"url":"${profileAt}"`)).toBe(1)
		expect(await replace('"url":"https://remote.example/@r1"', `"url":"${profileOver}"`)).toBe(1)
		const avatarAt = urlOf('https://files.remote.example/a/0.png#', 2048)
		const avatarOver = urlOf('https://files.remote.example/a/1.png#', 2049)
		expect(await replace('"url":"https://files.remote.example/a/0.png"', `"url":"${avatarAt}"`)).toBe(1)
		expect(await replace('"url":"https://files.remote.example/a/1.png"', `"url":"${avatarOver}"`)).toBe(1)
		// Two remote statuses: one url at STATUS_URL_LIMIT, one past it.
		const statusUrls: string[] = []
		expect(
			await edited(exportPath, (text) =>
				text.replace(/"url":"(https:\/\/(?:remote|other)\.example\/@r\d\/\d+)"/g, (whole, url: string) => {
					if (statusUrls.length >= 2) {
						return whole
					}
					const long = urlOf(`${url}#`, statusUrls.length === 0 ? 4096 : 4097)
					statusUrls.push(long)
					return `"url":"${long}"`
				})
			)
		).toBeGreaterThan(0)
		expect(statusUrls).toHaveLength(2)
		expect(await replace('<p>こんにちは ', `<p>こ${json('\u0000')}んにちは `)).toBe(1)
		// The attachments of r0's first status: one at each media bound, one past them.
		const mediaAt = urlOf('https://files.remote.example/m/1.mp4#', 2048)
		const mediaOver = urlOf('https://files.remote.example/m/2.png#', 2049)
		const describedAt = `${astral.repeat(5000)}\u0000${'d'.repeat(5000)}`
		const describedOver = `${'d'.repeat(9999)}${astral}${astral}`
		expect(
			await replace(
				'"url":"https://files.remote.example/m/1.mp4","name":"a clip"',
				`"url":"${mediaAt}","name":"${json(describedAt)}"`
			)
		).toBe(1)
		expect(
			await replace(
				'"url":"https://files.remote.example/m/2.png","name":null',
				`"url":"${mediaOver}","name":"${json(describedOver)}"`
			)
		).toBe(1)

		const converted = await convert(space.dir, exportPath)
		expect(converted.ok).toBe(true)
		expect((converted.manifest.conversion as { normalized: Record<string, number> }).normalized).toMatchObject({
			'stored:accounts.display_name': 2,
			'stored:accounts.note': 1,
			'stored:accounts.url': 1,
			'stored:accounts.avatar_url': 1,
			'stored:statuses.url': 1,
			'stored:statuses.content': 1,
			'stored:media_attachments.url': 1,
			'stored:media_attachments.description': 2,
		})

		const db = await opened(converted.dumpPath)
		try {
			expectFixedPoints(db)
			const account = (uri: string) =>
				db.prepare('SELECT display_name, note, url, avatar_url FROM accounts WHERE uri = ?').get(uri) as Record<
					string,
					string | null
				>
			expect(account('https://remote.example/users/r0')).toMatchObject({
				display_name: nameAt.replace('\u0000', ''),
				url: profileAt,
				avatar_url: avatarAt,
			})
			expect(account('https://remote.example/users/r0').note).not.toContain('\u0000')
			expect(account('https://remote.example/users/r1')).toMatchObject({
				display_name: 'é'.repeat(2048),
				url: null,
				avatar_url: null,
			})
			const urls = db
				.prepare('SELECT url FROM statuses WHERE raw LIKE ? OR raw LIKE ?')
				.all(`%${statusUrls[0]}%`, `%${statusUrls[1]}%`)
				.map((row) => (row as { url: string | null }).url)
			expect(urls.sort()).toEqual([null, statusUrls[0]].sort())
			const media = db
				.prepare('SELECT url, description FROM media_attachments WHERE url = ? OR description LIKE ? ORDER BY position')
				.all(mediaAt, 'd%') as { url: string; description: string }[]
			expect(media).toEqual([
				{ url: mediaAt, description: describedAt.replace('\u0000', '') },
				{ url: '', description: `${'d'.repeat(9999)}${astral}` },
			])
		} finally {
			db.close()
		}
		expect((await verify(exportPath, converted.dumpPath)).ok).toBe(true)
	})
	it('stores the JSON-bounded texts, header URLs and edit snapshots at each bound and one past it', async () => {
		const exportPath = await exportOf(space.dir, { level: 39 })
		const replace = (from: string, to: string) => edited(exportPath, (text) => text.replaceAll(from, to))
		// Each value at its bound ('a' padding), and one past it ('b'), in UTF-8 bytes of its (sanitized) JSON string.
		// The padding past `base` bytes: 'a' up to a bound (an even size here), 'b' past it, so a cut differs from it.
		const pad2 = (bytes: number, base: number) => (bytes % 2 === 0 ? 'a' : 'b').repeat(bytes - base)
		const html = (bytes: number) => `<p>${'\u65e5'.repeat(43_687)}${pad2(bytes, 131_070)}</p>`
		const bio = (bytes: number) => `<p>${'\u00e9'.repeat(32_763)}${pad2(bytes, 65_535)}</p>`
		const warning = (bytes: number) => `${'\u00e9'.repeat(8190)}${pad2(bytes, 16_382)}`
		const source = (bytes: number) => `${'\u65e5'.repeat(43_689)}${pad2(bytes, 131_069)}`
		const [bioAt, bioOver] = [bio(REMOTE_BIO_BYTES), bio(REMOTE_BIO_BYTES + 1)]
		const [contentAt, contentOver] = [html(STATUS_CONTENT_BYTES), html(STATUS_CONTENT_BYTES + 1)]
		const [warningAt, warningOver] = [warning(SPOILER_BYTES), warning(SPOILER_BYTES + 1)]
		const [sourceAt, sourceOver] = [source(STATUS_CONTENT_BYTES), source(STATUS_CONTENT_BYTES + 1)]
		expect([bioAt, bioOver].map((x) => jsonStringBytes(sanitizeRemoteHtml(x)))).toEqual([65_536, 65_537])
		expect([contentAt, contentOver].map((x) => jsonStringBytes(sanitizeRemoteHtml(x)))).toEqual([131_072, 131_073])
		expect([warningAt, warningOver].map(jsonStringBytes)).toEqual([16_384, 16_385])
		expect([sourceAt, sourceOver].map(jsonStringBytes)).toEqual([131_072, 131_073])
		const headerAt = urlOf('https://files.remote.example/h/2.png#', 2048)
		const headerOver = urlOf('https://files.remote.example/h/3.png#', 2049)
		const mediaAt = urlOf('https://files.remote.example/e/1.png#', 2048)
		const mediaOver = urlOf('https://files.remote.example/e/2.png#', 2049)
		expect([headerAt, headerOver, mediaAt, mediaOver].map((u) => Buffer.byteLength(u))).toEqual([
			2048, 2049, 2048, 2049,
		])

		expect(await replace('<p>bio 0</p>', json(bioAt))).toBe(1)
		expect(await replace('<p>bio 1</p>', json(bioOver))).toBe(1)
		for (const [i, url] of [
			[2, headerAt],
			[3, headerOver],
		] as const) {
			const icon = `"icon":{"type":"Image","url":"https://files.remote.example/a/${i}.png"}`
			expect(await replace(icon, `"image":{"type":"Image","url":"${url}"},${icon}`)).toBe(1)
		}
		expect(await replace('<p>unlisted from r3, lost its original id</p>', json(contentAt))).toBe(1)
		expect(await replace('<p>a reply to alice</p>', json(contentOver))).toBe(1)
		expect(await replace('CW 注意', json(warningAt))).toBe(1)
		expect(await replace('CW: spoilers', json(warningOver))).toBe(1)
		expect(await replace('"source":{"content":"unlisted, with a CW"', `"source":{"content":"${json(sourceAt)}"`)).toBe(
			1
		)
		expect(await replace('"source":{"content":"followers only"', `"source":{"content":"${json(sourceOver)}"`)).toBe(1)
		const attachment = (url: string) => `{"type":"Document","mediaType":"image/png","url":"${url}"}`
		expect(
			await replace(
				'"content":"<p>edited text, first version</p>","spoiler_text":"","sensitive":false,"attachment":[]',
				`"content":"${json(contentAt)}","spoiler_text":"${json(warningOver)}","sensitive":false,` +
					`"attachment":[${attachment(mediaAt)},${attachment(mediaOver)}]`
			)
		).toBe(1)

		const converted = await convert(space.dir, exportPath, { acceptTruncation: true })
		expect(converted.ok).toBe(true)
		expect((converted.manifest.conversion as { normalized: Record<string, number> }).normalized).toMatchObject({
			'html:bio-longer-than-bound': 1,
			'html:content-longer-than-bound': 1,
			'text:spoiler-longer-than-bound': 2,
			'text:source-longer-than-bound': 1,
			'stored:accounts.header_url': 1,
			'stored:status_edits.media_json': 1,
		})
		const db = await opened(converted.dumpPath)
		try {
			expectFixedPoints(db)
			const value = (query: string, ...params: string[]) => db.prepare(query).get(...params) as Record<string, unknown>
			const account = (i: number) =>
				value('SELECT note, header_url FROM accounts WHERE uri = ?', `https://remote.example/users/r${i}`)
			expect(account(0).note).toBe(bioAt)
			expect(account(1).note).toBe(sanitizeRemoteBio(bioOver))
			expect([account(2).header_url, account(3).header_url]).toEqual([headerAt, null])
			expect(value('SELECT count(*) AS n FROM statuses WHERE content = ?', contentAt).n).toBe(1)
			expect(value('SELECT count(*) AS n FROM statuses WHERE content = ?', sanitizeRemoteContent(contentOver)).n).toBe(
				1
			)
			expect(value('SELECT count(*) AS n FROM statuses WHERE spoiler_text = ?', warningAt).n).toBe(1)
			const cutWarning = cutJsonString(warningOver, SPOILER_BYTES)
			expect(value('SELECT count(*) AS n FROM statuses WHERE spoiler_text = ?', cutWarning).n).toBe(1)
			expect(value('SELECT count(*) AS n FROM statuses WHERE source_text = ?', sourceAt).n).toBe(1)
			const cutSource = cutJsonString(sourceOver, STATUS_CONTENT_BYTES)
			expect(value('SELECT count(*) AS n FROM statuses WHERE source_text = ?', cutSource).n).toBe(1)
			const edit = value('SELECT content, spoiler_text, media_json FROM status_edits WHERE content = ?', contentAt) as {
				content: string
				spoiler_text: string
				media_json: string
			}
			expect(edit.spoiler_text).toBe(cutWarning)
			expect(
				(JSON.parse(edit.media_json) as { url: string | null; preview_url: string | null }[]).map((m) => [
					m.url,
					m.preview_url,
				])
			).toEqual([
				[mediaAt, mediaAt],
				[null, null],
			])
		} finally {
			db.close()
		}
		expect((await verify(exportPath, converted.dumpPath, { acceptTruncation: true })).ok).toBe(true)
	})
})

// RES-2: conversion and verification enforce INSTANCE_SETTING_BOUNDS and absence of dropped settings.
// An over-bound document is a truncation even when its only text lies beyond the sanitizer's cap.
describe('converted instance settings at their stored bounds', () => {
	const sqlText = (text: string) => `'${text.replaceAll("'", "''")}'`
	// The legacy settings of the fixture replaced by `values` (by legacy name), the rules' second text by `rule`.
	async function exportWith(values: Record<string, string>, rule?: string) {
		const exportPath = await exportOf(space.dir, { level: 39 })
		await rewriteExport(exportPath, (text) => {
			if (!text.includes('"server_settings"')) {
				return rule !== undefined && text.includes('スパム禁止') ? text.replace('スパム禁止', rule) : undefined
			}
			const kept = text
				.split('\n')
				.filter((line) => !Object.keys(values).some((name) => line.includes(`'${name}'`)))
				.join('\n')
			const added = Object.entries(values)
				.map(
					([name, value]) =>
						`INSERT INTO "server_settings" ("setting_name","setting_value") VALUES(${sqlText(name)},${sqlText(value)});`
				)
				.join('\n')
			return `${kept.trimEnd()}\n${added}\n`
		})
		return exportPath
	}
	const settingsOf = async (dumpPath: string) => {
		const db = await opened(dumpPath)
		try {
			return Object.fromEntries(
				(
					db.prepare('SELECT name, value FROM instance_settings ORDER BY name').all() as {
						name: string
						value: string
					}[]
				).map((r) => [r.name, r.value])
			)
		} finally {
			db.close()
		}
	}
	const documentAt = `<p>${'日'.repeat(16_664)}a</p>`
	// Past INSTANCE_DOCUMENT_BYTES, with its only text past REMOTE_HTML_RAW_LIMIT, which the sanitizer never reaches.
	const hiddenPast = `<script>${'x'.repeat(50_000)}</script><p>Keep this policy</p>`

	it('cuts or drops values past their bounds as truncations, and drops blank and textless ones', async () => {
		expect(new TextEncoder().encode(documentAt).length).toBe(50_000)
		const exportPath = await exportWith(
			{
				'server name': 'T'.repeat(1025),
				'server description': '\v \t',
				'extended description': documentAt,
				'privacy policy': '<script>only a script</script>',
			},
			'r'.repeat(66_000)
		)
		const refused = await convert(space.dir, exportPath, { out: 'refused' })
		expect(refused.ok).toBe(false)
		expect((refused.manifest.conversion as { problems: Record<string, number> }).problems).toEqual({
			'settings:title-longer-than-bound': 1,
			'settings:rules-longer-than-bound': 1,
		})
		const converted = await convert(space.dir, exportPath, { acceptTruncation: true })
		expect(converted.ok).toBe(true)
		expect((converted.manifest.conversion as { normalized: Record<string, number> }).normalized).toMatchObject({
			'settings:title-longer-than-bound': 1,
			'settings:rules-longer-than-bound': 1,
			'settings:description-blank': 1,
			'settings:privacy_policy-no-text': 1,
		})
		expect(await settingsOf(converted.dumpPath)).toEqual({ extended_description: documentAt, title: 'T'.repeat(1024) })
		expect((await verify(exportPath, converted.dumpPath)).ok).toBe(false)
		expect((await verify(exportPath, converted.dumpPath, { acceptTruncation: true })).ok).toBe(true)
	})

	it('counts a document past its bound whose text the sanitizer never reaches as a truncation', async () => {
		expect(sanitizeRemoteHtml(hiddenPast)).toBe('')
		const exportPath = await exportWith({ 'privacy policy': hiddenPast })
		const refused = await convert(space.dir, exportPath, { out: 'refused' })
		expect(refused.ok).toBe(false)
		expect((refused.manifest.conversion as { problems: Record<string, number> }).problems).toEqual({
			'settings:privacy_policy-longer-than-bound': 1,
		})
		const converted = await convert(space.dir, exportPath, { acceptTruncation: true })
		expect(converted.ok).toBe(true)
		const normalized = (converted.manifest.conversion as { normalized: Record<string, number> }).normalized
		expect(normalized['settings:privacy_policy-longer-than-bound']).toBe(1)
		expect(normalized).not.toHaveProperty('settings:privacy_policy-no-text')
		expect(await settingsOf(converted.dumpPath)).not.toHaveProperty('privacy_policy')
		expect((await verify(exportPath, converted.dumpPath, { acceptTruncation: true })).ok).toBe(true)
	})

	it('fails verification when a dropped setting is in the dump', async () => {
		const exportPath = await exportWith({ 'privacy policy': '<script>only a script</script>' })
		const converted = await convert(space.dir, exportPath)
		expect(converted.ok).toBe(true)
		expect((await verify(exportPath, converted.dumpPath)).ok).toBe(true)
		const dumpPath = await tampered(
			space.dir,
			converted.dumpPath,
			"INSERT INTO instance_settings (name, value) VALUES ('privacy_policy', '<script>only a script</script>')"
		)
		const { ok, categories } = await verify(exportPath, dumpPath)
		expect(ok).toBe(false)
		expect(failing(categories)).toEqual(['settings'])
		expect(categories.settings).toMatchObject({ extra: 1 })
	})
})
