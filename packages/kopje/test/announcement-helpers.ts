import { runInDurableObject } from 'cloudflare:test'

import { type ApiHarness, bearer, seedAccount, sql } from './api-helpers'
import { BUILD } from './helpers'
import { ACCESS, setAccess } from './ops-helpers'
import { community } from './status-helpers'
import {
	type AdminAnnouncement,
	ANNOUNCEMENT_CONTENT_BYTES,
	type AnnouncementInput,
	MAX_ANNOUNCEMENT_MENTIONS,
	MAX_ANNOUNCEMENT_TAGS,
	MENTION_DOMAIN_BYTES,
	TAG_NAME_BYTES,
} from '../src/domain/announcements'
import { jsonBytes } from '../src/domain/answer-budget'
import { PROFILE_URL_LIMIT, USERNAME_LIMIT } from '../src/domain/profile-bounds'
import { MAX_TAG_LENGTH } from '../src/domain/status-bounds'
import type { ImportAuthority } from '../src/platform/store-admin'
import type { StoreStub } from '../src/platform/store-client'
import {
	EMOJI_URL_LIMIT,
	MAX_LIVE_ANNOUNCEMENTS,
	MAX_REACTION_NAMES,
	REACTION_NAME_BYTES,
	STATUS_EMOJIS_BYTES,
} from '../src/platform/stored-bounds'

// Announcements (migration 0056_announcements, domain/announcements.ts): the Access admin's writes through the Store,
// signed-in users' requests, and rows inserted as an import writes them.

const DEFAULTS: AnnouncementInput = { text: 'hello', startsAt: null, endsAt: null, allDay: false, scheduledAt: null }

// The Store's admin writes as the Access admin (ACCESS by default), each throwing on a refusal.
export function announcementAdmin(store: StoreStub, authority: ImportAuthority = ACCESS) {
	const ok = <T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> => {
		if (!result.ok) {
			throw new Error(`refused: ${JSON.stringify(result)}`)
		}
		return result as Extract<T, { ok: true }>
	}
	return {
		create: async (input: Partial<AnnouncementInput> = {}): Promise<AdminAnnouncement> =>
			ok(await store.createAnnouncement(BUILD, { authority, ...DEFAULTS, ...input })).announcement,
		update: async (id: string, changes: Partial<AnnouncementInput>) =>
			ok(await store.updateAnnouncement(BUILD, { authority, id, changes })).announcement,
		publish: async (id: string) => ok(await store.publishAnnouncement(BUILD, { authority, id })).announcement,
		unpublish: async (id: string) => ok(await store.unpublishAnnouncement(BUILD, { authority, id })).announcement,
		remove: async (id: string) => ok(await store.deleteAnnouncement(BUILD, { authority, id })).deleted,
	}
}

// Signed-in local users (each with a token of every scope) on a Store whose Access admin is ACCESS on the harness's
// team (so later sign-ins still pass), and that admin's writes.
export async function announcementHarness<const N extends string>(names: readonly N[], scope?: string) {
	const h = await community(names, scope)
	await setAccess(h.store, { access_team_domain: h.team.teamDomain })
	const authority = { ...ACCESS, teamDomain: h.team.teamDomain }
	return { ...h, authority, admin: announcementAdmin(h.store, authority) }
}

export type Sent = { status: number; body: unknown }

// A request of the user's token with `method`, its status and parsed body.
export async function send(
	h: Pick<ApiHarness, 'request'>,
	method: string,
	path: string,
	token?: string
): Promise<Sent> {
	const response = await h.request(path, token === undefined ? { method } : bearer(token, { method }))
	return { status: response.status, body: (await response.json()) as unknown }
}

// The reaction route of an announcement and a name, the name percent-encoded.
export function reactionPath(id: string, name: string): string {
	return `/api/v1/announcements/${id}/reactions/${encodeURIComponent(name)}`
}

export const T0 = '2026-10-12T00:00:00.000Z'

// An announcement row inserted as an import writes it (no API, no journal): published at `published_at` unless it
// is null; the text as given.
export async function seedAnnouncement(
	store: StoreStub,
	row: { id: string; text: string } & Partial<Record<string, string | number | null>>
): Promise<string> {
	const values = {
		published: 1,
		published_at: T0,
		created_at: T0,
		updated_at: T0,
		...row,
	}
	const columns = Object.keys(values)
	await runInDurableObject(store, (_instance, state) => {
		state.storage.sql.exec(
			`INSERT INTO announcements (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
			...Object.values(values)
		)
	})
	return row.id
}

// A remote account of `username` on `domain` with a 2,048-byte profile URL of backslashes on the shortest host (the
// `i`th), so the most of it is backslashes, which the URL keeps in its query and JSON escapes to two bytes each.
async function widestAccount(store: StoreStub, i: number, username: string, domain: string): Promise<void> {
	const account = await seedAccount(store, { username, domain })
	const prefix = `https://${(i + 10).toString(36)}/?`
	await sql(store, 'UPDATE accounts SET url = ? WHERE id = ?', `${prefix}${'\\'.repeat(2048 - prefix.length)}`, account)
}

// The widest mentions a 10,000-byte text reaches (RES-3): `count` (16) remote accounts of 255-character usernames on
// 367-character domains (625 bytes of text each), each with a 2,048-byte profile URL of backslashes in its query, which
// the URL keeps and JSON escapes to two bytes each. Returns the text that mentions them all.
export async function mentionFill(store: StoreStub, count = 16, first = 0): Promise<string> {
	const label = (c: string, n: number) => c.repeat(n)
	// 367 bytes, and 368 for the first, which the 10,000 bytes leave room for.
	const domain = (i: number) =>
		[`${String(i).padStart(2, '0')}${label('d', 60)}`, label('e', 60), label('f', 60), label('g', 60), label('h', 60)]
			.concat(label('i', 55), 'example')
			.join('.')
			.slice(0, i === first ? 368 : 367)
	const username = (i: number) => `${String(i).padStart(2, '0')}${'u'.repeat(253)}`
	const refs: string[] = []
	for (let i = first; i < first + count; i++) {
		await widestAccount(store, i, username(i), domain(i))
		refs.push(`@${username(i)}@${domain(i)}`)
	}
	return refs.join(' ')
}

// The widest hashtags (RES-3): 16 names of a CJK character and 85 U+0F77, which NFKC makes 256 code units of three
// bytes (U+0F77 is U+0FB2 U+0F71 U+0F80), the most a presented name holds; 260 bytes of text each.
export function tagFill(count = 16): string {
	return Array.from({ length: count }, (_, i) => `#${String.fromCharCode(0x4e00 + i)}${'\u0F77'.repeat(85)}`).join(' ')
}

// The conservative maximum of each presented part of an announcement (RES-3), derived from the caps of the columns
// and of the presenter, each at its worst JSON escaping, never from a fill: a fill only witnesses that what is
// reachable stays within it.
//   - mentions: MAX_ANNOUNCEMENT_MENTIONS entries, each an 18-digit id, a username of USERNAME_LIMIT (the lookup
//     matches the text's ASCII handle, so it needs no escape), a url of PROFILE_URL_LIMIT serialized bytes all escaped
//     to two (a backslash survives a URL's query), and an acct of that username, "@" and a looked-up domain of
//     MENTION_DOMAIN_BYTES (hostname or word characters, no escape);
//   - tags: MAX_ANNOUNCEMENT_TAGS entries, each a name of MAX_TAG_LENGTH three-byte code units within TAG_NAME_BYTES
//     (alphabetic, no escape) and its url: an origin of a 253-byte host, /tags/ and the name percent-encoded (three
//     bytes a byte);
//   - emojis: STATUS_EMOJIS_BYTES, the presented bound;
//   - reactions: MAX_REACTION_NAMES entries, each the wider of a custom emoji's (an ASCII shortcode of
//     REACTION_NAME_BYTES and two urls of EMOJI_URL_LIMIT, whose alphabet needs no escape) and a Unicode one's (a name
//     of REACTION_NAME_BYTES stored bytes, each decoded to U+FFFD, three bytes; no url), with a count of
//     Number.MAX_SAFE_INTEGER and `me` false;
//   - content: ANNOUNCEMENT_CONTENT_BYTES;
//   - the rest: keys, the id, four times of 24 bytes, all_day and read false, "statuses":[].
// Each part is its whole JSON value; the entity is the sum, the list 16 of them with brackets and separators.
export function derivedAnnouncementMaxima() {
	const x = (n: number, c = 'x') => c.repeat(n)
	const username = x(USERNAME_LIMIT, 'u')
	const mention = {
		id: x(18, '1'),
		username,
		url: x(PROFILE_URL_LIMIT, '\\'),
		acct: `${username}@${x(MENTION_DOMAIN_BYTES, 'd')}`,
	}
	const name = x(Math.min(MAX_TAG_LENGTH, Math.floor(TAG_NAME_BYTES / 3)), '\u65e5')
	const tag = { name, url: `https://${x(253, 'h')}/tags/${encodeURIComponent(name)}` }
	const count = Number.MAX_SAFE_INTEGER
	const custom = {
		name: x(REACTION_NAME_BYTES, 's'),
		count,
		me: false,
		url: x(EMOJI_URL_LIMIT),
		static_url: x(EMOJI_URL_LIMIT),
	}
	const unicode = { name: x(REACTION_NAME_BYTES, '\ufffd'), count, me: false }
	const reaction = jsonBytes(custom) >= jsonBytes(unicode) ? custom : unicode
	const time = x(24)
	const rest =
		jsonBytes({
			id: x(18, '1'),
			content: '',
			starts_at: time,
			ends_at: time,
			all_day: false,
			published_at: time,
			updated_at: time,
			read: false,
			mentions: [],
			statuses: [],
			tags: [],
			emojis: [],
			reactions: [],
		}) -
		jsonBytes('') -
		4 * jsonBytes([])
	const parts = {
		content: ANNOUNCEMENT_CONTENT_BYTES,
		mentions: jsonBytes(Array.from({ length: MAX_ANNOUNCEMENT_MENTIONS }, () => mention)),
		tags: jsonBytes(Array.from({ length: MAX_ANNOUNCEMENT_TAGS }, () => tag)),
		emojis: STATUS_EMOJIS_BYTES,
		reactions: jsonBytes(Array.from({ length: MAX_REACTION_NAMES }, () => reaction)),
		rest,
	}
	const entity = Object.values(parts).reduce((a, b) => a + b, 0)
	return { parts, entity, list: MAX_LIVE_ANNOUNCEMENTS * entity + MAX_LIVE_ANNOUNCEMENTS + 1, stream: 2 * entity + 2 }
}

// The widest IDN mentions: 16 remote accounts of 255-character usernames on a domain spelled with 120
// "é." labels, which URL.hostname makes punycode of 966 ASCII bytes (the account's stored domain), each with a
// 2,048-byte profile URL of backslashes. Returns the text that mentions them in the Unicode spelling.
export async function idnMentionFill(store: StoreStub): Promise<string> {
	const spelled = `${'\u00e9.'.repeat(120)}a.test`
	const domain = new URL(`https://${spelled}`).hostname
	const refs: string[] = []
	for (let i = 0; i < 16; i++) {
		const username = `${String(i).padStart(2, '0')}${'u'.repeat(253)}`
		await widestAccount(store, i, username, domain)
		refs.push(`@${username}@${spelled}`)
	}
	return refs.join(' ')
}
