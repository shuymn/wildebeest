import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { bearer, json, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { BUILD } from './helpers'
import { pathOf } from './media-helpers'
import { observedSql, rowsRead } from './read-helpers'
import { community, post, type Status, type User } from './status-helpers'
import { accessibleName, attr, byId, closest, elements, one, parseHtml, query, text } from './web-dom'
import { webStatusPage } from '../src/domain/web-pages/status'
import { STATUS_CONTENT_BYTES } from '../src/security/html'

// A status's edit history on its page (design §8 "Edit history", §2 step 6; amendments A5 and A7; VIS-4, VIS-11):
// the dialog's markup contract, the versions it lists and for whom, and what the embed leaves out. The share at the
// maxima is test/web-page-maxima.test.ts's; what the dialog does once rendered is the browser job's.

// The ids the walk reads at a time (EDIT_ID_CHUNK in src/domain/statuses.ts).
const EDIT_ID_CHUNK = 16

type Harness = Awaited<ReturnType<typeof community>>

async function edit(h: Harness, user: User, status: Status, body: Record<string, unknown>): Promise<void> {
	const response = await h.request(
		`/api/v1/statuses/${String(status.id)}`,
		bearer(user.token, json(body, { method: 'PUT' }))
	)
	expect(response.status).toBe(200)
}

// alice's post written three times: the first behind a warning, the last behind another.
async function editedThrice(h: Harness, alice: User): Promise<Status> {
	const status = await post(h, alice, { status: 'version one', spoiler_text: 'warning one', language: 'en' })
	await edit(h, alice, status, { status: 'version two', language: 'en' })
	await edit(h, alice, status, { status: 'version three', spoiler_text: 'warning three', language: 'en' })
	return status
}

const page = async (h: Harness, path: string) => {
	const response = await h.request(path)
	const html = await response.text()
	return { status: response.status, html, doc: parseHtml(html) }
}

describe('the edit history on a status page (design §8)', () => {
	it('lists the versions newest first in a closed dialog that the post’s Edited opens', async () => {
		const h = await community(['alice'])
		const status = await editedThrice(h, h.users.alice)
		const { status: code, doc } = await page(h, pathOf(String(status.url)))
		expect(code).toBe(200)

		// The history dialog, closed, named by its heading, closed by an outside click too (A7).
		const dialog = byId(doc, 'history')!
		expect(attr(dialog, 'open')).toBeNull()
		expect(attr(dialog, 'closedby')).toBe('any')
		const heading = byId(doc, attr(dialog, 'aria-labelledby') ?? '')
		expect(heading?.tagName).toBe('h2')
		expect(closest(heading!, (e) => e === dialog)).toBe(dialog)
		expect(accessibleName(dialog, doc)).toBe('Edit history')

		// The post's "Edited" is the one control that opens it; the dialog's own button closes it. (The page's other
		// dialogs, design §8, have their own.)
		const commands = query(doc, 'button')
			.filter((button) => attr(button, 'commandfor') === 'history')
			.map((button) => ({
				type: attr(button, 'type'),
				command: attr(button, 'command'),
				for: attr(button, 'commandfor'),
				name: accessibleName(button, doc),
				inDialog: closest(button, (e) => e.tagName === 'dialog') !== null,
				inPost: closest(button, (e) => e.tagName === 'article') !== null,
			}))
		expect(commands).toEqual([
			{ type: 'button', command: 'show-modal', for: attr(dialog, 'id'), name: 'Edited', inDialog: false, inPost: true },
			{ type: 'button', command: 'close', for: attr(dialog, 'id'), name: 'Close', inDialog: true, inPost: false },
		])

		// Initial focus (A5): the heading's row, focusable by script only, is the dialog's one autofocus.
		const autofocus = elements(dialog).filter((e) => attr(e, 'autofocus') !== null)
		expect(autofocus.map((e) => [attr(e, 'class'), attr(e, 'tabindex')])).toEqual([['dhead', '-1']])
		expect(autofocus[0]!.childNodes).toContain(heading)

		// Newest first, each with its label, its own time and its own warning; the post shows the newest.
		const history = await (await h.request(`/api/v1/statuses/${String(status.id)}/history`)).json<Status[]>()
		const versions = query(dialog, 'li').filter((li) => attr(li, 'class') === 'stack')
		expect(
			versions.map((li) => ({
				label: text(one(li, 'strong')),
				at: attr(one(li, 'time'), 'datetime'),
				warning: query(li, 'span', 'spoiler').map(text),
				body: text(one(li, 'div', 'body')),
			}))
		).toEqual([
			{ label: 'Current', at: history[2]!.created_at, warning: ['warning three'], body: 'version three' },
			{ label: 'Edited', at: history[1]!.created_at, warning: [], body: 'version two' },
			{ label: 'Original', at: history[0]!.created_at, warning: ['warning one'], body: 'version one' },
		])
		// No notice: nothing was left out.
		expect(query(dialog, 'p', 'muted')).toEqual([])
		// No version carries a language (§9.5), while the post itself does.
		expect(elements(dialog).filter((e) => attr(e, 'lang') !== null)).toEqual([])
		expect(attr(one(one(doc, 'article'), 'div', 'body'), 'lang')).toBe('en')
	})

	it('shows no history on the embed, and reads none for it', async () => {
		const h = await community(['alice'])
		const status = await editedThrice(h, h.users.alice)
		const path = pathOf(String(status.url))
		const embed = await page(h, `${path}/embed`)
		expect(embed.status).toBe(200)
		expect(embed.html).toContain('version three')
		for (const absent of ['<dialog', 'command', 'version one', 'version two', 'Edit history']) {
			expect(embed.html, absent).not.toContain(absent)
		}
		const read = (embed: boolean) =>
			h.store.webStatusPage(BUILD, { handle: 'alice', id: String(status.id), now: NOW, embed })
		const [forEmbed, forPage] = [await read(true), await read(false)]
		expect(forEmbed.status === 'ok' && forEmbed.history).toBeNull()
		// The same status's page read holds them: the embed's leaves them out by its mode.
		expect(forPage.status === 'ok' && forPage.history?.versions).toHaveLength(3)
	})

	it('shows Edited as text and no dialog for an edited status without recorded versions', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const plain = await post(h, alice, { status: 'never edited' })
		const imported = await post(h, alice, { status: 'edited elsewhere' })
		await sql(h.store, 'UPDATE statuses SET edited_at = ? WHERE id = ?', new Date(NOW).toISOString(), imported.id)
		const never = await page(h, pathOf(String(plain.url)))
		expect(never.html).not.toContain('Edited')
		expect(never.html).not.toContain('commandfor="history"')
		expect(never.html).not.toContain('<dialog id="history"')
		const unrecorded = await page(h, pathOf(String(imported.url)))
		const meta = query(one(unrecorded.doc, 'article'), 'p', 'meta').at(-1)!
		expect(text(meta)).toContain('Edited')
		expect(query(meta, 'button').map((button) => attr(button, 'commandfor'))).toEqual(['interact', 'embed'])
		expect(unrecorded.html).not.toContain('commandfor="history"')
		expect(unrecorded.html).not.toContain('<dialog id="history"')
	})

	it('sanitizes each version at the sink, with its own emoji', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const status = await post(h, alice, { status: 'now :cur:' })
		await sql(
			h.store,
			'UPDATE statuses SET emojis = ?, edited_at = ? WHERE id = ?',
			JSON.stringify([['cur', 'https://emoji.example/cur.png']]),
			new Date(NOW).toISOString(),
			status.id
		)
		await sql(
			h.store,
			`INSERT INTO status_edits (status_id, content, spoiler_text, sensitive, media_json, created_at, emojis)
			VALUES (?1, ?2, '<b>bold</b> :old:', 0, ?3, ?4, ?5), (?1, '<p>now :cur:</p>', '', 0, '[]', ?4, ?6)`,
			status.id,
			'<p onclick="x()">old<script>alert(1)</script><a href="javascript:alert(2)">j</a> :old: :cur:</p>',
			JSON.stringify([{ id: '1', type: 'image', url: 'javascript:alert(3)', preview_url: 'javascript:alert(4)' }]),
			new Date(NOW - 60_000).toISOString(),
			JSON.stringify([['old', 'https://emoji.example/old.png']]),
			JSON.stringify([['cur', 'https://emoji.example/cur.png']])
		)
		const { html, doc } = await page(h, pathOf(String(status.url)))
		const dialog = byId(doc, 'history')!
		const [current, original] = query(dialog, 'li').filter((li) => attr(li, 'class') === 'stack')
		// The dialog's markup as served (the page's own script, the L1 bundle, is in its head).
		const served = html.slice(html.indexOf('<dialog id="history"'), html.indexOf('</dialog>'))
		expect(served).toContain('old')
		for (const unsafe of ['onclick', '<script', 'alert(', 'javascript:', '<b>']) {
			expect(served, unsafe).not.toContain(unsafe)
		}
		// The warning is text; each version shows its own emoji, and another version's shortcode stays text.
		expect(text(one(original!, 'span', 'spoiler'))).toBe('<b>bold</b>')
		const emoji = (li: typeof current) => query(li!, 'img').map((img) => attr(img, 'alt'))
		expect(emoji(original)).toEqual([':old:', ':old:'])
		expect(text(one(original!, 'div', 'body'))).toContain(':cur:')
		expect(emoji(current)).toEqual([':cur:'])
		// The attachment whose URL is not http(s) is not shown at all.
		expect(query(dialog, 'div', 'media-grid')).toEqual([])
	})
})

describe('the edit history’s visibility (VIS-4, VIS-11)', () => {
	it('shows the versions only of a status an anonymous viewer may see, and nothing of any other', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const missing = await page(h, '/@alice/100000000000000001')
		expect(missing.status).toBe(404)
		for (const visibility of ['unlisted', 'private', 'direct'] as const) {
			const name = visibility
			const status = await post(h, alice, { status: `@bob ${name} version one`, visibility })
			await edit(h, alice, status, { status: `@bob ${name} version two` })
			// The versions exist: the author reads both through the API (the branch the page guards is reached).
			const own = await h.request(`/api/v1/statuses/${String(status.id)}/history`, bearer(alice.token))
			expect(
				(await own.json<Status[]>()).map((v) => v.content),
				name
			).toHaveLength(2)
			const shown = await page(h, pathOf(String(status.url)))
			if (name === 'unlisted') {
				expect(shown.status, name).toBe(200)
				expect(query(byId(shown.doc, 'history')!, 'li').filter((li) => attr(li, 'class') === 'stack')).toHaveLength(2)
				expect(shown.html, name).toContain(`${name} version one`)
			} else {
				// The same 404 as an unknown id, and nothing of any version anywhere in it.
				expect(shown.status, name).toBe(404)
				expect(shown.html, name).toBe(missing.html)
				expect((await page(h, `${pathOf(String(status.url))}/embed`)).html, name).toBe(missing.html)
			}
		}
		// A public status of an account suspended since: the same 404.
		const suspended = await post(h, bob, { status: 'bob version one' })
		await edit(h, bob, suspended, { status: 'bob version two' })
		expect((await page(h, pathOf(String(suspended.url)))).html).toContain('bob version one')
		await sql(
			h.store,
			'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?',
			new Date(NOW).toISOString(),
			bob.id
		)
		const gone = await page(h, pathOf(String(suspended.url)))
		expect(gone.status).toBe(404)
		expect(gone.html).not.toContain('version')
	})
})

describe('the edit history’s read (design §2)', () => {
	it('reads the same rows whatever other statuses’ histories hold, with statistics taken before they grew', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const status = await editedThrice(h, h.users.alice)
		const other = await post(h, alice, { status: 'another' })
		const input = { handle: 'alice', id: String(status.id), now: NOW }
		// Another status's history, 50 versions and then 5,000, the growth written after the statistics.
		const versionsOf = (n: number) =>
			sql(
				h.store,
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?3)
				INSERT INTO status_edits (status_id, content, created_at) SELECT ?1, '<p>x</p>', ?2 FROM n`,
				other.id,
				new Date(NOW).toISOString(),
				n
			)
		await versionsOf(50)
		await sql(h.store, 'ANALYZE')
		const before = await rowsRead(h, webStatusPage, input)
		await versionsOf(4950)
		const after = await rowsRead(h, webStatusPage, input)
		console.info(`Rows read beside another history of 50, then 5,000 versions: ${JSON.stringify({ before, after })}`)
		const read = await h.store.webStatusPage(BUILD, input)
		expect(read.status === 'ok' && read.history?.versions).toHaveLength(3)
		expect(after).toBe(before)
	})

	it('reads one chunk of ids past what it admits from a long imported history, and counts the rest by index', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const status = await post(h, alice, { status: 'now' })
		const at = new Date(NOW).toISOString()
		// The three newest versions, each with its content at its bound in ampersands (about 131 KB as JSON): three fit
		// the share, the fourth would not (test/web-page-maxima.test.ts).
		const big = `<p>${'&amp;'.repeat((STATUS_CONTENT_BYTES - 9) / 5)}</p>`
		await sql(
			h.store,
			`INSERT INTO status_edits (id, status_id, content, created_at)
			VALUES (20001, ?1, ?2, ?3), (20002, ?1, ?2, ?3), (20003, ?1, ?2, ?3), (20004, ?1, ?2, ?3)`,
			status.id,
			big,
			at
		)
		await sql(h.store, 'UPDATE statuses SET edited_at = ? WHERE id = ?', at, status.id)
		const input = { handle: 'alice', id: String(status.id), now: NOW }
		await sql(h.store, 'ANALYZE')
		const before = await rowsRead(h, webStatusPage, input)
		// 10,000 older versions, as a conversion carries them (no MAX_STATUS_EDITS), written after the statistics.
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
			INSERT INTO status_edits (id, status_id, content, created_at) SELECT i, ?, '<p>x</p>', ? FROM n`,
			status.id,
			at
		)
		const after = await rowsRead(h, webStatusPage, input)
		const read = await h.store.webStatusPage(BUILD, input)
		expect(read.status === 'ok' && read.history?.versions.length).toBe(3)
		expect(read.status === 'ok' && read.history?.leftOut).toBe(10_001)
		console.info(`Rows read, 4 versions then 10,004: ${JSON.stringify({ before, after })}`)
		// The count reads the status's 10,000 new index entries; the walk reads one full chunk of ids where it read four,
		// and the same four versions (three admitted, the fourth refused), whatever lies below them.
		expect(after - before).toBeLessThanOrEqual(10_000 + EDIT_ID_CHUNK)
		// What leaves SQLite for the history: one count and one chunk of ids, never the history's ids.
		const returned = await runInDurableObject(h.store, (_instance, state) => {
			const rows: [string, number][] = []
			webStatusPage.run(
				observedSql(state.storage.sql, (seen, query) => {
					if (query.includes('status_edits')) {
						rows.push([query.includes('COUNT(*)') ? 'count' : query.includes('LIMIT') ? 'ids' : 'version', seen.length])
					}
				}),
				input
			)
			return rows
		})
		expect(returned).toEqual([['count', 1], ['ids', EDIT_ID_CHUNK], ...Array.from({ length: 4 }, () => ['version', 1])])
	})
})
