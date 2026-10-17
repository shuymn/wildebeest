import {
	type Account,
	type Page,
	type PageQuery,
	type Present,
	relationshipResult,
	type RelationshipResult,
	resolveAccountId,
} from './accounts'
import { endorsementListedSql, endorsementsShownSql } from './audience'
import { optionalUserReadOperation, userReadOperation, userWriteOperation } from './auth'
import { ownedAccountsPage } from './lists'
import type { Db } from '../db/sql'

// Endorsed accounts (Mastodon 4.5's AccountPin, Api::V1::Accounts::EndorsementsController and
// Api::V1::EndorsementsController). A local user endorses accounts it follows (an accepted follow;
// AccountPin#validate_follow_relationship). When that follow ends, whatever ends it, the endorsement goes with it (the
// trigger of migration 0014_account_notes_and_pins, as Follow#remove_endorsements does). Endorsements are public: an
// account's list is shown to anyone (R28). They are not federated: Mastodon 4.5's actor has no endorsements collection.

// GET /api/v1/endorsements with limit=0 answers every endorsement (EndorsementsController#unlimited?). Kopje stops at
// this many, the newest by account id, and at ACCOUNT_ANSWER_BYTES (RES-3).
export const MAX_ENDORSEMENTS_ANSWERED = 1_000

// AccountPin's validation message (accounts.pin_errors.following), as ActiveRecord::RecordInvalid words it.
export const NOT_FOLLOWING = 'You must be already following the person you want to endorse'

export type EndorseResult = RelationshipResult | { status: 'invalid'; errors: string[] }

// POST /api/v1/accounts/:id/endorse (and /pin): AccountPin.find_or_create_by!. An endorsement already made stays; a new
// one needs the viewer's accepted follow of the account, else it is refused with AccountPin's message.
export const endorse = userWriteOperation<{ target: string; now: number }, EndorseResult>(
	(db, { target, now }, { accountId: viewerId }) => {
		const id = resolveAccountId(db, target)
		if (id === null) {
			return { status: 'not_found' }
		}
		const row = db.first<{ endorsed: number; following: number }>(
			`SELECT EXISTS (SELECT 1 FROM account_pins WHERE account_id = ?1 AND target_account_id = ?2) AS endorsed,
				EXISTS (SELECT 1 FROM follows WHERE account_id = ?1 AND target_account_id = ?2 AND state = 'accepted')
					AS following`,
			viewerId,
			id
		)
		if (row?.endorsed !== 1) {
			if (row?.following !== 1) {
				return { status: 'invalid', errors: [NOT_FOLLOWING] }
			}
			db.run(
				'INSERT INTO account_pins (account_id, target_account_id, created_at) VALUES (?, ?, ?)',
				viewerId,
				id,
				new Date(now).toISOString()
			)
		}
		return relationshipResult(db, viewerId, id, now)
	}
)

// POST /api/v1/accounts/:id/unendorse (and /unpin): the endorsement goes, if there is one.
export const unendorse = userWriteOperation<{ target: string; now: number }, RelationshipResult>(
	(db, { target, now }, { accountId: viewerId }) => {
		const id = resolveAccountId(db, target)
		if (id === null) {
			return { status: 'not_found' }
		}
		db.run('DELETE FROM account_pins WHERE account_id = ? AND target_account_id = ?', viewerId, id)
		return relationshipResult(db, viewerId, id, now)
	}
)

// The accounts `owner` endorses that R28 lists, by account id, newest first, paged by the account id
// (paginate_by_max_id, and min_id as Kopje's other account lists page); page null reads up to
// MAX_ENDORSEMENTS_ANSWERED within ACCOUNT_ANSWER_BYTES, below `from` (ownedAccountsPage in lists.ts).
function endorsedPage(
	db: Db,
	owner: string,
	query: { page: PageQuery | null; from?: string; present: Present }
): Page<Account> {
	if (db.first(`SELECT 1 AS shown WHERE ${endorsementsShownSql('?1')}`, owner) === undefined) {
		return { items: [], newest: null, oldest: null }
	}
	return ownedAccountsPage(
		db,
		owner,
		(order) => `SELECT p.target_account_id AS id FROM account_pins p
			WHERE p.account_id = ?1 AND p.target_account_id < ?2 AND p.target_account_id > ?3
			ORDER BY p.target_account_id ${order} LIMIT ?4`,
		endorsementListedSql('a.id'),
		query,
		MAX_ENDORSEMENTS_ANSWERED
	)
}

// GET /api/v1/endorsements: the viewer's own (EndorsementsController).
export const listEndorsements = userReadOperation<
	{ page: PageQuery | null; from?: string; present: Present },
	Page<Account>
>((db, query, { accountId }) => endorsedPage(db, accountId, query))

// GET /api/v1/accounts/:id/endorsements, to anyone (Accounts::EndorsementsController#index). Null when no account has
// the id.
export const accountEndorsements = optionalUserReadOperation<
	{ account: string; page: PageQuery; present: Present },
	Page<Account> | null
>((db, { account, page, present }) => {
	const id = resolveAccountId(db, account)
	return id === null ? null : endorsedPage(db, id, { page, present })
})
