import { createApp } from './app/app'
import { handleQueue } from './jobs/queue'
import { BUILD_VERSION } from './version'

export { Store } from './store'

const app = createApp({ build: BUILD_VERSION, now: () => Date.now() })

export default {
	fetch: (request, env, ctx) => app.fetch(request, env, ctx),
	queue: (batch) => handleQueue(batch),
	// No periodic work exists yet; in maintenance scheduled is a no-op by design.
	scheduled: () => {},
} satisfies ExportedHandler<Env>
