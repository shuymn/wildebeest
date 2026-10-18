import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { convert, exportOf, opened, verify, workspace } from './cutover-helpers.js'
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

// `prefix` padded with 'x' to `bytes` UTF-8 bytes (an ASCII prefix).
const urlOf = (prefix: string, bytes: number) => prefix.padEnd(bytes, 'x')
// A JSON string's body, as the export's JSON holds it.
const json = (text: string) => JSON.stringify(text).slice(1, -1)

// Applies `edit` to every file of the export; returns how many files it changed.
async function edited(exportPath: string, edit: (text: string) => string): Promise<number> {
	let changed = 0
	for (const name of (await readdir(exportPath)).filter((n) => n.endsWith('.sql'))) {
		const text = await readFile(join(exportPath, name), 'utf8')
		const next = edit(text)
		if (next !== text) {
			await writeFile(join(exportPath, name), next)
			changed++
		}
	}
	return changed
}

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
			for (const [table, column, projection] of COVERED) {
				const off = db
					.prepare(`SELECT count(*) AS n FROM ${table} WHERE (${projection(column)}) IS NOT ${column}`)
					.get() as { n: number }
				expect(off.n, `${table}.${column}`).toBe(0)
			}
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
})
