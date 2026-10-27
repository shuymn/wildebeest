import { forgetAdminAccountId, oauthAdmin } from './admin-authority'
import { authorize, type UserCredential } from './auth'
import { allocateLocalId } from './ids'
import { countRegistration, recordLogin } from './instance-activity'
import { chargeInstanceTransforms } from './media'
import { webClientId } from './oauth'
import { readOperation, writeOperation } from './operation'
import { accountSearchText } from './search-text'
import type { Db } from '../db/sql'
import { ACCESS_SETTINGS, CONFIG_KEYS } from '../platform/access-settings'
import type { ManagedIds } from '../platform/cloudflare-api'

// /setup fixes the instance domain first, so its presence marks a set-up instance.
export const getSetupState = readOperation<void, { complete: boolean }>((db) => ({
	complete: db.first("SELECT 1 AS found FROM instance_settings WHERE name = 'domain'") !== undefined,
}))

// The /setup wizard's state (B5b). Authorization runs here, in the transaction of each operation:
//
//   - Before bootstrap, a setup session authorizes: the Worker opens one after comparing SETUP_TOKEN as a fixed-size
//     digest (AUTH-5), and the browser holds only an opaque id whose SHA-256 names it. Sessions live in kopje_state
//     (outside the dumped tables) for SETUP_SESSION_MS and hold the wizard's draft: the confirmed domain and the Access
//     outcome it saw complete. Nothing of the draft is configuration until the bootstrap.
//   - Access reconciliations are coordinated here (setup_access). Each one reserves the instance-wide reconciliation,
//     with a lease and the next revision, before its first external write, and renews the lease (recording the ids of
//     the objects it made) before each further write; one that is superseded or no longer authorized stops before its
//     next write. Its outcome is recorded against its revision. A failure, or a lease that ran out without an outcome,
//     leaves the state "needs reconcile" until a later run completes.
//   - SETUP-3: bootstrapInstance writes the domain, the Access configuration and the first admin in one transaction
//     that fails once any configuration row or any local account exists, while a reconciliation is running or
//     unresolved, or when the session's draft is not the latest completed revision. It ends every setup session.
//   - SETUP-2: after that, no setup session authorizes anything (none can be opened or reserve, and those left are
//     refused): only the admin, signed in to the web UI (a web session of the account whose email is admin_email), may
//     see the status, run the checks and reconcile the Access configuration. Nobody changes the domain or the admin here.
//   - SETUP-4: the Cloudflare API token never reaches the Store; only what the API returned (team, AUD tags, ids) does.

export const SETUP_SESSION_MS = 60 * 60 * 1000
// How long a reservation holds without being renewed. Each external write renews it first. The Store's deadline is the
// authority: the Worker dispatches a Cloudflare request only while at least ACCESS_DISPATCH_MARGIN_MS of it is left,
// aborts every request at the deadline, and gives each at most ACCESS_REQUEST_TIMEOUT_MS. A reservation is superseded
// only ACCESS_SUPERSEDE_GRACE_MS after its deadline, longer than both, so whatever was dispatched under the old lease
// has finished or been aborted before a newer run can write (and the clocks may differ by up to the rest).
export const ACCESS_LEASE_MS = 2 * 60 * 1000
export const ACCESS_REQUEST_TIMEOUT_MS = 10_000
export const ACCESS_DISPATCH_MARGIN_MS = 15_000
export const ACCESS_SUPERSEDE_GRACE_MS = 30_000

const SESSION = 'setup_session:'
// Setup sessions kept at once; the oldest goes first. Only holders of SETUP_TOKEN open them.
export const MAX_SETUP_SESSIONS = 8
const ACCESS = 'setup_access'
const PROBE = 'setup_probe'
const IMAGES = 'setup_images'
const CRON = 'cron_last_run'

export type AccessDraft = {
	teamDomain: string
	accountId: string
	signInAud: string
	adminAud: string
	adminEmail: string
	serviceTokenClientId: string | null
}

type Reservation = { revision: number; holder: string; leaseUntil: number; domain: string; adminEmail: string }

type AccessState = {
	revision: number
	reservation: Reservation | null
	completed: { revision: number; access: AccessDraft; at: number } | null
	needsReconcile: boolean
	managed: ManagedIds
	// The last failure reported by a run after a newer one had taken over (it wrote nothing after that, see above).
	lateFailure?: { revision: number; at: number }
}

export type SetupDraft = { domain: string | null; access: AccessDraft | null; accessRevision: number | null }

type SessionRecord = SetupDraft & { expiresAt: number }

export type SetupAuthority = { kind: 'setup'; sessionHash: string } | { kind: 'admin'; credential: UserCredential }

export type Probe = { id: string; sentAt: number; consumedAt: number | null }

// pass: transformed; quota: the account's allowance is used up (9422); budget: the instance's monthly budget is spent,
// nothing was tried; invalid: the output was not the image asked for; failed: the binding failed (code when it gave one).
export type ImagesOutcome = 'pass' | 'quota' | 'budget' | 'invalid' | 'failed'

export type ImagesCheck = { month: string; at: number; outcome: ImagesOutcome; code: number | null }

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

function accessState(db: Db): AccessState {
	return (
		readState<AccessState>(db, ACCESS) ?? {
			revision: 0,
			reservation: null,
			completed: null,
			needsReconcile: false,
			managed: {},
		}
	)
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

function sessionNames(db: Db, order: 'ASC' | 'DESC'): string[] {
	return db
		.all<{ name: string }>(
			`SELECT name FROM kopje_state WHERE substr(name, 1, ?1) = ?2
			ORDER BY json_extract(value, '$.expiresAt') ${order}, name ${order}`,
			SESSION.length,
			SESSION
		)
		.map((row) => row.name)
}

// The admin behind a web session: a live token of the web client of the OAuth admin (adminAccountId, the same
// fail-closed match as the admin API's). It is checked at the operation's own time, not the time the request began.
function adminAccount(db: Db, credential: UserCredential, now: number): { username: string } | null {
	const auth = authorize(db, { ...credential, now })
	if (auth.status !== 'ok' || auth.viewer.accountId === null || auth.viewer.client.id !== webClientId(db)) {
		return null
	}
	const admin = oauthAdmin(db)
	return admin.accountId === auth.viewer.accountId && admin.username !== null ? { username: admin.username } : null
}

// Whether the authority may act now: a live setup session before bootstrap, the admin after it (SETUP-2).
function permitted(db: Db, authority: SetupAuthority, now: number): boolean {
	if (authority.kind === 'setup') {
		return !bootstrapped(db) && liveSession(db, authority.sessionHash, now) !== null
	}
	return bootstrapped(db) && adminAccount(db, authority.credential, now) !== null
}

function holderOf(authority: SetupAuthority): string {
	return authority.kind === 'setup' ? `setup:${authority.sessionHash}` : 'admin'
}

function instanceConfig(db: Db): InstanceConfig {
	const admin = oauthAdmin(db)
	return {
		domain: setting(db, 'domain'),
		teamDomain: setting(db, ACCESS_SETTINGS.teamDomain),
		adminEmail: setting(db, ACCESS_SETTINGS.adminEmail),
		adminUsername: admin.accountId === null ? null : admin.username,
		serviceTokenClientId: setting(db, ACCESS_SETTINGS.serviceTokenClientId),
	}
}

// The reconciliation as the wizard shows it.
export type AccessStatus = {
	// running: a reservation whose lease holds; unresolved: a failure, or a lease that ran out without an outcome.
	state: 'none' | 'running' | 'unresolved' | 'completed'
	completedAt: number | null
	lateFailureAt: number | null
}

function accessStatus(state: AccessState, now: number): AccessStatus {
	const completedAt = state.completed?.at ?? null
	const lateFailureAt = state.lateFailure?.at ?? null
	if (state.reservation !== null) {
		return { state: state.reservation.leaseUntil > now ? 'running' : 'unresolved', completedAt, lateFailureAt }
	}
	if (state.needsReconcile) {
		return { state: 'unresolved', completedAt, lateFailureAt }
	}
	return { state: state.completed === null ? 'none' : 'completed', completedAt, lateFailureAt }
}

// The draft is ready for bootstrap: nothing running or unresolved, and it saw the latest revision complete.
function draftReady(state: AccessState, session: SessionRecord): boolean {
	return (
		state.reservation === null &&
		!state.needsReconcile &&
		state.completed !== null &&
		state.completed.revision === state.revision &&
		session.access !== null &&
		session.accessRevision === state.completed.revision
	)
}

export type SetupView = {
	bootstrapped: boolean
	// Whether the authority given may use the wizard now (see permitted).
	authorized: boolean
	// The setup session's draft, before bootstrap; accessReady when step 7 may run with it.
	draft: (SetupDraft & { accessReady: boolean }) | null
	// The configuration, for the admin after bootstrap.
	config: InstanceConfig | null
	access: AccessStatus | null
	probe: Probe | null
	images: ImagesCheck | null
	cronLastRun: number | null
}

export const setupView = readOperation<{ authority: SetupAuthority | null; now: number }, SetupView>(
	(db, { authority, now }) => {
		const done = bootstrapped(db)
		const authorized = authority !== null && permitted(db, authority, now)
		if (!authorized) {
			return {
				bootstrapped: done,
				authorized,
				draft: null,
				config: null,
				access: null,
				probe: null,
				images: null,
				cronLastRun: null,
			}
		}
		const state = accessState(db)
		const session = authority.kind === 'setup' ? liveSession(db, authority.sessionHash, now) : null
		return {
			bootstrapped: done,
			authorized,
			draft:
				session === null
					? null
					: {
							domain: session.domain,
							access: session.access,
							accessRevision: session.accessRevision,
							accessReady: draftReady(state, session),
						},
			config: done ? instanceConfig(db) : null,
			access: accessStatus(state, now),
			probe: readState<Probe>(db, PROBE),
			images: readState<ImagesCheck>(db, IMAGES),
			cronLastRun: readState<number>(db, CRON),
		}
	}
)

// Opens a setup session after the Worker has checked SETUP_TOKEN. Refused once bootstrapped (SETUP-2). Expired
// sessions are pruned, and at most MAX_SETUP_SESSIONS are kept: the ones closest to expiry go first.
export const beginSetupSession = writeOperation<{ sessionHash: string; now: number }, 'ok' | 'complete'>(
	(db, { sessionHash, now }) => {
		if (bootstrapped(db)) {
			return 'complete'
		}
		db.run(
			`DELETE FROM kopje_state WHERE substr(name, 1, ?1) = ?2 AND json_extract(value, '$.expiresAt') <= ?3`,
			SESSION.length,
			SESSION,
			now
		)
		for (const name of sessionNames(db, 'DESC').slice(MAX_SETUP_SESSIONS - 1)) {
			db.run('DELETE FROM kopje_state WHERE name = ?', name)
		}
		writeState(db, `${SESSION}${sessionHash}`, {
			domain: null,
			access: null,
			accessRevision: null,
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
		const same = session.domain === domain
		writeState(db, `${SESSION}${sessionHash}`, {
			...session,
			domain,
			access: same ? session.access : null,
			accessRevision: same ? session.accessRevision : null,
		} satisfies SessionRecord)
		return 'ok'
	}
)

// The domain and admin a reconciliation is for: before bootstrap the session's confirmed domain and the email given;
// after it, the configured ones (the admin cannot change them here).
function planRefusal(db: Db, authority: SetupAuthority, domain: string, adminEmail: string, now: number) {
	if (authority.kind === 'setup') {
		return liveSession(db, authority.sessionHash, now)?.domain === domain ? null : ('no_domain' as const)
	}
	if (setting(db, 'domain') !== domain) {
		return 'no_domain' as const
	}
	const configured = setting(db, ACCESS_SETTINGS.adminEmail)?.trim().toLowerCase()
	return configured === adminEmail.toLowerCase() ? null : ('admin_mismatch' as const)
}

export type ReserveResult =
	| { status: 'ok'; revision: number; managed: ManagedIds; deadline: number }
	| { status: 'denied' | 'busy' | 'no_domain' | 'admin_mismatch' }

// Reserves the reconciliation before any external call. A reservation of anyone makes it busy until its deadline plus
// ACCESS_SUPERSEDE_GRACE_MS; after that it is superseded (it stays unresolved until this run completes). Every older
// draft stops being bootstrap-ready. The answer carries the lease deadline the Worker fences its requests with.
export const reserveAccess = writeOperation<
	{ authority: SetupAuthority; domain: string; adminEmail: string; now: number },
	ReserveResult
>((db, { authority, domain, adminEmail, now }) => {
	if (!permitted(db, authority, now)) {
		return { status: 'denied' }
	}
	const refused = planRefusal(db, authority, domain, adminEmail, now)
	if (refused !== null) {
		return { status: refused }
	}
	const state = accessState(db)
	if (state.reservation !== null && now <= state.reservation.leaseUntil + ACCESS_SUPERSEDE_GRACE_MS) {
		return { status: 'busy' }
	}
	const revision = state.revision + 1
	writeState(db, ACCESS, {
		...state,
		revision,
		needsReconcile: state.needsReconcile || state.reservation !== null,
		reservation: { revision, holder: holderOf(authority), leaseUntil: now + ACCESS_LEASE_MS, domain, adminEmail },
	} satisfies AccessState)
	return { status: 'ok', revision, managed: state.managed, deadline: now + ACCESS_LEASE_MS }
})

// The reservation of this revision, held by this authority and still authorized; null when the run must stop.
function heldReservation(db: Db, authority: SetupAuthority, revision: number, now: number): AccessState | null {
	const state = accessState(db)
	const held = state.reservation
	if (held === null || held.revision !== revision || held.holder !== holderOf(authority)) {
		return null
	}
	return permitted(db, authority, now) ? state : null
}

// Before each external write: renews the lease and records the ids made so far, and answers the new deadline. 'stop'
// when the run was superseded, or its authority ended (bootstrap ended the setup session; the admin's session expired,
// was signed out or suspended).
export const checkpointAccess = writeOperation<
	{ authority: SetupAuthority; revision: number; managed: ManagedIds; now: number },
	{ status: 'ok'; deadline: number } | { status: 'stop' }
>((db, { authority, revision, managed, now }) => {
	const state = heldReservation(db, authority, revision, now)
	if (state === null || state.reservation === null) {
		return { status: 'stop' }
	}
	writeState(db, ACCESS, {
		...state,
		managed: { ...state.managed, ...managed },
		reservation: { ...state.reservation, leaseUntil: now + ACCESS_LEASE_MS },
	} satisfies AccessState)
	return { status: 'ok', deadline: now + ACCESS_LEASE_MS }
})

// The run's outcome. Success makes it the latest completed revision: the reserving session's draft (before bootstrap)
// or the configuration (the admin's run) takes it. 'stop' when the run no longer holds the reservation.
export const completeAccess = writeOperation<
	{ authority: SetupAuthority; revision: number; access: AccessDraft; managed: ManagedIds; now: number },
	'ok' | 'stop'
>((db, { authority, revision, access, managed, now }) => {
	const state = heldReservation(db, authority, revision, now)
	if (state === null || state.reservation === null) {
		return 'stop'
	}
	const reservation = state.reservation
	if (access.adminEmail.toLowerCase() !== reservation.adminEmail.toLowerCase()) {
		return 'stop'
	}
	writeState(db, ACCESS, {
		...state,
		reservation: null,
		needsReconcile: false,
		completed: { revision, access, at: now },
		managed: { ...state.managed, ...managed },
	} satisfies AccessState)
	if (authority.kind === 'setup') {
		const session = liveSession(db, authority.sessionHash, now)
		if (session !== null) {
			writeState(db, `${SESSION}${authority.sessionHash}`, {
				...session,
				access,
				accessRevision: revision,
			} satisfies SessionRecord)
		}
	} else {
		writeAccess(db, access)
	}
	return 'ok'
})

// A run that failed: it releases its reservation and leaves the state unresolved, keeping the ids it made. A run
// already superseded has its failure recorded (lateFailure) without touching the newer run's state: it dispatched
// nothing after its deadline, and the newer run reserved only after the grace that followed.
export const failAccess = writeOperation<
	{ authority: SetupAuthority; revision: number; managed: ManagedIds; now: number },
	void
>((db, { authority, revision, managed, now }) => {
	const state = accessState(db)
	if (state.reservation?.revision !== revision || state.reservation.holder !== holderOf(authority)) {
		if (revision < state.revision) {
			writeState(db, ACCESS, { ...state, lateFailure: { revision, at: now } } satisfies AccessState)
		}
		return
	}
	writeState(db, ACCESS, {
		...state,
		reservation: null,
		needsReconcile: true,
		managed: { ...state.managed, ...managed },
	} satisfies AccessState)
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

// Only the probe last sent is marked; a superseded probe changes nothing.
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

function month(now: number): string {
	return new Date(now).toISOString().slice(0, 7)
}

// Step 4 transforms the same tiny image every time, which Images bills once per month: the instance's monthly budget
// (RES-6) is charged for it at most once per UTC month, atomically here. A recheck in the same month runs uncharged.
export const chargeSetupTransform = writeOperation<
	{ authority: SetupAuthority; limit: number; now: number },
	'ok' | 'denied' | 'budget_exhausted'
>((db, { authority, limit, now }) => {
	if (!permitted(db, authority, now)) {
		return 'denied'
	}
	const charged = readState<{ month: string }>(db, `${IMAGES}_charged`)
	if (charged?.month === month(now)) {
		return 'ok'
	}
	if (!chargeInstanceTransforms(db, 1, limit, now)) {
		return 'budget_exhausted'
	}
	writeState(db, `${IMAGES}_charged`, { month: month(now) })
	return 'ok'
})

// Step 4's outcome, shown until the next check.
export const recordSetupImages = writeOperation<
	{ authority: SetupAuthority; outcome: ImagesOutcome; code: number | null; now: number },
	boolean
>((db, { authority, outcome, code, now }) => {
	if (!permitted(db, authority, now)) {
		return false
	}
	writeState(db, IMAGES, { month: month(now), at: now, outcome, code } satisfies ImagesCheck)
	return true
})

export type BootstrapInput = {
	sessionHash: string
	domain: string
	username: string
	email: string
	key: { privkey: Uint8Array; salt: Uint8Array; pubkey: string }
	now: number
}

export type BootstrapResult = 'ok' | 'complete' | 'denied' | 'incomplete' | 'stale' | 'email_mismatch'

// SETUP-3: step 7. The domain, the Access configuration, admin_email and the admin's local account, in this one
// transaction, which fails once anything of a bootstrap exists, while an Access reconciliation runs or is unresolved,
// or when the session's Access outcome is not the latest completed revision. Ends every setup session (SETUP-2).
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
	if (!draftReady(accessState(db), session)) {
		return 'stale'
	}
	if (session.access.adminEmail.toLowerCase() !== input.email.toLowerCase()) {
		return 'email_mismatch'
	}
	db.run("INSERT INTO instance_settings (name, value) VALUES ('domain', ?)", input.domain)
	db.run('INSERT INTO instance_settings (name, value) VALUES (?, ?)', ACCESS_SETTINGS.adminEmail, input.email)
	writeAccess(db, session.access)
	insertLocalAccount(db, input)
	db.run('DELETE FROM kopje_state WHERE substr(name, 1, ?1) = ?2', SESSION.length, SESSION)
	return 'ok'
})

export type NewLocalAccount = {
	domain: string
	username: string
	email: string
	key: { privkey: Uint8Array; salt: Uint8Array; pubkey: string }
	now: number
}

// Makes a local account: the setup's admin (bootstrapInstance) and an invited identity's on its first sign-in
// (account-invitations.ts createInvitedAccount), the only two ways one is made. The caller has checked that the
// username is a LOCAL_USERNAME no local account holds; accounts_local_username refuses it otherwise. Returns its id.
export function insertLocalAccount(db: Db, input: NewLocalAccount): string {
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
	// User#prepare_new_user!: the registration and the account's first login.
	countRegistration(db, input.now)
	recordLogin(db, id, input.now)
	// The OAuth admin is the one local account whose email matches admin_email (VIS-29): read it again.
	forgetAdminAccountId(db)
	return id
}
