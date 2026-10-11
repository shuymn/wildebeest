import type { ConfigResult } from '../platform/config'
import type { StoreStub } from '../platform/store-client'

type Check = { ok: boolean; [detail: string]: unknown }

export type HealthReport = { ok: boolean; build: string; checks: Record<string, Check> }

// Env validity, Store reachability, schema version, and DB size. Hold details stay in the logs.
export async function checkHealth(build: string, config: ConfigResult, store: () => StoreStub): Promise<HealthReport> {
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
			checks.store = { ok: false, error: error instanceof Error ? error.message : String(error) }
		}
	}
	return { ok: Object.values(checks).every((check) => check.ok), build, checks }
}
