import { domainCoveredSql, hostCoveredSql, MAX_BLOCK_LABELS } from './audience'
import { readOperation, writeOperation } from './operation'
import type { Db } from '../db/sql'
import { blockedDomain, hostDomain } from '../platform/domain-name'

// Instance domain blocks (R38, VIS-30; Mastodon's DomainBlock), migration 0046_instance_domain_blocks: the instance's
// own policy by domain, as Store operations that each commit in one transaction and fetch nothing. The rule a host
// follows is the longest matching block (audience.ts hostCoveredSql), and a suspend covers it: its accounts are
// unavailable (availableSql), nothing is delivered to it but retractions (deliveries.ts sendRefused),
// nothing is fetched from it (fetchRefused), its accounts are neither stored nor refreshed (inbox.ts
// upsertRemoteActor), and its inbound activity is ignored but for cleanups verified with a stored key (inbox.ts
// receive, federation/inbound.ts). Every rule reads the live blocks, so a create, update or delete applies from its
// commit on.

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

// The block that rules `domain`: its own, or its nearest parent's (Mastodon's DomainBlock.rule_for).
function ruleFor(db: Db, domain: string): BlockRow | undefined {
	const suffixes = domain
		.split('.')
		.map((_, i, parts) => parts.slice(i).join('.'))
		.filter((suffix) => labels(suffix) >= 2 && labels(suffix) <= MAX_BLOCK_LABELS)
	return db.first<BlockRow>(
		`SELECT ${COLUMNS} FROM instance_domain_blocks WHERE domain IN (SELECT value FROM json_each(?))
		ORDER BY length(domain) DESC LIMIT 1`,
		JSON.stringify(suffixes)
	)
}

// Mastodon's DomainBlock#stricter_than? for the severities Kopje stores: a suspend is stricter than anything; a noop is
// stricter than a noop only by rejecting what the other does not.
function stricterThan(block: BlockFields, other: BlockRow): boolean {
	if (block.severity === 'suspend') {
		return true
	}
	if (other.severity === 'suspend') {
		return false
	}
	return (block.rejectMedia || other.reject_media === 0) && (block.rejectReports || other.reject_reports === 0)
}

export type CreateBlockResult =
	| { ok: true; block: InstanceDomainBlock }
	| { ok: false; error: 'invalid-domain' | 'too-deep' }
	| { ok: false; error: 'exists'; existing: InstanceDomainBlock }

// Creates a block of `domain` (raw, normalized by blockedDomain). Refused: a domain that is not one; a domain of more
// than MAX_BLOCK_LABELS labels (the label bound hostCoveredSql relies on); and, as Mastodon's create refuses it
// (domain_blocks_controller.rb:32-33, 58-60), a domain already blocked, or one whose ruling block is at least as
// strict, which `existing` names.
export const createInstanceDomainBlock = writeOperation<
	BlockFields & { domain: string; now: number },
	CreateBlockResult
>((db, input) => {
	const domain = blockedDomain(input.domain)
	if (domain === null) {
		return { ok: false, error: 'invalid-domain' }
	}
	if (labels(domain) > MAX_BLOCK_LABELS) {
		return { ok: false, error: 'too-deep' }
	}
	const existing = ruleFor(db, domain)
	if (existing !== undefined && (existing.domain === domain || !stricterThan(input, existing))) {
		return { ok: false, error: 'exists', existing: present(existing) }
	}
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
})

// Changes the severity, flags and comments of the block `id` (its domain stays); null for an unknown id.
export const updateInstanceDomainBlock = writeOperation<
	BlockFields & { id: number; now: number },
	InstanceDomainBlock | null
>((db, input) => {
	const row = db.first<BlockRow>(
		`UPDATE instance_domain_blocks SET severity = ?, reject_media = ?, reject_reports = ?, obfuscate = ?,
			private_comment = ?, public_comment = ?, updated_at = ?
		WHERE id = ? RETURNING ${COLUMNS}`,
		input.severity,
		input.rejectMedia ? 1 : 0,
		input.rejectReports ? 1 : 0,
		input.obfuscate ? 1 : 0,
		input.privateComment,
		input.publicComment,
		new Date(input.now).toISOString(),
		input.id
	)
	return row === undefined ? null : present(row)
})

// Deletes the block `id`; returns it, or null for an unknown id.
export const deleteInstanceDomainBlock = writeOperation<{ id: number }, InstanceDomainBlock | null>((db, { id }) => {
	const row = db.first<BlockRow>(`DELETE FROM instance_domain_blocks WHERE id = ? RETURNING ${COLUMNS}`, id)
	return row === undefined ? null : present(row)
})

// Whether a suspend block covers `host`, a normalized domain (hostDomain).
export function hostCovered(db: Db, host: string): boolean {
	return db.first<{ covered: number }>(`SELECT ${hostCoveredSql('?1')} AS covered`, host)?.covered === 1
}

// Decision 6: the Worker reads this before each fetch, and makes no request to a covered host (Mastodon's
// FetchRemoteActorService refuses a blocked domain). Advisory: a block committed between this read and the fetch
// costs one request, whose result the writes refuse (upsertRemoteActor, storeRemoteStatus).
export const fetchRefused = readOperation<{ host: string }, boolean>((db, { host }) => hostCovered(db, host))

// Whether the actor `uri` is domain-blocked: its host is covered, or its stored account is covered by its stored
// domain. Such an actor's inbound activity is verified only with a key already stored, with no fetch, and only its
// cleanups apply (federation/inbound.ts, inbox.ts receive).
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
