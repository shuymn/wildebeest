import { describe, expect, it } from 'vitest'

import { bearer, json, sql } from './api-helpers'
import { appToken, scopedToken } from './read-helpers'
import {
	act,
	block,
	community,
	domainBlock,
	follow,
	mute,
	post,
	remoteAccount,
	seedStatus,
	type Status,
} from './status-helpers'
import type { StoreStub } from '../src/platform/store-client'

// Quotes as clients are shown them (R35, VIS-27; Mastodon 4.5's REST::StatusSerializer, BaseQuoteSerializer,
// ShallowStatusSerializer and StatusFilter#filter_state_for_quote), and the quotes list
// (Api::V1::Statuses::QuotesController#index). Quote rows are written as federation/quotes.ts leaves them.

type Quote = { state: string; quoted_status?: QuotedStatus | null; quoted_status_id?: string | null }
type QuotedStatus = Status & { quote: Quote | null; quotes_count: number }

// A stored quote of `quotedId` (null: the quoted status is gone) by the status `statusId`, in `state`; legacy: the Note
// had no `quote` property.
async function quote(
	store: StoreStub,
	statusId: string,
	quotedId: string | null,
	state: string,
	legacy = false
): Promise<void> {
	await sql(
		store,
		`INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, legacy, updated_at)
		VALUES (?1, coalesce((SELECT uri FROM statuses WHERE id = ?2), 'https://remote.example/objects/gone'), ?2,
			(SELECT account_id FROM statuses WHERE id = ?2), ?3, ?4, '2026-10-12T00:00:00.000Z')`,
		statusId,
		quotedId,
		state,
		legacy ? 1 : 0
	)
}

async function shown(
	h: { request: (path: string, init?: RequestInit) => Promise<Response> },
	id: string,
	token?: string
) {
	const response = await h.request(`/api/v1/statuses/${id}`, token === undefined ? {} : bearer(token))
	expect(response.status).toBe(200)
	return response.json<QuotedStatus>()
}

// alice and carol are local; rem and far are remote, on two domains. q quotes t (a public status of far's).
async function world() {
	const h = await community(['alice', 'carol'])
	const rem = await remoteAccount(h.store, 'rem', 'remote.example')
	const far = await remoteAccount(h.store, 'far', 'far.example')
	const t = await seedStatus(h.store, { accountId: far, visibility: 'public', content: '<p>quoted words</p>' })
	const q = await seedStatus(h.store, { accountId: rem, visibility: 'public', content: '<p>quoting</p>' })
	return { h, ...h.users, rem, far, t, q }
}

describe('Status.quote (R35)', () => {
	it('embeds an accepted quote one level deep, with quotes_count from the counter', async () => {
		const { h, alice, far, rem, t, q } = await world()
		const t2 = await seedStatus(h.store, { accountId: rem, visibility: 'public' })
		await quote(h.store, q, t, 'accepted')
		await quote(h.store, t, t2, 'accepted')
		const status = await shown(h, q, alice.token)
		expect(status.quote).toEqual({ state: 'accepted', quoted_status: expect.objectContaining({ id: t }) })
		const quoted = status.quote?.quoted_status
		// The embedded status is a full status whose own quote is a ShallowQuote: the state and the id, never the status.
		expect(quoted).toMatchObject({
			id: t,
			account: { id: far },
			content: '<p>quoted words</p>',
			quotes_count: 1,
			favourited: false,
			filtered: [],
			quote: { state: 'accepted', quoted_status_id: t2 },
		})
		expect(quoted?.quote).not.toHaveProperty('quoted_status')
		expect(status.quote).not.toHaveProperty('quoted_status_id')
		expect(status.quotes_count).toBe(0)
		// Anonymous viewers are shown it too.
		expect((await shown(h, q)).quote?.state).toBe('accepted')
	})

	it('shows each stored state, a legacy quote only once accepted, and deleted when the quoted status is gone', async () => {
		const { h, alice, rem, t } = await world()
		const cases: [string, boolean, Quote | null][] = [
			['pending', false, { state: 'pending', quoted_status: null }],
			['rejected', false, { state: 'rejected', quoted_status: null }],
			['revoked', false, { state: 'revoked', quoted_status: null }],
			['pending', true, null],
			['rejected', true, null],
			['accepted', true, { state: 'accepted', quoted_status: expect.objectContaining({ id: t }) }],
		]
		for (const [state, legacy, expected] of cases) {
			const q = await seedStatus(h.store, { accountId: rem, visibility: 'public' })
			await quote(h.store, q, t, state, legacy)
			expect({ state, legacy, quote: (await shown(h, q, alice.token)).quote }).toEqual({
				state,
				legacy,
				quote: expected,
			})
		}
		const gone = await seedStatus(h.store, { accountId: rem, visibility: 'public' })
		await quote(h.store, gone, null, 'deleted')
		expect((await shown(h, gone, alice.token)).quote).toEqual({ state: 'deleted', quoted_status: null })
		const plain = await seedStatus(h.store, { accountId: rem, visibility: 'public' })
		expect((await shown(h, plain, alice.token)).quote).toBeNull()
	})

	it('is unauthorized for a public quote of a private status the viewer may not see; the quoted author sees it accepted', async () => {
		const { h, alice, carol, rem } = await world()
		const t = (await post(h, carol, { status: 'followers only', visibility: 'private' })).id
		const q = await seedStatus(h.store, { accountId: rem, visibility: 'public' })
		await quote(h.store, q, t, 'accepted')
		expect((await shown(h, q, alice.token)).quote).toEqual({ state: 'unauthorized', quoted_status: null })
		expect((await shown(h, q)).quote).toEqual({ state: 'unauthorized', quoted_status: null })
		expect((await shown(h, q, carol.token)).quote).toEqual({
			state: 'accepted',
			quoted_status: expect.objectContaining({ id: t, content: '<p>followers only</p>' }),
		})
		// A follower may see it.
		await follow(h, alice, carol.id)
		expect((await shown(h, q, alice.token)).quote?.state).toBe('accepted')
	})

	it('shows blocked_domain before blocked_account, then muted_account, with the quoted status for the client to fold', async () => {
		const { h, alice, far, t, q } = await world()
		await quote(h.store, q, t, 'accepted')
		const state = async (token?: string) => {
			const status = await shown(h, q, token)
			return { state: status.quote?.state, id: status.quote?.quoted_status?.id ?? null }
		}
		await mute(h.store, alice.id, far)
		expect(await state(alice.token)).toEqual({ state: 'muted_account', id: t })
		await block(h.store, alice.id, far)
		expect(await state(alice.token)).toEqual({ state: 'blocked_account', id: t })
		await domainBlock(h.store, alice.id, 'far.example')
		expect(await state(alice.token)).toEqual({ state: 'blocked_domain', id: t })
		// Only a signed-in viewer filters.
		expect(await state()).toEqual({ state: 'accepted', id: t })
	})

	it('nests a ShallowQuote whose state is the embedded status’s for the same viewer', async () => {
		const { h, alice, carol, rem, t, q } = await world()
		const hidden = (await post(h, carol, { status: 'private', visibility: 'private' })).id
		await quote(h.store, q, t, 'accepted')
		await quote(h.store, t, hidden, 'accepted')
		expect((await shown(h, q, alice.token)).quote?.quoted_status?.quote).toEqual({
			state: 'unauthorized',
			quoted_status_id: null,
		})
		expect((await shown(h, q, carol.token)).quote?.quoted_status?.quote).toEqual({
			state: 'accepted',
			quoted_status_id: hidden,
		})
		// The embedded status's own quote is never embedded.
		const outer = await seedStatus(h.store, { accountId: rem, visibility: 'public' })
		await quote(h.store, outer, q, 'accepted')
		expect((await shown(h, outer, carol.token)).quote?.quoted_status?.quote).toEqual({
			state: 'accepted',
			quoted_status_id: t,
		})
	})

	it('presents a boost with its original’s quote', async () => {
		const { h, alice, rem, t, q } = await world()
		await quote(h.store, q, t, 'accepted')
		const boost = await seedStatus(h.store, { accountId: rem, visibility: 'public', reblogOfId: q })
		const status = await shown(h, boost, alice.token)
		expect(status.quote).toBeNull()
		expect((status.reblog as QuotedStatus | null)?.quote).toMatchObject({ state: 'accepted', quoted_status: { id: t } })
	})

	it('gives the embedded status its own viewer flags, filters and media', async () => {
		const { h, alice, far, t, q } = await world()
		await quote(h.store, q, t, 'accepted')
		await sql(
			h.store,
			"INSERT INTO media_attachments (id, account_id, status_id, type, url, description) VALUES ('900000000000000001', ?, ?, 'image', 'https://far.example/a.png', 'a picture')",
			far,
			t
		)
		expect((await act(h, alice, `/api/v1/statuses/${t}/favourite`)).status).toBe(200)
		const filter = await h.request(
			'/api/v2/filters',
			bearer(alice.token, json({ title: 'words', context: ['home'], keywords_attributes: [{ keyword: 'words' }] }))
		)
		expect(filter.status).toBe(200)
		const status = await shown(h, q, alice.token)
		expect(status.filtered).toEqual([])
		const quoted = status.quote?.quoted_status
		expect(quoted?.favourited).toBe(true)
		expect(quoted?.favourites_count).toBe(1)
		expect((quoted?.filtered as { keyword_matches: string[] }[]).map((f) => f.keyword_matches)).toEqual([['words']])
		expect(quoted?.media_attachments).toEqual([expect.objectContaining({ id: '900000000000000001', type: 'image' })])
	})

	it('answers DELETE with the quoted status of a quote in any state when the viewer may see it, for redrafting', async () => {
		const { h, alice, carol, t } = await world()
		const own = (await post(h, alice, { status: 'quoting', visibility: 'public' })).id
		await quote(h.store, own, t, 'rejected')
		// Shown only for the source.
		expect((await shown(h, own, alice.token)).quote).toEqual({ state: 'rejected', quoted_status: null })
		const deleted = await h.request(`/api/v1/statuses/${own}`, bearer(alice.token, { method: 'DELETE' }))
		expect(deleted.status).toBe(200)
		expect((await deleted.json<QuotedStatus>()).quote).toMatchObject({ state: 'rejected', quoted_status: { id: t } })
		// Never a status the viewer may not see.
		const hidden = (await post(h, carol, { status: 'private', visibility: 'private' })).id
		const other = (await post(h, alice, { status: 'quoting again', visibility: 'public' })).id
		await quote(h.store, other, hidden, 'revoked')
		const again = await h.request(`/api/v1/statuses/${other}`, bearer(alice.token, { method: 'DELETE' }))
		expect((await again.json<QuotedStatus>()).quote).toEqual({ state: 'revoked', quoted_status: null })
	})
})

describe('client shapes', () => {
	// What Phanpy (src/utils/states.js: `status.reblog?.quote || status.quote`, then quotedStatus.id and .account),
	// Elk (StatusQuote.vue: a ShallowQuote is one with a quotedStatusId key, a Quote one without; the quote is drawn
	// from quotedStatus) and Ice Cubes (Models/Quote.swift: state, quoted_status decoded as a Status with its
	// non-optional fields) read.
	it('serves the keys each client tells the two quote shapes apart by, and a decodable embedded status', async () => {
		const { h, alice, rem, t, q } = await world()
		const t2 = await seedStatus(h.store, { accountId: rem, visibility: 'public' })
		await quote(h.store, q, t, 'accepted')
		await quote(h.store, t, t2, 'pending')
		const status = await shown(h, q, alice.token)
		const full = status.quote as Record<string, unknown>
		expect(Object.keys(full).sort()).toEqual(['quoted_status', 'state'])
		const embedded = full.quoted_status as Record<string, unknown>
		expect(Object.keys(embedded.quote as object).sort()).toEqual(['quoted_status_id', 'state'])
		expect(embedded.quote).toEqual({ state: 'pending', quoted_status_id: null })
		// Ice Cubes' Status: every non-optional field.
		for (const key of [
			'id',
			'content',
			'account',
			'created_at',
			'media_attachments',
			'mentions',
			'replies_count',
			'reblogs_count',
			'favourites_count',
			'emojis',
			'visibility',
			'spoiler_text',
			'sensitive',
			'tags',
		]) {
			expect(embedded[key], key).not.toBeUndefined()
			expect(embedded[key], key).not.toBeNull()
		}
		expect(embedded.account).toMatchObject({ id: expect.any(String), acct: 'far@far.example' })
		// Phanpy and Ice Cubes read quotes_count.
		expect(embedded.quotes_count).toBe(1)
	})
})

describe('GET /api/v1/statuses/:id/quotes', () => {
	async function list(h: Awaited<ReturnType<typeof world>>['h'], path: string, token: string) {
		const response = await h.request(path, bearer(token))
		const body = await response.json<{ id: string }[] | { error: string }>()
		return {
			status: response.status,
			ids: Array.isArray(body) ? body.map((s) => s.id) : body,
			link: response.headers.get('Link'),
		}
	}

	it('lists the accepted quotes newest first, paged by the quoting status, and filters them for all but the quoted author', async () => {
		const { h, alice, carol, rem, far } = await world()
		const t = (await post(h, carol, { status: 'quote me', visibility: 'public' })).id
		const quotes: string[] = []
		for (let i = 0; i < 5; i++) {
			const q = await seedStatus(h.store, { accountId: i === 2 ? far : rem, visibility: 'public' })
			await quote(h.store, q, t, 'accepted')
			quotes.push(q)
		}
		const pending = await seedStatus(h.store, { accountId: rem, visibility: 'public' })
		await quote(h.store, pending, t, 'pending')
		const newest = [...quotes].reverse()
		expect(await list(h, `/api/v1/statuses/${t}/quotes`, alice.token)).toMatchObject({ status: 200, ids: newest })
		const first = await list(h, `/api/v1/statuses/${t}/quotes?limit=2`, alice.token)
		expect(first.ids).toEqual(newest.slice(0, 2))
		expect(first.link).toContain(`max_id=${newest[1]}`)
		expect((await list(h, `/api/v1/statuses/${t}/quotes?limit=2&max_id=${newest[1]}`, alice.token)).ids).toEqual(
			newest.slice(2, 4)
		)
		expect((await list(h, `/api/v1/statuses/${t}/quotes?limit=2&min_id=${newest[2]}`, alice.token)).ids).toEqual(
			newest.slice(0, 2)
		)
		// alice blocks far: its quote leaves alice's list (R8); carol, the quoted author, still lists it (R2).
		await block(h.store, alice.id, far)
		await block(h.store, carol.id, far)
		expect((await list(h, `/api/v1/statuses/${t}/quotes`, alice.token)).ids).toEqual(
			newest.filter((id) => id !== quotes[2])
		)
		expect((await list(h, `/api/v1/statuses/${t}/quotes`, carol.token)).ids).toEqual(newest)
	})

	it('answers 404 for a status the viewer may not see, and needs a token with read:statuses', async () => {
		const { h, alice, carol } = await world()
		const hidden = (await post(h, carol, { status: 'private', visibility: 'private' })).id
		expect((await list(h, `/api/v1/statuses/${hidden}/quotes`, alice.token)).status).toBe(404)
		expect((await list(h, `/api/v1/statuses/${hidden}/quotes`, carol.token)).status).toBe(200)
		expect((await h.request(`/api/v1/statuses/${hidden}/quotes`)).status).toBe(401)
		expect((await list(h, `/api/v1/statuses/${hidden}/quotes`, await scopedToken(h, 'read:accounts'))).status).toBe(403)
	})

	it('reads an app token as an anonymous viewer, as Mastodon requires no user', async () => {
		const { h, alice, carol, rem, far } = await world()
		const t = (await post(h, carol, { status: 'quote me', visibility: 'public' })).id
		const open = await seedStatus(h.store, { accountId: rem, visibility: 'public' })
		const followers = await seedStatus(h.store, { accountId: far, visibility: 'private' })
		const blocked = await seedStatus(h.store, { accountId: far, visibility: 'public' })
		for (const q of [open, followers, blocked]) {
			await quote(h.store, q, t, 'accepted')
		}
		await follow(h, alice, far)
		await sql(
			h.store,
			"UPDATE follows SET state = 'accepted' WHERE account_id = ? AND target_account_id = ?",
			alice.id,
			far
		)
		const app = await appToken(h)
		// Anonymous: neither the followers-only quote nor a filter of alice's applies.
		expect(await list(h, `/api/v1/statuses/${t}/quotes`, app)).toMatchObject({ status: 200, ids: [blocked, open] })
		await block(h.store, alice.id, rem)
		expect((await list(h, `/api/v1/statuses/${t}/quotes`, alice.token)).ids).toEqual([blocked, followers])
		// A status an anonymous viewer may not see is not found.
		const hidden = (await post(h, carol, { status: 'private', visibility: 'private' })).id
		expect((await list(h, `/api/v1/statuses/${hidden}/quotes`, app)).status).toBe(404)
	})
})
