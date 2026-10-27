import { createApp } from './app/app'
import { scheduledBackup } from './jobs/backup'
import { scheduledDeliveries } from './jobs/deliver'
import { handleQueue, runScheduledJobs } from './jobs/queue'
import {
	handleScheduled,
	scheduledCardImages,
	scheduledFieldLinks,
	scheduledLinkCards,
	scheduledRemoteMedia,
} from './jobs/scheduled'
import { errorFields } from './platform/error-message'
import { defaultStore } from './platform/store-client'
import { generateRsaKeyPair } from './security/key-wrap'
import { buildOf } from './version'

export { Store } from './store'

const now = () => Date.now()
const app = createApp({ build: buildOf, now })
const delivery = { now, fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) }
const inboxDeps = {
	build: buildOf,
	store: defaultStore,
	now,
	keygen: generateRsaKeyPair,
	loader: { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) },
}

export default {
	fetch: (request, env, ctx) => app.fetch(request, env, ctx),
	queue: (batch, env) => handleQueue(batch, env, { ...inboxDeps, delivery }),
	// Every 5 minutes: a field link round (one account's profile links checked), a link card round (a few statuses' cards
	// fetched), a card image round (a few card images fetched and re-encoded), a remote media round (the cache of remote
	// avatars and headers maintained and a few files fetched), the delivery sweep and doorbell, the media sweep and
	// reconciliation, a round of inbound jobs (purges, Moves), the daily backup when it is due or running, and a turn of
	// the streaming API (which closes the sockets of expired tokens). Each is a no-op in maintenance, by design, and each
	// runs on its own.
	scheduled: (_controller, env, ctx) => {
		ctx.waitUntil(scheduledFieldLinks(env, inboxDeps))
		ctx.waitUntil(scheduledLinkCards(env, inboxDeps))
		ctx.waitUntil(scheduledCardImages(env, inboxDeps))
		ctx.waitUntil(scheduledRemoteMedia(env, inboxDeps))
		ctx.waitUntil(
			defaultStore(env)
				.streamTick(buildOf(env))
				.catch((error: unknown) => console.error({ event: 'kopje.stream.tick-failed', ...errorFields(error) }))
		)
		ctx.waitUntil(
			scheduledBackup(env, { build: buildOf, store: defaultStore, now, fetch: (request) => fetch(request) })
		)
		ctx.waitUntil(scheduledDeliveries(env, { ...delivery, build: buildOf, store: defaultStore }))
		ctx.waitUntil(handleScheduled(env, { build: buildOf, now: () => Date.now(), store: defaultStore }))
		ctx.waitUntil(runScheduledJobs(env, inboxDeps))
	},
} satisfies ExportedHandler<Env>
