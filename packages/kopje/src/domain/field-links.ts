import { availableJoinedSql } from './audience'
import { verifiableLink } from './field-verification'
import { writeOperation } from './operation'
import { USERNAME_LIMIT, usernameSql } from './profile-bounds'
import { iso } from './statuses'
import type { Db } from '../db/sql'
import {
	boundedLocalFieldsSql,
	FIELD_LINK_MAX_ATTEMPTS,
	FIELD_LINK_VALUE_BYTES,
	fieldLinkValueSql,
	VERIFIED_LINKS,
	verifiedLinksPastBoundSql,
} from '../platform/stored-bounds'

// Account fields[].verified_at of local accounts (Mastodon's VerifyAccountLinksWorker and VerifyLinkService,
// app/workers/verify_account_links_worker.rb, app/services/verify_link_service.rb, v4.5.11): the Store's part. The
// Worker's part, a round that fetches the links, is federation/field-links.ts. State lives on local_accounts
// (migration 0066_field_verification):
//
// - verified_links: the values verified, with their times, keyed by value, so a save that keeps a value (its name or
//   position changed) keeps its time and one that changes it drops it (Mastodon's Account#fields= carry-over,
//   app/models/account.rb:327-329). fields is never rewritten by the verification.
// - A candidate is a value of the bounded fields (boundedLocalFieldsSql) that fieldLinkValueSql and verifiableLink
//   accept, not yet verified: at most LOCAL_FIELDS, each at most FIELD_LINK_VALUE_BYTES of printable ASCII.
// - A save (accounts.ts updateCredentials) prunes verified_links in SQL and arms links_due_at when a candidate is left:
//   coalesced with a pending check (Mastodon's lock until_executed), and never before the last claim's hold ends.
// - A claim (claimFieldLinks, one per round) takes the first due account that is not held, bumps the claim token
//   and links_attempts, and holds it for FIELD_LINK_HOLD_MS: at most one claim per account per FIELD_LINK_HOLD_MS,
//   which also spaces the checks of an account (test/field-links.test.ts, "coalesces saves into one claim, at most one
//   per account per hold").
// - The fence: recordFieldLink and finishFieldLinks are writes (refused in the Store's maintenance) that apply only
//   while the claim token, an open claim (links_attempts > 0), the credential epoch and availability (R1) are those of
//   the claim. A suspension clears the due time and attempts in its transaction and bumps the epoch, so a round that
//   was running writes nothing more; its remaining network steps for the claimed account may still run (Mastodon does
//   not fence them either).
// - A finish closes the claim and keeps its hold as the cooldown. It schedules a next check only for values a save
//   added during the claim and values the round could not check (budget, deadline); a value checked and not verified
//   is not retried until a next save. A claim that never finishes (a round that died) is claimed again after its hold,
//   at most FIELD_LINK_MAX_ATTEMPTS times in all, then given up.

export const FIELD_LINK_HOLD_MS = 5 * 60 * 1000
// Raw due rows one claim reads at most before it stops (RES-6: no index, local accounts are operator-sized, as the
// unlock acceptance job's walk). Each is claimed, rescheduled to its hold, or disarmed, so every row read makes
// progress.
export const FIELD_LINK_CLAIM_WALK = 64

const DOMAIN = /^[a-z0-9.-]{1,253}$/

// The values of the bounded fields of the local account ?1 that may be verified and are not yet, in field order,
// distinct.
const CANDIDATES = `SELECT v FROM (SELECT f.value ->> '$.value' AS v, f.key AS k
		FROM local_accounts l, json_each(${boundedLocalFieldsSql('l.fields')}) f
		WHERE l.account_id = ?1 AND f.type = 'object' AND json_type(f.value, '$.value') = 'text'
			AND f.value ->> '$.value' NOT IN (SELECT e.value ->> '$[0]' FROM json_each(l.verified_links) e))
	WHERE ${fieldLinkValueSql('v')} AND v GLOB 'https://*'
	GROUP BY v ORDER BY min(k)`

// The account's candidates: at most LOCAL_FIELDS strings of at most FIELD_LINK_VALUE_BYTES printable ASCII.
export function linkCandidates(db: Db, accountId: string): string[] {
	return db
		.all<{ v: string }>(CANDIDATES, accountId)
		.map((row) => row.v)
		.filter(verifiableLink)
}

// In a save's transaction, after fields are written: keeps the verified values that are still a field's value (in
// SQL, by bytes), then arms a check when a candidate is left. Returns whether one is due or pending.
export function armFieldLinks(db: Db, accountId: string, now: number): boolean {
	db.run(
		`UPDATE local_accounts SET verified_links = (SELECT CASE WHEN count(*) = 0 THEN NULL
				ELSE json_group_array(json(e.value)) END
			FROM json_each(verified_links) e
			WHERE e.value ->> '$[0]' IN (SELECT f.value ->> '$.value' FROM json_each(${boundedLocalFieldsSql('fields')}) f
				WHERE f.type = 'object' AND json_type(f.value, '$.value') = 'text'))
		WHERE account_id = ? AND verified_links IS NOT NULL`,
		accountId
	)
	if (linkCandidates(db, accountId).length === 0) {
		return false
	}
	db.run(
		`UPDATE local_accounts SET links_due_at = COALESCE(links_due_at, max(?2, COALESCE(links_hold_until, 0)))
		WHERE account_id = ?1`,
		accountId,
		now
	)
	return true
}

export type FieldLinksClaim =
	| {
			kind: 'claimed'
			accountId: string
			token: number
			epoch: number
			// https://<domain>/@<username>: Mastodon's short_account_url (app/lib/tag_manager.rb:26-27).
			linkBack: string
			values: string[]
			givenUp: number
			more: boolean
	  }
	| { kind: 'none'; givenUp: number; more: boolean }

type Due = { account_id: string; hold: number | null; attempts: number }

type Claimable = { epoch: number | null; next: number; username: string | null; available: number }

// The first due account (links_due_at at or before `now`, then by account id) that is not held, claimed. Each due row
// read before it is rescheduled to its hold (held), disarmed (unavailable, no candidate left, or a claim token, epoch
// or username outside its bound: the row's own values are never rewritten), or given up (FIELD_LINK_MAX_ATTEMPTS
// claims never finished). At most FIELD_LINK_CLAIM_WALK rows are read; `more` when another due row is left.
export const claimFieldLinks = writeOperation<{ now: number }, FieldLinksClaim>((db, { now }) => {
	let givenUp = 0
	const domain = db.first<{ value: SqlStorageValue }>(
		"SELECT value FROM instance_settings WHERE name = 'domain'"
	)?.value
	if (typeof domain !== 'string' || !DOMAIN.test(domain)) {
		return { kind: 'none', givenUp, more: false }
	}
	const due = db.all<Due>(
		`SELECT account_id, links_hold_until AS hold, links_attempts AS attempts FROM local_accounts
		WHERE links_due_at <= ?1 ORDER BY links_due_at, account_id LIMIT ${FIELD_LINK_CLAIM_WALK + 1}`,
		now
	)
	const disarm = (accountId: string) =>
		db.run('UPDATE local_accounts SET links_due_at = NULL, links_attempts = 0 WHERE account_id = ?', accountId)
	const left = (read: number) =>
		due.length > read ||
		db.first('SELECT 1 AS d FROM local_accounts WHERE links_due_at <= ? LIMIT 1', now) !== undefined
	for (const [i, row] of due.slice(0, FIELD_LINK_CLAIM_WALK).entries()) {
		if (row.hold !== null && row.hold > now) {
			db.run('UPDATE local_accounts SET links_due_at = links_hold_until WHERE account_id = ?', row.account_id)
			continue
		}
		const state = db.first<Claimable>(
			`SELECT CASE WHEN typeof(l.credential_epoch) = 'integer' AND l.credential_epoch BETWEEN 0 AND 9007199254740991
					THEN l.credential_epoch END AS epoch,
				l.links_claim + 1 AS next,
				(SELECT ${usernameSql('u.username')} FROM accounts u WHERE u.id = l.account_id AND typeof(u.username) = 'text'
					AND length(CAST(u.username AS BLOB)) BETWEEN 1 AND ${USERNAME_LIMIT}
					AND u.username NOT GLOB '*[^A-Za-z0-9_.-]*') AS username,
				${availableJoinedSql('a', 'l')} AS available
			FROM local_accounts l JOIN accounts a ON a.id = l.account_id WHERE l.account_id = ?`,
			row.account_id
		)
		const values = state === undefined ? [] : linkCandidates(db, row.account_id)
		if (
			state === undefined ||
			state.epoch === null ||
			state.username === null ||
			state.next > Number.MAX_SAFE_INTEGER ||
			state.available === 0 ||
			values.length === 0
		) {
			disarm(row.account_id)
			continue
		}
		if (row.attempts >= FIELD_LINK_MAX_ATTEMPTS) {
			givenUp++
			disarm(row.account_id)
			continue
		}
		const token = db.first<{ token: number }>(
			`UPDATE local_accounts SET links_claim = links_claim + 1, links_attempts = links_attempts + 1,
				links_hold_until = ?2, links_due_at = ?2
			WHERE account_id = ?1 RETURNING links_claim AS token`,
			row.account_id,
			now + FIELD_LINK_HOLD_MS
		)!.token
		return {
			kind: 'claimed',
			accountId: row.account_id,
			token,
			epoch: state.epoch,
			linkBack: `https://${domain}/@${state.username}`,
			values,
			givenUp,
			more: left(i + 1),
		}
	}
	return { kind: 'none', givenUp, more: left(FIELD_LINK_CLAIM_WALK) }
})

export type FieldLinksFence = { accountId: string; token: number; epoch: number }

// Whether the claim `fence` names is still the account's open claim, of its epoch, on an available account.
function held(db: Db, { accountId, token, epoch }: FieldLinksFence): boolean {
	return (
		db.first(
			`SELECT 1 AS held FROM local_accounts l JOIN accounts a ON a.id = l.account_id
			WHERE l.account_id = ?1 AND l.links_claim = ?2 AND l.links_attempts > 0 AND l.credential_epoch = ?3
				AND ${availableJoinedSql('a', 'l')}`,
			accountId,
			token,
			epoch
		) !== undefined
	)
}

// A value as an input names it: a string within the candidates' bound, else none.
function boundedValue(value: unknown): string | null {
	return typeof value === 'string' && value.length >= 1 && value.length <= FIELD_LINK_VALUE_BYTES ? value : null
}

function boundedValues(values: unknown): string[] {
	return Array.isArray(values) ? values.slice(0, VERIFIED_LINKS).flatMap((value) => boundedValue(value) ?? []) : []
}

// The outcome of one value's check, under the claim's fence. A verified value that is still a candidate is appended
// with `now` as its time, in SQL, unless the result would pass the stored bound (verifiedLinksPastBoundSql, the
// trigger's rule): then it is dropped, never refused. held: whether the fence holds (false: the round stops).
export const recordFieldLink = writeOperation<
	FieldLinksFence & { value: string; verified: boolean; now: number },
	{ held: boolean; recorded: boolean }
>((db, input) => {
	if (!held(db, input)) {
		return { held: false, recorded: false }
	}
	const value = boundedValue(input.value)
	if (!input.verified || value === null || !linkCandidates(db, input.accountId).includes(value)) {
		return { held: true, recorded: false }
	}
	const appended = "json_insert(COALESCE(verified_links, '[]'), '$[#]', json_array(?2, ?3))"
	const changed = db.run(
		`UPDATE local_accounts SET verified_links = ${appended}
		WHERE account_id = ?1 AND NOT (${verifiedLinksPastBoundSql(appended)})`,
		input.accountId,
		value,
		iso(input.now)
	)
	return { held: true, recorded: changed > 0 }
})

// Closes the claim under its fence: attempts back to 0, the hold kept as the cooldown, and a next check due (at the
// later of `now` and the hold's end) only when a candidate is outside `claimed` (a save added it during the claim) or
// in `unchecked`; else none. held: whether the fence held (false: nothing was written).
export const finishFieldLinks = writeOperation<
	FieldLinksFence & { claimed: string[]; unchecked: string[]; now: number },
	{ held: boolean; pending: boolean }
>((db, input) => {
	if (!held(db, input)) {
		return { held: false, pending: false }
	}
	const claimed = boundedValues(input.claimed)
	const unchecked = boundedValues(input.unchecked)
	const pending = linkCandidates(db, input.accountId).some(
		(value) => !claimed.includes(value) || unchecked.includes(value)
	)
	db.run(
		`UPDATE local_accounts SET links_attempts = 0,
			links_due_at = CASE WHEN ?2 THEN max(?3, COALESCE(links_hold_until, 0)) END
		WHERE account_id = ?1`,
		input.accountId,
		pending ? 1 : 0,
		input.now
	)
	return { held: true, pending }
})
