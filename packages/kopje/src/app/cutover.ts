import { verifySpooledRequest } from '../federation/inbound'
import { legacyInboxMessage, legacyRecipient } from '../federation/legacy-inbox'
import type { LoaderDeps } from '../federation/loader'
import { decodeSpoolRecord, inflate, SPOOL_MESSAGE_LIMIT } from '../federation/spool'
import { readConfig, userKek } from '../platform/config'
import { PACKAGE_VERSION } from '../platform/package-version'
import {
	type ImportAuthority,
	JOURNAL_MAX_BYTES,
	JOURNAL_MAX_ENTRIES,
	type JournalCounts,
} from '../platform/store-admin'
import type { StoreStub } from '../platform/store-client'

// The rollback drain of a cutover (docs/cutover-runbook.md, "Rolling back"): the inbox requests Kopje accepted during
// the window go to the legacy instance, through an ordered lane, in the order they were spooled, before it receives
// anything new, so that a later Undo or Delete applies on top of them and nothing replays them into a later cutover.
//
// One round hands off at most one request, and only when:
//   - Kopje's Queue holds nothing (the collection barrier): every spooled request, the delayed ones included, is in the
//     journal, so none can arrive later than a newer one already sent;
//   - the legacy Queue holds nothing: the legacy consumer has acknowledged the previous request, retries included, so
//     no later request overtakes one it is still retrying;
//   - the legacy dead-letter queue holds nothing: a request it dead-lettered stops the drain until the operator
//     reconciles it.
// Each reading fails closed: a Queue whose metrics cannot be read stops the round.
// The request is verified first, against the time it was spooled, by Kopje's own rule (verifySpooledRequest), and
// becomes the legacy consumer's inbox message (federation/legacy-inbox.ts) for a recipient among the legacy local
// accounts the operator gives. A request that may verify later stops the round; one that fails for good, or has no
// legacy recipient, is kept for the operator. The record is marked as being sent before the send: after a crash it is
// sent again (at least once). One drain runs at a time (a Store lease).

export type DrainRound = {
	sent: number
	unverified: number
	noRecipient: number
	// The lane is busy; run the round again shortly.
	waiting: 'kopje-backlog' | 'legacy-backlog' | null
	// The drain cannot go on by itself; the operator acts, then runs it again.
	stopped:
		| 'legacy-dlq'
		| 'metrics-unavailable'
		| 'key-unavailable'
		| 'legacy-queue-failed'
		| 'legacy-queue-timeout'
		| 'journal-full'
		| null
	journal: JournalCounts
}

export type DrainResult = ({ ok: true } & DrainRound) | { ok: false; status: 400 | 409; code: string; message: string }

// A send to the legacy Queue that takes longer is given up for this round (well inside DRAIN_LEASE_MS).
const SEND_TIMEOUT_MS = 10_000
// Verification in one round stops after this long (well inside DRAIN_LEASE_MS).
const ROUND_BUDGET_MS = 60_000
// Records one round may verify, and set aside, before it stops; it hands off at most one request.
const MAX_EXAMINED_PER_ROUND = 50
const MAX_KEPT_PER_ROUND = 20
// Queue messages are limited to 128 KB; keep room for serialization overhead.
const LEGACY_MESSAGE_LIMIT = 120 * 1024
const USERNAME = /^[A-Za-z0-9_]{1,64}$/

type DrainEnv = Env & { LEGACY_QUEUE?: Queue; LEGACY_DLQ?: Queue }

async function backlog(queue: Queue | undefined): Promise<number | null> {
	const metrics = (queue as Partial<Pick<Queue, 'metrics'>> | undefined)?.metrics
	if (queue === undefined || typeof metrics !== 'function') {
		return null
	}
	try {
		return (await metrics.call(queue)).backlogCount
	} catch {
		return null
	}
}

type Store = StoreStub & Record<string, (...args: unknown[]) => Promise<unknown>>
type Refused = { ok: false; code: string; message: string }

export async function drainJournal(
	env: Env,
	deps: {
		build: string
		store: StoreStub
		loader: Omit<LoaderDeps, 'userAgent'>
		holder: string
		now?: () => number
		sendTimeoutMs?: number
	},
	authority: ImportAuthority,
	options: { accounts: unknown; fallback: unknown }
): Promise<DrainResult> {
	const config = readConfig(env)
	const { LEGACY_QUEUE: legacy, LEGACY_DLQ: legacyDlq } = env as DrainEnv
	if (!config.ok || legacy === undefined || legacyDlq === undefined || config.config.LEGACY_VAPID_JWK === undefined) {
		return refused(
			409,
			'legacy-binding-missing',
			'bind the legacy Queue as LEGACY_QUEUE and its dead-letter queue as LEGACY_DLQ, and set LEGACY_VAPID_JWK'
		)
	}
	let vapidKeys: unknown
	try {
		vapidKeys = JSON.parse(config.config.LEGACY_VAPID_JWK)
	} catch {
		return refused(409, 'legacy-binding-missing', 'LEGACY_VAPID_JWK is not JSON')
	}
	const { accounts, fallback } = options
	if (
		!Array.isArray(accounts) ||
		accounts.length === 0 ||
		!accounts.every((a) => typeof a === 'string' && USERNAME.test(a))
	) {
		return refused(400, 'invalid-accounts', 'accounts must list the legacy local usernames')
	}
	if (fallback !== undefined && fallback !== null && (typeof fallback !== 'string' || !accounts.includes(fallback))) {
		return refused(400, 'invalid-fallback', 'the fallback must be one of the accounts')
	}
	const stored = (await deps.store.config(deps.build)).values.domain
	if (stored === undefined) {
		return refused(409, 'domain-missing', 'the Store has no domain')
	}
	const domain: string = stored
	const kek = userKek(config.config)
	const lane: Queue = legacy
	const store = deps.store as unknown as Store
	const call = async <T>(method: string, ...args: unknown[]): Promise<T> => {
		const result = (await store[method]!(deps.build, authority, ...args)) as ({ ok: true } & T) | Refused
		if (!result.ok) {
			throw new DrainRefusal(result.code, result.message)
		}
		return result
	}
	const now = deps.now ?? (() => Date.now())
	const started = now()
	// A send that timed out may still be in flight until this invocation ends: the lease is then kept, so no other
	// drain starts until it has long expired (DRAIN_LEASE_MS), by which time this invocation and its send are gone.
	let keepLease = false
	try {
		await call('drainLease', { holder: deps.holder })
		try {
			return { ok: true, ...(await round()) }
		} finally {
			if (!keepLease) {
				await call('drainLease', { holder: deps.holder, release: true })
			}
		}
	} catch (error) {
		if (error instanceof DrainRefusal) {
			return refused(409, error.code, error.message)
		}
		throw error
	}

	async function round(): Promise<DrainRound> {
		const result: Omit<DrainRound, 'journal'> = { sent: 0, unverified: 0, noRecipient: 0, waiting: null, stopped: null }
		const finish = async () => ({ ...result, journal: (await deps.store.cutoverStatus(deps.build)).journal })
		// Read one after another: Kopje's Queue, the legacy Queue, and only after the legacy Queue was seen empty its
		// dead-letter queue, so a message that left the legacy Queue for its DLQ between the readings is seen there.
		const kopjeBacklog = await backlog(env.QUEUE)
		const legacyBacklog = kopjeBacklog === null ? null : await backlog(legacy)
		const legacyDead = legacyBacklog === null ? null : await backlog(legacyDlq)
		if (kopjeBacklog === null || legacyBacklog === null || legacyDead === null) {
			result.stopped = 'metrics-unavailable'
			return finish()
		}
		if (legacyDead > 0) {
			result.stopped = 'legacy-dlq'
			return finish()
		}
		// While the lane is busy, nothing is sent; the records are still verified, so that what fails for good is set
		// aside (and the journal's quota freed by the operator) without waiting.
		const busy = kopjeBacklog > 0 ? 'kopje-backlog' : legacyBacklog > 0 ? 'legacy-backlog' : null
		result.waiting = busy
		if (busy === 'kopje-backlog' && (await journalFull())) {
			// The barrier waits for requests the full journal cannot take: an operator decision, not a wait.
			result.waiting = null
			result.stopped = 'journal-full'
		}
		const loader = { ...deps.loader, userAgent: `Kopje/${PACKAGE_VERSION} (+https://${domain}/)` }
		const known = new Set(accounts as string[])
		const ready: string[] = []
		for (
			let kept = 0, examined = 0;
			kept < MAX_KEPT_PER_ROUND && examined < MAX_EXAMINED_PER_ROUND && now() - started < ROUND_BUDGET_MS;
			examined++
		) {
			const { entry } = await call<{
				entry: { id: string; spooledAt: number; record: Uint8Array; resend: boolean } | null
			}>('journalNext', deps.holder, ready)
			if (entry === null) {
				break
			}
			const message = await decodeSpoolRecord(entry.record)
			const check =
				message === null
					? ({ ok: false, transient: false, reason: 'invalid-record' } as const)
					: await verifySpooledRequest(loader, domain, {
							url: message.url,
							method: message.method,
							headers: message.headers,
							body: await inflate(message.body),
							receivedAt: message.spooledAt,
						})
			if (!check.ok) {
				if (check.transient) {
					result.stopped = busy === null ? 'key-unavailable' : null
					break
				}
				console.warn({ event: 'kopje.cutover.drain.unverified', reason: check.reason })
				await call('journalMark', deps.holder, entry.id, 'unverified')
				result.unverified++
				kept++
				continue
			}
			const recipient = legacyRecipient(
				new URL(message!.url).pathname,
				check.activity,
				domain,
				known,
				(fallback as string | undefined) ?? null
			)
			const body =
				recipient === null
					? null
					: legacyInboxMessage({
							activity: check.activity,
							recipient,
							signer: check.actor,
							userKek: kek,
							vapidKeys,
						})
			// No legacy recipient, or a message the legacy Queue cannot carry (its own inbox route had the same limit).
			if (body === null || new TextEncoder().encode(JSON.stringify(body)).byteLength > LEGACY_MESSAGE_LIMIT) {
				await call('journalMark', deps.holder, entry.id, 'no-recipient')
				result.noRecipient++
				kept++
				continue
			}
			if (busy !== null) {
				// Verified and kept in its place; it is sent once the lane is free.
				ready.push(entry.id)
				continue
			}
			await call('journalMark', deps.holder, entry.id, 'sending')
			const sent = await withTimeout(lane.send(body), deps.sendTimeoutMs ?? SEND_TIMEOUT_MS)
			if (sent !== 'sent') {
				// The record stays 'sending' and is sent again by a later round (at least once).
				result.stopped = sent === 'timeout' ? 'legacy-queue-timeout' : 'legacy-queue-failed'
				keepLease = sent === 'timeout'
				break
			}
			await call('journalMark', deps.holder, entry.id, 'done')
			result.sent = 1
			break
		}
		return finish()
	}

	async function journalFull(): Promise<boolean> {
		const journal = (await deps.store.cutoverStatus(deps.build)).journal
		const entries = journal.pending + journal.sending + journal.unverified + journal.noRecipient
		const settings = readConfig(env)
		const maxEntries = Math.min(
			(settings.ok ? settings.config.CUTOVER_JOURNAL_MAX_ENTRIES : undefined) ?? JOURNAL_MAX_ENTRIES,
			JOURNAL_MAX_ENTRIES
		)
		const maxBytes = Math.min(
			(settings.ok ? settings.config.CUTOVER_JOURNAL_MAX_BYTES : undefined) ?? JOURNAL_MAX_BYTES,
			JOURNAL_MAX_BYTES
		)
		return entries >= maxEntries || journal.bytes + SPOOL_MESSAGE_LIMIT > maxBytes
	}
}

async function withTimeout(send: Promise<unknown>, ms: number): Promise<'sent' | 'failed' | 'timeout'> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<'timeout'>((resolve) => {
		timer = setTimeout(() => resolve('timeout'), ms)
	})
	try {
		return await Promise.race([
			send.then(
				() => 'sent' as const,
				() => 'failed' as const
			),
			timeout,
		])
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer)
		}
	}
}

class DrainRefusal extends Error {
	constructor(
		readonly code: string,
		message: string
	) {
		super(message)
	}
}

function refused(status: 400 | 409, code: string, message: string): DrainResult {
	return { ok: false, status, code, message }
}
