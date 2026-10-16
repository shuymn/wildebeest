import type { DocumentLoader } from '@fedify/fedify'

import { createRemoteLoaders, type FederationState } from './federation'
import type { InboxDeps } from './inbox'
import { isTransientLoadError, requestBudget } from './loader'
import { fetchRemoteStatus, idOf } from './remote-status'
import { MAX_FEATURED_TAGS } from '../domain/featured-tags'
import { type CollectionSync, type CollectionSyncInput, MAX_REMOTE_PINS } from '../domain/remote-collections'
import type { RemoteStatusInput } from '../domain/remote-statuses'
import { readConfig, userKek } from '../platform/config'
import { callStore } from '../platform/store-client'

// The Worker's part of a sync of a remote account's collections (domain/remote-collections.ts): what Mastodon's
// FetchFeaturedCollectionService, FetchFeaturedTagsCollectionService and ProcessAccountService#collection_info fetch,
// read through the safe loader (NET-1) within one request's fetch budget per account (RES-6), signed by a local
// follower of the account or else by the instance actor (as Mastodon signs with local_follower), and never from the
// signed-document cache (NET-4). The jobs/queue.ts rounds run it after the Store's inbound jobs.
//
// Differences from Mastodon: a collection is read only on the actor's own origin (Mastodon checks the host for the
// featured collections only); the featured collection's items are read up to MAX_REMOTE_PINS; a fetch that may pass
// (a timeout, a 5xx, the budget) leaves that part as it was, where Mastodon retries the job or, for hide_collections,
// reads the failure as a hidden collection.

// Syncs one round runs, each with its own fetch budget.
export const COLLECTION_SYNCS_PER_ROUND = 2
// Pages of a featuredTags collection read at most (FetchFeaturedTagsCollectionService reads pages until it has
// FeaturedTag::LIMIT items or there is no next page; the budget bounds it too).
export const MAX_FEATURED_TAG_PAGES = 4

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function originOf(uri: string | null): string | null {
	if (uri === null) {
		return null
	}
	try {
		return new URL(uri).origin
	} catch {
		return null
	}
}

// A document on `origin` (Mastodon's non_matching_uri_hosts? refusal): the object, 'transient' when fetching again may
// succeed, or null (refused, gone, not an object, or on another origin). An embedded object is taken as it is.
async function documentOn(
	value: unknown,
	origin: string | null,
	loader: DocumentLoader
): Promise<Json | 'transient' | null> {
	if (isObject(value)) {
		return value
	}
	if (typeof value !== 'string' || origin === null || originOf(value) !== origin) {
		return null
	}
	try {
		const document = (await loader(value)).document
		return isObject(document) ? document : null
	} catch (error) {
		return isTransientLoadError(error) ? 'transient' : null
	}
}

// A collection page's items (Collection and CollectionPage: items; the ordered ones: orderedItems), or null for
// anything else.
function itemsOf(collection: Json): unknown[] | null {
	const items =
		collection.type === 'Collection' || collection.type === 'CollectionPage'
			? collection.items
			: collection.type === 'OrderedCollection' || collection.type === 'OrderedCollectionPage'
				? collection.orderedItems
				: undefined
	return items === undefined ? null : Array.isArray(items) ? items : items === null ? [] : [items]
}

function hashtagNames(items: readonly unknown[]): string[] {
	return items.flatMap((item) =>
		isObject(item) && item.type === 'Hashtag' && typeof item.name === 'string' ? [item.name] : []
	)
}

// ProcessAccountService#collection_info: whether the collection shows its items (a first page). An actor without the
// collection, or whose collection is not a readable object, hides it, as Mastodon reads it; undefined when the fetch
// may pass.
async function showsItems(
	url: string | null,
	origin: string | null,
	loader: DocumentLoader
): Promise<boolean | undefined> {
	const collection = await documentOn(url, origin, loader)
	if (collection === 'transient') {
		return undefined
	}
	return collection !== null && collection.first !== undefined && collection.first !== null
}

// hide_collections = following_private? || followers_private?, the followers not read once the following hides.
async function hidesCollections(sync: CollectionSync, origin: string | null, loader: DocumentLoader) {
	const following = await showsItems(sync.following, origin, loader)
	if (following === false) {
		return true
	}
	const followers = await showsItems(sync.followers, origin, loader)
	return following === undefined || followers === undefined ? null : !followers
}

// FetchFeaturedCollectionService: the first MAX_REMOTE_PINS items of the first page, or null when it cannot be read.
// Among them, Notes (or ids) of the actor's origin are its pins, and Hashtags its featured hashtags when it has no
// featuredTags collection. The items past them are never looked at, whatever they are.
async function readFeatured(
	sync: CollectionSync,
	origin: string | null,
	loader: DocumentLoader
): Promise<{ uris: string[]; hashtags: string[] } | null> {
	const collection = await documentOn(sync.featured, origin, loader)
	if (collection === null || collection === 'transient') {
		return null
	}
	const page = collection.first === undefined ? collection : await documentOn(collection.first, origin, loader)
	const items = page === null || page === 'transient' ? null : (itemsOf(page)?.slice(0, MAX_REMOTE_PINS) ?? null)
	if (items === null) {
		return null
	}
	const uris = [
		...new Set(
			items.flatMap((item) => {
				const uri = typeof item === 'string' || (isObject(item) && item.type === 'Note') ? idOf(item) : null
				return uri !== null && originOf(uri) === origin ? [uri] : []
			})
		),
	]
	return { uris, hashtags: hashtagNames(items).slice(0, MAX_FEATURED_TAGS) }
}

// The pinned statuses the Store does not have, fetched (FetchRemoteStatusService): a usable status, or null for one
// that is not; one that may be fetched later (the budget spent included) is left out, so it is not pinned this time.
async function fetchPinned(
	uris: string[],
	loader: DocumentLoader,
	stored: (uris: string[]) => Promise<string[]>
): Promise<Record<string, RemoteStatusInput | null>> {
	const known = new Set(uris.length === 0 ? [] : await stored(uris))
	const fetched: Record<string, RemoteStatusInput | null> = {}
	for (const uri of uris.filter((u) => !known.has(u))) {
		const status = await fetchRemoteStatus(uri, loader)
		if (status.kind !== 'transient') {
			fetched[uri] = status.kind === 'ok' ? status.status : null
		}
	}
	return fetched
}

// FetchFeaturedTagsCollectionService: the Hashtags of its pages, until MAX_FEATURED_TAGS items, a page without items,
// or MAX_FEATURED_TAG_PAGES pages. null when a page may be read later (Mastodon retries the job) or the collection
// cannot be read; a later page that cannot be read at all ends it with what was read.
async function readFeaturedTags(
	sync: CollectionSync,
	origin: string | null,
	loader: DocumentLoader
): Promise<string[] | null> {
	const collection = await documentOn(sync.featuredTags, origin, loader)
	if (collection === null || collection === 'transient') {
		return null
	}
	const items: unknown[] = []
	let page: Json | 'transient' | null =
		collection.first === undefined ? collection : await documentOn(collection.first, origin, loader)
	for (let read = 0; isObject(page) && read < MAX_FEATURED_TAG_PAGES; read++) {
		const listed = itemsOf(page)
		if (listed === null || listed.length === 0) {
			break
		}
		items.push(...listed)
		if (items.length >= MAX_FEATURED_TAGS || page.next === undefined || page.next === null) {
			break
		}
		page = await documentOn(page.next, origin, loader)
	}
	if (page === 'transient') {
		return null
	}
	return hashtagNames(items).slice(0, MAX_FEATURED_TAGS)
}

// What a round reads of one account's collections: the collections first, then the pinned statuses to fetch, which
// take what is left of the budget.
export async function readCollections(
	sync: CollectionSync,
	loader: DocumentLoader,
	stored: (uris: string[]) => Promise<string[]>
): Promise<Pick<CollectionSyncInput, 'pins' | 'tags' | 'hideCollections'>> {
	const origin = originOf(sync.accountUri)
	const hideCollections = await hidesCollections(sync, origin, loader)
	const featured = sync.featured === null ? null : await readFeatured(sync, origin, loader)
	const tags = sync.featuredTags === null ? (featured?.hashtags ?? null) : await readFeaturedTags(sync, origin, loader)
	const pins =
		featured === null ? null : { uris: featured.uris, fetched: await fetchPinned(featured.uris, loader, stored) }
	return { pins, tags, hideCollections }
}

// One round: up to COLLECTION_SYNCS_PER_ROUND syncs, each claimed, read and applied. Returns whether another waits.
// A Store refusal (maintenance) surfaces as StoreUnavailableError for the caller; a claimed sync whose round died is
// claimed again after its lease.
export async function syncCollections(env: Env, deps: InboxDeps): Promise<boolean> {
	const build = deps.build(env)
	const store = () => deps.store(env)
	const domain = await callStore(() => store().instanceDomain(build))
	if (domain === null) {
		return false
	}
	const origin = `https://${domain}`
	const config = readConfig(env)
	let pending = false
	for (let round = 0; round < COLLECTION_SYNCS_PER_ROUND; round++) {
		const sync = await callStore(() => store().claimCollectionSync(build, { now: deps.now() }))
		if (sync === null) {
			return false
		}
		pending = sync.pending
		const state: FederationState = { resolvedUsername: null, source: null, storeError: null }
		const loaders = createRemoteLoaders(
			{
				domain,
				build,
				store,
				kek: config.ok ? userKek(config.config) : '',
				now: deps.now,
				keygen: deps.keygen,
				loader: deps.loader,
			},
			state,
			sync.signer,
			requestBudget(Date.now())
		)
		const read = await readCollections(sync, loaders.document, (uris) =>
			callStore(() => store().storedStatusUris(build, { uris }))
		)
		if (state.storeError !== null) {
			throw state.storeError
		}
		await callStore(() =>
			store().applyCollectionSync(build, { now: deps.now(), origin, accountUri: sync.accountUri, ...read })
		)
	}
	return pending
}
