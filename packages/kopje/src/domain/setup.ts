import { authorize, type UserCredential } from './auth'
import { allocateLocalId } from './ids'
import { chargeInstanceTransforms } from './media'
import { webClientId } from './oauth'
import { readOperation, writeOperation } from './operation'
import { accountSearchText } from './search-text'
import type { Db } from '../db/sql'
import { ACCESS_SETTINGS, CONFIG_KEYS } from '../platform/access-settings'

// /setup fixes the instance domain first, so its presence marks a set-up instance.
export const getSetupState = readOperation<void, { complete: boolean }>((db) => ({
	complete: db.first("SELECT 1 AS found FROM instance_settings WHERE name = 'domain'") !== undefined,
}))

// The /setup wizard's state (B5b). Authorization runs here, in the transaction of each operation:
//
//   - Before bootstrap, a setup session authorizes: the Worker opens one after comparing SETUP_TOKEN as a fixed-size
//     digest (AUTH-5), and the browser holds only an opaque id whose SHA-256 names it. Sessions live in kopje_state
//     (outside the dumped tables) for SETUP_SESSION_MS and hold the wizard's draft: the confirmed domain and the Access
//     applications made for it. Nothing of the draft is configuration until the bootstrap.
//   - SETUP-3: bootstrapInstance writes the domain, the Access configuration and the first admin in one transaction
//     that fails once any configuration row or any local account exists, and ends every setup session.
//   - SETUP-2: after that, no setup session authorizes anything (none can be opened, and those left are refused): only
//     the admin, signed in to the web UI (a web session of the account whose email is admin_email), may see the status,
//     run the checks and reconcile the Access configuration. Nobody changes the domain or the admin here.
//   - SETUP-4: the Cloudflare API token never reaches the Store; only what the API returned (team, AUD tags) does.

export const SETUP_SESSION_MS = 60 * 60 * 1000

const SESSION = 'setup_session:'
// Setup sessions kept at once; the oldest goes first. Only holders of SETUP_TOKEN open them.
const MAX_SESSIONS = 8
const PROBE = 'setup_probe'
const CRON = 'cron_last_run'

export type AccessDraft = {
	teamDomain: string
	accountId: string
	signInAud: string
	adminAud: string
	adminEmail: string
	serviceTokenClientId: string | null
}

export type SetupDraft = { domain: string | null; access: AccessDraft | null }

type SessionRecord = SetupDraft & { expiresAt: number }

export type SetupAuthority = { kind: 'setup'; sessionHash: string } | { kind: 'admin'; credential: UserCredential }

export type Probe = { id: string; sentAt: number; consumedAt: number | null }

export type InstanceConfig = {
	domain: string | null
	teamDomain: string | null
	adminEmail: string | null
	adminUsername: string | null
	serviceTokenClientId: string | null
}

function readState<T>(db: Db, name: string): T | null {
	const row = db.first<{ value: string }>('SELECT value FROM kopje_state WHERE name = ?', name)
	return row === undefined ? null : (JSON.parse(row.value) as T)
}

function writeState(db: Db, name: string, value: unknown): void {
	db.run('INSERT OR REPLACE INTO kopje_state (name, value) VALUES (?, ?)', name, JSON.stringify(value))
}

function setting(db: Db, name: string): string | null {
	return db.first<{ value: string }>('SELECT value FROM instance_settings WHERE name = ?', name)?.value ?? null
}

// SETUP-3: bootstrapped once any configuration row or any local account exists, however it got there (the wizard, or
// /admin/config and an import at a cutover).
export function bootstrapped(db: Db): boolean {
	return (
		db.first(
			`SELECT 1 AS found FROM instance_settings WHERE name IN (${CONFIG_KEYS.map(() => '?').join(',')})`,
			...CONFIG_KEYS
		) !== undefined || db.first('SELECT 1 AS found FROM local_accounts') !== undefined
	)
}

function liveSession(db: Db, sessionHash: string, now: number): SessionRecord | null {
	const record = readState<SessionRecord>(db, `${SESSION}${sessionHash}`)
	return record !== null && record.expiresAt > now ? record : null
}

function deleteSessions(db: Db, where: string, ...params: SqlStorageValue[]): void {
	db.run(`DELETE FROM kopje_state WHERE substr(name, 1, ${SESSION.length}) = '${SESSION}' ${where}`, ...params)
}

// The admin behind a web session: a live token of the web client whose account's email is admin_email.
function adminAccount(db: Db, credential: UserCredential): { username: string } | null {
	const auth = authorize(db, credential)
	if (auth.status !== 'ok' || auth.viewer.accountId === null || auth.viewer.client.id !== webClientId(db)) {
		return null
	}
	const adminEmail = setting(db, ACCESS_SETTINGS.adminEmail)
	const row = db.first<{ email: string; username: string }>(
		'SELECT l.email, a.username FROM local_accounts l JOIN accounts a ON a.id = l.account_id WHERE l.account_id = ?',
		auth.viewer.accountId
	)
	return adminEmail !== null && row !== undefined && row.email.toLowerCase() === adminEmail.trim().toLowerCase()
		? { username: row.username }
		: null
}

// Whether the authority may act now: a live setup session before bootstrap, the admin after it (SETUP-2).
function permitted(db: Db, authority: SetupAuthority, now: number): boolean {
	if (authority.kind === 'setup') {
		return !bootstrapped(db) && liveSession(db, authority.sessionHash, now) !== null
	}
	return bootstrapped(db) && adminAccount(db, authority.credential) !== null
}

function instanceConfig(db: Db): InstanceConfig {
	const adminEmail = setting(db, ACCESS_SETTINGS.adminEmail)
	const admin =
		adminEmail === null
			? undefined
			: db.first<{ username: string }>(
					'SELECT a.username FROM local_accounts l JOIN accounts a ON a.id = l.account_id WHERE lower(l.email) = lower(?)',
					adminEmail.trim()
				)
	return {
		domain: setting(db, 'domain'),
		teamDomain: setting(db, ACCESS_SETTINGS.teamDomain),
		adminEmail,
		adminUsername: admin?.username ?? null,
		serviceTokenClientId: setting(db, ACCESS_SETTINGS.serviceTokenClientId),
	}
}

export type SetupView = {
	bootstrapped: boolean
	// Whether the authority given may use the wizard now (see permitted).
	authorized: boolean
	// The setup session's draft, before bootstrap.
	draft: SetupDraft | null
	// The configuration, for the admin after bootstrap.
	config: InstanceConfig | null
	probe: Probe | null
	cronLastRun: number | null
}

export const setupView = readOperation<{ authority: SetupAuthority | null; now: number }, SetupView>(
	(db, { authority, now }) => {
		const done = bootstrapped(db)
		const authorized = authority !== null && permitted(db, authority, now)
		if (!authorized) {
			return { bootstrapped: done, authorized, draft: null, config: null, probe: null, cronLastRun: null }
		}
		const session = authority.kind === 'setup' ? liveSession(db, authority.sessionHash, now) : null
		return {
			bootstrapped: done,
			authorized,
			draft: session === null ? null : { domain: session.domain, access: session.access },
			config: done ? instanceConfig(db) : null,
			probe: readState<Probe>(db, PROBE),
			cronLastRun: readState<number>(db, CRON),
		}
	}
)

// Opens a setup session after the Worker has checked SETUP_TOKEN. Refused once bootstrapped (SETUP-2).
export const beginSetupSession = writeOperation<{ sessionHash: string; now: number }, 'ok' | 'complete'>(
	(db, { sessionHash, now }) => {
		if (bootstrapped(db)) {
			return 'complete'
		}
		deleteSessions(db, "AND json_extract(value, '$.expiresAt') <= ?", now)
		const kept = db.all<{ name: string }>(
			`SELECT name FROM kopje_state WHERE substr(name, 1, ${SESSION.length}) = '${SESSION}'
			ORDER BY json_extract(value, '$.expiresAt') DESC`
		)
		for (const { name } of kept.slice(MAX_SESSIONS - 1)) {
			db.run('DELETE FROM kopje_state WHERE name = ?', name)
		}
		writeState(db, `${SESSION}${sessionHash}`, {
			domain: null,
			access: null,
			expiresAt: now + SETUP_SESSION_MS,
		} satisfies SessionRecord)
		return 'ok'
	}
)

export const endSetupSession = writeOperation<{ sessionHash: string }, void>((db, { sessionHash }) => {
	db.run('DELETE FROM kopje_state WHERE name = ?', `${SESSION}${sessionHash}`)
})

// Step 1: the domain the operator confirmed. Choosing another domain drops the Access draft made for the old one.
export const confirmSetupDomain = writeOperation<{ sessionHash: string; domain: string; now: number }, 'ok' | 'denied'>(
	(db, { sessionHash, domain, now }) => {
		const session = bootstrapped(db) ? null : liveSession(db, sessionHash, now)
		if (session === null) {
			return 'denied'
		}
		const access = session.domain === domain ? session.access : null
		writeState(db, `${SESSION}${sessionHash}`, { ...session, domain, access } satisfies SessionRecord)
		return 'ok'
	}
)

export type SaveAccessResult = 'ok' | 'denied' | 'no_domain' | 'admin_mismatch'

// Step 3's outcome. Before bootstrap it goes into the draft (for the confirmed domain); after it, the admin reconciles
// the Access configuration with it. The domain and admin_email stay as they are: the applications admit that admin.
export const saveSetupAccess = writeOperation<
	{ authority: SetupAuthority; domain: string; access: AccessDraft; now: number },
	SaveAccessResult
>((db, { authority, domain, access, now }) => {
	if (!permitted(db, authority, now)) {
		return 'denied'
	}
	if (authority.kind === 'setup') {
		const session = liveSession(db, authority.sessionHash, now)
		if (session === null || session.domain !== domain) {
			return 'no_domain'
		}
		writeState(db, `${SESSION}${authority.sessionHash}`, { ...session, access } satisfies SessionRecord)
		return 'ok'
	}
	const adminEmail = setting(db, ACCESS_SETTINGS.adminEmail)
	if (setting(db, 'domain') !== domain) {
		return 'no_domain'
	}
	if (adminEmail === null || adminEmail.trim().toLowerCase() !== access.adminEmail.toLowerCase()) {
		return 'admin_mismatch'
	}
	writeAccess(db, access)
	return 'ok'
})

function writeAccess(db: Db, access: AccessDraft): void {
	const rows: [string, string | null][] = [
		[ACCESS_SETTINGS.teamDomain, access.teamDomain],
		['access_aud', access.signInAud],
		[ACCESS_SETTINGS.adminAud, access.adminAud],
		[ACCESS_SETTINGS.serviceTokenClientId, access.serviceTokenClientId],
	]
	for (const [name, value] of rows) {
		if (value === null) {
			db.run('DELETE FROM instance_settings WHERE name = ?', name)
		} else {
			db.run('INSERT OR REPLACE INTO instance_settings (name, value) VALUES (?, ?)', name, value)
		}
	}
}

// Step 5: a probe message is on its way through the Queue; the consumer marks it (consumeSetupProbe).
export const sendSetupProbe = writeOperation<{ authority: SetupAuthority; id: string; now: number }, boolean>(
	(db, { authority, id, now }) => {
		if (!permitted(db, authority, now)) {
			return false
		}
		writeState(db, PROBE, { id, sentAt: now, consumedAt: null } satisfies Probe)
		return true
	}
)

// Only the probe last sent is marked; any other id changes nothing.
export const consumeSetupProbe = writeOperation<{ id: string; now: number }, boolean>((db, { id, now }) => {
	const probe = readState<Probe>(db, PROBE)
	if (probe === null || probe.id !== id || probe.consumedAt !== null) {
		return false
	}
	writeState(db, PROBE, { ...probe, consumedAt: now } satisfies Probe)
	return true
})

// The cron's marker, for step 5.
export const recordCronRun = writeOperation<{ now: number }, void>((db, { now }) => {
	writeState(db, CRON, now)
})

// Step 4 spends one Images transformation, charged to the instance's monthly budget like uploads (RES-6).
export const chargeSetupTransform = writeOperation<
	{ authority: SetupAuthority; limit: number; now: number },
	'ok' | 'denied' | 'budget_exhausted'
>((db, { authority, limit, now }) => {
	if (!permitted(db, authority, now)) {
		return 'denied'
	}
	return chargeInstanceTransforms(db, 1, limit, now) ? 'ok' : 'budget_exhausted'
})

export type BootstrapInput = {
	sessionHash: string
	domain: string
	username: string
	email: string
	key: { privkey: Uint8Array; salt: Uint8Array; pubkey: string }
	now: number
}

export type BootstrapResult = 'ok' | 'complete' | 'denied' | 'incomplete' | 'email_mismatch'

// SETUP-3: step 7. The domain, the Access configuration, admin_email and the admin's local account, in this one
// transaction, which fails once anything of a bootstrap exists. Ends every setup session (SETUP-2).
export const bootstrapInstance = writeOperation<BootstrapInput, BootstrapResult>((db, input) => {
	if (bootstrapped(db)) {
		return 'complete'
	}
	const session = liveSession(db, input.sessionHash, input.now)
	if (session === null) {
		return 'denied'
	}
	if (session.domain !== input.domain || session.access === null) {
		return 'incomplete'
	}
	if (session.access.adminEmail.toLowerCase() !== input.email.toLowerCase()) {
		return 'email_mismatch'
	}
	db.run("INSERT INTO instance_settings (name, value) VALUES ('domain', ?)", input.domain)
	db.run('INSERT INTO instance_settings (name, value) VALUES (?, ?)', ACCESS_SETTINGS.adminEmail, input.email)
	writeAccess(db, session.access)
	const id = allocateLocalId(db, input.now)
	const createdAt = new Date(input.now).toISOString()
	db.run(
		`INSERT INTO accounts (id, uri, username, domain, search_text, created_at)
		VALUES (?, ?, ?, NULL, ?, ?)`,
		id,
		`https://${input.domain}/ap/users/${input.username}`,
		input.username,
		accountSearchText(input.username, null, ''),
		createdAt
	)
	db.run(
		`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey, created_at)
		VALUES (?, ?, ?, ?, ?, ?)`,
		id,
		input.email,
		input.key.privkey.slice().buffer,
		input.key.salt.slice().buffer,
		input.key.pubkey,
		createdAt
	)
	deleteSessions(db, '')
	return 'ok'
})
