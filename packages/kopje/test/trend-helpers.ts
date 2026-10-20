import { runInDurableObject } from 'cloudflare:test'

import { seedAccount, sql } from './api-helpers'
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
