import type { PageQuery } from './accounts'
import { MAX_BLOCK_LABELS } from './audience'
import { ADMIN_PERMISSION, adminReadOperation, adminWriteOperation } from './auth'
import {
	blockDomainOf,
	blockById,
	blocksPage,
	conflictingBlock,
	createBlock,
	deleteBlock,
	type InstanceDomainBlock,
	type Severity,
	updateBlock,
} from './instance-domain-blocks'
import { logAction } from './moderation-log'
import type { Db } from '../db/sql'

// The Mastodon admin API's domain blocks (R37, VIS-29, VIS-30; Api::V1::Admin::DomainBlocksController of Mastodon
// 4.5.11) over the instance's blocks (instance-domain-blocks.ts), to the OAuth admin with manage_federation. Every
// write is logged in its transaction (moderation-log.ts), as Mastodon's log_action
// (domain_blocks_controller.rb:37, 45, 52).
//
// Differences from Mastodon, each answered 422 as a validation failure:
// - severity silence is not built (R38 has suspend and noop), so it is refused as a value outside the list. It is
//   Mastodon's default severity (domain_block.rb:11), so a create that sends none is refused too;
// - reject_media=true is refused: Kopje has no remote media cache to reject from (design change 9);
// - a domain of more than MAX_BLOCK_LABELS labels (the label bound of the live predicate, audience.ts);
// - a comment longer than MAX_BLOCK_COMMENT characters, which bounds an answered page (MAX_DOMAIN_BLOCKS_LIMIT blocks).

export const DOMAIN_BLOCKS_LIMIT = 100
export const MAX_DOMAIN_BLOCKS_LIMIT = 500
export const MAX_BLOCK_COMMENT = 1_000

const SEVERITIES: readonly string[] = ['suspend', 'noop'] satisfies Severity[]

// The request's fields, as the controller permits them (domain_block_params, resource_params): undefined for a field
// not sent. A severity sent blank is '' (Mastodon assigns nil, outside the list); a flag sent blank is not sent.
export type BlockRequest = {
	severity?: string
	rejectMedia?: boolean
	rejectReports?: boolean
	obfuscate?: boolean
	privateComment?: string | null
	publicComment?: string | null
}

export type DomainBlockResult =
	| { status: 'ok'; block: InstanceDomainBlock }
	| { status: 'not_found' }
	// 422 with Mastodon's validation message (Api::ErrorHandling's RecordInvalid rescue).
	| { status: 'invalid'; error: string }
	// 422 with REST::Admin::ExistingDomainBlockErrorSerializer of `existing`.
	| { status: 'exists'; existing: InstanceDomainBlock }

const characters = (text: string) => [...text].length

// The validation errors of the fields sent, in the order Mastodon's model declares them (the severity enum, then the
// domain), with Kopje's own after them.
function fieldErrors(request: BlockRequest): string[] {
	const errors: string[] = []
	if (request.severity !== undefined && !SEVERITIES.includes(request.severity)) {
		errors.push('Severity is not included in the list')
	}
	if (request.rejectMedia === true) {
		errors.push('Reject media is not supported')
	}
	for (const [name, value] of [
		['Private comment', request.privateComment],
		['Public comment', request.publicComment],
	] as const) {
		if (typeof value === 'string' && characters(value) > MAX_BLOCK_COMMENT) {
			errors.push(`${name} is too long (maximum is ${MAX_BLOCK_COMMENT} characters)`)
		}
	}
	return errors
}

const invalid = (errors: string[]): DomainBlockResult => ({
	status: 'invalid',
	error: `Validation failed: ${errors.join(', ')}`,
})

export const listAdminDomainBlocks = adminReadOperation<{ page: PageQuery }, InstanceDomainBlock[]>(
	ADMIN_PERMISSION.manageFederation,
	(db, { page }) => blocksPage(db, page)
)

export const getAdminDomainBlock = adminReadOperation<{ id: string }, DomainBlockResult>(
	ADMIN_PERMISSION.manageFederation,
	(db, { id }) => found(db, id)
)

// An id as Mastodon's find reads it: digits only, else no record.
function blockId(id: string): number | null {
	return /^\d{1,15}$/.test(id) ? Number(id) : null
}

function found(db: Db, id: string): DomainBlockResult {
	const key = blockId(id)
	const block = key === null ? null : blockById(db, key)
	return block === null ? { status: 'not_found' } : { status: 'ok', block }
}

// POST /api/v1/admin/domain_blocks. As Mastodon's create, a conflicting block is answered first
// (domain_blocks_controller.rb:31-33), then the validations (save!).
export const createAdminDomainBlock = adminWriteOperation<BlockRequest & { domain?: string }, DomainBlockResult>(
	ADMIN_PERMISSION.manageFederation,
	(db, request, admin) => {
		const raw = request.domain?.trim() ?? ''
		const named = raw === '' ? null : blockDomainOf(raw)
		// Mastodon's default severity is silence (domain_block.rb:11).
		const severity = request.severity ?? 'silence'
		// A conflict is answered before the validations (domain_blocks_controller.rb:31-33), for a domain within the
		// bounds.
		if (named?.ok === true) {
			const existing = conflictingBlock(db, named.domain, {
				severity,
				rejectMedia: request.rejectMedia ?? false,
				rejectReports: request.rejectReports ?? false,
			})
			if (existing !== undefined) {
				return { status: 'exists', existing }
			}
		}
		const errors = fieldErrors({ ...request, severity })
		// The domain's errors follow the severity's (domain_block.rb:24-26); Kopje's own follow Mastodon's.
		const domainError =
			named === null
				? "Domain can't be blank"
				: named.ok
					? null
					: named.error === 'invalid-domain'
						? 'Domain is invalid'
						: `Domain has more than ${MAX_BLOCK_LABELS} labels`
		if (domainError !== null) {
			errors.splice(errors[0] === 'Severity is not included in the list' ? 1 : 0, 0, domainError)
		}
		if (errors.length > 0 || named?.ok !== true) {
			return invalid(errors)
		}
		const { domain } = named
		const created = createBlock(db, {
			domain,
			severity: severity as Severity,
			rejectMedia: false,
			rejectReports: request.rejectReports ?? false,
			obfuscate: request.obfuscate ?? false,
			privateComment: request.privateComment ?? null,
			publicComment: request.publicComment ?? null,
			now: admin.now,
		})
		if (!created.ok) {
			// Both refusals were answered above; a create only reaches here with an existing block.
			return created.error === 'exists'
				? { status: 'exists', existing: created.existing }
				: invalid(['Domain is invalid'])
		}
		logAction(
			db,
			admin,
			'create',
			{ type: 'DomainBlock', id: String(created.block.id) },
			{ domain, severity },
			admin.now
		)
		return { status: 'ok', block: created.block }
	}
)

// PUT and PATCH /api/v1/admin/domain_blocks/:id: the fields sent change, the domain stays (domain_block_params).
// Mastodon checks no conflict on update.
export const updateAdminDomainBlock = adminWriteOperation<BlockRequest & { id: string }, DomainBlockResult>(
	ADMIN_PERMISSION.manageFederation,
	(db, request, admin) => {
		const current = found(db, request.id)
		if (current.status !== 'ok') {
			return current
		}
		const errors = fieldErrors(request)
		if (errors.length > 0) {
			return invalid(errors)
		}
		const block = updateBlock(db, {
			id: current.block.id,
			severity: request.severity as Severity | undefined,
			rejectMedia: request.rejectMedia,
			rejectReports: request.rejectReports,
			obfuscate: request.obfuscate,
			privateComment: request.privateComment,
			publicComment: request.publicComment,
			now: admin.now,
		})!
		logAction(
			db,
			admin,
			'update',
			{ type: 'DomainBlock', id: String(block.id) },
			{ domain: block.domain, severity: block.severity },
			admin.now
		)
		return { status: 'ok', block }
	}
)

// DELETE /api/v1/admin/domain_blocks/:id (Mastodon's UnblockDomainService): the block's rule ends at this commit, and
// the domain job clears its marks in rounds (instance-domain-blocks.ts).
export const deleteAdminDomainBlock = adminWriteOperation<{ id: string }, DomainBlockResult>(
	ADMIN_PERMISSION.manageFederation,
	(db, { id }, admin) => {
		const key = blockId(id)
		const block = key === null ? null : deleteBlock(db, key)
		if (block === null) {
			return { status: 'not_found' }
		}
		logAction(
			db,
			admin,
			'destroy',
			{ type: 'DomainBlock', id: String(block.id) },
			{ domain: block.domain, severity: block.severity },
			admin.now
		)
		return { status: 'ok', block }
	}
)

// The routes of a permission Kopje grants that read nothing: GET /api/v1/admin/domain_allows (manage_federation; no
// limited federation mode, so no allow), and POST /api/v1/admin/dimensions and /retention (view_dashboard; no
// dimension served, no sign-in records). Each answers `[]` to the OAuth admin.
export const federationGranted = adminReadOperation<object, true>(ADMIN_PERMISSION.manageFederation, () => true)
export const dashboardGranted = adminReadOperation<object, true>(ADMIN_PERMISSION.viewDashboard, () => true)
