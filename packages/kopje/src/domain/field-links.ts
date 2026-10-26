import { availableJoinedSql } from './audience'
import { verifiableLink } from './field-verification'
import { writeOperation } from './operation'
import { USERNAME_LIMIT, usernameSql } from './profile-bounds'
import {
	claimRemoteFieldLinks,
	expireRemoteFieldLinks,
	finishRemoteFieldLinks,
	recordRemoteFieldLink,
	remoteLinksHeld,
} from './remote-field-links'
import { iso } from './statuses'
import type { Db } from '../db/sql'
import {
	boundedLocalFieldsSql,
	FIELD_LINK_MAX_ATTEMPTS,
	FIELD_LINK_VALUE_BYTES,
	fieldLinkValueSql,
	REMOTE_FIELD_LINK_BYTES,
	unverifiedLinksPastBoundSql,
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
// - unverified_links (migration 0076_field_link_checks): the values checked and not verified since the last save, so
//   each value is checked once per save (Mastodon's VerifyAccountLinksWorker runs once per update, retry: false).
// - A candidate is a value of the bounded fields (boundedLocalFieldsSql) that fieldLinkValueSql and verifiableLink
//   accept, not yet verified, nor checked and not verified: at most LOCAL_FIELDS, each at most FIELD_LINK_VALUE_BYTES
//   of printable ASCII.
// - A save (accounts.ts updateCredentials) prunes verified_links in SQL, clears unverified_links, and arms
//   links_due_at when a candidate is left: coalesced with a pending check (Mastodon's lock until_executed), and never
//   before the last claim's hold ends.
// - A claim (claimFieldLinks, one per round) takes the first due account that is not held, bumps the claim token
//   and links_attempts, and holds it for FIELD_LINK_HOLD_MS: at most one claim per account per FIELD_LINK_HOLD_MS,
//   which also spaces the checks of an account (test/field-links.test.ts, "coalesces saves into one claim, at most one
//   per account per hold").
// - The fence: recordFieldLink and finishFieldLinks are writes (refused in the Store's maintenance) that apply only
//   while the claim token, an open claim (links_attempts > 0), the credential epoch and availability (R1) are those of
//   the claim. A suspension clears the due time and attempts in its transaction and bumps the epoch, so a round that
//   was running writes nothing more; its remaining network steps for the claimed account may still run (Mastodon does
//   not fence them either).
// - Each record removes its value from the candidates durably, verified or not: both writers rebuild what they keep of
//   their column in canonical form, limited to the current field values, so the stored bound refuses an append only
//   past LOCAL_FIELDS current values, which a candidate's cannot reach, or for a time without its 24-byte form (a `now`
//   past year 9999). A finish closes the claim and keeps its hold as the cooldown. It schedules a next check while a
//   candidate is left (a value the round could not check: budget, deadline, a policy read; or one a save during the
//   claim added or cleared), so a next check after a claim that could not check every value checks only the values
//   left; a value checked and not verified is not retried until a next save. A round whose claim answers with one
//   value's ceiling and a record's time left before its checks deadline checks at least one value
//   (federation/field-links.ts), so a save's values are all checked within LOCAL_FIELDS such claims, each at least a
//   hold apart. A claim that never finishes (a round that died) is claimed again after its hold, at most
//   FIELD_LINK_MAX_ATTEMPTS times in all, then given up.
// Remote accounts' fields (domain/remote-field-links.ts, migration 0068_remote_field_verification) share the round:
// a claim serves them only when the local walk found no work and did not use up its allowance, and their records and
// finish dispatch on the fence's target. Their expiry runs on every claim.

export const FIELD_LINK_HOLD_MS = 5 * 60 * 1000
// Raw due rows one claim reads at most before it stops (RES-6: no index, local accounts are operator-sized, as the
// unlock acceptance job's walk). Each is claimed, rescheduled to its hold, or disarmed, so every row read makes
// progress.
export const FIELD_LINK_CLAIM_WALK = 64

const DOMAIN = /^[a-z0-9.-]{1,253}$/

// The values of the bounded fields of the local account ?1 that may be verified and are neither verified nor checked
// and not verified, in field order, distinct.
const CANDIDATES = `SELECT v FROM (SELECT f.value ->> '$.value' AS v, f.key AS k
		FROM local_accounts l, json_each(${boundedLocalFieldsSql('l.fields')}) f
		WHERE l.account_id = ?1 AND f.type = 'object' AND json_type(f.value, '$.value') = 'text'
			AND f.value ->> '$.value' NOT IN (SELECT e.value ->> '$[0]' FROM json_each(l.verified_links) e)
			AND f.value ->> '$.value' NOT IN (SELECT e.value FROM json_each(l.unverified_links) e))
	WHERE ${fieldLinkValueSql('v')} AND v GLOB 'https://*'
	GROUP BY v ORDER BY min(k)`

// The account's candidates: at most LOCAL_FIELDS strings of at most FIELD_LINK_VALUE_BYTES printable ASCII.
export function linkCandidates(db: Db, accountId: string): string[] {
	return db
		.all<{ v: string }>(CANDIDATES, accountId)
		.map((row) => row.v)
		.filter(verifiableLink)
}

// The decoded text values of the bounded fields of the row being updated, for IN: what the writers keep of their
// column (in SQL, by bytes).
const CURRENT_VALUES = `SELECT f.value ->> '$.value' FROM json_each(${boundedLocalFieldsSql('local_accounts.fields')}) f
	WHERE f.type = 'object' AND json_type(f.value, '$.value') = 'text'`

// In a save's transaction, after fields are written: keeps the verified values that are still a field's value (in
// SQL, by bytes), clears the values checked and not verified (each is checked again), then arms a check when a
// candidate is left.
export function armFieldLinks(db: Db, accountId: string, now: number): void {
	db.run(
		`UPDATE local_accounts SET verified_links = (SELECT CASE WHEN count(*) = 0 THEN NULL
				ELSE json_group_array(json(e.value)) END
			FROM json_each(verified_links) e
			WHERE e.value ->> '$[0]' IN (${CURRENT_VALUES}))
		WHERE account_id = ? AND verified_links IS NOT NULL`,
		accountId
	)
	db.run(
		'UPDATE local_accounts SET unverified_links = NULL WHERE account_id = ? AND unverified_links IS NOT NULL',
		accountId
	)
	if (linkCandidates(db, accountId).length === 0) {
		return
	}
	db.run(
		`UPDATE local_accounts SET links_due_at = COALESCE(links_due_at, max(?2, COALESCE(links_hold_until, 0)))
		WHERE account_id = ?1`,
		accountId,
		now
	)
}

// A claim of the round (one a call): a local account's (target 'local', fenced by its credential epoch) or a remote
// one's (target 'remote', domain/remote-field-links.ts, fenced by its row's generation). origin: the instance's, for
// the round's User-Agent. givenUp and expired: accounts given up and remote checks expired by the call.
export type FieldLinksClaim =
	| ({
			kind: 'claimed'
			accountId: string
			token: number
			// Local: https://<domain>/@<username>, Mastodon's short_account_url (app/lib/tag_manager.rb:26-27). Remote: the
			// row's link_back (TagManager#url_for).
			linkBack: string
			values: string[]
			origin: string
			givenUp: number
			expired: number
	  } & ({ target: 'local'; epoch: number } | { target: 'remote'; generation: number }))
	| { kind: 'none'; givenUp: number; expired: number }

type Due = { account_id: string; hold: number | null; attempts: number }

type Claimable = { epoch: number | null; next: number; username: string | null; available: number }

// The first due account (links_due_at at or before `now`, then by account id) that is not held, claimed. Each due row
// read before it is rescheduled to its hold (held), disarmed (unavailable, no candidate left, or a claim token, epoch
// or username outside its bound: a username with a raw NUL, outside the format, or that its projection would change;
// only the scheduling columns are written, never the row's own values), or given up (FIELD_LINK_MAX_ATTEMPTS claims
// never finished). At most FIELD_LINK_CLAIM_WALK raw rows are read; the rest wait for a later round.
// Then, only when the local walk found no work and did not use up its allowance (AM7: later local rows may be due),
// the remote walk (remote-field-links.ts claimRemoteFieldLinks). Remote expiry runs first on every call (AM8). A call
// writes at most REMOTE_LINK_EXPIRE_BATCH + FIELD_LINK_CLAIM_WALK + REMOTE_LINK_CLAIM_WALK rows.
export const claimFieldLinks = writeOperation<{ now: number }, FieldLinksClaim>((db, { now }) => {
	let givenUp = 0
	if (!Number.isSafeInteger(now) || now < 0) {
		return { kind: 'none', givenUp, expired: 0 }
	}
	const expired = expireRemoteFieldLinks(db, now)
	const domain = db.first<{ value: SqlStorageValue }>(
		"SELECT value FROM instance_settings WHERE name = 'domain'"
	)?.value
	if (typeof domain !== 'string' || !DOMAIN.test(domain)) {
		return { kind: 'none', givenUp, expired }
	}
	const origin = `https://${domain}`
	const due = db.all<Due>(
		`SELECT account_id, links_hold_until AS hold, links_attempts AS attempts FROM local_accounts
		WHERE links_due_at <= ?1 ORDER BY links_due_at, account_id LIMIT ${FIELD_LINK_CLAIM_WALK}`,
		now
	)
	const disarm = (accountId: string) =>
		db.run('UPDATE local_accounts SET links_due_at = NULL, links_attempts = 0 WHERE account_id = ?', accountId)
	for (const row of due) {
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
					AND instr(CAST(u.username AS BLOB), x'00') = 0 AND u.username NOT GLOB '*[^A-Za-z0-9_.-]*'
					AND CAST(${usernameSql('u.username')} AS BLOB) = CAST(u.username AS BLOB)) AS username,
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
			target: 'local',
			accountId: row.account_id,
			token,
			epoch: state.epoch,
			linkBack: `${origin}/@${state.username}`,
			values,
			origin,
			givenUp,
			expired,
		}
	}
	if (due.length >= FIELD_LINK_CLAIM_WALK) {
		return { kind: 'none', givenUp, expired }
	}
	const remote = claimRemoteFieldLinks(db, now, FIELD_LINK_HOLD_MS)
	givenUp += remote.givenUp
	return remote.claim === null
		? { kind: 'none', givenUp, expired }
		: { kind: 'claimed', target: 'remote', ...remote.claim, origin, givenUp, expired }
})

export type FieldLinksFence = { accountId: string; token: number } & (
	{ target: 'local'; epoch: number } | { target: 'remote'; generation: number }
)

// Whether the claim `fence` names is still the account's open claim, of its epoch (local) or generation (remote), on
// an available account.
function held(db: Db, fence: FieldLinksFence): boolean {
	if (typeof fence.accountId !== 'string' || !Number.isSafeInteger(fence.token)) {
		return false
	}
	if (fence.target === 'remote') {
		return Number.isSafeInteger(fence.generation) && remoteLinksHeld(db, fence)
	}
	if (fence.target !== 'local') {
		return false
	}
	const { accountId, token, epoch } = fence
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

// A value as an input names it: a string within the candidates' bound (a remote href's for a remote claim), else none.
function boundedValue(value: unknown, limit = FIELD_LINK_VALUE_BYTES): string | null {
	return typeof value === 'string' && value.length >= 1 && value.length <= limit ? value : null
}

// What a record writes into its column: the entries whose value is a current field value, rebuilt in canonical form
// (an imported entry may be padded or escaped), in entry order, then the new entry appended.
const VERIFIED_APPENDED = `json_insert((SELECT json_group_array(json_array(e.value ->> '$[0]', e.value ->> '$[1]')
			ORDER BY e.key)
		FROM json_each(local_accounts.verified_links) e WHERE e.value ->> '$[0]' IN (${CURRENT_VALUES})),
	'$[#]', json_array(?2, ?3))`
const UNVERIFIED_APPENDED = `json_insert((SELECT json_group_array(e.value ORDER BY e.key)
		FROM json_each(local_accounts.unverified_links) e WHERE e.value IN (${CURRENT_VALUES})),
	'$[#]', ?2)`

// The outcome of one value's check, under the claim's fence, for a value that is still a candidate: a verified one is
// appended to verified_links with `now` as its time, one checked and not verified to unverified_links, each in SQL
// (VERIFIED_APPENDED, UNVERIFIED_APPENDED) unless the result would pass the column's stored bound (the trigger's
// rule, on the exact value written): then it is dropped, never refused. recorded: whether a verified time was
// written. held: whether the fence holds (false: the round stops).
export const recordFieldLink = writeOperation<
	FieldLinksFence & { value: string; verified: boolean; now: number },
	{ held: boolean; recorded: boolean }
>((db, input) => {
	if (!held(db, input)) {
		return { held: false, recorded: false }
	}
	if (input.target === 'remote') {
		const value = boundedValue(input.value, REMOTE_FIELD_LINK_BYTES)
		const recorded =
			value !== null &&
			Number.isSafeInteger(input.now) &&
			recordRemoteFieldLink(db, input.accountId, value, input.verified === true, input.now, iso(input.now))
		return { held: true, recorded }
	}
	const value = boundedValue(input.value)
	if (typeof input.verified !== 'boolean' || value === null || !linkCandidates(db, input.accountId).includes(value)) {
		return { held: true, recorded: false }
	}
	if (!input.verified) {
		db.run(
			`UPDATE local_accounts SET unverified_links = ${UNVERIFIED_APPENDED}
			WHERE account_id = ?1 AND NOT (${unverifiedLinksPastBoundSql(UNVERIFIED_APPENDED)})`,
			input.accountId,
			value
		)
		return { held: true, recorded: false }
	}
	const changed = db.run(
		`UPDATE local_accounts SET verified_links = ${VERIFIED_APPENDED}
		WHERE account_id = ?1 AND NOT (${verifiedLinksPastBoundSql(VERIFIED_APPENDED)})`,
		input.accountId,
		value,
		iso(input.now)
	)
	return { held: true, recorded: changed > 0 }
})

// Closes the claim under its fence: attempts back to 0, the hold kept as the cooldown, and a next check due (at the
// later of `now` and the hold's end) while a candidate is left, judged from the stored state alone; else none. held:
// whether the fence held (false: nothing was written).
export const finishFieldLinks = writeOperation<FieldLinksFence & { now: number }, { held: boolean; pending: boolean }>(
	(db, input) => {
		if (!held(db, input)) {
			return { held: false, pending: false }
		}
		if (input.target === 'remote') {
			return { held: true, pending: finishRemoteFieldLinks(db, input.accountId, input.now) }
		}
		const pending = linkCandidates(db, input.accountId).length > 0
		db.run(
			`UPDATE local_accounts SET links_attempts = 0,
			links_due_at = CASE WHEN ?2 THEN max(?3, COALESCE(links_hold_until, 0)) END
		WHERE account_id = ?1`,
			input.accountId,
			pending ? 1 : 0,
			input.now
		)
		return { held: true, pending }
	}
)
