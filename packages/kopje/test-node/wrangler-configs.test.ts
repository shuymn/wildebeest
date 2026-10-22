import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { experimental_readRawConfig } from 'wrangler'

// The Worker configs that deploy Kopje: the package's own and the instance template's. maintenance.wrangler.jsonc is
// not one: it is only bundled, and the Pages project that runs it keeps its own compatibility settings.
const SHIPPED = ['../wrangler.jsonc', '../../../deploy/wrangler.jsonc']
const MAINTENANCE = '../maintenance.wrangler.jsonc'

// The reader wrangler deploys with (as scripts/check-kopje-package.mjs). Its declared types live in a package this one
// does not depend on, so the part read here is typed locally.
const readRawConfig = experimental_readRawConfig as unknown as (args: { config: string }) => {
	rawConfig: { compatibility_flags?: string[]; observability?: unknown }
}

function read(path: string) {
	return readRawConfig({ config: fileURLToPath(new URL(path, import.meta.url)) }).rawConfig
}

// NET-1: every global fetch() is strictly public, whatever host it names.
const REQUIRED_FLAGS = ['nodejs_compat', 'global_fetch_strictly_public']

// DATA-5 (platform telemetry), docs/observability.md: logs on with query-string removal requested
// (redact_query_string), traces off unless an instance opts in.
const EXPECTED_OBSERVABILITY = {
	enabled: true,
	redact_query_string: true,
	logs: { enabled: true, invocation_logs: true, head_sampling_rate: 1 },
	traces: { enabled: false, head_sampling_rate: 1 },
}

describe('shipped Kopje Worker configs', () => {
	it.each(SHIPPED)('%s sets the required compatibility flags', (path) => {
		expect(read(path).compatibility_flags).toEqual(expect.arrayContaining(REQUIRED_FLAGS))
	})

	it.each(SHIPPED)('%s pins the observability block', (path) => {
		expect(read(path).observability).toEqual(EXPECTED_OBSERVABILITY)
	})

	// Never deployed as a Worker, so a block there would do nothing.
	it('leaves observability out of the maintenance worker config', () => {
		expect(read(MAINTENANCE).observability).toBeUndefined()
	})
})
