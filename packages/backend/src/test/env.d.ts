/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from '@cloudflare/vitest-pool-workers'

declare global {
	namespace Cloudflare {
		// Controls the type of `import("cloudflare:workers").env`
		interface Env {
			DATABASE: D1Database
			DOMAIN: string
			TEST_MIGRATIONS: D1Migration[] // Defined in `vitest.config.ts`
			userKEK: string
		}
	}
}

export {}
