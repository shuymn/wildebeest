// The expected side of the conversion check, computed from the bridged legacy database alone. It shares nothing with
// convert.js: it reads legacy columns and JSON directly and writes each record in the comparison form of
// verify-actual.js, keyed by AP URIs (never by the ids the converter assigns). The only shared code is Kopje's own HTML
// sanitizer, a runtime transformation the Store applies to every stored HTML value (HTML-1).
//
// Records are kept as exact values, not digests, so a change of the same length is still a difference. They hold data
// and are never printed: reports carry counts and digests only.

import { sanitizeRemoteHtml } from '../../../src/security/html.ts'

const PUBLIC = new Set(['https://www.w3.org/ns/activitystreams#Public', 'as:Public', 'Public'])
const STATUS_TYPES = new Set(['Note', 'Article', 'Page', 'Question', 'Video', 'Audio', 'Event'])

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

/** @param {unknown} value */
const text = (value) => (typeof value === 'string' ? value : '')

/** @param {unknown} value */
function when(value) {
	if (typeof value !== 'string' || value === '') {
		return null
	}
	const ms = Date.parse(/^\d{4}-\d{2}-\d{2} /.test(value) ? `${value.replace(' ', 'T')}Z` : value)
	return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

// How widely a status is visible: 3 public, 2 unlisted, 1 followers, 0 addressed only.
/** @param {unknown} to @param {unknown} cc @param {string} followers */
function reach(to, cc, followers) {
	const t = many(to).map(ref)
	const c = many(cc).map(ref)
	if (t.some((x) => x !== null && PUBLIC.has(x))) {
		return 3
	}
	if (c.some((x) => x !== null && PUBLIC.has(x))) {
		return 2
	}
	return t.includes(followers) ? 1 : 0
}

/** @param {Uint8Array} bytes */
const hex = (bytes) =>
	Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
		.join('')
		.toUpperCase()

/**
 * @param {import('node:sqlite').DatabaseSync} db the bridged legacy database
 * @param {{ originalActorIds: Map<string, string> }} options
 * @returns {Records}
 */
export function expectedFromLegacy(db, { originalActorIds }) {
	/** @type {Records} */
	const out = {}
	/** @param {string} category @param {string} key @param {unknown} value */
	const put = (category, key, value) => {
		const records = (out[category] ??= {})
		records[key] = JSON.stringify(value)
	}
	/** @param {string} sql */
	const all = (sql) => /** @type {Json[]} */ (db.prepare(sql).all())

	// Accounts and profiles.
	const local = new Set(all('SELECT actor_id FROM users').map((u) => String(u.actor_id)))
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
			sanitizeRemoteHtml(text(p.summary)),
			href(typeof p.icon === 'object' && p.icon !== null ? p.icon.url : p.icon),
			href(typeof p.image === 'object' && p.image !== null ? p.image.url : p.image),
			p.manuallyApprovesFollowers === true ? 1 : 0,
		])
		if (!isLocal) {
			put('raw', `account ${uri}`, String(actor.properties))
		}
	}
	const followersOf = (/** @type {string} */ uri) => {
		const f = actors.get(uri)?.followers
		return typeof f === 'string' ? f : `${uri}/followers`
	}
	// Keys and private settings of local users, byte for byte.
	for (const user of all('SELECT actor_id, email, privkey, privkey_salt, pubkey FROM users')) {
		put('keys', String(user.actor_id), [
			String(user.email),
			hex(user.privkey),
			hex(user.privkey_salt),
			String(user.pubkey),
		])
	}

	// Statuses: content, source, spoiler, sensitivity, time, and how widely visible.
	/** @type {Map<string, string>} object id -> status URI */
	const statusUri = new Map()
	const objects = all('SELECT * FROM objects')
	for (const o of objects) {
		if (!STATUS_TYPES.has(String(o.type)) || !actors.has(String(o.original_actor_id))) {
			continue
		}
		const id = String(o.id)
		const uri =
			o.local !== 1 && typeof o.original_object_id === 'string' && o.original_object_id !== id
				? o.original_object_id
				: id
		statusUri.set(id, uri)
	}
	/** @type {Map<string, Json>} */
	const outbox = new Map(
		all('SELECT actor_id, object_id, "to", cc FROM outbox_objects').map((r) => [`${r.actor_id} ${r.object_id}`, r])
	)
	/** @type {Map<string, string[]>} */
	const statusApiIds = new Map()
	for (const o of objects) {
		const uri = statusUri.get(String(o.id))
		if (uri === undefined) {
			continue
		}
		const p = parse(o.properties)
		const author = String(o.original_actor_id)
		const isLocal = o.local === 1
		const sent = isLocal ? outbox.get(`${author} ${String(o.id)}`) : undefined
		const visible =
			sent === undefined
				? reach(p.to, p.cc, followersOf(author))
				: reach(parse(`{"v":${sent.to}}`).v, parse(`{"v":${sent.cc}}`).v, followersOf(author))
		const spoiler = isLocal ? text(p.spoiler_text) || text(p.summary) : text(p.summary) || text(p.spoiler_text)
		const source =
			isLocal && typeof p.source === 'object' && p.source !== null && typeof p.source.content === 'string'
				? p.source.content
				: null
		put('statuses', uri, [
			author,
			sanitizeRemoteHtml(text(p.content)),
			source,
			spoiler,
			p.sensitive === true ? 1 : 0,
			when(p.published) ?? when(o.cdate),
			visible,
		])
		if (!isLocal) {
			put('raw', `status ${uri}`, String(o.properties))
		}
		put(
			'attachments',
			uri,
			many(p.attachment)
				.filter((a) => typeof a === 'object' && a !== null && href(/** @type {Json} */ (a).url) !== null)
				.map((a) => [
					href(/** @type {Json} */ (a).url),
					text(/** @type {Json} */ (a).name) ||
						text(/** @type {Json} */ (a).description) ||
						text(/** @type {Json} */ (a).summary),
				])
		)
		statusApiIds.set(String(o.mastodon_id), [...(statusApiIds.get(String(o.mastodon_id)) ?? []), uri])
		if (isLocal) {
			const tail = (href(p.url) ?? '').replace(/\/+$/, '').split('/').pop() ?? ''
			if (tail !== '' && tail !== String(o.mastodon_id)) {
				statusApiIds.set(tail, [...(statusApiIds.get(tail) ?? []), uri])
			}
		}
	}
	// Attachments are compared only where a status has some (the actual side has no row for none).
	for (const [key, value] of Object.entries(out.attachments ?? {})) {
		if (value === '[]') {
			delete (out.attachments ?? {})[key]
		}
	}

	// Local images: their old /ap/o/<uuid> and URL.
	for (const o of objects) {
		if (o.type === 'Image' && o.local === 1) {
			const id = String(o.id)
			const uuid = id.slice(id.indexOf('/ap/o/') + '/ap/o/'.length)
			if (id.includes('/ap/o/')) {
				put('media', uuid, href(parse(o.properties).url))
			}
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
			[sanitizeRemoteHtml(text(p.content)), text(p.spoiler_text) || text(p.summary), p.sensitive === true ? 1 : 0],
		])
	}
	for (const [uri, versions] of history) {
		const current = JSON.parse(out.statuses?.[uri] ?? '[]')
		put('edits', uri, [...versions, [current[1], current[3], current[4]]])
	}

	// Boosts.
	for (const r of all('SELECT id, mastodon_id, actor_id, object_id FROM actor_reblogs')) {
		const target = statusUri.get(String(r.object_id))
		if (target === undefined || !actors.has(String(r.actor_id))) {
			continue
		}
		put('boosts', String(r.id), [String(r.actor_id), target])
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

	// Relationships, by URI.
	const known = (/** @type {unknown} */ uri) => actors.has(String(uri))
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
		put('follows', key, [String(f.state), record])
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
	for (const l of all('SELECT id, account_id, title FROM lists')) {
		if (known(l.account_id)) {
			put('lists', String(l.id), [String(l.account_id), text(l.title)])
		}
	}
	for (const m of all('SELECT list_id, account_id FROM list_accounts')) {
		if (known(m.account_id) && out.lists?.[String(m.list_id)] !== undefined) {
			put('list_accounts', `${String(m.list_id)} ${String(m.account_id)}`, 1)
		}
	}

	// Notifications: the smallest id of each (recipient, type, sender, status) stays.
	const seen = new Set()
	const notifications = db.prepare(
		'SELECT id, type, actor_id, from_actor_id, object_id FROM actor_notifications ORDER BY id'
	)
	notifications.setReadBigInts(true)
	for (const n of /** @type {Json[]} */ (notifications.all())) {
		const target = n.object_id === null ? '' : statusUri.get(String(n.object_id))
		if (!known(n.actor_id) || !known(n.from_actor_id) || target === undefined) {
			continue
		}
		const natural = `${String(n.actor_id)} ${String(n.type)} ${String(n.from_actor_id)} ${target}`
		if (seen.has(natural)) {
			continue
		}
		seen.add(natural)
		put('notifications', String(n.id), [String(n.type), String(n.actor_id), String(n.from_actor_id), target])
	}

	// Settings and clients.
	for (const s of all('SELECT setting_name, setting_value FROM server_settings')) {
		put('settings', String(s.setting_name), String(s.setting_value))
	}
	const rules = all('SELECT id, text FROM server_rules ORDER BY id').map((r) => ({
		id: String(r.id),
		text: String(r.text),
	}))
	if (rules.length > 0) {
		put('settings', 'rules', JSON.stringify(rules))
	}
	for (const c of all('SELECT id, secret, name, redirect_uris FROM clients')) {
		put('clients', String(c.id), [String(c.secret), String(c.name), String(c.redirect_uris)])
	}
	return out
}
