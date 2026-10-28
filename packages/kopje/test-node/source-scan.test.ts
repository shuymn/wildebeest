import { describe, expect, it } from 'vitest'

import { expressionKey, lineOf, parse, sources } from './source-scan.js'

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

	// An interpolation's key (bounded-columns matches ALLOWED by it): the same however the expression is formatted, and
	// never the same for two different trees.
	const key = (expression: string) => {
		const [literal] = parse({ path: 'src/probe.ts', text: `const A = \`x\${${expression}}y\`` }).literals
		const part = literal?.parts[1]
		const found = part !== undefined && 'key' in part ? part.key : undefined
		expect(found).toBe(expressionKey(expression))
		return found
	}

	it('keys a tree the same however it is formatted', () => {
		const same: [string, string][] = [
			// Quotes and escapes.
			["f(kind, '?3', \"it's\")", 'f(kind, "?3", "it\'s")'],
			["f('\\t')", 'f("\\u0009")'],
			// Semicolons and line breaks.
			['() => {\n\ta;\n\tb;\n}', '() => { a\nb }'],
			// Trailing commas.
			['f([a,])', 'f([a])'],
			["f(\n\t\tkind,\n\t\t'?3',\n\t)", "f(kind, '?3')"],
			// Parentheses.
			['f((a))', 'f(a)'],
			['f(\n\t(a - b) - c,\n)', 'f(a - b - c)'],
			['a ?. b ?. (c)', 'a?.b?.(c)'],
			// Arrow parameter parentheses.
			['(x) => x', 'x => x'],
			// Property-name quotes.
			['{ "foo": bar }', '{ foo: bar }'],
			["class { 'm'() {} }", 'class { m() {} }'],
			// Number spelling.
			['f(1.0, 0x10)', 'f(1, 16)'],
		]
		for (const [a, b] of same) {
			expect(key(a), `${a} | ${b}`).toBe(key(b))
		}
	})

	it('keys two different trees differently', () => {
		const different: [string, string][] = [
			// String values.
			["projected.join(' ')", "projected.join('\\t')"],
			["f(' ')", "f('  ')"],
			["f('\\\\t')", "f('\\t')"],
			["f('a b')", "f('a\\tb')"],
			// Array holes.
			['f([])', 'f([,])'],
			['f([a])', 'f([a,,])'],
			// Regular expressions.
			['f(/[ ]/)', 'f(/[]/)'],
			['f(/a/g)', 'f(/a/)'],
			// A line break that ends a statement.
			['() => {\n\treturn\n\t1\n}', '() => {\n\treturn 1\n}'],
			// Grouping, chains and members.
			['a - (b - c)', 'a - b - c'],
			['(a?.b).c', 'a?.b.c'],
			['a.b', "a['b']"],
			['{ [foo]: bar }', '{ foo: bar }'],
			['- -a', '--a'],
			// Numbers and names.
			['f(1e400)', 'f(Infinity)'],
			['f(1n)', 'f(1)'],
			['f(null)', 'f(Null)'],
			// Templates.
			['`a ${b}`', '`a  ${b}`'],
			// Types.
			['x as A', 'x as B'],
			['f<A>()', 'f<B>()'],
			['(x: A) => x', '(x: B) => x'],
		]
		for (const [a, b] of different) {
			expect(key(a), `${a} | ${b}`).not.toBe(key(b))
		}
	})

	it('refuses an allowlist snippet that is not one expression', () => {
		expect(() => expressionKey('f(')).toThrow('not one expression')
		expect(() => expressionKey('a); (b')).toThrow('not one expression')
	})

	it('throws on a parse error rather than skip the file', () => {
		expect(() => parse({ path: 'src/probe.ts', text: 'a\nconst = 1' })).toThrow('src/probe.ts:2:')
	})
})
