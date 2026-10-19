import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

// The npm package ships no sources: there the cutover loads its runtime from dist/maintenance-render.js
// (cli/lib/cutover/kopje-runtime.js), built from src/maintenance-render.ts. Every name the runtime hands the cutover
// is exported there too, so the packaged CLI finds each one the sources give it.

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

describe('the packaged cutover runtime', () => {
	it('exports from src/maintenance-render.ts every name kopje-runtime.js destructures', async () => {
		const runtime = await source('cli/lib/cutover/kopje-runtime.js')
		const names = /export const \{([^}]*)\} = runtime/.exec(runtime)?.[1]?.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []
		expect(names).toEqual(expect.arrayContaining(['storedInstanceSetting', 'isBlank', 'INSTANCE_DOCUMENTS']))
		const render = await source('src/maintenance-render.ts')
		const exported = new Set(
			[...render.matchAll(/export \{([^}]*)\} from/g)].flatMap((m) => m[1]?.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])
		)
		expect(names.filter((name) => !exported.has(name))).toEqual([])
	})
})
