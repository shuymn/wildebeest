import type { ConfigResult } from '../platform/config'
import { errorMessage } from '../platform/error-message'
import type { StoreStub } from '../platform/store-client'

type Check = { ok: boolean; [detail: string]: unknown }

export type HealthReport = { ok: boolean; build: string; checks: Record<string, Check> }

// The detailed report: env validity and issues, Store reachability and build, schema version, and DB size. It is for
// the admin side only (a later /admin route behind Access); the public /health answers with publicHealth.
export async function healthReport(build: string, config: ConfigResult, store: () => StoreStub): Promise<HealthReport> {
	const checks: Record<string, Check> = {
		env: config.ok ? { ok: true } : { ok: false, issues: config.issues },
	}
	if (config.ok) {
		try {
			const health = await store().health(build)
			checks.store = { ok: health.versionMatch, build: health.build }
			checks.schema = {
				ok: health.schema.status === 'current' && !health.readonly,
				status: health.schema.status,
				applied: health.schema.applied.at(-1) ?? null,
				expected: health.schema.expected.at(-1) ?? null,
				hold: health.hold,
			}
			checks.database = { ok: true, size: health.databaseSize }
		} catch (error) {
			checks.store = { ok: false, error: errorMessage(error) }
		}
	}
	return { ok: Object.values(checks).every((check) => check.ok), build, checks }
}

// What the public /health discloses: ok or fail, nothing else.
export async function publicHealth(build: string, config: ConfigResult, store: () => StoreStub): Promise<Response> {
	const { ok } = await healthReport(build, config, store)
	return new Response(ok ? 'ok' : 'fail', {
		status: ok ? 200 : 503,
		headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
	})
}
