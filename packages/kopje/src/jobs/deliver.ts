import type { Completion, DeliveryOutcome } from '../domain/deliveries'
import { CLAIM_LIMIT } from '../domain/deliveries'
import { type PostDeps, postActivity, ringDoorbell } from '../federation/delivery'
import { readConfig, userKek } from '../platform/config'
import { errorFields } from '../platform/error-message'
import { PACKAGE_VERSION } from '../platform/package-version'
import { callStore, type StoreResolver } from '../platform/store-client'
import { StoreUnavailableError } from '../platform/store-errors'
import { createKeyring, type Signer } from '../security/keyring'

// The Worker's side of delivery (domain/deliveries.ts has the Store's). A round claims a bounded batch of due lane
// heads, POSTs them concurrently, and settles each with the lease token of its claim. The Queue only rings: a
// doorbell starts a round, a full round rings again, and a round with retries rings once more, delayed until the
// earliest of them is due. The cron rings every 5 minutes, which also picks up expired leases and anything a lost
// doorbell left behind. There is no DLQ: what fails for good is a gave_up row in the Store.

export type DeliveryDeps = {
	build: (env: Env) => string
	store: StoreResolver
	now: () => number
	fetch: typeof fetch
	checkHost?: (url: URL) => Promise<void>
	timeoutMs?: number
	// A fresh lease token per claim.
	leaseToken?: () => string
}

export type RoundResult = { claimed: number; settled: Completion['status'][]; full: boolean; retryAt: number | null }

const freshToken = () => crypto.randomUUID()

export async function deliveryRound(env: Env, deps: DeliveryDeps): Promise<RoundResult> {
	const build = deps.build(env)
	const store = deps.store(env)
	const claim = await callStore(() =>
		store.claimDeliveries(build, { now: deps.now(), leaseToken: (deps.leaseToken ?? freshToken)(), limit: CLAIM_LIMIT })
	)
	if (claim.deliveries.length === 0) {
		return { claimed: 0, settled: [], full: false, retryAt: null }
	}
	const config = readConfig(env)
	const keyring = createKeyring(config.ok ? userKek(config.config) : '')
	// Each author's key is unwrapped once for this round and dropped with it (DATA-1). An activity is signed only by
	// its author, never by the instance actor (DATA-7).
	const signers = new Map<string, Promise<Signer | null>>()
	const signerOf = (accountId: string) => {
		let signer = signers.get(accountId)
		if (signer === undefined) {
			const key = claim.signers[accountId]
			signer =
				key === undefined
					? Promise.resolve(null)
					: keyring
							.signerFor({
								keyId: new URL(`${key.actorUri}#main-key`),
								privkey: key.privkey,
								salt: key.salt,
								pubkey: key.pubkey,
							})
							.catch(() => null)
			signers.set(accountId, signer)
		}
		return signer
	}
	// Every signer is a local actor, on the instance's origin.
	const origin = new URL(Object.values(claim.signers)[0]?.actorUri ?? 'https://invalid.').origin
	const post: PostDeps = {
		fetch: deps.fetch,
		checkHost: deps.checkHost,
		timeoutMs: deps.timeoutMs,
		userAgent: `Kopje/${PACKAGE_VERSION} (+${origin}/)`,
	}
	const settled = await Promise.all(
		claim.deliveries.map(async (delivery): Promise<Completion | null> => {
			const signer = await signerOf(delivery.signer)
			const outcome: DeliveryOutcome =
				signer === null
					? { kind: 'failed', status: null, error: 'signing key unavailable', permanent: false }
					: await postActivity(post, delivery.inbox, delivery.body, signer.sign)
			try {
				const input = { id: delivery.id, leaseToken: claim.leaseToken, now: deps.now(), outcome }
				return await callStore(async (): Promise<Completion> => {
					const completion = await store.completeDelivery(build, input)
					return completion
				})
			} catch (error) {
				// OPS-3: the outcome is unknown to the Store. The lease expires and the row is claimed again; a receiver
				// that already has the activity ignores the repeat by its id.
				console.error({ event: 'kopje.delivery.complete.failed', delivery: delivery.id, ...errorFields(error) })
				return null
			}
		})
	)
	const completions = settled.filter((c): c is Completion => c !== null)
	const retries = completions.flatMap((c) => (c.status === 'retry' ? [c.retryAt] : []))
	const gaveUp = completions.filter((c) => c.status === 'gave_up').length
	if (gaveUp > 0) {
		console.warn({ event: 'kopje.delivery.gave_up', count: gaveUp })
	}
	return {
		claimed: claim.deliveries.length,
		settled: completions.map((c) => c.status),
		full: claim.deliveries.length >= CLAIM_LIMIT,
		retryAt: retries.length === 0 ? null : Math.min(...retries),
	}
}

// Handles the doorbells of one Queue batch: however many arrived, one round runs (RES-6: work per invocation is one
// claim). In maintenance nothing is claimed and nothing is counted (RES-5); the cron resumes afterwards.
export async function handleDoorbells(messages: readonly Message[], env: Env, deps: DeliveryDeps): Promise<void> {
	const config = readConfig(env)
	if (!config.ok || config.config.MAINTENANCE !== 'off') {
		ackAll(messages)
		return
	}
	let result: RoundResult
	try {
		result = await deliveryRound(env, deps)
	} catch (error) {
		if (error instanceof StoreUnavailableError) {
			ackAll(messages)
			return
		}
		console.error({ event: 'kopje.delivery.round.failed', ...errorFields(error) })
		// Leases are already taken or not; either way the cron resumes. A retry would only repeat the doorbell.
		ackAll(messages)
		return
	}
	try {
		if (result.full) {
			await ringDoorbell(env.QUEUE)
		}
		if (result.retryAt !== null) {
			await ringDoorbell(env.QUEUE, (result.retryAt - deps.now()) / 1000)
		}
	} catch (error) {
		console.error({ event: 'kopje.delivery.doorbell.failed', ...errorFields(error) })
	}
	ackAll(messages)
}

function ackAll(messages: readonly Message[]): void {
	for (const message of messages) {
		message.ack()
	}
}

// The 5-minute cron: sweeps expired given-up rows and rings the doorbell. A no-op in maintenance.
export async function scheduledDeliveries(env: Env, deps: DeliveryDeps): Promise<void> {
	const config = readConfig(env)
	if (!config.ok || config.config.MAINTENANCE !== 'off') {
		return
	}
	try {
		await callStore(() => deps.store(env).sweepDeliveries(deps.build(env), { now: deps.now() }))
	} catch (error) {
		if (error instanceof StoreUnavailableError) {
			return
		}
		console.error({ event: 'kopje.delivery.sweep.failed', ...errorFields(error) })
	}
	await ringDoorbell(env.QUEUE)
}
