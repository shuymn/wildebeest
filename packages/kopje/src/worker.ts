import { createApp } from './app/app'
import { scheduledDeliveries } from './jobs/deliver'
import { handleQueue, runScheduledJobs } from './jobs/queue'
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
	// Every 5 minutes: the delivery sweep and doorbell, and a round of inbound jobs (purges, Moves). Both are no-ops in
	// maintenance, by design.
	scheduled: (_controller, env, ctx) => {
		ctx.waitUntil(scheduledDeliveries(env, { ...delivery, build: buildOf, store: defaultStore }))
		ctx.waitUntil(runScheduledJobs(env, inboxDeps))
	},
} satisfies ExportedHandler<Env>
