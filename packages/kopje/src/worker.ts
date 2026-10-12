import { createApp } from './app/app'
import { scheduledBackup } from './jobs/backup'
import { scheduledDeliveries } from './jobs/deliver'
import { handleQueue, runScheduledJobs } from './jobs/queue'
import { handleScheduled } from './jobs/scheduled'
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
	// Every 5 minutes: the delivery sweep and doorbell, the media sweep and reconciliation, a round of inbound jobs
	// (purges, Moves), and the daily backup when it is due or running. Each is a no-op in maintenance, by design.
	scheduled: (_controller, env, ctx) => {
		ctx.waitUntil(
			scheduledBackup(env, { build: buildOf, store: defaultStore, now, fetch: (request) => fetch(request) })
		)
		ctx.waitUntil(scheduledDeliveries(env, { ...delivery, build: buildOf, store: defaultStore }))
		ctx.waitUntil(handleScheduled(env, { build: buildOf, now: () => Date.now(), store: defaultStore }))
		ctx.waitUntil(runScheduledJobs(env, inboxDeps))
	},
} satisfies ExportedHandler<Env>
