import { runInDurableObject } from 'cloudflare:test'

import { type ApiHarness, bearer, seedAccount, sql } from './api-helpers'
import { BUILD } from './helpers'
import { ACCESS, setAccess } from './ops-helpers'
import { community } from './status-helpers'
import type { AdminAnnouncement, AnnouncementInput } from '../src/domain/announcements'
import type { ImportAuthority } from '../src/platform/store-admin'
import type { StoreStub } from '../src/platform/store-client'

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
		const account = await seedAccount(store, { username: username(i), domain: domain(i) })
		// The shortest host, so the most of the URL is backslashes.
		const prefix = `https://${(i + 10).toString(36)}/?`
		await sql(
			store,
			'UPDATE accounts SET url = ? WHERE id = ?',
			`${prefix}${'\\'.repeat(2048 - prefix.length)}`,
			account
		)
		refs.push(`@${username(i)}@${domain(i)}`)
	}
	return refs.join(' ')
}

// The widest hashtags (RES-3): 16 names of a CJK character and 85 U+0F77, which NFKC makes 256 code units of three
// bytes (U+0F77 is U+0FB2 U+0F71 U+0F80), the most a presented name holds; 260 bytes of text each.
export function tagFill(count = 16): string {
	return Array.from({ length: count }, (_, i) => `#${String.fromCharCode(0x4e00 + i)}${'\u0F77'.repeat(85)}`).join(' ')
}
