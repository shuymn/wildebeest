import type { DocumentLoader } from '@fedify/fedify'

import { createRemoteLoaders, type FederationState } from './federation'
import type { InboxDeps } from './inbox'
import { isTransientLoadError, requestBudget } from './loader'
import { fetchRemoteStatus, idOf } from './remote-status'
import { MAX_FEATURED_TAGS } from '../domain/featured-tags'
import { type CollectionReadInput, type CollectionSync, MAX_REMOTE_PINS } from '../domain/remote-collections'
import type { RemoteStatusInput } from '../domain/remote-statuses'
import { readConfig, userKek } from '../platform/config'
import { callStore } from '../platform/store-client'

// The Worker's part of a sync of a remote account's collections (domain/remote-collections.ts): what Mastodon's
// FetchFeaturedCollectionService, FetchFeaturedTagsCollectionService and ProcessAccountService#collection_info fetch,
// read through the safe loader (NET-1) within one request's fetch budget per round (RES-6), signed by a local
// follower of the account or else by the instance actor (as Mastodon signs with local_follower), and never from the
// signed-document cache (NET-4). The jobs/queue.ts rounds run it after the Store's inbound jobs: a round runs one phase
// of a sync, reading the collections or fetching the pinned statuses that reading left pending.
//
// Differences from Mastodon: a collection is read only on the actor's own origin (Mastodon checks the host for the
// featured collections only); the featured collection's first MAX_REMOTE_PINS items are read; a collection that may be
// read later (a timeout, a 5xx, the budget) leaves that part as it was and is read again in a later round, where
// Mastodon retries the job or, for hide_collections, reads the failure as a hidden collection.

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

// The names of the Hashtags among `items`, in order, appended to `names` until it holds MAX_FEATURED_TAGS; the items
// after that are not looked at.
function hashtagNames(items: readonly unknown[], names: string[] = []): string[] {
	for (const item of items) {
		if (names.length >= MAX_FEATURED_TAGS) {
			break
		}
		if (isObject(item) && item.type === 'Hashtag' && typeof item.name === 'string') {
			names.push(item.name)
		}
	}
	return names
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

// hide_collections = following_private? || followers_private?, the followers not read once the following hides:
// hidden as soon as either collection is known to hide its items, shown when both are known to show them, and unknown
// (null: left as it was) only when neither tells.
async function hidesCollections(sync: CollectionSync, origin: string | null, loader: DocumentLoader) {
	const following = await showsItems(sync.following, origin, loader)
	if (following === false) {
		return true
	}
	const followers = await showsItems(sync.followers, origin, loader)
	if (followers === false) {
		return true
	}
	return following === true && followers === true ? false : null
}

// FetchFeaturedCollectionService: the first MAX_REMOTE_PINS items of the first page, null when it cannot be read, or
// 'transient' when it may be read later.
// Among them, Notes (or ids) of the actor's origin are its pins, and Hashtags its featured hashtags when it has no
// featuredTags collection. The items past them are never looked at, whatever they are.
async function readFeatured(
	sync: CollectionSync,
	origin: string | null,
	loader: DocumentLoader
): Promise<{ uris: string[]; hashtags: string[] } | 'transient' | null> {
	const collection = await documentOn(sync.featured, origin, loader)
	if (collection === null || collection === 'transient') {
		return collection
	}
	const page = collection.first === undefined ? collection : await documentOn(collection.first, origin, loader)
	if (page === 'transient') {
		return page
	}
	const items = page === null ? null : (itemsOf(page)?.slice(0, MAX_REMOTE_PINS) ?? null)
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
	return { uris, hashtags: hashtagNames(items) }
}

// Phase 2: the pending statuses, fetched in order (FetchRemoteStatusService) while the budget lasts: a usable status, or
// null for one that is not; one that may be fetched later (the budget spent included) is left out, for a later round.
async function fetchPending(
	uris: readonly string[],
	loader: DocumentLoader
): Promise<Record<string, RemoteStatusInput | null>> {
	const fetched: Record<string, RemoteStatusInput | null> = {}
	for (const uri of uris) {
		const status = await fetchRemoteStatus(uri, loader)
		if (status.kind !== 'transient') {
			fetched[uri] = status.kind === 'ok' ? status.status : null
		}
	}
	return fetched
}

// FetchFeaturedTagsCollectionService: the Hashtags of its pages, until MAX_FEATURED_TAGS items, a page without items,
// or MAX_FEATURED_TAG_PAGES pages. 'transient' when a page may be read later (Mastodon retries the job), null when the
// collection cannot be read; a later page that cannot be read at all ends it with what was read.
async function readFeaturedTags(
	sync: CollectionSync,
	origin: string | null,
	loader: DocumentLoader
): Promise<string[] | 'transient' | null> {
	const collection = await documentOn(sync.featuredTags, origin, loader)
	if (collection === null || collection === 'transient') {
		return collection
	}
	// The raw items read so far (the paging condition counts them), and the hashtags among them.
	let listedItems = 0
	const names: string[] = []
	let page: Json | 'transient' | null =
		collection.first === undefined ? collection : await documentOn(collection.first, origin, loader)
	// The page limit is checked before the next page is fetched: page MAX_FEATURED_TAG_PAGES + 1 is never asked for.
	for (let read = 1; isObject(page); read++) {
		const listed = itemsOf(page)
		if (listed === null || listed.length === 0) {
			break
		}
		listedItems += listed.length
		hashtagNames(listed, names)
		if (
			listedItems >= MAX_FEATURED_TAGS ||
			read >= MAX_FEATURED_TAG_PAGES ||
			page.next === undefined ||
			page.next === null
		) {
			break
		}
		page = await documentOn(page.next, origin, loader)
	}
	if (page === 'transient') {
		return page
	}
	return names
}

// Phase 1: what a round reads of one account's collections. unfinished: something may be read later (a fetch that may
// pass, the budget spent), so the read is tried again.
export async function readCollections(
	sync: CollectionSync,
	loader: DocumentLoader
): Promise<Pick<CollectionReadInput, 'pins' | 'tags' | 'hideCollections' | 'unfinished'>> {
	const origin = originOf(sync.accountUri)
	const hideCollections = await hidesCollections(sync, origin, loader)
	const read = sync.featured === null ? null : await readFeatured(sync, origin, loader)
	const featured = read === 'transient' ? null : read
	const listed =
		sync.featuredTags === null ? (featured?.hashtags ?? null) : await readFeaturedTags(sync, origin, loader)
	return {
		pins: featured === null ? null : { uris: featured.uris },
		tags: listed === 'transient' ? null : listed,
		hideCollections,
		// hidesCollections is null only when a collection may be read later.
		unfinished: hideCollections === null || read === 'transient' || listed === 'transient',
	}
}

// One round: up to COLLECTION_SYNCS_PER_ROUND syncs, each claimed, its phase run and handed back. Returns whether another waits.
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
		const sync = await callStore<CollectionSync | 'more' | null>(() =>
			store().claimCollectionSync(build, { now: deps.now() })
		)
		if (sync === null) {
			return false
		}
		if (sync === 'more') {
			// The claim spent its allowance dropping syncs; more are due.
			pending = true
			continue
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
		const round = { origin, accountUri: sync.accountUri, generation: sync.generation, token: sync.token }
		if (sync.phase === 'read') {
			const read = await readCollections(sync, loaders.document)
			if (state.storeError !== null) {
				throw state.storeError
			}
			pending = await callStore(() => store().completeCollectionRead(build, { ...round, now: deps.now(), ...read }))
		} else {
			const fetched = await fetchPending(sync.uris, loaders.document)
			if (state.storeError !== null) {
				throw state.storeError
			}
			pending = await callStore(() => store().completePinFetches(build, { ...round, now: deps.now(), fetched }))
		}
	}
	return pending
}
