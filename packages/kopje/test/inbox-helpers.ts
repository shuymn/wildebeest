import { exportSpki, signRequest } from '@fedify/fedify'
import { Temporal } from 'temporal-polyfill'

import { NOW } from './app-helpers'
import type { RemoteActorInput } from '../src/domain/inbox'
import { RSA_ALGORITHM } from '../src/security/key-wrap'

// Remote servers for inbox tests: synthetic, real-shaped actor documents (Mastodon 4.x and Misskey 2024+) served by
// an in-memory fetch, and activities signed as those servers sign them (draft-cavage, rsa-sha256, Digest). Nothing is
// fetched from a real server.

export const AP = 'application/activity+json'
export const LOCAL = 'https://kopje.test'
export const MASTODON = 'https://mastodon.example'
export const MISSKEY = 'https://misskey.example'

type Served = { status: number; body?: unknown; contentType?: string; location?: string; delayMs?: number }

// An in-memory web of remote documents. Unknown URLs answer 404; status 0 is a network failure.
export class RemoteWeb {
	readonly served = new Map<string, Served>()
	readonly fetched: string[] = []
	// The keyId each fetch was signed with ('unsigned' if none).
	readonly signers: string[] = []
	// URLs answered only to a fetch signed with the given keyId (403 otherwise), as a followers-only object is.
	readonly signedOnly = new Map<string, string>()
	// URLs whose next fetch waits at a gate (hold): a deterministic interleaving point, never a timer.
	readonly #held = new Map<string, { reached: () => void; gate: Promise<void> }[]>()

	// The next fetch of `url` not held yet stops before it is answered: `reached` resolves when it arrives, and it is
	// answered as served when `release` is called. Each call holds one more fetch, in order.
	hold(url: string): { reached: Promise<void>; release: () => void } {
		let reached!: () => void
		let release!: () => void
		const arrived = new Promise<void>((resolve) => (reached = resolve))
		const gate = new Promise<void>((resolve) => (release = resolve))
		this.#held.set(url, [...(this.#held.get(url) ?? []), { reached, gate }])
		return { reached: arrived, release }
	}

	readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(input, init)
		const url = new URL(request.url)
		url.hash = ''
		const held = this.#held.get(url.href)?.shift()
		if (held !== undefined) {
			held.reached()
			await held.gate
		}
		return this.answer(request, url)
	}) as typeof fetch

	private answer(request: Request, url: URL): Promise<Response> {
		this.fetched.push(url.href)
		const signer = /keyId="([^"]+)"/.exec(request.headers.get('signature') ?? '')?.[1] ?? 'unsigned'
		this.signers.push(signer)
		const only = this.signedOnly.get(url.href)
		if (only !== undefined && only !== signer) {
			return Promise.resolve(new Response('Forbidden', { status: 403 }))
		}
		const served = this.served.get(url.href)
		if (served === undefined) {
			return Promise.resolve(new Response('Not Found', { status: 404 }))
		}
		if (served.status === 0) {
			return Promise.reject(new TypeError('network connection lost'))
		}
		const body = served.body === undefined ? null : JSON.stringify(served.body)
		const headers: Record<string, string> = { 'content-type': served.contentType ?? AP }
		if (served.location !== undefined) {
			headers.location = served.location
		}
		const response = new Response(body, { status: served.status, headers })
		return served.delayMs === undefined
			? Promise.resolve(response)
			: new Promise<Response>((resolve) => setTimeout(() => resolve(response), served.delayMs))
	}

	get loader() {
		return { fetch: this.fetch, checkHost: () => Promise.resolve() }
	}

	serve(url: string, body: unknown, contentType = AP): void {
		this.served.set(url, { status: 200, body, contentType })
	}

	fail(url: string, status: number): void {
		this.served.set(url, { status })
	}

	redirect(url: string, location: string): void {
		this.served.set(url, { status: 302, location })
	}

	delay(url: string, delayMs: number): void {
		const served = this.served.get(url)
		if (served !== undefined) {
			this.served.set(url, { ...served, delayMs })
		}
	}
}

const pairs = new Map<number, Promise<CryptoKeyPair>>()

// RSA key pairs, generated once per test file and shared by index.
function keyPair(index: number): Promise<CryptoKeyPair> {
	let pair = pairs.get(index)
	if (pair === undefined) {
		pair = crypto.subtle.generateKey(
			{ ...RSA_ALGORITHM, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
			true,
			['sign', 'verify']
		) as Promise<CryptoKeyPair>
		pairs.set(index, pair)
	}
	return pair
}

export type TestActor = {
	uri: string
	keyId: string
	privateKey: CryptoKey
	pem: string
	document: Record<string, unknown>
}

const MASTODON_CONTEXT = [
	'https://www.w3.org/ns/activitystreams',
	'https://w3id.org/security/v1',
	{
		manuallyApprovesFollowers: 'as:manuallyApprovesFollowers',
		toot: 'http://joinmastodon.org/ns#',
		featured: { '@id': 'toot:featured', '@type': '@id' },
		featuredTags: { '@id': 'toot:featuredTags', '@type': '@id' },
		alsoKnownAs: { '@id': 'as:alsoKnownAs', '@type': '@id' },
		movedTo: { '@id': 'as:movedTo', '@type': '@id' },
		schema: 'http://schema.org#',
		PropertyValue: 'schema:PropertyValue',
		value: 'schema:value',
		discoverable: 'toot:discoverable',
		suspended: 'toot:suspended',
		memorial: 'toot:memorial',
		indexable: 'toot:indexable',
		attributionDomains: { '@id': 'toot:attributionDomains', '@type': '@id' },
		focalPoint: { '@container': '@list', '@id': 'toot:focalPoint' },
	},
]

// A Mastodon 4.x Person, as ActivityPub::ActorSerializer renders it.
export async function mastodonActor(
	web: RemoteWeb,
	username: string,
	options: { key?: number; origin?: string; uri?: string; extra?: Record<string, unknown> } = {}
): Promise<TestActor> {
	const origin = options.origin ?? MASTODON
	const uri = options.uri ?? `${origin}/users/${username}`
	const pair = await keyPair(options.key ?? 0)
	const pem = await exportSpki(pair.publicKey)
	const document: Record<string, unknown> = {
		'@context': MASTODON_CONTEXT,
		id: uri,
		type: 'Person',
		following: `${uri}/following`,
		followers: `${uri}/followers`,
		inbox: `${uri}/inbox`,
		outbox: `${uri}/outbox`,
		featured: `${uri}/collections/featured`,
		featuredTags: `${uri}/collections/tags`,
		preferredUsername: username,
		name: `${username} <b>display</b>`,
		summary:
			'<p>Bio with <a href="https://mastodon.example/tags/x" class="mention hashtag" rel="tag">#<span>x</span></a></p>',
		url: `${origin}/@${username}`,
		manuallyApprovesFollowers: false,
		discoverable: true,
		indexable: false,
		published: '2023-04-01T00:00:00Z',
		memorial: false,
		devices: `${uri}/collections/devices`,
		publicKey: { id: `${uri}#main-key`, owner: uri, publicKeyPem: pem },
		tag: [],
		attachment: [{ type: 'PropertyValue', name: 'Site', value: '<a href="https://example.com">example.com</a>' }],
		endpoints: { sharedInbox: `${origin}/inbox` },
		icon: { type: 'Image', mediaType: 'image/png', url: `${origin}/system/avatars/${username}.png` },
		image: { type: 'Image', mediaType: 'image/png', url: `${origin}/system/headers/${username}.png` },
		...options.extra,
	}
	web.serve(uri, document)
	return { uri, keyId: `${uri}#main-key`, privateKey: pair.privateKey, pem, document }
}

export const MISSKEY_CONTEXT = [
	'https://www.w3.org/ns/activitystreams',
	'https://w3id.org/security/v1',
	{
		Key: 'sec:Key',
		manuallyApprovesFollowers: 'as:manuallyApprovesFollowers',
		sensitive: 'as:sensitive',
		Hashtag: 'as:Hashtag',
		quoteUrl: 'as:quoteUrl',
		fedibird: 'http://fedibird.com/ns#',
		quoteUri: 'fedibird:quoteUri',
		toot: 'http://joinmastodon.org/ns#',
		Emoji: 'toot:Emoji',
		featured: 'toot:featured',
		discoverable: 'toot:discoverable',
		schema: 'http://schema.org#',
		PropertyValue: 'schema:PropertyValue',
		value: 'schema:value',
		misskey: 'https://misskey-hub.net/ns#',
		_misskey_content: 'misskey:_misskey_content',
		_misskey_quote: 'misskey:_misskey_quote',
		_misskey_reaction: 'misskey:_misskey_reaction',
		_misskey_votes: 'misskey:_misskey_votes',
		_misskey_summary: 'misskey:_misskey_summary',
		_misskey_followedMessage: 'misskey:_misskey_followedMessage',
		_misskey_requireSigninToViewContents: 'misskey:_misskey_requireSigninToViewContents',
		isCat: 'misskey:isCat',
		vcard: 'http://www.w3.org/2006/vcard/ns#',
	},
]

// A Misskey Person, as ApRendererService#renderPerson renders it: aid-style ids, the _misskey_* extensions, isCat,
// a sharedInbox at the top level as well as under endpoints, and a Key-typed publicKey.
export async function misskeyActor(
	web: RemoteWeb,
	id: string,
	username: string,
	options: { key?: number; extra?: Record<string, unknown> } = {}
): Promise<TestActor> {
	const uri = `${MISSKEY}/users/${id}`
	const pair = await keyPair(options.key ?? 1)
	const pem = await exportSpki(pair.publicKey)
	const document: Record<string, unknown> = {
		'@context': MISSKEY_CONTEXT,
		type: 'Person',
		id: uri,
		inbox: `${uri}/inbox`,
		outbox: `${uri}/outbox`,
		followers: `${uri}/followers`,
		following: `${uri}/following`,
		featured: `${uri}/collections/featured`,
		sharedInbox: `${MISSKEY}/inbox`,
		endpoints: { sharedInbox: `${MISSKEY}/inbox` },
		url: `${MISSKEY}/@${username}`,
		preferredUsername: username,
		name: 'みすきー :cat:',
		summary:
			'<p><span>にゃーん</span><br><a href="https://misskey.example/@friend" class="u-url mention">@friend</a></p>',
		_misskey_summary: 'にゃーん\n@friend',
		_misskey_followedMessage: null,
		_misskey_requireSigninToViewContents: false,
		icon: { type: 'Image', url: `${MISSKEY}/files/avatar-${id}.webp`, sensitive: false, name: null },
		image: null,
		backgroundUrl: null,
		tag: [
			{
				id: `${MISSKEY}/emojis/cat`,
				type: 'Emoji',
				name: ':cat:',
				icon: { type: 'Image', url: `${MISSKEY}/e/cat.png` },
			},
		],
		manuallyApprovesFollowers: false,
		discoverable: true,
		publicKey: { id: `${uri}#main-key`, type: 'Key', owner: uri, publicKeyPem: pem },
		isCat: true,
		attachment: [],
		...options.extra,
	}
	web.serve(uri, document)
	return { uri, keyId: `${uri}#main-key`, privateKey: pair.privateKey, pem, document }
}

export type SignOptions = {
	keyId?: string
	privateKey?: CryptoKey
	contentType?: string
	at?: number
	headers?: Record<string, string>
}

// The init of a POST of `activity` to `path`, signed as `actor` signs (Date at `at`, Digest, Host).
export async function signedInit(
	actor: TestActor,
	path: string,
	activity: unknown,
	options: SignOptions = {}
): Promise<RequestInit> {
	const body = typeof activity === 'string' ? activity : JSON.stringify(activity)
	const unsigned = new Request(`${LOCAL}${path}`, {
		method: 'POST',
		headers: { 'content-type': options.contentType ?? AP, ...options.headers },
		body,
	})
	const signed = await signRequest(
		unsigned,
		options.privateKey ?? actor.privateKey,
		new URL(options.keyId ?? actor.keyId),
		{
			spec: 'draft-cavage-http-signatures-12',
			currentTime: Temporal.Instant.fromEpochMilliseconds(options.at ?? NOW),
		}
	)
	return { method: 'POST', headers: signed.headers, body }
}

// What a test's RemoteActorInput leaves at its defaults: a Person with no profile text or images, flags off, no shared
// inbox, keys or emoji, and an empty document. A fresh object each call.
export function actorDefaults(): Omit<
	RemoteActorInput,
	'uri' | 'username' | 'domain' | 'displayName' | 'inboxUrl' | 'movedTo'
> {
	return {
		actorType: 'Person',
		note: '',
		url: null,
		avatarUrl: null,
		headerUrl: null,
		locked: false,
		discoverable: null,
		indexable: false,
		sharedInboxUrl: null,
		published: null,
		keys: [],
		emojiTags: [],
		raw: '{}',
	}
}
