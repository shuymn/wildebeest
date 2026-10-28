import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { parse, walk } from './source-scan.js'

// The Store compares applied migrations with MIGRATIONS (src/db/migrations.ts) by position, so the registry is the
// files of migrations/ numbered from 0000 without a gap or a reused number. A gap released once stays: renumbering a
// released file would make every upgraded Store diverge.
const RETIRED: Record<number, string> = {
	27: 'released as a gap in 0.1.0-rc.10 (0027_quotes landed as 0033_quotes)',
}

// The registry read by its syntax, not its text: each default import of a migrations/ file, and MIGRATIONS' entries
// by their name and the import their sql names.
const registry = parse({
	path: 'src/db/migrations.ts',
	text: readFileSync(fileURLToPath(new URL('../src/db/migrations.ts', import.meta.url)), 'utf8'),
}).program
const imports = new Map<string, string>()
const named: { name: string; sql: string }[] = []
walk(registry, (node) => {
	if (node.type === 'ImportDeclaration') {
		const file = /^\.\.\/\.\.\/migrations\/(\w+)\.sql$/.exec(node.source.value)?.[1]
		const local = node.specifiers.find((s) => s.type === 'ImportDefaultSpecifier')?.local.name
		if (file !== undefined && local !== undefined) {
			imports.set(local, file)
		}
	} else if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === 'MIGRATIONS') {
		if (node.init?.type !== 'ArrayExpression') {
			throw new Error('MIGRATIONS is not an array literal')
		}
		for (const element of node.init.elements) {
			const property = (key: string) =>
				element?.type === 'ObjectExpression'
					? element.properties.find((p) => p.type === 'Property' && p.key.type === 'Identifier' && p.key.name === key)
					: undefined
			const name = property('name')
			const sql = property('sql')
			if (
				name?.type !== 'Property' ||
				name.value.type !== 'Literal' ||
				typeof name.value.value !== 'string' ||
				sql?.type !== 'Property' ||
				sql.value.type !== 'Identifier'
			) {
				throw new Error('a MIGRATIONS entry is not { name: a string, sql: an import }')
			}
			named.push({ name: name.value.value, sql: sql.value.name })
		}
	}
})
const entries = named.map(({ name, sql }) => ({ name, file: imports.get(sql) }))
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
