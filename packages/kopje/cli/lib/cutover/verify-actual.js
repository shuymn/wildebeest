/* global crypto */
// The actual side of the conversion check, read from a Kopje dump (the converted file, or a dump of the Store after the
// import), and the comparison with the expected side (verify-expect.js). Plain JS without Node APIs, so the same check
// runs in the Workers test pool against a real Store.
//
// Each category maps a key built from AP URIs to the exact record. The check FAILs on any missing, extra or changed
// record: content that is missing or rewritten (even to the same length), a dropped relationship, or a different count.
// The report has counts and SHA-256 digests only, never records or keys.

import { readDumpText, textOf } from './dump-parse.js'

/** @typedef {Record<string, Record<string, string>>} Records */

// Categories where only the expected keys are checked: the Store holds more ids than the legacy instance had, and
// its own settings (configuration, keys made at setup) besides the imported ones.
const SUBSET = new Set(['legacy_ids', 'settings'])

export const CATEGORIES = [
	'accounts',
	'keys',
	'raw',
	'statuses',
	'edits',
	'attachments',
	'media',
	'boosts',
	'legacy_ids',
	'follows',
	'favourites',
	'bookmarks',
	'blocks',
	'mutes',
	'domain_blocks',
	'lists',
	'list_accounts',
	'notifications',
	'settings',
	'clients',
]

const REACH = /** @type {Record<string, number>} */ ({ public: 3, unlisted: 2, private: 1, direct: 0, limited: 0 })

/** @param {string | undefined} literal */
function int(literal) {
	return literal === undefined || literal === 'NULL' ? null : Number(literal)
}

/** @param {string | undefined} literal */
function blobHex(literal) {
	return literal === undefined || !/^[Xx]'/.test(literal) ? '' : literal.slice(2, -1).toUpperCase()
}

/**
 * @param {string} text the whole dump
 * @returns {Records}
 */
export function actualFromDump(text) {
	/** @type {Records} */
	const out = {}
	/** @param {string} category @param {string} key @param {unknown} value */
	const put = (category, key, value) => {
		const records = (out[category] ??= {})
		records[key] = JSON.stringify(value)
	}
	/** @type {Map<string, { uri: string, local: boolean }>} */
	const accounts = new Map()
	/** @type {Map<string, { uri: string, author: string, record: unknown[] | null }>} */
	const statuses = new Map()
	/** @type {Map<string, string>} */
	const reblogOf = new Map()
	/** @type {Map<string, unknown[]>} */
	const edits = new Map()
	/** @type {Map<string, [number, unknown[]][]>} */
	const media = new Map()
	const account = (/** @type {string | null} */ id) => (id === null ? undefined : accounts.get(id))
	const status = (/** @type {string | null} */ id) => (id === null ? undefined : statuses.get(id))

	const { statements } = readDumpText(text)
	for (const statement of statements) {
		if (statement.kind === 'link') {
			if (statement.table === 'statuses') {
				const id = textOf(statement.where.find(([c]) => c === 'id')?.[1])
				const target = textOf(statement.set.find(([c]) => c === 'reblog_of_id')?.[1])
				if (id !== null && target !== null) {
					reblogOf.set(id, target)
				}
			}
			continue
		}
		/** @type {Record<string, string>} */
		const row = {}
		statement.columns.forEach((column, i) => {
			row[column] = statement.literals[i] ?? 'NULL'
		})
		/** @param {string} column */
		const t = (column) => textOf(row[column])
		switch (statement.table) {
			case 'accounts': {
				const uri = t('uri') ?? ''
				const local = row.domain === 'NULL'
				accounts.set(t('id') ?? '', { uri, local })
				put('accounts', uri, [
					local ? 1 : 0,
					local ? t('username') : null,
					t('display_name'),
					t('note'),
					t('avatar_url'),
					t('header_url'),
					int(row.locked),
				])
				if (row.raw !== 'NULL') {
					put('raw', `account ${uri}`, t('raw'))
				}
				put('legacy_ids', `account ${t('id') ?? ''}`, uri)
				if (row.legacy_id !== 'NULL') {
					put('legacy_ids', `account ${t('legacy_id') ?? ''}`, uri)
				}
				break
			}
			case 'local_accounts': {
				const owner = account(t('account_id'))
				put('keys', owner?.uri ?? '', [t('email'), blobHex(row.privkey), blobHex(row.privkey_salt), t('pubkey')])
				break
			}
			case 'statuses': {
				const uri = t('uri') ?? ''
				const author = account(t('account_id'))?.uri ?? ''
				const id = t('id') ?? ''
				statuses.set(id, {
					uri,
					author,
					record: [
						author,
						t('content'),
						t('source_text'),
						t('spoiler_text'),
						int(row.sensitive),
						t('published_at'),
						REACH[t('visibility') ?? ''] ?? -1,
					],
				})
				if (row.raw !== 'NULL') {
					put('raw', `status ${uri}`, t('raw'))
				}
				put('legacy_ids', `status ${id}`, uri)
				if (row.legacy_id !== 'NULL') {
					put('legacy_ids', `status ${t('legacy_id') ?? ''}`, uri)
				}
				break
			}
			case 'status_edits': {
				const uri = status(t('status_id'))?.uri ?? ''
				edits.set(uri, [...(edits.get(uri) ?? []), [t('content'), t('spoiler_text'), int(row.sensitive)]])
				break
			}
			case 'media_attachments': {
				if (row.legacy_ap_o !== 'NULL') {
					put('media', t('legacy_ap_o') ?? '', t('url'))
				}
				const owner = status(t('status_id'))
				if (owner !== undefined) {
					media.set(owner.uri, [
						...(media.get(owner.uri) ?? []),
						[Number(int(row.position)), [t('url'), t('description')]],
					])
				}
				break
			}
			case 'follows':
				put('follows', `${account(t('account_id'))?.uri} ${account(t('target_account_id'))?.uri}`, [
					t('state'),
					t('uri'),
				])
				break
			case 'favourites':
				put('favourites', `${account(t('account_id'))?.uri} ${status(t('status_id'))?.uri}`, 1)
				break
			case 'bookmarks':
				put('bookmarks', `${account(t('account_id'))?.uri} ${status(t('status_id'))?.uri}`, 1)
				break
			case 'blocks':
				put('blocks', `${account(t('account_id'))?.uri} ${account(t('target_account_id'))?.uri}`, 1)
				break
			case 'mutes':
				put(
					'mutes',
					`${account(t('account_id'))?.uri} ${account(t('target_account_id'))?.uri}`,
					int(row.hide_notifications)
				)
				break
			case 'domain_blocks':
				put('domain_blocks', `${account(t('account_id'))?.uri} ${t('domain')}`, 1)
				break
			case 'lists':
				put('lists', t('id') ?? '', [account(t('account_id'))?.uri, t('title')])
				break
			case 'list_accounts':
				put('list_accounts', `${t('list_id')} ${account(t('account_id'))?.uri}`, 1)
				break
			case 'notifications':
				put('notifications', row.id ?? '', [
					t('type'),
					account(t('account_id'))?.uri,
					account(t('from_account_id'))?.uri,
					row.status_id === 'NULL' ? '' : status(t('status_id'))?.uri,
				])
				break
			case 'instance_settings':
				put('settings', t('name') ?? '', t('value'))
				break
			case 'oauth_clients':
				put('clients', t('id') ?? '', [t('secret'), t('name'), t('redirect_uris')])
				break
			default:
				break
		}
	}
	for (const [id, entry] of statuses) {
		const target = reblogOf.get(id)
		if (target === undefined) {
			put('statuses', entry.uri, entry.record)
		} else {
			put('boosts', entry.uri, [entry.author, statuses.get(target)?.uri])
		}
	}
	for (const [uri, versions] of edits) {
		put('edits', uri, versions)
	}
	for (const [uri, items] of media) {
		put(
			'attachments',
			uri,
			items.sort((a, b) => a[0] - b[0]).map(([, value]) => value)
		)
	}
	return out
}

/** @param {string} text */
async function sha256(text) {
	const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** @param {Record<string, string>} records @param {string[]} keys */
function canonical(records, keys) {
	return keys
		.sort()
		.map((key) => `${JSON.stringify(key)}\t${records[key]}\n`)
		.join('')
}

/**
 * Compares the expected and actual records. The report holds counts and digests only.
 * @param {Records} expected
 * @param {Records} actual
 */
export async function compareConversion(expected, actual) {
	/** @type {Record<string, { expected: number, actual: number, missing: number, extra: number, changed: number, expectedSha256: string, actualSha256: string }>} */
	const categories = {}
	let failed = false
	for (const name of CATEGORIES) {
		const want = expected[name] ?? {}
		const have = actual[name] ?? {}
		const wantKeys = Object.keys(want)
		const subset = SUBSET.has(name)
		const haveKeys = subset ? wantKeys.filter((k) => k in have) : Object.keys(have)
		let missing = 0
		let changed = 0
		for (const key of wantKeys) {
			if (!(key in have)) {
				missing++
			} else if (have[key] !== want[key]) {
				changed++
			}
		}
		const extra = subset ? 0 : haveKeys.filter((k) => !(k in want)).length
		failed ||= missing + changed + extra > 0
		categories[name] = {
			expected: wantKeys.length,
			actual: haveKeys.length,
			missing,
			extra,
			changed,
			expectedSha256: await sha256(canonical(want, wantKeys)),
			actualSha256: await sha256(canonical(have, haveKeys)),
		}
	}
	return { result: failed ? 'FAIL' : 'PASS', categories }
}
