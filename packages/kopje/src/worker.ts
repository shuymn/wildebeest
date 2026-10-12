import { createApp } from './app/app'
import { handleQueue } from './jobs/queue'
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
	// No periodic work exists yet; in maintenance scheduled is a no-op by design.
	scheduled: () => {},
} satisfies ExportedHandler<Env>
