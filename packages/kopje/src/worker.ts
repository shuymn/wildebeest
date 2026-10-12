import { createApp } from './app/app'
import { handleQueue, runScheduledJobs } from './jobs/queue'
import { defaultStore } from './platform/store-client'
import { generateRsaKeyPair } from './security/key-wrap'
import { buildOf } from './version'

export { Store } from './store'

const now = () => Date.now()
const app = createApp({ build: buildOf, now })
const inboxDeps = {
	build: buildOf,
	store: defaultStore,
	now,
	keygen: generateRsaKeyPair,
	loader: { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) },
}

export default {
	fetch: (request, env, ctx) => app.fetch(request, env, ctx),
	queue: (batch, env) => handleQueue(batch, env, inboxDeps),
	// Resumes inbound jobs (purges, Moves); in maintenance it is a no-op by design.
	scheduled: (_controller, env, ctx) => ctx.waitUntil(runScheduledJobs(env, inboxDeps)),
} satisfies ExportedHandler<Env>
