import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { experimental_readRawConfig } from 'wrangler'

// The Worker configs that deploy Kopje: the package's own and the instance template's. maintenance.wrangler.jsonc is
// not one: it is only bundled, and the Pages project that runs it keeps its own compatibility settings.
const SHIPPED = ['../wrangler.jsonc', '../../../deploy/wrangler.jsonc']

// The reader wrangler deploys with (as scripts/check-kopje-package.mjs). Its declared types live in a package this one
// does not depend on, so the part read here is typed locally.
const readRawConfig = experimental_readRawConfig as unknown as (args: { config: string }) => {
	rawConfig: { compatibility_flags?: string[] }
}

// NET-1: every global fetch() is strictly public, whatever host it names.
const REQUIRED_FLAGS = ['nodejs_compat', 'global_fetch_strictly_public']

describe('shipped Kopje Worker configs', () => {
	it.each(SHIPPED)('%s sets the required compatibility flags', (path) => {
		const { rawConfig } = readRawConfig({ config: fileURLToPath(new URL(path, import.meta.url)) })
		expect(rawConfig.compatibility_flags).toEqual(expect.arrayContaining(REQUIRED_FLAGS))
	})
})
