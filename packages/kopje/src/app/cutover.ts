import { verifySpooledRequest } from '../federation/inbound'
import { isLocalActor, legacyInboxMessage, legacyRecipient, type LegacyInboxMessage } from '../federation/legacy-inbox'
import type { LoaderDeps } from '../federation/loader'
import { decodeSpoolRecord, inflate } from '../federation/spool'
import { readConfig, userKek } from '../platform/config'
import { PACKAGE_VERSION } from '../platform/package-version'
import type { ImportAuthority } from '../platform/store-admin'
import type { StoreStub } from '../platform/store-client'

// The rollback drain of a cutover (docs/cutover-runbook.md, "Rolling back"): the inbox requests Kopje accepted during
// the window are handed to the legacy instance, in the order they were spooled, before it receives anything new, so
// that what happened later on the legacy instance (an Undo, a Delete) applies on top of them and nothing replays them
// into a later cutover. Each request is verified first, against the time it was spooled, by Kopje's own rule
// (verifySpooledRequest); a verified one becomes the legacy consumer's inbox message (federation/legacy-inbox.ts) on the
// legacy Queue (binding LEGACY_QUEUE). A request that may verify later stops the round, so nothing after it overtakes
// it; one that fails for good is kept in the journal for inspection, never dropped.

export type DrainResult =
	| { ok: true; sent: number; unverified: number; stopped: string | null; pending: number; unverifiedTotal: number }
	| { ok: false; status: 400 | 409; code: string; message: string }

export const DRAIN_MAX = 50
// Queue messages are limited to 128 KB; keep room for serialization overhead.
const LEGACY_MESSAGE_LIMIT = 120 * 1024

type DrainEnv = Env & { LEGACY_QUEUE?: Queue }

export async function drainJournal(
	env: Env,
	deps: { build: string; store: StoreStub; loader: Omit<LoaderDeps, 'userAgent'>; now: () => number },
	authority: ImportAuthority,
	options: { fallbackActor: unknown; max: unknown }
): Promise<DrainResult> {
	const config = readConfig(env)
	const queue = (env as DrainEnv).LEGACY_QUEUE
	if (!config.ok || queue === undefined || config.config.LEGACY_VAPID_JWK === undefined) {
		return refused(409, 'legacy-binding-missing', 'bind the legacy Queue as LEGACY_QUEUE and set LEGACY_VAPID_JWK')
	}
	let vapidKeys: unknown
	try {
		vapidKeys = JSON.parse(config.config.LEGACY_VAPID_JWK)
	} catch {
		return refused(409, 'legacy-binding-missing', 'LEGACY_VAPID_JWK is not JSON')
	}
	const domain = (await deps.store.config(deps.build)).values.domain
	if (domain === undefined) {
		return refused(409, 'domain-missing', 'the Store has no domain')
	}
	const fallback = options.fallbackActor
	if (typeof fallback !== 'string' || !isLocalActor(fallback, `https://${domain}`)) {
		return refused(400, 'invalid-fallback', 'fallbackActor must be a local actor URI of this domain')
	}
	const max = typeof options.max === 'number' && Number.isInteger(options.max) ? options.max : DRAIN_MAX
	const page = (await deps.store.journalPage(deps.build, authority, Math.min(Math.max(max, 1), DRAIN_MAX))) as
		| { ok: true; entries: { id: string; spooledAt: number; record: Uint8Array }[] }
		| { ok: false; code: string; message: string }
	if (!page.ok) {
		return refused(409, page.code, page.message)
	}
	const loader = { ...deps.loader, userAgent: `Kopje/${PACKAGE_VERSION} (+https://${domain}/)` }
	const ready: { id: string; body: LegacyInboxMessage }[] = []
	const sent: string[] = []
	const unverified: string[] = []
	let stopped: string | null = null
	for (const entry of page.entries) {
		const message = await decodeSpoolRecord(entry.record)
		if (message === null) {
			unverified.push(entry.id)
			continue
		}
		const check = await verifySpooledRequest(loader, domain, {
			url: message.url,
			method: message.method,
			headers: message.headers,
			body: await inflate(message.body),
			receivedAt: message.spooledAt,
		})
		if (!check.ok) {
			if (check.transient) {
				stopped = check.reason
				break
			}
			console.warn({ event: 'kopje.cutover.drain.unverified', reason: check.reason })
			unverified.push(entry.id)
			continue
		}
		const recipient = legacyRecipient(new URL(message.url).pathname, check.activity, domain, fallback)
		const body = legacyInboxMessage({
			activity: check.activity,
			recipient,
			signer: check.actor,
			userKek: userKek(config.config),
			vapidKeys,
		})
		// The legacy inbox route sent the same message, so the same Queue limit applied to it; one that cannot fit is
		// kept with the unverified ones for the operator.
		if (new TextEncoder().encode(JSON.stringify(body)).byteLength > LEGACY_MESSAGE_LIMIT) {
			console.warn({ event: 'kopje.cutover.drain.too-large' })
			unverified.push(entry.id)
			continue
		}
		ready.push({ id: entry.id, body })
	}
	// One at a time, in spool order; a send that fails stops the round, and the rest stays in the journal.
	for (const { id, body } of ready) {
		try {
			await queue.send(body)
		} catch {
			stopped = 'legacy-queue-failed'
			break
		}
		sent.push(id)
	}
	const settled = (await deps.store.journalSettle(deps.build, authority, { sent, unverified })) as
		| { ok: true; sent: number; unverified: number; journal: { pending: number; unverified: number } }
		| { ok: false; code: string; message: string }
	if (!settled.ok) {
		return refused(409, settled.code, settled.message)
	}
	return {
		ok: true,
		sent: settled.sent,
		unverified: settled.unverified,
		stopped,
		pending: settled.journal.pending,
		unverifiedTotal: settled.journal.unverified,
	}
}

function refused(status: 400 | 409, code: string, message: string): DrainResult {
	return { ok: false, status, code, message }
}
