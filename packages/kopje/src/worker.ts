import { createApp } from './app/app'
import { handleQueue } from './jobs/queue'
import { defaultStore } from './platform/store-client'
import { buildOf } from './version'

export { Store } from './store'

const app = createApp({ build: buildOf, now: () => Date.now() })

export default {
	fetch: (request, env, ctx) => app.fetch(request, env, ctx),
	queue: (batch, env) => handleQueue(batch, env, { build: buildOf, store: defaultStore }),
	// No periodic work exists yet; in maintenance scheduled is a no-op by design.
	scheduled: () => {},
} satisfies ExportedHandler<Env>
