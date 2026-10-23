import { DurableObject } from 'cloudflare:workers'

import { MIGRATIONS } from './db/migrations'
import { Db } from './db/sql'
import * as accounts from './domain/accounts'
import * as activities from './domain/activities'
import { announceConvertedProfiles } from './domain/actor-update'
import {
	ensureInstanceActorKey,
	featuredTagsOfActor,
	getCollection,
	getInstanceActorKey,
	getFetchSigner,
	getInstanceDomain,
	getLocalActor,
	getLocalKey,
	getNodeInfoUsage,
	listLocalKeys,
	listRewrapKeys,
	rewrapLocalKey,
} from './domain/actors'
import {
	actOnAccount,
	actOnAdminAccount,
	getAdminAccount,
	listAdminAccounts,
	setAccountEmail,
	unsuspendAccount,
	unsuspendAdminAccount,
} from './domain/admin-accounts'
import { oauthAdminStatus } from './domain/admin-authority'
import * as adminDomainBlocks from './domain/admin-domain-blocks'
import { adminMeasure } from './domain/admin-measures'
import * as announcements from './domain/announcements'
import { checkCredential, type Credential, noteActivity, type UserCredential } from './domain/auth'
import * as blocks from './domain/blocks'
import * as conversations from './domain/conversations'
import * as deliveries from './domain/deliveries'
import { directory } from './domain/directory'
import * as endorsements from './domain/endorsements'
import * as featuredTags from './domain/featured-tags'
import { kvCas, kvDelete, kvGet, kvList, kvSet } from './domain/fedify-kv'
import * as fieldLinks from './domain/field-links'
import * as filters from './domain/filters'
import * as inbox from './domain/inbox'
import {
	instanceAdminSettings,
	instanceDocument,
	instanceDocumentSource,
	instanceInfo,
	instancePeers,
	instanceRules,
	instanceSettings,
	searchPeers,
	setInstanceSettings,
} from './domain/instance'
import * as instanceDomainBlocks from './domain/instance-domain-blocks'
import * as linkCards from './domain/link-cards'
import * as lists from './domain/lists'
import * as localEmojis from './domain/local-emojis'
import * as markers from './domain/markers'
import * as media from './domain/media'
import * as mediaRebuild from './domain/media-rebuild'
import { moderationLog } from './domain/moderation-log'
import * as notificationGroups from './domain/notification-groups'
import * as notificationRequests from './domain/notification-requests'
import * as notifications from './domain/notifications'
import * as oauth from './domain/oauth'
import * as polls from './domain/polls'
import * as push from './domain/push'
import * as quotes from './domain/quotes'
import * as remoteCollections from './domain/remote-collections'
import { resolveSearch } from './domain/remote-statuses'
import * as reports from './domain/reports'
import * as scheduled from './domain/scheduled-statuses'
import { search } from './domain/search'
import * as setup from './domain/setup'
import { saveSnapshot } from './domain/snapshot'
import * as statusActions from './domain/status-actions'
import * as statuses from './domain/statuses'
import * as suggestions from './domain/suggestions'
import { runModerationJobs, suspendAccount } from './domain/suspension'
import * as tags from './domain/tags'
import * as timelines from './domain/timelines'
import * as trends from './domain/trends'
import { UNLOCK_ACCEPTS_PER_ROUND, unlockAcceptStep } from './domain/unlock-accepts'
import * as webPages from './domain/web-pages'
import * as webSession from './domain/web-session'
import {
	captureMedia,
	claimBackup,
	type MediaCopyRecord,
	mediaCoverage,
	mediaPage,
	readBackupState,
	recordMedia,
	saveBackup,
} from './platform/backup-state'
import { errorFields } from './platform/error-message'
import { restoreMarkerKey } from './platform/media-files'
import { type ImportAuthority, StoreAdmin } from './platform/store-admin'
import { readFlags } from './platform/store-flags'
import { StoreKernel, type StoreOperation } from './platform/store-kernel'
import { StreamHub } from './stream-hub'
import { buildOf, PACKAGE_VERSION } from './version'

// When a PITR restore was last scheduled (store.ts pitrToBookmark), or null.
async function lastRestore(bucket: R2Bucket, key: string): Promise<number | null> {
	const marker = await bucket.get(key)
	if (marker === null) {
		return null
	}
	const at = (JSON.parse(await marker.text()) as { at?: unknown }).at
	return typeof at === 'number' ? at : null
}

type OperationInput<T> = T extends StoreOperation<infer I, unknown> ? I : never

// The single source of truth of an instance: one SQLite-backed Durable Object. Every RPC takes the caller's build
// (the Workers version id, see version.ts). Domain operations run through the kernel's gate. Rescue RPCs work in every
// Store state. Of those, health(), version(), the inspection RPCs and the dump RPCs only read data and accept any caller
// build, since they are what an operator needs while the Worker and the Store disagree; the dump's freeze flag is
// bookkeeping, not data. pitrToBookmark(), maintenance, upgrade retry and import mutate, so they require the caller's
// build to match like any other mutation.
//
// How a request talks to the Store: Store-local decisions whose inputs are available together are combined into one
// call. A phase of a request ends at an external effect (verifying, fetching, sending) or at a commit, not at each
// read. A call stays separate only when its timing is the guarantee: a policy read after an awaited remote response
// (fetchRefused before a redirect hop or a later request, webHopRefused), a confirmation under lease right before a
// send (confirmDelivery), a one-time write (ensureInstanceActorKey). A fetch's preparation (domain/inbox.ts
// fetchPreparation: the signer and the policy verdict for its first request) is produced at the two answers that decide
// a fetch, inboxGate and a receiveActivity need, and nowhere else; it is optional, and the Worker reads what is
// missing (fetchSigner, fetchRefused) as it would without it.
export class Store extends DurableObject<Env> {
	readonly #kernel: StoreKernel
	readonly #admin: StoreAdmin
	readonly #streams: StreamHub

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		const build = buildOf(env)
		this.#kernel = new StoreKernel(ctx, {
			build,
			migrations: MIGRATIONS,
			afterCommit: (operation) => this.#streams.written(operation),
		})
		this.#admin = new StoreAdmin(ctx, this.#kernel, {
			source: { build, version: PACKAGE_VERSION },
			onPublish: (sql, now) => announceConvertedProfiles(new Db(sql), now),
		})
		// A turn is a request to this object's own stub (stream-hub.ts).
		this.#streams = new StreamHub(ctx, this.#kernel, (headers) =>
			env.STORE.get(ctx.id).fetch('https://store.internal/stream/turn', { method: 'POST', headers })
		)
	}

	// The streaming API (stream-hub.ts): the upgrade the Worker forwards (mastodon/streaming.ts), and the turns of the
	// fan-out, which only this object requests of itself.
	override fetch(request: Request): Promise<Response> {
		return this.#streams.fetch(request)
	}

	override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		return this.#streams.message(ws, message)
	}

	override webSocketClose(ws: WebSocket, code: number): Promise<void> {
		return this.#streams.closed(ws, code)
	}

	override webSocketError(ws: WebSocket): Promise<void> {
		return this.#streams.closed(ws, 1011)
	}

	// The cron's turn of the streaming API: closes the sockets of expired tokens and prunes the journal.
	streamTick(_callerBuild: string) {
		this.#streams.tick()
	}

	// The streaming tests' drain barrier (stream-hub.ts drained): resolves once the fan-out has caught up.
	streamDrained(_callerBuild: string) {
		return this.#streams.drained()
	}

	health(callerBuild: string) {
		return this.#kernel.health(callerBuild)
	}

	async version(_callerBuild: string) {
		return { ...(await this.#kernel.version()), version: PACKAGE_VERSION }
	}

	// The restore is recorded in R2 first (restoreMarkerKey): a restore rewinds the database, maintenance start and
	// unpublished flag included, so a media rebuild counts its settle period from this record instead.
	pitrToBookmark(callerBuild: string, bookmark: string) {
		return this.#kernel.restoreBookmark(callerBuild, bookmark, async () => {
			await this.env.MEDIA.put(restoreMarkerKey(this.ctx.id.toString()), JSON.stringify({ at: Date.now() }))
		})
	}

	// ---- operations tooling (platform/store-admin.ts), called from /admin/*

	capacity(_callerBuild: string) {
		return this.#admin.capacity()
	}

	spool(_callerBuild: string) {
		return this.#admin.spool()
	}

	adminGate(_callerBuild: string) {
		return this.#admin.gate()
	}

	query(_callerBuild: string, sql: string, limit?: number) {
		return this.#admin.query(sql, limit)
	}

	pitrBookmark(_callerBuild: string, at?: number) {
		return this.#admin.bookmark(at)
	}

	setMaintenance(callerBuild: string, on: boolean) {
		return this.#admin.setMaintenance(callerBuild, on)
	}

	retryUpgrade(callerBuild: string) {
		return this.#kernel.retryUpgrade(callerBuild)
	}

	dumpStart(_callerBuild: string, leaseSeconds?: number, opId?: string) {
		return this.#admin.dumpStart(leaseSeconds, opId)
	}

	dumpNext(_callerBuild: string, cursor: unknown, maxBytes?: number) {
		return this.#admin.dumpNext(cursor, maxBytes)
	}

	dumpFinish(_callerBuild: string, cursor: unknown, abort?: boolean) {
		return this.#admin.dumpFinish(cursor, abort)
	}

	dumpAbort(_callerBuild: string, opId: string) {
		return this.#admin.dumpAbort(opId)
	}

	catalog(_callerBuild: string) {
		return this.#admin.catalog()
	}

	// The scheduled backup's bookkeeping (platform/backup-state.ts). Like the dump flag it is not data, so any caller
	// build and any Store state (maintenance, a dump or an import) may use it. The runner lease is taken and checked
	// inside each transaction, at the time the caller passes.
	async backupState(_callerBuild: string) {
		await this.#kernel.state()
		return readBackupState(this.ctx.storage.sql)
	}

	// Refused while a verified import is unpublished: the scheduled backup starts only once the instance is published
	// (an operator's rescue dump is not affected), checked in the transaction that takes the runner lease.
	async backupClaim(_callerBuild: string, runner: string, now: number, leaseMs: number) {
		await this.#kernel.state()
		return this.#backupTx((sql) =>
			readFlags(sql).unpublished !== null
				? ({ ok: false, code: 'unpublished' } as const)
				: claimBackup(sql, runner, now, leaseMs)
		)
	}

	async backupSave(
		_callerBuild: string,
		runner: string,
		now: number,
		leaseMs: number,
		state: unknown,
		release: boolean,
		pruneTo: string | null
	) {
		await this.#kernel.state()
		return this.#backupTx((sql) => saveBackup(sql, runner, now, leaseMs, state, release, pruneTo))
	}

	// Completes the backup's dump and records the originals it references in one transaction, while its freeze holds.
	async backupFinishDump(
		_callerBuild: string,
		runner: string,
		now: number,
		run: string,
		destination: string,
		opId: string,
		cursor: unknown
	) {
		let required = 0
		const finished = await this.#admin.dumpFinish(cursor, false, {
			opId,
			within: (sql) => {
				const captured = captureMedia(sql, runner, now, run, destination)
				if (!captured.ok) {
					return { ok: false, code: captured.code, message: `backup ${captured.code}` }
				}
				required = captured.required
				return null
			},
		})
		return finished.ok ? { ...finished, required } : finished
	}

	async backupMedia(_callerBuild: string, run: string, after: string | null, limit: number, pendingOnly: boolean) {
		await this.#kernel.state()
		return mediaPage(this.ctx.storage.sql, run, after, limit, pendingOnly)
	}

	async backupRecord(_callerBuild: string, runner: string, now: number, source: string, record: MediaCopyRecord) {
		await this.#kernel.state()
		return this.#backupTx((sql) => recordMedia(sql, runner, now, source, record))
	}

	async backupCoverage(_callerBuild: string, run: string) {
		await this.#kernel.state()
		return mediaCoverage(this.ctx.storage.sql, run)
	}

	#backupTx<T>(fn: (sql: SqlStorage) => T): T {
		return this.ctx.storage.transactionSync(() => fn(this.ctx.storage.sql))
	}

	// Import and configuration mutations name their authority; the Store checks it where it writes (store-admin.ts).
	// An import replaces the data the streams were judged by: every socket closes (1012), and clients reconnect once it
	// is published.
	async importBegin(callerBuild: string, authority: ImportAuthority, header: unknown) {
		const result = await this.#admin.importBegin(callerBuild, authority, header)
		if (result.ok) {
			this.#streams.closeAll(1012, 'service restart')
		}
		return result
	}

	importChunk(callerBuild: string, authority: ImportAuthority, id: string, seq: number, bytes: Uint8Array) {
		return this.#admin.importChunk(callerBuild, authority, id, seq, bytes)
	}

	importFinish(callerBuild: string, authority: ImportAuthority, id: string, trailer: unknown) {
		return this.#admin.importFinish(callerBuild, authority, id, trailer)
	}

	importVerify(callerBuild: string, authority: ImportAuthority, id: string) {
		return this.#admin.importVerify(callerBuild, authority, id)
	}

	importProgress(_callerBuild: string, authority: ImportAuthority, id?: string) {
		return this.#admin.importProgress(authority, id)
	}

	importReset(callerBuild: string, authority: ImportAuthority, id?: string, abandonStale?: boolean) {
		return this.#admin.importReset(callerBuild, authority, id, abandonStale)
	}

	config(_callerBuild: string) {
		return this.#admin.config()
	}

	// The cutover's publication mark, rollback journal and reset (store-admin.ts, docs/cutover-runbook.md).
	cutoverStatus(callerBuild: string) {
		return this.#admin.cutoverStatus(callerBuild)
	}

	publish(callerBuild: string, authority: ImportAuthority) {
		return this.#admin.publish(callerBuild, authority)
	}

	journalSpool(
		callerBuild: string,
		entry: { digest: string; spooledAt: number; record: Uint8Array },
		limits?: { entries?: number; bytes?: number }
	) {
		return this.#admin.journalSpool(callerBuild, entry, limits)
	}

	handedOff(callerBuild: string, digest: string) {
		return this.#admin.handedOff(callerBuild, digest)
	}

	closeRollback(callerBuild: string, authority: ImportAuthority) {
		return this.#admin.closeRollback(callerBuild, authority)
	}

	drainLease(callerBuild: string, authority: ImportAuthority, request: { holder: string; release?: boolean }) {
		return this.#admin.drainLease(callerBuild, authority, request)
	}

	journalNext(callerBuild: string, authority: ImportAuthority, holder: string, skip?: string[]) {
		return this.#admin.journalNext(callerBuild, authority, holder, skip)
	}

	journalMark(
		callerBuild: string,
		authority: ImportAuthority,
		holder: string,
		id: string,
		state: 'sending' | 'done' | 'unverified' | 'no-recipient'
	) {
		return this.#admin.journalMark(callerBuild, authority, holder, id, state)
	}

	journalFullStop(callerBuild: string, authority: ImportAuthority, holder: string, action: 'record' | 'check') {
		return this.#admin.journalFullStop(callerBuild, authority, holder, action)
	}

	journalDiscardKept(callerBuild: string, authority: ImportAuthority) {
		return this.#admin.journalDiscardKept(callerBuild, authority)
	}

	cutoverReset(callerBuild: string, authority: ImportAuthority) {
		return this.#admin.cutoverReset(callerBuild, authority)
	}

	setConfig(callerBuild: string, authority: ImportAuthority, values: unknown) {
		return this.#admin.setConfig(callerBuild, authority, values)
	}

	// The OAuth admin's state for GET /admin/health, which shows it to Access only.
	oauthAdmin(callerBuild: string) {
		return this.#kernel.execute(callerBuild, oauthAdminStatus, undefined)
	}

	// POST /admin/accounts/email: the Access admin's repair of the OAuth admin's match (domain/admin-accounts.ts).
	setAccountEmail(callerBuild: string, input: OperationInput<typeof setAccountEmail>) {
		return this.#kernel.execute(callerBuild, setAccountEmail, input)
	}

	// GET and POST /admin/instance: the Access admin's public settings (domain/instance.ts).
	instanceAdminSettings(callerBuild: string) {
		return this.#kernel.execute(callerBuild, instanceAdminSettings, undefined)
	}

	setInstanceSettings(callerBuild: string, input: OperationInput<typeof setInstanceSettings>) {
		return this.#kernel.execute(callerBuild, setInstanceSettings, input)
	}

	// POST /admin/accounts/unsuspend: the Access admin's recovery of a suspended account (domain/admin-accounts.ts).
	unsuspendAccount(callerBuild: string, input: OperationInput<typeof unsuspendAccount>) {
		return this.#kernel.execute(callerBuild, unsuspendAccount, input)
	}

	// GET /admin/reports/:id (domain/reports.ts).
	reportTargetPage(callerBuild: string, input: OperationInput<typeof reports.reportTargetPage>) {
		return this.#kernel.execute(callerBuild, reports.reportTargetPage, input)
	}

	// GET /admin/moderation-log (domain/moderation-log.ts).
	moderationLog(callerBuild: string, input: OperationInput<typeof moderationLog>) {
		return this.#kernel.execute(callerBuild, moderationLog, input)
	}

	setupState(callerBuild: string) {
		return this.#kernel.execute(callerBuild, setup.getSetupState, undefined)
	}

	// The /setup wizard (B5b, domain/setup.ts): each operation authorizes its setup session or admin itself.

	setupView(callerBuild: string, input: OperationInput<typeof setup.setupView>) {
		return this.#kernel.execute(callerBuild, setup.setupView, input)
	}

	beginSetupSession(callerBuild: string, input: OperationInput<typeof setup.beginSetupSession>) {
		return this.#kernel.execute(callerBuild, setup.beginSetupSession, input)
	}

	endSetupSession(callerBuild: string, input: OperationInput<typeof setup.endSetupSession>) {
		return this.#kernel.execute(callerBuild, setup.endSetupSession, input)
	}

	confirmSetupDomain(callerBuild: string, input: OperationInput<typeof setup.confirmSetupDomain>) {
		return this.#kernel.execute(callerBuild, setup.confirmSetupDomain, input)
	}

	reserveAccess(callerBuild: string, input: OperationInput<typeof setup.reserveAccess>) {
		return this.#kernel.execute(callerBuild, setup.reserveAccess, input)
	}

	checkpointAccess(callerBuild: string, input: OperationInput<typeof setup.checkpointAccess>) {
		return this.#kernel.execute(callerBuild, setup.checkpointAccess, input)
	}

	completeAccess(callerBuild: string, input: OperationInput<typeof setup.completeAccess>) {
		return this.#kernel.execute(callerBuild, setup.completeAccess, input)
	}

	failAccess(callerBuild: string, input: OperationInput<typeof setup.failAccess>) {
		return this.#kernel.execute(callerBuild, setup.failAccess, input)
	}

	recordSetupImages(callerBuild: string, input: OperationInput<typeof setup.recordSetupImages>) {
		return this.#kernel.execute(callerBuild, setup.recordSetupImages, input)
	}

	sendSetupProbe(callerBuild: string, input: OperationInput<typeof setup.sendSetupProbe>) {
		return this.#kernel.execute(callerBuild, setup.sendSetupProbe, input)
	}

	consumeSetupProbe(callerBuild: string, input: OperationInput<typeof setup.consumeSetupProbe>) {
		return this.#kernel.execute(callerBuild, setup.consumeSetupProbe, input)
	}

	recordCronRun(callerBuild: string, input: OperationInput<typeof setup.recordCronRun>) {
		return this.#kernel.execute(callerBuild, setup.recordCronRun, input)
	}

	chargeSetupTransform(callerBuild: string, input: OperationInput<typeof setup.chargeSetupTransform>) {
		return this.#kernel.execute(callerBuild, setup.chargeSetupTransform, input)
	}

	bootstrapInstance(callerBuild: string, input: OperationInput<typeof setup.bootstrapInstance>) {
		return this.#kernel.execute(callerBuild, setup.bootstrapInstance, input)
	}

	// Inbound activities (B1b): the Worker verifies and prepares, the Store authorizes and applies (domain/inbox.ts),
	// with its own clock beside the Worker's (StoreReceiveInput).

	async receiveActivity(callerBuild: string, input: inbox.ReceiveInput): Promise<inbox.ReceiveAnswer> {
		try {
			return await this.#kernel.execute(callerBuild, inbox.receiveActivity, { ...input, storeNow: Date.now() })
		} catch (error) {
			// Rolled back: a retryable refusal changes nothing (domain/inbox.ts, RetryLater).
			if (error instanceof inbox.RetryLater) {
				return inbox.retryResult(error)
			}
			throw error
		}
	}

	// A round of the inbound jobs, of the domain block cleanups (domain/blocks.ts), of the jobs of answered
	// notification requests (domain/notification-requests.ts) and of the moderation jobs (domain/suspension.ts), each in
	// its own transaction.
	async runInboundJobs(callerBuild: string, input: OperationInput<typeof inbox.runInboundJobs>) {
		const inbound = await this.#kernel.execute(callerBuild, inbox.runInboundJobs, input)
		const cleanups = await this.#kernel.execute(callerBuild, blocks.runDomainBlockCleanups, input)
		const requests = await this.#kernel.execute(callerBuild, notificationRequests.runNotificationRequestJobs, input)
		const moderation = await this.#kernel.execute(callerBuild, runModerationJobs, input)
		const unlock = await this.#runUnlockAccepts(callerBuild, input)
		return {
			pending: inbound.pending || cleanups.pending || requests.pending || moderation.pending || unlock.pending,
			delivers: inbound.delivers || cleanups.delivers || moderation.delivers || unlock.delivers,
		}
	}

	// A round of the unlock acceptance jobs (domain/unlock-accepts.ts): at most UNLOCK_ACCEPTS_PER_ROUND steps, each in
	// its own transaction.
	async #runUnlockAccepts(callerBuild: string, input: { now: number }) {
		let delivers = false
		for (let step = 0; step < UNLOCK_ACCEPTS_PER_ROUND; step++) {
			const result = await this.#kernel.execute(callerBuild, unlockAcceptStep, input)
			delivers = delivers || result.delivers
			if (result.done) {
				return { pending: false, delivers }
			}
		}
		return { pending: true, delivers }
	}

	// Syncs of remote accounts' collections (domain/remote-collections.ts): claimed and applied by the Worker's job
	// rounds (federation/collections.ts).
	claimCollectionSync(callerBuild: string, input: OperationInput<typeof remoteCollections.claimCollectionSync>) {
		return this.#kernel.execute(callerBuild, remoteCollections.claimCollectionSync, input)
	}

	completeCollectionRead(callerBuild: string, input: OperationInput<typeof remoteCollections.completeCollectionRead>) {
		return this.#kernel.execute(callerBuild, remoteCollections.completeCollectionRead, input)
	}

	completePinFetches(callerBuild: string, input: OperationInput<typeof remoteCollections.completePinFetches>) {
		return this.#kernel.execute(callerBuild, remoteCollections.completePinFetches, input)
	}

	// Verification of received quotes (domain/quotes.ts): the work read, applied and claimed by the Worker's job rounds
	// (federation/quotes.ts).
	quoteWork(callerBuild: string, input: OperationInput<typeof quotes.quoteWork>) {
		return this.#kernel.execute(callerBuild, quotes.quoteWork, input)
	}

	completeQuote(callerBuild: string, input: OperationInput<typeof quotes.completeQuote>) {
		return this.#kernel.execute(callerBuild, quotes.completeQuote, input)
	}

	chargeQuote(callerBuild: string, input: OperationInput<typeof quotes.chargeQuote>) {
		return this.#kernel.execute(callerBuild, quotes.chargeQuote, input)
	}

	claimQuotes(callerBuild: string, input: OperationInput<typeof quotes.claimQuotes>) {
		return this.#kernel.execute(callerBuild, quotes.claimQuotes, input)
	}

	quoteAuthorization(callerBuild: string, input: OperationInput<typeof quotes.quoteAuthorization>) {
		return this.#kernel.execute(callerBuild, quotes.quoteAuthorization, input)
	}

	// Verification of local profile links (domain/field-links.ts): claimed, recorded and finished by the cron's round
	// (federation/field-links.ts).
	claimFieldLinks(callerBuild: string, input: OperationInput<typeof fieldLinks.claimFieldLinks>) {
		return this.#kernel.execute(callerBuild, fieldLinks.claimFieldLinks, input)
	}

	recordFieldLink(callerBuild: string, input: OperationInput<typeof fieldLinks.recordFieldLink>) {
		return this.#kernel.execute(callerBuild, fieldLinks.recordFieldLink, input)
	}

	finishFieldLinks(callerBuild: string, input: OperationInput<typeof fieldLinks.finishFieldLinks>) {
		return this.#kernel.execute(callerBuild, fieldLinks.finishFieldLinks, input)
	}

	// Status cards (domain/link-cards.ts): claimed and recorded by the cron's round (federation/link-cards.ts), whose
	// hops the domain policy admits as a write (webHopRefused, AM4).
	claimCards(callerBuild: string, input: OperationInput<typeof linkCards.claimCards>) {
		return this.#kernel.execute(callerBuild, linkCards.claimCards, input)
	}

	recordCard(callerBuild: string, input: OperationInput<typeof linkCards.recordCard>) {
		return this.#kernel.execute(callerBuild, linkCards.recordCard, input)
	}

	remoteKey(callerBuild: string, input: OperationInput<typeof inbox.getRemoteKey>) {
		return this.#kernel.execute(callerBuild, inbox.getRemoteKey, input)
	}

	// The instance domain policy the Worker reads before a fetch (decision 6, R38; inboxGate reads it before an inbound
	// request is verified): advisory, as the writes decide.
	fetchRefused(callerBuild: string, input: OperationInput<typeof instanceDomainBlocks.fetchRefused>) {
		return this.#kernel.execute(callerBuild, instanceDomainBlocks.fetchRefused, input)
	}

	// The domain policy of each hop of the cron's web page rounds (link cards, profile link verification), admitted as a
	// write (NET-3).
	webHopRefused(callerBuild: string, input: OperationInput<typeof instanceDomainBlocks.webHopRefused>) {
		return this.#kernel.execute(callerBuild, instanceDomainBlocks.webHopRefused, input)
	}

	// What an inbound request is judged on before it is verified (federation/inbox.ts processInbox), in one read, with
	// whether receiveActivity would be admitted now (refused: null, or the maintenance reason). Advisory: receiveActivity
	// is admitted and decides again in its own transaction.
	// While writes are refused, it hands over no fetch preparation, so no key leaves the Store for the request (OPS-8).
	async inboxGate(callerBuild: string, input: OperationInput<typeof inbox.inboxGate>) {
		const { output, refused } = await this.#kernel.executeProbing(callerBuild, inbox.inboxGate, input, 'write')
		return { ...output, prefetch: refused === null ? output.prefetch : null, refused }
	}

	inboxOwnerExists(callerBuild: string, input: OperationInput<typeof inbox.inboxOwnerExists>) {
		return this.#kernel.execute(callerBuild, inbox.inboxOwnerExists, input)
	}

	// Federation (B1a): Fedify's KvStore, local actors and keys, collections, NodeInfo, and the rescue snapshots.
	// rescueSnapshot is a rescue RPC like health(): any caller build, every Store state.

	kvGet(callerBuild: string, input: OperationInput<typeof kvGet>) {
		return this.#kernel.execute(callerBuild, kvGet, input)
	}

	kvSet(callerBuild: string, input: OperationInput<typeof kvSet>) {
		return this.#kernel.execute(callerBuild, kvSet, input)
	}

	kvDelete(callerBuild: string, input: OperationInput<typeof kvDelete>) {
		return this.#kernel.execute(callerBuild, kvDelete, input)
	}

	kvCas(callerBuild: string, input: OperationInput<typeof kvCas>) {
		return this.#kernel.execute(callerBuild, kvCas, input)
	}

	kvList(callerBuild: string, input: OperationInput<typeof kvList>) {
		return this.#kernel.execute(callerBuild, kvList, input)
	}

	instanceDomain(callerBuild: string) {
		return this.#kernel.execute(callerBuild, getInstanceDomain, undefined)
	}

	localActor(callerBuild: string, input: OperationInput<typeof getLocalActor>) {
		return this.#kernel.execute(callerBuild, getLocalActor, input)
	}

	// The signer of a fetch no Store answer prepared (DATA-7, actors.ts fetchSignerOf), on its first fetch.
	fetchSigner(callerBuild: string, input: OperationInput<typeof getFetchSigner>) {
		return this.#kernel.execute(callerBuild, getFetchSigner, input)
	}

	localKey(callerBuild: string, input: OperationInput<typeof getLocalKey>) {
		return this.#kernel.execute(callerBuild, getLocalKey, input)
	}

	instanceActorKey(callerBuild: string) {
		return this.#kernel.execute(callerBuild, getInstanceActorKey, undefined)
	}

	ensureInstanceActorKey(callerBuild: string, input: OperationInput<typeof ensureInstanceActorKey>) {
		return this.#kernel.execute(callerBuild, ensureInstanceActorKey, input)
	}

	localKeys(callerBuild: string) {
		return this.#kernel.execute(callerBuild, listLocalKeys, undefined)
	}

	// The KEK rewrap (app/key-rewrap.ts), from /admin/keys/rewrap: a page of wrapped keys, and the compare-and-swap write
	// of one rewrapped key.
	rewrapKeys(callerBuild: string, input: OperationInput<typeof listRewrapKeys>) {
		return this.#kernel.execute(callerBuild, listRewrapKeys, input)
	}

	rewrapKey(callerBuild: string, input: OperationInput<typeof rewrapLocalKey>) {
		return this.#kernel.execute(callerBuild, rewrapLocalKey, input)
	}

	collection(callerBuild: string, input: OperationInput<typeof getCollection>) {
		return this.#kernel.execute(callerBuild, getCollection, input)
	}

	featuredTagsCollection(callerBuild: string, input: OperationInput<typeof featuredTagsOfActor>) {
		return this.#kernel.execute(callerBuild, featuredTagsOfActor, input)
	}

	nodeInfoUsage(callerBuild: string, input: OperationInput<typeof getNodeInfoUsage>) {
		return this.#kernel.execute(callerBuild, getNodeInfoUsage, input)
	}

	saveSnapshot(callerBuild: string, input: OperationInput<typeof saveSnapshot>) {
		return this.#kernel.execute(callerBuild, saveSnapshot, input)
	}

	rescueSnapshot(_callerBuild: string, key: string) {
		return this.#kernel.readSnapshot(key)
	}

	// OAuth and the account and instance API (B3).

	registerApp(callerBuild: string, input: oauth.RegisterAppInput) {
		return this.#kernel.execute(callerBuild, oauth.registerApp, input)
	}

	// Protected operations take the request's credential and validate it in their own transaction (domain/auth.ts).
	// checkCredential() only validates.
	checkCredential(callerBuild: string, input: Credential) {
		return this.#kernel.execute(callerBuild, checkCredential, input)
	}

	// After an authenticated request's response (mastodon/activity.ts): its account's active day.
	noteActivity(callerBuild: string, input: OperationInput<typeof noteActivity>) {
		return this.#kernel.execute(callerBuild, noteActivity, input)
	}

	appOfCredential(callerBuild: string, input: Credential) {
		return this.#kernel.execute(callerBuild, oauth.appOfCredential, input)
	}

	inspectToken(callerBuild: string, input: OperationInput<typeof oauth.inspectToken>) {
		return this.#kernel.execute(callerBuild, oauth.inspectToken, input)
	}

	introspectToken(callerBuild: string, input: OperationInput<typeof oauth.introspectToken>) {
		return this.#kernel.execute(callerBuild, oauth.introspectToken, input)
	}

	authorizeContext(callerBuild: string, input: { clientId: string }) {
		return this.#kernel.execute(callerBuild, oauth.authorizeContext, input)
	}

	accountForLogin(callerBuild: string, input: { email: string }) {
		return this.#kernel.execute(callerBuild, oauth.accountForLogin, input)
	}

	issueCode(callerBuild: string, input: oauth.IssueCodeInput) {
		return this.#kernel.execute(callerBuild, oauth.issueCode, input)
	}

	exchangeCode(callerBuild: string, input: oauth.ExchangeCodeInput) {
		return this.#kernel.execute(callerBuild, oauth.exchangeCode, input)
	}

	issueAppToken(callerBuild: string, input: oauth.AppTokenInput) {
		return this.#kernel.execute(callerBuild, oauth.issueAppToken, input)
	}

	revokeToken(callerBuild: string, input: { tokenHash: string; clientId: string; clientSecret: string }) {
		return this.#kernel.execute(callerBuild, oauth.revokeToken, input)
	}

	sweepOAuth(callerBuild: string, input: OperationInput<typeof oauth.sweepOAuth>) {
		return this.#kernel.execute(callerBuild, oauth.sweepOAuth, input)
	}

	// The web UI (B5): sessions of its own OAuth client, the user's authorizations, and the public pages.
	beginWebLogin(callerBuild: string, input: OperationInput<typeof webSession.beginWebLogin>) {
		return this.#kernel.execute(callerBuild, webSession.beginWebLogin, input)
	}

	startWebSession(callerBuild: string, input: OperationInput<typeof webSession.startWebSession>) {
		return this.#kernel.execute(callerBuild, webSession.startWebSession, input)
	}

	endWebSession(callerBuild: string, input: OperationInput<typeof webSession.endWebSession>) {
		return this.#kernel.execute(callerBuild, webSession.endWebSession, input)
	}

	settingsView(callerBuild: string, input: OperationInput<typeof webSession.settingsView>) {
		return this.#kernel.execute(callerBuild, webSession.settingsView, input)
	}

	revokeAuthorization(callerBuild: string, input: OperationInput<typeof webSession.revokeAuthorization>) {
		return this.#kernel.execute(callerBuild, webSession.revokeAuthorization, input)
	}

	revokeOtherSessions(callerBuild: string, input: OperationInput<typeof webSession.revokeOtherSessions>) {
		return this.#kernel.execute(callerBuild, webSession.revokeOtherSessions, input)
	}

	profilePage(callerBuild: string, input: OperationInput<typeof webPages.profilePage>) {
		return this.#kernel.execute(callerBuild, webPages.profilePage, input)
	}

	statusPage(callerBuild: string, input: OperationInput<typeof webPages.statusPage>) {
		return this.#kernel.execute(callerBuild, webPages.statusPage, input)
	}

	embeddedStatus(callerBuild: string, input: OperationInput<typeof webPages.embeddedStatus>) {
		return this.#kernel.execute(callerBuild, webPages.embeddedStatus, input)
	}

	suspendAccount(callerBuild: string, input: { accountId: string; now: number }) {
		return this.#kernel.execute(callerBuild, suspendAccount, input)
	}

	instanceInfo(callerBuild: string, input: OperationInput<typeof instanceInfo>) {
		return this.#kernel.execute(callerBuild, instanceInfo, input)
	}

	instanceSettings(callerBuild: string) {
		return this.#kernel.execute(callerBuild, instanceSettings, undefined)
	}

	instanceRules(callerBuild: string) {
		return this.#kernel.execute(callerBuild, instanceRules, undefined)
	}

	// GET /api/v1/instance/{extended_description,privacy_policy,terms_of_service}: sanitized (domain/instance.ts).
	instanceDocument(callerBuild: string, input: OperationInput<typeof instanceDocument>) {
		return this.#kernel.execute(callerBuild, instanceDocument, input)
	}

	// The web pages of the documents: as stored, sanitized at the page's sink.
	instanceDocumentSource(callerBuild: string, input: OperationInput<typeof instanceDocumentSource>) {
		return this.#kernel.execute(callerBuild, instanceDocumentSource, input)
	}

	// GET /api/v1/instance/domain_blocks (domain/instance-domain-blocks.ts).
	publicDomainBlocks(callerBuild: string, input: OperationInput<typeof instanceDomainBlocks.publicDomainBlocks>) {
		return this.#kernel.execute(callerBuild, instanceDomainBlocks.publicDomainBlocks, input)
	}

	instancePeers(callerBuild: string) {
		return this.#kernel.execute(callerBuild, instancePeers, undefined)
	}

	searchPeers(callerBuild: string, input: { prefix: string }) {
		return this.#kernel.execute(callerBuild, searchPeers, input)
	}

	getAccount(callerBuild: string, input: { id: string; present: accounts.Present }) {
		return this.#kernel.execute(callerBuild, accounts.getAccount, input)
	}

	lookupAccount(callerBuild: string, input: { username: string; domain: string | null; present: accounts.Present }) {
		return this.#kernel.execute(callerBuild, accounts.lookupAccount, input)
	}

	verifyCredentials(callerBuild: string, input: { credential: UserCredential; present: accounts.Present }) {
		return this.#kernel.execute(callerBuild, accounts.verifyCredentials, input)
	}

	userinfo(callerBuild: string, input: OperationInput<typeof accounts.userinfo>) {
		return this.#kernel.execute(callerBuild, accounts.userinfo, input)
	}

	updateCredentials(callerBuild: string, input: OperationInput<typeof accounts.updateCredentials>) {
		return this.#kernel.execute(callerBuild, accounts.updateCredentials, input)
	}

	preferences(callerBuild: string, input: OperationInput<typeof accounts.preferences>) {
		return this.#kernel.execute(callerBuild, accounts.preferences, input)
	}

	relationships(callerBuild: string, input: { credential: UserCredential; ids: string[]; withSuspended?: boolean }) {
		return this.#kernel.execute(callerBuild, accounts.relationships, input)
	}

	familiarFollowers(callerBuild: string, input: OperationInput<typeof accounts.familiarFollowers>) {
		return this.#kernel.execute(callerBuild, accounts.familiarFollowers, input)
	}

	searchAccounts(callerBuild: string, input: accounts.SearchInput & { credential: UserCredential }) {
		return this.#kernel.execute(callerBuild, accounts.searchAccounts, input)
	}

	follow(callerBuild: string, input: accounts.FollowInput & { credential: UserCredential }) {
		return this.#kernel.execute(callerBuild, accounts.follow, input)
	}

	unfollow(callerBuild: string, input: { credential: UserCredential; target: string; now: number }) {
		return this.#kernel.execute(callerBuild, accounts.unfollow, input)
	}

	listFollowRequests(callerBuild: string, input: OperationInput<typeof accounts.listFollowRequests>) {
		return this.#kernel.execute(callerBuild, accounts.listFollowRequests, input)
	}

	answerFollowRequest(callerBuild: string, input: OperationInput<typeof accounts.answerFollowRequest>) {
		return this.#kernel.execute(callerBuild, accounts.answerFollowRequest, input)
	}

	listFollows(callerBuild: string, input: OperationInput<typeof accounts.listFollows>) {
		return this.#kernel.execute(callerBuild, accounts.listFollows, input)
	}

	// Accounts by id, private notes, endorsements and the removal of a follower (domain/accounts.ts,
	// domain/endorsements.ts, domain/blocks.ts).

	getAccounts(callerBuild: string, input: OperationInput<typeof accounts.getAccounts>) {
		return this.#kernel.execute(callerBuild, accounts.getAccounts, input)
	}

	setNote(callerBuild: string, input: OperationInput<typeof accounts.setNote>) {
		return this.#kernel.execute(callerBuild, accounts.setNote, input)
	}

	createReport(callerBuild: string, input: OperationInput<typeof reports.createReport>) {
		return this.#kernel.execute(callerBuild, reports.createReport, input)
	}

	// The Mastodon admin API's reports (domain/reports.ts, R37).
	adminReports(callerBuild: string, input: OperationInput<typeof reports.listAdminReports>) {
		return this.#kernel.execute(callerBuild, reports.listAdminReports, input)
	}

	adminReport(callerBuild: string, input: OperationInput<typeof reports.getAdminReport>) {
		return this.#kernel.execute(callerBuild, reports.getAdminReport, input)
	}

	updateAdminReport(callerBuild: string, input: OperationInput<typeof reports.updateAdminReport>) {
		return this.#kernel.execute(callerBuild, reports.updateAdminReport, input)
	}

	actOnReport(callerBuild: string, input: OperationInput<typeof reports.actOnReport>) {
		return this.#kernel.execute(callerBuild, reports.actOnReport, input)
	}

	// The Mastodon admin API's accounts (domain/admin-accounts.ts, R37).
	adminAccounts(callerBuild: string, input: OperationInput<typeof listAdminAccounts>) {
		return this.#kernel.execute(callerBuild, listAdminAccounts, input)
	}

	adminAccount(callerBuild: string, input: OperationInput<typeof getAdminAccount>) {
		return this.#kernel.execute(callerBuild, getAdminAccount, input)
	}

	actOnAdminAccount(callerBuild: string, input: OperationInput<typeof actOnAdminAccount>) {
		return this.#kernel.execute(callerBuild, actOnAdminAccount, input)
	}

	adminAccountAction(callerBuild: string, input: OperationInput<typeof actOnAccount>) {
		return this.#kernel.execute(callerBuild, actOnAccount, input)
	}

	unsuspendAdminAccount(callerBuild: string, input: OperationInput<typeof unsuspendAdminAccount>) {
		return this.#kernel.execute(callerBuild, unsuspendAdminAccount, input)
	}

	// The Mastodon admin API's domain blocks, domain allows and metrics (domain/admin-domain-blocks.ts,
	// domain/admin-measures.ts).
	adminDomainBlocks(callerBuild: string, input: OperationInput<typeof adminDomainBlocks.listAdminDomainBlocks>) {
		return this.#kernel.execute(callerBuild, adminDomainBlocks.listAdminDomainBlocks, input)
	}

	adminDomainBlock(callerBuild: string, input: OperationInput<typeof adminDomainBlocks.getAdminDomainBlock>) {
		return this.#kernel.execute(callerBuild, adminDomainBlocks.getAdminDomainBlock, input)
	}

	createAdminDomainBlock(callerBuild: string, input: OperationInput<typeof adminDomainBlocks.createAdminDomainBlock>) {
		return this.#kernel.execute(callerBuild, adminDomainBlocks.createAdminDomainBlock, input)
	}

	updateAdminDomainBlock(callerBuild: string, input: OperationInput<typeof adminDomainBlocks.updateAdminDomainBlock>) {
		return this.#kernel.execute(callerBuild, adminDomainBlocks.updateAdminDomainBlock, input)
	}

	deleteAdminDomainBlock(callerBuild: string, input: OperationInput<typeof adminDomainBlocks.deleteAdminDomainBlock>) {
		return this.#kernel.execute(callerBuild, adminDomainBlocks.deleteAdminDomainBlock, input)
	}

	adminFederationGranted(callerBuild: string, input: OperationInput<typeof adminDomainBlocks.federationGranted>) {
		return this.#kernel.execute(callerBuild, adminDomainBlocks.federationGranted, input)
	}

	adminDashboardGranted(callerBuild: string, input: OperationInput<typeof adminDomainBlocks.dashboardGranted>) {
		return this.#kernel.execute(callerBuild, adminDomainBlocks.dashboardGranted, input)
	}

	adminMeasure(callerBuild: string, input: OperationInput<typeof adminMeasure>) {
		return this.#kernel.execute(callerBuild, adminMeasure, input)
	}

	endorse(callerBuild: string, input: OperationInput<typeof endorsements.endorse>) {
		return this.#kernel.execute(callerBuild, endorsements.endorse, input)
	}

	unendorse(callerBuild: string, input: OperationInput<typeof endorsements.unendorse>) {
		return this.#kernel.execute(callerBuild, endorsements.unendorse, input)
	}

	listEndorsements(callerBuild: string, input: OperationInput<typeof endorsements.listEndorsements>) {
		return this.#kernel.execute(callerBuild, endorsements.listEndorsements, input)
	}

	accountEndorsements(callerBuild: string, input: OperationInput<typeof endorsements.accountEndorsements>) {
		return this.#kernel.execute(callerBuild, endorsements.accountEndorsements, input)
	}

	// The profile directory (domain/directory.ts).
	directory(callerBuild: string, input: OperationInput<typeof directory>) {
		return this.#kernel.execute(callerBuild, directory, input)
	}

	// Follow suggestions and their dismissals (domain/suggestions.ts).
	suggestions(callerBuild: string, input: OperationInput<typeof suggestions.suggestions>) {
		return this.#kernel.execute(callerBuild, suggestions.suggestions, input)
	}

	dismissSuggestion(callerBuild: string, input: OperationInput<typeof suggestions.dismissSuggestion>) {
		return this.#kernel.execute(callerBuild, suggestions.dismissSuggestion, input)
	}

	removeFromFollowers(callerBuild: string, input: OperationInput<typeof blocks.removeFromFollowers>) {
		return this.#kernel.execute(callerBuild, blocks.removeFromFollowers, input)
	}

	// Blocks, mutes and domain blocks (domain/blocks.ts).

	block(callerBuild: string, input: OperationInput<typeof blocks.block>) {
		return this.#kernel.execute(callerBuild, blocks.block, input)
	}

	unblock(callerBuild: string, input: OperationInput<typeof blocks.unblock>) {
		return this.#kernel.execute(callerBuild, blocks.unblock, input)
	}

	mute(callerBuild: string, input: OperationInput<typeof blocks.mute>) {
		return this.#kernel.execute(callerBuild, blocks.mute, input)
	}

	unmute(callerBuild: string, input: OperationInput<typeof blocks.unmute>) {
		return this.#kernel.execute(callerBuild, blocks.unmute, input)
	}

	listBlocks(callerBuild: string, input: OperationInput<typeof blocks.listBlocks>) {
		return this.#kernel.execute(callerBuild, blocks.listBlocks, input)
	}

	listMutes(callerBuild: string, input: OperationInput<typeof blocks.listMutes>) {
		return this.#kernel.execute(callerBuild, blocks.listMutes, input)
	}

	listDomainBlocks(callerBuild: string, input: OperationInput<typeof blocks.listDomainBlocks>) {
		return this.#kernel.execute(callerBuild, blocks.listDomainBlocks, input)
	}

	blockDomain(callerBuild: string, input: OperationInput<typeof blocks.blockDomain>) {
		return this.#kernel.execute(callerBuild, blocks.blockDomain, input)
	}

	unblockDomain(callerBuild: string, input: OperationInput<typeof blocks.unblockDomain>) {
		return this.#kernel.execute(callerBuild, blocks.unblockDomain, input)
	}

	previewDomainBlock(callerBuild: string, input: OperationInput<typeof blocks.previewDomainBlock>) {
		return this.#kernel.execute(callerBuild, blocks.previewDomainBlock, input)
	}

	// Filters (domain/filters.ts), v2 and the v1 layer over them.

	listFilters(callerBuild: string, input: OperationInput<typeof filters.listFilters>) {
		return this.#kernel.execute(callerBuild, filters.listFilters, input)
	}

	getFilter(callerBuild: string, input: OperationInput<typeof filters.getFilter>) {
		return this.#kernel.execute(callerBuild, filters.getFilter, input)
	}

	createFilter(callerBuild: string, input: OperationInput<typeof filters.createFilter>) {
		return this.#kernel.execute(callerBuild, filters.createFilter, input)
	}

	updateFilter(callerBuild: string, input: OperationInput<typeof filters.updateFilter>) {
		return this.#kernel.execute(callerBuild, filters.updateFilter, input)
	}

	deleteFilter(callerBuild: string, input: OperationInput<typeof filters.deleteFilter>) {
		return this.#kernel.execute(callerBuild, filters.deleteFilter, input)
	}

	listFilterKeywords(callerBuild: string, input: OperationInput<typeof filters.listFilterKeywords>) {
		return this.#kernel.execute(callerBuild, filters.listFilterKeywords, input)
	}

	createFilterKeyword(callerBuild: string, input: OperationInput<typeof filters.createFilterKeyword>) {
		return this.#kernel.execute(callerBuild, filters.createFilterKeyword, input)
	}

	getFilterKeyword(callerBuild: string, input: OperationInput<typeof filters.getFilterKeyword>) {
		return this.#kernel.execute(callerBuild, filters.getFilterKeyword, input)
	}

	updateFilterKeyword(callerBuild: string, input: OperationInput<typeof filters.updateFilterKeyword>) {
		return this.#kernel.execute(callerBuild, filters.updateFilterKeyword, input)
	}

	deleteFilterKeyword(callerBuild: string, input: OperationInput<typeof filters.deleteFilterKeyword>) {
		return this.#kernel.execute(callerBuild, filters.deleteFilterKeyword, input)
	}

	listFilterStatuses(callerBuild: string, input: OperationInput<typeof filters.listFilterStatuses>) {
		return this.#kernel.execute(callerBuild, filters.listFilterStatuses, input)
	}

	createFilterStatus(callerBuild: string, input: OperationInput<typeof filters.createFilterStatus>) {
		return this.#kernel.execute(callerBuild, filters.createFilterStatus, input)
	}

	getFilterStatus(callerBuild: string, input: OperationInput<typeof filters.getFilterStatus>) {
		return this.#kernel.execute(callerBuild, filters.getFilterStatus, input)
	}

	deleteFilterStatus(callerBuild: string, input: OperationInput<typeof filters.deleteFilterStatus>) {
		return this.#kernel.execute(callerBuild, filters.deleteFilterStatus, input)
	}

	listFiltersV1(callerBuild: string, input: OperationInput<typeof filters.listFiltersV1>) {
		return this.#kernel.execute(callerBuild, filters.listFiltersV1, input)
	}

	getFilterV1(callerBuild: string, input: OperationInput<typeof filters.getFilterV1>) {
		return this.#kernel.execute(callerBuild, filters.getFilterV1, input)
	}

	createFilterV1(callerBuild: string, input: OperationInput<typeof filters.createFilterV1>) {
		return this.#kernel.execute(callerBuild, filters.createFilterV1, input)
	}

	updateFilterV1(callerBuild: string, input: OperationInput<typeof filters.updateFilterV1>) {
		return this.#kernel.execute(callerBuild, filters.updateFilterV1, input)
	}

	deleteFilterV1(callerBuild: string, input: OperationInput<typeof filters.deleteFilterV1>) {
		return this.#kernel.execute(callerBuild, filters.deleteFilterV1, input)
	}

	// Lists (domain/lists.ts); their timeline is with the others.

	listLists(callerBuild: string, input: OperationInput<typeof lists.listLists>) {
		return this.#kernel.execute(callerBuild, lists.listLists, input)
	}

	getList(callerBuild: string, input: OperationInput<typeof lists.getList>) {
		return this.#kernel.execute(callerBuild, lists.getList, input)
	}

	createList(callerBuild: string, input: OperationInput<typeof lists.createList>) {
		return this.#kernel.execute(callerBuild, lists.createList, input)
	}

	updateList(callerBuild: string, input: OperationInput<typeof lists.updateList>) {
		return this.#kernel.execute(callerBuild, lists.updateList, input)
	}

	deleteList(callerBuild: string, input: OperationInput<typeof lists.deleteList>) {
		return this.#kernel.execute(callerBuild, lists.deleteList, input)
	}

	listAccounts(callerBuild: string, input: OperationInput<typeof lists.listAccounts>) {
		return this.#kernel.execute(callerBuild, lists.listAccounts, input)
	}

	addListAccounts(callerBuild: string, input: OperationInput<typeof lists.addListAccounts>) {
		return this.#kernel.execute(callerBuild, lists.addListAccounts, input)
	}

	removeListAccounts(callerBuild: string, input: OperationInput<typeof lists.removeListAccounts>) {
		return this.#kernel.execute(callerBuild, lists.removeListAccounts, input)
	}

	accountLists(callerBuild: string, input: OperationInput<typeof lists.accountLists>) {
		return this.#kernel.execute(callerBuild, lists.accountLists, input)
	}

	// Conversations (domain/conversations.ts).

	listConversations(callerBuild: string, input: OperationInput<typeof conversations.listConversations>) {
		return this.#kernel.execute(callerBuild, conversations.listConversations, input)
	}

	markConversation(callerBuild: string, input: OperationInput<typeof conversations.markConversation>) {
		return this.#kernel.execute(callerBuild, conversations.markConversation, input)
	}

	deleteConversation(callerBuild: string, input: OperationInput<typeof conversations.deleteConversation>) {
		return this.#kernel.execute(callerBuild, conversations.deleteConversation, input)
	}

	// Timeline markers (domain/markers.ts).

	getMarkers(callerBuild: string, input: OperationInput<typeof markers.getMarkers>) {
		return this.#kernel.execute(callerBuild, markers.getMarkers, input)
	}

	saveMarkers(callerBuild: string, input: OperationInput<typeof markers.saveMarkers>) {
		return this.#kernel.execute(callerBuild, markers.saveMarkers, input)
	}

	// Polls (domain/polls.ts).

	getPoll(callerBuild: string, input: OperationInput<typeof polls.getPoll>) {
		return this.#kernel.execute(callerBuild, polls.getPoll, input)
	}

	vote(callerBuild: string, input: OperationInput<typeof polls.vote>) {
		return this.#kernel.execute(callerBuild, polls.vote, input)
	}

	// The cron's round of polls (jobs/scheduled.ts): those that ended, and the Updates of counts that are due.
	pollRound(callerBuild: string, input: OperationInput<typeof polls.pollRound>) {
		return this.#kernel.execute(callerBuild, polls.pollRound, input)
	}

	// Scheduled statuses (domain/scheduled-statuses.ts).

	postStatus(callerBuild: string, input: OperationInput<typeof scheduled.postStatus>) {
		return this.#kernel.execute(callerBuild, scheduled.postStatus, input)
	}

	listScheduled(callerBuild: string, input: OperationInput<typeof scheduled.listScheduled>) {
		return this.#kernel.execute(callerBuild, scheduled.listScheduled, input)
	}

	getScheduled(callerBuild: string, input: OperationInput<typeof scheduled.getScheduled>) {
		return this.#kernel.execute(callerBuild, scheduled.getScheduled, input)
	}

	updateScheduled(callerBuild: string, input: OperationInput<typeof scheduled.updateScheduled>) {
		return this.#kernel.execute(callerBuild, scheduled.updateScheduled, input)
	}

	deleteScheduled(callerBuild: string, input: OperationInput<typeof scheduled.deleteScheduled>) {
		return this.#kernel.execute(callerBuild, scheduled.deleteScheduled, input)
	}

	// The cron's round (jobs/scheduled.ts): the due scheduled statuses, each published in its own transaction with one
	// of the object ids the Worker made. One that fails with an error is rolled back, then its attempt is recorded in a
	// transaction of its own (recordPublishFailure: retried later, dropped after the last attempt), and the round goes
	// on, so what keeps failing backs off and never holds back the others. A refusal of the first call (maintenance,
	// readonly) ends the round, and what is due waits for the next.
	async publishScheduled(callerBuild: string, input: { now: number; objectIds: string[] }) {
		const due = await this.#kernel.execute(callerBuild, scheduled.dueScheduled, {
			now: input.now,
			limit: input.objectIds.length,
		})
		const counts = { published: 0, dropped: 0, failed: 0, gone: 0 }
		for (const [i, id] of due.entries()) {
			try {
				const result = await this.#kernel.execute(callerBuild, scheduled.publishScheduled, {
					id,
					now: input.now,
					objectId: input.objectIds[i] ?? crypto.randomUUID(),
				})
				counts[result.status === 'published' ? 'published' : result.status === 'dropped' ? 'dropped' : 'gone']++
			} catch (error) {
				counts.failed++
				try {
					const failure = await this.#kernel.execute(callerBuild, scheduled.recordPublishFailure, {
						id,
						now: input.now,
					})
					console.error({ event: 'kopje.scheduled.status.failed', id, recorded: true, failure, ...errorFields(error) })
				} catch (recordError) {
					console.error({ event: 'kopje.scheduled.status.failed', id, recorded: false, ...errorFields(recordError) })
				}
			}
		}
		return counts
	}

	// Statuses, timelines and notifications (B4a).

	editStatus(callerBuild: string, input: OperationInput<typeof statuses.editStatus>) {
		return this.#kernel.execute(callerBuild, statuses.editStatus, input)
	}

	updateInteractionPolicy(callerBuild: string, input: OperationInput<typeof statuses.updateInteractionPolicy>) {
		return this.#kernel.execute(callerBuild, statuses.updateInteractionPolicy, input)
	}

	postTargets(callerBuild: string, input: OperationInput<typeof statuses.postTargets>) {
		return this.#kernel.execute(callerBuild, statuses.postTargets, input)
	}

	prepareRevoke(callerBuild: string, input: OperationInput<typeof statuses.prepareRevoke>) {
		return this.#kernel.execute(callerBuild, statuses.prepareRevoke, input)
	}

	revokeQuote(callerBuild: string, input: OperationInput<typeof statuses.revokeQuote>) {
		return this.#kernel.execute(callerBuild, statuses.revokeQuote, input)
	}

	deleteStatus(callerBuild: string, input: OperationInput<typeof statuses.deleteStatus>) {
		return this.#kernel.execute(callerBuild, statuses.deleteStatus, input)
	}

	getStatus(callerBuild: string, input: OperationInput<typeof statuses.getStatus>) {
		return this.#kernel.execute(callerBuild, statuses.getStatus, input)
	}

	statusContext(callerBuild: string, input: OperationInput<typeof statuses.statusContext>) {
		return this.#kernel.execute(callerBuild, statuses.statusContext, input)
	}

	statusHistory(callerBuild: string, input: OperationInput<typeof statuses.statusHistory>) {
		return this.#kernel.execute(callerBuild, statuses.statusHistory, input)
	}

	statusSource(callerBuild: string, input: OperationInput<typeof statuses.statusSource>) {
		return this.#kernel.execute(callerBuild, statuses.statusSource, input)
	}

	favourite(callerBuild: string, input: OperationInput<typeof statuses.favourite>) {
		return this.#kernel.execute(callerBuild, statuses.favourite, input)
	}

	unfavourite(callerBuild: string, input: OperationInput<typeof statuses.unfavourite>) {
		return this.#kernel.execute(callerBuild, statuses.unfavourite, input)
	}

	reblog(callerBuild: string, input: OperationInput<typeof statuses.reblog>) {
		return this.#kernel.execute(callerBuild, statuses.reblog, input)
	}

	unreblog(callerBuild: string, input: OperationInput<typeof statuses.unreblog>) {
		return this.#kernel.execute(callerBuild, statuses.unreblog, input)
	}

	bookmark(callerBuild: string, input: OperationInput<typeof statuses.bookmark>) {
		return this.#kernel.execute(callerBuild, statuses.bookmark, input)
	}

	unbookmark(callerBuild: string, input: OperationInput<typeof statuses.unbookmark>) {
		return this.#kernel.execute(callerBuild, statuses.unbookmark, input)
	}

	interactors(callerBuild: string, input: OperationInput<typeof statuses.interactors>) {
		return this.#kernel.execute(callerBuild, statuses.interactors, input)
	}

	statusQuotes(callerBuild: string, input: OperationInput<typeof statuses.statusQuotes>) {
		return this.#kernel.execute(callerBuild, statuses.statusQuotes, input)
	}

	// Statuses by id, pins and conversation mutes (domain/statuses.ts, domain/status-actions.ts).

	getStatuses(callerBuild: string, input: OperationInput<typeof statuses.getStatuses>) {
		return this.#kernel.execute(callerBuild, statuses.getStatuses, input)
	}

	pin(callerBuild: string, input: OperationInput<typeof statusActions.pin>) {
		return this.#kernel.execute(callerBuild, statusActions.pin, input)
	}

	unpin(callerBuild: string, input: OperationInput<typeof statusActions.unpin>) {
		return this.#kernel.execute(callerBuild, statusActions.unpin, input)
	}

	muteConversation(callerBuild: string, input: OperationInput<typeof statusActions.muteConversation>) {
		return this.#kernel.execute(callerBuild, statusActions.muteConversation, input)
	}

	unmuteConversation(callerBuild: string, input: OperationInput<typeof statusActions.unmuteConversation>) {
		return this.#kernel.execute(callerBuild, statusActions.unmuteConversation, input)
	}

	homeTimeline(callerBuild: string, input: OperationInput<typeof timelines.homeTimeline>) {
		return this.#kernel.execute(callerBuild, timelines.homeTimeline, input)
	}

	listTimeline(callerBuild: string, input: OperationInput<typeof timelines.listTimeline>) {
		return this.#kernel.execute(callerBuild, timelines.listTimeline, input)
	}

	publicTimeline(callerBuild: string, input: OperationInput<typeof timelines.publicTimeline>) {
		return this.#kernel.execute(callerBuild, timelines.publicTimeline, input)
	}

	tagTimeline(callerBuild: string, input: OperationInput<typeof timelines.tagTimeline>) {
		return this.#kernel.execute(callerBuild, timelines.tagTimeline, input)
	}

	// Hashtags (domain/tags.ts) and featured hashtags (domain/featured-tags.ts).
	tag(callerBuild: string, input: OperationInput<typeof tags.getTag>) {
		return this.#kernel.execute(callerBuild, tags.getTag, input)
	}

	followTag(callerBuild: string, input: OperationInput<typeof tags.followTag>) {
		return this.#kernel.execute(callerBuild, tags.followTag, input)
	}

	unfollowTag(callerBuild: string, input: OperationInput<typeof tags.unfollowTag>) {
		return this.#kernel.execute(callerBuild, tags.unfollowTag, input)
	}

	featureTag(callerBuild: string, input: OperationInput<typeof tags.featureTagOperation>) {
		return this.#kernel.execute(callerBuild, tags.featureTagOperation, input)
	}

	unfeatureTag(callerBuild: string, input: OperationInput<typeof tags.unfeatureTagOperation>) {
		return this.#kernel.execute(callerBuild, tags.unfeatureTagOperation, input)
	}

	followedTags(callerBuild: string, input: OperationInput<typeof tags.followedTags>) {
		return this.#kernel.execute(callerBuild, tags.followedTags, input)
	}

	featuredTagSuggestions(callerBuild: string, input: OperationInput<typeof tags.featuredTagSuggestions>) {
		return this.#kernel.execute(callerBuild, tags.featuredTagSuggestions, input)
	}

	listFeaturedTags(callerBuild: string, input: OperationInput<typeof featuredTags.listFeaturedTags>) {
		return this.#kernel.execute(callerBuild, featuredTags.listFeaturedTags, input)
	}

	createFeaturedTag(callerBuild: string, input: OperationInput<typeof featuredTags.createFeaturedTag>) {
		return this.#kernel.execute(callerBuild, featuredTags.createFeaturedTag, input)
	}

	deleteFeaturedTag(callerBuild: string, input: OperationInput<typeof featuredTags.deleteFeaturedTag>) {
		return this.#kernel.execute(callerBuild, featuredTags.deleteFeaturedTag, input)
	}

	accountFeaturedTags(callerBuild: string, input: OperationInput<typeof featuredTags.accountFeaturedTags>) {
		return this.#kernel.execute(callerBuild, featuredTags.accountFeaturedTags, input)
	}

	accountStatuses(callerBuild: string, input: OperationInput<typeof timelines.accountStatuses>) {
		return this.#kernel.execute(callerBuild, timelines.accountStatuses, input)
	}

	bookmarksList(callerBuild: string, input: OperationInput<typeof timelines.bookmarks>) {
		return this.#kernel.execute(callerBuild, timelines.bookmarks, input)
	}

	favouritesList(callerBuild: string, input: OperationInput<typeof timelines.favourites>) {
		return this.#kernel.execute(callerBuild, timelines.favourites, input)
	}

	listNotifications(callerBuild: string, input: OperationInput<typeof notifications.listNotifications>) {
		return this.#kernel.execute(callerBuild, notifications.listNotifications, input)
	}

	getNotification(callerBuild: string, input: OperationInput<typeof notifications.getNotification>) {
		return this.#kernel.execute(callerBuild, notifications.getNotification, input)
	}

	dismissNotification(callerBuild: string, input: OperationInput<typeof notifications.dismissNotification>) {
		return this.#kernel.execute(callerBuild, notifications.dismissNotification, input)
	}

	clearNotifications(callerBuild: string, input: OperationInput<typeof notifications.clearNotifications>) {
		return this.#kernel.execute(callerBuild, notifications.clearNotifications, input)
	}

	// Grouped notifications (API v2) and the unread counts.
	listGroupedNotifications(
		callerBuild: string,
		input: OperationInput<typeof notificationGroups.listGroupedNotifications>
	) {
		return this.#kernel.execute(callerBuild, notificationGroups.listGroupedNotifications, input)
	}

	getNotificationGroup(callerBuild: string, input: OperationInput<typeof notificationGroups.getNotificationGroup>) {
		return this.#kernel.execute(callerBuild, notificationGroups.getNotificationGroup, input)
	}

	notificationGroupAccounts(
		callerBuild: string,
		input: OperationInput<typeof notificationGroups.notificationGroupAccounts>
	) {
		return this.#kernel.execute(callerBuild, notificationGroups.notificationGroupAccounts, input)
	}

	dismissNotificationGroup(
		callerBuild: string,
		input: OperationInput<typeof notificationGroups.dismissNotificationGroup>
	) {
		return this.#kernel.execute(callerBuild, notificationGroups.dismissNotificationGroup, input)
	}

	unreadNotificationCount(callerBuild: string, input: OperationInput<typeof notificationGroups.unreadCount>) {
		return this.#kernel.execute(callerBuild, notificationGroups.unreadCount, input)
	}

	unreadNotificationGroupCount(callerBuild: string, input: OperationInput<typeof notificationGroups.unreadGroupCount>) {
		return this.#kernel.execute(callerBuild, notificationGroups.unreadGroupCount, input)
	}

	// The notification policy and notification requests.
	getNotificationPolicy(callerBuild: string, input: OperationInput<typeof notificationRequests.getNotificationPolicy>) {
		return this.#kernel.execute(callerBuild, notificationRequests.getNotificationPolicy, input)
	}

	updateNotificationPolicy(
		callerBuild: string,
		input: OperationInput<typeof notificationRequests.updateNotificationPolicy>
	) {
		return this.#kernel.execute(callerBuild, notificationRequests.updateNotificationPolicy, input)
	}

	listNotificationRequests(
		callerBuild: string,
		input: OperationInput<typeof notificationRequests.listNotificationRequests>
	) {
		return this.#kernel.execute(callerBuild, notificationRequests.listNotificationRequests, input)
	}

	getNotificationRequest(
		callerBuild: string,
		input: OperationInput<typeof notificationRequests.getNotificationRequest>
	) {
		return this.#kernel.execute(callerBuild, notificationRequests.getNotificationRequest, input)
	}

	acceptNotificationRequest(
		callerBuild: string,
		input: OperationInput<typeof notificationRequests.acceptNotificationRequest>
	) {
		return this.#kernel.execute(callerBuild, notificationRequests.acceptNotificationRequest, input)
	}

	dismissNotificationRequest(
		callerBuild: string,
		input: OperationInput<typeof notificationRequests.dismissNotificationRequest>
	) {
		return this.#kernel.execute(callerBuild, notificationRequests.dismissNotificationRequest, input)
	}

	acceptNotificationRequests(
		callerBuild: string,
		input: OperationInput<typeof notificationRequests.acceptNotificationRequests>
	) {
		return this.#kernel.execute(callerBuild, notificationRequests.acceptNotificationRequests, input)
	}

	dismissNotificationRequests(
		callerBuild: string,
		input: OperationInput<typeof notificationRequests.dismissNotificationRequests>
	) {
		return this.#kernel.execute(callerBuild, notificationRequests.dismissNotificationRequests, input)
	}

	notificationRequestsMerged(
		callerBuild: string,
		input: OperationInput<typeof notificationRequests.notificationRequestsMerged>
	) {
		return this.#kernel.execute(callerBuild, notificationRequests.notificationRequestsMerged, input)
	}

	// Web Push: the token's subscription, and the Worker's push rounds (jobs/push.ts).

	createPushSubscription(callerBuild: string, input: OperationInput<typeof push.createPushSubscription>) {
		return this.#kernel.execute(callerBuild, push.createPushSubscription, input)
	}

	getPushSubscription(callerBuild: string, input: OperationInput<typeof push.getPushSubscription>) {
		return this.#kernel.execute(callerBuild, push.getPushSubscription, input)
	}

	updatePushSubscription(callerBuild: string, input: OperationInput<typeof push.updatePushSubscription>) {
		return this.#kernel.execute(callerBuild, push.updatePushSubscription, input)
	}

	deletePushSubscription(callerBuild: string, input: OperationInput<typeof push.deletePushSubscription>) {
		return this.#kernel.execute(callerBuild, push.deletePushSubscription, input)
	}

	claimPushes(callerBuild: string, input: OperationInput<typeof push.claimPushes>) {
		return this.#kernel.execute(callerBuild, push.claimPushes, input)
	}

	confirmPush(callerBuild: string, input: OperationInput<typeof push.confirmPush>) {
		return this.#kernel.execute(callerBuild, push.confirmPush, input)
	}

	completePush(callerBuild: string, input: OperationInput<typeof push.completePush>) {
		return this.#kernel.execute(callerBuild, push.completePush, input)
	}

	// Media (B4b).

	reserveMedia(callerBuild: string, input: OperationInput<typeof media.reserveMedia>) {
		return this.#kernel.execute(callerBuild, media.reserveMedia, input)
	}

	completeMedia(callerBuild: string, input: OperationInput<typeof media.completeMedia>) {
		return this.#kernel.execute(callerBuild, media.completeMedia, input)
	}

	abandonMedia(callerBuild: string, input: OperationInput<typeof media.abandonMedia>) {
		return this.#kernel.execute(callerBuild, media.abandonMedia, input)
	}

	getMedia(callerBuild: string, input: OperationInput<typeof media.getMedia>) {
		return this.#kernel.execute(callerBuild, media.getMedia, input)
	}

	updateMedia(callerBuild: string, input: OperationInput<typeof media.updateMedia>) {
		return this.#kernel.execute(callerBuild, media.updateMedia, input)
	}

	deleteMedia(callerBuild: string, input: OperationInput<typeof media.deleteMedia>) {
		return this.#kernel.execute(callerBuild, media.deleteMedia, input)
	}

	removeProfileImage(callerBuild: string, input: OperationInput<typeof media.removeProfileImage>) {
		return this.#kernel.execute(callerBuild, media.removeProfileImage, input)
	}

	startTransforms(callerBuild: string, input: OperationInput<typeof media.startTransforms>) {
		return this.#kernel.execute(callerBuild, media.startTransforms, input)
	}

	dueOrphans(callerBuild: string, input: OperationInput<typeof media.dueOrphans>) {
		return this.#kernel.execute(callerBuild, media.dueOrphans, input)
	}

	forgetOrphans(callerBuild: string, input: OperationInput<typeof media.forgetOrphans>) {
		return this.#kernel.execute(callerBuild, media.forgetOrphans, input)
	}

	expiredMedia(callerBuild: string, input: OperationInput<typeof media.expiredMedia>) {
		return this.#kernel.execute(callerBuild, media.expiredMedia, input)
	}

	purgeMedia(callerBuild: string, input: OperationInput<typeof media.purgeMedia>) {
		return this.#kernel.execute(callerBuild, media.purgeMedia, input)
	}

	// The media rebuild (domain/media-rebuild.ts), from /admin/media/rebuild. Each runs at the Store's own time, never a
	// time the caller sends, so the lease and the fences that read it (store-admin.ts, store-flags.ts) share one clock.

	mediaRebuildCandidates(
		callerBuild: string,
		input: Omit<OperationInput<typeof mediaRebuild.rebuildCandidates>, 'now'>
	) {
		return this.#kernel.execute(callerBuild, mediaRebuild.rebuildCandidates, { ...input, now: Date.now() })
	}

	mediaRebuildRowLive(callerBuild: string, input: Omit<OperationInput<typeof mediaRebuild.rebuildRowLive>, 'now'>) {
		return this.#kernel.execute(callerBuild, mediaRebuild.rebuildRowLive, { ...input, now: Date.now() })
	}

	async mediaRebuildLease(
		callerBuild: string,
		input: Omit<OperationInput<typeof mediaRebuild.rebuildLease>, 'now' | 'restoredAt'>
	) {
		const restoredAt = await lastRestore(this.env.MEDIA, restoreMarkerKey(this.ctx.id.toString()))
		return this.#kernel.execute(callerBuild, mediaRebuild.rebuildLease, { ...input, restoredAt, now: Date.now() })
	}

	chargeMediaRebuild(callerBuild: string, input: Omit<OperationInput<typeof mediaRebuild.chargeRebuild>, 'now'>) {
		return this.#kernel.execute(callerBuild, mediaRebuild.chargeRebuild, { ...input, now: Date.now() })
	}

	recordMediaRebuild(callerBuild: string, input: Omit<OperationInput<typeof mediaRebuild.recordRebuild>, 'now'>) {
		return this.#kernel.execute(callerBuild, mediaRebuild.recordRebuild, { ...input, now: Date.now() })
	}

	// Local custom emoji (domain/local-emojis.ts): the Access admin's writes from /admin/emojis, each at the Store's own
	// time, so the writer deadline is judged on one clock; the public list and the Emoji object.

	reserveEmoji(callerBuild: string, input: Omit<OperationInput<typeof localEmojis.reserveEmoji>, 'now'>) {
		return this.#kernel.execute(callerBuild, localEmojis.reserveEmoji, { ...input, now: Date.now() })
	}

	completeEmoji(callerBuild: string, input: Omit<OperationInput<typeof localEmojis.completeEmoji>, 'now'>) {
		return this.#kernel.execute(callerBuild, localEmojis.completeEmoji, { ...input, now: Date.now() })
	}

	abandonEmoji(callerBuild: string, input: Omit<OperationInput<typeof localEmojis.abandonEmoji>, 'now'>) {
		return this.#kernel.execute(callerBuild, localEmojis.abandonEmoji, { ...input, now: Date.now() })
	}

	updateEmoji(callerBuild: string, input: Omit<OperationInput<typeof localEmojis.updateEmoji>, 'now'>) {
		return this.#kernel.execute(callerBuild, localEmojis.updateEmoji, { ...input, now: Date.now() })
	}

	adminEmojis(callerBuild: string, input: OperationInput<typeof localEmojis.adminEmojis>) {
		return this.#kernel.execute(callerBuild, localEmojis.adminEmojis, input)
	}

	customEmojis(callerBuild: string) {
		return this.#kernel.execute(callerBuild, localEmojis.customEmojis, undefined)
	}

	localEmojiObject(callerBuild: string, input: OperationInput<typeof localEmojis.localEmojiObject>) {
		return this.#kernel.execute(callerBuild, localEmojis.localEmojiObject, input)
	}

	// Announcements (domain/announcements.ts): the signed-in user's list, dismissals and reactions; the Access admin's
	// writes from /admin/announcements, each at the Store's own time, and its list; the cron's round.

	listAnnouncements(callerBuild: string, input: OperationInput<typeof announcements.listAnnouncements>) {
		return this.#kernel.execute(callerBuild, announcements.listAnnouncements, input)
	}

	dismissAnnouncement(callerBuild: string, input: OperationInput<typeof announcements.dismissAnnouncement>) {
		return this.#kernel.execute(callerBuild, announcements.dismissAnnouncement, input)
	}

	reactToAnnouncement(callerBuild: string, input: OperationInput<typeof announcements.reactToAnnouncement>) {
		return this.#kernel.execute(callerBuild, announcements.reactToAnnouncement, input)
	}

	unreactToAnnouncement(callerBuild: string, input: OperationInput<typeof announcements.unreactToAnnouncement>) {
		return this.#kernel.execute(callerBuild, announcements.unreactToAnnouncement, input)
	}

	createAnnouncement(callerBuild: string, input: Omit<OperationInput<typeof announcements.createAnnouncement>, 'now'>) {
		return this.#kernel.execute(callerBuild, announcements.createAnnouncement, { ...input, now: Date.now() })
	}

	updateAnnouncement(callerBuild: string, input: Omit<OperationInput<typeof announcements.updateAnnouncement>, 'now'>) {
		return this.#kernel.execute(callerBuild, announcements.updateAnnouncement, { ...input, now: Date.now() })
	}

	publishAnnouncement(
		callerBuild: string,
		input: Omit<OperationInput<typeof announcements.publishAnnouncement>, 'now'>
	) {
		return this.#kernel.execute(callerBuild, announcements.publishAnnouncement, { ...input, now: Date.now() })
	}

	unpublishAnnouncement(
		callerBuild: string,
		input: Omit<OperationInput<typeof announcements.unpublishAnnouncement>, 'now'>
	) {
		return this.#kernel.execute(callerBuild, announcements.unpublishAnnouncement, { ...input, now: Date.now() })
	}

	deleteAnnouncement(callerBuild: string, input: Omit<OperationInput<typeof announcements.deleteAnnouncement>, 'now'>) {
		return this.#kernel.execute(callerBuild, announcements.deleteAnnouncement, { ...input, now: Date.now() })
	}

	adminAnnouncements(callerBuild: string, input: OperationInput<typeof announcements.adminAnnouncements>) {
		return this.#kernel.execute(callerBuild, announcements.adminAnnouncements, input)
	}

	announcementRound(callerBuild: string, input: OperationInput<typeof announcements.announcementRound>) {
		return this.#kernel.execute(callerBuild, announcements.announcementRound, input)
	}

	// Trends (domain/trends.ts): the public lists, and the cron's round.

	trendingTags(callerBuild: string, input: OperationInput<typeof trends.trendingTags>) {
		return this.#kernel.execute(callerBuild, trends.trendingTags, input)
	}

	trendingStatuses(callerBuild: string, input: OperationInput<typeof trends.trendingStatuses>) {
		return this.#kernel.execute(callerBuild, trends.trendingStatuses, input)
	}

	// The Access admin's lists and reviews from /admin/trends, each at the Store's own time.

	adminTrendTags(callerBuild: string, input: Omit<OperationInput<typeof trends.adminTrendTags>, 'now'>) {
		return this.#kernel.execute(callerBuild, trends.adminTrendTags, { ...input, now: Date.now() })
	}

	adminTrendStatuses(callerBuild: string, input: OperationInput<typeof trends.adminTrendStatuses>) {
		return this.#kernel.execute(callerBuild, trends.adminTrendStatuses, input)
	}

	reviewTrendTag(callerBuild: string, input: Omit<OperationInput<typeof trends.reviewTrendTag>, 'now'>) {
		return this.#kernel.execute(callerBuild, trends.reviewTrendTag, { ...input, now: Date.now() })
	}

	reviewTrendStatus(callerBuild: string, input: Omit<OperationInput<typeof trends.reviewTrendStatus>, 'now'>) {
		return this.#kernel.execute(callerBuild, trends.reviewTrendStatus, { ...input, now: Date.now() })
	}

	trendsRound(callerBuild: string, input: OperationInput<typeof trends.trendsRound>) {
		return this.#kernel.execute(callerBuild, trends.trendsRound, input)
	}

	// Search (B4b).

	search(callerBuild: string, input: OperationInput<typeof search>) {
		return this.#kernel.execute(callerBuild, search, input)
	}

	// Search with resolve=true (B1b-2): stores what the Worker fetched, as inbound activities are stored.
	resolveSearch(callerBuild: string, input: OperationInput<typeof resolveSearch>) {
		return this.#kernel.execute(callerBuild, resolveSearch, input)
	}

	// Delivery (B2): claims, confirmations and completions from the Worker's delivery round, the operator's view, and
	// the sweep.

	claimDeliveries(callerBuild: string, input: OperationInput<typeof deliveries.claimDeliveries>) {
		return this.#kernel.execute(callerBuild, deliveries.claimDeliveries, input)
	}

	confirmDelivery(callerBuild: string, input: OperationInput<typeof deliveries.confirmDelivery>) {
		return this.#kernel.execute(callerBuild, deliveries.confirmDelivery, input)
	}

	completeDelivery(callerBuild: string, input: OperationInput<typeof deliveries.completeDelivery>) {
		return this.#kernel.execute(callerBuild, deliveries.completeDelivery, input)
	}

	deliveriesReport(callerBuild: string, input: OperationInput<typeof deliveries.deliveriesReport>) {
		return this.#kernel.execute(callerBuild, deliveries.deliveriesReport, input)
	}

	retryDeliveries(callerBuild: string, input: OperationInput<typeof deliveries.retryDeliveries>) {
		return this.#kernel.execute(callerBuild, deliveries.retryDeliveries, input)
	}

	sweepDeliveries(callerBuild: string, input: OperationInput<typeof deliveries.sweepDeliveries>) {
		return this.#kernel.execute(callerBuild, deliveries.sweepDeliveries, input)
	}

	// Local objects over ActivityPub (VIS-4).

	localNote(callerBuild: string, input: OperationInput<typeof activities.getLocalNote>) {
		return this.#kernel.execute(callerBuild, activities.getLocalNote, input)
	}

	legacyObject(callerBuild: string, input: OperationInput<typeof activities.getLegacyObject>) {
		return this.#kernel.execute(callerBuild, activities.getLegacyObject, input)
	}

	outbox(callerBuild: string, input: OperationInput<typeof activities.getOutbox>) {
		return this.#kernel.execute(callerBuild, activities.getOutbox, input)
	}

	featured(callerBuild: string, input: OperationInput<typeof activities.getFeatured>) {
		return this.#kernel.execute(callerBuild, activities.getFeatured, input)
	}

	override async alarm(): Promise<void> {
		await this.#kernel.upgrade()
	}
}
