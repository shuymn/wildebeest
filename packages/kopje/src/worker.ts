import { createApp } from './app/app'
import { scheduledDeliveries } from './jobs/deliver'
import { handleQueue } from './jobs/queue'
import { handleScheduled } from './jobs/scheduled'
import { defaultStore } from './platform/store-client'
import { buildOf } from './version'

export { Store } from './store'

const app = createApp({ build: buildOf, now: () => Date.now() })
const delivery = { now: () => Date.now(), fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) }

export default {
	fetch: (request, env, ctx) => app.fetch(request, env, ctx),
	queue: (batch, env) => handleQueue(batch, env, { build: buildOf, store: defaultStore, delivery }),
	// Every 5 minutes: the delivery sweep and doorbell, then the media sweep and reconciliation (each a no-op in
	// maintenance, by design).
	scheduled: (_controller, env, ctx) => {
		ctx.waitUntil(scheduledDeliveries(env, { ...delivery, build: buildOf, store: defaultStore }))
		ctx.waitUntil(handleScheduled(env, { build: buildOf, now: () => Date.now(), store: defaultStore }))
	},
} satisfies ExportedHandler<Env>
