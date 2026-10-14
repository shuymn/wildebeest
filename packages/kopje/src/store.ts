import { DurableObject } from 'cloudflare:workers'

import { MIGRATIONS } from './db/migrations'
import { Db } from './db/sql'
import * as accounts from './domain/accounts'
import * as activities from './domain/activities'
import { announceConvertedProfiles } from './domain/actor-update'
import {
	ensureInstanceActorKey,
	getCollection,
	getInstanceActorKey,
	getInstanceDomain,
	getLocalActor,
	getLocalKey,
	getNodeInfoUsage,
	listLocalKeys,
} from './domain/actors'
import { checkCredential, type Credential, type UserCredential } from './domain/auth'
import * as deliveries from './domain/deliveries'
import { kvCas, kvDelete, kvGet, kvList, kvSet } from './domain/fedify-kv'
import * as inbox from './domain/inbox'
import { instanceInfo } from './domain/instance'
import * as media from './domain/media'
import * as mediaRebuild from './domain/media-rebuild'
import * as notifications from './domain/notifications'
import * as oauth from './domain/oauth'
import * as push from './domain/push'
import { resolveSearch } from './domain/remote-statuses'
import { search } from './domain/search'
import * as setup from './domain/setup'
import { saveSnapshot } from './domain/snapshot'
import * as statuses from './domain/statuses'
import * as timelines from './domain/timelines'
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
import { restoreMarkerKey } from './platform/media-files'
import { type ImportAuthority, StoreAdmin } from './platform/store-admin'
import { readFlags } from './platform/store-flags'
import { StoreKernel, type StoreOperation } from './platform/store-kernel'
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
export class Store extends DurableObject<Env> {
	readonly #kernel: StoreKernel
	readonly #admin: StoreAdmin

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		const build = buildOf(env)
		this.#kernel = new StoreKernel(ctx, { build, migrations: MIGRATIONS })
		this.#admin = new StoreAdmin(ctx, this.#kernel, {
			source: { build, version: PACKAGE_VERSION },
			onPublish: (sql, now) => announceConvertedProfiles(new Db(sql), now),
		})
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
	importBegin(callerBuild: string, authority: ImportAuthority, header: unknown) {
		return this.#admin.importBegin(callerBuild, authority, header)
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

	// Inbound activities (B1b): the Worker verifies and prepares, the Store authorizes and applies (domain/inbox.ts).

	async receiveActivity(callerBuild: string, input: inbox.ReceiveInput): Promise<inbox.ReceiveResult> {
		try {
			return await this.#kernel.execute(callerBuild, inbox.receiveActivity, input)
		} catch (error) {
			// Rolled back: a retryable refusal changes nothing (domain/inbox.ts, RetryLater).
			if (error instanceof inbox.RetryLater) {
				return inbox.retryResult(error)
			}
			throw error
		}
	}

	runInboundJobs(callerBuild: string, input: OperationInput<typeof inbox.runInboundJobs>) {
		return this.#kernel.execute(callerBuild, inbox.runInboundJobs, input)
	}

	remoteKey(callerBuild: string, input: OperationInput<typeof inbox.getRemoteKey>) {
		return this.#kernel.execute(callerBuild, inbox.getRemoteKey, input)
	}

	inboxWritable(callerBuild: string) {
		return this.#kernel.execute(callerBuild, inbox.inboxWritable, undefined)
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

	collection(callerBuild: string, input: OperationInput<typeof getCollection>) {
		return this.#kernel.execute(callerBuild, getCollection, input)
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

	suspendAccount(callerBuild: string, input: { accountId: string; now: number }) {
		return this.#kernel.execute(callerBuild, oauth.suspendAccount, input)
	}

	instanceInfo(callerBuild: string) {
		return this.#kernel.execute(callerBuild, instanceInfo, undefined)
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

	updateCredentials(callerBuild: string, input: OperationInput<typeof accounts.updateCredentials>) {
		return this.#kernel.execute(callerBuild, accounts.updateCredentials, input)
	}

	relationships(callerBuild: string, input: { credential: UserCredential; ids: string[] }) {
		return this.#kernel.execute(callerBuild, accounts.relationships, input)
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

	listFollows(callerBuild: string, input: accounts.ListFollowsInput) {
		return this.#kernel.execute(callerBuild, accounts.listFollows, input)
	}

	// Statuses, timelines and notifications (B4a).

	createStatus(callerBuild: string, input: OperationInput<typeof statuses.createStatus>) {
		return this.#kernel.execute(callerBuild, statuses.createStatus, input)
	}

	editStatus(callerBuild: string, input: OperationInput<typeof statuses.editStatus>) {
		return this.#kernel.execute(callerBuild, statuses.editStatus, input)
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

	homeTimeline(callerBuild: string, input: OperationInput<typeof timelines.homeTimeline>) {
		return this.#kernel.execute(callerBuild, timelines.homeTimeline, input)
	}

	publicTimeline(callerBuild: string, input: OperationInput<typeof timelines.publicTimeline>) {
		return this.#kernel.execute(callerBuild, timelines.publicTimeline, input)
	}

	tagTimeline(callerBuild: string, input: OperationInput<typeof timelines.tagTimeline>) {
		return this.#kernel.execute(callerBuild, timelines.tagTimeline, input)
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

	setProfileImage(callerBuild: string, input: OperationInput<typeof media.setProfileImage>) {
		return this.#kernel.execute(callerBuild, media.setProfileImage, input)
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

	// Search (B4b).

	search(callerBuild: string, input: OperationInput<typeof search>) {
		return this.#kernel.execute(callerBuild, search, input)
	}

	// Search with resolve=true (B1b-2): stores what the Worker fetched, as inbound activities are stored.
	resolveSearch(callerBuild: string, input: OperationInput<typeof resolveSearch>) {
		return this.#kernel.execute(callerBuild, resolveSearch, input)
	}

	// Delivery (B2): claims and completions from the Worker's delivery round, the operator's view, and the sweep.

	claimDeliveries(callerBuild: string, input: OperationInput<typeof deliveries.claimDeliveries>) {
		return this.#kernel.execute(callerBuild, deliveries.claimDeliveries, input)
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

	override async alarm(): Promise<void> {
		await this.#kernel.upgrade()
	}
}
