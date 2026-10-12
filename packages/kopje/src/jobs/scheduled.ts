import { reconcileMedia, sweepMedia, type SweepDeps } from '../mastodon/media'
import { readConfig } from '../platform/config'
import { errorFields } from '../platform/error-message'

// The 5-minute cron (wrangler.jsonc). Nothing runs while the env sets maintenance (or is invalid), as for the queue; in
// the Store's own maintenance its writes are refused and each task waits for the next run.
//   - media: deletes one batch of doomed uploads and their R2 objects (domain/media.ts), then reconciles one page of R2
//     against the Store (objects no row names, past their grace period, are deleted).
export async function handleScheduled(env: Env, deps: SweepDeps): Promise<void> {
	const config = readConfig(env)
	if (!config.ok || config.config.MAINTENANCE !== 'off') {
		return
	}
	try {
		await sweepMedia(env, deps)
	} catch (error) {
		console.error({ event: 'kopje.scheduled.media_sweep_failed', ...errorFields(error) })
	}
	try {
		await reconcileMedia(env, deps)
	} catch (error) {
		console.error({ event: 'kopje.scheduled.media_reconcile_failed', ...errorFields(error) })
	}
}
