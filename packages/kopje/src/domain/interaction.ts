import { type Account, followAccount, presentAccountById, resolveAccountId } from './accounts'
import { availableSql, viewableStatusId } from './audience'
import { contextOf, userWriteOperation } from './auth'
import { type ResolveInput, storeResolved } from './remote-statuses'
import { presentStatus, type Status } from './status-presenter'

// /authorize_interaction (design §8; WEB-4, VIS-4): the remote-interaction page's two writes, each in the transaction
// of the signed-in session that posts it (userWriteOperation authorizes it there, so a session revoked while the
// Worker fetched is refused before anything is stored).
//
//   - resolveInteraction stores what the resolver fetched through search resolution's ingestion (storeResolved) and
//     shows it as an anonymous viewer would see it: the page names what the viewer may act on, never content the
//     instance actor was answered with because of its own access (a followers-only status is stored, and not shown).
//   - webFollow follows through the follow service (followAccount), as the follow API does, and tells its outcomes
//     apart.

export type InteractionTarget =
	{ kind: 'account'; account: Account } | { kind: 'status'; status: Status } | { kind: 'not_found' }

// quotesDue: the status stored has a quote whose verification is due (the Worker asks the Queue for a job round, as
// search resolution does).
export type InteractionResult = { target: InteractionTarget; quotesDue: boolean }

export const resolveInteraction = userWriteOperation<ResolveInput, InteractionResult>((db, input) => {
	const stored = storeResolved(db, input)
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

export type WebFollowInput = { target: string; now: number }

// The follow of /authorize_interaction/follow. followed: the follow is in effect (it may have been already); requested:
// a request was sent now; already_requested: one was pending before; refused: the follow service forbade it (a block
// or a domain block) or the follow limit refused it; not_found: no such account, or it is not available.
export const webFollow = userWriteOperation<WebFollowInput, FollowOutcome>((db, input, { accountId }) => {
	const targetId = resolveAccountId(db, input.target)
	if (targetId === null) {
		return 'not_found'
	}
	const before = db.first<{ state: string }>(
		'SELECT state FROM follows WHERE account_id = ? AND target_account_id = ?',
		accountId,
		targetId
	)
	const result = followAccount(db, { target: targetId, now: input.now }, accountId)
	switch (result.status) {
		case 'not_found':
			return 'not_found'
		case 'forbidden':
		case 'invalid':
		case 'unavailable':
			return 'refused'
		case 'ok':
			if (result.relationship.following) {
				return 'followed'
			}
			if (result.relationship.requested) {
				return before?.state === 'pending' ? 'already_requested' : 'requested'
			}
			return 'refused'
	}
})
