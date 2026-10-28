import {
	type Audience,
	availableLocalSql,
	availableSql,
	isActorObject,
	type OutboundKind,
	outboundKind,
	projectedSql,
	PROVENANCE_MAX,
	type RemoteRecipient,
	recipientsFor,
	shareReaches,
	type StagedAccount,
	stagedAccount,
	stagedBoost,
	stagedBoosters,
	stagedFollowers,
	type StagedInbox,
	stagedMentions,
	stagedParent,
	stagedList,
	stagedQuoters,
	stagedVoters,
} from './audience'
import { EXPANSION_STEP } from './delivery-bounds'
import { hostCovered } from './instance-domain-blocks'
import { readOperation, writeOperation } from './operation'
import { RowBudget } from './row-budget'
import { ACCOUNTS_ID_INDEX, STATUSES_ID_INDEX, STATUSES_URI_INDEX } from '../db/indexes'
import type { Db } from '../db/sql'
import { hostDomain } from '../platform/domain-name'

// Outbound delivery (NET-2, VIS-3, RES-4, RES-5, RES-6, OPS-3). deliveries is the source of
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
//     an attempt, marks the row exposed (it may be POSTed from then on; nothing clears it) and leases it for LEASE_MS.
//     A completion settles a row only with the token of its current lease, so a completion that arrives after the
//     lease expired and the row was claimed again changes nothing.
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
//     other activities to that server. A remote author's Delete forwarded through local boosts (inbox.ts
//     recordForwards) is one intent per booster, signed by it in its lanes, so no server learns of another booster's
//     share (NET-2).
//   - Forwards: an intent whose audience has shares (Audience.shares) has a subject of its own (FORWARD_SUBJECT), so it
//     neither supersedes nor is superseded by any other activity, whatever names its object's id (VIS-3).

export const LEASE_MS = 60_000
export const MAX_ATTEMPTS = 15
export const RETRY_BASE_MS = 30_000
export const RETRY_MAX_MS = 12 * 60 * 60 * 1000
export const CLAIM_LIMIT = 16
export const GAVE_UP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export { EXPANSION_STEP }
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

// The subject of a forwarded activity (an envelope whose audience has shares): its object's id behind a prefix no
// URI starts with, so that no other writer's subject (an id, or a collection and member pair) equals it.
export const FORWARD_SUBJECT = 'forward '

// The subject a forward of `object` is recorded under (beginRetraction).
export function forwardSubject(object: string): string {
	return `${FORWARD_SUBJECT}${object}`
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

// What an intent's audience names (audience.ts Audience): its followers, accounts, poll voters and, for a local
// status's Delete, the status whose accounts are read at staging (recipientsFor).
export type DeliveryAudience = Audience

// The audience of another status an activity also reaches (reachOf), resolved under that status's owner: its local
// author, whose receipts and earlier activities about `object` hold the inboxes that received it.
export type ReachOf = { owner: string; object: string; audience: DeliveryAudience }

// What an intent records: the activity, its audience, and, for the one activity the instance actor signs, signedBy.
// immutable: every destination receives the activity as recorded, byte for byte (a body signed by its author, whose
// proof an edit would break); a would-be personal copy goes to its recipient's personal inbox unedited. reachOf: the
// audiences of other statuses it reaches too (a stamp's Delete reaches the quoted and the quoting status's), only
// selecting inboxes: the signer, its lanes and the subject stay the envelope's own. followPair: the remote follower a
// local account's Accept or Reject of a Follow answers (outbound_activities.follow_pair, cancelFollowAnswers); kept in
// its column, not in the body. An immutable envelope whose audience has shares is a forward (FORWARD_SUBJECT): a
// remote author's proven Delete, sent as received.
export type DeliveryEnvelope = {
	activity: Activity
	audience: DeliveryAudience
	signedBy?: 'instance'
	immutable?: true
	reachOf?: ReachOf[]
	followPair?: string
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

// How an activity reaches the addressed account with this uri (audienceTargets): true for a copy of its own at its
// personal inbox, addressed to it (one the addressed activity does not name in to/cc); false for a neutral copy at its
// shared inbox, else its personal inbox. A staged retraction applies the same rule (planOf, takeAccount).
function placement(activity: Activity): (uri: string) => boolean {
	const named = new Set([...uris(activity.to), ...uris(activity.cc)])
	const addressedActivity = Array.isArray(activity.to)
	return (uri) => addressedActivity && !named.has(uri)
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
	reachOf: readonly ReachOf[],
	earlierReceivers = true
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
	const place = placement(activity)
	const reach = (recipients: ReturnType<typeof recipientsFor>) => {
		for (const follower of [...recipients.followers, ...recipients.voters]) {
			add(follower.inbox, null, follower)
		}
		for (const account of recipients.accounts) {
			const personal = place(account.uri)
			add(
				personal ? account.inbox_url : (account.shared_inbox_url ?? account.inbox_url),
				personal ? account.uri : null,
				account
			)
		}
	}
	const recipients = recipientsFor(db, signerId, activity, audience, withdraws)
	reach(recipients)
	const { object, retracts } = subjectOf(activity, withdraws)
	// A forward reaches its shares' receivers (below), never the earlier receivers of its object's id, which is not
	// the signer's.
	if (retracts && object !== null && earlierReceivers && audience.shares === undefined) {
		for (const inbox of receiversOf(db, signerId, object)) {
			add(inbox, null, null)
		}
	}
	// A forward (VIS-3): the signer's followers, by shared inbox as its Announce went, and every inbox that received
	// each of its boosts or may (receiversOf), neutral copies only, whatever the forwarded activity's to.
	const shared = audience.shares === undefined ? [] : shareReaches(db, signerId, audience.shares)
	if (shared.length > 0) {
		reach(recipientsFor(db, signerId, activity, { followers: true, accounts: [] }, withdraws))
		for (const uri of shared) {
			for (const inbox of receiversOf(db, signerId, uri)) {
				add(inbox, null, null)
			}
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

// Seek the status by unique URI, then its receipts by (signer, status) (RES-7).
const RECEIPTS_OF = `statuses s INDEXED BY ${STATUSES_URI_INDEX}
	CROSS JOIN outbound_receipts r INDEXED BY outbound_receipts_account ON r.status_id = s.id`

// Every inbox that received an object of this signer, or may: its receipts, the rows of earlier activities about it
// in any state (a leased one may have been POSTed already), and their targets not yet expanded.
function receiversOf(db: Db, signerId: string, object: string): string[] {
	const receipts = db.all<{ inbox: string }>(
		`SELECT r.inbox_url AS inbox FROM ${RECEIPTS_OF} WHERE s.uri = ? AND r.account_id = ?`,
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
// options.withdraws: a Reject that ends an accepted follow, a retraction (outboundKind). options.audienceOnly: a
// retraction sent to its audience alone, not to the earlier receivers of what it withdraws (R38's severing Reject,
// blocks.ts endFollow: a Follow's Reject matters to the follower's server only, at its current inbox, as Mastodon's
// RejectFollowService sends it).
export function enqueueActivity(
	db: Db,
	signerId: string,
	envelope: DeliveryEnvelope,
	now: number,
	options: { withdraws?: boolean; audienceOnly?: boolean } = {}
): void {
	const found = targetsOf(
		db,
		signerId,
		envelope.activity,
		envelope.audience,
		options.withdraws === true,
		envelope.reachOf ?? [],
		options.audienceOnly !== true
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
// An activity superseded already is final (superseded, staged NULL), so it is not written again.
const SUPERSEDED = `account_id = ? AND object_uri = ? AND superseded = 0
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

// The unsuperseded activities about an object, below an intent id, through outbound_activities_unsuperseded (migration
// 0045_remote_suspension), whose WHERE term SUPERSEDED names: a seek that never reads the superseded history, under
// stale statistics too (RES-7).
const UNSUPERSEDED_BELOW = `outbound_activities INDEXED BY outbound_activities_unsuperseded
	WHERE ${SUPERSEDED} AND id < CAST(?6 AS INTEGER)`

// The highest intent id there can be: supersedeEarlier's bound when it has none.
const NO_INTENT_BOUND = '9223372036854775807'

// Supersedes at most `limit` of the earlier activities about `object` that a retraction of it by `signerId` would
// (supersede), oldest first, each an update and at most one delete; returns whether any is left. `below`: only those
// recorded before the intent with this id (a retraction recorded already, which SUPERSEDED matches too). R38's
// severing works them down this way before recording its Reject (remote-suspension.ts), so that the Reject's own
// supersede writes nothing; a local status's Delete before recording itself, and its job after (inbox.ts).
export function supersedeEarlier(
	db: Db,
	signerId: string,
	object: string,
	limit: number,
	below: string = NO_INTENT_BOUND
): boolean {
	const earlier = db.all<{ id: string }>(
		`SELECT CAST(id AS TEXT) AS id FROM ${UNSUPERSEDED_BELOW} ORDER BY outbound_activities.id LIMIT ?7`,
		signerId,
		object,
		1,
		'[]',
		0,
		below,
		limit
	)
	for (const { id } of earlier) {
		supersedeIntent(db, id)
	}
	return db.first(`SELECT 1 AS x FROM ${UNSUPERSEDED_BELOW} LIMIT 1`, signerId, object, 1, '[]', 0, below) !== undefined
}

// Marks one intent superseded (final: staged cleared too) and drops it if nothing of it is left.
function supersedeIntent(db: Db, id: string): void {
	db.run('UPDATE outbound_activities SET superseded = 1, staged = NULL WHERE id = CAST(? AS INTEGER)', id)
	dropSettledActivity(db, id)
}

// A retraction recorded in bounded steps: a job's Undo of a local boost and a local status's Delete (RES-6), whose
// audience and receipts may be more targets than one batch can write. beginRetraction records the intent, superseding
// the earlier activities about its object, in at most maxRows rows (null, writing nothing, when they do not fit), and
// returns its id; with `superseding` 'bounded' it records the intent alone, in one row, and its caller supersedes the
// earlier activities in bounded steps (supersedeEarlier), before and after it. A forward (FORWARD_SUBJECT) is recorded
// 'bounded' and supersedes nothing. stageRetraction then stages its targets over as many calls as they need and returns
// whether all are written. While it stages, receipts of its object are still recorded (completeDelivery), so an inbox
// an earlier activity reaches meanwhile stays a target, and the intent is kept even with no rows. The caller keeps the
// receipts until it is staged. Its chunks come after those of intents recorded meanwhile: nothing recorded later is
// about the object but another retraction of it. Chunks already written may be expanded before the rest are staged,
// which is harmless.
export function beginRetraction(
	db: Db,
	signerId: string,
	envelope: DeliveryEnvelope,
	now: number,
	maxRows: number,
	superseding: 'all' | 'bounded' = 'all'
): string | null {
	const subject = subjectOf(envelope.activity, false).object
	const object = subject !== null && envelope.audience.shares !== undefined ? forwardSubject(subject) : subject
	const superseded =
		object === null || superseding === 'bounded'
			? { n: 0, headed: 0 }
			: (db.first<{ n: number; headed: number }>(
					`SELECT count(*) AS n, total(retracts = 1 AND staged IS NOT NULL AND staged <> '') AS headed
					FROM outbound_activities WHERE ${SUPERSEDED}`,
					signerId,
					object,
					1,
					'[]',
					0
				) ?? { n: 0, headed: 0 })
	// Each superseded intent is updated and may be dropped, and one still staging may mark its staging ended
	// (outbound_activities_staging_ended); then the intent itself.
	if (2 * superseded.n + superseded.headed + 1 > maxRows) {
		return null
	}
	if (object !== null && superseding === 'all') {
		supersede(db, signerId, object, true)
	}
	return db.first<{ id: string }>(
		`INSERT INTO outbound_activities (account_id, body, object_uri, retracts, staged, created_at)
		VALUES (?, ?, ?, 1, '', ?) RETURNING CAST(id AS TEXT) AS id`,
		signerId,
		JSON.stringify(envelope),
		object,
		now
	)!.id
}

// The id of the retraction of `object` by `signerId` still staging its targets (the one stageRetraction stages), or
// null.
// The oldest retraction of a pair still staging, in id order (the INTEGER key, named so that no TEXT alias orders it)
// within the partial index outbound_activities_staging (migration 0085_retraction_staging), which holds retractions
// still staging only: the pair's other intents, any number of them, are not read (RES-7).
const OLDEST_STAGING = `FROM outbound_activities INDEXED BY outbound_activities_staging
	WHERE account_id = ? AND object_uri = ? AND retracts = 1 AND staged IS NOT NULL ORDER BY outbound_activities.id LIMIT 1`

export function stagingRetraction(db: Db, signerId: string, object: string): string | null {
	return db.first<{ id: string }>(`SELECT CAST(id AS TEXT) AS id ${OLDEST_STAGING}`, signerId, object)?.id ?? null
}

// ---- Staging a retraction (RES-6)
//
// A retraction's targets are what audienceTargets finds, read a source at a time instead of whole: each source is
// walked by its own index from a cursor kept on the staging's row (retraction_stagings, migration
// 0085_retraction_staging), and what it reaches is merged into the staged set (retraction_reach), one row per target
// with the recipients behind it. Once every source is read the set is written out as chunks in its key order and
// deleted as it is written. Each call runs in its caller's savepoint (the job batch's, runJobBatch), so a call that
// throws leaves the staging as it was. A call admits every read before it runs (Gathering.admit) and stops at
// STAGING_READ reads, STAGING_BYTES of returned text and its maxRows, but always consumes its first candidate, so one
// that does not finish consumes a candidate or saves a moved cursor (RES-5); docs/threat-model.md RES-6 states its
// bounds and gaps, and test/retraction-staging.test.ts ("the heap of a staging call") derives its heap.
// The sources, in order: the audience's accounts (by position), the status's mentions, its parent's author, boosters
// and quoters, the poll's voters, the followers (follows.id up to follow_bound, read when the staging began), then for
// its object (a forward: for each of its shares that resolves, and the followers after them) the earlier activities'
// targets not yet expanded, their delivery rows and the receipts, in that order: evidence only moves forward from a
// target to a row to a receipt, so each is read before what it can become (docs/threat-model.md RES-6). Cursors over
// text are account and status ids (18 ASCII digits by their CHECKs, bound back as they are) or a receipt's inbox, which
// is set and compared in SQL only, never bound back from the Worker (DATA-6). A target is admitted by chunked()'s rule
// on what it would be before its row is written, so no row can fail retraction_reach's CHECK; a refused one is logged
// and passed, but a personal copy refused for its inbox is kept as refused, so that the lowest account id behind its
// addressee still decides its inbox. outbound_activities.staged holds the staging's id; any other value starts the
// staging anew.
export const STAGING_READ = 500
export const STAGING_BYTES = 2 * TARGET_CHUNK_BYTES
export const EMIT_BYTES = TARGET_CHUNK_BYTES
// The staging's rows: its row's insert and staged set by the first call; its delete, staged cleared and the intent
// dropped at the end (endStaging). Each call saves its row once more.
const R_HEAD = 2
const R_END = 3
export const STAGE_MIN_ROWS = R_HEAD + R_END + 1

const MIN_INTEGER = '-9223372036854775808'
const BOUND = TARGET_CHUNK_BYTES

type Phase =
	| 'accounts'
	| 'mentions'
	| 'parent'
	| 'boosters'
	| 'quoters'
	| 'voters'
	| 'followers'
	| 'unexpanded'
	| 'deliveries'
	| 'receipts'
	| 'emit'

// Where gathering stands: the phase and its subject (a forward's share by position), whether a share resolved, and the
// phase's cursor: afterId a follow or an earlier intent; afterRow a chunk or a delivery row of it; afterIndex a
// position in the audience's accounts or in that chunk; afterKey an account or status id. A receipt's inbox lives in
// the row's after_key alone.
type Cursor = {
	phase: Phase
	subject: number
	shared: boolean
	afterId: string | null
	afterRow: string | null
	afterIndex: number | null
	afterKey: string | null
}

type Staging = Cursor & { id: string; followBound: string }

// The intent's row as staging reads it: the activity (parsed in the Worker) and the audience's values as SQLite reads
// them from the stored body (json_type, json_extract), the lists left there.
type IntentRow = {
	id: string
	staged: string
	activity: string
	followers_type: string | null
	followers: SqlStorageValue
	status_type: string | null
	status: SqlStorageValue
	distributable: number
	poll_type: string | null
	poll: SqlStorageValue
	shares_type: string | null
}

const INTENT_COLUMNS = `CAST(id AS TEXT) AS id, staged, json_extract(body, '$.activity') AS activity,
	json_type(body, '$.audience.followers') AS followers_type, json_extract(body, '$.audience.followers') AS followers,
	json_type(body, '$.audience.status') AS status_type, json_extract(body, '$.audience.status') AS status,
	json_type(body, '$.audience.distributable') IS 'true' AS distributable,
	json_type(body, '$.audience.pollVoters') AS poll_type, json_extract(body, '$.audience.pollVoters') AS poll,
	json_type(body, '$.audience.shares') AS shares_type`

// Whether a JSON value, as json_type and json_extract give it, is truthy to JavaScript (recipientsFor tests
// audience.followers so).
function truthy(type: string | null, value: SqlStorageValue): boolean {
	switch (type) {
		case 'true':
		case 'object':
		case 'array':
			return true
		case 'integer':
		case 'real':
			return value !== 0
		case 'text':
			return value !== ''
		default:
			return false
	}
}

// What the envelope asks staging to read (recipientsFor, statusAccounts, shareReaches, receiversOf); a value the
// audience leaves undefined is null here (JSON null is bound as NULL).
type Plan = {
	signerId: string
	intentId: string
	kind: OutboundKind
	// to and cc's names (placement): a personal copy goes to an addressed account they do not name.
	addressed: boolean
	named: Set<string>
	// The most UTF-8 bytes of a name past TARGET_CHUNK_BYTES: a uri longer than it can decode to no name.
	namedPast: number
	status: SqlStorageValue | undefined
	distributable: boolean
	pollVoters: SqlStorageValue | undefined
	followers: boolean
	// The subject whose earlier receivers a retraction reaches, or null; a forward has shares (their count) instead.
	object: string | null
	shares: number | null
}

function planOf(db: Db, signerId: string, intent: IntentRow): Plan {
	const activity = JSON.parse(intent.activity) as Activity
	const { object, retracts } = subjectOf(activity, false)
	const forward = intent.shares_type !== null
	const named = [...uris(activity.to), ...uris(activity.cc)]
	return {
		signerId,
		intentId: intent.id,
		kind: outboundKind(activity, false),
		addressed: Array.isArray(activity.to),
		named: new Set(named),
		namedPast: Math.max(0, ...named.map((uri) => utf8.encode(uri).byteLength).filter((n) => n > BOUND)),
		status: intent.status_type === null ? undefined : intent.status,
		distributable: intent.distributable === 1,
		pollVoters: intent.poll_type === null ? undefined : intent.poll,
		followers: truthy(intent.followers_type, intent.followers),
		object: retracts && !forward ? object : null,
		// shareReaches' list as json_each reads it (a scalar is one share), counted once a call.
		shares: forward
			? db.first<{ n: number }>(
					`SELECT count(*) AS n FROM json_each((SELECT o.body FROM main.outbound_activities o
						WHERE o.id = CAST(?1 AS INTEGER)), '$.audience.shares')`,
					intent.id
				)!.n
			: null,
	}
}

// The phase after `phase` in the order above, whether or not it applies.
function successor(plan: Plan, phase: Phase, subject: number): [Phase, number] {
	const forward = plan.shares !== null
	switch (phase) {
		case 'accounts':
			return ['mentions', 0]
		case 'mentions':
			return ['parent', 0]
		case 'parent':
			return ['boosters', 0]
		case 'boosters':
			return ['quoters', 0]
		case 'quoters':
			return ['voters', 0]
		case 'voters':
			return forward ? ['unexpanded', 0] : ['followers', 0]
		case 'followers':
			return forward ? ['emit', 0] : ['unexpanded', 0]
		case 'unexpanded':
			return ['deliveries', subject]
		case 'deliveries':
			return ['receipts', subject]
		case 'receipts':
			return !forward ? ['emit', 0] : subject + 1 < plan.shares! ? ['unexpanded', subject + 1] : ['followers', 0]
		case 'emit':
			return ['emit', 0]
	}
}

function applies(plan: Plan, c: Cursor): boolean {
	switch (c.phase) {
		case 'accounts':
		case 'emit':
			return true
		case 'mentions':
			return plan.status !== undefined
		case 'parent':
		case 'boosters':
		case 'quoters':
			return plan.status !== undefined && plan.distributable
		case 'voters':
			return plan.pollVoters !== undefined
		case 'followers':
			return plan.followers || (plan.shares !== null && c.shared)
		case 'unexpanded':
		case 'deliveries':
		case 'receipts':
			return plan.shares === null ? plan.object !== null && c.subject === 0 : c.subject < plan.shares
	}
}

function advance(plan: Plan, c: Cursor): Cursor {
	let [phase, subject] = successor(plan, c.phase, c.subject)
	for (;;) {
		const next = { ...c, phase, subject, afterId: null, afterRow: null, afterIndex: null, afterKey: null }
		if (applies(plan, next)) {
			return next
		}
		;[phase, subject] = successor(plan, phase, subject)
	}
}

// One target of the staged set as a call gathers it: a personal copy (neutral 0) by its addressee, with the inbox of
// the lowest account id behind it (`from`, as audienceTargets keeps the first in id order), refused when that inbox
// makes it too large for a chunk; a neutral copy by inbox.
type GatheredTarget = {
	neutral: 0 | 1
	key: string
	inbox: string | null
	from: string | null
	refused: boolean
	unknown: boolean
	accounts: Set<string>
}

// One call's gathering: its budgets and what it read.
class Gathering {
	readonly targets = new Map<string, GatheredTarget>()
	// A forward's shares, read lazily from one page a call (stagedList): the page, whose next element is the next
	// subject's, and the subject at `subjectAt` (its share's boost id, null when it resolves to none).
	shareRows: Iterator<{ id: string | null }> | null = null
	subjectAt = -1
	subject: string | null = null
	reads = 0
	bytes = 0
	chunkBytes = 0
	oversized = 0
	stopped = false
	// Receipts entered in this call and no cursor of theirs saved yet: the row's after_key is not theirs.
	receiptsFresh = false
	// Rows kept for an immediate write still to come (a receipts page's cursor).
	reserve = 0
	#spent: number

	constructor(
		readonly db: Db,
		readonly plan: Plan,
		readonly staging: Staging,
		readonly budget: RowBudget
	) {
		this.#spent = budget.spent()
	}

	// Whether a read may run: the call is not stopped and has read fewer than STAGING_READ raw candidates.
	open(): boolean {
		return !this.stopped && this.reads < STAGING_READ
	}

	// The one rule of a call's reads, checked before each: a seek, a statement's first row (or its finding none) and
	// each further row a page yields count one each, and none runs once STAGING_READ have; else the call stops.
	admit(): boolean {
		if (!this.open()) {
			this.stopped = true
			return false
		}
		this.reads++
		return true
	}

	// Whether n more rows fit with every target gathered so far written, the reserve and the row saved.
	fits(n: number): boolean {
		return this.#spent + this.targets.size + this.reserve + n + 1 <= this.budget.limit
	}

	// An immediate write (a receipt's cursor or deletion), admitted beforehand (its reserve released first).
	write(run: () => void): boolean {
		this.reserve = 0
		if (!this.fits(1)) {
			this.stopped = true
			return false
		}
		run()
		this.#spent = this.budget.spent()
		return true
	}

	// Consumes one candidate row of `bytes` projected bytes that reaches `target` (null: none); `refused` counts one
	// that chunked() would refuse. False, consuming nothing, when a budget stops the call: the text returned is past
	// STAGING_BYTES (so the first candidate of a call is always consumed, whatever its size), or its target does not
	// fit the rows left.
	take(
		bytes: number,
		target: Omit<GatheredTarget, 'accounts'> | null,
		recipient: string | null,
		refused = false
	): boolean {
		if (this.bytes >= STAGING_BYTES) {
			this.stopped = true
			return false
		}
		const id = target === null ? null : `${target.neutral}\n${target.key}`
		const seen = id === null ? undefined : this.targets.get(id)
		if (id !== null && seen === undefined && !this.fits(1)) {
			this.stopped = true
			return false
		}
		this.bytes += bytes
		if (refused) {
			this.oversized++
		}
		if (target === null || id === null) {
			return true
		}
		const into = seen ?? { ...target, accounts: new Set<string>() }
		this.targets.set(id, into)
		if (seen !== undefined && target.from !== null && (into.from === null || target.from < into.from)) {
			into.inbox = target.inbox
			into.from = target.from
			into.refused = target.refused
		}
		into.unknown ||= target.unknown
		if (recipient !== null && !into.unknown) {
			addCapped(into.accounts, recipient)
		}
		return true
	}
}

const utf8 = new TextEncoder()

// Whether a target of `size` bytes (its JSON's UTF-8 bytes and a comma) fits a chunk on its own: chunked()'s rule.
function fitsAlone(size: number): boolean {
	return size + 2 <= TARGET_CHUNK_BYTES
}

// chunked()'s admission of one target, on its addressing alone (its provenance is decided at write-out).
function targetFits(target: Target): boolean {
	return fitsAlone(utf8.encode(JSON.stringify(target)).byteLength + 1)
}

// A projected value: its text and the bytes it returned, or null with `over` when it is text longer than the bound
// (none returned).
function projected(value: string | null, bytes: number | null): { value: string | null; over: boolean; bytes: number } {
	return { value, over: value === null && bytes !== null, bytes: value === null ? 0 : (bytes ?? 0) }
}

// An addressed account as targetsOf reaches it (placement): a personal copy at its own inbox when the activity
// addresses accounts and does not name it, else a neutral copy at REACH_INBOX, whatever its uri. Every value returned
// is charged, the row's a recipient or not, with the uri read for a name past the bound, once, as the row is consumed.
function takeAccount(g: Gathering, row: StagedAccount): boolean {
	const uri = projected(row.uri, row.uri_bytes)
	const inbox = projected(row.inbox_url, row.inbox_url_bytes)
	const reach = projected(row.reach, row.reach_bytes)
	let bytes = uri.bytes + inbox.bytes + reach.bytes
	if (row.id === null) {
		return g.take(bytes, null, null)
	}
	let personal = false
	if (g.plan.addressed) {
		if (uri.value !== null) {
			personal = !g.plan.named.has(uri.value)
		} else if (!uri.over) {
			// No text: no addressee to name or address.
			return g.take(bytes, null, null)
		} else {
			const named = namedPast(g, row.id, row.uri_bytes!)
			if (named === undefined) {
				return false
			}
			bytes += named.bytes
			personal = !named.named
		}
	}
	if (!personal) {
		return takeInbox(g, bytes, reach, row.id)
	}
	if (uri.value === null) {
		// Its addressee is past the bound: chunked() refuses any copy of it.
		return g.take(bytes, null, null, true)
	}
	const at = isDeliverableInbox(inbox.value) ? inbox.value : ''
	const fits = !inbox.over && targetFits({ inbox: at, addressee: uri.value })
	if (!fits && !targetFits({ inbox: '', addressee: uri.value })) {
		return g.take(bytes, null, null, true)
	}
	return g.take(
		bytes,
		{ neutral: 0, key: uri.value, inbox: fits ? at : '', from: row.id, refused: !fits, unknown: false },
		row.id,
		!fits
	)
}

// Whether a uri past the bound decodes to one of to and cc's names (placement compares decoded strings), and the bytes
// it read: read only when a name is as long (decoding only lengthens a malformed byte), first in a call or within
// STAGING_BYTES, one seek admitted; undefined when the call stops first. Its bytes are charged with its row's.
function namedPast(g: Gathering, id: string, bytes: number): { named: boolean; bytes: number } | undefined {
	if (bytes > g.plan.namedPast) {
		return { named: false, bytes: 0 }
	}
	if ((g.bytes > 0 && g.bytes + bytes > STAGING_BYTES) || !g.admit()) {
		g.stopped = true
		return undefined
	}
	const uri = g.db.first<{ uri: string }>(
		`SELECT uri FROM main.accounts INDEXED BY ${ACCOUNTS_ID_INDEX} WHERE id = ?1 AND typeof(uri) = 'text'`,
		id
	)?.uri
	return { named: uri !== undefined && g.plan.named.has(uri), bytes }
}

// A neutral copy at `inbox`, for `recipient` (null: an earlier receiver, unknown).
function takeInbox(
	g: Gathering,
	bytes: number,
	inbox: { value: string | null; over: boolean },
	recipient: string | null
): boolean {
	if (inbox.over || (isDeliverableInbox(inbox.value) && !targetFits({ inbox: inbox.value, addressee: null }))) {
		return g.take(bytes, null, null, true)
	}
	if (!isDeliverableInbox(inbox.value)) {
		return g.take(bytes, null, null)
	}
	return g.take(
		bytes,
		{ neutral: 1, key: inbox.value, inbox: null, from: null, refused: false, unknown: recipient === null },
		recipient
	)
}

// Runs one page under the call's rule (admit): its LIMIT at the reads left, each row pulled only once admitted, so a
// read a row's consumption makes (a nested seek) is counted before the next row is; consumes its rows and returns
// whether it exhausted its walk (every row consumed, fewer than its limit, or all of a statement that returns one row
// at most: `single`).
function consumePage<R>(
	g: Gathering,
	read: (limit: number) => Iterable<R>,
	take: (row: R) => boolean,
	single = false
): boolean {
	if (!g.admit()) {
		return false
	}
	const limit = STAGING_READ - g.reads + 1
	const rows = read(limit)[Symbol.iterator]()
	try {
		for (let n = 0; ; n++) {
			if (n > 0 && !g.admit()) {
				return false
			}
			const step = rows.next()
			if (step.done === true) {
				return single || n < limit
			}
			if (!take(step.value)) {
				return false
			}
		}
	} finally {
		// A page left before its end is closed, as a for-of loop closes it.
		rows.return?.()
	}
}

// The audience's accounts by position: each element that can be an account id sought by its key (one read admitted).
function stepAccounts(g: Gathering, c: Cursor): boolean {
	const start = c.afterIndex ?? 0
	let consumed = 0
	const { kind, signerId, intentId } = g.plan
	const exhausted = consumePage(
		g,
		(limit) => stagedList(g.db, intentId, '$.audience.accounts', start, limit),
		(element) => {
			let taken: boolean
			if (element.id === null) {
				taken = g.take(0, null, null)
			} else if (!g.admit()) {
				return false
			} else {
				const row = stagedAccount(g.db, kind, signerId, element.id, BOUND)
				taken = row === undefined ? g.take(0, null, null) : takeAccount(g, row)
			}
			if (taken) {
				consumed++
			}
			return taken
		}
	)
	c.afterIndex = start + consumed
	return exhausted
}

// A walk keyed by an account or status id (afterKey).
function stepKeyed(g: Gathering, c: Cursor, read: (after: string, limit: number) => Iterable<StagedAccount>): boolean {
	return consumePage(
		g,
		(limit) => read(c.afterKey ?? '', limit),
		(row) => {
			if (!takeAccount(g, row)) {
				return false
			}
			c.afterKey = row.key
			return true
		}
	)
}

// A walk of reached inboxes (followers, voters).
function stepInboxes(g: Gathering, read: (limit: number) => Iterable<StagedInbox>, update: (row: StagedInbox) => void) {
	return consumePage(g, read, (row) => {
		const inbox = projected(row.inbox, row.inbox_bytes)
		const taken = row.id === null ? g.take(inbox.bytes, null, null) : takeInbox(g, inbox.bytes, inbox, row.id)
		if (taken) {
			update(row)
		}
		return taken
	})
}

// `column` past the cursor `param` (TEXT, DATA-6), or from the lowest INTEGER when there is none (bound: MIN_INTEGER).
function pastSql(column: string, param: string, after: string | null): string {
	return `${column} ${after === null ? '>=' : '>'} CAST(${param} AS INTEGER)`
}

// The subject whose evidence is read: the retraction's object, by its uri, or a forward's share, by its boost's id (its
// uri stays in SQL, subjectUriSql); `param` is bound as the statement's subject.
type Subject = { param: SqlStorageValue; byId: boolean }

function subjectUriSql(s: Subject, n: string): string {
	return s.byId ? `(SELECT s.uri FROM main.statuses s INDEXED BY ${STATUSES_ID_INDEX} WHERE s.id = ${n})` : n
}

// The next earlier activity about the subject by the signer past the intent `after`, through outbound_activities_object
// in id order (RES-7), and whether it retracts: one seek, admitted.
function nextIntent(
	g: Gathering,
	subject: Subject,
	after: string | null
): { id: string; retracts: number } | null | undefined {
	if (!g.admit()) {
		return undefined
	}
	return (
		g.db.first<{ id: string; retracts: number }>(
			`SELECT CAST(id AS TEXT) AS id, retracts FROM outbound_activities INDEXED BY outbound_activities_object
			WHERE account_id = ?1 AND object_uri = ${subjectUriSql(subject, '?2')} AND ${pastSql('id', '?3', after)}
			ORDER BY outbound_activities.id LIMIT 1`,
			g.plan.signerId,
			subject.param,
			after ?? MIN_INTEGER
		) ?? null
	)
}

// The walk of the earlier activities about the subject, each that does not retract (receiversOf) walked by `within`
// from the cursor's afterRow (and afterIndex), which returns whether it is exhausted. Whether an intent retracts is
// read before its rows are, by its key (one seek admitted when a call resumes at it), so no walk of an earlier
// retraction's rows or targets runs.
function stepIntents(g: Gathering, c: Cursor, subject: Subject, within: () => boolean): boolean {
	let done = c.afterId === null
	if (!done) {
		if (!g.admit()) {
			return false
		}
		done =
			g.db.first<{ retracts: number }>(
				'SELECT retracts FROM outbound_activities WHERE id = CAST(?1 AS INTEGER)',
				c.afterId
			)?.retracts !== 0
	}
	for (;;) {
		if (done) {
			const next = nextIntent(g, subject, c.afterId)
			if (next === undefined) {
				return false
			}
			if (next === null) {
				return true
			}
			c.afterId = next.id
			c.afterRow = null
			c.afterIndex = null
			done = next.retracts !== 0
			continue
		}
		done = within()
		if (!done) {
			return false
		}
	}
}

// The targets not yet expanded of the intent c.afterId, from the cursor: afterRow null, its first chunk; afterIndex
// set, the chunk afterRow from that position; afterIndex null, the chunk after afterRow. Each chunk's elements are read
// as receiversOf reads them (json_each, json_extract of $.inbox, at or past `next`), in SQL, which parses at most
// STAGING_BYTES of chunks a call beyond the first.
function stepChunks(g: Gathering, c: Cursor): boolean {
	for (;;) {
		if (!g.admit()) {
			return false
		}
		const op = c.afterRow !== null && c.afterIndex === null ? '>' : '>='
		const chunk = g.db.first<{ id: string; bytes: number }>(
			`SELECT CAST(id AS TEXT) AS id, length(CAST(targets AS BLOB)) AS bytes
			FROM outbound_targets INDEXED BY outbound_targets_activity
			WHERE activity_id = CAST(?1 AS INTEGER) AND id ${op} CAST(?2 AS INTEGER)
			ORDER BY outbound_targets.id LIMIT 1`,
			c.afterId,
			c.afterRow ?? MIN_INTEGER
		)
		if (chunk === undefined) {
			return true
		}
		if (g.chunkBytes > 0 && g.chunkBytes + chunk.bytes > STAGING_BYTES) {
			g.stopped = true
			return false
		}
		g.chunkBytes += chunk.bytes
		const from = chunk.id === c.afterRow && c.afterIndex !== null ? c.afterIndex : 0
		let next = from
		const exhausted = consumePage(
			g,
			(limit) =>
				g.db.iterate<{ key: number; inbox: string | null; inbox_bytes: number | null }>(
					`SELECT t.key, ${projectedSql("json_extract(t.value, '$.inbox')", 'inbox', '?4')}
					FROM json_each((SELECT c.targets FROM outbound_targets c WHERE c.id = CAST(?1 AS INTEGER))) t
					WHERE t.key >= (SELECT c.next FROM outbound_targets c WHERE c.id = CAST(?1 AS INTEGER)) AND t.key >= ?2
					LIMIT ?3`,
					chunk.id,
					from,
					limit,
					BOUND
				),
			(row) => {
				const inbox = projected(row.inbox, row.inbox_bytes)
				if (!takeInbox(g, inbox.bytes, inbox, null)) {
					return false
				}
				next = row.key + 1
				return true
			}
		)
		c.afterRow = chunk.id
		c.afterIndex = exhausted ? null : next
		if (!exhausted) {
			return false
		}
	}
}

// The delivery rows of the intent c.afterId past the row c.afterRow, in every state (a leased one may be POSTed).
function stepRows(g: Gathering, c: Cursor): boolean {
	return consumePage(
		g,
		(limit) =>
			g.db.iterate<{ id: string; inbox: string | null; inbox_bytes: number | null }>(
				`SELECT CAST(id AS TEXT) AS id, ${projectedSql('inbox_url', 'inbox', '?4')}
				FROM deliveries INDEXED BY deliveries_activity
				WHERE activity_id = CAST(?1 AS INTEGER) AND ${pastSql('id', '?2', c.afterRow)}
				ORDER BY deliveries.id LIMIT ?3`,
				c.afterId,
				c.afterRow ?? MIN_INTEGER,
				limit,
				BOUND
			),
		(row) => {
			const inbox = projected(row.inbox, row.inbox_bytes)
			if (!takeInbox(g, inbox.bytes, inbox, null)) {
				return false
			}
			c.afterRow = row.id
			return true
		}
	)
}

// The receipts of the subject past the cursor in the row's after_key ('' when the phase began in this call), in inbox
// order through outbound_receipts_account (RES-7): ?1 the subject, ?2 the signer, ?5 1 when fresh, ?6 the staging. A
// BLOB inbox (TEXT affinity admits one) sorts after every text and is no inbox: the walk ends before the first.
function receiptsPast(s: Subject): string {
	const from = s.byId
		? `statuses s INDEXED BY ${STATUSES_ID_INDEX}
			CROSS JOIN outbound_receipts r INDEXED BY outbound_receipts_account ON r.status_id = s.id
			WHERE s.id = ?1`
		: `${RECEIPTS_OF} WHERE s.uri = ?1`
	return `FROM ${from} AND r.account_id = ?2 AND r.inbox_url < X''
		AND r.inbox_url > (CASE WHEN ?5 = 1 THEN '' ELSE COALESCE((SELECT h.after_key FROM retraction_stagings h
			WHERE h.id = CAST(?6 AS INTEGER)), '') END)
		ORDER BY r.inbox_url`
}

// The receipts, a page at a time, the cursor saved in SQL after each page that consumed one. A receipt whose inbox is
// longer than TARGET_CHUNK_BYTES can never be a target, and its inbox could not be a cursor (after_key's CHECK): the
// page stops before it, and once it is the first past the cursor it is deleted, counted and logged.
function stepReceipts(g: Gathering, subject: Subject): boolean {
	const past = receiptsPast(subject)
	const status = subject.byId ? '?1' : `(SELECT id FROM statuses INDEXED BY ${STATUSES_URI_INDEX} WHERE uri = ?1)`
	for (;;) {
		const params = (n: number) => [subject.param, g.plan.signerId, n, BOUND, g.receiptsFresh ? 1 : 0, g.staging.id]
		let consumed = 0
		let over = false
		g.reserve = 1
		const exhausted = consumePage(
			g,
			(limit) =>
				g.db.iterate<{ inbox: string | null; inbox_bytes: number | null }>(
					`SELECT ${projectedSql('r.inbox_url', 'inbox', '?4')} ${past} LIMIT ?3`,
					...params(limit)
				),
			(row) => {
				const inbox = projected(row.inbox, row.inbox_bytes)
				if (inbox.over) {
					over = true
					return false
				}
				if (!takeInbox(g, inbox.bytes, inbox, null)) {
					return false
				}
				consumed++
				return true
			}
		)
		if (
			consumed > 0 &&
			!g.write(() =>
				g.db.run(
					`UPDATE retraction_stagings SET after_key = (SELECT r.inbox_url ${past} LIMIT 1 OFFSET ?3)
					WHERE id = CAST(?6 AS INTEGER)`,
					...params(consumed - 1)
				)
			)
		) {
			return false
		}
		g.reserve = 0
		if (consumed > 0) {
			g.receiptsFresh = false
		}
		if (!over) {
			return exhausted
		}
		const deleted = g.write(() =>
			g.db.run(
				`DELETE FROM outbound_receipts WHERE status_id = ${status}
					AND inbox_url = (SELECT r.inbox_url ${past} LIMIT 1) AND length(CAST(inbox_url AS BLOB)) > ?4`,
				...params(0)
			)
		)
		if (!deleted) {
			return false
		}
		g.oversized++
	}
}

// The subject the cursor names: the retraction's object, or a forward's share by position (shareReaches' rule; one that
// does not resolve, null, is passed). A forward's shares are pulled one at a time from one page a call, so resolving a
// share reads it alone (a page row and its boost's seek), and its evidence is read in the same call. A share that
// resolves is recorded (shared), so its followers are read after the shares. Undefined when the call stops first.
function evidenceSubject(g: Gathering, c: Cursor): Subject | null | undefined {
	if (g.plan.shares === null) {
		return { param: g.plan.object, byId: false }
	}
	if (g.subjectAt !== c.subject) {
		// The subject's element, admitted: the page's first, or its next (a subject keeps its position through its
		// three phases, then the next position follows, and a resumed call starts a page of its own).
		if (!g.admit()) {
			return undefined
		}
		g.shareRows ??= stagedList(g.db, g.plan.intentId, '$.audience.shares', c.subject, STAGING_READ - g.reads + 1)[
			Symbol.iterator
		]()
		const step = g.shareRows.next()
		if (step.done === true) {
			g.shareRows = null
		}
		let id = step.done === true ? null : step.value.id
		if (id !== null) {
			if (!g.admit()) {
				return undefined
			}
			id = stagedBoost(g.db, g.plan.signerId, id) ? id : null
		}
		g.subjectAt = c.subject
		g.subject = id
	}
	if (g.subject === null) {
		return null
	}
	c.shared = true
	return { param: g.subject, byId: true }
}

function step(g: Gathering, c: Cursor): boolean {
	const { kind, signerId } = g.plan
	const status = g.plan.status ?? null
	switch (c.phase) {
		case 'accounts':
			return stepAccounts(g, c)
		case 'mentions':
			return stepKeyed(g, c, (after, limit) => stagedMentions(g.db, kind, signerId, status, after, limit, BOUND))
		case 'parent':
			return consumePage(
				g,
				() => stagedParent(g.db, kind, signerId, status, BOUND),
				(row) => takeAccount(g, row),
				true
			)
		case 'boosters':
			return stepKeyed(g, c, (after, limit) => stagedBoosters(g.db, kind, signerId, status, after, limit, BOUND))
		case 'quoters':
			return stepKeyed(g, c, (after, limit) => stagedQuoters(g.db, kind, signerId, status, after, limit, BOUND))
		case 'voters':
			return stepInboxes(
				g,
				(limit) => stagedVoters(g.db, kind, signerId, g.plan.pollVoters ?? null, c.afterKey ?? '', limit, BOUND),
				(row) => (c.afterKey = row.key)
			)
		case 'followers':
			return stepInboxes(
				g,
				(limit) => stagedFollowers(g.db, kind, signerId, c.afterId, g.staging.followBound, limit, BOUND),
				(row) => (c.afterId = row.key)
			)
		case 'unexpanded':
		case 'deliveries':
		case 'receipts': {
			const subject = evidenceSubject(g, c)
			if (subject === undefined) {
				return false
			}
			if (subject === null) {
				return true
			}
			if (c.phase === 'receipts') {
				return stepReceipts(g, subject)
			}
			return stepIntents(g, c, subject, () => (c.phase === 'unexpanded' ? stepChunks(g, c) : stepRows(g, c)))
		}
		case 'emit':
			return true
	}
}

// Reads from the staging's cursor until a budget stops the call or gathering ends (phase emit), and closes the page of
// shares it kept open across steps.
function gather(g: Gathering, start: Cursor): Cursor {
	let c: Cursor = { ...start }
	g.receiptsFresh = false
	try {
		while (c.phase !== 'emit' && g.open()) {
			if (!applies(g.plan, c) || step(g, c)) {
				c = advance(g.plan, c)
				g.receiptsFresh = c.phase === 'receipts'
			}
		}
	} finally {
		g.shareRows?.return?.()
		g.shareRows = null
	}
	return c
}

// The account ids a staged row holds: its CHECK bounds the JSON, and an imported one may hold other values, which are
// dropped so that a merge with PROVENANCE_MAX + 1 ids of 18 digits always fits that CHECK.
function storedIds(accounts: string): string[] {
	const parsed = JSON.parse(accounts) as unknown[]
	return parsed.filter((id): id is string => typeof id === 'string' && /^[0-9]{18}$/.test(id))
}

// Merges what the call gathered into the staged set: each target read by its key and written only when it changed. A
// row whose recipients are unknown, or past PROVENANCE_MAX, takes no more of them, so it is not written again; a
// personal copy takes the inbox (and refusal) of a lower account id behind it.
function flush(g: Gathering): void {
	for (const t of g.targets.values()) {
		// The stored inbox stays in SQL: only whose it is is read.
		const stored = g.db.first<{ inbox_account: string | null; accounts: string; unknown: number }>(
			`SELECT inbox_account, accounts, unknown FROM retraction_reach
			WHERE staging_id = CAST(?1 AS INTEGER) AND neutral = ?2 AND key = ?3`,
			g.staging.id,
			t.neutral,
			t.key
		)
		const before = stored === undefined ? [] : storedIds(stored.accounts)
		const unknown = stored?.unknown === 1 || t.unknown
		const accounts = new Set(before)
		if (!unknown) {
			for (const id of t.accounts) {
				addCapped(accounts, id)
			}
		}
		const replaces =
			t.from !== null && (stored === undefined || stored.inbox_account === null || t.from < stored.inbox_account)
		if (stored !== undefined && (stored.unknown === 1) === unknown && accounts.size === before.length && !replaces) {
			continue
		}
		g.db.run(
			`INSERT INTO retraction_reach (staging_id, neutral, key, inbox, inbox_account, refused, accounts, unknown)
			VALUES (CAST(?1 AS INTEGER), ?2, ?3, ?4, ?5, ?9, ?6, ?7)
			ON CONFLICT (staging_id, neutral, key) DO UPDATE SET
				inbox = CASE WHEN ?8 = 1 THEN excluded.inbox ELSE inbox END,
				inbox_account = CASE WHEN ?8 = 1 THEN excluded.inbox_account ELSE inbox_account END,
				refused = CASE WHEN ?8 = 1 THEN excluded.refused ELSE refused END,
				accounts = excluded.accounts, unknown = excluded.unknown`,
			g.staging.id,
			t.neutral,
			t.key,
			t.inbox,
			t.from,
			JSON.stringify([...accounts]),
			unknown ? 1 : 0,
			replaces ? 1 : 0,
			t.refused ? 1 : 0
		)
	}
}

// The staging the intent's staged names: its id in canonical form, of this intent, not ended.
function stagingOf(db: Db, intent: { id: string; staged: string }): Staging | undefined {
	const row = db.first<{
		id: string
		follow_bound: string
		phase: Phase
		subject: string
		shared: number
		after_id: string | null
		after_row: string | null
		after_index: string | null
		after_key: string | null
	}>(
		`SELECT CAST(id AS TEXT) AS id, CAST(follow_bound AS TEXT) AS follow_bound, phase, CAST(subject AS TEXT) AS subject,
			shared, CAST(after_id AS TEXT) AS after_id, CAST(after_row AS TEXT) AS after_row,
			CAST(after_index AS TEXT) AS after_index, CASE WHEN phase = 'receipts' THEN NULL ELSE after_key END AS after_key
		FROM retraction_stagings
		WHERE id = CAST(?1 AS INTEGER) AND CAST(id AS TEXT) = ?1 AND activity_id = CAST(?2 AS INTEGER) AND ended = 0`,
		intent.staged,
		intent.id
	)
	if (row === undefined) {
		return undefined
	}
	return {
		id: row.id,
		followBound: row.follow_bound,
		phase: row.phase,
		subject: Number(row.subject),
		shared: row.shared === 1,
		afterId: row.after_id,
		afterRow: row.after_row,
		afterIndex: row.after_index === null ? null : Number(row.after_index),
		afterKey: row.after_key,
	}
}

// A staging begins (R_HEAD): its row, with the follows it reads frozen at the highest follow id, and staged naming it.
function beginStaging(db: Db, intentId: string): Staging {
	const row = db.first<{ id: string; follow_bound: string }>(
		`INSERT INTO retraction_stagings (activity_id, follow_bound, phase)
		VALUES (CAST(?1 AS INTEGER), (SELECT COALESCE(max(id), 0) FROM follows), 'accounts')
		RETURNING CAST(id AS TEXT) AS id, CAST(follow_bound AS TEXT) AS follow_bound`,
		intentId
	)!
	db.run('UPDATE outbound_activities SET staged = ?1 WHERE id = CAST(?2 AS INTEGER)', row.id, intentId)
	return {
		id: row.id,
		followBound: row.follow_bound,
		phase: 'accounts',
		subject: 0,
		shared: false,
		afterId: null,
		afterRow: null,
		afterIndex: null,
		afterKey: null,
	}
}

// Saves the cursor, writing the row only when a value changed (no unchanged write counts as progress). A receipts
// cursor is the row's own (set in SQL by stepReceipts) and kept, unless the phase began in this call and saved none.
function saveCursor(db: Db, stagingId: string, c: Cursor, receiptsFresh: boolean): void {
	const keep = c.phase === 'receipts' && !receiptsFresh ? 1 : 0
	db.run(
		`UPDATE retraction_stagings SET phase = ?2, subject = CAST(?3 AS INTEGER), shared = ?4,
			after_id = CAST(?5 AS INTEGER), after_row = CAST(?6 AS INTEGER), after_index = CAST(?7 AS INTEGER),
			after_key = CASE WHEN ?9 = 1 THEN after_key ELSE ?8 END
		WHERE id = CAST(?1 AS INTEGER) AND (phase IS NOT ?2 OR subject IS NOT CAST(?3 AS INTEGER) OR shared IS NOT ?4
			OR after_id IS NOT CAST(?5 AS INTEGER) OR after_row IS NOT CAST(?6 AS INTEGER)
			OR after_index IS NOT CAST(?7 AS INTEGER) OR (?9 = 0 AND after_key IS NOT ?8))`,
		stagingId,
		c.phase,
		String(c.subject),
		c.shared ? 1 : 0,
		c.afterId,
		c.afterRow,
		c.afterIndex === null ? null : String(c.afterIndex),
		c.phase === 'receipts' ? null : c.afterKey,
		keep
	)
}

// The staged set's first rows in key order (personal copies first), consumed while the JSON of their keys and inboxes
// is within EMIT_BYTES, then written as chunks while they fit `room` rows: each chunk prefix costs the rows it
// consumed (refused ones too) plus its chunks. A row refused at gathering, or whose key's and inbox's JSON (json_quote,
// which a decoded value's JSON only lengthens) is past TARGET_CHUNK_BYTES, can never be a target: it stays in SQL and
// is consumed, counted and logged. The rows consumed are deleted through the last one written (a range in SQL, its
// bound read there: no key is bound back from the Worker). Returns whether the set is empty.
function writeOut(db: Db, stagingId: string, intentId: string, room: number): boolean {
	const limit = Math.min(STAGING_READ, room - 1)
	// The page's rows, null for one that is no target, and the targets with their row's position.
	let rows = 0
	const targets: Target[] = []
	const rowOf: number[] = []
	let bytes = 0
	let cut = false
	let refused = 0
	for (const row of db.iterate<{
		neutral: number
		key: string | null
		inbox: string | null
		accounts: string
		unknown: number
		json: number
		refused: number
	}>(
		`SELECT neutral, accounts, unknown, json, refused,
			CASE WHEN refused = 0 AND json <= ?3 THEN key END AS key, CASE WHEN refused = 0 AND json <= ?3 THEN inbox END AS inbox
		FROM (SELECT neutral, key, inbox, refused, accounts, unknown,
				length(CAST(json_quote(key) AS BLOB)) + length(CAST(json_quote(COALESCE(inbox, '')) AS BLOB)) AS json
			FROM retraction_reach WHERE staging_id = CAST(?1 AS INTEGER) ORDER BY neutral, key LIMIT ?2) w
		ORDER BY w.neutral, w.key`,
		stagingId,
		limit,
		BOUND
	)) {
		if (bytes >= EMIT_BYTES) {
			cut = true
			break
		}
		rows++
		if (row.key === null) {
			refused += row.refused === 1 ? 0 : 1
			continue
		}
		bytes += row.json
		const provenance = stagedProvenance(row.unknown === 1, storedIds(row.accounts))
		rowOf.push(rows - 1)
		targets.push(
			row.neutral === 0
				? { inbox: row.inbox ?? '', addressee: row.key, ...provenance }
				: { inbox: row.key, addressee: null, ...provenance }
		)
	}
	if (refused > 0) {
		console.warn({ event: 'kopje.delivery.oversized_target', count: refused })
	}
	if (rows === 0) {
		return true
	}
	const chunks = chunked(targets)
	let taken = 0
	let through = 0
	for (const chunk of chunks) {
		const consumed = rowOf[chunk.last]! + 1
		if (consumed + taken + 1 > room) {
			break
		}
		taken++
		through = consumed
	}
	// Past the last chunk, the rows no chunk holds go too when their deletes fit.
	if (taken === chunks.length && rows + taken <= room) {
		through = rows
	}
	insertChunks(db, intentId, chunks.slice(0, taken))
	drainStaged(db, stagingId, through)
	return !cut && rows < limit && through === rows
}

// A staged target's provenance (Provenance): its account ids, `many` past PROVENANCE_MAX, none when unknown. Staged
// retractions carry no domains: the send-time check exempts a retraction (sendRefused), and forwardFallback reads the
// accounts alone.
function stagedProvenance(unknown: boolean, accounts: string[]): Provenance {
	if (unknown) {
		return {}
	}
	return accounts.length > PROVENANCE_MAX ? { many: true } : { accounts: [...accounts].sort() }
}

// Deletes the first n rows of the staged set in key order, personal copies first: in each half (neutral) a range of
// the primary key through a bound read in SQL by its offset, or through its last key when it holds fewer.
function drainStaged(db: Db, stagingId: string, n: number): void {
	let left = n
	for (const neutral of [0, 1]) {
		if (left <= 0) {
			return
		}
		left -= db.run(
			`DELETE FROM retraction_reach WHERE staging_id = CAST(?1 AS INTEGER) AND neutral = ?2 AND key <= COALESCE(
				(SELECT key FROM retraction_reach WHERE staging_id = CAST(?1 AS INTEGER) AND neutral = ?2 ORDER BY key
					LIMIT 1 OFFSET ?3),
				(SELECT max(key) FROM retraction_reach WHERE staging_id = CAST(?1 AS INTEGER) AND neutral = ?2))`,
			stagingId,
			neutral,
			left - 1
		)
	}
}

// The oldest retraction of `object` by `signerId` still staging (OLDEST_STAGING), or with intentId that intent, sought
// by its key (+retracts: never through outbound_activities_staging) and checked to be signerId's retraction of `object`
// still staging (a forward, inbox.ts stageForwards): stages what fits maxRows and returns whether all its targets are
// written and the intent released (true, too, when there is none). Below STAGE_MIN_ROWS it writes nothing and returns
// false.
export function stageRetraction(db: Db, signerId: string, object: string, maxRows: number, intentId?: string): boolean {
	const intent = db.first<IntentRow>(
		intentId === undefined
			? `SELECT ${INTENT_COLUMNS} ${OLDEST_STAGING}`
			: `SELECT ${INTENT_COLUMNS} FROM outbound_activities
				WHERE id = CAST(?3 AS INTEGER) AND account_id = ?1 AND object_uri = ?2 AND +retracts = 1 AND staged IS NOT NULL`,
		signerId,
		object,
		...(intentId === undefined ? [] : [intentId])
	)
	if (intent === undefined) {
		return true
	}
	if (maxRows < STAGE_MIN_ROWS) {
		return false
	}
	const budget = new RowBudget(db, maxRows)
	const plan = planOf(db, signerId, intent)
	let staging = stagingOf(db, intent) ?? beginStaging(db, intent.id)
	if (staging.phase !== 'emit') {
		const g = new Gathering(db, plan, staging, budget)
		const cursor = gather(g, staging)
		flush(g)
		saveCursor(db, staging.id, cursor, g.receiptsFresh)
		if (g.oversized > 0) {
			console.warn({ event: 'kopje.delivery.oversized_target', count: g.oversized })
		}
		staging = { ...staging, ...cursor }
	}
	if (staging.phase !== 'emit') {
		return false
	}
	const room = maxRows - budget.spent() - R_END
	if (room < 2 || !writeOut(db, staging.id, intent.id, room)) {
		return false
	}
	db.run('DELETE FROM retraction_stagings WHERE id = CAST(? AS INTEGER)', staging.id)
	endStaging(db, intent.id)
	return true
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
	insertChunks(db, intentId, chunks)
	return chunks.length
}

// Releases a staged intent: no more targets come, and it goes once its rows are settled.
export function endStaging(db: Db, intentId: string): void {
	db.run('UPDATE outbound_activities SET staged = NULL WHERE id = CAST(? AS INTEGER) AND staged IS NOT NULL', intentId)
	dropSettledActivity(db, intentId)
}

// The targets as JSON arrays of at most TARGET_CHUNK_SIZE targets and TARGET_CHUNK_BYTES each, with the index of
// the last target each holds. A target too large for a chunk on its own (the URL caps at ingestion keep remote ones
// far below it; an imported or older row may not be) is left out, counted and logged without its value (DATA-5).
function chunked(targets: Target[]): { json: string; last: number }[] {
	const chunks: { json: string; last: number }[] = []
	let current: string[] = []
	let bytes = 2
	let last = -1
	let oversized = 0
	targets.forEach((target, index) => {
		const json = JSON.stringify(target)
		const size = utf8.encode(json).byteLength + 1
		if (!fitsAlone(size)) {
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
	const { followPair, ...stored } = envelope
	const intent = db.first<{ id: string }>(
		`INSERT INTO outbound_activities (account_id, body, object_uri, retracts, created_at, follow_pair)
		VALUES (?, ?, ?, ?, ?, ?) RETURNING CAST(id AS TEXT) AS id`,
		signerId,
		JSON.stringify(stored),
		object,
		retracts ? 1 : 0,
		now,
		followPair ?? null
	)!
	insertChunks(db, intent.id, chunks)
}

// Writes chunks (chunked) as the intent's targets still to expand, one row each.
function insertChunks(db: Db, intentId: string, chunks: readonly { json: string }[]): void {
	for (const chunk of chunks) {
		db.run('INSERT INTO outbound_targets (activity_id, targets) VALUES (CAST(? AS INTEGER), ?)', intentId, chunk.json)
	}
}

// Servers (lane origins) with a delivered Create receipt at any inbox. A leased Create does not count: it may give
// up, and an operator's later retry could deliver an older version; send the Create/Update pair even if it succeeds.
// A server may already hold an object it fetched to boost or quote, so this set only controls omissions. Origins are
// the unit: an Update at a personal inbox applies after a Create at the shared inbox; another Create is ignored.
function serversWithObject(db: Db, signerId: string, object: string): Set<string> {
	const receipts = db.all<{ inbox_url: string }>(
		`SELECT r.inbox_url FROM ${RECEIPTS_OF} WHERE s.uri = ? AND r.account_id = ?`,
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
// counted once by the caller, when a row first needs it, and kept up to date. Retractions are never refused: they
// clean up what was already sent, and are bounded by it; admitting only retractions counts nothing, so R38's severing
// rounds, which record many, do not read up to MAX_BACKLOG rows for each.
class Admission {
	#total: number | null = null

	constructor(private readonly db: Db) {}

	admits(accountId: string, lane: string, retracts: boolean): boolean {
		if (retracts) {
			if (this.#total !== null) {
				this.#total++
			}
			return true
		}
		this.#total ??= activeCount(this.db, '1', MAX_BACKLOG)
		const fits =
			this.#total < MAX_BACKLOG &&
			activeCount(this.db, 'account_id = ? AND lane = ?', MAX_LANE_BACKLOG, accountId, lane) < MAX_LANE_BACKLOG
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
export function expandPending(db: Db, now: number, budget: number): void {
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
// Follow answers
// ---------------------------------------------------------------------------------------------------------------

// A remote Follow cancels its pair's answers (Accept, Reject) that no POST of Kopje's can be in flight for, and the
// unexpanded ones (inbox.ts follow): for interoperability with servers that match an answer by account pair, not only
// by the Follow it names (Misskey's UserFollowingService; Mastodon's Accept and Reject fall back to the pair), so a
// stale one would act on the new request. Every row that is not leased goes (queued, pending or given up, claimed
// before or not: a pending row's attempt has completed). A leased row keeps its lane, so the new answer waits behind
// it, and its intent is superseded: the claim, the confirmation and a failed completion drop a superseded answer
// (STALE_ANSWER) instead of sending, retrying or giving it up. Only a POST whose confirmation was granted before the
// Follow committed still goes (the accepted risk in docs/threat-model.md).
//
// Bounds (RES-6): a Follow reads at most FOLLOW_ANSWER_INTENTS + 1 unsettled answers of its pair, and of them
// FOLLOW_ANSWER_ROWS + 1 rows (leased or not) and FOLLOW_ANSWER_CHUNKS + 1 unexpanded chunks; over any bound it is
// refused (followAnswersOf returns null) before anything is written, and the peer delivers it again. An answer has
// one target, so one row or chunk: the intent bound bites first, and the others bound stored rows from elsewhere (an
// imported store). Answers leave the bound as their rows deliver or are cancelled, and as sweepDeliveries deletes the
// given-up rows of superseded ones.
export const FOLLOW_ANSWER_INTENTS = 32
export const FOLLOW_ANSWER_ROWS = 64
export const FOLLOW_ANSWER_CHUNKS = 32

// rows: those not leased, which are cancelled; exposed, whether a claim ever took one.
export type FollowAnswers = {
	intents: string[]
	rows: { id: string; activity_id: string; account_id: string; lane: string; state: string; exposed: number }[]
	chunks: string[]
}

// The discovery's statements (exported for their plan and rows-read tests). Each LIMIT stops an index seek: the
// intents are ordered by the numeric column (`ORDER BY id` would name the text alias and sort the whole backlog), and
// the rows and chunks need no order. The rows name deliveries_activity: statistics older than the Store's growth would
// scan the deliveries (RES-7).
export const FOLLOW_ANSWER_INTENTS_SQL = `SELECT CAST(o.id AS TEXT) AS id
	FROM outbound_activities o INDEXED BY outbound_activities_follow_pair
	WHERE o.account_id = ? AND o.follow_pair = ? ORDER BY o.id LIMIT ?`
export const FOLLOW_ANSWER_ROWS_SQL = `SELECT CAST(id AS TEXT) AS id, CAST(activity_id AS TEXT) AS activity_id,
	account_id, lane, state, exposed
	FROM deliveries INDEXED BY deliveries_activity WHERE activity_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?)) LIMIT ?`
export const FOLLOW_ANSWER_CHUNKS_SQL = `SELECT CAST(id AS TEXT) AS id FROM outbound_targets
	WHERE activity_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?)) LIMIT ?`

// Reads only: the unsettled answers of signerId to followerId, or null over a bound.
export function followAnswersOf(db: Db, signerId: string, followerId: string): FollowAnswers | null {
	const intents = db
		.all<{ id: string }>(FOLLOW_ANSWER_INTENTS_SQL, signerId, followerId, FOLLOW_ANSWER_INTENTS + 1)
		.map((r) => r.id)
	if (intents.length > FOLLOW_ANSWER_INTENTS) {
		return null
	}
	if (intents.length === 0) {
		return { intents, rows: [], chunks: [] }
	}
	const ids = JSON.stringify(intents)
	const rows = db.all<FollowAnswers['rows'][number]>(FOLLOW_ANSWER_ROWS_SQL, ids, FOLLOW_ANSWER_ROWS + 1)
	const chunks = db.all<{ id: string }>(FOLLOW_ANSWER_CHUNKS_SQL, ids, FOLLOW_ANSWER_CHUNKS + 1).map((r) => r.id)
	if (rows.length > FOLLOW_ANSWER_ROWS || chunks.length > FOLLOW_ANSWER_CHUNKS) {
		return null
	}
	return { intents, rows: rows.filter((row) => row.state !== 'leased'), chunks }
}

// Cancels what followAnswersOf found, in the transaction that read it. Every row goes before any lane is promoted, so
// a promotion never picks a row about to be deleted and a lane never has two heads. A cancelled row a claim took is
// logged (staleAnswer, `cancel`): one an earlier attempt may have reached. Its activity is one of found.intents, read
// in this transaction and not deleted before the loop below ends.
export function cancelFollowAnswers(db: Db, found: FollowAnswers, now: number): void {
	for (const row of found.rows) {
		if (row.exposed === 1) {
			const { type } = db.first<{ type: string }>(
				`SELECT ${ANSWER_TYPE} AS type FROM outbound_activities o WHERE o.id = CAST(? AS INTEGER)`,
				row.activity_id
			)!
			staleAnswer(type, 'cancel')
		}
		db.run('DELETE FROM deliveries WHERE id = CAST(? AS INTEGER)', row.id)
	}
	const heads = new Map(found.rows.filter((r) => r.state === 'pending').map((r) => [`${r.account_id} ${r.lane}`, r]))
	for (const head of heads.values()) {
		promoteLane(db, head.account_id, head.lane, now)
	}
	for (const chunk of found.chunks) {
		db.run('DELETE FROM outbound_targets WHERE id = CAST(? AS INTEGER)', chunk)
	}
	for (const intent of found.intents) {
		supersedeIntent(db, intent)
	}
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

// Promotes the oldest queued row of a lane once the lane has no pending or leased row, both read through the lane's
// entries of deliveries_lane (RES-7). Each names the index's own WHERE term (state IN ACTIVE): SQLite uses a partial
// index only for a query that does (https://sqlite.org/partialindex.html#queries_using_partial_indexes).
function promoteLane(db: Db, accountId: string, lane: string, now: number): void {
	db.run(
		`UPDATE deliveries SET state = 'pending', next_attempt_at = ?3, updated_at = ?3
		WHERE id = (SELECT id FROM deliveries INDEXED BY deliveries_lane
				WHERE account_id = ?1 AND lane = ?2 AND state IN ${ACTIVE} AND state = 'queued' ORDER BY id LIMIT 1)
			AND NOT EXISTS (SELECT 1 FROM deliveries INDEXED BY deliveries_lane
				WHERE account_id = ?1 AND lane = ?2 AND state IN ${ACTIVE} AND state IN ('pending', 'leased'))`,
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

// 1 for a follow answer whose intent a later Follow of its pair, or a block's withdrawing Reject, superseded (NET-2),
// else 0 (also with no activity row). It reads only the two stored columns, never the activity's JSON, which an
// imported row may lack. Read with the row, and judged apart from sendRefused, so VIS-30's retraction exemption does
// not cover it: a withdrawing Reject is stale too once a newer Follow supersedes it. superseded is never cleared, and
// the row is read under its lease token, so the check needs no caller time. Its activity is `o`.
const STALE_ANSWER = `(o.follow_pair IS NOT NULL AND o.superseded = 1)`

// The answer's type as logged: Accept or Reject, else 'other' (an imported body with no such type), never null.
const ANSWER_TYPE = `CASE json_extract(o.body, '$.activity.type') WHEN 'Accept' THEN 'Accept' WHEN 'Reject' THEN 'Reject'
	ELSE 'other' END`

// DATA-5: the answer's type (ANSWER_TYPE) and where it was caught, nothing else. `cancel`: a Follow deleted a row a
// claim had taken; `claim`, `confirm`, `failure`: a leased one was dropped instead of being leased again, sent, or
// retried or given up; `sent_in_flight`: one confirmed before it was superseded was delivered. That is local evidence
// that the peer may have applied it after the newer Follow, not an observed disagreement.
function staleAnswer(type: string, at: 'cancel' | 'claim' | 'confirm' | 'failure' | 'sent_in_flight'): void {
	console.warn({ event: 'kopje.delivery.stale_follow_answer', type, at })
}

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
	stale_answer: number
	answer_type: string
}

const DUE_ROW = `CAST(d.id AS TEXT) AS id, CAST(d.activity_id AS TEXT) AS activity_id, d.account_id, d.lane, d.inbox_url,
	d.attempts, d.addressee, d.recipient_accounts, d.recipient_domains, o.id IS NOT NULL AS found, o.retracts,
	${REFUSED_SENDER} AS refused_sender, json_extract(o.body, '$.signedBy') AS signed_by,
	CASE json_extract(o.body, '$.activity.type') WHEN 'Announce' THEN json_extract(o.body, '$.activity.object') END
		AS boosted, ${STALE_ANSWER} AS stale_answer, ${ANSWER_TYPE} AS answer_type`

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
// rule joins accounts, because availableSql reads a missing id as available and a purged recipient must count as gone,
// each recipient sought by id (RES-7).
// An Announce distributes its original, so it is sent only while the original exists and its author is available (R1),
// read live by the original's uri (statuses' unique key): an original deleted since (its author's Delete applies even
// while the author is suspended) or never stored refuses it. No other content activity carries a remote author's
// object (a quote names its quoted status by uri and stamp only).
function sendRefused(db: Db, row: DueRow): boolean {
	if (row.retracts === 1) {
		return false
	}
	if (row.refused_sender === 1) {
		return true
	}
	const host = hostOf(row.inbox_url)
	if (host !== null && hostCovered(db, host)) {
		return true
	}
	if (
		row.recipient_accounts !== null &&
		db.first(
			`SELECT 1 AS yes FROM json_each(?) r CROSS JOIN main.accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = r.value
			WHERE ${availableSql('a.id')} LIMIT 1`,
			row.recipient_accounts
		) === undefined
	) {
		return true
	}
	if (
		row.boosted !== null &&
		db.first(
			`SELECT 1 AS yes FROM main.statuses s WHERE s.uri = ? AND ${availableSql('s.account_id')}`,
			row.boosted
		) === undefined
	) {
		return true
	}
	const domains = row.recipient_domains === null ? [] : (JSON.parse(row.recipient_domains) as string[])
	return domains.length > 0 && domains.every((domain) => hostCovered(db, domain))
}

function dropRow(db: Db, row: LaneRow, now: number): void {
	db.run('DELETE FROM deliveries WHERE id = CAST(? AS INTEGER)', row.id)
	promoteLane(db, row.account_id, row.lane, now)
	dropSettledActivity(db, row.activity_id)
}

// Expands one step, then leases up to `limit` due lane heads (RES-6: a claim reads and returns a bounded number of
// rows). An expired lease is due again; one that has used up its attempts is given up instead of claimed; one the
// send-time check refuses (sendRefused), and a superseded follow answer (STALE_ANSWER), are dropped. What to send is
// read by confirmDelivery.
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
			if (row.stale_answer === 1) {
				dropRow(db, row, now)
				staleAnswer(row.answer_type, 'claim')
				continue
			}
			if (row.attempts >= MAX_ATTEMPTS) {
				giveUp(db, row, now, null, 'lease expired')
				continue
			}
			db.run(
				`UPDATE deliveries SET state = 'leased', lease_token = ?, attempts = attempts + 1, next_attempt_at = ?,
					updated_at = ?, last_error = CASE WHEN state = 'leased' THEN 'lease expired' ELSE last_error END, exposed = 1
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
	// The send-time check refused the row, or it is a superseded follow answer: it is deleted and its lane promoted.
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
		if (row.found === 0 || row.activity === null || row.stale_answer === 1 || sendRefused(db, row)) {
			dropRow(db, row, now)
			if (row.stale_answer === 1) {
				staleAnswer(row.answer_type, 'confirm')
			}
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
	// A superseded follow answer (STALE_ANSWER) that failed: deleted, never retried or given up, its lane promoted.
	| { status: 'dropped' }
	// The lease is no longer this one's: the row was claimed again, settled, or deleted.
	| { status: 'stale' }
) & { nextDueAt: number | null }

const MAX_ERROR_LENGTH = 200

export const completeDelivery = writeOperation<
	{ id: string; leaseToken: string; now: number; outcome: DeliveryOutcome },
	Completion
>((db, { id, leaseToken, now, outcome }) => {
	const row = db.first<LaneRow & { stale_answer: number; answer_type: string }>(
		`SELECT CAST(d.id AS TEXT) AS id, CAST(d.activity_id AS TEXT) AS activity_id, d.account_id, d.lane, d.inbox_url,
			d.attempts, ${STALE_ANSWER} AS stale_answer, ${ANSWER_TYPE} AS answer_type
		FROM ${DUE_FROM} WHERE d.id = CAST(? AS INTEGER) AND d.state = 'leased' AND d.lease_token = ?`,
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
		// a server whose Create was given up gets the Create again with the next edit. Of a withdrawn status (its Delete
		// is recorded, statuses.withdrawn) every activity but a retraction records one: the inbox may hold the status
		// (an Update to a poll's voter, which no other evidence names once the poll is ended), and its Delete, staging,
		// reaches it then (VIS-3).
		db.run(
			`INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at)
			SELECT s.id, ?2, o.account_id, ?3 FROM outbound_activities o JOIN statuses s ON s.uri = o.object_uri
			WHERE o.id = CAST(?1 AS INTEGER)
				AND (json_extract(o.body, '$.activity.type') IN ('Create', 'Announce') OR (s.withdrawn = 1 AND o.retracts = 0))
				AND NOT EXISTS (SELECT 1 FROM outbound_activities r
					WHERE r.account_id = o.account_id AND r.object_uri = o.object_uri AND r.retracts = 1 AND r.staged IS NULL)
			ON CONFLICT DO UPDATE SET delivered_at = excluded.delivered_at`,
			row.activity_id,
			row.inbox_url,
			now
		)
		dropRow(db, row, now)
		if (row.stale_answer === 1) {
			staleAnswer(row.answer_type, 'sent_in_flight')
		}
		return { status: 'delivered', nextDueAt: nextDueAt(db, now, leaseToken) }
	}
	// Before every failure exit (the personal inbox, giving up, a retry): a superseded answer gets no further attempt.
	if (row.stale_answer === 1) {
		dropRow(db, row, now)
		staleAnswer(row.answer_type, 'failure')
		return { status: 'dropped', nextDueAt: nextDueAt(db, now, leaseToken) }
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
// serves that recipient alone, and its provenance (VIS-30) says so. A forward's row (Audience.shares; its addressing is
// the remote author's) moves by its provenance instead (forwardFallback).
function personalFallback(db: Db, row: LaneRow, now: number, status: number | null, error: string): boolean {
	if (status === null || !SHARED_INBOX_MISSING.has(status) || row.attempts >= MAX_ATTEMPTS) {
		return false
	}
	const forward = db.first<{ forward: number }>(
		"SELECT json_type(body, '$.audience.shares') = 'array' AS forward FROM outbound_activities WHERE id = CAST(? AS INTEGER)",
		row.activity_id
	)
	if (forward?.forward === 1) {
		return forwardFallback(db, row, now, status, error)
	}
	// The audience's accounts at this shared inbox, in id order (as many as the activity addresses). For content, the
	// first one the send-time check would still send to (sendRefused): one it would refuse would lose the delivery at
	// the next claim, though another recipient there may be available. A retraction takes the first, as it is never
	// refused. Each account is sought by id from the audience (RES-7).
	const candidates = db.all<{ inbox: string; id: string; uri: string; retracts: number; available: number }>(
		`SELECT a.inbox_url AS inbox, a.id, a.uri, o.retracts, ${availableSql('a.id')} AS available
		FROM deliveries d CROSS JOIN outbound_activities o ON o.id = d.activity_id
			CROSS JOIN json_each(o.body, '$.audience.accounts') r CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = r.value
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
		return c.retracts === 1 || (c.available === 1 && (host === null || !hostCovered(db, host)))
	})
	if (personal === undefined || !isDeliverableInbox(personal.inbox) || laneOf(personal.inbox) !== row.lane) {
		return false
	}
	moveToPersonal(db, row, now, status, error, personal)
	return true
}

// Moves the row in place to the recipient's personal inbox, retried at once and serving that recipient alone.
function moveToPersonal(
	db: Db,
	row: LaneRow,
	now: number,
	status: number,
	error: string,
	personal: { inbox: string; id: string; uri: string }
): void {
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
}

// personalFallback for a forward's row: it moves in place, as there, only when its provenance (recipient_accounts, at
// most PROVENANCE_MAX ids, each sought by id: RES-7) names exactly one account behind this shared inbox with a
// different personal inbox on the same origin, which the activity has no row or unexpanded target for. A row serving
// several such accounts, more than PROVENANCE_MAX (recipients_many), or unknown ones (an earlier receiver of a boost)
// does not move and gives up visibly: one row moved to several inboxes would let a later activity of its lane (the
// boost's Undo) overtake the copies written behind it.
function forwardFallback(db: Db, row: LaneRow, now: number, status: number, error: string): boolean {
	const candidates = db.all<{ inbox: string; id: string; uri: string }>(
		`SELECT a.inbox_url AS inbox, a.id, a.uri
		FROM deliveries d CROSS JOIN json_each(d.recipient_accounts) r
			CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = r.value
		WHERE d.id = CAST(?1 AS INTEGER) AND d.addressee IS NULL AND d.recipient_accounts IS NOT NULL
			AND d.recipients_many IS NULL AND a.domain IS NOT NULL AND a.shared_inbox_url = d.inbox_url
			AND a.inbox_url <> d.inbox_url
		ORDER BY a.id`,
		row.id
	)
	const movable = candidates.filter((c) => isDeliverableInbox(c.inbox) && laneOf(c.inbox) === row.lane)
	if (movable.length !== 1) {
		return false
	}
	const personal = movable[0]!
	// The activity's rows and unexpanded targets, read once for the one candidate: at most the forward's own targets.
	const duplicate = db.first(
		`SELECT 1 AS x FROM deliveries e INDEXED BY deliveries_activity
		WHERE e.activity_id = CAST(?1 AS INTEGER) AND e.inbox_url = ?2
		UNION ALL SELECT 1 FROM outbound_targets c INDEXED BY outbound_targets_activity, json_each(c.targets) t
		WHERE c.activity_id = CAST(?1 AS INTEGER) AND t.key >= c.next AND json_extract(t.value, '$.inbox') = ?2
		LIMIT 1`,
		row.activity_id,
		personal.inbox
	)
	if (duplicate !== undefined) {
		return false
	}
	moveToPersonal(db, row, now, status, error, personal)
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
// A superseded follow answer's given-up row goes at once (retryDeliveries refuses it, so nothing can send it again),
// so its intent stops counting toward its pair's FOLLOW_ANSWER_INTENTS once its other rows settle. Both deletes share
// SWEEP_BATCH rows a round, the answers first. The answers' read also passes the superseded answers whose rows are
// still active, at most the delivery backlog (RES-4). The rows left of SWEEP_BATCH then go to the stagings that ended
// unwritten (sweepStagings).
export const sweepDeliveries = writeOperation<{ now: number }, { swept: number }>((db, { now }) => {
	const answers = db.all<{ activity_id: string }>(
		`DELETE FROM deliveries WHERE id IN (SELECT d.id
			FROM outbound_activities o INDEXED BY outbound_activities_follow_swept
				CROSS JOIN deliveries d INDEXED BY deliveries_activity ON d.activity_id = o.id
			WHERE o.follow_pair IS NOT NULL AND o.superseded = 1 AND d.state = 'gave_up' ORDER BY o.id LIMIT ?)
		RETURNING CAST(activity_id AS TEXT) AS activity_id`,
		SWEEP_BATCH
	)
	const expired = db.all<{ activity_id: string }>(
		`DELETE FROM deliveries WHERE id IN (SELECT id FROM deliveries WHERE state = 'gave_up' AND updated_at < ?
			ORDER BY updated_at LIMIT ?) RETURNING CAST(activity_id AS TEXT) AS activity_id`,
		now - GAVE_UP_RETENTION_MS,
		SWEEP_BATCH - answers.length
	)
	const swept = [...answers, ...expired]
	for (const activityId of new Set(swept.map((r) => r.activity_id))) {
		dropSettledActivity(db, activityId)
	}
	return { swept: swept.length + sweepStagings(db, SWEEP_BATCH - swept.length) }
})

// The stagings that ended before their targets were written (outbound_activities_staging_ended: superseded), oldest
// first through retraction_stagings_ended: their staged rows deleted in key order (drainStaged), and each staging's row
// once none is left, in at most `left` rows. Returns the rows deleted.
function sweepStagings(db: Db, left: number): number {
	let deleted = 0
	while (deleted < left) {
		const ended = db.first<{ id: string }>(
			`SELECT CAST(id AS TEXT) AS id FROM retraction_stagings INDEXED BY retraction_stagings_ended
			WHERE ended = 1 ORDER BY id LIMIT 1`
		)
		if (ended === undefined) {
			return deleted
		}
		// The staging's own row is kept room for.
		const rows = Math.min(left - deleted - 1, STAGING_READ)
		const staged =
			db.first<{ n: number }>(
				`SELECT count(*) AS n FROM (SELECT 1 FROM retraction_reach WHERE staging_id = CAST(?1 AS INTEGER) LIMIT ?2)`,
				ended.id,
				rows + 1
			)?.n ?? 0
		const drained = Math.min(staged, rows)
		drainStaged(db, ended.id, drained)
		deleted += drained
		if (staged > drained) {
			return deleted
		}
		const gone = db.run(
			`DELETE FROM retraction_stagings WHERE id = CAST(?1 AS INTEGER) AND ended = 1
				AND NOT EXISTS (SELECT 1 FROM retraction_reach WHERE staging_id = CAST(?1 AS INTEGER))`,
			ended.id
		)
		if (gone === 0) {
			return deleted
		}
		deleted += gone
	}
	return deleted
}
