import { DurableObject } from 'cloudflare:workers'

import { MIGRATIONS } from './db/migrations'
import { acceptInbox, type InboxDelivery } from './domain/inbox'
import { getSetupState } from './domain/setup'
import { StoreAdmin } from './platform/store-admin'
import type { ImportRecord } from './platform/store-flags'
import { StoreKernel } from './platform/store-kernel'
import { buildOf, PACKAGE_VERSION } from './version'

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

	dumpStart(_callerBuild: string, leaseSeconds?: number) {
		return this.#admin.dumpStart(leaseSeconds)
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

	importBegin(callerBuild: string, header: unknown, mode: ImportRecord['mode']) {
		return this.#admin.importBegin(callerBuild, header, mode)
	}

	importChunk(callerBuild: string, id: string, seq: number, bytes: Uint8Array) {
		return this.#admin.importChunk(callerBuild, id, seq, bytes)
	}

	importFinish(callerBuild: string, id: string, trailer: unknown) {
		return this.#admin.importFinish(callerBuild, id, trailer)
	}

	importVerify(callerBuild: string, id: string) {
		return this.#admin.importVerify(callerBuild, id)
	}

	importProgress(_callerBuild: string) {
		return this.#admin.importProgress()
	}

	importReset(callerBuild: string) {
		return this.#admin.importReset(callerBuild)
	}

	setupState(callerBuild: string) {
		return this.#kernel.execute(callerBuild, getSetupState, undefined)
	}

	receiveInbox(callerBuild: string, delivery: InboxDelivery) {
		return this.#kernel.execute(callerBuild, acceptInbox, delivery)
	}

	override async alarm(): Promise<void> {
		await this.#kernel.upgrade()
	}
}
