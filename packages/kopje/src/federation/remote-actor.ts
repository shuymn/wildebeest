import type { DocumentLoader } from '@fedify/fedify'
import { type Actor, getActorTypeName, type Image, isActor, Link, lookupObject } from '@fedify/vocab'

import { isTransientLoadError } from './loader'
import type { RemoteActorInput } from '../domain/inbox'
import { httpUrl } from '../platform/http-url'
import { sanitizeRemoteHtml } from '../security/html'

// Remote actors as Kopje stores them: fetched through the safe loader (NET-1, ID-8), parsed by Fedify's lookupObject,
// which checks the parsed id against the document's origin (ID-2), and reduced to bounded, safe columns.

// Mastodon's remote username rule (Account::USERNAME_RE), with a length bound (RES-1).
const USERNAME = /^[a-z0-9_]+([a-z0-9_.-]+[a-z0-9_]+)?$/i
const USERNAME_LIMIT = 255
// Raw caps (RES-1). The display name is plain text and is cut, as Mastodon cuts what it receives.
const DISPLAY_NAME_LIMIT = 2048

export type FetchedActor =
	| { kind: 'ok'; actor: Actor; input: RemoteActorInput | null }
	// Fetching again may succeed (timeout, network error, 5xx).
	| { kind: 'transient' }
	// Gone, refused, or not an actor with exactly this id.
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
		return { kind: isTransientLoadError(error) ? 'transient' : 'unusable' }
	}
	let object: unknown
	try {
		object = await lookupObject(uri, {
			documentLoader: (url, options) => (url === uri ? Promise.resolve(remote) : loader(url, options)),
			contextLoader,
		})
	} catch {
		return { kind: 'unusable' }
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

function href(value: URL | Link | null | undefined): string | null {
	const target = value instanceof Link ? value.href : value
	return httpUrl(target?.href ?? null)?.href ?? null
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

// The columns of a remote account (null if the document cannot be one). Display names are plain text; the bio is
// sanitized HTML (HTML-1); URLs are http(s) or null (HTML-3). Misskey's extensions (_misskey_summary, isCat, ...) are
// not interpreted; they stay in raw with the rest of the document.
export async function remoteActorInput(actor: Actor, document: unknown): Promise<RemoteActorInput | null> {
	const uri = actor.id
	const username = text(actor.preferredUsername)
	if (uri === null || username === null || username.length > USERNAME_LIMIT || !USERNAME.test(username)) {
		return null
	}
	const options = { documentLoader: NO_FETCH, contextLoader: NO_FETCH }
	const images: Images = actor
	return {
		uri: uri.href,
		username,
		domain: uri.host.toLowerCase(),
		actorType: getActorTypeName(actor),
		displayName: (text(actor.name) ?? '').slice(0, DISPLAY_NAME_LIMIT),
		note: sanitizeRemoteHtml(text(actor.summary) ?? ''),
		url: href(actor.url),
		avatarUrl: await imageUrl(() => images.getIcon(options)),
		headerUrl: await imageUrl(() => images.getImage(options)),
		locked: actor.manuallyApprovesFollowers === true,
		discoverable: actor.discoverable,
		inboxUrl: httpUrl(actor.inboxId?.href ?? null)?.href ?? null,
		sharedInboxUrl: httpUrl(actor.endpoints?.sharedInbox?.href ?? null)?.href ?? null,
		// A Temporal.Instant, whose type the polyfill's globals leave unresolved for the linter.
		published: (actor.published as { toString(): string } | null)?.toString() ?? null,
		raw: JSON.stringify(document),
	}
}
