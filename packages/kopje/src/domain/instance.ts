import { readOperation } from './operation'

// What the instance endpoints show, from instance_settings (the only settings store) and cached counters.

export type InstanceRule = { id: string; text: string }

export type InstanceInfo = {
	domain: string | null
	title: string | null
	description: string | null
	contactEmail: string | null
	rules: InstanceRule[]
	userCount: number
	statusCount: number
	domainCount: number
}

const PUBLIC_SETTINGS = ['domain', 'title', 'description', 'contact_email', 'rules'] as const
const SETTINGS_QUERY = `SELECT name, value FROM instance_settings WHERE name IN (${PUBLIC_SETTINGS.map(() => '?').join(', ')})`

export const instanceInfo = readOperation<void, InstanceInfo>((db) => {
	const settings = new Map(
		db.all<{ name: string; value: string }>(SETTINGS_QUERY, ...PUBLIC_SETTINGS).map((row) => [row.name, row.value])
	)
	const counts = db.first<{ users: number; statuses: number | null; domains: number }>(
		`SELECT
			(SELECT COUNT(*) FROM local_accounts WHERE suspended_at IS NULL) AS users,
			(SELECT SUM(statuses_count) FROM accounts WHERE domain IS NULL) AS statuses,
			(SELECT COUNT(DISTINCT domain) FROM accounts WHERE domain IS NOT NULL) AS domains`
	)
	return {
		domain: settings.get('domain') ?? null,
		title: settings.get('title') ?? null,
		description: settings.get('description') ?? null,
		contactEmail: settings.get('contact_email') ?? null,
		rules: parseRules(settings.get('rules')),
		userCount: counts?.users ?? 0,
		statusCount: counts?.statuses ?? 0,
		domainCount: counts?.domains ?? 0,
	}
})

// GET /api/v1/instance/rules: the rules setting alone, one row, whatever the instance holds.
export const instanceRules = readOperation<void, InstanceRule[]>((db) =>
	parseRules(db.first<{ value: string }>("SELECT value FROM instance_settings WHERE name = 'rules'")?.value)
)

// rules is a JSON array of strings or of { id?, text } objects. Anything unreadable shows as no rules.
export function parseRules(value: string | undefined): InstanceRule[] {
	if (value === undefined) {
		return []
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(value)
	} catch {
		return []
	}
	if (!Array.isArray(parsed)) {
		return []
	}
	const rules: InstanceRule[] = []
	for (const [index, rule] of parsed.entries()) {
		const text = typeof rule === 'string' ? rule : (rule as { text?: unknown } | null)?.text
		if (typeof text !== 'string' || text === '') {
			continue
		}
		const id = (rule as { id?: unknown } | null)?.id
		rules.push({ id: typeof id === 'string' || typeof id === 'number' ? String(id) : String(index + 1), text })
	}
	return rules
}

// RES-3, RES-7: GET /api/v1/instance/peers lists at most this many domains.
export const MAX_PEERS = 10_000

// The distinct domains of known remote accounts, in order, as Mastodon's Instance.searchable lists them (Kopje has no
// server-wide domain blocks to leave out). Each domain is found by one seek on the (domain, username) index past the
// previous one, so the work grows with the domains returned, never with the accounts known. The same set the
// instance's domain_count counts; it reveals no more than which servers the instance knows of.
export const instancePeers = readOperation<void, string[]>((db) =>
	db
		.all<{ domain: string }>(
			`WITH RECURSIVE peers(domain) AS (
				SELECT (SELECT MIN(domain) FROM accounts WHERE domain IS NOT NULL)
				UNION ALL
				SELECT (SELECT MIN(domain) FROM accounts WHERE domain > peers.domain) FROM peers WHERE peers.domain IS NOT NULL
				LIMIT ?1
			)
			SELECT domain FROM peers WHERE domain IS NOT NULL`,
			MAX_PEERS
		)
		.map((row) => row.domain)
)
