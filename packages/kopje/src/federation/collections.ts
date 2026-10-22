import type { DocumentLoader } from '@fedify/fedify'

import { createRemoteLoaders, type FederationState } from './federation'
import type { InboxDeps } from './inbox'
import {
	CappedFetchError,
	type DocumentCaps,
	isTransientLoadError,
	REQUEST_MAX_BYTES,
	REQUEST_MAX_FETCHES,
	requestBudget,
} from './loader'
import { fetchRemoteStatus, idOf } from './remote-status'
import { MAX_FEATURED_TAGS } from '../domain/featured-tags'
import {
	type CollectionCounts,
	type CollectionReadInput,
	type CollectionSync,
	MAX_REMOTE_PINS,
	PART_FEATURED,
	PART_NETWORK,
	PART_TAGS,
} from '../domain/remote-collections'
import type { RemoteStatusInput } from '../domain/remote-statuses'
import { readConfig, userKek } from '../platform/config'
import { callStore } from '../platform/store-client'
import { storedCount } from '../platform/stored-bounds'

// The Worker's part of a sync of a remote account's collections (domain/remote-collections.ts): what Mastodon's
// FetchFeaturedCollectionService, FetchFeaturedTagsCollectionService and ProcessAccountService#collection_info fetch
// (the following, followers and outbox collections, for hide_collections and the counts),
// read through the safe loader (NET-1) within one request's fetch budget per round (RES-6), signed by a local
// follower of the account or else by the instance actor (as Mastodon signs with local_follower), and never from the
// signed-document cache (NET-4). The jobs/queue.ts rounds run it after the Store's inbound jobs: a round runs one phase
// of a sync, reading the collections or fetching the pinned statuses that reading left pending.
//
// Differences from Mastodon: a collection is read only on the actor's own origin (Mastodon checks the host for the
// featured collections only); the featured collection's first MAX_REMOTE_PINS items are read; a collection that may be
// read later (a timeout, a 5xx, the budget) leaves that part as it was and is read again in a later round, where
// Mastodon retries the job or, for hide_collections, reads the failure as a hidden collection (and keeps the count);
// a network document past NETWORK_CAPS tells nothing.

// Syncs one round runs, each with its own fetch budget.
export const COLLECTION_SYNCS_PER_ROUND = 2
// Pages of a featuredTags collection read at most (FetchFeaturedTagsCollectionService reads pages until it has
// FeaturedTag::LIMIT items or there is no next page).
export const MAX_FEATURED_TAG_PAGES = 3
// The most documents each part of a read fetches (domain/remote-collections.ts PART_*): the featured collection and its
// first page, the following, followers and outbox collections, and the featuredTags collection and its pages. A round
// reads the parts not read yet in that order, and records each it reads through, so the parts together may cost more
// than one budget. Each part alone fits a round's budget even with a redirect hop on each of its documents, checked as
// the module loads: a part read first in its round always completes, so every round with a healthy part left makes
// progress.
export const PART_DOCUMENTS = { featured: 2, network: 3, tags: 1 + MAX_FEATURED_TAG_PAGES } as const
if (Math.max(...Object.values(PART_DOCUMENTS)) * 2 > REQUEST_MAX_FETCHES) {
	throw new Error('each part of a collection read must fit one round of REQUEST_MAX_FETCHES, a redirect each included')
}
// The network part's documents are read under tighter caps, so that its three fit one round's fetches and bytes
// together whatever the documents are (RES-6): one redirect each (PART_DOCUMENTS.network × 2 fetches) and 512 KiB of
// body each (UTF-8 bytes as served; three take 1.5 MiB of REQUEST_MAX_BYTES). A document past them is settled as
// telling nothing: no count, and no say in hide_collections. The other parts keep the loader's own caps.
export const NETWORK_CAPS = { documentBytes: 512 * 1024, maxRedirects: 1 } as const satisfies DocumentCaps
if (
	PART_DOCUMENTS.network * (1 + NETWORK_CAPS.maxRedirects) > REQUEST_MAX_FETCHES ||
	PART_DOCUMENTS.network * NETWORK_CAPS.documentBytes >= REQUEST_MAX_BYTES
) {
	throw new Error('the network part must fit one round of REQUEST_MAX_FETCHES and REQUEST_MAX_BYTES under NETWORK_CAPS')
}

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
// succeed, 'capped' when a capped loader's caps refused it (RemoteLoaders capped), or null (refused, gone, not an
// object, or on another origin). An embedded object is taken as it is.
async function loadOn(
	value: unknown,
	origin: string | null,
	loader: DocumentLoader
): Promise<Json | 'transient' | 'capped' | null> {
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
		return isTransientLoadError(error) ? 'transient' : error instanceof CappedFetchError ? 'capped' : null
	}
}

// loadOn through the loader's own caps, which refuse nothing as 'capped'.
async function documentOn(
	value: unknown,
	origin: string | null,
	loader: DocumentLoader
): Promise<Json | 'transient' | null> {
	const loaded = await loadOn(value, origin, loader)
	return loaded === 'capped' ? null : loaded
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
// may pass or the document was past NETWORK_CAPS.
function showsItems(collection: Json | 'transient' | 'capped' | null): boolean | undefined {
	if (collection === 'transient' || collection === 'capped') {
		return undefined
	}
	return collection !== null && collection.first !== undefined && collection.first !== null
}

// collection_info's total_items: a JSON number only (Mastodon's is_a?(Numeric)), its integer part, a negative one read
// as 0 (AccountStat's getters show max(value, 0)); one past MAX_ACCOUNT_COUNT or not finite is not taken (null), as
// storedCount refuses it.
function totalItemsOf(collection: Json | 'transient' | 'capped' | null): number | null {
	const total = isObject(collection) ? collection.totalItems : undefined
	return typeof total === 'number' && Number.isFinite(total) ? storedCount(Math.max(Math.trunc(total), 0)) : null
}

// ProcessAccountService#set_fetchable_attributes!: the following, followers and outbox collections, each fetched (the
// followers even once the following hides, as Mastodon fetches all three for their counts). hide_collections =
// following_private? || followers_private?: hidden as soon as either collection is known to hide its items, shown when
// both are known to show them, and unknown (null: left as it was) otherwise. The counts are each collection's
// totalItems. settled: none of the three may be read later, so the part is read through.
async function readNetwork(
	sync: CollectionSync,
	origin: string | null,
	loader: DocumentLoader
): Promise<{ hideCollections: boolean | null; counts: CollectionCounts; settled: boolean }> {
	const following = await loadOn(sync.following, origin, loader)
	const followers = await loadOn(sync.followers, origin, loader)
	const outbox = await loadOn(sync.outbox, origin, loader)
	const shows = [showsItems(following), showsItems(followers)]
	return {
		hideCollections: shows.includes(false) ? true : shows.every((shown) => shown === true) ? false : null,
		counts: { statuses: totalItemsOf(outbox), following: totalItemsOf(following), followers: totalItemsOf(followers) },
		settled: ![following, followers, outbox].includes('transient'),
	}
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

type ReadOut = Pick<CollectionReadInput, 'parts' | 'pins' | 'tags' | 'hideCollections' | 'counts'>

// The loaders of a read: `document` within the loader's own caps, `network` within NETWORK_CAPS.
type ReadLoaders = { document: DocumentLoader; network: DocumentLoader }

// Each part's read, which records in `out` what it read through.
const PART_READS: [
	number,
	(sync: CollectionSync, origin: string | null, loaders: ReadLoaders, out: ReadOut) => Promise<void>,
][] = [
	// The featured collection: its pins, and its hashtags for an actor without a featuredTags collection (that part is
	// read with it). One that cannot be read at all is read through: nothing changes, as with Mastodon.
	[
		PART_FEATURED,
		async (sync, origin, loaders, out) => {
			const read = sync.featured === null ? null : await readFeatured(sync, origin, loaders.document)
			if (read !== 'transient') {
				out.parts |= PART_FEATURED | (sync.featuredTags === null ? PART_TAGS : 0)
				out.pins = read === null ? null : { uris: read.uris }
				out.tags = sync.featuredTags === null ? (read?.hashtags ?? null) : out.tags
			}
		},
	],
	// What was learned is applied in every round; the part is read through once none of its documents may be read later.
	[
		PART_NETWORK,
		async (sync, origin, loaders, out) => {
			const read = await readNetwork(sync, origin, loaders.network)
			out.hideCollections = read.hideCollections
			out.counts = read.counts
			out.parts |= read.settled ? PART_NETWORK : 0
		},
	],
	[
		PART_TAGS,
		async (sync, origin, loaders, out) => {
			const listed = await readFeaturedTags(sync, origin, loaders.document)
			if (listed !== 'transient') {
				out.parts |= PART_TAGS
				out.tags = listed
			}
		},
	],
]

// Phase 1: what a round reads of one account's collections: the parts not read through yet, in the order featured,
// network, featuredTags, starting from the one the round's attempt names. A round after one without progress starts
// with the next unread part, so each gets a round where it goes first with the whole budget (a part that keeps failing
// does not spend every round's budget before a healthy one) before MAX_SYNC_ATTEMPTS gives the read up.
export async function readCollections(sync: CollectionSync, loaders: ReadLoaders): Promise<ReadOut> {
	const origin = originOf(sync.accountUri)
	const out: ReadOut = {
		parts: 0,
		pins: null,
		tags: null,
		hideCollections: null,
		counts: { statuses: null, following: null, followers: null },
	}
	const unread = PART_READS.filter(
		([part]) => (sync.parts & part) === 0 && !(part === PART_TAGS && sync.featuredTags === null)
	)
	const first = unread.length === 0 ? 0 : (Math.max(sync.attempt, 1) - 1) % unread.length
	for (const [, read] of [...unread.slice(first), ...unread.slice(0, first)]) {
		await read(sync, origin, loaders, out)
	}
	return out
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
			const read = await readCollections(sync, {
				document: loaders.document,
				network: loaders.capped(NETWORK_CAPS),
			})
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
