import { DurableObject } from 'cloudflare:workers'

import { MIGRATIONS } from './db/migrations'
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
import { kvCas, kvDelete, kvGet, kvList, kvSet } from './domain/fedify-kv'
import { acceptInbox, type InboxDelivery } from './domain/inbox'
import { getSetupState } from './domain/setup'
import { saveSnapshot } from './domain/snapshot'
import { StoreKernel, type StoreOperation } from './platform/store-kernel'
import { buildOf, PACKAGE_VERSION } from './version'

type OperationInput<T> = T extends StoreOperation<infer I, unknown> ? I : never

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

	override async alarm(): Promise<void> {
		await this.#kernel.upgrade()
	}
}
