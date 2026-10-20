import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it, vi } from 'vitest'

import { bearer, json, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { BUILD } from './helpers'
import { ALICE, setup } from './inbox-status-helpers'
import { added, localSnapshotAtCap } from './local-emoji-helpers'
import { ACCESS, setAccess } from './ops-helpers'
import { community, getJson, outbound, post, remoteAccount, remoteFollows } from './status-helpers'
import { Db } from '../src/db/sql'
import { actorDocument } from '../src/domain/actor-update'
import { jsonBytes } from '../src/domain/answer-budget'
import { emojiCandidates } from '../src/federation/remote-emoji'
import { publishScheduled } from '../src/jobs/scheduled'
import { ACCOUNT_EMOJIS_BYTES, MAX_ENABLED_EMOJIS, presentedEmojiBytes } from '../src/platform/stored-bounds'

// Local custom emoji as clients and peers see them: GET /api/v1/custom_emojis (REST::CustomEmojiSerializer), the
// snapshots a post, a scheduled post, an edit and a profile save take (custom-emojis.ts localEmojiSnapshot), the Emoji
// tags of Notes, actors and Update(Person), and GET /emojis/:id (HTML-3, RES-3).

const AP = { headers: { accept: 'application/activity+json' } }
const HOUR = 60 * 60 * 1000

async function emojiHarness() {
	const h = await community(['admin', 'bob'])
	await setAccess(h.store, { admin_email: 'admin@example.com' })
	const authority = { ...ACCESS, email: 'admin@example.com' }
	const add = (shortcode: string, body: Record<string, unknown> = {}) => added(h.store, shortcode, { authority, body })
	const set = (id: string, changes: { disabled?: boolean; visibleInPicker?: boolean }) =>
		h.store.updateEmoji(BUILD, { authority, id, changes })
	return { ...h, add, set }
}

const entity = (shortcode: string, url: string) => ({ shortcode, url, static_url: url, visible_in_picker: true })

function path(uri: string): string {
	return new URL(uri).pathname
}

describe('GET /api/v1/custom_emojis', () => {
	it('lists enabled emoji shown in the picker to anyone, in shortcode order, category only when valid', async () => {
		const h = await emojiHarness()
		const zeta = await h.add('zeta', { category: 'Greek' })
		const alpha = await h.add('alpha')
		await h.add('hidden', { visibleInPicker: false })
		const off = await h.add('off')
		await h.set(off.id, { disabled: true })
		const response = await h.request('/api/v1/custom_emojis')
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual([
			entity('alpha', alpha.url),
			{ ...entity('zeta', zeta.url), category: 'Greek' },
		])
	})

	it('omits an imported category of malformed UTF-8 past the bound as decoded, and shows a shorter one', async () => {
		const h = await emojiHarness()
		const long = await h.add('long')
		const short = await h.add('short')
		// 64 SQLite characters and 192 bytes pass the CHECK; decoded, they are 192 U+FFFD (576 bytes).
		await sql(
			h.store,
			`UPDATE custom_emojis SET category = CAST(X'${'EDA080'.repeat(64)}' AS TEXT) WHERE id = ?`,
			long.id
		)
		await sql(h.store, "UPDATE custom_emojis SET category = CAST(X'EDA080' AS TEXT) WHERE id = ?", short.id)
		const list = await (await h.request('/api/v1/custom_emojis')).json<Record<string, unknown>[]>()
		expect(list).toEqual([entity('long', long.url), { ...entity('short', short.url), category: '�'.repeat(3) }])
		for (const item of list) {
			expect(new TextEncoder().encode(JSON.stringify(item)).length + 1).toBeLessThanOrEqual(1489)
		}
		const admin = await h.store.adminEmojis(BUILD, {})
		expect(admin.emojis.map((e) => e.category)).toEqual([null, '�'.repeat(3)])
	})

	it('answers 1,000 entries at their bounds within 1,489,001 UTF-8 bytes, 1,489 each with its separator', async () => {
		const h = await emojiHarness()
		const [admin] = await sql<{ id: string }>(h.store, "SELECT id FROM accounts WHERE username = 'admin'")
		// Imported rows: shortcodes of 128, urls of 512 (EMOJI_URL_LIMIT) and categories of 64 four-byte code points.
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO media_attachments (id, account_id, type, url, file_token, content_type, meta, processed)
			SELECT CAST(160000000000000000 + i AS TEXT), ?2, 'image',
				substr('https://kopje.test/media/' || printf('%04d', i) || '/' || ?3, 1, 512), printf('tok%029d', i),
				'image/png', '{"original":{"width":1,"height":1}}', 1 FROM n`,
			MAX_ENABLED_EMOJIS,
			admin!.id,
			'x'.repeat(600)
		)
		await sql(
			h.store,
			`INSERT INTO custom_emojis (id, shortcode, category, created_at)
			SELECT id, substr(printf('%04d', CAST(id AS INTEGER) - 160000000000000000) || ?1, 1, 128), ?2,
				'2026-10-12T00:00:00.000Z' FROM media_attachments`,
			'x'.repeat(200),
			'\u{1F600}'.repeat(64)
		)
		const body = new Uint8Array(await (await h.request('/api/v1/custom_emojis')).arrayBuffer())
		const list = JSON.parse(new TextDecoder().decode(body)) as unknown[]
		expect(list).toHaveLength(1000)
		expect(body.length).toBe(1_489_001)
	}, 60_000)
})

describe('local emoji snapshots', () => {
	it('snapshots enabled emoji a post references, unlisted ones too, and its poll shows the subset', async () => {
		const h = await emojiHarness()
		const blob = await h.add('blob')
		const quiet = await h.add('quiet', { visibleInPicker: false })
		const off = await h.add('off')
		await h.set(off.id, { disabled: true })
		const status = await post(h, h.users.bob, {
			status: ':blob: :quiet: :off: :missing:',
			spoiler_text: ':quiet:',
			poll: { options: [':blob:', 'plain'], expires_in: 3600 },
		})
		// In order of first occurrence: the content warning, then the text.
		expect(status.emojis).toEqual([entity('quiet', quiet.url), entity('blob', blob.url)])
		expect((status.poll as { emojis: unknown }).emojis).toEqual([entity('blob', blob.url)])
		const boost = await h.request(
			`/api/v1/statuses/${status.id}/reblog`,
			bearer(h.users.admin.token, { method: 'POST' })
		)
		const boosted = await boost.json<{ emojis: unknown; reblog: { emojis: unknown } }>()
		expect(boosted.emojis).toEqual([])
		expect(boosted.reblog.emojis).toEqual(status.emojis)
	})

	it('keeps what was posted after a disable or a replace, and an edit takes the current emoji, history kept', async () => {
		const h = await emojiHarness()
		const first = await h.add('blob')
		const status = await post(h, h.users.bob, { status: 'hi :blob:' })
		const second = await h.add('blob', { replace: true })
		const shown = await getJson<{ emojis: unknown }>(h, `/api/v1/statuses/${status.id}`, h.users.bob.token)
		expect(shown.body.emojis).toEqual([entity('blob', first.url)])
		await h.set(second.id, { disabled: true })
		const edited = await h.request(
			`/api/v1/statuses/${status.id}`,
			bearer(h.users.bob.token, json({ status: 'edited :blob:' }, { method: 'PUT' }))
		)
		expect((await edited.json<{ emojis: unknown }>()).emojis).toEqual([])
		await h.set(second.id, { disabled: false })
		const again = await h.request(
			`/api/v1/statuses/${status.id}`,
			bearer(h.users.bob.token, json({ status: 'again :blob:' }, { method: 'PUT' }))
		)
		expect((await again.json<{ emojis: unknown }>()).emojis).toEqual([entity('blob', second.url)])
		const history = await getJson<{ emojis: unknown }[]>(h, `/api/v1/statuses/${status.id}/history`)
		expect(history.body.map((version) => version.emojis)).toEqual([
			[entity('blob', first.url)],
			[],
			[entity('blob', second.url)],
		])
	})

	it('snapshots a scheduled post when it is published, and a profile on every save', async () => {
		const h = await emojiHarness()
		const blob = await h.add('blob')
		const scheduled = await h.request(
			'/api/v1/statuses',
			bearer(h.users.bob.token, json({ status: 'later :blob:', scheduled_at: new Date(NOW + HOUR).toISOString() }))
		)
		expect(scheduled.status).toBe(200)
		await publishScheduled(h.env, {
			build: () => BUILD,
			now: () => NOW + 2 * HOUR,
			store: () => h.store,
			doorbell: vi.fn(() => Promise.resolve()),
		})
		const [published] = await sql<{ emojis: string | null }>(
			h.store,
			"SELECT emojis FROM statuses WHERE source_text = 'later :blob:'"
		)
		expect(published?.emojis).toBe(JSON.stringify([['blob', blob.url]]))
		const save = (body: Record<string, unknown>) =>
			h.request('/api/v1/accounts/update_credentials', bearer(h.users.bob.token, json(body, { method: 'PATCH' })))
		const saved = await (await save({ display_name: 'Bob :blob:', note: 'n' })).json<{ emojis: unknown }>()
		expect(saved.emojis).toEqual([entity('blob', blob.url)])
		await h.set(blob.id, { disabled: true })
		expect((await (await save({ note: 'again' })).json<{ emojis: unknown }>()).emojis).toEqual([])
	})
})

// Misskey's isEmoji (packages/backend/src/core/activitypub/type.ts:254-255): an Emoji with one icon that has a url.
function misskeyEmoji(object: Record<string, unknown>): boolean {
	const icon = object.icon as { url?: unknown } | unknown[] | undefined
	return object.type === 'Emoji' && icon !== undefined && !Array.isArray(icon) && icon.url != null
}

describe('outbound Emoji tags', () => {
	it('tags the Create, the Update and the served Note, with toot:Emoji only when there are tags', async () => {
		const h = await emojiHarness()
		const fan = await remoteAccount(h.store, 'fan', 'fans.example')
		await remoteFollows(h.store, fan, h.users.bob.id)
		const blob = await h.add('blob')
		const tag = {
			id: `https://kopje.test/emojis/${blob.id}`,
			type: 'Emoji',
			name: ':blob:',
			updated: blob.created_at,
			icon: { type: 'Image', mediaType: 'image/png', url: blob.url },
		}
		const plain = await post(h, h.users.bob, { status: 'plain' })
		const tagged = await post(h, h.users.bob, { status: ':blob: hi' })
		await h.request(
			`/api/v1/statuses/${tagged.id}`,
			bearer(h.users.bob.token, json({ status: ':blob: edited' }, { method: 'PUT' }))
		)
		const sent = await outbound(h.store)
		const [createPlain, createTagged, update] = sent.map((row) => row.activity as Record<string, unknown>)
		const context = (activity: Record<string, unknown> | undefined) =>
			(activity?.['@context'] as [string, Record<string, unknown>])[1]
		expect(context(createPlain)).not.toHaveProperty('Emoji')
		expect(context(createTagged)).toMatchObject({ toot: 'http://joinmastodon.org/ns#', Emoji: 'toot:Emoji' })
		expect(update?.type).toBe('Update')
		for (const activity of [createTagged, update]) {
			const tags = (activity?.object as { tag: Record<string, unknown>[] }).tag
			expect(tags.filter((t) => t.type === 'Emoji')).toEqual([tag])
			expect(tags.filter((t) => misskeyEmoji(t))).toHaveLength(1)
			expect(emojiCandidates(tags)).toEqual([{ shortcode: 'blob', url: blob.url }])
		}
		// The served Note, through Fedify 2.4.4's Note.fromJsonLd, keeps the tag.
		const served = await (await h.request(path(tagged.uri as string), AP)).json<Record<string, unknown>>()
		const servedTags = served.tag as Record<string, unknown>[]
		expect(servedTags.filter((t) => t.type === 'Emoji')).toEqual([
			expect.objectContaining({ id: tag.id, name: ':blob:', icon: expect.objectContaining({ url: blob.url }) }),
		])
		expect(emojiCandidates(servedTags)).toEqual([{ shortcode: 'blob', url: blob.url }])
		const servedPlain = await (await h.request(path(plain.uri as string), AP)).json<Record<string, unknown>>()
		expect(JSON.stringify(servedPlain)).not.toContain('Emoji')
	})

	it('tags the actor and its Update(Person) alike, and a suspended actor shows none', async () => {
		const t = await setup()
		await setAccess(t.store, { admin_email: 'alice@mail.example' })
		const blob = await added(t.store, 'blob', { authority: { ...ACCESS, email: 'alice@mail.example' } })
		const fan = await remoteAccount(t.store, 'fan', 'fans.example')
		await remoteFollows(t.store, fan, ALICE)
		const saved = await t.request(
			'/api/v1/accounts/update_credentials',
			bearer(t.tokens.alice, json({ display_name: ':blob: Alice' }, { method: 'PATCH' }))
		)
		expect(saved.status).toBe(200)
		const update = (await outbound(t.store)).find((row) => row.activity.type === 'Update')
		const updateTags = (update?.activity.object as Record<string, unknown>).tag as Record<string, unknown>[]
		expect(updateTags).toEqual([
			{
				id: `https://kopje.test/emojis/${blob.id}`,
				type: 'Emoji',
				name: ':blob:',
				updated: blob.created_at,
				icon: { type: 'Image', mediaType: 'image/png', url: blob.url },
			},
		])
		const actor = await (await t.request('/ap/users/alice', AP)).json<Record<string, unknown>>()
		const actorTags = (Array.isArray(actor.tag) ? actor.tag : [actor.tag]) as Record<string, unknown>[]
		expect(actorTags).toEqual([
			expect.objectContaining({ id: updateTags[0]!.id, type: 'Emoji', name: ':blob:', updated: expect.any(String) }),
		])
		expect(emojiCandidates(actorTags)).toEqual(emojiCandidates(updateTags))
		expect(actorTags.every(misskeyEmoji)).toBe(true)
		await sql(
			t.store,
			"UPDATE local_accounts SET suspended_at = '2026-10-12T00:00:00.000Z' WHERE account_id = ?",
			ALICE
		)
		const suspended = await (await t.request('/ap/users/alice', AP)).json<Record<string, unknown>>()
		expect(suspended.tag).toBeUndefined()
	})
})

describe('GET /emojis/:id', () => {
	it('serves enabled and disabled local emoji, cached for three minutes, and 404 for anything else', async () => {
		const h = await emojiHarness()
		const on = await h.add('on')
		const off = await h.add('off')
		await h.set(off.id, { disabled: true })
		for (const emoji of [on, off]) {
			const response = await h.request(`/emojis/${emoji.id}`)
			expect(response.status).toBe(200)
			expect(response.headers.get('content-type')).toBe('application/activity+json')
			expect(response.headers.get('cache-control')).toBe('public, max-age=180')
			expect(await response.json()).toEqual({
				'@context': [
					'https://www.w3.org/ns/activitystreams',
					{ toot: 'http://joinmastodon.org/ns#', Emoji: 'toot:Emoji' },
				],
				id: `https://kopje.test/emojis/${emoji.id}`,
				type: 'Emoji',
				name: `:${emoji.shortcode}:`,
				updated: emoji.created_at,
				icon: { type: 'Image', mediaType: 'image/png', url: emoji.url },
			})
		}
		for (const missing of ['123456789012345678', 'abc', `${on.id}0`, '']) {
			expect((await h.request(`/emojis/${missing}`)).status).toBe(404)
		}
	})
})

describe('actor Emoji tags at their bound (RES-3)', () => {
	it('resolves an account snapshot of 6,144 presented bytes to tags of at most 8,960 bytes', async () => {
		const t = await setup()
		const snapshot = await localSnapshotAtCap(t.store, ALICE, ACCOUNT_EMOJIS_BYTES)
		expect(presentedEmojiBytes(JSON.parse(snapshot) as [string, string][])).toBe(ACCOUNT_EMOJIS_BYTES)
		await sql(t.store, 'UPDATE accounts SET emojis = ? WHERE id = ?', snapshot, ALICE)
		const measured = await runInDurableObject(t.store, (_instance, state) => {
			const document = actorDocument(new Db(state.storage.sql), ALICE)!
			const tags = document.tag as unknown[]
			return { tags: tags.length, bytes: jsonBytes(tags), document: jsonBytes(document) }
		})
		expect(measured.bytes).toBeLessThanOrEqual(8_960)
		expect(measured).toEqual({ tags: 30, bytes: 7_404, document: 9_005 })
	})
})
