import { DurableObject } from 'cloudflare:workers'

import { MIGRATIONS } from './db/migrations'
import * as accounts from './domain/accounts'
import * as activities from './domain/activities'
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
import * as notifications from './domain/notifications'
import * as oauth from './domain/oauth'
import { getSetupState } from './domain/setup'
import { saveSnapshot } from './domain/snapshot'
import * as statuses from './domain/statuses'
import * as timelines from './domain/timelines'
import { type ImportAuthority, StoreAdmin } from './platform/store-admin'
import { StoreKernel, type StoreOperation } from './platform/store-kernel'
import { buildOf, PACKAGE_VERSION } from './version'

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
		this.#admin = new StoreAdmin(ctx, this.#kernel, { source: { build, version: PACKAGE_VERSION } })
	}

	health(callerBuild: string) {
		return this.#kernel.health(callerBuild)
	}

	async version(_callerBuild: string) {
		return { ...(await this.#kernel.version()), version: PACKAGE_VERSION }
	}

	pitrToBookmark(callerBuild: string, bookmark: string) {
		return this.#kernel.restoreBookmark(callerBuild, bookmark)
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

	catalog(_callerBuild: string) {
		return this.#admin.catalog()
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

	setConfig(callerBuild: string, authority: ImportAuthority, values: unknown) {
		return this.#admin.setConfig(callerBuild, authority, values)
	}

	setupState(callerBuild: string) {
		return this.#kernel.execute(callerBuild, getSetupState, undefined)
	}

	// Inbound activities (B1b): the Worker verifies and prepares, the Store authorizes and applies (domain/inbox.ts).

	receiveActivity(callerBuild: string, input: inbox.ReceiveInput) {
		return this.#kernel.execute(callerBuild, inbox.receiveActivity, input)
	}

	runInboundJobs(callerBuild: string, input: OperationInput<typeof inbox.runInboundJobs>) {
		return this.#kernel.execute(callerBuild, inbox.runInboundJobs, input)
	}

	remoteKey(callerBuild: string, input: OperationInput<typeof inbox.getRemoteKey>) {
		return this.#kernel.execute(callerBuild, inbox.getRemoteKey, input)
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

	updateCredentials(
		callerBuild: string,
		input: { credential: UserCredential; changes: accounts.CredentialChanges; present: accounts.Present }
	) {
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

	outbox(callerBuild: string, input: OperationInput<typeof activities.getOutbox>) {
		return this.#kernel.execute(callerBuild, activities.getOutbox, input)
	}

	override async alarm(): Promise<void> {
		await this.#kernel.upgrade()
	}
}
