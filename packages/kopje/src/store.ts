import { DurableObject } from 'cloudflare:workers'

import { MIGRATIONS } from './db/migrations'
import * as accounts from './domain/accounts'
import { checkCredential, type Credential, type UserCredential } from './domain/auth'
import { acceptInbox, type InboxDelivery } from './domain/inbox'
import { instanceInfo } from './domain/instance'
import * as oauth from './domain/oauth'
import { getSetupState } from './domain/setup'
import { StoreKernel } from './platform/store-kernel'
import { buildOf, PACKAGE_VERSION } from './version'

// The single source of truth of an instance: one SQLite-backed Durable Object. Every RPC takes the caller's build
// (the Workers version id, see version.ts). Domain operations run through the kernel's gate. Rescue RPCs work in every
// Store state. Of those, health(), version() and dump() are read-only introspection and accept any caller build, since
// they are what an operator needs while the Worker and the Store disagree; pitrToBookmark() rewinds the database, so
// it requires the caller's build to match like any other mutation.
export class Store extends DurableObject<Env> {
	readonly #kernel: StoreKernel

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		this.#kernel = new StoreKernel(ctx, { build: buildOf(env), migrations: MIGRATIONS })
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

	dump(_callerBuild: string): { status: 'unimplemented' } {
		return { status: 'unimplemented' }
	}

	setupState(callerBuild: string) {
		return this.#kernel.execute(callerBuild, getSetupState, undefined)
	}

	receiveInbox(callerBuild: string, delivery: InboxDelivery) {
		return this.#kernel.execute(callerBuild, acceptInbox, delivery)
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

	unfollow(callerBuild: string, input: { credential: UserCredential; target: string }) {
		return this.#kernel.execute(callerBuild, accounts.unfollow, input)
	}

	listFollows(callerBuild: string, input: accounts.ListFollowsInput) {
		return this.#kernel.execute(callerBuild, accounts.listFollows, input)
	}

	override async alarm(): Promise<void> {
		await this.#kernel.upgrade()
	}
}
