import { runInDurableObject } from 'cloudflare:test'

import { seedAccount, sql } from './api-helpers'
import { BUILD } from './helpers'
import type { StoreStub } from '../src/platform/store-client'

// Trends (migration 0057_trends, domain/trends.ts): authors and statuses written straight into the Store with the
// columns trends read (language, counts, content warning, publication time), as ingestion or a cutover writes them.

export const HOUR = 3_600_000
export const DAY = 24 * HOUR
// A fixed clock: 2026-10-20 12:00 UTC, so today and yesterday are 2026-10-20 and 2026-10-19.
export const AT = Date.parse('2026-10-20T12:00:00.000Z')
export const TODAY = Date.parse('2026-10-20T00:00:00.000Z')
export const YESTERDAY = TODAY - DAY

// The id Kopje gives a status at `ms` (domain/ids.ts: the time in the high bits), the `seq`th of that millisecond.
export function idAt(ms: number, seq = 0): string {
	return ((BigInt(ms) << 16n) | BigInt(seq)).toString().padStart(18, '0')
}

// A discoverable author (remote on `domain` when given).
export async function author(
	store: StoreStub,
	username: string,
	options: { domain?: string; discoverable?: number | null } = {}
): Promise<string> {
	const id = await seedAccount(store, { username, ...(options.domain === undefined ? {} : { domain: options.domain }) })
	await sql(
		store,
		'UPDATE accounts SET discoverable = ? WHERE id = ?',
		'discoverable' in options ? (options.discoverable ?? null) : 1,
		id
	)
	return id
}

export type TrendStatus = {
	author: string
	// The publication time; the id's time is `idAt` unless `id` is given.
	published: number
	id?: string
	seq?: number
	language?: string | null
	visibility?: string
	reply?: boolean
	spoiler?: string
	sensitive?: number
	reblogs?: number
	favourites?: number
	tags?: readonly string[]
	reblogOf?: string
	publishedAt?: string
}

function insertStatus(state: SqlStorage, status: TrendStatus): string {
	const id = status.id ?? idAt(status.published, status.seq ?? 0)
	state.exec(
		`INSERT INTO statuses (id, uri, account_id, reblog_of_id, in_reply_to_uri, visibility, spoiler_text, content,
			sensitive, language, published_at, reblogs_count, favourites_count)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id,
		`https://remote.example/objects/${id}`,
		status.author,
		status.reblogOf ?? null,
		status.reply === true ? 'https://remote.example/objects/parent' : null,
		status.visibility ?? 'public',
		status.spoiler ?? '',
		status.reblogOf === undefined ? `<p>status ${id}</p>` : '',
		status.sensitive ?? 0,
		status.language === undefined ? 'en' : status.language,
		status.publishedAt ?? new Date(status.published).toISOString(),
		status.reblogs ?? 0,
		status.favourites ?? 0
	)
	for (const tag of status.tags ?? []) {
		state.exec(
			"INSERT INTO status_tags (status_id, name, public) SELECT id, ?, visibility = 'public' FROM statuses WHERE id = ?",
			tag,
			id
		)
	}
	return id
}

// Statuses written in one call, returning their ids in order.
export async function trendStatuses(store: StoreStub, statuses: readonly TrendStatus[]): Promise<string[]> {
	return runInDurableObject(store, (_instance, state) => statuses.map((s) => insertStatus(state.storage.sql, s)))
}

export async function trendStatus(store: StoreStub, status: TrendStatus): Promise<string> {
	const [id] = await trendStatuses(store, [status])
	return id!
}

// `n` discoverable remote accounts, ids from `base` (500000000000000000 by default), on `domains` domains.
export async function authors(store: StoreStub, n: number, base = 500_000_000_000_000_000n, domains = 1) {
	await sql(
		store,
		`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
		INSERT INTO accounts (id, uri, username, domain, discoverable)
		SELECT CAST(?2 + i AS TEXT), 'https://d' || (i % ?3) || '.example/users/u' || ?2 || i, 'u' || i,
			'd' || (i % ?3) || '.example', 1
		FROM n`,
		n,
		String(base),
		domains
	)
	return Array.from({ length: n }, (_, i) => String(base + BigInt(i)))
}

// The round at `now`, through the Store.
export async function round(store: StoreStub, now = AT) {
	return store.trendsRound(BUILD, { now })
}

export type TagRow = { name: string; score: number; max_score: number; max_score_at: string }

export async function trendTags(store: StoreStub): Promise<TagRow[]> {
	return sql<TagRow>(store, 'SELECT name, score, max_score, max_score_at FROM trend_tags ORDER BY name')
}

export async function trendRows(store: StoreStub): Promise<{ status_id: string; account_id: string; score: number }[]> {
	return sql(store, 'SELECT status_id, account_id, score FROM trend_statuses ORDER BY score DESC, status_id DESC')
}

// `accounts` statuses carrying `tags`, one by each of `by` (an author each), published at `at` + their index ms.
export function uses(by: readonly string[], tags: readonly string[], at: number, seqBase = 0): TrendStatus[] {
	return by.map((a, i) => ({ author: a, published: at + i, seq: seqBase, tags }))
}

export async function setTrendSetting(store: StoreStub, name: 'trends' | 'trendable_by_default', value: boolean) {
	await sql(store, 'INSERT OR REPLACE INTO instance_settings (name, value) VALUES (?, ?)', name, String(value))
}

export async function review(
	store: StoreStub,
	table: 'tag_trend_reviews' | 'status_trend_reviews' | 'account_trend_reviews',
	key: string,
	trendable: boolean
) {
	const column = table === 'tag_trend_reviews' ? 'name' : table === 'status_trend_reviews' ? 'status_id' : 'account_id'
	await sql(
		store,
		`INSERT OR REPLACE INTO ${table} (${column}, trendable, reviewed_at) VALUES (?, ?, '2026-10-20T00:00:00.000Z')`,
		key,
		trendable ? 1 : 0
	)
}

// ---- Link trends (migration 0071_link_trends)

// A card copy of a status as a recorded card writes it: attached, its posted link `url` (the final URL by default),
// its final URL `link`, a qualifying link card by default (an article link with texts, a supported language and a
// stored image), and public as its status's visibility gives it unless `public` says otherwise.
export type LinkCopy = {
	status: string
	link: string
	url?: string
	linkType?: number
	cardType?: number
	title?: string
	description?: string
	provider?: string
	language?: string | null
	image?: 'stored' | 'pending' | 'none'
	public?: number
}

// The card_images id of a copy's image: its status id with a leading 8 (no status id of the fixtures starts so).
const imageIdOf = (status: string) => `8${status.slice(1)}`

function insertCopy(state: SqlStorage, copy: LinkCopy): void {
	const image = copy.image ?? 'stored'
	const imageId = image === 'none' ? null : imageIdOf(copy.status)
	if (imageId !== null) {
		state.exec(
			image === 'stored'
				? `INSERT INTO card_images (id, source_url, enqueued_at, token, width, height, stored_at)
					VALUES (?1, 'https://img.example/' || ?1, 1, ?2, 640, 360, 1)`
				: "INSERT INTO card_images (id, source_url, due_at, enqueued_at) VALUES (?1, 'https://img.example/' || ?1, 1, 1)",
			...(image === 'stored' ? [imageId, `t${imageId.padStart(42, '0')}`] : [imageId])
		)
	}
	const video = copy.cardType === 2
	state.exec(
		`INSERT INTO status_cards (status_id, url, enqueued_at, generation, title, description, provider_name, language,
			fetched_at, card_type, embed_src, image_url, image_id, link_type, final_url, public)
		VALUES (?1, ?2, 1, 1, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?9, ?10, ?11, ?12,
			coalesce(?13, (SELECT visibility = 'public' FROM statuses WHERE id = ?1)))`,
		copy.status,
		copy.url ?? copy.link,
		copy.title ?? 'A title',
		copy.description ?? 'A description',
		copy.provider ?? 'A publisher',
		copy.language === undefined ? 'en' : copy.language,
		copy.cardType ?? 0,
		video ? 'https://player.example/e' : '',
		imageId === null ? '' : `https://img.example/${imageId}`,
		imageId,
		copy.linkType ?? 1,
		copy.link,
		copy.public ?? null
	)
}

export async function linkCopies(store: StoreStub, copies: readonly LinkCopy[]): Promise<void> {
	await runInDurableObject(store, (_instance, state) => {
		for (const copy of copies) {
			insertCopy(state.storage.sql, copy)
		}
	})
}

// `by.length` public originals, one by each of `by`, published at `at` + their index ms (ids of sequence `seq`), each
// with a qualifying copy of `link` (`copy` changes it); returns their ids.
export async function linkPosts(
	store: StoreStub,
	by: readonly string[],
	link: string,
	at: number,
	{ seq = 0, copy = {}, status = {} }: { seq?: number; copy?: Partial<LinkCopy>; status?: Partial<TrendStatus> } = {}
): Promise<string[]> {
	const ids = await trendStatuses(
		store,
		by.map((a, i) => ({ author: a, published: at + i, seq, ...status }))
	)
	await linkCopies(
		store,
		ids.map((id) => ({ status: id, link, ...copy }))
	)
	return ids
}

// Public boosts of `of`, one by each of `by`, published at `at` + their index ms.
export async function boosts(
	store: StoreStub,
	of: string,
	by: readonly string[],
	at: number,
	{ seq = 0, visibility = 'public' }: { seq?: number; visibility?: string } = {}
): Promise<string[]> {
	return trendStatuses(
		store,
		by.map((a, i) => ({ author: a, published: at + i, seq, reblogOf: of, visibility }))
	)
}

export type LinkRow = {
	url: string
	domain: string
	language: string | null
	score: number
	max_score: number
	max_score_at: string
}

export async function trendLinkRows(store: StoreStub): Promise<LinkRow[]> {
	return sql<LinkRow>(
		store,
		'SELECT url, domain, language, score, max_score, max_score_at FROM trend_links ORDER BY url'
	)
}

// A stored trend link as an import writes it.
export async function storedLink(
	store: StoreStub,
	url: string,
	score: number,
	max: number,
	at: number,
	{ domain = new URL(url).hostname, language = 'en' }: { domain?: string; language?: string | null } = {}
) {
	await sql(
		store,
		'INSERT INTO trend_links (url, domain, language, score, max_score, max_score_at) VALUES (?, ?, ?, ?, ?, ?)',
		url,
		domain,
		language,
		score,
		max,
		new Date(at).toISOString()
	)
}

export async function reviewLink(store: StoreStub, kind: 'link' | 'publisher', key: string, trendable: boolean) {
	const [table, column] = kind === 'link' ? ['link_trend_reviews', 'url'] : ['link_provider_reviews', 'domain']
	await sql(
		store,
		`INSERT OR REPLACE INTO ${table} (${column}, trendable, reviewed_at) VALUES (?, ?, '2026-10-20T00:00:00.000Z')`,
		key,
		trendable ? 1 : 0
	)
}
