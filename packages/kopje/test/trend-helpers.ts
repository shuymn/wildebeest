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
