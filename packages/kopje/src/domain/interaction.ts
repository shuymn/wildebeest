import { type Account, accountByAddress, followAccount, presentAccountById, resolveAccountId } from './accounts'
import { instanceDomainOf } from './actors'
import { availableSql, viewableStatusId } from './audience'
import { contextOf, userWriteOperation } from './auth'
import { type ResolveInput, type StoredResolution, storeResolved } from './remote-statuses'
import { presentStatus, type Status } from './status-presenter'
import { localUsername } from './web-pages/site'
import { statusTarget, targetStatus } from './web-pages/status'
import type { Db } from '../db/sql'
import { parseAddress } from '../platform/domain-name'
import { httpUrl } from '../platform/http-url'

// /authorize_interaction (design §8; WEB-4, VIS-4): the remote-interaction page's two writes, each in the transaction
// of the signed-in session that posts it (userWriteOperation authorizes it there, so a session revoked while the
// Worker fetched is refused before anything is stored).
//
//   - resolveInteraction stores what the resolver fetched through search resolution's ingestion (storeResolved) and
//     shows it as an anonymous viewer would see it: the page names what the viewer may act on, never content the
//     instance actor was answered with because of its own access (a followers-only status is stored, and not shown).
//     The resolver fetches nothing for this instance's own addresses and URLs, and storeResolved finds a stored object
//     by its exact uri only; so an address on this domain, a profile URL (/@user) and a status permalink
//     (/@user/:id, the embed's forms) are mapped to the stored identities here (localTarget). Search keeps its rule.
//   - webFollow follows through the follow service (followAccount), as the follow API does, and tells its outcomes
//     apart.

export type InteractionTarget =
	{ kind: 'account'; account: Account } | { kind: 'status'; status: Status } | { kind: 'not_found' }

// quotesDue: the status stored has a quote whose verification is due (the Worker asks the Queue for a job round, as
// search resolution does).
export type InteractionResult = { target: InteractionTarget; quotesDue: boolean }

// A target on this instance: a local account by its address or profile URL, or a local status by its permalink if an
// anonymous viewer may see it (pageStatus, VIS-4's read of the status page); none for anything else.
function localTarget(db: Db, query: string, present: ResolveInput['present']): StoredResolution {
	const none: StoredResolution = { kind: 'none' }
	const domain = instanceDomainOf(db)
	if (domain === null) {
		return none
	}
	const account = (username: string | null): StoredResolution =>
		username === null || username === ''
			? none
			: { kind: 'account', id: accountByAddress(db, username, null, present)?.id }
	const address = parseAddress(query)
	if (address !== null) {
		return address.domain === domain ? account(address.username) : none
	}
	const url = httpUrl(query)
	if (url === null || url.host !== domain) {
		return none
	}
	const status = statusTarget(query, domain)
	if (status !== null) {
		const row = targetStatus(db, status)
		return row === undefined ? none : { kind: 'status', id: row.id, quotesDue: false }
	}
	const profile = /^\/(@[^/]+)\/?$/.exec(url.pathname)
	if (profile === null) {
		return none
	}
	try {
		return account(localUsername(decodeURIComponent(profile[1] ?? ''), domain))
	} catch {
		return none
	}
}

export const resolveInteraction = userWriteOperation<ResolveInput, InteractionResult>((db, input) => {
	const fetched = storeResolved(db, input)
	const stored =
		fetched.kind === 'none' && input.resolved.kind === 'none' ? localTarget(db, input.query, input.present) : fetched
	const notFound: InteractionResult = { target: { kind: 'not_found' }, quotesDue: false }
	switch (stored.kind) {
		case 'none':
			return notFound
		case 'account': {
			const { id } = stored
			const available = id !== undefined && db.first(`SELECT 1 AS ok WHERE ${availableSql('?1')}`, id) !== undefined
			const account = available ? presentAccountById(db, id, input.present) : undefined
			return account === undefined ? notFound : { target: { kind: 'account', account }, quotesDue: false }
		}
		case 'status': {
			const visible = stored.id === undefined ? null : viewableStatusId(db, null, stored.id)
			const status =
				visible === null ? null : presentStatus(db, visible, { ...input.present, viewer: contextOf(null, input.now) })
			return {
				target: status === null ? { kind: 'not_found' } : { kind: 'status', status },
				quotesDue: stored.quotesDue,
			}
		}
	}
})

export type FollowOutcome = 'followed' | 'requested' | 'already_requested' | 'refused' | 'not_found'

// The outcome, and the account it is about as the Store knows it (null when there is none to name).
export type WebFollowResult = { outcome: FollowOutcome; account: Account | null }

export type WebFollowInput = { target: string; now: number; present: ResolveInput['present'] }

// The follow of /authorize_interaction/follow. followed: the follow is in effect (it may have been already); requested:
// a request was sent now; already_requested: one was pending before; refused: the follow service forbade it (a block
// or a domain block) or the follow limit refused it; not_found: no such account, or it is not available.
export const webFollow = userWriteOperation<WebFollowInput, WebFollowResult>((db, input, { accountId }) => {
	const targetId = resolveAccountId(db, input.target)
	if (targetId === null) {
		return { outcome: 'not_found', account: null }
	}
	const before = db.first<{ state: string }>(
		'SELECT state FROM follows WHERE account_id = ? AND target_account_id = ?',
		accountId,
		targetId
	)
	const result = followAccount(db, { target: targetId, now: input.now }, accountId)
	const named = (outcome: FollowOutcome): WebFollowResult => ({
		outcome,
		account: presentAccountById(db, targetId, input.present) ?? null,
	})
	switch (result.status) {
		case 'not_found':
			return { outcome: 'not_found', account: null }
		case 'forbidden':
		case 'invalid':
		case 'unavailable':
			return named('refused')
		case 'ok':
			if (result.relationship.following) {
				return named('followed')
			}
			if (result.relationship.requested) {
				return named(before?.state === 'pending' ? 'already_requested' : 'requested')
			}
			return named('refused')
	}
})
