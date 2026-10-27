import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

import { MIGRATIONS } from '../src/db/migrations'
import type { Claim, ClaimedDelivery, DeliveryOutcome } from '../src/domain/deliveries'
import { STORE_JOB_FAMILIES } from '../src/jobs/queue'
import type { StoreStub } from '../src/platform/store-client'
import { type KernelOptions, type Migration, StoreKernel } from '../src/platform/store-kernel'

// The build identity of this test run: the Workers version id that both the Worker and the Store see.
export const BUILD = env.CF_VERSION_METADATA.id

// The shipped migrations by name, in order, and the newest: what a migrated Store reports as applied.
export const MIGRATION_NAMES = MIGRATIONS.map((m) => m.name)
export const LATEST_MIGRATION = MIGRATION_NAMES.at(-1)

// Each test gets its own Store object, so test files can run in parallel without sharing state.
export function freshStore(): StoreStub {
	return env.STORE.getByName(crypto.randomUUID())
}

// A kernel of this build with logging silenced.
export function testKernel(
	state: DurableObjectState,
	migrations: readonly Migration[] = MIGRATIONS,
	extra: Partial<KernelOptions> = {}
): StoreKernel {
	return new StoreKernel(state, { build: BUILD, migrations, log: () => {}, ...extra })
}

export async function migratedStore(): Promise<StoreStub> {
	const store = freshStore()
	await runInDurableObject(store, (_instance, state) => testKernel(state).upgrade())
	return store
}

// The Store's part of a jobs round (STORE_JOB_FAMILIES, jobs/queue.ts), each family in turn and without the round's
// error boundaries: whether any family has work left, and whether any staged deliveries.
export async function runStoreJobs(
	store: StoreStub,
	build: string,
	input: { now: number }
): Promise<{ pending: boolean; delivers: boolean }> {
	let pending = false
	let delivers = false
	for (const { run } of STORE_JOB_FAMILIES) {
		const result = await run(store, build, input)
		pending = pending || result.pending
		delivers = delivers || result.delivers
	}
	return { pending, delivers }
}

// Fixes the instance domain, as /setup does, so federation routes are reachable.
export async function completeSetup(store: StoreStub): Promise<void> {
	await runInDurableObject(store, (_instance, state) => {
		state.storage.sql.exec("INSERT INTO instance_settings (name, value) VALUES ('domain', 'kopje.test')")
	})
}

// Settles an RPC call and returns its rejection. Handing an RPC promise straight to expect().rejects leaves the
// pipelined promise unhandled in the pool.
export async function rejectionOf(call: Promise<unknown>): Promise<unknown> {
	return call.then(
		() => undefined,
		(error: unknown) => error
	)
}

export function tableNames(sql: SqlStorage): string[] {
	return sql
		.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
		.toArray()
		.map((row) => row.name)
}

export type SentClaim = Omit<Claim, 'deliveries'> & { deliveries: (ClaimedDelivery & { body: string })[] }

// A claim, with each claimed row's body as its confirmation reads it in the same lease, right after: what the Worker
// sends (confirmDelivery). Every claimed row must still be sendable.
export async function claimSent(
	store: StoreStub,
	input: { now: number; leaseToken: string; limit?: number }
): Promise<SentClaim> {
	const claim = await store.claimDeliveries(BUILD, input)
	const deliveries: SentClaim['deliveries'] = []
	for (const delivery of claim.deliveries) {
		const confirmation = await store.confirmDelivery(BUILD, {
			id: delivery.id,
			leaseToken: input.leaseToken,
			now: input.now,
		})
		if (confirmation.status !== 'send') {
			throw new Error(`delivery ${delivery.id} claimed, then ${confirmation.status} at confirmation`)
		}
		deliveries.push({ ...delivery, body: confirmation.body })
	}
	return { ...claim, deliveries }
}

// One claim at `now`: each claimed row is confirmed, and each one confirmation lets through is completed with
// `outcome` (null: left leased), one row at a time. Returns the claim and, in order, each sent row's inbox and body.
export async function claimAndSettle(
	store: StoreStub,
	input: { now: number; leaseToken: string; outcome: DeliveryOutcome | null }
): Promise<{ claim: Claim; sent: { inbox: string; body: string }[] }> {
	const { now, leaseToken, outcome } = input
	const claim = await store.claimDeliveries(BUILD, { now, leaseToken })
	const sent: { inbox: string; body: string }[] = []
	for (const delivery of claim.deliveries) {
		const confirmation = await store.confirmDelivery(BUILD, { id: delivery.id, leaseToken, now })
		if (confirmation.status === 'send') {
			sent.push({ inbox: delivery.inbox, body: confirmation.body })
			if (outcome !== null) {
				await store.completeDelivery(BUILD, { id: delivery.id, leaseToken, now, outcome })
			}
		}
	}
	return { claim, sent }
}

// An email whose local part holds the three letters JavaScript's case folding treats unlike SQLite's lower() (AUTH-9,
// platform/login-email.ts), and its variants: each Unicode one equals it after JavaScript's trim() and toLowerCase(),
// and the sign-in's rule reads it as another email; the ASCII one is the same email.
export const FOLDED_EMAIL = 'kim.straße.i̇ris@example.com'
export const UNICODE_EMAIL_VARIANTS = [
	'Kim.straße.i̇ris@example.com',
	'kim.straẞe.i̇ris@example.com',
	'kim.straße.İris@example.com',
	` ${FOLDED_EMAIL} `,
] as const
export const ASCII_EMAIL_VARIANT = 'KIM.straße.i̇ris@EXAMPLE.com'
