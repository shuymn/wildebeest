import { createApp } from './app/app'
import { handleQueue } from './jobs/queue'
import { handleScheduled } from './jobs/scheduled'
import { defaultStore } from './platform/store-client'
import { buildOf } from './version'

export { Store } from './store'

const app = createApp({ build: buildOf, now: () => Date.now() })

export default {
	fetch: (request, env, ctx) => app.fetch(request, env, ctx),
	queue: (batch, env) => handleQueue(batch, env, { build: buildOf, store: defaultStore }),
	scheduled: (_controller, env, ctx) => {
		ctx.waitUntil(handleScheduled(env, { build: buildOf, now: () => Date.now(), store: defaultStore }))
	},
} satisfies ExportedHandler<Env>
