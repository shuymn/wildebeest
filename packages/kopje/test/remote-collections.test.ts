import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { inboxDeps, NOW } from './app-helpers'
import { BUILD } from './helpers'
import { MASTODON, mastodonActor, type TestActor } from './inbox-helpers'
import {
	ALICE,
	AS,
	create,
	DAVE,
	followed,
	mastodonNote,
	nextId,
	OTHER,
	PUBLIC,
	remove,
	type Setup,
	setup,
} from './inbox-status-helpers'
import { MAX_FEATURED_TAGS } from '../src/domain/featured-tags'
import { MAX_REMOTE_PINS } from '../src/domain/remote-collections'
import { MAX_FEATURED_TAG_PAGES, syncCollections } from '../src/federation/collections'

// A remote account's pinned statuses, featured hashtags and hide_collections (Mastodon 4.5's ActivityPub::Activity::Add
// and Remove, FetchFeaturedCollectionService, FetchFeaturedTagsCollectionService and
// ProcessAccountService#set_fetchable_attributes!): learned from Add and Remove and from its collections, and shown by
// the profile endpoints through the same rules as a local account's.

type Status = { id: string; uri: string }
type FeaturedTag = { name: string; statuses_count: string; last_status_at: string | null }
type Account = { id: string; hide_collections: boolean | null }

function featuredOf(actor: TestActor): string {
	return `${actor.uri}/collections/featured`
}

function addOrRemove(type: 'Add' | 'Remove', actor: TestActor, object: unknown, target = featuredOf(actor)) {
	return {
		'@context': AS,
		id: `${actor.uri}#${type.toLowerCase()}-${nextId()}`,
		type,
		actor: actor.uri,
		target,
		object,
	}
}

function hashtag(name: string) {
	return { type: 'Hashtag', href: `${MASTODON}/tags/${name.toLowerCase()}`, name: `#${name}` }
}

async function pinned(t: Setup, accountId: string, as: 'alice' | 'dave' | null): Promise<string[]> {
	const response = await t.api<Status[]>(`/api/v1/accounts/${accountId}/statuses?pinned=true`, as)
	expect(response.status).toBe(200)
	return response.body.map((status) => status.uri)
}

async function featuredTags(t: Setup, accountId: string): Promise<FeaturedTag[]> {
	const response = await t.api<FeaturedTag[]>(`/api/v1/accounts/${accountId}/featured_tags`, null)
	expect(response.status).toBe(200)
	return response.body
}

const rows = (t: Setup, table: string) => sql<{ n: number }>(t.store, `SELECT count(*) AS n FROM ${table}`)

// A round of jobs' syncs, as the Queue's and cron's rounds run them, until none waits.
async function sync(t: Setup): Promise<void> {
	const deps = inboxDeps(() => t.store, t.web.loader)
	for (let round = 0; round < 5 && (await syncCollections(t.env, deps)); round++) {
		// Another sync waits.
	}
	expect(await rows(t, 'collection_syncs')).toEqual([{ n: 0 }])
}

describe('learning a remote account’s collections from Add and Remove', () => {
	it('pins and unpins its statuses and features its hashtags, shown with the audience rules', async () => {
		const clock = { now: NOW }
		const t = await setup(clock)
		const bob = await mastodonActor(t.web, 'bob')
		const bobId = await followed(t, bob)
		const open = mastodonNote(bob, { tag: [hashtag('Cats')] })
		const followersOnly = mastodonNote(bob, { to: [`${bob.uri}/followers`], cc: [] })
		expect(await t.post(bob, create(bob, open))).toBe(202)
		expect(await t.post(bob, create(bob, followersOnly))).toBe(202)

		expect(await t.post(bob, addOrRemove('Add', bob, open.id))).toBe(202)
		clock.now += 1000
		expect(await t.post(bob, addOrRemove('Add', bob, followersOnly.id))).toBe(202)
		expect(await t.post(bob, addOrRemove('Add', bob, hashtag('Cats')))).toBe(202)
		// Mastodon sends a featured hashtag's Add to the featured collection; Kopje also takes it to featuredTags.
		expect(await t.post(bob, addOrRemove('Add', bob, hashtag('Dogs'), `${bob.uri}/collections/tags`))).toBe(202)

		// Newest pin first. The followers-only pin is shown to alice, who follows bob, and to nobody else.
		expect(await pinned(t, bobId, 'alice')).toEqual([followersOnly.id, open.id])
		expect(await pinned(t, bobId, 'dave')).toEqual([open.id])
		expect(await pinned(t, bobId, null)).toEqual([open.id])
		// Counted from the statuses Kopje has, as FeaturedTag#reset_data counts them.
		expect(await featuredTags(t, bobId)).toEqual([
			expect.objectContaining({ name: 'Cats', statuses_count: '1', last_status_at: '2026-10-11' }),
			expect.objectContaining({ name: 'Dogs', statuses_count: '0', last_status_at: null }),
		])

		// A later status with a featured hashtag counts, and its deletion uncounts it (RemoveStatusService).
		const later = mastodonNote(bob, { tag: [hashtag('cats')], published: '2026-10-11T13:00:00Z' })
		expect(await t.post(bob, create(bob, later))).toBe(202)
		expect((await featuredTags(t, bobId))[0]).toMatchObject({ statuses_count: '2' })
		expect(await t.post(bob, remove(bob, later.id))).toBe(202)
		expect((await featuredTags(t, bobId))[0]).toMatchObject({ statuses_count: '1', last_status_at: '2026-10-11' })

		expect(await t.post(bob, addOrRemove('Remove', bob, open.id))).toBe(202)
		expect(await t.post(bob, addOrRemove('Remove', bob, hashtag('cats')))).toBe(202)
		expect(await pinned(t, bobId, 'alice')).toEqual([followersOnly.id])
		expect((await featuredTags(t, bobId)).map((tag) => tag.name)).toEqual(['Dogs'])
	})

	it('links a featured hashtag to the remote account, never to a local one of the same username', async () => {
		const t = await setup()
		// A remote alice, and the local alice, each featuring #cats.
		const remoteAlice = await mastodonActor(t.web, 'alice')
		const remoteId = await followed(t, remoteAlice, DAVE)
		expect(await t.post(remoteAlice, addOrRemove('Add', remoteAlice, hashtag('cats')))).toBe(202)
		const local = await t.request('/api/v1/featured_tags', {
			method: 'POST',
			headers: { authorization: `Bearer ${t.tokens.alice}`, 'content-type': 'application/json' },
			body: JSON.stringify({ name: 'cats' }),
		})
		expect(local.status).toBe(200)
		const [remoteUrl] = (await featuredTags(t, remoteId)).map((tag) => (tag as FeaturedTag & { url: string }).url)
		const [localUrl] = (await featuredTags(t, ALICE)).map((tag) => (tag as FeaturedTag & { url: string }).url)
		expect(remoteUrl).toBe('https://kopje.test/@alice@mastodon.example/tagged/cats')
		expect(localUrl).toBe('https://kopje.test/@alice/tagged/cats')
		// The remote one leads to the remote profile; the local one is the local page.
		const remote = await t.request(new URL(remoteUrl!).pathname)
		expect([remote.status, remote.headers.get('location')]).toEqual([302, `${MASTODON}/@alice`])
		expect((await t.request(new URL(localUrl!).pathname)).status).toBe(200)
		expect((await t.request('/@nobody@mastodon.example/tagged/cats')).status).toBe(404)
	})

	it('fetches a status it does not have yet, for an actor with local followers', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const bobId = await followed(t, bob)
		const note = mastodonNote(bob)
		t.web.serve(note.id, { '@context': AS, ...note })
		expect(await t.post(bob, addOrRemove('Add', bob, note.id))).toBe(202)
		expect(await pinned(t, bobId, null)).toEqual([note.id])
	})

	it('ignores a forged Add: another actor’s, to a collection on another host, of another account’s status', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const mallory = await mastodonActor(t.web, 'mallory', { key: 2 })
		const bobId = await followed(t, bob)
		const malloryId = await followed(t, mallory)
		const bobs = mastodonNote(bob)
		const mallorys = mastodonNote(mallory)
		expect(await t.post(bob, create(bob, bobs))).toBe(202)
		expect(await t.post(mallory, create(mallory, mallorys))).toBe(202)

		// Mallory adds bob's status to bob's collection, or to her own.
		expect(await t.post(mallory, addOrRemove('Add', mallory, bobs.id, featuredOf(bob)))).toBe(202)
		expect(await t.post(mallory, addOrRemove('Add', mallory, bobs.id))).toBe(202)
		expect(await t.post(mallory, addOrRemove('Add', mallory, hashtag('Cats'), featuredOf(bob)))).toBe(202)
		// Bob adds to a collection on another host, or one his document does not name.
		expect(await t.post(bob, addOrRemove('Add', bob, bobs.id, `${OTHER}/users/bob/collections/featured`))).toBe(202)
		expect(await t.post(bob, addOrRemove('Add', bob, bobs.id, `${bob.uri}/collections/other`))).toBe(202)
		expect(await t.post(bob, addOrRemove('Add', bob, hashtag('Cats'), `${OTHER}/tags`))).toBe(202)
		// Bob adds mallory's status (on his own host) to his own collection, and a hashtag that is not a valid name.
		expect(await t.post(bob, addOrRemove('Add', bob, mallorys.id))).toBe(202)
		expect(await t.post(bob, addOrRemove('Add', bob, { type: 'Hashtag', name: '#not a tag' }))).toBe(202)

		expect(await rows(t, 'status_pins')).toEqual([{ n: 0 }])
		expect(await rows(t, 'featured_tags')).toEqual([{ n: 0 }])
		expect(await pinned(t, bobId, 'alice')).toEqual([])
		expect(await pinned(t, malloryId, 'alice')).toEqual([])

		// Mallory removes bob's pin: it stays.
		expect(await t.post(bob, addOrRemove('Add', bob, bobs.id))).toBe(202)
		expect(await t.post(mallory, addOrRemove('Remove', mallory, bobs.id, featuredOf(bob)))).toBe(202)
		expect(await t.post(mallory, addOrRemove('Remove', mallory, bobs.id))).toBe(202)
		expect(await pinned(t, bobId, 'alice')).toEqual([bobs.id])
	})

	it('keeps at most MAX_REMOTE_PINS pins and MAX_FEATURED_TAGS hashtags', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const bobId = await followed(t, bob)
		const notes = Array.from({ length: MAX_REMOTE_PINS + 2 }, () => mastodonNote(bob))
		for (const note of notes) {
			expect(await t.post(bob, create(bob, note))).toBe(202)
			expect(await t.post(bob, addOrRemove('Add', bob, note.id))).toBe(202)
		}
		for (let i = 0; i < MAX_FEATURED_TAGS + 2; i++) {
			expect(await t.post(bob, addOrRemove('Add', bob, hashtag(`tag${i}`)))).toBe(202)
		}
		expect(await rows(t, 'status_pins')).toEqual([{ n: MAX_REMOTE_PINS }])
		expect((await featuredTags(t, bobId)).length).toBe(MAX_FEATURED_TAGS)
	})
})

describe('a remote account’s purge', () => {
	it('removes its pins, featured hashtags and waiting sync with it', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const bobId = await followed(t, bob)
		const note = mastodonNote(bob)
		expect(await t.post(bob, create(bob, note))).toBe(202)
		expect(await t.post(bob, addOrRemove('Add', bob, note.id))).toBe(202)
		expect(await t.post(bob, addOrRemove('Add', bob, hashtag('Cats')))).toBe(202)
		expect(await rows(t, 'collection_syncs')).toEqual([{ n: 1 }])
		const deleted = { '@context': AS, id: `${bob.uri}#delete`, type: 'Delete', actor: bob.uri, object: bob.uri }
		expect(await t.post(bob, deleted)).toBe(202)
		const deps = inboxDeps(() => t.store, t.web.loader)
		for (let round = 0; round < 5; round++) {
			await t.store.runInboundJobs(BUILD, { now: NOW })
		}
		expect(await sql(t.store, 'SELECT id FROM accounts WHERE id = ?', bobId)).toEqual([])
		for (const table of ['status_pins', 'featured_tags', 'collection_syncs']) {
			expect([table, await rows(t, table)]).toEqual([table, [{ n: 0 }]])
		}
		// Nothing is left for a round to read.
		expect(await syncCollections(t.env, deps)).toBe(false)
	})
})

describe('reading a remote account’s collections', () => {
	// Bob's featured and featuredTags collections as Mastodon 4.5 serves them.
	async function servedCollections(t: Setup, bob: TestActor, items: unknown[], tags: unknown[]) {
		t.web.serve(featuredOf(bob), {
			'@context': AS,
			id: featuredOf(bob),
			type: 'OrderedCollection',
			totalItems: items.length,
			orderedItems: items,
		})
		t.web.serve(`${bob.uri}/collections/tags`, {
			'@context': AS,
			id: `${bob.uri}/collections/tags`,
			type: 'Collection',
			totalItems: tags.length,
			items: tags,
		})
	}

	function followCollection(actor: TestActor, kind: 'followers' | 'following', shown: boolean) {
		const id = `${actor.uri}/${kind}`
		return { '@context': AS, id, type: 'OrderedCollection', totalItems: 1, ...(shown ? { first: `${id}?page=1` } : {}) }
	}

	it('learns pins, featured hashtags and hide_collections when it stores the account, and applies them', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const mallory = await mastodonActor(t.web, 'mallory', { key: 2 })
		const stored = mastodonNote(bob)
		const fetched = mastodonNote(bob, { to: [`${bob.uri}/followers`], cc: [] })
		const mallorys = mastodonNote(mallory)
		t.web.serve(fetched.id, { '@context': AS, ...fetched })
		t.web.serve(mallorys.id, { '@context': AS, ...mallorys })
		await servedCollections(
			t,
			bob,
			[stored.id, fetched, mallorys.id, `${OTHER}/users/bob/statuses/1`, { type: 'Hashtag', name: '#x' }],
			[hashtag('Cats'), hashtag('Dogs'), { type: 'Note', name: '#Birds' }, hashtag('not valid!')]
		)
		t.web.serve(`${bob.uri}/followers`, followCollection(bob, 'followers', false))
		t.web.serve(`${bob.uri}/following`, followCollection(bob, 'following', true))

		// Storing bob's document (his Follow of dave) asks for a sync, and the inbox asks the Queue for a round.
		const bobId = await followed(t, bob)
		expect(await rows(t, 'collection_syncs')).toEqual([{ n: 1 }])
		expect(t.queue.pending.map((m) => m.body)).toContainEqual({ kind: 'inbound-jobs' })
		expect(await t.post(bob, create(bob, stored))).toBe(202)
		await sync(t)

		// The collection's order is the profile's; mallory's status and one on another host are not bob's pins.
		expect(await pinned(t, bobId, 'alice')).toEqual([stored.id, fetched.id])
		expect(await pinned(t, bobId, 'dave')).toEqual([stored.id])
		expect((await featuredTags(t, bobId)).map((tag) => tag.name)).toEqual(['Cats', 'Dogs'])
		// Fetched as alice, bob's local follower (FetchFeaturedCollectionService#local_follower).
		expect(t.web.signers[t.web.fetched.indexOf(fetched.id)]).toBe('https://kopje.test/ap/users/alice#main-key')

		// His followers collection shows no items: he hides his network, from everyone but himself.
		const account = await t.api<Account>(`/api/v1/accounts/${bobId}`, 'dave')
		expect(account.body.hide_collections).toBe(true)
		expect((await t.api<Account[]>(`/api/v1/accounts/${bobId}/following`, 'dave')).body).toEqual([])
		expect((await t.api<Account[]>(`/api/v1/accounts/${bobId}/followers`, 'dave')).body).toEqual([])
		expect((await t.api<Account[]>(`/api/v1/accounts/${bobId}/followers`, null)).body).toEqual([])

		// He shows it again, unpins, and features other hashtags: the next sync follows.
		t.web.serve(`${bob.uri}/followers`, followCollection(bob, 'followers', true))
		await servedCollections(t, bob, [fetched.id], [hashtag('dogs'), hashtag('Birds')])
		const updated = { '@context': AS, id: `${bob.uri}#updates/${nextId()}`, type: 'Update', actor: bob.uri }
		expect(await t.post(bob, { ...updated, object: bob.document })).toBe(202)
		await sync(t)
		expect(await pinned(t, bobId, 'alice')).toEqual([fetched.id])
		expect((await featuredTags(t, bobId)).map((tag) => tag.name)).toEqual(['dogs', 'Birds'])
		expect((await t.api<Account>(`/api/v1/accounts/${bobId}`, 'dave')).body.hide_collections).toBe(false)
		expect((await t.api<Account[]>(`/api/v1/accounts/${bobId}/followers`, 'dave')).body.map((a) => a.id)).toEqual([
			ALICE,
		])
		expect((await t.api<Account[]>(`/api/v1/accounts/${bobId}/following`, null)).body.map((a) => a.id)).toEqual([DAVE])
	})

	it('keeps the first MAX_REMOTE_PINS items and MAX_FEATURED_TAGS hashtags of an oversized collection', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const notes = Array.from({ length: MAX_REMOTE_PINS + 10 }, () => mastodonNote(bob, { to: [PUBLIC] }))
		await servedCollections(
			t,
			bob,
			notes.map((note) => note.id),
			Array.from({ length: MAX_FEATURED_TAGS + 10 }, (_, i) => hashtag(`tag${i}`))
		)
		const bobId = await followed(t, bob)
		for (const note of notes) {
			expect(await t.post(bob, create(bob, note))).toBe(202)
		}
		await sync(t)
		expect(await pinned(t, bobId, null)).toEqual(notes.slice(0, MAX_REMOTE_PINS).map((note) => note.id))
		expect((await featuredTags(t, bobId)).map((tag) => tag.name)).toEqual(
			Array.from({ length: MAX_FEATURED_TAGS }, (_, i) => `tag${i}`)
		)
	})

	it('looks at the first MAX_REMOTE_PINS items of the featured collection only, whatever they are', async () => {
		const t = await setup()
		// No featuredTags collection: the featured collection's Hashtags are its featured hashtags.
		const bob = await mastodonActor(t.web, 'bob', { extra: { featuredTags: null } })
		const own = mastodonNote(bob)
		const late = mastodonNote(bob)
		t.web.serve(late.id, { '@context': AS, ...late })
		const foreign = Array.from({ length: MAX_REMOTE_PINS - 2 }, (_, i) => `${OTHER}/users/bob/statuses/${i}`)
		await servedCollections(t, bob, [hashtag('Early'), ...foreign, own.id, late.id, hashtag('Late')], [])
		const bobId = await followed(t, bob)
		expect(await t.post(bob, create(bob, own))).toBe(202)
		await sync(t)
		// The 20th item is pinned; the 21st is not, nor fetched, and the hashtag after it is not featured.
		expect(await pinned(t, bobId, null)).toEqual([own.id])
		expect(t.web.fetched).not.toContain(late.id)
		expect((await featuredTags(t, bobId)).map((tag) => tag.name)).toEqual(['Early'])
	})

	it('reads at most MAX_FEATURED_TAG_PAGES pages of the featuredTags collection, and never asks for the next', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await servedCollections(t, bob, [], [])
		const tags = `${bob.uri}/collections/tags`
		const pageUrl = (n: number) => `${tags}?page=${n}`
		t.web.serve(tags, { '@context': AS, id: tags, type: 'OrderedCollection', first: pageUrl(1) })
		for (let n = 1; n <= MAX_FEATURED_TAG_PAGES + 1; n++) {
			t.web.serve(pageUrl(n), {
				'@context': AS,
				id: pageUrl(n),
				type: 'OrderedCollectionPage',
				next: pageUrl(n + 1),
				orderedItems: [hashtag(`page${n}`)],
			})
		}
		const bobId = await followed(t, bob)
		await sync(t)
		expect(t.web.fetched).not.toContain(pageUrl(MAX_FEATURED_TAG_PAGES + 1))
		expect((await featuredTags(t, bobId)).map((tag) => tag.name)).toEqual(
			Array.from({ length: MAX_FEATURED_TAG_PAGES }, (_, i) => `page${i + 1}`)
		)
	})

	it('leaves what it learned as it was when a collection cannot be read for now, unless the other one hides', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const note = mastodonNote(bob)
		await servedCollections(t, bob, [note.id], [hashtag('Cats')])
		t.web.serve(`${bob.uri}/followers`, followCollection(bob, 'followers', true))
		t.web.serve(`${bob.uri}/following`, followCollection(bob, 'following', true))
		const bobId = await followed(t, bob)
		expect(await t.post(bob, create(bob, note))).toBe(202)
		await sync(t)
		expect(await pinned(t, bobId, null)).toEqual([note.id])

		t.web.fail(featuredOf(bob), 503)
		t.web.fail(`${bob.uri}/collections/tags`, 503)
		t.web.fail(`${bob.uri}/following`, 503)
		await sql(t.store, 'INSERT INTO collection_syncs (account_id, due_at) VALUES (?, 0)', bobId)
		await sync(t)
		expect(await pinned(t, bobId, null)).toEqual([note.id])
		expect((await featuredTags(t, bobId)).map((tag) => tag.name)).toEqual(['Cats'])
		expect((await t.api<Account>(`/api/v1/accounts/${bobId}`, null)).body.hide_collections).toBe(false)

		// The following collection still times out, but the followers collection now hides its items: hidden.
		t.web.serve(`${bob.uri}/followers`, followCollection(bob, 'followers', false))
		await sql(t.store, 'INSERT INTO collection_syncs (account_id, due_at) VALUES (?, 0)', bobId)
		await sync(t)
		expect((await t.api<Account>(`/api/v1/accounts/${bobId}`, null)).body.hide_collections).toBe(true)
		expect((await t.api<Account[]>(`/api/v1/accounts/${bobId}/followers`, null)).body).toEqual([])
	})
})
