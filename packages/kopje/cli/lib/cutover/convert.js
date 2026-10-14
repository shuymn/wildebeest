// Maps a bridged legacy database (schema 0039, legacy-load.js) onto the Kopje Store schema, in a local database
// written as a dump afterwards (kopje-db.js). Nothing here leaves the machine.
//
// Ids (accounts, statuses, media, lists) are 18-digit TEXT. An 18-digit legacy API id is kept as the id; any other
// legacy API id (a UUID) becomes legacy_id and the row gets a new id: local rows from their creation time, remote
// rows from `published` truncated to the second plus 0-999 ms, both with the low bits drawn deterministically from the
// base time and the row's key, so a conversion is reproducible. Notifications keep their INTEGER ids.
//
// HTML from the legacy database (status content, bios) goes through Kopje's own sanitizer (src/security/html.ts,
// HTML-1), so the Store never holds HTML it would not have stored itself.

import { createHash } from 'node:crypto'

import { LEGACY_DEFAULT_AVATAR, mediaToken, parseDeliveryUrl, UPSTREAM_ACCOUNT_HASH } from './images-export.js'
import { MAX_PROFILE_UPDATES } from './kopje-db.js'
import {
	blockedDomain,
	hashtagObjectName,
	normalizeTag,
	normalizeSearchText,
	REMOTE_HTML_RAW_LIMIT,
	remoteHtmlText,
	sanitizeRemoteHtml,
} from './kopje-runtime.js'
import { digestOf } from './sql-script.js'
import { fit, FULL_EDGE, SMALL_EDGE } from './upload-rules.js'

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public'
const STATUS_TYPES = new Set(['Note', 'Article', 'Page', 'Question', 'Video', 'Audio', 'Event'])
const EARLIEST_MS = Date.UTC(2018, 4, 10)
const ID18 = /^[0-9]{18}$/

// Tables 0030-0033 created that the legacy code never wrote; rows there would be lost, so they stop the conversion.
export const UNUSED_LEGACY_TABLES = [
	'account_fields',
	'account_notes',
	'endorsements',
	'status_pins',
	'media_attachments',
	'tags',
	'status_tags',
	'followed_tags',
	'featured_tags',
	'mentions',
	'markers',
	'polls',
	'poll_options',
	'poll_votes',
	'filters',
	'filter_keywords',
	'filter_statuses',
	'conversations',
	'conversation_accounts',
	'conversation_mutes',
	'status_edits',
]

// The names legacy instance settings had (packages/backend/src/config/server.ts) and where Kopje keeps them. title and
// description are what /api/v1/instance and /api/v2/instance show. Kopje has no endpoint for the extended description
// or the privacy policy yet; they are kept under these names for one (Mastodon's /api/v1/instance/extended_description
// and /api/v1/instance/privacy_policy). Any other name stops the conversion: it could collide with Kopje's own settings.
export const LEGACY_SETTINGS = /** @type {Record<string, string>} */ ({
	'server name': 'title',
	'server description': 'description',
	'extended description': 'extended_description',
	'privacy policy': 'privacy_policy',
})

/** @typedef {import('node:sqlite').DatabaseSync} DatabaseSync */
/** @typedef {Record<string, any>} Json */

/**
 * 'YYYY-MM-DD HH:MM:SS[.fff]' (UTC, legacy cdate) or ISO 8601 to 'YYYY-MM-DDTHH:MM:SS.sssZ'; null when unparsable.
 * @param {unknown} value
 * @returns {string | null}
 */
export function isoTime(value) {
	if (typeof value !== 'string' || value === '') {
		return null
	}
	const text = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value
	const ms = Date.parse(text)
	return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

/** @param {unknown} value */
function json(value) {
	if (typeof value !== 'string') {
		return null
	}
	try {
		const parsed = JSON.parse(value)
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? /** @type {Json} */ (parsed) : null
	} catch {
		return null
	}
}

/** @param {unknown} value @returns {unknown[]} */
function list(value) {
	return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]
}

/** @param {unknown} value @returns {string | null} */
function idOf(value) {
	if (typeof value === 'string') {
		return value
	}
	if (typeof value === 'object' && value !== null) {
		const v = /** @type {Json} */ (value)
		const id = v.id ?? v.href
		return typeof id === 'string' ? id : null
	}
	return null
}

/** @param {unknown} value @returns {string | null} */
function linkOf(value) {
	if (typeof value === 'string') {
		return value
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			const url = linkOf(item)
			if (url !== null) {
				return url
			}
		}
		return null
	}
	if (typeof value === 'object' && value !== null) {
		const v = /** @type {Json} */ (value)
		return linkOf(v.href ?? v.url)
	}
	return null
}

/** @param {unknown} value */
function str(value) {
	return typeof value === 'string' ? value : ''
}

/**
 * A status's language as Kopje stores one it receives (src/federation/remote-status.ts, languageOf): from the first
 * language map of contentMap, nameMap and summaryMap, the primary subtag of its first tag, lowercased, if that is ISO
 * 639 (two or three letters); else none.
 * @param {Json} properties
 * @returns {string | null}
 */
function statusLanguage(properties) {
	const map = [properties.contentMap, properties.nameMap, properties.summaryMap].find(
		(m) => typeof m === 'object' && m !== null && !Array.isArray(m) && Object.keys(m).length > 0
	)
	const tag = map === undefined ? '' : (Object.keys(map)[0] ?? '')
	const primary = (tag.split(/[-_]/)[0] ?? '').toLowerCase()
	return /^[a-z]{2,3}$/.test(primary) ? primary : null
}

/**
 * Legacy's reference rule (packages/backend/src/activitypub/objects/index.ts, getApId): a string is parsed as a URL
 * and compared in its normalized form; an object stands for its `id`, recursively; anything else (an object with only
 * `href`, null, a number) makes legacy throw, which here is null.
 * @param {unknown} value
 * @returns {string | null}
 */
function legacyReference(value, depth = 0) {
	if (typeof value === 'string') {
		try {
			return new URL(value).href
		} catch {
			return null
		}
	}
	if (typeof value === 'object' && value !== null && !Array.isArray(value) && depth < 16) {
		const id = /** @type {Json} */ (value).id
		return id === undefined ? null : legacyReference(id, depth + 1)
	}
	return null
}

/**
 * The followers value legacy compares against (actorFromRow, then detectVisibility's followers.toString()): the stored
 * property as it is spelled, or, where the property is missing, `<actor id>/followers` built from the parsed id. Null
 * where legacy fails: an actor it cannot load, a null property, an unparsable id.
 * @param {string | null} actorId
 * @param {{ present: boolean, value: unknown } | null | undefined} stored
 * @returns {string | null}
 */
export function legacyFollowers(actorId, stored) {
	if (actorId === null || stored === null || stored === undefined) {
		return null
	}
	if (stored.present) {
		// Legacy calls toString() on whatever is stored, an object included ('[object Object]'), and so must this.
		// eslint-disable-next-line @typescript-eslint/no-base-to-string
		return stored.value === null ? null : String(stored.value)
	}
	try {
		return new URL(`${new URL(actorId).toString()}/followers`).toString()
	} catch {
		return null
	}
}

/**
 * Who could read an object in legacy Wildebeest (packages/backend/src/mastodon/status_visibility.ts, detectVisibility
 * and isVisible), from its to and cc (toArray of each) and its stored author: public with Public in to; with the
 * author's followers in to, unlisted when Public is in cc, else the author's followers; otherwise the accounts in to.
 * Addresses are normalized as getApId does, but the followers value is compared as legacy spells it; where comparing it
 * normalized would decide otherwise, the answer is 'ambiguous' and the conversion stops rather than choose. Null where
 * legacy would throw, so that nobody could read the object there.
 * @param {unknown} to
 * @param {unknown} cc
 * @param {string | null} followers the value legacyFollowers gives for the stored author
 * @returns {{ visibility: 'public' | 'unlisted' | 'private' | 'direct' | 'ambiguous', to: string[] } | null}
 */
export function legacyAudience(to, cc, followers) {
	const targets = list(to).map((x) => legacyReference(x))
	const copies = list(cc).map((x) => legacyReference(x))
	if (targets.includes(null) || copies.includes(null)) {
		return null
	}
	const t = /** @type {string[]} */ (targets)
	if (t.includes(PUBLIC)) {
		return { visibility: 'public', to: t }
	}
	if (followers === null) {
		return null
	}
	const literal = t.includes(followers)
	const normalized = legacyReference(followers)
	if (literal !== (normalized !== null && t.includes(normalized))) {
		return { visibility: 'ambiguous', to: t }
	}
	if (literal) {
		return { visibility: copies.includes(PUBLIC) ? 'unlisted' : 'private', to: t }
	}
	return { visibility: 'direct', to: t }
}

/**
 * Deterministic id allocation per table.
 * @param {number} baseTime
 */
function allocator(baseTime) {
	/** @type {Map<string, Set<string>>} */
	const used = new Map()
	/** @param {string} table */
	const set = (table) => {
		let s = used.get(table)
		if (s === undefined) {
			s = new Set()
			used.set(table, s)
		}
		return s
	}
	/** @param {string} key */
	const draw = (key) => createHash('sha256').update(`${baseTime}\n${key}`).digest()
	/**
	 * @param {string} table
	 * @param {bigint} start
	 */
	const take = (table, start) => {
		let value = start
		for (;;) {
			const text = value.toString()
			if (text.length !== 18) {
				throw new Error(`id out of range for ${table}: ${text}`)
			}
			if (!set(table).has(text)) {
				set(table).add(text)
				return text
			}
			value += 1n
		}
	}
	/** @param {number | null} ms */
	const clamp = (ms) => Math.max(Math.min(ms === null || Number.isNaN(ms) ? baseTime : ms, baseTime), EARLIEST_MS)
	return {
		/** @param {string} table @param {string} id */
		keep(table, id) {
			if (!ID18.test(id) || set(table).has(id)) {
				return false
			}
			set(table).add(id)
			return true
		},
		/** @param {string} table @param {string | null} created @param {string} key */
		local(table, created, key) {
			const ms = clamp(created === null ? null : Date.parse(created))
			return take(table, (BigInt(ms) << 16n) | BigInt(draw(key).readUInt16BE(0)))
		},
		/** @param {string} table @param {string | null} published @param {string} key */
		remote(table, published, key) {
			const bytes = draw(key)
			const ms =
				Math.floor(clamp(published === null ? null : Date.parse(published)) / 1000) * 1000 +
				(bytes.readUInt16BE(2) % 1000)
			return take(table, (BigInt(ms) << 16n) | BigInt(bytes.readUInt16BE(0)))
		},
	}
}

/**
 * @typedef {{ mapped: number, missing: number, upstream: number, foreign: number, unmapped: number }} ImageCounts
 * @typedef {{ problems: Record<string, number>, dropped: Record<string, number>, normalized: Record<string, number>,
 *   legacy: Record<string, number>, domain: string, localAccounts: number,
 *   images: { counts: ImageCounts, originals: [string, string][] } | null }} ConvertSummary
 * @typedef {{ kind: 'keep', url: string | null } | { kind: 'drop' } | { kind: 'mapped', imageId: string, token: string,
 *   url: string, preview: string, contentType: string, meta: string }} MappedImage
 */

/**
 * Maps the delivery URLs of the operator's Cloudflare Images account (images-export.js) to local media on the instance
 * origin, as Kopje's upload path names them: /media/<token>/{full,small}.<ext>, PNG kept as PNG and every other type
 * served as WebP (src/platform/images.ts), meta sized by the same fit. Every media row gets a token of its own, derived
 * from the image's secret and the row's key (mediaToken), so each row has its own files and original and Kopje's
 * per-row lifecycle (sweep, backup, rebuild) applies unchanged even when several rows show one image. A profile image
 * that is one of legacy's defaults is dropped (Kopje's own default applies); other accounts' URLs are kept. An image
 * that is missing is dropped; a URL under the operator's account that images.json does not map is counted as unmapped.
 * @param {import('./images-export.js').ImagesFile} file
 * @param {string} origin
 */
function imageMapper(file, origin) {
	/** @type {ImageCounts} */
	const counts = { mapped: 0, missing: 0, upstream: 0, foreign: 0, unmapped: 0 }
	/**
	 * @param {string | null} url
	 * @param {boolean} profile an avatar or header
	 * @param {(imageId: string) => string} rowKey the key of the media row that will show it
	 * @returns {MappedImage}
	 */
	const map = (url, profile, rowKey) => {
		if (profile && url === LEGACY_DEFAULT_AVATAR) {
			counts.upstream++
			return { kind: 'drop' }
		}
		const parts = parseDeliveryUrl(url)
		if (parts === null) {
			return { kind: 'keep', url }
		}
		if (profile && parts.hash === UPSTREAM_ACCOUNT_HASH) {
			counts.upstream++
			return { kind: 'drop' }
		}
		if (parts.hash !== file.accountHash) {
			counts.foreign++
			return { kind: 'keep', url }
		}
		const entry = parts.id === null ? undefined : file.images.get(parts.id)
		if (parts.id === null || entry === undefined) {
			counts.unmapped++
			return { kind: 'keep', url }
		}
		if (entry.state !== 'ok') {
			counts.missing++
			return { kind: 'drop' }
		}
		counts.mapped++
		const contentType = entry.type === 'image/png' ? 'image/png' : 'image/webp'
		const extension = contentType === 'image/png' ? 'png' : 'webp'
		const full = fit(entry, FULL_EDGE)
		const token = mediaToken(entry.secret, rowKey(parts.id))
		return {
			kind: 'mapped',
			imageId: parts.id,
			token,
			url: `${origin}/media/${token}/full.${extension}`,
			preview: `${origin}/media/${token}/small.${extension}`,
			contentType,
			meta: JSON.stringify({ original: full, small: fit(full, SMALL_EDGE) }),
		}
	}
	return { map, counts }
}

/**
 * Converts the bridged legacy database into the (empty) Kopje database.
 * @param {DatabaseSync} legacy
 * @param {DatabaseSync} kopje
 * @param {{ baseTime: number, originalActorIds: Map<string, string>, notificationSequence: string | null,
 *   source: import('./legacy-load.js').SourceAddressing, acceptTruncation?: boolean, domain?: string,
 *   images?: import('./images-export.js').ImagesFile }} options
 * @returns {ConvertSummary}
 */
export function convertLegacy(
	legacy,
	kopje,
	{
		baseTime,
		originalActorIds,
		notificationSequence,
		source,
		acceptTruncation = false,
		domain: expectedDomain,
		images: imageFile,
	}
) {
	/** @type {Record<string, number>} */
	const problems = {}
	/** @type {Record<string, number>} */
	const dropped = {}
	/** @type {Record<string, number>} */
	const normalized = {}
	/** @type {Record<string, number>} */
	const legacyCounts = {}
	/** @param {Record<string, number>} bag @param {string} code */
	const count = (bag, code, n = 1) => {
		bag[code] = (bag[code] ?? 0) + n
	}
	const ids = allocator(baseTime)
	// Kopje's sanitizer cuts HTML at REMOTE_HTML_RAW_LIMIT; a longer value would lose its end, so it stops the conversion
	// unless truncation is accepted (counted either way).
	// Text decoded from legacy JSON can hold a lone surrogate (half of a character outside the BMP), which UTF-8, so the
	// dump and the Store, cannot represent. A carried text field gets U+FFFD in its place here, counted, rather than
	// wherever it is encoded.
	/** @param {unknown} value */
	const carried = (value) => {
		const text = str(value)
		const wellFormed = text.toWellFormed()
		if (wellFormed !== text) {
			count(normalized, 'text:lone-surrogate-replaced')
		}
		return wellFormed
	}
	/** @param {unknown} value */
	const html = (value) => {
		const text = carried(value)
		if (text.length > REMOTE_HTML_RAW_LIMIT) {
			count(acceptTruncation ? normalized : problems, 'html:longer-than-sanitizer-limit')
		}
		return sanitizeRemoteHtml(text)
	}
	/** @param {string} table @param {string | null} time @param {string} key */
	const localId = (table, time, key) => ids.local(table, time, key)
	/** @param {string} table @param {string | null} time @param {string} key */
	const remoteId = (table, time, key) => ids.remote(table, time, key)
	/** @param {string} sql @param {...import('node:sqlite').SQLInputValue} params */
	const rows = (sql, ...params) => /** @type {Json[]} */ (legacy.prepare(sql).all(...params))
	/** @param {string} sql */
	const insert = (sql) => kopje.prepare(sql)

	for (const table of UNUSED_LEGACY_TABLES) {
		const n = Number(/** @type {Json} */ (legacy.prepare(`SELECT count(*) AS n FROM "${table}"`).get()).n)
		if (n > 0) {
			count(problems, `rows-in-unused-table:${table}`, n)
		}
	}

	// ---------------------------------------------------------------- accounts
	const users = rows('SELECT actor_id, email, privkey, privkey_salt, pubkey, cdate FROM users ORDER BY rowid')
	const localActors = new Set(users.map((u) => String(u.actor_id)))
	/** @type {Set<string>} */
	const hosts = new Set()
	for (const uri of localActors) {
		const match = /^https:\/\/([^/]+)\/ap\/users\/[^/]+$/.exec(uri)
		hosts.add(match === null ? '' : (match[1] ?? '').toLowerCase())
	}
	const domain = [...hosts][0] ?? ''
	if (users.length === 0) {
		count(problems, 'no-local-users')
	}
	if (hosts.size > 1 || hosts.has('')) {
		count(problems, 'local-actors-on-several-domains')
	}
	if (expectedDomain !== undefined && expectedDomain.toLowerCase() !== domain) {
		count(problems, 'domain-differs-from-expected')
	}
	// With images-export's mapping, local references to the operator's Cloudflare Images become local media, one row
	// (with its own token and original) per reference.
	const imageMap = imageFile === undefined ? null : imageMapper(imageFile, `https://${domain}`)
	/** @type {[string, string][]} image id and the media id whose original it becomes */
	const originals = []
	/** @type {{ accountId: string, uri: string, kind: string, image: MappedImage }[]} */
	const profileImages = []
	// Local accounts whose avatar or header the mapping changed: publication announces them (kopje_state
	// profile_updates, src/platform/dump-catalog.ts), as other servers hold the old URLs.
	/** @type {Set<string>} */
	const changedProfiles = new Set()

	const actors = rows('SELECT id, type, cdate, properties FROM actors ORDER BY rowid')
	/** @type {Map<string, { id: string, local: boolean, followers: string, properties: Json, created: string | null }>} */
	const accounts = new Map()
	// An original legacy id shared by several actors stays with the oldest; the others get new ids.
	/** @type {Map<string, string>} */
	const legacyOwner = new Map()
	for (const actor of [...actors].sort((a, b) =>
		String(a.cdate) < String(b.cdate) ? -1 : String(a.cdate) > String(b.cdate) ? 1 : 0
	)) {
		const original = originalActorIds.get(String(actor.id))
		if (original !== undefined && !legacyOwner.has(original)) {
			legacyOwner.set(original, String(actor.id))
		}
	}
	const accountInsert = insert(
		`INSERT INTO accounts (id, uri, username, domain, actor_type, display_name, note, url, avatar_url, header_url, locked,
			discoverable, inbox_url, shared_inbox_url, raw, fetched_at, search_text, legacy_id, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)
	const pendingAccounts = []
	for (const actor of actors) {
		const uri = String(actor.id)
		const properties = json(actor.properties)
		if (properties === null) {
			count(problems, 'actor-properties-not-json')
			continue
		}
		const original = originalActorIds.get(uri)
		const owns = original !== undefined && legacyOwner.get(original) === uri
		const kept = owns && ids.keep('accounts', original)
		pendingAccounts.push({ actor, uri, properties, original: owns ? original : undefined, kept })
	}
	for (const { actor, uri, properties, original, kept } of pendingAccounts) {
		const local = localActors.has(uri)
		/** @param {unknown} value @param {string} kind */
		const profileImage = (value, kind) => {
			const url = linkOf(typeof value === 'object' && value !== null ? /** @type {Json} */ (value).url : value)
			if (!local || imageMap === null) {
				return url
			}
			const image = imageMap.map(url, true, () => `profile\n${uri}\n${kind}`)
			if (image.kind !== 'keep') {
				changedProfiles.add(id)
			}
			if (image.kind === 'mapped') {
				profileImages.push({ accountId: id, uri, kind, image })
				return image.url
			}
			return image.kind === 'keep' ? image.url : null
		}
		const created = isoTime(properties.published) ?? isoTime(actor.cdate)
		const id = kept && original !== undefined ? original : ids.local('accounts', created, `account:${uri}`)
		const legacyId = original !== undefined && !kept && !original.includes('@') ? original : null
		if (legacyId !== null) {
			count(legacyCounts, 'accounts')
		}
		let username = carried(properties.preferredUsername)
		let host = null
		if (local) {
			const segment = uri.slice(uri.lastIndexOf('/') + 1)
			if (segment !== username) {
				count(problems, 'local-actor-uri-differs-from-username')
			}
			username = segment
		} else {
			try {
				host = new URL(uri).host.toLowerCase()
			} catch {
				count(problems, 'remote-actor-uri-invalid')
				continue
			}
			if (username === '') {
				username = uri.replace(/\/+$/, '').slice(uri.replace(/\/+$/, '').lastIndexOf('/') + 1)
			}
		}
		const displayName = carried(properties.name)
		const endpoints =
			typeof properties.endpoints === 'object' && properties.endpoints !== null ? properties.endpoints : {}
		accountInsert.run(
			id,
			uri,
			username,
			host,
			str(actor.type) || str(properties.type) || 'Person',
			displayName,
			html(properties.summary),
			local ? null : linkOf(properties.url),
			profileImage(properties.icon, 'avatar'),
			profileImage(properties.image, 'header'),
			properties.manuallyApprovesFollowers === true ? 1 : 0,
			typeof properties.discoverable === 'boolean' ? (properties.discoverable ? 1 : 0) : null,
			local ? null : typeof properties.inbox === 'string' ? properties.inbox : null,
			local ? null : typeof endpoints.sharedInbox === 'string' ? endpoints.sharedInbox : null,
			local ? null : String(actor.properties),
			local ? null : isoTime(actor.cdate),
			normalizeSearchText(`${displayName} ${host === null ? username : `${username}@${host}`}`),
			legacyId,
			created ?? new Date(baseTime).toISOString()
		)
		accounts.set(uri, {
			id,
			local,
			followers: typeof properties.followers === 'string' ? properties.followers : `${uri}/followers`,
			properties,
			created,
		})
	}
	/** @param {unknown} uri */
	const accountOf = (uri) => (typeof uri === 'string' ? accounts.get(uri) : undefined)

	// ---------------------------------------------------------------- local_accounts
	const preferences = new Map(rows('SELECT * FROM actor_preferences').map((p) => [String(p.id), p]))
	const localInsert = insert(
		`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey, also_known_as, default_visibility,
			default_sensitive, default_language, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)
	/** @type {string[]} */
	const localIds = []
	for (const user of users) {
		const account = accountOf(user.actor_id)
		if (account === undefined) {
			count(problems, 'user-without-actor')
			continue
		}
		const preference = preferences.get(String(user.actor_id))
		const visibility = str(preference?.posting_default_visibility) || 'public'
		if (!['public', 'unlisted', 'private', 'direct'].includes(visibility)) {
			count(problems, 'invalid-default-visibility')
		}
		localInsert.run(
			account.id,
			String(user.email),
			/** @type {Uint8Array} */ (user.privkey),
			/** @type {Uint8Array} */ (user.privkey_salt),
			String(user.pubkey),
			JSON.stringify(list(account.properties.alsoKnownAs).filter((x) => typeof x === 'string')),
			visibility,
			preference?.posting_default_sensitive === 1 ? 1 : 0,
			preference?.posting_default_language ?? null,
			isoTime(user.cdate) ?? account.created ?? new Date(baseTime).toISOString()
		)
		localIds.push(account.id)
	}

	// ---------------------------------------------------------------- statuses: ids and URIs first
	const objects = rows('SELECT * FROM objects ORDER BY rowid')
	const prefix = `https://${domain}/ap/o/`
	/**
	 * @typedef {{ row: Json, properties: Json, id: string, uri: string, local: boolean, author: string,
	 *   legacyId: string | null, legacyApO: string | null, published: string }} StatusPlan
	 */
	/** @type {Map<string, StatusPlan>} */
	const statuses = new Map()
	/** @type {Map<string, string>} */
	const statusByUri = new Map()
	/** @type {Json[]} */
	const images = []
	/** @type {Set<string>} */
	const statusUris = new Set()
	const planned = []
	for (const row of objects) {
		const type = String(row.type)
		if (type === 'Image' && row.local === 1) {
			images.push(row)
			continue
		}
		if (!STATUS_TYPES.has(type)) {
			count(problems, `unsupported-object-type:${digestOf(type)}${row.local === 1 ? ':local' : ''}`)
			continue
		}
		const properties = json(row.properties)
		if (properties === null) {
			count(problems, 'object-properties-not-json')
			continue
		}
		const author = accountOf(row.original_actor_id)
		if (author === undefined) {
			count(dropped, 'statuses:unknown-author')
			continue
		}
		const local = row.local === 1
		if (local !== author.local) {
			count(problems, 'status-locality-differs-from-author')
			continue
		}
		const proxy = String(row.id)
		let uri = proxy
		let legacyApO = null
		if (local) {
			if (!proxy.startsWith(prefix)) {
				count(problems, 'local-status-uri-off-domain')
			}
		} else if (typeof row.original_object_id === 'string' && row.original_object_id !== proxy) {
			uri = row.original_object_id
			legacyApO = proxy.startsWith(prefix) ? proxy.slice(prefix.length) : null
		} else {
			count(normalized, 'statuses:remote-without-original-uri')
		}
		if (statusUris.has(uri)) {
			count(problems, 'duplicate-status-uri')
			continue
		}
		statusUris.add(uri)
		planned.push({ row, properties, uri, local, author: author.id, legacyApO })
	}
	// Boosts whose booster and original exist, with unique URIs.
	const plannedByObject = new Map(planned.map((plan) => [String(plan.row.id), plan]))
	const reblogs = rows(
		`SELECT rb.id, rb.mastodon_id, rb.actor_id, rb.object_id, rb.outbox_object_id, rb.cdate,
			ob.published_date AS ob_published
		FROM actor_reblogs rb LEFT JOIN outbox_objects ob ON ob.id = rb.outbox_object_id ORDER BY rb.rowid`
	)
	const boostPlans = []
	for (const reblog of reblogs) {
		const booster = accountOf(reblog.actor_id)
		if (booster === undefined || !plannedByObject.has(String(reblog.object_id))) {
			count(dropped, 'reblogs:unknown-account-or-status')
			continue
		}
		const uri = String(reblog.id)
		if (statusUris.has(uri)) {
			count(problems, 'duplicate-status-uri')
			continue
		}
		statusUris.add(uri)
		boostPlans.push({ reblog, booster, uri })
	}

	// Ids. Every 18-digit legacy id a status or boost keeps is reserved before any new id is drawn, so a drawn id never
	// takes the id of a later row.
	const keptStatus = new Set(planned.filter((plan) => ids.keep('statuses', String(plan.row.mastodon_id))))
	const keptBoost = new Set(boostPlans.filter((boost) => ids.keep('statuses', String(boost.reblog.mastodon_id))))
	for (const plan of planned) {
		const mastodonId = String(plan.row.mastodon_id)
		const published = isoTime(plan.properties.published) ?? isoTime(plan.row.cdate) ?? new Date(baseTime).toISOString()
		const kept = keptStatus.has(plan)
		const id = kept
			? mastodonId
			: plan.local
				? ids.local('statuses', published, `status:${plan.uri}`)
				: ids.remote('statuses', published, `status:${plan.uri}`)
		let legacyId = kept ? null : mastodonId
		if (plan.local && kept) {
			// A lazily converted local status: its URL still ends with the id it was created with.
			const tail = (linkOf(plan.properties.url) ?? '').replace(/\/+$/, '').split('/').pop() ?? ''
			if (tail !== '' && tail !== id) {
				legacyId = tail
			}
		}
		statuses.set(String(plan.row.id), { ...plan, id, legacyId, published })
		statusByUri.set(plan.uri, id)
	}
	const boosts = boostPlans.map((plan) => {
		const { reblog, booster, uri } = plan
		const published = isoTime(reblog.ob_published) ?? isoTime(reblog.cdate) ?? new Date(baseTime).toISOString()
		const mastodonId = String(reblog.mastodon_id)
		const kept = keptBoost.has(plan)
		const id = kept
			? mastodonId
			: booster.local
				? ids.local('statuses', published, `reblog:${uri}`)
				: ids.remote('statuses', published, `reblog:${uri}`)
		const target = /** @type {StatusPlan} */ (statuses.get(String(reblog.object_id)))
		return { reblog, booster, target, uri, id, published, legacyId: kept ? null : mastodonId }
	})
	// A legacy id must be unique and may not equal another status's id (resolveApiId looks at ids first).
	const allStatusIds = new Set([...[...statuses.values()].map((s) => s.id), ...boosts.map((b) => b.id)])
	/** @type {Set<string>} */
	const legacyStatusIds = new Set()
	for (const plan of [...statuses.values(), ...boosts]) {
		if (plan.legacyId !== null && (allStatusIds.has(plan.legacyId) || legacyStatusIds.has(plan.legacyId))) {
			plan.legacyId = null
			count(normalized, 'statuses:legacy-id-not-unique')
		}
		if (plan.legacyId !== null) {
			legacyStatusIds.add(plan.legacyId)
			count(legacyCounts, 'statuses')
		}
	}
	for (const plan of statuses.values()) {
		if (plan.legacyApO !== null) {
			count(legacyCounts, 'statuses_ap_o')
		}
	}

	// ---------------------------------------------------------------- statuses: rows
	kopje.exec('BEGIN')
	kopje.exec('PRAGMA defer_foreign_keys = ON')
	const idempotency = new Map(
		rows('SELECT key, object_id FROM idempotency_keys ORDER BY expires_at, rowid').map((k) => [
			String(k.object_id),
			String(k.key),
		])
	)
	// Accepted followers by followed account, for the readers of a followers-only status.
	/** @type {Map<string, Set<string>>} */
	const acceptedFollowers = new Map()
	for (const follow of rows("SELECT actor_id, target_actor_id FROM actor_following WHERE state = 'accepted'")) {
		const follower = accountOf(follow.actor_id)
		const followed = accountOf(follow.target_actor_id)
		if (follower !== undefined && followed !== undefined) {
			const set = acceptedFollowers.get(followed.id) ?? new Set()
			set.add(follower.id)
			acceptedFollowers.set(followed.id, set)
		}
	}
	const statusInsert = insert(
		`INSERT INTO statuses (id, uri, url, account_id, in_reply_to_uri, in_reply_to_id, visibility, spoiler_text, content,
			source_text, sensitive, language, published_at, edited_at, remote_version, client_key, raw, search_text,
			legacy_id, legacy_ap_o, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)
	const mentionInsert = insert('INSERT OR IGNORE INTO status_mentions (status_id, account_id, silent) VALUES (?, ?, ?)')
	const tagInsert = insert('INSERT OR IGNORE INTO status_tags (status_id, name) VALUES (?, ?)')
	// Accounts by their URI in legacy's normalized form (legacyReference).
	const accountByReference = new Map(
		[...accounts].flatMap(([uri, a]) => {
			const reference = legacyReference(uri)
			return reference === null ? [] : [[reference, a.id]]
		})
	)
	/** @type {Map<string, { parent: string | null, account: string, inReplyToUri: string | null }>} */
	const replies = new Map()
	for (const plan of statuses.values()) {
		const { row, properties, local } = plan
		const author = /** @type {NonNullable<ReturnType<typeof accountOf>>} */ (accountOf(row.original_actor_id))
		// The audience comes from the object's own addressing and its stored author as exported (legacy authorizes with
		// them); for a local status the outbox row, where the export has one, must agree.
		const addressing = source.objects.get(String(row.id)) ?? { to: undefined, cc: undefined, kind: 'object' }
		const storedAuthor = source.authors.get(String(row.id)) ?? null
		const audience = legacyAudience(
			addressing.to,
			addressing.cc,
			legacyFollowers(storedAuthor, storedAuthor === null ? null : source.followers.get(storedAuthor))
		)
		if (audience === null) {
			count(problems, 'statuses:addressing-legacy-could-not-read')
			continue
		}
		if (audience.visibility === 'ambiguous') {
			count(problems, 'statuses:followers-spelling-ambiguous')
			continue
		}
		const legacy = audience.visibility
		if (storedAuthor !== String(row.original_actor_id) && legacy !== 'public' && legacy !== 'unlisted') {
			// A bridge migration (0021) changed the author of a non-public object: its readers would change.
			count(problems, 'statuses:author-changed-audience')
			continue
		}
		if (local) {
			const sent = source.outboxByPair.get(`${String(row.original_actor_id)}\n${String(row.id)}`)
			if (sent !== undefined && sent !== null) {
				const outboxAudience = legacyAudience(
					sent.to,
					sent.cc,
					legacyFollowers(storedAuthor, storedAuthor === null ? null : source.followers.get(storedAuthor))
				)
				if (
					outboxAudience === null ||
					(sent.kind === 'target'
						? !outboxAudience.to.every(
								(x) =>
									audience.to.includes(x) ||
									list(addressing.cc)
										.map((y) => legacyReference(y))
										.includes(x)
							)
						: outboxAudience.visibility !== legacy)
				) {
					count(problems, 'statuses:addressing-conflict')
				}
			}
		}
		// Recipients (status_mentions). Public and unlisted: tagged known accounts, and addressed ones as silent. A direct
		// status: exactly the known accounts in to, which legacy let read it without a follow. A followers-only status:
		// none, so that only an accepted follow, checked when it is read, lets anyone read it, as legacy's isVisible did; a
		// mention there would be a lasting grant. Tags and cc entries outside these sets stay in raw and are counted.
		const tagged = new Set()
		for (const tag of list(properties.tag)) {
			if (typeof tag === 'object' && tag !== null && /** @type {Json} */ (tag).type === 'Mention') {
				const account = accountByReference.get(legacyReference(/** @type {Json} */ (tag).href) ?? '')
				if (account !== undefined && account !== author.id) {
					tagged.add(account)
				}
			}
		}
		/** @param {unknown} value */
		const known = (value) =>
			list(value)
				.map((x) => accountByReference.get(legacyReference(x) ?? ''))
				.filter((x) => x !== undefined && x !== author.id)
		const candidates = new Set([...tagged, ...known(addressing.to), ...known(addressing.cc)])
		/** @type {Set<unknown>} */
		let readers = candidates
		if (legacy === 'private') {
			readers = new Set()
		} else if (legacy === 'direct') {
			readers = new Set(known(addressing.to))
		}
		/** @type {Map<string, number>} */
		const mentions = new Map()
		for (const account of readers) {
			mentions.set(String(account), tagged.has(account) ? 0 : 1)
		}
		const outside = [...candidates].filter((a) => !readers.has(a)).length
		if (outside > 0) {
			count(normalized, 'mentionsNotRecipients', outside)
		}
		const visibility = legacy === 'direct' && [...mentions.values()].includes(1) ? 'limited' : legacy
		const spoiler = local
			? carried(properties.spoiler_text) || carried(properties.summary)
			: carried(properties.summary) || carried(properties.spoiler_text)
		const content = html(properties.content)
		const updated = isoTime(properties.updated)
		const edited = updated !== null && updated !== plan.published ? updated : null
		// The parent: the status at inReplyTo, else the one legacy linked.
		const inReplyToUri = idOf(properties.inReplyTo)
		const legacyParent = typeof row.in_reply_to_id === 'string' ? statuses.get(row.in_reply_to_id) : undefined
		const parent = (inReplyToUri === null ? undefined : statusByUri.get(inReplyToUri)) ?? legacyParent?.id
		const replyUri = inReplyToUri ?? legacyParent?.uri ?? null
		replies.set(plan.id, { parent: parent ?? null, account: author.id, inReplyToUri: replyUri })
		statusInsert.run(
			plan.id,
			plan.uri,
			local ? null : linkOf(properties.url),
			author.id,
			replyUri,
			parent ?? null,
			visibility,
			spoiler,
			content,
			local &&
				typeof properties.source === 'object' &&
				properties.source !== null &&
				typeof properties.source.content === 'string'
				? carried(properties.source.content)
				: null,
			properties.sensitive === true ? 1 : 0,
			statusLanguage(properties),
			plan.published,
			edited,
			local ? null : (edited ?? plan.published),
			local ? (idempotency.get(String(row.id)) ?? null) : null,
			local ? null : String(row.properties),
			normalizeSearchText(`${spoiler} ${remoteHtmlText(content)}`),
			plan.legacyId,
			plan.legacyApO,
			isoTime(row.cdate) ?? plan.published
		)
		for (const [account, silent] of mentions) {
			mentionInsert.run(plan.id, account, silent)
		}
		const tags = new Set()
		for (const tag of list(properties.tag)) {
			if (typeof tag === 'object' && tag !== null && /** @type {Json} */ (tag).type === 'Hashtag') {
				tags.add(hashtagObjectName(carried(/** @type {Json} */ (tag).name)))
			}
		}
		for (const tag of tags) {
			if (tag !== '') {
				tagInsert.run(plan.id, tag)
			}
		}
	}
	for (const hashtag of rows('SELECT value, object_id FROM note_hashtags ORDER BY rowid')) {
		const status = statuses.get(String(hashtag.object_id))
		// Legacy recorded the name without its #, as the status text has it (getHashtags).
		const name = normalizeTag(carried(hashtag.value))
		if (status !== undefined && name !== '') {
			tagInsert.run(status.id, name)
		}
	}
	// Conversation partner (Mastodon's carried_over_reply_to_account_id): a reply to one's own reply keeps the partner.
	/** @type {Map<string, string | null>} */
	const partner = new Map()
	/** @param {string} id @param {number} depth @returns {string | null} */
	const partnerOf = (id, depth) => {
		const known = partner.get(id)
		if (known !== undefined) {
			return known
		}
		const reply = replies.get(id)
		let value = null
		if (reply !== undefined && reply.parent !== null) {
			const parent = replies.get(reply.parent)
			if (parent !== undefined) {
				value =
					parent.account === reply.account && parent.inReplyToUri !== null && depth < 1000
						? partnerOf(reply.parent, depth + 1)
						: parent.account
			}
		}
		partner.set(id, value)
		return value
	}
	const partnerUpdate = insert('UPDATE statuses SET in_reply_to_account_id = ? WHERE id = ?')
	for (const id of replies.keys()) {
		const value = partnerOf(id, 0)
		if (value !== null) {
			partnerUpdate.run(value, id)
		}
	}

	// Boost rows. A boost's audience is its outbox row's addressing as exported; below 0002 the export has none, and
	// the boost is refused rather than guessed.
	for (const boost of boosts) {
		const sent = source.outbox.get(String(boost.reblog.outbox_object_id))
		if (sent === undefined || sent === null) {
			count(problems, 'reblogs:audience-unknown')
			continue
		}
		const boostAudience = legacyAudience(
			sent.to,
			sent.cc,
			legacyFollowers(String(boost.reblog.actor_id), source.followers.get(String(boost.reblog.actor_id)))
		)
		if (boostAudience === null) {
			count(problems, 'reblogs:addressing-legacy-could-not-read')
			continue
		}
		if (boostAudience.visibility === 'ambiguous') {
			count(problems, 'reblogs:followers-spelling-ambiguous')
			continue
		}
		// A direct boost reaches the accounts in its to, as legacy served it; any other boost grants nobody.
		const boostReaders =
			boostAudience.visibility === 'direct'
				? [...new Set(boostAudience.to.map((r) => accountByReference.get(r)))].filter(
						(a) => a !== undefined && a !== boost.booster.id
					)
				: []
		const visibility =
			boostAudience.visibility === 'direct' && boostReaders.length > 0 ? 'limited' : boostAudience.visibility
		statusInsert.run(
			boost.id,
			boost.uri,
			null,
			boost.booster.id,
			null,
			null,
			visibility,
			'',
			'',
			null,
			0,
			null,
			boost.published,
			null,
			null,
			null,
			null,
			null,
			boost.legacyId,
			null,
			isoTime(boost.reblog.cdate) ?? boost.published
		)
		insert('UPDATE statuses SET reblog_of_id = ? WHERE id = ?').run(boost.target.id, boost.id)
		for (const account of boostReaders) {
			mentionInsert.run(boost.id, String(account), 1)
		}
	}

	// ---------------------------------------------------------------- media
	// Local media mapped from Cloudflare Images also get their file token, served type and preview URL.
	const mediaRow = insert(
		`INSERT INTO media_attachments (id, account_id, status_id, position, type, url, preview_url, description, meta,
			file_token, content_type, processed, legacy_ap_o, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
	)
	/**
	 * @param {string} id @param {string} account @param {string | null} status @param {number} position
	 * @param {string} type @param {string} url @param {string} description @param {string | null} meta
	 * @param {string | null} legacyApO @param {string} created @param {MappedImage} [image]
	 */
	const mediaInsert = (id, account, status, position, type, url, description, meta, legacyApO, created, image) => {
		const mapped = image?.kind === 'mapped' ? image : null
		if (mapped !== null) {
			originals.push([mapped.imageId, id])
		}
		mediaRow.run(
			id,
			account,
			status,
			position,
			type,
			url,
			mapped?.preview ?? null,
			description,
			meta,
			mapped?.token ?? null,
			mapped?.contentType ?? null,
			legacyApO,
			created
		)
	}
	/** @param {string | null} url @param {boolean} local @param {(imageId: string) => string} rowKey */
	const attachmentImage = (url, local, rowKey) =>
		/** @type {MappedImage} */ (local && imageMap !== null ? imageMap.map(url, false, rowKey) : { kind: 'keep', url })
	/** @type {Map<string, { row: Json, properties: Json, used: boolean }>} */
	const imagesById = new Map()
	/** @type {Map<string, string>} */
	const imageByUrl = new Map()
	for (const image of images) {
		const properties = json(image.properties) ?? {}
		imagesById.set(String(image.id), { row: image, properties, used: false })
		const url = linkOf(properties.url)
		if (url !== null && !imageByUrl.has(url)) {
			imageByUrl.set(url, String(image.id))
		}
	}
	/** @param {Json} element */
	const mediaType = (element) => {
		const mime = str(element.mediaType)
		const type = str(element.type)
		if (type === 'Image' || mime.startsWith('image/')) {
			return 'image'
		}
		if (type === 'Video' || mime.startsWith('video/')) {
			return 'video'
		}
		if (type === 'Audio' || mime.startsWith('audio/')) {
			return 'audio'
		}
		return 'unknown'
	}
	/** @param {Json} element */
	const metaOf = (element) =>
		typeof element.width === 'number' && typeof element.height === 'number' && element.width > 0 && element.height > 0
			? JSON.stringify({ original: { width: element.width, height: element.height } })
			: null
	/** @param {Json} element */
	const descriptionOf = (element) => carried(element.name) || carried(element.description) || carried(element.summary)
	/**
	 * @param {string} imageId
	 */
	// Every image id that is kept is reserved before media ids are drawn.
	/** @type {Map<string, string>} */
	const imageIds = new Map()
	for (const [imageId, image] of imagesById) {
		if (ids.keep('media_attachments', String(image.row.mastodon_id))) {
			imageIds.set(imageId, String(image.row.mastodon_id))
		}
	}
	for (const [imageId, image] of imagesById) {
		if (!imageIds.has(imageId)) {
			imageIds.set(imageId, ids.local('media_attachments', isoTime(image.row.cdate), `image:${imageId}`))
		}
	}
	/** @param {string} imageId */
	const imageMediaId = (imageId) => imageIds.get(imageId) ?? ''
	/**
	 * @typedef {{ position: number, id: string, type: string, url: string, preview: string | null, description: string,
	 *   meta: string | null, imageId: string | null }} Attached
	 */
	/** @type {Map<string, Attached[]>} */
	const mediaByStatus = new Map()
	for (const plan of statuses.values()) {
		/** @type {Attached[]} */
		const attached = []
		list(plan.properties.attachment).forEach((value, position) => {
			if (typeof value !== 'object' || value === null) {
				count(dropped, 'attachments:not-an-object')
				return
			}
			const element = /** @type {Json} */ (value)
			const url = linkOf(element.url)
			let imageId = null
			if (plan.local) {
				const candidate = idOf(element.id)
				const byId = candidate !== null && imagesById.has(candidate) ? candidate : null
				const found = byId ?? (url === null ? null : (imageByUrl.get(url) ?? null))
				if (found !== null && imagesById.get(found)?.used === false) {
					imageId = found
				}
			}
			if (imageId !== null) {
				const image = /** @type {{ row: Json, properties: Json, used: boolean }} */ (imagesById.get(imageId))
				image.used = true
				const mapped = attachmentImage(
					url ?? linkOf(image.properties.url),
					true,
					() => `attachment\n${plan.uri}\n${position}`
				)
				if (mapped.kind === 'drop') {
					return
				}
				const id = imageMediaId(imageId)
				const type = mediaType(element) === 'unknown' ? 'image' : mediaType(element)
				const imageUrl = mapped.url ?? ''
				const meta = mapped.kind === 'mapped' ? mapped.meta : metaOf(element)
				const description = descriptionOf(element)
				mediaInsert(
					id,
					plan.author,
					plan.id,
					position,
					type,
					imageUrl,
					description,
					meta,
					imageId.startsWith(prefix) ? imageId.slice(prefix.length) : null,
					isoTime(image.row.cdate) ?? plan.published,
					mapped
				)
				attached.push({
					position,
					id,
					type,
					url: imageUrl,
					preview: mapped.kind === 'mapped' ? mapped.preview : null,
					imageId: mapped.kind === 'mapped' ? mapped.imageId : null,
					description,
					meta,
				})
				if (imageId.startsWith(prefix)) {
					count(legacyCounts, 'media_ap_o')
				}
			} else if (url !== null) {
				const mapped = attachmentImage(url, plan.local, () => `attachment\n${plan.uri}\n${position}`)
				if (mapped.kind === 'drop') {
					return
				}
				const id = (plan.local ? localId : remoteId)(
					'media_attachments',
					plan.published,
					`attachment:${plan.uri}#${position}`
				)
				const type = mapped.kind === 'mapped' && mediaType(element) === 'unknown' ? 'image' : mediaType(element)
				const mediaUrl = mapped.url ?? url
				const meta = mapped.kind === 'mapped' ? mapped.meta : metaOf(element)
				const description = descriptionOf(element)
				mediaInsert(id, plan.author, plan.id, position, type, mediaUrl, description, meta, null, plan.published, mapped)
				attached.push({
					position,
					id,
					type,
					url: mediaUrl,
					preview: mapped.kind === 'mapped' ? mapped.preview : null,
					imageId: mapped.kind === 'mapped' ? mapped.imageId : null,
					description,
					meta,
				})
			} else {
				count(dropped, 'attachments:without-url')
			}
		})
		mediaByStatus.set(plan.id, attached)
	}
	for (const [imageId, image] of imagesById) {
		if (image.used) {
			continue
		}
		const owner = accountOf(image.row.original_actor_id)
		const mapped = attachmentImage(linkOf(image.properties.url), owner?.local === true, () => `image\n${imageId}`)
		if (mapped.kind === 'drop') {
			continue
		}
		const url = mapped.url
		if (owner === undefined || url === null) {
			count(dropped, 'images:without-owner-or-url')
			continue
		}
		mediaInsert(
			imageMediaId(imageId),
			owner.id,
			null,
			0,
			'image',
			url,
			descriptionOf(image.properties),
			mapped.kind === 'mapped' ? mapped.meta : null,
			imageId.startsWith(prefix) ? imageId.slice(prefix.length) : null,
			isoTime(image.row.cdate) ?? new Date(baseTime).toISOString(),
			mapped
		)
		if (imageId.startsWith(prefix)) {
			count(legacyCounts, 'media_ap_o')
		}
	}
	// Avatars and headers become what Kopje makes of a profile image: a media row of the account with neither a status
	// nor gc_at, whose full file the account's avatar_url or header_url names (src/domain/media.ts, setProfileImage).
	for (const { accountId, uri, kind, image } of profileImages) {
		if (image.kind !== 'mapped') {
			continue
		}
		mediaInsert(
			ids.local('media_attachments', null, `profile:${uri}#${kind}`),
			accountId,
			null,
			0,
			'image',
			image.url,
			'',
			image.meta,
			null,
			new Date(baseTime).toISOString(),
			image
		)
	}

	// ---------------------------------------------------------------- edits: earlier versions, then the current one
	/** @param {Omit<Attached, 'position' | 'imageId'>} m */
	const presented = (m) => ({
		id: m.id,
		type: m.type,
		url: m.url,
		preview_url: m.preview ?? m.url,
		remote_url: null,
		preview_remote_url: null,
		text_url: null,
		meta: m.meta === null ? null : JSON.parse(m.meta),
		description: m.description === '' ? null : m.description,
		blurhash: null,
	})
	const editInsert = insert(
		'INSERT INTO status_edits (status_id, content, spoiler_text, sensitive, media_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
	)
	/** @type {Map<string, Json[]>} */
	const revisions = new Map()
	/** @type {Map<string, string>} status URI and image id -> the row of an image only earlier versions show */
	const editedImages = new Map()
	for (const revision of rows('SELECT object_id, properties, cdate FROM object_revisions ORDER BY id')) {
		const plan = statuses.get(String(revision.object_id))
		if (plan === undefined) {
			count(dropped, 'edits:unknown-status')
			continue
		}
		const listed = revisions.get(String(revision.object_id)) ?? []
		listed.push(revision)
		revisions.set(String(revision.object_id), listed)
	}
	for (const [objectId, versions] of revisions) {
		const plan = /** @type {StatusPlan} */ (statuses.get(objectId))
		const current = mediaByStatus.get(plan.id) ?? []
		for (const revision of versions) {
			const properties = json(revision.properties) ?? {}
			const media = list(properties.attachment)
				.filter((x) => typeof x === 'object' && x !== null)
				.flatMap((x, position) => {
					const element = /** @type {Json} */ (x)
					const mapped = attachmentImage(linkOf(element.url), plan.local, (imageId) => `edit\n${plan.uri}\n${imageId}`)
					if (mapped.kind === 'drop') {
						return []
					}
					const url = mapped.url ?? ''
					const same = current.find((m) =>
						mapped.kind === 'mapped' ? m.imageId === mapped.imageId : m.imageId === null && m.url === url
					)
					// The row the status shows now, with what this version said of it: its own description, and for an
					// image kept where it was, the size it declared.
					if (same !== undefined) {
						return [
							presented({
								...same,
								description: descriptionOf(element),
								meta: same.imageId === null ? metaOf(element) : same.meta,
							}),
						]
					}
					if (mapped.kind !== 'mapped') {
						return [
							presented({
								id: ids.remote(
									'media_attachments',
									plan.published,
									`edit:${plan.uri}#${String(revision.cdate)}#${position}`
								),
								type: mediaType(element),
								url,
								preview: null,
								description: descriptionOf(element),
								meta: metaOf(element),
							}),
						]
					}
					// An image only earlier versions show still needs a row, with its own token and original, so its files
					// are made and kept: an unattached one of the author, as legacy kept such images. One per status.
					const key = `${plan.uri}\n${mapped.imageId}`
					let id = editedImages.get(key)
					if (id === undefined) {
						id = ids.local('media_attachments', plan.published, `edited-image:${key}`)
						editedImages.set(key, id)
						mediaInsert(
							id,
							plan.author,
							null,
							0,
							'image',
							url,
							descriptionOf(element),
							mapped.meta,
							null,
							plan.published,
							mapped
						)
					}
					return [
						presented({
							id,
							type: mediaType(element) === 'unknown' ? 'image' : mediaType(element),
							url,
							preview: mapped.preview,
							description: descriptionOf(element),
							meta: mapped.meta,
						}),
					]
				})
			editInsert.run(
				plan.id,
				html(properties.content),
				carried(properties.spoiler_text) || carried(properties.summary),
				properties.sensitive === true ? 1 : 0,
				JSON.stringify(media),
				isoTime(properties.updated) ?? isoTime(properties.published) ?? isoTime(revision.cdate) ?? plan.published
			)
		}
		const status = /** @type {Json} */ (
			kopje
				.prepare('SELECT content, spoiler_text, sensitive, edited_at, published_at FROM statuses WHERE id = ?')
				.get(plan.id)
		)
		editInsert.run(
			plan.id,
			status.content,
			status.spoiler_text,
			status.sensitive,
			JSON.stringify(current.map(presented)),
			status.edited_at ?? status.published_at
		)
	}

	// ---------------------------------------------------------------- edges
	/** @type {Map<string, string[]>} */
	const activities = new Map()
	for (const activity of rows('SELECT actor_id, activity FROM actor_activities ORDER BY cdate, rowid')) {
		const body = json(activity.activity)
		if (body === null || typeof body.id !== 'string' || (body.type !== 'Follow' && body.type !== 'Like')) {
			continue
		}
		const key = `${String(body.type)}\n${String(activity.actor_id)}\n${idOf(body.object) ?? ''}`
		activities.set(key, [...(activities.get(key) ?? []), body.id])
	}
	/** @param {string} type @param {unknown} actor @param {string[]} objects */
	const activityId = (type, actor, objects) => {
		for (const object of objects) {
			const found = activities.get(`${type}\n${String(actor)}\n${object}`)
			if (found !== undefined) {
				return found[found.length - 1] ?? null
			}
		}
		return null
	}
	/** @param {unknown} objectId */
	const statusOf = (objectId) => statuses.get(String(objectId))

	const followInsert = insert(
		`INSERT INTO follows (account_id, target_account_id, state, uri, show_reblogs, notify, languages, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	)
	for (const follow of rows('SELECT * FROM actor_following ORDER BY cdate, rowid')) {
		const actor = accountOf(follow.actor_id)
		const target = accountOf(follow.target_actor_id)
		if (actor === undefined || target === undefined) {
			count(dropped, 'follows:unknown-account')
			continue
		}
		if (actor.id === target.id) {
			count(normalized, 'follows:self-follow-left-out')
			continue
		}
		if (follow.state !== 'pending' && follow.state !== 'accepted') {
			count(problems, `follows:unknown-state`)
			continue
		}
		const uri =
			(typeof follow.uri === 'string' && follow.uri !== '' ? follow.uri : null) ??
			(actor.local ? activityId('Follow', follow.actor_id, [String(follow.target_actor_id)]) : null)
		if (follow.state === 'accepted' && uri === null) {
			count(normalized, 'follows:accepted-without-follow-record')
		}
		const languages =
			typeof follow.languages === 'string' && json(`{"v":${follow.languages}}`) !== null ? follow.languages : null
		followInsert.run(
			actor.id,
			target.id,
			follow.state,
			uri,
			follow.show_reblogs === 0 ? 0 : 1,
			follow.notify === 1 ? 1 : 0,
			languages,
			isoTime(follow.cdate) ?? new Date(baseTime).toISOString()
		)
	}

	const favouriteInsert = insert('INSERT INTO favourites (account_id, status_id, uri, created_at) VALUES (?, ?, ?, ?)')
	for (const favourite of rows('SELECT * FROM actor_favourites ORDER BY cdate, rowid')) {
		const actor = accountOf(favourite.actor_id)
		const status = statusOf(favourite.object_id)
		if (actor === undefined || status === undefined) {
			count(dropped, 'favourites:unknown-account-or-status')
			continue
		}
		const uri = actor.local ? activityId('Like', favourite.actor_id, [status.uri, String(favourite.object_id)]) : null
		favouriteInsert.run(actor.id, status.id, uri, isoTime(favourite.cdate) ?? status.published)
	}

	/** @param {unknown} uri @param {string} what */
	const localOwner = (uri, what) => {
		const account = accountOf(uri)
		if (account === undefined) {
			count(dropped, `${what}:unknown-account`)
			return undefined
		}
		if (!account.local) {
			count(problems, `${what}:owner-not-local`)
			return undefined
		}
		return account
	}

	const bookmarkInsert = insert('INSERT INTO bookmarks (account_id, status_id, created_at) VALUES (?, ?, ?)')
	for (const bookmark of rows('SELECT * FROM bookmarks ORDER BY created_at, rowid')) {
		const owner = localOwner(bookmark.account_id, 'bookmarks')
		const status = statusOf(bookmark.status_id)
		if (owner === undefined) {
			continue
		}
		if (status === undefined) {
			count(dropped, 'bookmarks:unknown-status')
			continue
		}
		bookmarkInsert.run(owner.id, status.id, isoTime(bookmark.created_at) ?? status.published)
	}

	const blockInsert = insert('INSERT INTO blocks (account_id, target_account_id, uri, created_at) VALUES (?, ?, ?, ?)')
	for (const block of rows('SELECT * FROM blocks ORDER BY created_at, rowid')) {
		const actor = accountOf(block.account_id)
		const target = accountOf(block.target_account_id)
		if (actor === undefined || target === undefined) {
			count(dropped, 'blocks:unknown-account')
			continue
		}
		if (actor.id === target.id) {
			count(normalized, 'blocks:self-block-left-out')
			continue
		}
		blockInsert.run(
			actor.id,
			target.id,
			block.uri ?? null,
			isoTime(block.created_at) ?? new Date(baseTime).toISOString()
		)
	}

	const muteInsert = insert(
		'INSERT INTO mutes (account_id, target_account_id, hide_notifications, created_at) VALUES (?, ?, ?, ?)'
	)
	for (const mute of rows('SELECT * FROM mutes ORDER BY created_at, rowid')) {
		const owner = localOwner(mute.account_id, 'mutes')
		const target = accountOf(mute.target_account_id)
		if (owner === undefined) {
			continue
		}
		if (target === undefined) {
			count(dropped, 'mutes:unknown-account')
			continue
		}
		if (owner.id === target.id) {
			count(normalized, 'mutes:self-mute-left-out')
			continue
		}
		muteInsert.run(
			owner.id,
			target.id,
			mute.hide_notifications === 0 ? 0 : 1,
			isoTime(mute.created_at) ?? new Date(baseTime).toISOString()
		)
	}

	// A domain block is matched as stored (domain/audience.ts, inDomainSql), so it is converted as Kopje's API stores
	// one (blockedDomain: lowercase, punycode, no trailing dot). Rows that become the same block are merged, and a value
	// that is no domain name is dropped, counted. A Store converted before this kept trailing dots; its migration
	// 0003_domain_block_form brings those rows to this form.
	const domainBlockInsert = insert(
		'INSERT OR IGNORE INTO domain_blocks (account_id, domain, created_at) VALUES (?, ?, ?)'
	)
	for (const block of rows('SELECT * FROM domain_blocks ORDER BY created_at, rowid')) {
		const owner = localOwner(block.account_id, 'domain_blocks')
		if (owner === undefined) {
			continue
		}
		const domain = blockedDomain(str(block.domain))
		if (domain === null) {
			count(dropped, 'domain_blocks:invalid-domain')
			continue
		}
		const result = domainBlockInsert.run(
			owner.id,
			domain,
			isoTime(block.created_at) ?? new Date(baseTime).toISOString()
		)
		if (Number(result.changes) === 0) {
			count(normalized, 'domain_blocks:case-duplicate-merged')
		}
	}

	const listInsert = insert(
		'INSERT INTO lists (id, account_id, title, replies_policy, exclusive, created_at) VALUES (?, ?, ?, ?, ?, ?)'
	)
	/** @type {Set<string>} */
	const lists = new Set()
	for (const row of rows('SELECT * FROM lists ORDER BY created_at, rowid')) {
		const owner = localOwner(row.account_id, 'lists')
		if (owner === undefined) {
			continue
		}
		const id = String(row.id)
		if (!ids.keep('lists', id)) {
			count(problems, 'lists:id-not-18-digits')
			continue
		}
		const policy = ['followed', 'list', 'none'].includes(str(row.replies_policy)) ? str(row.replies_policy) : 'list'
		listInsert.run(
			id,
			owner.id,
			str(row.title),
			policy,
			row.exclusive === 1 ? 1 : 0,
			isoTime(row.created_at) ?? new Date(baseTime).toISOString()
		)
		lists.add(id)
		localIds.push(id)
	}
	const listAccountInsert = insert('INSERT INTO list_accounts (list_id, account_id) VALUES (?, ?)')
	for (const member of rows('SELECT * FROM list_accounts ORDER BY rowid')) {
		const account = accountOf(member.account_id)
		if (account === undefined || !lists.has(String(member.list_id))) {
			count(dropped, 'list_accounts:unknown-list-or-account')
			continue
		}
		listAccountInsert.run(String(member.list_id), account.id)
	}

	// ---------------------------------------------------------------- notifications (natural key; the smallest id stays)
	const notificationInsert = insert(
		'INSERT OR IGNORE INTO notifications (id, account_id, type, from_account_id, status_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
	)
	let maxNotification = 0n
	const notificationRows = legacy.prepare(
		'SELECT id, type, actor_id, from_actor_id, object_id, cdate FROM actor_notifications ORDER BY id'
	)
	notificationRows.setReadBigInts(true)
	for (const notification of /** @type {Json[]} */ (notificationRows.all())) {
		const id = /** @type {bigint} */ (notification.id)
		if (id > maxNotification) {
			maxNotification = id
		}
		// Legacy notified the author of a boosted or liked status whoever it was, a remote author too; it only ever listed
		// a local user's own notifications, so a remote owner's were never shown.
		if (accountOf(notification.actor_id)?.local === false) {
			count(dropped, 'notifications:owner-remote')
			continue
		}
		const recipient = localOwner(notification.actor_id, 'notifications')
		const from = accountOf(notification.from_actor_id)
		if (recipient === undefined) {
			continue
		}
		if (from === undefined) {
			count(dropped, 'notifications:unknown-account')
			continue
		}
		let status = null
		if (notification.object_id !== null) {
			const found = statusOf(notification.object_id)
			if (found === undefined) {
				count(dropped, 'notifications:unknown-status')
				continue
			}
			status = found.id
		}
		const result = notificationInsert.run(
			id,
			recipient.id,
			str(notification.type),
			from.id,
			status,
			isoTime(notification.cdate) ?? new Date(baseTime).toISOString()
		)
		if (Number(result.changes) === 0) {
			count(normalized, 'notifications:duplicate-merged')
		}
	}
	const sequence =
		notificationSequence !== null && BigInt(notificationSequence) > maxNotification
			? BigInt(notificationSequence)
			: maxNotification
	if (sequence > 0n) {
		kopje.prepare("DELETE FROM sqlite_sequence WHERE name = 'notifications'").run()
		kopje.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('notifications', ?)").run(sequence)
	}

	// ---------------------------------------------------------------- clients and settings
	const clientInsert = insert(
		'INSERT INTO oauth_clients (id, secret, name, redirect_uris, website, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
	)
	for (const client of rows('SELECT * FROM clients ORDER BY cdate, rowid')) {
		clientInsert.run(
			String(client.id),
			String(client.secret),
			String(client.name),
			String(client.redirect_uris),
			client.website ?? null,
			str(client.scopes) || 'read',
			isoTime(client.cdate) ?? new Date(baseTime).toISOString()
		)
	}
	const settingInsert = insert('INSERT INTO instance_settings (name, value) VALUES (?, ?)')
	for (const setting of rows('SELECT setting_name, setting_value FROM server_settings ORDER BY rowid')) {
		const legacyName = String(setting.setting_name)
		const name = Object.hasOwn(LEGACY_SETTINGS, legacyName) ? LEGACY_SETTINGS[legacyName] : undefined
		if (name === undefined) {
			count(problems, 'settings:unknown-name')
			continue
		}
		settingInsert.run(name, String(setting.setting_value))
	}
	const rules = rows('SELECT id, text FROM server_rules ORDER BY id').map((r) => ({
		id: String(r.id),
		text: String(r.text),
	}))
	if (rules.length > 0) {
		settingInsert.run('rules', JSON.stringify(rules))
	}

	// ---------------------------------------------------------------- counters
	kopje.exec(`
		UPDATE statuses SET
			replies_count = (SELECT count(*) FROM statuses c WHERE c.in_reply_to_id = statuses.id),
			reblogs_count = (SELECT count(*) FROM statuses b WHERE b.reblog_of_id = statuses.id),
			favourites_count = (SELECT count(*) FROM favourites f WHERE f.status_id = statuses.id);
		UPDATE accounts SET
			followers_count = (SELECT count(*) FROM follows f WHERE f.target_account_id = accounts.id AND f.state = 'accepted'),
			following_count = (SELECT count(*) FROM follows f WHERE f.account_id = accounts.id AND f.state = 'accepted'),
			statuses_count = (SELECT count(*) FROM statuses s WHERE s.account_id = accounts.id)
		WHERE domain IS NULL;
	`)
	const lastLocal = /** @type {Json} */ (
		kopje
			.prepare(
				`SELECT max(id) AS id FROM (
					SELECT a.id FROM accounts a WHERE a.domain IS NULL
					UNION ALL SELECT s.id FROM statuses s JOIN accounts a ON a.id = s.account_id WHERE a.domain IS NULL
					UNION ALL SELECT m.id FROM media_attachments m JOIN accounts a ON a.id = m.account_id WHERE a.domain IS NULL
					UNION ALL SELECT id FROM lists)`
			)
			.get()
	).id
	if (typeof lastLocal === 'string') {
		kopje.prepare("INSERT OR REPLACE INTO kopje_state (name, value) VALUES ('last_local_id', ?)").run(lastLocal)
	}
	if (changedProfiles.size > MAX_PROFILE_UPDATES) {
		count(problems, 'profile-updates-over-limit')
	} else if (changedProfiles.size > 0) {
		kopje
			.prepare("INSERT INTO kopje_state (name, value) VALUES ('profile_updates', ?)")
			.run(JSON.stringify([...changedProfiles].sort()))
	}
	kopje.exec('COMMIT')
	const violations = kopje.prepare('PRAGMA foreign_key_check').all().length
	if (violations > 0) {
		count(problems, 'foreign-key-violations', violations)
	}
	return {
		problems,
		dropped,
		normalized,
		legacy: legacyCounts,
		domain,
		localAccounts: users.length,
		images: imageMap === null ? null : { counts: imageMap.counts, originals },
	}
}
