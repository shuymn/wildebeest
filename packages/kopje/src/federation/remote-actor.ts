import { type DocumentLoader, exportSpki, FetchError } from '@fedify/fedify'
import { type Actor, getActorTypeName, type Image, isActor, Link, lookupObject } from '@fedify/vocab'

import { isTransientLoadError, loadFailureOf } from './loader'
import type { RemoteActorInput } from '../domain/inbox'
import { ACTOR_URI_LIMIT, DISPLAY_NAME_LIMIT, PROFILE_URL_LIMIT } from '../domain/profile-bounds'
import { hostDomain } from '../platform/domain-name'
import { httpUrl } from '../platform/http-url'
import { isRemoteUsername, isStorableActorId } from '../platform/identity-bounds'
import { sanitizeRemoteBio } from '../security/html'

// Remote actors as Kopje stores them: fetched through the safe loader (NET-1, ID-8), parsed by Fedify's lookupObject,
// which checks the parsed id against the document's origin (ID-2), and reduced to bounded, safe columns.

// Raw caps (RES-1): the display name is plain text and is cut (DISPLAY_NAME_LIMIT), as Mastodon cuts what it
// receives.
// Actor ids and inbox URLs (RES-6): a delivery target is an inbox and, for a silent recipient, an actor id, so their
// length bounds a target. This cap is Kopje's own interoperability policy, not another server's behaviour: Mastodon
// sets no length limit, and Misskey stores inbox URLs in 512-character columns. Real servers use far shorter URLs.
// A serialized URL is ASCII, so its length is its size in bytes.
export const INBOX_URL_LIMIT = 2048
export { ACTOR_URI_LIMIT }

export type FetchedActor =
	| { kind: 'ok'; actor: Actor; input: RemoteActorInput | null }
	// Fetching again may succeed (timeout, network error, 5xx).
	| { kind: 'transient' }
	// The document answers 404 or 410: the actor is gone.
	| { kind: 'gone' }
	// Refused, or not an actor with exactly this id.
	| { kind: 'unusable' }

// Loads the actor at uri. The document is loaded once through `loader` and handed to lookupObject, which therefore
// never falls back to its own WebFinger lookup (that would fetch outside the safe loader). An actor whose id is not
// exactly uri is unusable.
export async function fetchActor(
	uri: string,
	loader: DocumentLoader,
	contextLoader: DocumentLoader
): Promise<FetchedActor> {
	let remote: Awaited<ReturnType<DocumentLoader>>
	try {
		remote = await loader(uri)
	} catch (error) {
		const status = error instanceof FetchError ? error.response?.status : undefined
		if (status === 404 || status === 410) {
			return { kind: 'gone' }
		}
		return { kind: isTransientLoadError(error) ? 'transient' : 'unusable' }
	}
	let object: unknown
	try {
		object = await lookupObject(uri, {
			documentLoader: (url, options) => (url === uri ? Promise.resolve(remote) : loader(url, options)),
			contextLoader,
		})
	} catch (error) {
		// A JSON-LD context that failed to load for a reason that may pass is transient too; only a document that
		// cannot be read as served is unusable.
		const failure = loadFailureOf(error)
		return { kind: failure !== undefined && isTransientLoadError(failure) ? 'transient' : 'unusable' }
	}
	if (!isActor(object) || object.id?.href !== uri) {
		return { kind: 'unusable' }
	}
	return { kind: 'ok', actor: object, input: await remoteActorInput(object, remote.document) }
}

// A natural-language value: a plain string or Fedify's LanguageString (a String with a language tag).
function text(value: string | { toString(): string } | null | undefined): string | null {
	return value === null || value === undefined ? null : value.toString()
}

// A profile URL (url, icon, image): http(s) (HTML-3) and at most PROFILE_URL_LIMIT long, else none, as an invalid one.
function href(value: URL | Link | null | undefined): string | null {
	const target = value instanceof Link ? value.href : value
	const url = httpUrl(target?.href ?? null)?.href ?? null
	return url !== null && url.length <= PROFILE_URL_LIMIT ? url : null
}

// Icons and headers are taken only when embedded: a reference would cost another fetch per actor (RES-6).
const NO_FETCH: DocumentLoader = () => Promise.reject(new Error('not fetched'))

type Images = Record<
	'getIcon' | 'getImage',
	(options: { documentLoader: DocumentLoader; contextLoader: DocumentLoader }) => Promise<Image | null>
>

async function imageUrl(get: () => Promise<{ url: URL | Link | null } | null>): Promise<string | null> {
	try {
		return href((await get())?.url)
	} catch {
		return null
	}
}

// The keys embedded in the document that belong to this actor: a key naming another owner, or with an id on another
// origin, is not the actor's to vouch for (ID-1) and is left out. Referenced keys are not fetched.
async function ownKeys(actor: Actor, uri: URL): Promise<{ id: string; pem: string }[]> {
	const keys: { id: string; pem: string }[] = []
	try {
		for await (const key of actor.getPublicKeys({
			documentLoader: NO_FETCH,
			contextLoader: NO_FETCH,
			suppressError: true,
		})) {
			const owner = key.ownerId
			if (key.id === null || key.id.origin !== uri.origin || (owner !== null && owner.href !== uri.href)) {
				continue
			}
			if (key.publicKey !== null) {
				keys.push({ id: key.id.href, pem: await exportSpki(key.publicKey) })
			}
		}
	} catch {
		// A key that does not parse is not listed.
	}
	return keys
}

// The columns of a remote account (null if the document cannot be one). Display names are plain text; the bio is
// sanitized HTML (HTML-1); URLs are http(s) or null (HTML-3). Misskey's extensions (_misskey_summary, isCat, ...) are
// not interpreted; they stay in raw with the rest of the document.
export async function remoteActorInput(actor: Actor, document: unknown): Promise<RemoteActorInput | null> {
	const uri = actor.id
	const username = text(actor.preferredUsername)
	if (uri === null || !isStorableActorId(uri.href) || username === null || !isRemoteUsername(username)) {
		return null
	}
	const inboxUrl = httpUrl(actor.inboxId?.href ?? null)?.href ?? null
	// By Kopje's policy, an over-long inbox makes the actor unusable (nothing could be delivered to it), and an
	// over-long shared inbox is ignored, so its personal inbox is used.
	if (inboxUrl !== null && inboxUrl.length > INBOX_URL_LIMIT) {
		return null
	}
	const sharedInboxUrl = httpUrl(actor.endpoints?.sharedInbox?.href ?? null)?.href ?? null
	const options = { documentLoader: NO_FETCH, contextLoader: NO_FETCH }
	const images: Images = actor
	return {
		uri: uri.href,
		username,
		domain: hostDomain(uri.href),
		actorType: getActorTypeName(actor),
		displayName: (text(actor.name) ?? '').slice(0, DISPLAY_NAME_LIMIT),
		note: sanitizeRemoteBio(text(actor.summary) ?? ''),
		url: href(actor.url),
		avatarUrl: await imageUrl(() => images.getIcon(options)),
		headerUrl: await imageUrl(() => images.getImage(options)),
		locked: actor.manuallyApprovesFollowers === true,
		discoverable: actor.discoverable,
		inboxUrl,
		sharedInboxUrl: sharedInboxUrl !== null && sharedInboxUrl.length <= INBOX_URL_LIMIT ? sharedInboxUrl : null,
		// A Temporal.Instant, whose type the polyfill's globals leave unresolved for the linter.
		keys: await ownKeys(actor, uri),
		published: (actor.published as { toString(): string } | null)?.toString() ?? null,
		raw: JSON.stringify(document),
	}
}
