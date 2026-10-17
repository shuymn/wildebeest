// The expected side of the conversion check, computed from the legacy data alone. It shares nothing with convert.js:
// it reads legacy columns and JSON directly, takes every audience from the addressing as exported (captured before any
// bridge migration ran), and writes each record in the comparison form of verify-actual.js, keyed by AP URIs (never by
// the ids the converter assigns). The only shared code is the Worker's own runtime (kopje-runtime.js): its HTML
// sanitizers and text bounds, which the Store applies to every stored value (HTML-1, RES-2), and its identity checks;
// test-node/cutover-sanitize.test.ts pins the sanitizer's output by hand.
//
// Records are kept as exact values, not digests, so a change of the same length is still a difference. They hold data
// and are never printed: reports carry counts and digests only.

import { createHmac } from 'node:crypto'
import { domainToASCII } from 'node:url'

import {
	cutJsonString,
	jsonStringBytes,
	isRemoteUsername,
	isStorableActorId,
	REMOTE_BIO_BYTES,
	STATUS_URI_LIMIT,
	withinIdentityBound,
	REMOTE_HTML_RAW_LIMIT,
	sanitizeRemoteBio,
	sanitizeRemoteContent,
	sanitizeRemoteHtml,
	SPOILER_BYTES,
	STATUS_CONTENT_BYTES,
} from './kopje-runtime.js'

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public'
const STATUS_TYPES = new Set(['Note', 'Article', 'Page', 'Question', 'Video', 'Audio', 'Event'])
const SETTING_NAMES = new Map([
	['server name', 'title'],
	['server description', 'description'],
	['extended description', 'extended_description'],
	['privacy policy', 'privacy_policy'],
])

/** @typedef {import('./verify-actual.js').Records} Records */
/** @typedef {Record<string, any>} Json */

/** @param {unknown} text @returns {Json} */
function parse(text) {
	try {
		const value = /** @type {unknown} */ (JSON.parse(String(text)))
		return typeof value === 'object' && value !== null ? /** @type {Json} */ (value) : {}
	} catch {
		return {}
	}
}

/** @param {unknown} value @returns {unknown[]} */
const many = (value) => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value])

/** @param {unknown} value @returns {string | null} */
function ref(value) {
	if (typeof value === 'string') {
		return value
	}
	if (typeof value === 'object' && value !== null) {
		const v = /** @type {Json} */ (value)
		return typeof v.id === 'string' ? v.id : typeof v.href === 'string' ? v.href : null
	}
	return null
}

/** @param {unknown} value @returns {string | null} */
function href(value) {
	if (typeof value === 'string') {
		return value
	}
	if (Array.isArray(value)) {
		return value.map(href).find((x) => x !== null) ?? null
	}
	if (typeof value === 'object' && value !== null) {
		const v = /** @type {Json} */ (value)
		return href(v.href ?? v.url)
	}
	return null
}

// UTF-8 cannot carry a lone surrogate, so the Store holds U+FFFD in its place: compare text as it can be stored.
/** @param {unknown} value */
const text = (value) => (typeof value === 'string' ? value.toWellFormed() : '')

/**
 * A time as an ISO string. Legacy writes 'YYYY-MM-DD HH:MM[:SS[.fff]]' (cdate, in UTC) and may keep a time in that form
 * with its zone ('Z' or '+09:00'); a time without a zone is UTC. Anything else is read as written.
 * @param {unknown} value
 */
function when(value) {
	if (typeof value !== 'string' || value === '') {
		return null
	}
	const spaced = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:\d{2})?$/.exec(value)
	const ms = Date.parse(spaced === null ? value : `${spaced[1]}T${spaced[2]}${spaced[3] ?? 'Z'}`)
	return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

/**
 * The language a status declares, as Kopje reads one from an object (src/domain/language.ts), written out here on its
 * own: the first tag of its contentMap, else nameMap, else summaryMap, cut to its primary subtag in lowercase, when that
 * is two or three letters (ISO 639). Legacy itself never showed a language.
 * @param {Json} p
 */
function languageOf(p) {
	for (const key of ['contentMap', 'nameMap', 'summaryMap']) {
		const map = p[key]
		const first = typeof map === 'object' && map !== null && !Array.isArray(map) ? Object.keys(map)[0] : undefined
		if (first !== undefined) {
			const primary = (first.split(/[-_]/)[0] ?? '').toLowerCase()
			return /^[a-z]{2,3}$/.test(primary) ? primary : null
		}
	}
	return null
}

// A hashtag as status_tags names it: Mastodon's HashtagNormalizer#normalize, written out here apart from Kopje's
// (src/domain/tag-name.ts) so that verify-conversion checks the converter's names. NFKC; each code point lowercased
// (String#downcase has no final-sigma rule); a letter of ASCIIFolding's table replaced by its ASCII letter; and only the
// characters Tag::HASHTAG_INVALID_CHARS_RE does not match kept: Alphabetic, decimal digits, Thai U+0E47 to U+0E4E and
// the separators _, U+00B7, U+30FB and U+200C. So a received Hashtag's # goes with the other characters no hashtag
// holds, and so does a fullwidth or small number sign in legacy's note_hashtags (the text after # in the status,
// getHashtags). Empty is no hashtag.
const FOLDED_LETTERS =
	'ÀÁÂÃÄÅàáâãäåĀāĂăĄąÇçĆćĈĉĊċČčÐðĎďĐđÈÉÊËèéêëĒēĔĕĖėĘęĚěĜĝĞğĠġĢģĤĥĦħÌÍÎÏìíîïĨĩĪīĬĭĮįİıĴĵĶķĸĹĺĻļĽľĿŀŁłÑñŃńŅņŇňŉŊŋÒÓÔÕÖØòóôõöøŌōŎŏŐőŔŕŖŗŘřŚśŜŝŞşŠšſŢţŤťŦŧÙÚÛÜùúûüŨũŪūŬŭŮůŰűŲųŴŵÝýÿŶŷŸŹźŻżŽž'
const ASCII_LETTERS =
	'AAAAAAaaaaaaAaAaAaCcCcCcCcCcDdDdDdEEEEeeeeEeEeEeEeEeGgGgGgGgHhHhIIIIiiiiIiIiIiIiIiJjKkkLlLlLlLlLlNnNnNnNnnNnOOOOOOooooooOoOoOoRrRrRrSsSsSsSssTtTtTtUUUUuuuuUuUuUuUuUuUuWwYyyYyYZzZzZz'
const HASHTAG_CHARACTER = /^[\p{Alphabetic}\p{Nd}\u0E47-\u0E4E_\u00B7\u30FB\u200C]$/u
/** @param {unknown} value */
const hashtagName = (value) =>
	[...text(value).normalize('NFKC')]
		.flatMap((c) => [...c.toLowerCase()])
		.map((c) => {
			const at = FOLDED_LETTERS.indexOf(c)
			return at === -1 ? c : ASCII_LETTERS.charAt(at)
		})
		.filter((c) => HASHTAG_CHARACTER.test(c))
		.join('')

/** @param {unknown} value whether a legacy value is JSON text, as the Store requires of follows.languages */
function isJsonText(value) {
	if (typeof value !== 'string') {
		return false
	}
	try {
		JSON.parse(value)
		return true
	} catch {
		return false
	}
}

/** @param {Uint8Array} bytes */
const hex = (bytes) =>
	Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
		.join('')
		.toUpperCase()

/**
 * An address the way legacy resolves one (getApId in packages/backend/src/activitypub/objects/index.ts): a URL string
 * in its normalized form, or an object's id, followed through nested objects. Anything else could not be resolved by
 * legacy, which is undefined here.
 * @param {unknown} value
 * @param {number} [hops]
 * @returns {string | undefined}
 */
function address(value, hops = 0) {
	if (typeof value === 'string') {
		return URL.canParse(value) ? new URL(value).toString() : undefined
	}
	if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'id' in value && hops < 16) {
		return address(/** @type {{ id: unknown }} */ (value).id, hops + 1)
	}
	return undefined
}

// A domain block's domain as Kopje stores it, worked out here on its own: a trailing slash and a trailing dot dropped,
// lowercased, IDNA to ASCII (punycode), and only a hostname of two or more labels, not an IPv4 address. null when it
// is no domain name (the converter drops the row).
/** @param {string} raw */
function blockedDomainOf(raw) {
	const name = raw.trim().replace(/\/$/, '').replace(/\.$/, '')
	if (name === '' || name.endsWith('.') || /[\s/\\?#@:[\]%]/.test(name)) {
		return null
	}
	const ascii = domainToASCII(name)
	return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(ascii) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(ascii) ? ascii : null
}

/**
 * The stored author's followers as legacy's detectVisibility sees them: actorFromRow keeps the property as spelled and
 * builds `<id>/followers` from the parsed actor id only when the property is missing; then followers.toString(). Undefined
 * where legacy fails (no loadable actor, a null value, an unparsable id).
 * @param {string | null} actor
 * @param {{ present: boolean, value: unknown } | null | undefined} property
 * @returns {string | undefined}
 */
export function followersOf(actor, property) {
	if (actor === null || property === null || property === undefined || (property.present && property.value === null)) {
		return undefined
	}
	if (property.present) {
		return `${/** @type {string} */ (property.value)}`
	}
	if (!URL.canParse(actor)) {
		return undefined
	}
	const built = `${new URL(actor).toString()}/followers`
	return URL.canParse(built) ? new URL(built).toString() : undefined
}

/**
 * Who could read an object in legacy Wildebeest (status_visibility.ts): with Public in to, anyone; with the author's
 * followers in to, anyone (Public also in cc) or the followers; otherwise the accounts in to. Addresses are resolved as
 * getApId does; the followers value is matched as spelled, and 'ambiguous' where matching it normalized would differ.
 * 'unreadable' where legacy fails.
 * @param {unknown} to
 * @param {unknown} cc
 * @param {string | undefined} followers from followersOf
 */
export function audienceOf(to, cc, followers) {
	const t = many(to).map((x) => address(x))
	const c = many(cc).map((x) => address(x))
	if (t.includes(undefined) || c.includes(undefined)) {
		return { visibility: 'unreadable', to: [] }
	}
	if (t.includes(PUBLIC)) {
		return { visibility: 'public', to: t }
	}
	if (followers === undefined) {
		return { visibility: 'unreadable', to: [] }
	}
	const spelled = t.indexOf(followers) !== -1
	const resolved = address(followers)
	if (spelled !== (resolved !== undefined && t.indexOf(resolved) !== -1)) {
		return { visibility: 'ambiguous', to: t }
	}
	return { visibility: spelled ? (c.includes(PUBLIC) ? 'unlisted' : 'private') : 'direct', to: t }
}

// Cloudflare Images delivery URLs (`kopje-admin images-export`), and the account cloudflare/wildebeest's default
// images are under.
const DELIVERY = /^https:\/\/imagedelivery\.net\/([^/]+)\/([^/]+)\/([^/]+)$/
const UPSTREAM_DEFAULTS = 'NkfPDviynOyTAOI79ar_GQ'
const MASTODON_MISSING_AVATAR =
	'https://raw.githubusercontent.com/mastodon/mastodon/main/public/avatars/original/missing.png'

/**
 * A media meta value in comparison form: full and preview sizes, null where absent.
 * @param {unknown} meta
 */
function metaSizes(meta) {
	if (typeof meta !== 'object' || meta === null) {
		return null
	}
	const m = /** @type {Json} */ (meta)
	/** @type {unknown[]} */
	const sizes = [m.original?.width ?? null, m.original?.height ?? null, m.small?.width ?? null, m.small?.height ?? null]
	return sizes
}

/**
 * The thread of each status, from the reply records alone, each status walked once: a status that replies to no status
 * carried takes the conversation its stored object names, else the inReplyTo it names, else its own URI, and each
 * reply below it takes its thread; a status in a cycle of replies, or below one, takes the same as a start would.
 * @param {Record<string, string>} replies the `replies` records: status URI -> [inReplyTo, the carried parent's URI]
 * @param {Record<string, string>} statuses the `statuses` records, by status URI
 * @param {Map<string, string>} [conversations] status URI -> the conversation its stored object names
 * @returns {(uri: string) => string}
 */
export function threadsOf(replies, statuses, conversations = new Map()) {
	/** @type {Map<string, string | null>} status URI -> what it replies to (in_reply_to_uri) */
	const inReplyToOf = new Map()
	/** @type {Map<string, string>} status URI -> the carried status it replies to */
	const parentOf = new Map()
	for (const [uri, record] of Object.entries(replies)) {
		const [inReplyTo, parent] = /** @type {[string | null, string | null]} */ (JSON.parse(record))
		inReplyToOf.set(uri, inReplyTo)
		if (parent !== null && statuses[parent] !== undefined) {
			parentOf.set(uri, parent)
		}
	}
	/** @param {string} uri */
	const ownThread = (uri) => conversations.get(uri) ?? inReplyToOf.get(uri) ?? uri
	/** @type {Map<string, string | null>} status URI -> its thread, or null when no chain start is above it */
	const chained = new Map()
	/** @param {string} uri @returns {string} */
	const threadOf = (uri) => {
		/** @type {string[]} */
		const path = []
		const onPath = new Set()
		/** @type {string | null} */
		let found = null
		for (let at = uri; ;) {
			const known = chained.get(at)
			if (known !== undefined) {
				found = known
				break
			}
			if (onPath.has(at)) {
				break
			}
			path.push(at)
			onPath.add(at)
			const parent = parentOf.get(at)
			if (parent === undefined) {
				found = ownThread(at)
				break
			}
			at = parent
		}
		for (const at of path) {
			chained.set(at, found)
		}
		return chained.get(uri) ?? ownThread(uri)
	}
	return threadOf
}

/**
 * @param {import('node:sqlite').DatabaseSync} db the bridged legacy database
 * @param {{ originalActorIds: Map<string, string>, source: import('./legacy-load.js').SourceAddressing,
 *   notificationSequence: string | null, images?: import('./images-export.js').ImagesFile }} options
 * @returns {{ records: Records, overLimit: number, images: { missing: number, unmapped: number },
 *   dropped: Record<string, number>, identities: number }} dropped: rows the conversion must leave out, which need
 *   --accept-deletions; identities: actor ids, remote usernames and status uris the Worker would refuse
 */
export function expectedFromLegacy(db, { originalActorIds, source, notificationSequence, images }) {
	/** @type {Records} */
	const out = {}
	let overLimit = 0
	let identities = 0
	/** @type {Record<string, number>} */
	const dropped = {}
	/** @param {string} category @param {string} key @param {unknown} value */
	const put = (category, key, value) => {
		const records = (out[category] ??= {})
		records[key] = JSON.stringify(value)
	}
	/** @param {string} sql */
	const all = (sql) => /** @type {Json[]} */ (db.prepare(sql).all())
	/** @param {unknown} value */
	const sanitized = (value) => {
		if (text(value).length > REMOTE_HTML_RAW_LIMIT) {
			overLimit++
		}
		return sanitizeRemoteHtml(text(value))
	}
	// RES-2: a bio and status content within their JSON-byte bounds, as the converter and the Worker store them
	// (src/security/html.ts); a cut is a truncation too.
	/** @param {unknown} value @param {number} bytes @param {(html: string) => string} within */
	const sanitizedWithin = (value, bytes, within) => {
		const whole = sanitized(value)
		if (jsonStringBytes(whole) <= bytes) {
			return whole
		}
		overLimit++
		return within(text(value))
	}
	/** @param {unknown} value */
	const bio = (value) => sanitizedWithin(value, REMOTE_BIO_BYTES, sanitizeRemoteBio)
	/** @param {unknown} value */
	const content = (value) => sanitizedWithin(value, STATUS_CONTENT_BYTES, sanitizeRemoteContent)
	// A content warning and source text cut to their bounds (cutJsonString), each cut a truncation.
	/** @param {string} value @param {number} bytes */
	const bounded = (value, bytes) => {
		const cut = cutJsonString(value, bytes)
		if (cut !== value) {
			overLimit++
		}
		return cut
	}

	// Accounts and profiles.
	const local = new Set(all('SELECT actor_id FROM users').map((u) => String(u.actor_id)))
	const domain = [...local].map((uri) => new URL(uri).host.toLowerCase())[0] ?? ''

	// With images.json: where a local reference to the operator's Cloudflare Images must point, from the mapping alone.
	// Every media row showing a mapped image has a token of its own, HMAC-SHA256 under the image's secret of the
	// reference's key (docs/cutover.md, "Media"), and is served from /media/<token>/{full,small}.<ext> on the instance
	// origin, as PNG when it is a PNG and as WebP otherwise, with its type and sizes (full within 3840 pixels, the preview
	// within 640 of that). A missing image and a default profile image are expected to be gone.
	const imageCounts = { missing: 0, unmapped: 0 }
	/** @param {number} width @param {number} height @param {number} edge */
	const within = (width, height, edge) => {
		const longest = Math.max(width, height)
		const scale = longest > edge ? edge / longest : 1
		return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))]
	}
	/**
	 * What a local reference becomes: gone, kept as it is, or an image of images.json.
	 * @param {string | null} url
	 * @param {boolean} profile
	 * @returns {{ gone: true } | { gone: false, url: string | null, imageId: null }
	 *   | { gone: false, url: null, imageId: string, entry: Extract<import('./images-export.js').ImageEntry, { state: 'ok' }> }}
	 */
	const resolveImage = (url, profile) => {
		if (images !== undefined && profile && url === MASTODON_MISSING_AVATAR) {
			return { gone: true }
		}
		const match = images === undefined || url === null ? null : DELIVERY.exec(url)
		if (images === undefined || match === null) {
			return { gone: false, url, imageId: null }
		}
		const [, account, imageId = ''] = match
		if (profile && account === UPSTREAM_DEFAULTS) {
			return { gone: true }
		}
		if (account !== images.accountHash) {
			return { gone: false, url, imageId: null }
		}
		const entry = images.images.get(imageId)
		if (entry === undefined) {
			imageCounts.unmapped++
			return { gone: false, url, imageId: null }
		}
		if (entry.state !== 'ok') {
			imageCounts.missing++
			return { gone: true }
		}
		return { gone: false, url: null, imageId, entry }
	}
	/**
	 * The files of the media row with this key showing a resolved image (registered in media_files), or the kept URL.
	 * @param {ReturnType<typeof resolveImage>} resolved
	 * @param {string} key
	 * @returns {{ url: string | null, preview: string | null, meta: unknown[] | null } | undefined}
	 */
	const filesOf = (resolved, key) => {
		if (resolved.gone) {
			return undefined
		}
		if (resolved.imageId === null) {
			return { url: resolved.url, preview: null, meta: null }
		}
		const { entry } = resolved
		const token = createHmac('sha256', entry.secret).update(key).digest('base64url')
		const extension = entry.type === 'image/png' ? 'png' : 'webp'
		const [fullWidth = 0, fullHeight = 0] = within(entry.width, entry.height, 3840)
		const files = {
			url: `https://${domain}/media/${token}/full.${extension}`,
			preview: `https://${domain}/media/${token}/small.${extension}`,
			meta: [fullWidth, fullHeight, ...within(fullWidth, fullHeight, 640)],
		}
		put('media_files', token, [files.url, files.preview, `image/${extension}`, files.meta])
		return files
	}
	/** @type {Map<string, Json>} */
	const actors = new Map()
	for (const actor of all('SELECT id, type, properties FROM actors')) {
		const uri = String(actor.id)
		const p = parse(actor.properties)
		actors.set(uri, p)
		const isLocal = local.has(uri)
		// An identity the Worker would refuse, as the converter refuses it (src/platform/identity-bounds.ts).
		const username =
			text(p.preferredUsername) || uri.replace(/\/+$/, '').slice(uri.replace(/\/+$/, '').lastIndexOf('/') + 1)
		if (!isLocal && (!isStorableActorId(uri) || !isRemoteUsername(username))) {
			identities++
		}
		/** @param {unknown} value @param {string} kind */
		const profileImage = (value, kind) => {
			const url = href(typeof value === 'object' && value !== null ? /** @type {Json} */ (value).url : value)
			if (!isLocal) {
				return url
			}
			const converted = filesOf(resolveImage(url, true), `profile\n${uri}\n${kind}`)?.url ?? null
			// A local profile whose image changed is announced at publication (the dump's profile_updates).
			if (converted !== url) {
				put('profile_updates', uri, 1)
			}
			return converted
		}
		put('accounts', uri, [
			isLocal ? 1 : 0,
			isLocal ? text(p.preferredUsername) : null,
			text(p.name),
			bio(p.summary),
			profileImage(p.icon, 'avatar'),
			profileImage(p.image, 'header'),
			p.manuallyApprovesFollowers === true ? 1 : 0,
			// Legacy showed the type of the actors row; the properties' type where the row has none.
			text(actor.type) || text(p.type) || 'Person',
			// Unset: a local account stays undiscoverable, as legacy showed and published it (false); a remote one is unknown,
			// as Kopje stores a fetched actor that omits it (src/federation/remote-actor.ts).
			typeof p.discoverable === 'boolean' ? (p.discoverable ? 1 : 0) : isLocal ? 0 : null,
		])
		if (!isLocal) {
			put('raw', `account ${uri}`, String(actor.properties))
		}
	}
	const known = (/** @type {unknown} */ uri) => actors.has(String(uri))
	/** @type {Map<string, string>} actor by its address in legacy's normalized form */
	const byAddress = new Map()
	for (const uri of actors.keys()) {
		const normalized = address(uri)
		if (normalized !== undefined) {
			byAddress.set(normalized, uri)
		}
	}
	// The local account: its keys, its aliases (the actor's alsoKnownAs) and its posting defaults (actor_preferences as
	// legacy read them, their defaults where a user has no row).
	const preferences = new Map(all('SELECT * FROM actor_preferences').map((p) => [String(p.id), p]))
	for (const user of all('SELECT actor_id, email, privkey, privkey_salt, pubkey FROM users')) {
		const preference = preferences.get(String(user.actor_id))
		put('keys', String(user.actor_id), [
			String(user.email),
			hex(user.privkey),
			hex(user.privkey_salt),
			String(user.pubkey),
			many(actors.get(String(user.actor_id))?.alsoKnownAs).filter((x) => typeof x === 'string'),
			text(preference?.posting_default_visibility) || 'public',
			preference?.posting_default_sensitive === 1 ? 1 : 0,
			typeof preference?.posting_default_language === 'string' ? preference.posting_default_language : null,
		])
	}
	// Statuses.
	/** @type {Map<string, string>} object id -> status URI */
	const statusUri = new Map()
	const objects = all('SELECT * FROM objects')
	for (const o of objects) {
		if (!STATUS_TYPES.has(String(o.type)) || !known(o.original_actor_id)) {
			continue
		}
		const id = String(o.id)
		const uri =
			o.local !== 1 && typeof o.original_object_id === 'string' && o.original_object_id !== id
				? o.original_object_id
				: id
		statusUri.set(id, uri)
		if (!withinIdentityBound(uri, STATUS_URI_LIMIT)) {
			identities++
		}
	}
	const byUri = new Set(statusUri.values())
	/**
	 * @typedef {{ imageId: string | null, link: string, url: string | null, preview: string | null, description: string,
	 *   meta: unknown[] | null }} Shown
	 */
	/** @type {Map<string, Shown[]>} status URI -> its attachments now */
	const currentMedia = new Map()
	/** @param {Json} element the size an attachment declares, as legacy stored it */
	const sized = (element) =>
		typeof element.width === 'number' && typeof element.height === 'number' && element.width > 0 && element.height > 0
			? { original: { width: element.width, height: element.height } }
			: null
	/** @type {Map<string, string[]>} */
	const statusApiIds = new Map()
	const prefix = `https://${domain}/ap/o/`
	/** @type {Map<string, string[]>} object id -> the hashtags legacy recorded for it */
	const recordedTags = new Map()
	for (const h of all('SELECT value, object_id FROM note_hashtags')) {
		recordedTags.set(String(h.object_id), [...(recordedTags.get(String(h.object_id)) ?? []), hashtagName(h.value)])
	}
	/** @type {Map<string, string>} status URI -> the conversation its object names */
	const namedConversations = new Map()
	for (const o of objects) {
		const id = String(o.id)
		const uri = statusUri.get(id)
		if (uri === undefined) {
			continue
		}
		const p = parse(o.properties)
		// The conversation a remote status's object names (Mastodon's `conversation`): a string of 1 to 4,096 UTF-8 bytes,
		// as Kopje reads one when it receives a status and from the object it keeps.
		if (o.local !== 1 && typeof p.conversation === 'string') {
			const bytes = new TextEncoder().encode(p.conversation).length
			if (bytes > 0 && bytes <= 4096) {
				namedConversations.set(uri, p.conversation)
			}
		}
		const author = String(o.original_actor_id)
		const isLocal = o.local === 1
		const spoiler = bounded(
			isLocal ? text(p.spoiler_text) || text(p.summary) : text(p.summary) || text(p.spoiler_text),
			SPOILER_BYTES
		)
		const sourceText =
			isLocal && typeof p.source === 'object' && p.source !== null && typeof p.source.content === 'string'
				? bounded(text(p.source.content), STATUS_CONTENT_BYTES)
				: null
		// Hashtags: the object's Hashtag tags and the ones legacy recorded for it. An edit time equal to the publication
		// time is stored as none, as Kopje stores an incoming status (src/domain/remote-statuses.ts).
		const published = when(p.published) ?? when(o.cdate)
		const updated = when(p.updated)
		const hashtags = [
			...many(p.tag)
				.filter((t) => typeof t === 'object' && t !== null && /** @type {Json} */ (t).type === 'Hashtag')
				.map((t) => hashtagName(/** @type {Json} */ (t).name)),
			...(recordedTags.get(id) ?? []),
		]
		// The audience, from the object's addressing and stored author as exported.
		const addressing = source.objects.get(id) ?? { to: undefined, cc: undefined }
		const stored = source.authors.get(id) ?? null
		const audience = audienceOf(
			addressing.to,
			addressing.cc,
			followersOf(stored, stored === null ? null : source.followers.get(stored))
		)
		// Each hashtag is listed on hashtag timelines (status_tags.public) when the status is public.
		const listed = audience.visibility === 'public' ? 1 : 0
		put('statuses', uri, [
			author,
			content(p.content),
			sourceText,
			spoiler,
			p.sensitive === true ? 1 : 0,
			published,
			languageOf(p),
			updated !== published ? updated : null,
			[...new Set(hashtags.filter((x) => x !== ''))].sort().map((name) => [name, listed]),
		])

		// Recipients: for public and unlisted, the tagged known accounts and, silently, the other addressed ones; for
		// followers-only, none (a follow decides); for direct, exactly the known accounts in to (tagged ones not silent),
		// each marked as a mention in a status only a mention lets one see (status_mentions.requires_mention), and each
		// naming the status's author (status_mentions.author_id). Non-public audiences also name the author legacy
		// authorized with.
		const requiresMention = audience.visibility === 'direct' ? 1 : 0
		const accountAt = (/** @type {unknown} */ x) => byAddress.get(address(x) ?? '')
		const tagged = new Set(
			many(p.tag)
				.filter((t) => typeof t === 'object' && t !== null && /** @type {Json} */ (t).type === 'Mention')
				.map((t) => accountAt(/** @type {Json} */ (t).href))
				.filter((x) => x !== undefined && x !== author)
		)
		const inTo = many(addressing.to)
			.map(accountAt)
			.filter((x) => x !== undefined && x !== author)
		const inCc = many(addressing.cc)
			.map(accountAt)
			.filter((x) => x !== undefined && x !== author)
		/** @type {Set<unknown>} */
		let readers = new Set([...tagged, ...inTo, ...inCc])
		if (
			audience.visibility === 'private' ||
			audience.visibility === 'unreadable' ||
			audience.visibility === 'ambiguous'
		) {
			readers = new Set()
		} else if (audience.visibility === 'direct') {
			readers = new Set(inTo)
		}
		const open = audience.visibility === 'public' || audience.visibility === 'unlisted'
		put('audience', uri, [
			audience.visibility,
			[...readers]
				.map(
					(x) =>
						/** @type {[string, number, number, string]} */ ([
							String(x),
							tagged.has(/** @type {string} */ (x)) ? 0 : 1,
							requiresMention,
							author,
						])
				)
				.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
			open ? null : stored,
		])

		// Reply link: inReplyTo, and the status it points to (by URI, else the one legacy linked).
		const inReplyTo = ref(p.inReplyTo)
		const linked = typeof o.in_reply_to_id === 'string' ? statusUri.get(o.in_reply_to_id) : undefined
		const parent = inReplyTo !== null && byUri.has(inReplyTo) ? inReplyTo : (linked ?? null)
		if (inReplyTo !== null || parent !== null) {
			put('replies', uri, [inReplyTo ?? parent, parent])
		}
		if (!isLocal) {
			put('raw', `status ${uri}`, String(o.properties))
			if (uri !== id && id.startsWith(prefix)) {
				put('aliases', id.slice(prefix.length), uri)
			}
		}
		// Each attachment with a URL, at its position: what the status shows now (also the last version of its edits).
		/** @type {Shown[]} */
		const shown = []
		many(p.attachment).forEach((a, position) => {
			const element = /** @type {Json} */ (a)
			const link = typeof a === 'object' && a !== null ? href(element.url) : null
			if (link === null) {
				return
			}
			const resolved = isLocal ? resolveImage(link, false) : { gone: false, url: link, imageId: null }
			const files = filesOf(
				/** @type {ReturnType<typeof resolveImage>} */ (resolved),
				`attachment\n${uri}\n${position}`
			)
			if (files !== undefined) {
				shown.push({
					imageId: resolved.gone ? null : resolved.imageId,
					link,
					url: files.url,
					preview: files.preview ?? files.url,
					description: text(element.name) || text(element.description) || text(element.summary),
					meta: files.meta ?? metaSizes(sized(element)),
				})
			}
		})
		currentMedia.set(uri, shown)
		if (shown.length > 0) {
			put(
				'attachments',
				uri,
				shown.map((m) => [m.url, m.description])
			)
		}
		statusApiIds.set(String(o.mastodon_id), [...(statusApiIds.get(String(o.mastodon_id)) ?? []), uri])
		if (isLocal) {
			const tail = (href(p.url) ?? '').replace(/\/+$/, '').split('/').pop() ?? ''
			if (tail !== '' && tail !== String(o.mastodon_id)) {
				statusApiIds.set(tail, [...(statusApiIds.get(tail) ?? []), uri])
			}
		}
	}

	// Local images: their old /ap/o/<uuid>, URL, owner (the stored author as exported) and the status that shows them:
	// the first local status, in export order, whose attachment names the image by id, else by URL, each image once.
	const localImages = objects.filter((o) => o.type === 'Image' && o.local === 1)
	/** @type {Map<string, { uri: string, position: number, link: string | null }>} image id -> where a status shows it */
	const shownIn = new Map()
	for (const o of objects) {
		const uri = statusUri.get(String(o.id))
		if (uri === undefined || o.local !== 1) {
			continue
		}
		many(parse(o.properties).attachment).forEach((a, position) => {
			if (typeof a !== 'object' || a === null) {
				return
			}
			const element = /** @type {Json} */ (a)
			const byId = localImages.find((i) => typeof element.id === 'string' && String(i.id) === element.id)
			const link = href(element.url)
			const match = byId ?? localImages.find((i) => link !== null && href(parse(i.properties).url) === link)
			if (match !== undefined && !shownIn.has(String(match.id))) {
				shownIn.set(String(match.id), { uri, position, link })
			}
		})
	}
	for (const o of localImages) {
		const id = String(o.id)
		const own = href(parse(o.properties).url)
		const where = shownIn.get(id)
		// Shown by a status: the image is that attachment's row; otherwise a row of its own.
		const files =
			where === undefined
				? filesOf(resolveImage(own, false), `image\n${id}`)
				: filesOf(resolveImage(where.link ?? own, false), `attachment\n${where.uri}\n${where.position}`)
		if (id.startsWith(prefix) && files !== undefined) {
			put('media', id.slice(prefix.length), [files.url, source.authors.get(id) ?? null, where?.uri ?? null])
		}
	}

	// Edits: the earlier versions in order, then the current one.
	/** @type {Map<string, unknown[]>} */
	const history = new Map()
	const localObjects = new Set(objects.filter((o) => o.local === 1).map((o) => String(o.id)))
	for (const r of all('SELECT object_id, properties FROM object_revisions ORDER BY id')) {
		const uri = statusUri.get(String(r.object_id))
		if (uri === undefined) {
			continue
		}
		const p = parse(r.properties)
		const isLocal = localObjects.has(String(r.object_id))
		const now = currentMedia.get(uri) ?? []
		// Each attachment of the version: an image the status still shows is that row; an image only earlier versions
		// show has a row of its own per status; anything else is presented as it was.
		const media = many(p.attachment)
			.filter((a) => typeof a === 'object' && a !== null)
			.flatMap((a) => {
				const element = /** @type {Json} */ (a)
				const link = href(element.url)
				const resolved = isLocal ? resolveImage(link, false) : { gone: false, url: link, imageId: null }
				if (resolved.gone) {
					return []
				}
				const same = now.find((m) =>
					resolved.imageId === null ? m.imageId === null && m.url === (link ?? '') : m.imageId === resolved.imageId
				)
				// The URLs are the row's; the description (and a kept image's declared size) are this version's.
				const description = text(element.name) || text(element.description) || text(element.summary)
				if (same !== undefined) {
					return [[same.url, same.preview, description, same.imageId === null ? metaSizes(sized(element)) : same.meta]]
				}
				if (resolved.imageId === null) {
					return [[link ?? '', link ?? '', description, metaSizes(sized(element))]]
				}
				const files = /** @type {{ url: string, preview: string, meta: unknown[] }} */ (
					filesOf(resolved, `edit\n${uri}\n${resolved.imageId}`)
				)
				return [[files.url, files.preview, description, files.meta]]
			})
		history.set(uri, [
			...(history.get(uri) ?? []),
			[
				content(p.content),
				bounded(text(p.spoiler_text) || text(p.summary), SPOILER_BYTES),
				p.sensitive === true ? 1 : 0,
				media,
			],
		])
	}
	for (const [uri, versions] of history) {
		const current = /** @type {unknown[]} */ (JSON.parse(out.statuses?.[uri] ?? '[]'))
		const media = (currentMedia.get(uri) ?? []).map((m) => [m.url, m.preview, m.description, m.meta])
		put('edits', uri, [...versions, [current[1], current[3], current[4], media]])
	}

	// Boosts, with the audience of their outbox row as exported.
	for (const r of all('SELECT id, mastodon_id, actor_id, object_id, outbox_object_id FROM actor_reblogs')) {
		const target = statusUri.get(String(r.object_id))
		if (target === undefined || !known(r.actor_id)) {
			continue
		}
		if (!withinIdentityBound(String(r.id), STATUS_URI_LIMIT)) {
			identities++
		}
		const sent = source.outbox.get(String(r.outbox_object_id))
		const audience =
			sent === undefined || sent === null
				? { visibility: 'unreadable', to: [] }
				: audienceOf(sent.to, sent.cc, followersOf(String(r.actor_id), source.followers.get(String(r.actor_id))))
		// A boost reaches nobody in particular, except a direct one: the accounts in its to, silent, in a status only a
		// mention lets one see.
		const recipients =
			audience.visibility === 'direct'
				? [...new Set(audience.to.map((x) => byAddress.get(x ?? '')))]
						.filter((x) => x !== undefined && x !== String(r.actor_id))
						.map((x) => /** @type {[string, number, number, string]} */ ([String(x), 1, 1, String(r.actor_id)]))
						.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
				: []
		put('boosts', String(r.id), [String(r.actor_id), target, audience.visibility, recipients])
		statusApiIds.set(String(r.mastodon_id), [...(statusApiIds.get(String(r.mastodon_id)) ?? []), String(r.id)])
	}
	// Old API ids resolve to the same status (an ambiguous id is not checked).
	for (const [apiId, uris] of statusApiIds) {
		if (uris.length === 1) {
			put('legacy_ids', `status ${apiId}`, uris[0])
		}
	}
	/** @type {Map<string, string[]>} */
	const accountApiIds = new Map()
	for (const [uri, apiId] of originalActorIds) {
		if (!apiId.includes('@')) {
			accountApiIds.set(apiId, [...(accountApiIds.get(apiId) ?? []), uri])
		}
	}
	for (const [apiId, uris] of accountApiIds) {
		if (uris.length === 1) {
			put('legacy_ids', `account ${apiId}`, uris[0])
		}
	}

	// Relationships, by URI, with their preferences.
	// The Follow and Like activities each account sent, by their object.
	/** @type {Map<string, string[]>} */
	const follows = new Map()
	/** @type {Map<string, string[]>} */
	const likes = new Map()
	for (const a of all('SELECT actor_id, activity FROM actor_activities ORDER BY cdate, rowid')) {
		const body = parse(a.activity)
		const sent = body.type === 'Follow' ? follows : body.type === 'Like' ? likes : undefined
		if (sent !== undefined && typeof body.id === 'string') {
			const key = `${String(a.actor_id)} ${ref(body.object) ?? ''}`
			sent.set(key, [...(sent.get(key) ?? []), body.id])
		}
	}
	for (const f of all('SELECT * FROM actor_following')) {
		if (!known(f.actor_id) || !known(f.target_actor_id) || f.actor_id === f.target_actor_id) {
			continue
		}
		const key = `${String(f.actor_id)} ${String(f.target_actor_id)}`
		const record =
			typeof f.uri === 'string' && f.uri !== ''
				? f.uri
				: local.has(String(f.actor_id))
					? (follows.get(key)?.at(-1) ?? null)
					: null
		put('follows', key, [
			String(f.state),
			record,
			f.show_reblogs === 0 ? 0 : 1,
			f.notify === 1 ? 1 : 0,
			isJsonText(f.languages) ? f.languages : null,
		])
	}
	// A local account's favourite keeps its last Like, which names the status by its URI (or, earlier, its legacy id).
	for (const f of all('SELECT actor_id, object_id FROM actor_favourites')) {
		const target = statusUri.get(String(f.object_id))
		if (known(f.actor_id) && target !== undefined) {
			const like = local.has(String(f.actor_id))
				? (likes.get(`${String(f.actor_id)} ${target}`) ?? likes.get(`${String(f.actor_id)} ${String(f.object_id)}`))
				: undefined
			put('favourites', `${String(f.actor_id)} ${target}`, [like?.at(-1) ?? null])
		}
	}
	for (const b of all('SELECT account_id, status_id FROM bookmarks')) {
		const target = statusUri.get(String(b.status_id))
		if (known(b.account_id) && target !== undefined) {
			put('bookmarks', `${String(b.account_id)} ${target}`, 1)
		}
	}
	for (const b of all('SELECT account_id, target_account_id, uri FROM blocks')) {
		if (known(b.account_id) && known(b.target_account_id) && b.account_id !== b.target_account_id) {
			// The Block activity's id, which an unblock undoes.
			put('blocks', `${String(b.account_id)} ${String(b.target_account_id)}`, [
				typeof b.uri === 'string' ? b.uri : null,
			])
		}
	}
	for (const m of all('SELECT account_id, target_account_id, hide_notifications FROM mutes')) {
		if (known(m.account_id) && known(m.target_account_id) && m.account_id !== m.target_account_id) {
			// Legacy never wrote an expiry: a converted mute is indefinite.
			put('mutes', `${String(m.account_id)} ${String(m.target_account_id)}`, [m.hide_notifications === 0 ? 0 : 1, null])
		}
	}
	for (const d of all('SELECT account_id, domain FROM domain_blocks')) {
		if (!known(d.account_id)) {
			continue
		}
		const domain = blockedDomainOf(text(d.domain))
		if (domain === null) {
			dropped['domain_blocks:invalid-domain'] = (dropped['domain_blocks:invalid-domain'] ?? 0) + 1
		} else {
			put('domain_blocks', `${String(d.account_id)} ${domain}`, 1)
		}
	}
	for (const l of all('SELECT id, account_id, title, replies_policy, exclusive FROM lists')) {
		if (known(l.account_id)) {
			const policy = ['followed', 'list', 'none'].includes(text(l.replies_policy)) ? text(l.replies_policy) : 'list'
			put('lists', String(l.id), [String(l.account_id), text(l.title), policy, l.exclusive === 1 ? 1 : 0])
		}
	}
	// A member the list's owner neither is nor follows (in either state) is left out, as the converter leaves it out.
	for (const m of all('SELECT list_id, account_id FROM list_accounts')) {
		const list = out.lists?.[String(m.list_id)]
		const owner = list === undefined ? undefined : String(/** @type {unknown[]} */ (JSON.parse(list))[0])
		const member = String(m.account_id)
		if (
			known(m.account_id) &&
			owner !== undefined &&
			(owner === member || out.follows?.[`${owner} ${member}`] !== undefined)
		) {
			put('list_accounts', `${String(m.list_id)} ${member}`, 1)
		}
	}

	// Notifications: the smallest id of each (recipient, type, sender, status) stays; the counter continues from the
	// exported sequence or the largest id, whichever is higher.
	const seen = new Set()
	const notifications = db.prepare(
		'SELECT id, type, actor_id, from_actor_id, object_id FROM actor_notifications ORDER BY id'
	)
	notifications.setReadBigInts(true)
	let highest = notificationSequence === null ? 0n : BigInt(notificationSequence)
	for (const n of /** @type {Json[]} */ (notifications.all())) {
		if (n.id > highest) {
			highest = n.id
		}
		const target = n.object_id === null ? '' : statusUri.get(String(n.object_id))
		// Legacy listed a local user's own notifications only.
		if (!local.has(String(n.actor_id)) || !known(n.from_actor_id) || target === undefined) {
			continue
		}
		const natural = `${String(n.actor_id)} ${String(n.type)} ${String(n.from_actor_id)} ${target}`
		if (seen.has(natural)) {
			continue
		}
		seen.add(natural)
		put('notifications', String(n.id), [String(n.type), String(n.actor_id), String(n.from_actor_id), target])
	}
	if (highest > 0n) {
		put('counters', 'notifications', highest.toString())
	}

	// Threads and conversations, worked out here on their own from the records above, each status once. A status's
	// thread: a status that replies to no status carried takes the inReplyTo it names, else its own URI, and each reply
	// below it takes its thread; a status in a cycle of replies, or below one, takes its own inReplyTo, else its URI.
	const threadOf = threadsOf(out.replies ?? {}, out.statuses ?? {}, namedConversations)
	for (const uri of Object.keys(out.statuses ?? {})) {
		put('threads', uri, threadOf(uri))
	}

	// A direct status (direct with no silent recipient: one with a silent recipient is limited) is in its local
	// author's conversation, and in the conversation of each local account notified of it as a mention. A conversation
	// is keyed by its owner, its thread and the other accounts among the author and the tagged recipients. Its last
	// status is its newest, and it is unread when that one is someone else's: the ids that order them are the
	// converter's, so the actual side checks that of its own rows.
	/** @type {Map<string, string[]>} status URI -> the accounts notified of it as a mention */
	const notified = new Map()
	for (const record of Object.values(out.notifications ?? {})) {
		const [type, recipient, , target] = /** @type {string[]} */ (JSON.parse(record))
		if (type === 'mention' && target !== undefined && recipient !== undefined) {
			const list = notified.get(target)
			if (list === undefined) {
				notified.set(target, [recipient])
			} else {
				list.push(recipient)
			}
		}
	}
	/** @type {Map<string, string[]>} */
	const conversations = new Map()
	for (const [uri, record] of Object.entries(out.audience ?? {})) {
		const [visibility, recipients] = /** @type {[string, [string, number][]]} */ (JSON.parse(record))
		if (visibility !== 'direct' || recipients.some(([, silent]) => silent === 1)) {
			continue
		}
		const author = String(/** @type {unknown[]} */ (JSON.parse(out.statuses?.[uri] ?? '[]'))[0])
		const owners = new Set([...(local.has(author) ? [author] : []), ...(notified.get(uri) ?? [])])
		const thread = threadOf(uri)
		for (const owner of owners) {
			const others = [...new Set([author, ...recipients.map(([x]) => x)])].filter((x) => x !== owner).sort()
			const key = `${owner} ${thread} ${others.join(' ')}`
			const members = conversations.get(key)
			if (members === undefined) {
				conversations.set(key, [uri])
			} else {
				members.push(uri)
			}
		}
	}
	for (const [key, members] of conversations) {
		put('conversations', key, [members.sort(), true, true])
	}

	// Settings, under Kopje's names, and clients.
	for (const s of all('SELECT setting_name, setting_value FROM server_settings')) {
		put(
			'settings',
			SETTING_NAMES.get(String(s.setting_name)) ?? `unknown ${String(s.setting_name)}`,
			String(s.setting_value)
		)
	}
	const rules = all('SELECT id, text FROM server_rules ORDER BY id').map((r) => ({
		id: String(r.id),
		text: String(r.text),
	}))
	if (rules.length > 0) {
		put('settings', 'rules', JSON.stringify(rules))
	}
	for (const c of all('SELECT id, secret, name, redirect_uris, website, scopes FROM clients')) {
		put('clients', String(c.id), [
			String(c.secret),
			String(c.name),
			String(c.redirect_uris),
			text(c.scopes) || 'read',
			typeof c.website === 'string' ? c.website : null,
		])
	}
	return { records: out, overLimit, images: imageCounts, dropped, identities }
}
