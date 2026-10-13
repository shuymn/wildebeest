// The expected side of the conversion check, computed from the legacy data alone. It shares nothing with convert.js:
// it reads legacy columns and JSON directly, takes every audience from the addressing as exported (captured before any
// bridge migration ran), and writes each record in the comparison form of verify-actual.js, keyed by AP URIs (never by
// the ids the converter assigns). The only shared code is Kopje's own HTML sanitizer, a runtime transformation the
// Store applies to every stored HTML value (HTML-1); test-node/cutover-sanitize.test.ts pins its output by hand.
//
// Records are kept as exact values, not digests, so a change of the same length is still a difference. They hold data
// and are never printed: reports carry counts and digests only.

import { REMOTE_HTML_RAW_LIMIT, sanitizeRemoteHtml } from './kopje-runtime.js'

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

/** @param {unknown} value */
function when(value) {
	if (typeof value !== 'string' || value === '') {
		return null
	}
	const ms = Date.parse(/^\d{4}-\d{2}-\d{2} /.test(value) ? `${value.replace(' ', 'T')}Z` : value)
	return Number.isNaN(ms) ? null : new Date(ms).toISOString()
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

/**
 * @param {import('node:sqlite').DatabaseSync} db the bridged legacy database
 * @param {{ originalActorIds: Map<string, string>, source: import('./legacy-load.js').SourceAddressing,
 *   notificationSequence: string | null }} options
 * @returns {{ records: Records, overLimit: number }}
 */
export function expectedFromLegacy(db, { originalActorIds, source, notificationSequence }) {
	/** @type {Records} */
	const out = {}
	let overLimit = 0
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

	// Accounts and profiles.
	const local = new Set(all('SELECT actor_id FROM users').map((u) => String(u.actor_id)))
	const domain = [...local].map((uri) => new URL(uri).host.toLowerCase())[0] ?? ''
	/** @type {Map<string, Json>} */
	const actors = new Map()
	for (const actor of all('SELECT id, properties FROM actors')) {
		const uri = String(actor.id)
		const p = parse(actor.properties)
		actors.set(uri, p)
		const isLocal = local.has(uri)
		put('accounts', uri, [
			isLocal ? 1 : 0,
			isLocal ? text(p.preferredUsername) : null,
			text(p.name),
			sanitized(p.summary),
			href(typeof p.icon === 'object' && p.icon !== null ? p.icon.url : p.icon),
			href(typeof p.image === 'object' && p.image !== null ? p.image.url : p.image),
			p.manuallyApprovesFollowers === true ? 1 : 0,
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
	for (const user of all('SELECT actor_id, email, privkey, privkey_salt, pubkey FROM users')) {
		put('keys', String(user.actor_id), [
			String(user.email),
			hex(user.privkey),
			hex(user.privkey_salt),
			String(user.pubkey),
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
		statusUri.set(
			id,
			o.local !== 1 && typeof o.original_object_id === 'string' && o.original_object_id !== id
				? o.original_object_id
				: id
		)
	}
	const byUri = new Set(statusUri.values())
	/** @type {Map<string, string[]>} */
	const statusApiIds = new Map()
	const prefix = `https://${domain}/ap/o/`
	for (const o of objects) {
		const id = String(o.id)
		const uri = statusUri.get(id)
		if (uri === undefined) {
			continue
		}
		const p = parse(o.properties)
		const author = String(o.original_actor_id)
		const isLocal = o.local === 1
		const spoiler = isLocal ? text(p.spoiler_text) || text(p.summary) : text(p.summary) || text(p.spoiler_text)
		const sourceText =
			isLocal && typeof p.source === 'object' && p.source !== null && typeof p.source.content === 'string'
				? text(p.source.content)
				: null
		put('statuses', uri, [
			author,
			sanitized(p.content),
			sourceText,
			spoiler,
			p.sensitive === true ? 1 : 0,
			when(p.published) ?? when(o.cdate),
		])

		// The audience, from the object's addressing and stored author as exported. Recipients: for public and unlisted,
		// the tagged known accounts and, silently, the other addressed ones; for followers-only, none (a follow decides);
		// for direct, exactly the known accounts in to (tagged ones not silent). Non-public audiences also name the author
		// legacy authorized with.
		const addressing = source.objects.get(id) ?? { to: undefined, cc: undefined }
		const stored = source.authors.get(id) ?? null
		const audience = audienceOf(
			addressing.to,
			addressing.cc,
			followersOf(stored, stored === null ? null : source.followers.get(stored))
		)
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
				.map((x) => /** @type {[string, number]} */ ([String(x), tagged.has(/** @type {string} */ (x)) ? 0 : 1]))
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
		const attachments = many(p.attachment)
			.filter((a) => typeof a === 'object' && a !== null && href(/** @type {Json} */ (a).url) !== null)
			.map((a) => [
				href(/** @type {Json} */ (a).url),
				text(/** @type {Json} */ (a).name) ||
					text(/** @type {Json} */ (a).description) ||
					text(/** @type {Json} */ (a).summary),
			])
		if (attachments.length > 0) {
			put('attachments', uri, attachments)
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
	const images = objects.filter((o) => o.type === 'Image' && o.local === 1)
	/** @type {Map<string, string>} image id -> status URI */
	const shownIn = new Map()
	for (const o of objects) {
		const uri = statusUri.get(String(o.id))
		if (uri === undefined || o.local !== 1) {
			continue
		}
		for (const a of many(parse(o.properties).attachment)) {
			if (typeof a !== 'object' || a === null) {
				continue
			}
			const element = /** @type {Json} */ (a)
			const byId = images.find((i) => typeof element.id === 'string' && String(i.id) === element.id)
			const link = href(element.url)
			const match = byId ?? images.find((i) => link !== null && href(parse(i.properties).url) === link)
			if (match !== undefined && !shownIn.has(String(match.id))) {
				shownIn.set(String(match.id), uri)
			}
		}
	}
	for (const o of images) {
		const id = String(o.id)
		if (id.startsWith(prefix)) {
			put('media', id.slice(prefix.length), [
				href(parse(o.properties).url),
				source.authors.get(id) ?? null,
				shownIn.get(id) ?? null,
			])
		}
	}

	// Edits: the earlier versions in order, then the current one.
	/** @type {Map<string, unknown[]>} */
	const history = new Map()
	for (const r of all('SELECT object_id, properties FROM object_revisions ORDER BY id')) {
		const uri = statusUri.get(String(r.object_id))
		if (uri === undefined) {
			continue
		}
		const p = parse(r.properties)
		history.set(uri, [
			...(history.get(uri) ?? []),
			[sanitized(p.content), text(p.spoiler_text) || text(p.summary), p.sensitive === true ? 1 : 0],
		])
	}
	for (const [uri, versions] of history) {
		const current = /** @type {unknown[]} */ (JSON.parse(out.statuses?.[uri] ?? '[]'))
		put('edits', uri, [...versions, [current[1], current[3], current[4]]])
	}

	// Boosts, with the audience of their outbox row as exported.
	for (const r of all('SELECT id, mastodon_id, actor_id, object_id, outbox_object_id FROM actor_reblogs')) {
		const target = statusUri.get(String(r.object_id))
		if (target === undefined || !known(r.actor_id)) {
			continue
		}
		const sent = source.outbox.get(String(r.outbox_object_id))
		const audience =
			sent === undefined || sent === null
				? { visibility: 'unreadable', to: [] }
				: audienceOf(sent.to, sent.cc, followersOf(String(r.actor_id), source.followers.get(String(r.actor_id))))
		// A boost reaches nobody in particular, except a direct one: the accounts in its to.
		const recipients =
			audience.visibility === 'direct'
				? [...new Set(audience.to.map((x) => byAddress.get(x ?? '')))]
						.filter((x) => x !== undefined && x !== String(r.actor_id))
						.map((x) => /** @type {[string, number]} */ ([String(x), 1]))
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
	/** @type {Map<string, string[]>} */
	const follows = new Map()
	for (const a of all('SELECT actor_id, activity FROM actor_activities ORDER BY cdate, rowid')) {
		const body = parse(a.activity)
		if (body.type === 'Follow' && typeof body.id === 'string') {
			const key = `${String(a.actor_id)} ${ref(body.object) ?? ''}`
			follows.set(key, [...(follows.get(key) ?? []), body.id])
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
		put('follows', key, [String(f.state), record, f.show_reblogs === 0 ? 0 : 1, f.notify === 1 ? 1 : 0])
	}
	for (const f of all('SELECT actor_id, object_id FROM actor_favourites')) {
		const target = statusUri.get(String(f.object_id))
		if (known(f.actor_id) && target !== undefined) {
			put('favourites', `${String(f.actor_id)} ${target}`, 1)
		}
	}
	for (const b of all('SELECT account_id, status_id FROM bookmarks')) {
		const target = statusUri.get(String(b.status_id))
		if (known(b.account_id) && target !== undefined) {
			put('bookmarks', `${String(b.account_id)} ${target}`, 1)
		}
	}
	for (const b of all('SELECT account_id, target_account_id FROM blocks')) {
		if (known(b.account_id) && known(b.target_account_id) && b.account_id !== b.target_account_id) {
			put('blocks', `${String(b.account_id)} ${String(b.target_account_id)}`, 1)
		}
	}
	for (const m of all('SELECT account_id, target_account_id, hide_notifications FROM mutes')) {
		if (known(m.account_id) && known(m.target_account_id) && m.account_id !== m.target_account_id) {
			put('mutes', `${String(m.account_id)} ${String(m.target_account_id)}`, m.hide_notifications === 0 ? 0 : 1)
		}
	}
	for (const d of all('SELECT account_id, domain FROM domain_blocks')) {
		if (known(d.account_id)) {
			put('domain_blocks', `${String(d.account_id)} ${text(d.domain).trim().toLowerCase()}`, 1)
		}
	}
	for (const l of all('SELECT id, account_id, title, replies_policy, exclusive FROM lists')) {
		if (known(l.account_id)) {
			const policy = ['followed', 'list', 'none'].includes(text(l.replies_policy)) ? text(l.replies_policy) : 'list'
			put('lists', String(l.id), [String(l.account_id), text(l.title), policy, l.exclusive === 1 ? 1 : 0])
		}
	}
	for (const m of all('SELECT list_id, account_id FROM list_accounts')) {
		if (known(m.account_id) && out.lists?.[String(m.list_id)] !== undefined) {
			put('list_accounts', `${String(m.list_id)} ${String(m.account_id)}`, 1)
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
	for (const c of all('SELECT id, secret, name, redirect_uris, scopes FROM clients')) {
		put('clients', String(c.id), [String(c.secret), String(c.name), String(c.redirect_uris), text(c.scopes) || 'read'])
	}
	return { records: out, overLimit }
}
