import {
	createFederation,
	type DocumentLoader,
	type Federation,
	kvCache,
	type NodeInfo,
	type RemoteDocument,
	type RequestContext,
} from '@fedify/fedify'
import {
	Activity,
	Application,
	CryptographicKey,
	Emoji,
	Endpoints,
	Group,
	Hashtag,
	Image,
	Note,
	type Object as ApObject,
	Organization,
	Person,
	PropertyValue,
	Question,
	Service,
} from '@fedify/vocab'
import { Temporal } from 'temporal-polyfill'

import { DoKvStore } from './kv-store'
import {
	createContextLoader,
	createSafeLoader,
	createWebFingerLoader,
	type FetchBudget,
	type LoaderDeps,
	RefusedFetchError,
	type RequestSigner,
	requireObjectRoot,
} from './loader'
import type { FeaturedItem } from '../domain/activities'
import {
	type CollectionKind,
	type CollectionPage,
	decodeKey,
	type EncodedKey,
	type LocalActor,
	type NodeInfoUsage,
	type StoredKey,
} from '../domain/actors'
import type { FollowerSigner } from '../domain/remote-collections'
import type { SnapshotSource } from '../domain/snapshot'
import { renderFieldValue } from '../domain/status-text'
import { httpUrl } from '../platform/http-url'
import { withinJsonBounds } from '../platform/json-bounds'
import { PACKAGE_VERSION } from '../platform/package-version'
import { callStore, type StoreStub } from '../platform/store-client'
import { StoreUnavailableError } from '../platform/store-errors'
import { bytesToBase64, generateWrappedKey, importPublicKeyPem, type KeyGen } from '../security/key-wrap'
import { createKeyring, type KeyOwner, requestSigner, type Signer } from '../security/keyring'

// The Fedify Federation of one request: dispatchers for actors, key pairs, WebFinger, NodeInfo, the followers,
// following, featured and featured hashtags collections, local Notes and the outbox, over the Store, with ids under the domain fixed at /setup. It
// never sends: Fedify's queue,
// sendActivity and forwardActivity are not used (test-node/fedify-usage.test.ts); outbound delivery goes through
// deliveries.

// The identifier of the instance actor, served at /actor. It cannot collide with a username, which has no ':'.
export const INSTANCE_ACTOR = 'kopje:instance'

export const SOFTWARE_REPOSITORY = 'https://github.com/shuymn/wildebeest'

// Per-request state the dispatchers fill in for the caller (it is also Fedify's context data): the username a
// dispatched actor resolved to, what the answer was rendered from (for the snapshot's freshness check), and a Store
// failure. Fedify answers 500 for any error a dispatcher throws, so the caller rethrows storeError to get maintenance
// handling (spool, snapshot, 503) instead.
export type FederationState = {
	resolvedUsername: string | null
	source: SnapshotSource | null
	storeError: StoreUnavailableError | null
}

export type FederationDeps = {
	domain: string
	build: string
	store: () => StoreStub
	kek: string
	now: () => number
	keygen: KeyGen
	loader: Omit<LoaderDeps, 'userAgent'>
}

const ACTOR_CLASSES = { Person, Service, Group, Organization, Application } as const

// Fedify's kvCache serves a hit without calling the loader, so entries admitted under a looser acceptance policy would
// outlive a fix for their TTL. Bump the version whenever the document loader's acceptance policy is tightened.
// v2: ActivityPub media types only and object roots only (ID-8).
const SIGNED_DOCUMENT_PREFIX = ['_fedify', 'signedRemoteDocument', 'v2'] as const

// The instance actor's key, created on first use (a write, so it needs a Store that accepts writes once). Racing first
// uses agree on one key: ensureInstanceActorKey keeps the first stored and returns it. Federation (signed fetches, the
// /actor document) and delivery (a report's Flag, jobs/deliver.ts) both get the key here.
export async function instanceActorKey(
	rpc: <T>(call: (store: StoreStub) => Promise<T>) => Promise<T>,
	build: string,
	kek: string,
	keygen: KeyGen
): Promise<EncodedKey> {
	const stored = await rpc((s) => s.instanceActorKey(build))
	if (stored !== null) {
		return stored
	}
	const generated = await generateWrappedKey(kek, keygen)
	const encoded = {
		privkey: bytesToBase64(generated.privkey),
		salt: bytesToBase64(generated.salt),
		pubkey: generated.pubkey,
	}
	return rpc((s) => s.ensureInstanceActorKey(build, encoded))
}

// The pieces every federation use shares: Store RPCs that record a maintenance failure in the state, the KvStore, the
// instance actor's key, and loaders signed and cached per signing key.
function federationParts(deps: FederationDeps, state: FederationState) {
	const { build, domain } = deps
	const origin = `https://${domain}`
	const rpc = async <T>(call: (store: StoreStub) => Promise<T>): Promise<T> => {
		try {
			return await callStore(() => call(deps.store()))
		} catch (error) {
			if (error instanceof StoreUnavailableError) {
				state.storeError ??= error
			}
			throw error
		}
	}
	const kv = new DoKvStore(deps.store, build, deps.now)
	const keyring = createKeyring(deps.kek)
	const loaderDeps: LoaderDeps = {
		...deps.loader,
		userAgent: `Kopje/${PACKAGE_VERSION} (+${origin}/)`,
		refusesHost: (host) => rpc((s) => s.fetchRefused(build, { host })),
	}
	const instanceKeyId = new URL('/actor#main-key', origin)

	const actors = new Map<string, Promise<LocalActor | null>>()
	const localActor = (username: string) =>
		memo(actors, username.toLowerCase(), () => rpc((s) => s.localActor(build, { username })))

	let instanceKey: Promise<EncodedKey> | undefined
	const loadInstanceKey = () => (instanceKey ??= instanceActorKey(rpc, build, deps.kek, deps.keygen))
	const instanceSigner = async () => keyring.signerFor(instanceOwner(await loadInstanceKey(), instanceKeyId))

	// The signer of a local account on a remote account's behalf, while it may sign for it (getFollowerKey), or null.
	const followerSigner = async (signer: FollowerSigner): Promise<Signer | null> => {
		const found = await rpc((s) => s.followerKey(build, signer))
		return found === null
			? null
			: keyring.signerFor(userOwner(found.key, new URL(`/ap/users/${found.username}#main-key`, origin)))
	}

	// The signer of a fetch as a local account, while it is available (getSigningKey), or null.
	const localSigner = async (username: string): Promise<Signer | null> => {
		const key = await rpc((s) => s.signingKey(build, { username }))
		return key === null ? null : keyring.signerFor(userOwner(key, new URL(`/ap/users/${username}#main-key`, origin)))
	}

	// The key pair Fedify publishes for a local account (setKeyPairsDispatcher), by the stored spelling of the username,
	// or null. It is loaded without the availability check, so it is a bare key pair, never a Signer a fetch could use.
	const publishedKeyPair = async (username: string): Promise<CryptoKeyPair | null> => {
		if ((await localActor(username))?.username !== username) {
			return null
		}
		const key = await rpc((s) => s.localKey(build, { username }))
		return key === null
			? null
			: (await keyring.signerFor(userOwner(key, new URL(`/ap/users/${username}#main-key`, origin)))).keyPair
	}

	// A signed loader caches per signing key (design §7): what one key was shown must not reach another key or the
	// unsigned path.
	const signedLoader = (keyId: URL, sign: () => Promise<RequestSigner>) =>
		requireObjectRoot(
			kvCache({
				loader: async (url, options) => createSafeLoader(loaderDeps, await sign())(url, options),
				kv,
				prefix: [...SIGNED_DOCUMENT_PREFIX, keyId.href],
			})
		)
	const contextLoader = boundedContexts(loaderDeps, kv)

	return {
		origin,
		rpc,
		kv,
		loaderDeps,
		instanceKeyId,
		localActor,
		loadInstanceKey,
		instanceSigner,
		publishedKeyPair,
		localSigner,
		followerSigner,
		signedLoader,
		contextLoader,
	}
}

// The loaders of inbound processing (DATA-7): fetches for a personal inbox are signed with the recipient's key (a
// username), fetches on a remote account's behalf with a local follower's (a FollowerSigner, checked when its key is
// loaded), all others, and those whose signer may not sign, with the instance actor's. Documents are fetched anew, never from the 5-minute document cache, because key
// material is judged on them (ID-1); within one request a URL is fetched once. Every fetch, contexts included, draws
// on the request's budget (RES-6); cached contexts cost nothing. Every document must stay within the JSON bounds
// (RES-2) before Fedify's JSON-LD processing or Kopje's own reading sees it. webfinger is unsigned, as WebFinger is.
export type RemoteLoaders = { document: DocumentLoader; context: DocumentLoader; webfinger: DocumentLoader }

export function createRemoteLoaders(
	deps: FederationDeps,
	state: FederationState,
	recipient: string | FollowerSigner | null,
	budget: FetchBudget
): RemoteLoaders {
	const parts = federationParts(deps, state)
	const loaderDeps = { ...parts.loaderDeps, budget }
	let resolved: Promise<Signer> | undefined
	// Resolved on the first fetch only: a request refused before any fetch unwraps no key.
	const signer = () =>
		(resolved ??= (async () =>
			(recipient === null
				? null
				: typeof recipient === 'string'
					? await parts.localSigner(recipient)
					: await parts.followerSigner(recipient)) ?? parts.instanceSigner())())
	const fetched = new Map<string, ReturnType<DocumentLoader>>()
	const fresh = requireObjectRoot(async (url, options) => {
		return withinBounds(await createSafeLoader(loaderDeps, (await signer()).sign)(url, options))
	})
	return {
		// Keyed without the fragment: HTTP never sends it, so `actor#main-key` and `actor` are one fetch. Key ids are
		// still compared whole by Fedify and by receiveInbound.
		document: (url, options) => memo(fetched, withoutFragment(url), () => fresh(url, options)),
		context: boundedContexts(loaderDeps, parts.kv),
		webfinger: createWebFingerLoader(loaderDeps),
	}
}

// RES-2: a document or JSON-LD context past the JSON bounds is refused before anything reads it.
function withinBounds(remote: RemoteDocument): RemoteDocument {
	if (!withinJsonBounds(remote.document)) {
		throw new RefusedFetchError(new URL(remote.documentUrl), 'Document exceeds the JSON bounds')
	}
	return remote
}

// JSON-LD contexts, cached in the KvStore. Checked before they are cached and again on every cache hit, since an
// entry may predate the check.
function boundedContexts(loaderDeps: LoaderDeps, kv: DoKvStore): DocumentLoader {
	const loader = createContextLoader(loaderDeps)
	const cached = kvCache({ loader: async (url, options) => withinBounds(await loader(url, options)), kv })
	return async (url, options) => withinBounds(await cached(url, options))
}

export function createKopjeFederation(deps: FederationDeps, state: FederationState): Federation<FederationState> {
	const { domain } = deps
	const parts = federationParts(deps, state)
	const {
		origin,
		kv,
		instanceKeyId,
		localActor,
		loadInstanceKey,
		instanceSigner,
		publishedKeyPair,
		signedLoader,
		rpc,
	} = parts
	const { build } = deps

	const federation = createFederation<FederationState>({
		kv,
		origin,
		// Fetches with no specific recipient are signed as the instance actor (secure-mode servers refuse unsigned ones).
		documentLoaderFactory: () => signedLoader(instanceKeyId, async () => (await instanceSigner()).sign),
		contextLoaderFactory: () => parts.contextLoader,
		// Fedify calls this with the recipient's key on a personal inbox.
		authenticatedDocumentLoaderFactory: ({ keyId, privateKey }) =>
			signedLoader(keyId, () => Promise.resolve(requestSigner(keyId, privateKey))),
	})

	federation
		.setActorDispatcher('/ap/users/{identifier}', async (ctx, identifier) => {
			if (identifier === INSTANCE_ACTOR) {
				// The HTTP alias rule: the document is served at /actor, never under the /ap/users template. WebFinger
				// resolves it only by its canonical URI; Fedify also maps the template spelling of the identifier to it.
				if (!isInstanceActorRequest(ctx.url, origin)) {
					return null
				}
				const key = await loadInstanceKey()
				state.source = { kind: 'instance-actor', rendered: key.pubkey }
				return instanceActor(domain, key)
			}
			const actor = await localActor(identifier)
			// Actor URIs keep the username's case; a differently cased path is not this actor's id.
			if (actor === null || actor.username !== identifier) {
				return null
			}
			state.resolvedUsername = actor.username
			state.source = { kind: 'actor', username: actor.username, rendered: JSON.stringify(actor) }
			return localActorObject(ctx, actor)
		})
		.mapHandle(async (_ctx, username) => (await localActor(username))?.username ?? null)
		.mapActorAlias('/actor', INSTANCE_ACTOR)
		.setKeyPairsDispatcher(async (_ctx, identifier) => {
			if (identifier === INSTANCE_ACTOR) {
				return [(await instanceSigner()).keyPair]
			}
			// Only the stored spelling has keys: '#main-key' under another case would name a key no actor publishes.
			const pair = await publishedKeyPair(identifier)
			return pair === null ? [] : [pair]
		})

	const collections = new Map<string, Promise<CollectionPage | null>>()
	// Collections exist only under the stored spelling of a username, like the actor itself.
	const collection = (kind: CollectionKind, username: string, page: number | null) =>
		memo(collections, `${kind}/${username}/${page}`, async () =>
			(await localActor(username))?.username === username
				? rpc((s) => s.collection(build, { username, kind, page }))
				: null
		)
	// A collection whose owner hides its network has no first page: Fedify then asks for its items without a cursor,
	// and it has none to show, only its size. A page of it is refused (403), as Mastodon refuses it: the dispatcher
	// answers it empty so that Fedify reaches the authorization check, which refuses it.
	for (const kind of ['followers', 'following'] as const) {
		const dispatcher = async (_ctx: unknown, identifier: string, cursor: string | null) => {
			if (cursor === null) {
				return (await collection(kind, identifier, null))?.hidden === true ? { items: [] } : null
			}
			const page = parsePage(cursor)
			const result = page === null ? null : await collection(kind, identifier, page)
			if (page === null || result === null) {
				return null
			}
			if (result.hidden) {
				return { items: [] }
			}
			const items = result.items.map((item) => new URL(item.uri))
			return { items, nextCursor: result.hasNext ? String(page + 1) : null }
		}
		const setters =
			kind === 'followers'
				? federation.setFollowersDispatcher('/ap/users/{identifier}/followers', async (ctx, identifier, cursor) => {
						const page = await dispatcher(ctx, identifier, cursor)
						return page === null
							? null
							: { ...page, items: page.items.map((id) => ({ id, inboxId: null, endpoints: null })) }
					})
				: federation.setFollowingDispatcher('/ap/users/{identifier}/following', dispatcher)
		setters
			.authorize(async (ctx, identifier) => {
				// Fedify asks only after the dispatcher answered, so the page's result is already read.
				const cursor = ctx.url.searchParams.get('cursor')
				return cursor === null || (await collection(kind, identifier, parsePage(cursor)))?.hidden !== true
			})
			.setCounter(async (_ctx, identifier) => (await collection(kind, identifier, null))?.total ?? null)
			.setFirstCursor(async (_ctx, identifier) => {
				const result = await collection(kind, identifier, null)
				return result === null || result.hidden ? null : '1'
			})
	}

	// The featured collection (ActivityPub::CollectionsController, `featured`): the pinned statuses, newest pin first,
	// all in the collection itself, as Mastodon's OrderedCollection without pages: the Note of a public or unlisted one
	// (as the object endpoint serves it, VIS-4), the uri alone of any other, and their count (totalItems). It is also the
	// target Mastodon names in the Add and Remove of a pin and of a featured hashtag (domain/status-actions.ts,
	// domain/featured-tags.ts), which receivers act on only when the actor publishes it. An unknown or suspended actor
	// has none.
	const pins = new Map<string, Promise<FeaturedItem[] | null>>()
	const featuredOf = (username: string) =>
		memo(pins, username, async () =>
			(await localActor(username))?.username === username ? rpc((s) => s.featured(build, { username })) : null
		)
	federation
		.setFeaturedDispatcher('/ap/users/{identifier}/collections/featured', async (ctx, identifier, cursor) => {
			const featured = cursor === null ? await featuredOf(identifier) : null
			if (featured === null) {
				return null
			}
			const items = await Promise.all(
				featured.map(async ({ uri, note }): Promise<ApObject | URL> => {
					if (note === null) {
						return new URL(uri)
					}
					const json = JSON.parse(note) as { type?: unknown }
					return json.type === 'Question'
						? Question.fromJsonLd(json, { contextLoader: ctx.contextLoader })
						: Note.fromJsonLd(json, { contextLoader: ctx.contextLoader })
				})
			)
			// Fedify serves a URL item as the uri it is (filterCollectionItems), though the dispatcher's type names objects.
			return { items: items as ApObject[] }
		})
		.setCounter(async (_ctx, identifier) => (await featuredOf(identifier))?.length ?? null)
	// The featuredTags collection (`tags`): the actor's featured hashtags, at most ten, in one collection.
	const featuredTags = new Map<string, Promise<Hashtag[] | null>>()
	const hashtags = (identifier: string) =>
		memo(featuredTags, identifier, async () => {
			if ((await localActor(identifier))?.username !== identifier) {
				return null
			}
			const tags = await rpc((s) => s.featuredTagsCollection(build, { username: identifier, origin }))
			return tags?.map((tag) => new Hashtag({ name: `#${tag.name}`, href: new URL(tag.href) })) ?? null
		})
	federation
		.setFeaturedTagsDispatcher('/ap/users/{identifier}/collections/tags', async (_ctx, identifier) => {
			const items = await hashtags(identifier)
			return items === null ? null : { items }
		})
		.setCounter(async (_ctx, identifier) => (await hashtags(identifier))?.length ?? null)

	// VIS-4: local public and unlisted statuses as Notes, from the data of their outbound Create (domain/activities.ts).
	// Anything else, signed request or not, is not found.
	federation.setObjectDispatcher(Note, '/ap/o/{uuid}', async (ctx, { uuid }) => {
		if (!OBJECT_ID.test(uuid)) {
			return null
		}
		const note = await rpc((s) => s.localNote(build, { uri: `${origin}/ap/o/${uuid}` }))
		if (note === null) {
			return null
		}
		const json = JSON.parse(note) as { type?: unknown }
		// A status with a poll is a Question (ActivityPub::NoteSerializer). Fedify serves whatever object the dispatcher
		// returns; the dispatcher is registered for Note, the type of the path's other objects.
		return json.type === 'Question'
			? ((await Question.fromJsonLd(json, { contextLoader: ctx.contextLoader })) as unknown as Note)
			: Note.fromJsonLd(json, { contextLoader: ctx.contextLoader })
	})

	// The outbox: Create and Announce of the public and unlisted statuses, newest first.
	federation
		.setOutboxDispatcher('/ap/users/{identifier}/outbox', async (ctx, identifier, cursor) => {
			const before = cursor === FIRST_OUTBOX_CURSOR ? '~' : cursor !== null && /^\d{18}$/.test(cursor) ? cursor : null
			if (before === null || (await localActor(identifier))?.username !== identifier) {
				return null
			}
			const page = await rpc((s) => s.outbox(build, { username: identifier, before }))
			if (page === null) {
				return null
			}
			const items = await Promise.all(
				page.items.map((item) => Activity.fromJsonLd(JSON.parse(item), { contextLoader: ctx.contextLoader }))
			)
			return { items, nextCursor: page.next }
		})
		.setCounter(async (_ctx, identifier) =>
			(await localActor(identifier))?.username === identifier
				? ((await rpc((s) => s.outbox(build, { username: identifier, before: null })))?.total ?? null)
				: null
		)
		.setFirstCursor(async (_ctx, identifier) =>
			(await localActor(identifier))?.username === identifier ? FIRST_OUTBOX_CURSOR : null
		)

	federation.setNodeInfoDispatcher('/nodeinfo/2.1', async () => {
		const now = deps.now()
		const usage = await rpc((s) => s.nodeInfoUsage(build, { now }))
		state.source = { kind: 'nodeinfo', now, rendered: JSON.stringify(usage) }
		return nodeInfo(usage)
	})

	return federation
}

// The object id of a local status URI: a uuid, or the legacy id it was migrated with.
const OBJECT_ID = /^[0-9A-Za-z-]{1,64}$/
const FIRST_OUTBOX_CURSOR = 'first'

function isInstanceActorRequest(url: URL, origin: string): boolean {
	if (url.pathname === '/.well-known/webfinger') {
		const resources = url.searchParams.getAll('resource')
		return resources.length === 1 && resources[0] === `${origin}/actor`
	}
	return url.pathname === '/actor'
}

function withoutFragment(url: string): string {
	const hash = url.indexOf('#')
	return hash === -1 ? url : url.slice(0, hash)
}

function memo<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
	let value = cache.get(key)
	if (value === undefined) {
		value = load()
		cache.set(key, value)
	}
	return value
}

// Collection pages are numbered from 1, newest first, as Mastodon's ?page=N.
function parsePage(cursor: string | null): number | null {
	return cursor !== null && /^[1-9]\d{0,5}$/.test(cursor) ? Number(cursor) : null
}

function userOwner(key: StoredKey, keyId: URL): KeyOwner {
	return { keyId, privkey: key.privkey, salt: key.salt, pubkey: key.pubkey }
}

function instanceOwner(key: EncodedKey, keyId: URL): KeyOwner {
	return userOwner(decodeKey(key), keyId)
}

async function localActorObject(ctx: RequestContext<FederationState>, actor: LocalActor) {
	const id = ctx.getActorUri(actor.username)
	const cls = ACTOR_CLASSES[actor.actorType as keyof typeof ACTOR_CLASSES] ?? Person
	// A suspended actor, as Mastodon's ActivityPub::ActorSerializer presents one: no name, summary, icon, image, aliases
	// or fields, not locked or discoverable, and `suspended: true`; its keys, inboxes and collections stay, so other
	// servers can still verify what it signed and learn of the suspension.
	const profile = actor.suspended
		? { manuallyApprovesFollowers: false, discoverable: false, suspended: true }
		: {
				name: actor.displayName,
				summary: actor.note,
				manuallyApprovesFollowers: actor.locked,
				discoverable: actor.discoverable,
				// Only http(s) URLs are published; anything else stored is left out (HTML-3), aliases included.
				icon: image(actor.avatarUrl),
				image: image(actor.headerUrl),
				aliases: actor.alsoKnownAs.flatMap((uri) => httpUrl(uri) ?? []),
				// Profile fields as Mastodon publishes them: the value escaped and linked (HTML-2).
				attachments: actor.fields.map(
					(field) => new PropertyValue({ name: field.name, value: renderFieldValue(field.value) })
				),
				// The profile's local emoji (ActivityPub::ActorSerializer#virtual_tags, none while suspended: :143).
				tags: actor.emojis.map(emojiObject),
			}
	const object = new cls({
		id,
		preferredUsername: actor.username,
		url: new URL(`/@${actor.username}`, ctx.canonicalOrigin),
		inbox: new URL(`${id.href}/inbox`),
		outbox: new URL(`${id.href}/outbox`),
		followers: ctx.getFollowersUri(actor.username),
		following: ctx.getFollowingUri(actor.username),
		featured: ctx.getFeaturedUri(actor.username),
		featuredTags: ctx.getFeaturedTagsUri(actor.username),
		endpoints: new Endpoints({ sharedInbox: new URL('/inbox', ctx.canonicalOrigin) }),
		// Derived from local_accounts.pubkey, the authoritative public key.
		publicKey: new CryptographicKey({
			id: new URL('#main-key', id),
			owner: id,
			publicKey: await importPublicKeyPem(actor.pubkey),
		}),
		published: Temporal.Instant.from(actor.createdAt),
		...profile,
	})
	return withAttributionDomains(object, actor.attributionDomains)
}

// Mastodon's `attributionDomains` (toot:attributionDomains), which Fedify's vocabulary does not have: added to the
// compacted document with its context term, only when the account has one, as ActivityPub::ActorSerializer adds it
// (a suspended account's too).
const ATTRIBUTION_DOMAINS_CONTEXT = {
	toot: 'http://joinmastodon.org/ns#',
	attributionDomains: { '@id': 'toot:attributionDomains', '@container': '@set' },
}

function withAttributionDomains<T extends { toJsonLd(options?: object): Promise<unknown> }>(
	object: T,
	domains: string[]
): T {
	if (domains.length === 0) {
		return object
	}
	const toJsonLd = object.toJsonLd.bind(object)
	object.toJsonLd = async (options?: object) => {
		const json = await toJsonLd(options)
		if (typeof json !== 'object' || json === null || !('@context' in json)) {
			return json
		}
		const context = (json as { '@context': unknown })['@context']
		return {
			...json,
			'@context': [...(Array.isArray(context) ? context : [context]), ATTRIBUTION_DOMAINS_CONTEXT],
			attributionDomains: domains,
		}
	}
	return object
}

// An Emoji tag as Fedify's Emoji. Its time passed emojiInstant (custom-emojis.ts emojiTag), so it parses.
function emojiObject(emoji: LocalActor['emojis'][number]): Emoji {
	return new Emoji({
		id: new URL(emoji.id),
		name: emoji.name,
		updated: Temporal.Instant.from(emoji.updated),
		icon: new Image({ mediaType: emoji.icon.mediaType, url: new URL(emoji.icon.url) }),
	})
}

function image(stored: string | null): Image | null {
	const url = httpUrl(stored)
	return url === null ? null : new Image({ url })
}

// The instance actor, as Mastodon's: an Application at /actor with its own inbox and the shared inbox.
async function instanceActor(domain: string, key: EncodedKey) {
	const origin = `https://${domain}`
	const id = new URL('/actor', origin)
	return new Application({
		id,
		preferredUsername: domain,
		url: new URL('/about', origin),
		inbox: new URL('/actor/inbox', origin),
		outbox: new URL('/actor/outbox', origin),
		endpoints: new Endpoints({ sharedInbox: new URL('/inbox', origin) }),
		publicKey: new CryptographicKey({
			id: new URL('#main-key', id),
			owner: id,
			publicKey: await importPublicKeyPem(key.pubkey),
		}),
		manuallyApprovesFollowers: true,
	})
}

export function nodeInfo(usage: NodeInfoUsage): NodeInfo {
	return {
		software: {
			name: 'kopje',
			version: PACKAGE_VERSION,
			repository: new URL(SOFTWARE_REPOSITORY),
			homepage: new URL(SOFTWARE_REPOSITORY),
		},
		protocols: ['activitypub'],
		openRegistrations: false,
		usage: {
			users: { total: usage.users, activeMonth: usage.activeMonth, activeHalfyear: usage.activeHalfyear },
			localPosts: usage.localPosts,
			localComments: 0,
		},
		metadata: {},
	}
}
