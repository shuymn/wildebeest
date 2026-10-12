import { createFederation, type Federation, kvCache, type NodeInfo, type RequestContext } from '@fedify/fedify'
import {
	Activity,
	Application,
	CryptographicKey,
	Endpoints,
	Group,
	Image,
	Note,
	Organization,
	Person,
	Service,
} from '@fedify/vocab'
import { Temporal } from 'temporal-polyfill'

import { DoKvStore } from './kv-store'
import { createContextLoader, createSafeLoader, type LoaderDeps, type RequestSigner, requireObjectRoot } from './loader'
import {
	type CollectionKind,
	type CollectionPage,
	decodeKey,
	type EncodedKey,
	type LocalActor,
	type NodeInfoUsage,
	type StoredKey,
} from '../domain/actors'
import type { SnapshotSource } from '../domain/snapshot'
import { httpUrl } from '../platform/http-url'
import { PACKAGE_VERSION } from '../platform/package-version'
import { callStore, type StoreStub } from '../platform/store-client'
import { StoreUnavailableError } from '../platform/store-errors'
import { bytesToBase64, generateWrappedKey, importPublicKeyPem, type KeyGen } from '../security/key-wrap'
import { createKeyring, type KeyOwner, requestSigner, type Signer } from '../security/keyring'

// The Fedify Federation of one request: dispatchers for actors, key pairs, WebFinger, NodeInfo and the followers and
// following collections, local Notes and the outbox, over the Store, with ids under the domain fixed at /setup. It
// never sends: Fedify's queue,
// sendActivity and forwardActivity are not used (test/fedify-usage.test.ts); outbound delivery goes through deliveries.

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

export function createKopjeFederation(deps: FederationDeps, state: FederationState): Federation<FederationState> {
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
	const loaderDeps: LoaderDeps = { ...deps.loader, userAgent: `Kopje/${PACKAGE_VERSION} (+${origin}/)` }
	const instanceKeyId = new URL('/actor#main-key', origin)

	const actors = new Map<string, Promise<LocalActor | null>>()
	const localActor = (username: string) =>
		memo(actors, username.toLowerCase(), () => rpc((s) => s.localActor(build, { username })))

	let instanceKey: Promise<EncodedKey> | undefined
	// The instance actor's key, created on first use (a write, so it needs a Store that accepts writes once).
	const loadInstanceKey = () =>
		(instanceKey ??= (async () => {
			const stored = await rpc((s) => s.instanceActorKey(build))
			if (stored !== null) {
				return stored
			}
			const generated = await generateWrappedKey(deps.kek, deps.keygen)
			const encoded = {
				privkey: bytesToBase64(generated.privkey),
				salt: bytesToBase64(generated.salt),
				pubkey: generated.pubkey,
			}
			return rpc((s) => s.ensureInstanceActorKey(build, encoded))
		})())
	const instanceSigner = async () => keyring.signerFor(instanceOwner(await loadInstanceKey(), instanceKeyId))

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

	const federation = createFederation<FederationState>({
		kv,
		origin,
		// Fetches with no specific recipient are signed as the instance actor (secure-mode servers refuse unsigned ones).
		documentLoaderFactory: () => signedLoader(instanceKeyId, async () => (await instanceSigner()).sign),
		contextLoaderFactory: () => kvCache({ loader: createContextLoader(loaderDeps), kv }),
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
			let signer: Signer
			if (identifier === INSTANCE_ACTOR) {
				signer = await instanceSigner()
			} else {
				// Only the stored spelling has keys: '#main-key' under another case would name a key no actor publishes.
				if ((await localActor(identifier))?.username !== identifier) {
					return []
				}
				const key = await rpc((s) => s.localKey(build, { username: identifier }))
				if (key === null) {
					return []
				}
				signer = await keyring.signerFor(userOwner(key, new URL(`/ap/users/${identifier}#main-key`, origin)))
			}
			return [signer.keyPair]
		})

	const collections = new Map<string, Promise<CollectionPage | null>>()
	// Collections exist only under the stored spelling of a username, like the actor itself.
	const collection = (kind: CollectionKind, username: string, page: number | null) =>
		memo(collections, `${kind}/${username}/${page}`, async () =>
			(await localActor(username))?.username === username
				? rpc((s) => s.collection(build, { username, kind, page }))
				: null
		)
	for (const kind of ['followers', 'following'] as const) {
		const dispatcher = async (_ctx: unknown, identifier: string, cursor: string | null) => {
			const page = parsePage(cursor)
			const result = page === null ? null : await collection(kind, identifier, page)
			if (page === null || result === null) {
				return null
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
			.setCounter(async (_ctx, identifier) => (await collection(kind, identifier, null))?.total ?? null)
			.setFirstCursor(async (_ctx, identifier) => ((await collection(kind, identifier, null)) === null ? null : '1'))
	}

	// VIS-4: local public and unlisted statuses as Notes, from the data of their outbound Create (domain/activities.ts).
	// Anything else, signed request or not, is not found.
	federation.setObjectDispatcher(Note, '/ap/o/{uuid}', async (ctx, { uuid }) => {
		if (!OBJECT_ID.test(uuid)) {
			return null
		}
		const note = await rpc((s) => s.localNote(build, { uri: `${origin}/ap/o/${uuid}` }))
		return note === null ? null : Note.fromJsonLd(JSON.parse(note), { contextLoader: ctx.contextLoader })
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
	return new cls({
		id,
		preferredUsername: actor.username,
		name: actor.displayName,
		summary: actor.note,
		url: new URL(`/@${actor.username}`, ctx.canonicalOrigin),
		inbox: new URL(`${id.href}/inbox`),
		outbox: new URL(`${id.href}/outbox`),
		followers: ctx.getFollowersUri(actor.username),
		following: ctx.getFollowingUri(actor.username),
		endpoints: new Endpoints({ sharedInbox: new URL('/inbox', ctx.canonicalOrigin) }),
		// Derived from local_accounts.pubkey, the authoritative public key.
		publicKey: new CryptographicKey({
			id: new URL('#main-key', id),
			owner: id,
			publicKey: await importPublicKeyPem(actor.pubkey),
		}),
		manuallyApprovesFollowers: actor.locked,
		discoverable: actor.discoverable,
		published: Temporal.Instant.from(actor.createdAt),
		// Only http(s) URLs are published; anything else stored is left out (HTML-3), aliases included.
		icon: image(actor.avatarUrl),
		image: image(actor.headerUrl),
		aliases: actor.alsoKnownAs.flatMap((uri) => httpUrl(uri) ?? []),
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
