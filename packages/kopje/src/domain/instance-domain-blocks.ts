import { type PageQuery, edgeRangeSql } from './accounts'
import { domainCoveredSql, hostCoveredSql, MAX_BLOCK_LABELS } from './audience'
import { readOperation, writeOperation } from './operation'
import type { Db } from '../db/sql'
import { blockedDomain, hostDomain } from '../platform/domain-name'

// Instance domain blocks (R38, VIS-30; Mastodon's DomainBlock), migration 0046_instance_domain_blocks. Each Store
// operation commits in one transaction and fetches nothing. A host's rule is its longest matching block (audience.ts
// hostCoveredSql); a suspend denies availability, delivery but retractions, fetches, actor storage and refresh, and
// inbound activity but cleanups verified with a stored key (docs/visibility.md, "Instance domain blocks").
// Rules read the live blocks, so a change applies from its commit. A change in coverage resets the domain job in its
// transaction (resetDomainJob), which reconciles the domain marks and severs newly covered accounts.

export type Severity = 'suspend' | 'noop'

export type InstanceDomainBlock = {
	id: number
	domain: string
	severity: Severity
	reject_media: boolean
	reject_reports: boolean
	obfuscate: boolean
	private_comment: string | null
	public_comment: string | null
	created_at: string
	updated_at: string
}

export type BlockFields = {
	severity: Severity
	rejectMedia: boolean
	rejectReports: boolean
	obfuscate: boolean
	privateComment: string | null
	publicComment: string | null
}

type BlockRow = Omit<InstanceDomainBlock, 'reject_media' | 'reject_reports' | 'obfuscate'> & {
	reject_media: number
	reject_reports: number
	obfuscate: number
}

const COLUMNS =
	'id, domain, severity, reject_media, reject_reports, obfuscate, private_comment, public_comment, created_at, updated_at'

function present(row: BlockRow): InstanceDomainBlock {
	return {
		...row,
		reject_media: row.reject_media === 1,
		reject_reports: row.reject_reports === 1,
		obfuscate: row.obfuscate === 1,
	}
}

function labels(domain: string): number {
	return domain.split('.').length
}

// Mastodon's DomainValidator (app/validators/domain_validator.rb:4-6, 24-31): a normalized domain is shorter than 256
// characters, each label 1 to 63 long.
export const MAX_DOMAIN_LENGTH = 255
export const MAX_LABEL_LENGTH = 63
// A raw domain (trimmed) longer than this is refused before it is normalized: no normalization of a longer one gives a
// domain within MAX_DOMAIN_LENGTH.
export const MAX_DOMAIN_INPUT = 1_024

export type BlockDomain = { ok: true; domain: string } | { ok: false; error: 'invalid-domain' | 'too-deep' }

// The domain a block of `raw` names: normalized by blockedDomain once the raw input is within MAX_DOMAIN_INPUT, then
// held to Mastodon's limits (invalid-domain) and to MAX_BLOCK_LABELS labels (too-deep), the bound hostCoveredSql and
// ruleFor rely on.
export function blockDomainOf(raw: string): BlockDomain {
	const trimmed = raw.trim()
	const domain = trimmed.length > MAX_DOMAIN_INPUT ? null : blockedDomain(trimmed)
	if (
		domain === null ||
		domain.length > MAX_DOMAIN_LENGTH ||
		domain.split('.').some((label) => label.length > MAX_LABEL_LENGTH)
	) {
		return { ok: false, error: 'invalid-domain' }
	}
	return labels(domain) > MAX_BLOCK_LABELS ? { ok: false, error: 'too-deep' } : { ok: true, domain }
}

// The block that rules `domain`: its own, or its nearest parent's (Mastodon's DomainBlock.rule_for). Only its
// suffixes of 2 to MAX_BLOCK_LABELS labels are built: no stored block has more.
function ruleFor(db: Db, domain: string): BlockRow | undefined {
	const tail = domain.split('.').slice(-MAX_BLOCK_LABELS)
	const suffixes = tail.map((_, i) => tail.slice(i).join('.')).filter((suffix) => labels(suffix) >= 2)
	return db.first<BlockRow>(
		`SELECT ${COLUMNS} FROM instance_domain_blocks WHERE domain IN (SELECT value FROM json_each(?))
		ORDER BY length(domain) DESC LIMIT 1`,
		JSON.stringify(suffixes)
	)
}

// Resets the domain job (remote-suspension.ts) in the caller's transaction: its walks start again, and its follow
// bound is the newest follow. Here, not there: deliveries.ts reads hostCovered, and remote-suspension.ts deliveries.ts.
export function resetDomainJob(db: Db): void {
	db.run(
		`INSERT INTO remote_moderation_jobs (kind, subject, mode, follow_bound, phase, cursor)
		VALUES ('domain', '', 'domain', (SELECT coalesce(max(id), 0) FROM follows), 'clear', '')
		ON CONFLICT (kind, subject) DO UPDATE SET follow_bound = excluded.follow_bound, phase = excluded.phase,
			cursor = excluded.cursor`
	)
}

// A block's change of the rule for the hosts its domain rules: whether they were covered before (`was`) and are after.
function transition(db: Db, was: boolean, is: boolean): void {
	if (was !== is) {
		resetDomainJob(db)
	}
}

// The fields Mastodon's DomainBlock#stricter_than? compares (domain_block.rb:81-87). `severity` is a request's, which
// may be one Kopje does not store (silence, or a value outside the list), as Mastodon compares an unsaved block.
export type Strictness = { severity: string; rejectMedia: boolean; rejectReports: boolean }

// Mastodon's DomainBlock#stricter_than? (domain_block.rb:81-87) against a stored block, whose severity is suspend or
// noop: a suspend is stricter than anything; nothing else is stricter than a suspend; otherwise the flags decide.
function stricterThan(block: Strictness, other: BlockRow): boolean {
	if (block.severity === 'suspend') {
		return true
	}
	if (other.severity === 'suspend' && (block.severity === 'silence' || block.severity === 'noop')) {
		return false
	}
	return (block.rejectMedia || other.reject_media === 0) && (block.rejectReports || other.reject_reports === 0)
}

// Whether a new block of `domain` (normalized) conflicts with `ruling`, the block that rules it, as Mastodon's create
// refuses it (domain_blocks_controller.rb:32-33, 58-60): the block of `domain` itself, or one at least as strict.
function conflicts(domain: string, block: Strictness, ruling: BlockRow): boolean {
	return ruling.domain === domain || !stricterThan(block, ruling)
}

// The block a new block of `domain` (normalized) conflicts with (conflicts).
export function conflictingBlock(db: Db, domain: string, block: Strictness): InstanceDomainBlock | undefined {
	const ruling = ruleFor(db, domain)
	return ruling !== undefined && conflicts(domain, block, ruling) ? present(ruling) : undefined
}

export type CreateBlockResult =
	| { ok: true; block: InstanceDomainBlock }
	| { ok: false; error: 'invalid-domain' | 'too-deep' }
	| { ok: false; error: 'exists'; existing: InstanceDomainBlock }

// Creates a block of a raw `domain`; refuses what blockDomainOf refuses and a conflicting block (conflictingBlock).
export function createBlock(db: Db, input: BlockFields & { domain: string; now: number }): CreateBlockResult {
	const named = blockDomainOf(input.domain)
	if (!named.ok) {
		return named
	}
	const { domain } = named
	const ruling = ruleFor(db, domain)
	if (ruling !== undefined && conflicts(domain, input, ruling)) {
		return { ok: false, error: 'exists', existing: present(ruling) }
	}
	transition(db, ruling?.severity === 'suspend', input.severity === 'suspend')
	const at = new Date(input.now).toISOString()
	const row = db.first<BlockRow>(
		`INSERT INTO instance_domain_blocks (domain, severity, reject_media, reject_reports, obfuscate, private_comment,
			public_comment, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
		domain,
		input.severity,
		input.rejectMedia ? 1 : 0,
		input.rejectReports ? 1 : 0,
		input.obfuscate ? 1 : 0,
		input.privateComment,
		input.publicComment,
		at,
		at
	)
	return { ok: true, block: present(row!) }
}

export const createInstanceDomainBlock = writeOperation(createBlock)

// Applies the given fields; the domain and omitted fields stay. Null for an unknown id.
export function updateBlock(
	db: Db,
	input: Partial<BlockFields> & { id: number; now: number }
): InstanceDomainBlock | null {
	const before = db.first<BlockRow>(`SELECT ${COLUMNS} FROM instance_domain_blocks WHERE id = ?`, input.id)
	if (before === undefined) {
		return null
	}
	const severity = input.severity ?? before.severity
	transition(db, before.severity === 'suspend', severity === 'suspend')
	const flag = (value: boolean | undefined, stored: number) => (value === undefined ? stored : value ? 1 : 0)
	const row = db.first<BlockRow>(
		`UPDATE instance_domain_blocks SET severity = ?, reject_media = ?, reject_reports = ?, obfuscate = ?,
			private_comment = ?, public_comment = ?, updated_at = ?
		WHERE id = ? RETURNING ${COLUMNS}`,
		severity,
		flag(input.rejectMedia, before.reject_media),
		flag(input.rejectReports, before.reject_reports),
		flag(input.obfuscate, before.obfuscate),
		input.privateComment === undefined ? before.private_comment : input.privateComment,
		input.publicComment === undefined ? before.public_comment : input.publicComment,
		new Date(input.now).toISOString(),
		input.id
	)
	return row === undefined ? null : present(row)
}

export const updateInstanceDomainBlock = writeOperation(updateBlock)

export function deleteBlock(db: Db, id: number): InstanceDomainBlock | null {
	const row = db.first<BlockRow>(`DELETE FROM instance_domain_blocks WHERE id = ? RETURNING ${COLUMNS}`, id)
	if (row === undefined) {
		return null
	}
	transition(db, row.severity === 'suspend', ruleFor(db, row.domain)?.severity === 'suspend')
	return present(row)
}

export const deleteInstanceDomainBlock = writeOperation<{ id: number }, InstanceDomainBlock | null>((db, { id }) =>
	deleteBlock(db, id)
)

export function blockById(db: Db, id: number): InstanceDomainBlock | null {
	const row = db.first<BlockRow>(`SELECT ${COLUMNS} FROM instance_domain_blocks WHERE id = ?`, id)
	return row === undefined ? null : present(row)
}

// A page of the blocks by id, as Mastodon's to_a_paginated_by_id reads it (app/models/concerns/paginable.rb:24-30):
// newest first below max_id and above since_id, or, given min_id, the oldest above it and below max_id (since_id
// unused), still answered newest first. Direct ranges on the primary key (edgeRangeSql).
export function blocksPage(db: Db, page: PageQuery): InstanceDomainBlock[] {
	const ascending = page.minId !== undefined
	const rows = db.all<BlockRow>(
		`SELECT ${COLUMNS} FROM instance_domain_blocks WHERE ${edgeRangeSql('id', '?1', '?2')}
		ORDER BY id ${ascending ? 'ASC' : 'DESC'} LIMIT ?3`,
		page.maxId ?? null,
		(ascending ? page.minId : page.sinceId) ?? null,
		page.limit
	)
	return (ascending ? rows.reverse() : rows).map(present)
}

// Whether a suspend block covers `host`, a normalized domain (hostDomain).
export function hostCovered(db: Db, host: string): boolean {
	return db.first<{ covered: number }>(`SELECT ${hostCoveredSql('?1')} AS covered`, host)?.covered === 1
}

// Decision 6: the Worker reads this before each fetch, and makes no request to a covered host (Mastodon's
// FetchRemoteActorService refuses a blocked domain). Advisory: a block committed between this read and the fetch
// costs one request, whose result the writes refuse (upsertRemoteActor, storeRemoteStatus).
export const fetchRefused = readOperation<{ host: string }, boolean>((db, { host }) => hostCovered(db, host))

// Blocked by the actor URI's host or its stored account's domain. Inbound cleanups then need a stored key and fetch
// nothing (R38; federation/inbound.ts, inbox.ts receive).
export function actorDomainBlocked(db: Db, uri: string): boolean {
	let host: string
	try {
		host = hostDomain(uri)
	} catch {
		return false
	}
	return (
		hostCovered(db, host) ||
		db.first(`SELECT 1 AS x FROM accounts a WHERE a.uri = ? AND ${domainCoveredSql('a')}`, uri) !== undefined
	)
}

export const inboundDomainBlocked = readOperation<{ uri: string }, boolean>((db, { uri }) =>
	actorDomainBlocked(db, uri)
)
