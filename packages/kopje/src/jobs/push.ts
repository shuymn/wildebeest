import { base64url } from 'jose'

import type { DeliveryDeps } from './deliver'
import { CLAIM_LIMIT, type DeliveryOutcome } from '../domain/deliveries'
import { type ClaimedPush, type PushCompletion, type PushContent, truncateText } from '../domain/push'
import { COMPLETION_MARGIN_MS, postActivity, type PostDeps } from '../federation/delivery'
import { readConfig } from '../platform/config'
import { errorFields } from '../platform/error-message'
import { PACKAGE_VERSION } from '../platform/package-version'
import { callStore } from '../platform/store-client'
import { vapidPrivateJwk, vapidPublicKey } from '../platform/vapid'
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

export type PushRoundResult = { claimed: number; settled: PushCompletion['status'][]; nextDueAt: number | null }

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
	const config = readConfig(env)
	const secret = config.ok ? config.config.VAPID_JWK : undefined
	const jwk = secret === undefined ? null : vapidPrivateJwk(secret)
	const publicKey = secret === undefined ? null : vapidPublicKey(secret)
	if (jwk === null || publicKey === null) {
		return { claimed: 0, settled: [], nextDueAt: null }
	}
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
		claim.pushes.map(async (push): Promise<PushCompletion | null> => {
			const outcome = await sendPush(post, push, { jwk, publicKey, subject: `${origin}/`, deadline })
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
	const completions = settled.filter((c): c is PushCompletion => c !== null)
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
		settled: completions.map((c) => c.status),
		nextDueAt: due.length === 0 ? null : Math.min(...due),
	}
}

type Signing = { jwk: JsonWebKey; publicKey: string; subject: string; deadline: number }

// One push through the delivery sink. The encrypted message and its headers replace the sink's request (keeping its
// URL, redirect rule and abort signal), prepared inside the budget as a delivery's signature is.
function sendPush(post: PostDeps, push: ClaimedPush, signing: Signing): Promise<DeliveryOutcome> {
	const encoding: PushEncoding = push.standard ? 'aes128gcm' : 'aesgcm'
	return postActivity(post, {
		inbox: push.endpoint,
		body: '',
		deadline: signing.deadline,
		signer: async () => {
			const token = await openPushToken(signing.jwk, push.tokenHash, push.tokenSealed)
			const encrypted = await encryptPush(
				pushPayload(push.content, token ?? ''),
				{ p256dh: base64url.decode(push.p256dh), auth: base64url.decode(push.auth) },
				encoding
			)
			const url = new URL(push.endpoint)
			const vapid = {
				token: await vapidToken(signing.jwk, url.origin, signing.subject, post.now()),
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
}
