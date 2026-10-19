// Numbered remote accounts for the suggestion tests (test/suggestions.test.ts, test/suggestions-bounds.test.ts):
// account i has the id SUGGESTION_BASE + i, the username r<i> and an actor id on its host.

export const SUGGESTION_BASE = 500_000_000_000_000_000n

export const suggestionAccount = (i: number) => String(SUGGESTION_BASE + BigInt(i))

// The integers 0..count - 1 as the CTE n(i), none for 0.
export const numbers = (count: number) =>
	`WITH RECURSIVE n(i) AS (SELECT 0 WHERE ${count} > 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${count} - 1)`

// The insert of accounts from..from + count - 1 on `domain` (actor ids on `host`), discoverable 1, 0 or unset.
export function remoteAccountsSql(
	from: number,
	count: number,
	options: { discoverable?: 0 | 1 | null; domain?: string; host?: string } = {}
): string {
	const domain = options.domain ?? 'remote.example'
	const host = options.host ?? domain
	const discoverable = options.discoverable === undefined ? 1 : (options.discoverable ?? 'NULL')
	return `${numbers(count)} INSERT INTO accounts (id, uri, username, domain, discoverable)
		SELECT CAST(${SUGGESTION_BASE} + ${from} + i AS TEXT), 'https://${host}/users/r' || (${from} + i),
			'r' || (${from} + i), '${domain}', ${discoverable} FROM n`
}
