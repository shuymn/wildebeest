import { describe, expect, it } from 'vitest'

import { lineOf, parse, sources } from './source-scan.js'

describe('the source scan', () => {
	it('reads the package by its relative paths, declaration files left out', () => {
		const paths = sources('src').map((s) => s.path)
		expect(paths).toEqual(expect.arrayContaining(['src/worker.ts', 'src/domain/audience.ts', 'src/app/web.tsx']))
		expect(paths.some((p) => p.endsWith('.d.ts'))).toBe(false)
		expect(() => sources('src', ['.none'])).toThrow('no sources in src')
	})

	it('counts offsets in UTF-16 code units and keeps no parentheses as nodes', () => {
		// ’ is 3 bytes of UTF-8 and one code unit, 𝒳 4 bytes and two code units.
		const text = "const A = '’𝒳' as const\nconst B = (`x${A}y`)\n"
		const { literals } = parse({ path: 'src/probe.ts', text })
		expect(literals.map((l) => [l.constant, text.slice(l.node.start, l.node.end)])).toEqual([
			['A', "'’𝒳'"],
			['B', '`x${A}y`'],
		])
		expect(literals[1]?.parts).toEqual([{ text: 'x' }, expect.objectContaining({ source: 'A' }), { text: 'y' }])
		expect(lineOf(text, literals[1]?.node.start ?? 0)).toBe(2)
	})

	it('names only a const as a constant', () => {
		const text = "const A = 'a'\nlet B = 'b'\nvar C = 'c'\nexport const D: string = 'd'"
		expect(parse({ path: 'src/probe.ts', text }).literals.map((l) => l.constant)).toEqual(['A', null, null, 'D'])
	})

	it('blanks comments, keeping lines, and not a // inside a string or a regular expression', () => {
		const text = "a // one\n/* two\nthree */ b('//', /\\/\\//)"
		expect(parse({ path: 'src/probe.ts', text }).code).toBe("a       \n      \n         b('//', /\\/\\//)")
	})

	// An interpolation's source is a key (bounded-columns' ALLOWED): the same under either formatter style, and never the
	// same for two different string values.
	const key = (expression: string) => {
		const [literal] = parse({ path: 'src/probe.ts', text: `const A = \`x\${${expression}}y\`` }).literals
		const part = literal?.parts[1]
		return part !== undefined && 'source' in part ? part.source : undefined
	}

	it('keys an interpolation the same under either quote, semicolon and trailing-comma style', () => {
		expect(key("f(kind, '?3', \"it's\")")).toBe("f(kind, '?3', \"it's\")")
		expect(key('f(kind, "?3", "it\'s")')).toBe("f(kind, '?3', \"it's\")")
		expect(key("f(\n\t\tkind,\n\t\t'?3',\n\t\t\"it's\",\n\t)")).toBe("f(kind, '?3', \"it's\")")
		expect(key('g(`a  ${b}  c`)')).toBe('g(`a  ${b}  c`)')
	})

	it('keys two different string values differently', () => {
		const values = [' ', '\t', '  ', '\n', ' ', '\\t', "'", '"', '\\', '\\\\', 'a b', 'a  b', 'a\tb']
		const keys = values.map((v) => key(`f(${JSON.stringify(v)})`))
		expect(new Set(keys).size).toBe(values.length)
		expect(key("f('\\t')")).toBe(key('f("\\u0009")'))
		expect(key("projected.join(' ')")).not.toBe(key("projected.join('\\t')"))
	})

	it('throws on a parse error rather than skip the file', () => {
		expect(() => parse({ path: 'src/probe.ts', text: 'a\nconst = 1' })).toThrow('src/probe.ts:2:')
	})
})
