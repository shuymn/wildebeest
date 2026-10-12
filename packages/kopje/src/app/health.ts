import { type Config, type ConfigResult, userKek } from '../platform/config'
import { errorMessage } from '../platform/error-message'
import type { StoreStub } from '../platform/store-client'
import { checkKey } from '../security/keyring'

type Check = { ok: boolean; [detail: string]: unknown }

export type HealthReport = { ok: boolean; build: string; checks: Record<string, Check> }

// The detailed report: env validity and issues, Store reachability and build, schema version, DB size, and the keys.
// It is for the admin side only (a later /admin route behind Access); the public /health answers with publicHealth,
// which skips the key check (an unwrap and an RSA signature per key is too much work for an unauthenticated GET).
export async function healthReport(
	build: string,
	config: ConfigResult,
	store: () => StoreStub,
	{ checkKeys = true }: { checkKeys?: boolean } = {}
): Promise<HealthReport> {
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
		if (checkKeys && checks.store.ok) {
			checks.keys = await keysCheck(build, config.config, store)
		}
	}
	return { ok: Object.values(checks).every((check) => check.ok), build, checks }
}

// Every local key (users and the instance actor) must unwrap with the configured KEK, and a signature made with it must
// verify against the stored public key. An empty KEK is legal but reported as a warning.
async function keysCheck(build: string, config: Config, store: () => StoreStub): Promise<Check> {
	const kek = userKek(config)
	const warning = kek === '' ? { warning: 'USER_KEK is empty' } : {}
	try {
		const keys = await store().localKeys(build)
		const failures: { owner: string; result: string }[] = []
		for (const { owner, key } of keys) {
			const result = await checkKey(kek, key)
			if (result !== 'ok') {
				failures.push({ owner: owner ?? '(instance actor)', result })
			}
		}
		return { ok: failures.length === 0, count: keys.length, failures, ...warning }
	} catch (error) {
		return { ok: false, error: errorMessage(error), ...warning }
	}
}

// What the public /health discloses: ok or fail, nothing else.
export async function publicHealth(build: string, config: ConfigResult, store: () => StoreStub): Promise<Response> {
	const { ok } = await healthReport(build, config, store, { checkKeys: false })
	return new Response(ok ? 'ok' : 'fail', {
		status: ok ? 200 : 503,
		headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
	})
}
