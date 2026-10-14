import { base64url } from 'jose'

import type { DeliveryDeps } from './deliver'
import { CLAIM_LIMIT, type DeliveryOutcome } from '../domain/deliveries'
import {
	type ClaimedPush,
	type ConfirmedPush,
	type PushCompletion,
	type PushContent,
	truncateText,
} from '../domain/push'
import { COMPLETION_MARGIN_MS, postActivity, type PostDeps } from '../federation/delivery'
import { webPushKeys } from '../platform/config'
import { errorFields } from '../platform/error-message'
import { PACKAGE_VERSION } from '../platform/package-version'
import { callStore } from '../platform/store-client'
import {
	encryptPush,
	MAX_PUSH_PLAINTEXT,
	openPushToken,
	type PushEncoding,
	pushHeaders,
	vapidToken,
} from '../security/web-push'

// The Worker's side of Web Push (domain/push.ts has the Store's). A round claims a bounded batch of due pushes and
// sends each through the delivery sink (federation/delivery.ts), so a push has the deliveries' rules: NET-3's host
// rules and DNS check before every POST (PUSH-2), no redirects, and one budget inside the lease. Each is encrypted for
// its subscription's encoding and signed with VAPID (security/web-push.ts). It runs with the delivery round of the same
// doorbell (jobs/deliver.ts); without a VAPID_JWK nothing is claimed.

// Mastodon's TTL and urgency for a notification push.
const TTL_SECONDS = 48 * 60 * 60
const URGENCY = 'normal'

// settled: each push's completion, or dropped when the last check before the POST dropped it (PUSH-3).
export type PushRoundResult = {
	claimed: number
	settled: (PushCompletion['status'] | 'dropped')[]
	nextDueAt: number | null
}

const freshToken = () => crypto.randomUUID()

// Mastodon's payload (Web::NotificationSerializer), within what one push may carry (MAX_PUSH_PLAINTEXT). The body is
// already at most 140 characters; a payload still too large loses its icon, then its title is shortened as the body
// is. The rest is bounded (ids, type, locale, token), so that always fits.
export function pushPayload(content: PushContent, accessToken: string): Uint8Array {
	const encode = (payload: PushContent) =>
		new TextEncoder().encode(JSON.stringify({ access_token: accessToken, ...payload }))
	const full = encode(content)
	if (full.length <= MAX_PUSH_PLAINTEXT) {
		return full
	}
	const noIcon = encode({ ...content, icon: '' })
	return noIcon.length <= MAX_PUSH_PLAINTEXT
		? noIcon
		: encode({ ...content, icon: '', title: truncateText(content.title, 140) })
}

export async function pushRound(env: Env, deps: DeliveryDeps): Promise<PushRoundResult> {
	const keys = webPushKeys(env)
	if (keys === null) {
		return { claimed: 0, settled: [], nextDueAt: null }
	}
	const { jwk, publicKey } = keys
	const build = deps.build(env)
	const store = deps.store(env)
	const claim = await callStore(() =>
		store.claimPushes(build, { now: deps.now(), leaseToken: (deps.leaseToken ?? freshToken)(), limit: CLAIM_LIMIT })
	)
	if (claim.pushes.length === 0 || claim.origin === null) {
		return { claimed: 0, settled: [], nextDueAt: claim.nextDueAt }
	}
	const origin = claim.origin
	const post: PostDeps = {
		fetch: deps.fetch,
		checkHost: deps.checkHost,
		timeoutMs: deps.timeoutMs,
		now: deps.now,
		userAgent: `Kopje/${PACKAGE_VERSION} (+${origin}/)`,
	}
	const deadline = claim.leaseUntil - COMPLETION_MARGIN_MS
	const settled = await Promise.all(
		claim.pushes.map(async (push): Promise<PushCompletion | 'dropped' | null> => {
			const confirm = () =>
				callStore(() => store.confirmPush(build, { id: push.id, leaseToken: claim.leaseToken, now: deps.now() }))
			const outcome = await sendPush(post, push, { jwk, publicKey, subject: `${origin}/`, deadline }, confirm)
			if (outcome === 'dropped') {
				return outcome
			}
			try {
				const input = { id: push.id, leaseToken: claim.leaseToken, now: deps.now(), outcome }
				return await callStore(async (): Promise<PushCompletion> => {
					const completion = await store.completePush(build, input)
					return completion
				})
			} catch (error) {
				// The lease expires and the push is claimed again: the client may show it twice.
				console.error({ event: 'kopje.push.complete.failed', push: push.id, ...errorFields(error) })
				return null
			}
		})
	)
	const completions = settled.filter((c): c is PushCompletion => c !== null && c !== 'dropped')
	const failed = completions.filter((c) => c.status === 'gave_up' || c.status === 'unsubscribed')
	if (failed.length > 0) {
		// DATA-5: counts only, no endpoint.
		console.warn({ event: 'kopje.push.dropped', count: failed.length })
	}
	const due = [
		...completions.map((c) => c.nextDueAt),
		...(completions.length < settled.length ? [claim.nextDueAt] : []),
	].filter((at): at is number => at !== null)
	return {
		claimed: claim.pushes.length,
		settled: settled.flatMap((c) => (c === null ? [] : [c === 'dropped' ? c : c.status])),
		nextDueAt: due.length === 0 ? null : Math.min(...due),
	}
}

type Signing = { jwk: JsonWebKey; publicKey: string; subject: string; deadline: number }

// One push through the delivery sink. After the host check and right before the POST (where a delivery is signed),
// the Store confirms the push under its lease and hands over what to send (PUSH-3, confirmPush); a push it drops is
// not sent. The encrypted message and its headers then replace the sink's request, keeping its URL (a row's endpoint
// never changes: a new subscription is a new row), redirect rule and abort signal.
async function sendPush(
	post: PostDeps,
	push: ClaimedPush,
	signing: Signing,
	confirm: () => Promise<ConfirmedPush | null>
): Promise<DeliveryOutcome | 'dropped'> {
	let dropped = false
	const outcome = await postActivity(post, {
		inbox: push.endpoint,
		body: '',
		deadline: signing.deadline,
		signer: async () => {
			const current = await confirm()
			if (current === null) {
				dropped = true
				return null
			}
			const encoding: PushEncoding = current.standard ? 'aes128gcm' : 'aesgcm'
			const token = await openPushToken(signing.jwk, current.tokenHash, current.tokenSealed)
			const encrypted = await encryptPush(
				pushPayload(current.content, token ?? ''),
				{ p256dh: base64url.decode(current.p256dh), auth: base64url.decode(current.auth) },
				encoding
			)
			const vapid = {
				token: await vapidToken(signing.jwk, new URL(push.endpoint).origin, signing.subject, post.now()),
				publicKey: signing.publicKey,
			}
			return (request) =>
				Promise.resolve(
					new Request(request, {
						headers: {
							'user-agent': request.headers.get('user-agent') ?? '',
							'content-type': 'application/octet-stream',
							ttl: String(TTL_SECONDS),
							urgency: URGENCY,
							...pushHeaders(encoding, encrypted, vapid),
						},
						body: encrypted.body,
					})
				)
		},
	})
	return dropped ? 'dropped' : outcome
}
