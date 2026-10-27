import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// The Store compares applied migrations with MIGRATIONS (src/db/migrations.ts) by position, so the registry is the
// files of migrations/ numbered from 0000 without a gap or a reused number. A gap released once stays: renumbering a
// released file would make every upgraded Store diverge.
const RETIRED: Record<number, string> = {
	27: 'released as a gap in 0.1.0-rc.10 (0027_quotes landed as 0033_quotes)',
}

const registry = readFileSync(fileURLToPath(new URL('../src/db/migrations.ts', import.meta.url)), 'utf8')
const imports = new Map(
	[...registry.matchAll(/^import (\w+) from '\.\.\/\.\.\/migrations\/(\w+)\.sql'$/gm)].map((m) => [m[1]!, m[2]!])
)
const entries = [...registry.matchAll(/\{ name: '(\w+)', sql: (\w+)/g)].map((m) => ({
	name: m[1]!,
	file: imports.get(m[2]!),
}))
const files = readdirSync(fileURLToPath(new URL('../migrations/', import.meta.url)))
	.filter((f) => f.endsWith('.sql'))
	.map((f) => f.slice(0, -'.sql'.length))

describe('Store migration registry', () => {
	it('numbers the n-th migration n, from 0000, skipping only a retired number', () => {
		const expected: string[] = []
		for (let n = 0; expected.length < entries.length; n++) {
			if (!(n in RETIRED)) expected.push(String(n).padStart(4, '0'))
		}
		expect(entries.map((e) => e.name.slice(0, 5))).toEqual(expected.map((n) => `${n}_`))
		const numbers = entries.map((e) => Number(e.name.slice(0, 4)))
		expect(numbers.filter((n, i) => i > 0 && n <= numbers[i - 1]!)).toEqual([])
	})

	it('registers every file under migrations/ once, by its own name', () => {
		expect(entries.filter((e) => e.file !== e.name)).toEqual([])
		expect(entries.map((e) => e.name).sort()).toEqual(files.sort())
	})
})
