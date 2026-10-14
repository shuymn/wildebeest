import { pushRound } from './push'
import type { Completion } from '../domain/deliveries'
import { CLAIM_LIMIT } from '../domain/deliveries'
import { COMPLETION_MARGIN_MS, type PostDeps, postActivity, ringDoorbell } from '../federation/delivery'
import { readConfig, userKek } from '../platform/config'
import { errorFields } from '../platform/error-message'
import { PACKAGE_VERSION } from '../platform/package-version'
import { callStore, type StoreResolver } from '../platform/store-client'
import { StoreUnavailableError } from '../platform/store-errors'
import { createKeyring, type Signer } from '../security/keyring'

// The Worker's side of delivery (domain/deliveries.ts has the Store's). A round claims a bounded batch of due lane
// heads, POSTs them concurrently, and settles each with the lease token of its claim. The Queue only rings: a
// doorbell starts a round, and the round rings once more for the earliest work the Store reports due (nextDueAt):
// at once for a promoted lane head or an intent still expanding, later for a retry or a lease deadline. The cron
// rings every 5 minutes for anything a lost doorbell left behind. There is no DLQ: what fails for good is a gave_up
// row in the Store.

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

export type RoundResult = { claimed: number; settled: Completion['status'][]; nextDueAt: number | null }

const freshToken = () => crypto.randomUUID()

export async function deliveryRound(env: Env, deps: DeliveryDeps): Promise<RoundResult> {
	const build = deps.build(env)
	const store = deps.store(env)
	const claim = await callStore(() =>
		store.claimDeliveries(build, { now: deps.now(), leaseToken: (deps.leaseToken ?? freshToken)(), limit: CLAIM_LIMIT })
	)
	if (claim.deliveries.length === 0) {
		return { claimed: 0, settled: [], nextDueAt: claim.nextDueAt }
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
		now: deps.now,
		userAgent: `Kopje/${PACKAGE_VERSION} (+${origin}/)`,
	}
	const deadline = claim.leaseUntil - COMPLETION_MARGIN_MS
	const settled = await Promise.all(
		claim.deliveries.map(async (delivery): Promise<Completion | null> => {
			// Key loading counts against the delivery's budget like the DNS check and the POST.
			const outcome = await postActivity(post, {
				inbox: delivery.inbox,
				body: delivery.body,
				signer: async () => (await signerOf(delivery.signer))?.sign ?? null,
				deadline,
			})
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
	const gaveUp = completions.filter((c) => c.status === 'gave_up').length
	if (gaveUp > 0) {
		console.warn({ event: 'kopje.delivery.gave_up', count: gaveUp })
	}
	// Each answer saw the Store at its own moment; the earliest is never later than the work really due. A lost
	// completion leaves its row leased, which the claim's answer covers.
	const due = [
		...completions.map((c) => c.nextDueAt),
		...(completions.length < settled.length ? [claim.nextDueAt] : []),
	].filter((at): at is number => at !== null)
	return {
		claimed: claim.deliveries.length,
		settled: completions.map((c) => c.status),
		nextDueAt: due.length === 0 ? null : Math.min(...due),
	}
}

// Handles the doorbells of one Queue batch: however many arrived, one round runs (RES-6: work per invocation is one
// claim), with one round of Web Push beside it (jobs/push.ts). In maintenance nothing is claimed and nothing is
// counted (RES-5); the cron resumes afterwards.
export async function handleDoorbells(messages: readonly Message[], env: Env, deps: DeliveryDeps): Promise<void> {
	const config = readConfig(env)
	if (!config.ok || config.config.MAINTENANCE !== 'off') {
		ackAll(messages)
		return
	}
	const due = (
		await Promise.all([
			nextDueOf(() => deliveryRound(env, deps), 'kopje.delivery.round.failed'),
			nextDueOf(() => pushRound(env, deps), 'kopje.push.round.failed'),
		])
	).filter((at): at is number => at !== null)
	try {
		if (due.length > 0) {
			await ringDoorbell(env.QUEUE, (Math.min(...due) - deps.now()) / 1000)
		}
	} catch (error) {
		console.error({ event: 'kopje.delivery.doorbell.failed', ...errorFields(error) })
	}
	ackAll(messages)
}

// A round's nextDueAt, or null when it failed. Leases are already taken or not; either way the cron resumes, so the
// doorbell is acked: a retry would only repeat it.
async function nextDueOf(round: () => Promise<{ nextDueAt: number | null }>, event: string): Promise<number | null> {
	try {
		return (await round()).nextDueAt
	} catch (error) {
		if (!(error instanceof StoreUnavailableError)) {
			console.error({ event, ...errorFields(error) })
		}
		return null
	}
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
