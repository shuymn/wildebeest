import { NEW_GENERATION } from './ids'
import type { Db } from '../db/sql'
import {
	REMOTE_LINK_BACK_BYTES,
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
