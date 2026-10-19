import { type Account, accountsOf, admitAccounts, type Present, resolveAccountId } from './accounts'
import { admit, ARRAY_ANSWER_BYTES } from './answer-budget'
import { listedForSql, suggestionCandidateSql, suggestionSourceSql } from './audience'
import { userReadOperation, userWriteOperation } from './auth'

// Follow suggestions (Mastodon 4.5's AccountSuggestions, GET /api/v1/suggestions and /api/v2/suggestions, DELETE
// /api/v1/suggestions/:id; docs/visibility.md, "Suggestions"). Of Mastodon's sources only friends of friends
// (FriendsOfFriendsSource) has data in Kopje: the accounts the viewer's follows follow, ranked by how many of them
// follow each (frequency, highest first), then by follower count (lowest first), then by id (newest first). A
// stored remote follower count is 0 (Kopje does not learn it), so at equal frequency remote accounts come first.
//
// Rule R39: an edge counts when its source is shown to the viewer by R13 (suggestionSourceSql) and its target passes
// suggestionCandidateSql (someone else, discoverable, not followed or requested, not dismissed); the candidates R12
// lists to the viewer (listedForSql) are ranked, and the first SUGGESTIONS_KEPT kept.
//
// Work is bounded (RES-7) by windows of follow ids, fixed whatever the planner's statistics: each a range of
// follows_following (account_id, id) from the id of its last entry, which a scalar lookup of that index finds.
//   - sources: the viewer's SUGGESTION_SOURCES accepted follows with the highest ids; one R13 hides takes a slot and
//     brings nothing;
//   - edges: each source's SUGGESTION_EDGES_PER_SOURCE accepted follows with the highest ids, every one taking a slot,
//     its target whatever it is;
//   - cutoff: the first SUGGESTION_EDGES edges, sources by descending follow id, each source's edges by descending
//     follow id (the order of the two ranges, so no sort holds them);
//   - candidates: the distinct targets of the kept edges that pass suggestionCandidateSql, at most SUGGESTION_EDGES,
//     each judged by R12 before the ranking, so a hidden account takes no place in it.
// The answer is a ranking over that bounded graph, not a prefix of Mastodon's: an edge outside the windows is not
// counted, which can reorder two candidates or bring in one Mastodon ranks lower. No cache: each request ranks
// anew, so offsets are stable only while the follows, blocks, mutes and dismissals stay as they were.

export const SUGGESTION_SOURCES = 1000
export const SUGGESTION_EDGES_PER_SOURCE = 100
export const SUGGESTION_EDGES = 10_000
export const SUGGESTIONS_KEPT = 40

export const SUGGESTIONS_DEFAULT_LIMIT = 40
export const SUGGESTIONS_MAX_LIMIT = 80

// The v2 entity (REST::SuggestionSerializer): friends_of_friends is shown with the legacy source past_interactions.
export type Suggestion = { source: 'past_interactions'; sources: ['friends_of_friends']; account: Account }

export type SuggestionsInput = { version: 1 | 2; offset: number; limit: number; present: Present }

// The id of the `n`th accepted follow of `owner` from the newest (1 the newest), or 0 when it has fewer: the lower end
// of its window in follows_following.
function windowStartSql(owner: string, n: number, alias: string): string {
	return `coalesce((SELECT ${alias}.id FROM follows ${alias} INDEXED BY follows_following
		WHERE ${alias}.account_id = ${owner} AND ${alias}.state = 'accepted'
		ORDER BY ${alias}.id DESC LIMIT 1 OFFSET ${n - 1}), 0)`
}

// ?1 the viewer, ?2 the time R12 judges mutes at.
const KEPT_SQL = `WITH
	edges(x) AS (
		SELECT e.target_account_id
		FROM follows f INDEXED BY follows_following
		CROSS JOIN follows e INDEXED BY follows_following
		WHERE f.account_id = ?1 AND f.state = 'accepted' AND f.id >= ${windowStartSql('?1', SUGGESTION_SOURCES, 'fs')}
			AND ${suggestionSourceSql('f.target_account_id', '?1')}
			AND e.account_id = f.target_account_id AND e.state = 'accepted'
			AND e.id >= ${windowStartSql('f.target_account_id', SUGGESTION_EDGES_PER_SOURCE, 'es')}
		ORDER BY f.id DESC, e.id DESC
		LIMIT ${SUGGESTION_EDGES}),
	grouped(x, frequency, followers_count) AS (
		SELECT a.id, count(*), a.followers_count
		FROM edges g CROSS JOIN accounts a ON a.id = g.x
		WHERE ${suggestionCandidateSql('a.id', 'a', '?1')}
		GROUP BY a.id)
SELECT x AS id FROM grouped
WHERE ${listedForSql('grouped.x', '?1', '?2')}
ORDER BY frequency DESC, followers_count ASC, x DESC
LIMIT ${SUGGESTIONS_KEPT}`

// The page `offset`, `limit` of the kept suggestions, within ANSWER_BYTES (RES-3): fewer accounts past it (an offset
// endpoint, docs/response-inventory.md). An offset at or past SUGGESTIONS_KEPT reads nothing.
export const suggestions = userReadOperation<SuggestionsInput, Account[] | Suggestion[]>(
	(db, { version, offset, limit, present }, _viewer, { accountId: viewerId, now }) => {
		if (offset >= SUGGESTIONS_KEPT || limit <= 0) {
			return []
		}
		const ids = db
			.all<{ id: string }>(KEPT_SQL, viewerId, now)
			.slice(offset, offset + limit)
			.map((row) => row.id)
		if (version === 1) {
			return admitAccounts(db, ids, present, ARRAY_ANSWER_BYTES, true).items
		}
		return admit(suggestionsOf(accountsOf(db, ids, present)), ARRAY_ANSWER_BYTES, true).items
	}
)

function* suggestionsOf(accounts: Iterable<Account | undefined>): Generator<Suggestion | undefined> {
	for (const account of accounts) {
		yield account === undefined ? undefined : { source: 'past_interactions', sources: ['friends_of_friends'], account }
	}
}

// DELETE /api/v1/suggestions/:id (AccountSuggestions#remove): the viewer dismisses an account they know by id (a
// legacy id resolves); an unknown id or a repeat stores nothing. Kept until the account's purge.
export const dismissSuggestion = userWriteOperation<{ target: string; now: number }, Record<string, never>>(
	(db, { target, now }, _viewer, { accountId: viewerId }) => {
		const id = resolveAccountId(db, target)
		if (id !== null) {
			db.run(
				`INSERT OR IGNORE INTO follow_recommendation_mutes (account_id, target_account_id, created_at)
				VALUES (?, ?, ?)`,
				viewerId,
				id,
				new Date(now).toISOString()
			)
		}
		return {}
	}
)
