import { availableSql } from './audience'
import { NEW_GENERATION } from './ids'
import type { Db } from '../db/sql'
import {
	FIELD_LINK_MAX_ATTEMPTS,
	REMOTE_LINK_BACK_BYTES,
	REMOTE_LINK_DUE_INDEX,
	REMOTE_LINK_EXPIRY_INDEX,
	remoteFieldLinksPastBoundSql,
	remoteLinkBackPastBoundSql,
	SAFE_INTEGER_MAX,
} from '../platform/stored-bounds'

// Account fields[].verified_at of remote accounts (Mastodon's VerifyAccountLinksWorker as ProcessAccountService
// schedules it, app/services/activitypub/process_account_service.rb:67-70, 205-207, v4.5.11): the Store's part, the
// only module that writes remote_field_links (migration 0068_remote_field_verification). The Worker's part is the
// field-links round (federation/field-links.ts), shared with local accounts, which it serves after them. A row:
//
// - link_back: the account's url when it is http(s), within REMOTE_LINK_BACK_BYTES and on the actor id's hostname
//   (Mastodon's url_to_href with its host check, :248-258, 269-274), else the actor id (TagManager#url_for).
// - links: the [index, href, verified_at, checked] of the first REMOTE_VERIFIED_SHOWN shown fields whose original value
//   is a link (accounts.ts presentedRemoteFields, field-verification.ts remoteFieldLink), in shown order (AM1).
// - generation: drawn fresh (NEW_GENERATION) when the row is inserted, one more on every change of link_back or of the
//   (index, href) list, so a claim made before a change or a deletion cannot be recorded after it (AM4, AM5).
//
// Every store of a remote actor's document that replaces its raw (inbox.ts upsertRemoteActor; not the frozen and
// covered paths) calls armRemoteFieldLinks in its transaction. Mastodon re-verifies on every processing; Kopje keeps a
// time while the href and the link back stay (docs/mastodon-deviations.md, "Accounts").

// An unverified link checked at least this long ago (checked_at, the last negative check: AM13) is checked again at a
// store (Q3).
export const REMOTE_LINK_RECHECK_MS = 24 * 60 * 60 * 1000

// The link back of a remote account whose actor id is `uri` and stored url `url` (remote-actor.ts: WHATWG-serialized,
// http(s)), as above.
export function remoteLinkBack(uri: string, url: string | null): string {
	if (url === null || url.length > REMOTE_LINK_BACK_BYTES || !/^https?:\/\//.test(url)) {
		return uri
	}
	try {
		return new URL(url).hostname === new URL(uri).hostname ? url : uri
	} catch {
		return uri
	}
}

// The candidates as an input names them: at most REMOTE_VERIFIED_SHOWN [index, href] pairs, else none. The SQL rule
// (remoteFieldLinksPastBoundSql) judges the rest.
function boundedCandidates(links: unknown): [number, string][] {
	if (!Array.isArray(links)) {
		return []
	}
	return links.flatMap((link: unknown): [number, string][] =>
		Array.isArray(link) && Number.isSafeInteger(link[0]) && typeof link[1] === 'string'
			? [[link[0] as number, link[1]]]
			: []
	)
}

// The (index, href) list of a links value `column`, as canonical JSON: what a change is judged on, by bytes.
function pairsSql(column: string): string {
	return `(SELECT json_group_array(json_array(e.value ->> '$[0]', e.value ->> '$[1]') ORDER BY e.key)
		FROM json_each(${column}) e)`
}

// Whether the DO UPDATE below changes the row's link back or its (index, href) list, by bytes.
const changedSql = `(CAST(remote_field_links.link_back AS BLOB) <> CAST(excluded.link_back AS BLOB)
	OR CAST(${pairsSql('remote_field_links.links')} AS BLOB) <> CAST(${pairsSql('excluded.links')} AS BLOB))`

// In the transaction that stores the remote account `accountId`'s document: its row replaced for `links` (at most
// REMOTE_VERIFIED_SHOWN [index, href], accounts.ts presentedRemoteFields) and `linkBack`, in SQL, binding only them.
// Each new entry takes verified_at and checked from one donor, the first stored entry with its href by bytes, while the
// link back is unchanged by bytes; a donor unverified and checked is unchecked again when checked_at is NULL or
// REMOTE_LINK_RECHECK_MS old. A change bumps generation and resets attempts (the claim token kept); an unchecked entry
// arms the row (coalesced with a pending check, never before the last claim's hold ends). No candidate, a replacement
// the stored rule refuses (remoteFieldLinksPastBoundSql, the triggers'), or a generation past SAFE_INTEGER_MAX deletes
// the row, so no index attestation from an older document survives (AM4). At most 2 statements, 1 row written.
export function armRemoteFieldLinks(db: Db, accountId: string, linkBack: string, links: unknown, now: number): void {
	const candidates = boundedCandidates(links)
	const stored =
		candidates.length > 0 &&
		db.run(
			`WITH c AS (SELECT j.key AS k, j.value ->> '$[0]' AS i, j.value ->> '$[1]' AS h FROM json_each(?2) j),
				o AS (SELECT links, checked_at FROM remote_field_links
					WHERE account_id = ?1 AND CAST(link_back AS BLOB) = CAST(?3 AS BLOB)),
				d AS (SELECT c.k, c.i, c.h, (SELECT e.key FROM o, json_each(o.links) e
						WHERE CAST(e.value ->> '$[1]' AS BLOB) = CAST(c.h AS BLOB) ORDER BY e.key LIMIT 1) AS dk
					FROM c),
				v AS (SELECT d.k, d.i, d.h, (SELECT o.links ->> ('$[' || d.dk || '][2]') FROM o) AS vt,
						(SELECT CASE WHEN o.links ->> ('$[' || d.dk || '][2]') IS NOT NULL THEN 1
							WHEN o.checked_at IS NOT NULL AND o.checked_at > ?4 - ${REMOTE_LINK_RECHECK_MS}
							THEN o.links ->> ('$[' || d.dk || '][3]') ELSE 0 END FROM o) AS ck
					FROM d),
				n AS (SELECT json_group_array(json_array(v.i, v.h, v.vt, COALESCE(v.ck, 0)) ORDER BY v.k) AS links,
						max(COALESCE(v.ck, 0) = 0) AS pending
					FROM v)
			INSERT INTO remote_field_links (account_id, link_back, links, generation, due_at, armed_at)
			SELECT ?1, ?3, n.links, ${NEW_GENERATION}, CASE WHEN n.pending THEN ?4 END, CASE WHEN n.pending THEN ?4 END
			FROM n WHERE NOT (${remoteFieldLinksPastBoundSql('n.links')}) AND NOT (${remoteLinkBackPastBoundSql('?3')})
			ON CONFLICT (account_id) DO UPDATE SET
				generation = CASE WHEN ${changedSql} THEN generation + 1 ELSE generation END,
				attempts = CASE WHEN ${changedSql} THEN 0 ELSE attempts END,
				due_at = CASE WHEN excluded.due_at IS NULL THEN due_at
					ELSE COALESCE(due_at, max(excluded.due_at, COALESCE(hold_until, 0))) END,
				armed_at = CASE WHEN excluded.due_at IS NULL THEN armed_at ELSE COALESCE(armed_at, excluded.armed_at) END,
				link_back = excluded.link_back, links = excluded.links
			WHERE NOT (${changedSql}) OR generation + 1 <= ${SAFE_INTEGER_MAX}`,
			accountId,
			JSON.stringify(candidates),
			linkBack,
			now
		) > 0
	if (!stored) {
		db.run('DELETE FROM remote_field_links WHERE account_id = ?', accountId)
	}
}

// ---- The round's operations (called by field-links.ts claimFieldLinks, recordFieldLink and finishFieldLinks)

// A pending check expires this long after it was armed (armed_at), its row disarmed, not deleted: it holds verified
// times. At most REMOTE_LINK_EXPIRE_BATCH rows a call, by the expiry index.
export const REMOTE_LINK_EXPIRE_MS = 24 * 60 * 60 * 1000
export const REMOTE_LINK_EXPIRE_BATCH = 500
// Raw due rows one claim reads at most, by the due index; each makes progress.
export const REMOTE_LINK_CLAIM_WALK = 64

// AM14: an open claim's hold, NULL-safe: the one exception of the batch expiry and the walk's held branch.
const OPEN_HOLD = 'attempts > 0 AND hold_until IS NOT NULL AND hold_until > ?2'

// Expires at most REMOTE_LINK_EXPIRE_BATCH rows armed before `now` - REMOTE_LINK_EXPIRE_MS (AM8: on every claim call,
// before and whatever the local walk finds): at most REMOTE_LINK_EXPIRE_BATCH candidates read by the expiry index
// (oldest armed first), then the open-hold filter (as link-cards.ts claimCards), so a held candidate takes a slot of
// the batch and is kept; a later expired row waits for a call whose batch reaches it, and the walk checks the age of
// every row it reads again. Returns the rows disarmed.
export function expireRemoteFieldLinks(db: Db, now: number): number {
	return db.run(
		`UPDATE remote_field_links SET due_at = NULL, armed_at = NULL, attempts = 0
		WHERE account_id IN (SELECT account_id FROM remote_field_links INDEXED BY ${REMOTE_LINK_EXPIRY_INDEX}
				WHERE due_at IS NOT NULL AND armed_at < ?1 ORDER BY armed_at LIMIT ${REMOTE_LINK_EXPIRE_BATCH})
			AND NOT (${OPEN_HOLD})`,
		now - REMOTE_LINK_EXPIRE_MS,
		now
	)
}

export type RemoteLinksClaim = {
	accountId: string
	token: number
	generation: number
	linkBack: string
	// The distinct hrefs of the unchecked entries, in entry order: at most REMOTE_VERIFIED_SHOWN.
	values: string[]
}

type Walked = {
	id: string | null
	link_back: string | null
	links: string | null
	generation: number | null
	claim: number | null
	attempts: number | null
	hold: number | null
	armed: number | null
	open_hold: number
	available: number
}

// A counter or time column as read: an integer within 0..`max`, else NULL.
function remoteCountSql(column: string, max = SAFE_INTEGER_MAX): string {
	return `CASE WHEN typeof(${column}) = 'integer' AND ${column} BETWEEN 0 AND ${max} THEN ${column} END`
}

// The walk's projections, each NULL past its stored bound (never, under the triggers), and the row's open hold and
// availability (R1, audience.ts availableSql: suspension, deletion and domain coverage, sought by key) read live, of
// the row `r`.
const WALKED = `CASE WHEN typeof(account_id) = 'text' AND length(CAST(account_id AS BLOB)) = 18
		AND account_id NOT GLOB '*[^0-9]*' THEN account_id END AS id,
	CASE WHEN NOT (${remoteLinkBackPastBoundSql('link_back')}) THEN link_back END AS link_back,
	CASE WHEN NOT (${remoteFieldLinksPastBoundSql('links')}) THEN links END AS links,
	${remoteCountSql('generation')} AS generation, ${remoteCountSql('claim')} AS claim,
	${remoteCountSql('attempts', FIELD_LINK_MAX_ATTEMPTS)} AS attempts,
	${remoteCountSql('hold_until')} AS hold,
	${remoteCountSql('armed_at')} AS armed, COALESCE(${OPEN_HOLD}, 0) AS open_hold,
	${availableSql('r.account_id')} AS available`

// The first due row (due_at at or before `now`, then by account id) that may be claimed, claimed; at most
// REMOTE_LINK_CLAIM_WALK raw rows read, each making progress, in order: a row past a projection deleted by its key; an
// open hold (AM14) rescheduled to its end; one armed before the expiry cutoff disarmed; a hold not yet ended (an
// imported cooldown) rescheduled to its end; an unavailable account, no unchecked entry or FIELD_LINK_MAX_ATTEMPTS
// claims never finished (given up) disarmed; a claim token that would pass SAFE_INTEGER_MAX deleted; else claimed for
// FIELD_LINK_HOLD_MS (`hold`: claim + 1, attempts + 1, due_at and hold_until at its end). At most
// REMOTE_LINK_CLAIM_WALK rows written.
export function claimRemoteFieldLinks(
	db: Db,
	now: number,
	hold: number
): { claim: RemoteLinksClaim | null; givenUp: number } {
	let givenUp = 0
	const walk = db.all<Walked>(
		`SELECT ${WALKED} FROM remote_field_links r INDEXED BY ${REMOTE_LINK_DUE_INDEX} WHERE r.due_at <= ?1
		ORDER BY r.due_at, r.account_id LIMIT ${REMOTE_LINK_CLAIM_WALK}`,
		now,
		now
	)
	const disarm = (id: string) =>
		db.run('UPDATE remote_field_links SET due_at = NULL, armed_at = NULL, attempts = 0 WHERE account_id = ?', id)
	for (const row of walk) {
		const { id, link_back: linkBack, links, generation, claim, attempts, armed } = row
		if (id === null || linkBack === null || links === null || generation === null || claim === null) {
			db.run(
				`DELETE FROM remote_field_links WHERE account_id IN (SELECT account_id FROM remote_field_links
					INDEXED BY ${REMOTE_LINK_DUE_INDEX} WHERE due_at <= ?1 ORDER BY due_at, account_id
					LIMIT ${REMOTE_LINK_CLAIM_WALK}) AND (${WALKED_REFUSED})`,
				now
			)
			continue
		}
		if (row.open_hold === 1) {
			db.run('UPDATE remote_field_links SET due_at = hold_until WHERE account_id = ?', id)
			continue
		}
		if (attempts === null || armed === null || armed < now - REMOTE_LINK_EXPIRE_MS) {
			disarm(id)
			continue
		}
		if (row.hold !== null && row.hold > now) {
			db.run('UPDATE remote_field_links SET due_at = hold_until WHERE account_id = ?', id)
			continue
		}
		const values = uncheckedHrefs(db, id)
		if (row.available !== 1 || values.length === 0) {
			disarm(id)
			continue
		}
		if (attempts >= FIELD_LINK_MAX_ATTEMPTS) {
			givenUp++
			disarm(id)
			continue
		}
		if (claim + 1 > SAFE_INTEGER_MAX) {
			db.run('DELETE FROM remote_field_links WHERE account_id = ?', id)
			continue
		}
		const token = db.first<{ token: number }>(
			`UPDATE remote_field_links SET claim = claim + 1, attempts = attempts + 1, hold_until = ?2, due_at = ?2
			WHERE account_id = ?1 RETURNING claim AS token`,
			id,
			now + hold
		)!.token
		return { claim: { accountId: id, token, generation, linkBack, values }, givenUp }
	}
	return { claim: null, givenUp }
}

// A row the walk's projections refuse (the identity, link_back, links, generation or claim): deleted by its key.
const WALKED_REFUSED = `NOT (typeof(account_id) = 'text' AND length(CAST(account_id AS BLOB)) = 18
		AND account_id NOT GLOB '*[^0-9]*')
	OR ${remoteLinkBackPastBoundSql('link_back')} OR ${remoteFieldLinksPastBoundSql('links')}
	OR ${remoteCountSql('generation')} IS NULL OR ${remoteCountSql('claim')} IS NULL`

// The distinct hrefs of the row's unchecked entries, in entry order.
function uncheckedHrefs(db: Db, accountId: string): string[] {
	return db
		.all<{ h: string }>(
			`SELECT e.value ->> '$[1]' AS h FROM remote_field_links r, json_each(r.links) e
			WHERE r.account_id = ?1 AND e.value ->> '$[3]' = 0 GROUP BY CAST(h AS BLOB) ORDER BY min(e.key)`,
			accountId
		)
		.map((row) => row.h)
}

export type RemoteLinksFence = { accountId: string; token: number; generation: number }

// Whether the claim `fence` names is still the row's open claim, of its generation, on an available account.
export function remoteLinksHeld(db: Db, { accountId, token, generation }: RemoteLinksFence): boolean {
	return (
		db.first(
			`SELECT 1 AS held FROM remote_field_links WHERE account_id = ?1 AND claim = ?2 AND attempts > 0
				AND generation = ?3 AND ${availableSql('?1')}`,
			accountId,
			token,
			generation
		) !== undefined
	)
}

// Under a held fence: every unchecked entry whose href is `value` by bytes marked checked, with `now`'s ISO time
// `at` when verified; a negative record also sets checked_at to `now` in the same statement (AM13). Dropped, never
// refused, when the result would pass the stored rule. Returns whether a verified time was written.
export function recordRemoteFieldLink(
	db: Db,
	accountId: string,
	value: string,
	verified: boolean,
	now: number,
	at: string
): boolean {
	const match = `CAST(e.value ->> '$[1]' AS BLOB) = CAST(?2 AS BLOB) AND e.value ->> '$[3]' = 0`
	const next = `(SELECT json_group_array(CASE WHEN ${match}
			THEN json_array(e.value ->> '$[0]', e.value ->> '$[1]', CASE WHEN ?3 THEN ?5 END, 1) ELSE json(e.value) END
			ORDER BY e.key) FROM json_each(remote_field_links.links) e)`
	const changed = db.run(
		`UPDATE remote_field_links SET links = ${next}, checked_at = CASE WHEN ?3 THEN checked_at ELSE ?4 END
		WHERE account_id = ?1 AND EXISTS (SELECT 1 FROM json_each(remote_field_links.links) e WHERE ${match})
			AND NOT (${remoteFieldLinksPastBoundSql(next)})`,
		accountId,
		value,
		verified ? 1 : 0,
		now,
		at
	)
	return verified && changed > 0
}

// Under a held fence: the claim closed (attempts 0), the hold kept as the cooldown, and a next check due at the later
// of `now` and the hold's end while an unchecked entry remains (the round's budget or deadline, a policy error, or a
// store during the claim), else disarmed. Returns whether a check is pending.
export function finishRemoteFieldLinks(db: Db, accountId: string, now: number): boolean {
	const pending = uncheckedHrefs(db, accountId).length > 0
	db.run(
		`UPDATE remote_field_links SET attempts = 0,
			due_at = CASE WHEN ?2 THEN max(?3, COALESCE(hold_until, 0)) END,
			armed_at = CASE WHEN ?2 THEN COALESCE(armed_at, ?3) END
		WHERE account_id = ?1`,
		accountId,
		pending ? 1 : 0,
		now
	)
	return pending
}
