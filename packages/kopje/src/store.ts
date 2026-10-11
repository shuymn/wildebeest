import { DurableObject } from 'cloudflare:workers'

import { MIGRATIONS } from './db/migrations'
import { getSetupState } from './domain/setup'
import { StoreKernel } from './platform/store-kernel'
import { buildOf, PACKAGE_VERSION } from './version'

// The single source of truth of an instance: one SQLite-backed Durable Object. Every RPC takes the caller's build
// (the Workers version id, see version.ts). Domain operations run through the kernel's gate; rescue RPCs (health, version, PITR, dump) work in
// every state.
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

	pitrToBookmark(_callerBuild: string, bookmark: string) {
		return this.#kernel.restoreBookmark(bookmark)
	}

	dump(_callerBuild: string): { status: 'unimplemented' } {
		return { status: 'unimplemented' }
	}

	setupState(callerBuild: string) {
		return this.#kernel.execute(callerBuild, getSetupState, undefined)
	}

	override async alarm(): Promise<void> {
		await this.#kernel.upgrade()
	}
}
