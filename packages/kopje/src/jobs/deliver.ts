import { pushRound } from './push'
import { decodeKey } from '../domain/actors'
import type { Completion, Confirmation, DeliverySigner } from '../domain/deliveries'
import { CLAIM_LIMIT, INSTANCE_SIGNER } from '../domain/deliveries'
import { COMPLETION_MARGIN_MS, type PostDeps, postActivity, ringDoorbell } from '../federation/delivery'
import { instanceActorKey } from '../federation/federation'
import { readConfig, userKek } from '../platform/config'
import { errorFields } from '../platform/error-message'
import { PACKAGE_VERSION } from '../platform/package-version'
import { callStore, type StoreResolver } from '../platform/store-client'
import { StoreUnavailableError } from '../platform/store-errors'
import { generateRsaKeyPair, type KeyGen } from '../security/key-wrap'
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
	// Generates the instance actor's key if a Flag needs it before anything else has (default: RSA 4096).
	keygen?: KeyGen
}

// settled: each claimed row's completion, or 'dropped' when its confirmation refused it (VIS-30); a row whose
// confirmation found its lease gone, or did not reach the Store, settles nothing here.
export type RoundResult = { claimed: number; settled: (Completion['status'] | 'dropped')[]; nextDueAt: number | null }

type Dropped = { status: 'dropped'; nextDueAt: number | null }

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
	const kek = config.ok ? userKek(config.config) : ''
	const keyring = createKeyring(kek)
	// Each signer's key is unwrapped once for this round and dropped with it (DATA-1). An activity is signed by the
	// lane's account, its author or the booster forwarding a remote author's Delete; only one recorded as the instance
	// actor's (a report's Flag) is signed by the instance key (DATA-7), loaded through instanceActorKey, which creates it
	// if no fetch or /actor request has yet.
	const instanceKey = async (actorUri: string): Promise<DeliverySigner> => {
		const key = decodeKey(
			await instanceActorKey((call) => callStore(() => call(store)), build, kek, deps.keygen ?? generateRsaKeyPair)
		)
		return { actorUri, ...key }
	}
	const signers = new Map<string, Promise<Signer | null>>()
	const signerOf = (accountId: string) => {
		let signer = signers.get(accountId)
		if (signer === undefined) {
			const stored = claim.signers[accountId]
			const key =
				accountId === INSTANCE_SIGNER && claim.instanceActor !== null
					? instanceKey(claim.instanceActor)
					: Promise.resolve(stored)
			signer = key
				.then((found) =>
					found === undefined
						? null
						: keyring.signerFor({
								keyId: new URL(`${found.actorUri}#main-key`),
								privkey: found.privkey,
								salt: found.salt,
								pubkey: found.pubkey,
							})
				)
				.catch(() => null)
			signers.set(accountId, signer)
		}
		return signer
	}
	// Every signer is a local actor or the instance actor, on the instance's origin.
	const origin = new URL(Object.values(claim.signers)[0]?.actorUri ?? claim.instanceActor ?? 'https://invalid.').origin
	const post: PostDeps = {
		fetch: deps.fetch,
		checkHost: deps.checkHost,
		timeoutMs: deps.timeoutMs,
		now: deps.now,
		userAgent: `Kopje/${PACKAGE_VERSION} (+${origin}/)`,
	}
	const deadline = claim.leaseUntil - COMPLETION_MARGIN_MS
	const settled = await Promise.all(
		claim.deliveries.map(async (delivery): Promise<Completion | Dropped | null> => {
			let withheld: Dropped | 'stale' | 'unconfirmed' | null = null
			// Key loading counts against the delivery's budget like the DNS check and the POST. After it, and after the
			// host check, the Store confirms the row under its lease and hands over the body to sign and send (VIS-30,
			// confirmDelivery): nothing is sent unless it does.
			const outcome = await postActivity(post, {
				inbox: delivery.inbox,
				body: '',
				signer: async () => {
					const sign = (await signerOf(delivery.signer))?.sign
					if (sign === undefined) {
						return null
					}
					let confirmation: Confirmation
					try {
						confirmation = await callStore(
							async (): Promise<Confirmation> =>
								await store.confirmDelivery(build, { id: delivery.id, leaseToken: claim.leaseToken, now: deps.now() })
						)
					} catch (error) {
						// The lease expires and the row is claimed again.
						console.error({ event: 'kopje.delivery.confirm.failed', delivery: delivery.id, ...errorFields(error) })
						withheld = 'unconfirmed'
						return null
					}
					if (confirmation.status !== 'send') {
						withheld = confirmation.status === 'stale' ? 'stale' : confirmation
						return null
					}
					const body = confirmation.body
					return (request) => sign(new Request(request, { body }))
				},
				deadline,
			})
			if (withheld !== null) {
				return typeof withheld === 'string' ? null : withheld
			}
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
	const completions = settled.filter((c): c is Completion | Dropped => c !== null)
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
