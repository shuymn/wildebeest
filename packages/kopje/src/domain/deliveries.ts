import {
	availableLocalSql,
	availableSql,
	isActorObject,
	outboundKind,
	PROVENANCE_MAX,
	type RemoteRecipient,
	recipientsFor,
} from './audience'
import { hostRefused } from './host-policy'
import { readOperation, writeOperation } from './operation'
import type { Db } from '../db/sql'
import { hostDomain } from '../platform/domain-name'

// Outbound delivery (design §4 "outbound", NET-2, VIS-3, RES-4, RES-5, RES-6, OPS-3). deliveries is the source of
// truth; the Queue only rings a doorbell, and the Worker does the POSTs.
//
//   - Targets: an outbound intent's audience becomes a list of (inbox, addressee) targets, from the stored audience
//     only and for the recipients the policy gives it (audienceTargets, recipientsFor in audience.ts). A retraction
//     (Delete, Undo, Reject) also targets every inbox that received the object or may still receive it: receipts, and
//     the deliveries and unexpanded targets of earlier activities about it.
//   - Silent recipients: a recipient the activity reaches without naming it in to/cc gets a copy of its own at its
//     personal inbox, with only itself added to to (the object's too), and no Mention. Misskey reads the audience from
//     to/cc only, not from the inbox it arrived at, so without the name the recipient would lose access. Each such
//     copy tells its recipient only that they themselves are addressed; the copy for everyone else never names them.
//   - Expansion: the targets are stored with the intent in chunks (outbound_targets) of at most TARGET_CHUNK_SIZE
//     targets and TARGET_CHUNK_BYTES, so no row grows with the audience (a Durable Object row is limited to 2 MB), and
//     written as deliveries rows EXPANSION_STEP at a time, oldest chunk first, in the transaction that records it and
//     then in each claim (RES-6). An intent's rows are all written before a later intent's, so id order stays intent
//     order; the one exception is a retraction staged over several steps (stageRetraction).
//   - Admission (RES-4): a lane may hold MAX_LANE_BACKLOG active rows and the Store MAX_BACKLOG. A row over either cap
//     is written as gave_up with 'backlog full': refused at once, visible to the operator, retried by them.
//   - Lanes: a lane is (sender, inbox origin) and is delivered in id order, so a Create to a server's shared inbox
//     cannot be overtaken by an Update or Delete to a personal inbox there. Only a lane's oldest active row is pending
//     or leased; the rows behind it are queued and promoted when it settles. So the due index holds lane heads only,
//     and a claim reads at most `limit` rows.
//   - Claims run inside one Store transaction, so they are serialized. Each claim issues a fresh lease token, counts
//     an attempt and leases the row for LEASE_MS. A completion settles a row only with the token of its current
//     lease, so a completion that arrives after the lease expired and the row was claimed again changes nothing.
//   - An expired lease (the Worker died, or the completion was lost after the POST) is claimed again like a due row.
//     The remote inbox may then see the activity twice; receivers deduplicate by activity id.
//   - A failure is retried after min(30 s·2^n, 12 h), n being the attempts so far; after MAX_ATTEMPTS, or on a
//     permanent failure, the row is gave_up: kept for the operator until retried or swept. An activity that a later
//     one about the same object follows is superseded, and the operator may not send it again (an Add or Remove is
//     about its object in its collection, so either supersedes the other of the same pair).
//   - An activity without to that a recipient's shared inbox answers with 404, 405 or 410 moves to that recipient's
//     personal inbox on the same origin, within its attempts (personalFallback): some servers advertise a shared
//     inbox they have disabled.
//   - A delivered Create or Announce of a local status records its inbox in outbound_receipts, owned by the
//     status; none is written once the status is gone or a retraction of it is pending (one still staging its
//     targets reads them from the receipts, so they are written until it is staged).
//   - Claims and completions return nextDueAt, the earliest time any work is due, so the Worker can ring for it.
//   - Send-time check (VIS-30): each target's Provenance is copied onto its row; sendRefused and confirmDelivery below.
//   - Signer: an activity is signed by its lane's account, its author, except one recorded as signed by the instance
//     actor (signedBy 'instance', DATA-7): a forwarded report's Flag (reports.ts), which Mastodon sends from
//     Account.representative. Its lane is still the reporter's, which owns the intent and orders it with the reporter's
//     other activities to that server.

export const LEASE_MS = 60_000
export const MAX_ATTEMPTS = 15
export const RETRY_BASE_MS = 30_000
export const RETRY_MAX_MS = 12 * 60 * 60 * 1000
export const CLAIM_LIMIT = 16
export const GAVE_UP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const EXPANSION_STEP = 100
// A chunk is one expansion step, so a step parses one chunk; with the URL caps at ingestion a full chunk stays well
// under TARGET_CHUNK_BYTES, which in turn is far under the 2 MB a Durable Object row or string may hold.
export const TARGET_CHUNK_SIZE = EXPANSION_STEP
export const TARGET_CHUNK_BYTES = 512 * 1024
export const MAX_LANE_BACKLOG = 500
export const MAX_BACKLOG = 10_000
export const BACKLOG_FULL = 'backlog full'
const SWEEP_BATCH = 500
export const RETRY_BATCH = 1000
const REPORT_LIMIT = 100
const ACTIVE = "('queued', 'pending', 'leased')"

// The wait before the next attempt, after `attempts` attempts have failed (attempts >= 1).
export function retryDelay(attempts: number): number {
	return Math.min(RETRY_BASE_MS * 2 ** Math.min(attempts, 30), RETRY_MAX_MS)
}

// ---------------------------------------------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------------------------------------------

type Activity = Record<string, unknown>

// A target's provenance (VIS-30): the remote recipients behind it, which the send-time check reads (sendRefused).
//   - accounts: their ids, at most PROVENANCE_MAX; absent above it, where `many` is set instead ("not all
//     unavailable").
//   - domains: the distinct hosts of their actor ids, at most PROVENANCE_MAX; absent above it.
// A target with neither accounts nor many has no provenance: one whose recipients are unknown (a retraction's earlier
// receivers, phase A's staged reach, a row queued before migration 0044) or merged with such a target.
export type Provenance = { accounts?: string[]; domains?: string[]; many?: true }

export type Target = { inbox: string; addressee: string | null } & Provenance

export { PROVENANCE_MAX }

function uris(value: unknown): string[] {
	if (typeof value === 'string') {
		return [value]
	}
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function idOf(value: unknown): string | null {
	if (typeof value === 'string') {
		return value
	}
	if (typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string') {
		return (value as { id: string }).id
	}
	return null
}

function hrefOf(value: unknown): string | null {
	const href = typeof value === 'object' && value !== null ? (value as { href?: unknown }).href : undefined
	return typeof href === 'string' ? href : null
}

// The activity types a later activity about the same object supersedes (beyond what a retraction supersedes: all):
// an Update earlier Updates, an Add or Remove earlier Adds and Removes of the same member of the same collection.
function supersededTypes(type: unknown): string[] {
	switch (type) {
		case 'Update':
			return ['Update']
		case 'Add':
		case 'Remove':
			return ['Add', 'Remove']
		default:
			return []
	}
}

function quoteStampOf(activity: Activity): string | null {
	const object = activity.object
	return typeof object === 'object' &&
		object !== null &&
		(object as { type?: unknown }).type === 'QuoteRequest' &&
		typeof activity.result === 'string'
		? activity.result
		: null
}

// The local object an activity is about, and whether it retracts it (outboundKind in audience.ts).
// retracts: the activity withdraws work already sent, so it supersedes what it names and admission never refuses it.
// A Reject withdraws only when it ends a follow we had accepted (withdraws); a Reject of a request never accepted (a
// refused or blocked Follow) is new work and is admitted like any other.
function subjectOf(activity: Activity, withdraws: boolean): { object: string | null; retracts: boolean } {
	const retracts = outboundKind(activity, withdraws) === 'retraction'
	switch (activity.type) {
		// An Accept of a QuoteRequest is about the stamp it grants (its result), so the stamp's Delete supersedes it
		// while it waits; any other Accept, a Follow's, is about what it accepts.
		case 'Accept':
			return { object: quoteStampOf(activity) ?? idOf(activity.object), retracts }
		case 'Create':
		case 'Update':
		case 'Delete':
		case 'Undo':
		case 'Reject':
			return { object: idOf(activity.object), retracts }
		// An Add or Remove is about its object in its collection (a featured hashtag, by its href when it has no id), so a
		// later one about the same pair supersedes it.
		case 'Add':
		case 'Remove': {
			const target = idOf(activity.target)
			const member = idOf(activity.object) ?? hrefOf(activity.object)
			return { object: target === null || member === null ? null : `${target} ${member}`, retracts }
		}
		default:
			return { object: typeof activity.id === 'string' ? activity.id : null, retracts }
	}
}

// NET-3's syntactic part, applied before a row is written: an https URL without credentials. Host checks (literal
// IPs, local names, DNS) run again at every POST (federation/delivery.ts).
export function isDeliverableInbox(value: string | null): value is string {
	if (value === null || value === '') {
		return false
	}
	try {
		const url = new URL(value)
		return url.protocol === 'https:' && url.username === '' && url.password === ''
	} catch {
		return false
	}
}

export type DeliveryAudience = { followers: boolean; accounts: string[]; pollVoters?: string }

// The audience of another status an activity also reaches (reachOf), resolved under that status's owner: its local
// author, whose receipts and earlier activities about `object` hold the inboxes that received it.
export type ReachOf = { owner: string; object: string; audience: DeliveryAudience }

// What an intent records: the activity, its audience, and, for the one activity the instance actor signs, signedBy.
// immutable: every destination receives the activity as recorded, byte for byte (a body signed by its author, whose
// proof an edit would break); a would-be personal copy goes to its recipient's personal inbox unedited. reachOf: the
// audiences of other statuses it reaches too (a stamp's Delete reaches the quoted and the quoting status's), only
// selecting inboxes: the signer, its lanes and the subject stay the envelope's own.
export type DeliveryEnvelope = {
	activity: Activity
	audience: DeliveryAudience
	signedBy?: 'instance'
	immutable?: true
	reachOf?: ReachOf[]
}

// The targets an activity goes to (NET-2), from the stored audience only, for the recipients the policy gives it
// (recipientsFor in audience.ts):
//   - followers: by shared inbox when they have one (deduplicated);
//   - addressed accounts named in to/cc: by shared inbox, as Mastodon's StatusReachFinder;
//   - addressed accounts the activity reaches without naming them: on an addressed activity (one with to), a silent
//     recipient, by its personal inbox only, with itself as addressee (none: recorded as unreachable for the
//     operator, never sent to a shared inbox); otherwise (an activity without to: a Like, Follow, Accept, Reject,
//     Block or their Undo, each of which names its recipient through its object) by shared inbox when it has one, else its
//     personal inbox, as some servers accept but do not process such activities at a personal inbox;
//   - for a retraction, every inbox that received the object or may still receive it.
// Local accounts are never delivered to over HTTP: they read the Store. A neutral copy goes once to each inbox, and a
// personal copy once to each silent recipient. Personal copies are written first, so on a server that also gets the
// neutral copy, the one naming its recipient is POSTed first; Misskey keeps only the first Create it processes.
export function audienceTargets(
	db: Db,
	signerId: string,
	activity: Activity,
	audience: DeliveryAudience,
	withdraws = false
): Target[] {
	return targetsOf(db, signerId, activity, audience, withdraws, []).targets
}

// The recipients behind a target as staging gathers them, unknown once any of them is. Each set stops growing at
// PROVENANCE_MAX + 1 (its overflow), so a target keeps a bounded amount whatever its audience.
type Behind = { accounts: Set<string>; domains: Set<string>; unknown: boolean }

function nobody(): Behind {
	return { accounts: new Set(), domains: new Set(), unknown: false }
}

function addCapped(set: Set<string>, value: string): void {
	if (set.size <= PROVENANCE_MAX) {
		set.add(value)
	}
}

function mergedProvenance(target: Target, other: Target): Provenance {
	const known = (t: Target) => t.accounts !== undefined || t.many === true
	if (!known(target) || !known(other)) {
		return {}
	}
	const merged = nobody()
	for (const t of [target, other]) {
		for (const id of t.accounts ?? []) {
			addCapped(merged.accounts, id)
		}
		for (const host of t.domains ?? []) {
			addCapped(merged.domains, host)
		}
	}
	const provenance = provenanceOf(merged)
	const many = target.many === true || other.many === true || provenance.many === true
	const domains = target.domains === undefined || other.domains === undefined ? undefined : provenance.domains
	return {
		...(many ? { many: true } : { accounts: provenance.accounts }),
		...(domains === undefined ? {} : { domains }),
	}
}

function provenanceOf(b: Behind): Provenance {
	if (b.unknown) {
		return {}
	}
	const domains = b.domains.size > PROVENANCE_MAX ? {} : { domains: [...b.domains].sort() }
	return b.accounts.size > PROVENANCE_MAX
		? { many: true, ...domains }
		: { accounts: [...b.accounts].sort(), ...domains }
}

// The targets, and the inboxes among them that are a poll's voters (pollVoters), which hold the status already: they
// fetched it to vote, though no delivery of it to them may have been recorded. Each target carries the provenance of
// every recipient it serves, merged across followers, addressed accounts, voters and reachOf before deduplication.
function targetsOf(
	db: Db,
	signerId: string,
	activity: Activity,
	audience: DeliveryAudience,
	withdraws: boolean,
	reachOf: readonly ReachOf[]
): { targets: Target[]; voters: Set<string> } {
	// Neutral copies by inbox; personal copies by recipient, kept apart so one never replaces the other.
	const neutral = new Map<string, Behind>()
	const personal = new Map<string, { inbox: string; behind: Behind }>()
	// recipient null: an inbox whose recipients are unknown (an earlier receiver of what a retraction withdraws).
	const add = (inbox: string | null, addressee: string | null, recipient: RemoteRecipient | null) => {
		let into: Behind
		if (addressee !== null) {
			// VIS-2: only the recipient's own inbox. Without one the copy is recorded as unreachable ('' inbox), never
			// sent to a shared inbox where others would see the recipient named.
			const entry = personal.get(addressee) ?? { inbox: isDeliverableInbox(inbox) ? inbox : '', behind: nobody() }
			personal.set(addressee, entry)
			into = entry.behind
		} else if (isDeliverableInbox(inbox)) {
			into = neutral.get(inbox) ?? nobody()
			neutral.set(inbox, into)
		} else {
			return
		}
		if (recipient === null) {
			into.unknown = true
		} else {
			addCapped(into.accounts, recipient.id)
			addCapped(into.domains, recipient.host)
		}
	}
	const named = new Set([...uris(activity.to), ...uris(activity.cc)])
	const addressedActivity = Array.isArray(activity.to)
	const reach = (recipients: ReturnType<typeof recipientsFor>) => {
		for (const follower of [...recipients.followers, ...recipients.voters]) {
			add(follower.inbox, null, follower)
		}
		for (const account of recipients.accounts) {
			if (named.has(account.uri)) {
				add(account.shared_inbox_url ?? account.inbox_url, null, account)
			} else {
				add(
					addressedActivity ? account.inbox_url : (account.shared_inbox_url ?? account.inbox_url),
					addressedActivity ? account.uri : null,
					account
				)
			}
		}
	}
	const recipients = recipientsFor(db, signerId, activity, audience, withdraws)
	reach(recipients)
	const { object, retracts } = subjectOf(activity, withdraws)
	if (retracts && object !== null) {
		for (const inbox of receiversOf(db, signerId, object)) {
			add(inbox, null, null)
		}
	}
	for (const other of reachOf) {
		reach(recipientsFor(db, other.owner, activity, other.audience, withdraws))
		for (const inbox of receiversOf(db, other.owner, other.object)) {
			add(inbox, null, null)
		}
	}
	const byInbox = (a: Target, b: Target) => (a.inbox < b.inbox ? -1 : a.inbox > b.inbox ? 1 : 0)
	return {
		targets: [
			...[...personal]
				.map(([addressee, { inbox, behind }]) => ({ inbox, addressee, ...provenanceOf(behind) }))
				.sort(byInbox),
			...[...neutral].map(([inbox, behind]) => ({ inbox, addressee: null, ...provenanceOf(behind) })).sort(byInbox),
		],
		voters: new Set(recipients.voters.map((v) => v.inbox).filter(isDeliverableInbox)),
	}
}

// Every inbox that received an object of this signer, or may: its receipts, the rows of earlier activities about it
// in any state (a leased one may have been POSTed already), and their targets not yet expanded.
function receiversOf(db: Db, signerId: string, object: string): string[] {
	const receipts = db.all<{ inbox: string }>(
		`SELECT r.inbox_url AS inbox FROM outbound_receipts r JOIN statuses s ON s.id = r.status_id
		WHERE s.uri = ? AND r.account_id = ?`,
		object,
		signerId
	)
	const outstanding = db.all<{ inbox: string }>(
		`SELECT d.inbox_url AS inbox FROM outbound_activities o JOIN deliveries d ON d.activity_id = o.id
		WHERE o.account_id = ? AND o.object_uri = ? AND o.retracts = 0`,
		signerId,
		object
	)
	const unexpanded = db.all<{ inbox: string }>(
		`SELECT json_extract(t.value, '$.inbox') AS inbox
		FROM outbound_activities o JOIN outbound_targets c ON c.activity_id = o.id, json_each(c.targets) t
		WHERE o.account_id = ? AND o.object_uri = ? AND o.retracts = 0 AND t.key >= c.next`,
		signerId,
		object
	)
	return [...receipts, ...outstanding, ...unexpanded].map((r) => r.inbox)
}

// ---------------------------------------------------------------------------------------------------------------
// Recording and expansion
// ---------------------------------------------------------------------------------------------------------------

// Records the intent with its targets, and expands what the step allows. A retraction supersedes every earlier
// activity about its object and drops the object's receipts (its own targets now hold that evidence); an Update
// supersedes earlier Updates only. An Update of a status goes alone to servers known to have it (a receipt, or its
// poll's voters); every other server gets a Create of the current
// version and then the Update, in that order in its lane, which replace any Create or Update of the object still
// waiting for it there. Whether such a server holds the status is never guessed: Mastodon and Misskey ignore a Create
// of a status they hold (Create#create_status) and an Update of one they do not, so one of the pair applies either way,
// and the delivered Create's receipt makes later edits an Update alone.
export function enqueueActivity(
	db: Db,
	signerId: string,
	envelope: DeliveryEnvelope,
	now: number,
	options: { withdraws?: boolean } = {}
): void {
	const found = targetsOf(
		db,
		signerId,
		envelope.activity,
		envelope.audience,
		options.withdraws === true,
		envelope.reachOf ?? []
	)
	const { voters } = found
	let targets = found.targets
	// An immutable activity's personal copy is the neutral one, byte for byte: one delivery per inbox suffices
	// (quotes.ts revokeLocalStamp), and it serves the neutral copy's recipients too.
	if (envelope.immutable === true) {
		const neutral = new Map(targets.filter((t) => t.addressee === null).map((t) => [t.inbox, t]))
		const personal = new Set(targets.filter((t) => t.addressee !== null).map((t) => t.inbox))
		targets = targets.flatMap((t) => {
			if (t.addressee === null) {
				return personal.has(t.inbox) ? [] : [t]
			}
			const shared = neutral.get(t.inbox)
			return [shared === undefined ? t : { inbox: t.inbox, addressee: t.addressee, ...mergedProvenance(t, shared) }]
		})
	}
	const { object, retracts } = subjectOf(envelope.activity, options.withdraws === true)
	const types = supersededTypes(envelope.activity.type)
	if (object !== null && (retracts || types.length > 0)) {
		supersede(db, signerId, object, retracts, types)
	}
	if (object !== null && retracts) {
		db.run(
			'DELETE FROM outbound_receipts WHERE account_id = ? AND status_id IN (SELECT id FROM statuses WHERE uri = ?)',
			signerId,
			object
		)
	}
	// An actor Update goes unchanged to every target and replaces its waiting profile Updates, so quick edits deliver
	// only the latest document. A status Update follows the rule above; poll voters hold the status and take its counts
	// from an Update only (DistributePollUpdateWorker).
	if (object !== null && envelope.activity.type === 'Update' && isActorObject(envelope.activity.object)) {
		// A restoration Update still staging its audience carries the new document too, so a server it reaches after
		// this Update is not left with the older profile. (No profile changes while the account is suspended, so a
		// suspension's Update is never rewritten.)
		db.run(
			`UPDATE outbound_activities SET body = json_set(body, '$.activity.object', json(?3))
			WHERE account_id = ?1 AND object_uri = ?2 AND retracts = 0 AND staged IS NOT NULL
				AND json_extract(body, '$.activity.object.suspended') IS NOT 1`,
			signerId,
			object,
			JSON.stringify(envelope.activity.object)
		)
		replaceWaiting(
			db,
			signerId,
			object,
			new Set(targets.filter((t) => t.inbox !== '').map((t) => laneOf(t.inbox))),
			now
		)
		insertIntent(db, signerId, envelope, object, false, targets, now)
	} else if (object !== null && envelope.activity.type === 'Update') {
		const having = serversWithObject(db, signerId, object)
		const fresh = targets.filter((t) => t.inbox !== '' && !having.has(laneOf(t.inbox)) && !voters.has(t.inbox))
		if (fresh.length > 0) {
			replaceWaiting(db, signerId, object, new Set(fresh.map((t) => laneOf(t.inbox))), now)
			const creation = { ...envelope, activity: createOfCurrent(envelope.activity) }
			insertIntent(db, signerId, creation, object, false, fresh, now)
		}
		insertIntent(db, signerId, envelope, object, false, targets, now)
	} else {
		insertIntent(db, signerId, envelope, object, retracts, targets, now)
	}
	expandPending(db, now, EXPANSION_STEP)
}

// The earlier activities about an object that a new one supersedes. A moderation Update still staging (retracts 0,
// staged set: beginStagedUpdate) is superseded only by another (`moderation`): a profile edit made while the
// restoration's audience is staged must not cut that audience down to the followers.
const SUPERSEDED = `account_id = ? AND object_uri = ?
	AND (? OR json_extract(body, '$.activity.type') IN (SELECT value FROM json_each(?)))
	AND (? OR retracts = 1 OR staged IS NULL)`

// Marks the earlier activities a new one about the object follows. A retraction still staging (stageRetraction) is
// complete then: the new retraction targets every inbox it held or would have.
function supersede(
	db: Db,
	signerId: string,
	object: string,
	retracts: boolean,
	types: string[] = [],
	moderation = false
): void {
	const stopped = db.all<{ id: string }>(
		`UPDATE outbound_activities SET superseded = 1, staged = NULL WHERE ${SUPERSEDED}
		RETURNING CAST(id AS TEXT) AS id`,
		signerId,
		object,
		retracts ? 1 : 0,
		JSON.stringify(types),
		moderation ? 1 : 0
	)
	for (const { id } of stopped) {
		dropSettledActivity(db, id)
	}
}

// A retraction recorded in bounded steps: a purge's Undo of a local boost (RES-6), whose receipts alone may be more
// targets than one batch can write. beginRetraction records the intent, superseding the earlier activities about its
// object, in at most maxRows rows (false, writing nothing, when they do not fit); stageRetraction then writes its
// targets a chunk at a time in a fixed order, at most maxRows rows per call, and returns whether all are written.
// While it stages, `staged` holds the key of the last target written; receipts of its object are still recorded
// (completeDelivery), so an inbox an earlier activity reaches meanwhile stays a target; and the intent is kept even
// with no rows. The caller keeps the receipts until it is staged. Its chunks written in a later call come after those
// of intents recorded meanwhile: nothing recorded later is about the object but another retraction of it. Chunks
// already written may be expanded before the rest are staged, which is harmless. Each call recomputes the targets and
// skips keys at or below `staged`, so a follower whose inbox changes to an earlier key between calls is missed (an
// accepted risk in the threat model).
export function beginRetraction(
	db: Db,
	signerId: string,
	envelope: DeliveryEnvelope,
	now: number,
	maxRows: number
): boolean {
	const { object } = subjectOf(envelope.activity, false)
	const superseded =
		object === null
			? 0
			: (db.first<{ n: number }>(
					`SELECT count(*) AS n FROM outbound_activities WHERE ${SUPERSEDED}`,
					signerId,
					object,
					1,
					'[]',
					0
				)?.n ?? 0)
	// Each superseded intent is updated and may be dropped; then the intent itself.
	if (2 * superseded + 1 > maxRows) {
		return false
	}
	if (object !== null) {
		supersede(db, signerId, object, true)
	}
	db.run(
		`INSERT INTO outbound_activities (account_id, body, object_uri, retracts, staged, created_at)
		VALUES (?, ?, ?, 1, '', ?)`,
		signerId,
		JSON.stringify(envelope),
		object,
		now
	)
	return true
}

export function stageRetraction(db: Db, signerId: string, object: string, maxRows: number): boolean {
	const intent = db.first<{ id: string; body: string; staged: string }>(
		`SELECT CAST(id AS TEXT) AS id, body, staged FROM outbound_activities
		WHERE account_id = ? AND object_uri = ? AND retracts = 1 AND staged IS NOT NULL ORDER BY id LIMIT 1`,
		signerId,
		object
	)
	if (intent === undefined) {
		return true
	}
	// Each chunk is a row, and so is the update of staged.
	if (maxRows < 2) {
		return false
	}
	const envelope = JSON.parse(intent.body) as { activity: Activity; audience: DeliveryAudience }
	const targets = audienceTargets(db, signerId, envelope.activity, envelope.audience)
		.map((target) => ({ target, key: stageKey(target) }))
		.filter((t) => t.key > intent.staged)
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
	const chunks = chunked(targets.map((t) => t.target))
	const fits = chunks.slice(0, maxRows - 1)
	for (const chunk of fits) {
		db.run('INSERT INTO outbound_targets (activity_id, targets) VALUES (CAST(? AS INTEGER), ?)', intent.id, chunk.json)
	}
	const done = fits.length === chunks.length
	db.run(
		'UPDATE outbound_activities SET staged = ? WHERE id = CAST(? AS INTEGER)',
		done ? null : targets[fits[fits.length - 1]!.last]!.key,
		intent.id
	)
	if (done) {
		dropSettledActivity(db, intent.id)
	}
	return done
}

// An intent whose targets the moderation jobs stage (domain/suspension.ts): the Update of a local actor that a
// suspension or an unsuspension sends to an audience read in bounded rounds (R1, AccountReachFinder). beginStagedUpdate
// records it with no targets, superseding the earlier Updates of the actor, a moderation one still staging included
// (it stops: its generation has ended); a profile Update supersedes none still staging (SUPERSEDED). While `staged` is
// set the intent is kept even with no rows.
// stageTargets writes targets to it as chunks, which claims may expand at once; endStaging releases it. Returns the
// intent's id. Its chunks come after those of intents recorded meanwhile.
export function beginStagedUpdate(db: Db, signerId: string, envelope: DeliveryEnvelope, now: number): string {
	const { object } = subjectOf(envelope.activity, false)
	if (object !== null) {
		supersede(db, signerId, object, false, supersededTypes(envelope.activity.type), true)
	}
	return db.first<{ id: string }>(
		`INSERT INTO outbound_activities (account_id, body, object_uri, retracts, staged, created_at)
		VALUES (?, ?, ?, 0, '', ?) RETURNING CAST(id AS TEXT) AS id`,
		signerId,
		JSON.stringify(envelope),
		object,
		now
	)!.id
}

// Writes `inboxes` (neutral copies) as chunks of the staged intent `intentId`, and returns how many rows it wrote; none
// when the intent is no longer staging (superseded, or gone).
export function stageTargets(db: Db, intentId: string, inboxes: readonly string[]): number {
	if (
		db.first(
			'SELECT 1 AS x FROM outbound_activities WHERE id = CAST(? AS INTEGER) AND staged IS NOT NULL',
			intentId
		) === undefined
	) {
		return 0
	}
	const chunks = chunked(inboxes.filter(isDeliverableInbox).map((inbox) => ({ inbox, addressee: null })))
	for (const chunk of chunks) {
		db.run('INSERT INTO outbound_targets (activity_id, targets) VALUES (CAST(? AS INTEGER), ?)', intentId, chunk.json)
	}
	return chunks.length
}

// Releases a staged intent: no more targets come, and it goes once its rows are settled.
export function endStaging(db: Db, intentId: string): void {
	db.run('UPDATE outbound_activities SET staged = NULL WHERE id = CAST(? AS INTEGER) AND staged IS NOT NULL', intentId)
	dropSettledActivity(db, intentId)
}

// The fixed order a retraction is staged in: personal copies first (as audienceTargets orders them), then by inbox.
function stageKey(target: Target): string {
	return `${target.addressee === null ? 1 : 0}\n${target.inbox}\n${target.addressee ?? ''}`
}

// The targets as JSON arrays of at most TARGET_CHUNK_SIZE targets and TARGET_CHUNK_BYTES each, with the index of
// the last target each holds. A target too large for a chunk on its own (the URL caps at ingestion keep remote ones
// far below it; an imported or older row may not be) is left out, counted and logged without its value (DATA-5).
function chunked(targets: Target[]): { json: string; last: number }[] {
	const encoder = new TextEncoder()
	const chunks: { json: string; last: number }[] = []
	let current: string[] = []
	let bytes = 2
	let last = -1
	let oversized = 0
	targets.forEach((target, index) => {
		const json = JSON.stringify(target)
		const size = encoder.encode(json).byteLength + 1
		if (size + 2 > TARGET_CHUNK_BYTES) {
			oversized++
			return
		}
		if (current.length >= TARGET_CHUNK_SIZE || bytes + size > TARGET_CHUNK_BYTES) {
			chunks.push({ json: `[${current.join(',')}]`, last })
			current = []
			bytes = 2
		}
		current.push(json)
		bytes += size
		last = index
	})
	if (current.length > 0) {
		chunks.push({ json: `[${current.join(',')}]`, last })
	}
	if (oversized > 0) {
		console.warn({ event: 'kopje.delivery.oversized_target', count: oversized })
	}
	return chunks
}

function insertIntent(
	db: Db,
	signerId: string,
	envelope: DeliveryEnvelope,
	object: string | null,
	retracts: boolean,
	targets: Target[],
	now: number
): void {
	const chunks = chunked(targets)
	if (chunks.length === 0) {
		return
	}
	const intent = db.first<{ id: string }>(
		`INSERT INTO outbound_activities (account_id, body, object_uri, retracts, created_at)
		VALUES (?, ?, ?, ?, ?) RETURNING CAST(id AS TEXT) AS id`,
		signerId,
		JSON.stringify(envelope),
		object,
		retracts ? 1 : 0,
		now
	)!
	for (const chunk of chunks) {
		db.run('INSERT INTO outbound_targets (activity_id, targets) VALUES (CAST(? AS INTEGER), ?)', intent.id, chunk.json)
	}
}

// Servers (lane origins) with a delivered Create receipt at any inbox. A leased Create does not count: it may give
// up, and an operator's later retry could deliver an older version; send the Create/Update pair even if it succeeds.
// A server may already hold an object it fetched to boost or quote, so this set only controls omissions. Origins are
// the unit: an Update at a personal inbox applies after a Create at the shared inbox; another Create is ignored.
function serversWithObject(db: Db, signerId: string, object: string): Set<string> {
	const receipts = db.all<{ inbox_url: string }>(
		`SELECT r.inbox_url FROM outbound_receipts r JOIN statuses s ON s.id = r.status_id
		WHERE s.uri = ? AND r.account_id = ?`,
		object,
		signerId
	)
	return new Set(receipts.map((r) => laneOf(r.inbox_url)))
}

// Drops the Creates and Updates of an object still waiting for these servers (queued, pending, given up, or not
// expanded): the pair of the current version's Create and the Update replaces them.
function replaceWaiting(db: Db, signerId: string, object: string, lanes: Set<string>, now: number): void {
	const earlier = db.all<{ id: string }>(
		`SELECT CAST(id AS TEXT) AS id FROM outbound_activities
		WHERE account_id = ? AND object_uri = ? AND retracts = 0`,
		signerId,
		object
	)
	for (const intent of earlier) {
		const removed = db.all<{ lane: string }>(
			`DELETE FROM deliveries WHERE activity_id = CAST(? AS INTEGER) AND state <> 'leased'
				AND lane IN (SELECT value FROM json_each(?)) RETURNING lane`,
			intent.id,
			JSON.stringify([...lanes])
		)
		for (const lane of new Set(removed.map((r) => r.lane))) {
			promoteLane(db, signerId, lane, now)
		}
		const chunks = db.all<{ id: string; targets: string; next: number }>(
			'SELECT CAST(id AS TEXT) AS id, targets, next FROM outbound_targets WHERE activity_id = CAST(? AS INTEGER)',
			intent.id
		)
		for (const chunk of chunks) {
			// A chunk only shrinks, so it stays within its bounds.
			const rest = (JSON.parse(chunk.targets) as Target[]).slice(chunk.next).filter((t) => !lanes.has(laneOf(t.inbox)))
			if (rest.length === 0) {
				db.run('DELETE FROM outbound_targets WHERE id = CAST(? AS INTEGER)', chunk.id)
			} else {
				db.run(
					'UPDATE outbound_targets SET targets = ?, next = 0 WHERE id = CAST(? AS INTEGER)',
					JSON.stringify(rest),
					chunk.id
				)
			}
		}
		dropSettledActivity(db, intent.id)
	}
}

function createOfCurrent(update: Activity): Activity {
	const note = update.object as Activity
	return {
		'@context': update['@context'],
		id: `${String(note.id)}/activity`,
		type: 'Create',
		actor: update.actor,
		published: note.published,
		to: update.to,
		cc: update.cc,
		object: note,
	}
}

function laneOf(inbox: string): string {
	return inbox === '' ? '' : new URL(inbox).origin
}

function activeCount(db: Db, where: string, limit: number, ...params: SqlStorageValue[]): number {
	return (
		db.first<{ n: number }>(
			`SELECT count(*) AS n FROM (SELECT 1 FROM deliveries WHERE ${where} AND state IN ${ACTIVE} LIMIT ?)`,
			...params,
			limit
		)?.n ?? 0
	)
}

// Admission (RES-4): whether one more active row fits the lane and the whole backlog, `total` being the active rows
// counted once by the caller and kept up to date. Retractions are never refused: they clean up what was already
// sent, and are bounded by it.
class Admission {
	#total: number | null = null

	constructor(private readonly db: Db) {}

	admits(accountId: string, lane: string, retracts: boolean): boolean {
		this.#total ??= activeCount(this.db, '1', MAX_BACKLOG)
		const fits =
			retracts ||
			(this.#total < MAX_BACKLOG &&
				activeCount(this.db, 'account_id = ? AND lane = ?', MAX_LANE_BACKLOG, accountId, lane) < MAX_LANE_BACKLOG)
		if (fits) {
			this.#total++
		}
		return fits
	}
}

export const NO_PERSONAL_INBOX = 'no personal inbox'

// Writes up to `budget` targets of the oldest chunks still expanding, oldest first, reading each chunk from its cursor
// (next). A target over a cap is written as gave_up 'backlog full'; a silent copy without a personal inbox as gave_up
// 'no personal inbox' (inbox '').
function expandPending(db: Db, now: number, budget: number): void {
	const admission = new Admission(db)
	while (budget > 0) {
		const chunk = db.first<{ id: string; activity_id: string; account_id: string; retracts: number; next: number }>(
			`SELECT CAST(c.id AS TEXT) AS id, CAST(c.activity_id AS TEXT) AS activity_id, o.account_id, o.retracts, c.next
			FROM outbound_targets c JOIN outbound_activities o ON o.id = c.activity_id ORDER BY c.id LIMIT 1`
		)
		if (chunk === undefined) {
			return
		}
		const step = db.all<{
			key: number
			inbox: string
			addressee: string | null
			accounts: string | null
			domains: string | null
			many: number | null
		}>(
			`SELECT t.key, json_extract(t.value, '$.inbox') AS inbox, json_extract(t.value, '$.addressee') AS addressee,
				json_extract(t.value, '$.accounts') AS accounts, json_extract(t.value, '$.domains') AS domains,
				json_extract(t.value, '$.many') AS many
			FROM outbound_targets c, json_each(c.targets) t
			WHERE c.id = CAST(? AS INTEGER) AND t.key >= c.next ORDER BY t.key LIMIT ?`,
			chunk.id,
			budget
		)
		const intent = { id: chunk.activity_id, account_id: chunk.account_id, retracts: chunk.retracts }
		for (const target of step) {
			const lane = laneOf(target.inbox)
			const refusal =
				target.inbox === ''
					? NO_PERSONAL_INBOX
					: admission.admits(intent.account_id, lane, intent.retracts === 1)
						? null
						: BACKLOG_FULL
			if (refusal === NO_PERSONAL_INBOX) {
				// DATA-5: no URL or identity in the log; the operator sees the row.
				console.warn({ event: 'kopje.delivery.no_personal_inbox' })
			}
			db.run(
				`INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, addressee, state, next_attempt_at,
					last_error, updated_at, recipient_accounts, recipient_domains, recipients_many)
				VALUES (CAST(?1 AS INTEGER), ?2, ?3, ?4, ?5,
					CASE WHEN ?6 IS NOT NULL THEN 'gave_up'
						WHEN EXISTS (SELECT 1 FROM deliveries WHERE account_id = ?2 AND lane = ?4 AND state IN ${ACTIVE})
						THEN 'queued' ELSE 'pending' END,
					?7, ?6, ?7, ?8, ?9, ?10)`,
				intent.id,
				intent.account_id,
				target.inbox,
				lane,
				target.addressee,
				refusal,
				now,
				target.many === 1 ? null : target.accounts,
				target.domains,
				target.many === 1 ? 1 : null
			)
		}
		const next = step.length === 0 ? chunk.next : step[step.length - 1]!.key + 1
		db.run('UPDATE outbound_targets SET next = ? WHERE id = CAST(? AS INTEGER)', next, chunk.id)
		db.run(
			'DELETE FROM outbound_targets WHERE id = CAST(? AS INTEGER) AND next >= json_array_length(targets)',
			chunk.id
		)
		budget -= step.length
	}
}

// The earliest time any work is due: now while intents are still expanding, else the earliest due or lease deadline.
// A completion leaves out the rows of its own claim, which the round that holds them reports on itself.
function nextDueAt(db: Db, now: number, ownLease: string | null = null): number | null {
	if (db.first('SELECT 1 AS yes FROM outbound_targets LIMIT 1') !== undefined) {
		return now
	}
	return (
		db.first<{ at: number | null }>(
			`SELECT min(next_attempt_at) AS at FROM deliveries
			WHERE state IN ('pending', 'leased') AND (?1 IS NULL OR lease_token IS NOT ?1)`,
			ownLease
		)?.at ?? null
	)
}

// ---------------------------------------------------------------------------------------------------------------
// Claims and completions
// ---------------------------------------------------------------------------------------------------------------

export type ClaimedDelivery = { id: string; inbox: string; signer: string }

export type DeliverySigner = { actorUri: string; privkey: Uint8Array; salt: Uint8Array; pubkey: string }

export type Claim = {
	leaseToken: string
	leaseUntil: number
	deliveries: ClaimedDelivery[]
	signers: Record<string, DeliverySigner>
	// The instance actor's URI when a claimed delivery is the instance actor's (INSTANCE_SIGNER), else null.
	instanceActor: string | null
	nextDueAt: number | null
}

// Promotes the oldest queued row of a lane once the lane has no pending or leased row.
function promoteLane(db: Db, accountId: string, lane: string, now: number): void {
	db.run(
		`UPDATE deliveries SET state = 'pending', next_attempt_at = ?3, updated_at = ?3
		WHERE id = (SELECT id FROM deliveries WHERE account_id = ?1 AND lane = ?2 AND state = 'queued' ORDER BY id LIMIT 1)
			AND NOT EXISTS (SELECT 1 FROM deliveries WHERE account_id = ?1 AND lane = ?2 AND state IN ('pending', 'leased'))`,
		accountId,
		lane,
		now
	)
}

function dropSettledActivity(db: Db, activityId: string): void {
	db.run(
		`DELETE FROM outbound_activities WHERE id = CAST(?1 AS INTEGER) AND staged IS NULL
			AND NOT EXISTS (SELECT 1 FROM outbound_targets WHERE activity_id = CAST(?1 AS INTEGER))
			AND NOT EXISTS (SELECT 1 FROM deliveries WHERE activity_id = CAST(?1 AS INTEGER))`,
		activityId
	)
}

type LaneRow = {
	id: string
	activity_id: string
	account_id: string
	lane: string
	inbox_url: string
	attempts: number
}

const LANE_ROW = `CAST(id AS TEXT) AS id, CAST(activity_id AS TEXT) AS activity_id, account_id, lane, inbox_url, attempts`

function giveUp(db: Db, row: LaneRow, now: number, status: number | null, error: string): void {
	db.run(
		`UPDATE deliveries SET state = 'gave_up', lease_token = NULL, last_status = ?, last_error = ?, updated_at = ?
		WHERE id = CAST(? AS INTEGER)`,
		status,
		error,
		now,
		row.id
	)
	promoteLane(db, row.account_id, row.lane, now)
}

// The activity as sent to one row: a personal copy adds its addressee to to, and to the object's to, unless the
// activity is immutable.
function bodyFor(activity: string, addressee: string | null, immutable: boolean): string {
	if (addressee === null || immutable) {
		return activity
	}
	const parsed = JSON.parse(activity) as Activity
	const addTo = (target: Activity) => {
		target.to = [...uris(target.to).filter((uri) => uri !== addressee), addressee]
	}
	addTo(parsed)
	if (typeof parsed.object === 'object' && parsed.object !== null && Array.isArray((parsed.object as Activity).to)) {
		addTo(parsed.object as Activity)
	}
	return JSON.stringify(parsed)
}

// The signer of a delivery the instance actor signs: no account id, which is 18 digits, can be it. Its key is not in
// claim.signers; the Worker loads it, creating it if it does not exist yet (instanceActorKey in federation.ts), and
// signs as claim.instanceActor.
export const INSTANCE_SIGNER = 'instance'

// R1 for a suspended local sender: what its lane holds is dropped, not sent, except a retraction (outboundKind: a
// Delete, an Undo, a Reject that withdraws, which VIS-3 sends to every earlier receiver) and the suspension's own
// Update of its actor (the redacted document, `suspended: true`). Queued content is dropped when it is claimed or
// confirmed while the sender is suspended, which the queue does within moments of the suspension; a row not claimed by
// the time of an unsuspension is sent then. The restoration's Update is recorded once the account is no longer
// suspended, so it passes; one confirmed after the account is suspended again does not.
const REFUSED_SENDER = `EXISTS (SELECT 1 FROM local_accounts l
	WHERE l.account_id = d.account_id AND NOT ${availableLocalSql('l')} AND o.retracts = 0
		AND NOT (json_extract(o.body, '$.activity.type') = 'Update'
			AND json_extract(o.body, '$.activity.object.suspended') IS 1
			AND json_extract(o.body, '$.activity.object.id') = json_extract(o.body, '$.activity.actor')))`

// A due row (`d`) with its activity (`o`, LEFT JOINed: found is 0 when it is gone) as the send-time check reads it.
type DueRow = LaneRow & {
	addressee: string | null
	recipient_accounts: string | null
	recipient_domains: string | null
	found: number
	retracts: number | null
	refused_sender: number
	signed_by: string | null
	// An Announce's boosted original (its object), null for any other activity.
	boosted: string | null
}

const DUE_ROW = `CAST(d.id AS TEXT) AS id, CAST(d.activity_id AS TEXT) AS activity_id, d.account_id, d.lane, d.inbox_url,
	d.attempts, d.addressee, d.recipient_accounts, d.recipient_domains, o.id IS NOT NULL AS found, o.retracts,
	${REFUSED_SENDER} AS refused_sender, json_extract(o.body, '$.signedBy') AS signed_by,
	CASE json_extract(o.body, '$.activity.type') WHEN 'Announce' THEN json_extract(o.body, '$.activity.object') END
		AS boosted`

const DUE_FROM = 'deliveries d LEFT JOIN outbound_activities o ON o.id = d.activity_id'

function hostOf(inbox: string): string | null {
	try {
		return hostDomain(inbox)
	} catch {
		return null
	}
}

// VIS-30's send-time check, at the claim and again at confirmation (the rules: docs/visibility.md, "The send-time
// check"). The exemption reads the persisted retracts flag, never the activity's kind worked out again. The accounts
// rule joins accounts, because availableSql reads a missing id as available and a purged recipient must count as gone.
// An Announce distributes its original, so it is refused while the original's author is unavailable (R1), read live by
// the original's uri (statuses' unique key); no other content activity carries a remote author's object (a quote names
// its quoted status by uri and stamp only).
function sendRefused(db: Db, row: DueRow): boolean {
	if (row.retracts === 1) {
		return false
	}
	if (row.refused_sender === 1) {
		return true
	}
	const host = hostOf(row.inbox_url)
	if (host !== null && hostRefused(db, host)) {
		return true
	}
	if (
		row.recipient_accounts !== null &&
		db.first(
			`SELECT 1 AS yes FROM json_each(?) r JOIN main.accounts a ON a.id = r.value
			WHERE ${availableSql('a.id')} LIMIT 1`,
			row.recipient_accounts
		) === undefined
	) {
		return true
	}
	if (
		row.boosted !== null &&
		db.first(
			`SELECT 1 AS yes FROM main.statuses s WHERE s.uri = ? AND NOT ${availableSql('s.account_id')}`,
			row.boosted
		) !== undefined
	) {
		return true
	}
	const domains = row.recipient_domains === null ? [] : (JSON.parse(row.recipient_domains) as string[])
	return domains.length > 0 && domains.every((domain) => hostRefused(db, domain))
}

function dropRow(db: Db, row: LaneRow, now: number): void {
	db.run('DELETE FROM deliveries WHERE id = CAST(? AS INTEGER)', row.id)
	promoteLane(db, row.account_id, row.lane, now)
	dropSettledActivity(db, row.activity_id)
}

// Expands one step, then leases up to `limit` due lane heads (RES-6: a claim reads and returns a bounded number of
// rows). An expired lease is due again; one that has used up its attempts is given up instead of claimed; one the
// send-time check refuses (sendRefused) is dropped. What to send is read by confirmDelivery.
export const claimDeliveries = writeOperation<{ now: number; leaseToken: string; limit?: number }, Claim>(
	(db, { now, leaseToken, limit }) => {
		expandPending(db, now, EXPANSION_STEP)
		const max = Math.max(1, Math.min(limit ?? CLAIM_LIMIT, CLAIM_LIMIT))
		const leaseUntil = now + LEASE_MS
		const due = db.all<DueRow>(
			`SELECT ${DUE_ROW} FROM ${DUE_FROM}
			WHERE d.state IN ('pending', 'leased') AND d.next_attempt_at <= ? ORDER BY d.next_attempt_at, id LIMIT ?`,
			now,
			max
		)
		const claimed: ClaimedDelivery[] = []
		for (const row of due) {
			// A row whose activity is gone is never refused here; its confirmation drops it.
			if (row.found === 1 && sendRefused(db, row)) {
				dropRow(db, row, now)
				continue
			}
			if (row.attempts >= MAX_ATTEMPTS) {
				giveUp(db, row, now, null, 'lease expired')
				continue
			}
			db.run(
				`UPDATE deliveries SET state = 'leased', lease_token = ?, attempts = attempts + 1, next_attempt_at = ?,
					updated_at = ?, last_error = CASE WHEN state = 'leased' THEN 'lease expired' ELSE last_error END
				WHERE id = CAST(? AS INTEGER)`,
				leaseToken,
				leaseUntil,
				now,
				row.id
			)
			claimed.push({
				id: row.id,
				inbox: row.inbox_url,
				signer: row.signed_by === 'instance' ? INSTANCE_SIGNER : row.account_id,
			})
		}
		const signers: Record<string, DeliverySigner> = {}
		for (const accountId of new Set(claimed.map((c) => c.signer))) {
			if (accountId === INSTANCE_SIGNER) {
				continue
			}
			const key = db.first<{ uri: string; privkey: ArrayBuffer; privkey_salt: ArrayBuffer; pubkey: string }>(
				`SELECT a.uri, l.privkey, l.privkey_salt, l.pubkey FROM local_accounts l JOIN accounts a ON a.id = l.account_id
				WHERE l.account_id = ?`,
				accountId
			)
			if (key !== undefined) {
				signers[accountId] = {
					actorUri: key.uri,
					privkey: new Uint8Array(key.privkey),
					salt: new Uint8Array(key.privkey_salt),
					pubkey: key.pubkey,
				}
			}
		}
		const domain = claimed.some((c) => c.signer === INSTANCE_SIGNER)
			? db.first<{ value: string }>("SELECT value FROM instance_settings WHERE name = 'domain'")?.value
			: undefined
		const instanceActor = domain === undefined ? null : `https://${domain}/actor`
		return { leaseToken, leaseUntil, deliveries: claimed, signers, instanceActor, nextDueAt: nextDueAt(db, now) }
	}
)

export type Confirmation =
	| { status: 'send'; body: string }
	// The send-time check refused the row: it is deleted and its lane promoted.
	| { status: 'dropped'; nextDueAt: number | null }
	// The lease is no longer this one's: send nothing.
	| { status: 'stale' }

// VIS-30's send boundary: called after the signer is loaded and the host checked, right before signing and the POST,
// with the claim's lease (as confirmPush is). It runs the claim's check again (sendRefused) and, when the row may still
// be sent, writes nothing and returns what to send, read now and never from the claim (a staged restoration Update is
// rewritten in place while it stages). A change that commits after it does not stop that POST.
export const confirmDelivery = writeOperation<{ id: string; leaseToken: string; now: number }, Confirmation>(
	(db, { id, leaseToken, now }) => {
		const row = db.first<DueRow & { activity: string | null; immutable: number | null }>(
			`SELECT ${DUE_ROW}, json_extract(o.body, '$.activity') AS activity, json_extract(o.body, '$.immutable') AS immutable
			FROM ${DUE_FROM} WHERE d.id = CAST(? AS INTEGER) AND d.state = 'leased' AND d.lease_token = ?`,
			id,
			leaseToken
		)
		if (row === undefined) {
			return { status: 'stale' }
		}
		if (row.found === 0 || row.activity === null || sendRefused(db, row)) {
			dropRow(db, row, now)
			return { status: 'dropped', nextDueAt: nextDueAt(db, now, leaseToken) }
		}
		return { status: 'send', body: bodyFor(row.activity, row.addressee, row.immutable === 1) }
	}
)

export type DeliveryOutcome =
	{ kind: 'delivered'; status: number } | { kind: 'failed'; status: number | null; error: string; permanent: boolean }

export type Completion = (
	| { status: 'delivered' }
	| { status: 'retry'; retryAt: number }
	| { status: 'gave_up' }
	// The lease is no longer this one's: the row was claimed again, settled, or deleted.
	| { status: 'stale' }
) & { nextDueAt: number | null }

const MAX_ERROR_LENGTH = 200

export const completeDelivery = writeOperation<
	{ id: string; leaseToken: string; now: number; outcome: DeliveryOutcome },
	Completion
>((db, { id, leaseToken, now, outcome }) => {
	const row = db.first<LaneRow>(
		`SELECT ${LANE_ROW} FROM deliveries WHERE id = CAST(? AS INTEGER) AND state = 'leased' AND lease_token = ?`,
		id,
		leaseToken
	)
	if (row === undefined) {
		return { status: 'stale', nextDueAt: nextDueAt(db, now, leaseToken) }
	}
	if (outcome.kind === 'delivered') {
		// The receipt is kept only for a status that still exists and has no retraction pending (VIS-3). A retraction
		// still staging its targets is not pending yet: it reads them from the receipts. Only a Create or an Announce
		// records one: a delivered Update proves nothing (a server that lacks the status answers 2xx and ignores it), so
		// a server whose Create was given up gets the Create again with the next edit.
		db.run(
			`INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at)
			SELECT s.id, ?2, o.account_id, ?3 FROM outbound_activities o JOIN statuses s ON s.uri = o.object_uri
			WHERE o.id = CAST(?1 AS INTEGER) AND json_extract(o.body, '$.activity.type') IN ('Create', 'Announce')
				AND NOT EXISTS (SELECT 1 FROM outbound_activities r
					WHERE r.account_id = o.account_id AND r.object_uri = o.object_uri AND r.retracts = 1 AND r.staged IS NULL)
			ON CONFLICT DO UPDATE SET delivered_at = excluded.delivered_at`,
			row.activity_id,
			row.inbox_url,
			now
		)
		dropRow(db, row, now)
		return { status: 'delivered', nextDueAt: nextDueAt(db, now, leaseToken) }
	}
	const error = outcome.error.slice(0, MAX_ERROR_LENGTH)
	if (outcome.permanent && personalFallback(db, row, now, outcome.status, error)) {
		return { status: 'retry', retryAt: now, nextDueAt: nextDueAt(db, now, leaseToken) }
	}
	if (outcome.permanent || row.attempts >= MAX_ATTEMPTS) {
		giveUp(db, row, now, outcome.status, error)
		return { status: 'gave_up', nextDueAt: nextDueAt(db, now, leaseToken) }
	}
	const retryAt = now + retryDelay(row.attempts)
	db.run(
		`UPDATE deliveries SET state = 'pending', lease_token = NULL, next_attempt_at = ?, last_status = ?, last_error = ?,
			updated_at = ? WHERE id = CAST(? AS INTEGER)`,
		retryAt,
		outcome.status,
		error,
		now,
		row.id
	)
	return { status: 'retry', retryAt, nextDueAt: nextDueAt(db, now, leaseToken) }
})

// The answers by which a shared inbox is taken to be missing (not found, no POST, gone) rather than refusing the
// activity. A server may advertise a shared inbox it has disabled (Pixelfed lists one even when its configuration
// turns it off) while its personal inboxes still work.
const SHARED_INBOX_MISSING = new Set([404, 405, 410])

// The fallback of audienceTargets' rule for an activity without to: a row sent to its recipient's shared inbox that
// answered SHARED_INBOX_MISSING moves, in place, to that recipient's personal inbox when it has a different one on
// the same origin that the activity has no row or unexpanded target for. A personal inbox on another origin gets no
// fallback (the row gives up as on any other permanent failure), so a row never changes lanes: it keeps its id and
// its place in the lane (a later Undo stays behind it), and records the shared inbox's answer until it settles. The
// failed attempt counts, and a row moves only while it has attempts left (MAX_ATTEMPTS): a recipient that swaps its
// inbox URLs between attempts keeps a row alive for at most MAX_ATTEMPTS attempts, as ordinary retries do. Rows of an
// addressed activity (followers, accounts named in to/cc) and personal copies (addressee) never move. A moved row
// serves that recipient alone, and its provenance (VIS-30) says so.
function personalFallback(db: Db, row: LaneRow, now: number, status: number | null, error: string): boolean {
	if (status === null || !SHARED_INBOX_MISSING.has(status) || row.attempts >= MAX_ATTEMPTS) {
		return false
	}
	// The audience's accounts at this shared inbox, in id order (as many as the activity addresses). For content, the
	// first one the send-time check would still send to (sendRefused): one it would refuse would lose the delivery at
	// the next claim, though another recipient there may be available. A retraction takes the first, as it is never
	// refused.
	const candidates = db.all<{ inbox: string; id: string; uri: string; retracts: number; available: number }>(
		`SELECT a.inbox_url AS inbox, a.id, a.uri, o.retracts, ${availableSql('a.id')} AS available
		FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id,
			json_each(o.body, '$.audience.accounts') r JOIN accounts a ON a.id = r.value
		WHERE d.id = CAST(?1 AS INTEGER) AND d.addressee IS NULL AND json_type(o.body, '$.activity.to') IS NOT 'array'
			AND a.domain IS NOT NULL AND a.shared_inbox_url = d.inbox_url AND a.inbox_url <> d.inbox_url
			AND NOT EXISTS (SELECT 1 FROM deliveries e WHERE e.activity_id = o.id AND e.inbox_url = a.inbox_url)
			AND NOT EXISTS (SELECT 1 FROM outbound_targets c, json_each(c.targets) t
				WHERE c.activity_id = o.id AND t.key >= c.next AND json_extract(t.value, '$.inbox') = a.inbox_url)
		ORDER BY a.id`,
		row.id
	)
	const personal = candidates.find((c) => {
		const host = hostOf(c.uri)
		return c.retracts === 1 || (c.available === 1 && (host === null || !hostRefused(db, host)))
	})
	if (personal === undefined || !isDeliverableInbox(personal.inbox) || laneOf(personal.inbox) !== row.lane) {
		return false
	}
	db.run(
		`UPDATE deliveries SET state = 'pending', inbox_url = ?2, lease_token = NULL, next_attempt_at = ?3,
			last_status = ?4, last_error = ?5, updated_at = ?3, recipient_accounts = json_array(?6),
			recipient_domains = CASE WHEN ?7 IS NULL THEN NULL ELSE json_array(?7) END, recipients_many = NULL
		WHERE id = CAST(?1 AS INTEGER)`,
		row.id,
		personal.inbox,
		now,
		status,
		`shared inbox ${error}; sent to the personal inbox`.slice(0, MAX_ERROR_LENGTH),
		personal.id,
		hostOf(personal.uri)
	)
	// DATA-5: no URL or identity in the log.
	console.warn({ event: 'kopje.delivery.shared_inbox_fallback', status })
	return true
}

// ---------------------------------------------------------------------------------------------------------------
// Operator view (admin API and `kopje-admin deliveries`) and the sweep
// ---------------------------------------------------------------------------------------------------------------

export type GaveUpDelivery = {
	id: string
	account: string
	// '' for a silent copy whose recipient has no personal inbox (unreachable).
	inbox: string
	// The silent recipient a personal copy is addressed to.
	addressee: string | null
	activityType: string | null
	activityId: string | null
	attempts: number
	lastStatus: number | null
	lastError: string | null
	superseded: boolean
	updatedAt: number
}

export type DeliveriesReport = {
	backlog: {
		queued: number
		pending: number
		leased: number
		gaveUp: number
		expanding: number
		oldestDueAt: number | null
		caps: { lane: number; total: number }
	}
	gaveUp: GaveUpDelivery[]
}

// The backlog by state and the given-up rows, newest first, `before` an id for the next page.
export const deliveriesReport = readOperation<{ before?: string; limit?: number }, DeliveriesReport>(
	(db, { before, limit }) => {
		const counts = db.all<{ state: string; n: number }>('SELECT state, count(*) AS n FROM deliveries GROUP BY state')
		const count = (state: string) => counts.find((c) => c.state === state)?.n ?? 0
		const oldest = db.first<{ at: number | null }>(
			"SELECT min(next_attempt_at) AS at FROM deliveries WHERE state IN ('pending', 'leased')"
		)
		const expanding = db.first<{ n: number }>('SELECT count(DISTINCT activity_id) AS n FROM outbound_targets')?.n ?? 0
		const rows = db.all<{
			id: string
			username: string
			inbox_url: string
			type: string | null
			activity: string | null
			attempts: number
			last_status: number | null
			last_error: string | null
			superseded: number
			addressee: string | null
			updated_at: number
		}>(
			`SELECT CAST(d.id AS TEXT) AS id, a.username, d.inbox_url, json_extract(o.body, '$.activity.type') AS type,
				json_extract(o.body, '$.activity.id') AS activity, d.attempts, d.last_status, d.last_error, o.superseded, d.addressee,
				d.updated_at
			FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id LEFT JOIN accounts a ON a.id = d.account_id
			WHERE d.state = 'gave_up' AND d.id < coalesce(CAST(?1 AS INTEGER), 1e19) ORDER BY d.id DESC LIMIT ?2`,
			before ?? null,
			Math.max(1, Math.min(limit ?? REPORT_LIMIT, REPORT_LIMIT))
		)
		return {
			backlog: {
				queued: count('queued'),
				pending: count('pending'),
				leased: count('leased'),
				gaveUp: count('gave_up'),
				expanding,
				oldestDueAt: oldest?.at ?? null,
				caps: { lane: MAX_LANE_BACKLOG, total: MAX_BACKLOG },
			},
			gaveUp: rows.map((r) => ({
				id: r.id,
				account: r.username,
				inbox: r.inbox_url,
				addressee: r.addressee,
				activityType: r.type,
				activityId: r.activity,
				attempts: r.attempts,
				lastStatus: r.last_status,
				lastError: r.last_error,
				superseded: r.superseded === 1,
				updatedAt: r.updated_at,
			})),
		}
	}
)

export type RetryResult =
	// refused: still over an admission cap, left given up. next: the cursor for `all` when more rows remain.
	| { ok: true; retried: number; skipped: number; refused: number; more: boolean; next: string | null }
	// Named rows that may not be sent again: superseded (a later activity about the same object, an Undo, a Delete or
	// an Update, follows it; sending it again could undo what the user did since), or a silent copy without a
	// personal inbox (unreachable).
	| { ok: false; code: 'superseded' | 'unreachable'; ids: string[] }

// Puts given-up rows back in their lanes with fresh attempts, through the same admission as new work (retractions are
// never refused): the named ones, or all eligible ones, RETRY_BATCH per call from the `after` cursor.
export const retryDeliveries = writeOperation<{ ids: string[] | 'all'; now: number; after?: string }, RetryResult>(
	(db, { ids, now, after }) => {
		type Candidate = {
			id: string
			account_id: string
			lane: string
			superseded: number
			retracts: number
			inbox_url: string
		}
		const columns = 'CAST(d.id AS TEXT) AS id, d.account_id, d.lane, o.superseded, o.retracts, d.inbox_url'
		let rows: Candidate[]
		let skipped = 0
		if (ids === 'all') {
			// Eligible rows only, so ineligible ones never fill the batch.
			rows = db.all<Candidate>(
				`SELECT ${columns} FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id
				WHERE d.state = 'gave_up' AND o.superseded = 0 AND d.inbox_url <> '' AND d.id > CAST(?1 AS INTEGER)
				ORDER BY d.id LIMIT ?2`,
				after ?? '0',
				RETRY_BATCH + 1
			)
			skipped =
				db.first<{ n: number }>(
					`SELECT count(*) AS n FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id
					WHERE d.state = 'gave_up' AND (o.superseded = 1 OR d.inbox_url = '') AND d.id > CAST(? AS INTEGER)`,
					after ?? '0'
				)?.n ?? 0
		} else {
			rows = db.all<Candidate>(
				`SELECT ${columns} FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id
				WHERE d.state = 'gave_up' AND d.id IN (SELECT CAST(value AS INTEGER) FROM json_each(?)) ORDER BY d.id`,
				JSON.stringify(ids.slice(0, RETRY_BATCH))
			)
			const superseded = rows.filter((r) => r.superseded === 1).map((r) => r.id)
			if (superseded.length > 0) {
				return { ok: false, code: 'superseded', ids: superseded }
			}
			const unreachable = rows.filter((r) => r.inbox_url === '').map((r) => r.id)
			if (unreachable.length > 0) {
				return { ok: false, code: 'unreachable', ids: unreachable }
			}
		}
		const batch = rows.slice(0, RETRY_BATCH)
		const admission = new Admission(db)
		let retried = 0
		for (const row of batch) {
			if (!admission.admits(row.account_id, row.lane, row.retracts === 1)) {
				continue
			}
			db.run(
				`UPDATE deliveries SET attempts = 0, last_status = NULL, last_error = NULL, next_attempt_at = ?3, updated_at = ?3,
					state = CASE WHEN EXISTS (SELECT 1 FROM deliveries WHERE account_id = ?1 AND lane = ?2
						AND state IN ${ACTIVE}) THEN 'queued' ELSE 'pending' END
				WHERE id = CAST(?4 AS INTEGER)`,
				row.account_id,
				row.lane,
				now,
				row.id
			)
			retried++
		}
		const more = rows.length > RETRY_BATCH
		return {
			ok: true,
			retried,
			skipped,
			refused: batch.length - retried,
			more,
			next: more ? (batch.at(-1)?.id ?? null) : null,
		}
	}
)

// RES-4: given-up rows are kept for GAVE_UP_RETENTION_MS, then deleted with their activity once it has no row left.
export const sweepDeliveries = writeOperation<{ now: number }, { swept: number }>((db, { now }) => {
	const swept = db.all<{ activity_id: string }>(
		`DELETE FROM deliveries WHERE id IN (SELECT id FROM deliveries WHERE state = 'gave_up' AND updated_at < ?
			ORDER BY updated_at LIMIT ?) RETURNING CAST(activity_id AS TEXT) AS activity_id`,
		now - GAVE_UP_RETENTION_MS,
		SWEEP_BATCH
	)
	for (const activityId of new Set(swept.map((r) => r.activity_id))) {
		dropSettledActivity(db, activityId)
	}
	return { swept: swept.length }
})
